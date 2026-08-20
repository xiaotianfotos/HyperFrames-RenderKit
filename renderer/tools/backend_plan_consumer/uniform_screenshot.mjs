import { readFileSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  buildScreenshotAuditEvidence,
  canonicalJson,
  sha256,
  verifyExecutionProof,
} from "../frame_backend_preflight/lib.mjs";
import { transformProxyTreeHtml } from "../proxy_tree_transformer.mjs";
import { transformScreenshotHtml } from "../screenshot_entry_transformer.mjs";
import {
  DEFAULT_MOV_CONTRACT,
  EXECUTION_PLAN_KIND,
  EXECUTION_PLAN_SCHEMA_VERSION,
  verifyExecutionSegmentPlan,
} from "./lib.mjs";
import { verifyExecutionInputsDescriptor } from "./execution_inputs.mjs";

export const PROJECT_SCOPE_MEDIA_PROOF_KIND = "hyperframes-project-scope-screenshot-media-policy-proof";
export const PROJECT_SCOPE_MEDIA_PROOF_SCHEMA_VERSION = 1;

const here = dirname(fileURLToPath(import.meta.url));
const SHA256_PATTERN = /^sha256:[a-f0-9]{64}$/;
const WHOLE_PROJECT_PROXY_INELIGIBLE_CODES = new Set(["HF_PROXY_DYNAMIC_SELECTOR_UNAUDITED"]);

function integer(value, name, minimum = 0) {
  if (!Number.isSafeInteger(value) || value < minimum) throw new Error(`${name} must be an integer >= ${minimum}`);
  return value;
}

function identity(value, name, { nullable = false } = {}) {
  if (value == null && nullable) return null;
  if (typeof value !== "string" || !SHA256_PATTERN.test(value)) throw new Error(`${name} must be a sha256 identity`);
  return value;
}

function normalizeFps(value) {
  if (!value || typeof value !== "object") throw new Error("target.fps is required");
  const fps = {
    numerator: integer(value.numerator, "target.fps.numerator", 1),
    denominator: integer(value.denominator, "target.fps.denominator", 1),
  };
  if (fps.numerator !== 60 || fps.denominator !== 1) throw new Error("uniform screenshot compiler currently supports only 60/1 fps");
  return fps;
}

function insideRelative(projectRoot, path) {
  if (typeof path !== "string" || !path) return null;
  const rel = relative(projectRoot, resolve(path));
  return rel && !rel.startsWith("..") && !isAbsolute(rel) ? rel.split("\\").join("/") : null;
}

function toolchainEvidence() {
  const paths = {
    proxyTransformerIdentity: resolve(here, "../proxy_tree_transformer.mjs"),
    screenshotTransformerIdentity: resolve(here, "../screenshot_entry_transformer.mjs"),
    auditLibraryIdentity: resolve(here, "../frame_backend_preflight/lib.mjs"),
  };
  return Object.fromEntries(Object.entries(paths).map(([key, path]) => [key, `sha256:${sha256(readFileSync(path))}`]));
}

function signedStaticGate(core) {
  return { ...core, evidenceSignature: `sha256:${sha256(core)}` };
}

function staticGateFromFailure(error, projectRoot, transformerIdentity) {
  return signedStaticGate({
    kind: "hyperframes-project-scope-proxy-static-gate",
    schemaVersion: 1,
    scope: "whole-project",
    passed: false,
    backend: "proxy-tree",
    code: String(error?.code ?? "HF_PROXY_STATIC_GATE_FAILED"),
    reason: error?.details?.reason == null ? null : String(error.details.reason),
    source: insideRelative(projectRoot, error?.details?.source),
    expression: error?.details?.expression == null ? null : String(error.details.expression),
    transformerIdentity,
  });
}

function staticGateFromReport(report, transformerIdentity) {
  return signedStaticGate({
    kind: "hyperframes-project-scope-proxy-static-gate",
    schemaVersion: 1,
    scope: "whole-project",
    passed: true,
    backend: "proxy-tree",
    code: null,
    reason: null,
    source: null,
    expression: null,
    transformerIdentity,
    reportIdentity: `sha256:${sha256(report)}`,
  });
}

function failedScreenshotAudit(error, entrySha256) {
  const core = {
    kind: "hyperframes-screenshot-entry-audit-failure",
    schemaVersion: 1,
    entrySha256,
    eligible: false,
    contract: null,
    media: [],
    blockers: [{ code: String(error?.code ?? "HF_SCREENSHOT_AUDIT_FAILED"), message: String(error?.message ?? error) }],
    scannedScripts: [],
  };
  return { ...core, auditSignature: `sha256:${sha256(core)}` };
}

export function recomputeUniformScreenshotProjectEvidence({
  projectRoot: rawProjectRoot,
  entryPath: rawEntryPath,
  intrinsicDimensionsBySource = null,
} = {}) {
  const projectRoot = resolve(rawProjectRoot ?? "");
  const entryPath = resolve(rawEntryPath ?? "");
  const entryRelative = insideRelative(projectRoot, entryPath);
  if (!entryRelative) throw new Error("entryPath must remain inside projectRoot");
  const entrySha256 = sha256(readFileSync(entryPath));
  const toolchain = toolchainEvidence();
  let screenshotAudit;
  try {
    const report = transformScreenshotHtml({ entryPath, projectRoot }).report;
    screenshotAudit = buildScreenshotAuditEvidence({ report, projectRoot, entrySha256 });
  } catch (error) {
    screenshotAudit = failedScreenshotAudit(error, entrySha256);
  }
  let proxyStaticGate;
  try {
    const transformed = transformProxyTreeHtml({ entryPath, intrinsicDimensionsBySource });
    proxyStaticGate = staticGateFromReport(transformed.report, toolchain.proxyTransformerIdentity);
  } catch (error) {
    proxyStaticGate = staticGateFromFailure(error, projectRoot, toolchain.proxyTransformerIdentity);
  }
  return {
    kind: "hyperframes-uniform-screenshot-current-project-evidence",
    schemaVersion: 1,
    entry: entryRelative,
    entrySha256: `sha256:${entrySha256}`,
    screenshotAudit,
    proxyStaticGate,
    toolchain,
  };
}

function normalizeSeedStaticGate(raw, projectRoot, transformerIdentity) {
  if (!raw || raw.passed !== false) return null;
  const core = {
    kind: "hyperframes-project-scope-proxy-static-gate",
    schemaVersion: 1,
    scope: "whole-project",
    passed: false,
    backend: "proxy-tree",
    code: raw.code == null ? null : String(raw.code),
    reason: raw.details?.reason == null ? null : String(raw.details.reason),
    source: insideRelative(projectRoot, raw.details?.source),
    expression: raw.details?.expression == null ? null : String(raw.details.expression),
    transformerIdentity,
  };
  return signedStaticGate(core);
}

function sourcePreflightBasis(seedPreflightPlan) {
  return {
    proofSignature: seedPreflightPlan?.proof?.proofSignature ?? null,
    mediaPolicyProofSignature: seedPreflightPlan?.proof?.screenshotMediaPolicy?.proofSignature ?? null,
    validationIdentity: seedPreflightPlan?.validation?.validationIdentity ?? null,
    determinismSignature: seedPreflightPlan?.proof?.screenshotMediaPolicy?.determinismSignature ?? null,
    determinismPasses: seedPreflightPlan?.proof?.screenshotMediaPolicy?.determinismPasses ?? 0,
    seedStartFrame: seedPreflightPlan?.startFrame ?? null,
    seedFrameCount: seedPreflightPlan?.frameCount ?? null,
    seedFps: seedPreflightPlan?.fps ?? null,
    timelineAuthority: "none-project-scope-reissue-only",
  };
}

export function issueProjectScopeMediaPolicyProof({
  projectManifestVerification,
  currentEvidence,
  seedPreflightPlan = null,
  projectRoot,
} = {}) {
  const reasons = [];
  const projectIdentity = projectManifestVerification?.projectIdentity ?? null;
  if (projectManifestVerification?.valid !== true || !SHA256_PATTERN.test(projectIdentity ?? "")) {
    reasons.push("whole-project-manifest-not-verified");
  }
  if (currentEvidence?.screenshotAudit?.eligible !== true) reasons.push("screenshot-audit-ineligible");
  if (!SHA256_PATTERN.test(currentEvidence?.screenshotAudit?.auditSignature ?? "")) reasons.push("screenshot-audit-signature-missing");
  const gate = currentEvidence?.proxyStaticGate;
  if (gate?.passed !== false || !WHOLE_PROJECT_PROXY_INELIGIBLE_CODES.has(gate?.code)) {
    reasons.push("proxy-not-proven-whole-project-ineligible");
  }
  if (!SHA256_PATTERN.test(gate?.evidenceSignature ?? "")) reasons.push("proxy-static-gate-signature-missing");

  let seedVerification = { valid: false, reason: "seed-preflight-proof-missing" };
  if (seedPreflightPlan) {
    seedVerification = verifyExecutionProof(seedPreflightPlan, {
      projectIdentity,
      renderPlanIdentity: seedPreflightPlan.renderPlanIdentity,
      machineProfileIdentity: seedPreflightPlan.machineProfileIdentity,
      styleOverrideProfileHash: seedPreflightPlan.styleOverrideProfileHash,
      auditSignature: currentEvidence?.screenshotAudit?.auditSignature,
    });
  }
  if (!seedVerification.valid || seedVerification.screenshotMediaPolicy !== "bounded-static") {
    reasons.push(`bounded-static-seed-invalid:${seedVerification.reason ?? "policy-not-bounded-static"}`);
  }
  if (seedPreflightPlan?.preflight?.identities?.projectIdentityPolicy !== "caller-supplied-strong") {
    reasons.push("seed-project-identity-not-caller-supplied-strong");
  }
  const seedGate = normalizeSeedStaticGate(
    seedPreflightPlan?.preflight?.staticGate,
    resolve(projectRoot ?? ""),
    currentEvidence?.toolchain?.proxyTransformerIdentity,
  );
  if (!seedGate || canonicalJson(seedGate) !== canonicalJson(gate)) reasons.push("seed-proxy-static-gate-mismatch");
  if (seedPreflightPlan?.preflight?.screenshotAudit?.auditSignature !== currentEvidence?.screenshotAudit?.auditSignature) {
    reasons.push("seed-screenshot-audit-mismatch");
  }

  const core = {
    kind: PROJECT_SCOPE_MEDIA_PROOF_KIND,
    schemaVersion: PROJECT_SCOPE_MEDIA_PROOF_SCHEMA_VERSION,
    scope: "whole-project-static-screenshot-media-policy",
    selectedPolicy: reasons.length === 0 ? "bounded-static" : "faithful",
    projectIdentity,
    auditSignature: currentEvidence?.screenshotAudit?.auditSignature ?? null,
    screenshotAuditContract: currentEvidence?.screenshotAudit?.contract ?? null,
    proxyStaticGate: gate ?? null,
    toolchain: currentEvidence?.toolchain ?? null,
    sourcePreflightBasis: sourcePreflightBasis(seedPreflightPlan),
    reasons,
  };
  return { ...core, proofSignature: `sha256:${sha256(core)}` };
}

export function verifyProjectScopeMediaPolicyProof({ proof, projectManifestVerification, currentEvidence } = {}) {
  const fail = (reason) => ({ valid: false, selectedPolicy: "faithful", reason });
  if (proof?.kind !== PROJECT_SCOPE_MEDIA_PROOF_KIND || proof?.schemaVersion !== PROJECT_SCOPE_MEDIA_PROOF_SCHEMA_VERSION) {
    return fail("project-scope-proof-missing-or-schema-mismatch");
  }
  const { proofSignature, ...core } = proof;
  if (proofSignature !== `sha256:${sha256(core)}`) return fail("project-scope-proof-signature-mismatch");
  if (projectManifestVerification?.valid !== true) return fail("whole-project-manifest-not-verified");
  if (proof.projectIdentity !== projectManifestVerification.projectIdentity) return fail("project-scope-project-identity-mismatch");
  if (proof.auditSignature !== currentEvidence?.screenshotAudit?.auditSignature) return fail("project-scope-audit-signature-mismatch");
  if (canonicalJson(proof.proxyStaticGate) !== canonicalJson(currentEvidence?.proxyStaticGate)) {
    return fail("project-scope-proxy-static-gate-mismatch");
  }
  if (canonicalJson(proof.toolchain) !== canonicalJson(currentEvidence?.toolchain)) return fail("project-scope-toolchain-mismatch");
  if (proof.selectedPolicy !== "bounded-static" || !Array.isArray(proof.reasons) || proof.reasons.length !== 0) {
    return fail("project-scope-proof-does-not-authorize-bounded-static");
  }
  if (proof.sourcePreflightBasis?.timelineAuthority !== "none-project-scope-reissue-only") {
    return fail("project-scope-proof-timeline-authority-invalid");
  }
  if (currentEvidence?.screenshotAudit?.eligible !== true
      || currentEvidence?.proxyStaticGate?.passed !== false
      || !WHOLE_PROJECT_PROXY_INELIGIBLE_CODES.has(currentEvidence?.proxyStaticGate?.code)) {
    return fail("current-project-evidence-does-not-authorize-bounded-static");
  }
  return { valid: true, selectedPolicy: "bounded-static", reason: null, proofSignature };
}

function normalizeTarget(raw = {}) {
  return {
    projectIdentity: identity(raw.projectIdentity, "target.projectIdentity"),
    renderPlanIdentity: identity(raw.renderPlanIdentity ?? raw.renderIdentity, "target.renderPlanIdentity"),
    machineProfileIdentity: identity(raw.machineProfileIdentity, "target.machineProfileIdentity"),
    styleOverrideProfileHash: identity(raw.styleOverrideProfileHash, "target.styleOverrideProfileHash", { nullable: true }),
    auditSignature: identity(raw.auditSignature, "target.auditSignature"),
    startFrame: integer(raw.startFrame, "target.startFrame"),
    frameCount: integer(raw.frameCount, "target.frameCount", 1),
    fps: normalizeFps(raw.fps),
  };
}

export function computeUniformScreenshotRenderPlanIdentity({ target: rawTarget, currentEvidence } = {}) {
  const target = normalizeTarget(rawTarget);
  const entrySha256 = String(currentEvidence?.entrySha256 ?? "");
  if (!/^sha256:[a-f0-9]{64}$/.test(entrySha256) || typeof currentEvidence?.entry !== "string") {
    throw new Error("current project evidence lacks the entry identity required for renderPlanIdentity");
  }
  const basis = {
    projectIdentity: target.projectIdentity,
    entry: currentEvidence.entry,
    entrySha256: entrySha256.slice("sha256:".length),
    startFrame: target.startFrame,
    frameCount: target.frameCount,
    fpsNumerator: target.fps.numerator,
    fpsDenominator: target.fps.denominator,
    width: DEFAULT_MOV_CONTRACT.video.width,
    height: DEFAULT_MOV_CONTRACT.video.height,
    styleOverrideProfileHash: target.styleOverrideProfileHash,
  };
  return { basis, renderPlanIdentity: `sha256:${sha256(basis)}` };
}

export function compileUniformScreenshotExecutionPlan({
  target: rawTarget,
  projectManifestVerification,
  currentEvidence,
  projectScopeProof = null,
  executionInputs = null,
  executionInputsError = null,
  outputContract = DEFAULT_MOV_CONTRACT,
} = {}) {
  const target = normalizeTarget(rawTarget);
  if (canonicalJson(outputContract) !== canonicalJson(DEFAULT_MOV_CONTRACT)) {
    throw new Error("uniform screenshot compiler supports only the canonical MOV contract");
  }
  const proofVerification = verifyProjectScopeMediaPolicyProof({
    proof: projectScopeProof,
    projectManifestVerification,
    currentEvidence,
  });
  const rejections = [];
  if (!proofVerification.valid) rejections.push(proofVerification.reason);
  if (target.projectIdentity !== projectManifestVerification?.projectIdentity) rejections.push("target-project-identity-mismatch");
  if (target.auditSignature !== currentEvidence?.screenshotAudit?.auditSignature) rejections.push("target-audit-signature-mismatch");
  const inputCheck = verifyExecutionInputsDescriptor(executionInputs);
  if (!inputCheck.valid) rejections.push(executionInputsError ?? inputCheck.reason);
  if (inputCheck.valid && executionInputs.projectIdentity !== projectManifestVerification?.projectIdentity) {
    rejections.push("execution-inputs-project-identity-mismatch");
  }
  if (inputCheck.valid && (
    executionInputs.project?.entry?.path !== currentEvidence?.entry
    || executionInputs.project?.entry?.sha256 !== currentEvidence?.entrySha256
  )) {
    rejections.push("execution-inputs-entry-mismatch");
  }
  const targetRenderIdentity = computeUniformScreenshotRenderPlanIdentity({ target, currentEvidence });
  if (target.renderPlanIdentity !== targetRenderIdentity.renderPlanIdentity) {
    rejections.push("target-render-plan-identity-mismatch");
  }
  const screenshotMediaPolicy = rejections.length === 0 ? "bounded-static" : "faithful";
  const boundExecutionInputs = inputCheck.valid
    && executionInputs.projectIdentity === projectManifestVerification?.projectIdentity
    && executionInputs.project?.entry?.path === currentEvidence?.entry
    && executionInputs.project?.entry?.sha256 === currentEvidence?.entrySha256
    ? executionInputs
    : null;
  const segment = {
    segmentId: "segment-0000",
    order: 0,
    startFrame: target.startFrame,
    endFrameExclusive: target.startFrame + target.frameCount,
    frameCount: target.frameCount,
    backend: "screenshot",
    sourceRangeIndexes: [],
    screenshotMediaPolicy,
    outputContract: JSON.parse(JSON.stringify(DEFAULT_MOV_CONTRACT)),
  };
  const core = {
    kind: EXECUTION_PLAN_KIND,
    schemaVersion: EXECUTION_PLAN_SCHEMA_VERSION,
    executable: true,
    executionMode: screenshotMediaPolicy === "bounded-static"
      ? "verified-uniform-screenshot-project-scope"
      : "uniform-screenshot-faithful-fallback",
    fallbackReason: rejections.length ? rejections.join(",") : null,
    sourceProofType: "project-scope-screenshot-media-policy",
    sourceProofValid: screenshotMediaPolicy === "bounded-static",
    sourceProofSignature: SHA256_PATTERN.test(projectScopeProof?.proofSignature ?? "") ? projectScopeProof.proofSignature : null,
    sourceBackendPlanSignature: null,
    executionInputs: boundExecutionInputs,
    projectScopeProofVerification: {
      valid: proofVerification.valid,
      reason: proofVerification.reason,
      targetTimelineWasNotInheritedFromSeed: true,
    },
    targetRenderIdentity: {
      verified: target.renderPlanIdentity === targetRenderIdentity.renderPlanIdentity,
      basis: targetRenderIdentity.basis,
      expected: targetRenderIdentity.renderPlanIdentity,
    },
    identities: {
      projectIdentity: projectManifestVerification?.projectIdentity ?? target.projectIdentity,
      renderPlanIdentity: target.renderPlanIdentity,
      machineProfileIdentity: target.machineProfileIdentity,
      styleOverrideProfileHash: target.styleOverrideProfileHash,
      auditSignature: currentEvidence?.screenshotAudit?.auditSignature ?? target.auditSignature,
    },
    timeline: {
      startFrame: target.startFrame,
      frameCount: target.frameCount,
      fps: target.fps,
    },
    screenshotMediaPolicy,
    downgradedProxyRangeIndexes: [],
    segments: [segment],
    concat: {
      mode: "single-segment",
      streamCopyEligible: false,
      segmentOrder: [segment.segmentId],
      outputContract: JSON.parse(JSON.stringify(DEFAULT_MOV_CONTRACT)),
    },
  };
  const plan = { ...core, executionPlanSignature: `sha256:${sha256(core)}` };
  const verified = verifyExecutionSegmentPlan(plan);
  if (!verified.valid) throw new Error(`uniform screenshot compiler produced an invalid plan: ${verified.reason}`);
  return plan;
}
