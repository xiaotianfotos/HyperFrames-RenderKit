import {
  CACHE_DECISION,
  DEFAULT_RUNTIME_LIMITS,
  DIRECT_DECISION,
  PRODUCTION_DECODER_SCHEMA_VERSION,
  ProductionDecoderError,
  asUint8Array,
  cacheRequiredDecision,
  invariant,
  validateBoundedInteger,
  validateOpaqueToken,
  validateSourceIdentity,
} from "./contract.mjs";

const BRIDGE_METHODS = Object.freeze([
  "decoderOpenSource",
  "decoderResolveTarget",
  "decoderBeginCursor",
  "decoderNextBatch",
  "decoderAckBatch",
  "decoderReleaseCursor",
  "decoderCloseSource",
  "decoderStats",
]);

function validateBridge(bridge) {
  for (const method of BRIDGE_METHODS) {
    invariant(typeof bridge?.[method] === "function", "INVALID_DECODER_BRIDGE",
      `Renderer decoder bridge is missing ${method}()`, { method });
  }
}

class BoundedLruMap {
  constructor(maximum) {
    this.maximum = validateBoundedInteger(maximum, "LRU maximum", 1, 16_384);
    this.map = new Map();
  }

  get(key) {
    const value = this.map.get(key);
    if (value === undefined) return undefined;
    this.map.delete(key);
    this.map.set(key, value);
    return value;
  }

  set(key, value) {
    if (this.map.has(key)) this.map.delete(key);
    this.map.set(key, value);
    while (this.map.size > this.maximum) this.map.delete(this.map.keys().next().value);
  }

  clear() { this.map.clear(); }
  get size() { return this.map.size; }
}

function validateOpenInfo(info, expectedSourceIdentity) {
  invariant(info && typeof info === "object", "INVALID_DECODER_OPEN_RESPONSE",
    "Main decoder broker returned no open response");
  invariant(info.schemaVersion === PRODUCTION_DECODER_SCHEMA_VERSION,
    "DECODER_SCHEMA_MISMATCH", "Main and renderer decoder schemas differ", {
      expected: PRODUCTION_DECODER_SCHEMA_VERSION,
      actual: info.schemaVersion ?? null,
    });
  invariant(info.decision === DIRECT_DECISION || info.decision === CACHE_DECISION,
    "INVALID_DECODER_DECISION", "Main decoder broker returned an unknown decision", {
      decision: info.decision ?? null,
    });
  validateSourceIdentity(info.sourceIdentity, "openInfo.sourceIdentity");
  invariant(info.sourceIdentity === expectedSourceIdentity, "DECODER_OPEN_SOURCE_MISMATCH",
    "Main decoder broker opened a different source identity");
  return info;
}

function validateTarget(rawTarget, expectedPtsUs) {
  invariant(rawTarget && typeof rawTarget === "object", "INVALID_TARGET_RESPONSE",
    "Main decoder broker returned no exact target");
  invariant(Number.isSafeInteger(rawTarget.presentationFrameIndex) && rawTarget.presentationFrameIndex >= 0,
    "INVALID_TARGET_ORDINAL", "Resolved presentation ordinal is invalid", { rawTarget });
  invariant(Number.isSafeInteger(rawTarget.ptsUs) && rawTarget.ptsUs === expectedPtsUs,
    "TARGET_PTS_IDENTITY_MISMATCH", "Resolved target PTS differs from the exact request", {
      expectedPtsUs,
      actualPtsUs: rawTarget.ptsUs,
    });
  invariant(Number.isSafeInteger(rawTarget.durationUs) && rawTarget.durationUs > 0,
    "INVALID_TARGET_DURATION", "Resolved target duration is invalid", { rawTarget });
  invariant(Number.isSafeInteger(rawTarget.packetDecodeOrdinal) && rawTarget.packetDecodeOrdinal >= 0,
    "INVALID_TARGET_DECODE_ORDINAL", "Resolved target decode ordinal is invalid", { rawTarget });
  return Object.freeze({ ...rawTarget });
}

function validatePacket(rawPacket) {
  invariant(rawPacket && typeof rawPacket === "object", "INVALID_REMOTE_PACKET",
    "Main decoder broker returned an invalid packet");
  const data = asUint8Array(rawPacket.data, "encoded packet data");
  invariant(Number.isSafeInteger(rawPacket.decodeOrdinal) && rawPacket.decodeOrdinal >= 0,
    "INVALID_PACKET_DECODE_ORDINAL", "Packet decode ordinal is invalid", { rawPacket });
  invariant(Number.isSafeInteger(rawPacket.sequenceNumber) && rawPacket.sequenceNumber >= 0,
    "INVALID_PACKET_SEQUENCE", "Packet sequence number is invalid", { rawPacket });
  invariant(Number.isSafeInteger(rawPacket.presentationFrameIndex) && rawPacket.presentationFrameIndex >= 0,
    "INVALID_PACKET_PRESENTATION_ORDINAL", "Packet presentation ordinal is invalid", { rawPacket });
  invariant(Number.isSafeInteger(rawPacket.ptsUs), "INVALID_PACKET_PTS",
    "Packet PTS must be integer microseconds", { rawPacket });
  invariant(Number.isSafeInteger(rawPacket.durationUs) && rawPacket.durationUs > 0,
    "INVALID_PACKET_DURATION", "Packet duration must be positive integer microseconds", { rawPacket });
  invariant(rawPacket.type === "key" || rawPacket.type === "delta",
    "INVALID_PACKET_TYPE", "Packet type must be key or delta", { rawPacket });
  invariant(Number.isSafeInteger(rawPacket.byteLength)
    && rawPacket.byteLength === data.byteLength && data.byteLength > 0,
  "REMOTE_PACKET_BYTE_LENGTH_MISMATCH", "Packet declared and actual byte lengths differ", {
    declared: rawPacket.byteLength,
    actual: data.byteLength,
  });
  return Object.freeze({ ...rawPacket, data });
}

export class RemoteDecoderSource {
  static async open(bridge, request, runtimeLimits = {}) {
    validateBridge(bridge);
    const sourceIdentity = validateSourceIdentity(request?.sourceIdentity);
    const info = validateOpenInfo(await bridge.decoderOpenSource(request), sourceIdentity);
    if (info.decision === CACHE_DECISION) return Object.freeze({ decision: CACHE_DECISION, info, source: null });
    const limits = { ...DEFAULT_RUNTIME_LIMITS, ...runtimeLimits };
    if (info.summary.maximumPresentationReorderDepth > limits.readyFramesMax) {
      await bridge.decoderCloseSource({
        sourceHandle: info.sourceHandle,
        sourceIdentity,
      });
      const decision = cacheRequiredDecision(new ProductionDecoderError(
        "CACHE_REQUIRED_REORDER_DEPTH",
        "H.264 reorder depth exceeds the validated renderer frame-retention profile",
        {
          maximumPresentationReorderDepth: info.summary.maximumPresentationReorderDepth,
          readyFramesMax: limits.readyFramesMax,
        },
      ), sourceIdentity);
      return Object.freeze({ decision: CACHE_DECISION, info: decision, source: null });
    }
    const source = new RemoteDecoderSource({ bridge, info, runtimeLimits: limits });
    return Object.freeze({ decision: DIRECT_DECISION, info, source });
  }

  constructor({ bridge, info, runtimeLimits }) {
    validateBridge(bridge);
    this.bridge = bridge;
    this.sourceHandle = validateOpaqueToken(info.sourceHandle, "sourceHandle");
    this.sourceIdentity = validateSourceIdentity(info.sourceIdentity);
    this.indexDigest = String(info.summary?.indexDigest ?? "");
    invariant(/^[0-9a-f]{64}$/.test(this.indexDigest), "INVALID_INDEX_DIGEST",
      "Main decoder summary is missing a SHA-256 compact-index digest");
    this.presentationTimingDigest = String(info.summary?.presentationTimingDigest ?? "");
    invariant(/^[0-9a-f]{64}$/.test(this.presentationTimingDigest),
      "INVALID_PRESENTATION_TIMING_DIGEST",
      "Main decoder summary is missing a SHA-256 presentation timing digest");
    invariant(info.summary?.timing?.kind === "cfr-zero-origin", "REMOTE_TIMING_CONTRACT_MISMATCH",
      "Direct renderer source must have a proven CFR zero-origin timing profile");
    invariant(info.summary?.codec === "avc" && /^avc1\./.test(info.summary?.sampleEntry ?? ""),
      "REMOTE_CODEC_CONTRACT_MISMATCH", "Direct renderer source must be H.264 avc1");
    this.summary = Object.freeze({ ...info.summary, track: Object.freeze({ ...info.summary.track }) });
    this.maximumBatchPackets = validateBoundedInteger(
      info.limits?.maximumBatchPackets, "broker maximumBatchPackets", 1, 32,
    );
    this.maximumBatchBytes = validateBoundedInteger(
      info.limits?.maximumBatchBytes, "broker maximumBatchBytes", 1, 32 * 1024 * 1024,
    );
    this.maximumOpenCursors = validateBoundedInteger(
      info.limits?.maximumOpenCursors, "broker maximumOpenCursors", 1, 32,
    );
    this.batchSize = Math.min(this.maximumBatchPackets, runtimeLimits.batchSize ?? this.maximumBatchPackets);
    invariant(runtimeLimits.maximumPacketMetadataEntries
      >= runtimeLimits.maxLanesPerSource * this.batchSize,
    "REMOTE_METADATA_BUDGET_TOO_SMALL",
    "Packet metadata cache must cover every bounded per-source lane batch", {
      maximumPacketMetadataEntries: runtimeLimits.maximumPacketMetadataEntries,
      requiredEntries: runtimeLimits.maxLanesPerSource * this.batchSize,
      maxLanesPerSource: runtimeLimits.maxLanesPerSource,
      batchSize: this.batchSize,
    });
    this.decoderConfig = {
      ...info.decoderConfig,
      description: asUint8Array(info.decoderConfig?.description, "decoder config description"),
    };
    invariant(/^avc1\./.test(this.decoderConfig.codec ?? "") && this.decoderConfig.description.byteLength > 0,
      "INVALID_REMOTE_DECODER_CONFIG", "Remote decoder config is incomplete");
    this.targetCache = new BoundedLruMap(runtimeLimits.maximumTargetCacheEntries);
    this.packetMetadata = new BoundedLruMap(runtimeLimits.maximumPacketMetadataEntries);
    this.cursorByPacket = new WeakMap();
    this.cursorStates = new Map();
    this.pendingCleanup = new Set();
    this.disposed = false;
    this.metrics = {
      targetResolves: 0,
      targetCacheHits: 0,
      cursorBegins: 0,
      cursorReleases: 0,
      batches: 0,
      batchAcks: 0,
      packetsReceived: 0,
      bytesReceived: 0,
      peakBufferedPackets: 0,
      peakBufferedBytes: 0,
      validationFailures: 0,
    };
  }

  requestBase() {
    return { sourceHandle: this.sourceHandle, sourceIdentity: this.sourceIdentity };
  }

  validateEnvelope(response) {
    invariant(response && typeof response === "object", "INVALID_REMOTE_RESPONSE",
      "Main decoder broker returned an invalid response");
    invariant(response.schemaVersion == null || response.schemaVersion === PRODUCTION_DECODER_SCHEMA_VERSION,
      "DECODER_SCHEMA_MISMATCH", "Main decoder response schema changed during a render");
    invariant(response.sourceHandle === this.sourceHandle && response.sourceIdentity === this.sourceIdentity,
      "REMOTE_SOURCE_IDENTITY_MISMATCH", "Main decoder response belongs to another source");
    invariant(response.indexDigest === this.indexDigest,
      "REMOTE_INDEX_DIGEST_MISMATCH", "Main decoder compact index changed during a render");
  }

  async resolveTarget(ptsUs) {
    invariant(!this.disposed, "REMOTE_SOURCE_DISPOSED", "Remote decoder source is disposed");
    invariant(Number.isSafeInteger(ptsUs), "INVALID_TARGET_PTS",
      "Exact target PTS must be integer microseconds", { ptsUs });
    const cached = this.targetCache.get(ptsUs);
    if (cached) {
      this.metrics.targetCacheHits += 1;
      return cached;
    }
    const response = await this.bridge.decoderResolveTarget({ ...this.requestBase(), ptsUs });
    this.validateEnvelope(response);
    const target = validateTarget(response.target, ptsUs);
    this.targetCache.set(ptsUs, target);
    this.metrics.targetResolves += 1;
    return target;
  }

  rememberPacketMetadata(packet) {
    const existing = this.packetMetadata.get(packet.ptsUs);
    invariant(existing == null
      || (existing.decodeOrdinal === packet.decodeOrdinal
        && existing.presentationFrameIndex === packet.presentationFrameIndex),
    "REMOTE_PACKET_PTS_COLLISION", "Two remote packets claim the same presentation PTS", {
      ptsUs: packet.ptsUs,
    });
    this.packetMetadata.set(packet.ptsUs, packet);
    this.targetCache.set(packet.ptsUs, Object.freeze({
      presentationFrameIndex: packet.presentationFrameIndex,
      ptsUs: packet.ptsUs,
      durationUs: packet.durationUs,
      packetDecodeOrdinal: packet.decodeOrdinal,
    }));
  }

  presentationForSubmittedPts(ptsUs) {
    return this.packetMetadata.get(ptsUs) ?? null;
  }

  validateBatch(rawBatch, { expectedToken = null, expectedDecodeOrdinal = null, firstBatch = false } = {}) {
    try {
      this.validateEnvelope(rawBatch);
      const token = validateOpaqueToken(rawBatch.token, "cursorToken");
      const batchLeaseId = validateOpaqueToken(rawBatch.batchLeaseId, "batchLeaseId");
      if (expectedToken != null) {
        invariant(token === expectedToken, "REMOTE_CURSOR_TOKEN_MISMATCH",
          "Main decoder returned another cursor token");
      }
      invariant(typeof rawBatch.eof === "boolean", "INVALID_REMOTE_EOF", "Remote EOF flag must be boolean");
      invariant(Array.isArray(rawBatch.packets) && rawBatch.packets.length > 0
        && rawBatch.packets.length <= this.batchSize,
      "INVALID_REMOTE_PACKET_BATCH", "Remote packet batch size is outside the negotiated limit", {
        packetCount: rawBatch.packets?.length ?? null,
        batchSize: this.batchSize,
      });
      const packets = [];
      let batchBytes = 0;
      let nextDecodeOrdinal = expectedDecodeOrdinal;
      for (const rawPacket of rawBatch.packets) {
        const packet = validatePacket(rawPacket);
        if (nextDecodeOrdinal != null) {
          invariant(packet.decodeOrdinal === nextDecodeOrdinal, "REMOTE_DECODE_SEQUENCE_DISCONTINUITY",
            "Remote packet decode ordinals are not contiguous", {
              expectedDecodeOrdinal: nextDecodeOrdinal,
              actualDecodeOrdinal: packet.decodeOrdinal,
            });
        }
        nextDecodeOrdinal = packet.decodeOrdinal + 1;
        batchBytes += packet.data.byteLength;
        packets.push(packet);
      }
      invariant(Number.isSafeInteger(rawBatch.batchBytes)
        && rawBatch.batchBytes === batchBytes && batchBytes <= this.maximumBatchBytes,
      "REMOTE_BATCH_BYTE_COUNT_MISMATCH", "Remote packet batch byte count is invalid", {
        declared: rawBatch.batchBytes,
        measured: batchBytes,
        maximumBatchBytes: this.maximumBatchBytes,
      });
      let target = null;
      let rap = null;
      if (firstBatch) {
        target = validateTarget(rawBatch.target, rawBatch.target?.ptsUs);
        rap = validatePacket({ ...rawBatch.rap, data: packets[0].data });
        invariant(packets[0].decodeOrdinal === rap.decodeOrdinal
          && packets[0].sequenceNumber === rap.sequenceNumber && packets[0].type === "key",
        "REMOTE_RAP_MISMATCH", "First cursor packet does not match the verified RAP summary");
      } else {
        invariant(rawBatch.target == null && rawBatch.rap == null,
          "REMOTE_BATCH_UNEXPECTED_MANIFEST_DATA",
          "Non-initial packet batches must not carry target/RAP manifest objects");
      }
      for (const packet of packets) this.rememberPacketMetadata(packet);
      this.metrics.batches += 1;
      this.metrics.packetsReceived += packets.length;
      this.metrics.bytesReceived += batchBytes;
      return { token, batchLeaseId, batchBytes, packets, eof: rawBatch.eof, nextDecodeOrdinal, target, rap };
    } catch (error) {
      this.metrics.validationFailures += 1;
      throw error;
    }
  }

  updateBufferPeaks() {
    let packets = 0;
    let bytes = 0;
    for (const state of this.cursorStates.values()) {
      packets += state.packets.length;
      bytes += state.bufferedBytes;
    }
    this.metrics.peakBufferedPackets = Math.max(this.metrics.peakBufferedPackets, packets);
    this.metrics.peakBufferedBytes = Math.max(this.metrics.peakBufferedBytes, bytes);
  }

  normalizePacket(packet, state) {
    this.cursorByPacket.set(packet, state);
    state.lastDeliveredDecodeOrdinal = packet.decodeOrdinal;
    state.bufferedBytes -= packet.data.byteLength;
    invariant(state.bufferedBytes >= 0, "REMOTE_BUFFER_BYTE_UNDERFLOW",
      "Remote cursor buffered-byte accounting underflowed");
    return packet;
  }

  async verifiedRapCursor(targetPtsUs) {
    invariant(!this.disposed, "REMOTE_SOURCE_DISPOSED", "Remote decoder source is disposed");
    invariant(this.cursorStates.size < this.maximumOpenCursors, "REMOTE_CURSOR_LIMIT_EXCEEDED",
      "Renderer cursor count reached the negotiated per-source limit");
    const resolved = await this.resolveTarget(targetPtsUs);
    let rawBatch;
    try {
      rawBatch = await this.bridge.decoderBeginCursor({
        ...this.requestBase(),
        ptsUs: targetPtsUs,
        batchSize: this.batchSize,
      });
      const batch = this.validateBatch(rawBatch, { firstBatch: true });
      invariant(batch.target.presentationFrameIndex === resolved.presentationFrameIndex
        && batch.target.ptsUs === resolved.ptsUs,
      "REMOTE_TARGET_CHANGED", "Target resolution changed between resolve and cursor begin");
      const state = {
        token: batch.token,
        batchLeaseId: batch.batchLeaseId,
        packets: batch.packets,
        bufferedBytes: batch.batchBytes,
        eof: batch.eof,
        nextDecodeOrdinal: batch.nextDecodeOrdinal,
        lastDeliveredDecodeOrdinal: null,
        released: false,
        busy: false,
      };
      this.cursorStates.set(state.token, state);
      this.metrics.cursorBegins += 1;
      this.updateBufferPeaks();
      return this.normalizePacket(state.packets.shift(), state);
    } catch (error) {
      if (rawBatch?.token && rawBatch?.batchLeaseId) {
        try {
          await this.bridge.decoderReleaseCursor({
            ...this.requestBase(),
            token: rawBatch.token,
          });
        } catch {
          // Keep the original validation/begin error.
        }
      }
      throw error;
    }
  }

  async acknowledgeStateBatch(state) {
    if (!state.batchLeaseId) return;
    const leaseId = state.batchLeaseId;
    const acknowledged = await this.bridge.decoderAckBatch({
      ...this.requestBase(),
      token: state.token,
      batchLeaseId: leaseId,
    });
    invariant(acknowledged === true, "REMOTE_BATCH_ACK_REJECTED",
      "Main decoder broker rejected an outstanding packet-batch acknowledgement");
    state.batchLeaseId = null;
    this.metrics.batchAcks += 1;
  }

  async nextPacket(packet) {
    const state = this.cursorByPacket.get(packet);
    invariant(state != null && !state.released, "REMOTE_PACKET_CURSOR_MISSING",
      "Encoded packet is detached from its remote cursor");
    invariant(packet.decodeOrdinal === state.lastDeliveredDecodeOrdinal,
      "REMOTE_CURSOR_PACKET_REPLAY", "nextPacket() must advance from the last delivered packet");
    invariant(!state.busy, "REMOTE_CURSOR_BUSY", "Concurrent nextPacket() calls are forbidden");
    state.busy = true;
    try {
      if (state.packets.length === 0) {
        await this.acknowledgeStateBatch(state);
        if (state.eof) {
          state.released = true;
          this.cursorStates.delete(state.token);
          this.metrics.cursorReleases += 1;
          return null;
        }
        const rawBatch = await this.bridge.decoderNextBatch({
          ...this.requestBase(),
          token: state.token,
          batchSize: this.batchSize,
        });
        const batch = this.validateBatch(rawBatch, {
          expectedToken: state.token,
          expectedDecodeOrdinal: state.nextDecodeOrdinal,
          firstBatch: false,
        });
        state.batchLeaseId = batch.batchLeaseId;
        state.packets.push(...batch.packets);
        state.bufferedBytes = batch.batchBytes;
        state.eof = batch.eof;
        state.nextDecodeOrdinal = batch.nextDecodeOrdinal;
        this.updateBufferPeaks();
      }
      invariant(state.packets.length > 0, "EMPTY_NON_EOF_CURSOR",
        "Remote cursor ran out of packets without EOF");
      return this.normalizePacket(state.packets.shift(), state);
    } catch (error) {
      try {
        await this.releaseState(state);
      } catch (releaseError) {
        throw new AggregateError([error, releaseError],
          `Remote demux failed and cursor release also failed: ${error?.message ?? error}`);
      }
      throw error;
    } finally {
      state.busy = false;
    }
  }

  toVerifiedChunk(packet, encodedChunkFactory = null) {
    const metadata = this.packetMetadata.get(packet.ptsUs);
    invariant(metadata != null
      && metadata.decodeOrdinal === packet.decodeOrdinal
      && metadata.byteLength === packet.byteLength,
    "REMOTE_PACKET_METADATA_EVICTED", "Packet metadata is unavailable before WebCodecs submission", {
      ptsUs: packet.ptsUs,
      decodeOrdinal: packet.decodeOrdinal,
    });
    const factory = encodedChunkFactory ?? ((init) => new EncodedVideoChunk(init));
    const chunk = factory({
      data: packet.data,
      type: packet.type,
      timestamp: packet.ptsUs,
      duration: packet.durationUs,
    });
    invariant(chunk.timestamp === packet.ptsUs && chunk.duration === packet.durationUs,
      "ENCODED_CHUNK_TIMING_MISMATCH", "EncodedVideoChunk changed exact packet timing");
    return { chunk, metadata };
  }

  async releaseState(state) {
    if (!state || state.released) return false;
    state.released = true;
    state.packets.length = 0;
    state.bufferedBytes = 0;
    this.cursorStates.delete(state.token);
    const cleanup = Promise.resolve(this.bridge.decoderReleaseCursor({
      ...this.requestBase(),
      token: state.token,
    })).then((released) => {
      invariant(released === true, "REMOTE_CURSOR_RELEASE_REJECTED",
        "Main decoder broker rejected an active cursor release", { token: state.token });
      return true;
    });
    this.pendingCleanup.add(cleanup);
    try {
      await cleanup;
      state.batchLeaseId = null;
      this.metrics.cursorReleases += 1;
      return true;
    } finally {
      this.pendingCleanup.delete(cleanup);
    }
  }

  async releaseCursor(packet) {
    const state = packet ? this.cursorByPacket.get(packet) : null;
    if (!state || state.released) return false;
    return this.releaseState(state);
  }

  snapshot() {
    return Object.freeze({
      schemaVersion: PRODUCTION_DECODER_SCHEMA_VERSION,
      sourceIdentity: this.sourceIdentity,
      ...this.metrics,
      activeCursors: this.cursorStates.size,
      pendingCleanup: this.pendingCleanup.size,
      targetCacheEntries: this.targetCache.size,
      packetMetadataEntries: this.packetMetadata.size,
      disposed: this.disposed,
    });
  }

  async getTransportMetrics() { return this.bridge.decoderStats(); }

  async dispose() {
    if (this.disposed) return;
    this.disposed = true;
    const states = [...this.cursorStates.values()];
    const results = await Promise.allSettled(states.map((state) => this.releaseState(state)));
    await Promise.allSettled([...this.pendingCleanup]);
    const failures = results.filter((result) => result.status === "rejected");
    let closeError = null;
    try {
      const closed = await this.bridge.decoderCloseSource(this.requestBase());
      invariant(closed === true, "REMOTE_SOURCE_CLOSE_REJECTED",
        "Main decoder broker rejected an active source close");
    } catch (error) {
      closeError = error;
    }
    this.targetCache.clear();
    this.packetMetadata.clear();
    invariant(failures.length === 0 && closeError == null, "REMOTE_SOURCE_DISPOSE_FAILED",
      "Remote decoder source cleanup did not complete", {
        cursorReleaseFailures: failures.length,
        closeError: closeError?.message ?? null,
      });
  }
}

export async function openRemoteDecoderSource(bridge, request, runtimeLimits = {}) {
  return RemoteDecoderSource.open(bridge, request, runtimeLimits);
}
