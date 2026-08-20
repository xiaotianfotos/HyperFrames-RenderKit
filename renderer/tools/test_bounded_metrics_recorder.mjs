#!/usr/bin/env node

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { runInNewContext } from "node:vm";

const rendererRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const source = readFileSync(resolve(rendererRoot, "bounded-metrics-recorder.js"), "utf8");
const sandbox = { TextEncoder };
runInNewContext(source, sandbox);
const runtime = sandbox.HyperframesBoundedMetrics;

assert.equal(runtime.KIND, "hyperframes-bounded-frame-metrics");
assert.equal(runtime.SCHEMA_VERSION, 1);

// A production-length run remains bounded while preserving aggregate counts,
// deterministic samples, anomalies, and the last frames.
{
  const frameCount = 36_000;
  const recorder = runtime.createBoundedMetricsRecorder({ expectedFrames: frameCount });
  const anomalyFrames = new Map([
    [1_234, { mediaTimes: [{ transition: "seek", advanceFallback: true }], wallMs: 7 }],
    [2_345, { waitReason: "paint-timeout", wallMs: 8 }],
    [19_000, {
      partial: true,
      failureStage: "media-seek",
      error: "planned media seek timed out",
      wallMs: 500,
    }],
    [20_000, { wallMs: 250 }],
  ]);
  for (let frameIndex = 0; frameIndex < frameCount; frameIndex += 1) {
    recorder.record({
      frameIndex,
      timelineFrame: 22_742 + frameIndex,
      time: frameIndex / 60,
      wallMs: 5,
      timelineSeekMs: 0.25,
      mediaSeekMs: 1.5,
      waitReason: "timeline",
      mediaTimes: [{ transition: "advance" }],
      ...(anomalyFrames.get(frameIndex) ?? {}),
    });
  }
  const snapshot = recorder.snapshot();
  assert.equal(snapshot.framesObserved, frameCount);
  assert.equal(snapshot.framesCompleted, frameCount - 1);
  assert.equal(recorder.framesCompleted, frameCount - 1);
  assert.equal(snapshot.framesPartial, 1);
  assert.equal(snapshot.framesErrored >= 1, true);
  assert.equal(snapshot.aggregates.numeric.wallMs.count, frameCount);
  assert.equal(snapshot.aggregates.numeric.timelineSeekMs.count, frameCount);
  assert.equal(snapshot.aggregates.anomalies.partial, 1);
  assert.equal(snapshot.aggregates.anomalies.fallback >= 1, true);
  assert.equal(snapshot.aggregates.anomalies.timeout >= 1, true);
  assert.equal(snapshot.aggregates.anomalies.slow, 2);
  assert.equal(snapshot.retention.storedFrames <= snapshot.retention.limits.maxStoredFrames, true);
  assert.equal(
    snapshot.retention.estimatedStoredRecordBytes <= snapshot.retention.limits.maxStoredBytes,
    true,
  );
  assert.equal(
    snapshot.retention.estimatedPeakStoredRecordBytes <= snapshot.retention.limits.maxStoredBytes,
    true,
  );
  assert.equal(snapshot.retention.droppedFrames > 35_000, true);
  assert.equal(
    snapshot.retention.estimatedIpcJsonDoubleCopyBytes,
    snapshot.retention.estimatedStoredRecordBytes * 2,
  );

  const retainedIndices = snapshot.records.map((record) => record.frameIndex);
  assert.equal(new Set(retainedIndices).size, retainedIndices.length, "retained frame records must be unique");
  for (const frameIndex of anomalyFrames.keys()) {
    assert.equal(retainedIndices.includes(frameIndex), true, `anomaly frame ${frameIndex} must be retained`);
  }
  const partial = snapshot.records.find((record) => record.frameIndex === 19_000);
  assert.equal(partial.partial, true);
  assert.match(partial.error, /timed out/);
  assert.equal(partial.__metricsRetention.reasons.includes("critical"), true);
  assert.equal(partial.__metricsRetention.anomalies.includes("partial"), true);
  assert.equal(partial.__metricsRetention.anomalies.includes("error"), true);

  const head = [...snapshot.retention.bucketFrameIndices.head];
  const tail = [...snapshot.retention.bucketFrameIndices.tail];
  assert.deepEqual(head, [0, 1, 2, 3, 4, 5, 6, 7]);
  assert.deepEqual(tail, [38_117, 38_118, 38_119, 38_120, 38_121, 38_122, 38_123, 38_124]);
  assert.equal(head.some((frameIndex) => tail.includes(frameIndex)), false, "head and tail must not overlap");
}

// Huge nested diagnostics are compacted before retention. A partial error has
// higher priority than samples and slow frames, so it cannot disappear merely
// because the bounded recorder is saturated.
{
  const recorder = runtime.createBoundedMetricsRecorder({
    expectedFrames: 200,
    headFrames: 2,
    tailFrames: 2,
    sampleEvery: 1,
    sampleFrames: 6,
    anomalyFrames: 2,
    criticalFrames: 4,
    maxStoredFrames: 12,
    maxStoredBytes: 16 * 1024,
    maxRecordBytes: 2 * 1024,
    slowFrameMs: 100,
  });
  for (let frameIndex = 0; frameIndex < 200; frameIndex += 1) {
    const partial = frameIndex === 100;
    recorder.record({
      frameIndex,
      partial,
      failureStage: partial ? "media-seek" : null,
      error: partial ? `fatal decoder error ${"E".repeat(10_000)}` : null,
      wallMs: frameIndex % 7 === 0 ? 150 : 5,
      mediaTimes: Array.from({ length: 500 }, (_, index) => ({
        id: `clip-${index}`,
        transition: "advance",
        diagnostic: "x".repeat(5_000),
      })),
    });
  }
  const snapshot = recorder.snapshot();
  assert.equal(snapshot.framesCompleted, 199);
  assert.equal(snapshot.retention.storedFrames <= 12, true);
  assert.equal(snapshot.retention.peakStoredFrames <= 12, true);
  assert.equal(snapshot.retention.estimatedStoredRecordBytes <= 16 * 1024, true);
  assert.equal(snapshot.retention.estimatedPeakStoredRecordBytes <= 16 * 1024, true);
  assert.equal(snapshot.retention.oversizeRecordsCompacted > 0, true);
  const partial = snapshot.records.find((record) => record.frameIndex === 100);
  assert.ok(partial, "partial error must survive sample/anomaly pressure");
  assert.equal(partial.partial, true);
  assert.match(partial.error, /fatal decoder error/);
  assert.equal(partial.__metricsRetention.reasons.includes("critical"), true);
}

// A fatal partial frame outranks a stream of later timeout diagnostics inside
// the bounded critical bucket.
{
  const recorder = runtime.createBoundedMetricsRecorder({
    headFrames: 0,
    tailFrames: 1,
    sampleEvery: 100,
    sampleFrames: 0,
    criticalFrames: 2,
    maxStoredFrames: 4,
  });
  for (let frameIndex = 0; frameIndex < 20; frameIndex += 1) {
    recorder.record(frameIndex === 5
      ? { frameIndex, partial: true, error: "fatal partial", wallMs: 4 }
      : { frameIndex, waitReason: frameIndex > 5 ? "paint-timeout" : "paint", wallMs: 4 });
  }
  const snapshot = recorder.snapshot();
  assert.ok(snapshot.records.find((record) => record.frameIndex === 5));
  assert.equal(snapshot.retention.bucketFrameIndices.critical.includes(5), true);
}

// Full frame series are deliberately available only through explicit opt-in.
{
  const bounded = runtime.createBoundedMetricsRecorder({
    headFrames: 2,
    tailFrames: 2,
    sampleEvery: 100,
    sampleFrames: 2,
    maxStoredFrames: 8,
  });
  const full = runtime.createBoundedMetricsRecorder({ mode: "full", maxStoredFrames: 8 });
  for (let frameIndex = 0; frameIndex < 1_000; frameIndex += 1) {
    const frame = { frameIndex, wallMs: 4 };
    bounded.record(frame);
    full.record(frame);
  }
  const boundedSnapshot = bounded.snapshot();
  const fullSnapshot = full.snapshot();
  assert.equal(boundedSnapshot.mode, "bounded");
  assert.equal(boundedSnapshot.retention.storedFrames <= 8, true);
  assert.equal(boundedSnapshot.retention.droppedFrames > 0, true);
  assert.equal(fullSnapshot.mode, "full");
  assert.equal(fullSnapshot.retention.limits.unboundedFullMode, true);
  assert.equal(fullSnapshot.retention.storedFrames, 1_000);
  assert.equal(fullSnapshot.retention.droppedFrames, 0);
  assert.equal(fullSnapshot.framesCompleted, 1_000);
}

// API guards fail early instead of silently switching to an unbounded mode.
assert.throws(() => runtime.createBoundedMetricsRecorder({ mode: "everything" }), /bounded or full/);
assert.throws(() => runtime.createBoundedMetricsRecorder({ maxStoredBytes: 128 }), /at least 512/);
assert.throws(() => runtime.createBoundedMetricsRecorder().record(null), /must be an object/);

console.log("bounded metrics recorder tests passed");
