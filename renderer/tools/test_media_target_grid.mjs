#!/usr/bin/env node

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { runInNewContext } from "node:vm";
import { resolveRenderStart } from "./render_start_lib.mjs";

const rendererRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const rendererSource = readFileSync(resolve(rendererRoot, "full-canvas-renderer.js"), "utf8");
const mainSource = readFileSync(resolve(rendererRoot, "full-canvas-main.mjs"), "utf8");
const preloadSource = readFileSync(resolve(rendererRoot, "preload.mjs"), "utf8");
const rendererWithoutEntrypoint = rendererSource.replace(
  /\nvoid runFullCanvasRenderWithFailureReport\(\)\.catch[\s\S]*$/,
  "",
);
const sandbox = {};
runInNewContext(
  `${rendererWithoutEntrypoint}\n`
  + "globalThis.__mediaTargetForMode = mediaTargetForMode;\n"
  + "globalThis.__frameIndexForTime = cfrFrameIndexForMediaTime;\n"
  + "globalThis.__mediaTargetAtOrPastEnd = mediaTargetAtOrPastEnd;",
  sandbox,
);

const targetForMode = sandbox.__mediaTargetForMode;
const frameIndexForTime = sandbox.__frameIndexForTime;
const targetAtOrPastEnd = sandbox.__mediaTargetAtOrPastEnd;
const fps = 60;
const frameDuration = 1 / fps;
const overshootTolerance = frameDuration / 3;

assert.deepEqual(
  { ...targetForMode(14.493333, fps, "exact") },
  {
    rawTarget: 14.493333,
    decoderTarget: 14.493333,
    targetSnapDelta: 0,
    targetFrameIndex: null,
  },
);

// phase is the fractional part of rawTarget * fps, not a number of seconds.
// video013's observed failing target 14.4933s is source-frame phase 0.60.
const phases = [
  { name: "clipC", phaseFrames: 0.56, baseFrameIndex: 120 },
  { name: "video013", phaseFrames: 0.60, baseFrameIndex: 869 },
  { name: "clipB", phaseFrames: 0.80, baseFrameIndex: 48 },
];
for (const {
  name,
  phaseFrames,
  baseFrameIndex,
} of phases) {
  for (let offset = 0; offset < 8; offset += 1) {
    const rawTarget = (baseFrameIndex + phaseFrames + offset) / fps;
    const snapped = targetForMode(rawTarget, fps, "frame-grid");
    assert.equal(
      snapped.targetFrameIndex,
      baseFrameIndex + offset,
      `${name} frame index ${offset}`,
    );
    assert.ok(
      Math.abs(snapped.decoderTarget - (baseFrameIndex + offset) / fps) < 1e-12,
      `${name} decoder target ${offset}`,
    );
    // A CFR callback can return this exact grid frame, so target overshoot is
    // zero instead of being forced to the following frame by a fractional target.
    const firstCfrFrameAtOrAfterTarget = Math.ceil(
      (snapped.decoderTarget - 1e-12) * fps,
    ) / fps;
    assert.ok(
      firstCfrFrameAtOrAfterTarget - snapped.decoderTarget <= overshootTolerance,
      `${name} must not force an overshoot fallback at offset ${offset}`,
    );
  }
}

// Before snapping, the .56 and .60 phases force the next CFR callback more
// than 1/3 frame beyond the requested target and therefore force a fallback.
for (const { name, phaseFrames, baseFrameIndex } of phases.slice(0, 2)) {
  const rawTarget = (baseFrameIndex + phaseFrames) / fps;
  const nextCfrFrame = Math.ceil(rawTarget * fps) / fps;
  assert.ok(
    nextCfrFrame - rawTarget > overshootTolerance,
    `${name} must reproduce the old inevitable overshoot`,
  );
}
assert.equal(targetForMode(14.493333, fps, "frame-grid").targetFrameIndex, 869);

// Frame-grid tolerance repairs only machine-roundoff-scale errors. It must not
// reinterpret a genuinely earlier target, even one just 0.5 microseconds below
// the next grid point.
const nextGridIndex = 870;
const halfMicrosecondBeforeNextGrid = nextGridIndex / fps - 0.5e-6;
assert.equal(frameIndexForTime(halfMicrosecondBeforeNextGrid, fps), nextGridIndex - 1);
const ulpScaleBelowGrid = (
  nextGridIndex - Number.EPSILON * nextGridIndex * 4
) / fps;
assert.equal(frameIndexForTime(ulpScaleBelowGrid, fps), nextGridIndex);

// Render entry points use integer frame indices, not rounded decimal seconds.
assert.equal(frameIndexForTime(292.65, fps), 17_559);
assert.equal(frameIndexForTime(379.033333, fps), 22_741);
assert.deepEqual(resolveRenderStart({}, fps), { startFrame: 0, start: 0 });
assert.deepEqual(
  resolveRenderStart({ startFrame: "17559" }, fps),
  { startFrame: 17_559, start: 292.65 },
);
assert.deepEqual(
  resolveRenderStart({ startFrame: "22742" }, fps),
  { startFrame: 22_742, start: 22_742 / fps },
);
assert.deepEqual(
  resolveRenderStart({ start: "379.033333" }, fps),
  { startFrame: null, start: 379.033333 },
);
assert.throws(
  () => resolveRenderStart({ start: "0", startFrame: "0" }, fps),
  /either --start or --startFrame/,
);
assert.throws(() => resolveRenderStart({ startFrame: "1.5" }, fps), /Invalid startFrame/);

// Snapping remains compatible with the existing end-of-stream hold guard: an
// out-of-range timeline request still stays beyond duration - half a frame.
const sourceDuration = 614.833333;
const tailRequest = targetForMode(614.890667, fps, "frame-grid");
assert.equal(targetAtOrPastEnd(tailRequest.decoderTarget, sourceDuration, fps), true);
assert.equal(targetAtOrPastEnd(sourceDuration - frameDuration, sourceDuration, fps), false);

assert.throws(() => targetForMode(0, fps, "unknown"), /Unsupported media target mode/);
assert.match(mainSource, /mediaTargetMode: args\.mediaTargetMode \?\? "exact"/);
assert.match(mainSource, /ipcMain\.handle\("renderkit:report-results"/);
assert.match(preloadSource, /reportResults: \(payload\) => ipcRenderer\.invoke\("renderkit:report-results"/);
assert.match(rendererSource, /reportResults\(partialResults\(reportedError\)\)/);
assert.match(rendererSource, /let productionFrameEnded = true;\s+let productionFrameError = null;\s+try \{/);
assert.match(rendererSource, /catch \(error\) \{\s+productionFrameError = error;\s+throw error;/);
assert.match(rendererSource, /finally \{\s+if \(productionDecoderRuntime && !productionFrameEnded\)/);
assert.match(rendererSource, /throw new AggregateError\(\s*\[productionFrameError, cleanupError\]/);
console.log("media target grid tests passed");
