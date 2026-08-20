export const DEFAULT_CHILD_CANVAS_THRESHOLDS = Object.freeze({
  full: Object.freeze({
    maximumMeanAbsoluteError: 7,
    maximumBadPixelFraction: 0.09,
    minimumLumaSsim: 0.975,
    local: Object.freeze({
      maximumWorstTileMeanAbsoluteError: 8,
      maximumP95TileMeanAbsoluteError: 5,
      maximumWorstTileBadBlockFraction: 0.3,
      maximumP95TileBadBlockFraction: 0.1,
      minimumWorstTileLumaSsim: 0.9,
      minimumP05TileLumaSsim: 0.94,
    }),
  }),
  feature: Object.freeze({
    maximumMeanAbsoluteError: 10,
    maximumBadPixelFraction: 0.14,
    minimumLumaSsim: 0.94,
    local: Object.freeze({
      maximumWorstTileMeanAbsoluteError: 10,
      maximumP95TileMeanAbsoluteError: 7,
      maximumWorstTileBadBlockFraction: 0.4,
      maximumP95TileBadBlockFraction: 0.2,
      minimumWorstTileLumaSsim: 0.88,
      minimumP05TileLumaSsim: 0.92,
    }),
  }),
  localAnalysis: Object.freeze({
    tileSizes: Object.freeze([64, 128]),
    tileStrideFraction: 0.5,
    blockSize: 8,
    badBlockMeanChannelDelta: 12,
    retainedWorstTiles: 3,
  }),
  badPixelChannelDelta: 24,
  directVideoEquivalent: Object.freeze({
    maximumMeanAbsoluteError: 8,
    maximumBadPixelFraction: 0.1,
    minimumLumaSsim: 0.97,
  }),
  directVideoBlackRatio: 0.3,
});

function assertBitmap(bitmap, width, height, name) {
  if (!(bitmap instanceof Uint8Array) && !Buffer.isBuffer(bitmap)) {
    throw new TypeError(`${name} must be a Uint8Array or Buffer`);
  }
  const expected = width * height * 4;
  if (bitmap.byteLength !== expected) {
    throw new RangeError(`${name} has ${bitmap.byteLength} bytes; expected ${expected} for ${width}x${height}`);
  }
}

function normalizeRegion(region, width, height) {
  const normalized = {
    name: region?.name ?? "full",
    x: Math.max(0, Math.floor(region?.x ?? 0)),
    y: Math.max(0, Math.floor(region?.y ?? 0)),
    width: Math.max(0, Math.floor(region?.width ?? width)),
    height: Math.max(0, Math.floor(region?.height ?? height)),
  };
  normalized.width = Math.min(normalized.width, width - normalized.x);
  normalized.height = Math.min(normalized.height, height - normalized.y);
  if (normalized.width <= 0 || normalized.height <= 0) {
    throw new RangeError(`Region ${normalized.name} is empty or outside ${width}x${height}`);
  }
  return normalized;
}

function sampleLuma(bitmap, offset) {
  // NativeImage uses the same byte order for both inputs. Equal RGB weighting keeps
  // the metric independent of whether the platform exposes BGRA or RGBA.
  return (bitmap[offset] + bitmap[offset + 1] + bitmap[offset + 2]) / 3;
}

function lumaSsimFromMoments({
  count,
  referenceSum,
  candidateSum,
  referenceSquared,
  candidateSquared,
  product,
}) {
  const referenceMean = referenceSum / count;
  const candidateMean = candidateSum / count;
  const referenceVariance = Math.max(0, referenceSquared / count - referenceMean ** 2);
  const candidateVariance = Math.max(0, candidateSquared / count - candidateMean ** 2);
  const covariance = product / count - referenceMean * candidateMean;
  const c1 = (0.01 * 255) ** 2;
  const c2 = (0.03 * 255) ** 2;
  const rawSsim = ((2 * referenceMean * candidateMean + c1) * (2 * covariance + c2))
    / ((referenceMean ** 2 + candidateMean ** 2 + c1) * (referenceVariance + candidateVariance + c2));
  return {
    lumaSsim: Math.max(-1, Math.min(1, rawSsim)),
    referenceMean,
    candidateMean,
    referenceVariance,
    candidateVariance,
  };
}

function positiveInteger(value, name) {
  const normalized = Math.floor(Number(value));
  if (!Number.isFinite(normalized) || normalized <= 0) {
    throw new RangeError(`${name} must be a positive integer`);
  }
  return normalized;
}

function normalizeLocalAnalysis(localAnalysis) {
  if (localAnalysis === false || localAnalysis == null) return null;
  const source = localAnalysis === true
    ? DEFAULT_CHILD_CANVAS_THRESHOLDS.localAnalysis
    : localAnalysis;
  const tileSizes = [...new Set((source.tileSizes ?? []).map((value) => positiveInteger(value, "tile size")))]
    .sort((left, right) => left - right);
  if (tileSizes.length === 0) throw new RangeError("localAnalysis.tileSizes must not be empty");
  const tileStrideFraction = Number(source.tileStrideFraction);
  if (!Number.isFinite(tileStrideFraction) || tileStrideFraction <= 0 || tileStrideFraction > 1) {
    throw new RangeError("localAnalysis.tileStrideFraction must be in (0, 1]");
  }
  const badBlockMeanChannelDelta = Number(source.badBlockMeanChannelDelta);
  if (!Number.isFinite(badBlockMeanChannelDelta) || badBlockMeanChannelDelta < 0) {
    throw new RangeError("localAnalysis.badBlockMeanChannelDelta must be a non-negative number");
  }
  return {
    tileSizes,
    tileStrideFraction,
    blockSize: positiveInteger(source.blockSize, "localAnalysis.blockSize"),
    badBlockMeanChannelDelta,
    retainedWorstTiles: positiveInteger(source.retainedWorstTiles, "localAnalysis.retainedWorstTiles"),
  };
}

function axisTileStarts(origin, length, size, stride) {
  if (length <= size) return [origin];
  const last = origin + length - size;
  const starts = [];
  for (let value = origin; value <= last; value += stride) starts.push(value);
  if (starts.at(-1) !== last) starts.push(last);
  return starts;
}

function percentile(values, fraction) {
  if (values.length === 0) return null;
  const sorted = [...values].sort((left, right) => left - right);
  const position = Math.max(0, Math.min(1, fraction)) * (sorted.length - 1);
  const low = Math.floor(position);
  const high = Math.ceil(position);
  if (low === high) return sorted[low];
  const weight = position - low;
  return sorted[low] * (1 - weight) + sorted[high] * weight;
}

function compactTile(tile) {
  return {
    scale: tile.scale,
    region: tile.region,
    blocks: tile.blocks,
    blockSize: tile.blockSize,
    lowFrequencyMeanAbsoluteError: tile.lowFrequencyMeanAbsoluteError,
    badBlockMeanChannelDelta: tile.badBlockMeanChannelDelta,
    badBlocks: tile.badBlocks,
    badBlockFraction: tile.badBlockFraction,
    lumaSsim: tile.lumaSsim,
    referenceMeanLuma: tile.referenceMeanLuma,
    candidateMeanLuma: tile.candidateMeanLuma,
    referenceLumaVariance: tile.referenceLumaVariance,
    candidateLumaVariance: tile.candidateLumaVariance,
  };
}

function retainedWorst(tiles, field, direction, count) {
  return [...tiles]
    .sort((left, right) => direction * (left[field] - right[field]))
    .slice(0, count)
    .map(compactTile);
}

function summarizeTiles(tiles, retainedWorstTiles) {
  const lumaSsim = tiles.map((tile) => tile.lumaSsim);
  const meanAbsoluteError = tiles.map((tile) => tile.lowFrequencyMeanAbsoluteError);
  const badBlockFraction = tiles.map((tile) => tile.badBlockFraction);
  return {
    tileCount: tiles.length,
    percentiles: {
      lumaSsim: {
        p01: percentile(lumaSsim, 0.01),
        p05: percentile(lumaSsim, 0.05),
        p10: percentile(lumaSsim, 0.1),
        p50: percentile(lumaSsim, 0.5),
      },
      lowFrequencyMeanAbsoluteError: {
        p50: percentile(meanAbsoluteError, 0.5),
        p90: percentile(meanAbsoluteError, 0.9),
        p95: percentile(meanAbsoluteError, 0.95),
        p99: percentile(meanAbsoluteError, 0.99),
      },
      badBlockFraction: {
        p50: percentile(badBlockFraction, 0.5),
        p90: percentile(badBlockFraction, 0.9),
        p95: percentile(badBlockFraction, 0.95),
        p99: percentile(badBlockFraction, 0.99),
      },
    },
    worstTiles: {
      lumaSsim: retainedWorst(tiles, "lumaSsim", 1, retainedWorstTiles),
      lowFrequencyMeanAbsoluteError: retainedWorst(
        tiles,
        "lowFrequencyMeanAbsoluteError",
        -1,
        retainedWorstTiles,
      ),
      badBlockFraction: retainedWorst(tiles, "badBlockFraction", -1, retainedWorstTiles),
    },
  };
}

function compareLowFrequencyTile(reference, candidate, bitmapWidth, {
  name,
  x,
  y,
  width,
  height,
  scale,
}, config) {
  let blockCount = 0;
  let badBlocks = 0;
  let blockAbsoluteErrorSum = 0;
  let referenceLumaSum = 0;
  let candidateLumaSum = 0;
  let referenceLumaSquared = 0;
  let candidateLumaSquared = 0;
  let lumaProduct = 0;

  for (let blockY = y; blockY < y + height; blockY += config.blockSize) {
    const blockHeight = Math.min(config.blockSize, y + height - blockY);
    for (let blockX = x; blockX < x + width; blockX += config.blockSize) {
      const blockWidth = Math.min(config.blockSize, x + width - blockX);
      const blockPixels = blockWidth * blockHeight;
      const absoluteChannelDeltas = [0, 0, 0];
      let blockReferenceLuma = 0;
      let blockCandidateLuma = 0;
      for (let sampleY = blockY; sampleY < blockY + blockHeight; sampleY += 1) {
        for (let sampleX = blockX; sampleX < blockX + blockWidth; sampleX += 1) {
          const offset = (sampleY * bitmapWidth + sampleX) * 4;
          for (let channel = 0; channel < 3; channel += 1) {
            absoluteChannelDeltas[channel] += Math.abs(
              reference[offset + channel] - candidate[offset + channel],
            );
          }
          blockReferenceLuma += sampleLuma(reference, offset);
          blockCandidateLuma += sampleLuma(candidate, offset);
        }
      }
      const channelMeans = absoluteChannelDeltas.map((value) => value / blockPixels);
      const blockMeanAbsoluteError = channelMeans.reduce((sum, value) => sum + value, 0) / 3;
      if (Math.max(...channelMeans) > config.badBlockMeanChannelDelta) badBlocks += 1;
      const referenceLuma = blockReferenceLuma / blockPixels;
      const candidateLuma = blockCandidateLuma / blockPixels;
      blockAbsoluteErrorSum += blockMeanAbsoluteError;
      referenceLumaSum += referenceLuma;
      candidateLumaSum += candidateLuma;
      referenceLumaSquared += referenceLuma * referenceLuma;
      candidateLumaSquared += candidateLuma * candidateLuma;
      lumaProduct += referenceLuma * candidateLuma;
      blockCount += 1;
    }
  }

  const moments = lumaSsimFromMoments({
    count: blockCount,
    referenceSum: referenceLumaSum,
    candidateSum: candidateLumaSum,
    referenceSquared: referenceLumaSquared,
    candidateSquared: candidateLumaSquared,
    product: lumaProduct,
  });
  return {
    scale,
    region: { name, x, y, width, height },
    blocks: blockCount,
    blockSize: config.blockSize,
    lowFrequencyMeanAbsoluteError: blockAbsoluteErrorSum / blockCount,
    badBlockMeanChannelDelta: config.badBlockMeanChannelDelta,
    badBlocks,
    badBlockFraction: badBlocks / blockCount,
    lumaSsim: moments.lumaSsim,
    referenceMeanLuma: moments.referenceMean,
    candidateMeanLuma: moments.candidateMean,
    referenceLumaVariance: moments.referenceVariance,
    candidateLumaVariance: moments.candidateVariance,
  };
}

function compareLocalTiles(reference, candidate, bitmapWidth, bounds, config) {
  const scales = [];
  const allTiles = [];
  const effectiveScales = new Set();
  for (const requestedTileSize of config.tileSizes) {
    const tileWidth = Math.min(requestedTileSize, bounds.width);
    const tileHeight = Math.min(requestedTileSize, bounds.height);
    const effectiveScale = `${tileWidth}x${tileHeight}`;
    if (effectiveScales.has(effectiveScale)) continue;
    effectiveScales.add(effectiveScale);
    const stride = Math.max(1, Math.floor(requestedTileSize * config.tileStrideFraction));
    const xStarts = axisTileStarts(bounds.x, bounds.width, tileWidth, stride);
    const yStarts = axisTileStarts(bounds.y, bounds.height, tileHeight, stride);
    const tiles = [];
    for (const y of yStarts) {
      for (const x of xStarts) {
        tiles.push(compareLowFrequencyTile(reference, candidate, bitmapWidth, {
          name: bounds.name,
          x,
          y,
          width: tileWidth,
          height: tileHeight,
          scale: requestedTileSize,
        }, config));
      }
    }
    allTiles.push(...tiles);
    scales.push({
      requestedTileSize,
      effectiveTileWidth: tileWidth,
      effectiveTileHeight: tileHeight,
      stride,
      ...summarizeTiles(tiles, config.retainedWorstTiles),
    });
  }
  return {
    schemaVersion: "1.0.0",
    method: "overlapping-multiscale-tiles-with-block-mean-v1",
    config,
    scales,
    aggregate: summarizeTiles(allTiles, config.retainedWorstTiles),
  };
}

export function compareBitmaps(reference, candidate, width, height, {
  region = null,
  badPixelChannelDelta = DEFAULT_CHILD_CANVAS_THRESHOLDS.badPixelChannelDelta,
  localAnalysis = DEFAULT_CHILD_CANVAS_THRESHOLDS.localAnalysis,
} = {}) {
  assertBitmap(reference, width, height, "reference");
  assertBitmap(candidate, width, height, "candidate");
  const bounds = normalizeRegion(region, width, height);
  let absoluteError = 0;
  let squaredError = 0;
  let badPixels = 0;
  let pixelCount = 0;
  let referenceLumaSum = 0;
  let candidateLumaSum = 0;
  let referenceLumaSquared = 0;
  let candidateLumaSquared = 0;
  let lumaProduct = 0;

  for (let y = bounds.y; y < bounds.y + bounds.height; y += 1) {
    for (let x = bounds.x; x < bounds.x + bounds.width; x += 1) {
      const offset = (y * width + x) * 4;
      let maximumDelta = 0;
      for (let channel = 0; channel < 3; channel += 1) {
        const delta = Math.abs(reference[offset + channel] - candidate[offset + channel]);
        absoluteError += delta;
        squaredError += delta * delta;
        maximumDelta = Math.max(maximumDelta, delta);
      }
      if (maximumDelta > badPixelChannelDelta) badPixels += 1;
      const referenceLuma = sampleLuma(reference, offset);
      const candidateLuma = sampleLuma(candidate, offset);
      referenceLumaSum += referenceLuma;
      candidateLumaSum += candidateLuma;
      referenceLumaSquared += referenceLuma * referenceLuma;
      candidateLumaSquared += candidateLuma * candidateLuma;
      lumaProduct += referenceLuma * candidateLuma;
      pixelCount += 1;
    }
  }

  const channelCount = pixelCount * 3;
  const moments = lumaSsimFromMoments({
    count: pixelCount,
    referenceSum: referenceLumaSum,
    candidateSum: candidateLumaSum,
    referenceSquared: referenceLumaSquared,
    candidateSquared: candidateLumaSquared,
    product: lumaProduct,
  });
  const localConfig = normalizeLocalAnalysis(localAnalysis);

  return {
    region: bounds,
    pixels: pixelCount,
    meanAbsoluteError: absoluteError / channelCount,
    rootMeanSquaredError: Math.sqrt(squaredError / channelCount),
    badPixelChannelDelta,
    badPixels,
    badPixelFraction: badPixels / pixelCount,
    lumaSsim: moments.lumaSsim,
    referenceMeanLuma: moments.referenceMean,
    candidateMeanLuma: moments.candidateMean,
    referenceLumaVariance: moments.referenceVariance,
    candidateLumaVariance: moments.candidateVariance,
    localAnalysis: localConfig
      ? compareLocalTiles(reference, candidate, width, bounds, localConfig)
      : null,
  };
}

function maximumCheck(actual, threshold) {
  return {
    pass: Number.isFinite(actual) && actual <= threshold,
    actual,
    comparator: "<=",
    threshold,
  };
}

function minimumCheck(actual, threshold) {
  return {
    pass: Number.isFinite(actual) && actual >= threshold,
    actual,
    comparator: ">=",
    threshold,
  };
}

function firstWorstValue(summary, group, field) {
  return summary?.worstTiles?.[group]?.[0]?.[field];
}

export function evaluateBitmapMetric(metric, thresholds) {
  const rawChecks = {
    meanAbsoluteError: maximumCheck(
      metric?.meanAbsoluteError,
      thresholds.maximumMeanAbsoluteError,
    ),
    badPixelFraction: maximumCheck(
      metric?.badPixelFraction,
      thresholds.maximumBadPixelFraction,
    ),
    lumaSsim: minimumCheck(metric?.lumaSsim, thresholds.minimumLumaSsim),
  };
  const rawPass = Object.values(rawChecks).every((check) => check.pass);

  let localChecks = null;
  let localPass = true;
  if (thresholds.local != null) {
    const summary = metric?.localAnalysis?.aggregate;
    localChecks = summary
      ? {
        worstTileMeanAbsoluteError: maximumCheck(
          firstWorstValue(summary, "lowFrequencyMeanAbsoluteError", "lowFrequencyMeanAbsoluteError"),
          thresholds.local.maximumWorstTileMeanAbsoluteError,
        ),
        p95TileMeanAbsoluteError: maximumCheck(
          summary.percentiles?.lowFrequencyMeanAbsoluteError?.p95,
          thresholds.local.maximumP95TileMeanAbsoluteError,
        ),
        worstTileBadBlockFraction: maximumCheck(
          firstWorstValue(summary, "badBlockFraction", "badBlockFraction"),
          thresholds.local.maximumWorstTileBadBlockFraction,
        ),
        p95TileBadBlockFraction: maximumCheck(
          summary.percentiles?.badBlockFraction?.p95,
          thresholds.local.maximumP95TileBadBlockFraction,
        ),
        worstTileLumaSsim: minimumCheck(
          firstWorstValue(summary, "lumaSsim", "lumaSsim"),
          thresholds.local.minimumWorstTileLumaSsim,
        ),
        p05TileLumaSsim: minimumCheck(
          summary.percentiles?.lumaSsim?.p05,
          thresholds.local.minimumP05TileLumaSsim,
        ),
      }
      : {
        localAnalysisAvailable: {
          pass: false,
          actual: false,
          comparator: "===",
          threshold: true,
        },
      };
    localPass = Object.values(localChecks).every((check) => check.pass);
  }

  const failures = [];
  for (const [check, result] of Object.entries(rawChecks)) {
    if (!result.pass) failures.push({ scope: "raw", check, ...result });
  }
  for (const [check, result] of Object.entries(localChecks ?? {})) {
    if (!result.pass) failures.push({ scope: "local", check, ...result });
  }
  return {
    pass: rawPass && localPass,
    rawPass,
    localPass,
    rawChecks,
    localChecks,
    failures,
  };
}

export function metricPasses(metric, thresholds) {
  return evaluateBitmapMetric(metric, thresholds).pass;
}

export function evaluateChildCanvasGate({
  fullMetric,
  featureMetrics,
  support,
  thresholds = DEFAULT_CHILD_CANVAS_THRESHOLDS,
}) {
  const supportChecks = {
    drawElementImage: support?.drawElementImage === true,
    requestPaint: support?.requestPaint === true,
    cssTransform: support?.cssTransform === true,
    cssBorderRadius: support?.cssBorderRadius === true,
    cssFilter: support?.cssFilter === true,
    cssBackdropFilter: support?.cssBackdropFilter === true,
  };
  const fullEvaluation = evaluateBitmapMetric(fullMetric, thresholds.full);
  const fullPass = fullEvaluation.pass;
  const featureResults = featureMetrics.map((metric) => {
    const evaluation = evaluateBitmapMetric(metric, thresholds.feature);
    return {
      name: metric.region.name,
      pass: evaluation.pass,
      metric,
      evaluation,
    };
  });
  const supportPass = Object.values(supportChecks).every(Boolean);
  return {
    pass: supportPass && fullPass && featureResults.every((item) => item.pass),
    supportPass,
    supportChecks,
    fullPass,
    fullMetric,
    fullEvaluation,
    featureResults,
    thresholds,
    rule: "All declared CSS capabilities, global metrics, and local multiscale tile metrics must pass in every region; partial support or localized damage is a hard rejection",
  };
}

export function classifyDirectVideoControl(metric, {
  thresholds = DEFAULT_CHILD_CANVAS_THRESHOLDS,
} = {}) {
  const equivalent = metricPasses(metric, thresholds.directVideoEquivalent);
  const lumaRatio = metric.referenceMeanLuma > 1e-9
    ? metric.candidateMeanLuma / metric.referenceMeanLuma
    : null;
  let classification;
  if (equivalent) classification = "captured-equivalent";
  else if (lumaRatio != null && lumaRatio <= thresholds.directVideoBlackRatio) classification = "black-or-missing-video-pixels";
  else classification = "partial-stale-or-different-video-pixels";
  return {
    classification,
    equivalent,
    lumaRatio,
    metric,
    interpretation: equivalent
      ? "This Chrome build may capture direct <video>; validate decoded frame identity before relying on it"
      : classification === "black-or-missing-video-pixels"
        ? "The direct <video> control reproduces the known CanvasDrawElement external-video loss"
        : "The direct <video> path is not pixel-equivalent and is not a safe backend",
  };
}

export function makeAmplifiedDifference(reference, candidate, width, height, amplification = 4) {
  assertBitmap(reference, width, height, "reference");
  assertBitmap(candidate, width, height, "candidate");
  const output = Buffer.alloc(width * height * 4);
  for (let offset = 0; offset < output.length; offset += 4) {
    output[offset] = Math.min(255, Math.abs(reference[offset] - candidate[offset]) * amplification);
    output[offset + 1] = Math.min(255, Math.abs(reference[offset + 1] - candidate[offset + 1]) * amplification);
    output[offset + 2] = Math.min(255, Math.abs(reference[offset + 2] - candidate[offset + 2]) * amplification);
    output[offset + 3] = 255;
  }
  return output;
}

export function buildProxyReplacementPlan({ videoDescriptor, childCanvasGate }) {
  if (!childCanvasGate?.pass) {
    return {
      eligible: false,
      reason: "child-canvas-pixel-gate-failed",
      steps: [],
    };
  }
  const preservedAttributes = [
    "id", "class", "style", "data-start", "data-duration", "data-track-index", "data-media-start",
    "data-hf-id", "aria-label", "aria-hidden",
  ].filter((name) => videoDescriptor?.attributes?.[name] != null);
  return {
    eligible: true,
    source: videoDescriptor?.source ?? null,
    proxyElement: "canvas",
    preservedAttributes,
    removedMediaAttributes: ["src", "crossorigin", "muted", "playsinline", "preload", "poster"],
    steps: [
      "Create an external hidden decoder lane selected by RenderPlan source+PTS requirements",
      "Replace the visible video node with a canvas carrying the same id, class, style, data timing, and DOM position",
      "Size the canvas backing store to the decoded frame while retaining the original CSS box/object-fit contract",
      "For each output frame, verify the planned PTS, then drawImage the decoded frame into the proxy canvas",
      "Request paint and drawElementImage the unchanged composition root once, preserving browser CSS and stacking",
      "If any capability or golden-frame gate fails, reject this backend and use screenshot fallback",
    ],
    invariants: [
      "Proxy substitution happens before composition scripts and timelines resolve DOM targets",
      "No duplicate id exists while the proxy is installed",
      "RenderPlan rejects or rewrites CSS selectors that depend on the video tag name",
      "Decoder lifecycle is separate from visible DOM lifecycle",
      "One decoder lane cannot serve two different PTS values in the same output frame",
      "Proxy bitmap update and root paint must complete before capture",
      "The proxy must not silently emulate unsupported video semantics such as live controls or protected content",
    ],
  };
}
