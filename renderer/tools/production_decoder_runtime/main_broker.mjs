import { createHash, randomUUID } from "node:crypto";
import { stat } from "node:fs/promises";
import path from "node:path";
import { EncodedPacketSink, FilePathSource, Input, MP4 } from "mediabunny";
import {
  CACHE_DECISION,
  DEFAULT_BROKER_LIMITS,
  DIRECT_DECISION,
  MEDIABUNNY_API_VERSION,
  PRODUCTION_DECODER_SCHEMA_VERSION,
  ProductionDecoderError,
  asUint8Array,
  cacheRequiredDecision,
  invariant,
  isCacheRequiredError,
  validateBoundedInteger,
  validateOpaqueToken,
  validateSourceIdentity,
} from "./contract.mjs";

const HARD_LIMITS = Object.freeze({
  maximumBatchPackets: 32,
  maximumBatchBytes: 32 * 1024 * 1024,
  maximumGlobalDemuxBytes: 256 * 1024 * 1024,
  maximumOpenCursors: 32,
  maximumSources: 256,
  operationTimeoutMs: 120_000,
});

function descriptionBytes(description) {
  if (description == null) return new Uint8Array();
  return asUint8Array(description, "VideoDecoderConfig.description");
}

function cloneDecoderConfig(config) {
  return {
    codec: config.codec,
    codedWidth: config.codedWidth ?? undefined,
    codedHeight: config.codedHeight ?? undefined,
    displayAspectWidth: config.displayAspectWidth ?? undefined,
    displayAspectHeight: config.displayAspectHeight ?? undefined,
    colorSpace: config.colorSpace ?? undefined,
    description: new Uint8Array(descriptionBytes(config.description)),
  };
}

export function validateDirectH264Codec(codec, decoderConfig) {
  invariant(codec === "avc", codec === "hevc" ? "CACHE_REQUIRED_HEVC" : "CACHE_REQUIRED_CODEC",
    "Direct decode currently accepts H.264/AVC only", { codec });
  invariant(decoderConfig != null && /^avc1\./.test(decoderConfig.codec),
    "CACHE_REQUIRED_AVC1", "Direct H.264 requires an avc1 sample entry", {
      decoderCodec: decoderConfig?.codec ?? null,
    });
  invariant(descriptionBytes(decoderConfig.description).byteLength > 0,
    "CACHE_REQUIRED_AVCC_DESCRIPTION", "Direct H.264 requires an AVCDecoderConfigurationRecord");
  return true;
}

function normalizeBrokerLimits(options = {}) {
  const merged = { ...DEFAULT_BROKER_LIMITS, ...options };
  return Object.freeze({
    maximumBatchPackets: validateBoundedInteger(
      merged.maximumBatchPackets, "maximumBatchPackets", 1, HARD_LIMITS.maximumBatchPackets,
    ),
    maximumBatchBytes: validateBoundedInteger(
      merged.maximumBatchBytes, "maximumBatchBytes", 1, HARD_LIMITS.maximumBatchBytes,
    ),
    maximumGlobalDemuxBytes: validateBoundedInteger(
      merged.maximumGlobalDemuxBytes,
      "maximumGlobalDemuxBytes",
      1,
      HARD_LIMITS.maximumGlobalDemuxBytes,
    ),
    maximumOpenCursors: validateBoundedInteger(
      merged.maximumOpenCursors, "maximumOpenCursors", 1, HARD_LIMITS.maximumOpenCursors,
    ),
    maximumSources: validateBoundedInteger(
      merged.maximumSources, "maximumSources", 1, HARD_LIMITS.maximumSources,
    ),
    operationTimeoutMs: validateBoundedInteger(
      merged.operationTimeoutMs, "operationTimeoutMs", 100, HARD_LIMITS.operationTimeoutMs,
    ),
  });
}

function withTimeout(promise, timeoutMs, code, message, details = {}) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new ProductionDecoderError(code, message, details)), timeoutMs);
    }),
  ]).finally(() => clearTimeout(timer));
}

/** A FIFO byte semaphore. Reservations become explicit leases until renderer acknowledgement. */
export class GlobalDemuxByteBudget {
  constructor(maximumBytes, operationTimeoutMs = DEFAULT_BROKER_LIMITS.operationTimeoutMs) {
    this.maximumBytes = validateBoundedInteger(
      maximumBytes, "maximumGlobalDemuxBytes", 1, HARD_LIMITS.maximumGlobalDemuxBytes,
    );
    this.operationTimeoutMs = validateBoundedInteger(
      operationTimeoutMs, "operationTimeoutMs", 100, HARD_LIMITS.operationTimeoutMs,
    );
    this.currentBytes = 0;
    this.leases = new Map();
    this.waiters = [];
    this.closed = false;
    this.metrics = {
      reservations: 0,
      releases: 0,
      waits: 0,
      waitMs: 0,
      peakBytes: 0,
      peakLeases: 0,
      abortedWaits: 0,
    };
  }

  async acquire(bytes, metadata = {}, signal = null) {
    validateBoundedInteger(bytes, "demux reservation bytes", 1, this.maximumBytes,
      "DEMUX_RESERVATION_EXCEEDS_GLOBAL_BUDGET");
    invariant(!this.closed, "DEMUX_BYTE_BUDGET_CLOSED", "Global demux byte budget is closed");
    if (signal?.aborted) {
      throw new ProductionDecoderError("DEMUX_RESERVATION_ABORTED", "Demux byte reservation was aborted");
    }
    if (this.waiters.length === 0 && this.currentBytes + bytes <= this.maximumBytes) {
      return this.allocate(bytes, metadata);
    }
    this.metrics.waits += 1;
    const startedAt = performance.now();
    let abortHandler;
    let waiter;
    const pending = new Promise((resolve, reject) => {
      waiter = { bytes, metadata, resolve, reject, signal, settled: false };
      abortHandler = () => {
        if (waiter.settled) return;
        waiter.settled = true;
        const index = this.waiters.indexOf(waiter);
        if (index >= 0) this.waiters.splice(index, 1);
        this.metrics.abortedWaits += 1;
        reject(new ProductionDecoderError("DEMUX_RESERVATION_ABORTED", "Demux byte reservation was aborted"));
      };
      signal?.addEventListener("abort", abortHandler, { once: true });
      this.waiters.push(waiter);
    });
    try {
      return await withTimeout(
        pending,
        this.operationTimeoutMs,
        "DEMUX_BYTE_BUDGET_TIMEOUT",
        "Timed out waiting for the bounded global demux byte budget",
        { requestedBytes: bytes, maximumBytes: this.maximumBytes },
      );
    } finally {
      this.metrics.waitMs += performance.now() - startedAt;
      signal?.removeEventListener("abort", abortHandler);
      if (!waiter.settled) {
        waiter.settled = true;
        const index = this.waiters.indexOf(waiter);
        if (index >= 0) this.waiters.splice(index, 1);
      }
    }
  }

  allocate(bytes, metadata) {
    const leaseId = randomUUID();
    this.currentBytes += bytes;
    this.leases.set(leaseId, { bytes, metadata });
    this.metrics.reservations += 1;
    this.metrics.peakBytes = Math.max(this.metrics.peakBytes, this.currentBytes);
    this.metrics.peakLeases = Math.max(this.metrics.peakLeases, this.leases.size);
    return leaseId;
  }

  shrink(leaseId, actualBytes) {
    validateOpaqueToken(leaseId, "batchLeaseId");
    const lease = this.leases.get(leaseId);
    invariant(lease != null, "DEMUX_BYTE_LEASE_NOT_FOUND", "Demux byte lease is absent", { leaseId });
    validateBoundedInteger(actualBytes, "actual demux batch bytes", 1, lease.bytes,
      "INVALID_DEMUX_ACTUAL_BYTES");
    this.currentBytes -= lease.bytes - actualBytes;
    lease.bytes = actualBytes;
    this.drainWaiters();
  }

  release(leaseId) {
    if (typeof leaseId !== "string") return false;
    const lease = this.leases.get(leaseId);
    if (!lease) return false;
    this.leases.delete(leaseId);
    this.currentBytes -= lease.bytes;
    invariant(this.currentBytes >= 0, "DEMUX_BYTE_BUDGET_UNDERFLOW",
      "Global demux byte budget underflowed", { currentBytes: this.currentBytes });
    this.metrics.releases += 1;
    this.drainWaiters();
    return true;
  }

  drainWaiters() {
    while (this.waiters.length > 0) {
      const waiter = this.waiters[0];
      if (waiter.settled) {
        this.waiters.shift();
        continue;
      }
      if (this.currentBytes + waiter.bytes > this.maximumBytes) break;
      this.waiters.shift();
      waiter.settled = true;
      waiter.resolve(this.allocate(waiter.bytes, waiter.metadata));
    }
  }

  snapshot() {
    return Object.freeze({
      ...this.metrics,
      maximumBytes: this.maximumBytes,
      currentBytes: this.currentBytes,
      activeLeases: this.leases.size,
      waitingReservations: this.waiters.filter((waiter) => !waiter.settled).length,
    });
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    for (const waiter of this.waiters.splice(0)) {
      if (waiter.settled) continue;
      waiter.settled = true;
      waiter.reject(new ProductionDecoderError("DEMUX_BYTE_BUDGET_CLOSED", "Global demux byte budget closed"));
    }
    for (const leaseId of [...this.leases.keys()]) this.release(leaseId);
  }
}

function binarySearchExact(values, target) {
  let low = 0;
  let high = values.length - 1;
  while (low <= high) {
    const middle = (low + high) >>> 1;
    const value = values[middle];
    if (value === target) return middle;
    if (value < target) low = middle + 1;
    else high = middle - 1;
  }
  return -1;
}

function binarySearchFloor(values, target) {
  let low = 0;
  let high = values.length - 1;
  let result = -1;
  while (low <= high) {
    const middle = (low + high) >>> 1;
    if (values[middle] <= target) {
      result = middle;
      low = middle + 1;
    } else {
      high = middle - 1;
    }
  }
  return result;
}

function timingProfile(presentationPtsUs, presentationDurationUs) {
  invariant(presentationPtsUs.length >= 2, "CACHE_REQUIRED_SINGLE_FRAME",
    "Direct decode requires at least two frames to prove a CFR timing grid", {
      frameCount: presentationPtsUs.length,
    });
  invariant(presentationPtsUs[0] === 0, "CACHE_REQUIRED_NONZERO_ORIGIN",
    "Direct decode requires presentation PTS to start at zero", { firstPtsUs: presentationPtsUs[0] });
  let minimumDeltaUs = Infinity;
  let maximumDeltaUs = -Infinity;
  for (let index = 1; index < presentationPtsUs.length; index += 1) {
    const delta = presentationPtsUs[index] - presentationPtsUs[index - 1];
    invariant(Number.isSafeInteger(delta) && delta > 0, "CACHE_REQUIRED_INVALID_PTS_GRID",
      "Presentation PTS must be strictly increasing integer microseconds", { index, delta });
    minimumDeltaUs = Math.min(minimumDeltaUs, delta);
    maximumDeltaUs = Math.max(maximumDeltaUs, delta);
  }
  let minimumDurationUs = Infinity;
  let maximumDurationUs = -Infinity;
  for (const duration of presentationDurationUs) {
    invariant(Number.isSafeInteger(duration) && duration > 0, "CACHE_REQUIRED_INVALID_DURATION",
      "Every direct-decode frame needs a positive integer duration", { duration });
    minimumDurationUs = Math.min(minimumDurationUs, duration);
    maximumDurationUs = Math.max(maximumDurationUs, duration);
  }
  invariant(maximumDeltaUs - minimumDeltaUs <= 1 && maximumDurationUs - minimumDurationUs <= 1,
    "CACHE_REQUIRED_VFR", "Variable-frame-rate timing requires a canonical CFR cache", {
      minimumDeltaUs,
      maximumDeltaUs,
      minimumDurationUs,
      maximumDurationUs,
    });
  invariant(Math.abs(minimumDurationUs - minimumDeltaUs) <= 1
    || Math.abs(maximumDurationUs - maximumDeltaUs) <= 1,
  "CACHE_REQUIRED_VFR", "Frame durations do not match the proven CFR PTS grid", {
    minimumDeltaUs,
    maximumDeltaUs,
    minimumDurationUs,
    maximumDurationUs,
  });
  const nominalFrameDurationUs = Math.round((minimumDeltaUs + maximumDeltaUs) / 2);
  return Object.freeze({
    kind: "cfr-zero-origin",
    nominalFrameDurationUs,
    minimumDeltaUs,
    maximumDeltaUs,
    minimumDurationUs,
    maximumDurationUs,
    estimatedFps: 1_000_000 / nominalFrameDurationUs,
  });
}

function digestCompactIndex(index, decoderConfig) {
  const hash = createHash("sha256");
  for (const value of [
    index.decodeSequence,
    index.decodePtsUs,
    index.decodeDurationUs,
    index.decodeTimestampSeconds,
    index.decodeByteLength,
    index.decodeType,
    index.decodePresentationOrdinal,
    index.presentationPtsUs,
    index.presentationDurationUs,
    index.presentationTimestampSeconds,
    index.presentationDecodeOrdinal,
    index.rapPresentationOrdinal,
    index.rapDecodeOrdinal,
  ]) {
    hash.update(Buffer.from(value.buffer, value.byteOffset, value.byteLength));
  }
  hash.update(Buffer.from(descriptionBytes(decoderConfig.description)));
  return hash.digest("hex");
}

/**
 * Stable main-process proof of the complete presentation timing index.
 * Every frame contributes PTS then duration as unsigned 8-byte BE
 * microseconds; only the 32-byte digest crosses the host boundary.
 */
export function digestPresentationTimingMicroseconds(presentationPtsUs, presentationDurationUs) {
  invariant(presentationPtsUs?.length === presentationDurationUs?.length
    && presentationPtsUs.length > 0,
  "INVALID_PRESENTATION_TIMING_INDEX",
  "Presentation PTS and duration indexes must have equal non-zero cardinality");
  const hash = createHash("sha256");
  const encoded = Buffer.allocUnsafe(16);
  let previousPtsUs = -1;
  for (let index = 0; index < presentationPtsUs.length; index += 1) {
    const ptsUs = presentationPtsUs[index];
    const durationUs = presentationDurationUs[index];
    invariant(Number.isSafeInteger(ptsUs) && ptsUs >= 0 && ptsUs > previousPtsUs,
      "INVALID_PRESENTATION_TIMING_INDEX",
      "Presentation PTS microseconds must be safe, non-negative and strictly increasing", {
        index,
        ptsUs,
        previousPtsUs,
      });
    invariant(Number.isSafeInteger(durationUs) && durationUs > 0,
      "INVALID_PRESENTATION_TIMING_INDEX",
      "Presentation duration microseconds must be a positive safe integer", {
        index,
        durationUs,
      });
    encoded.writeBigUInt64BE(BigInt(ptsUs), 0);
    encoded.writeBigUInt64BE(BigInt(durationUs), 8);
    hash.update(encoded);
    previousPtsUs = ptsUs;
  }
  return hash.digest("hex");
}

/** Build a typed-array index retained only in the main process. */
export async function buildCompactH264Index(sink, decoderConfig) {
  const rows = [];
  let previousSequence = -1;
  const seenPts = new Set();
  for await (const packet of sink.packets(undefined, undefined, { metadataOnly: true })) {
    invariant(Number.isSafeInteger(packet.sequenceNumber) && packet.sequenceNumber >= 0
      && packet.sequenceNumber <= 0xffff_ffff && packet.sequenceNumber > previousSequence,
    "CACHE_REQUIRED_DECODE_SEQUENCE", "Packet decode sequence must be strictly increasing uint32", {
      sequenceNumber: packet.sequenceNumber,
      previousSequence,
    });
    invariant(Number.isSafeInteger(packet.microsecondTimestamp) && !seenPts.has(packet.microsecondTimestamp),
      "CACHE_REQUIRED_PTS_MICROSECOND_COLLISION",
      "Every encoded packet must map to a unique integer-microsecond presentation PTS", {
        ptsUs: packet.microsecondTimestamp,
      });
    invariant(Number.isSafeInteger(packet.microsecondDuration) && packet.microsecondDuration > 0,
      "CACHE_REQUIRED_INVALID_DURATION", "Encoded packet duration must be a positive integer", {
        durationUs: packet.microsecondDuration,
      });
    invariant(Number.isSafeInteger(packet.byteLength) && packet.byteLength > 0 && packet.byteLength <= 0xffff_ffff,
      "CACHE_REQUIRED_PACKET_SIZE", "Encoded packet byte length must fit uint32", {
        byteLength: packet.byteLength,
      });
    rows.push({
      sequenceNumber: packet.sequenceNumber,
      ptsUs: packet.microsecondTimestamp,
      durationUs: packet.microsecondDuration,
      timestampSeconds: packet.timestamp,
      byteLength: packet.byteLength,
    });
    previousSequence = packet.sequenceNumber;
    seenPts.add(packet.microsecondTimestamp);
  }
  invariant(rows.length > 0, "CACHE_REQUIRED_EMPTY_VIDEO", "Source contains no encoded video packets");

  const verifiedSequences = new Set();
  let keyPacket = await sink.getFirstKeyPacket({ verifyKeyPackets: true });
  while (keyPacket) {
    verifiedSequences.add(keyPacket.sequenceNumber);
    keyPacket = await sink.getNextKeyPacket(keyPacket, { verifyKeyPackets: true });
  }
  invariant(verifiedSequences.size > 0, "CACHE_REQUIRED_NO_VERIFIED_RAP",
    "Source contains no bitstream-verified H.264 random access point");

  const decodeOrdinalBySequence = new Map(rows.map((row, index) => [row.sequenceNumber, index]));
  for (const sequence of verifiedSequences) {
    invariant(decodeOrdinalBySequence.has(sequence), "CACHE_REQUIRED_RAP_NOT_INDEXED",
      "Verified random access packet is absent from the metadata index", { sequenceNumber: sequence });
  }
  const presentationRows = rows
    .map((row, decodeOrdinal) => ({ ...row, decodeOrdinal }))
    .sort((left, right) => left.ptsUs - right.ptsUs || left.sequenceNumber - right.sequenceNumber);
  invariant(presentationRows.length === rows.length, "CACHE_REQUIRED_PACKET_FRAME_CARDINALITY",
    "Direct H.264 requires one presentation frame per encoded packet");

  const count = rows.length;
  const index = {
    decodeSequence: new Uint32Array(count),
    decodePtsUs: new Float64Array(count),
    decodeDurationUs: new Float64Array(count),
    decodeTimestampSeconds: new Float64Array(count),
    decodeByteLength: new Uint32Array(count),
    decodeType: new Uint8Array(count),
    decodePresentationOrdinal: new Uint32Array(count),
    presentationPtsUs: new Float64Array(count),
    presentationDurationUs: new Float64Array(count),
    presentationTimestampSeconds: new Float64Array(count),
    presentationDecodeOrdinal: new Uint32Array(count),
  };
  const presentationOrdinalByDecode = new Uint32Array(count);
  for (let presentationOrdinal = 0; presentationOrdinal < count; presentationOrdinal += 1) {
    const row = presentationRows[presentationOrdinal];
    index.presentationPtsUs[presentationOrdinal] = row.ptsUs;
    index.presentationDurationUs[presentationOrdinal] = row.durationUs;
    index.presentationTimestampSeconds[presentationOrdinal] = row.timestampSeconds;
    index.presentationDecodeOrdinal[presentationOrdinal] = row.decodeOrdinal;
    presentationOrdinalByDecode[row.decodeOrdinal] = presentationOrdinal;
  }
  let maximumPresentationReorderDepth = 0;
  for (let decodeOrdinal = 0; decodeOrdinal < count; decodeOrdinal += 1) {
    const row = rows[decodeOrdinal];
    const presentationOrdinal = presentationOrdinalByDecode[decodeOrdinal];
    index.decodeSequence[decodeOrdinal] = row.sequenceNumber;
    index.decodePtsUs[decodeOrdinal] = row.ptsUs;
    index.decodeDurationUs[decodeOrdinal] = row.durationUs;
    index.decodeTimestampSeconds[decodeOrdinal] = row.timestampSeconds;
    index.decodeByteLength[decodeOrdinal] = row.byteLength;
    index.decodeType[decodeOrdinal] = verifiedSequences.has(row.sequenceNumber) ? 1 : 0;
    index.decodePresentationOrdinal[decodeOrdinal] = presentationOrdinal;
    maximumPresentationReorderDepth = Math.max(
      maximumPresentationReorderDepth,
      Math.abs(presentationOrdinal - decodeOrdinal),
    );
  }
  const rapRows = [...verifiedSequences]
    .map((sequenceNumber) => {
      const decodeOrdinal = decodeOrdinalBySequence.get(sequenceNumber);
      return { decodeOrdinal, presentationOrdinal: presentationOrdinalByDecode[decodeOrdinal] };
    })
    .sort((left, right) => left.presentationOrdinal - right.presentationOrdinal);
  index.rapPresentationOrdinal = Uint32Array.from(rapRows.map((row) => row.presentationOrdinal));
  index.rapDecodeOrdinal = Uint32Array.from(rapRows.map((row) => row.decodeOrdinal));
  index.timing = timingProfile(index.presentationPtsUs, index.presentationDurationUs);
  index.maximumPresentationReorderDepth = maximumPresentationReorderDepth;
  index.presentationTimingDigest = digestPresentationTimingMicroseconds(
    index.presentationPtsUs,
    index.presentationDurationUs,
  );
  index.indexDigest = digestCompactIndex(index, decoderConfig);
  return index;
}

function packetMetadata(index, decodeOrdinal) {
  invariant(Number.isSafeInteger(decodeOrdinal) && decodeOrdinal >= 0 && decodeOrdinal < index.decodeSequence.length,
    "DEMUX_DECODE_ORDINAL_OUT_OF_RANGE", "Decode ordinal is outside the compact index", { decodeOrdinal });
  return {
    decodeOrdinal,
    sequenceNumber: index.decodeSequence[decodeOrdinal],
    presentationFrameIndex: index.decodePresentationOrdinal[decodeOrdinal],
    ptsUs: index.decodePtsUs[decodeOrdinal],
    durationUs: index.decodeDurationUs[decodeOrdinal],
    type: index.decodeType[decodeOrdinal] === 1 ? "key" : "delta",
    byteLength: index.decodeByteLength[decodeOrdinal],
  };
}

function presentationMetadata(index, presentationFrameIndex) {
  invariant(Number.isSafeInteger(presentationFrameIndex)
    && presentationFrameIndex >= 0 && presentationFrameIndex < index.presentationPtsUs.length,
  "TARGET_PRESENTATION_OUT_OF_RANGE", "Presentation ordinal is outside the compact index", {
    presentationFrameIndex,
  });
  return {
    presentationFrameIndex,
    ptsUs: index.presentationPtsUs[presentationFrameIndex],
    durationUs: index.presentationDurationUs[presentationFrameIndex],
    packetDecodeOrdinal: index.presentationDecodeOrdinal[presentationFrameIndex],
  };
}

export class DirectH264SourceService {
  static async open(filePath, sourceIdentity, limits, byteBudget) {
    const input = new Input({ formats: [MP4], source: new FilePathSource(filePath) });
    let service = null;
    try {
      invariant(await input.canRead(), "CACHE_REQUIRED_CONTAINER",
        "Direct decode currently requires a readable MP4 container");
      const track = await input.getPrimaryVideoTrack();
      invariant(track != null, "CACHE_REQUIRED_VIDEO_TRACK", "Source has no primary video track");
      const codec = await track.getCodec();
      if (codec !== "avc") validateDirectH264Codec(codec, null);
      const decoderConfig = await track.getDecoderConfig();
      validateDirectH264Codec(codec, decoderConfig);
      const [rotation, highDynamicRange, mayHaveAlpha, codedWidth, codedHeight, displayWidth, displayHeight, colorSpace] =
        await Promise.all([
          track.getRotation(),
          track.hasHighDynamicRange(),
          track.canBeTransparent(),
          track.getCodedWidth(),
          track.getCodedHeight(),
          track.getDisplayWidth(),
          track.getDisplayHeight(),
          track.getColorSpace(),
        ]);
      invariant(rotation === 0, "CACHE_REQUIRED_ROTATION", "Rotated video requires canonical normalization", { rotation });
      invariant(highDynamicRange === false, "CACHE_REQUIRED_HDR", "HDR video requires an explicit color policy");
      invariant(mayHaveAlpha === false, "CACHE_REQUIRED_ALPHA", "Alpha video is outside the opaque direct-decode contract");
      const sink = new EncodedPacketSink(track);
      const index = await buildCompactH264Index(sink, decoderConfig);
      service = new DirectH264SourceService({
        filePath,
        sourceIdentity,
        input,
        sink,
        decoderConfig,
        index,
        trackSummary: {
          codedWidth,
          codedHeight,
          displayWidth,
          displayHeight,
          rotation,
          highDynamicRange,
          mayHaveAlpha,
          colorSpace,
        },
        limits,
        byteBudget,
      });
      return service;
    } catch (error) {
      if (service) await service.dispose();
      else await Promise.resolve(input.dispose());
      throw error;
    }
  }

  constructor({ filePath, sourceIdentity, input, sink, decoderConfig, index, trackSummary, limits, byteBudget }) {
    this.filePath = filePath;
    this.sourceIdentity = validateSourceIdentity(sourceIdentity);
    this.sourceHandle = randomUUID();
    this.input = input;
    this.sink = sink;
    this.decoderConfig = cloneDecoderConfig(decoderConfig);
    this.index = index;
    this.trackSummary = trackSummary;
    this.limits = limits;
    this.byteBudget = byteBudget;
    this.cursors = new Map();
    this.pendingBegins = 0;
    this.activeReads = 0;
    this.idleWaiters = new Set();
    this.abortController = new AbortController();
    this.disposed = false;
    this.metrics = {
      cursorBegins: 0,
      cursorReleases: 0,
      explicitReleases: 0,
      eofReleases: 0,
      errorReleases: 0,
      batches: 0,
      packets: 0,
      bytes: 0,
      batchAcks: 0,
      peakOpenCursors: 0,
      cursorBusyFailures: 0,
    };
  }

  publicInfo(reusedSource = false) {
    invariant(!this.disposed, "DEMUX_SOURCE_DISPOSED", "Demux source is disposed");
    const frameCount = this.index.presentationPtsUs.length;
    return {
      schemaVersion: PRODUCTION_DECODER_SCHEMA_VERSION,
      decision: DIRECT_DECISION,
      sourceHandle: this.sourceHandle,
      sourceIdentity: this.sourceIdentity,
      reusedSource,
      decoderConfig: cloneDecoderConfig(this.decoderConfig),
      summary: {
        container: "mp4",
        codec: "avc",
        sampleEntry: this.decoderConfig.codec,
        packetCount: this.index.decodeSequence.length,
        presentationFrameCount: frameCount,
        randomAccessPointCount: this.index.rapDecodeOrdinal.length,
        firstPtsUs: this.index.presentationPtsUs[0],
        lastPtsUs: this.index.presentationPtsUs[frameCount - 1],
        timing: this.index.timing,
        hasDecodePresentationReordering: this.index.maximumPresentationReorderDepth > 0,
        maximumPresentationReorderDepth: this.index.maximumPresentationReorderDepth,
        presentationTimingDigest: this.index.presentationTimingDigest,
        indexDigest: this.index.indexDigest,
        track: { ...this.trackSummary },
        adapter: {
          package: `mediabunny@${MEDIABUNNY_API_VERSION}`,
          license: "MPL-2.0",
          sourceMode: "main-process-file-range",
        },
      },
      limits: {
        maximumBatchPackets: this.limits.maximumBatchPackets,
        maximumBatchBytes: this.limits.maximumBatchBytes,
        maximumOpenCursors: this.limits.maximumOpenCursors,
        maximumGlobalDemuxBytes: this.limits.maximumGlobalDemuxBytes,
      },
    };
  }

  assertRequest(request) {
    invariant(!this.disposed, "DEMUX_SOURCE_DISPOSED", "Demux source is disposed");
    validateOpaqueToken(request?.sourceHandle, "sourceHandle");
    invariant(request.sourceHandle === this.sourceHandle, "DEMUX_SOURCE_HANDLE_MISMATCH",
      "Demux request belongs to another source handle");
    validateSourceIdentity(request.sourceIdentity);
    invariant(request.sourceIdentity === this.sourceIdentity, "DEMUX_SOURCE_IDENTITY_MISMATCH",
      "Demux request belongs to another source identity");
  }

  resolveTarget(request) {
    this.assertRequest(request);
    invariant(Number.isSafeInteger(request.ptsUs), "INVALID_TARGET_PTS",
      "Target PTS must be integer microseconds", { ptsUs: request.ptsUs });
    const ordinal = binarySearchExact(this.index.presentationPtsUs, request.ptsUs);
    invariant(ordinal >= 0, "TARGET_PTS_NOT_INDEXED",
      "Exact target PTS is absent from the direct-decode index", { ptsUs: request.ptsUs });
    return {
      sourceHandle: this.sourceHandle,
      sourceIdentity: this.sourceIdentity,
      indexDigest: this.index.indexDigest,
      target: presentationMetadata(this.index, ordinal),
    };
  }

  validateBatchRequest(request) {
    this.assertRequest(request);
    return validateBoundedInteger(
      request.batchSize ?? this.limits.maximumBatchPackets,
      "batchSize",
      1,
      this.limits.maximumBatchPackets,
      "INVALID_DEMUX_BATCH_SIZE",
    );
  }

  async begin(request) {
    const batchSize = this.validateBatchRequest(request);
    const resolved = this.resolveTarget(request);
    invariant(this.cursors.size + this.pendingBegins < this.limits.maximumOpenCursors,
      "DEMUX_CURSOR_LIMIT_EXCEEDED", "Per-source cursor limit reached", {
        activeCursors: this.cursors.size,
        pendingBegins: this.pendingBegins,
        maximumOpenCursors: this.limits.maximumOpenCursors,
      });
    this.pendingBegins += 1;
    let token = null;
    try {
      const targetOrdinal = resolved.target.presentationFrameIndex;
      const rapIndex = binarySearchFloor(this.index.rapPresentationOrdinal, targetOrdinal);
      invariant(rapIndex >= 0, "RAP_NOT_FOUND", "No verified H.264 RAP precedes target", {
        targetOrdinal,
      });
      const rapDecodeOrdinal = this.index.rapDecodeOrdinal[rapIndex];
      const packet = await this.sink.getKeyPacket(
        this.index.presentationTimestampSeconds[targetOrdinal],
        { verifyKeyPackets: true },
      );
      invariant(!this.disposed, "DEMUX_SOURCE_DISPOSED_DURING_BEGIN",
        "Demux source closed while locating a random access point");
      const expectedRap = packetMetadata(this.index, rapDecodeOrdinal);
      invariant(packet != null && packet.sequenceNumber === expectedRap.sequenceNumber && packet.type === "key",
        "RAP_VERIFICATION_MISMATCH", "Runtime RAP differs from the compact verified index", {
          expectedSequenceNumber: expectedRap.sequenceNumber,
          actualSequenceNumber: packet?.sequenceNumber ?? null,
        });
      token = randomUUID();
      this.cursors.set(token, {
        token,
        target: resolved.target,
        rap: expectedRap,
        nextPacket: packet,
        nextDecodeOrdinal: rapDecodeOrdinal,
        outstandingLeaseId: null,
        busy: false,
        eof: false,
        released: false,
      });
      this.metrics.cursorBegins += 1;
      this.metrics.peakOpenCursors = Math.max(this.metrics.peakOpenCursors, this.cursors.size);
      return await this.readBatch(token, batchSize, true);
    } catch (error) {
      if (token) this.releaseToken(token, "error");
      throw error;
    } finally {
      this.pendingBegins -= 1;
      this.signalIdle();
    }
  }

  async next(request) {
    const batchSize = this.validateBatchRequest(request);
    const token = validateOpaqueToken(request.token, "cursorToken");
    try {
      return await this.readBatch(token, batchSize, false);
    } catch (error) {
      this.releaseToken(token, "error");
      throw error;
    }
  }

  async readBatch(token, batchSize, firstBatch) {
    const state = this.cursors.get(token);
    invariant(state != null && !state.released, "DEMUX_CURSOR_NOT_FOUND", "Demux cursor is absent or released");
    invariant(state.outstandingLeaseId == null, "DEMUX_BATCH_ACK_REQUIRED",
      "The previous packet batch must be acknowledged before reading another", { token });
    if (state.busy) {
      this.metrics.cursorBusyFailures += 1;
      this.releaseToken(token, "error");
      throw new ProductionDecoderError("DEMUX_CURSOR_BUSY", "Concurrent reads on one cursor are forbidden");
    }
    state.busy = true;
    this.activeReads += 1;
    let leaseId = null;
    try {
      leaseId = await this.byteBudget.acquire(
        this.limits.maximumBatchBytes,
        { sourceHandle: this.sourceHandle, cursorToken: token },
        this.abortController.signal,
      );
      invariant(this.cursors.get(token) === state && !state.released,
        "DEMUX_CURSOR_RELEASED_DURING_READ", "Cursor closed while waiting for the global byte budget");
      const packets = [];
      let batchBytes = 0;
      while (state.nextPacket && packets.length < batchSize) {
        const packet = state.nextPacket;
        const metadata = packetMetadata(this.index, state.nextDecodeOrdinal);
        invariant(packet.sequenceNumber === metadata.sequenceNumber
          && packet.microsecondTimestamp === metadata.ptsUs
          && packet.microsecondDuration === metadata.durationUs
          && packet.data.byteLength === metadata.byteLength,
        "RUNTIME_PACKET_IDENTITY_MISMATCH", "Runtime packet differs from the compact index", {
          decodeOrdinal: state.nextDecodeOrdinal,
          sequenceNumber: packet.sequenceNumber,
        });
        invariant(packet.type === metadata.type, "RUNTIME_PACKET_TYPE_MISMATCH",
          "Runtime packet key/delta type differs from the verified index", {
            sequenceNumber: packet.sequenceNumber,
            expected: metadata.type,
            actual: packet.type,
          });
        if (packets.length > 0 && batchBytes + packet.data.byteLength > this.limits.maximumBatchBytes) break;
        invariant(packet.data.byteLength <= this.limits.maximumBatchBytes,
          "DEMUX_PACKET_EXCEEDS_BATCH_BUDGET", "One encoded packet exceeds the demux byte budget", {
            byteLength: packet.data.byteLength,
            maximumBatchBytes: this.limits.maximumBatchBytes,
          });
        packets.push({ ...metadata, data: new Uint8Array(packet.data) });
        batchBytes += packet.data.byteLength;
        state.nextPacket = await this.sink.getNextPacket(packet, { verifyKeyPackets: true });
        state.nextDecodeOrdinal += 1;
        invariant(this.cursors.get(token) === state && !state.released,
          "DEMUX_CURSOR_RELEASED_DURING_READ", "Cursor closed while a packet batch was being read");
      }
      invariant(packets.length > 0, "EMPTY_DEMUX_BATCH", "Demux cursor returned no encoded packets");
      this.byteBudget.shrink(leaseId, batchBytes);
      state.outstandingLeaseId = leaseId;
      state.eof = state.nextPacket == null;
      this.metrics.batches += 1;
      this.metrics.packets += packets.length;
      this.metrics.bytes += batchBytes;
      return {
        schemaVersion: PRODUCTION_DECODER_SCHEMA_VERSION,
        sourceHandle: this.sourceHandle,
        sourceIdentity: this.sourceIdentity,
        indexDigest: this.index.indexDigest,
        token,
        batchLeaseId: leaseId,
        batchBytes,
        packets,
        eof: state.eof,
        target: firstBatch ? state.target : undefined,
        rap: firstBatch ? state.rap : undefined,
        activeCursors: this.cursors.size,
      };
    } catch (error) {
      if (leaseId) this.byteBudget.release(leaseId);
      throw error;
    } finally {
      state.busy = false;
      this.activeReads -= 1;
      this.signalIdle();
    }
  }

  acknowledgeBatch(request) {
    this.assertRequest(request);
    const token = validateOpaqueToken(request.token, "cursorToken");
    const leaseId = validateOpaqueToken(request.batchLeaseId, "batchLeaseId");
    const state = this.cursors.get(token);
    invariant(state != null && !state.released, "DEMUX_CURSOR_NOT_FOUND", "Demux cursor is absent or released");
    invariant(state.outstandingLeaseId === leaseId, "DEMUX_BATCH_LEASE_MISMATCH",
      "Batch acknowledgement does not match the cursor's outstanding lease");
    invariant(this.byteBudget.release(leaseId), "DEMUX_BATCH_LEASE_NOT_FOUND",
      "Batch byte lease was already released");
    state.outstandingLeaseId = null;
    this.metrics.batchAcks += 1;
    if (state.eof) this.releaseToken(token, "eof");
    return true;
  }

  release(request) {
    this.assertRequest(request);
    const token = validateOpaqueToken(request.token, "cursorToken");
    return this.releaseToken(token, "explicit");
  }

  releaseToken(token, reason) {
    const state = this.cursors.get(token);
    if (!state) return false;
    state.released = true;
    this.cursors.delete(token);
    if (state.outstandingLeaseId) this.byteBudget.release(state.outstandingLeaseId);
    state.outstandingLeaseId = null;
    this.metrics.cursorReleases += 1;
    if (reason === "explicit") this.metrics.explicitReleases += 1;
    if (reason === "eof") this.metrics.eofReleases += 1;
    if (reason === "error") this.metrics.errorReleases += 1;
    return true;
  }

  signalIdle() {
    if (this.pendingBegins !== 0 || this.activeReads !== 0) return;
    for (const resolve of this.idleWaiters) resolve();
    this.idleWaiters.clear();
  }

  async waitForIdle() {
    if (this.pendingBegins === 0 && this.activeReads === 0) return;
    await new Promise((resolve) => this.idleWaiters.add(resolve));
  }

  snapshot() {
    return Object.freeze({
      ...this.metrics,
      sourceIdentity: this.sourceIdentity,
      activeCursors: this.cursors.size,
      pendingBegins: this.pendingBegins,
      activeReads: this.activeReads,
      disposed: this.disposed,
    });
  }

  async dispose() {
    if (this.disposed) return;
    this.disposed = true;
    this.abortController.abort();
    for (const token of [...this.cursors.keys()]) this.releaseToken(token, "explicit");
    await this.waitForIdle();
    await Promise.resolve(this.input.dispose());
  }
}

export class ProductionDemuxBroker {
  constructor(options = {}) {
    this.limits = normalizeBrokerLimits(options);
    invariant(this.limits.maximumBatchBytes <= this.limits.maximumGlobalDemuxBytes,
      "DEMUX_BATCH_EXCEEDS_GLOBAL_BUDGET",
      "maximumBatchBytes cannot exceed maximumGlobalDemuxBytes", {
        maximumBatchBytes: this.limits.maximumBatchBytes,
        maximumGlobalDemuxBytes: this.limits.maximumGlobalDemuxBytes,
      });
    this.byteBudget = new GlobalDemuxByteBudget(
      this.limits.maximumGlobalDemuxBytes,
      this.limits.operationTimeoutMs,
    );
    this.sourcesByHandle = new Map();
    this.sourcesByIdentity = new Map();
    this.disposed = false;
    this.metrics = {
      sourceOpenRequests: 0,
      directSourcesOpened: 0,
      reusedSourceOpens: 0,
      canonicalCacheRequired: 0,
      sourcesClosed: 0,
    };
  }

  async openSource({ filePath, sourceIdentity }) {
    invariant(!this.disposed, "DEMUX_BROKER_DISPOSED", "Production demux broker is disposed");
    this.metrics.sourceOpenRequests += 1;
    validateSourceIdentity(sourceIdentity);
    invariant(typeof filePath === "string" && path.isAbsolute(filePath), "INVALID_MEDIA_FILE_PATH",
      "Main-process media path must be absolute");
    const normalizedPath = path.resolve(filePath);
    const fileStat = await stat(normalizedPath);
    invariant(fileStat.isFile(), "INVALID_MEDIA_FILE_PATH", "Main-process media path must identify a file");
    const existing = this.sourcesByIdentity.get(sourceIdentity);
    if (existing) {
      invariant(existing.filePath === normalizedPath, "SOURCE_IDENTITY_PATH_COLLISION",
        "One source identity cannot refer to two different approved paths");
      this.metrics.reusedSourceOpens += 1;
      return existing.publicInfo(true);
    }
    invariant(this.sourcesByHandle.size < this.limits.maximumSources, "DEMUX_SOURCE_LIMIT_EXCEEDED",
      "Global direct-decode source limit reached", { maximumSources: this.limits.maximumSources });
    try {
      const service = await DirectH264SourceService.open(
        normalizedPath,
        sourceIdentity,
        this.limits,
        this.byteBudget,
      );
      this.sourcesByHandle.set(service.sourceHandle, service);
      this.sourcesByIdentity.set(sourceIdentity, service);
      this.metrics.directSourcesOpened += 1;
      return service.publicInfo(false);
    } catch (error) {
      if (!isCacheRequiredError(error)) throw error;
      this.metrics.canonicalCacheRequired += 1;
      return cacheRequiredDecision(error, sourceIdentity);
    }
  }

  sourceFor(request) {
    invariant(!this.disposed, "DEMUX_BROKER_DISPOSED", "Production demux broker is disposed");
    const handle = validateOpaqueToken(request?.sourceHandle, "sourceHandle");
    const source = this.sourcesByHandle.get(handle);
    invariant(source != null, "DEMUX_SOURCE_NOT_FOUND", "Direct-decode source handle is absent or closed");
    return source;
  }

  resolveTarget(request) { return this.sourceFor(request).resolveTarget(request); }
  beginCursor(request) { return this.sourceFor(request).begin(request); }
  nextBatch(request) { return this.sourceFor(request).next(request); }
  acknowledgeBatch(request) { return this.sourceFor(request).acknowledgeBatch(request); }
  releaseCursor(request) { return this.sourceFor(request).release(request); }

  async closeSource(request) {
    const source = this.sourceFor(request);
    this.sourcesByHandle.delete(source.sourceHandle);
    this.sourcesByIdentity.delete(source.sourceIdentity);
    await source.dispose();
    this.metrics.sourcesClosed += 1;
    return true;
  }

  snapshot() {
    let activeCursors = 0;
    let pendingBegins = 0;
    let activeReads = 0;
    for (const source of this.sourcesByHandle.values()) {
      const snapshot = source.snapshot();
      activeCursors += snapshot.activeCursors;
      pendingBegins += snapshot.pendingBegins;
      activeReads += snapshot.activeReads;
    }
    return Object.freeze({
      schemaVersion: PRODUCTION_DECODER_SCHEMA_VERSION,
      ...this.metrics,
      activeSources: this.sourcesByHandle.size,
      activeCursors,
      pendingBegins,
      activeReads,
      byteBudget: this.byteBudget.snapshot(),
    });
  }

  async dispose() {
    if (this.disposed) return;
    const sources = [...this.sourcesByHandle.values()];
    this.sourcesByHandle.clear();
    this.sourcesByIdentity.clear();
    const results = await Promise.allSettled(sources.map((source) => source.dispose()));
    this.byteBudget.close();
    this.disposed = true;
    const failures = results.filter((result) => result.status === "rejected");
    invariant(failures.length === 0, "DEMUX_BROKER_DISPOSE_FAILED",
      "One or more main-process demux sources did not clean up", {
        failureCount: failures.length,
        messages: failures.slice(0, 8).map((result) => result.reason?.message ?? String(result.reason)),
      });
  }
}

export function createProductionDemuxBroker(options = {}) {
  return new ProductionDemuxBroker(options);
}

/**
 * Root main-process integration API. `resolveSource` is the host's allow-list:
 * renderer tokens are never treated as filesystem paths.
 */
export function createProductionDecoderMainBridge({ broker, resolveSource }) {
  invariant(broker instanceof ProductionDemuxBroker, "INVALID_DEMUX_BROKER",
    "createProductionDecoderMainBridge requires a ProductionDemuxBroker");
  invariant(typeof resolveSource === "function", "INVALID_SOURCE_RESOLVER",
    "Main bridge requires an approved source-token resolver");
  return Object.freeze({
    async decoderOpenSource(request) {
      const approved = await resolveSource(request);
      invariant(approved && typeof approved === "object", "SOURCE_RESOLVER_REJECTED",
        "Source resolver did not return an approved source");
      invariant(approved.sourceIdentity === request.sourceIdentity, "SOURCE_RESOLVER_IDENTITY_MISMATCH",
        "Approved source identity differs from the renderer request");
      return broker.openSource(approved);
    },
    decoderResolveTarget: (request) => broker.resolveTarget(request),
    decoderBeginCursor: (request) => broker.beginCursor(request),
    decoderNextBatch: (request) => broker.nextBatch(request),
    decoderAckBatch: (request) => broker.acknowledgeBatch(request),
    decoderReleaseCursor: (request) => broker.releaseCursor(request),
    decoderCloseSource: (request) => broker.closeSource(request),
    decoderStats: () => broker.snapshot(),
  });
}

export { CACHE_DECISION, DIRECT_DECISION };
