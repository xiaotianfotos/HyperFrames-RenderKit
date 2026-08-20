(function installMediaTimingRuntime(global) {
  "use strict";

  const KIND = "hyperframes-media-timing-plan";
  const SCHEMA_VERSION = 1;
  const expandedPtsByPlan = new WeakMap();

  function parseRatio(value, name = "ratio") {
    const match = String(value ?? "").match(/^(-?\d+)\/(-?\d+)$/);
    if (!match) throw new Error(`${name} must be an integer ratio, got ${value}`);
    const numerator = Number(match[1]);
    const denominator = Number(match[2]);
    if (!Number.isSafeInteger(numerator) || !Number.isSafeInteger(denominator) || denominator === 0) {
      throw new Error(`${name} is not a safe non-zero ratio: ${value}`);
    }
    return { numerator, denominator };
  }

  function ticksToSeconds(ticks, timeBase) {
    const { numerator, denominator } = parseRatio(timeBase, "timeBase");
    return ticks * numerator / denominator;
  }

  function secondsToTicksFloor(seconds, timeBase) {
    if (!Number.isFinite(seconds)) throw new Error(`seconds must be finite, got ${seconds}`);
    const { numerator, denominator } = parseRatio(timeBase, "timeBase");
    const value = seconds * denominator / numerator;
    const tolerance = Math.max(1, Math.abs(value)) * Number.EPSILON * 8;
    return Math.floor(value + tolerance);
  }

  function validatePlan(plan) {
    if (!plan || plan.kind !== KIND || plan.schemaVersion !== SCHEMA_VERSION) {
      throw new Error("Unsupported media timing plan");
    }
    const presentation = plan.presentation;
    if (!presentation || !Number.isSafeInteger(presentation.frameCount)
        || presentation.frameCount < 1) {
      throw new Error("Timing plan has no presentation frames");
    }
    if (!Number.isSafeInteger(presentation.displayEndTicks)
        || presentation.displayEndTicks <= presentation.lastPtsTicks) {
      throw new Error("Timing plan has no valid final display end");
    }
    parseRatio(plan.stream?.timeBase, "plan.stream.timeBase");
    return plan;
  }

  function browserCurrentTimeCompatibility(plan) {
    validatePlan(plan);
    const issues = [];
    if (plan.timeline.presentationOriginTicks !== 0) {
      issues.push(`presentation origin is ${plan.timeline.presentationOriginTicks}, expected 0`);
    }
    if (plan.presentation.firstPtsTicks !== 0) {
      issues.push(`first presentation PTS is ${plan.presentation.firstPtsTicks}, expected 0`);
    }
    if (plan.stream.startPtsTicks !== 0) {
      issues.push(`stream start PTS is ${plan.stream.startPtsTicks}, expected 0`);
    }
    if (!Number.isFinite(plan.stream.startTimeSeconds)
        || Math.abs(plan.stream.startTimeSeconds) > 1e-9) {
      issues.push(`stream start time is ${plan.stream.startTimeSeconds}, expected 0`);
    }
    return {
      compatible: issues.length === 0,
      issues,
      calibrationRequired: true,
      editListDetected: Boolean(plan.timeline.editList?.detected),
      policy: "zero-origin post-demux PTS plus live rVFC calibration",
    };
  }

  function expandPts(plan) {
    const cached = expandedPtsByPlan.get(plan);
    if (cached) return cached;
    const { frameCount, pts } = plan.presentation;
    const expanded = [pts.firstPtsTicks];
    let current = pts.firstPtsTicks;
    if (pts.kind === "delta-rle") {
      for (const [delta, count] of pts.deltaRuns) {
        for (let index = 0; index < count; index += 1) {
          current += delta;
          expanded.push(current);
        }
      }
    } else if (pts.kind === "delta") {
      for (const delta of pts.deltas) {
        current += delta;
        expanded.push(current);
      }
    } else if (pts.kind === "linear") {
      for (let index = 1; index < frameCount; index += 1) {
        expanded.push(pts.firstPtsTicks + index * (pts.stepTicks ?? 0));
      }
    } else {
      throw new Error(`Unsupported PTS encoding: ${pts.kind}`);
    }
    if (expanded.length !== frameCount || expanded.at(-1) !== plan.presentation.lastPtsTicks) {
      throw new Error("Timing plan PTS encoding is inconsistent");
    }
    expandedPtsByPlan.set(plan, expanded);
    return expanded;
  }

  function createQuery(plan) {
    validatePlan(plan);
    const compatibility = browserCurrentTimeCompatibility(plan);
    if (!compatibility.compatible) {
      throw new Error(`Timing plan is not calibrated for browser currentTime: ${compatibility.issues.join("; ")}`);
    }
    const { presentation, stream, source, timeline } = plan;
    const expanded = presentation.pts.kind === "linear" ? null : expandPts(plan);
    const timeBaseSeconds = ticksToSeconds(1, stream.timeBase);
    const minimumPtsToleranceSeconds = Math.max(timeBaseSeconds * 0.51, 1e-6);

    function atIndex(frameIndex, rawTargetSeconds = null) {
      if (!Number.isSafeInteger(frameIndex) || frameIndex < 0 || frameIndex >= presentation.frameCount) {
        throw new Error(`Source frame index is out of range: ${frameIndex}`);
      }
      const ptsTicks = presentation.pts.kind === "linear"
        ? presentation.pts.firstPtsTicks + frameIndex * (presentation.pts.stepTicks ?? 0)
        : expanded[frameIndex];
      const mediaRelativePtsTicks = ptsTicks - timeline.presentationOriginTicks;
      const nextPtsTicks = frameIndex + 1 < presentation.frameCount
        ? (presentation.pts.kind === "linear"
          ? presentation.pts.firstPtsTicks + (frameIndex + 1) * (presentation.pts.stepTicks ?? 0)
          : expanded[frameIndex + 1])
        : presentation.displayEndTicks;
      const intervalSeconds = ticksToSeconds(nextPtsTicks - ptsTicks, stream.timeBase);
      const seekGuardSeconds = Math.max(4e-6, Math.min(timeBaseSeconds * 2, intervalSeconds / 8));
      if (!(intervalSeconds > seekGuardSeconds * 2)) {
        throw new Error(
          `Presentation interval ${intervalSeconds}s is too short for a safe interior seek guard `
          + `${seekGuardSeconds}s at source frame ${frameIndex}`,
        );
      }
      const seekInteriorOffsetSeconds = seekGuardSeconds;
      const ptsToleranceSeconds = Math.min(
        minimumPtsToleranceSeconds,
        intervalSeconds / 4 * 0.99,
      );
      const mediaRelativeSeconds = ticksToSeconds(mediaRelativePtsTicks, stream.timeBase);
      const intervalEndMediaRelativeSeconds = ticksToSeconds(
        nextPtsTicks - timeline.presentationOriginTicks,
        stream.timeBase,
      );
      const seekInteriorSeconds = mediaRelativeSeconds + seekInteriorOffsetSeconds;
      return {
        sourceIdentity: source.identity,
        streamIndex: stream.index,
        sourceFrameIndex: frameIndex,
        frameIndex,
        ptsTicks,
        ptsSeconds: ticksToSeconds(ptsTicks, stream.timeBase),
        mediaRelativePtsTicks,
        mediaRelativeSeconds,
        presentationEndTicks: nextPtsTicks,
        presentationEndSeconds: ticksToSeconds(nextPtsTicks, stream.timeBase),
        intervalEndMediaRelativeSeconds,
        seekInteriorSeconds,
        seekTargetSeconds: seekInteriorSeconds,
        seekInteriorOffsetSeconds,
        seekGuardSeconds,
        timeBaseSeconds,
        rawTargetSeconds,
        rawTargetTicks: rawTargetSeconds == null ? null : secondsToTicksFloor(rawTargetSeconds, stream.timeBase),
        lookup: presentation.pts.kind === "linear"
          ? "cfr-integer-fast-path"
          : "vfr-binary-search",
        isLastFrame: frameIndex === presentation.frameCount - 1,
        displayEndTicks: presentation.displayEndTicks,
        displayEndSeconds: ticksToSeconds(presentation.displayEndTicks, stream.timeBase),
        ptsToleranceSeconds,
      };
    }

    function atOrBefore(rawTargetSeconds, { tailPolicy = "hold-last" } = {}) {
      if (!Number.isFinite(rawTargetSeconds)) {
        throw new Error(`Invalid raw media target: ${rawTargetSeconds}`);
      }
      if (!["hold-last", "transparent", "fail"].includes(tailPolicy)) {
        throw new Error(`Unsupported media tail policy: ${tailPolicy}`);
      }
      const rawTargetTicks = secondsToTicksFloor(rawTargetSeconds, stream.timeBase);
      const targetPtsTicks = timeline.presentationOriginTicks + rawTargetTicks;
      if (targetPtsTicks < presentation.firstPtsTicks) return null;
      const pastDisplayEnd = targetPtsTicks >= presentation.displayEndTicks;
      if (pastDisplayEnd && tailPolicy === "fail") {
        throw new Error(
          `Media target ${rawTargetSeconds}s is past display end `
          + `${ticksToSeconds(presentation.displayEndTicks, stream.timeBase)}s`,
        );
      }
      let frameIndex;
      if (presentation.pts.kind === "linear") {
        frameIndex = presentation.pts.stepTicks == null
          ? 0
          : Math.floor((targetPtsTicks - presentation.pts.firstPtsTicks) / presentation.pts.stepTicks);
        frameIndex = Math.min(presentation.frameCount - 1, frameIndex);
      } else {
        let low = 0;
        let high = expanded.length - 1;
        while (low <= high) {
          const middle = (low + high) >>> 1;
          if (expanded[middle] <= targetPtsTicks) low = middle + 1;
          else high = middle - 1;
        }
        frameIndex = Math.max(0, high);
      }
      return {
        ...atIndex(frameIndex, rawTargetSeconds),
        targetPtsTicks,
        pastDisplayEnd,
        tailAction: pastDisplayEnd ? tailPolicy : "display",
        transparent: pastDisplayEnd && tailPolicy === "transparent",
      };
    }

    return Object.freeze({
      plan,
      compatibility,
      minimumPtsToleranceSeconds,
      atIndex,
      atOrBefore,
    });
  }

  function samePresentationFrame(left, right) {
    return Boolean(left && right
      && left.sourceIdentity === right.sourceIdentity
      && left.streamIndex === right.streamIndex
      && left.ptsTicks === right.ptsTicks);
  }

  function classifyPresentedFrame({
    expected,
    tolerance,
    mediaTime,
    seeking = false,
    paused = false,
    allowOvershoot = false,
  }) {
    const difference = mediaTime - expected;
    // rVFC metadata identifies the frame Chromium actually submitted for
    // presentation. During an exact seek Chromium can invoke rVFC before it
    // clears HTMLMediaElement.seeking. Once the PTS identity matches, waiting
    // for another callback can deadlock because the element is paused.
    if (Math.abs(difference) <= tolerance) {
      return { status: "exact", difference, requestNext: false, play: false };
    }
    if (seeking) return { status: "waiting-for-seek", requestNext: true, play: false };
    if (difference < -tolerance) {
      return {
        status: "stale-before-target",
        difference,
        requestNext: true,
        // A paused decoder cannot produce another callback on its own. Briefly
        // resume it and pause again as soon as the planned PTS is observed.
        play: paused,
      };
    }
    if (allowOvershoot) {
      return { status: "overshot", difference, requestNext: false, play: false };
    }
    return { status: "mismatch-after-target", difference, requestNext: false, play: false };
  }

  function classifyMediaReadiness({ readyState, haveCurrentData, seeking = false, error = null }) {
    if (error) return { status: "error", seeking };
    // A decoded frame is not safe to hand to the next timeline step until the
    // seek that produced it has settled. Chromium may report HAVE_CURRENT_DATA
    // before it clears HTMLMediaElement.seeking.
    if (seeking) return { status: "waiting-for-seeked", seeking };
    if (readyState >= haveCurrentData) return { status: "ready", seeking };
    return { status: "waiting-for-current-data", seeking };
  }

  function classifySeekSettlement({ verifiedCandidate = false, seeking = false, error = null }) {
    if (error) return { status: "error" };
    if (!verifiedCandidate) return { status: "waiting-for-verified-frame" };
    return seeking ? { status: "waiting-for-seeked" } : { status: "settled" };
  }

  function decideTransition(previousState, nextSelection, { clipKey = null } = {}) {
    if (!nextSelection) throw new Error("A timing transition requires a selected source frame");
    if (nextSelection.transparent) {
      return { action: "transparent", sameFrame: samePresentationFrame(previousState?.selection, nextSelection), seekReason: "tail-transparent" };
    }
    if (!previousState?.selection) {
      return { action: "seek", sameFrame: false, seekReason: "initial-or-calibration" };
    }
    if (samePresentationFrame(previousState.selection, nextSelection)) {
      return { action: "reuse", sameFrame: true, seekReason: "same-presentation-pts" };
    }
    const delta = nextSelection.frameIndex - previousState.selection.frameIndex;
    if (previousState.clipKey != null && clipKey != null && previousState.clipKey !== clipKey) {
      return { action: "seek", sameFrame: false, seekReason: "clip-cut" };
    }
    if (delta === 1) {
      return { action: "advance", sameFrame: false, seekReason: "sequential-next-presentation" };
    }
    if (delta < 0) {
      return { action: "seek", sameFrame: false, seekReason: "backward-presentation-jump" };
    }
    return { action: "seek", sameFrame: false, seekReason: "nonsequential-presentation-jump" };
  }

  global.HyperframesMediaTiming = Object.freeze({
    KIND,
    SCHEMA_VERSION,
    browserCurrentTimeCompatibility,
    classifyPresentedFrame,
    classifyMediaReadiness,
    classifySeekSettlement,
    createQuery,
    decideTransition,
    samePresentationFrame,
    ticksToSeconds,
  });
})(globalThis);
