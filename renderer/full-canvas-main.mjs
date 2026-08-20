import { app, BrowserWindow, contentTracing, ipcMain, nativeImage } from "electron";
import {
  createWriteStream,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { basename, dirname, isAbsolute, relative, resolve } from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { performance } from "node:perf_hooks";
import { totalmem } from "node:os";
import { loadAndVerifyMediaSourceMap } from "./tools/media_source_map_lib.mjs";
import { loadAndVerifyMediaTimingBundle } from "./tools/media_timing_bundle_lib.mjs";
import {
  bindCanonicalMediaRouteToTimingEntries,
  loadAndVerifyCanonicalMediaRoute,
  mergeCanonicalMediaRouteMappings,
} from "./tools/canonical_media_route_lib.mjs";
import { transformProxyTreeHtml } from "./tools/proxy_tree_transformer.mjs";
import {
  createRenderMemoryWatchdogRecorder,
  deriveRenderMemoryWatchdogPolicy,
} from "./tools/render_memory_watchdog_lib.mjs";
import { deriveRenderResourceBudget } from "./tools/render_resource_budget_lib.mjs";
import { resolveRenderStart } from "./tools/render_start_lib.mjs";
import { transformScreenshotHtml } from "./tools/screenshot_entry_transformer.mjs";
import {
  FRAME_SIGNATURE_GRID_HEIGHT,
  FRAME_SIGNATURE_GRID_WIDTH,
  createFrameSignatureHeader,
  createFrameSignatureWriter,
  rgbSignatureFromResizedBgra,
} from "./tools/frame_signature_sidecar.mjs";
import {
  CACHE_DECISION as PRODUCTION_DECODER_CACHE_DECISION,
  createProductionDecoderMainBridge,
  createProductionDemuxBroker,
  validateDemuxConcurrencyBudget,
} from "./tools/production_decoder_runtime/main.mjs";
import {
  buildFullCanvasProductionDecoderPlan,
  preflightFullCanvasProductionDecoder,
} from "./tools/production_decoder_runtime/full_canvas_host.mjs";

const rendererRoot = dirname(fileURLToPath(import.meta.url));
const args = Object.fromEntries(process.argv.slice(2).filter((arg) => arg.startsWith("--")).map((arg) => {
  const split = arg.indexOf("=");
  return split === -1 ? [arg.slice(2), "true"] : [arg.slice(2, split), arg.slice(split + 1)];
}));
const domProbeSelectors = String(args.domProbeSelectors ?? "")
  .split("|")
  .map((selector) => selector.trim())
  .filter(Boolean);
const domProbeFrames = String(args.domProbeFrames ?? "")
  .split(",")
  .map((value) => value.trim())
  .filter(Boolean)
  .map(Number);
if (domProbeFrames.some((frame) => !Number.isInteger(frame) || frame < 0)) {
  throw new Error(`Invalid --domProbeFrames value: ${args.domProbeFrames}`);
}

const frames = Number(args.frames ?? 60);
const fps = Number(args.fps ?? 60);
const { start, startFrame } = resolveRenderStart(args, fps);
const width = Number(args.width ?? 3840);
const height = Number(args.height ?? 2160);
const bitrate = Number(args.bitrate ?? 40_000_000);
const resourceBudget = deriveRenderResourceBudget({
  width,
  height,
  fps,
  bitrate,
  totalMemoryBytes: totalmem(),
  surfaceBudgetBytes: args.videoSurfaceBudgetBytes,
  payloadBudgetBytes: args.payloadWriteBudgetBytes,
  encoderQueueLimit: args.queueLimit,
  encoderQueueLowWatermark: args.queueLowWatermark,
  payloadWriteWindow: args.payloadWriteWindow,
  payloadWriteLowWatermark: args.payloadWriteLowWatermark,
  allowUnsafeOverride: args.allowUnsafeResourceOverride === "true",
});
const queueLimit = resourceBudget.limits.encoderQueueLimit;
const memoryWatchdogPolicy = deriveRenderMemoryWatchdogPolicy({
  totalMemoryBytes: totalmem(),
  intervalMs: args.memoryWatchdogIntervalMs,
  maxAggregateRssBytes: args.memoryWatchdogMaxRssBytes,
  minAvailableBytes: args.memoryWatchdogMinAvailableBytes,
  consecutiveBreaches: args.memoryWatchdogConsecutiveBreaches,
});
const projectRoot = resolve(args.projectRoot ?? rendererRoot);
const entry = resolve(projectRoot, args.entry ?? "index.html");
const hyperframesRuntimeInput = args.hyperframesRuntime == null
  ? null
  : String(args.hyperframesRuntime);
if (hyperframesRuntimeInput && !isAbsolute(hyperframesRuntimeInput)) {
  throw new Error("--hyperframesRuntime must be an absolute path");
}
const hyperframesRuntimePath = hyperframesRuntimeInput
  ? resolve(hyperframesRuntimeInput)
  : null;
const hyperframesRuntimeTimeoutMs = Number(args.hyperframesRuntimeTimeoutMs ?? 30_000);
if (hyperframesRuntimePath && !existsSync(hyperframesRuntimePath)) {
  throw new Error(`HyperFrames runtime not found: ${hyperframesRuntimePath}`);
}
if (!Number.isFinite(hyperframesRuntimeTimeoutMs) || hyperframesRuntimeTimeoutMs <= 0) {
  throw new Error(`Invalid hyperframesRuntimeTimeoutMs: ${hyperframesRuntimeTimeoutMs}`);
}
const output = resolve(rendererRoot, args.output ?? "results/full-canvas.mov");
if (args.ffmpegPath && !isAbsolute(args.ffmpegPath)) throw new Error("--ffmpegPath must be absolute");
if (args.ffprobePath && !isAbsolute(args.ffprobePath)) throw new Error("--ffprobePath must be absolute");
const ffmpegPath = args.ffmpegPath ? resolve(args.ffmpegPath) : "ffmpeg";
const ffprobePath = args.ffprobePath ? resolve(args.ffprobePath) : "ffprobe";
const runtimeTempDir = args.runtimeTempDir ? resolve(args.runtimeTempDir) : null;
const normalizedProcessEnvironment = Object.fromEntries(
  Object.entries(process.env).map(([key, value]) => [key, String(value)]).sort(([left], [right]) => left.localeCompare(right)),
);
const processEnvironmentSha256 = `sha256:${createHash("sha256").update(JSON.stringify(normalizedProcessEnvironment)).digest("hex")}`;
if (args.spawnEnvironmentSha256 && args.spawnEnvironmentSha256 !== processEnvironmentSha256) {
  throw new Error(
    `Signed spawn environment mismatch: expected ${args.spawnEnvironmentSha256}, observed ${processEnvironmentSha256}`,
  );
}
const childProcessEnvironment = Object.freeze({ ...normalizedProcessEnvironment });
const runId = `${process.pid}-${randomUUID()}`;
const stagingOutput = resolve(
  dirname(output),
  `.${basename(output)}.hf-partial-${runId}.mov`,
);
const rawPath = output.replace(/\.[^.]+$/, ".h264");
const metricsPath = `${output}.metrics.json`;
const stagingMetricsPath = resolve(dirname(output), `.${basename(output)}.metrics.hf-partial-${runId}.json`);
const failedMetricsPath = `${output}.failed-${runId}.metrics.json`;
const frameSignaturePath = `${output}.frame-signatures.bin`;
const frameSignatureStagingPath = resolve(
  dirname(output),
  `.${basename(output)}.frame-signatures.hf-partial-${runId}.bin`,
);
const audioReference = args.audioReference ? resolve(args.audioReference) : null;
const audioCodec = args.audioCodec ?? "pcm_s24le";
const supportedAudioCodecs = new Set(["pcm_s16le", "pcm_s24le", "alac", "aac"]);
if (!supportedAudioCodecs.has(audioCodec)) {
  throw new Error(
    `Unsupported --audioCodec=${audioCodec}; expected one of ${[...supportedAudioCodecs].join(", ")}`,
  );
}
const allowAudioCodecPadding = args.allowAudioCodecPadding === "true";
if (audioCodec === "aac"
    && (audioReference || args.mixProjectAudio === "true")
    && !allowAudioCodecPadding) {
  throw new Error(
    "AAC encodes fixed 1024-sample blocks and cannot guarantee sample-exact decoded MOV audio. "
    + "Use the default pcm_s24le master, alac, or pass --allowAudioCodecPadding=true explicitly.",
  );
}
const directMux = args.directMux !== "false";
const requestedCompositeMode = args.compositeMode ?? "layered";
const outputBackend = args.outputBackend ?? (requestedCompositeMode === "screenshot" ? "screenshot" : "webcodecs");
const screenshotCaptureMode = requestedCompositeMode === "screenshot";
const screenshotWindowMode = args.screenshotWindowMode ?? "emulated";
const screenshotMediaPolicyRequested = args.screenshotMediaPolicy ?? "auto";
const screenshotEncoder = args.screenshotEncoder ?? (
  process.platform === "linux" ? "vaapi" : (process.platform === "darwin" ? "videotoolbox" : "libx264")
);
const screenshotCaptureTimeoutMs = Number(args.screenshotCaptureTimeoutMs ?? 15_000);
const screenshotOptimizeForSpeed = args.screenshotOptimizeForSpeed === "true";
const gpuRasterBudgetMb = Number(args.gpuRasterBudgetMb ?? Math.min(
  1024,
  Math.max(256, Math.floor(totalmem() / (1024 * 1024) * 0.05)),
));
const screenshotFrameMaxBytes = Number(
  args.screenshotFrameMaxBytes
  ?? (resourceBudget.estimates.rgbaBytes + 8 * 1024 * 1024),
);
const renderSessionPartition = `hf-render-${process.pid}-${randomUUID()}`;
const mediaSourceMapVerify = args.mediaSourceMapVerify ?? "stat";
const loadedMediaSourceMap = args.mediaSourceMap
  ? await loadAndVerifyMediaSourceMap({
    manifestPath: resolve(projectRoot, args.mediaSourceMap),
    projectRoot,
    verifyMode: mediaSourceMapVerify,
  })
  : null;
const canonicalMediaRouteVerify = args.canonicalMediaRouteVerify ?? "sha256";
const loadedCanonicalMediaRoute = args.canonicalMediaRoute
  ? await loadAndVerifyCanonicalMediaRoute({
    routePath: resolve(projectRoot, args.canonicalMediaRoute),
    projectRoot,
    entryPath: entry,
    verifyMode: canonicalMediaRouteVerify,
  })
  : null;
const decoderMappingRequirements = mergeCanonicalMediaRouteMappings({
  mediaSourceMapEntries: loadedMediaSourceMap?.entries ?? [],
  canonicalRouteEntries: loadedCanonicalMediaRoute?.entries ?? [],
}).map((mapped) => ({ source: mapped.source, cache: mapped.cache }));
if (loadedCanonicalMediaRoute && !args.mediaTimingPlan) {
  throw new Error("--canonicalMediaRoute requires --mediaTimingPlan=<project bundle>");
}
const mediaTimingPlanVerify = args.mediaTimingPlanVerify ?? "stat";
const loadedMediaTimingBundle = args.mediaTimingPlan
  ? await loadAndVerifyMediaTimingBundle({
    manifestPath: resolve(projectRoot, args.mediaTimingPlan),
    projectRoot,
    entryPath: entry,
    verifyMode: mediaTimingPlanVerify,
    requiredDecoderMappings: decoderMappingRequirements,
  })
  : null;
const boundCanonicalMediaRoute = loadedCanonicalMediaRoute
  ? bindCanonicalMediaRouteToTimingEntries({
    routeEntries: loadedCanonicalMediaRoute.entries,
    timingEntries: loadedMediaTimingBundle.entries,
  })
  : [];
const decoderSourceMappings = mergeCanonicalMediaRouteMappings({
  mediaSourceMapEntries: loadedMediaSourceMap?.entries ?? [],
  canonicalRouteEntries: boundCanonicalMediaRoute,
});
const mediaDecoderBackend = args.mediaDecoderBackend ?? "html-video";
const productionDecoderPlan = mediaDecoderBackend === "production-webcodecs"
  ? buildFullCanvasProductionDecoderPlan({
    timingEntries: loadedMediaTimingBundle?.entries ?? [],
    sourceMapEntries: decoderSourceMappings,
  })
  : null;
const productionDecoderRoutePath = mediaDecoderBackend === "production-webcodecs"
  ? resolve(args.mediaDecoderRouteDecision ?? `${output}.media-route.json`)
  : null;
const productionDecoderRouteStagingPath = productionDecoderRoutePath
  ? resolve(dirname(productionDecoderRoutePath), `.${basename(productionDecoderRoutePath)}.hf-partial-${runId}.json`)
  : null;
const entryIdentity = loadedMediaTimingBundle?.bundle?.project?.entryFingerprint?.sha256
  ?? createHash("sha256").update(readFileSync(entry)).digest("hex");
const assetsIdentity = createHash("sha256").update(JSON.stringify(
  (loadedMediaTimingBundle?.entries ?? []).map((entryRecord) => ({
    source: entryRecord.source,
    sourceIdentity: entryRecord.plan.source.identity,
    roles: entryRecord.roles,
    mapsFrom: entryRecord.mapsFrom,
  })).sort((left, right) => left.source.localeCompare(right.source)),
)).digest("hex");
const timingBundleIdentity = loadedMediaTimingBundle
  ? createHash("sha256").update(readFileSync(loadedMediaTimingBundle.path)).digest("hex")
  : createHash("sha256").update("no-media-timing-bundle").digest("hex");
const canonicalMediaRouteIdentity = loadedCanonicalMediaRoute?.route.integrity.payloadSha256
  ?? createHash("sha256").update("no-canonical-media-route").digest("hex");
const decoderMappingsIdentity = createHash("sha256").update(JSON.stringify(
  decoderSourceMappings.map((mapping) => ({
    source: mapping.source,
    cache: mapping.cache,
    recipeKey: mapping.recipeKey,
    frameRate: mapping.frameRate,
    canonical: mapping.canonical ?? null,
  })).sort((left, right) => left.source.localeCompare(right.source)),
)).digest("hex");
const renderIdentity = Object.freeze({
  project: createHash("sha256").update(JSON.stringify({
    entry: entryIdentity,
    assets: assetsIdentity,
    timingBundle: timingBundleIdentity,
    canonicalMediaRoute: canonicalMediaRouteIdentity,
    decoderMappings: decoderMappingsIdentity,
    hyperframesRuntime: hyperframesRuntimePath
      ? createHash("sha256").update(readFileSync(hyperframesRuntimePath)).digest("hex")
      : null,
  })).digest("hex"),
  entry: entryIdentity,
  assets: assetsIdentity,
  timingBundle: timingBundleIdentity,
  canonicalMediaRoute: canonicalMediaRouteIdentity,
  decoderMappings: decoderMappingsIdentity,
});
const config = {
  projectRoot,
  entry,
  ffmpegPath,
  ffprobePath,
  runtimeTempDir,
  hyperframesRuntimePath,
  hyperframesRuntimeTimeoutMs,
  hyperframesRuntimeEnabled: Boolean(hyperframesRuntimePath),
  spawnEnvironmentSha256: args.spawnEnvironmentSha256 ?? null,
  observedProcessEnvironmentSha256: processEnvironmentSha256,
  output,
  rawPath: directMux ? null : rawPath,
  width,
  height,
  fps,
  frames,
  start,
  startFrame,
  duration: frames / fps,
  bitrate,
  bitrateMode: args.bitrateMode ?? "variable",
  queueLimit,
  queueLowWatermark: resourceBudget.limits.encoderQueueLowWatermark,
  queueBackpressureMode: args.queueBackpressureMode ?? resourceBudget.limits.encoderBackpressureMode,
  payloadWriteWindow: resourceBudget.limits.payloadWriteWindow,
  payloadWriteLowWatermark: resourceBudget.limits.payloadWriteLowWatermark,
  maxPendingPayloadBytes: resourceBudget.limits.maxPendingPayloadBytes,
  pendingPayloadLowWatermarkBytes: Math.floor(resourceBudget.limits.maxPendingPayloadBytes / 2),
  resourceBudget,
  memoryWatchdogEnabled: args.memoryWatchdog !== "false",
  memoryWatchdogPolicy,
  payloadStallTimeoutMs: Number(args.payloadStallTimeoutMs ?? 30_000),
  muxFinalizeTimeoutMs: Number(args.muxFinalizeTimeoutMs ?? 15_000),
  waitMode: args.waitMode ?? "paint",
  paintTimeoutMs: Number(args.paintTimeoutMs ?? 100),
  seekTimeoutMs: Number(args.seekTimeoutMs ?? 5_000),
  compositeMode: requestedCompositeMode,
  outputBackend,
  screenshotWindowMode,
  screenshotMediaPolicyRequested,
  screenshotMediaPolicy: screenshotMediaPolicyRequested === "auto" ? "faithful" : screenshotMediaPolicyRequested,
  screenshotEncoder,
  screenshotFrameMaxBytes,
  screenshotCaptureTimeoutMs,
  screenshotOptimizeForSpeed,
  gpuRasterBudgetMb,
  screenshotMediaRequestGate: screenshotCaptureMode && screenshotMediaPolicyRequested === "bounded-static",
  vaapiDevice: args.vaapiDevice ?? "/dev/dri/renderD128",
  mediaFrameMode: args.mediaFrameMode ?? "video",
  mediaSeekBiasFrames: Number(args.mediaSeekBiasFrames ?? 0),
  mediaAdvanceMode: args.mediaAdvanceMode ?? "playback-step",
  // Keep arbitrary/VFR sources byte-for-byte compatible unless the caller
  // explicitly declares that source timestamps live on the output frame grid.
  mediaTargetMode: args.mediaTargetMode ?? "exact",
  mediaTailPolicy: args.mediaTailPolicy ?? "hold-last",
  mediaPlaybackRate: Number(args.mediaPlaybackRate ?? 0.5),
  mediaOvershootToleranceFrames: Number(args.mediaOvershootToleranceFrames ?? (1 / 3)),
  mediaDecoderLanesTotal: Number(args.mediaDecoderLanesTotal ?? 12),
  mediaDecoderLanesPerSource: Number(args.mediaDecoderLanesPerSource ?? 2),
  mediaDecoderIdleFrames: Number(args.mediaDecoderIdleFrames ?? 120),
  mediaDecoderBackend,
  productionDecoderRuntimeUrl: mediaDecoderBackend === "production-webcodecs"
    ? pathToFileURL(resolve(rendererRoot, "tools/production_decoder_runtime/browser.mjs")).href
    : null,
  productionDecoderSources: productionDecoderPlan?.rendererSources ?? [],
  productionDecoderRoutePath,
  productionDecoderLimits: mediaDecoderBackend === "production-webcodecs" ? {
    maximumBatchPackets: Number(args.productionDecoderBatchPackets ?? 8),
    maximumBatchBytes: Number(args.productionDecoderBatchBytes ?? (8 * 1024 * 1024)),
    maximumGlobalDemuxBytes: Number(args.productionDecoderGlobalDemuxBytes ?? Math.max(
      32 * 1024 * 1024,
      Number(args.mediaDecoderLanesTotal ?? 12)
        * Number(args.productionDecoderBatchBytes ?? (8 * 1024 * 1024)),
    )),
    maximumOpenCursors: Number(
      args.productionDecoderOpenCursors ?? Number(args.mediaDecoderLanesTotal ?? 12),
    ),
    decodeQueueMax: Number(args.productionDecoderDecodeQueueMax ?? 4),
    decodeLeadMax: Number(args.productionDecoderDecodeLeadMax ?? 8),
    readyFramesMax: Number(args.productionDecoderReadyFramesMax ?? 8),
    maxWarmAdvanceFrames: Number(args.productionDecoderWarmAdvanceFrames ?? 12),
  } : null,
  frameMetricsMode: args.frameMetricsMode ?? "bounded",
  frameMetricsHead: Number(args.frameMetricsHead ?? 8),
  frameMetricsTail: Number(args.frameMetricsTail ?? 8),
  frameMetricsSampleEvery: Number(args.frameMetricsSampleEvery ?? 600),
  frameMetricsMaxFrames: Number(args.frameMetricsMaxFrames ?? 160),
  frameMetricsMaxBytes: Number(args.frameMetricsMaxBytes ?? (2 * 1024 * 1024)),
  frameMetricsSlowMs: Number(args.frameMetricsSlowMs ?? 100),
  mediaSourceMapPath: loadedMediaSourceMap?.path ?? null,
  mediaSourceMapVerify: loadedMediaSourceMap?.verifyMode ?? null,
  mediaSourceMapRecipeKey: loadedMediaSourceMap?.recipe.key ?? null,
  mediaSourceMap: decoderSourceMappings,
  canonicalMediaRoutePath: loadedCanonicalMediaRoute?.path ?? null,
  canonicalMediaRouteVerify: loadedCanonicalMediaRoute?.verifyMode ?? null,
  canonicalMediaRouteIdentity: loadedCanonicalMediaRoute?.route.integrity.payloadSha256 ?? null,
  canonicalMediaRouteMappings: boundCanonicalMediaRoute,
  mediaTimingPlanPath: loadedMediaTimingBundle?.path ?? null,
  mediaTimingPlanVerify: loadedMediaTimingBundle?.verifyMode ?? null,
  mediaTimingPlans: loadedMediaTimingBundle?.entries.map((entryRecord) => ({
    source: entryRecord.source,
    sourceUrl: entryRecord.sourceUrl,
    roles: entryRecord.roles,
    mapsFrom: entryRecord.mapsFrom,
    plan: entryRecord.plan,
    compatibility: entryRecord.compatibility,
  })) ?? [],
  proxyTreeTransform: null,
  screenshotEntryTransform: null,
  partialOpacityPolicy: args.partialOpacityPolicy ?? "preserve",
  directMux,
  mixProjectAudio: args.mixProjectAudio === "true",
  audioCodec,
  allowAudioCodecPadding,
  audioBitrate: Number(args.audioBitrate ?? 192_000),
  audioSampleRate: Number(args.audioSampleRate ?? 48_000),
  audioReference,
  diagnostics: args.diagnostics === "true",
  domProbeSelectors,
  domProbeFrames,
  trace: args.trace === "true",
  showWindow: args.showWindow === "true",
};

if (!existsSync(entry)) throw new Error(`Composition entry not found: ${entry}`);
if (args.ffmpegPath && !existsSync(ffmpegPath)) throw new Error(`FFmpeg executable not found: ${ffmpegPath}`);
if (args.ffprobePath && !existsSync(ffprobePath)) throw new Error(`FFprobe executable not found: ${ffprobePath}`);
if (audioReference && !existsSync(audioReference)) throw new Error(`Audio reference not found: ${audioReference}`);
if (!Number.isFinite(frames) || frames <= 0 || !Number.isInteger(frames)) throw new Error(`Invalid frames: ${frames}`);
if (!Number.isFinite(fps) || fps <= 0) throw new Error(`Invalid fps: ${fps}`);
if (!Number.isFinite(start) || start < 0) throw new Error(`Invalid start: ${start}`);
if (!["layered", "native-tree", "proxy", "proxy-tree", "tree", "screenshot"].includes(config.compositeMode)) {
  throw new Error(`Invalid compositeMode: ${config.compositeMode}`);
}
if (!["preserve", "promote-dynamic"].includes(config.partialOpacityPolicy)) {
  throw new Error(`Invalid partialOpacityPolicy: ${config.partialOpacityPolicy}`);
}
if (!["webcodecs", "screenshot"].includes(config.outputBackend)) {
  throw new Error(`Invalid outputBackend: ${config.outputBackend}`);
}
if (!["html-video", "production-webcodecs"].includes(config.mediaDecoderBackend)) {
  throw new Error(`Invalid mediaDecoderBackend: ${config.mediaDecoderBackend}`);
}
if (loadedCanonicalMediaRoute) {
  if (config.mediaDecoderBackend !== "production-webcodecs"
      || config.outputBackend !== "webcodecs"
      || config.mediaTargetMode !== "timing-plan"
      || config.mediaFrameMode !== "video"
      || !["layered", "proxy-tree"].includes(config.compositeMode)) {
    throw new Error(
      "--canonicalMediaRoute requires production-webcodecs + webcodecs output + timing-plan + "
      + "video frames + layered/proxy-tree",
    );
  }
}
if (config.mediaDecoderBackend === "production-webcodecs") {
  if (config.outputBackend !== "webcodecs") {
    throw new Error("--mediaDecoderBackend=production-webcodecs requires --outputBackend=webcodecs");
  }
  if (!["layered", "proxy-tree"].includes(config.compositeMode)) {
    throw new Error(
      "--mediaDecoderBackend=production-webcodecs supports only layered or proxy-tree manual video draw",
    );
  }
  if (config.mediaTargetMode !== "timing-plan") {
    throw new Error("--mediaDecoderBackend=production-webcodecs requires --mediaTargetMode=timing-plan");
  }
  if (config.mediaFrameMode !== "video") {
    throw new Error("--mediaDecoderBackend=production-webcodecs requires --mediaFrameMode=video");
  }
  if (!productionDecoderPlan?.hostSources.length) {
    throw new Error("production-webcodecs has no verified selected decoder sources");
  }
  if (config.mediaDecoderLanesTotal > 32 || config.mediaDecoderLanesPerSource > 8) {
    throw new Error("production-webcodecs lane limits exceed the validated runtime hard limits (32 total, 8/source)");
  }
  config.productionDecoderLimits.demuxConcurrencyBudget = validateDemuxConcurrencyBudget({
    maxTotalLanes: config.mediaDecoderLanesTotal,
    maximumBatchBytes: config.productionDecoderLimits.maximumBatchBytes,
    maximumGlobalDemuxBytes: config.productionDecoderLimits.maximumGlobalDemuxBytes,
    maximumOpenCursors: config.productionDecoderLimits.maximumOpenCursors,
  });
}
if (config.compositeMode === "screenshot"
    && !new Set(["screenshot", "webcodecs"]).has(config.outputBackend)) {
  throw new Error("compositeMode=screenshot requires outputBackend=screenshot or webcodecs");
}
if (config.outputBackend === "screenshot" && config.compositeMode !== "screenshot") {
  throw new Error("outputBackend=screenshot requires compositeMode=screenshot; mixed composition contracts are forbidden");
}
if (config.outputBackend === "screenshot" && !directMux) {
  throw new Error("screenshot output backend requires --directMux=true");
}
if (!new Set(["emulated", "offscreen", "visible"]).has(config.screenshotWindowMode)) {
  throw new Error(`Invalid screenshotWindowMode: ${config.screenshotWindowMode}`);
}
if (!new Set(["auto", "bounded-static", "faithful"]).has(config.screenshotMediaPolicyRequested)) {
  throw new Error(`Invalid screenshotMediaPolicy: ${config.screenshotMediaPolicyRequested}`);
}
if (!new Set(["vaapi", "videotoolbox", "libx264"]).has(config.screenshotEncoder)) {
  throw new Error(`Invalid screenshotEncoder: ${config.screenshotEncoder}`);
}
if (config.screenshotEncoder === "vaapi" && process.platform !== "linux") {
  throw new Error("screenshotEncoder=vaapi is only supported on Linux");
}
if (config.screenshotEncoder === "videotoolbox" && process.platform !== "darwin") {
  throw new Error("screenshotEncoder=videotoolbox is only supported on macOS");
}
if (screenshotCaptureMode && config.mediaFrameMode !== "video") {
  throw new Error("screenshot output backend requires --mediaFrameMode=video so native DOM media is captured");
}
if (screenshotCaptureMode && decoderSourceMappings.length) {
  throw new Error(
    "screenshot output currently captures authored media sources directly; "
    + "decoder source mappings are not allowed until DOM source substitution has an equivalent verified contract",
  );
}
if (!Number.isFinite(config.screenshotCaptureTimeoutMs) || config.screenshotCaptureTimeoutMs < 1_000) {
  throw new Error(`Invalid screenshotCaptureTimeoutMs: ${config.screenshotCaptureTimeoutMs}`);
}
if (!Number.isSafeInteger(config.gpuRasterBudgetMb)
    || config.gpuRasterBudgetMb < 128
    || config.gpuRasterBudgetMb * 1024 * 1024 > totalmem() / 2) {
  throw new Error(`Invalid gpuRasterBudgetMb for this system: ${config.gpuRasterBudgetMb}`);
}
if (!Number.isFinite(config.muxFinalizeTimeoutMs) || config.muxFinalizeTimeoutMs < 1_000) {
  throw new Error(`Invalid muxFinalizeTimeoutMs: ${config.muxFinalizeTimeoutMs}`);
}
if (!Number.isSafeInteger(config.screenshotFrameMaxBytes)
    || config.screenshotFrameMaxBytes < resourceBudget.estimates.rgbaBytes) {
  throw new Error(
    `screenshotFrameMaxBytes must be a safe integer at least as large as one RGBA frame `
    + `(${resourceBudget.estimates.rgbaBytes}); got ${config.screenshotFrameMaxBytes}`,
  );
}
if (!["exact", "frame-grid", "timing-plan"].includes(config.mediaTargetMode)) {
  throw new Error(`Invalid mediaTargetMode: ${config.mediaTargetMode} (expected exact, frame-grid, or timing-plan)`);
}
if (!["hold-last", "transparent", "fail"].includes(config.mediaTailPolicy)) {
  throw new Error(`Invalid mediaTailPolicy: ${config.mediaTailPolicy}`);
}
if (config.mediaTargetMode === "timing-plan" && !loadedMediaTimingBundle) {
  throw new Error("--mediaTargetMode=timing-plan requires --mediaTimingPlan=<project bundle>");
}
if (config.mediaTargetMode === "timing-plan" && config.mediaSeekBiasFrames !== 0) {
  throw new Error("timing-plan mode requires --mediaSeekBiasFrames=0; selected presentation PTS cannot be biased");
}
if (config.mediaTargetMode === "timing-plan" && config.mediaAdvanceMode !== "playback-step") {
  throw new Error("timing-plan mode requires --mediaAdvanceMode=playback-step for verified rVFC advancement");
}
if (config.compositeMode === "proxy-tree" && config.mediaTargetMode !== "timing-plan") {
  throw new Error("--compositeMode=proxy-tree requires --mediaTargetMode=timing-plan and a verified timing bundle");
}
if (config.compositeMode === "proxy-tree") {
  if (!args.runtimeTempDir || !isAbsolute(args.runtimeTempDir)) {
    throw new Error("--compositeMode=proxy-tree requires an absolute --runtimeTempDir outside projectRoot");
  }
  const runtimeRelative = relative(projectRoot, config.runtimeTempDir);
  if (!runtimeRelative.startsWith("..") && !isAbsolute(runtimeRelative)) {
    throw new Error("--runtimeTempDir must be outside projectRoot so a read-only project snapshot remains immutable");
  }
}
if (!Number.isSafeInteger(config.mediaDecoderLanesTotal) || config.mediaDecoderLanesTotal < 1) {
  throw new Error(`Invalid mediaDecoderLanesTotal: ${config.mediaDecoderLanesTotal}`);
}
if (!Number.isSafeInteger(config.mediaDecoderLanesPerSource) || config.mediaDecoderLanesPerSource < 1) {
  throw new Error(`Invalid mediaDecoderLanesPerSource: ${config.mediaDecoderLanesPerSource}`);
}
if (!Number.isSafeInteger(config.mediaDecoderIdleFrames) || config.mediaDecoderIdleFrames < 0) {
  throw new Error(`Invalid mediaDecoderIdleFrames: ${config.mediaDecoderIdleFrames}`);
}
if (!new Set(["bounded", "full"]).has(config.frameMetricsMode)) {
  throw new Error(`Invalid frameMetricsMode: ${config.frameMetricsMode}`);
}
for (const [name, value] of [
  ["frameMetricsHead", config.frameMetricsHead],
  ["frameMetricsTail", config.frameMetricsTail],
]) {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`Invalid ${name}: ${value}`);
}
for (const [name, value] of [
  ["frameMetricsSampleEvery", config.frameMetricsSampleEvery],
  ["frameMetricsMaxFrames", config.frameMetricsMaxFrames],
  ["frameMetricsMaxBytes", config.frameMetricsMaxBytes],
]) {
  if (!Number.isSafeInteger(value) || value < 1) throw new Error(`Invalid ${name}: ${value}`);
}
if (!Number.isFinite(config.frameMetricsSlowMs) || config.frameMetricsSlowMs <= 0) {
  throw new Error(`Invalid frameMetricsSlowMs: ${config.frameMetricsSlowMs}`);
}
if (loadedMediaSourceMap && loadedMediaSourceMap.recipe.fps !== fps) {
  throw new Error(`mediaSourceMap is ${loadedMediaSourceMap.recipe.fps}fps but render is ${fps}fps`);
}
const canonicalFpsMismatches = boundCanonicalMediaRoute
  .filter((mapping) => mapping.frameRate !== fps);
if (canonicalFpsMismatches.length) {
  throw new Error(
    `canonicalMediaRoute frame rate differs from render ${fps}fps: `
    + canonicalFpsMismatches.map((mapping) => `${mapping.source}=${mapping.frameRate}`).join(", "),
  );
}
if (decoderSourceMappings.length && !["layered", "proxy-tree"].includes(config.compositeMode)) {
  throw new Error("decoder source mappings require --compositeMode=layered or proxy-tree");
}
if (!Number.isInteger(config.payloadWriteWindow) || config.payloadWriteWindow < 1) {
  throw new Error(`Invalid payloadWriteWindow: ${config.payloadWriteWindow}`);
}
if (!Number.isInteger(config.payloadWriteLowWatermark)
    || config.payloadWriteLowWatermark < 0
    || config.payloadWriteLowWatermark >= config.payloadWriteWindow) {
  throw new Error(`Invalid payloadWriteLowWatermark: ${config.payloadWriteLowWatermark}`);
}

const productionDecoderBroker = config.mediaDecoderBackend === "production-webcodecs"
  ? createProductionDemuxBroker({
    maximumBatchPackets: config.productionDecoderLimits.maximumBatchPackets,
    maximumBatchBytes: config.productionDecoderLimits.maximumBatchBytes,
    maximumGlobalDemuxBytes: config.productionDecoderLimits.maximumGlobalDemuxBytes,
    maximumOpenCursors: config.productionDecoderLimits.maximumOpenCursors,
  })
  : null;
const productionDecoderBridge = productionDecoderBroker
  ? createProductionDecoderMainBridge({
    broker: productionDecoderBroker,
    resolveSource(request) {
      const approved = productionDecoderPlan.approvedByToken.get(request?.sourceToken);
      if (!approved || approved.sourceIdentity !== request?.sourceIdentity) {
        throw new Error("Production decoder source token/identity was not approved by the verified timing plan");
      }
      return { filePath: approved.filePath, sourceIdentity: approved.sourceIdentity };
    },
  })
  : null;

app.commandLine.appendSwitch("no-sandbox");
app.commandLine.appendSwitch("disable-setuid-sandbox");
app.commandLine.appendSwitch("ignore-gpu-blocklist");
app.commandLine.appendSwitch("enable-gpu-rasterization");
app.commandLine.appendSwitch("enable-zero-copy");
app.commandLine.appendSwitch("enable-native-gpu-memory-buffers");
app.commandLine.appendSwitch("force-color-profile", "srgb");
app.commandLine.appendSwitch("force-device-scale-factor", "1");
app.commandLine.appendSwitch("use-gl", "angle");
app.commandLine.appendSwitch("use-angle", args.angle ?? "gl");
app.commandLine.appendSwitch("disable-software-rasterizer");
app.commandLine.appendSwitch("disable-background-timer-throttling");
app.commandLine.appendSwitch("disable-renderer-backgrounding");
app.commandLine.appendSwitch("disable-backgrounding-occluded-windows");
app.commandLine.appendSwitch("disable-frame-rate-limit");
app.commandLine.appendSwitch("disable-gpu-vsync");
if (screenshotCaptureMode) {
  // Chromium's compositor otherwise derives a budget from the small physical
  // Wayland window instead of the 4K emulated viewport and may checkerboard.
  app.commandLine.appendSwitch("force-gpu-mem-available-mb", String(config.gpuRasterBudgetMb));
}
app.commandLine.appendSwitch("enable-features", [
  "CanvasDrawElement",
  "AcceleratedVideoDecoder",
  "AcceleratedVideoDecodeLinuxGL",
  "AcceleratedVideoDecodeLinuxZeroCopyGL",
  "AcceleratedVideoEncoder",
  "UseMultiPlaneFormatForHardwareVideo",
].join(","));
app.commandLine.appendSwitch("remote-debugging-port", args.cdp ?? "9238");
app.commandLine.appendSwitch("enable-logging", "stderr");
app.commandLine.appendSwitch("vmodule", "*video_encode*=1,*video_encoder*=1,*vaapi*=1,*webcodecs*=1");

mkdirSync(dirname(output), { recursive: true });

if (screenshotCaptureMode) {
  const occupiedTargets = [output, metricsPath, frameSignaturePath].filter((path) => existsSync(path));
  if (occupiedTargets.length) {
    throw new Error(
      `Refusing to overwrite an existing screenshot render contract: ${occupiedTargets.join(", ")}. `
      + "Use a new run-unique output path or move the complete MOV/sidecar/metrics set first.",
    );
  }
}

let frameSignatureWriter = null;
let frameSignatureEvidence = null;
let frameSignatureCommitted = false;
if (screenshotCaptureMode) {
  frameSignatureWriter = createFrameSignatureWriter({
    stagingPath: frameSignatureStagingPath,
    finalPath: frameSignaturePath,
    header: createFrameSignatureHeader({
      runId,
      renderIdentity,
      width: config.width,
      height: config.height,
      fps: config.fps,
      frames: config.frames,
      startFrame: config.startFrame,
      startSeconds: config.start,
    }),
  });
}

let window;
let payloadStream;
let support = null;
let rendererMetrics = null;
let failure = null;
let failureKind = null;
let failureExitCode = 1;
let finalized = false;
let tracePath = null;
const diagnosticWarnings = [];
let muxProcess = null;
let muxPromise = null;
const directMuxStderrHeadLimit = 64 * 1024;
const directMuxStderrTailLimit = 1024 * 1024;
let directMuxStderrHead = "";
let directMuxStderrTail = "";
let directMuxStderrBytes = 0;
let directMuxExpectedAudio = false;
let payloadFailure = null;
let payloadClosed = false;
let payloadEnding = false;
let payloadWriteChain = Promise.resolve();
let loadEntry = entry;
let proxyTreeTempEntry = null;
let screenshotTempEntry = null;
let screenshotCaptureInFlight = false;
let screenshotDebuggerAttached = false;
let screenshotExpectedFrameIndex = 0;
let productionDecoderRoute = null;
let productionDecoderBrokerBeforeDispose = null;
let productionDecoderBrokerAfterDispose = null;
const screenshotHashSequence = createHash("sha256");
const screenshotHashRetentionMaxFrames = Number(args.screenshotHashRetentionMaxFrames ?? 600);
const screenshotHashHeadFrames = Number(args.screenshotHashHeadFrames ?? 8);
const screenshotHashTailFrames = Number(args.screenshotHashTailFrames ?? 8);
const screenshotHashSampleEvery = Number(args.screenshotHashSampleEvery ?? 600);
for (const [name, value, minimum] of [
  ["screenshotHashRetentionMaxFrames", screenshotHashRetentionMaxFrames, 1],
  ["screenshotHashHeadFrames", screenshotHashHeadFrames, 0],
  ["screenshotHashTailFrames", screenshotHashTailFrames, 0],
  ["screenshotHashSampleEvery", screenshotHashSampleEvery, 1],
]) {
  if (!Number.isSafeInteger(value) || value < minimum) throw new Error(`Invalid ${name}: ${value}`);
}
const screenshotHashRetained = [];
const screenshotHashTail = [];
let screenshotHashFramesObserved = 0;
let screenshotHashTotalPngBytes = 0;
let screenshotMediaGateInstalled = false;
let screenshotMediaGateSession = null;
const screenshotMediaLeaseCounts = new Map();
const screenshotPermittedMediaUrls = new Set(
  config.mediaTimingPlans
    .filter((entryRecord) => entryRecord.roles.includes("composition"))
    .map((entryRecord) => entryRecord.sourceUrl),
);
const screenshotMediaGateMetrics = {
  requestedPolicy: config.screenshotMediaPolicyRequested,
  policy: config.screenshotMediaPolicy,
  allowedRequests: 0,
  blockedRequests: 0,
  unexpectedRequests: 0,
  allowlistUpdates: 0,
  maxActiveUrls: 0,
  maxActiveLeases: 0,
  blockedUrlSamples: [],
  finalActiveUrls: null,
  finalActiveLeases: null,
};
let outputCommitted = false;
let stagingOutputRemoved = false;
const memoryWatchdogRecorder = createRenderMemoryWatchdogRecorder(memoryWatchdogPolicy);
let memoryWatchdogTimer = null;
let memoryWatchdogAborting = false;
const processStartedAt = performance.now();

function appendDirectMuxStderr(chunk) {
  const text = String(chunk);
  directMuxStderrBytes += Buffer.byteLength(text);
  if (directMuxStderrHead.length < directMuxStderrHeadLimit) {
    directMuxStderrHead += text.slice(0, directMuxStderrHeadLimit - directMuxStderrHead.length);
  }
  directMuxStderrTail = (directMuxStderrTail + text).slice(-directMuxStderrTailLimit);
}

function directMuxStderrSnapshot() {
  return {
    totalBytes: directMuxStderrBytes,
    truncated: directMuxStderrBytes > Buffer.byteLength(directMuxStderrHead)
      + Buffer.byteLength(directMuxStderrTail),
    head: directMuxStderrHead,
    tail: directMuxStderrTail,
  };
}

function directMuxStderrMessage() {
  if (directMuxStderrHead === directMuxStderrTail) return directMuxStderrHead;
  return `${directMuxStderrHead}\n...[stderr bounded; total ${directMuxStderrBytes} bytes]...\n${directMuxStderrTail}`;
}

function commitProductionDecoderRoute(route) {
  if (!productionDecoderRoutePath || !productionDecoderRouteStagingPath) return;
  mkdirSync(dirname(productionDecoderRoutePath), { recursive: true });
  writeFileSync(productionDecoderRouteStagingPath, `${JSON.stringify(route, null, 2)}\n`, { flag: "wx" });
  renameSync(productionDecoderRouteStagingPath, productionDecoderRoutePath);
}

async function prepareProductionDecoderBackend() {
  if (!productionDecoderBroker) return true;
  const preflight = await preflightFullCanvasProductionDecoder({
    broker: productionDecoderBroker,
    plan: productionDecoderPlan,
    ffprobePath: config.ffprobePath,
    decodeLeadMax: config.productionDecoderLimits.decodeLeadMax,
    readyFramesMax: config.productionDecoderLimits.readyFramesMax,
  });
  productionDecoderRoute = Object.freeze({
    kind: "hyperframes-production-decoder-route",
    schemaVersion: 1,
    runId,
    backend: config.mediaDecoderBackend,
    decision: preflight.decision,
    renderStarted: false,
    timingPlanPath: config.mediaTimingPlanPath,
    sources: preflight.sources,
    createdAt: new Date().toISOString(),
  });
  commitProductionDecoderRoute(productionDecoderRoute);
  if (preflight.decision !== PRODUCTION_DECODER_CACHE_DECISION) return true;
  failureKind = "canonical-cache-required";
  failureExitCode = 2;
  const reasons = preflight.sources
    .filter((source) => source.decision === PRODUCTION_DECODER_CACHE_DECISION)
    .map((source) => `${source.source}: ${source.reason?.code ?? "CACHE_REQUIRED_UNKNOWN"}`);
  failure = `Production decoder preflight requires canonical cache: ${reasons.join("; ")}`;
  return false;
}

async function disposeProductionDecoderBroker() {
  if (!productionDecoderBroker || productionDecoderBrokerAfterDispose) return;
  productionDecoderBrokerBeforeDispose = productionDecoderBroker.snapshot();
  await productionDecoderBroker.dispose();
  productionDecoderBrokerAfterDispose = productionDecoderBroker.snapshot();
  const after = productionDecoderBrokerAfterDispose;
  if (after.activeSources !== 0
      || after.activeCursors !== 0
      || after.byteBudget.currentBytes !== 0
      || after.byteBudget.activeLeases !== 0) {
    throw new Error(`Production decoder broker resources did not return to zero: ${JSON.stringify(after)}`);
  }
}

function recordScreenshotHash(record) {
  screenshotHashFramesObserved += 1;
  screenshotHashTotalPngBytes += record.byteLength;
  screenshotHashSequence.update(`${record.frameIndex}:${record.byteLength}:${record.sha256}\n`);
  if (config.frames <= screenshotHashRetentionMaxFrames
      || record.frameIndex < screenshotHashHeadFrames
      || record.frameIndex % screenshotHashSampleEvery === 0) {
    screenshotHashRetained.push(record);
  }
  screenshotHashTail.push(record);
  while (screenshotHashTail.length > screenshotHashTailFrames) screenshotHashTail.shift();
}

function screenshotHashSnapshot() {
  const recordsByFrame = new Map();
  for (const record of [...screenshotHashRetained, ...screenshotHashTail]) {
    recordsByFrame.set(record.frameIndex, record);
  }
  return {
    mode: config.frames <= screenshotHashRetentionMaxFrames ? "full" : "bounded",
    sequenceSha256: screenshotHashSequence.copy().digest("hex"),
    framesObserved: screenshotHashFramesObserved,
    totalPngBytes: screenshotHashTotalPngBytes,
    retention: {
      maxFullFrames: screenshotHashRetentionMaxFrames,
      headFrames: screenshotHashHeadFrames,
      tailFrames: screenshotHashTailFrames,
      sampleEvery: screenshotHashSampleEvery,
      retainedFrames: recordsByFrame.size,
    },
    records: [...recordsByFrame.values()].sort((left, right) => left.frameIndex - right.frameIndex),
  };
}

function ffmpegRssBytes() {
  if (process.platform !== "linux" || !muxProcess?.pid) return 0;
  try {
    const status = readFileSync(`/proc/${muxProcess.pid}/status`, "utf8");
    const match = status.match(/^VmRSS:\s+(\d+)\s+kB$/m);
    return match ? Number(match[1]) * 1024 : 0;
  } catch {
    return 0;
  }
}

function availableSystemMemoryBytes() {
  const info = typeof process.getSystemMemoryInfo === "function"
    ? process.getSystemMemoryInfo()
    : null;
  const kilobytes = Number(info?.available ?? info?.free);
  if (Number.isFinite(kilobytes) && kilobytes >= 0) return Math.round(kilobytes * 1024);
  throw new Error("Electron did not expose available system memory for the render watchdog");
}

function sampleMemoryWatchdog(stage = "periodic") {
  if (!config.memoryWatchdogEnabled || !app.isReady()) return null;
  const result = memoryWatchdogRecorder.record({
    stage,
    elapsedMs: performance.now() - processStartedAt,
    availableMemoryBytes: availableSystemMemoryBytes(),
    appMetrics: app.getAppMetrics(),
    externalRssBytes: ffmpegRssBytes(),
  });
  if (result.violation && !finalized && !memoryWatchdogAborting) {
    memoryWatchdogAborting = true;
    failure ||= `${result.violation.code}: ${result.violation.message}`;
    void finalize();
  }
  return result;
}

function startMemoryWatchdog() {
  if (!config.memoryWatchdogEnabled || memoryWatchdogTimer) return;
  sampleMemoryWatchdog("startup");
  memoryWatchdogTimer = setInterval(
    () => sampleMemoryWatchdog("periodic"),
    config.memoryWatchdogPolicy.intervalMs,
  );
  memoryWatchdogTimer.unref?.();
}

function enforceMemoryWatchdog(stage) {
  const result = sampleMemoryWatchdog(stage);
  if (result?.violation) {
    throw new Error(`${result.violation.code}: ${result.violation.message}`);
  }
}

function stopMemoryWatchdog() {
  if (!memoryWatchdogTimer) return;
  clearInterval(memoryWatchdogTimer);
  memoryWatchdogTimer = null;
}

function parseAspectRatio(value) {
  const match = String(value ?? "").trim().match(/^(\d+):(\d+)$/);
  if (!match || Number(match[1]) < 1 || Number(match[2]) < 1) return null;
  return { numerator: Number(match[1]), denominator: Number(match[2]) };
}

async function auditProxyTreeDisplayDimensions(entryRecord) {
  const { stdout } = await runProcess(config.ffprobePath, [
    "-v", "error",
    "-select_streams", "v:0",
    "-show_entries",
    "stream=index,width,height,sample_aspect_ratio,display_aspect_ratio:stream_tags=rotate:stream_side_data=side_data_type,rotation",
    "-of", "json",
    entryRecord.sourcePath,
  ]);
  const streams = JSON.parse(stdout).streams ?? [];
  if (streams.length !== 1) {
    throw new Error(`proxy-tree display audit expected one video stream for ${entryRecord.source}; got ${streams.length}`);
  }
  const stream = streams[0];
  const width = Number(stream.width);
  const height = Number(stream.height);
  if (!Number.isSafeInteger(width) || width < 1 || !Number.isSafeInteger(height) || height < 1) {
    throw new Error(`proxy-tree cannot prove coded dimensions for ${entryRecord.source}`);
  }
  if (width !== entryRecord.plan.stream.width || height !== entryRecord.plan.stream.height) {
    throw new Error(
      `proxy-tree display audit disagrees with verified timing plan for ${entryRecord.source}: `
      + `${width}x${height} !== ${entryRecord.plan.stream.width}x${entryRecord.plan.stream.height}`,
    );
  }
  const sampleAspectRatio = String(stream.sample_aspect_ratio ?? "").trim();
  const parsedSampleAspectRatio = parseAspectRatio(sampleAspectRatio);
  if (sampleAspectRatio && sampleAspectRatio !== "N/A"
      && sampleAspectRatio !== "0:1"
      && (!parsedSampleAspectRatio
        || parsedSampleAspectRatio.numerator !== parsedSampleAspectRatio.denominator)) {
    throw new Error(
      `proxy-tree does not yet support non-square sample aspect ratio ${sampleAspectRatio} `
      + `for ${entryRecord.source}; use layered or normalize the source`,
    );
  }
  const displayAspectRatio = String(stream.display_aspect_ratio ?? "").trim();
  const parsedDisplayAspectRatio = parseAspectRatio(displayAspectRatio);
  if (displayAspectRatio && displayAspectRatio !== "N/A"
      && (!parsedDisplayAspectRatio
        || parsedDisplayAspectRatio.numerator * height !== parsedDisplayAspectRatio.denominator * width)) {
    throw new Error(
      `proxy-tree does not yet support display aspect ratio ${displayAspectRatio} `
      + `that differs from coded ${width}:${height} for ${entryRecord.source}`,
    );
  }
  const rotationValues = [
    stream.tags?.rotate,
    ...(stream.side_data_list ?? []).map((sideData) => sideData.rotation),
  ].filter((value) => value != null && String(value).trim() !== "");
  for (const rotationValue of rotationValues) {
    const rotation = Number(rotationValue);
    if (!Number.isFinite(rotation) || Math.abs(rotation % 360) > 1e-7) {
      throw new Error(
        `proxy-tree does not yet support rotated display metadata (${rotationValue} degrees) `
        + `for ${entryRecord.source}; use layered or normalize the source`,
      );
    }
  }
  const unauditedDisplaySideData = (stream.side_data_list ?? []).filter((sideData) => (
    /display matrix|frame crop|clean aperture/i.test(String(sideData.side_data_type ?? ""))
  ));
  if (unauditedDisplaySideData.length) {
    throw new Error(
      `proxy-tree cannot prove display dimensions for ${entryRecord.source}; unsupported side data: `
      + unauditedDisplaySideData.map((item) => item.side_data_type).join(", "),
    );
  }
  return {
    source: entryRecord.source,
    sourceUrl: entryRecord.sourceUrl,
    width,
    height,
    sampleAspectRatio: sampleAspectRatio || null,
    displayAspectRatio: displayAspectRatio || null,
    rotationDegrees: rotationValues.length ? Number(rotationValues[0]) : 0,
    policy: "coded dimensions accepted only when SAR is square/unspecified and rotation is zero",
  };
}

async function prepareProxyTreeEntry() {
  if (config.compositeMode !== "proxy-tree") return;
  const compositionEntries = loadedMediaTimingBundle.entries
    .filter((entryRecord) => entryRecord.roles.includes("composition"));
  const displayDimensionAudits = await Promise.all(
    compositionEntries.map((entryRecord) => auditProxyTreeDisplayDimensions(entryRecord)),
  );
  const intrinsicDimensionsBySource = new Map(displayDimensionAudits.map((audit) => [
    audit.sourceUrl,
    { width: audit.width, height: audit.height },
  ]));
  const transformed = transformProxyTreeHtml({
    entryPath: entry,
    intrinsicDimensionsBySource,
    baseUrl: pathToFileURL(entry).href,
  });
  transformed.report.displayDimensionAudits = displayDimensionAudits;
  mkdirSync(config.runtimeTempDir, { recursive: true, mode: 0o700 });
  const tempEntry = resolve(config.runtimeTempDir, `.hf-proxy-tree-${process.pid}-${randomUUID()}.html`);
  writeFileSync(tempEntry, transformed.html, { encoding: "utf8", flag: "wx" });
  proxyTreeTempEntry = tempEntry;
  loadEntry = tempEntry;
  config.proxyTreeTransform = transformed.report;
}

function cleanupProxyTreeEntry() {
  if (!proxyTreeTempEntry) return;
  const path = proxyTreeTempEntry;
  proxyTreeTempEntry = null;
  try {
    unlinkSync(path);
  } catch (error) {
    console.warn(`FULL_CANVAS_PROXY_TREE_CLEANUP ${path}: ${error?.message || error}`);
  }
}

async function prepareScreenshotEntry() {
  if (!screenshotCaptureMode) return;
  const transformed = transformScreenshotHtml({ entryPath: entry, projectRoot });
  if (transformed.report.videoCount > 0 && config.mediaTargetMode !== "timing-plan") {
    throw new Error(
      `Screenshot composition contains ${transformed.report.videoCount} video element(s); `
      + "quality fallback requires --mediaTargetMode=timing-plan with verified rVFC presentation PTS",
    );
  }
  if (config.screenshotMediaPolicyRequested === "bounded-static"
      && !transformed.report.boundedStatic?.eligible) {
    const codes = transformed.report.boundedStatic?.blockers?.map((item) => item.code).join(", ") || "unknown";
    throw new Error(
      `Screenshot bounded-static media policy could not prove project safety (${codes}); `
      + "rerun with --screenshotMediaPolicy=faithful or normalize media into the deterministic decoder/cache path",
    );
  }
  // The static audit is a conservative heuristic, not a semantic proof of all
  // media-observable JavaScript/CSS. Auto therefore remains faithful. A
  // versioned, signed backend preflight may explicitly select bounded-static.
  config.screenshotMediaPolicy = config.screenshotMediaPolicyRequested === "auto"
    ? "faithful"
    : config.screenshotMediaPolicyRequested;
  config.screenshotMediaRequestGate = config.screenshotMediaPolicy === "bounded-static";
  screenshotMediaGateMetrics.policy = config.screenshotMediaPolicy;
  transformed.report.mediaPolicyRequested = config.screenshotMediaPolicyRequested;
  transformed.report.mediaPolicy = config.screenshotMediaPolicy;
  transformed.report.autoFallbackReason = config.screenshotMediaPolicyRequested === "auto"
    ? [{
      code: "HF_SCREENSHOT_BOUNDED_STATIC_REQUIRES_SIGNED_PREFLIGHT",
      heuristicEligible: Boolean(transformed.report.boundedStatic?.eligible),
      heuristicBlockers: transformed.report.boundedStatic?.blockers ?? [],
    }]
    : null;
  transformed.report.mediaRequestGate = config.screenshotMediaPolicy === "bounded-static"
    ? "isolated-session source-lease allowlist before navigation"
    : null;
  config.screenshotEntryTransform = transformed.report;
}

function cleanupStagingOutput() {
  if (outputCommitted || stagingOutputRemoved || !existsSync(stagingOutput)) return;
  try {
    unlinkSync(stagingOutput);
    stagingOutputRemoved = true;
  } catch (error) {
    console.warn(`FULL_CANVAS_PARTIAL_CLEANUP ${stagingOutput}: ${error?.message || error}`);
  }
}

function cleanupFrameSignatureStaging() {
  if (!frameSignatureWriter || frameSignatureCommitted) return;
  try {
    frameSignatureWriter.abort();
  } catch (error) {
    console.warn(`FULL_CANVAS_FRAME_SIGNATURE_CLEANUP ${frameSignatureStagingPath}: ${error?.message || error}`);
  }
}

function rollbackCommittedRunArtifacts(reason) {
  const failures = [];
  if (outputCommitted && existsSync(output)) {
    try {
      unlinkSync(output);
      outputCommitted = false;
    } catch (error) {
      failures.push(`MOV rollback failed: ${error?.message || error}`);
    }
  }
  // Screenshot startup refuses a pre-existing final sidecar, so any sidecar
  // found here belongs to this run even if commit() copied it and then failed
  // before the caller could flip frameSignatureCommitted.
  if (frameSignatureWriter && existsSync(frameSignaturePath)) {
    try {
      unlinkSync(frameSignaturePath);
      frameSignatureCommitted = false;
      if (frameSignatureEvidence) frameSignatureEvidence = { ...frameSignatureEvidence, committed: false, rolledBack: true };
    } catch (error) {
      failures.push(`sidecar rollback failed: ${error?.message || error}`);
    }
  }
  if (failures.length) {
    diagnosticWarnings.push(`${reason}: ${failures.join("; ")}`);
  }
}

function uninstallScreenshotMediaGate() {
  if (!screenshotMediaGateInstalled || !screenshotMediaGateSession) return;
  try {
    screenshotMediaGateSession.webRequest.onBeforeRequest(null);
  } catch (error) {
    console.warn(`FULL_CANVAS_MEDIA_GATE_CLEANUP ${error?.message || error}`);
  }
  screenshotMediaGateInstalled = false;
  screenshotMediaGateSession = null;
  screenshotMediaLeaseCounts.clear();
}

function cleanupScreenshotEntry() {
  if (!screenshotTempEntry) return;
  const path = screenshotTempEntry;
  screenshotTempEntry = null;
  try {
    unlinkSync(path);
  } catch (error) {
    console.warn(`FULL_CANVAS_SCREENSHOT_CLEANUP ${path}: ${error?.message || error}`);
  }
}

process.once("exit", cleanupProxyTreeEntry);
process.once("exit", cleanupScreenshotEntry);
process.once("exit", cleanupStagingOutput);
process.once("exit", cleanupFrameSignatureStaging);
process.once("exit", uninstallScreenshotMediaGate);

function runProcess(command, commandArgs) {
  return new Promise((resolveProcess, rejectProcess) => {
    const child = spawn(command, commandArgs, { env: childProcessEnvironment, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.once("error", rejectProcess);
    child.once("close", (code) => {
      if (code === 0) resolveProcess({ stdout, stderr });
      else rejectProcess(new Error(`${command} exited ${code}: ${stderr}`));
    });
  });
}

function withTimeout(promise, timeoutMs, label) {
  return new Promise((resolvePromise, rejectPromise) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      rejectPromise(new Error(`${label} timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    Promise.resolve(promise).then(
      (value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolvePromise(value);
      },
      (error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        rejectPromise(error);
      },
    );
  });
}

function installScreenshotMediaGate() {
  if (!config.screenshotMediaRequestGate) return;
  if (!window || window.isDestroyed()) throw new Error("Cannot install screenshot media gate without a render window");
  screenshotMediaGateSession = window.webContents.session;
  screenshotMediaGateSession.webRequest.onBeforeRequest(
    { urls: ["<all_urls>"] },
    (details, callback) => {
      if (details.resourceType !== "media") {
        callback({});
        return;
      }
      const permitted = screenshotPermittedMediaUrls.has(details.url);
      const leased = (screenshotMediaLeaseCounts.get(details.url) ?? 0) > 0;
      if (permitted && leased) {
        screenshotMediaGateMetrics.allowedRequests += 1;
        callback({});
        return;
      }
      screenshotMediaGateMetrics.blockedRequests += 1;
      if (!permitted) screenshotMediaGateMetrics.unexpectedRequests += 1;
      if (screenshotMediaGateMetrics.blockedUrlSamples.length < 16
          && !screenshotMediaGateMetrics.blockedUrlSamples.includes(details.url)) {
        screenshotMediaGateMetrics.blockedUrlSamples.push(details.url);
      }
      callback({ cancel: true });
    },
  );
  screenshotMediaGateInstalled = true;
}

function directMuxCommand(audioClips = []) {
  const ffmpegArgs = ["-hide_banner", "-loglevel", "warning", "-y"];
  if (config.outputBackend === "screenshot") {
    if (config.screenshotEncoder === "vaapi") {
      ffmpegArgs.push("-vaapi_device", config.vaapiDevice);
    }
    ffmpegArgs.push(
      "-thread_queue_size", "2",
      "-framerate", String(config.fps),
      "-f", "image2pipe", "-vcodec", "png", "-i", "pipe:0",
    );
  } else {
    ffmpegArgs.push(
      "-thread_queue_size", "512",
      "-fflags", "+genpts", "-r", String(config.fps), "-f", "h264", "-i", "pipe:0",
    );
  }
  let audioMap = null;
  let outputDuration = config.duration;

  if (audioReference) {
    ffmpegArgs.push(
      "-ss", String(config.start), "-t", String(config.duration), "-i", audioReference,
    );
    audioMap = "1:a:0?";
  } else if (config.mixProjectAudio) {
    const sampleRate = config.audioSampleRate;
    const samplesPerFrame = sampleRate / config.fps;
    if (!Number.isInteger(samplesPerFrame)) {
      throw new Error(`Audio sample rate ${sampleRate} is not divisible by fps ${config.fps}`);
    }
    const totalSamples = config.frames * samplesPerFrame;
    outputDuration = totalSamples / sampleRate;
    const renderStartSample = Math.round(config.start * sampleRate);
    const renderEndSample = renderStartSample + totalSamples;
    const activeAudio = audioClips.map((clip) => {
      const clipStartSample = Math.round(Number(clip.start) * sampleRate);
      const clipDurationSamples = Math.round(Number(clip.duration) * sampleRate);
      const clipEndSample = clipStartSample + clipDurationSamples;
      const mediaStartSample = Math.round(Number(clip.mediaStart || 0) * sampleRate);
      const volume = Number(clip.volume ?? 1);
      const overlapStartSample = Math.max(renderStartSample, clipStartSample);
      const overlapEndSample = Math.min(renderEndSample, clipEndSample);
      return {
        ...clip,
        source: resolve(projectRoot, clip.src),
        inputStartSample: mediaStartSample + overlapStartSample - clipStartSample,
        durationSamples: overlapEndSample - overlapStartSample,
        delaySamples: overlapStartSample - renderStartSample,
        volume,
      };
    }).filter((clip) => clip.durationSamples > 0);

    const filters = [];
    for (const [index, clip] of activeAudio.entries()) {
      if (!existsSync(clip.source)) throw new Error(`Audio source not found: ${clip.source}`);
      ffmpegArgs.push("-i", clip.source);
      const sourceEndSample = clip.inputStartSample + clip.durationSamples;
      filters.push(
        `[${index + 1}:a:0]aresample=${sampleRate}:async=0,`
        + `aformat=sample_fmts=fltp:sample_rates=${sampleRate}:channel_layouts=stereo,`
        + `atrim=start_sample=${clip.inputStartSample}:end_sample=${sourceEndSample},`
        + `asetpts=PTS-STARTPTS,`
        + `apad=whole_len=${clip.durationSamples},atrim=end_sample=${clip.durationSamples},`
        + `volume=${clip.volume.toFixed(6)},adelay=${clip.delaySamples}S:all=1[a${index}]`,
      );
    }
    if (activeAudio.length) {
      const inputs = activeAudio.map((_clip, index) => `[a${index}]`).join("");
      filters.push(
        `${inputs}amix=inputs=${activeAudio.length}:duration=longest:dropout_transition=0:normalize=0,`
        + `apad=whole_len=${totalSamples},atrim=end_sample=${totalSamples},`
        + `asetpts=N/SR/TB[aout]`,
      );
      ffmpegArgs.push("-filter_complex", filters.join(";"));
      audioMap = "[aout]";
    } else {
      filters.push(
        `anullsrc=r=${sampleRate}:cl=stereo,`
        + `atrim=end_sample=${totalSamples},asetpts=N/SR/TB[aout]`,
      );
      ffmpegArgs.push("-filter_complex", filters.join(";"));
      audioMap = "[aout]";
    }
  }

  let videoCodecArgs = [
    "-c:v", "copy",
    "-bsf:v",
    "h264_metadata=video_full_range_flag=0:colour_primaries=1:transfer_characteristics=1:matrix_coefficients=1",
    "-color_range", "tv",
    "-colorspace", "bt709",
    "-color_primaries", "bt709",
    "-color_trc", "bt709",
  ];
  if (config.outputBackend === "screenshot") {
    const colorScale = [
      "scale=iw:ih:in_range=pc:out_range=tv:out_color_matrix=bt709:flags=lanczos+accurate_rnd",
      "setparams=range=limited:color_primaries=bt709:color_trc=bt709:colorspace=bt709",
    ].join(",");
    const common = [
      "-profile:v", "high",
      "-b:v", String(config.bitrate),
      "-g", String(Math.max(1, Math.round(config.fps * 2))),
      "-color_range", "tv",
      "-colorspace", "bt709",
      "-color_primaries", "bt709",
      "-color_trc", "bt709",
    ];
    if (config.screenshotEncoder === "vaapi") {
      videoCodecArgs = [
        "-vf", `${colorScale},format=nv12,hwupload`,
        "-c:v", "h264_vaapi",
        ...common,
      ];
    } else if (config.screenshotEncoder === "videotoolbox") {
      videoCodecArgs = [
        "-vf", `${colorScale},format=nv12`,
        "-c:v", "h264_videotoolbox",
        ...common,
      ];
    } else {
      videoCodecArgs = [
        "-vf", `${colorScale},format=yuv420p`,
        "-c:v", "libx264",
        "-preset", "medium",
        ...common,
      ];
    }
  }
  ffmpegArgs.push("-map", "0:v:0");
  if (audioMap) {
    ffmpegArgs.push("-map", audioMap, ...videoCodecArgs, "-c:a", config.audioCodec);
    if (config.audioCodec === "aac") {
      ffmpegArgs.push("-b:a", String(config.audioBitrate));
    }
    ffmpegArgs.push("-ar", String(config.audioSampleRate), "-ac", "2");
  } else {
    ffmpegArgs.push(...videoCodecArgs, "-an");
  }
  ffmpegArgs.push(
    "-t", outputDuration.toFixed(9),
    "-movflags", "+faststart",
    stagingOutput,
  );
  directMuxExpectedAudio = Boolean(audioMap);
  return ffmpegArgs;
}

function startDirectMux(audioClips) {
  if (muxPromise) return;
  const ffmpegArgs = directMuxCommand(audioClips);
  muxProcess = spawn(config.ffmpegPath, ffmpegArgs, {
    env: childProcessEnvironment,
    stdio: ["pipe", "ignore", "pipe"],
  });
  payloadStream = muxProcess.stdin;
  payloadClosed = false;
  payloadEnding = false;
  payloadFailure = null;
  payloadStream.on("error", (error) => {
    payloadFailure ||= error;
  });
  payloadStream.on("close", () => {
    payloadClosed = true;
    if (!payloadEnding) payloadFailure ||= new Error("FFmpeg payload pipe closed before render completion");
  });
  muxProcess.stderr.setEncoding("utf8");
  muxProcess.stderr.on("data", appendDirectMuxStderr);
  muxPromise = new Promise((resolveMux, rejectMux) => {
    muxProcess.once("error", (error) => {
      payloadFailure ||= error;
      rejectMux(error);
    });
    muxProcess.once("close", (code) => {
      if (code === 0) resolveMux({ stderr: directMuxStderrSnapshot(), args: ffmpegArgs });
      else {
        payloadFailure ||= new Error(`ffmpeg direct mux exited ${code}: ${directMuxStderrMessage()}`);
        rejectMux(payloadFailure);
      }
    });
  });
  muxPromise.catch(() => {});
}

function waitForPayloadDrain() {
  return new Promise((resolveDrain, rejectDrain) => {
    if (payloadFailure) {
      rejectDrain(payloadFailure);
      return;
    }
    if (!payloadStream || payloadClosed || payloadStream.destroyed || !payloadStream.writable) {
      rejectDrain(new Error("FFmpeg payload pipe is not writable"));
      return;
    }
    let timer = null;
    const cleanup = () => {
      clearTimeout(timer);
      payloadStream?.removeListener("drain", onDrain);
      payloadStream?.removeListener("error", onError);
      payloadStream?.removeListener("close", onClose);
    };
    const finish = (error) => {
      cleanup();
      if (error) rejectDrain(error);
      else resolveDrain();
    };
    const onDrain = () => finish(null);
    const onError = (error) => finish(error);
    const onClose = () => finish(payloadFailure || new Error("FFmpeg payload pipe closed while waiting for drain"));
    payloadStream.once("drain", onDrain);
    payloadStream.once("error", onError);
    payloadStream.once("close", onClose);
    timer = setTimeout(() => {
      const error = new Error(`FFmpeg payload pipe stalled for ${config.payloadStallTimeoutMs}ms`);
      payloadFailure ||= error;
      finish(error);
    }, config.payloadStallTimeoutMs);
  });
}

async function writePayloadBytes(bytes) {
  if (payloadFailure) throw payloadFailure;
  if (!payloadStream || payloadClosed || payloadStream.destroyed || !payloadStream.writable) {
    throw new Error("Payload stream is not writable");
  }
  if (!payloadStream.write(bytes)) await waitForPayloadDrain();
  if (payloadFailure) throw payloadFailure;
  return bytes.byteLength;
}

function enqueuePayloadWrite(bytes) {
  const operation = payloadWriteChain.then(() => writePayloadBytes(bytes));
  payloadWriteChain = operation.catch(() => {});
  return operation;
}

async function closePayloadStream() {
  if (!payloadStream) return;
  await payloadWriteChain;
  if (payloadFailure) {
    const error = payloadFailure;
    payloadEnding = true;
    payloadStream.destroy();
    payloadStream = null;
    throw error;
  }
  payloadEnding = true;
  await new Promise((resolveClose, rejectClose) => {
    let settled = false;
    const cleanup = () => payloadStream?.removeListener("error", onError);
    const finish = (error) => {
      if (settled) return;
      settled = true;
      cleanup();
      if (error) rejectClose(error);
      else resolveClose();
    };
    const onError = (error) => finish(error);
    payloadStream.once("error", onError);
    payloadStream.end(() => finish(null));
  });
  payloadStream = null;
}

async function terminateMuxProcess() {
  if (!muxProcess || muxProcess.exitCode != null || muxProcess.signalCode != null) return;
  const closed = new Promise((resolveClose) => muxProcess.once("close", resolveClose));
  muxProcess.kill("SIGTERM");
  try {
    await withTimeout(closed, 2_000, "FFmpeg SIGTERM shutdown");
  } catch {
    if (muxProcess.exitCode == null && muxProcess.signalCode == null) muxProcess.kill("SIGKILL");
    try {
      await withTimeout(closed, 2_000, "FFmpeg SIGKILL shutdown");
    } catch {
      // app.exit follows; the exact partial path is never promoted.
    }
  }
}

async function muxOutput() {
  const videoCopyArgs = [
    "-c:v", "copy",
    "-bsf:v",
    "h264_metadata=video_full_range_flag=0:colour_primaries=1:transfer_characteristics=1:matrix_coefficients=1",
    "-color_range", "tv",
    "-colorspace", "bt709",
    "-color_primaries", "bt709",
    "-color_trc", "bt709",
  ];
  const ffmpegArgs = [
    "-hide_banner", "-loglevel", "warning", "-y",
    "-fflags", "+genpts", "-r", String(config.fps), "-i", rawPath,
  ];
  if (audioReference) {
    ffmpegArgs.push(
      "-ss", String(config.start), "-t", String(config.duration), "-i", audioReference,
      "-map", "0:v:0", "-map", "1:a?", ...videoCopyArgs,
      "-c:a", config.audioCodec,
    );
    if (config.audioCodec === "aac") ffmpegArgs.push("-b:a", String(config.audioBitrate));
    ffmpegArgs.push("-ar", String(config.audioSampleRate), "-ac", "2");
  } else {
    ffmpegArgs.push("-map", "0:v:0", ...videoCopyArgs, "-an");
  }
  ffmpegArgs.push("-t", String(config.duration), "-movflags", "+faststart", stagingOutput);
  return runProcess(config.ffmpegPath, ffmpegArgs);
}

async function probeOutput(path = stagingOutput) {
  const result = await runProcess(config.ffprobePath, [
    "-v", "error", "-count_packets",
    "-show_entries",
    "format=duration,size,bit_rate:stream=index,codec_type,codec_name,pix_fmt,width,height,r_frame_rate,avg_frame_rate,nb_read_packets,duration,duration_ts,time_base,start_time,sample_rate,channels,channel_layout,bit_rate,color_range,color_space,color_transfer,color_primaries",
    "-of", "json", path,
  ]);
  return JSON.parse(result.stdout);
}

async function probeDecodedAudioSamples(path = stagingOutput) {
  const result = await runProcess(config.ffprobePath, [
    "-v", "error",
    "-select_streams", "a:0",
    "-show_frames",
    "-show_entries", "frame=nb_samples",
    "-of", "csv=p=0",
    path,
  ]);
  let frameCount = 0;
  let samplesPerChannel = 0;
  for (const rawLine of result.stdout.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    const value = Number(line.split(",", 1)[0]);
    if (!Number.isSafeInteger(value) || value <= 0) {
      throw new Error(`Invalid decoded audio frame sample count: ${line}`);
    }
    frameCount += 1;
    samplesPerChannel += value;
  }
  if (!frameCount) throw new Error("Decoded audio probe returned no audio frames");
  return { frameCount, samplesPerChannel };
}

async function finalize() {
  if (finalized) return;
  finalized = true;
  stopMemoryWatchdog();
  try {
    sampleMemoryWatchdog("finalize-start");
  } catch (error) {
    failure ||= `Memory watchdog final sample failed: ${error?.message || error}`;
  }
  const finalizeStartedAt = performance.now();
  let mux = null;
  let probe = null;
  let decodedAudio = null;
  let gpuInfo = null;
  try {
    await withTimeout(closePayloadStream(), config.payloadStallTimeoutMs, "Payload stream finalization");
    if (!failure && frameSignatureWriter) {
      frameSignatureEvidence = await withTimeout(
        frameSignatureWriter.finalize(),
        config.payloadStallTimeoutMs,
        "Frame signature sidecar finalization",
      );
    }
    if (directMux && muxPromise) mux = await withTimeout(muxPromise, config.muxFinalizeTimeoutMs, "FFmpeg mux finalization");
    else if (directMux && !failure) throw new Error("Direct muxer was not initialized");
    else if (!failure) mux = await muxOutput();
    if (!failure) probe = await probeOutput();
    if (!failure && (audioReference || directMuxExpectedAudio)) {
      decodedAudio = await probeDecodedAudioSamples();
    }
    if (!failure) {
      const video = probe.streams?.find((stream) => stream.codec_type === "video");
      const audio = probe.streams?.find((stream) => stream.codec_type === "audio");
      const validation = [];
      const ratio = (value) => {
        const [numerator, denominator = "1"] = String(value ?? "0").split("/");
        return Number(numerator) / Number(denominator);
      };
      const finiteNumber = (value) => {
        const numeric = Number(value);
        return Number.isFinite(numeric) ? numeric : null;
      };
      const durationTolerance = 1 / config.fps + 0.000_001;
      if (!video) validation.push("missing video stream");
      if (video && (video.width !== config.width || video.height !== config.height)) {
        validation.push(`resolution ${video.width}x${video.height}`);
      }
      if (video && video.codec_name !== "h264") validation.push(`video codec ${video.codec_name}`);
      if (video && video.pix_fmt !== "yuv420p") validation.push(`pixel format ${video.pix_fmt}`);
      if (video) {
        if (video.color_range !== "tv") validation.push(`color range ${video.color_range}`);
        if (video.color_space !== "bt709") validation.push(`color space ${video.color_space}`);
        if (video.color_primaries !== "bt709") validation.push(`color primaries ${video.color_primaries}`);
        if (video.color_transfer !== "bt709") validation.push(`color transfer ${video.color_transfer}`);
      }
      const probedFrameRate = video ? ratio(video.avg_frame_rate) : NaN;
      if (video && (!Number.isFinite(probedFrameRate)
          || Math.abs(probedFrameRate - config.fps) > 0.000_001)) {
        validation.push(`frame rate ${video.avg_frame_rate ?? "missing"}`);
      }
      if (video && (!Number.isSafeInteger(Number(video.nb_read_packets))
          || Number(video.nb_read_packets) !== config.frames)) {
        validation.push(`video packets ${video.nb_read_packets ?? "missing"}, expected ${config.frames}`);
      }
      const videoDuration = finiteNumber(video?.duration);
      if (video && (videoDuration == null
          || Math.abs(videoDuration - config.duration) > durationTolerance)) {
        validation.push(`video duration ${video?.duration ?? "missing"}, expected ${config.duration}`);
      }
      const videoStart = finiteNumber(video?.start_time);
      if (video && (videoStart == null || Math.abs(videoStart) > 0.000_001)) {
        validation.push(`video start ${video?.start_time ?? "missing"}`);
      }
      const containerDuration = finiteNumber(probe.format?.duration);
      if (containerDuration == null
          || Math.abs(containerDuration - config.duration) > durationTolerance) {
        validation.push(`container duration ${probe.format?.duration ?? "missing"}, expected ${config.duration}`);
      }
      if ((audioReference || directMuxExpectedAudio) && !audio) {
        validation.push("missing audio stream");
      } else if (audioReference || directMuxExpectedAudio) {
        if (audio.codec_name !== config.audioCodec) {
          validation.push(`audio codec ${audio.codec_name}, expected ${config.audioCodec}`);
        }
        if (Number(audio.sample_rate) !== config.audioSampleRate) {
          validation.push(`audio sample rate ${audio.sample_rate}`);
        }
        if (Number(audio.channels) !== 2) validation.push(`audio channels ${audio.channels}`);
        const audioDuration = finiteNumber(audio.duration);
        if (audioDuration == null || Math.abs(audioDuration - config.duration) > durationTolerance) {
          validation.push(`audio duration ${audio.duration ?? "missing"}, expected ${config.duration}`);
        }
        const audioStart = finiteNumber(audio.start_time);
        if (audioStart == null || Math.abs(audioStart) > 1 / config.audioSampleRate) {
          validation.push(`audio start ${audio.start_time ?? "missing"}`);
        }
        const samplesPerFrame = config.audioSampleRate / config.fps;
        const expectedSamples = samplesPerFrame * config.frames;
        if (!Number.isSafeInteger(expectedSamples)) {
          validation.push(
            `audio clock ${config.audioSampleRate}/${config.fps} does not yield integer frame samples`,
          );
        } else if (!decodedAudio) {
          validation.push("decoded audio sample probe missing");
        } else if (config.audioCodec === "aac" && config.allowAudioCodecPadding) {
          const padding = decodedAudio.samplesPerChannel - expectedSamples;
          if (padding < 0 || padding >= 1024) {
            validation.push(
              `decoded AAC samples ${decodedAudio.samplesPerChannel}, expected ${expectedSamples} plus <1024 padding`,
            );
          }
        } else if (decodedAudio.samplesPerChannel !== expectedSamples) {
          validation.push(
            `decoded audio samples ${decodedAudio.samplesPerChannel}, expected exactly ${expectedSamples}`,
          );
        }
      }
      if (rendererMetrics?.mediaSeekErrors?.length) {
        validation.push(`media seek errors ${rendererMetrics.mediaSeekErrors.length}`);
      }
      if (validation.length) failure = `Output validation failed: ${validation.join("; ")}`;
    }
    if (config.diagnostics) {
      try {
        gpuInfo = await app.getGPUInfo("complete");
      } catch (error) {
        diagnosticWarnings.push(`GPU diagnostics unavailable: ${error?.message || error}`);
      }
    }
    if (!failure) {
      if (frameSignatureWriter) {
        frameSignatureWriter.commit();
        frameSignatureCommitted = true;
        frameSignatureEvidence = { ...frameSignatureEvidence, committed: true };
      }
      renameSync(stagingOutput, output);
      outputCommitted = true;
    }
  } catch (error) {
    failure ||= error?.stack || String(error);
    await terminateMuxProcess();
    rollbackCommittedRunArtifacts("finalize rollback");
  }
  if (failure) {
    cleanupStagingOutput();
    cleanupFrameSignatureStaging();
  }

  if (config.trace) {
    try {
      tracePath = await contentTracing.stopRecording(resolve(rendererRoot, "results/full-canvas.trace.json"));
    } catch (error) {
      diagnosticWarnings.push(`Trace stop failed: ${error?.message || error}`);
    }
  }

  try {
    await disposeProductionDecoderBroker();
  } catch (error) {
    failureKind = "resource-cleanup-failure";
    failureExitCode = 1;
    failure ||= `Production decoder broker cleanup failed: ${error?.stack || error}`;
    cleanupStagingOutput();
  }

  const metrics = {
    runId,
    renderIdentity,
    config: {
      ...config,
      mediaTimingPlans: config.mediaTimingPlans.map((entryRecord) => ({
        source: entryRecord.source,
        roles: entryRecord.roles,
        mapsFrom: entryRecord.mapsFrom,
        sourceIdentity: entryRecord.plan.source.identity,
        frameCount: entryRecord.plan.presentation.frameCount,
        classification: entryRecord.plan.presentation.classification,
        timestampSource: entryRecord.plan.probe.timestampSource,
      })),
      productionDecoderRuntimeUrl: config.productionDecoderRuntimeUrl ? "browser.mjs" : null,
      productionDecoderSources: config.productionDecoderSources.map((entryRecord) => ({
        source: entryRecord.source,
        sourceIdentity: entryRecord.sourceIdentity,
      })),
    },
    electron: process.versions,
    gpuFeatureStatus: app.getGPUFeatureStatus(),
    gpuInfo,
    support,
    renderer: rendererMetrics,
    muxStderr: mux?.stderr ?? null,
    muxArgs: mux?.args ?? null,
    probe,
    decodedAudio,
    outputCommit: {
      stagingOutput,
      committed: outputCommitted,
      partialRemoved: stagingOutputRemoved,
    },
    screenshotSequence: screenshotCaptureMode ? {
      expectedFrames: config.frames,
      capturedFrames: screenshotExpectedFrameIndex,
      optimizeForSpeed: config.screenshotOptimizeForSpeed,
      frameHashSequence: screenshotHashSnapshot(),
      frameSignatureSidecar: frameSignatureEvidence ? {
        ...frameSignatureEvidence,
        stagingPath: frameSignatureEvidence.stagingPath,
        committed: frameSignatureCommitted,
      } : null,
      mediaGate: screenshotMediaGateMetrics,
    } : null,
    productionDecoder: config.mediaDecoderBackend === "production-webcodecs" ? {
      route: productionDecoderRoute,
      routePath: productionDecoderRoutePath,
      brokerBeforeDispose: productionDecoderBrokerBeforeDispose,
      brokerAfterDispose: productionDecoderBrokerAfterDispose,
    } : null,
    memoryWatchdog: memoryWatchdogRecorder.snapshot(),
    tracePath,
    diagnosticWarnings,
    failure,
    failureKind: failure ? (failureKind ?? "render-failure") : null,
    failureExitCode: failure ? failureExitCode : 0,
    finalizeMs: performance.now() - finalizeStartedAt,
    processWallMs: performance.now() - processStartedAt,
    createdAt: new Date().toISOString(),
  };
  let writtenMetricsPath = failure ? failedMetricsPath : metricsPath;
  try {
    const metricsJson = `${JSON.stringify(metrics, null, 2)}\n`;
    if (failure) {
      writeFileSync(failedMetricsPath, metricsJson, { flag: "wx" });
    } else {
      writeFileSync(stagingMetricsPath, metricsJson, { flag: "wx" });
      renameSync(stagingMetricsPath, metricsPath);
    }
    console.log(`FULL_CANVAS_RESULT ${JSON.stringify({
      runId,
      output,
      metricsPath: writtenMetricsPath,
      failure,
      failureKind: failure ? (failureKind ?? "render-failure") : null,
      failureExitCode: failure ? failureExitCode : 0,
      renderer: rendererMetrics ? {
        frames: rendererMetrics.frames,
        framesCompleted: rendererMetrics.framesCompleted,
        wallMs: rendererMetrics.wallMs,
        outputChunks: rendererMetrics.outputChunks,
        payloadBytes: rendererMetrics.payloadBytes,
        frameMetrics: rendererMetrics.frameMetrics ? {
          mode: rendererMetrics.frameMetrics.mode,
          framesObserved: rendererMetrics.frameMetrics.framesObserved,
          framesCompleted: rendererMetrics.frameMetrics.framesCompleted,
          retention: rendererMetrics.frameMetrics.retention,
          aggregates: rendererMetrics.frameMetrics.aggregates,
        } : null,
      } : null,
      memoryWatchdog: {
        peakAggregateRssBytes: memoryWatchdogRecorder.snapshot().peakAggregateRssBytes,
        minAvailableBytes: memoryWatchdogRecorder.snapshot().minAvailableBytes,
        violation: memoryWatchdogRecorder.snapshot().violation,
      },
      probe,
      decodedAudio,
    })}`);
  } catch (error) {
    failure ||= `Metrics commit failed: ${error?.stack || error}`;
    rollbackCommittedRunArtifacts("metrics commit rollback");
    writtenMetricsPath = null;
    console.error(`FULL_CANVAS_METRICS_COMMIT_FAILED ${failure}`);
    try {
      if (existsSync(stagingMetricsPath)) unlinkSync(stagingMetricsPath);
    } catch {
      // The unique .hf-partial name remains visibly incomplete if cleanup fails.
    }
    try {
      const failedAfterCommit = {
        ...metrics,
        outputCommit: {
          ...metrics.outputCommit,
          committed: false,
          rolledBack: true,
        },
        screenshotSequence: metrics.screenshotSequence ? {
          ...metrics.screenshotSequence,
          frameSignatureSidecar: frameSignatureEvidence ? {
            ...frameSignatureEvidence,
            committed: false,
            rolledBack: true,
          } : null,
        } : null,
        failure,
        failureKind: "metrics-commit-failure",
        failureExitCode: 1,
      };
      writeFileSync(failedMetricsPath, `${JSON.stringify(failedAfterCommit, null, 2)}\n`, { flag: "wx" });
      writtenMetricsPath = failedMetricsPath;
    } catch (failedMetricsError) {
      console.error(`FULL_CANVAS_FAILED_METRICS_WRITE_FAILED ${failedMetricsError?.stack || failedMetricsError}`);
    }
  } finally {
    if (screenshotDebuggerAttached && window && !window.isDestroyed()) {
      try {
        window.webContents.debugger.detach();
      } catch (error) {
        console.warn(`FULL_CANVAS_SCREENSHOT_DEBUGGER_DETACH ${error?.message || error}`);
      }
      screenshotDebuggerAttached = false;
    }
    uninstallScreenshotMediaGate();
    window?.destroy();
    cleanupProxyTreeEntry();
    cleanupScreenshotEntry();
    app.exit(failure ? failureExitCode : 0);
  }
}

function assertProductionDecoderIpcSender(event) {
  if (!productionDecoderBridge) throw new Error("Production decoder IPC is disabled for this render");
  if (!window || window.isDestroyed() || event.sender !== window.webContents) {
    throw new Error("Production decoder IPC did not originate from the active render window");
  }
}

const productionDecoderIpcMethods = Object.freeze({
  "renderkit:decoder-open-source": "decoderOpenSource",
  "renderkit:decoder-resolve-target": "decoderResolveTarget",
  "renderkit:decoder-begin-cursor": "decoderBeginCursor",
  "renderkit:decoder-next-batch": "decoderNextBatch",
  "renderkit:decoder-ack-batch": "decoderAckBatch",
  "renderkit:decoder-release-cursor": "decoderReleaseCursor",
  "renderkit:decoder-close-source": "decoderCloseSource",
  "renderkit:decoder-stats": "decoderStats",
});
for (const [channel, method] of Object.entries(productionDecoderIpcMethods)) {
  ipcMain.handle(channel, async (event, request) => {
    assertProductionDecoderIpcSender(event);
    return productionDecoderBridge[method](request);
  });
}

ipcMain.handle("renderkit:get-config", () => config);
ipcMain.handle("renderkit:report-support", (_event, value) => {
  support = value;
  if (productionDecoderRoute) {
    productionDecoderRoute = Object.freeze({
      ...productionDecoderRoute,
      renderStarted: true,
      rendererOpenedAt: new Date().toISOString(),
    });
    commitProductionDecoderRoute(productionDecoderRoute);
  }
  if (directMux) startDirectMux(value.audioClips ?? []);
  console.log(`FULL_CANVAS_SUPPORT ${JSON.stringify(value)}`);
  return true;
});
ipcMain.on("renderkit:progress", (_event, value) => {
  console.log(`FULL_CANVAS_PROGRESS ${value.frame}/${value.frames} ${Math.round(value.elapsedMs)}ms`);
});
ipcMain.handle("renderkit:report-results", (_event, value) => {
  rendererMetrics = value;
  return true;
});
ipcMain.handle("renderkit:write-payload", async (_event, payload) => {
  if (config.outputBackend === "screenshot") {
    throw new Error("renderkit:write-payload is forbidden for screenshot output; only ordered main-process capture may feed FFmpeg");
  }
  if (!payloadStream) throw new Error("Payload stream is not initialized");
  const bytes = Buffer.from(payload.bytes);
  return enqueuePayloadWrite(bytes);
});
ipcMain.handle("renderkit:set-screenshot-media-access", async (event, payload = {}) => {
  if (!config.screenshotMediaRequestGate) {
    if (screenshotCaptureMode && config.screenshotMediaPolicy === "faithful") {
      return { policy: "faithful", activeUrls: 0, activeLeases: 0 };
    }
    throw new Error("Screenshot media request gate is unavailable for the selected output policy");
  }
  if (!window || window.isDestroyed() || event.sender !== window.webContents) {
    throw new Error("Screenshot media access request did not originate from the active render window");
  }
  if (!Array.isArray(payload.sources)) throw new Error("Screenshot media access requires a sources array");
  const requestedFrameIndex = Number(payload.frameIndex);
  if (!Number.isSafeInteger(requestedFrameIndex)
      || requestedFrameIndex !== screenshotExpectedFrameIndex
      || requestedFrameIndex < 0
      || requestedFrameIndex > config.frames) {
    throw new Error(
      `Screenshot media lease frame ${payload.frameIndex}; expected ${screenshotExpectedFrameIndex} `
      + `(valid range 0..${config.frames})`,
    );
  }
  if (payload.sources.length > (config.screenshotEntryTransform?.videoCount ?? 0)) {
    throw new Error(`Screenshot media access listed too many sources: ${payload.sources.length}`);
  }
  const next = new Map();
  for (const item of payload.sources) {
    const url = String(item?.url ?? "");
    const count = Number(item?.count);
    if (!screenshotPermittedMediaUrls.has(url)) {
      throw new Error(`Screenshot media source is absent from the verified timing bundle: ${url}`);
    }
    if (!Number.isSafeInteger(count) || count < 1) {
      throw new Error(`Invalid screenshot media lease count for ${url}: ${item?.count}`);
    }
    if (next.has(url)) throw new Error(`Duplicate screenshot media lease source: ${url}`);
    next.set(url, count);
  }
  screenshotMediaLeaseCounts.clear();
  for (const [url, count] of next) screenshotMediaLeaseCounts.set(url, count);
  const activeLeases = [...next.values()].reduce((sum, count) => sum + count, 0);
  if (activeLeases > (config.screenshotEntryTransform?.videoCount ?? 0)) {
    throw new Error(
      `Screenshot media lease count ${activeLeases} exceeds audited video count `
      + `${config.screenshotEntryTransform?.videoCount ?? 0}`,
    );
  }
  screenshotMediaGateMetrics.allowlistUpdates += 1;
  screenshotMediaGateMetrics.maxActiveUrls = Math.max(screenshotMediaGateMetrics.maxActiveUrls, next.size);
  screenshotMediaGateMetrics.maxActiveLeases = Math.max(screenshotMediaGateMetrics.maxActiveLeases, activeLeases);
  return { policy: "bounded-static", activeUrls: next.size, activeLeases };
});
ipcMain.handle("renderkit:capture-frame", async (event, payload = {}) => {
  if (!screenshotCaptureMode) {
    throw new Error("Native screenshot capture is unavailable for the selected output backend");
  }
  if (!window || window.isDestroyed() || event.sender !== window.webContents) {
    throw new Error("Screenshot capture request did not originate from the active render window");
  }
  if (!payloadStream) throw new Error("Payload stream is not initialized");
  if (screenshotCaptureInFlight) throw new Error("Concurrent screenshot capture is forbidden");
  const frameIndex = Number(payload.frameIndex);
  if (!Number.isSafeInteger(frameIndex)
      || frameIndex !== screenshotExpectedFrameIndex
      || frameIndex < 0
      || frameIndex >= config.frames) {
    throw new Error(
      `Out-of-order screenshot frame ${payload.frameIndex}; expected ${screenshotExpectedFrameIndex} of ${config.frames}`,
    );
  }
  const expectedTimelineFrame = config.startFrame == null ? null : config.startFrame + frameIndex;
  if (payload.timelineFrame !== expectedTimelineFrame) {
    throw new Error(
      `Screenshot timeline frame mismatch at output frame ${frameIndex}: `
      + `${payload.timelineFrame} !== ${expectedTimelineFrame}`,
    );
  }
  const expectedTime = expectedTimelineFrame == null
    ? config.start + frameIndex / config.fps
    : expectedTimelineFrame / config.fps;
  if (!Number.isFinite(Number(payload.time)) || Math.abs(Number(payload.time) - expectedTime) > 1e-9) {
    throw new Error(`Screenshot time mismatch at frame ${frameIndex}: ${payload.time} !== ${expectedTime}`);
  }
  screenshotCaptureInFlight = true;
  try {
    enforceMemoryWatchdog(`capture-${frameIndex}-before`);
    if (config.screenshotWindowMode !== "emulated") {
      const contentBounds = window.getContentBounds();
      if (contentBounds.width !== config.width || contentBounds.height !== config.height) {
        throw new Error(
          `Screenshot viewport is ${contentBounds.width}x${contentBounds.height}; `
          + `expected exact ${config.width}x${config.height}`,
        );
      }
    }
    const captureStartedAt = performance.now();
    let bytes;
    let size;
    let pngEncodeMs = 0;
    let captureContract;
    if (config.screenshotWindowMode === "emulated") {
      if (!screenshotDebuggerAttached) throw new Error("Screenshot debugger is not attached");
      const response = await withTimeout(window.webContents.debugger.sendCommand("Page.captureScreenshot", {
        format: "png",
        fromSurface: true,
        captureBeyondViewport: true,
        optimizeForSpeed: config.screenshotOptimizeForSpeed,
        clip: { x: 0, y: 0, width: config.width, height: config.height, scale: 1 },
      }), config.screenshotCaptureTimeoutMs, `CDP screenshot frame ${frameIndex}`);
      const maxBase64Length = Math.ceil(config.screenshotFrameMaxBytes / 3) * 4 + 8;
      if (typeof response.data !== "string" || response.data.length > maxBase64Length) {
        throw new Error(
          `CDP screenshot base64 payload is ${response.data?.length ?? "invalid"} characters; `
          + `limit is ${maxBase64Length}`,
        );
      }
      bytes = Buffer.from(response.data, "base64");
      if (bytes.byteLength < 24 || bytes.toString("ascii", 12, 16) !== "IHDR") {
        throw new Error("CDP screenshot did not contain a PNG IHDR header");
      }
      size = { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
      captureContract = "cdp-page-capture-screenshot-png-main-process-sequential";
    } else {
      const image = await withTimeout(window.webContents.capturePage({
        x: 0,
        y: 0,
        width: config.width,
        height: config.height,
      }), config.screenshotCaptureTimeoutMs, `capturePage screenshot frame ${frameIndex}`);
      size = image.getSize();
      const pngStartedAt = performance.now();
      bytes = image.toPNG();
      pngEncodeMs = performance.now() - pngStartedAt;
      captureContract = "capture-page-png-main-process-sequential";
    }
    enforceMemoryWatchdog(`capture-${frameIndex}-decoded`);
    const captureMs = performance.now() - captureStartedAt;
    if (size.width !== config.width || size.height !== config.height) {
      throw new Error(
        `native screenshot returned ${size.width}x${size.height}; expected ${config.width}x${config.height}`,
      );
    }
    if (bytes.byteLength < 8 || bytes.readUInt32BE(0) !== 0x89504e47) {
      throw new Error("capturePage did not produce a valid PNG payload");
    }
    if (bytes.byteLength > config.screenshotFrameMaxBytes) {
      throw new Error(
        `Screenshot PNG is ${bytes.byteLength} bytes, above the per-frame limit `
        + `${config.screenshotFrameMaxBytes}`,
      );
    }
    const decodedImage = nativeImage.createFromBuffer(bytes, { scaleFactor: 1 });
    if (decodedImage.isEmpty()) throw new Error("Screenshot PNG could not be decoded for pixel identity verification");
    const decodedSize = decodedImage.getSize();
    if (decodedSize.width !== config.width || decodedSize.height !== config.height) {
      throw new Error(
        `Decoded screenshot is ${decodedSize.width}x${decodedSize.height}; `
        + `expected ${config.width}x${config.height}`,
      );
    }
    const bitmap = decodedImage.toBitmap({ scaleFactor: 1 });
    const expectedBitmapBytes = config.width * config.height * 4;
    if (bitmap.byteLength !== expectedBitmapBytes) {
      throw new Error(
        `Decoded screenshot bitmap is ${bitmap.byteLength} bytes; expected ${expectedBitmapBytes}`,
      );
    }
    const pixelSha256 = createHash("sha256").update(bitmap).digest("hex");
    const pngSha256 = createHash("sha256").update(bytes).digest("hex");
    if (!frameSignatureWriter) throw new Error("Screenshot frame signature writer is unavailable");
    const signatureImage = decodedImage.resize({
      width: FRAME_SIGNATURE_GRID_WIDTH,
      height: FRAME_SIGNATURE_GRID_HEIGHT,
      quality: "best",
    });
    if (signatureImage.isEmpty()) throw new Error(`Frame ${frameIndex} signature resize produced an empty image`);
    const signatureBitmap = signatureImage.toBitmap({ scaleFactor: 1 });
    const frameSignature = rgbSignatureFromResizedBgra(signatureBitmap);
    await frameSignatureWriter.write(frameIndex, frameSignature);
    const writeStartedAt = performance.now();
    if (config.outputBackend === "screenshot") await enqueuePayloadWrite(bytes);
    enforceMemoryWatchdog(`capture-${frameIndex}-written`);
    recordScreenshotHash({
      frameIndex,
      sha256: pixelSha256,
      pngSha256,
      byteLength: bytes.byteLength,
      bitmapByteLength: bitmap.byteLength,
    });
    screenshotExpectedFrameIndex += 1;
    return {
      frameIndex,
      byteLength: bytes.byteLength,
      captureMs,
      pngEncodeMs,
      writeMs: config.outputBackend === "screenshot" ? performance.now() - writeStartedAt : 0,
      ...(config.outputBackend === "webcodecs" ? {
        pngBytes: new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength),
      } : {}),
      width: size.width,
      height: size.height,
      contract: captureContract,
      sha256: pixelSha256,
      pngSha256,
    };
  } finally {
    screenshotCaptureInFlight = false;
  }
});
ipcMain.handle("renderkit:finish", async (_event, value) => {
  rendererMetrics = value;
  if (screenshotCaptureMode && screenshotExpectedFrameIndex !== config.frames) {
    failure ||= `Screenshot sequence completed ${screenshotExpectedFrameIndex}/${config.frames} ordered frames`;
  }
  const finalActiveLeases = [...screenshotMediaLeaseCounts.values()].reduce((sum, count) => sum + count, 0);
  screenshotMediaGateMetrics.finalActiveUrls = screenshotMediaLeaseCounts.size;
  screenshotMediaGateMetrics.finalActiveLeases = finalActiveLeases;
  if (config.screenshotMediaRequestGate && finalActiveLeases !== 0) {
    failure ||= `Screenshot media gate finished with ${finalActiveLeases} active lease(s)`;
  }
  await finalize();
});
ipcMain.handle("renderkit:fail", async (_event, message) => {
  failure = String(message);
  await finalize();
});

app.whenReady().then(async () => {
  if (!await prepareProductionDecoderBackend()) {
    await finalize();
    return;
  }
  await prepareProxyTreeEntry();
  await prepareScreenshotEntry();
  if (!directMux) payloadStream = createWriteStream(rawPath);
  if (config.trace) {
    await contentTracing.startRecording({
      included_categories: ["toplevel", "gpu", "media", "video", "disabled-by-default-media", "disabled-by-default-gpu.service"],
      recording_mode: "record-until-full",
    });
  }

  window = new BrowserWindow({
    show: screenshotCaptureMode
      ? config.screenshotWindowMode !== "offscreen"
      : config.showWindow,
    width: screenshotCaptureMode && config.screenshotWindowMode !== "emulated"
      ? config.width
      : Math.min(config.width, 1920),
    height: screenshotCaptureMode && config.screenshotWindowMode !== "emulated"
      ? config.height
      : Math.min(config.height, 1080),
    useContentSize: screenshotCaptureMode && config.screenshotWindowMode !== "emulated",
    frame: !screenshotCaptureMode,
    backgroundColor: "#000000",
    paintWhenInitiallyHidden: true,
    webPreferences: {
      partition: renderSessionPartition,
      preload: resolve(rendererRoot, "preload.mjs"),
      contextIsolation: true,
      sandbox: false,
      nodeIntegration: false,
      backgroundThrottling: false,
      autoplayPolicy: "no-user-gesture-required",
      webSecurity: false,
      ...(screenshotCaptureMode && config.screenshotWindowMode === "offscreen"
        ? { offscreen: { useSharedTexture: false } }
        : {}),
    },
  });
  startMemoryWatchdog();
  installScreenshotMediaGate();
  window.webContents.on("console-message", (_event, details) => console.log(`FULL_CANVAS_RENDERER ${details.level}: ${details.message}`));
  window.webContents.on("render-process-gone", (_event, details) => {
    failure = `Renderer process gone: ${JSON.stringify(details)}`;
    finalize();
  });
  window.on("unresponsive", () => {
    if (finalized) return;
    failure ||= "Render window became unresponsive";
    finalize();
  });
  window.on("closed", () => {
    if (finalized) return;
    failure ||= "Render window closed before output validation and commit";
    finalize();
  });
  if (screenshotCaptureMode && config.screenshotWindowMode === "emulated") {
    // Electron 43 crashes if device emulation is enabled before a renderer
    // target exists. Bootstrap an empty document first, then apply the exact
    // virtual viewport before loading any project code.
    await window.loadURL("about:blank");
    window.webContents.debugger.attach("1.3");
    screenshotDebuggerAttached = true;
    window.webContents.debugger.once("detach", (_event, reason) => {
      screenshotDebuggerAttached = false;
      if (finalized) return;
      failure ||= `Screenshot debugger detached before completion: ${reason}`;
      finalize();
    });
    await window.webContents.debugger.sendCommand("Emulation.setDeviceMetricsOverride", {
      width: config.width,
      height: config.height,
      deviceScaleFactor: 1,
      mobile: false,
      screenWidth: config.width,
      screenHeight: config.height,
      positionX: 0,
      positionY: 0,
      scale: 1,
      screenOrientation: { type: "landscapePrimary", angle: 0 },
    });
    await window.webContents.debugger.sendCommand("Emulation.setVisibleSize", {
      width: config.width,
      height: config.height,
    });
  }
  await window.loadFile(loadEntry);
  const nestedCompositionBootstrap = await window.webContents.executeJavaScript(`(() => ({
    hosts: [...document.querySelectorAll('[data-composition-src],[data-composition-file]')].map((host, index) => ({
      index,
      key: host.id || host.getAttribute('data-hf-id') || String(index),
      id: host.id || null,
      hfId: host.getAttribute('data-hf-id'),
      compositionId: host.getAttribute('data-composition-id'),
      start: host.getAttribute('data-start'),
      duration: host.getAttribute('data-duration'),
      trackIndex: host.getAttribute('data-track-index'),
    })),
  }))()`);
  if (nestedCompositionBootstrap.hosts.length > 0 && !config.hyperframesRuntimeEnabled) {
    throw new Error(
      `Entry declares ${nestedCompositionBootstrap.hosts.length} nested composition(s), `
      + "but --hyperframesRuntime was not provided; refusing to render an unexpanded entry",
    );
  }
  if (config.hyperframesRuntimeEnabled) {
    const hyperframesRuntimeSource = readFileSync(config.hyperframesRuntimePath, "utf8");
    await window.webContents.executeJavaScript(
      `${hyperframesRuntimeSource}\n//# sourceURL=hyperframe.runtime.iife.js`,
    );
    await window.webContents.executeJavaScript(`new Promise((resolveReady, rejectReady) => {
      const expected = ${nestedCompositionBootstrap.hosts.length};
      const timeoutMs = ${hyperframesRuntimeTimeoutMs};
      const started = performance.now();
      const timer = setInterval(() => {
        const player = window.__player;
        const duration = typeof player?.getDuration === 'function' ? Number(player.getDuration()) : 0;
        const innerRoots = document.querySelectorAll('[data-hf-inner-root]').length;
        const timelineKeys = Object.keys(window.__timelines || {});
        const ready = player && duration > 0 && innerRoots >= expected;
        if (ready) {
          clearInterval(timer);
          resolveReady({ duration, innerRoots, timelineKeys });
          return;
        }
        if (performance.now() - started > timeoutMs) {
          clearInterval(timer);
          rejectReady(new Error(
            'HyperFrames runtime readiness timeout: nested=' + expected
            + ', inner=' + innerRoots + ', duration=' + duration
            + ', timelines=' + timelineKeys.join(',')
          ));
        }
      }, 25);
    })`);
    await window.webContents.executeJavaScript(`(() => {
      const descriptors = ${JSON.stringify(nestedCompositionBootstrap.hosts)};
      for (const descriptor of descriptors) {
        const host = descriptor.id
          ? document.getElementById(descriptor.id)
          : descriptor.hfId
            ? document.querySelector('[data-hf-id="' + CSS.escape(descriptor.hfId) + '"]')
            : document.querySelectorAll('[data-composition-src],[data-composition-file]')[descriptor.index];
        if (!host) throw new Error('Nested composition host disappeared: ' + descriptor.key);
        for (const [name, value] of [
          ['data-start', descriptor.start],
          ['data-duration', descriptor.duration],
          ['data-track-index', descriptor.trackIndex],
        ]) {
          if (value == null) host.removeAttribute(name);
          else host.setAttribute(name, value);
        }
        if (!host.querySelector('[data-hf-inner-root]')) {
          throw new Error('Nested composition did not expand: ' + descriptor.key);
        }
        if (!descriptor.compositionId || !window.__timelines?.[descriptor.compositionId]) {
          throw new Error('Nested composition timeline missing: ' + (descriptor.compositionId || descriptor.key));
        }
      }
      return { nestedCompositionsExpanded: descriptors.length };
    })()`);
  }
  const mediaTimingRuntimeSource = readFileSync(resolve(rendererRoot, "media-timing-runtime.js"), "utf8");
  const decoderLaneAllocatorSource = readFileSync(resolve(rendererRoot, "decoder-lane-allocator.js"), "utf8");
  const boundedMetricsRecorderSource = readFileSync(resolve(rendererRoot, "bounded-metrics-recorder.js"), "utf8");
  const rendererSource = readFileSync(resolve(rendererRoot, "full-canvas-renderer.js"), "utf8");
  await window.webContents.executeJavaScript(
    `${mediaTimingRuntimeSource}\n//# sourceURL=media-timing-runtime.js\n`
    + `${decoderLaneAllocatorSource}\n//# sourceURL=decoder-lane-allocator.js\n`
    + `${boundedMetricsRecorderSource}\n//# sourceURL=bounded-metrics-recorder.js\n`
    + `${rendererSource}\n//# sourceURL=full-canvas-renderer.js`,
  );
}).catch(async (error) => {
  failure = error?.stack || String(error);
  await finalize();
});
