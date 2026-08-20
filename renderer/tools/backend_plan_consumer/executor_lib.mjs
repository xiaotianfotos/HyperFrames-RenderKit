import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  copyFileSync,
  createWriteStream,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, isAbsolute, relative, resolve } from "node:path";
import {
  evaluateMovStreamCopyConcat,
  validateObservedMovContract,
  verifyExecutionSegmentPlan,
} from "./lib.mjs";
import { verifyWholeProjectIdentityManifest } from "../frame_backend_preflight/project_identity.mjs";
import { canonicalJson } from "../frame_backend_preflight/lib.mjs";
import {
  materializeProjectSnapshot,
  redirectContextToProjectSnapshot,
  verifyExecutionInputs,
  verifyExecutionInputsDescriptor,
} from "./execution_inputs.mjs";
import { parseFrameSignatureSidecar } from "../frame_signature_sidecar.mjs";

const RESERVED_RENDER_ARGS = new Set([
  "projectRoot", "entry", "output", "width", "height", "fps", "frames", "start", "startFrame",
  "compositeMode", "outputBackend", "mediaDecoderBackend", "mediaFrameMode", "mediaTargetMode",
  "mediaAdvanceMode", "mediaSeekBiasFrames", "mediaTimingPlan", "mediaSourceMap", "directMux",
  "canonicalMediaRoute", "canonicalMediaRouteVerify",
  "audioCodec", "audioSampleRate", "audioReference", "mixProjectAudio", "screenshotMediaPolicy",
  "mediaDecoderRouteDecision", "ffmpegPath", "ffprobePath", "runtimeTempDir", "spawnEnvironmentSha256",
]);

const ALLOWED_COMMON_RENDER_ARGS = new Set([
  "bitrate", "bitrateMode", "waitMode", "paintTimeoutMs", "seekTimeoutMs", "mediaTailPolicy",
  "mediaPlaybackRate", "mediaOvershootToleranceFrames", "mediaDecoderLanesTotal",
  "mediaDecoderLanesPerSource", "mediaDecoderIdleFrames", "mediaTimingPlanVerify",
  "mediaSourceMapVerify", "screenshotWindowMode", "screenshotEncoder", "screenshotCaptureTimeoutMs",
  "screenshotFrameMaxBytes", "gpuRasterBudgetMb", "vaapiDevice", "queueLimit", "queueLowWatermark",
  "queueBackpressureMode", "payloadWriteWindow", "payloadWriteLowWatermark", "payloadStallTimeoutMs",
  "muxFinalizeTimeoutMs", "memoryWatchdog", "memoryWatchdogIntervalMs", "memoryWatchdogMaxRssBytes",
  "memoryWatchdogMinAvailableBytes", "memoryWatchdogConsecutiveBreaches", "frameMetricsMode",
  "frameMetricsHead", "frameMetricsTail", "frameMetricsSampleEvery", "frameMetricsMaxFrames",
  "frameMetricsMaxBytes", "frameMetricsSlowMs", "productionDecoderBatchPackets",
  "productionDecoderBatchBytes", "productionDecoderGlobalDemuxBytes", "productionDecoderOpenCursors",
  "productionDecoderDecodeQueueMax", "productionDecoderDecodeLeadMax", "productionDecoderReadyFramesMax",
  "productionDecoderWarmAdvanceFrames", "videoSurfaceBudgetBytes", "payloadWriteBudgetBytes",
  "allowUnsafeResourceOverride", "diagnostics", "trace", "showWindow", "partialOpacityPolicy",
  "screenshotOptimizeForSpeed",
]);

function parseRatio(value, name) {
  if (value && typeof value === "object") {
    const numerator = Number(value.numerator);
    const denominator = Number(value.denominator);
    if (Number.isSafeInteger(numerator) && numerator > 0
      && Number.isSafeInteger(denominator) && denominator > 0) return { numerator, denominator };
  }
  const [rawNumerator, rawDenominator = "1"] = String(value ?? "").split("/");
  const numerator = Number(rawNumerator);
  const denominator = Number(rawDenominator);
  if (!Number.isSafeInteger(numerator) || numerator <= 0
    || !Number.isSafeInteger(denominator) || denominator <= 0) {
    throw new Error(`${name} is not a positive rational`);
  }
  return { numerator, denominator };
}

function finiteInteger(value, name, { minimum = 0 } = {}) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum) throw new Error(`${name} must be an integer >= ${minimum}`);
  return parsed;
}

function stringifyArg(value) {
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "number" && !Number.isFinite(value)) throw new Error("render argument numbers must be finite");
  if (value == null || typeof value === "object") throw new Error("render argument values must be scalar");
  return String(value);
}

export function normalizeRenderContext(raw = {}) {
  const required = (key) => {
    if (typeof raw[key] !== "string" || raw[key].length === 0) throw new Error(`renderContext.${key} is required`);
    return resolve(raw[key]);
  };
  const commonRenderArgs = raw.commonRenderArgs ?? {};
  if (!commonRenderArgs || typeof commonRenderArgs !== "object" || Array.isArray(commonRenderArgs)) {
    throw new Error("renderContext.commonRenderArgs must be an object");
  }
  for (const key of Object.keys(commonRenderArgs)) {
    if (RESERVED_RENDER_ARGS.has(key) || !ALLOWED_COMMON_RENDER_ARGS.has(key)) {
      throw new Error(`renderContext.commonRenderArgs cannot set ${key}`);
    }
    stringifyArg(commonRenderArgs[key]);
  }
  if (raw.audioReference && raw.mixProjectAudio === true) {
    throw new Error("use either audioReference or mixProjectAudio, not both");
  }
  const environment = raw.environment ?? {};
  if (!environment || typeof environment !== "object" || Array.isArray(environment)) {
    throw new Error("renderContext.environment must be an object");
  }
  const executable = (value, name) => {
    if (typeof value !== "string" || value.length === 0) throw new Error(`renderContext.${name} is required`);
    return value.includes("/") ? resolve(value) : value;
  };
  return {
    runtimeCommand: executable(raw.runtimeCommand, "runtimeCommand"),
    runtimePrefixArgs: Array.isArray(raw.runtimePrefixArgs) ? raw.runtimePrefixArgs.map(String) : [],
    mainScript: required("mainScript"),
    projectRoot: required("projectRoot"),
    entry: required("entry"),
    mediaTimingPlan: required("mediaTimingPlan"),
    projectIdentityManifest: raw.projectIdentityManifest ? resolve(raw.projectIdentityManifest) : null,
    mediaSourceMap: raw.mediaSourceMap ? resolve(raw.mediaSourceMap) : null,
    canonicalMediaRoute: raw.canonicalMediaRoute ? resolve(raw.canonicalMediaRoute) : null,
    audioReference: raw.audioReference ? resolve(raw.audioReference) : null,
    mixProjectAudio: raw.audioReference ? false : raw.mixProjectAudio !== false,
    commonRenderArgs: { ...commonRenderArgs },
    environment: Object.fromEntries(Object.entries(environment).map(([key, value]) => [String(key), String(value)])),
    cwd: raw.cwd ? resolve(raw.cwd) : dirname(required("mainScript")),
    ffmpeg: raw.ffmpeg ? executable(raw.ffmpeg, "ffmpeg") : "ffmpeg",
    ffprobe: raw.ffprobe ? executable(raw.ffprobe, "ffprobe") : "ffprobe",
  };
}

async function verifyExecutionEnvelope(executionPlan, context) {
  const inputShape = verifyExecutionInputsDescriptor(executionPlan.executionInputs);
  if (!inputShape.valid) throw new Error(`signed execution inputs are required: ${inputShape.reason}`);
  if (!context.projectIdentityManifest) {
    throw new Error("execution requires renderContext.projectIdentityManifest");
  }
  let manifest;
  try {
    manifest = JSON.parse(readFileSync(context.projectIdentityManifest, "utf8"));
  } catch (error) {
    throw new Error(`project identity manifest is unreadable: ${error.message}`);
  }
  const verified = await verifyWholeProjectIdentityManifest({ manifest, projectRoot: context.projectRoot });
  if (!verified.valid) throw new Error(`project identity verification failed: ${verified.reason}`);
  if (verified.projectIdentity !== executionPlan.identities.projectIdentity) {
    throw new Error("project identity manifest does not match the signed execution plan");
  }
  if (executionPlan.executionInputs.projectIdentity !== verified.projectIdentity) {
    throw new Error("signed execution inputs do not match the verified project identity");
  }
  const inputsVerified = await verifyExecutionInputs({
    descriptor: executionPlan.executionInputs,
    renderContext: context,
    projectManifest: manifest,
    projectManifestVerification: verified,
  });
  if (!inputsVerified.valid) throw new Error(`execution input verification failed: ${inputsVerified.reason}`);
  return {
    manifest,
    verification: verified,
    report: {
      required: true,
      verified: true,
      manifest: context.projectIdentityManifest,
      projectIdentity: verified.projectIdentity,
      algorithm: verified.algorithm,
      fileCount: verified.fileCount,
      totalBytes: verified.totalBytes,
      executionInputsIdentity: executionPlan.executionInputs.inputsIdentity,
      executionInputsVerified: true,
    },
  };
}

function argRecordToFlags(record) {
  return Object.entries(record)
    .filter(([, value]) => value !== undefined && value !== null)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, value]) => `--${key}=${stringifyArg(value)}`);
}

export function buildSegmentRenderInvocation({ executionPlan, segment, renderContext, outputPath } = {}) {
  const planCheck = verifyExecutionSegmentPlan(executionPlan);
  if (!planCheck.valid) throw new Error(`invalid execution plan: ${planCheck.reason}`);
  const context = normalizeRenderContext(renderContext);
  if (!executionPlan.segments.some((candidate) => candidate.segmentId === segment?.segmentId)) {
    throw new Error("segment does not belong to the execution plan");
  }
  const fps = executionPlan.timeline.fps;
  if (fps.denominator !== 1) throw new Error("full-canvas-main currently accepts only integer fps");
  const common = {
    projectRoot: context.projectRoot,
    entry: context.entry,
    output: resolve(outputPath),
    width: segment.outputContract.video.width,
    height: segment.outputContract.video.height,
    fps: fps.numerator,
    frames: segment.frameCount,
    startFrame: segment.startFrame,
    directMux: true,
    mediaFrameMode: "video",
    mediaTargetMode: "timing-plan",
    mediaAdvanceMode: "playback-step",
    mediaSeekBiasFrames: 0,
    mediaTimingPlan: context.mediaTimingPlan,
    ffmpegPath: executionPlan.executionInputs.tools.ffmpeg.resolvedPath,
    ffprobePath: executionPlan.executionInputs.tools.ffprobe.resolvedPath,
    runtimeTempDir: `${resolve(outputPath)}.runtime`,
    spawnEnvironmentSha256: executionPlan.executionInputs.environmentContract.valuesSha256,
    audioCodec: "pcm_s24le",
    audioSampleRate: 48_000,
    mixProjectAudio: context.mixProjectAudio,
    ...(context.audioReference ? { audioReference: context.audioReference } : {}),
    ...context.commonRenderArgs,
  };
  const backend = segment.backend === "proxy-tree"
    ? {
      compositeMode: "proxy-tree",
      outputBackend: "webcodecs",
      mediaDecoderBackend: "production-webcodecs",
      ...(context.mediaSourceMap ? { mediaSourceMap: context.mediaSourceMap } : {}),
      mediaDecoderRouteDecision: `${resolve(outputPath)}.media-route.json`,
    }
    : segment.backend === "layered-exact"
      ? {
        compositeMode: "layered",
        outputBackend: "webcodecs",
        mediaDecoderBackend: "production-webcodecs",
        ...(context.mediaSourceMap ? { mediaSourceMap: context.mediaSourceMap } : {}),
        ...(context.canonicalMediaRoute ? {
          canonicalMediaRoute: context.canonicalMediaRoute,
          canonicalMediaRouteVerify: "sha256",
        } : {}),
        mediaDecoderRouteDecision: `${resolve(outputPath)}.media-route.json`,
      }
      : {
      compositeMode: "screenshot",
      // Capture the faithful Chromium composite, then submit the PNG through
      // the same WebCodecs encoder used by exact segments.  Keeping a single
      // H.264 encoder contract is what makes verified stream-copy concat safe.
      outputBackend: "webcodecs",
      mediaDecoderBackend: "html-video",
      screenshotMediaPolicy: segment.screenshotMediaPolicy,
      };
  return {
    command: context.runtimeCommand,
    args: [...context.runtimePrefixArgs, context.mainScript, ...argRecordToFlags({ ...common, ...backend })],
    cwd: context.cwd,
    env: { ...(executionPlan.executionInputs.environmentContract?.values ?? {}) },
    outputPath: resolve(outputPath),
    metricsPath: `${resolve(outputPath)}.metrics.json`,
    backend: segment.backend,
    segmentId: segment.segmentId,
  };
}

function appendTail(current, chunk, maximum = 16 * 1024) {
  const combined = current + chunk;
  return combined.length <= maximum ? combined : combined.slice(-maximum);
}

function requireSignedSpawnEnvironment(env) {
  if (!env || typeof env !== "object" || Array.isArray(env)) {
    throw new Error("a signed explicit spawn environment is required");
  }
  for (const [key, value] of Object.entries(env)) {
    if (typeof key !== "string" || !key || typeof value !== "string") {
      throw new Error("signed spawn environment keys and values must be non-empty strings");
    }
  }
  return { ...env };
}

function requireAbsoluteCommand(command, label) {
  if (typeof command !== "string" || !isAbsolute(command)) {
    throw new Error(`${label} must be the signed absolute executable path`);
  }
  return command;
}

export function runLoggedCommand({ command, args, cwd, env, stdoutLog, stderrLog }) {
  const executable = requireAbsoluteCommand(command, "runtime command");
  const spawnEnvironment = requireSignedSpawnEnvironment(env);
  return new Promise((resolveRun, rejectRun) => {
    mkdirSync(dirname(stdoutLog), { recursive: true });
    const stdoutStream = createWriteStream(stdoutLog, { flags: "wx" });
    const stderrStream = createWriteStream(stderrLog, { flags: "wx" });
    const child = spawn(executable, args, { cwd, env: spawnEnvironment, stdio: ["ignore", "pipe", "pipe"] });
    let stdoutTail = "";
    let stderrTail = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { stdoutTail = appendTail(stdoutTail, chunk); stdoutStream.write(chunk); });
    child.stderr.on("data", (chunk) => { stderrTail = appendTail(stderrTail, chunk); stderrStream.write(chunk); });
    child.once("error", (error) => {
      stdoutStream.end();
      stderrStream.end();
      rejectRun(error);
    });
    child.once("close", (code, signal) => {
      stdoutStream.end();
      stderrStream.end();
      const result = { command, args, code, signal, stdoutTail, stderrTail, stdoutLog, stderrLog };
      if (code === 0) resolveRun(result);
      else rejectRun(Object.assign(new Error(`${command} exited ${code ?? signal}: ${stderrTail}`), result));
    });
  });
}

function runCapture(command, args, { cwd, env } = {}) {
  const executable = requireAbsoluteCommand(command, "capture command");
  const spawnEnvironment = requireSignedSpawnEnvironment(env);
  return new Promise((resolveRun, rejectRun) => {
    const child = spawn(executable, args, { cwd, env: spawnEnvironment, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.once("error", rejectRun);
    child.once("close", (code, signal) => {
      if (code === 0) resolveRun({ stdout, stderr, code });
      else rejectRun(new Error(`${command} exited ${code ?? signal}: ${stderr.slice(-4_000)}`));
    });
  });
}

function firstStream(probe, type) {
  return probe?.streams?.find((stream) => stream.codec_type === type) ?? null;
}

function normalizeContainer(formatName) {
  const names = String(formatName ?? "").split(",");
  return names.includes("mov") ? "mov" : names[0] ?? null;
}

function sha256Text(value) {
  return `sha256:${createHash("sha256").update(String(value)).digest("hex")}`;
}

export async function probeSegmentMov({ file, segment, outputContract, ffprobe, env } = {}) {
  if (!existsSync(file) || statSync(file).size === 0) throw new Error(`segment MOV is missing or empty: ${file}`);
  const streamProbe = JSON.parse((await runCapture(ffprobe, [
    "-v", "error", "-count_frames", "-show_data",
    "-show_entries",
    "format=format_name:stream=index,codec_type,codec_name,codec_tag_string,pix_fmt,width,height,"
      + "r_frame_rate,avg_frame_rate,time_base,start_pts,duration_ts,nb_read_frames,sample_aspect_ratio,"
      + "color_range,color_space,color_transfer,color_primaries,chroma_location,field_order,extradata,"
      + "sample_fmt,bits_per_sample,bits_per_raw_sample,sample_rate,channels,channel_layout",
    "-of", "json", file,
  ], { env })).stdout);
  const firstVideoFrameProbe = JSON.parse((await runCapture(ffprobe, [
    "-v", "error", "-select_streams", "v:0", "-read_intervals", "%+#1",
    "-show_frames", "-show_entries", "frame=key_frame,pict_type", "-of", "json", file,
  ], { env })).stdout);
  const firstVideoPacketProbe = JSON.parse((await runCapture(ffprobe, [
    "-v", "error", "-select_streams", "v:0", "-read_intervals", "%+#1",
    "-show_packets", "-show_entries", "packet=flags", "-of", "json", file,
  ], { env })).stdout);
  const audioFrames = (await runCapture(ffprobe, [
    "-v", "error", "-select_streams", "a:0", "-show_frames",
    "-show_entries", "frame=nb_samples", "-of", "csv=p=0", file,
  ], { env })).stdout;
  const video = firstStream(streamProbe, "video");
  const audio = firstStream(streamProbe, "audio");
  const videoStreams = streamProbe.streams?.filter((stream) => stream.codec_type === "video") ?? [];
  const audioStreams = streamProbe.streams?.filter((stream) => stream.codec_type === "audio") ?? [];
  if (videoStreams.length !== 1 || audioStreams.length !== 1 || !video || !audio) {
    throw new Error("segment MOV must contain exactly one video and one audio stream");
  }
  const audioSampleCount = audioFrames.split(/\r?\n/).filter(Boolean).reduce((sum, line) => {
    const value = finiteInteger(line.split(",", 1)[0], "decoded audio frame samples", { minimum: 1 });
    return sum + value;
  }, 0);
  const firstFrame = firstVideoFrameProbe.frames?.[0] ?? null;
  const firstPacket = firstVideoPacketProbe.packets?.[0] ?? null;
  const independentStart = Number(firstFrame?.key_frame) === 1
    && firstFrame?.pict_type === "I"
    && String(firstPacket?.flags ?? "").includes("K");
  const videoTimeBase = parseRatio(video.time_base, "video.time_base");
  const audioTimeBase = parseRatio(audio.time_base ?? "1/48000", "audio.time_base");
  const audioStartPts = Number(audio.start_pts ?? 0);
  const startSample = Number.isSafeInteger(audioStartPts)
    ? audioStartPts * audioTimeBase.numerator * Number(audio.sample_rate) / audioTimeBase.denominator
    : NaN;
  return {
    segmentId: segment.segmentId,
    file: resolve(file),
    sizeBytes: statSync(file).size,
    container: normalizeContainer(streamProbe.format?.format_name),
    video: {
      codec: video.codec_name ?? null,
      codecTag: video.codec_tag_string ?? null,
      width: Number(video.width),
      height: Number(video.height),
      pixelFormat: video.pix_fmt ?? null,
      fps: parseRatio(video.avg_frame_rate, "video.avg_frame_rate"),
      nominalFps: parseRatio(video.r_frame_rate, "video.r_frame_rate"),
      timeBasePolicy: outputContract.video.timeBasePolicy,
      sampleAspectRatioPolicy: outputContract.video.sampleAspectRatioPolicy,
      timeBase: videoTimeBase,
      sampleAspectRatio: video.sample_aspect_ratio ?? null,
      colorRange: video.color_range ?? null,
      colorSpace: video.color_space ?? null,
      colorPrimaries: video.color_primaries ?? null,
      colorTransfer: video.color_transfer ?? null,
      chromaLocation: video.chroma_location ?? null,
      scan: video.field_order ?? null,
      closedGop: independentStart,
      startsWithIdr: independentStart,
      openGop: !independentStart,
      codecExtradataSha256: video.extradata ? sha256Text(video.extradata) : null,
      frameCount: Number(video.nb_read_frames),
      startTimeTicks: Number(video.start_pts),
      durationTicks: Number(video.duration_ts),
    },
    audio: {
      codec: audio.codec_name ?? null,
      codecTag: audio.codec_tag_string ?? null,
      sampleFormat: audio.sample_fmt ?? null,
      bitsPerRawSample: Number(audio.bits_per_raw_sample || audio.bits_per_sample),
      sampleRate: Number(audio.sample_rate),
      channels: Number(audio.channels),
      channelLayout: audio.channel_layout ?? null,
      timeBase: audioTimeBase,
      startSample,
      sampleCount: audioSampleCount,
    },
  };
}

function concatEscape(path) {
  return `'${resolve(path).replaceAll("'", "'\\''")}'`;
}

export function buildConcatInvocation({ ffmpeg, listPath, outputPath, cwd, env } = {}) {
  const executable = requireAbsoluteCommand(ffmpeg, "ffmpeg");
  const spawnEnvironment = requireSignedSpawnEnvironment(env);
  return {
    command: executable,
    args: [
      "-hide_banner", "-loglevel", "warning", "-nostdin", "-y",
      "-f", "concat", "-safe", "0", "-i", resolve(listPath),
      "-map", "0:v:0", "-map", "0:a:0", "-c", "copy", "-movflags", "+faststart",
      resolve(outputPath),
    ],
    cwd,
    env: spawnEnvironment,
  };
}

function invocationFlag(invocation, name) {
  const prefix = `--${name}=`;
  return invocation.args.find((item) => item.startsWith(prefix))?.slice(prefix.length) ?? null;
}

function validateCompletedFrameSignature(invocation, segment, metrics) {
  if (segment.backend !== "screenshot") return null;
  const evidence = metrics.screenshotSequence?.frameSignatureSidecar;
  if (!evidence || evidence.committed !== true) {
    throw new Error("screenshot renderer metrics do not prove committed frame-signature sidecar evidence");
  }
  const expectedPath = `${invocation.outputPath}.frame-signatures.bin`;
  if (resolve(evidence.path ?? "") !== resolve(expectedPath)) {
    throw new Error("screenshot frame-signature path does not match segment output");
  }
  if (typeof evidence.stagingPath !== "string" || existsSync(evidence.stagingPath)) {
    throw new Error("screenshot frame-signature staging evidence is missing or still present");
  }
  if (!existsSync(expectedPath)) throw new Error(`screenshot frame-signature sidecar is missing: ${expectedPath}`);
  const parsed = parseFrameSignatureSidecar(expectedPath);
  if (evidence.sizeBytes !== parsed.sizeBytes || evidence.sha256 !== parsed.sha256
      || evidence.sequenceSha256 !== parsed.sequenceSha256 || evidence.frames !== parsed.frames) {
    throw new Error("screenshot frame-signature metrics identity does not match the committed sidecar");
  }
  if (canonicalJson(evidence.header) !== canonicalJson(parsed.header)) {
    throw new Error("screenshot frame-signature metrics header does not match the committed sidecar");
  }
  const fps = Number(invocationFlag(invocation, "fps"));
  const expectedStartSeconds = segment.startFrame / fps;
  const source = parsed.header.source;
  if (parsed.frames !== segment.frameCount || source.frames !== segment.frameCount
      || source.startFrame !== segment.startFrame
      || !Number.isFinite(fps) || fps <= 0 || !Number.isFinite(source.fps) || Math.abs(source.fps - fps) > 1e-12
      || !Number.isFinite(source.startSeconds) || Math.abs(source.startSeconds - expectedStartSeconds) > 1e-12
      || source.width !== segment.outputContract.video.width
      || source.height !== segment.outputContract.video.height) {
    throw new Error("screenshot frame-signature header timeline/geometry does not match the segment");
  }
  const identityKeys = Object.keys(parsed.header.renderIdentity).sort();
  if (parsed.header.runId !== metrics.runId
      || Object.keys(metrics.renderIdentity ?? {}).sort().join(",") !== identityKeys.join(",")
      || identityKeys.some((key) => parsed.header.renderIdentity[key] !== metrics.renderIdentity[key])) {
    throw new Error("screenshot frame-signature run/render identity does not match renderer metrics");
  }
  return {
    kind: parsed.header.kind,
    schemaVersion: parsed.header.schemaVersion,
    path: expectedPath,
    sizeBytes: parsed.sizeBytes,
    sha256: parsed.sha256,
    sequenceSha256: parsed.sequenceSha256,
    frames: parsed.frames,
    header: parsed.header,
  };
}

function revalidateRenderedFrameSignatures(rendered) {
  for (const item of rendered) {
    if (item.segment.backend !== "screenshot") continue;
    const approved = item.frameSignatureSidecar;
    if (!approved || !existsSync(approved.path) || statSync(approved.path).size !== approved.sizeBytes) {
      throw new Error(`screenshot frame-signature sidecar disappeared before publication: ${item.segment.segmentId}`);
    }
    let observed;
    try {
      observed = parseFrameSignatureSidecar(approved.path);
    } catch (error) {
      throw new Error(`screenshot frame-signature sidecar changed before publication: ${item.segment.segmentId}: ${error.message}`);
    }
    if (observed.sha256 !== approved.sha256 || observed.sequenceSha256 !== approved.sequenceSha256
        || observed.frames !== approved.frames) {
      throw new Error(`screenshot frame-signature sidecar changed before publication: ${item.segment.segmentId}`);
    }
  }
}

function validateCompletedMetrics(invocation, segment, executionInputs) {
  if (!existsSync(invocation.outputPath) || statSync(invocation.outputPath).size === 0) {
    throw new Error(`renderer did not create ${invocation.outputPath}`);
  }
  if (!existsSync(invocation.metricsPath)) throw new Error(`renderer completion metrics are missing: ${invocation.metricsPath}`);
  const metrics = JSON.parse(readFileSync(invocation.metricsPath, "utf8"));
  if (metrics.failure) throw new Error(`renderer metrics report failure: ${metrics.failure}`);
  if (metrics.outputCommit?.committed !== true) throw new Error("renderer metrics do not prove atomic output commit");
  if (Number(metrics.config?.frames) !== segment.frameCount) throw new Error("renderer metrics frame count does not match segment");
  if (Number(metrics.config?.startFrame) !== segment.startFrame) throw new Error("renderer metrics startFrame does not match segment");
  const expectedProjectRoot = invocationFlag(invocation, "projectRoot");
  const expectedEntry = invocationFlag(invocation, "entry");
  const expectedTiming = invocationFlag(invocation, "mediaTimingPlan");
  const expectedFfmpeg = invocationFlag(invocation, "ffmpegPath");
  const expectedFfprobe = invocationFlag(invocation, "ffprobePath");
  const expectedRuntimeTemp = invocationFlag(invocation, "runtimeTempDir");
  const expectedSpawnEnvironmentSha256 = invocationFlag(invocation, "spawnEnvironmentSha256");
  if (resolve(metrics.config?.projectRoot ?? "") !== resolve(expectedProjectRoot ?? "")) {
    throw new Error("renderer metrics projectRoot does not match the snapshotted invocation");
  }
  if (resolve(metrics.config?.entry ?? "") !== resolve(expectedEntry ?? "")) {
    throw new Error("renderer metrics entry does not match the snapshotted invocation");
  }
  if (resolve(metrics.config?.mediaTimingPlanPath ?? "") !== resolve(expectedTiming ?? "")) {
    throw new Error("renderer metrics timing bundle does not match the snapshotted invocation");
  }
  if (resolve(expectedFfmpeg ?? "") !== resolve(executionInputs.tools.ffmpeg.resolvedPath)
      || resolve(expectedFfprobe ?? "") !== resolve(executionInputs.tools.ffprobe.resolvedPath)) {
    throw new Error("renderer invocation did not receive the signed ffmpeg/ffprobe paths");
  }
  const runtimeTempRelative = expectedRuntimeTemp
    ? relative(resolve(expectedProjectRoot), resolve(expectedRuntimeTemp))
    : "";
  if (!expectedRuntimeTemp || (!runtimeTempRelative.startsWith("..") && !isAbsolute(runtimeTempRelative))) {
    throw new Error("renderer runtime temp is missing or inside the read-only project snapshot");
  }
  if (expectedSpawnEnvironmentSha256 !== executionInputs.environmentContract.valuesSha256) {
    throw new Error("renderer invocation did not receive the signed spawn environment identity");
  }
  if (metrics.config?.spawnEnvironmentSha256
      && metrics.config.spawnEnvironmentSha256 !== expectedSpawnEnvironmentSha256) {
    throw new Error("renderer metrics spawn environment identity does not match the signed invocation");
  }
  if (metrics.config?.observedProcessEnvironmentSha256
      && metrics.config.observedProcessEnvironmentSha256 !== expectedSpawnEnvironmentSha256) {
    throw new Error("renderer observed a process environment different from the signed descriptor");
  }
  if (metrics.config?.ffmpegPath && resolve(metrics.config.ffmpegPath) !== resolve(expectedFfmpeg)) {
    throw new Error("renderer metrics ffmpeg path does not match the signed invocation");
  }
  if (metrics.config?.ffprobePath && resolve(metrics.config.ffprobePath) !== resolve(expectedFfprobe)) {
    throw new Error("renderer metrics ffprobe path does not match the signed invocation");
  }
  if (metrics.config?.runtimeTempDir && resolve(metrics.config.runtimeTempDir) !== resolve(expectedRuntimeTemp)) {
    throw new Error("renderer metrics runtime temp does not match the invocation");
  }
  const rendererIdentity = executionInputs.expectedRendererIdentity;
  if (metrics.renderIdentity?.entry !== rendererIdentity.entry) {
    throw new Error("renderer metrics entry identity does not match signed execution inputs");
  }
  if (metrics.renderIdentity?.timingBundle !== rendererIdentity.timingBundle) {
    throw new Error("renderer metrics timing identity does not match signed execution inputs");
  }
  if (rendererIdentity.assets != null && metrics.renderIdentity?.assets !== rendererIdentity.assets) {
    throw new Error("renderer metrics asset identity does not match signed execution inputs");
  }
  return { metrics, frameSignatureSidecar: validateCompletedFrameSignature(invocation, segment, metrics) };
}

function ensureFreshDirectory(path) {
  if (existsSync(path)) {
    if (!statSync(path).isDirectory() || readdirSync(path).length !== 0) {
      throw new Error(`run root must not exist or must be empty: ${path}`);
    }
  } else mkdirSync(path, { recursive: true });
}

function writeFailure(runRoot, error, state) {
  if (!existsSync(runRoot)) return;
  const path = resolve(runRoot, `failure-${Date.now()}-${randomUUID()}.json`);
  writeFileSync(path, `${JSON.stringify({
    kind: "hyperframes-segment-executor-failure",
    schemaVersion: 1,
    createdAt: new Date().toISOString(),
    error: error?.stack ?? String(error),
    state,
  }, null, 2)}\n`);
}

async function renderSegments({
  executionPlan,
  context,
  segmentRoot,
  commandRunner,
  probeAdapter,
  commandRecords,
  beforeSegment,
  afterSegment,
}) {
  mkdirSync(segmentRoot, { recursive: true });
  const rendered = [];
  for (const segment of executionPlan.segments) {
    const outputPath = resolve(segmentRoot, `${segment.segmentId}-${segment.backend}.mov`);
    const invocation = buildSegmentRenderInvocation({ executionPlan, segment, renderContext: context, outputPath });
    const stdoutLog = `${outputPath}.stdout.log`;
    const stderrLog = `${outputPath}.stderr.log`;
    if (existsSync(outputPath) || existsSync(invocation.metricsPath)) throw new Error(`segment output already exists: ${outputPath}`);
    const runtimeTempDir = invocationFlag(invocation, "runtimeTempDir");
    if (!runtimeTempDir || existsSync(runtimeTempDir)) throw new Error(`segment runtime temp must be fresh: ${runtimeTempDir}`);
    mkdirSync(runtimeTempDir, { recursive: false, mode: 0o700 });
    await beforeSegment(segment);
    const startedAt = Date.now();
    const result = await commandRunner({ ...invocation, stdoutLog, stderrLog });
    await afterSegment(segment);
    const completed = validateCompletedMetrics(invocation, segment, executionPlan.executionInputs);
    const { metrics, frameSignatureSidecar } = completed;
    const observed = await probeAdapter({
      file: outputPath,
      segment,
      outputContract: executionPlan.concat.outputContract,
      ffprobe: context.ffprobe,
      env: invocation.env,
    });
    rendered.push({ segment, outputPath, metricsPath: invocation.metricsPath, observed, frameSignatureSidecar });
    commandRecords.push({
      phase: "render-segment",
      segmentId: segment.segmentId,
      backend: segment.backend,
      command: invocation.command,
      args: invocation.args,
      startedAt: new Date(startedAt).toISOString(),
      completedAt: new Date().toISOString(),
      exitCode: result.code ?? 0,
      metricsRunId: metrics.runId ?? null,
    });
  }
  return rendered;
}

function dryRunReport({ executionPlan, context, runRoot, finalOutput, projectIdentityVerification }) {
  const invocations = executionPlan.segments.map((segment) => buildSegmentRenderInvocation({
    executionPlan,
    segment,
    renderContext: context,
    outputPath: resolve(runRoot, "segments", `${segment.segmentId}-${segment.backend}.mov`),
  })).map(({ env: _env, ...invocation }) => invocation);
  return {
    kind: "hyperframes-segment-executor-dry-run",
    schemaVersion: 1,
    executionPlanSignature: executionPlan.executionPlanSignature,
    projectIdentityVerification,
    inputSnapshot: {
      mode: "materialize-and-verify-before-render",
      sourceProjectRoot: context.projectRoot,
      destination: resolve(runRoot, "input-snapshot"),
      permissions: "manifest-files-0444-directories-0555",
      dryRunCreated: false,
    },
    runRoot,
    finalOutput,
    segmentInvocations: invocations,
    finalization: executionPlan.segments.length === 1
      ? { mode: "atomic-copy-after-probe" }
      : { mode: "ffmpeg-concat-stream-copy-after-observation-gate" },
  };
}

function bindSignedExecutablePaths(context, executionInputs) {
  return {
    ...context,
    runtimeCommand: executionInputs.tools.runtimeCommand.resolvedPath,
    ffmpeg: executionInputs.tools.ffmpeg.resolvedPath,
    ffprobe: executionInputs.tools.ffprobe.resolvedPath,
    spawnEnvironment: { ...executionInputs.environmentContract.values },
  };
}

export async function executeSegmentPlan({
  executionPlan,
  renderContext,
  runRoot: rawRunRoot,
  finalOutput: rawFinalOutput,
  dryRun = false,
  mismatchPolicy = "hard-fail",
  commandRunner = runLoggedCommand,
  probeAdapter = probeSegmentMov,
} = {}) {
  const planCheck = verifyExecutionSegmentPlan(executionPlan);
  if (!planCheck.valid) throw new Error(`invalid execution plan: ${planCheck.reason}`);
  const sourceContext = normalizeRenderContext(renderContext);
  const runRoot = resolve(rawRunRoot);
  const finalOutput = resolve(rawFinalOutput);
  const finalMetrics = `${finalOutput}.metrics.json`;
  const envelope = await verifyExecutionEnvelope(executionPlan, sourceContext);
  const projectIdentityVerification = envelope.report;
  if (dryRun) return dryRunReport({
    executionPlan,
    context: bindSignedExecutablePaths(sourceContext, executionPlan.executionInputs),
    runRoot,
    finalOutput,
    projectIdentityVerification,
  });
  if (existsSync(finalOutput) || existsSync(finalMetrics)) {
    throw new Error(`final output or metrics already exists: ${finalOutput}`);
  }
  ensureFreshDirectory(runRoot);
  mkdirSync(dirname(finalOutput), { recursive: true });
  const state = { phase: "snapshot", completedSegmentIds: [], commandRecords: [], inputSnapshot: null };
  let activePlan = executionPlan;
  let rendered;
  let concatDecision;
  try {
    const inputSnapshot = await materializeProjectSnapshot({
      manifest: envelope.manifest,
      sourceProjectRoot: sourceContext.projectRoot,
      snapshotRoot: resolve(runRoot, "input-snapshot"),
    });
    state.inputSnapshot = inputSnapshot;
    const snapshotVerificationContext = redirectContextToProjectSnapshot({
      context: sourceContext,
      descriptor: executionPlan.executionInputs,
      snapshotRoot: inputSnapshot.path,
    });
    const context = bindSignedExecutablePaths(snapshotVerificationContext, executionPlan.executionInputs);
    const verifyBoundInputs = async (phase, segmentId = null) => {
      // The materialization result proves only that the snapshot was correct at
      // creation time.  Re-hash every manifest file at every execution gate so
      // chmod/privileged writes to the otherwise read-only tree cannot survive
      // on a cached verification object.
      const snapshotProjectVerification = await verifyWholeProjectIdentityManifest({
        manifest: envelope.manifest,
        projectRoot: inputSnapshot.path,
      });
      if (!snapshotProjectVerification.valid) {
        throw new Error(
          `execution inputs changed during ${phase}${segmentId ? ` for ${segmentId}` : ""}: `
          + `snapshot-project:${snapshotProjectVerification.reason}`,
        );
      }
      if (snapshotProjectVerification.projectIdentity !== executionPlan.executionInputs.projectIdentity
          || snapshotProjectVerification.projectIdentity !== inputSnapshot.projectIdentity) {
        throw new Error(
          `execution inputs changed during ${phase}${segmentId ? ` for ${segmentId}` : ""}: `
          + "snapshot-project-identity-mismatch",
        );
      }
      const launchCheck = await verifyExecutionInputs({
        descriptor: executionPlan.executionInputs,
        renderContext: snapshotVerificationContext,
        projectManifest: envelope.manifest,
        projectManifestVerification: snapshotProjectVerification,
      });
      if (!launchCheck.valid) {
        throw new Error(`execution inputs changed during ${phase}${segmentId ? ` for ${segmentId}` : ""}: ${launchCheck.reason}`);
      }
      state.commandRecords.push({
        phase,
        segmentId,
        inputsIdentity: launchCheck.inputsIdentity,
        snapshotProjectIdentity: snapshotProjectVerification.projectIdentity,
        snapshotFileCount: snapshotProjectVerification.fileCount,
        snapshotTotalBytes: snapshotProjectVerification.totalBytes,
        verifiedAt: new Date().toISOString(),
      });
    };
    const verifyBeforeSegment = (segment) => verifyBoundInputs("verify-before-segment-execution-inputs", segment.segmentId);
    const verifyAfterSegment = (segment) => verifyBoundInputs("verify-after-segment-execution-inputs", segment.segmentId);
    state.phase = "render";
    rendered = await renderSegments({
      executionPlan: activePlan,
      context,
      segmentRoot: resolve(runRoot, "segments"),
      commandRunner,
      probeAdapter,
      commandRecords: state.commandRecords,
      beforeSegment: verifyBeforeSegment,
      afterSegment: verifyAfterSegment,
    });
    state.completedSegmentIds = rendered.map((item) => item.segment.segmentId);
    concatDecision = evaluateMovStreamCopyConcat({
      executionPlan: activePlan,
      observedSegments: rendered.map((item) => item.observed),
      mismatchPolicy,
    });
    if (concatDecision.action === "hard-fail") {
      throw new Error(`segment outputs are not stream-copy compatible: ${JSON.stringify(concatDecision.failures)}`);
    }
    if (concatDecision.action === "rerender-uniform-screenshot") {
      state.phase = "uniform-screenshot-fallback";
      activePlan = concatDecision.replacementExecutionPlan;
      rendered = await renderSegments({
        executionPlan: activePlan,
        context,
        segmentRoot: resolve(runRoot, "segments-fallback"),
        commandRunner,
        probeAdapter,
        commandRecords: state.commandRecords,
        beforeSegment: verifyBeforeSegment,
        afterSegment: verifyAfterSegment,
      });
      state.completedSegmentIds.push(...rendered.map((item) => `fallback:${item.segment.segmentId}`));
      concatDecision = evaluateMovStreamCopyConcat({
        executionPlan: activePlan,
        observedSegments: rendered.map((item) => item.observed),
        mismatchPolicy: "hard-fail",
      });
      if (!concatDecision.executable) throw new Error("uniform screenshot fallback violated the MOV contract");
    }

    state.phase = "finalize";
    const partialOutput = resolve(dirname(finalOutput), `.${basename(finalOutput)}.hf-partial-${randomUUID()}.mov`);
    const partialMetrics = resolve(dirname(finalOutput), `.${basename(finalMetrics)}.hf-partial-${randomUUID()}.json`);
    try {
      await verifyBoundInputs("verify-before-finalization-inputs");
      if (rendered.length === 1) {
        copyFileSync(rendered[0].outputPath, partialOutput);
      } else {
        const concatList = resolve(runRoot, "concat-list.txt");
        writeFileSync(concatList, `${rendered.map((item) => `file ${concatEscape(item.outputPath)}`).join("\n")}\n`, { flag: "wx" });
        const concatInvocation = buildConcatInvocation({
          ffmpeg: context.ffmpeg,
          listPath: concatList,
          outputPath: partialOutput,
          cwd: context.cwd,
          env: { ...context.spawnEnvironment },
        });
        await verifyBoundInputs("verify-before-concat-inputs");
        const startedAt = Date.now();
        const result = await commandRunner({
          ...concatInvocation,
          stdoutLog: resolve(runRoot, "concat.stdout.log"),
          stderrLog: resolve(runRoot, "concat.stderr.log"),
        });
        state.commandRecords.push({
          phase: "concat-stream-copy",
          command: concatInvocation.command,
          args: concatInvocation.args,
          startedAt: new Date(startedAt).toISOString(),
          completedAt: new Date().toISOString(),
          exitCode: result.code ?? 0,
        });
        await verifyBoundInputs("verify-after-concat-inputs");
      }
      const finalSegment = {
        segmentId: "final",
        frameCount: activePlan.timeline.frameCount,
      };
      const finalObserved = await probeAdapter({
        file: partialOutput,
        segment: finalSegment,
        outputContract: activePlan.concat.outputContract,
        ffprobe: context.ffprobe,
        env: { ...context.spawnEnvironment },
      });
      const finalFailures = validateObservedMovContract({
        segment: finalSegment,
        observed: finalObserved,
        outputContract: activePlan.concat.outputContract,
      });
      const reference = rendered[0].observed;
      if (finalObserved.video.codecExtradataSha256 !== reference.video.codecExtradataSha256) {
        finalFailures.push("final-codec-extradata-mismatch");
      }
      if (JSON.stringify(finalObserved.video.timeBase) !== JSON.stringify(reference.video.timeBase)) {
        finalFailures.push("final-video-timebase-mismatch");
      }
      if (finalFailures.length) throw new Error(`final MOV contract failed: ${finalFailures.join(", ")}`);
      await verifyBoundInputs("verify-before-atomic-publication-inputs");
      revalidateRenderedFrameSignatures(rendered);
      state.commandRecords.push({
        phase: "verify-before-atomic-publication-frame-signatures",
        segmentIds: rendered.filter((item) => item.frameSignatureSidecar).map((item) => item.segment.segmentId),
        verifiedAt: new Date().toISOString(),
      });
      // Validation must happen against the unpublished partial, but the durable
      // completion record must point at the name that survives atomic commit.
      const publishedObserved = { ...finalObserved, file: finalOutput };
      const completion = {
        kind: "hyperframes-segment-executor-completion",
        schemaVersion: 1,
        createdAt: new Date().toISOString(),
        executionPlanSignature: activePlan.executionPlanSignature,
        originalExecutionPlanSignature: executionPlan.executionPlanSignature,
        projectIdentityVerification,
        inputSnapshot,
        usedUniformScreenshotFallback: activePlan !== executionPlan,
        finalOutput,
        finalSizeBytes: statSync(partialOutput).size,
        finalObserved: publishedObserved,
        concatDecision,
        segments: rendered.map((item) => ({
          segmentId: item.segment.segmentId,
          backend: item.segment.backend,
          startFrame: item.segment.startFrame,
          frameCount: item.segment.frameCount,
          outputPath: item.outputPath,
          metricsPath: item.metricsPath,
          frameSignatureSidecar: item.frameSignatureSidecar,
          observed: item.observed,
        })),
        commands: state.commandRecords,
        failure: null,
        outputCommit: { committed: true, atomicRename: true },
      };
      writeFileSync(partialMetrics, `${JSON.stringify(completion, null, 2)}\n`, { flag: "wx" });
      renameSync(partialOutput, finalOutput);
      try {
        renameSync(partialMetrics, finalMetrics);
      } catch (error) {
        unlinkSync(finalOutput);
        throw error;
      }
      state.phase = "complete";
      return completion;
    } catch (error) {
      if (existsSync(partialOutput)) rmSync(partialOutput, { force: true });
      if (existsSync(partialMetrics)) rmSync(partialMetrics, { force: true });
      throw error;
    }
  } catch (error) {
    writeFailure(runRoot, error, state);
    throw error;
  }
}
