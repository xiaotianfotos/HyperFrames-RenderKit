#!/usr/bin/env node

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { runInNewContext } from "node:vm";
import { buildTimingPlan } from "./media_timing_plan_lib.mjs";

const rendererRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const runtimeSource = readFileSync(resolve(rendererRoot, "media-timing-runtime.js"), "utf8");
const sandbox = {};
runInNewContext(runtimeSource, sandbox);
const runtime = sandbox.HyperframesMediaTiming;

function syntheticPlan(ptsTicks, {
  keyframes = [0],
  bFrames = true,
  durationTicks = null,
  timeBase = "1/1000",
} = {}) {
  const end = ptsTicks.at(-1) + (durationTicks ?? (ptsTicks.at(-1) - ptsTicks.at(-2)));
  return buildTimingPlan({
    sourcePath: "/synthetic/source.mp4",
    sourceStat: { size: 10, mtimeNs: "10" },
    sourceSha256: "b".repeat(64),
    ffprobeVersion: "synthetic",
    probe: {
      streams: [{
        index: 0,
        codec_type: "video",
        codec_name: "h264",
        width: 64,
        height: 36,
        time_base: timeBase,
        r_frame_rate: "10/1",
        avg_frame_rate: "10/1",
        start_pts: "0",
        start_time: "0",
        duration_ts: String(end),
        has_b_frames: bFrames ? 2 : 0,
      }],
      frames: ptsTicks.map((pts, index) => ({
        stream_index: 0,
        best_effort_timestamp: String(pts),
        key_frame: keyframes.includes(index) ? 1 : 0,
        pict_type: bFrames && index > 0 ? "B" : "P",
      })),
    },
  });
}

const cfr = runtime.createQuery(syntheticPlan([0, 100, 200, 300, 400], { keyframes: [0] }));
assert.equal(cfr.atOrBefore(0.299).frameIndex, 2);
assert.equal(cfr.atOrBefore(0.3).frameIndex, 3);
assert.equal(cfr.atOrBefore(0.3 - 1e-9).frameIndex, 2);
assert.equal(cfr.atOrBefore(0.299).lookup, "cfr-integer-fast-path");
assert.ok(cfr.atIndex(3).seekTargetSeconds > 0.3);
assert.ok(cfr.atIndex(3).seekTargetSeconds < 0.4);
assert.equal(cfr.atIndex(3).seekInteriorSeconds, 0.302);
assert.equal(cfr.atIndex(3).intervalEndMediaRelativeSeconds, 0.4);
const fineTimeBase = runtime.createQuery(syntheticPlan([0, 1500, 3000], {
  timeBase: "1/90000",
  durationTicks: 1500,
}));
assert.ok(fineTimeBase.atIndex(1).ptsToleranceSeconds >= 1e-6);
assert.ok(fineTimeBase.atIndex(1).ptsToleranceSeconds < (1500 / 90000) / 4);

const vfr = runtime.createQuery(syntheticPlan([0, 100, 300, 400], { keyframes: [0] }));
const gapA = vfr.atOrBefore(0.2);
const gapB = vfr.atOrBefore(0.299);
const gapEnd = vfr.atOrBefore(0.3);
assert.equal(gapA.frameIndex, 1);
assert.equal(gapB.frameIndex, 1);
assert.equal(gapEnd.frameIndex, 2);
assert.equal(gapA.lookup, "vfr-binary-search");
assert.deepEqual(
  { ...runtime.decideTransition({ selection: gapA, clipKey: "clip-a" }, gapB, { clipKey: "clip-a" }) },
  { action: "reuse", sameFrame: true, seekReason: "same-presentation-pts" },
);
assert.deepEqual(
  { ...runtime.decideTransition({ selection: gapB, clipKey: "clip-a" }, gapEnd, { clipKey: "clip-a" }) },
  { action: "advance", sameFrame: false, seekReason: "sequential-next-presentation" },
);

// Long GOPs do not alter presentation selection. A non-adjacent output jump
// seeks even when both frames belong to the same GOP.
const longGopStart = cfr.atOrBefore(0);
const longGopJump = cfr.atOrBefore(0.4);
assert.deepEqual(
  { ...runtime.decideTransition({ selection: longGopStart, clipKey: "clip-a" }, longGopJump, { clipKey: "clip-a" }) },
  { action: "seek", sameFrame: false, seekReason: "nonsequential-presentation-jump" },
);
assert.equal(
  runtime.decideTransition({ selection: longGopJump, clipKey: "clip-a" }, gapEnd, { clipKey: "clip-a" }).seekReason,
  "backward-presentation-jump",
);

// A cut seeks when it changes the selected PTS, while an identical selected
// PTS is reused even if ownership moves to another clip.
assert.equal(
  runtime.decideTransition({ selection: gapA, clipKey: "clip-a" }, gapB, { clipKey: "clip-b" }).action,
  "reuse",
);
assert.equal(
  runtime.decideTransition({ selection: gapB, clipKey: "clip-a" }, gapEnd, { clipKey: "clip-b" }).seekReason,
  "clip-cut",
);

const beforeTail = vfr.atOrBefore(0.499, { tailPolicy: "hold-last" });
const heldTail = vfr.atOrBefore(0.5, { tailPolicy: "hold-last" });
const transparentTail = vfr.atOrBefore(0.5, { tailPolicy: "transparent" });
assert.equal(beforeTail.pastDisplayEnd, false);
assert.equal(heldTail.frameIndex, 3);
assert.equal(heldTail.tailAction, "hold-last");
assert.equal(transparentTail.transparent, true);
assert.equal(runtime.decideTransition({ selection: beforeTail }, heldTail).action, "reuse");
assert.equal(runtime.decideTransition({ selection: heldTail }, transparentTail).action, "transparent");
assert.throws(() => vfr.atOrBefore(0.5, { tailPolicy: "fail" }), /past display end/);

// Regression for Electron's initial paused seek: the first callback may still
// identify the old frame. Waiting for another callback while paused deadlocks;
// the state machine must explicitly resume playback, then accept the target.
const stalePaused = runtime.classifyPresentedFrame({
  expected: 1 / 60,
  tolerance: 1e-6,
  mediaTime: 0,
  seeking: false,
  paused: true,
});
assert.deepEqual(
  { ...stalePaused },
  {
    status: "stale-before-target",
    difference: -1 / 60,
    requestNext: true,
    play: true,
  },
);
assert.deepEqual(
  { ...runtime.classifyMediaReadiness({
    readyState: 1,
    haveCurrentData: 2,
    seeking: true,
  }) },
  { status: "waiting-for-seeked", seeking: true },
);
assert.deepEqual(
  { ...runtime.classifyMediaReadiness({
    readyState: 2,
    haveCurrentData: 2,
    seeking: true,
  }) },
  { status: "waiting-for-seeked", seeking: true },
);
assert.deepEqual(
  { ...runtime.classifyMediaReadiness({
    readyState: 1,
    haveCurrentData: 2,
    seeking: false,
  }) },
  { status: "waiting-for-current-data", seeking: false },
);
assert.deepEqual(
  { ...runtime.classifyMediaReadiness({
    readyState: 2,
    haveCurrentData: 2,
    seeking: false,
  }) },
  { status: "ready", seeking: false },
);
assert.equal(runtime.classifyPresentedFrame({
  expected: 1 / 60,
  tolerance: 1e-6,
  mediaTime: 1 / 60,
  seeking: false,
  paused: false,
}).status, "exact");
assert.deepEqual(
  { ...runtime.classifyPresentedFrame({
    expected: 394.4,
    tolerance: 1e-6,
    mediaTime: 394.4,
    seeking: true,
    paused: true,
  }) },
  {
    status: "exact",
    difference: 0,
    requestNext: false,
    play: false,
  },
);
let simulatedPaused = true;
let simulatedPlayCalls = 0;
let simulatedVerified = false;
for (const mediaTime of [0, 1 / 60]) {
  const decision = runtime.classifyPresentedFrame({
    expected: 1 / 60,
    tolerance: 1e-6,
    mediaTime,
    seeking: false,
    paused: simulatedPaused,
  });
  if (decision.play) {
    simulatedPlayCalls += 1;
    simulatedPaused = false;
  }
  if (decision.status === "exact") {
    simulatedVerified = true;
    simulatedPaused = true;
  }
}
assert.equal(simulatedPlayCalls, 1);
assert.equal(simulatedVerified, true);
assert.equal(simulatedPaused, true);

const rendererSource = readFileSync(resolve(rendererRoot, "full-canvas-renderer.js"), "utf8");
assert.match(rendererSource, /same-output-frame-presentation-pts/);
assert.match(rendererSource, /rVFC-overshoot-recovery-seek/);
assert.match(rendererSource, /seekTargetSeconds/);
assert.match(rendererSource, /No verified timing plan for decoder source/);
assert.match(rendererSource, /requestVideoFrameCallback/);
assert.match(rendererSource, /staleResumeCount/);
assert.match(rendererSource, /bootstrapTimingFrame/);
assert.match(rendererSource, /preparedFrameSources\.has\(item\.clip\)/);
assert.match(rendererSource, /not-renderable-opacity/);

console.log("media timing scheduler tests passed");
