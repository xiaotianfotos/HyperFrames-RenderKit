#!/usr/bin/env node

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { resolve } from "node:path";
import { tmpdir } from "node:os";
import { main as runCacheTool } from "./media_cfr_cache.mjs";

function run(command, args) {
  return new Promise((resolveRun, rejectRun) => {
    const child = spawn(command, args, { stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.once("error", rejectRun);
    child.once("close", (code) => {
      if (code === 0) resolveRun();
      else rejectRun(new Error(`${command} exited ${code}: ${stderr}`));
    });
  });
}

function runCapture(command, args) {
  return new Promise((resolveRun, rejectRun) => {
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
    const stdout = [];
    let stderr = "";
    child.stdout.on("data", (chunk) => stdout.push(chunk));
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.once("error", rejectRun);
    child.once("close", (code) => {
      if (code === 0) resolveRun(Buffer.concat(stdout));
      else rejectRun(new Error(`${command} exited ${code}: ${stderr}`));
    });
  });
}

async function sampleFrameColors(filePath) {
  const bytes = await runCapture("ffmpeg", [
    "-hide_banner", "-loglevel", "error", "-i", filePath,
    "-vf", "scale=1:1:flags=area", "-pix_fmt", "rgb24", "-fps_mode", "passthrough",
    "-f", "rawvideo", "pipe:1",
  ]);
  assert.equal(bytes.length % 3, 0);
  return Array.from({ length: bytes.length / 3 }, (_unused, index) => (
    [bytes[index * 3], bytes[index * 3 + 1], bytes[index * 3 + 2]]
  ));
}

function nearestColorIndex(color, references) {
  let bestIndex = -1;
  let bestDistance = Number.POSITIVE_INFINITY;
  for (const [index, reference] of references.entries()) {
    const distance = color.reduce((sum, channel, channelIndex) => (
      sum + (channel - reference[channelIndex]) ** 2
    ), 0);
    if (distance < bestDistance) {
      bestDistance = distance;
      bestIndex = index;
    }
  }
  return bestIndex;
}

const projectRoot = mkdtempSync(resolve(tmpdir(), "hf-cfr-integration-"));

try {
  const mediaDirectory = resolve(projectRoot, "media");
  mkdirSync(mediaDirectory, { recursive: true });
  const sourceFilters = new Map([
    [
      "video_008",
      "nullsrc=s=160x90:r=60:d=0.1,"
      + "geq=r='mod(N*40,256)':g='mod(N*70,256)':b='mod(N*100,256)',"
      + "format=yuv420p,select='not(eq(n,1)+eq(n,4))'",
    ],
    ["video_009", "testsrc2=size=160x90:rate=60:duration=0.1,select='not(eq(n,2))'"],
    ["video_014", "testsrc2=size=160x90:rate=60:duration=0.1,select='not(eq(n,1))'"],
  ]);
  for (const id of ["video_008", "video_009", "video_014"]) {
    await run("ffmpeg", [
      "-hide_banner", "-loglevel", "error", "-y",
      "-f", "lavfi",
      "-i", sourceFilters.get(id),
      "-c:v", "libx264", "-pix_fmt", "yuv420p", "-fps_mode", "vfr",
      "-video_track_timescale", "60000",
      resolve(mediaDirectory, `${id}.mp4`),
    ]);
  }
  writeFileSync(resolve(projectRoot, "index.html"), [
    "<!doctype html>",
    "<video src=\"media/video_008.mp4\"></video>",
    "<video src=\"media/video_009.mp4\"></video>",
    "<video src=\"media/video_014.mp4\"></video>",
  ].join("\n"));

  await runCacheTool([
    "generate",
    `--projectRoot=${projectRoot}`,
    "--encoder=libx264",
  ]);
  await runCacheTool([
    "generate",
    `--projectRoot=${projectRoot}`,
    "--encoder=libx264",
  ]);
  await runCacheTool([
    "verify",
    `--projectRoot=${projectRoot}`,
    "--verify=sha256",
  ]);

  const manifest = JSON.parse(readFileSync(
    resolve(projectRoot, ".render-cache/cfr60/media-source-map.json"),
    "utf8",
  ));
  assert.equal(manifest.entries.length, 3);
  for (const entry of manifest.entries) {
    assert.equal(entry.cacheMedia.video.avgFrameRate, "60/1");
    assert.equal(entry.cacheMedia.video.timeBase, "1/60000");
    assert.equal(entry.cacheTimeline.firstTimestamp, "0");
    assert.equal(entry.cacheTimeline.expectedStepTicks, 1000);
    assert.equal(entry.cacheTimeline.maxGridErrorTicks, "0");
    assert.equal(entry.cacheTimeline.onGrid, true);
    assert.equal(entry.cacheTimeline.frameCount, Number(entry.cacheMedia.video.nbReadFrames));
    assert.equal(entry.sourceTimeline.firstGridIndex, 0);
    assert.equal(entry.sourceTimeline.onGrid, true);
    assert.equal(entry.sourceTimeline.strictlyIncreasing, true);
    assert.ok(entry.sourceTimeline.missingGridFrames > 0);
    assert.match(entry.cache, new RegExp(`${entry.id}\\.[a-f0-9]{12}\\.[a-f0-9]{12}\\.cfr60\\.h264\\.mp4$`));
  }

  const sparseEntry = manifest.entries.find((entry) => entry.id === "video_008");
  const sparseSourceColors = await sampleFrameColors(resolve(projectRoot, sparseEntry.source));
  const sparseCacheColors = await sampleFrameColors(resolve(projectRoot, sparseEntry.cache));
  const sparseSourceGridIndices = sparseEntry.sourceTimeline.firstGridIndices;
  assert.equal(sparseSourceColors.length, sparseSourceGridIndices.length);
  const actualCacheIdentities = sparseCacheColors.map((color) => (
    sparseSourceGridIndices[nearestColorIndex(color, sparseSourceColors)]
  ));
  const expectedCacheIdentities = sparseCacheColors.map((_color, gridIndex) => (
    sparseSourceGridIndices.findLast((sourceGridIndex) => sourceGridIndex <= gridIndex)
      ?? sparseSourceGridIndices[0]
  ));
  assert.deepEqual(actualCacheIdentities, expectedCacheIdentities);
  console.log("media CFR cache integration test passed");
} finally {
  rmSync(projectRoot, { recursive: true, force: true });
}
