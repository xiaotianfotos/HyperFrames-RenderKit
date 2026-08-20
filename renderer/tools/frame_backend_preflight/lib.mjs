import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { runInNewContext } from "node:vm";

const moduleRoot = dirname(fileURLToPath(import.meta.url));
export const rendererRoot = resolve(moduleRoot, "../..");

export function canonicalJson(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
}

export function sha256(value) {
  const bytes = Buffer.isBuffer(value) || value instanceof Uint8Array
    ? value
    : Buffer.from(typeof value === "string" ? value : canonicalJson(value));
  return createHash("sha256").update(bytes).digest("hex");
}

export function buildScreenshotAuditEvidence({ report, projectRoot, entrySha256 }) {
  const scannedScripts = (report?.boundedStatic?.scannedScripts ?? []).map((scriptPath) => ({
    projectRelative: relative(projectRoot, scriptPath),
    sha256: sha256(readFileSync(scriptPath)),
  })).sort((left, right) => left.projectRelative.localeCompare(right.projectRelative));
  const evidence = {
    kind: report?.kind ?? null,
    schemaVersion: report?.schemaVersion ?? null,
    entrySha256,
    eligible: report?.boundedStatic?.eligible === true,
    contract: report?.boundedStatic?.contract ?? null,
    media: report?.boundedStatic?.media ?? [],
    blockers: report?.boundedStatic?.blockers ?? [],
    scannedScripts,
  };
  return { ...evidence, auditSignature: `sha256:${sha256(evidence)}` };
}

export function verifyExecutionProof(plan, expected) {
  const fail = (reason) => ({ valid: false, executable: false, screenshotMediaPolicy: "faithful", reason });
  if (plan?.kind !== "hyperframes-frame-backend-plan" || plan?.schemaVersion !== 2) return fail("plan-schema-mismatch");
  if (plan.executable !== true || plan.validationState !== "passed") return fail("plan-not-executable");
  const proof = plan.proof;
  if (proof?.kind !== "hyperframes-backend-preflight-execution-proof" || proof?.schemaVersion !== 1) {
    return fail("execution-proof-missing");
  }
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
  if (proof.backendPlanSignature !== `sha256:${sha256(backendPlanCore)}`) return fail("backend-plan-signature-mismatch");
  const mediaProof = proof.screenshotMediaPolicy;
  if (mediaProof?.kind !== "hyperframes-screenshot-media-policy-proof" || mediaProof?.schemaVersion !== 1) {
    return fail("screenshot-media-policy-proof-missing");
  }
  const { proofSignature: mediaSignature, ...mediaCore } = mediaProof;
  if (mediaSignature !== `sha256:${sha256(mediaCore)}`) return fail("screenshot-media-policy-proof-signature-mismatch");
  if (!Array.isArray(mediaProof.reasons)) return fail("screenshot-media-policy-reasons-invalid");
  const { proofSignature, ...proofCore } = proof;
  if (proofSignature !== `sha256:${sha256(proofCore)}`) return fail("execution-proof-signature-mismatch");
  for (const key of ["projectIdentity", "renderPlanIdentity", "machineProfileIdentity", "styleOverrideProfileHash"]) {
    const expectedValue = expected?.[key] ?? null;
    if ((plan[key] ?? null) !== expectedValue || (mediaProof[key] ?? null) !== expectedValue) {
      return fail(`${key}-mismatch`);
    }
  }
  if (mediaProof.auditSignature !== expected?.auditSignature) return fail("screenshot-audit-signature-mismatch");
  if (mediaProof.oracleValidationIdentity !== plan.validation?.validationIdentity) {
    return fail("oracle-validation-identity-mismatch");
  }
  if (!Number.isSafeInteger(mediaProof.determinismPasses) || mediaProof.determinismPasses < 2) {
    return fail("dual-run-determinism-not-proven");
  }
  if (mediaProof.selectedPolicy === "bounded-static" && mediaProof.reasons.length !== 0) {
    return fail("bounded-static-proof-has-rejections");
  }
  if (!new Set(["bounded-static", "faithful"]).has(mediaProof.selectedPolicy)) {
    return fail("unknown-screenshot-media-policy");
  }
  return {
    valid: true,
    executable: true,
    screenshotMediaPolicy: mediaProof.selectedPolicy,
    backendPlanSignature: proof.backendPlanSignature,
    proofSignature,
  };
}

export function loadPlanRuntime() {
  const sandbox = {};
  runInNewContext(readFileSync(resolve(rendererRoot, "frame-backend-plan-runtime.js"), "utf8"), sandbox);
  if (sandbox.HyperframesFrameBackendPlan?.SCHEMA_VERSION !== 2) {
    throw new Error("FrameBackendPlan schema v2 runtime is unavailable");
  }
  return sandbox.HyperframesFrameBackendPlan;
}

export function uniqueGoldenFrames(plan) {
  return [...new Set((plan?.ranges ?? []).flatMap((range) => range.goldenFrames ?? []))]
    .sort((left, right) => left - right);
}

export function riskProfileKey({ riskSignature, requiresBrowserPaint }) {
  return canonicalJson({ requiresBrowserPaint, riskSignature });
}

export function signatureIsFastProofEligible(signature) {
  return Array.isArray(signature) && signature.every((atom) => (
    atom?.classification === "known"
    && atom?.blocker !== true
    && atom?.pseudoGeometryUnknown !== true
    && Array.isArray(atom?.blockedBackends)
    && atom.blockedBackends.length === 0
    && atom.property != null
    && atom.value != null
    && atom.rect != null
    && atom.intersectionArea != null
    && atom.cumulativeOpacity != null
  ));
}

export function signatureToRisks(signature) {
  return signature.map((atom) => {
    const classification = atom.classification ?? "unknown";
    return {
      id: atom.id,
      feature: atom.feature,
      active: true,
      blocker: atom.blocker === true,
      blockedBackends: atom.blockedBackends ?? [],
      unknown: classification !== "known",
      unknownReasons: classification === "known" ? [] : [classification],
      evidence: {
        property: atom.property,
        value: atom.value,
        rect: atom.rect,
        intersectionArea: atom.intersectionArea,
        cumulativeOpacity: atom.cumulativeOpacity,
        pseudoGeometryUnknown: atom.pseudoGeometryUnknown === true,
        uninspectable: classification === "uninspectable",
        dynamicRiskNode: classification.includes("unknown-node"),
        unknownFeature: classification.includes("unknown-feature"),
      },
    };
  });
}

function builderOptions(options, backends, onRange = null) {
  return {
    frameCount: options.frameCount,
    startFrame: options.startFrame,
    fpsNumerator: options.fpsNumerator,
    fpsDenominator: options.fpsDenominator,
    backends,
    order: ["proxy-tree", "screenshot"],
    mode: "production",
    projectIdentity: options.projectIdentity,
    renderPlanIdentity: options.renderPlanIdentity,
    machineProfileIdentity: options.machineProfileIdentity,
    styleOverrideProfileHash: options.styleOverrideProfileHash,
    retainRanges: true,
    maxRetainedRanges: options.maxRetainedRanges,
    maxRetainedBlockerRanges: options.maxRetainedBlockerRanges,
    ...(onRange ? { onRange } : {}),
  };
}

export function compileDetailedPlan({
  runtime,
  sourcePlan,
  options,
  backend,
  provenRiskProfiles,
}) {
  const proofs = [];
  for (const range of sourcePlan.ranges) {
    const profileKey = riskProfileKey(range);
    if (!provenRiskProfiles.has(profileKey)) continue;
    proofs.push({
      projectIdentity: options.projectIdentity,
      renderPlanIdentity: options.renderPlanIdentity,
      machineProfileIdentity: options.machineProfileIdentity,
      gateProfileHash: backend.gateProfileHash,
      styleOverrideProfileHash: options.styleOverrideProfileHash,
      requiresBrowserPaint: range.requiresBrowserPaint,
      riskSignature: range.riskSignature,
    });
  }
  const uniqueProofs = [...new Map(proofs.map((proof) => [riskProfileKey(proof), proof])).values()];
  const backends = [
    {
      name: "proxy-tree",
      eligible: backend.eligible,
      ineligibleReason: backend.ineligibleReason ?? null,
      gateProfileHash: backend.gateProfileHash ?? null,
      provenRiskSignatures: uniqueProofs,
    },
    { name: "screenshot", eligible: true, oracle: true },
  ];
  const builder = runtime.createFrameBackendPlanBuilder(builderOptions(options, backends));
  for (const range of sourcePlan.ranges) {
    const risks = signatureToRisks(range.riskSignature);
    for (let timelineFrame = range.startFrame; timelineFrame < range.endFrameExclusive; timelineFrame += 1) {
      builder.addFrame({
        timelineFrame,
        inventoryState: range.inventoryState,
        requiresBrowserPaint: range.requiresBrowserPaint,
        risks,
      });
    }
  }
  const plan = builder.finish();
  plan.determinism = sourcePlan.determinism;
  plan.prepassSummary = sourcePlan.prepassSummary;
  return plan;
}

export function compileOracleOnlyPlan({ runtime, options, sourcePlan, reason }) {
  const backends = [
    { name: "proxy-tree", eligible: false, ineligibleReason: reason },
    { name: "screenshot", eligible: true, oracle: true },
  ];
  const builder = runtime.createFrameBackendPlanBuilder(builderOptions(options, backends));
  const risk = {
    id: ":backend-preflight-policy",
    feature: "oracle-only-fallback",
    active: true,
    blockedBackends: ["proxy-tree"],
    evidence: {
      property: "fallbackReason",
      value: reason,
      rect: { left: 0, top: 0, right: 0, bottom: 0, width: 0, height: 0 },
      intersectionArea: 0,
      cumulativeOpacity: 1,
      pseudoGeometryUnknown: false,
      code: reason,
    },
  };
  for (let offset = 0; offset < options.frameCount; offset += 1) {
    builder.addFrame({
      timelineFrame: options.startFrame + offset,
      inventoryState: "oracle-only-collapsed",
      requiresBrowserPaint: true,
      risks: [risk],
    });
  }
  const plan = builder.finish();
  plan.determinism = sourcePlan.determinism;
  plan.prepassSummary = {
    ...(sourcePlan.prepassSummary ?? {}),
    oracleOnlyCollapsed: true,
    oracleOnlyReason: reason,
    detailedRangeCount: sourcePlan.summary.rangeCount,
  };
  return plan;
}

export function compareBitmaps(left, right, {
  width,
  height,
  maxAbsoluteDifference = 2,
  maxRmse = 0.5,
  maxDifferentPixelRatio = 0.0001,
} = {}) {
  if (!Buffer.isBuffer(left)) left = Buffer.from(left);
  if (!Buffer.isBuffer(right)) right = Buffer.from(right);
  const expectedLength = width * height * 4;
  if (left.length !== expectedLength || right.length !== expectedLength) {
    return {
      passed: false,
      reason: "bitmap-size-mismatch",
      expectedLength,
      leftLength: left.length,
      rightLength: right.length,
    };
  }
  let sumSquares = 0;
  let peak = 0;
  let differentPixels = 0;
  for (let offset = 0; offset < expectedLength; offset += 4) {
    let pixelDifferent = false;
    for (let channel = 0; channel < 4; channel += 1) {
      const difference = Math.abs(left[offset + channel] - right[offset + channel]);
      peak = Math.max(peak, difference);
      sumSquares += difference * difference;
      if (difference > maxAbsoluteDifference) pixelDifferent = true;
    }
    if (pixelDifferent) differentPixels += 1;
  }
  const rmse = Math.sqrt(sumSquares / expectedLength);
  const differentPixelRatio = differentPixels / (width * height);
  return {
    passed: peak <= maxAbsoluteDifference
      && rmse <= maxRmse
      && differentPixelRatio <= maxDifferentPixelRatio,
    reason: "pixel-comparison",
    peak,
    rmse,
    differentPixels,
    differentPixelRatio,
    thresholds: { maxAbsoluteDifference, maxRmse, maxDifferentPixelRatio },
  };
}
