#!/usr/bin/env node

import assert from "node:assert/strict";
import {
  deriveRenderResourceBudget,
  RENDER_RESOURCE_MIB,
} from "./render_resource_budget_lib.mjs";

// 4K60 uses a conservative ~43.5 MiB per queued RGBA+NV12 frame. A 256 MiB
// budget therefore permits five in-flight frames and queueLimit=4.
{
  const plan = deriveRenderResourceBudget({
    width: 3840,
    height: 2160,
    fps: 60,
    bitrate: 40_000_000,
    surfaceBudgetBytes: 256 * RENDER_RESOURCE_MIB,
  });
  assert.equal(plan.estimates.rgbaBytes, 33_177_600);
  assert.equal(plan.estimates.nv12Bytes, 12_441_600);
  assert.equal(plan.estimates.estimatedBytesPerEncoderFrame, 45_619_200);
  assert.equal(plan.limits.maxInFlightByBytes, 5);
  assert.equal(plan.limits.maxInFlightFrames, 5);
  assert.equal(plan.limits.encoderQueueLimit, 4);
  assert.equal(plan.limits.encoderQueueLowWatermark, 2);
  assert.equal(plan.limits.encoderBackpressureMode, "dequeue");
  assert.equal(plan.limits.maxPendingPayloadBytes, 32 * RENDER_RESOURCE_MIB);
  assert.equal(plan.limits.payloadWriteWindow, 8);
}

// 1080p may exploit more concurrency, but a hard cap prevents driver queues
// from growing without bound on large-memory machines.
{
  const plan = deriveRenderResourceBudget({
    width: 1920,
    height: 1080,
    totalMemoryBytes: 64 * 1024 * RENDER_RESOURCE_MIB,
  });
  assert.equal(plan.budgets.surfaceBudgetBytes, 256 * RENDER_RESOURCE_MIB);
  assert.equal(plan.limits.maxInFlightFrames, 12);
  assert.equal(plan.limits.encoderQueueLimit, 11);
}

// Low-memory machines automatically receive a smaller budget rather than the
// same frame-count limit as a large server.
{
  const plan = deriveRenderResourceBudget({
    width: 3840,
    height: 2160,
    totalMemoryBytes: 8 * 1024 * RENDER_RESOURCE_MIB,
  });
  assert.equal(plan.budgets.surfaceBudgetBytes, Math.floor(8 * 1024 * RENDER_RESOURCE_MIB * 0.02));
  assert.equal(plan.limits.encoderQueueLimit, 2);
}

// 8K can still run sequentially with queueLimit=0 when one estimated surface
// fits, instead of pretending the 4K queue count is safe.
{
  const plan = deriveRenderResourceBudget({
    width: 7680,
    height: 4320,
    surfaceBudgetBytes: 256 * RENDER_RESOURCE_MIB,
  });
  assert.equal(plan.limits.maxInFlightFrames, 1);
  assert.equal(plan.limits.encoderQueueLimit, 0);
}

// Overrides are fail-closed unless the caller explicitly enlarges the byte
// budget (or opts into an unsafe development-only override).
assert.throws(() => deriveRenderResourceBudget({
  width: 3840,
  height: 2160,
  surfaceBudgetBytes: 256 * RENDER_RESOURCE_MIB,
  encoderQueueLimit: 48,
}), /exceeds resolution-aware safe limit/);

assert.throws(() => deriveRenderResourceBudget({
  width: 7680,
  height: 4320,
  surfaceBudgetBytes: 64 * RENDER_RESOURCE_MIB,
}), /cannot hold one estimated/);

assert.throws(() => deriveRenderResourceBudget({
  width: 3840,
  height: 2160,
  payloadBudgetBytes: 8 * RENDER_RESOURCE_MIB,
  payloadWriteWindow: 8,
}), /exceeds byte-aware safe limit/);

assert.throws(() => deriveRenderResourceBudget({
  width: 3840,
  height: 2160,
  payloadBudgetBytes: 1,
}), /cannot hold one estimated encoded chunk/);

assert.throws(() => deriveRenderResourceBudget({
  width: 1920,
  height: 1080,
  totalMemoryBytes: 128 * RENDER_RESOURCE_MIB,
  surfaceBudgetBytes: 16 * 1024 * RENDER_RESOURCE_MIB,
}), /exceeds total system memory/);

console.log("render resource budget tests: ok");
