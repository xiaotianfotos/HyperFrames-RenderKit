#!/usr/bin/env node

import assert from "node:assert/strict";
import {
  DEFAULT_MOV_CONTRACT,
  compileSegmentExecutionPlan,
  evaluateMovStreamCopyConcat,
  verifyExecutionSegmentPlan,
} from "./lib.mjs";
import { sha256 } from "../frame_backend_preflight/lib.mjs";

const expected = {
  projectIdentity: `sha256:${"1".repeat(64)}`,
  renderPlanIdentity: `sha256:${"2".repeat(64)}`,
  machineProfileIdentity: `sha256:${"3".repeat(64)}`,
  styleOverrideProfileHash: null,
  auditSignature: `sha256:${"4".repeat(64)}`,
  startFrame: 100,
  frameCount: 12,
  fps: { numerator: 60, denominator: 1 },
};

const knownAtom = {
  id: "#title",
  feature: "browser-paint-active",
  property: "text-content",
  value: "hello",
  rect: { left: 0, top: 0, right: 100, bottom: 20, width: 100, height: 20 },
  intersectionArea: 2_000,
  cumulativeOpacity: 1,
  pseudoGeometryUnknown: false,
  classification: "known",
  blocker: false,
  blockedBackends: [],
};

function signedPreflight(ranges, { pending = false, mediaPolicy = "bounded-static" } = {}) {
  const validation = {
    validationIdentity: "sha256:oracle",
    oracleBackendName: "screenshot",
    machineProfileIdentity: expected.machineProfileIdentity,
    requiredGoldenFrames: [100, 111],
    validatedGoldenFrames: [100, 111],
    missingGoldenFrames: [],
    reasons: [],
  };
  const plan = {
    kind: "hyperframes-frame-backend-plan",
    schemaVersion: 2,
    mode: "production",
    projectIdentity: expected.projectIdentity,
    renderPlanIdentity: expected.renderPlanIdentity,
    machineProfileIdentity: expected.machineProfileIdentity,
    styleOverrideProfileHash: expected.styleOverrideProfileHash,
    startFrame: expected.startFrame,
    frameCount: expected.frameCount,
    fps: expected.fps,
    validationState: pending ? "pending" : "passed",
    executable: !pending,
    ranges,
    validation,
  };
  if (pending) return plan;
  const mediaCore = {
    kind: "hyperframes-screenshot-media-policy-proof",
    schemaVersion: 1,
    selectedPolicy: mediaPolicy,
    projectIdentity: expected.projectIdentity,
    renderPlanIdentity: expected.renderPlanIdentity,
    machineProfileIdentity: expected.machineProfileIdentity,
    styleOverrideProfileHash: expected.styleOverrideProfileHash,
    auditSignature: expected.auditSignature,
    determinismSignature: `sha256:${"5".repeat(64)}`,
    determinismPasses: 2,
    oracleValidationIdentity: validation.validationIdentity,
    oracleBackendName: "screenshot",
    reasons: [],
  };
  const screenshotMediaPolicy = { ...mediaCore, proofSignature: `sha256:${sha256(mediaCore)}` };
  const backendCore = {
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
    backendPlanSignature: `sha256:${sha256(backendCore)}`,
    screenshotMediaPolicy,
  };
  plan.proof = { ...proofCore, proofSignature: `sha256:${sha256(proofCore)}` };
  return plan;
}

function range(startFrame, endFrameExclusive, backend, overrides = {}) {
  return {
    startFrame,
    endFrameExclusive,
    backend,
    executable: true,
    decisionBasis: backend === "proxy-tree" ? "exact-signature-proof" : "oracle",
    gateProfileHash: backend === "proxy-tree" ? `sha256:${"6".repeat(64)}` : null,
    styleOverrideProfileHash: null,
    requiresBrowserPaint: true,
    inventoryState: "complete",
    riskSignature: [knownAtom],
    rejectedBackends: [],
    goldenFrames: [startFrame, endFrameExclusive - 1],
    ...overrides,
  };
}

const mixed = signedPreflight([
  range(100, 103, "proxy-tree"),
  range(103, 105, "proxy-tree", { riskSignature: [] }),
  range(105, 108, "screenshot"),
  range(108, 110, "screenshot", { riskSignature: [] }),
  range(110, 112, "proxy-tree"),
]);
const mixedExecution = compileSegmentExecutionPlan({ preflightPlan: mixed, expected });
assert.equal(mixedExecution.executionMode, "verified");
assert.deepEqual(mixedExecution.segments.map((segment) => [segment.startFrame, segment.endFrameExclusive, segment.backend]), [
  [100, 105, "proxy-tree"],
  [105, 110, "screenshot"],
  [110, 112, "proxy-tree"],
]);
assert.equal(mixedExecution.segments[1].screenshotMediaPolicy, "bounded-static");
assert.equal(verifyExecutionSegmentPlan(mixedExecution).valid, true);

const unsafeProxy = signedPreflight([
  range(100, 106, "proxy-tree", { decisionBasis: "pending" }),
  range(106, 112, "screenshot"),
]);
const downgraded = compileSegmentExecutionPlan({ preflightPlan: unsafeProxy, expected });
assert.equal(downgraded.executionMode, "verified-with-oracle-downgrade");
assert.equal(downgraded.segments.length, 1);
assert.equal(downgraded.segments[0].backend, "screenshot");

const allScreenshot = compileSegmentExecutionPlan({
  preflightPlan: signedPreflight([range(100, 112, "screenshot")]),
  expected,
});
assert.equal(allScreenshot.executionMode, "verified");
assert.equal(allScreenshot.segments.length, 1);
assert.equal(allScreenshot.segments[0].backend, "screenshot");

const tampered = structuredClone(mixed);
tampered.ranges[0].endFrameExclusive = 104;
const tamperedExecution = compileSegmentExecutionPlan({ preflightPlan: tampered, expected });
assert.equal(tamperedExecution.executionMode, "oracle-fallback");
assert.equal(tamperedExecution.fallbackReason, "backend-plan-signature-mismatch");
assert.equal(tamperedExecution.screenshotMediaPolicy, "faithful");
assert.deepEqual(tamperedExecution.segments.map((segment) => [segment.startFrame, segment.endFrameExclusive, segment.backend]), [
  [100, 112, "screenshot"],
]);

const pendingExecution = compileSegmentExecutionPlan({
  preflightPlan: signedPreflight([range(100, 112, "proxy-tree")], { pending: true }),
  expected,
});
assert.equal(pendingExecution.executionMode, "oracle-fallback");
assert.equal(pendingExecution.fallbackReason, "plan-not-executable");

const signedGap = signedPreflight([
  range(100, 104, "proxy-tree"),
  range(105, 112, "screenshot"),
]);
const gapExecution = compileSegmentExecutionPlan({ preflightPlan: signedGap, expected });
assert.equal(gapExecution.executionMode, "oracle-fallback");
assert.equal(gapExecution.fallbackReason, "signed-range-coverage-invalid:1");

function observation(segment, overrides = {}) {
  const expectedSamples = segment.frameCount * 800;
  return {
    segmentId: segment.segmentId,
    container: "mov",
    video: {
      ...DEFAULT_MOV_CONTRACT.video,
      timeBase: { numerator: 1, denominator: 15_360 },
      codecExtradataSha256: `sha256:${"a".repeat(64)}`,
      frameCount: segment.frameCount,
      startTimeTicks: 0,
      durationTicks: segment.frameCount * 256,
    },
    audio: {
      ...DEFAULT_MOV_CONTRACT.audio,
      startSample: 0,
      sampleCount: expectedSamples,
    },
    ...overrides,
  };
}

const compatible = mixedExecution.segments.map((segment) => observation(segment));
const concat = evaluateMovStreamCopyConcat({ executionPlan: mixedExecution, observedSegments: compatible });
assert.equal(concat.executable, true);
assert.equal(concat.action, "concat-stream-copy");

const wrongColor = structuredClone(compatible);
wrongColor[1].video.colorTransfer = "smpte2084";
const hardFailure = evaluateMovStreamCopyConcat({
  executionPlan: mixedExecution,
  observedSegments: wrongColor,
  mismatchPolicy: "hard-fail",
});
assert.equal(hardFailure.executable, false);
assert.equal(hardFailure.action, "hard-fail");
assert.ok(hardFailure.failures[0].reasons.includes("contract-mismatch:video.colorTransfer"));

const fallback = evaluateMovStreamCopyConcat({
  executionPlan: mixedExecution,
  observedSegments: wrongColor,
  mismatchPolicy: "uniform-screenshot",
});
assert.equal(fallback.action, "rerender-uniform-screenshot");
assert.equal(fallback.replacementExecutionPlan.executionMode, "oracle-fallback");
assert.equal(fallback.replacementExecutionPlan.segments.length, 1);
assert.equal(fallback.replacementExecutionPlan.segments[0].backend, "screenshot");
assert.equal(fallback.replacementExecutionPlan.screenshotMediaPolicy, "faithful");

const extradataMismatch = structuredClone(compatible);
extradataMismatch[2].video.codecExtradataSha256 = `sha256:${"b".repeat(64)}`;
const incompatibleSps = evaluateMovStreamCopyConcat({
  executionPlan: mixedExecution,
  observedSegments: extradataMismatch,
});
assert.ok(incompatibleSps.failures.some((failure) => failure.reasons.includes("video-codec-extradata-mismatch")));

const alteredExecution = structuredClone(mixedExecution);
alteredExecution.segments[0].backend = "screenshot";
assert.equal(verifyExecutionSegmentPlan(alteredExecution).reason, "execution-plan-signature-mismatch");

console.log("backend plan consumer tests passed");
