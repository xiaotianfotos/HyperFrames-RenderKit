#!/usr/bin/env node

import assert from "node:assert/strict";
import {
  createRenderMemoryWatchdogRecorder,
  deriveRenderMemoryWatchdogPolicy,
} from "./render_memory_watchdog_lib.mjs";

const GIB = 1024 ** 3;
const policy = deriveRenderMemoryWatchdogPolicy({
  totalMemoryBytes: 32 * GIB,
  maxAggregateRssBytes: 4 * GIB,
  minAvailableBytes: 2 * GIB,
  consecutiveBreaches: 2,
});
const recorder = createRenderMemoryWatchdogRecorder(policy);
const metric = (rssBytes, type = "Browser") => ({
  pid: 1,
  type,
  memory: { workingSetSize: rssBytes / 1024 },
});

assert.equal(recorder.record({ appMetrics: [metric(1 * GIB)], availableMemoryBytes: 8 * GIB }).violation, null);
assert.equal(recorder.record({ appMetrics: [metric(3 * GIB)], externalRssBytes: 2 * GIB, availableMemoryBytes: 8 * GIB }).violation, null);
const rssViolation = recorder.record({ appMetrics: [metric(3 * GIB)], externalRssBytes: 2 * GIB, availableMemoryBytes: 8 * GIB }).violation;
assert.equal(rssViolation.code, "HF_RENDER_MEMORY_RSS_LIMIT");
assert.equal(recorder.snapshot().peakAggregateRssBytes, 5 * GIB);

const availableRecorder = createRenderMemoryWatchdogRecorder(policy);
availableRecorder.record({ appMetrics: [metric(1 * GIB)], availableMemoryBytes: 1 * GIB });
const availableViolation = availableRecorder.record({ appMetrics: [metric(1 * GIB)], availableMemoryBytes: 1 * GIB }).violation;
assert.equal(availableViolation.code, "HF_RENDER_MEMORY_AVAILABLE_LIMIT");

assert.throws(() => deriveRenderMemoryWatchdogPolicy({
  totalMemoryBytes: 4 * GIB,
  minAvailableBytes: 2 * GIB,
  maxAggregateRssBytes: 3 * GIB,
}), /leaves less/);

console.log("render memory watchdog tests: ok");
