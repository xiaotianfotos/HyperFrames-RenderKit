#!/usr/bin/env node

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import {
  copyFileSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

import {
  buildFullAudioOracleContract,
  buildFullVideoOracleContract,
  validateFinalMov,
} from "./validate_final_mov.mjs";
import {
  FRAME_SIGNATURE_GRID_HEIGHT,
  FRAME_SIGNATURE_GRID_WIDTH,
  createFrameSignatureHeader,
  createFrameSignatureWriter,
} from "./frame_signature_sidecar.mjs";

function run(command, args) {
  return new Promise((resolveRun, rejectRun) => {
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stderr = "";
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.once("error", rejectRun);
    child.once("close", (code) => {
      if (code === 0) resolveRun();
      else rejectRun(new Error(`${command} exited ${code}: ${stderr.slice(-4_000)}`));
    });
  });
}

async function makeFixture(path, {
  frames = 12,
  audioSamples = frames * 800,
  audioFrequency = 997,
  metadata = null,
  redFrame = null,
  localPatchFrame = null,
} = {}) {
  const duration = frames / 60;
  await run("ffmpeg", [
    "-hide_banner", "-loglevel", "error", "-nostdin", "-y",
    "-f", "lavfi", "-i", `testsrc2=size=64x64:rate=60:duration=${duration}`,
    "-f", "lavfi", "-i", `sine=frequency=${audioFrequency}:sample_rate=48000:duration=${duration}`,
    "-map", "0:v:0", "-map", "1:a:0", "-frames:v", String(frames),
    "-vf", `${redFrame == null ? "" : `drawbox=x=0:y=0:w=iw:h=ih:color=red:t=fill:enable='eq(n,${redFrame})',`}${localPatchFrame == null ? "" : `drawbox=x=24:y=24:w=12:h=12:color=lime:t=fill:enable='eq(n,${localPatchFrame})',`}format=yuv420p,setparams=range=limited:color_primaries=bt709:color_trc=bt709:colorspace=bt709`,
    "-af", `atrim=end_sample=${audioSamples},asetpts=N/SR/TB`,
    "-c:v", "libx264", "-preset", "ultrafast", "-qp", "18", "-profile:v", "high",
    "-x264-params", "colorprim=bt709:transfer=bt709:colormatrix=bt709:fullrange=off",
    "-color_range", "tv", "-colorspace", "bt709", "-color_primaries", "bt709", "-color_trc", "bt709",
    "-c:a", "pcm_s24le", "-ar", "48000", "-ac", "2", "-movflags", "+faststart",
    ...(metadata ? ["-metadata", `comment=${metadata}`] : []),
    path,
  ]);
}

async function makeRawAudioOracle(source, path) {
  await run("ffmpeg", [
    "-hide_banner", "-loglevel", "error", "-nostdin", "-y", "-i", source,
    "-map", "0:a:0", "-vn", "-sn", "-dn", "-c:a", "pcm_s24le", "-f", "s24le", path,
  ]);
}

async function attachFrameSignatureSidecar(root, output, source, metrics) {
  const rawPath = resolve(root, `${metrics.runId}-${Math.random().toString(16).slice(2)}.rgb`);
  await run("ffmpeg", [
    "-hide_banner", "-loglevel", "error", "-nostdin", "-y", "-i", source,
    "-map", "0:v:0", "-an", "-sn", "-dn",
    "-vf", `scale=${FRAME_SIGNATURE_GRID_WIDTH}:${FRAME_SIGNATURE_GRID_HEIGHT}:flags=area,format=rgb24`,
    "-f", "rawvideo", "-pix_fmt", "rgb24", rawPath,
  ]);
  const bytes = readFileSync(rawPath);
  const signatureBytes = FRAME_SIGNATURE_GRID_WIDTH * FRAME_SIGNATURE_GRID_HEIGHT * 3;
  assert.equal(bytes.length, metrics.config.frames * signatureBytes);
  const finalPath = `${output}.frame-signatures.bin`;
  const stagingPath = resolve(root, `.${metrics.runId}-${Math.random().toString(16).slice(2)}.frame-signatures.partial.bin`);
  const writer = createFrameSignatureWriter({
    stagingPath,
    finalPath,
    header: createFrameSignatureHeader({
      runId: metrics.runId,
      renderIdentity: metrics.renderIdentity,
      width: metrics.config.width,
      height: metrics.config.height,
      fps: metrics.config.fps,
      frames: metrics.config.frames,
      startFrame: metrics.config.startFrame,
      startSeconds: metrics.config.startFrame / metrics.config.fps,
    }),
  });
  for (let frame = 0; frame < metrics.config.frames; frame += 1) {
    await writer.write(frame, bytes.subarray(frame * signatureBytes, (frame + 1) * signatureBytes));
  }
  const evidence = await writer.finalize();
  writer.commit();
  metrics.screenshotSequence.frameSignatureSidecar = { ...evidence, committed: true };
  return finalPath;
}

function successfulMetrics(output, { frames = 12, startFrame = 0, overrides = {} } = {}) {
  const size = statSync(output).size;
  const metrics = {
    runId: "fixture-run",
    renderIdentity: {
      project: "aa".repeat(32),
      entry: "bb".repeat(32),
      assets: "cc".repeat(32),
      timingBundle: "dd".repeat(32),
      canonicalMediaRoute: "ee".repeat(32),
      decoderMappings: "ff".repeat(32),
    },
    failure: null,
    failureKind: null,
    failureExitCode: 0,
    config: {
      output,
      width: 64,
      height: 64,
      fps: 60,
      frames,
      startFrame,
      outputBackend: "screenshot",
      compositeMode: "screenshot",
      mediaDecoderBackend: "html-video",
      mixProjectAudio: true,
      audioCodec: "pcm_s24le",
      audioSampleRate: 48_000,
      memoryWatchdogEnabled: true,
    },
    renderer: {
      framesCompleted: frames,
      outputChunks: frames,
      pendingPayloadBytes: 0,
      mediaSeekErrors: [],
    },
    probe: { format: { size: String(size) } },
    decodedAudio: { frameCount: Math.ceil(frames * 800 / 1024), samplesPerChannel: frames * 800 },
    outputCommit: {
      stagingOutput: resolve(output, "..", `.fixture.hf-partial-${process.pid}.mov`),
      committed: true,
      partialRemoved: false,
    },
    screenshotSequence: {
      expectedFrames: frames,
      capturedFrames: frames,
      frameHashSequence: {
        framesObserved: frames,
        sequenceSha256: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      },
      mediaGate: {
        finalActiveUrls: 0,
        finalActiveLeases: 0,
      },
    },
    memoryWatchdog: {
      samplesObserved: 3,
      violation: null,
    },
    createdAt: new Date().toISOString(),
    ...overrides,
  };
  return metrics;
}

function successfulProductionMetrics(output, overrides = {}) {
  const metrics = successfulMetrics(output);
  metrics.config.outputBackend = "webcodecs";
  metrics.config.compositeMode = "layered";
  metrics.config.mediaDecoderBackend = "production-webcodecs";
  delete metrics.screenshotSequence;
  const beforeDispose = {
    kind: "hyperframes-production-decoder-snapshot",
    schemaVersion: 1,
    phase: "before-dispose",
    directSources: 1,
    outputFrames: 12,
    cacheRequiredSources: 0,
    canonicalCacheDecisions: 0,
    acquireFailures: 0,
    activeSources: 1,
    activeLanes: 1,
    frameOpen: false,
    allocator: { metrics: { allocationFailures: 0 } },
    frameBudget: { outstandingFrames: 1, acquiredFrames: 13, closedFrames: 12 },
    sourceMetrics: [{
      kind: "hyperframes-production-decoder-source-metrics",
      schemaVersion: 1,
      sourceId: "fixture-source",
      framesAcquired: 12,
      validationFailures: 0,
    }],
    laneMetrics: [{
      kind: "hyperframes-production-decoder-lane-metrics",
      schemaVersion: 1,
      laneId: "fixture-lane",
      sourceId: "fixture-source",
      framesDecoded: 12,
      exactPtsFailures: 0,
      unexpectedOutputs: 0,
      duplicateOutputs: 0,
    }],
  };
  const afterDispose = {
    kind: "hyperframes-production-decoder-snapshot",
    schemaVersion: 1,
    phase: "after-dispose",
    directSources: 1,
    outputFrames: 12,
    cacheRequiredSources: 0,
    canonicalCacheDecisions: 0,
    acquireFailures: 0,
    activeSources: 0,
    activeLanes: 0,
    frameOpen: false,
    allocator: { metrics: { allocationFailures: 0 } },
    frameBudget: { outstandingFrames: 0, acquiredFrames: 13, closedFrames: 13 },
    sourceMetrics: [],
    laneMetrics: [],
  };
  const broker = (phase) => ({
    kind: "hyperframes-production-decoder-broker-snapshot",
    schemaVersion: 1,
    phase,
    canonicalCacheRequired: 0,
    activeSources: 0,
    activeCursors: 0,
    pendingBegins: 0,
    activeReads: 0,
    byteBudget: {
      kind: "hyperframes-production-decoder-byte-budget",
      schemaVersion: 1,
      abortedWaits: 0,
      currentBytes: 0,
      activeLeases: 0,
      waitingReservations: 0,
    },
  });
  metrics.renderer.support = { productionDecoder: {
    kind: "hyperframes-production-decoder-renderer-evidence",
    schemaVersion: 1,
    final: {
    kind: "hyperframes-production-decoder-final-evidence",
    schemaVersion: 1,
    beforeDispose,
    afterDispose,
    brokerAfterRendererDispose: broker("after-renderer-dispose"),
  } } };
  metrics.productionDecoder = {
    kind: "hyperframes-production-decoder-main-evidence",
    schemaVersion: 1,
    brokerBeforeDispose: broker("before-dispose"),
    brokerAfterDispose: broker("after-dispose"),
  };
  return Object.assign(metrics, overrides);
}

function sha256(path) {
  return `sha256:${createHash("sha256").update(readFileSync(path)).digest("hex")}`;
}

const PROJECT_IDENTITY = `sha256:${"11".repeat(32)}`;

async function writeGoldenManifest(root, name, clips, {
  finalRenderIdentityProject = "aa".repeat(32),
  fullVideoOracle,
  fullAudioOracle,
  fullFrameCount = 12,
  omitFullVideoOracle = false,
} = {}) {
  const manifestPath = resolve(root, name);
  const fullAudioOracleContract = await buildFullAudioOracleContract({
    path: fullAudioOracle,
    inputFormat: "s24le",
    sampleRate: 48_000,
    channels: 2,
    expectedSamplesPerChannel: fullFrameCount * 800,
    projectIdentity: PROJECT_IDENTITY,
  });
  const fullVideoOracleContract = omitFullVideoOracle ? null : await buildFullVideoOracleContract({
    path: fullVideoOracle,
    projectIdentity: PROJECT_IDENTITY,
    frameCount: fullFrameCount,
    width: 64,
    height: 64,
    fps: 60,
    comparisonWidth: 32,
    comparisonHeight: 32,
    cropTop: 0,
    minimumSsim: 0.999,
  });
  const manifest = {
    kind: "hyperframes-golden-clip-manifest",
    schemaVersion: 2,
    projectIdentity: PROJECT_IDENTITY,
    finalRenderIdentityProject,
    ...(fullVideoOracleContract ? { fullVideoOracle: fullVideoOracleContract } : {}),
    fullAudioOracle: fullAudioOracleContract,
    clips: clips.map((clip, index) => {
      const metricsPath = clip.metricsPath ?? `${clip.path}.metrics.json`;
      const metrics = JSON.parse(readFileSync(metricsPath, "utf8"));
      return {
        id: clip.id ?? `clip-${index}`,
        path: clip.path,
        metrics: metricsPath,
        globalStartFrame: clip.globalStartFrame ?? 0,
        frameCount: clip.frameCount,
        approvedIdentity: {
          movieSha256: sha256(clip.path),
          metricsSha256: sha256(metricsPath),
          metricsRunId: metrics.runId,
          screenshotSequenceSha256: metrics.screenshotSequence.frameHashSequence.sequenceSha256,
          projectIdentity: PROJECT_IDENTITY,
          renderIdentityProject: metrics.renderIdentity?.project,
          ...(clip.legacyMetricsApproved ? { legacyMetricsApproved: true } : {}),
        },
      };
    }),
  };
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  return manifestPath;
}

function writeMetrics(output, metrics) {
  writeFileSync(`${output}.metrics.json`, `${JSON.stringify(metrics, null, 2)}\n`);
}

function options(root, input, suffix, goldenManifest) {
  return {
    input,
    goldenManifest,
    outputDir: resolve(root, suffix),
    frames: 12,
    fps: 60,
    width: 64,
    height: 64,
    cropTop: 0,
    ssimMinimum: 0.999,
    times: [0, 0.1, 11 / 60],
    skipAudioScan: true,
  };
}

const root = mkdtempSync(resolve(tmpdir(), "hf-final-mov-validator-"));
try {
  const input = resolve(root, "accepted.mov");
  const golden = resolve(root, "golden.mov");
  const goldenPeer = resolve(root, "golden-peer.mov");
  const fullAudioOracle = resolve(root, "approved-full-audio.s24le");
  await makeFixture(input);
  await makeFixture(golden, { metadata: "independently-approved-golden" });
  await makeFixture(goldenPeer, { metadata: "independently-approved-golden-peer" });
  await makeRawAudioOracle(golden, fullAudioOracle);
  writeMetrics(input, successfulMetrics(input));
  writeMetrics(golden, successfulMetrics(golden));
  writeMetrics(goldenPeer, successfulMetrics(goldenPeer));
  const goldenManifest = await writeGoldenManifest(root, "goldens.json", [
    {
      id: "approved-full-fixture-a",
      path: golden,
      globalStartFrame: 0,
      frameCount: 12,
    },
    {
      id: "approved-full-fixture-b",
      path: goldenPeer,
      globalStartFrame: 0,
      frameCount: 12,
    },
  ], { fullVideoOracle: golden, fullAudioOracle });

  const accepted = await validateFinalMov(options(root, input, "accepted.validation", goldenManifest));
  assert.equal(accepted.ok, true, accepted.errors.join("\n"));
  assert.equal(accepted.videoTimeline.frameCount, 12);
  assert.equal(accepted.videoTimeline.mismatchCount, 0);
  assert.equal(accepted.audioTimeline.samplesPerChannel, 9_600);
  assert.equal(accepted.audioTimeline.mismatchCount, 0);
  assert.equal(accepted.golden.cropped.minimum, 1);
  assert.equal(accepted.screenshots.frames.every((frame) => frame.comparisons.length === 2), true);
  assert.equal(readFileSync(accepted.reportJson, "utf8").endsWith("\n"), true);
  assert.equal(readdirSync(resolve(root, "accepted.validation")).some((name) => name.includes(".tmp-")), false);

  const sidecarInput = resolve(root, "sidecar-accepted.mov");
  copyFileSync(input, sidecarInput);
  const sidecarMetrics = successfulMetrics(sidecarInput);
  await attachFrameSignatureSidecar(root, sidecarInput, golden, sidecarMetrics);
  writeMetrics(sidecarInput, sidecarMetrics);
  const sidecarManifest = await writeGoldenManifest(root, "goldens-sidecar.json", [
    { id: "approved-full-fixture-a", path: golden, globalStartFrame: 0, frameCount: 12 },
    { id: "approved-full-fixture-b", path: goldenPeer, globalStartFrame: 0, frameCount: 12 },
  ], { fullVideoOracle: golden, fullAudioOracle, omitFullVideoOracle: true });
  const sidecarAccepted = await validateFinalMov(options(root, sidecarInput, "sidecar-accepted.validation", sidecarManifest));
  assert.equal(sidecarAccepted.ok, true, sidecarAccepted.errors.join("\n"));
  assert.equal(sidecarAccepted.frameSignatures.result.frameCount, 12);
  assert.equal(sidecarAccepted.frameSignatures.result.failedFrameCount, 0);
  const existingSidecarBytes = readFileSync(`${sidecarInput}.frame-signatures.bin`);
  await assert.rejects(
    attachFrameSignatureSidecar(root, sidecarInput, golden, successfulMetrics(sidecarInput)),
    /exist|EEXIST/i,
    "a new run must not overwrite an existing committed sidecar",
  );
  assert.deepEqual(readFileSync(`${sidecarInput}.frame-signatures.bin`), existingSidecarBytes);

  const missingSidecarInput = resolve(root, "missing-sidecar.mov");
  copyFileSync(input, missingSidecarInput);
  writeMetrics(missingSidecarInput, successfulMetrics(missingSidecarInput));
  const missingSidecar = await validateFinalMov(options(root, missingSidecarInput, "missing-sidecar.validation", sidecarManifest));
  assert.equal(missingSidecar.ok, false);
  assert.ok(missingSidecar.errors.some((error) => error.includes("capture frame-signature coverage") || error.includes("full video oracle")));

  const tamperedSidecarInput = resolve(root, "tampered-sidecar.mov");
  copyFileSync(input, tamperedSidecarInput);
  const tamperedSidecarMetrics = successfulMetrics(tamperedSidecarInput);
  const tamperedSidecarPath = await attachFrameSignatureSidecar(root, tamperedSidecarInput, golden, tamperedSidecarMetrics);
  writeMetrics(tamperedSidecarInput, tamperedSidecarMetrics);
  const tamperedBytes = readFileSync(tamperedSidecarPath);
  tamperedBytes[Math.floor(tamperedBytes.length / 2)] ^= 0xff;
  writeFileSync(tamperedSidecarPath, tamperedBytes);
  const tamperedSidecar = await validateFinalMov(options(root, tamperedSidecarInput, "tampered-sidecar.validation", sidecarManifest));
  assert.equal(tamperedSidecar.ok, false);
  assert.ok(tamperedSidecar.errors.some((error) => error.includes("frame signature")));

  const incompleteSidecarIdentityInput = resolve(root, "incomplete-sidecar-identity.mov");
  copyFileSync(input, incompleteSidecarIdentityInput);
  const incompleteSidecarIdentityMetrics = successfulMetrics(incompleteSidecarIdentityInput);
  await attachFrameSignatureSidecar(root, incompleteSidecarIdentityInput, golden, incompleteSidecarIdentityMetrics);
  delete incompleteSidecarIdentityMetrics.renderIdentity.canonicalMediaRoute;
  delete incompleteSidecarIdentityMetrics.screenshotSequence.frameSignatureSidecar.header;
  writeMetrics(incompleteSidecarIdentityInput, incompleteSidecarIdentityMetrics);
  const incompleteSidecarIdentity = await validateFinalMov(options(
    root, incompleteSidecarIdentityInput, "incomplete-sidecar-identity.validation", sidecarManifest,
  ));
  assert.equal(incompleteSidecarIdentity.ok, false);
  assert.ok(incompleteSidecarIdentity.errors.some((error) => error.includes("frame signature metrics header")));
  assert.ok(incompleteSidecarIdentity.errors.some((error) => error.includes("render identity fields")));

  const shortSidecarInput = resolve(root, "short-sidecar.mov");
  copyFileSync(input, shortSidecarInput);
  const shortSidecarMetrics = successfulMetrics(shortSidecarInput);
  const shortSidecarPath = await attachFrameSignatureSidecar(root, shortSidecarInput, golden, shortSidecarMetrics);
  writeMetrics(shortSidecarInput, shortSidecarMetrics);
  const completeSidecarBytes = readFileSync(shortSidecarPath);
  writeFileSync(shortSidecarPath, completeSidecarBytes.subarray(0, completeSidecarBytes.length - 1_732));
  const shortSidecarResult = await validateFinalMov(options(root, shortSidecarInput, "short-sidecar-record.validation", sidecarManifest));
  assert.equal(shortSidecarResult.ok, false);
  assert.ok(shortSidecarResult.errors.some((error) => error.includes("frame signature")));

  const missingGolden = await validateFinalMov(options(root, input, "missing-golden.validation", null));
  assert.equal(missingGolden.ok, false);
  assert.ok(missingGolden.errors.some((error) => error.includes("golden manifest supplied")));
  assert.equal(missingGolden.screenshots.frames.length, 3, "actual evidence must still be extracted");

  const leaky = successfulMetrics(input);
  leaky.screenshotSequence.mediaGate.finalActiveLeases = 1;
  writeMetrics(input, leaky);
  const leaked = await validateFinalMov(options(root, input, "lease-leak.validation", goldenManifest));
  assert.equal(leaked.ok, false);
  assert.ok(leaked.errors.some((error) => error.includes("active leases after render")));

  writeMetrics(input, successfulMetrics(input));
  const shortAudio = resolve(root, "short-audio.mov");
  await makeFixture(shortAudio, { audioSamples: 9_599 });
  writeMetrics(shortAudio, successfulMetrics(shortAudio));
  const badAudio = await validateFinalMov(options(root, shortAudio, "short-audio.validation", goldenManifest));
  assert.equal(badAudio.ok, false);
  assert.equal(badAudio.audioTimeline.samplesPerChannel, 9_599);
  assert.ok(badAudio.errors.some((error) => error.includes("decoded audio samples/channel")));

  const wrongAudioContent = resolve(root, "wrong-audio-content.mov");
  await makeFixture(wrongAudioContent, { audioFrequency: 440 });
  writeMetrics(wrongAudioContent, successfulMetrics(wrongAudioContent));
  const wrongAudioContentResult = await validateFinalMov(options(root, wrongAudioContent, "wrong-audio-content.validation", goldenManifest));
  assert.equal(wrongAudioContentResult.ok, false);
  assert.ok(wrongAudioContentResult.errors.some((error) => error.includes("final full PCM content")),
    "same-length 440 Hz replacement must fail full-sample audio identity");

  const wrongThirdFrame = resolve(root, "wrong-third-frame.mov");
  await makeFixture(wrongThirdFrame, { redFrame: 2 });
  const wrongThirdFrameMetrics = successfulMetrics(wrongThirdFrame);
  await attachFrameSignatureSidecar(root, wrongThirdFrame, golden, wrongThirdFrameMetrics);
  writeMetrics(wrongThirdFrame, wrongThirdFrameMetrics);
  const wrongThirdFrameResult = await validateFinalMov(options(root, wrongThirdFrame, "wrong-third-frame.validation", sidecarManifest));
  assert.equal(wrongThirdFrameResult.ok, false);
  assert.ok(wrongThirdFrameResult.errors.some((error) => error.includes("capture-signature every-frame content")),
    "red replacement at decoded frame 3 must fail the renderer capture signature gate");
  assert.ok(wrongThirdFrameResult.frameSignatures.result.failureSamples.some((entry) => entry.frame === 2));

  const wrongLocalPatch = resolve(root, "wrong-local-patch.mov");
  await makeFixture(wrongLocalPatch, { localPatchFrame: 7 });
  const wrongLocalPatchMetrics = successfulMetrics(wrongLocalPatch);
  await attachFrameSignatureSidecar(root, wrongLocalPatch, golden, wrongLocalPatchMetrics);
  writeMetrics(wrongLocalPatch, wrongLocalPatchMetrics);
  const wrongLocalPatchResult = await validateFinalMov(options(root, wrongLocalPatch, "wrong-local-patch.validation", sidecarManifest));
  assert.equal(wrongLocalPatchResult.ok, false);
  assert.ok(wrongLocalPatchResult.errors.some((error) => error.includes("capture-signature every-frame content")));
  assert.ok(wrongLocalPatchResult.frameSignatures.result.failureSamples.some((entry) => entry.frame === 7));

  const missingWatchdogMetrics = successfulMetrics(input);
  delete missingWatchdogMetrics.memoryWatchdog;
  writeMetrics(input, missingWatchdogMetrics);
  const missingWatchdog = await validateFinalMov(options(root, input, "missing-watchdog.validation", goldenManifest));
  assert.equal(missingWatchdog.ok, false);
  assert.ok(missingWatchdog.errors.some((error) => error.includes("memory watchdog")));

  const executorOutput = resolve(root, "executor-final.mov");
  const segmentOutput = resolve(root, "executor-segment.mov");
  copyFileSync(input, executorOutput);
  copyFileSync(input, segmentOutput);
  writeMetrics(segmentOutput, successfulMetrics(segmentOutput));
  writeFileSync(`${executorOutput}.metrics.json`, `${JSON.stringify({
    kind: "hyperframes-segment-executor-completion",
    schemaVersion: 1,
    createdAt: new Date().toISOString(),
    failure: null,
    projectIdentityVerification: { projectIdentity: PROJECT_IDENTITY },
    finalOutput: executorOutput,
    finalSizeBytes: statSync(executorOutput).size,
    finalObserved: {
      file: executorOutput,
      video: { frameCount: 12 },
      audio: { sampleCount: 9_600 },
    },
    segments: [{
      segmentId: "full",
      backend: "screenshot",
      startFrame: 0,
      frameCount: 12,
      outputPath: segmentOutput,
      metricsPath: `${segmentOutput}.metrics.json`,
      observed: { file: segmentOutput },
    }],
    outputCommit: { committed: true, atomicRename: true },
  }, null, 2)}\n`);
  const executorAccepted = await validateFinalMov(options(root, executorOutput, "executor.validation", goldenManifest));
  assert.equal(executorAccepted.ok, true, executorAccepted.errors.join("\n"));
  assert.equal(executorAccepted.completionMetrics.flavor, "segment-executor");

  const executorMetricsPath = `${executorOutput}.metrics.json`;
  const validExecutorMetrics = JSON.parse(readFileSync(executorMetricsPath, "utf8"));
  const missingExecutorIdentity = structuredClone(validExecutorMetrics);
  delete missingExecutorIdentity.projectIdentityVerification;
  writeFileSync(executorMetricsPath, `${JSON.stringify(missingExecutorIdentity, null, 2)}\n`);
  const missingExecutorIdentityResult = await validateFinalMov(options(root, executorOutput, "executor-missing-identity.validation", goldenManifest));
  assert.equal(missingExecutorIdentityResult.ok, false);
  assert.ok(missingExecutorIdentityResult.errors.some((error) => error.includes("executor canonical project identity")));

  const malformedExecutorIdentity = structuredClone(validExecutorMetrics);
  malformedExecutorIdentity.projectIdentityVerification.projectIdentity = "fixture-render-project";
  writeFileSync(executorMetricsPath, `${JSON.stringify(malformedExecutorIdentity, null, 2)}\n`);
  const malformedExecutorIdentityResult = await validateFinalMov(options(root, executorOutput, "executor-malformed-identity.validation", goldenManifest));
  assert.equal(malformedExecutorIdentityResult.ok, false);
  assert.ok(malformedExecutorIdentityResult.errors.some((error) => error.includes("executor canonical project identity")));

  const swappedSegmentMetricsOutput = resolve(root, "swapped-segment-owner.mov");
  copyFileSync(input, swappedSegmentMetricsOutput);
  writeMetrics(swappedSegmentMetricsOutput, successfulMetrics(swappedSegmentMetricsOutput));
  const swappedExecutorMetrics = structuredClone(validExecutorMetrics);
  swappedExecutorMetrics.segments[0].metricsPath = `${swappedSegmentMetricsOutput}.metrics.json`;
  writeFileSync(executorMetricsPath, `${JSON.stringify(swappedExecutorMetrics, null, 2)}\n`);
  const swappedSegmentMetrics = await validateFinalMov(options(root, executorOutput, "executor-swapped-segment-metrics.validation", goldenManifest));
  assert.equal(swappedSegmentMetrics.ok, false);
  assert.ok(swappedSegmentMetrics.errors.some((error) => error.includes("adjacent metrics path") || error.includes("metrics output path")));

  writeFileSync(executorMetricsPath, `${JSON.stringify(validExecutorMetrics, null, 2)}\n`);

  const productionMetrics = successfulProductionMetrics(input);
  writeMetrics(input, productionMetrics);
  const productionAccepted = await validateFinalMov(options(root, input, "production-accepted.validation", goldenManifest));
  assert.equal(productionAccepted.ok, true, productionAccepted.errors.join("\n"));

  const erasedRendererProductionContainer = structuredClone(productionMetrics);
  delete erasedRendererProductionContainer.renderer.support.productionDecoder;
  writeMetrics(input, erasedRendererProductionContainer);
  const erasedRendererProductionResult = await validateFinalMov(options(root, input, "production-erased-renderer-container.validation", goldenManifest));
  assert.equal(erasedRendererProductionResult.ok, false);
  assert.ok(erasedRendererProductionResult.errors.some((error) => error.includes("renderer production-decoder evidence")));

  const erasedMainProductionContainer = structuredClone(productionMetrics);
  delete erasedMainProductionContainer.productionDecoder;
  writeMetrics(input, erasedMainProductionContainer);
  const erasedMainProductionResult = await validateFinalMov(options(root, input, "production-erased-main-container.validation", goldenManifest));
  assert.equal(erasedMainProductionResult.ok, false);
  assert.ok(erasedMainProductionResult.errors.some((error) => error.includes("main production-decoder evidence")));

  const malformedProductionShape = structuredClone(productionMetrics);
  malformedProductionShape.renderer.support.productionDecoder.final.beforeDispose.directSources = "1";
  malformedProductionShape.renderer.support.productionDecoder.final.beforeDispose.sourceMetrics = [];
  malformedProductionShape.renderer.support.productionDecoder.final.beforeDispose.laneMetrics = [];
  writeMetrics(input, malformedProductionShape);
  const malformedProductionShapeResult = await validateFinalMov(options(root, input, "production-malformed-shape.validation", goldenManifest));
  assert.equal(malformedProductionShapeResult.ok, false);
  assert.ok(malformedProductionShapeResult.errors.some((error) => error.includes("direct sources")));
  assert.ok(malformedProductionShapeResult.errors.some((error) => error.includes("source protocol evidence")));
  assert.ok(malformedProductionShapeResult.errors.some((error) => error.includes("lane protocol evidence")));

  const asynchronousLastFrameError = structuredClone(productionMetrics);
  asynchronousLastFrameError.renderer.support.productionDecoder.final.beforeDispose.laneMetrics[0].unexpectedOutputs = 1;
  writeMetrics(input, asynchronousLastFrameError);
  const asynchronousLastFrameRejected = await validateFinalMov(options(root, input, "production-async-last-frame-error.validation", goldenManifest));
  assert.equal(asynchronousLastFrameRejected.ok, false);
  assert.ok(asynchronousLastFrameRejected.errors.some((error) => error.includes("unexpected outputs")));

  const missingProtocolCounter = structuredClone(productionMetrics);
  delete missingProtocolCounter.renderer.support.productionDecoder.final.beforeDispose.laneMetrics[0].duplicateOutputs;
  writeMetrics(input, missingProtocolCounter);
  const missingProtocolCounterRejected = await validateFinalMov(options(root, input, "production-missing-counter.validation", goldenManifest));
  assert.equal(missingProtocolCounterRejected.ok, false);
  assert.ok(missingProtocolCounterRejected.errors.some((error) => error.includes("duplicate outputs")));

  const malformedProtocolCounters = structuredClone(productionMetrics);
  delete malformedProtocolCounters.renderer.support.productionDecoder.final.beforeDispose.acquireFailures;
  malformedProtocolCounters.renderer.support.productionDecoder.final.beforeDispose.cacheRequiredSources = 1;
  malformedProtocolCounters.renderer.support.productionDecoder.final.beforeDispose.sourceMetrics[0].validationFailures = 1;
  writeMetrics(input, malformedProtocolCounters);
  const malformedProtocolCountersRejected = await validateFinalMov(options(root, input, "production-malformed-counters.validation", goldenManifest));
  assert.equal(malformedProtocolCountersRejected.ok, false);
  assert.ok(malformedProtocolCountersRejected.errors.some((error) => error.includes("acquire failures")));
  assert.ok(malformedProtocolCountersRejected.errors.some((error) => error.includes("cache-required sources")));
  assert.ok(malformedProtocolCountersRejected.errors.some((error) => error.includes("validation failures")));

  const swappedDirectMetrics = successfulMetrics(golden);
  writeMetrics(input, swappedDirectMetrics);
  const swappedDirectRejected = await validateFinalMov(options(root, input, "direct-swapped-metrics.validation", goldenManifest));
  assert.equal(swappedDirectRejected.ok, false);
  assert.ok(swappedDirectRejected.errors.some((error) => error.includes("metrics output path")));

  writeMetrics(input, successfulMetrics(input));
  const selfManifest = await writeGoldenManifest(root, "self-golden.json", [{
    id: "forbidden-self",
    path: input,
    globalStartFrame: 0,
    frameCount: 12,
  }], { fullVideoOracle: golden, fullAudioOracle });
  const selfGolden = await validateFinalMov(options(root, input, "self-golden.validation", selfManifest));
  assert.equal(selfGolden.ok, false);
  assert.ok(selfGolden.errors.some((error) => error.includes("self-golden") || error.includes("not final movie path")));

  process.stdout.write(`${JSON.stringify({
    ok: true,
    accepted: accepted.ok,
    exactFrames: accepted.videoTimeline.frameCount,
    exactSamplesPerChannel: accepted.audioTimeline.samplesPerChannel,
    captureSidecarAccepted: sidecarAccepted.ok,
    missingSidecarRejected: !missingSidecar.ok,
    tamperedSidecarRejected: !tamperedSidecar.ok,
    incompleteSidecarIdentityRejected: !incompleteSidecarIdentity.ok,
    shortSidecarRejected: !shortSidecarResult.ok,
    missingGoldenRejected: !missingGolden.ok,
    leaseLeakRejected: !leaked.ok,
    shortAudioRejected: !badAudio.ok,
    wrongAudioContentRejected: !wrongAudioContentResult.ok,
    wrongThirdFrameRejected: !wrongThirdFrameResult.ok,
    wrongLocalPatchRejected: !wrongLocalPatchResult.ok,
    wrongLocalPatchSignature: wrongLocalPatchResult.frameSignatures.result.failureSamples.find((entry) => entry.frame === 7),
    wrongRedFrameSignature: wrongThirdFrameResult.frameSignatures.result.failureSamples.find((entry) => entry.frame === 2),
    missingWatchdogRejected: !missingWatchdog.ok,
    executorMetricsAccepted: executorAccepted.ok,
    executorMissingIdentityRejected: !missingExecutorIdentityResult.ok,
    executorMalformedIdentityRejected: !malformedExecutorIdentityResult.ok,
    swappedSegmentMetricsRejected: !swappedSegmentMetrics.ok,
    productionMetricsAccepted: productionAccepted.ok,
    erasedRendererProductionContainerRejected: !erasedRendererProductionResult.ok,
    erasedMainProductionContainerRejected: !erasedMainProductionResult.ok,
    malformedProductionShapeRejected: !malformedProductionShapeResult.ok,
    asynchronousLastFrameErrorRejected: !asynchronousLastFrameRejected.ok,
    missingProtocolCounterRejected: !missingProtocolCounterRejected.ok,
    malformedProtocolCountersRejected: !malformedProtocolCountersRejected.ok,
    swappedDirectMetricsRejected: !swappedDirectRejected.ok,
    selfGoldenRejected: !selfGolden.ok,
    atomicReportFiles: true,
  }, null, 2)}\n`);
} finally {
  rmSync(root, { recursive: true, force: true });
}
