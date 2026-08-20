#!/usr/bin/env electron

import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { once } from "node:events";
import {
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { spawn } from "node:child_process";
import { app, nativeImage } from "electron";
import {
  FRAME_SIGNATURE_GRID_HEIGHT,
  FRAME_SIGNATURE_GRID_WIDTH,
  createFrameSignatureHeader,
  createFrameSignatureWriter,
  rgbSignatureFromResizedBgra,
} from "./frame_signature_sidecar.mjs";
import { buildFullAudioOracleContract, validateFinalMov } from "./validate_final_mov.mjs";

function run(command, args) {
  return new Promise((resolveRun, rejectRun) => {
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.once("error", rejectRun);
    child.once("close", (code) => code === 0
      ? resolveRun({ stdout, stderr })
      : rejectRun(new Error(`${command} exited ${code}: ${stderr}`)));
  });
}

function successfulMetrics(output, runId, renderIdentity, sidecar = null) {
  return {
    runId,
    renderIdentity,
    failure: null,
    failureKind: null,
    failureExitCode: 0,
    config: {
      output,
      width: 64,
      height: 64,
      fps: 60,
      frames: 12,
      startFrame: 0,
      outputBackend: "screenshot",
      compositeMode: "screenshot",
      mediaDecoderBackend: "html-video",
      mixProjectAudio: true,
      audioCodec: "pcm_s24le",
      audioSampleRate: 48_000,
      memoryWatchdogEnabled: true,
    },
    renderer: { framesCompleted: 12, outputChunks: 12, pendingPayloadBytes: 0, mediaSeekErrors: [] },
    probe: { format: { size: String(statSync(output).size) } },
    decodedAudio: { frameCount: 10, samplesPerChannel: 9_600 },
    outputCommit: {
      stagingOutput: resolve(output, "..", `.absent-${runId}.mov`),
      committed: true,
    },
    screenshotSequence: {
      expectedFrames: 12,
      capturedFrames: 12,
      frameHashSequence: { framesObserved: 12, sequenceSha256: "44".repeat(32) },
      frameSignatureSidecar: sidecar,
      mediaGate: { finalActiveUrls: 0, finalActiveLeases: 0 },
    },
    memoryWatchdog: { samplesObserved: 2, violation: null },
    createdAt: new Date().toISOString(),
  };
}

async function encodePngSequence(pngs, audioPath, output) {
  const child = spawn("ffmpeg", [
    "-hide_banner", "-loglevel", "error", "-nostdin", "-y",
    "-f", "image2pipe", "-framerate", "60", "-vcodec", "png", "-i", "pipe:0",
    "-i", audioPath, "-map", "0:v:0", "-map", "1:a:0", "-frames:v", "12",
    "-vf", "format=yuv420p,setparams=range=limited:color_primaries=bt709:color_trc=bt709:colorspace=bt709",
    "-c:v", "libx264", "-preset", "ultrafast", "-qp", "18", "-tag:v", "avc1",
    "-x264-params", "colorprim=bt709:transfer=bt709:colormatrix=bt709:fullrange=off",
    "-color_range", "tv", "-colorspace", "bt709", "-color_primaries", "bt709", "-color_trc", "bt709",
    "-c:a", "pcm_s24le", "-ar", "48000", "-ac", "2", "-shortest", output,
  ], { stdio: ["pipe", "ignore", "pipe"] });
  let stderr = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  for (const png of pngs) {
    if (!child.stdin.write(png)) await once(child.stdin, "drain");
  }
  child.stdin.end();
  const [code] = await once(child, "close");
  if (code !== 0) throw new Error(`ffmpeg PNG encoder exited ${code}: ${stderr}`);
}

const root = mkdtempSync(resolve(tmpdir(), "hf-frame-signature-electron-"));
try {
  const audioPath = resolve(root, "oracle.wav");
  await run("ffmpeg", [
    "-hide_banner", "-loglevel", "error", "-nostdin", "-y",
    "-f", "lavfi", "-i", "sine=frequency=997:sample_rate=48000:duration=0.2",
    "-c:a", "pcm_s24le", "-ar", "48000", "-ac", "2", audioPath,
  ]);
  const pngPattern = resolve(root, "screenshot-%03d.png");
  await run("ffmpeg", [
    "-hide_banner", "-loglevel", "error", "-nostdin", "-y",
    "-f", "lavfi", "-i", "testsrc2=size=64x64:rate=60:duration=0.2",
    "-frames:v", "12", "-c:v", "png", pngPattern,
  ]);
  const runId = `electron-e2e-${randomUUID()}`;
  const renderIdentity = {
    project: "55".repeat(32), entry: "66".repeat(32), assets: "77".repeat(32), timingBundle: "88".repeat(32),
    canonicalMediaRoute: "aa".repeat(32), decoderMappings: "bb".repeat(32),
  };
  const output = resolve(root, "electron-capture.mov");
  const writer = createFrameSignatureWriter({
    stagingPath: resolve(root, ".electron-capture.frame-signatures.partial.bin"),
    finalPath: `${output}.frame-signatures.bin`,
    header: createFrameSignatureHeader({
      runId, renderIdentity, width: 64, height: 64, fps: 60, frames: 12, startFrame: 0, startSeconds: 0,
    }),
  });
  const pngs = [];
  for (let frame = 0; frame < 12; frame += 1) {
    const png = readFileSync(resolve(root, `screenshot-${String(frame + 1).padStart(3, "0")}.png`));
    const image = nativeImage.createFromBuffer(png, { scaleFactor: 1 });
    assert.deepEqual(image.getSize(), { width: 64, height: 64 });
    pngs.push(png);
    const decoded = nativeImage.createFromBuffer(png, { scaleFactor: 1 });
    const resized = decoded.resize({ width: FRAME_SIGNATURE_GRID_WIDTH, height: FRAME_SIGNATURE_GRID_HEIGHT, quality: "best" });
    const captureSignature = rgbSignatureFromResizedBgra(resized.toBitmap({ scaleFactor: 1 }));
    await writer.write(frame, captureSignature);
  }
  const sidecar = await writer.finalize();
  writer.commit();
  await encodePngSequence(pngs, audioPath, output);
  const committedSidecar = { ...sidecar, committed: true };
  writeFileSync(`${output}.metrics.json`, `${JSON.stringify(successfulMetrics(output, runId, renderIdentity, committedSidecar), null, 2)}\n`);

  const golden = resolve(root, "approved-remux.mov");
  await run("ffmpeg", [
    "-hide_banner", "-loglevel", "error", "-nostdin", "-y", "-i", output,
    "-map", "0", "-c", "copy", "-metadata", "comment=independent-e2e-approved-remux", golden,
  ]);
  const goldenRunId = "electron-e2e-golden";
  writeFileSync(`${golden}.metrics.json`, `${JSON.stringify(successfulMetrics(golden, goldenRunId, renderIdentity, null), null, 2)}\n`);
  const projectIdentity = `sha256:${"99".repeat(32)}`;
  const fullAudioOracle = await buildFullAudioOracleContract({
    path: audioPath,
    projectIdentity,
    inputFormat: "media",
    sampleRate: 48_000,
    channels: 2,
    expectedSamplesPerChannel: 9_600,
  });
  const goldenMetricsPath = `${golden}.metrics.json`;
  const manifest = resolve(root, "goldens.json");
  writeFileSync(manifest, `${JSON.stringify({
    kind: "hyperframes-golden-clip-manifest",
    schemaVersion: 2,
    projectIdentity,
    finalRenderIdentityProject: renderIdentity.project,
    fullAudioOracle,
    clips: [{
      id: "electron-e2e-approved-remux",
      path: golden,
      metrics: goldenMetricsPath,
      globalStartFrame: 0,
      frameCount: 12,
      approvedIdentity: {
        movieSha256: `sha256:${createHash("sha256").update(readFileSync(golden)).digest("hex")}`,
        metricsSha256: `sha256:${createHash("sha256").update(readFileSync(goldenMetricsPath)).digest("hex")}`,
        metricsRunId: goldenRunId,
        screenshotSequenceSha256: "44".repeat(32),
        projectIdentity,
        renderIdentityProject: renderIdentity.project,
      },
    }],
  }, null, 2)}\n`);
  const report = await validateFinalMov({
    input: output,
    goldenManifest: manifest,
    outputDir: resolve(root, "validation"),
    frames: 12,
    fps: 60,
    width: 64,
    height: 64,
    cropTop: 0,
    ssimMinimum: 0.999,
    times: [0, 0.1, 11 / 60],
    skipAudioScan: true,
  });
  if (!report.ok) console.error(JSON.stringify(report.frameSignatures?.result, null, 2));
  assert.equal(report.ok, true, report.errors.join("\n"));
  assert.equal(report.frameSignatures.result.failedFrameCount, 0);
  process.stdout.write(`${JSON.stringify({
    ok: true,
    frames: report.frameSignatures.result.frameCount,
    maximumChannelDelta: report.frameSignatures.result.globalMaximumChannelDelta,
    maximumFractionAbove64: report.frameSignatures.result.globalMaximumFractionAbove64,
    maximumFractionAbove128: report.frameSignatures.result.globalMaximumFractionAbove128,
    maximumAverageHashDistance: report.frameSignatures.result.globalMaximumAverageHashDistance,
    maximumDifferenceHashDistance: report.frameSignatures.result.globalMaximumDifferenceHashDistance,
    averageMeanAbsoluteDelta: report.frameSignatures.result.averageMeanAbsoluteDelta,
    minimumFrameSimilarity: report.frameSignatures.result.minimumFrameSimilarity,
  }, null, 2)}\n`);
} finally {
  app.quit();
  rmSync(root, { recursive: true, force: true });
}
