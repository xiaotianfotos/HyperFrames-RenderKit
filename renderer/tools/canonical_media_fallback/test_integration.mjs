#!/usr/bin/env node

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  BIT_DEPTH_POLICY_10_TO_8,
  CanonicalPolicyRequiredError,
  buildCanonicalCache,
  inspectCanonicalSource,
  runProcess,
  verifyCanonicalCache,
} from "./lib.mjs";

async function generateVfrBFrameFixture(outputPath, hueDegrees = 0) {
  await runProcess("ffmpeg", [
    "-hide_banner", "-loglevel", "error", "-y",
    "-f", "lavfi", "-i", "testsrc2=size=160x90:rate=24:duration=1.5",
    "-f", "lavfi", "-i", "sine=frequency=880:sample_rate=48000:duration=1.5",
    "-map", "0:v:0", "-map", "1:a:0",
    "-vf",
    [
      "select=not(eq(n\\,1)+eq(n\\,4)+eq(n\\,8)+eq(n\\,17))",
      `hue=h=${hueDegrees}`,
      "format=yuv420p",
      "setsar=4/3",
      "setparams=range=limited:color_primaries=bt709:color_trc=bt709:colorspace=bt709",
    ].join(","),
    "-fps_mode", "vfr",
    "-c:v", "libx264", "-preset", "veryfast", "-crf", "12",
    "-g", "12", "-keyint_min", "12", "-sc_threshold", "0", "-bf", "3",
    "-x264-params", "bframes=3:b-adapt=0:scenecut=0",
    "-tag:v", "avc1", "-video_track_timescale", "24000",
    "-color_range", "tv", "-color_primaries", "bt709", "-color_trc", "bt709",
    "-colorspace", "bt709", "-chroma_sample_location", "left",
    "-c:a", "aac", "-b:a", "64k", "-shortest",
    outputPath,
  ], { captureStdout: false });
}

async function generateHdrTaggedFixture(outputPath) {
  await runProcess("ffmpeg", [
    "-hide_banner", "-loglevel", "error", "-y",
    "-f", "lavfi", "-i", "testsrc2=size=160x90:rate=24:duration=0.25",
    "-vf", [
      "format=yuv420p",
      "setparams=range=limited:color_primaries=bt2020:color_trc=smpte2084:colorspace=bt2020nc",
    ].join(","),
    "-c:v", "libx264", "-preset", "ultrafast", "-crf", "12",
    "-color_range", "tv", "-color_primaries", "bt2020", "-color_trc", "smpte2084",
    "-colorspace", "bt2020nc", "-chroma_sample_location", "left",
    "-an", outputPath,
  ], { captureStdout: false });
}

async function generateAlphaFixture(outputPath) {
  await runProcess("ffmpeg", [
    "-hide_banner", "-loglevel", "error", "-y",
    "-f", "lavfi", "-i", "color=c=red@0.35:size=160x90:rate=24:duration=0.25",
    "-vf", "format=argb",
    "-c:v", "qtrle", "-an", outputPath,
  ], { captureStdout: false });
}

async function generateTenBitSdrFixture(outputPath) {
  await runProcess("ffmpeg", [
    "-hide_banner", "-loglevel", "error", "-y",
    "-f", "lavfi", "-i", "testsrc2=size=160x90:rate=24:duration=0.5",
    "-vf", [
      "format=yuv420p10le",
      "setparams=range=limited:color_primaries=bt709:color_trc=bt709:colorspace=bt709",
    ].join(","),
    "-c:v", "libx265", "-preset", "ultrafast",
    "-x265-params", "pools=1:frame-threads=1:keyint=24:min-keyint=24:scenecut=0",
    "-pix_fmt", "yuv420p10le", "-tag:v", "hvc1",
    "-color_range", "tv", "-color_primaries", "bt709", "-color_trc", "bt709",
    "-colorspace", "bt709", "-chroma_sample_location", "left",
    "-an", outputPath,
  ], { captureStdout: false });
}

function loadManifest(filePath) {
  return JSON.parse(readFileSync(filePath, "utf8"));
}

function runCli(argumentsList) {
  return new Promise((resolveRun, rejectRun) => {
    const cliPath = fileURLToPath(new URL("./cli.mjs", import.meta.url));
    const child = spawn(process.execPath, [cliPath, ...argumentsList], { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.once("error", rejectRun);
    child.once("close", (code) => resolveRun({ code, stdout, stderr }));
  });
}

const testRoot = mkdtempSync(resolve(tmpdir(), "canonical-media-fallback-test-"));
const cacheDirectory = resolve(testRoot, "cache");
const sourcePath = resolve(testRoot, "vfr-bframes.mp4");
const hdrPath = resolve(testRoot, "hdr-tagged.mp4");
const rotatedPath = resolve(testRoot, "rotated.mp4");
const alphaPath = resolve(testRoot, "alpha.mov");
const tenBitPath = resolve(testRoot, "ten-bit-sdr.mp4");
const missingSarPath = resolve(testRoot, "missing-sar.mp4");

try {
  await runProcess("ffmpeg", [
    "-hide_banner", "-loglevel", "error", "-y",
    "-f", "lavfi", "-i", "testsrc2=size=160x90:rate=24:duration=0.25",
    "-vf", [
      "format=yuv420p",
      "setsar=0/1",
      "setparams=range=limited:color_primaries=bt709:color_trc=bt709:colorspace=bt709",
    ].join(","),
    "-c:v", "libx264", "-preset", "ultrafast", "-crf", "12",
    "-color_range", "tv", "-color_primaries", "bt709", "-color_trc", "bt709",
    "-colorspace", "bt709", "-chroma_sample_location", "left",
    "-an", missingSarPath,
  ], { captureStdout: false });
  const missingSarInspection = await inspectCanonicalSource({ input: missingSarPath });
  assert.equal(missingSarInspection.status, "cache-required-with-policy");
  assert.ok(missingSarInspection.blockers.some((item) => item.code === "SAR_POLICY_REQUIRED"));
  const declaredSarInspection = await inspectCanonicalSource({
    input: missingSarPath,
    sampleAspectRatio: "1:1",
  });
  assert.equal(declaredSarInspection.status, "supported");
  assert.deepEqual(declaredSarInspection.sarResolution, {
    mode: "explicit-for-missing-source-metadata",
    source: null,
    declared: "1:1",
    effective: "1:1",
  });
  const declaredSarCache = await buildCanonicalCache({
    input: missingSarPath,
    fps: "24",
    cacheDirectory,
    sampleAspectRatio: "1:1",
  });
  assert.equal(declaredSarCache.manifest.recipe.sarPolicy.mode, "explicit-for-missing-source-metadata");
  assert.equal(declaredSarCache.manifest.acceptance.structure.sampleAspectRatio, "1:1");
  await verifyCanonicalCache({ manifest: declaredSarCache.manifestPath });

  await generateVfrBFrameFixture(sourcePath, 0);
  const sourceInspection = await inspectCanonicalSource({ input: sourcePath });
  assert.equal(sourceInspection.status, "supported");
  assert.equal(sourceInspection.timeline.variableFrameRate, true, "fixture must be VFR by presentation PTS deltas");
  assert.equal(sourceInspection.timeline.hasBFrames, true, "fixture must decode B pictures");
  assert.equal(sourceInspection.stream.audioStreamCount, 1, "fixture must prove audio is removed from cache");
  assert.equal(sourceInspection.stream.sampleAspectRatio, "4:3");

  const events = [];
  const first = await buildCanonicalCache({
    input: sourcePath,
    fps: "24",
    cacheDirectory,
    onEvent: (event) => events.push(event.type),
  });
  assert.equal(first.status, "built");
  assert.equal(first.hit, false);
  assert.ok(events.includes("source-probed"));
  assert.ok(events.includes("cache-build"));
  assert.ok(events.includes("cache-ready"));
  assert.match(first.manifest.source.fingerprint.sha256, /^[a-f0-9]{64}$/);
  assert.match(first.manifest.recipe.hash, /^[a-f0-9]{64}$/);
  assert.equal(first.manifest.recipe.profile, "quality");
  assert.equal(first.manifest.recipe.quality.crf, 10);
  assert.equal(first.manifest.recipe.codecTag, "avc1");
  assert.equal(first.manifest.recipe.closedGop, true);
  assert.equal(first.manifest.recipe.bFrames, 0);
  assert.equal(first.manifest.acceptance.passed, true);
  assert.equal(first.manifest.acceptance.structure.audioStreamCount, 0);
  assert.equal(first.manifest.acceptance.structure.ptsCheckedPerFrame, true);
  assert.equal(first.manifest.acceptance.structure.timeBase, "1/24000");
  assert.equal(first.manifest.acceptance.structure.sampleAspectRatio, "4:3");
  assert.equal(first.manifest.acceptance.structure.closedGopValidated, true);
  assert.ok(first.manifest.acceptance.structure.keyFrameIndices.length >= 2);
  assert.ok(first.manifest.frameMap.entries.length > sourceInspection.timeline.frameCount);
  assert.equal(first.manifest.frameMap.entries.length, first.manifest.acceptance.structure.frameCount);
  assert.ok(first.manifest.frameMap.entries.some((entry, index, entries) => (
    index > 0 && entry.sourceFrameIndex === entries[index - 1].sourceFrameIndex
  )), "VFR gaps must be represented as repeated source selections");
  for (const [frameIndex, entry] of first.manifest.frameMap.entries.entries()) {
    assert.equal(entry.cacheFrameIndex, frameIndex);
    assert.equal(entry.cachePtsTicks, String(frameIndex * 1000));
    assert.equal(entry.sourcePtsTicks, sourceInspection.timeline.presentationPtsTicks[entry.sourceFrameIndex]);
  }

  const cacheStatBeforeHit = statSync(first.cachePath, { bigint: true });
  const secondEvents = [];
  const second = await buildCanonicalCache({
    input: sourcePath,
    fps: "24/1",
    cacheDirectory,
    onEvent: (event) => secondEvents.push(event.type),
  });
  const cacheStatAfterHit = statSync(second.cachePath, { bigint: true });
  assert.equal(second.status, "hit");
  assert.equal(second.hit, true);
  assert.equal(second.cachePath, first.cachePath);
  assert.deepEqual(secondEvents, ["source-probed", "cache-hit"]);
  assert.equal(cacheStatAfterHit.mtimeNs, cacheStatBeforeHit.mtimeNs, "cache hit must not rewrite media");

  const verified = await verifyCanonicalCache({ manifest: first.manifestPath });
  assert.equal(verified.status, "verified");
  assert.equal(verified.frameCount, first.manifest.frameMap.cacheFrameCount);
  assert.equal(verified.acceptance.passed, true);

  const downsampled = await buildCanonicalCache({
    input: sourcePath,
    fps: "12",
    cacheDirectory,
  });
  assert.equal(downsampled.status, "built");
  assert.equal(downsampled.manifest.acceptance.pixelSampling.passed, true);
  assert.ok(downsampled.manifest.frameMap.entries.some((entry, index, entries) => (
    index > 0 && entry.sourceFrameIndex - entries[index - 1].sourceFrameIndex > 1
  )), "downsample mapping must select the last colliding presentation frame on each output grid point");

  const fpsInvalidation = await buildCanonicalCache({
    input: sourcePath,
    fps: "30000/1001",
    cacheDirectory,
  });
  assert.equal(fpsInvalidation.status, "built");
  assert.notEqual(fpsInvalidation.cachePath, first.cachePath);
  assert.notEqual(fpsInvalidation.manifest.recipe.hash, first.manifest.recipe.hash);
  assert.equal(fpsInvalidation.manifest.recipe.outputTimeBase, "1/30000000");
  assert.equal(fpsInvalidation.manifest.recipe.outputFrameStepTicks, "1001000");
  assert.equal(fpsInvalidation.manifest.acceptance.structure.averageFrameRate, "30000/1001");

  await generateVfrBFrameFixture(sourcePath, 90);
  const sourceInvalidation = await buildCanonicalCache({
    input: sourcePath,
    fps: "24",
    cacheDirectory,
  });
  assert.equal(sourceInvalidation.status, "built");
  assert.notEqual(sourceInvalidation.cachePath, first.cachePath);
  assert.notEqual(sourceInvalidation.manifest.source.fingerprint.sha256, first.manifest.source.fingerprint.sha256);
  assert.equal(loadManifest(sourceInvalidation.manifestPath).source.fingerprint.sha256,
    sourceInvalidation.manifest.source.fingerprint.sha256);

  await runProcess("ffmpeg", [
    "-hide_banner", "-loglevel", "error", "-y",
    "-display_rotation:v:0", "90", "-i", sourcePath,
    "-map", "0:v:0", "-c", "copy", "-an", rotatedPath,
  ], { captureStdout: false });
  const rotatedInspection = await inspectCanonicalSource({ input: rotatedPath });
  assert.equal(rotatedInspection.status, "cache-required-with-policy");
  assert.ok(rotatedInspection.blockers.some((item) => item.code === "ORIENTATION_POLICY_REQUIRED"));

  await generateAlphaFixture(alphaPath);
  const alphaInspection = await inspectCanonicalSource({ input: alphaPath });
  assert.equal(alphaInspection.status, "cache-required-with-policy");
  assert.ok(alphaInspection.blockers.some((item) => item.code === "ALPHA_POLICY_REQUIRED"));

  await generateTenBitSdrFixture(tenBitPath);
  const tenBitRejected = await inspectCanonicalSource({ input: tenBitPath });
  assert.equal(tenBitRejected.status, "cache-required-with-policy");
  assert.ok(tenBitRejected.blockers.some((item) => item.code === "BIT_DEPTH_POLICY_REQUIRED"));
  const tenBitApproved = await inspectCanonicalSource({
    input: tenBitPath,
    bitDepthPolicy: BIT_DEPTH_POLICY_10_TO_8,
  });
  assert.equal(tenBitApproved.status, "supported");
  assert.equal(tenBitApproved.bitDepthConversion.active, true);
  assert.equal(tenBitApproved.bitDepthConversion.dither, "zscale-error-diffusion");
  const tenBitCache = await buildCanonicalCache({
    input: tenBitPath,
    fps: "24",
    cacheDirectory,
    bitDepthPolicy: BIT_DEPTH_POLICY_10_TO_8,
  });
  assert.equal(tenBitCache.status, "built");
  assert.equal(tenBitCache.manifest.recipe.bitDepthPolicy.active, true);
  assert.equal(tenBitCache.manifest.recipe.bitDepthPolicy.requestedPolicy, BIT_DEPTH_POLICY_10_TO_8);
  assert.equal(tenBitCache.manifest.acceptance.structure.pixelFormat, "yuv420p");
  assert.equal(tenBitCache.manifest.acceptance.pixelSampling.passed, true);
  const tenBitVerified = await verifyCanonicalCache({ manifest: tenBitCache.manifestPath });
  assert.equal(tenBitVerified.status, "verified");

  await generateHdrTaggedFixture(hdrPath);
  const hdrInspection = await inspectCanonicalSource({ input: hdrPath });
  assert.equal(hdrInspection.status, "cache-required-with-policy");
  assert.ok(hdrInspection.blockers.some((item) => item.code === "HDR_POLICY_REQUIRED"));
  const cacheEntriesBeforeReject = readdirSync(cacheDirectory).sort();
  await assert.rejects(
    buildCanonicalCache({ input: hdrPath, fps: "24", cacheDirectory }),
    (error) => error instanceof CanonicalPolicyRequiredError
      && error.status === "cache-required-with-policy"
      && error.details.blockers.some((item) => item.code === "HDR_POLICY_REQUIRED"),
  );
  const rejectedCli = await runCli([
    "build", `--input=${hdrPath}`, "--fps=24", `--cache-dir=${cacheDirectory}`, "--json",
  ]);
  assert.equal(rejectedCli.code, 2);
  assert.equal(rejectedCli.stdout, "");
  const rejectedPayload = JSON.parse(rejectedCli.stderr);
  assert.equal(rejectedPayload.status, "cache-required-with-policy");
  assert.equal(rejectedPayload.code, "CANONICAL_MEDIA_POLICY_REQUIRED");
  assert.deepEqual(readdirSync(cacheDirectory).sort(), cacheEntriesBeforeReject,
    "policy rejection must not create or mutate cache artifacts");

  process.stdout.write("canonical media fallback integration test passed\n");
} finally {
  rmSync(testRoot, { recursive: true, force: true });
}
