import {
  DEFAULT_RUNTIME_LIMITS,
  ProductionDecoderError,
  classifyLaneTransition,
  invariant,
} from "./contract.mjs";

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject, settled: false };
}

function withTimeout(promise, timeoutMs, createError) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(createError()), timeoutMs);
    }),
  ]).finally(() => clearTimeout(timer));
}

export class GlobalVideoFrameBudget {
  constructor(maximumFrames) {
    invariant(Number.isSafeInteger(maximumFrames) && maximumFrames > 0,
      "INVALID_FRAME_BUDGET", "Global VideoFrame budget must be positive", { maximumFrames });
    this.maximumFrames = maximumFrames;
    this.outstandingFrames = 0;
    this.peakFrames = 0;
    this.acquiredFrames = 0;
    this.closedFrames = 0;
  }

  acquire() {
    this.outstandingFrames += 1;
    this.acquiredFrames += 1;
    this.peakFrames = Math.max(this.peakFrames, this.outstandingFrames);
    invariant(this.outstandingFrames <= this.maximumFrames, "GLOBAL_FRAME_BUDGET_EXCEEDED",
      "Outstanding VideoFrame count exceeded the global bound", {
        outstandingFrames: this.outstandingFrames,
        maximumFrames: this.maximumFrames,
      });
  }

  release() {
    invariant(this.outstandingFrames > 0, "FRAME_BUDGET_UNDERFLOW",
      "A VideoFrame budget lease was released twice");
    this.outstandingFrames -= 1;
    this.closedFrames += 1;
  }

  snapshot() {
    return Object.freeze({
      maximumFrames: this.maximumFrames,
      outstandingFrames: this.outstandingFrames,
      peakFrames: this.peakFrames,
      acquiredFrames: this.acquiredFrames,
      closedFrames: this.closedFrames,
    });
  }
}

export class ProductionDecoderLane {
  constructor({
    laneId,
    source,
    frameBudget,
    limits = {},
    videoDecoderFactory = null,
    encodedChunkFactory = null,
  }) {
    invariant(typeof laneId === "string" && laneId.length > 0,
      "INVALID_LANE_ID", "Decoder lane needs a stable id");
    invariant(source && typeof source.resolveTarget === "function"
      && typeof source.verifiedRapCursor === "function",
    "INVALID_REMOTE_SOURCE", "Decoder lane needs a RemoteDecoderSource-like adapter");
    invariant(frameBudget instanceof GlobalVideoFrameBudget,
      "INVALID_FRAME_BUDGET", "Decoder lane needs the shared GlobalVideoFrameBudget");
    this.laneId = laneId;
    this.source = source;
    this.frameBudget = frameBudget;
    this.limits = { ...DEFAULT_RUNTIME_LIMITS, ...limits };
    this.videoDecoderFactory = videoDecoderFactory
      ?? ((callbacks) => new VideoDecoder(callbacks));
    this.encodedChunkFactory = encodedChunkFactory;
    this.decoder = null;
    this.generation = 0;
    this.configured = false;
    this.drained = false;
    this.lastFedDecodeOrdinal = null;
    this.lastOutputPtsUs = null;
    this.lastRequestedOrdinal = null;
    this.held = null;
    this.readyFrames = new Map();
    this.closedFrames = new WeakSet();
    this.activeRequest = null;
    this.nextPacket = null;
    this.outputSignal = deferred();
    this.fatalError = null;
    this.submittedInGeneration = 0;
    this.outputsInGeneration = 0;
    this.submittedMetadataByPts = new Map();
    this.metrics = {
      configureCount: 0,
      decoderConfigureMs: 0,
      decodeSubmitMs: 0,
      decodeWaitMs: 0,
      decodeLeadWaitMs: 0,
      packetsDecoded: 0,
      decodeQueuePeak: 0,
      decodeLeadPeak: 0,
      outputs: 0,
      framesClosed: 0,
      readyFramesPeak: 0,
      resets: 0,
      rapRestarts: 0,
      reuses: 0,
      advances: 0,
      seeks: 0,
      eofFlushes: 0,
      exactPtsFailures: 0,
      unexpectedOutputs: 0,
      duplicateOutputs: 0,
      transitionActions: { reuse: 0, advance: 0, seek: 0 },
      transitionReasons: {},
      lastTransition: null,
      lastSubmittedDecodeOrdinal: null,
      lastSubmittedPtsUs: null,
    };
  }

  stateForTransition() {
    return {
      configured: this.configured,
      drained: this.drained,
      heldOrdinal: this.held?.ordinal ?? null,
      lastRequestedOrdinal: this.lastRequestedOrdinal,
    };
  }

  createDecoder() {
    this.decoder = this.videoDecoderFactory({
      output: (frame) => this.onOutput(frame),
      error: (error) => this.onDecoderError(error),
    });
    invariant(this.decoder && typeof this.decoder.configure === "function"
      && typeof this.decoder.decode === "function",
    "VIDEODECODER_UNAVAILABLE", "VideoDecoder is unavailable or invalid in this renderer");
  }

  async configure({ reset = false } = {}) {
    const startedAt = performance.now();
    if (!this.decoder || this.decoder.state === "closed") this.createDecoder();
    if (reset && this.decoder.state !== "closed") {
      this.decoder.reset();
      this.metrics.resets += 1;
    }
    this.decoder.configure({
      ...this.source.decoderConfig,
      hardwareAcceleration: "prefer-hardware",
      optimizeForLatency: false,
    });
    this.configured = true;
    this.drained = false;
    this.metrics.configureCount += 1;
    this.metrics.decoderConfigureMs += performance.now() - startedAt;
  }

  closeFrame(frame, reason) {
    if (!frame || this.closedFrames.has(frame)) return reason;
    this.closedFrames.add(frame);
    try {
      frame.close();
    } finally {
      this.frameBudget.release();
      this.metrics.framesClosed += 1;
    }
    return reason;
  }

  closeHeld(reason) {
    if (!this.held) return;
    this.closeFrame(this.held.frame, reason);
    this.held = null;
  }

  closeReady(reason) {
    for (const ready of this.readyFrames.values()) this.closeFrame(ready.frame, reason);
    this.readyFrames.clear();
  }

  signalOutput() {
    if (!this.outputSignal.settled) {
      this.outputSignal.settled = true;
      this.outputSignal.resolve();
    }
    this.outputSignal = deferred();
  }

  failActive(error) {
    if (!this.activeRequest || this.activeRequest.deferred.settled) return;
    this.activeRequest.deferred.settled = true;
    this.activeRequest.deferred.reject(error);
  }

  onDecoderError(error) {
    this.fatalError = new ProductionDecoderError(
      "VIDEODECODER_ERROR",
      "VideoDecoder emitted an asynchronous error",
      { laneId: this.laneId, cause: error?.message ?? String(error) },
    );
    this.failActive(this.fatalError);
    this.closeHeld("decoder-error");
    this.closeReady("decoder-error");
    this.submittedMetadataByPts.clear();
    this.signalOutput();
  }

  retainReady(frame, metadata) {
    const ptsUs = metadata.ptsUs;
    if (this.readyFrames.has(ptsUs)) {
      this.metrics.duplicateOutputs += 1;
      this.closeFrame(frame, "duplicate-ready-output");
      throw new ProductionDecoderError("DUPLICATE_OUTPUT_PTS",
        "VideoDecoder emitted the same PTS twice in one generation", {
          laneId: this.laneId,
          generation: this.generation,
          ptsUs,
        });
    }
    this.readyFrames.set(ptsUs, {
      frame,
      ordinal: metadata.presentationFrameIndex,
      ptsUs,
      generation: this.generation,
    });
    const ordered = [...this.readyFrames.values()].sort((left, right) => left.ptsUs - right.ptsUs);
    while (ordered.length > this.limits.readyFramesMax) {
      const discarded = ordered.pop();
      this.readyFrames.delete(discarded.ptsUs);
      this.closeFrame(discarded.frame, "ready-frame-cap");
    }
    this.metrics.readyFramesPeak = Math.max(this.metrics.readyFramesPeak, this.readyFrames.size);
  }

  onOutput(frame) {
    try {
      this.frameBudget.acquire();
      this.metrics.outputs += 1;
      const ptsUs = frame.timestamp;
      const metadata = this.submittedMetadataByPts.get(ptsUs);
      if (!metadata) {
        if (ptsUs === this.lastOutputPtsUs) this.metrics.duplicateOutputs += 1;
        else this.metrics.unexpectedOutputs += 1;
        this.closeFrame(frame, "unexpected-output-pts");
        throw new ProductionDecoderError("UNEXPECTED_OUTPUT_PTS",
          "VideoDecoder output PTS was not outstanding on this decoder lane", {
            laneId: this.laneId,
            generation: this.generation,
            ptsUs,
          });
      }
      this.submittedMetadataByPts.delete(ptsUs);
      if (ptsUs === this.lastOutputPtsUs) {
        this.metrics.duplicateOutputs += 1;
        this.closeFrame(frame, "duplicate-output-pts");
        throw new ProductionDecoderError("DUPLICATE_OUTPUT_PTS",
          "VideoDecoder output PTS was duplicated in one decoder generation", {
            laneId: this.laneId,
            generation: this.generation,
            ptsUs,
          });
      }
      if (this.lastOutputPtsUs != null && ptsUs < this.lastOutputPtsUs) {
        this.metrics.unexpectedOutputs += 1;
        this.closeFrame(frame, "non-monotonic-output");
        throw new ProductionDecoderError("NON_MONOTONIC_PRESENTATION_OUTPUT",
          "VideoDecoder outputs must be presentation-ordered within one generation", {
            previousPtsUs: this.lastOutputPtsUs,
            ptsUs,
          });
      }
      this.outputsInGeneration += 1;
      this.lastOutputPtsUs = ptsUs;
      const active = this.activeRequest;
      if (!active) {
        this.retainReady(frame, metadata);
        this.signalOutput();
        return;
      }
      if (ptsUs < active.ptsUs) {
        this.closeFrame(frame, "output-before-target");
      } else if (ptsUs === active.ptsUs) {
        this.closeHeld("replace-held-target");
        this.held = {
          frame,
          ordinal: active.ordinal,
          ptsUs,
          presentationKey: active.presentationKey,
          leaseId: `${this.laneId}:${this.generation}:${ptsUs}`,
        };
        active.deferred.settled = true;
        active.deferred.resolve(this.held);
      } else if (active.deferred.settled) {
        this.retainReady(frame, metadata);
      } else {
        this.metrics.exactPtsFailures += 1;
        this.closeFrame(frame, "output-overshot-target");
        const failure = new ProductionDecoderError("OUTPUT_OVERSHOT_EXACT_TARGET",
          "VideoDecoder advanced past the exact target without producing it", {
            laneId: this.laneId,
            targetPtsUs: active.ptsUs,
            outputPtsUs: ptsUs,
          });
        this.fatalError = failure;
        this.failActive(failure);
      }
      this.signalOutput();
    } catch (error) {
      if (!this.closedFrames.has(frame)) this.closeFrame(frame, "output-handler-error");
      this.fatalError = error;
      this.failActive(error);
      this.signalOutput();
    }
  }

  promoteReady(target, presentationKey) {
    for (const ready of [...this.readyFrames.values()]) {
      if (ready.ptsUs < target.ptsUs) {
        this.readyFrames.delete(ready.ptsUs);
        this.closeFrame(ready.frame, "stale-ready-frame");
      }
    }
    const ready = this.readyFrames.get(target.ptsUs);
    if (!ready) return null;
    this.readyFrames.delete(target.ptsUs);
    this.closeHeld("promote-ready-target");
    this.held = {
      ...ready,
      presentationKey,
      leaseId: `${this.laneId}:${this.generation}:${target.ptsUs}`,
    };
    return this.held;
  }

  async restartAtRap(target) {
    this.failActive(new ProductionDecoderError("REQUEST_RESTARTED", "Active exact-frame request was restarted"));
    this.activeRequest = null;
    this.closeHeld("rap-restart");
    this.closeReady("rap-restart");
    const cursorPacket = this.nextPacket;
    this.nextPacket = null;
    await this.source.releaseCursor(cursorPacket);
    this.generation += 1;
    this.submittedInGeneration = 0;
    this.outputsInGeneration = 0;
    this.submittedMetadataByPts.clear();
    this.fatalError = null;
    await this.configure({ reset: this.configured });
    this.nextPacket = await this.source.verifiedRapCursor(target.ptsUs);
    this.lastFedDecodeOrdinal = null;
    this.lastOutputPtsUs = null;
    this.metrics.rapRestarts += 1;
  }

  async waitForQueueBelowLimit() {
    while (this.decoder.decodeQueueSize >= this.limits.decodeQueueMax) {
      const startedAt = performance.now();
      await withTimeout(
        new Promise((resolve) => this.decoder.addEventListener("dequeue", resolve, { once: true })),
        this.limits.operationTimeoutMs,
        () => new ProductionDecoderError("DECODE_QUEUE_TIMEOUT",
          "VideoDecoder decode queue did not drain", {
            laneId: this.laneId,
            decodeQueueSize: this.decoder.decodeQueueSize,
          }),
      );
      this.metrics.decodeWaitMs += performance.now() - startedAt;
    }
  }

  async yieldForDecoder() {
    const startedAt = performance.now();
    await Promise.race([this.outputSignal.promise, new Promise((resolve) => setTimeout(resolve, 0))]);
    this.metrics.decodeWaitMs += performance.now() - startedAt;
  }

  async waitForDecodeLead(request) {
    while (!request.deferred.settled
      && this.submittedInGeneration - this.outputsInGeneration >= this.limits.decodeLeadMax) {
      const outputCount = this.outputsInGeneration;
      const startedAt = performance.now();
      await withTimeout(
        this.outputSignal.promise,
        this.limits.operationTimeoutMs,
        () => new ProductionDecoderError("DECODE_LEAD_TIMEOUT",
          "Decoder accepted the maximum bounded input lead without presentation progress", {
            laneId: this.laneId,
            submittedInGeneration: this.submittedInGeneration,
            outputCount,
            decodeLeadMax: this.limits.decodeLeadMax,
          }),
      );
      this.metrics.decodeLeadWaitMs += performance.now() - startedAt;
      if (this.fatalError) throw this.fatalError;
      invariant(request.deferred.settled || this.outputsInGeneration > outputCount,
        "DECODE_LEAD_NO_PROGRESS", "Decoder signaled output without advancing exact PTS identity");
    }
  }

  async submitUntilExactTarget(target, request) {
    while (!request.deferred.settled) {
      if (this.fatalError) throw this.fatalError;
      if (!this.nextPacket) {
        this.metrics.eofFlushes += 1;
        const startedAt = performance.now();
        await this.decoder.flush();
        this.metrics.decodeWaitMs += performance.now() - startedAt;
        this.drained = true;
        if (!request.deferred.settled) {
          this.metrics.exactPtsFailures += 1;
          request.deferred.settled = true;
          request.deferred.reject(new ProductionDecoderError("TARGET_NOT_OUTPUT_AT_EOF",
            "VideoDecoder reached EOF without outputting the exact target PTS", {
              targetPtsUs: target.ptsUs,
              targetOrdinal: target.presentationFrameIndex,
            }));
        }
        break;
      }
      await this.waitForDecodeLead(request);
      if (request.deferred.settled) break;
      await this.waitForQueueBelowLimit();
      if (request.deferred.settled) break;
      const packet = this.nextPacket;
      const { chunk, metadata } = this.source.toVerifiedChunk(packet, this.encodedChunkFactory);
      invariant(this.lastFedDecodeOrdinal == null || metadata.decodeOrdinal === this.lastFedDecodeOrdinal + 1,
        "NON_CONTIGUOUS_RUNTIME_DECODE_SEQUENCE",
        "Runtime attempted to feed non-contiguous decode ordinals", {
          previous: this.lastFedDecodeOrdinal,
          next: metadata.decodeOrdinal,
        });
      if (this.lastFedDecodeOrdinal == null) {
        invariant(chunk.type === "key", "RAP_FIRST_CHUNK_NOT_KEY",
          "First chunk after configure/reset must be a verified key packet");
      }
      invariant(!this.submittedMetadataByPts.has(metadata.ptsUs),
        "DUPLICATE_SUBMITTED_PTS", "One decoder generation submitted the same exact PTS twice", {
          laneId: this.laneId,
          ptsUs: metadata.ptsUs,
        });
      this.submittedMetadataByPts.set(metadata.ptsUs, metadata);
      this.submittedInGeneration += 1;
      const startedAt = performance.now();
      try {
        this.decoder.decode(chunk);
      } catch (error) {
        this.submittedMetadataByPts.delete(metadata.ptsUs);
        this.submittedInGeneration -= 1;
        throw error;
      }
      this.metrics.decodeSubmitMs += performance.now() - startedAt;
      this.metrics.packetsDecoded += 1;
      this.metrics.decodeLeadPeak = Math.max(
        this.metrics.decodeLeadPeak,
        this.submittedInGeneration - this.outputsInGeneration,
      );
      this.metrics.decodeQueuePeak = Math.max(this.metrics.decodeQueuePeak, this.decoder.decodeQueueSize);
      invariant(this.decoder.decodeQueueSize <= this.limits.decodeQueueMax,
        "DECODE_QUEUE_LIMIT_EXCEEDED", "VideoDecoder decode queue exceeded its hard bound", {
          decodeQueueSize: this.decoder.decodeQueueSize,
          decodeQueueMax: this.limits.decodeQueueMax,
        });
      this.lastFedDecodeOrdinal = metadata.decodeOrdinal;
      this.metrics.lastSubmittedDecodeOrdinal = metadata.decodeOrdinal;
      this.metrics.lastSubmittedPtsUs = metadata.ptsUs;
      this.nextPacket = await this.source.nextPacket(packet);
      await this.yieldForDecoder();
    }
    return request.deferred.promise;
  }

  recordTransition(transition, target) {
    this.metrics.transitionActions[transition.action] += 1;
    this.metrics.transitionReasons[transition.reason] =
      (this.metrics.transitionReasons[transition.reason] ?? 0) + 1;
    this.metrics.lastTransition = {
      action: transition.action,
      reason: transition.reason,
      targetPtsUs: target.ptsUs,
      targetOrdinal: target.presentationFrameIndex,
    };
  }

  async ensureExactFrame({ ptsUs, presentationKey }) {
    invariant(this.activeRequest == null, "CONCURRENT_REQUEST_ON_LANE",
      "One decoder lane accepts only one exact-frame request at a time", { laneId: this.laneId });
    const target = await this.source.resolveTarget(ptsUs);
    let transition = classifyLaneTransition(this.stateForTransition(), target.presentationFrameIndex, this.limits);
    this.recordTransition(transition, target);
    if (transition.action === "reuse") {
      invariant(this.held?.ptsUs === ptsUs && this.held.presentationKey === presentationKey,
        "HELD_FRAME_IDENTITY_MISMATCH", "Held VideoFrame does not match exact presentation identity");
      this.metrics.reuses += 1;
      this.lastRequestedOrdinal = target.presentationFrameIndex;
      return this.held;
    }
    const ready = this.promoteReady(target, presentationKey);
    if (ready) {
      this.metrics.advances += 1;
      this.lastRequestedOrdinal = target.presentationFrameIndex;
      return ready;
    }
    if (transition.action === "seek") {
      this.metrics.seeks += 1;
      await this.restartAtRap(target);
    } else {
      this.metrics.advances += 1;
      this.closeHeld("advance-request");
    }
    const request = {
      ordinal: target.presentationFrameIndex,
      ptsUs,
      presentationKey,
      deferred: deferred(),
    };
    this.activeRequest = request;
    try {
      const held = await withTimeout(
        this.submitUntilExactTarget(target, request),
        this.limits.operationTimeoutMs,
        () => new ProductionDecoderError("EXACT_FRAME_TIMEOUT",
          "Timed out waiting for exact VideoFrame.timestamp", {
            laneId: this.laneId,
            targetPtsUs: ptsUs,
          }),
      );
      invariant(held?.frame?.timestamp === ptsUs, "RETURNED_FRAME_PTS_MISMATCH",
        "Decoder lane returned the wrong exact VideoFrame timestamp", {
          expectedPtsUs: ptsUs,
          actualPtsUs: held?.frame?.timestamp,
        });
      this.lastRequestedOrdinal = target.presentationFrameIndex;
      return held;
    } finally {
      if (this.activeRequest === request) this.activeRequest = null;
    }
  }

  snapshot() {
    return Object.freeze({
      laneId: this.laneId,
      sourceIdentity: this.source.sourceIdentity,
      generation: this.generation,
      configured: this.configured,
      drained: this.drained,
      heldPtsUs: this.held?.ptsUs ?? null,
      readyFrameCount: this.readyFrames.size,
      ...this.metrics,
      transitionActions: Object.freeze({ ...this.metrics.transitionActions }),
      transitionReasons: Object.freeze({ ...this.metrics.transitionReasons }),
    });
  }

  async close() {
    this.failActive(new ProductionDecoderError("LANE_CLOSED", "Decoder lane was closed"));
    const cursorPacket = this.nextPacket;
    this.nextPacket = null;
    let releaseError = null;
    try {
      await this.source.releaseCursor(cursorPacket);
    } catch (error) {
      releaseError = error;
    } finally {
      this.activeRequest = null;
      this.closeHeld("lane-close");
      this.closeReady("lane-close");
      this.submittedMetadataByPts.clear();
      if (this.decoder && this.decoder.state !== "closed") this.decoder.close();
      this.decoder = null;
      this.configured = false;
      this.drained = true;
    }
    if (releaseError) throw releaseError;
  }
}
