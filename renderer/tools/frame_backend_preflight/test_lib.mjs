#!/usr/bin/env node

import assert from "node:assert/strict";
import {
  compareBitmaps,
  compileDetailedPlan,
  compileOracleOnlyPlan,
  loadPlanRuntime,
  riskProfileKey,
  signatureIsFastProofEligible,
  uniqueGoldenFrames,
} from "./lib.mjs";

const runtime = loadPlanRuntime();
const identities = {
  projectIdentity: "project-sha",
  renderPlanIdentity: "render-sha",
  machineProfileIdentity: "machine-sha",
  styleOverrideProfileHash: null,
};
const options = {
  frameCount: 3,
  startFrame: 0,
  fpsNumerator: 60,
  fpsDenominator: 1,
  maxRetainedRanges: 32,
  maxRetainedBlockerRanges: 8,
  ...identities,
};
const risk = {
  id: "#title",
  feature: "browser-paint-active",
  evidence: {
    property: "text-content",
    value: "hello",
    rect: { left: 0, top: 0, right: 100, bottom: 20, width: 100, height: 20 },
    intersectionArea: 2_000,
    cumulativeOpacity: 1,
  },
};
const source = runtime.compileFrameBackendPlan({
  ...options,
  frames: Array.from({ length: 3 }, (_, timelineFrame) => ({
    timelineFrame,
    inventoryState: "complete",
    requiresBrowserPaint: true,
    risks: [risk],
  })),
  backends: [{ name: "screenshot", eligible: true, oracle: true }],
  order: ["screenshot"],
});
source.determinism = { state: "passed", passes: 2 };
assert.deepEqual(uniqueGoldenFrames(source), [0, 1, 2]);
assert.equal(signatureIsFastProofEligible(source.ranges[0].riskSignature), true);

const profile = riskProfileKey(source.ranges[0]);
const detailed = compileDetailedPlan({
  runtime,
  sourcePlan: source,
  options,
  backend: { eligible: true, gateProfileHash: "gate-sha" },
  provenRiskProfiles: new Set([profile]),
});
assert.equal(detailed.ranges.length, 1);
assert.equal(detailed.ranges[0].backend, "proxy-tree");
assert.equal(detailed.determinism.state, "passed");

const oracleOnly = compileOracleOnlyPlan({
  runtime,
  options,
  sourcePlan: source,
  reason: "HF_PROXY_DYNAMIC_SELECTOR_UNAUDITED",
});
assert.equal(oracleOnly.ranges.length, 1);
assert.equal(oracleOnly.ranges[0].backend, "screenshot");
assert.equal(oracleOnly.summary.blockerFrames, 0);
assert.equal(oracleOnly.ranges[0].rejectedBackends[0].detail, "HF_PROXY_DYNAMIC_SELECTOR_UNAUDITED");

const left = Buffer.alloc(2 * 2 * 4, 10);
const right = Buffer.from(left);
assert.equal(compareBitmaps(left, right, { width: 2, height: 2 }).passed, true);
right[0] = 255;
const mismatch = compareBitmaps(left, right, { width: 2, height: 2 });
assert.equal(mismatch.passed, false);
assert.equal(mismatch.differentPixels, 1);
assert.equal(compareBitmaps(Buffer.alloc(1), right, { width: 2, height: 2 }).reason, "bitmap-size-mismatch");

console.log("frame backend preflight library tests passed");
