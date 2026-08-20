import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { sha256 } from "../frame_backend_preflight/lib.mjs";
import {
  buildWholeProjectIdentityManifest,
  verifyWholeProjectIdentityManifest,
} from "../frame_backend_preflight/project_identity.mjs";
import { verifyExecutionSegmentPlan } from "./lib.mjs";
import { buildExecutionInputs } from "./execution_inputs.mjs";
import { normalizeRenderContext } from "./executor_lib.mjs";
import {
  compileUniformScreenshotExecutionPlan,
  computeUniformScreenshotRenderPlanIdentity,
  issueProjectScopeMediaPolicyProof,
  recomputeUniformScreenshotProjectEvidence,
} from "./uniform_screenshot.mjs";

const here = dirname(fileURLToPath(import.meta.url));

function signedSeedPreflight({ projectIdentity, evidence, projectRoot }) {
  const renderPlanIdentity = `sha256:${"2".repeat(64)}`;
  const machineProfileIdentity = `sha256:${"3".repeat(64)}`;
  const validation = {
    validationIdentity: `sha256:${"4".repeat(64)}`,
    oracleBackendName: "screenshot",
    machineProfileIdentity,
    requiredGoldenFrames: [0, 1, 2],
    validatedGoldenFrames: [0, 1, 2],
    missingGoldenFrames: [],
    reasons: [],
  };
  const range = {
    startFrame: 0,
    endFrameExclusive: 3,
    backend: "screenshot",
    executable: true,
    decisionBasis: "oracle",
    gateProfileHash: null,
    styleOverrideProfileHash: null,
    requiresBrowserPaint: true,
    inventoryState: "incomplete",
    riskSignature: [],
    rejectedBackends: [{ backend: "proxy-tree", reason: "backend-ineligible", detail: evidence.proxyStaticGate.code }],
    goldenFrames: [0, 1, 2],
  };
  const mediaCore = {
    kind: "hyperframes-screenshot-media-policy-proof",
    schemaVersion: 1,
    selectedPolicy: "bounded-static",
    projectIdentity,
    renderPlanIdentity,
    machineProfileIdentity,
    styleOverrideProfileHash: null,
    auditSignature: evidence.screenshotAudit.auditSignature,
    determinismSignature: `sha256:${"5".repeat(64)}`,
    determinismPasses: 2,
    oracleValidationIdentity: validation.validationIdentity,
    oracleBackendName: "screenshot",
    reasons: [],
  };
  const mediaProof = { ...mediaCore, proofSignature: `sha256:${sha256(mediaCore)}` };
  const plan = {
    kind: "hyperframes-frame-backend-plan",
    schemaVersion: 2,
    projectIdentity,
    renderPlanIdentity,
    machineProfileIdentity,
    styleOverrideProfileHash: null,
    startFrame: 0,
    frameCount: 3,
    fps: { numerator: 60, denominator: 1 },
    ranges: [range],
    validation,
    validationState: "passed",
    executable: true,
    renderable: true,
  };
  const backendPlanCore = {
    kind: plan.kind,
    schemaVersion: plan.schemaVersion,
    projectIdentity: plan.projectIdentity,
    renderPlanIdentity: plan.renderPlanIdentity,
    machineProfileIdentity: plan.machineProfileIdentity,
    styleOverrideProfileHash: plan.styleOverrideProfileHash,
    startFrame: plan.startFrame,
    frameCount: plan.frameCount,
    fps: plan.fps,
    ranges: plan.ranges,
    validation: plan.validation,
  };
  const proofCore = {
    kind: "hyperframes-backend-preflight-execution-proof",
    schemaVersion: 1,
    backendPlanSignature: `sha256:${sha256(backendPlanCore)}`,
    screenshotMediaPolicy: mediaProof,
  };
  plan.proof = { ...proofCore, proofSignature: `sha256:${sha256(proofCore)}` };
  plan.preflight = {
    identities: { projectIdentityPolicy: "caller-supplied-strong" },
    staticGate: {
      passed: false,
      code: evidence.proxyStaticGate.code,
      details: {
        source: resolve(projectRoot, evidence.proxyStaticGate.source),
        reason: evidence.proxyStaticGate.reason,
        expression: evidence.proxyStaticGate.expression,
      },
    },
    screenshotAudit: evidence.screenshotAudit,
    screenshotMediaPolicy: "bounded-static",
  };
  return plan;
}

const scratch = mkdtempSync(resolve(tmpdir(), "hf-uniform-screenshot-"));
try {
  const projectRoot = resolve(scratch, "project");
  mkdirSync(resolve(projectRoot, "shared"), { recursive: true });
  mkdirSync(resolve(projectRoot, ".media/video"), { recursive: true });
  writeFileSync(resolve(projectRoot, "index.html"), [
    '<!doctype html><main data-composition-id="scene">',
    '<video class="clip" id="clip" width="16" height="16" src=".media/video/clip.mp4"></video>',
    "</main>",
    '<script src="shared/master.js"></script>',
  ].join(""));
  writeFileSync(
    resolve(projectRoot, "shared/master.js"),
    'gsap.set([".clip", window.name].join(", "), { opacity: 1 });\n',
  );
  writeFileSync(resolve(projectRoot, ".media/manifest.jsonl"), '{"id":"clip","path":".media/video/clip.mp4"}\n');
  writeFileSync(resolve(projectRoot, ".media/video/clip.mp4"), "fake-video-bytes");
  writeFileSync(resolve(projectRoot, "timing.json"), "{}\n");

  const manifest = await buildWholeProjectIdentityManifest({ projectRoot, include: ["timing.json"] });
  const manifestVerification = await verifyWholeProjectIdentityManifest({ manifest, projectRoot });
  assert.equal(manifestVerification.valid, true);
  const evidence = recomputeUniformScreenshotProjectEvidence({
    projectRoot,
    entryPath: resolve(projectRoot, "index.html"),
  });
  assert.equal(evidence.screenshotAudit.eligible, true);
  assert.equal(evidence.proxyStaticGate.passed, false);
  assert.equal(evidence.proxyStaticGate.code, "HF_PROXY_DYNAMIC_SELECTOR_UNAUDITED");

  const seed = signedSeedPreflight({ projectIdentity: manifest.projectIdentity, evidence, projectRoot });
  const projectProof = issueProjectScopeMediaPolicyProof({
    projectManifestVerification: manifestVerification,
    currentEvidence: evidence,
    seedPreflightPlan: seed,
    projectRoot,
  });
  assert.equal(projectProof.selectedPolicy, "bounded-static");
  assert.deepEqual(projectProof.reasons, []);
  assert.equal(projectProof.sourcePreflightBasis.seedFrameCount, 3);
  assert.equal(projectProof.sourcePreflightBasis.timelineAuthority, "none-project-scope-reissue-only");

  const mainScript = resolve(here, "../../full-canvas-main.mjs");
  const renderContext = {
    runtimeCommand: process.execPath,
    mainScript,
    projectRoot,
    entry: resolve(projectRoot, "index.html"),
    mediaTimingPlan: resolve(projectRoot, "timing.json"),
    mixProjectAudio: true,
    ffmpeg: resolve(here, "fixtures/fake_ffmpeg.mjs"),
    ffprobe: resolve(here, "fixtures/fake_ffprobe.mjs"),
  };
  const executionInputs = await buildExecutionInputs({
    renderContext: normalizeRenderContext(renderContext),
    projectManifest: manifest,
    projectManifestVerification: manifestVerification,
  });

  const target = {
    projectIdentity: manifest.projectIdentity,
    renderPlanIdentity: `sha256:${"6".repeat(64)}`,
    machineProfileIdentity: `sha256:${"7".repeat(64)}`,
    styleOverrideProfileHash: null,
    auditSignature: evidence.screenshotAudit.auditSignature,
    startFrame: 0,
    frameCount: 36_000,
    fps: { numerator: 60, denominator: 1 },
  };
  target.renderPlanIdentity = computeUniformScreenshotRenderPlanIdentity({ target, currentEvidence: evidence }).renderPlanIdentity;
  const compile = (overrides = {}) => compileUniformScreenshotExecutionPlan({
    target,
    projectManifestVerification: manifestVerification,
    currentEvidence: evidence,
    projectScopeProof: projectProof,
    executionInputs,
    ...overrides,
  });
  const full = compile();
  assert.equal(full.screenshotMediaPolicy, "bounded-static");
  assert.equal(full.timeline.frameCount, 36_000);
  assert.equal(full.segments[0].frameCount, 36_000);
  assert.equal(full.sourceProofSignature, projectProof.proofSignature);
  assert.notEqual(full.sourceProofSignature, seed.proof.proofSignature);
  assert.equal(full.targetRenderIdentity.verified, true);
  assert.equal(verifyExecutionSegmentPlan(full).valid, true);
  assert.equal(full.executionInputs.inputsIdentity, executionInputs.inputsIdentity);

  const stretched = structuredClone(full);
  stretched.timeline.frameCount += 1;
  stretched.segments[0].frameCount += 1;
  stretched.segments[0].endFrameExclusive += 1;
  assert.equal(verifyExecutionSegmentPlan(stretched).reason, "execution-plan-signature-mismatch");

  const directSeedReuse = compile({ projectScopeProof: seed });
  assert.equal(directSeedReuse.screenshotMediaPolicy, "faithful");
  assert.match(directSeedReuse.fallbackReason, /project-scope-proof-missing-or-schema-mismatch/);

  const seedTimelineIdentityReuse = compile({ target: { ...target, renderPlanIdentity: seed.renderPlanIdentity } });
  assert.equal(seedTimelineIdentityReuse.screenshotMediaPolicy, "faithful");
  assert.match(seedTimelineIdentityReuse.fallbackReason, /target-render-plan-identity-mismatch/);

  const tamperedProof = structuredClone(projectProof);
  tamperedProof.auditSignature = `sha256:${"8".repeat(64)}`;
  const tampered = compile({ projectScopeProof: tamperedProof });
  assert.equal(tampered.screenshotMediaPolicy, "faithful");
  assert.match(tampered.fallbackReason, /project-scope-proof-signature-mismatch/);

  const changedGateEvidence = structuredClone(evidence);
  changedGateEvidence.proxyStaticGate.passed = true;
  const changedGate = compile({ currentEvidence: changedGateEvidence });
  assert.equal(changedGate.screenshotMediaPolicy, "faithful");
  assert.match(changedGate.fallbackReason, /project-scope-proxy-static-gate-mismatch/);

  const missingProof = compile({ projectScopeProof: null });
  assert.equal(missingProof.screenshotMediaPolicy, "faithful");
  assert.match(missingProof.fallbackReason, /project-scope-proof-missing-or-schema-mismatch/);

  const wrongAudit = compile({ target: { ...target, auditSignature: `sha256:${"9".repeat(64)}` } });
  assert.equal(wrongAudit.screenshotMediaPolicy, "faithful");
  assert.match(wrongAudit.fallbackReason, /target-audit-signature-mismatch/);

  const missingExecutionInputs = compile({ executionInputs: null });
  assert.equal(missingExecutionInputs.screenshotMediaPolicy, "faithful");
  assert.match(missingExecutionInputs.fallbackReason, /execution-inputs-schema-mismatch/);

  const proofPath = resolve(scratch, "project-proof.json");
  const manifestPath = resolve(scratch, "manifest.json");
  const targetPath = resolve(scratch, "target.json");
  const contextPath = resolve(scratch, "render-context.json");
  const cliOutput = resolve(scratch, "cli-full-plan.json");
  writeFileSync(proofPath, `${JSON.stringify(projectProof)}\n`);
  writeFileSync(manifestPath, `${JSON.stringify(manifest)}\n`);
  writeFileSync(targetPath, `${JSON.stringify(target)}\n`);
  writeFileSync(contextPath, `${JSON.stringify(renderContext)}\n`);
  execFileSync(process.execPath, [
    resolve(here, "cli.mjs"),
    "compile-uniform-screenshot",
    `--project-manifest=${manifestPath}`,
    `--project-root=${projectRoot}`,
    `--entry=${resolve(projectRoot, "index.html")}`,
    `--context=${contextPath}`,
    `--project-scope-proof=${proofPath}`,
    `--target=${targetPath}`,
    `--output=${cliOutput}`,
  ]);
  const cliPlan = JSON.parse(readFileSync(cliOutput, "utf8"));
  assert.equal(cliPlan.screenshotMediaPolicy, "bounded-static");
  assert.equal(cliPlan.timeline.frameCount, 36_000);
  console.log("uniform screenshot project-scope compiler tests passed");
} finally {
  rmSync(scratch, { recursive: true, force: true });
}
