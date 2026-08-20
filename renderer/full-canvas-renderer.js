const MEDIA_TARGET_GRID_ULP_MULTIPLIER = 16;

function cfrFrameIndexForMediaTime(target, frameRate) {
  if (!Number.isFinite(target) || !Number.isFinite(frameRate) || frameRate <= 0) return null;
  const framePosition = target * frameRate;
  const roundoffTolerance = Number.EPSILON
    * Math.max(1, Math.abs(framePosition))
    * MEDIA_TARGET_GRID_ULP_MULTIPLIER;
  return Math.max(0, Math.floor(framePosition + roundoffTolerance));
}

function mediaTargetForMode(rawTarget, frameRate, mode) {
  if (!Number.isFinite(rawTarget)) throw new Error(`Invalid raw media target: ${rawTarget}`);
  if (mode === "exact") {
    return {
      rawTarget,
      decoderTarget: rawTarget,
      targetSnapDelta: 0,
      targetFrameIndex: null,
    };
  }
  if (mode !== "frame-grid") throw new Error(`Unsupported media target mode: ${mode}`);
  const targetFrameIndex = cfrFrameIndexForMediaTime(rawTarget, frameRate);
  const decoderTarget = targetFrameIndex / frameRate;
  return {
    rawTarget,
    decoderTarget,
    targetSnapDelta: decoderTarget - rawTarget,
    targetFrameIndex,
  };
}

function mediaTargetAtOrPastEnd(target, duration, frameRate) {
  return Number.isFinite(duration)
    && target >= Math.max(0, duration - 1 / frameRate / 2);
}

function isVideoProxyElement(element) {
  return element instanceof HTMLCanvasElement && element.hasAttribute("data-hf-video-proxy");
}

function isVideoClipElement(element) {
  return element instanceof HTMLVideoElement || isVideoProxyElement(element);
}

function declaredMediaElementSource(element) {
  if (isVideoProxyElement(element)) {
    return String(element.dataset.hfVideoSrc || "").trim() || null;
  }
  const selected = String(element.currentSrc || "").trim();
  if (selected) return selected;
  const direct = String(element.getAttribute("src") || "").trim();
  if (direct) return direct;
  const nested = element.querySelector(":scope > source[src]")?.getAttribute("src");
  return String(nested || "").trim() || null;
}

function computedColorAlpha(color) {
  const value = String(color ?? "").trim().toLowerCase();
  if (value === "transparent") return 0;
  const rgba = value.match(/^rgba?\((.+)\)$/);
  if (rgba) {
    const slashAlpha = rgba[1].match(/\/\s*([\d.]+%?)/);
    const commaParts = rgba[1].split(",").map((part) => part.trim());
    const rawAlpha = slashAlpha?.[1] ?? (commaParts.length === 4 ? commaParts[3] : "1");
    if (String(rawAlpha).endsWith("%")) return Number.parseFloat(rawAlpha) / 100;
    return Number(rawAlpha);
  }
  const colorFunctionAlpha = value.match(/\/\s*([\d.]+%?)\s*\)$/);
  if (colorFunctionAlpha) {
    return colorFunctionAlpha[1].endsWith("%")
      ? Number.parseFloat(colorFunctionAlpha[1]) / 100
      : Number(colorFunctionAlpha[1]);
  }
  return value ? 1 : null;
}

function authoredBackgroundState(element) {
  const style = getComputedStyle(element);
  return {
    color: style.backgroundColor,
    colorAlpha: computedColorAlpha(style.backgroundColor),
    image: style.backgroundImage,
  };
}

let partialResults = (error = null) => ({
  partial: true,
  failureStage: "setup",
  failure: error?.stack || (error == null ? null : String(error)),
});
let activeProductionDecoder = null;

async function disposeActiveProductionDecoder() {
  if (!activeProductionDecoder) return null;
  const active = activeProductionDecoder;
  activeProductionDecoder = null;
  const beforeDispose = active.runtime.snapshot();
  await active.runtime.dispose();
  const afterDispose = active.runtime.snapshot();
  const brokerAfterRendererDispose = await active.api.decoderStats();
  active.support.productionDecoder.final = {
    beforeDispose,
    afterDispose,
    brokerAfterRendererDispose,
  };
  if (afterDispose.activeSources !== 0
      || afterDispose.activeLanes !== 0
      || afterDispose.frameBudget.outstandingFrames !== 0
      || brokerAfterRendererDispose.activeSources !== 0
      || brokerAfterRendererDispose.activeCursors !== 0
      || brokerAfterRendererDispose.byteBudget.currentBytes !== 0
      || brokerAfterRendererDispose.byteBudget.activeLeases !== 0) {
    throw new Error("Production decoder renderer resources did not return to zero");
  }
  return active.support.productionDecoder.final;
}

async function runFullCanvasRender() {
  const api = window.hyperframesRenderKit;
  const config = await api.getConfig();
  const {
    width,
    height,
    fps,
    frames,
    start,
    startFrame,
    bitrate,
    bitrateMode,
    queueLimit,
    queueLowWatermark,
    queueBackpressureMode,
    payloadWriteWindow,
    payloadWriteLowWatermark,
    maxPendingPayloadBytes,
    pendingPayloadLowWatermarkBytes,
    resourceBudget,
    waitMode,
    paintTimeoutMs,
    seekTimeoutMs,
    compositeMode,
    outputBackend,
    screenshotMediaPolicy,
    screenshotMediaRequestGate,
    mediaFrameMode,
    mediaSeekBiasFrames,
    mediaAdvanceMode,
    mediaTargetMode,
    mediaTailPolicy,
    mediaPlaybackRate,
    mediaOvershootToleranceFrames,
    mediaDecoderLanesTotal,
    mediaDecoderLanesPerSource,
    mediaDecoderIdleFrames,
    mediaDecoderBackend,
    productionDecoderRuntimeUrl,
    productionDecoderSources = [],
    productionDecoderRoutePath,
    productionDecoderLimits,
    frameMetricsMode,
    frameMetricsHead,
    frameMetricsTail,
    frameMetricsSampleEvery,
    frameMetricsMaxFrames,
    frameMetricsMaxBytes,
    frameMetricsSlowMs,
    mediaSourceMap = [],
    mediaSourceMapPath,
    mediaSourceMapVerify,
    mediaSourceMapRecipeKey,
    canonicalMediaRoutePath,
    canonicalMediaRouteVerify,
    canonicalMediaRouteIdentity,
    canonicalMediaRouteMappings = [],
    mediaTimingPlans = [],
    mediaTimingPlanPath,
    mediaTimingPlanVerify,
    proxyTreeTransform,
    screenshotEntryTransform,
    partialOpacityPolicy = "preserve",
    hyperframesRuntimeEnabled = false,
    diagnostics,
    domProbeSelectors = [],
    domProbeFrames = [],
  } = config;
  const nativeScreenshot = compositeMode === "screenshot";
  const webcodecsOutput = outputBackend === "webcodecs";
  const productionDecoderEnabled = mediaDecoderBackend === "production-webcodecs";
  if (productionDecoderEnabled && (nativeScreenshot
      || !["layered", "proxy-tree"].includes(compositeMode)
      || mediaTargetMode !== "timing-plan"
      || mediaFrameMode !== "video")) {
    throw new Error("production-webcodecs renderer contract mismatch; HTMLVideo fallback is forbidden");
  }
  if (canonicalMediaRouteMappings.length && (!productionDecoderEnabled
      || nativeScreenshot
      || !["layered", "proxy-tree"].includes(compositeMode)
      || mediaTargetMode !== "timing-plan"
      || mediaFrameMode !== "video")) {
    throw new Error("canonical media route renderer contract mismatch; source fallback is forbidden");
  }
  if ((canonicalMediaRouteMappings.length > 0) !== Boolean(canonicalMediaRoutePath)
      || (canonicalMediaRouteMappings.length > 0) !== Boolean(canonicalMediaRouteIdentity)) {
    throw new Error("canonical media route path/identity/mapping set is incomplete");
  }
  if (canonicalMediaRouteIdentity
      && !/^[a-f0-9]{64}$/.test(canonicalMediaRouteIdentity)) {
    throw new Error("canonical media route identity must be a SHA-256 digest");
  }
  if (canonicalMediaRouteMappings.length
      && !["stat", "sha256", "full"].includes(canonicalMediaRouteVerify)) {
    throw new Error(`Unsupported canonical media route verification mode: ${canonicalMediaRouteVerify}`);
  }

  await document.fonts?.ready;
  const readyStartedAt = performance.now();
  while (!window.__timelines?.main) {
    if (performance.now() - readyStartedAt > 30_000) throw new Error("Master timeline did not initialize");
    await new Promise((resolveWait) => setTimeout(resolveWait, 20));
  }

  const root = document.querySelector("[data-composition-id]");
  if (!root) throw new Error("Composition root is missing");
  const staticVideoElements = [...root.querySelectorAll("video")];
  const staticVideoProxies = [...root.querySelectorAll("canvas[data-hf-video-proxy]")];
  if (nativeScreenshot) {
    if (screenshotEntryTransform?.videoCount !== staticVideoElements.length) {
      throw new Error(
        `Screenshot preload transform expected ${screenshotEntryTransform?.videoCount ?? "unknown"} video(s); `
        + `DOM contains ${staticVideoElements.length}`,
      );
    }
    for (const [index, video] of staticVideoElements.entries()) {
      const expected = screenshotEntryTransform.videos?.[index];
      const authoredPreload = video.hasAttribute("preload") ? video.getAttribute("preload") : null;
      if (!expected
          || expected.id !== (video.id || null)
          || expected.authoredPreload !== authoredPreload) {
        throw new Error(`Screenshot entry audit no longer matches authored video ${index}`);
      }
    }
  }
  if (compositeMode === "proxy-tree") {
    if (staticVideoElements.length) {
      throw new Error(`proxy-tree early transform left ${staticVideoElements.length} live <video> element(s)`);
    }
    if (!staticVideoProxies.length) throw new Error("proxy-tree early transform produced no video proxy canvases");
    if (proxyTreeTransform?.proxyCount !== staticVideoProxies.length) {
      throw new Error(
        `proxy-tree transform report expected ${proxyTreeTransform?.proxyCount ?? "unknown"} proxies; `
        + `DOM contains ${staticVideoProxies.length}`,
      );
    }
    for (const [index, proxy] of staticVideoProxies.entries()) {
      const descriptor = proxyTreeTransform.proxies?.[index];
      const declared = declaredMediaElementSource(proxy);
      const declaredUrl = declared ? new URL(declared, document.baseURI).href : null;
      if (!descriptor || declaredUrl !== descriptor.sourceUrl) {
        throw new Error(
          `proxy-tree source descriptor changed before renderer startup at proxy ${index}: `
          + `${declaredUrl ?? "missing"} !== ${descriptor?.sourceUrl ?? "missing transform descriptor"}`,
        );
      }
      const declaredSourceWidth = Number(proxy.dataset.hfVideoSourceWidth || 0) || null;
      const declaredSourceHeight = Number(proxy.dataset.hfVideoSourceHeight || 0) || null;
      const expectedSourceWidth = descriptor.intrinsicSize?.sourceWidth ?? null;
      const expectedSourceHeight = descriptor.intrinsicSize?.sourceHeight ?? null;
      if (declaredSourceWidth !== expectedSourceWidth || declaredSourceHeight !== expectedSourceHeight) {
        throw new Error(
          `proxy-tree intrinsic source descriptor changed before renderer startup at proxy ${index}: `
          + `${declaredSourceWidth ?? "missing"}x${declaredSourceHeight ?? "missing"} !== `
          + `${expectedSourceWidth ?? "missing"}x${expectedSourceHeight ?? "missing"}`,
        );
      }
    }
  } else if (staticVideoProxies.length) {
    throw new Error(`Found ${staticVideoProxies.length} data-hf-video-proxy canvas(es) outside proxy-tree mode`);
  }
  const timeline = window.__timelines.main;
  const authoredRootWidth = Number(root.dataset.width || root.offsetWidth || width);
  const authoredRootHeight = Number(root.dataset.height || root.offsetHeight || height);
  const scaleCapturedHtmlBands = Number.isFinite(authoredRootWidth)
    && Number.isFinite(authoredRootHeight)
    && authoredRootWidth > 0
    && authoredRootHeight > 0
    && (Math.abs(authoredRootWidth - width) > 0.5 || Math.abs(authoredRootHeight - height) > 0.5);
  const nestedCompositionHosts = [...root.querySelectorAll(":scope > [data-composition-src], :scope > [data-composition-file]")];
  if (nestedCompositionHosts.length > 0 && !hyperframesRuntimeEnabled) {
    throw new Error(
      `Entry contains ${nestedCompositionHosts.length} nested composition(s), `
      + "but the HyperFrames runtime was not injected",
    );
  }
  for (const host of nestedCompositionHosts) {
    const compositionId = host.dataset.compositionId;
    if (!host.querySelector("[data-hf-inner-root]")) {
      throw new Error(`Nested composition was not expanded: ${host.id || compositionId || "unknown"}`);
    }
    if (!compositionId || !window.__timelines?.[compositionId]) {
      throw new Error(`Nested composition timeline is missing: ${compositionId || host.id || "unknown"}`);
    }
  }
  const allTopLevelClipElements = [...root.querySelectorAll(":scope > .clip")];
  const hiddenTopLevelClipElements = allTopLevelClipElements.filter((element) => (
    element.hasAttribute("hidden")
    || element.hasAttribute("data-hidden")
  ));
  for (const element of hiddenTopLevelClipElements) element.style.visibility = "hidden";
  const topLevelClips = allTopLevelClipElements
    .filter((element) => (
      !element.hasAttribute("hidden")
      && !element.hasAttribute("data-hidden")
    ))
    .map((element, order) => ({
    element,
    order,
    start: Number(element.dataset.start || 0),
    duration: Number(element.dataset.duration || Number.POSITIVE_INFINITY),
    end: Number(element.dataset.start || 0) + Number(element.dataset.duration || Number.POSITIVE_INFINITY),
    track: Number(element.dataset.trackIndex || 0),
    mediaStart: Number(element.dataset.mediaStart || 0),
    compositionId: element.dataset.compositionId || null,
    isVideo: isVideoClipElement(element),
    isVideoProxy: isVideoProxyElement(element),
    src: isVideoClipElement(element) ? declaredMediaElementSource(element) : null,
    }));
  const videos = topLevelClips.filter((clip) => clip.isVideo);
  const missingVideoSources = videos.filter((clip) => !clip.src);
  if (missingVideoSources.length) {
    throw new Error(
      `Composition video clip(s) have no selected src or nested <source>: `
      + missingVideoSources.map((clip) => clip.element.id || `(order ${clip.order})`).join(", "),
    );
  }
  const audioElements = [...root.querySelectorAll(":scope > audio")];
  const audioClips = audioElements.filter((element) => (
    !element.hasAttribute("hidden")
    && !element.hasAttribute("data-hidden")
  )).map((element) => ({
    id: element.id,
    src: element.getAttribute("src"),
    start: Number(element.dataset.start || 0),
    duration: Number(element.dataset.duration || 0),
    end: Number(element.dataset.start || 0) + Number(element.dataset.duration || 0),
    mediaStart: Number(element.dataset.mediaStart || 0),
    volume: Number(element.dataset.volume ?? 1),
    track: Number(element.dataset.trackIndex || 0),
  }));
  const useManualMediaBackend = !nativeScreenshot
    && (compositeMode === "layered" || compositeMode === "proxy-tree");
  const useDecoderDeck = useManualMediaBackend && !productionDecoderEnabled;
  const decoderSourceMap = new Map(mediaSourceMap.map((entry) => [entry.sourceUrl, entry]));
  const timingRuntime = window.HyperframesMediaTiming ?? null;
  if (mediaTargetMode === "timing-plan" && !timingRuntime) {
    throw new Error("Media timing runtime was not installed");
  }
  const timingBySource = new Map(mediaTimingPlans.map((entry) => [entry.sourceUrl, {
    ...entry,
    query: timingRuntime?.createQuery(entry.plan) ?? null,
  }]));
  const canonicalSourceUrls = new Set();
  for (const mapping of canonicalMediaRouteMappings) {
    if (canonicalSourceUrls.has(mapping.sourceUrl)) {
      throw new Error(`Duplicate canonical media route source URL: ${mapping.sourceUrl}`);
    }
    canonicalSourceUrls.add(mapping.sourceUrl);
    const effectiveMappings = mediaSourceMap.filter((entry) => entry.sourceUrl === mapping.sourceUrl);
    if (effectiveMappings.length !== 1
        || effectiveMappings[0].source !== mapping.source
        || effectiveMappings[0].cache !== mapping.cache
        || effectiveMappings[0].cacheUrl !== mapping.cacheUrl) {
      throw new Error(`Canonical media route is not the unique decoder mapping for ${mapping.source}`);
    }
    const sourceTiming = timingBySource.get(mapping.sourceUrl);
    const cacheTiming = timingBySource.get(mapping.cacheUrl);
    if (!sourceTiming?.roles.includes("composition")
        || sourceTiming.source !== mapping.source
        || sourceTiming.plan.source.identity !== mapping.canonical?.sourceIdentity) {
      throw new Error(`Canonical media route source timing identity changed for ${mapping.source}`);
    }
    if (!cacheTiming?.roles.includes("decoder-cache")
        || !cacheTiming.mapsFrom.includes(mapping.source)
        || cacheTiming.source !== mapping.cache
        || cacheTiming.plan.source.identity !== mapping.canonical?.cacheIdentity) {
      throw new Error(`Canonical media route cache timing identity changed for ${mapping.cache}`);
    }
    if (mapping.frameRate !== fps
        || cacheTiming.plan.presentation.frameCount !== mapping.canonical?.frameCount
        || mapping.recipeKey !== mapping.canonical?.recipeHash
        || !/^[a-f0-9]{64}$/.test(mapping.canonical?.frameMapSha256 ?? "")) {
      throw new Error(`Canonical media route frame contract changed for ${mapping.cache}`);
    }
  }
  const compositionVideoSources = new Set(videos.map((clip) => new URL(clip.src, document.baseURI).href));
  const unusedMappings = mediaSourceMap.filter((entry) => !compositionVideoSources.has(entry.sourceUrl));
  if (unusedMappings.length) {
    throw new Error(`mediaSourceMap source is not used by this composition: ${unusedMappings.map((entry) => entry.source).join(", ")}`);
  }
  if (mediaTargetMode === "timing-plan") {
    const declaredVideoSources = new Set();
    for (const mediaElement of root.querySelectorAll("video,canvas[data-hf-video-proxy]")) {
      const declared = declaredMediaElementSource(mediaElement);
      if (declared) declaredVideoSources.add(new URL(declared, document.baseURI).href);
      if (mediaElement instanceof HTMLVideoElement) {
        for (const source of mediaElement.querySelectorAll("source[src]")) {
          declaredVideoSources.add(new URL(source.getAttribute("src"), document.baseURI).href);
        }
      }
    }
    const missingPlans = [...declaredVideoSources].filter((source) => !timingBySource.has(source));
    if (missingPlans.length) {
      throw new Error(`mediaTimingPlan has no plan for live composition video source(s): ${missingPlans.join(", ")}`);
    }
    const stalePlans = mediaTimingPlans
      .filter((entry) => entry.roles.includes("composition"))
      .filter((entry) => !declaredVideoSources.has(entry.sourceUrl));
    if (stalePlans.length) {
      throw new Error(`mediaTimingPlan contains stale composition source(s): ${stalePlans.map((entry) => entry.source).join(", ")}`);
    }
    const missingDecoderPlans = mediaSourceMap
      .filter((entry) => !timingBySource.has(entry.cacheUrl));
    if (missingDecoderPlans.length) {
      throw new Error(
        `mediaTimingPlan has no plan for mapped decoder cache(s): `
        + missingDecoderPlans.map((entry) => entry.cache).join(", "),
      );
    }
  }
  const productionSourceByUrl = new Map(productionDecoderSources.map((entry) => [entry.sourceUrl, entry]));
  let productionDecoderModule = null;
  let productionDecoderRuntime = null;
  let productionDecoderInitial = null;
  if (productionDecoderEnabled) {
    if (!productionDecoderRuntimeUrl || productionSourceByUrl.size === 0) {
      throw new Error("production-webcodecs runtime/source allow-list is missing");
    }
    productionDecoderModule = await import(productionDecoderRuntimeUrl);
    productionDecoderRuntime = productionDecoderModule.createProductionDecoderRuntime({
      bridge: api,
      limits: {
        maxTotalLanes: mediaDecoderLanesTotal,
        maxLanesPerSource: mediaDecoderLanesPerSource,
        idleUnloadFrames: mediaDecoderIdleFrames,
        decodeQueueMax: productionDecoderLimits.decodeQueueMax,
        decodeLeadMax: productionDecoderLimits.decodeLeadMax,
        readyFramesMax: productionDecoderLimits.readyFramesMax,
        maxWarmAdvanceFrames: productionDecoderLimits.maxWarmAdvanceFrames,
        batchSize: productionDecoderLimits.maximumBatchPackets,
      },
    });
    activeProductionDecoder = { runtime: productionDecoderRuntime, api, support: { productionDecoder: {} } };
    const openDecisions = [];
    for (const descriptor of productionDecoderSources) {
      const timing = timingBySource.get(descriptor.sourceUrl);
      if (!timing || timing.plan.source.identity !== descriptor.sourceIdentity) {
        throw new Error(`Production decoder timing/source identity mismatch for ${descriptor.source}`);
      }
      const opened = await productionDecoderRuntime.openSource({
        sourceToken: descriptor.sourceToken,
        sourceIdentity: descriptor.sourceIdentity,
      });
      if (opened.decision !== productionDecoderModule.DIRECT_DECISION) {
        const code = opened.info?.reason?.code ?? "CACHE_REQUIRED_DURING_RENDERER_OPEN";
        throw new Error(`${code}: production source was not direct after main preflight`);
      }
      openDecisions.push({
        source: descriptor.source,
        sourceIdentity: descriptor.sourceIdentity,
        decision: opened.decision,
        codec: opened.summary.codec,
        sampleEntry: opened.summary.sampleEntry,
        presentationFrameCount: opened.summary.presentationFrameCount,
        maximumPresentationReorderDepth: opened.summary.maximumPresentationReorderDepth,
        indexDigest: opened.summary.indexDigest,
      });
    }
    productionDecoderInitial = {
      exactPts: true,
      htmlVideoFallback: false,
      routePath: productionDecoderRoutePath,
      openDecisions,
      runtime: productionDecoderRuntime.snapshot(),
      broker: await api.decoderStats(),
    };
  }
  const decoderBySource = new Map();
  const decoderByLaneId = new Map();
  const mediaStates = new Map();
  const mediaCalibrationByDecoder = new Map();
  let decoderSerial = 0;
  const loadedNativeVideos = new Set();
  const decoderDeck = useDecoderDeck ? document.createElement("div") : null;
  if (decoderDeck) {
    decoderDeck.id = "__full_canvas_decoder_deck";
    decoderDeck.style.cssText = "position:fixed;left:0;top:0;width:16px;height:16px;overflow:hidden;z-index:2147483647;pointer-events:none";
    document.body.appendChild(decoderDeck);
  }
  if (useManualMediaBackend) {
    for (const clip of videos) {
      if (!(clip.element instanceof HTMLVideoElement)) continue;
      clip.element.pause();
      clip.element.removeAttribute("src");
      for (const source of clip.element.querySelectorAll(":scope > source[src]")) {
        source.removeAttribute("src");
      }
      clip.element.preload = "none";
      clip.element.load();
    }
  }

  const decoderLaneRuntime = window.HyperframesDecoderLanes ?? null;
  if (useDecoderDeck && mediaTargetMode === "timing-plan" && !decoderLaneRuntime) {
    throw new Error("Timing-plan decoder lane allocator was not installed");
  }
  const timingDecoderLanes = useDecoderDeck && mediaTargetMode === "timing-plan"
    ? decoderLaneRuntime.createDecoderLaneAllocator({
      maxTotalLanes: mediaDecoderLanesTotal,
      maxLanesPerSource: mediaDecoderLanesPerSource,
      idleUnloadFrames: mediaDecoderIdleFrames,
    })
    : null;

  function decoderDescriptorForClip(clip) {
    const source = new URL(clip.src, document.baseURI).href;
    const mappedSource = decoderSourceMap.get(source) ?? null;
    return {
      source,
      mappedSource,
      decoderSource: mappedSource?.cacheUrl ?? source,
    };
  }

  function productionDescriptorForClip(clip) {
    const { decoderSource } = decoderDescriptorForClip(clip);
    const descriptor = productionSourceByUrl.get(decoderSource) ?? null;
    if (!descriptor) {
      throw new Error(`PRODUCTION_DECODER_SOURCE_NOT_APPROVED: ${decoderSource}`);
    }
    return descriptor;
  }

  function createDeckDecoder(id) {
    const decoder = document.createElement("video");
    decoder.id = id;
    decoder.preload = "auto";
    decoder.muted = true;
    decoder.playsInline = true;
    decoder.style.cssText = "position:absolute;inset:0;width:16px;height:16px;object-fit:cover;opacity:.01;pointer-events:none";
    decoderDeck.appendChild(decoder);
    return decoder;
  }

  function configureDeckDecoder(decoder, descriptor, { laneId = null, generation = null } = {}) {
    decoder.pause();
    decoder.removeAttribute("src");
    decoder.load();
    mediaStates.delete(decoder);
    mediaCalibrationByDecoder.delete(decoder);
    decoder.preload = "auto";
    decoder.src = descriptor.decoderSource;
    decoder.dataset.originalSource = descriptor.source;
    decoder.dataset.mappedSource = descriptor.mappedSource?.cacheUrl ?? "";
    decoder.dataset.mappedFrameRate = descriptor.mappedSource?.frameRate
      ? String(descriptor.mappedSource.frameRate)
      : "";
    decoder.dataset.timingSource = descriptor.decoderSource;
    decoder.dataset.decoderLaneId = laneId ?? "";
    decoder.dataset.decoderLaneGeneration = generation == null ? "" : String(generation);
  }

  function decoderForClip(clip) {
    if (productionDecoderEnabled) {
      throw new Error("PRODUCTION_HTMLVIDEO_FALLBACK_FORBIDDEN: exact VideoFrame was not prepared");
    }
    if (!useDecoderDeck) return clip.element;
    const descriptor = decoderDescriptorForClip(clip);
    let decoder = decoderBySource.get(descriptor.source);
    if (!decoder) {
      decoder = createDeckDecoder(`__decoder_${decoderSerial++}`);
      configureDeckDecoder(decoder, descriptor);
      decoderBySource.set(descriptor.source, decoder);
    }
    return decoder;
  }

  function timingPresentationKey(timing, selection) {
    return `${timing.plan.source.identity}:${selection.streamIndex}:${selection.ptsTicks}`;
  }

  function clipLaneKey(clip) {
    return clip.element.id || `video-order-${clip.order}`;
  }

  function decoderForTimingSelection(clip, timing, selection) {
    if (!timingDecoderLanes) {
      return {
        decoder: decoderForClip(clip),
        allocation: null,
        descriptor: decoderDescriptorForClip(clip),
      };
    }
    const descriptor = decoderDescriptorForClip(clip);
    const allocation = timingDecoderLanes.claim({
      sourceKey: descriptor.decoderSource,
      presentationKey: timingPresentationKey(timing, selection),
      clipKey: clipLaneKey(clip),
    });
    let decoder = decoderByLaneId.get(allocation.laneId);
    if (!decoder) {
      decoder = createDeckDecoder(`__${allocation.laneId.replaceAll("-", "_")}`);
      decoderByLaneId.set(allocation.laneId, decoder);
    }
    const configuredGeneration = Number(decoder.dataset.decoderLaneGeneration || Number.NaN);
    if (allocation.sourceChanged
        || configuredGeneration !== allocation.generation
        || decoder.dataset.timingSource !== descriptor.decoderSource) {
      configureDeckDecoder(decoder, descriptor, {
        laneId: allocation.laneId,
        generation: allocation.generation,
      });
    }
    return { decoder, allocation, descriptor };
  }

  function releaseDecoderLaneSource(laneId) {
    const decoder = decoderByLaneId.get(laneId);
    if (!decoder) return;
    if (!decoder.paused) decoder.pause();
    decoder.removeAttribute("src");
    decoder.preload = "none";
    decoder.load();
    decoder.dataset.originalSource = "";
    decoder.dataset.mappedSource = "";
    decoder.dataset.mappedFrameRate = "";
    decoder.dataset.timingSource = "";
    decoder.dataset.decoderLaneGeneration = "";
    mediaStates.delete(decoder);
    mediaCalibrationByDecoder.delete(decoder);
  }

  function timingForClip(clip) {
    const { decoderSource } = decoderDescriptorForClip(clip);
    const timing = timingBySource.get(decoderSource) ?? null;
    if (mediaTargetMode === "timing-plan" && !timing) {
      throw new Error(`No verified timing plan for decoder source ${decoderSource}`);
    }
    return timing;
  }

  for (const audio of audioElements) {
    audio.pause();
    audio.style.display = "none";
  }

  const authoredBackgrounds = {
    root: authoredBackgroundState(root),
    body: authoredBackgroundState(document.body),
    html: authoredBackgroundState(document.documentElement),
  };
  if (compositeMode === "proxy-tree") {
    const visibleAncestorBackground = [authoredBackgrounds.body, authoredBackgrounds.html].some((background) => (
      Number(background.colorAlpha) > 1e-7 || background.image !== "none"
    ));
    if (visibleAncestorBackground && !(Number(authoredBackgrounds.root.colorAlpha) >= 1 - 1e-7)) {
      const error = new Error(
        "HF_PROXY_ANCESTOR_BACKGROUND_UNSUPPORTED: proxy-tree cannot capture html/body background "
        + "through a transparent or non-provably-opaque composition root; give the root an opaque "
        + "background or use layered",
      );
      error.code = "HF_PROXY_ANCESTOR_BACKGROUND_UNSUPPORTED";
      error.blocker = true;
      error.details = authoredBackgrounds;
      throw error;
    }
  }
  const canvas = document.createElement("canvas");
  canvas.id = "__full_canvas_capture";
  canvas.setAttribute("layoutsubtree", "");
  canvas.width = nativeScreenshot ? 1 : width;
  canvas.height = nativeScreenshot ? 1 : height;
  const transparentLayout = compositeMode === "layered";
  const preserveAuthoredBackground = compositeMode === "proxy-tree" || nativeScreenshot;
  if (nativeScreenshot) {
    canvas.style.display = "none";
    await new Promise((resolveFrame) => requestAnimationFrame(() => requestAnimationFrame(resolveFrame)));
    const rootRect = root.getBoundingClientRect();
    const dimensionTolerance = 0.01;
    if (window.innerWidth !== width || window.innerHeight !== height) {
      throw new Error(
        `HF_SCREENSHOT_VIEWPORT_MISMATCH: browser viewport is ${window.innerWidth}x${window.innerHeight}; `
        + `expected exact ${width}x${height}`,
      );
    }
    if (Math.abs(rootRect.left) > dimensionTolerance
        || Math.abs(rootRect.top) > dimensionTolerance
        || Math.abs(rootRect.width - width) > dimensionTolerance
        || Math.abs(rootRect.height - height) > dimensionTolerance) {
      throw new Error(
        `HF_SCREENSHOT_ROOT_BOUNDS_MISMATCH: composition root is `
        + `${rootRect.left},${rootRect.top} ${rootRect.width}x${rootRect.height}; `
        + `expected 0,0 ${width}x${height}`,
      );
    }
  } else {
    canvas.width = width;
    canvas.height = height;
    canvas.style.cssText = `display:block;position:absolute;inset:0;width:${width}px;height:${height}px;background:${transparentLayout ? "transparent" : "#000"}`;
    root.parentNode.insertBefore(canvas, root);
    canvas.appendChild(root);
    root.style.width = `${width}px`;
    root.style.height = `${height}px`;
    if (!preserveAuthoredBackground) {
      root.style.setProperty("background", transparentLayout ? "transparent" : "#000", "important");
    }
    document.documentElement.style.cssText += ";margin:0;overflow:hidden";
    document.body.style.cssText += `;margin:0;width:${width}px;height:${height}px;overflow:hidden`;
    if (!preserveAuthoredBackground) {
      document.documentElement.style.setProperty("background", transparentLayout ? "transparent" : "#000", "important");
      document.body.style.setProperty("background", transparentLayout ? "transparent" : "#000", "important");
    }
  }

  const tick = document.createElement("div");
  tick.style.cssText = "position:absolute;left:0;top:0;width:1px;height:1px;background:#000;opacity:.01";
  canvas.appendChild(tick);
  const invalidate = () => {
    tick.style.backgroundColor = tick.style.backgroundColor === "rgb(0, 0, 0)" ? "rgb(1, 1, 1)" : "rgb(0, 0, 0)";
    if (typeof canvas.requestPaint === "function") {
      canvas.requestPaint();
      return true;
    }
    return false;
  };
  const context = canvas.getContext("2d", { alpha: compositeMode === "layered", desynchronized: true });
  if (!nativeScreenshot && typeof context?.drawElementImage !== "function") {
    throw new Error("CanvasDrawElement is unavailable");
  }
  const outputCanvas = (compositeMode === "layered" || (nativeScreenshot && webcodecsOutput))
    ? document.createElement("canvas")
    : canvas;
  outputCanvas.width = width;
  outputCanvas.height = height;
  const outputContext = (compositeMode === "layered" || (nativeScreenshot && webcodecsOutput))
    ? outputCanvas.getContext("2d", { alpha: false, desynchronized: true })
    : context;
  const rootChildren = [...root.children];
  const clipByElement = new Map(topLevelClips.map((clip) => [clip.element, clip]));
  function promoteDynamicPartialOpacity(items) {
    if (partialOpacityPolicy !== "promote-dynamic") return [];
    const restorations = [];
    for (const item of items) {
      const candidates = [item.element, ...item.element.querySelectorAll("*")];
      for (const element of candidates) {
        if (!(element instanceof HTMLElement || element instanceof SVGElement)) continue;
        const inlineOpacity = element.style.opacity;
        if (inlineOpacity === "") continue;
        const opacity = Number(inlineOpacity);
        if (!Number.isFinite(opacity)) continue;
        if (opacity <= 0.001 || opacity >= 0.999) continue;
        restorations.push([element, inlineOpacity]);
        element.style.opacity = "1";
      }
    }
    return restorations;
  }

  function stackLevel(element) {
    const value = getComputedStyle(element).zIndex;
    if (value === "auto") return 0;
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : 0;
  }

  function positionFraction(token, axis) {
    const keywords = axis === "x"
      ? { left: 0, center: 0.5, right: 1 }
      : { top: 0, center: 0.5, bottom: 1 };
    if (token in keywords) return keywords[token];
    if (token.endsWith("%")) return Number.parseFloat(token) / 100;
    return 0.5;
  }

  function objectPosition(style) {
    const tokens = style.objectPosition.trim().toLowerCase().split(/\s+/);
    if (tokens.length === 1) {
      if (tokens[0] === "top" || tokens[0] === "bottom") return [0.5, positionFraction(tokens[0], "y")];
      return [positionFraction(tokens[0], "x"), 0.5];
    }
    return [positionFraction(tokens[0], "x"), positionFraction(tokens[1], "y")];
  }

  function proxyObjectPosition(style, clip) {
    const tokens = style.objectPosition.trim().toLowerCase().split(/\s+/).filter(Boolean);
    if (tokens.length < 1 || tokens.length > 2) {
      throw new Error(
        `proxy-tree does not yet support object-position ${style.objectPosition} on ${clipLaneKey(clip)}`,
      );
    }
    const normalized = tokens.length === 1
      ? (tokens[0] === "top" || tokens[0] === "bottom" ? ["center", tokens[0]] : [tokens[0], "center"])
      : tokens;
    const validX = /^(?:left|center|right|-?(?:\d+\.?\d*|\.\d+)%)$/;
    const validY = /^(?:top|center|bottom|-?(?:\d+\.?\d*|\.\d+)%)$/;
    if (!validX.test(normalized[0]) || !validY.test(normalized[1])) {
      throw new Error(
        `proxy-tree requires keyword/percentage object-position on ${clipLaneKey(clip)}; got ${style.objectPosition}`,
      );
    }
    return [positionFraction(normalized[0], "x"), positionFraction(normalized[1], "y")];
  }

  function roundedVideoClip(targetContext, rect, style) {
    const radii = [
      style.borderTopLeftRadius,
      style.borderTopRightRadius,
      style.borderBottomRightRadius,
      style.borderBottomLeftRadius,
    ];
    if (radii.every((radius) => radius.startsWith("50%"))) {
      targetContext.beginPath();
      targetContext.ellipse(
        rect.left + rect.width / 2,
        rect.top + rect.height / 2,
        rect.width / 2,
        rect.height / 2,
        0,
        0,
        Math.PI * 2,
      );
      targetContext.clip();
      return;
    }
    const scaleX = rect.width / Math.max(1, rect.element.offsetWidth);
    const radius = Math.max(0, Number.parseFloat(radii[0]) * scaleX || 0);
    if (radius > 0) {
      targetContext.beginPath();
      targetContext.roundRect(rect.left, rect.top, rect.width, rect.height, radius);
      targetContext.clip();
    }
  }

  function drawStyledVideo(targetContext, clip, source) {
    if (!source) return;
    const style = getComputedStyle(clip.element);
    const bounds = clip.element.getBoundingClientRect();
    if (bounds.width <= 0 || bounds.height <= 0 || Number(style.opacity) <= 0.001) return;

    const scaleX = bounds.width / Math.max(1, clip.element.offsetWidth);
    const scaleY = bounds.height / Math.max(1, clip.element.offsetHeight);
    const borderLeft = (Number.parseFloat(style.borderLeftWidth) || 0) * scaleX;
    const borderRight = (Number.parseFloat(style.borderRightWidth) || 0) * scaleX;
    const borderTop = (Number.parseFloat(style.borderTopWidth) || 0) * scaleY;
    const borderBottom = (Number.parseFloat(style.borderBottomWidth) || 0) * scaleY;
    const content = {
      left: bounds.left + borderLeft,
      top: bounds.top + borderTop,
      width: Math.max(0, bounds.width - borderLeft - borderRight),
      height: Math.max(0, bounds.height - borderTop - borderBottom),
    };
    const sourceWidth = source.videoWidth || source.displayWidth || source.width || width;
    const sourceHeight = source.videoHeight || source.displayHeight || source.height || height;
    if (!sourceWidth || !sourceHeight || !content.width || !content.height) return;

    const fit = style.objectFit || "fill";
    let objectWidth = content.width;
    let objectHeight = content.height;
    if (fit === "contain" || fit === "cover" || fit === "scale-down") {
      let scale = fit === "cover"
        ? Math.max(content.width / sourceWidth, content.height / sourceHeight)
        : Math.min(content.width / sourceWidth, content.height / sourceHeight);
      if (fit === "scale-down") scale = Math.min(scale, scaleX, scaleY);
      objectWidth = sourceWidth * scale;
      objectHeight = sourceHeight * scale;
    } else if (fit === "none") {
      objectWidth = sourceWidth * scaleX;
      objectHeight = sourceHeight * scaleY;
    }
    const [positionX, positionY] = objectPosition(style);
    const objectLeft = content.left + (content.width - objectWidth) * positionX;
    const objectTop = content.top + (content.height - objectHeight) * positionY;
    const drawLeft = Math.max(content.left, objectLeft);
    const drawTop = Math.max(content.top, objectTop);
    const drawRight = Math.min(content.left + content.width, objectLeft + objectWidth);
    const drawBottom = Math.min(content.top + content.height, objectTop + objectHeight);
    if (drawRight <= drawLeft || drawBottom <= drawTop) return;

    const sourceX = (drawLeft - objectLeft) / objectWidth * sourceWidth;
    const sourceY = (drawTop - objectTop) / objectHeight * sourceHeight;
    const sourceDrawWidth = (drawRight - drawLeft) / objectWidth * sourceWidth;
    const sourceDrawHeight = (drawBottom - drawTop) / objectHeight * sourceHeight;
    targetContext.save();
    targetContext.globalAlpha = Number(style.opacity) || 1;
    roundedVideoClip(targetContext, {
      left: bounds.left,
      top: bounds.top,
      width: bounds.width,
      height: bounds.height,
      element: clip.element,
    }, style);
    targetContext.drawImage(
      source,
      sourceX,
      sourceY,
      sourceDrawWidth,
      sourceDrawHeight,
      drawLeft,
      drawTop,
      drawRight - drawLeft,
      drawBottom - drawTop,
    );
    targetContext.restore();
  }

  function proxyCanvasContentSize(element, style) {
    const paddingX = (Number.parseFloat(style.paddingLeft) || 0)
      + (Number.parseFloat(style.paddingRight) || 0);
    const paddingY = (Number.parseFloat(style.paddingTop) || 0)
      + (Number.parseFloat(style.paddingBottom) || 0);
    return {
      width: Math.max(1, Math.round(Math.max(0, element.clientWidth - paddingX))),
      height: Math.max(1, Math.round(Math.max(0, element.clientHeight - paddingY))),
    };
  }

  function drawVideoIntoProxyCanvas(clip, source) {
    if (!clip.isVideoProxy || !(clip.element instanceof HTMLCanvasElement)) {
      throw new Error(`proxy-tree tried to paint a non-proxy clip: ${clipLaneKey(clip)}`);
    }
    const style = getComputedStyle(clip.element);
    const size = proxyCanvasContentSize(clip.element, style);
    if (clip.element.width !== size.width) clip.element.width = size.width;
    if (clip.element.height !== size.height) clip.element.height = size.height;
    // CanvasDrawElement snapshots the compositor-visible state of child
    // canvases. A desynchronized child context may still point at the
    // previously presented buffer when the root is captured, even after the
    // outer layout-canvas paint event. Keep proxy contexts synchronized so a
    // verified VideoFrame draw is part of the same root snapshot.
    const proxyContext = clip.element.getContext("2d", { alpha: true });
    if (!proxyContext) throw new Error(`Could not create 2D context for proxy ${clipLaneKey(clip)}`);
    proxyContext.clearRect(0, 0, size.width, size.height);
    const fit = style.objectFit || "fill";
    if (!source) return { drawn: false, width: size.width, height: size.height, objectFit: fit };

    const sourceWidth = source.videoWidth || source.displayWidth || source.width || 0;
    const sourceHeight = source.videoHeight || source.displayHeight || source.height || 0;
    if (!(sourceWidth > 0) || !(sourceHeight > 0)) {
      throw new Error(
        `Verified decoder source for proxy ${clipLaneKey(clip)} has invalid dimensions ${sourceWidth}x${sourceHeight}`,
      );
    }

    let objectWidth = size.width;
    let objectHeight = size.height;
    if (fit === "contain" || fit === "cover" || fit === "scale-down") {
      let scale = fit === "cover"
        ? Math.max(size.width / sourceWidth, size.height / sourceHeight)
        : Math.min(size.width / sourceWidth, size.height / sourceHeight);
      if (fit === "scale-down") scale = Math.min(1, scale);
      objectWidth = sourceWidth * scale;
      objectHeight = sourceHeight * scale;
    } else if (fit === "none") {
      objectWidth = sourceWidth;
      objectHeight = sourceHeight;
    } else if (fit !== "fill") {
      throw new Error(`Unsupported object-fit ${fit} on proxy ${clipLaneKey(clip)}`);
    }

    const [positionX, positionY] = proxyObjectPosition(style, clip);
    const objectLeft = (size.width - objectWidth) * positionX;
    const objectTop = (size.height - objectHeight) * positionY;
    const drawLeft = Math.max(0, objectLeft);
    const drawTop = Math.max(0, objectTop);
    const drawRight = Math.min(size.width, objectLeft + objectWidth);
    const drawBottom = Math.min(size.height, objectTop + objectHeight);
    if (drawRight <= drawLeft || drawBottom <= drawTop) {
      return { drawn: false, width: size.width, height: size.height, objectFit: fit };
    }

    const sourceX = (drawLeft - objectLeft) / objectWidth * sourceWidth;
    const sourceY = (drawTop - objectTop) / objectHeight * sourceHeight;
    const sourceDrawWidth = (drawRight - drawLeft) / objectWidth * sourceWidth;
    const sourceDrawHeight = (drawBottom - drawTop) / objectHeight * sourceHeight;
    proxyContext.drawImage(
      source,
      sourceX,
      sourceY,
      sourceDrawWidth,
      sourceDrawHeight,
      drawLeft,
      drawTop,
      drawRight - drawLeft,
      drawBottom - drawTop,
    );
    return { drawn: true, width: size.width, height: size.height, objectFit: fit };
  }

  const videoProxies = new Map();
  if (compositeMode === "proxy") {
    for (const clip of videos) {
      const proxy = document.createElement("canvas");
      proxy.id = `${clip.element.id}--canvas-proxy`;
      proxy.className = clip.element.className;
      proxy.width = width;
      proxy.height = height;
      proxy.setAttribute("aria-hidden", "true");
      proxy.style.visibility = "hidden";
      proxy.style.pointerEvents = "none";
      clip.element.insertAdjacentElement("afterend", proxy);
      videoProxies.set(clip.element, {
        element: proxy,
        context: proxy.getContext("2d", { alpha: false, desynchronized: true }),
      });
    }
  }

  function waitForEvent(target, event, timeoutMs, description) {
    return new Promise((resolveWait, rejectWait) => {
      let timer;
      const cleanup = () => {
        clearTimeout(timer);
        target.removeEventListener(event, onEvent);
        target.removeEventListener("error", onError);
      };
      const onEvent = () => {
        cleanup();
        resolveWait();
      };
      const onError = () => {
        cleanup();
        rejectWait(new Error(`${description}: ${target.error?.message || "media error"}`));
      };
      target.addEventListener(event, onEvent, { once: true });
      target.addEventListener("error", onError, { once: true });
      timer = setTimeout(() => {
        cleanup();
        rejectWait(new Error(`${description} timed out after ${timeoutMs}ms`));
      }, timeoutMs);
    });
  }

  async function ensureMetadata(video) {
    if (video.readyState >= HTMLMediaElement.HAVE_METADATA) return;
    video.preload = "auto";
    video.muted = true;
    video.load();
    await waitForEvent(video, "loadedmetadata", seekTimeoutMs, `Metadata ${video.currentSrc || video.src}`);
  }

  async function ensureCurrentData(video) {
    await ensureMetadata(video);
    if (video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA) return;
    await new Promise((resolveData, rejectData) => {
      let settled = false;
      let timer = null;
      let poll = null;
      const readinessEvents = ["seeked", "canplay", "loadeddata"];
      const cleanup = () => {
        clearTimeout(timer);
        clearInterval(poll);
        for (const event of readinessEvents) video.removeEventListener(event, check);
        video.removeEventListener("error", onError);
      };
      const finish = (error = null) => {
        if (settled) return;
        settled = true;
        cleanup();
        if (error) rejectData(error);
        else resolveData();
      };
      const check = () => {
        const readiness = timingRuntime?.classifyMediaReadiness({
          readyState: video.readyState,
          haveCurrentData: HTMLMediaElement.HAVE_CURRENT_DATA,
          seeking: video.seeking,
          error: video.error,
        }) ?? {
          status: video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA
            ? "ready"
            : "waiting-for-current-data",
        };
        if (readiness.status === "ready") finish();
        else if (readiness.status === "error") onError();
      };
      const onError = () => finish(new Error(
        `Decode ${video.currentSrc || video.src}: ${video.error?.message || "media error"}`,
      ));
      for (const event of readinessEvents) video.addEventListener(event, check);
      video.addEventListener("error", onError, { once: true });
      poll = setInterval(check, 10);
      timer = setTimeout(() => finish(new Error(
        `Decoder did not reach HAVE_CURRENT_DATA after ${seekTimeoutMs}ms for `
        + `${video.currentSrc || video.src} (readyState=${video.readyState}, seeking=${video.seeking})`,
      )), seekTimeoutMs);
      queueMicrotask(check);
    });
  }

  async function seekVideo(video, target) {
    await ensureMetadata(video);
    const maxTime = Number.isFinite(video.duration) ? Math.max(0, video.duration - 1 / fps / 4) : target;
    const clamped = Math.max(0, Math.min(target, maxTime));
    if (Math.abs(video.currentTime - clamped) <= 1 / fps / 8 && video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA) {
      return { currentTime: video.currentTime, readyState: video.readyState };
    }
    await new Promise((resolveSeek, rejectSeek) => {
      let settled = false;
      let timer = null;
      let poll = null;
      const cleanup = () => {
        clearTimeout(timer);
        clearInterval(poll);
        video.removeEventListener("seeked", onSeeked);
        video.removeEventListener("error", onError);
      };
      const finish = () => {
        if (settled) return;
        settled = true;
        cleanup();
        resolveSeek();
      };
      const onSeeked = () => finish();
      const onError = () => {
        if (settled) return;
        settled = true;
        cleanup();
        rejectSeek(new Error(`Seek ${video.currentSrc || video.src}: ${video.error?.message || "media error"}`));
      };
      const finishIfReady = () => {
        if (!video.seeking
            && video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA
            && Math.abs(video.currentTime - clamped) <= 1 / fps) {
          finish();
        }
      };
      video.addEventListener("seeked", onSeeked, { once: true });
      video.addEventListener("error", onError, { once: true });
      timer = setTimeout(() => {
        finishIfReady();
        if (!settled) {
          settled = true;
          cleanup();
          rejectSeek(new Error(`Seek ${video.currentSrc || video.src} to ${clamped} timed out after ${seekTimeoutMs}ms (current=${video.currentTime}, seeking=${video.seeking}, readyState=${video.readyState})`));
        }
      }, seekTimeoutMs);
      video.currentTime = clamped;
      poll = setInterval(finishIfReady, 10);
      queueMicrotask(finishIfReady);
      requestAnimationFrame(finishIfReady);
    });
    if (video.seeking || video.readyState < HTMLMediaElement.HAVE_CURRENT_DATA) {
      await ensureCurrentData(video);
    }
    return { currentTime: video.currentTime, readyState: video.readyState };
  }

  async function waitForVerifiedPlanFrame(video, selection, trigger, {
    allowOvershoot = false,
    recoverMismatch = null,
  } = {}) {
    // A seek or play operation is allowed to start from HAVE_METADATA. The
    // rVFC below proves frame identity; after an exact callback we separately
    // wait for the seek/readiness state to settle before entering the next
    // output frame.
    await ensureMetadata(video);
    if (typeof video.requestVideoFrameCallback !== "function") {
      throw new Error(`Timing-plan mode requires requestVideoFrameCallback for ${video.currentSrc || video.src}`);
    }
    const expected = selection.mediaRelativeSeconds;
    const tolerance = selection.ptsToleranceSeconds;
    return new Promise((resolveFrame, rejectFrame) => {
      let callbackId = 0;
      let settled = false;
      let timer = null;
      let mismatchRecoveries = 0;
      let staleResumeCount = 0;
      let verifiedCandidate = null;
      const callbackHistory = [];
      const cleanup = () => {
        clearTimeout(timer);
        if (callbackId) video.cancelVideoFrameCallback?.(callbackId);
        video.removeEventListener("error", onError);
        video.removeEventListener("ended", onEnded);
      };
      const finish = (error, value = null) => {
        if (settled) return;
        settled = true;
        cleanup();
        video.pause();
        if (error) rejectFrame(error);
        else resolveFrame(value);
      };
      const requestNext = () => {
        callbackId = video.requestVideoFrameCallback(onFrame);
      };
      const onFrame = (_now, metadata) => {
        const decision = timingRuntime.classifyPresentedFrame({
          expected,
          tolerance,
          mediaTime: metadata.mediaTime,
          seeking: video.seeking,
          paused: video.paused,
          allowOvershoot,
        });
        callbackHistory.push({
          mediaTime: metadata.mediaTime,
          status: decision.status,
          seeking: video.seeking,
          paused: video.paused,
        });
        if (callbackHistory.length > 12) callbackHistory.shift();
        if (decision.status === "waiting-for-seek") {
          requestNext();
          return;
        }
        if (decision.status === "exact") {
          // rVFC is authoritative for frame identity and can arrive before
          // Chromium clears `seeking` or restores HAVE_CURRENT_DATA. Accept the
          // exact PTS now, then wait only for media readiness—not another frame.
          verifiedCandidate = metadata;
          clearTimeout(timer);
          timer = null;
          video.pause();
          const completeVerifiedFrame = () => finish(null, {
            currentTime: video.currentTime,
            readyState: video.readyState,
            presentedMediaTime: verifiedCandidate.mediaTime,
            presentedFrames: verifiedCandidate.presentedFrames,
            overshot: false,
            verifiedPts: true,
            // ensureCurrentData resolves only when both parts of the
            // settlement gate hold: !seeking AND HAVE_CURRENT_DATA.
            seekSettledAfterExactPts: true,
            staleResumeCount,
            mismatchRecoveries,
            callbackHistory,
          });
          if (video.seeking || video.readyState < HTMLMediaElement.HAVE_CURRENT_DATA) {
            ensureCurrentData(video).then(completeVerifiedFrame, (error) => finish(error));
          } else {
            completeVerifiedFrame();
          }
          return;
        }
        if (decision.status === "stale-before-target") {
          requestNext();
          if (decision.play) {
            staleResumeCount += 1;
            video.playbackRate = mediaPlaybackRate;
            video.play().catch((error) => finish(error));
          }
          return;
        }
        if (decision.status === "overshot") {
          finish(null, {
            currentTime: video.currentTime,
            readyState: video.readyState,
            presentedMediaTime: metadata.mediaTime,
            presentedFrames: metadata.presentedFrames,
            overshot: true,
            verifiedPts: false,
            staleResumeCount,
            mismatchRecoveries,
            callbackHistory,
          });
          return;
        }
        if (recoverMismatch && mismatchRecoveries < 1) {
          mismatchRecoveries += 1;
          requestNext();
          try {
            Promise.resolve(recoverMismatch()).catch((error) => finish(error));
          } catch (error) {
            finish(error);
          }
          return;
        }
        finish(new Error(
          `Decoder presented ${metadata.mediaTime}s, expected planned PTS ${expected}s `
          + `(tolerance ${tolerance}s) for ${video.currentSrc || video.src}; `
          + `callbacks=${JSON.stringify(callbackHistory)}`,
        ));
      };
      const onError = () => finish(new Error(
        `Decode ${video.currentSrc || video.src}: ${video.error?.message || "media error"}`,
      ));
      const onEnded = () => {
        // `ended` may race the settlement of an already verified final frame.
        // The exact rVFC remains authoritative; let the readiness gate finish
        // (or time out) instead of replacing a valid candidate with an error.
        if (verifiedCandidate) return;
        finish(new Error(
          `Decoder ended before presenting planned PTS ${expected}s for ${video.currentSrc || video.src}`,
        ));
      };
      video.addEventListener("error", onError, { once: true });
      video.addEventListener("ended", onEnded, { once: true });
      requestNext();
      timer = setTimeout(() => finish(new Error(
        `Timed out verifying planned PTS ${expected}s after ${seekTimeoutMs}ms for `
        + `${video.currentSrc || video.src}; callbacks=${JSON.stringify(callbackHistory)}`,
      )), seekTimeoutMs);
      try {
        Promise.resolve(trigger()).catch((error) => finish(error));
      } catch (error) {
        finish(error);
      }
    });
  }

  async function seekVideoToPlan(video, selection) {
    await ensureMetadata(video);
    const upper = Number.isFinite(video.duration)
      ? Math.min(selection.intervalEndMediaRelativeSeconds, video.duration)
      : selection.intervalEndMediaRelativeSeconds;
    const interval = upper - selection.mediaRelativeSeconds;
    const guard = Math.max(4e-6, Math.min(selection.timeBaseSeconds * 2, interval / 8));
    if (!(interval > guard * 2)) {
      throw new Error(
        `Browser cannot expose a safe interior for planned frame ${selection.frameIndex}: `
        + `PTS=${selection.mediaRelativeSeconds}, upper=${upper}, duration=${video.duration}`,
      );
    }
    const browserSeekTarget = selection.mediaRelativeSeconds + guard;
    const performSeek = () => {
      video.pause();
      // Seek inside the selected frame's display interval. Some Chromium
      // decoders quantize an exact-boundary currentTime slightly backward and
      // would otherwise expose the preceding frame. rVFC still verifies the
      // identity against the exact planned presentation PTS.
      video.currentTime = browserSeekTarget;
    };
    const actual = await waitForVerifiedPlanFrame(video, selection, performSeek, {
      recoverMismatch: performSeek,
    });
    return { ...actual, seekTarget: browserSeekTarget, seekGuardSeconds: guard };
  }

  async function advanceVideoToPlan(video, selection) {
    return waitForVerifiedPlanFrame(video, selection, () => {
      video.playbackRate = mediaPlaybackRate;
      return video.play();
    }, { allowOvershoot: true });
  }

  async function bootstrapTimingFrame(video, timing) {
    await ensureCurrentData(video);
    if (typeof video.requestVideoFrameCallback !== "function") {
      throw new Error(`Timing-plan mode requires requestVideoFrameCallback for ${video.currentSrc || video.src}`);
    }
    const metadata = await new Promise((resolveFrame, rejectFrame) => {
      let callbackId = 0;
      let timer = null;
      let settled = false;
      const cleanup = () => {
        clearTimeout(timer);
        if (callbackId) video.cancelVideoFrameCallback?.(callbackId);
        video.removeEventListener("error", onError);
        video.removeEventListener("ended", onEnded);
      };
      const finish = (error, value = null) => {
        if (settled) return;
        settled = true;
        cleanup();
        video.pause();
        if (error) rejectFrame(error);
        else resolveFrame(value);
      };
      const onError = () => finish(new Error(
        `Bootstrap decode ${video.currentSrc || video.src}: ${video.error?.message || "media error"}`,
      ));
      const onEnded = () => finish(new Error(
        `Decoder ended before its bootstrap rVFC for ${video.currentSrc || video.src}`,
      ));
      video.addEventListener("error", onError, { once: true });
      video.addEventListener("ended", onEnded, { once: true });
      callbackId = video.requestVideoFrameCallback((_now, frameMetadata) => finish(null, frameMetadata));
      timer = setTimeout(() => finish(new Error(
        `Timed out obtaining bootstrap rVFC after ${seekTimeoutMs}ms for ${video.currentSrc || video.src}`,
      )), seekTimeoutMs);
      video.playbackRate = mediaPlaybackRate;
      video.play().catch((error) => finish(error));
    });
    const selection = timing.query.atOrBefore(
      metadata.mediaTime + timing.query.minimumPtsToleranceSeconds,
      { tailPolicy: "hold-last" },
    );
    if (!selection || Math.abs(metadata.mediaTime - selection.mediaRelativeSeconds) > selection.ptsToleranceSeconds) {
      throw new Error(
        `Bootstrap rVFC mediaTime ${metadata.mediaTime}s does not map to a planned PTS for ${timing.source}`,
      );
    }
    return {
      selection,
      actual: {
        currentTime: video.currentTime,
        readyState: video.readyState,
        presentedMediaTime: metadata.mediaTime,
        presentedFrames: metadata.presentedFrames,
        verifiedPts: true,
      },
    };
  }

  async function ensureTimingCalibrated(video, timing) {
    const existing = mediaCalibrationByDecoder.get(video);
    if (existing) return existing;
    const startedAt = performance.now();
    const first = timing.query.atIndex(0, 0);
    const bootstrap = await bootstrapTimingFrame(video, timing);
    const samples = [{
      kind: "bootstrap",
      frameIndex: bootstrap.selection.frameIndex,
      expected: bootstrap.selection.mediaRelativeSeconds,
      actual: bootstrap.actual.presentedMediaTime,
    }];
    if (timing.plan.presentation.frameCount > 1) {
      const second = timing.query.atIndex(1);
      if (!timingRuntime.samePresentationFrame(bootstrap.selection, second)) {
        const secondActual = await seekVideoToPlan(video, second);
        samples.push({ kind: "seek", frameIndex: 1, expected: second.mediaRelativeSeconds, actual: secondActual.presentedMediaTime });
      }
    }
    const firstActual = timingRuntime.samePresentationFrame(bootstrap.selection, first)
      && timing.plan.presentation.frameCount === 1
      ? bootstrap.actual
      : await seekVideoToPlan(video, first);
    samples.push({ kind: "final", frameIndex: 0, expected: first.mediaRelativeSeconds, actual: firstActual.presentedMediaTime });
    const calibration = {
      source: timing.source,
      sourceIdentity: timing.plan.source.identity,
      editListDetected: Boolean(timing.plan.timeline.editList?.detected),
      samples,
      elapsedMs: performance.now() - startedAt,
    };
    mediaCalibrationByDecoder.set(video, calibration);
    mediaStates.set(video, { selection: first, target: first.mediaRelativeSeconds, clipKey: null });
    return calibration;
  }

  async function advanceVideoOneFrame(video, expectedMediaTime) {
    await ensureMetadata(video);
    const frameDuration = 1 / fps;
    if (mediaTargetAtOrPastEnd(expectedMediaTime, video.duration, fps)) {
      let heldFrame = { currentTime: video.currentTime, readyState: video.readyState };
      const lastFrameIsReady = video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA
        && video.currentTime >= Math.max(0, video.duration - frameDuration * 1.5);
      if (!lastFrameIsReady) {
        heldFrame = await seekVideo(video, Math.max(0, video.duration - frameDuration / 4));
      }
      video.pause();
      return {
        currentTime: heldFrame.currentTime ?? video.currentTime,
        readyState: heldFrame.readyState ?? video.readyState,
        presentedMediaTime: null,
        presentedFrames: null,
        overshot: false,
        heldAtEnd: true,
      };
    }
    if (typeof video.requestVideoFrameCallback !== "function") {
      return seekVideo(video, expectedMediaTime + mediaSeekBiasFrames / fps);
    }
    return new Promise((resolveFrame, rejectFrame) => {
      let callbackId = 0;
      let settled = false;
      const cleanup = () => {
        clearTimeout(timer);
        if (callbackId) video.cancelVideoFrameCallback?.(callbackId);
        video.removeEventListener("ended", onEnded);
      };
      const fail = (error) => {
        if (settled) return;
        settled = true;
        cleanup();
        video.pause();
        rejectFrame(error);
      };
      const timer = setTimeout(() => {
        fail(new Error(`Advance ${video.currentSrc || video.src} to ${expectedMediaTime} timed out after ${seekTimeoutMs}ms`));
      }, seekTimeoutMs);
      const onFrame = (_now, metadata) => {
        if (metadata.mediaTime + 1 / fps / 3 < expectedMediaTime) {
          callbackId = video.requestVideoFrameCallback(onFrame);
          return;
        }
        if (settled) return;
        settled = true;
        cleanup();
        video.pause();
        resolveFrame({
          currentTime: video.currentTime,
          readyState: video.readyState,
          presentedMediaTime: metadata.mediaTime,
          presentedFrames: metadata.presentedFrames,
          overshot: metadata.mediaTime - expectedMediaTime > mediaOvershootToleranceFrames / fps,
        });
      };
      const onEnded = () => {
        if (settled) return;
        settled = true;
        cleanup();
        video.pause();
        resolveFrame({
          currentTime: video.currentTime,
          readyState: video.readyState,
          presentedMediaTime: null,
          presentedFrames: null,
          overshot: false,
          heldAtEnd: true,
        });
      };
      callbackId = video.requestVideoFrameCallback(onFrame);
      video.addEventListener("ended", onEnded, { once: true });
      video.playbackRate = mediaPlaybackRate;
      video.play().catch(fail);
    });
  }

  async function waitForPaint() {
    if (nativeScreenshot) {
      await new Promise((resolveFrame) => requestAnimationFrame(() => requestAnimationFrame(resolveFrame)));
      await new Promise((resolveTask) => setTimeout(resolveTask, 0));
      return "native-compositor-double-raf";
    }
    if (waitMode === "none") return "none";
    if (waitMode === "synchronous-paint") {
      if (typeof canvas.requestSynchronousPaint !== "function") {
        throw new Error("HF_SYNCHRONOUS_PAINT_UNAVAILABLE: custom Electron support is required");
      }
      let dispatched = false;
      const onSynchronousPaint = () => { dispatched = true; };
      canvas.addEventListener("paint", onSynchronousPaint, { once: true });
      canvas.requestSynchronousPaint();
      canvas.removeEventListener("paint", onSynchronousPaint);
      if (!dispatched) {
        throw new Error("HF_SYNCHRONOUS_PAINT_NOT_SYNCHRONOUS: paint was not dispatched before return");
      }
      return "synchronous-paint";
    }
    if (waitMode === "single-raf") {
      invalidate();
      await new Promise((resolveFrame) => requestAnimationFrame(resolveFrame));
      return "single-raf";
    }
    if (waitMode === "double-raf") {
      invalidate();
      await new Promise((resolveFrame) => requestAnimationFrame(() => requestAnimationFrame(resolveFrame)));
      return "double-raf";
    }
    return new Promise((resolvePaint) => {
      let settled = false;
      let timer = null;
      const finish = (reason) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        canvas.removeEventListener("paint", onPaint);
        resolvePaint(reason);
      };
      const onPaint = () => finish("paint-event");
      canvas.addEventListener("paint", onPaint, { once: true });
      const requested = invalidate();
      timer = setTimeout(() => finish(requested ? "timeout" : "request-unavailable"), requested ? paintTimeoutMs : 0);
    });
  }

  const codecCandidates = ["avc1.640034", "avc1.640033", "avc1.640032"];
  let encoderConfig = null;
  if (webcodecsOutput) {
    for (const codec of codecCandidates) {
      const candidate = {
        codec,
        width,
        height,
        framerate: fps,
        bitrate,
        bitrateMode,
        hardwareAcceleration: "prefer-hardware",
        latencyMode: "realtime",
        avc: { format: "annexb" },
        alpha: "discard",
      };
      const result = await VideoEncoder.isConfigSupported(candidate);
      if (result.supported) {
        encoderConfig = result.config;
        break;
      }
    }
    if (!encoderConfig) throw new Error("No hardware H.264 WebCodecs configuration");
  }

  const webglProbe = document.createElement("canvas").getContext("webgl");
  const rendererInfo = webglProbe?.getExtension("WEBGL_debug_renderer_info");
  const support = {
    userAgent: navigator.userAgent,
    outputBackend,
    drawElementImage: !nativeScreenshot,
    requestPaint: !nativeScreenshot && typeof canvas.requestPaint === "function",
    requestSynchronousPaint: !nativeScreenshot && typeof canvas.requestSynchronousPaint === "function",
    videoEncoder: typeof VideoEncoder === "function",
    videoFrame: typeof VideoFrame === "function",
    webglRenderer: rendererInfo ? webglProbe.getParameter(rendererInfo.UNMASKED_RENDERER_WEBGL) : "unknown",
    encoderConfig,
    resourceBudget,
    mediaDecoderBackend,
    partialOpacityPolicy,
    productionDecoder: productionDecoderEnabled ? {
      active: true,
      contract: "timing-plan exact PTS -> main paged demux -> VideoDecoder VideoFrame -> manual canvas draw",
      initial: productionDecoderInitial,
      final: null,
    } : {
      active: false,
      contract: "HTMLVideoElement seek/rVFC compatibility backend",
      initial: null,
      final: null,
    },
    screenshotCapture: nativeScreenshot ? {
      contract: webcodecsOutput
        ? "native Chromium composition -> lossless PNG capture -> WebCodecs H.264 -> MOV"
        : "native Chromium composition -> lossless PNG capture -> FFmpeg H.264 -> MOV",
      viewport: { width: window.innerWidth, height: window.innerHeight },
      rootBounds: root.getBoundingClientRect().toJSON(),
      sequential: true,
      mediaPolicy: screenshotMediaPolicy,
      mediaRequestGate: screenshotMediaRequestGate,
      authoredDomMutations: screenshotEntryTransform?.domMutations ?? null,
      entryTransform: screenshotEntryTransform,
    } : null,
    layoutDiagnostics: {
      contextAttributes: context.getContextAttributes?.() ?? null,
      canvasBackground: getComputedStyle(canvas).backgroundColor,
      rootBackground: getComputedStyle(root).backgroundColor,
      rootBackgroundImage: getComputedStyle(root).backgroundImage,
      bodyBackground: getComputedStyle(document.body).backgroundColor,
      bodyBackgroundImage: getComputedStyle(document.body).backgroundImage,
      htmlBackground: getComputedStyle(document.documentElement).backgroundColor,
      htmlBackgroundImage: getComputedStyle(document.documentElement).backgroundImage,
      authoredBackgroundPreserved: preserveAuthoredBackground,
      authoredBackgrounds,
    },
    videoClips: videos.map((clip) => ({
      id: clip.element.id,
      src: clip.src,
      proxy: clip.isVideoProxy,
      decoderSrc: decoderSourceMap.get(new URL(clip.src, document.baseURI).href)?.cache ?? clip.src,
      decoderMapped: decoderSourceMap.has(new URL(clip.src, document.baseURI).href),
      start: clip.start,
      end: clip.end,
      mediaStart: clip.mediaStart,
      track: clip.track,
    })),
    proxyTree: {
      active: compositeMode === "proxy-tree",
      proxyCount: staticVideoProxies.length,
      earlyTransform: proxyTreeTransform ?? null,
      captureContract: compositeMode === "proxy-tree"
        ? "verified decoder frame -> child proxy canvas -> one root drawElementImage"
        : null,
    },
    mediaSourceMap: {
      active: decoderSourceMap.size > 0,
      backend: productionDecoderEnabled ? "production-webcodecs" : (useDecoderDeck ? "html-video" : null),
      manifestPath: mediaSourceMapPath,
      verifyMode: mediaSourceMapVerify,
      recipeKey: mediaSourceMapRecipeKey,
      entries: mediaSourceMap.map((entry) => ({
        id: entry.id,
        source: entry.source,
        cache: entry.cache,
      })),
    },
    canonicalMediaRoute: {
      active: canonicalMediaRouteMappings.length > 0,
      manifestPath: canonicalMediaRoutePath,
      verifyMode: canonicalMediaRouteVerify,
      identity: canonicalMediaRouteIdentity,
      entries: canonicalMediaRouteMappings.map((mapping) => ({
        source: mapping.source,
        cache: mapping.cache,
        recipeHash: mapping.canonical.recipeHash,
        frameMapSha256: mapping.canonical.frameMapSha256,
        sourceIdentity: mapping.canonical.sourceIdentity,
        cacheIdentity: mapping.canonical.cacheIdentity,
        frameCount: mapping.canonical.frameCount,
        frameRate: mapping.frameRate,
      })),
    },
    mediaTimingPlan: {
      active: mediaTargetMode === "timing-plan",
      manifestPath: mediaTimingPlanPath,
      verifyMode: mediaTimingPlanVerify,
      tailPolicy: mediaTailPolicy,
      entries: mediaTimingPlans.map((entry) => ({
        source: entry.source,
        roles: entry.roles,
        sourceIdentity: entry.plan.source.identity,
        frameCount: entry.plan.presentation.frameCount,
        classification: entry.plan.presentation.classification,
        timestampSource: entry.plan.probe.timestampSource,
        editListDetected: Boolean(entry.plan.timeline.editList?.detected),
      })),
      calibrations: [],
    },
    mediaDecoderLanePool: {
      active: Boolean(timingDecoderLanes),
      limits: {
        maxTotalLanes: mediaDecoderLanesTotal,
        maxLanesPerSource: mediaDecoderLanesPerSource,
        idleUnloadFrames: mediaDecoderIdleFrames,
      },
      final: null,
    },
    startFrame,
    mediaTargetMode,
    mediaTailPolicy,
    audioClips,
  };
  if (activeProductionDecoder) activeProductionDecoder.support = support;
  await api.reportSupport(support);

  let outputChunks = 0;
  let attemptedPayloadBytes = 0;
  let payloadBytes = 0;
  let encodeQueueMax = 0;
  let promotedDynamicOpacityElements = 0;
  let framesWithPromotedDynamicOpacity = 0;
  let encoderError = null;
  const pendingWrites = new Set();
  let firstWriteError = null;
  let payloadWriteMax = 0;
  let pendingPayloadBytes = 0;
  let payloadWriteMaxBytes = 0;
  const phaseTotals = {
    timelineSeekMs: 0,
    mediaSeekMs: 0,
    paintWaitMs: 0,
    drawElementImageMs: 0,
    videoDrawMs: 0,
    mediaSnapshotMs: 0,
    overlayCompositeMs: 0,
    decoderWakePaintMs: 0,
    videoFrameCreateMs: 0,
    encodeSubmitMs: 0,
    queueFlushMs: 0,
    queueBackpressureMs: 0,
    finalFlushMs: 0,
    outputCopyMs: 0,
    outputWriteMs: 0,
    payloadBackpressureMs: 0,
    screenshotCaptureMs: 0,
    screenshotPngEncodeMs: 0,
    screenshotPngDecodeMs: 0,
  };
  const waitReasons = {};
  const mediaSeekErrors = [];

  async function waitForPayloadWindow(maxPending, maxBytes) {
    while (pendingWrites.size > maxPending || pendingPayloadBytes > maxBytes) {
      await Promise.race([...pendingWrites].map((pending) => pending.then(
        () => undefined,
        () => undefined,
      )));
      if (firstWriteError) throw firstWriteError;
    }
    if (firstWriteError) throw firstWriteError;
  }
  const frameMetricsRecorder = globalThis.HyperframesBoundedMetrics?.createBoundedMetricsRecorder({
    mode: frameMetricsMode,
    expectedFrames: frames,
    headFrames: frameMetricsHead,
    tailFrames: frameMetricsTail,
    sampleEvery: frameMetricsSampleEvery,
    maxStoredFrames: frameMetricsMaxFrames,
    maxStoredBytes: frameMetricsMaxBytes,
    slowFrameMs: frameMetricsSlowMs,
  });
  if (!frameMetricsRecorder) throw new Error("Bounded frame metrics runtime is unavailable");
  const diagnosticPixelSamples = [];
  const diagnosticDomProbes = [];
  const domProbeFrameSet = new Set(domProbeFrames);

  function describeDomProbeElement(element) {
    if (!element) return null;
    const style = getComputedStyle(element);
    const rect = element.getBoundingClientRect();
    return {
      tagName: element.tagName,
      id: element.id || null,
      className: typeof element.className === "string" ? element.className : null,
      inlineStyle: element.getAttribute("style"),
      text: String(element.textContent ?? "").trim().slice(0, 240),
      computed: {
        display: style.display,
        visibility: style.visibility,
        opacity: style.opacity,
        transform: style.transform,
        position: style.position,
        left: style.left,
        top: style.top,
        width: style.width,
        height: style.height,
        color: style.color,
        backgroundColor: style.backgroundColor,
      },
      rect: {
        x: rect.x,
        y: rect.y,
        width: rect.width,
        height: rect.height,
      },
    };
  }

  function captureDomProbe(frameIndex, timelineTime) {
    for (const selector of domProbeSelectors) {
      let element;
      try {
        element = document.querySelector(selector);
      } catch (error) {
        const invalid = {
          frameIndex,
          timelineTime,
          selector,
          error: `Invalid selector: ${error?.message || error}`,
        };
        diagnosticDomProbes.push(invalid);
        console.info(`FULL_CANVAS_DOM_PROBE ${JSON.stringify(invalid)}`);
        continue;
      }
      const ancestors = [];
      let ancestor = element?.parentElement ?? null;
      while (ancestor && ancestors.length < 8) {
        ancestors.push(describeDomProbeElement(ancestor));
        ancestor = ancestor.parentElement;
      }
      const record = {
        frameIndex,
        timelineTime,
        selector,
        found: Boolean(element),
        element: describeDomProbeElement(element),
        ancestors,
      };
      diagnosticDomProbes.push(record);
      console.info(`FULL_CANVAS_DOM_PROBE ${JSON.stringify(record)}`);
    }
  }
  const startedAt = performance.now();
  partialResults = (error = null) => {
    const frameMetrics = frameMetricsRecorder.snapshot();
    return {
      partial: true,
      failure: error?.stack || (error == null ? null : String(error)),
      frames,
      framesCompleted: frameMetrics.framesCompleted,
      fps,
      start,
      startFrame,
      width,
      height,
      wallMs: performance.now() - startedAt,
      outputChunks,
      attemptedPayloadBytes,
      payloadBytes,
      encodeQueueMax,
      queueLimit,
      queueLowWatermark,
      queueBackpressureMode,
      payloadWriteMax,
      pendingPayloadBytes,
      payloadWriteMaxBytes,
      payloadWriteWindow,
      payloadWriteLowWatermark,
      maxPendingPayloadBytes,
      pendingPayloadLowWatermarkBytes,
      mediaTargetMode,
      mediaTailPolicy,
      phaseTotals,
      waitReasons,
      mediaSeekErrors,
      frameTimings: frameMetrics.records,
      frameMetrics,
      diagnosticPixelSamples,
      diagnosticDomProbes,
      support,
    };
  };
  const encoder = webcodecsOutput ? new VideoEncoder({
    output: (chunk) => {
      const chunkBytes = chunk.byteLength;
      attemptedPayloadBytes += chunkBytes;
      if (chunkBytes > maxPendingPayloadBytes
          || pendingPayloadBytes + chunkBytes > maxPendingPayloadBytes) {
        firstWriteError ||= new Error(
          `Encoded payload byte budget exceeded before allocation: pending=${pendingPayloadBytes}, `
          + `chunk=${chunkBytes}, limit=${maxPendingPayloadBytes}`,
        );
        return;
      }
      const copyStartedAt = performance.now();
      const bytes = new Uint8Array(chunkBytes);
      chunk.copyTo(bytes);
      phaseTotals.outputCopyMs += performance.now() - copyStartedAt;
      outputChunks += 1;
      payloadBytes += bytes.byteLength;
      pendingPayloadBytes += bytes.byteLength;
      payloadWriteMaxBytes = Math.max(payloadWriteMaxBytes, pendingPayloadBytes);
      const writeStartedAt = performance.now();
      let pending;
      try {
        pending = Promise.resolve(api.writePayload({ kind: "h264", bytes }));
      } catch (error) {
        pendingPayloadBytes -= bytes.byteLength;
        firstWriteError ||= error instanceof Error ? error : new Error(String(error));
        return;
      }
      pendingWrites.add(pending);
      payloadWriteMax = Math.max(payloadWriteMax, pendingWrites.size);
      pending.then(
        () => {
          phaseTotals.outputWriteMs += performance.now() - writeStartedAt;
          pendingPayloadBytes -= bytes.byteLength;
          pendingWrites.delete(pending);
        },
        (error) => {
          phaseTotals.outputWriteMs += performance.now() - writeStartedAt;
          pendingPayloadBytes -= bytes.byteLength;
          firstWriteError ||= error instanceof Error ? error : new Error(String(error));
          pendingWrites.delete(pending);
        },
      );
    },
    error: (error) => { encoderError = String(error); },
  }) : null;
  if (encoder) encoder.configure(encoderConfig);

  function waitForEncoderQueue(maxQueueSize) {
    if (!encoder) return Promise.resolve();
    if (encoder.encodeQueueSize <= maxQueueSize) return Promise.resolve();
    return new Promise((resolveQueue, rejectQueue) => {
      let timeout = null;
      const cleanup = () => {
        clearTimeout(timeout);
        encoder.removeEventListener("dequeue", checkQueue);
      };
      const checkQueue = () => {
        if (encoderError) {
          cleanup();
          rejectQueue(new Error(encoderError));
          return;
        }
        if (encoder.encodeQueueSize <= maxQueueSize) {
          cleanup();
          resolveQueue();
        }
      };
      encoder.addEventListener("dequeue", checkQueue);
      timeout = setTimeout(() => {
        cleanup();
        rejectQueue(new Error(`Encoder queue did not fall below ${maxQueueSize} within ${seekTimeoutMs}ms`));
      }, seekTimeoutMs);
      queueMicrotask(checkQueue);
    });
  }

  for (let frameIndex = 0; frameIndex < frames; frameIndex += 1) {
    const frameStartedAt = performance.now();
    const timelineFrame = startFrame == null ? null : startFrame + frameIndex;
    const time = timelineFrame == null ? start + frameIndex / fps : timelineFrame / fps;
    const activeClips = topLevelClips.filter((clip) => time >= clip.start && time < clip.end);
    for (const clip of topLevelClips) {
      const active = activeClips.includes(clip);
      clip.element.style.visibility = active ? "visible" : "hidden";
      if (hyperframesRuntimeEnabled && !clip.isVideo && clip.compositionId) {
        // The HyperFrames player normally owns host activation. The fast renderer
        // drives child GSAP timelines directly so that HTMLVideo elements remain
        // under the deterministic decoder; mirror the player's host gate here.
        clip.element.style.opacity = active ? "1" : "0";
      }
    }

    const timelineStartedAt = performance.now();
    if (hyperframesRuntimeEnabled) {
      if (typeof window.__player?.seek !== "function") {
        throw new Error("HyperFrames runtime player disappeared before timeline seek");
      }
      await window.__player.seek(time);
    } else {
      timeline.seek(time, false);
    }
    const timelineSeekMs = performance.now() - timelineStartedAt;
    phaseTotals.timelineSeekMs += timelineSeekMs;
    if (diagnostics && domProbeFrameSet.has(frameIndex)) {
      captureDomProbe(frameIndex, time);
    }

    const mediaStartedAt = performance.now();
    const activeVideos = activeClips.filter((clip) => clip.isVideo);
    const mediaVideos = activeVideos.filter((clip) => {
      const style = getComputedStyle(clip.element);
      return style.display !== "none";
    });
    const renderableVideos = mediaVideos.filter((clip) => Number(getComputedStyle(clip.element).opacity) > 0.001);
    if (nativeScreenshot && screenshotMediaRequestGate) {
      const activeVideoElements = new Set(renderableVideos.map((clip) => clip.element));
      const sourceLeaseCounts = new Map();
      for (const clip of renderableVideos) {
        const url = new URL(clip.src, document.baseURI).href;
        sourceLeaseCounts.set(url, (sourceLeaseCounts.get(url) ?? 0) + 1);
      }
      await api.setScreenshotMediaAccess({
        frameIndex,
        sources: [...sourceLeaseCounts].sort(([left], [right]) => left.localeCompare(right)).map(([url, count]) => ({ url, count })),
      });
      for (const video of staticVideoElements) {
        if (activeVideoElements.has(video)) {
          if (!loadedNativeVideos.has(video)) {
            video.pause();
            const hadPreload = video.hasAttribute("preload");
            const authoredPreload = video.getAttribute("preload");
            video.preload = "auto";
            video.load();
            if (hadPreload) video.setAttribute("preload", authoredPreload);
            else video.removeAttribute("preload");
            mediaStates.delete(video);
            mediaCalibrationByDecoder.delete(video);
            loadedNativeVideos.add(video);
          }
        } else if (loadedNativeVideos.has(video)) {
          const declared = declaredMediaElementSource(video);
          const sourceUrl = declared ? new URL(declared, document.baseURI).href : null;
          if (!sourceUrl || !sourceLeaseCounts.has(sourceUrl)) {
            video.pause();
            video.load();
            mediaStates.delete(video);
            mediaCalibrationByDecoder.delete(video);
            loadedNativeVideos.delete(video);
          }
        }
      }
    }
    const mediaTimes = [];
    const preparedFrameSources = new Map();
    const preparedDecoderTargets = new Map();
    const transparentScreenshotClips = new Set();
    if (timingDecoderLanes) timingDecoderLanes.beginFrame(frameIndex);
    let decoderLaneMaintenance = null;
    let productionFrameEnded = true;
    let productionFrameError = null;
    try {
      if (productionDecoderRuntime) {
        productionDecoderRuntime.beginOutputFrame(frameIndex);
        productionFrameEnded = false;
      }
    for (const clip of mediaVideos) {
      const rawTarget = clip.mediaStart + time - clip.start;
      let decoderTarget = null;
      let targetSnapDelta = null;
      let targetFrameIndex = null;
      let seekTarget = null;
      let timingSelection = null;
      let timingTransition = null;
      try {
        if (mediaTargetMode === "timing-plan" && !renderableVideos.includes(clip)) {
          mediaTimes.push({
            id: clip.element.id,
            rawTarget,
            skipped: true,
            skipReason: "not-renderable-opacity",
          });
          continue;
        }
        if (mediaTargetMode === "timing-plan") {
          const timing = timingForClip(clip);
          timingSelection = timing.query.atOrBefore(rawTarget, { tailPolicy: mediaTailPolicy });
          if (!timingSelection) {
            throw new Error(`Media target ${rawTarget}s precedes the first planned PTS for ${timing.source}`);
          }
          decoderTarget = timingSelection.mediaRelativeSeconds;
          targetSnapDelta = decoderTarget - rawTarget;
          targetFrameIndex = timingSelection.frameIndex;
          seekTarget = timingSelection.seekTargetSeconds;

          if (timingSelection.transparent) {
            preparedFrameSources.set(clip, null);
            if (nativeScreenshot) {
              clip.element.style.visibility = "hidden";
              transparentScreenshotClips.add(clip);
            }
            mediaTimes.push({
              id: clip.element.id,
              decoderId: null,
              decoderLaneId: null,
              rawTarget,
              decoderTarget,
              targetSnapDelta,
              targetFrameIndex,
              sourceFrameIndex: timingSelection.frameIndex,
              ptsTicks: timingSelection.ptsTicks,
              ptsSeconds: timingSelection.ptsSeconds,
              lookup: timingSelection.lookup,
              sameFrame: false,
              seekReason: "tail-transparent",
              transition: "transparent",
              tailAction: timingSelection.tailAction,
              heldAtEnd: false,
            });
            continue;
          }

          if (productionDecoderRuntime) {
            const descriptor = productionDescriptorForClip(clip);
            if (descriptor.sourceIdentity !== timing.plan.source.identity) {
              throw new Error(`Production decoder source identity changed for ${clipLaneKey(clip)}`);
            }
            const ptsUs = productionDecoderModule.ticksToMicrosecondsExact(
              timingSelection.ptsTicks,
              timing.plan.stream.timeBase,
            );
            const lease = await productionDecoderRuntime.acquireFrame({
              sourceIdentity: descriptor.sourceIdentity,
              ptsUs,
              clipKey: clipLaneKey(clip),
            });
            if (lease.frame.timestamp !== ptsUs || lease.ownership !== "runtime-owned-do-not-close") {
              throw new Error(`Production decoder returned a non-exact or invalid frame lease for ${clipLaneKey(clip)}`);
            }
            preparedFrameSources.set(clip, lease.frame);
            mediaTimes.push({
              id: clip.element.id,
              decoderId: null,
              decoderBackend: "production-webcodecs",
              decoderLaneId: lease.laneId,
              decoderLaneShared: lease.shared,
              rawTarget,
              decoderTarget,
              targetSnapDelta,
              targetFrameIndex,
              sourceFrameIndex: timingSelection.frameIndex,
              ptsTicks: timingSelection.ptsTicks,
              ptsUs,
              ptsSeconds: timingSelection.ptsSeconds,
              lookup: timingSelection.lookup,
              exactPts: lease.frame.timestamp === ptsUs,
              htmlVideoFallback: false,
              tailAction: timingSelection.tailAction,
              heldAtEnd: timingSelection.pastDisplayEnd && mediaTailPolicy === "hold-last",
            });
            continue;
          }

          const {
            decoder: mediaElement,
            allocation: decoderLaneAllocation,
          } = decoderForTimingSelection(clip, timing, timingSelection);

          const alreadyPrepared = preparedDecoderTargets.get(mediaElement);
          if (alreadyPrepared?.selection
              && !timingRuntime.samePresentationFrame(alreadyPrepared.selection, timingSelection)) {
            throw new Error(
              `One decoder source requested at two planned PTS values in output frame ${frameIndex}: `
              + `${alreadyPrepared.selection.ptsTicks} and ${timingSelection.ptsTicks}`,
            );
          }
          if (alreadyPrepared?.selection) {
            preparedFrameSources.set(clip, mediaElement);
            const sharedState = mediaStates.get(mediaElement);
            if (sharedState) {
              sharedState.clipKeys = [...new Set([...(sharedState.clipKeys ?? []), clipLaneKey(clip)])];
            }
            mediaTimes.push({
              id: clip.element.id,
              decoderId: mediaElement.id,
              decoderLaneId: decoderLaneAllocation?.laneId ?? null,
              decoderLaneGeneration: decoderLaneAllocation?.generation ?? null,
              decoderLaneReason: decoderLaneAllocation?.reason ?? "single-decoder",
              decoderLaneShared: decoderLaneAllocation?.shared ?? true,
              rawTarget,
              decoderTarget,
              targetSnapDelta,
              targetFrameIndex,
              sourceFrameIndex: timingSelection.frameIndex,
              ptsTicks: timingSelection.ptsTicks,
              ptsSeconds: timingSelection.ptsSeconds,
              lookup: timingSelection.lookup,
              sameFrame: true,
              seekReason: "same-output-frame-presentation-pts",
              transition: "reuse",
              actual: mediaElement.currentTime,
              readyState: mediaElement.readyState,
              reused: true,
              presentedMediaTime: timingSelection.mediaRelativeSeconds,
              verifiedPts: true,
              tailAction: timingSelection.tailAction,
              heldAtEnd: timingSelection.pastDisplayEnd && mediaTailPolicy === "hold-last",
            });
            continue;
          }

          const calibration = await ensureTimingCalibrated(mediaElement, timing);
          if (!support.mediaTimingPlan.calibrations.some((entry) => (
            entry.decoderId === mediaElement.id
            && entry.decoderLaneGeneration === (decoderLaneAllocation?.generation ?? null)
            && entry.sourceIdentity === calibration.sourceIdentity
          ))) {
            support.mediaTimingPlan.calibrations.push({
              ...calibration,
              decoderId: mediaElement.id,
              decoderLaneId: decoderLaneAllocation?.laneId ?? null,
              decoderLaneGeneration: decoderLaneAllocation?.generation ?? null,
            });
          }
          const storedPrevious = mediaStates.get(mediaElement);
          const laneClipKey = clipLaneKey(clip);
          const previous = storedPrevious?.clipKeys?.includes(laneClipKey)
            ? { ...storedPrevious, clipKey: laneClipKey }
            : storedPrevious;
          timingTransition = timingRuntime.decideTransition(previous, timingSelection, {
            clipKey: laneClipKey,
          });
          let actual;
          let advanceFallback = false;
          if (timingTransition.action === "reuse") {
            actual = {
              currentTime: mediaElement.currentTime,
              readyState: mediaElement.readyState,
              presentedMediaTime: previous.selection.mediaRelativeSeconds,
              presentedFrames: null,
              verifiedPts: true,
              seekSettledAfterExactPts: !mediaElement.seeking
                && mediaElement.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA,
            };
          } else if (timingTransition.action === "advance") {
            actual = await advanceVideoToPlan(mediaElement, timingSelection);
            if (actual.overshot) {
              advanceFallback = true;
              actual = await seekVideoToPlan(mediaElement, timingSelection);
              timingTransition = {
                ...timingTransition,
                action: "seek",
                seekReason: "rVFC-overshoot-recovery-seek",
              };
            }
          } else {
            actual = await seekVideoToPlan(mediaElement, timingSelection);
          }
          if (!actual.verifiedPts) {
            throw new Error(`Planned PTS ${timingSelection.ptsTicks} was not verified after decoder transition`);
          }
          mediaStates.set(mediaElement, {
            selection: timingSelection,
            target: decoderTarget,
            clipKey: laneClipKey,
            clipKeys: [laneClipKey],
          });
          preparedDecoderTargets.set(mediaElement, { selection: timingSelection });
          mediaTimes.push({
            id: clip.element.id,
            decoderId: mediaElement.id,
            decoderLaneId: decoderLaneAllocation?.laneId ?? null,
            decoderLaneGeneration: decoderLaneAllocation?.generation ?? null,
            decoderLaneReason: decoderLaneAllocation?.reason ?? "single-decoder",
            decoderLaneShared: decoderLaneAllocation?.shared ?? false,
            decoderLaneSourceChanged: decoderLaneAllocation?.sourceChanged ?? false,
            rawTarget,
            decoderTarget,
            targetSnapDelta,
            targetFrameIndex,
            sourceFrameIndex: timingSelection.frameIndex,
            ptsTicks: timingSelection.ptsTicks,
            ptsSeconds: timingSelection.ptsSeconds,
            lookup: timingSelection.lookup,
            sameFrame: timingTransition.sameFrame,
            seekReason: timingTransition.seekReason,
            transition: timingTransition.action,
            seekTarget: actual.seekTarget ?? seekTarget,
            seekGuardSeconds: actual.seekGuardSeconds ?? timingSelection.seekGuardSeconds,
            actual: actual.currentTime,
            readyState: actual.readyState,
            advanced: timingTransition.action === "advance",
            advanceFallback,
            presentedMediaTime: actual.presentedMediaTime ?? null,
            presentedFrames: actual.presentedFrames ?? null,
            verifiedPts: actual.verifiedPts,
            seekSettledAfterExactPts: actual.seekSettledAfterExactPts === true,
            staleResumeCount: actual.staleResumeCount ?? 0,
            mismatchRecoveries: actual.mismatchRecoveries ?? 0,
            tailAction: timingSelection.tailAction,
            heldAtEnd: timingSelection.pastDisplayEnd && mediaTailPolicy === "hold-last",
          });
          if (mediaFrameMode === "bitmap") {
            const snapshotStartedAt = performance.now();
            preparedFrameSources.set(clip, await createImageBitmap(mediaElement));
            phaseTotals.mediaSnapshotMs += performance.now() - snapshotStartedAt;
          } else {
            preparedFrameSources.set(clip, mediaElement);
          }
          continue;
        }

        const mediaElement = decoderForClip(clip);
        ({ decoderTarget, targetSnapDelta, targetFrameIndex } = mediaTargetForMode(
          rawTarget,
          fps,
          mediaTargetMode,
        ));
        seekTarget = decoderTarget + mediaSeekBiasFrames / fps;
        const alreadyPrepared = preparedDecoderTargets.get(mediaElement);
        if (alreadyPrepared != null && Math.abs(alreadyPrepared - decoderTarget) > 1 / fps / 4) {
          throw new Error(`One decoder source requested at two media times: ${alreadyPrepared} and ${decoderTarget}`);
        }
        if (alreadyPrepared != null) {
          preparedFrameSources.set(clip, mediaElement);
          mediaTimes.push({
            id: clip.element.id,
            decoderId: mediaElement.id,
            target: decoderTarget,
            rawTarget,
            decoderTarget,
            targetSnapDelta,
            targetFrameIndex,
            seekTarget,
            actual: mediaElement.currentTime,
            readyState: mediaElement.readyState,
            reused: true,
          });
          continue;
        }
        const previous = mediaStates.get(mediaElement);
        const canAdvance = mediaAdvanceMode === "playback-step"
          && previous
          && Math.abs(decoderTarget - previous.target - 1 / fps) <= 1 / fps / 4;
        let actual;
        if (canAdvance) {
          actual = await advanceVideoOneFrame(mediaElement, decoderTarget);
        } else {
          actual = await seekVideo(mediaElement, seekTarget);
          if (compositeMode === "native-tree") {
            actual = await advanceVideoOneFrame(mediaElement, decoderTarget);
          }
        }
        const advanceFallback = canAdvance && actual.overshot;
        if (advanceFallback) {
          await new Promise((resolveTask) => setTimeout(resolveTask, 0));
          actual = await seekVideo(mediaElement, seekTarget);
          if (compositeMode === "native-tree") {
            actual = await advanceVideoOneFrame(mediaElement, decoderTarget);
          }
        }
        mediaStates.set(mediaElement, { target: decoderTarget });
        preparedDecoderTargets.set(mediaElement, decoderTarget);
        mediaTimes.push({
          id: clip.element.id,
          decoderId: mediaElement.id,
          target: decoderTarget,
          rawTarget,
          decoderTarget,
          targetSnapDelta,
          targetFrameIndex,
          seekTarget,
          actual: actual.currentTime,
          readyState: actual.readyState,
          advanced: canAdvance,
          advanceFallback,
          presentedMediaTime: actual.presentedMediaTime ?? null,
          presentedFrames: actual.presentedFrames ?? null,
          heldAtEnd: actual.heldAtEnd ?? false,
        });
        if (mediaFrameMode === "bitmap") {
          const snapshotStartedAt = performance.now();
          preparedFrameSources.set(clip, await createImageBitmap(mediaElement));
          phaseTotals.mediaSnapshotMs += performance.now() - snapshotStartedAt;
        } else {
          preparedFrameSources.set(clip, mediaElement);
        }
      } catch (error) {
        if (timingDecoderLanes) support.mediaDecoderLanePool.final = timingDecoderLanes.snapshot();
        const failedMediaSeekMs = performance.now() - mediaStartedAt;
        phaseTotals.mediaSeekMs += failedMediaSeekMs;
        mediaSeekErrors.push({
          frameIndex,
          id: clip.element.id,
          target: decoderTarget,
          rawTarget,
          decoderTarget,
          targetSnapDelta,
          targetFrameIndex,
          sourceFrameIndex: timingSelection?.frameIndex ?? null,
          ptsTicks: timingSelection?.ptsTicks ?? null,
          ptsSeconds: timingSelection?.ptsSeconds ?? null,
          lookup: timingSelection?.lookup ?? null,
          sameFrame: timingTransition?.sameFrame ?? null,
          seekReason: timingTransition?.seekReason ?? null,
          decoderLaneErrorCode: error?.code ?? null,
          decoderLaneBlocker: error?.blocker === true,
          decoderLaneDetails: error?.details ?? null,
          error: String(error),
        });
        frameMetricsRecorder.record({
          partial: true,
          frameIndex,
          timelineFrame,
          time,
          activeClipIds: activeClips.map((activeClip) => activeClip.element.id),
          mediaTimes,
          mediaSeekMs: failedMediaSeekMs,
          failureStage: "media-seek",
          decoderLaneErrorCode: error?.code ?? null,
          decoderLaneBlocker: error?.blocker === true,
          decoderLaneDetails: error?.details ?? null,
          error: error?.stack || String(error),
          wallMs: performance.now() - frameStartedAt,
        });
        throw error;
      }
    }
    const mediaSeekMs = performance.now() - mediaStartedAt;
    phaseTotals.mediaSeekMs += mediaSeekMs;

    if (nativeScreenshot) {
      const paintStartedAt = performance.now();
      const waitReason = await waitForPaint();
      const paintWaitMs = performance.now() - paintStartedAt;
      phaseTotals.paintWaitMs += paintWaitMs;
      waitReasons[waitReason] = (waitReasons[waitReason] ?? 0) + 1;

      const captureResult = await api.captureFrame({ frameIndex, timelineFrame, time });
      if (captureResult.frameIndex !== frameIndex
          || captureResult.width !== width
          || captureResult.height !== height
          || !String(captureResult.contract ?? "").includes("main-process-sequential")
          || !/^[a-f0-9]{64}$/.test(String(captureResult.sha256 ?? ""))) {
        throw new Error(`Screenshot capture contract mismatch for frame ${frameIndex}`);
      }
      const { pngBytes, ...captureMetrics } = captureResult;
      let queueWaitMs = 0;
      let payloadWaitMs = captureResult.writeMs;
      if (webcodecsOutput) {
        if (!(pngBytes instanceof Uint8Array) || pngBytes.byteLength !== captureResult.byteLength) {
          throw new Error(`Screenshot WebCodecs payload mismatch for frame ${frameIndex}`);
        }
        const decodeStartedAt = performance.now();
        const bitmap = await createImageBitmap(new Blob([pngBytes], { type: "image/png" }));
        phaseTotals.screenshotPngDecodeMs += performance.now() - decodeStartedAt;
        if (bitmap.width !== width || bitmap.height !== height) {
          bitmap.close();
          throw new Error(
            `Screenshot WebCodecs bitmap is ${bitmap.width}x${bitmap.height}; expected ${width}x${height}`,
          );
        }
        outputContext.clearRect(0, 0, width, height);
        outputContext.drawImage(bitmap, 0, 0, width, height);
        bitmap.close();
        const timestamp = Math.round(frameIndex * 1_000_000 / fps);
        const duration = Math.round(1_000_000 / fps);
        const videoFrameStartedAt = performance.now();
        const videoFrame = new VideoFrame(outputCanvas, { timestamp, duration });
        phaseTotals.videoFrameCreateMs += performance.now() - videoFrameStartedAt;
        const encodeStartedAt = performance.now();
        encoder.encode(videoFrame, { keyFrame: frameIndex === 0 });
        phaseTotals.encodeSubmitMs += performance.now() - encodeStartedAt;
        videoFrame.close();
        encodeQueueMax = Math.max(encodeQueueMax, encoder.encodeQueueSize);
        if (encoder.encodeQueueSize > queueLimit) {
          const queueWaitStartedAt = performance.now();
          if (queueBackpressureMode === "flush") {
            await encoder.flush();
            queueWaitMs = performance.now() - queueWaitStartedAt;
            phaseTotals.queueFlushMs += queueWaitMs;
          } else {
            await waitForEncoderQueue(queueLowWatermark);
            queueWaitMs = performance.now() - queueWaitStartedAt;
            phaseTotals.queueBackpressureMs += queueWaitMs;
          }
        }
        if (pendingWrites.size >= payloadWriteWindow
            || pendingPayloadBytes >= maxPendingPayloadBytes) {
          const payloadWaitStartedAt = performance.now();
          await waitForPayloadWindow(payloadWriteLowWatermark, pendingPayloadLowWatermarkBytes);
          payloadWaitMs = performance.now() - payloadWaitStartedAt;
          phaseTotals.payloadBackpressureMs += payloadWaitMs;
        } else if (firstWriteError) {
          throw firstWriteError;
        }
      } else {
        outputChunks += 1;
        attemptedPayloadBytes += captureResult.byteLength;
        payloadBytes += captureResult.byteLength;
        payloadWriteMax = Math.max(payloadWriteMax, 1);
        payloadWriteMaxBytes = Math.max(payloadWriteMaxBytes, captureResult.byteLength);
      }
      phaseTotals.screenshotCaptureMs += captureResult.captureMs;
      phaseTotals.screenshotPngEncodeMs += captureResult.pngEncodeMs;
      phaseTotals.outputWriteMs += captureResult.writeMs;
      for (const source of preparedFrameSources.values()) source?.close?.();

      frameMetricsRecorder.record({
        frameIndex,
        timelineFrame,
        time,
        activeClipIds: activeClips.map((clip) => clip.element.id),
        mediaTimes,
        decoderLaneMaintenance,
        timelineSeekMs,
        mediaSeekMs,
        paintWaitMs,
        waitReason,
        layerBandCount: 1,
        proxyCanvasUpdates: [],
        drawElementImageMs: 0,
        videoDrawMs: 0,
        overlayCompositeMs: 0,
        queueWaitMs,
        payloadWaitMs,
        decoderWakePaintMs: 0,
        screenshotCapture: captureMetrics,
        transparentScreenshotClipIds: [...transparentScreenshotClips].map((clip) => clip.element.id),
        wallMs: performance.now() - frameStartedAt,
      });
      if ((frameIndex + 1) % 10 === 0 || frameIndex + 1 === frames) {
        api.reportProgress({ frame: frameIndex + 1, frames, elapsedMs: performance.now() - startedAt });
      }
      continue;
    }

    context.clearRect(0, 0, width, height);
    outputContext.clearRect(0, 0, width, height);
    const diagnosticBeforeDraw = diagnostics
      ? [...context.getImageData(width / 2, height / 2, 1, 1).data]
      : null;
    if (compositeMode !== "tree") {
      outputContext.fillStyle = "#000";
      outputContext.fillRect(0, 0, width, height);
    }

    const childVisibility = rootChildren.map((element) => [element, element.style.visibility]);
    let paintWaitMs = 0;
    let drawElementImageMs = 0;
    let videoDrawMs = 0;
    let overlayCompositeMs = 0;
    let layerBandCount = 0;
    let framePromotedDynamicOpacityElements = 0;
    const proxyCanvasUpdates = [];
    const frameWaitReasons = [];
    if (compositeMode === "layered") {
      const activeSet = new Set(activeClips);
      const renderableVideoSet = new Set(renderableVideos);
      const stackItems = rootChildren.map((element, order) => ({
        element,
        order,
        clip: clipByElement.get(element) ?? null,
        level: stackLevel(element),
      })).filter((item) => {
        if (item.element instanceof HTMLAudioElement) return false;
        if (item.clip && !activeSet.has(item.clip)) return false;
        const style = getComputedStyle(item.element);
        if (style.display === "none" || style.visibility === "hidden" || Number(style.opacity) <= 0.001) return false;
        if (item.clip?.isVideo && !renderableVideoSet.has(item.clip)) return false;
        return true;
      }).sort((left, right) => left.level - right.level || left.order - right.order);

      const captureHtmlBand = async (items) => {
        if (!items.length) return;
        const visible = new Set(items.map((item) => item.element));
        for (const [element, visibility] of childVisibility) {
          element.style.visibility = visible.has(element) ? visibility : "hidden";
        }
        const opacityRestorations = promoteDynamicPartialOpacity(items);
        framePromotedDynamicOpacityElements += opacityRestorations.length;
        promotedDynamicOpacityElements += opacityRestorations.length;
        try {
          context.clearRect(0, 0, width, height);
          const paintStartedAt = performance.now();
          const reason = await waitForPaint();
          const bandPaintMs = performance.now() - paintStartedAt;
          paintWaitMs += bandPaintMs;
          phaseTotals.paintWaitMs += bandPaintMs;
          waitReasons[reason] = (waitReasons[reason] ?? 0) + 1;
          frameWaitReasons.push(reason);

          const drawStartedAt = performance.now();
          context.save();
          try {
            if (scaleCapturedHtmlBands) {
              // Chromium's drawElementImage() ignores a transform on the captured
              // root. Apply the authored-to-output scale on the destination canvas
              // so text/SVG/CSS are rasterized directly at delivery resolution.
              context.scale(width / authoredRootWidth, height / authoredRootHeight);
            }
            context.drawElementImage(root, 0, 0);
          } finally {
            context.restore();
          }
          const bandDrawMs = performance.now() - drawStartedAt;
          drawElementImageMs += bandDrawMs;
          phaseTotals.drawElementImageMs += bandDrawMs;
        } finally {
          for (const [element, opacity] of opacityRestorations) element.style.opacity = opacity;
        }

        const compositeStartedAt = performance.now();
        outputContext.drawImage(canvas, 0, 0);
        const bandCompositeMs = performance.now() - compositeStartedAt;
        overlayCompositeMs += bandCompositeMs;
        phaseTotals.overlayCompositeMs += bandCompositeMs;
        layerBandCount += 1;
      };

      let htmlBand = [];
      for (const item of stackItems) {
        if (!item.clip?.isVideo) {
          htmlBand.push(item);
          continue;
        }
        await captureHtmlBand(htmlBand);
        htmlBand = [];
        const videoDrawStartedAt = performance.now();
        if (mediaTargetMode === "timing-plan" && !preparedFrameSources.has(item.clip)) {
          throw new Error(
            `Timing-plan clip ${clipLaneKey(item.clip)} reached compositing without an allocated decoder lane`,
          );
        }
        const preparedSource = preparedFrameSources.has(item.clip)
          ? preparedFrameSources.get(item.clip)
          : decoderForClip(item.clip);
        if (preparedSource) drawStyledVideo(outputContext, item.clip, preparedSource);
        const itemVideoDrawMs = performance.now() - videoDrawStartedAt;
        videoDrawMs += itemVideoDrawMs;
        phaseTotals.videoDrawMs += itemVideoDrawMs;
      }
      await captureHtmlBand(htmlBand);
      for (const [element, visibility] of childVisibility) element.style.visibility = visibility;
    } else if (compositeMode === "proxy-tree") {
      const videoDrawStartedAt = performance.now();
      for (const clip of renderableVideos) {
        if (!clip.isVideoProxy) {
          throw new Error(`proxy-tree renderable video ${clipLaneKey(clip)} is not an early proxy canvas`);
        }
        if (!preparedFrameSources.has(clip)) {
          throw new Error(
            `Timing-plan proxy ${clipLaneKey(clip)} reached compositing without an allocated decoder lane`,
          );
        }
        const update = drawVideoIntoProxyCanvas(clip, preparedFrameSources.get(clip));
        proxyCanvasUpdates.push({ id: clipLaneKey(clip), ...update });
      }
      videoDrawMs = performance.now() - videoDrawStartedAt;
      phaseTotals.videoDrawMs += videoDrawMs;
    } else if (compositeMode === "proxy") {
      const videoDrawStartedAt = performance.now();
      for (const { element: proxy } of videoProxies.values()) proxy.style.visibility = "hidden";
      for (const clip of renderableVideos) {
        const proxy = videoProxies.get(clip.element);
        const sourceWidth = clip.element.videoWidth || width;
        const sourceHeight = clip.element.videoHeight || height;
        if (proxy.element.width !== sourceWidth) proxy.element.width = sourceWidth;
        if (proxy.element.height !== sourceHeight) proxy.element.height = sourceHeight;
        proxy.context.drawImage(clip.element, 0, 0, sourceWidth, sourceHeight);
        proxy.element.style.cssText = clip.element.style.cssText;
        proxy.element.style.visibility = "visible";
        proxy.element.style.pointerEvents = "none";
      }
      for (const [element] of childVisibility) {
        if (element instanceof HTMLVideoElement) element.style.visibility = "hidden";
      }
      videoDrawMs = performance.now() - videoDrawStartedAt;
      phaseTotals.videoDrawMs += videoDrawMs;
    }

    if (compositeMode !== "layered") {
      const opacityRestorations = promoteDynamicPartialOpacity([{ element: root }]);
      framePromotedDynamicOpacityElements += opacityRestorations.length;
      promotedDynamicOpacityElements += opacityRestorations.length;
      try {
        const paintStartedAt = performance.now();
        const reason = await waitForPaint();
        paintWaitMs = performance.now() - paintStartedAt;
        phaseTotals.paintWaitMs += paintWaitMs;
        waitReasons[reason] = (waitReasons[reason] ?? 0) + 1;
        frameWaitReasons.push(reason);

        const drawStartedAt = performance.now();
        context.drawElementImage(root, 0, 0);
        drawElementImageMs = performance.now() - drawStartedAt;
        phaseTotals.drawElementImageMs += drawElementImageMs;
        layerBandCount = 1;
      } finally {
        for (const [element, opacity] of opacityRestorations) element.style.opacity = opacity;
      }
    }
    if (framePromotedDynamicOpacityElements > 0) framesWithPromotedDynamicOpacity += 1;
    if (diagnostics) {
      const samplePoints = [[0, 0], [width / 2, height / 2], [500, 500], [1000, 1000]];
      diagnosticPixelSamples.push(samplePoints.map(([x, y]) => ({
        x,
        y,
        rgba: [...outputContext.getImageData(x, y, 1, 1).data],
      })).concat([{ beforeDraw: diagnosticBeforeDraw }]));
    }
    for (const [element, visibility] of childVisibility) element.style.visibility = visibility;
    for (const { element: proxy } of videoProxies.values()) proxy.style.visibility = "hidden";
    if (!productionDecoderRuntime) {
      for (const source of preparedFrameSources.values()) source?.close?.();
    }
    if (productionDecoderRuntime) {
      productionFrameEnded = true;
      decoderLaneMaintenance = await productionDecoderRuntime.endOutputFrame();
      support.productionDecoder.lastFrame = {
        frameIndex,
        maintenance: decoderLaneMaintenance,
        runtime: productionDecoderRuntime.snapshot(),
      };
    }
    if (timingDecoderLanes) {
      decoderLaneMaintenance = timingDecoderLanes.endFrame();
      for (const laneId of decoderLaneMaintenance.pauseLaneIds) {
        const idleDecoder = decoderByLaneId.get(laneId);
        if (idleDecoder && !idleDecoder.paused) idleDecoder.pause();
      }
      for (const laneId of decoderLaneMaintenance.unloadLaneIds) {
        releaseDecoderLaneSource(laneId);
      }
      support.mediaDecoderLanePool.final = timingDecoderLanes.snapshot();
    }

    const timestamp = Math.round(frameIndex * 1_000_000 / fps);
    const duration = Math.round(1_000_000 / fps);
    const videoFrameStartedAt = performance.now();
    const videoFrame = new VideoFrame(outputCanvas, { timestamp, duration });
    phaseTotals.videoFrameCreateMs += performance.now() - videoFrameStartedAt;
    const encodeStartedAt = performance.now();
    encoder.encode(videoFrame, { keyFrame: frameIndex === 0 });
    phaseTotals.encodeSubmitMs += performance.now() - encodeStartedAt;
    videoFrame.close();
    encodeQueueMax = Math.max(encodeQueueMax, encoder.encodeQueueSize);
    let queueWaitMs = 0;
    if (encoder.encodeQueueSize > queueLimit) {
      const queueWaitStartedAt = performance.now();
      if (queueBackpressureMode === "flush") {
        await encoder.flush();
        queueWaitMs = performance.now() - queueWaitStartedAt;
        phaseTotals.queueFlushMs += queueWaitMs;
      } else {
        await waitForEncoderQueue(queueLowWatermark);
        queueWaitMs = performance.now() - queueWaitStartedAt;
        phaseTotals.queueBackpressureMs += queueWaitMs;
      }
    }
    let payloadWaitMs = 0;
    if (pendingWrites.size >= payloadWriteWindow
        || pendingPayloadBytes >= maxPendingPayloadBytes) {
      const payloadWaitStartedAt = performance.now();
      await waitForPayloadWindow(payloadWriteLowWatermark, pendingPayloadLowWatermarkBytes);
      payloadWaitMs = performance.now() - payloadWaitStartedAt;
      phaseTotals.payloadBackpressureMs += payloadWaitMs;
    } else if (firstWriteError) {
      throw firstWriteError;
    }

    let decoderWakePaintMs = 0;
    if (compositeMode === "layered"
        && !useDecoderDeck
        && !productionDecoderRuntime
        && frameIndex + 1 < frames
        && renderableVideos.length) {
      const wakeStartedAt = performance.now();
      await waitForPaint();
      decoderWakePaintMs = performance.now() - wakeStartedAt;
      phaseTotals.decoderWakePaintMs += decoderWakePaintMs;
    }

    frameMetricsRecorder.record({
      frameIndex,
      timelineFrame,
      time,
      activeClipIds: activeClips.map((clip) => clip.element.id),
      mediaTimes,
      decoderLaneMaintenance,
      timelineSeekMs,
      mediaSeekMs,
      paintWaitMs,
      waitReason: frameWaitReasons.join("+"),
      layerBandCount,
      proxyCanvasUpdates,
      promotedDynamicOpacityElements: framePromotedDynamicOpacityElements,
      drawElementImageMs,
      videoDrawMs,
      overlayCompositeMs,
      queueWaitMs,
      payloadWaitMs,
      decoderWakePaintMs,
      wallMs: performance.now() - frameStartedAt,
    });
    if ((frameIndex + 1) % 10 === 0 || frameIndex + 1 === frames) {
      api.reportProgress({ frame: frameIndex + 1, frames, elapsedMs: performance.now() - startedAt });
    }
    } catch (error) {
      productionFrameError = error;
      throw error;
    } finally {
      if (productionDecoderRuntime && !productionFrameEnded) {
        productionFrameEnded = true;
        try {
          const abortedMaintenance = await productionDecoderRuntime.endOutputFrame();
          support.productionDecoder.lastFrame = {
            frameIndex,
            aborted: true,
            maintenance: abortedMaintenance,
            runtime: productionDecoderRuntime.snapshot(),
          };
        } catch (cleanupError) {
          if (productionFrameError) {
            throw new AggregateError(
              [productionFrameError, cleanupError],
              `Production decoder frame ${frameIndex} failed and cleanup also failed`,
            );
          }
          throw cleanupError;
        }
      }
    }
  }

  if (nativeScreenshot && screenshotMediaRequestGate) {
    await api.setScreenshotMediaAccess({ frameIndex: frames, sources: [] });
    for (const video of loadedNativeVideos) {
      video.pause();
      video.load();
      mediaStates.delete(video);
      mediaCalibrationByDecoder.delete(video);
    }
    loadedNativeVideos.clear();
  }

  if (encoder) {
    const finalFlushStartedAt = performance.now();
    await encoder.flush();
    phaseTotals.finalFlushMs += performance.now() - finalFlushStartedAt;
    encoder.close();
  }
  await waitForPayloadWindow(0, 0);
  if (encoderError) throw new Error(encoderError);
  if (firstWriteError) throw firstWriteError;
  await disposeActiveProductionDecoder();

  const frameMetrics = frameMetricsRecorder.snapshot();
  await api.finish({
    frames,
    framesCompleted: frameMetrics.framesCompleted,
    fps,
    start,
    startFrame,
    width,
    height,
    wallMs: performance.now() - startedAt,
    outputChunks,
    attemptedPayloadBytes,
    payloadBytes,
    encodeQueueMax,
    partialOpacityPolicy,
    promotedDynamicOpacityElements,
    framesWithPromotedDynamicOpacity,
    queueLimit,
    queueLowWatermark,
    queueBackpressureMode,
    payloadWriteMax,
    pendingPayloadBytes,
    payloadWriteMaxBytes,
    payloadWriteWindow,
    payloadWriteLowWatermark,
    maxPendingPayloadBytes,
    pendingPayloadLowWatermarkBytes,
    mediaTargetMode,
    mediaTailPolicy,
    phaseTotals,
    waitReasons,
    mediaSeekErrors,
    frameTimings: frameMetrics.records,
    frameMetrics,
    diagnosticPixelSamples,
    diagnosticDomProbes,
    support,
  });
}

async function runFullCanvasRenderWithFailureReport() {
  try {
    await runFullCanvasRender();
  } catch (error) {
    let reportedError = error;
    try {
      await disposeActiveProductionDecoder();
    } catch (cleanupError) {
      reportedError = new Error(
        `${error?.stack || error}\nProduction decoder cleanup also failed: ${cleanupError?.stack || cleanupError}`,
      );
    }
    try {
      await window.hyperframesRenderKit.reportResults(partialResults(reportedError));
    } catch (reportError) {
      console.error("Failed to report partial renderer metrics", reportError);
    }
    throw reportedError;
  }
}

void runFullCanvasRenderWithFailureReport().catch(async (error) => {
  console.error(error);
  await window.hyperframesRenderKit.fail(error?.stack || String(error));
});
