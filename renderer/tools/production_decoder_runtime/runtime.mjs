import {
  CACHE_DECISION,
  DEFAULT_RUNTIME_LIMITS,
  DIRECT_DECISION,
  PRODUCTION_DECODER_SCHEMA_VERSION,
  ProductionDecoderError,
  invariant,
  makePresentationKey,
  validateBoundedInteger,
  validateSourceIdentity,
} from "./contract.mjs";
import { GlobalVideoFrameBudget, ProductionDecoderLane } from "./decoder_lane.mjs";
import { openRemoteDecoderSource } from "./remote_source.mjs";

function normalizeRuntimeLimits(options = {}) {
  const limits = { ...DEFAULT_RUNTIME_LIMITS, ...options };
  return Object.freeze({
    decodeQueueMax: validateBoundedInteger(limits.decodeQueueMax, "decodeQueueMax", 1, 16),
    decodeLeadMax: validateBoundedInteger(limits.decodeLeadMax, "decodeLeadMax", 1, 32),
    readyFramesMax: validateBoundedInteger(limits.readyFramesMax, "readyFramesMax", 0, 16),
    maxWarmAdvanceFrames: validateBoundedInteger(limits.maxWarmAdvanceFrames, "maxWarmAdvanceFrames", 0, 10_000),
    maxTotalLanes: validateBoundedInteger(limits.maxTotalLanes, "maxTotalLanes", 1, 32),
    maxLanesPerSource: validateBoundedInteger(limits.maxLanesPerSource, "maxLanesPerSource", 1, 8),
    idleUnloadFrames: validateBoundedInteger(limits.idleUnloadFrames, "idleUnloadFrames", 0, 1_000_000),
    maximumTargetCacheEntries: validateBoundedInteger(
      limits.maximumTargetCacheEntries, "maximumTargetCacheEntries", 1, 16_384,
    ),
    maximumPacketMetadataEntries: validateBoundedInteger(
      limits.maximumPacketMetadataEntries, "maximumPacketMetadataEntries", 32, 16_384,
    ),
    operationTimeoutMs: validateBoundedInteger(limits.operationTimeoutMs, "operationTimeoutMs", 100, 120_000),
    batchSize: limits.batchSize == null
      ? undefined
      : validateBoundedInteger(limits.batchSize, "batchSize", 1, 32),
  });
}

class LaneSlotAllocator {
  constructor(limits) {
    this.limits = limits;
    this.slots = [];
    this.serial = 0;
    this.currentFrame = null;
    this.frameOpen = false;
    this.metrics = {
      claims: 0,
      sharedClaims: 0,
      newLanes: 0,
      sourceReassignments: 0,
      unloadedIdleLanes: 0,
      allocationFailures: 0,
      peakBoundLanes: 0,
      peakActiveLanes: 0,
    };
  }

  beginFrame(frameIndex) {
    invariant(Number.isSafeInteger(frameIndex) && frameIndex >= 0,
      "INVALID_OUTPUT_FRAME_INDEX", "Output frame index must be a non-negative integer", { frameIndex });
    invariant(!this.frameOpen, "OUTPUT_FRAME_ALREADY_OPEN",
      "Call endOutputFrame() before beginning another output frame", { currentFrame: this.currentFrame });
    this.currentFrame = frameIndex;
    this.frameOpen = true;
    for (const slot of this.slots) {
      slot.activeFrame = null;
      slot.activePresentationKey = null;
      slot.activeClipKeys.clear();
    }
  }

  sourceSlots(sourceIdentity) {
    return this.slots.filter((slot) => slot.sourceIdentity === sourceIdentity);
  }

  mostRecent(slots) {
    return [...slots].sort((left, right) => (
      right.lastUsedFrame - left.lastUsedFrame || left.id.localeCompare(right.id)
    ))[0] ?? null;
  }

  leastRecent(slots) {
    return [...slots].sort((left, right) => (
      left.lastUsedFrame - right.lastUsedFrame || left.id.localeCompare(right.id)
    ))[0] ?? null;
  }

  activate(slot, sourceIdentity, presentationKey, clipKey, reason, previousSourceIdentity = null) {
    slot.activeFrame = this.currentFrame;
    slot.activePresentationKey = presentationKey;
    slot.activeClipKeys.add(clipKey);
    this.metrics.claims += 1;
    if (reason === "same-source-same-presentation") this.metrics.sharedClaims += 1;
    this.metrics.peakBoundLanes = Math.max(
      this.metrics.peakBoundLanes,
      this.slots.filter((candidate) => candidate.sourceIdentity != null).length,
    );
    this.metrics.peakActiveLanes = Math.max(
      this.metrics.peakActiveLanes,
      this.slots.filter((candidate) => candidate.activeFrame === this.currentFrame).length,
    );
    return Object.freeze({
      laneId: slot.id,
      generation: slot.generation,
      sourceIdentity,
      presentationKey,
      clipKey,
      reason,
      shared: reason === "same-source-same-presentation",
      sourceChanged: previousSourceIdentity != null && previousSourceIdentity !== sourceIdentity,
      previousSourceIdentity,
    });
  }

  claim({ sourceIdentity, presentationKey, clipKey }) {
    invariant(this.frameOpen, "OUTPUT_FRAME_NOT_OPEN", "Call beginOutputFrame() before acquireFrame()");
    validateSourceIdentity(sourceIdentity);
    invariant(typeof presentationKey === "string" && presentationKey.length > 0,
      "INVALID_PRESENTATION_KEY", "Presentation key is required");
    invariant(typeof clipKey === "string" && clipKey.length > 0 && clipKey.length <= 512,
      "INVALID_CLIP_KEY", "Clip key must be a non-empty bounded string");
    const shared = this.slots.find((slot) => (
      slot.sourceIdentity === sourceIdentity
      && slot.activeFrame === this.currentFrame
      && slot.activePresentationKey === presentationKey
    ));
    if (shared) return this.activate(shared, sourceIdentity, presentationKey, clipKey,
      "same-source-same-presentation");

    const idleForSource = this.sourceSlots(sourceIdentity)
      .filter((slot) => slot.activeFrame !== this.currentFrame);
    let slot = this.mostRecent(idleForSource.filter((candidate) => candidate.lastClipKeys.has(clipKey)));
    let reason = "clip-continuity";
    if (!slot) {
      slot = this.mostRecent(idleForSource.filter(
        (candidate) => candidate.lastPresentationKey === presentationKey,
      ));
      reason = "cached-presentation";
    }
    if (!slot) {
      slot = this.mostRecent(idleForSource);
      reason = "warm-source-lane";
    }
    if (slot) return this.activate(slot, sourceIdentity, presentationKey, clipKey, reason);

    if (this.sourceSlots(sourceIdentity).length >= this.limits.maxLanesPerSource) {
      this.metrics.allocationFailures += 1;
      throw new ProductionDecoderError("DECODER_LANE_PER_SOURCE_LIMIT",
        "One output frame requires too many distinct PTS values from the same source", {
          outputFrameIndex: this.currentFrame,
          sourceIdentity,
          presentationKey,
          maxLanesPerSource: this.limits.maxLanesPerSource,
        });
    }
    slot = this.slots.find((candidate) => candidate.sourceIdentity == null) ?? null;
    if (!slot && this.slots.length < this.limits.maxTotalLanes) {
      slot = {
        id: `production-decoder-lane-${this.serial++}`,
        generation: 0,
        sourceIdentity: null,
        lastPresentationKey: null,
        lastClipKeys: new Set(),
        lastUsedFrame: Number.NEGATIVE_INFINITY,
        activeFrame: null,
        activePresentationKey: null,
        activeClipKeys: new Set(),
      };
      this.slots.push(slot);
      this.metrics.newLanes += 1;
      reason = "new-lane";
    } else if (!slot) {
      slot = this.leastRecent(this.slots.filter((candidate) => candidate.activeFrame !== this.currentFrame));
      reason = "lru-source-reassignment";
    } else {
      reason = "unloaded-lane-reassignment";
    }
    if (!slot) {
      this.metrics.allocationFailures += 1;
      throw new ProductionDecoderError("DECODER_LANE_GLOBAL_LIMIT",
        "All global decoder lanes are active on distinct presentations in this output frame", {
          outputFrameIndex: this.currentFrame,
          maxTotalLanes: this.limits.maxTotalLanes,
        });
    }
    const previousSourceIdentity = slot.sourceIdentity;
    if (previousSourceIdentity !== sourceIdentity) {
      slot.generation += 1;
      slot.sourceIdentity = sourceIdentity;
      slot.lastPresentationKey = null;
      slot.lastClipKeys.clear();
      if (previousSourceIdentity != null) this.metrics.sourceReassignments += 1;
    }
    return this.activate(
      slot,
      sourceIdentity,
      presentationKey,
      clipKey,
      reason,
      previousSourceIdentity,
    );
  }

  endFrame() {
    invariant(this.frameOpen, "OUTPUT_FRAME_NOT_OPEN", "No output frame is open");
    const unloadLaneIds = [];
    for (const slot of this.slots) {
      if (slot.activeFrame === this.currentFrame) {
        slot.lastPresentationKey = slot.activePresentationKey;
        slot.lastClipKeys = new Set(slot.activeClipKeys);
        slot.lastUsedFrame = this.currentFrame;
        continue;
      }
      if (slot.sourceIdentity == null) continue;
      if (this.currentFrame - slot.lastUsedFrame >= this.limits.idleUnloadFrames) {
        unloadLaneIds.push(slot.id);
        slot.generation += 1;
        slot.sourceIdentity = null;
        slot.lastPresentationKey = null;
        slot.lastClipKeys.clear();
        this.metrics.unloadedIdleLanes += 1;
      }
    }
    for (const slot of this.slots) {
      slot.activeFrame = null;
      slot.activePresentationKey = null;
      slot.activeClipKeys.clear();
    }
    const frameIndex = this.currentFrame;
    this.frameOpen = false;
    return Object.freeze({ frameIndex, unloadLaneIds });
  }

  snapshot() {
    return Object.freeze({
      currentFrame: this.currentFrame,
      frameOpen: this.frameOpen,
      limits: this.limits,
      metrics: Object.freeze({ ...this.metrics }),
      lanes: Object.freeze(this.slots.map((slot) => Object.freeze({
        laneId: slot.id,
        generation: slot.generation,
        sourceIdentity: slot.sourceIdentity,
        lastPresentationKey: slot.lastPresentationKey,
        lastUsedFrame: Number.isFinite(slot.lastUsedFrame) ? slot.lastUsedFrame : null,
      }))),
    });
  }
}

export class ProductionDecoderRuntime {
  constructor({ bridge, limits = {}, videoDecoderFactory = null, encodedChunkFactory = null }) {
    invariant(bridge && typeof bridge === "object", "INVALID_DECODER_BRIDGE",
      "ProductionDecoderRuntime requires a preload-safe decoder bridge");
    this.bridge = bridge;
    this.limits = normalizeRuntimeLimits(limits);
    this.videoDecoderFactory = videoDecoderFactory;
    this.encodedChunkFactory = encodedChunkFactory;
    this.allocator = new LaneSlotAllocator(this.limits);
    const maximumFrames = this.limits.maxTotalLanes * (this.limits.readyFramesMax + 2);
    this.frameBudget = new GlobalVideoFrameBudget(maximumFrames);
    this.sources = new Map();
    this.cacheDecisions = new Map();
    this.lanes = new Map();
    this.framePromises = new Map();
    this.frameOpen = false;
    this.currentFrame = null;
    this.disposed = false;
    this.metrics = {
      sourceOpenRequests: 0,
      directSources: 0,
      cacheRequiredSources: 0,
      outputFrames: 0,
      frameAcquisitions: 0,
      sharedFrameAcquisitions: 0,
      laneCreates: 0,
      laneCloses: 0,
      acquireFailures: 0,
    };
  }

  async openSource(request) {
    invariant(!this.disposed, "DECODER_RUNTIME_DISPOSED", "Production decoder runtime is disposed");
    const sourceIdentity = validateSourceIdentity(request?.sourceIdentity);
    this.metrics.sourceOpenRequests += 1;
    if (this.sources.has(sourceIdentity)) {
      return Object.freeze({ decision: DIRECT_DECISION, reused: true, summary: this.sources.get(sourceIdentity).summary });
    }
    if (this.cacheDecisions.has(sourceIdentity)) return this.cacheDecisions.get(sourceIdentity);
    const opened = await openRemoteDecoderSource(this.bridge, request, this.limits);
    if (opened.decision === CACHE_DECISION) {
      const decision = Object.freeze({ decision: CACHE_DECISION, reused: false, info: opened.info });
      this.cacheDecisions.set(sourceIdentity, decision);
      this.metrics.cacheRequiredSources += 1;
      return decision;
    }
    this.sources.set(sourceIdentity, opened.source);
    this.metrics.directSources += 1;
    return Object.freeze({ decision: DIRECT_DECISION, reused: false, summary: opened.source.summary });
  }

  beginOutputFrame(frameIndex) {
    invariant(!this.disposed, "DECODER_RUNTIME_DISPOSED", "Production decoder runtime is disposed");
    invariant(!this.frameOpen, "OUTPUT_FRAME_ALREADY_OPEN",
      "Call endOutputFrame() before beginning another output frame");
    this.allocator.beginFrame(frameIndex);
    this.frameOpen = true;
    this.currentFrame = frameIndex;
    this.framePromises.clear();
  }

  async laneForAllocation(allocation, source) {
    let laneState = this.lanes.get(allocation.laneId);
    if (laneState && laneState.sourceIdentity !== allocation.sourceIdentity) {
      await laneState.lane.close();
      this.lanes.delete(allocation.laneId);
      this.metrics.laneCloses += 1;
      laneState = null;
    }
    if (!laneState) {
      const lane = new ProductionDecoderLane({
        laneId: allocation.laneId,
        source,
        frameBudget: this.frameBudget,
        limits: this.limits,
        videoDecoderFactory: this.videoDecoderFactory,
        encodedChunkFactory: this.encodedChunkFactory,
      });
      laneState = { lane, sourceIdentity: allocation.sourceIdentity };
      this.lanes.set(allocation.laneId, laneState);
      this.metrics.laneCreates += 1;
    }
    return laneState.lane;
  }

  async acquireFrame({ sourceIdentity, ptsUs, clipKey }) {
    invariant(!this.disposed, "DECODER_RUNTIME_DISPOSED", "Production decoder runtime is disposed");
    invariant(this.frameOpen, "OUTPUT_FRAME_NOT_OPEN", "Call beginOutputFrame() before acquireFrame()");
    validateSourceIdentity(sourceIdentity);
    invariant(Number.isSafeInteger(ptsUs), "INVALID_TARGET_PTS",
      "Exact media PTS must be integer microseconds", { ptsUs });
    const source = this.sources.get(sourceIdentity);
    invariant(source != null, this.cacheDecisions.has(sourceIdentity)
      ? "CANONICAL_CACHE_REQUIRED" : "DECODER_SOURCE_NOT_OPEN",
    this.cacheDecisions.has(sourceIdentity)
      ? "This source must be replaced by its canonical cache before rendering"
      : "Call openSource() and require a direct decision before acquireFrame()", {
      sourceIdentity,
      cacheDecision: this.cacheDecisions.get(sourceIdentity)?.info?.reason?.code ?? null,
    });
    const presentationKey = makePresentationKey(sourceIdentity, ptsUs);
    const allocation = this.allocator.claim({ sourceIdentity, presentationKey, clipKey });
    this.metrics.frameAcquisitions += 1;
    if (allocation.shared) this.metrics.sharedFrameAcquisitions += 1;
    let framePromise = this.framePromises.get(presentationKey);
    if (!framePromise) {
      framePromise = (async () => {
        const lane = await this.laneForAllocation(allocation, source);
        return lane.ensureExactFrame({ ptsUs, presentationKey });
      })();
      this.framePromises.set(presentationKey, framePromise);
    }
    try {
      const held = await framePromise;
      invariant(held?.frame?.timestamp === ptsUs, "RUNTIME_FRAME_PTS_MISMATCH",
        "Production decoder runtime returned the wrong exact PTS");
      return Object.freeze({
        frame: held.frame,
        leaseId: held.leaseId,
        laneId: allocation.laneId,
        sourceIdentity,
        ptsUs,
        presentationKey,
        shared: allocation.shared,
        ownership: "runtime-owned-do-not-close",
      });
    } catch (error) {
      this.metrics.acquireFailures += 1;
      throw error;
    }
  }

  async endOutputFrame() {
    invariant(this.frameOpen, "OUTPUT_FRAME_NOT_OPEN", "No output frame is open");
    const maintenance = this.allocator.endFrame();
    this.frameOpen = false;
    this.currentFrame = null;
    this.framePromises.clear();
    const closeResults = await Promise.allSettled(maintenance.unloadLaneIds.map(async (laneId) => {
      const laneState = this.lanes.get(laneId);
      if (!laneState) return;
      this.lanes.delete(laneId);
      await laneState.lane.close();
      this.metrics.laneCloses += 1;
    }));
    const failures = closeResults.filter((result) => result.status === "rejected");
    invariant(failures.length === 0, "IDLE_LANE_CLEANUP_FAILED",
      "One or more idle decoder lanes could not be closed", { failureCount: failures.length });
    this.metrics.outputFrames += 1;
    return maintenance;
  }

  snapshot() {
    const laneMetrics = [...this.lanes.values()].map((state) => state.lane.snapshot());
    return Object.freeze({
      schemaVersion: PRODUCTION_DECODER_SCHEMA_VERSION,
      ...this.metrics,
      activeSources: this.sources.size,
      canonicalCacheDecisions: this.cacheDecisions.size,
      activeLanes: this.lanes.size,
      currentFrame: this.currentFrame,
      frameOpen: this.frameOpen,
      allocator: this.allocator.snapshot(),
      frameBudget: this.frameBudget.snapshot(),
      sourceMetrics: Object.freeze([...this.sources.values()].map((source) => source.snapshot())),
      laneMetrics: Object.freeze(laneMetrics),
      compact: true,
    });
  }

  getBrokerMetrics() { return this.bridge.decoderStats(); }

  async dispose() {
    if (this.disposed) return;
    if (this.frameOpen) await this.endOutputFrame();
    const laneResults = await Promise.allSettled(
      [...this.lanes.values()].map((state) => state.lane.close()),
    );
    this.lanes.clear();
    const sourceResults = await Promise.allSettled(
      [...this.sources.values()].map((source) => source.dispose()),
    );
    this.sources.clear();
    this.framePromises.clear();
    this.disposed = true;
    const failures = [...laneResults, ...sourceResults].filter((result) => result.status === "rejected");
    invariant(failures.length === 0, "DECODER_RUNTIME_DISPOSE_FAILED",
      "Production decoder runtime did not clean up every lane/source", {
        failureCount: failures.length,
        messages: failures.slice(0, 8).map((result) => result.reason?.message ?? String(result.reason)),
      });
    invariant(this.frameBudget.outstandingFrames === 0, "VIDEOFRAME_LEAK",
      "Production decoder runtime disposed with outstanding VideoFrames", this.frameBudget.snapshot());
  }
}

export function createProductionDecoderRuntime(options) {
  return new ProductionDecoderRuntime(options);
}
