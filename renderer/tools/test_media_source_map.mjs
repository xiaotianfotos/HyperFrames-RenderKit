#!/usr/bin/env node

import assert from "node:assert/strict";
import {
  appendFileSync,
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { dirname, resolve } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { runInNewContext } from "node:vm";
import {
  MEDIA_SOURCE_MAP_KIND,
  MEDIA_SOURCE_MAP_SCHEMA_VERSION,
  buildCfrFfmpegArgs,
  createCfrRecipe,
  findCfrTargetSources,
  fingerprintFile,
  loadAndVerifyMediaSourceMap,
  projectFile,
  validateManifestShape,
} from "./media_source_map_lib.mjs";
import { parseToolArguments } from "./media_cfr_cache.mjs";

const rendererRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const temporaryRoot = mkdtempSync(resolve(tmpdir(), "hf-media-map-test-"));

function mediaProbe({ cache = false } = {}) {
  return {
    formatDuration: "1.000000",
    formatSize: "4",
    audioStreams: 0,
    video: {
      codecName: "h264",
      pixelFormat: cache ? "yuv420p" : "yuv420p",
      width: 1920,
      height: 1080,
      rFrameRate: "60/1",
      avgFrameRate: "60/1",
      nbReadFrames: "60",
      duration: "1.000000",
      startTime: "0.000000",
      timeBase: "1/60000",
    },
  };
}

function cacheTimeline(frameCount = 60) {
  return {
    gridFps: 60,
    timeBase: "1/60000",
    frameCount,
    expectedStepTicks: 1000,
    firstTimestamp: "0",
    lastTimestamp: String((frameCount - 1) * 1000),
    startsAtZero: true,
    onGrid: true,
    maxGridErrorTicks: "0",
    firstMismatch: null,
  };
}

function sourceTimeline(frameCount = 60) {
  return {
    gridFps: 60,
    gridToleranceSeconds: 0.000001,
    timeBase: "1/60000",
    frameCount,
    firstTimestamp: "0",
    lastTimestamp: String((frameCount - 1) * 1000),
    firstGridIndex: 0,
    lastGridIndex: frameCount - 1,
    firstGridIndices: [0, 1, 2, 3, 4, 5, 6, 7],
    startsAtZero: true,
    onGrid: true,
    strictlyIncreasing: true,
    missingGridFrames: 0,
    maxGapFrames: 0,
    maxGridErrorSeconds: 0,
    firstMismatch: null,
  };
}

try {
  mkdirSync(resolve(temporaryRoot, "media"), { recursive: true });
  mkdirSync(resolve(temporaryRoot, ".render-cache/cfr60"), { recursive: true });
  writeFileSync(resolve(temporaryRoot, "index.html"), `
    <video id="a" src="media/video_008.mp4"></video>
    <video id="b" src='media/video_009-capture.mp4'></video>
    <video id="c" src=media/video_014_take.mp4></video>
    <video id="unmapped" src="media/video_010.mp4"></video>
  `);

  const recipe = createCfrRecipe({
    encoder: "vaapi",
    device: "/dev/dri/renderD128",
    ffmpegVersion: "ffmpeg version test",
  });
  const targets = findCfrTargetSources({
    projectRoot: temporaryRoot,
    entryPath: resolve(temporaryRoot, "index.html"),
  });
  assert.deepEqual(targets.map((entry) => entry.id), ["video_008", "video_009", "video_014"]);

  const entries = [];
  for (const target of targets) {
    const sourcePath = resolve(temporaryRoot, target.source);
    const cache = `.render-cache/cfr60/${target.id}.cfr60.h264.mp4`;
    const cachePath = resolve(temporaryRoot, cache);
    writeFileSync(sourcePath, `source-${target.id}`);
    writeFileSync(cachePath, `cache-${target.id}`);
    entries.push({
      id: target.id,
      source: target.source,
      cache,
      sourceFingerprint: await fingerprintFile(sourcePath),
      cacheFingerprint: await fingerprintFile(cachePath),
      sourceMedia: mediaProbe(),
      sourceTimeline: sourceTimeline(),
      cacheMedia: mediaProbe({ cache: true }),
      cacheTimeline: cacheTimeline(),
      recipeKey: recipe.key,
    });
  }

  const manifest = {
    kind: MEDIA_SOURCE_MAP_KIND,
    schemaVersion: MEDIA_SOURCE_MAP_SCHEMA_VERSION,
    createdAt: new Date(0).toISOString(),
    recipe,
    entries,
  };
  validateManifestShape(manifest);
  const tamperedManifest = structuredClone(manifest);
  tamperedManifest.recipe.quality.qp = 17;
  assert.throws(() => validateManifestShape(tamperedManifest), /does not match the recorded recipe/);
  const shiftedTimelineManifest = structuredClone(manifest);
  shiftedTimelineManifest.entries[0].cacheTimeline.firstTimestamp = "1000";
  shiftedTimelineManifest.entries[0].cacheTimeline.startsAtZero = false;
  assert.throws(() => validateManifestShape(shiftedTimelineManifest), /cache timeline is invalid/);
  const shiftedSourceManifest = structuredClone(manifest);
  shiftedSourceManifest.entries[0].sourceTimeline.firstTimestamp = "1";
  shiftedSourceManifest.entries[0].sourceTimeline.startsAtZero = false;
  assert.throws(() => validateManifestShape(shiftedSourceManifest), /source timeline is invalid/);
  const manifestPath = resolve(temporaryRoot, ".render-cache/cfr60/media-source-map.json");
  writeFileSync(manifestPath, JSON.stringify(manifest));

  const loaded = await loadAndVerifyMediaSourceMap({
    manifestPath,
    projectRoot: temporaryRoot,
    verifyMode: "sha256",
  });
  assert.equal(loaded.entries.length, 3);
  assert.equal(loaded.entries[0].frameRate, 60);
  assert.match(loaded.entries[0].sourceUrl, /^file:/);
  assert.match(loaded.entries[0].cacheUrl, /^file:/);

  const vaapiArgs = buildCfrFfmpegArgs({
    recipe,
    sourcePath: "/source.mp4",
    outputPath: "/cache.mp4",
  });
  assert.ok(vaapiArgs.includes("h264_vaapi"));
  assert.equal(vaapiArgs[vaapiArgs.indexOf("-hwaccel_device") + 1], "va");
  assert.ok(vaapiArgs.includes("fps=60:start_time=0:round=up:eof_action=round,scale_vaapi=format=nv12"));
  assert.deepEqual(
    parseToolArguments(["generate", "--encoder=vaapi", "--projectRoot=/tmp/project"]),
    { command: "generate", options: { encoder: "vaapi", projectRoot: "/tmp/project" } },
  );

  assert.throws(
    () => projectFile(temporaryRoot, "../outside.mp4", "test path"),
    /escapes projectRoot/,
  );

  const copiedSource = resolve(temporaryRoot, entries[0].source);
  const replacementSource = `${copiedSource}.copied`;
  copyFileSync(copiedSource, replacementSource);
  renameSync(replacementSource, copiedSource);
  const movedMtime = new Date(Date.now() + 5_000);
  utimesSync(copiedSource, movedMtime, movedMtime);
  await assert.rejects(
    loadAndVerifyMediaSourceMap({ manifestPath, projectRoot: temporaryRoot, verifyMode: "stat" }),
    /source stat changed/,
  );
  await loadAndVerifyMediaSourceMap({ manifestPath, projectRoot: temporaryRoot, verifyMode: "sha256" });

  appendFileSync(copiedSource, "changed");
  await assert.rejects(
    loadAndVerifyMediaSourceMap({ manifestPath, projectRoot: temporaryRoot, verifyMode: "sha256" }),
    /source size changed/,
  );

  const rendererSource = readFileSync(resolve(rendererRoot, "full-canvas-renderer.js"), "utf8");
  const mainSource = readFileSync(resolve(rendererRoot, "full-canvas-main.mjs"), "utf8");
  assert.match(rendererSource, /decoderSource: mappedSource\?\.cacheUrl \?\? source/);
  assert.match(rendererSource, /decoder\.src = descriptor\.decoderSource/);
  assert.match(mainSource, /args\.mediaSourceMap/);

  const rendererWithoutEntrypoint = rendererSource.replace(
    /\nvoid runFullCanvasRenderWithFailureReport\(\)\.catch[\s\S]*$/,
    "",
  );
  const rendererSandbox = {};
  runInNewContext(
    `${rendererWithoutEntrypoint}\nglobalThis.__frameIndexForTest = cfrFrameIndexForMediaTime;`,
    rendererSandbox,
  );
  const frameIndexForTime = rendererSandbox.__frameIndexForTest;
  const expectedIndices = [0, 1, 2, 3, 4, 5];
  // A sparse VFR source has frames only at grid positions 0, 2, 3, and 5.
  // CFR normalization holds the previous identity in the two missing slots.
  const sparseSourceFrames = [0, 2, 3, 5].map((gridIndex) => ({
    gridIndex,
    identity: `source-frame-${gridIndex}`,
  }));
  const missingFrameIdentities = expectedIndices.map((gridIndex) => (
    sparseSourceFrames.findLast((frame) => frame.gridIndex <= gridIndex).identity
  ));
  for (const phase of [0.006667, 0.009334]) {
    const indices = expectedIndices.map((index) => frameIndexForTime(phase + index / 60, 60));
    assert.deepEqual(indices, expectedIndices, `CFR indices must stay stable at phase ${phase}`);
    assert.deepEqual(
      indices.map((index) => missingFrameIdentities[index]),
      missingFrameIdentities,
      `duplicated missing-frame identities must not shift at phase ${phase}`,
    );
  }
  console.log("media source map tests passed");
} finally {
  rmSync(temporaryRoot, { recursive: true, force: true });
}
