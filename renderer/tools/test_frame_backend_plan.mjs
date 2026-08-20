#!/usr/bin/env node

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { runInNewContext } from "node:vm";

const rendererRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const source = readFileSync(resolve(rendererRoot, "frame-backend-plan-runtime.js"), "utf8");
const sandbox = {};
runInNewContext(source, sandbox);
const runtime = sandbox.HyperframesFrameBackendPlan;
const plain = (value) => JSON.parse(JSON.stringify(value));

const identities = Object.freeze({
  projectIdentity: "project-sha",
  renderPlanIdentity: "render-plan-sha",
  machineProfileIdentity: "machine-sha",
  styleOverrideProfileHash: "style-sha",
});
const defaultRect = Object.freeze({ left: 0, top: 0, right: 100, bottom: 100, width: 100, height: 100 });

function risk(id, feature, value, {
  property = feature,
  rect = defaultRect,
  opacity = 1,
  intersectionArea = 10_000,
  unknown = false,
  unknownReasons = [],
  blocker = false,
  blockedBackends = [],
  code = null,
  pseudoGeometryUnknown = false,
} = {}) {
  return {
    id,
    feature,
    unknown,
    unknownReasons,
    blocker,
    blockedBackends,
    evidence: {
      property,
      value,
      rect,
      cumulativeOpacity: opacity,
      intersectionArea,
      pseudoGeometryUnknown,
      ...(code == null ? {} : { code }),
    },
  };
}

function proof(gateProfileHash, risks, requiresBrowserPaint, overrides = {}) {
  return {
    ...identities,
    gateProfileHash,
    requiresBrowserPaint,
    riskSignature: runtime.createRiskSignature(risks),
    ...overrides,
  };
}

function proxyBackend(proofs, extra = {}) {
  return {
    name: "proxy-tree",
    eligible: true,
    gateProfileHash: "proxy-gate-sha",
    provenRiskSignatures: proofs,
    ...extra,
  };
}

const screenshotBackend = Object.freeze({ name: "screenshot", eligible: true, oracle: true });
const glassRisk = risk("#glass", "backdrop-filter", "blur(10px)");
const cleanProof = proof("proxy-gate-sha", [], true);

const frameCount = 900;
const frames = Array.from({ length: frameCount }, (_, timelineFrame) => ({
  timelineFrame,
  inventoryState: "complete",
  requiresBrowserPaint: true,
  risks: timelineFrame >= 120 && timelineFrame < 180 ? [glassRisk] : [],
}));

const plan = runtime.compileFrameBackendPlan({
  frameCount,
  fpsNumerator: 60,
  frames,
  backends: [proxyBackend([cleanProof]), screenshotBackend],
  ...identities,
});

assert.equal(runtime.SCHEMA_VERSION, 2);
assert.deepEqual(plain(plan.fps), { numerator: 60, denominator: 1 });
assert.deepEqual(plain(plan.ranges.map((range) => [range.startFrame, range.endFrameExclusive, range.backend])), [
  [0, 120, "proxy-tree"],
  [120, 180, "screenshot"],
  [180, 900, "proxy-tree"],
]);
assert.deepEqual(plain(plan.ranges.map((range) => range.goldenFrames)), [
  [0, 1, 118, 119, 120],
  [119, 120, 121, 178, 179, 180],
  [179, 180, 181, 898, 899],
]);
assert.equal(plan.ranges[1].riskSignature[0].value, "blur(10px)");
assert.deepEqual(JSON.parse(JSON.stringify(plan.summary.framesByBackend)), {
  "proxy-tree": 840,
  screenshot: 60,
});
assert.equal(plan.validationState, "pending");
assert.equal(plan.renderable, false);
assert.equal(plan.executable, false);
assert.equal(plan.ranges.every((range) => range.executable === false), true);

// Only an explicit, complete screenshot-oracle validation may make a plan executable.
plan.determinism = { state: "passed", passes: 2 };
const requiredGoldenFrames = [...new Set(plan.ranges.flatMap((range) => range.goldenFrames))];
const finalized = runtime.finalizeWithOracleValidation(plan, {
  passed: true,
  oracleBackendName: "screenshot",
  machineProfileIdentity: identities.machineProfileIdentity,
  validationIdentity: "golden-run-sha",
  validatedGoldenFrames: requiredGoldenFrames,
});
assert.equal(finalized.validationState, "passed");
assert.equal(finalized.renderable, true);
assert.equal(finalized.ranges.every((range) => range.executable), true);
const incompleteGolden = runtime.finalizeWithOracleValidation(plan, {
  passed: true,
  oracleBackendName: "screenshot",
  machineProfileIdentity: identities.machineProfileIdentity,
  validationIdentity: "golden-run-sha",
  validatedGoldenFrames: requiredGoldenFrames.slice(1),
});
assert.equal(incompleteGolden.renderable, false);
assert.ok(incompleteGolden.validation.reasons.includes("golden-frame-coverage-incomplete"));

// A hard blocker is accepted by neither a fast backend nor the oracle and is never executable.
const protectedRisk = risk("#drm", "protected-content", "attached", { property: "mediaKeys", blocker: true });
const blocked = runtime.compileFrameBackendPlan({
  startFrame: 100,
  frameCount: 2,
  fpsNumerator: 60,
  frames: [
    { timelineFrame: 100, inventoryState: "complete", requiresBrowserPaint: true, risks: [] },
    { timelineFrame: 101, inventoryState: "complete", requiresBrowserPaint: true, risks: [protectedRisk] },
  ],
  backends: [proxyBackend([cleanProof]), screenshotBackend],
  ...identities,
});
assert.equal(blocked.summary.blockerFrames, 1);
assert.equal(blocked.summary.blockerRangeCount, 1);
assert.equal(blocked.ranges.at(-1).backend, "fail");
assert.equal(blocked.ranges.at(-1).executable, false);
assert.equal(blocked.blockers[0].startFrame, 101);
assert.equal(blocked.blockers[0].endFrameExclusive, 102);

// Counterexample: a matching proof still cannot promote a runtime-unknown node/feature.
const unknownGlass = risk("#dynamic", "backdrop-filter", "blur(10px)", {
  unknown: true,
  unknownReasons: ["unknown-node"],
});
const unknownPlan = runtime.compileFrameBackendPlan({
  frameCount: 1,
  fpsNumerator: 60,
  frames: [{ timelineFrame: 0, inventoryState: "complete", requiresBrowserPaint: true, risks: [unknownGlass] }],
  backends: [proxyBackend([proof("proxy-gate-sha", [unknownGlass], true)]), screenshotBackend],
  ...identities,
});
assert.equal(unknownPlan.ranges[0].backend, "screenshot");

// Counterexamples: value, geometry, opacity, combination, and profile are exact proof dimensions.
const filter10 = risk("#card", "filter", "blur(10px)");
const filter12 = risk("#card", "filter", "blur(12px)");
const shiftedFilter = risk("#card", "filter", "blur(10px)", {
  rect: { left: 1, top: 0, right: 101, bottom: 100, width: 100, height: 100 },
});
const fadedFilter = risk("#card", "filter", "blur(10px)", { opacity: 0.5 });
const blend = risk("#card", "mix-blend-mode", "screen");
const exactProofBackend = proxyBackend([proof("proxy-gate-sha", [filter10], true)]);
for (const risks of [[filter12], [shiftedFilter], [fadedFilter], [filter10, blend]]) {
  const counterexample = runtime.compileFrameBackendPlan({
    frameCount: 1,
    fpsNumerator: 60,
    frames: [{ timelineFrame: 0, inventoryState: "complete", requiresBrowserPaint: true, risks }],
    backends: [exactProofBackend, screenshotBackend],
    ...identities,
  });
  assert.equal(counterexample.ranges[0].backend, "screenshot");
}
const wrongMachineProof = proof("proxy-gate-sha", [filter10], true, { machineProfileIdentity: "other-machine" });
const wrongProfile = runtime.compileFrameBackendPlan({
  frameCount: 1,
  fpsNumerator: 60,
  frames: [{ timelineFrame: 0, inventoryState: "complete", requiresBrowserPaint: true, risks: [filter10] }],
  backends: [proxyBackend([wrongMachineProof]), screenshotBackend],
  ...identities,
});
assert.equal(wrongProfile.ranges[0].backend, "screenshot");
const wrongStyleProof = proof("proxy-gate-sha", [filter10], true, { styleOverrideProfileHash: "other-style" });
const wrongStyleProfile = runtime.compileFrameBackendPlan({
  frameCount: 1,
  fpsNumerator: 60,
  frames: [{ timelineFrame: 0, inventoryState: "complete", requiresBrowserPaint: true, risks: [filter10] }],
  backends: [proxyBackend([wrongStyleProof]), screenshotBackend],
  ...identities,
});
assert.equal(wrongStyleProfile.ranges[0].backend, "screenshot");

// Ordinary browser paint is a separate dimension and ffmpeg-only can never claim to support it.
const ffmpegBackend = {
  name: "ffmpeg-only",
  eligible: true,
  gateProfileHash: "ffmpeg-gate-sha",
  supportsBrowserPaint: true,
  provenRiskSignatures: [
    proof("ffmpeg-gate-sha", [], true),
    proof("ffmpeg-gate-sha", [], false),
  ],
};
const browserPaintPlan = runtime.compileFrameBackendPlan({
  frameCount: 1,
  fpsNumerator: 60,
  frames: [{ timelineFrame: 0, inventoryState: "complete", requiresBrowserPaint: true, risks: [] }],
  backends: [ffmpegBackend, proxyBackend([cleanProof]), screenshotBackend],
  ...identities,
});
assert.equal(browserPaintPlan.ranges[0].backend, "proxy-tree");
const mediaOnlyPlan = runtime.compileFrameBackendPlan({
  frameCount: 1,
  fpsNumerator: 60,
  frames: [{ timelineFrame: 0, inventoryState: "complete", requiresBrowserPaint: false, risks: [] }],
  backends: [ffmpegBackend, screenshotBackend],
  ...identities,
});
assert.equal(mediaOnlyPlan.ranges[0].backend, "ffmpeg-only");
const falsifiedPaintFlag = runtime.compileFrameBackendPlan({
  frameCount: 1,
  fpsNumerator: 60,
  frames: [{ timelineFrame: 0, inventoryState: "complete", requiresBrowserPaint: false, risks: [filter10] }],
  backends: [
    {
      ...ffmpegBackend,
      provenRiskSignatures: [proof("ffmpeg-gate-sha", [filter10], false)],
    },
    screenshotBackend,
  ],
  ...identities,
});
assert.equal(falsifiedPaintFlag.ranges[0].backend, "screenshot");
assert.equal(falsifiedPaintFlag.ranges[0].requiresBrowserPaint, true);

// Missing inventory and legacy feature allowlists fail closed to the oracle.
const incompleteInventory = runtime.compileFrameBackendPlan({
  frameCount: 1,
  fpsNumerator: 60,
  frames: [{ timelineFrame: 0, requiresBrowserPaint: true, risks: [] }],
  backends: [proxyBackend([cleanProof]), screenshotBackend],
  ...identities,
});
assert.equal(incompleteInventory.ranges[0].backend, "screenshot");
const missingRiskArray = runtime.compileFrameBackendPlan({
  frameCount: 1,
  fpsNumerator: 60,
  frames: [{ timelineFrame: 0, inventoryState: "complete", requiresBrowserPaint: true }],
  backends: [proxyBackend([cleanProof]), screenshotBackend],
  ...identities,
});
assert.equal(missingRiskArray.ranges[0].backend, "screenshot");
const legacyPolicy = runtime.compileFrameBackendPlan({
  frameCount: 1,
  fpsNumerator: 60,
  frames: [{ timelineFrame: 0, inventoryState: "complete", requiresBrowserPaint: true, risks: [glassRisk] }],
  backends: [proxyBackend([], { supportedFeatures: ["backdrop-filter"], allowsUnknown: true }), screenshotBackend],
  ...identities,
});
assert.equal(legacyPolicy.ranges[0].backend, "screenshot");
assert.match(legacyPolicy.warnings[0], /ignored/);

// A proxy-only static audit failure is a screenshot fallback, not a global blocker.
const staticProxyFallback = runtime.compileFrameBackendPlan({
  frameCount: 1,
  fpsNumerator: 60,
  frames: [{ timelineFrame: 0, inventoryState: "complete", requiresBrowserPaint: true, risks: [] }],
  backends: [
    { name: "proxy-tree", eligible: false, ineligibleReason: "HF_PROXY_DYNAMIC_SELECTOR_UNAUDITED" },
    screenshotBackend,
  ],
  ...identities,
});
assert.equal(staticProxyFallback.ranges[0].backend, "screenshot");
assert.equal(staticProxyFallback.summary.blockerFrames, 0);
assert.deepEqual(plain(staticProxyFallback.ranges[0].rejectedBackends), [{
  backend: "proxy-tree",
  reason: "backend-ineligible",
  detail: "HF_PROXY_DYNAMIC_SELECTOR_UNAUDITED",
}]);

const dynamicSelectorRisk = risk("master.js:helper", "proxy-static-audit", "HF_PROXY_DYNAMIC_SELECTOR_UNAUDITED", {
  property: "audit-code",
  blockedBackends: ["proxy-tree"],
  code: "HF_PROXY_DYNAMIC_SELECTOR_UNAUDITED",
});
const rangedProxyFallback = runtime.compileFrameBackendPlan({
  frameCount: 3,
  fpsNumerator: 60,
  frames: [
    { timelineFrame: 0, inventoryState: "complete", requiresBrowserPaint: true, risks: [] },
    { timelineFrame: 1, inventoryState: "complete", requiresBrowserPaint: true, risks: [dynamicSelectorRisk] },
    { timelineFrame: 2, inventoryState: "complete", requiresBrowserPaint: true, risks: [] },
  ],
  backends: [proxyBackend([cleanProof]), screenshotBackend],
  ...identities,
});
assert.deepEqual(plain(rangedProxyFallback.ranges.map((range) => range.backend)), ["proxy-tree", "screenshot", "proxy-tree"]);
assert.equal(rangedProxyFallback.summary.blockerFrames, 0);
assert.equal(rangedProxyFallback.ranges[1].rejectedBackends[0].reason, "backend-specific-blocker");

// Audit mode is bounded by default and is never an executable artifact.
let auditRangeCount = 0;
const audit = runtime.compileFrameBackendPlan({
  frameCount: 4,
  fpsNumerator: 60,
  frames: Array.from({ length: 4 }, (_, timelineFrame) => ({
    timelineFrame,
    inventoryState: "complete",
    requiresBrowserPaint: true,
    risks: [],
  })),
  backends: [screenshotBackend],
  mode: "audit",
  onRange: () => { auditRangeCount += 1; },
});
assert.equal(audit.summary.rangeCount, 1);
assert.equal(auditRangeCount, 1);
assert.equal(audit.ranges.length, 0);
assert.equal(audit.renderable, false);

const identityless = runtime.compileFrameBackendPlan({
  frameCount: 1,
  fpsNumerator: 60,
  frames: [{ timelineFrame: 0, inventoryState: "complete", requiresBrowserPaint: true, risks: [] }],
  backends: [screenshotBackend],
});
identityless.determinism = { state: "passed", passes: 2 };
const identitylessFinal = runtime.finalizeWithOracleValidation(identityless, {
  passed: true,
  oracleBackendName: "screenshot",
  machineProfileIdentity: null,
  validationIdentity: "golden-run-sha",
  validatedGoldenFrames: identityless.ranges[0].goldenFrames,
});
assert.equal(identitylessFinal.renderable, false);
assert.ok(identitylessFinal.validation.reasons.includes("plan-identities-incomplete"));

// 38,125 alternating signatures do not cause unbounded retained range growth.
const alternatingCount = 36_000;
let streamedRangeCount = 0;
const alternating = runtime.createFrameBackendPlanBuilder({
  frameCount: alternatingCount,
  fpsNumerator: 60,
  backends: [proxyBackend([cleanProof]), screenshotBackend],
  maxRetainedRanges: 64,
  onRange: () => { streamedRangeCount += 1; },
  ...identities,
});
for (let timelineFrame = 0; timelineFrame < alternatingCount; timelineFrame += 1) {
  alternating.addFrame({
    timelineFrame,
    inventoryState: "complete",
    requiresBrowserPaint: true,
    risks: timelineFrame % 2 === 0 ? [] : [glassRisk],
  });
}
const alternatingPlan = alternating.finish();
assert.equal(alternatingPlan.summary.rangeCount, alternatingCount);
assert.equal(streamedRangeCount, alternatingCount);
assert.equal(alternatingPlan.ranges.length, 64);
assert.equal(alternatingPlan.summary.rangesTruncated, true);
assert.equal(alternatingPlan.renderable, false);

const repeatedBlockers = runtime.createFrameBackendPlanBuilder({
  frameCount: 1000,
  fpsNumerator: 60,
  backends: [screenshotBackend],
  maxRetainedBlockerRanges: 2,
  ...identities,
});
for (let timelineFrame = 0; timelineFrame < 1000; timelineFrame += 1) {
  repeatedBlockers.addFrame({
    timelineFrame,
    inventoryState: "complete",
    requiresBrowserPaint: true,
    risks: [protectedRisk],
  });
}
const repeatedBlockerPlan = repeatedBlockers.finish();
assert.equal(repeatedBlockerPlan.summary.blockerFrames, 1000);
assert.equal(repeatedBlockerPlan.blockers.length, 1);
assert.deepEqual([repeatedBlockerPlan.blockers[0].startFrame, repeatedBlockerPlan.blockers[0].endFrameExclusive], [0, 1000]);

// Strict configuration validation rejects ambiguous or accidentally incomplete policies.
assert.throws(() => runtime.createFrameBackendPlanBuilder({
  frameCount: 1,
  fpsNumerator: 60,
  backends: [{ name: "proxy-tree", eligible: true }],
}), /gateProfileHash/);
assert.throws(() => runtime.createFrameBackendPlanBuilder({
  frameCount: 1,
  fpsNumerator: 60,
  backends: [screenshotBackend, screenshotBackend],
}), /duplicate backend/);
assert.throws(() => runtime.createFrameBackendPlanBuilder({
  frameCount: 1,
  fpsNumerator: 60,
  backends: [screenshotBackend],
  order: ["missing"],
}), /unknown backend/);
assert.throws(() => runtime.compileFrameBackendPlan({
  frameCount: 2,
  fpsNumerator: 60,
  frames: [{ timelineFrame: 0 }],
  backends: [screenshotBackend],
}), /exactly 2/);

console.log("frame backend plan tests passed");
