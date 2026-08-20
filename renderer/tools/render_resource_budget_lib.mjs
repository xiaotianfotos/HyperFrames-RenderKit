const MIB = 1024 * 1024;

function assertPositiveInteger(value, name) {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error(`${name} must be a positive safe integer; got ${value}`);
  }
}

function align(value, alignment) {
  return Math.ceil(value / alignment) * alignment;
}

function clamp(value, minimum, maximum) {
  return Math.min(maximum, Math.max(minimum, value));
}

function parseOptionalBytes(value, name) {
  if (value == null) return null;
  const number = Number(value);
  assertPositiveInteger(number, name);
  return number;
}

/**
 * Derive conservative, resolution-aware limits for the canvas -> WebCodecs ->
 * mux pipeline. Queue counts alone are unsafe: one queued 4K ABGR frame is
 * roughly four 1080p frames, before the encoder's NV12 surface is considered.
 *
 * The estimate intentionally counts one exportable RGBA surface and one NV12
 * encoder/VPP surface per in-flight frame. It is an upper-bound policy input,
 * not a claim about a particular driver's private allocation strategy.
 */
export function deriveRenderResourceBudget(options = {}) {
  const width = Number(options.width);
  const height = Number(options.height);
  assertPositiveInteger(width, "width");
  assertPositiveInteger(height, "height");

  const totalMemoryBytes = parseOptionalBytes(options.totalMemoryBytes, "totalMemoryBytes");
  const bitrate = Number(options.bitrate ?? 40_000_000);
  const fps = Number(options.fps ?? 60);
  if (!Number.isFinite(bitrate) || bitrate <= 0) throw new Error(`bitrate must be positive; got ${bitrate}`);
  if (!Number.isFinite(fps) || fps <= 0) throw new Error(`fps must be positive; got ${fps}`);

  // NativePixmap row strides are commonly aligned. Using 256 bytes for RGBA
  // and 128 bytes for luma/chroma keeps the calculation stable across Intel,
  // Apple and discrete-GPU implementations without reading driver internals.
  const rgbaBytes = align(width * 4, 256) * height;
  const nv12LumaBytes = align(width, 128) * height;
  const nv12Bytes = nv12LumaBytes + Math.ceil(nv12LumaBytes / 2);
  const estimatedBytesPerEncoderFrame = rgbaBytes + nv12Bytes;

  const automaticSurfaceBudgetBytes = totalMemoryBytes == null
    ? 256 * MIB
    : clamp(Math.floor(totalMemoryBytes * 0.02), 96 * MIB, 256 * MIB);
  const surfaceBudgetBytes = parseOptionalBytes(
    options.surfaceBudgetBytes,
    "surfaceBudgetBytes",
  ) ?? automaticSurfaceBudgetBytes;
  if (totalMemoryBytes != null
      && surfaceBudgetBytes > totalMemoryBytes
      && options.allowUnsafeOverride !== true) {
    throw new Error(
      `surface budget ${surfaceBudgetBytes} exceeds total system memory ${totalMemoryBytes}; `
      + `refusing an impossible memory policy`,
    );
  }

  const maxInFlightByBytes = Math.floor(surfaceBudgetBytes / estimatedBytesPerEncoderFrame);
  if (maxInFlightByBytes < 1) {
    throw new Error(
      `surface budget ${surfaceBudgetBytes} cannot hold one estimated ${width}x${height} `
      + `encoder frame (${estimatedBytesPerEncoderFrame} bytes)`,
    );
  }

  const hardMaxInFlightFrames = Number(options.hardMaxInFlightFrames ?? 12);
  assertPositiveInteger(hardMaxInFlightFrames, "hardMaxInFlightFrames");
  const maxInFlightFrames = Math.min(maxInFlightByBytes, hardMaxInFlightFrames);
  // The renderer checks encodeQueueSize after submitting a frame. A limit of N
  // can therefore briefly have N+1 frames in flight; reserve that slot here.
  const safeEncoderQueueLimit = Math.max(0, maxInFlightFrames - 1);

  let encoderQueueLimit = safeEncoderQueueLimit;
  if (options.encoderQueueLimit != null) {
    const requested = Number(options.encoderQueueLimit);
    if (!Number.isSafeInteger(requested) || requested < 0) {
      throw new Error(`encoderQueueLimit must be a non-negative safe integer; got ${options.encoderQueueLimit}`);
    }
    if (requested > safeEncoderQueueLimit && options.allowUnsafeOverride !== true) {
      throw new Error(
        `requested encoderQueueLimit=${requested} exceeds resolution-aware safe limit `
        + `${safeEncoderQueueLimit}; increase surfaceBudgetBytes explicitly and keep unsafe overrides disabled`,
      );
    }
    encoderQueueLimit = requested;
  }
  const encoderQueueLowWatermark = Math.min(
    encoderQueueLimit,
    Number.isSafeInteger(Number(options.encoderQueueLowWatermark))
      ? Math.max(0, Number(options.encoderQueueLowWatermark))
      : Math.floor(encoderQueueLimit / 2),
  );

  const automaticPayloadBudgetBytes = Math.min(
    32 * MIB,
    Math.max(8 * MIB, Math.floor(surfaceBudgetBytes / 8)),
  );
  const payloadBudgetBytes = parseOptionalBytes(
    options.payloadBudgetBytes,
    "payloadBudgetBytes",
  ) ?? automaticPayloadBudgetBytes;
  // A keyframe can be far larger than bitrate/fps. Reserve at least 4 MiB and
  // scale with both resolution and average encoded bytes per frame.
  const estimatedMaxChunkBytes = Math.max(
    4 * MIB,
    Math.min(Math.floor(rgbaBytes / 4), Math.ceil((bitrate / 8 / fps) * 32)),
  );
  if (payloadBudgetBytes < estimatedMaxChunkBytes) {
    throw new Error(
      `payload budget ${payloadBudgetBytes} cannot hold one estimated encoded chunk `
      + `(${estimatedMaxChunkBytes} bytes)`,
    );
  }
  const safePayloadWriteWindow = Math.max(
    1,
    Math.min(8, Math.floor(payloadBudgetBytes / estimatedMaxChunkBytes)),
  );
  let payloadWriteWindow = safePayloadWriteWindow;
  if (options.payloadWriteWindow != null) {
    const requested = Number(options.payloadWriteWindow);
    assertPositiveInteger(requested, "payloadWriteWindow");
    if (requested > safePayloadWriteWindow && options.allowUnsafeOverride !== true) {
      throw new Error(
        `requested payloadWriteWindow=${requested} exceeds byte-aware safe limit `
        + `${safePayloadWriteWindow}`,
      );
    }
    payloadWriteWindow = requested;
  }
  const payloadWriteLowWatermark = Math.min(
    payloadWriteWindow - 1,
    Number.isSafeInteger(Number(options.payloadWriteLowWatermark))
      ? Math.max(0, Number(options.payloadWriteLowWatermark))
      : Math.floor(payloadWriteWindow / 2),
  );

  return Object.freeze({
    kind: "hyperframes-render-resource-budget",
    schemaVersion: 1,
    dimensions: { width, height, fps },
    estimates: {
      rgbaBytes,
      nv12Bytes,
      estimatedBytesPerEncoderFrame,
      estimatedMaxChunkBytes,
    },
    budgets: {
      totalMemoryBytes,
      surfaceBudgetBytes,
      payloadBudgetBytes,
      automaticSurfaceBudgetBytes,
      automaticPayloadBudgetBytes,
    },
    limits: {
      maxInFlightByBytes,
      maxInFlightFrames,
      encoderQueueLimit,
      encoderQueueLowWatermark,
      encoderBackpressureMode: "dequeue",
      payloadWriteWindow,
      payloadWriteLowWatermark,
      maxPendingPayloadBytes: payloadBudgetBytes,
    },
    assumptions: [
      "one aligned RGBA export surface plus one aligned NV12 encoder/VPP surface per in-flight frame",
      "encodeQueueSize is checked after submission, so queueLimit reserves one additional submitted frame",
      "pending payload bytes are measured at runtime; estimatedMaxChunkBytes only limits IPC promise count",
      "surface bytes are a conservative scheduling estimate, not a driver-allocation or RSS hard limit",
      "encoded payload bytes exclude structured-clone and Buffer copies; runtime RSS must still be monitored",
      "unsafe overrides are rejected unless allowUnsafeOverride=true is explicitly set",
    ],
  });
}

export const RENDER_RESOURCE_MIB = MIB;
