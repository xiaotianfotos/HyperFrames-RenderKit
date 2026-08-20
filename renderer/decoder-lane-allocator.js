(function installHyperframesDecoderLaneAllocator(global) {
  "use strict";

  const KIND = "hyperframes-decoder-lane-allocator";
  const SCHEMA_VERSION = 1;

  class DecoderLaneAllocationError extends Error {
    constructor(code, message, details = {}) {
      super(message);
      this.name = "DecoderLaneAllocationError";
      this.code = code;
      this.blocker = true;
      this.details = details;
    }
  }

  function positiveInteger(value, name) {
    if (!Number.isSafeInteger(value) || value < 1) {
      throw new Error(`${name} must be a positive integer, received ${value}`);
    }
    return value;
  }

  function nonNegativeInteger(value, name) {
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new Error(`${name} must be a non-negative integer, received ${value}`);
    }
    return value;
  }

  function requiredKey(value, name) {
    const key = String(value ?? "").trim();
    if (!key) throw new Error(`${name} must be a non-empty string`);
    return key;
  }

  function createDecoderLaneAllocator({
    maxTotalLanes = 12,
    maxLanesPerSource = 2,
    idleUnloadFrames = 120,
  } = {}) {
    const limits = Object.freeze({
      maxTotalLanes: positiveInteger(maxTotalLanes, "maxTotalLanes"),
      maxLanesPerSource: positiveInteger(maxLanesPerSource, "maxLanesPerSource"),
      idleUnloadFrames: nonNegativeInteger(idleUnloadFrames, "idleUnloadFrames"),
    });
    let currentFrame = null;
    let frameOpen = false;
    let serial = 0;
    const lanes = [];
    const stats = {
      claims: 0,
      sharedClaims: 0,
      clipContinuityClaims: 0,
      presentationReuseClaims: 0,
      warmSourceReuseClaims: 0,
      createdLanes: 0,
      sourceReassignments: 0,
      pausedIdleLanes: 0,
      unloadedIdleLanes: 0,
      allocationFailures: 0,
      peakBoundLanes: 0,
      peakActiveLanes: 0,
      peakActiveBySource: {},
    };

    function laneView(lane) {
      return Object.freeze({
        id: lane.id,
        generation: lane.generation,
        sourceKey: lane.sourceKey,
        lastPresentationKey: lane.lastPresentationKey,
        lastClipKeys: [...lane.lastClipKeys],
        lastUsedFrame: lane.lastUsedFrame,
        activeFrame: lane.activeFrame,
        activePresentationKey: lane.activePresentationKey,
        activeClipKeys: [...lane.activeClipKeys],
        idlePaused: lane.idlePaused,
      });
    }

    function updatePeaks() {
      const bound = lanes.filter((lane) => lane.sourceKey != null).length;
      const active = lanes.filter((lane) => lane.activeFrame === currentFrame).length;
      stats.peakBoundLanes = Math.max(stats.peakBoundLanes, bound);
      stats.peakActiveLanes = Math.max(stats.peakActiveLanes, active);
      const activeBySource = new Map();
      for (const lane of lanes) {
        if (lane.activeFrame !== currentFrame || lane.sourceKey == null) continue;
        activeBySource.set(lane.sourceKey, (activeBySource.get(lane.sourceKey) ?? 0) + 1);
      }
      for (const [sourceKey, count] of activeBySource) {
        stats.peakActiveBySource[sourceKey] = Math.max(stats.peakActiveBySource[sourceKey] ?? 0, count);
      }
    }

    function beginFrame(frameIndex) {
      nonNegativeInteger(frameIndex, "frameIndex");
      if (frameOpen) {
        throw new Error(`Decoder lane frame ${currentFrame} is still open; call endFrame() before ${frameIndex}`);
      }
      currentFrame = frameIndex;
      frameOpen = true;
      for (const lane of lanes) {
        lane.activeFrame = null;
        lane.activePresentationKey = null;
        lane.activeClipKeys.clear();
      }
      return snapshot();
    }

    function sourceLanes(sourceKey) {
      return lanes.filter((lane) => lane.sourceKey === sourceKey);
    }

    function mostRecentlyUsed(candidates) {
      return [...candidates].sort((left, right) => (
        right.lastUsedFrame - left.lastUsedFrame
        || right.generation - left.generation
        || left.id.localeCompare(right.id)
      ))[0] ?? null;
    }

    function leastRecentlyUsed(candidates) {
      return [...candidates].sort((left, right) => (
        left.lastUsedFrame - right.lastUsedFrame
        || left.generation - right.generation
        || left.id.localeCompare(right.id)
      ))[0] ?? null;
    }

    function bindLane(lane, sourceKey) {
      const previousSourceKey = lane.sourceKey;
      const sourceChanged = previousSourceKey !== sourceKey;
      if (sourceChanged) {
        lane.generation += 1;
        lane.sourceKey = sourceKey;
        lane.lastPresentationKey = null;
        lane.lastClipKeys.clear();
        lane.idlePaused = false;
        if (previousSourceKey != null) stats.sourceReassignments += 1;
      }
      return { sourceChanged, previousSourceKey };
    }

    function activateLane(lane, sourceKey, presentationKey, clipKey, reason, binding = {}) {
      lane.activeFrame = currentFrame;
      lane.activePresentationKey = presentationKey;
      lane.activeClipKeys.add(clipKey);
      // The next inactive frame is a new active -> idle transition and may
      // need one defensive pause action. Do not emit that action repeatedly
      // throughout the whole idle interval.
      lane.idlePaused = false;
      stats.claims += 1;
      if (reason === "same-source-same-presentation") stats.sharedClaims += 1;
      if (reason === "clip-continuity") stats.clipContinuityClaims += 1;
      if (reason === "cached-presentation") stats.presentationReuseClaims += 1;
      if (reason === "warm-source-lane") stats.warmSourceReuseClaims += 1;
      updatePeaks();
      return Object.freeze({
        lane: laneView(lane),
        laneId: lane.id,
        generation: lane.generation,
        sourceKey,
        presentationKey,
        clipKey,
        reason,
        shared: reason === "same-source-same-presentation",
        sourceChanged: Boolean(binding.sourceChanged),
        previousSourceKey: binding.previousSourceKey ?? null,
      });
    }

    function allocationFailure(code, message, details) {
      stats.allocationFailures += 1;
      throw new DecoderLaneAllocationError(code, message, details);
    }

    function claim({ sourceKey, presentationKey, clipKey }) {
      if (!frameOpen) throw new Error("beginFrame() must be called before claiming a decoder lane");
      const normalizedSource = requiredKey(sourceKey, "sourceKey");
      const normalizedPresentation = requiredKey(presentationKey, "presentationKey");
      const normalizedClip = requiredKey(clipKey, "clipKey");

      const activeShared = lanes.find((lane) => (
        lane.sourceKey === normalizedSource
        && lane.activeFrame === currentFrame
        && lane.activePresentationKey === normalizedPresentation
      ));
      if (activeShared) {
        return activateLane(
          activeShared,
          normalizedSource,
          normalizedPresentation,
          normalizedClip,
          "same-source-same-presentation",
        );
      }

      const idleForSource = sourceLanes(normalizedSource)
        .filter((lane) => lane.activeFrame !== currentFrame);
      let lane = mostRecentlyUsed(idleForSource.filter((candidate) => candidate.lastClipKeys.has(normalizedClip)));
      let reason = "clip-continuity";
      if (!lane) {
        lane = mostRecentlyUsed(idleForSource.filter(
          (candidate) => candidate.lastPresentationKey === normalizedPresentation,
        ));
        reason = "cached-presentation";
      }
      if (!lane) {
        lane = mostRecentlyUsed(idleForSource);
        reason = "warm-source-lane";
      }
      if (lane) {
        return activateLane(lane, normalizedSource, normalizedPresentation, normalizedClip, reason);
      }

      const boundForSource = sourceLanes(normalizedSource).length;
      if (boundForSource >= limits.maxLanesPerSource) {
        const active = sourceLanes(normalizedSource)
          .filter((candidate) => candidate.activeFrame === currentFrame)
          .map((candidate) => ({
            laneId: candidate.id,
            presentationKey: candidate.activePresentationKey,
            clipKeys: [...candidate.activeClipKeys],
          }));
        allocationFailure(
          "decoder-lane-per-source-limit",
          `Decoder lane blocker: source ${normalizedSource} needs more than `
          + `${limits.maxLanesPerSource} simultaneous presentation PTS values in output frame ${currentFrame}. `
          + `Requested ${normalizedPresentation} for ${normalizedClip}; active=${JSON.stringify(active)}. `
          + "Increase --mediaDecoderLanesPerSource or remove divergent same-frame media times.",
          {
            frameIndex: currentFrame,
            sourceKey: normalizedSource,
            presentationKey: normalizedPresentation,
            clipKey: normalizedClip,
            maxLanesPerSource: limits.maxLanesPerSource,
            active,
          },
        );
      }

      lane = lanes.find((candidate) => candidate.sourceKey == null && candidate.activeFrame !== currentFrame) ?? null;
      let binding;
      if (!lane && lanes.length < limits.maxTotalLanes) {
        lane = {
          id: `decoder-lane-${serial++}`,
          generation: 0,
          sourceKey: null,
          lastPresentationKey: null,
          lastClipKeys: new Set(),
          lastUsedFrame: Number.NEGATIVE_INFINITY,
          activeFrame: null,
          activePresentationKey: null,
          activeClipKeys: new Set(),
          idlePaused: false,
        };
        lanes.push(lane);
        stats.createdLanes += 1;
        reason = "new-lane";
      } else if (!lane) {
        lane = leastRecentlyUsed(lanes.filter((candidate) => candidate.activeFrame !== currentFrame));
        reason = "lru-source-reassignment";
      } else {
        reason = "unloaded-lane-reassignment";
      }
      if (!lane) {
        const active = lanes
          .filter((candidate) => candidate.activeFrame === currentFrame)
          .map((candidate) => ({
            laneId: candidate.id,
            sourceKey: candidate.sourceKey,
            presentationKey: candidate.activePresentationKey,
            clipKeys: [...candidate.activeClipKeys],
          }));
        allocationFailure(
          "decoder-lane-global-limit",
          `Decoder lane blocker: all ${limits.maxTotalLanes} global decoder lanes are active in `
          + `output frame ${currentFrame}. Requested ${normalizedSource} ${normalizedPresentation} for `
          + `${normalizedClip}; active=${JSON.stringify(active)}. Increase --mediaDecoderLanesTotal or `
          + "reduce simultaneous distinct video presentations.",
          {
            frameIndex: currentFrame,
            sourceKey: normalizedSource,
            presentationKey: normalizedPresentation,
            clipKey: normalizedClip,
            maxTotalLanes: limits.maxTotalLanes,
            active,
          },
        );
      }
      binding = bindLane(lane, normalizedSource);
      return activateLane(
        lane,
        normalizedSource,
        normalizedPresentation,
        normalizedClip,
        reason,
        binding,
      );
    }

    function endFrame() {
      if (!frameOpen) throw new Error("beginFrame() must be called before endFrame()");
      const usedLaneIds = new Set();
      for (const lane of lanes) {
        if (lane.activeFrame !== currentFrame) continue;
        usedLaneIds.add(lane.id);
        lane.lastPresentationKey = lane.activePresentationKey;
        lane.lastClipKeys = new Set(lane.activeClipKeys);
        lane.lastUsedFrame = currentFrame;
      }
      const unloadLaneIds = [];
      const pauseLaneIds = [];
      for (const lane of lanes) {
        if (usedLaneIds.has(lane.id) || lane.sourceKey == null) continue;
        const idleFrames = currentFrame - lane.lastUsedFrame;
        if (idleFrames >= limits.idleUnloadFrames) {
          unloadLaneIds.push(lane.id);
          lane.generation += 1;
          lane.sourceKey = null;
          lane.lastPresentationKey = null;
          lane.lastClipKeys.clear();
          lane.idlePaused = false;
          stats.unloadedIdleLanes += 1;
        } else if (!lane.idlePaused) {
          pauseLaneIds.push(lane.id);
          lane.idlePaused = true;
          stats.pausedIdleLanes += 1;
        }
      }
      for (const lane of lanes) {
        lane.activeFrame = null;
        lane.activePresentationKey = null;
        lane.activeClipKeys.clear();
      }
      frameOpen = false;
      updatePeaks();
      return Object.freeze({
        frameIndex: currentFrame,
        usedLaneIds: [...usedLaneIds],
        pauseLaneIds,
        unloadLaneIds,
      });
    }

    function snapshot() {
      return Object.freeze({
        kind: KIND,
        schemaVersion: SCHEMA_VERSION,
        limits,
        currentFrame,
        frameOpen,
        lanes: lanes.map(laneView),
        stats: Object.freeze({
          ...stats,
          peakActiveBySource: Object.freeze({ ...stats.peakActiveBySource }),
        }),
      });
    }

    return Object.freeze({ beginFrame, claim, endFrame, snapshot });
  }

  global.HyperframesDecoderLanes = Object.freeze({
    KIND,
    SCHEMA_VERSION,
    DecoderLaneAllocationError,
    createDecoderLaneAllocator,
  });
})(globalThis);
