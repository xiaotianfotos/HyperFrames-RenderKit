#!/usr/bin/env node

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { runInNewContext } from "node:vm";

const rendererRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const source = readFileSync(resolve(rendererRoot, "decoder-lane-allocator.js"), "utf8");
const sandbox = {};
runInNewContext(source, sandbox);
const runtime = sandbox.HyperframesDecoderLanes;

function allocator(options = {}) {
  return runtime.createDecoderLaneAllocator({
    maxTotalLanes: 4,
    maxLanesPerSource: 2,
    idleUnloadFrames: 10,
    ...options,
  });
}

// Same source + same presentation PTS shares one decoder in an output frame.
{
  const lanes = allocator();
  lanes.beginFrame(0);
  const main = lanes.claim({ sourceKey: "source-a", presentationKey: "pts-100", clipKey: "main" });
  const pip = lanes.claim({ sourceKey: "source-a", presentationKey: "pts-100", clipKey: "pip" });
  assert.equal(pip.laneId, main.laneId);
  assert.equal(pip.shared, true);
  assert.equal(pip.reason, "same-source-same-presentation");
  assert.equal(lanes.snapshot().lanes.length, 1);
  lanes.endFrame();
}

// Same source + different presentation PTS requires independent lanes.
{
  const lanes = allocator();
  lanes.beginFrame(0);
  const main = lanes.claim({ sourceKey: "source-a", presentationKey: "pts-100", clipKey: "main" });
  const pip = lanes.claim({ sourceKey: "source-a", presentationKey: "pts-200", clipKey: "pip" });
  assert.notEqual(pip.laneId, main.laneId);
  assert.equal(lanes.snapshot().lanes.length, 2);
  lanes.endFrame();
}

// Across output frames, clip ownership wins over arbitrary warm-lane choice so
// both clips keep sequential decode state even when claim order changes.
{
  const lanes = allocator();
  lanes.beginFrame(0);
  const main0 = lanes.claim({ sourceKey: "source-a", presentationKey: "pts-100", clipKey: "main" });
  const pip0 = lanes.claim({ sourceKey: "source-a", presentationKey: "pts-500", clipKey: "pip" });
  lanes.endFrame();
  lanes.beginFrame(1);
  const pip1 = lanes.claim({ sourceKey: "source-a", presentationKey: "pts-501", clipKey: "pip" });
  const main1 = lanes.claim({ sourceKey: "source-a", presentationKey: "pts-101", clipKey: "main" });
  assert.equal(pip1.laneId, pip0.laneId);
  assert.equal(main1.laneId, main0.laneId);
  assert.equal(pip1.reason, "clip-continuity");
  assert.equal(main1.reason, "clip-continuity");
  lanes.endFrame();
}

// Under global pressure an inactive LRU lane is reassigned rather than growing
// the decoder-context count without bound.
{
  const lanes = allocator({ maxTotalLanes: 1, maxLanesPerSource: 1 });
  lanes.beginFrame(0);
  const first = lanes.claim({ sourceKey: "source-a", presentationKey: "pts-0", clipKey: "a" });
  lanes.endFrame();
  lanes.beginFrame(1);
  const switched = lanes.claim({ sourceKey: "source-b", presentationKey: "pts-0", clipKey: "b" });
  assert.equal(switched.laneId, first.laneId);
  assert.equal(switched.reason, "lru-source-reassignment");
  assert.equal(switched.sourceChanged, true);
  assert.equal(switched.previousSourceKey, "source-a");
  lanes.endFrame();
}

// Divergent presentations beyond either configured limit are hard blockers.
{
  const lanes = allocator({ maxTotalLanes: 3, maxLanesPerSource: 1 });
  lanes.beginFrame(0);
  lanes.claim({ sourceKey: "source-a", presentationKey: "pts-0", clipKey: "a" });
  assert.throws(
    () => lanes.claim({ sourceKey: "source-a", presentationKey: "pts-1", clipKey: "b" }),
    (error) => error.code === "decoder-lane-per-source-limit"
      && /--mediaDecoderLanesPerSource/.test(error.message),
  );
  lanes.endFrame();
}
{
  const lanes = allocator({ maxTotalLanes: 1, maxLanesPerSource: 2 });
  lanes.beginFrame(0);
  lanes.claim({ sourceKey: "source-a", presentationKey: "pts-0", clipKey: "a" });
  assert.throws(
    () => lanes.claim({ sourceKey: "source-b", presentationKey: "pts-0", clipKey: "b" }),
    (error) => error.code === "decoder-lane-global-limit"
      && /--mediaDecoderLanesTotal/.test(error.message),
  );
  lanes.endFrame();
}

// Idle lanes pause first, then release their source binding at the configured
// age so a future source can reuse the same bounded DOM decoder.
{
  const lanes = allocator({ maxTotalLanes: 2, maxLanesPerSource: 1, idleUnloadFrames: 2 });
  lanes.beginFrame(0);
  const old = lanes.claim({ sourceKey: "source-a", presentationKey: "pts-0", clipKey: "a" });
  lanes.endFrame();
  lanes.beginFrame(1);
  lanes.claim({ sourceKey: "source-b", presentationKey: "pts-0", clipKey: "b" });
  const firstIdle = lanes.endFrame();
  assert.deepEqual([...firstIdle.pauseLaneIds], [old.laneId]);
  lanes.beginFrame(2);
  lanes.claim({ sourceKey: "source-b", presentationKey: "pts-1", clipKey: "b" });
  const reclaimed = lanes.endFrame();
  assert.deepEqual([...reclaimed.pauseLaneIds], []);
  assert.deepEqual([...reclaimed.unloadLaneIds], [old.laneId]);
  assert.equal(lanes.snapshot().stats.pausedIdleLanes, 1);
  lanes.beginFrame(3);
  const replacement = lanes.claim({ sourceKey: "source-c", presentationKey: "pts-0", clipKey: "c" });
  assert.equal(replacement.laneId, old.laneId);
  assert.equal(replacement.reason, "unloaded-lane-reassignment");
  lanes.endFrame();
}

// A bound idle lane gets one pause action per active -> idle transition, not
// one action on every output frame. Current-frame active lanes are never in
// pauseLaneIds.
{
  const lanes = allocator({ maxTotalLanes: 2, maxLanesPerSource: 1, idleUnloadFrames: 20 });
  lanes.beginFrame(0);
  const a = lanes.claim({ sourceKey: "source-a", presentationKey: "pts-0", clipKey: "a" });
  assert.deepEqual([...lanes.endFrame().pauseLaneIds], []);
  lanes.beginFrame(1);
  const b = lanes.claim({ sourceKey: "source-b", presentationKey: "pts-0", clipKey: "b" });
  assert.deepEqual([...lanes.endFrame().pauseLaneIds], [a.laneId]);
  lanes.beginFrame(2);
  lanes.claim({ sourceKey: "source-b", presentationKey: "pts-1", clipKey: "b" });
  assert.deepEqual([...lanes.endFrame().pauseLaneIds], []);
  lanes.beginFrame(3);
  lanes.claim({ sourceKey: "source-a", presentationKey: "pts-1", clipKey: "a" });
  assert.deepEqual([...lanes.endFrame().pauseLaneIds], [b.laneId]);
  lanes.beginFrame(4);
  lanes.claim({ sourceKey: "source-b", presentationKey: "pts-2", clipKey: "b" });
  assert.deepEqual([...lanes.endFrame().pauseLaneIds], [a.laneId]);
  assert.equal(lanes.snapshot().stats.pausedIdleLanes, 3);
}

// Regression case: one secondary lane becomes idle for the rest of a 61
// frame probe. It is paused once, not once per remaining output frame.
{
  const lanes = allocator({ maxTotalLanes: 2, maxLanesPerSource: 2, idleUnloadFrames: 120 });
  lanes.beginFrame(0);
  const primary = lanes.claim({ sourceKey: "source-a", presentationKey: "pts-0", clipKey: "main" });
  const secondary = lanes.claim({ sourceKey: "source-a", presentationKey: "pts-30", clipKey: "pip" });
  assert.deepEqual([...lanes.endFrame().pauseLaneIds], []);
  for (let frame = 1; frame < 61; frame += 1) {
    lanes.beginFrame(frame);
    const active = lanes.claim({
      sourceKey: "source-a",
      presentationKey: `pts-${frame}`,
      clipKey: "main",
    });
    assert.equal(active.laneId, primary.laneId);
    const maintenance = lanes.endFrame();
    assert.ok(!maintenance.pauseLaneIds.includes(primary.laneId));
    assert.deepEqual([...maintenance.pauseLaneIds], frame === 1 ? [secondary.laneId] : []);
  }
  assert.equal(lanes.snapshot().stats.pausedIdleLanes, 1);
}

// Static integration gates: the renderer claims lanes only after timing
// selection, the main process injects the browser-safe runtime, and all limits
// are exposed as explicit CLI configuration instead of hidden constants.
const rendererSource = readFileSync(resolve(rendererRoot, "full-canvas-renderer.js"), "utf8");
const mainSource = readFileSync(resolve(rendererRoot, "full-canvas-main.mjs"), "utf8");
assert.match(rendererSource, /createDecoderLaneAllocator/);
assert.match(rendererSource, /decoderForTimingSelection\(clip, timing, timingSelection\)/);
assert.match(rendererSource, /Timing-plan clip .* without an allocated decoder lane/);
assert.match(rendererSource, /decoderLaneErrorCode/);
assert.match(mainSource, /decoder-lane-allocator\.js/);
assert.match(mainSource, /mediaDecoderLanesTotal/);
assert.match(mainSource, /mediaDecoderLanesPerSource/);
assert.match(mainSource, /mediaDecoderIdleFrames/);

console.log("decoder lane allocator tests passed");
