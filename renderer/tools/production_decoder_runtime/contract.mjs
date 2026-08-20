export const PRODUCTION_DECODER_SCHEMA_VERSION = "1.0.0";
export const MEDIABUNNY_API_VERSION = "1.53.0";

export const DIRECT_DECISION = "direct-h264-avc1";
export const CACHE_DECISION = "canonical-cache-required";

export const DEFAULT_BROKER_LIMITS = Object.freeze({
  maximumBatchPackets: 8,
  maximumBatchBytes: 8 * 1024 * 1024,
  maximumGlobalDemuxBytes: 32 * 1024 * 1024,
  maximumOpenCursors: 8,
  maximumSources: 64,
  operationTimeoutMs: 15_000,
});

export const DEFAULT_RUNTIME_LIMITS = Object.freeze({
  decodeQueueMax: 4,
  // Some AVC decoders retain reorderDepth + 1 submitted pictures before
  // emitting the first presentation frame. A lead of four deadlocks valid
  // streams whose measured presentation reorder depth is three.
  decodeLeadMax: 8,
  readyFramesMax: 8,
  maxWarmAdvanceFrames: 12,
  maxTotalLanes: 12,
  maxLanesPerSource: 2,
  idleUnloadFrames: 120,
  maximumTargetCacheEntries: 512,
  maximumPacketMetadataEntries: 256,
  operationTimeoutMs: 15_000,
});

export class ProductionDecoderError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = "ProductionDecoderError";
    this.code = code;
    this.details = details;
  }
}

export function invariant(condition, code, message, details = {}) {
  if (!condition) throw new ProductionDecoderError(code, message, details);
}

export function isCacheRequiredError(error) {
  return typeof error?.code === "string" && error.code.startsWith("CACHE_REQUIRED_");
}

export function cacheRequiredDecision(error, sourceIdentity) {
  invariant(isCacheRequiredError(error), "INVALID_CACHE_DECISION_ERROR",
    "Only CACHE_REQUIRED_* errors can become a canonical-cache decision", {
      code: error?.code ?? null,
    });
  return Object.freeze({
    schemaVersion: PRODUCTION_DECODER_SCHEMA_VERSION,
    decision: CACHE_DECISION,
    sourceIdentity,
    reason: Object.freeze({
      code: error.code,
      message: error.message,
      details: compactDetails(error.details),
    }),
    canonicalContract: Object.freeze({
      container: "mp4",
      codec: "h264",
      sampleEntry: "avc1",
      timing: "cfr-zero-origin",
      alpha: false,
      rotationDegrees: 0,
      highDynamicRange: false,
      integration: "tools/canonical_media_fallback",
    }),
  });
}

export function compactDetails(details) {
  if (!details || typeof details !== "object") return {};
  const result = {};
  for (const [key, value] of Object.entries(details)) {
    if (typeof value === "string") result[key] = value.slice(0, 256);
    else if (typeof value === "number" || typeof value === "boolean" || value == null) result[key] = value;
  }
  return result;
}

export function validateBoundedInteger(value, label, minimum, maximum, code = "INVALID_LIMIT") {
  invariant(Number.isSafeInteger(value) && value >= minimum && value <= maximum,
    code, `${label} must be an integer in [${minimum}, ${maximum}]`, { label, value, minimum, maximum });
  return value;
}

/**
 * A lane may hold one unacknowledged maximum-size demux batch. Reject a
 * combined host/runtime configuration that could leave every lane waiting on
 * a byte reservation that can never be granted.
 */
export function validateDemuxConcurrencyBudget({
  maxTotalLanes,
  maximumBatchBytes,
  maximumGlobalDemuxBytes,
  maximumOpenCursors,
}) {
  for (const [label, value] of Object.entries({
    maxTotalLanes,
    maximumBatchBytes,
    maximumGlobalDemuxBytes,
    maximumOpenCursors,
  })) {
    invariant(Number.isSafeInteger(value) && value > 0,
      "INVALID_DEMUX_CONCURRENCY_BUDGET",
      `${label} must be a positive safe integer`, { label, value });
  }
  const requiredGlobalDemuxBytes = maxTotalLanes * maximumBatchBytes;
  invariant(Number.isSafeInteger(requiredGlobalDemuxBytes)
    && maximumGlobalDemuxBytes >= requiredGlobalDemuxBytes,
  "DEMUX_GLOBAL_BUDGET_UNSAFE",
  "Global demux bytes must reserve one maximum-size batch for every active decoder lane", {
    maxTotalLanes,
    maximumBatchBytes,
    maximumGlobalDemuxBytes,
    requiredGlobalDemuxBytes,
  });
  invariant(maximumOpenCursors >= maxTotalLanes,
    "DEMUX_CURSOR_BUDGET_UNSAFE",
    "Open cursor capacity must reserve one cursor for every active decoder lane", {
      maxTotalLanes,
      maximumOpenCursors,
    });
  return Object.freeze({
    maxTotalLanes,
    maximumBatchBytes,
    maximumGlobalDemuxBytes,
    maximumOpenCursors,
    requiredGlobalDemuxBytes,
    saturationSafe: true,
  });
}

export function validateSourceIdentity(value, label = "sourceIdentity") {
  invariant(typeof value === "string" && value.length > 0 && value.length <= 512,
    "INVALID_SOURCE_IDENTITY", `${label} must be a non-empty bounded string`, {
      type: typeof value,
      length: typeof value === "string" ? value.length : null,
    });
  return value;
}

export function validateOpaqueToken(value, label = "token") {
  invariant(typeof value === "string"
    && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value),
  "INVALID_OPAQUE_TOKEN", `${label} must be a UUIDv4`, { label });
  return value;
}

export function asUint8Array(value, label = "binary data") {
  if (value instanceof Uint8Array) return value;
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (ArrayBuffer.isView(value)) return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  throw new ProductionDecoderError("INVALID_BINARY_DATA", `${label} must be ArrayBuffer-compatible`, {
    label,
    type: Object.prototype.toString.call(value),
  });
}

export function makePresentationKey(sourceIdentity, ptsUs) {
  validateSourceIdentity(sourceIdentity);
  invariant(Number.isSafeInteger(ptsUs), "INVALID_PRESENTATION_PTS",
    "Presentation PTS must be an integer number of microseconds", { ptsUs });
  return `${sourceIdentity}:0:${ptsUs}`;
}

/**
 * Convert an integer media time-base timestamp to the exact integer
 * microsecond domain used by Mediabunny/WebCodecs. BigInt avoids a float
 * boundary turning (for example) 50_000us into 49_999us.
 */
export function ticksToMicrosecondsExact(ticks, timeBase) {
  invariant(Number.isSafeInteger(ticks) && ticks >= 0, "INVALID_PRESENTATION_TICKS",
    "Presentation ticks must be a non-negative safe integer", { ticks });
  const match = String(timeBase ?? "").match(/^(\d+)\/(\d+)$/);
  invariant(match != null, "INVALID_PRESENTATION_TIME_BASE",
    "Presentation time base must be a positive integer ratio", { timeBase: String(timeBase ?? "") });
  const numerator = Number(match[1]);
  const denominator = Number(match[2]);
  invariant(Number.isSafeInteger(numerator) && numerator > 0
    && Number.isSafeInteger(denominator) && denominator > 0,
  "INVALID_PRESENTATION_TIME_BASE", "Presentation time base must be a positive safe integer ratio", {
    timeBase: String(timeBase),
  });
  const value = (BigInt(ticks) * BigInt(numerator) * 1_000_000n) / BigInt(denominator);
  invariant(value <= BigInt(Number.MAX_SAFE_INTEGER), "PRESENTATION_MICROSECONDS_OVERFLOW",
    "Presentation timestamp exceeds the safe integer microsecond domain", { ticks, timeBase: String(timeBase) });
  return Number(value);
}

export function classifyLaneTransition(state, targetOrdinal, limits = DEFAULT_RUNTIME_LIMITS) {
  invariant(Number.isSafeInteger(targetOrdinal) && targetOrdinal >= 0,
    "INVALID_TARGET_ORDINAL", "Target presentation ordinal must be a non-negative integer", { targetOrdinal });
  if (state.heldOrdinal === targetOrdinal) return { action: "reuse", reason: "held-exact-target" };
  if (!state.configured) return { action: "seek", reason: "initial-configure" };
  if (state.drained) return { action: "seek", reason: "decoder-drained" };
  if (!Number.isSafeInteger(state.lastRequestedOrdinal)) return { action: "seek", reason: "no-request-history" };
  if (targetOrdinal < state.lastRequestedOrdinal) return { action: "seek", reason: "backward-request" };
  if (targetOrdinal === state.lastRequestedOrdinal) {
    return { action: "seek", reason: "same-target-without-held-frame" };
  }
  if (targetOrdinal - state.lastRequestedOrdinal > limits.maxWarmAdvanceFrames) {
    return { action: "seek", reason: "far-forward-request" };
  }
  return { action: "advance", reason: "warm-forward-request" };
}

export function serializeProductionDecoderError(error) {
  return {
    name: error?.name ?? "Error",
    code: error?.code ?? null,
    message: error?.message ?? String(error),
    details: compactDetails(error?.details),
  };
}
