const DEFAULT_TOLERANCE_SECONDS = 0.001;

function assertFinite(value, name) {
  if (!Number.isFinite(value)) throw new Error(`${name} must be finite, got ${value}`);
  return value;
}

function lowerBoundAtOrBefore(values, target) {
  let low = 0;
  let high = values.length - 1;
  while (low <= high) {
    const middle = (low + high) >>> 1;
    if (values[middle] <= target) low = middle + 1;
    else high = middle - 1;
  }
  return high;
}

export function nearestPresentationFrame(ptsSeconds, sourceTimeSeconds) {
  if (!Array.isArray(ptsSeconds) || !ptsSeconds.length) {
    throw new Error("ptsSeconds must contain at least one presentation timestamp");
  }
  assertFinite(sourceTimeSeconds, "sourceTimeSeconds");
  const before = lowerBoundAtOrBefore(ptsSeconds, sourceTimeSeconds);
  if (before < 0) {
    return { frameIndex: 0, ptsSeconds: ptsSeconds[0], residualSeconds: ptsSeconds[0] - sourceTimeSeconds };
  }
  if (before === ptsSeconds.length - 1) {
    return {
      frameIndex: before,
      ptsSeconds: ptsSeconds[before],
      residualSeconds: ptsSeconds[before] - sourceTimeSeconds,
    };
  }
  const after = before + 1;
  const beforeResidual = ptsSeconds[before] - sourceTimeSeconds;
  const afterResidual = ptsSeconds[after] - sourceTimeSeconds;
  return Math.abs(beforeResidual) <= Math.abs(afterResidual)
    ? { frameIndex: before, ptsSeconds: ptsSeconds[before], residualSeconds: beforeResidual }
    : { frameIndex: after, ptsSeconds: ptsSeconds[after], residualSeconds: afterResidual };
}

export function presentationFrameAtOrBefore(ptsSeconds, sourceTimeSeconds) {
  if (!Array.isArray(ptsSeconds) || !ptsSeconds.length) {
    throw new Error("ptsSeconds must contain at least one presentation timestamp");
  }
  assertFinite(sourceTimeSeconds, "sourceTimeSeconds");
  const frameIndex = lowerBoundAtOrBefore(ptsSeconds, sourceTimeSeconds);
  if (frameIndex < 0) return null;
  return { frameIndex, ptsSeconds: ptsSeconds[frameIndex] };
}

export function seekInteriorSeconds({
  ptsSeconds,
  frameIndex,
  timeBaseSeconds,
  displayEndSeconds,
  browserEndSourceSeconds = Number.POSITIVE_INFINITY,
  sourceToBrowserOffsetSeconds = 0,
  minimumGuardSeconds = 4e-6,
}) {
  if (!Array.isArray(ptsSeconds) || !Number.isInteger(frameIndex)
      || frameIndex < 0 || frameIndex >= ptsSeconds.length) {
    throw new Error("seekInteriorSeconds requires an in-range frameIndex");
  }
  const lower = ptsSeconds[frameIndex];
  const nominalUpper = frameIndex + 1 < ptsSeconds.length
    ? ptsSeconds[frameIndex + 1]
    : displayEndSeconds;
  const upper = Math.min(nominalUpper, browserEndSourceSeconds);
  const span = upper - lower;
  const tickGuard = Number.isFinite(timeBaseSeconds) && timeBaseSeconds > 0
    ? Math.min(timeBaseSeconds * 2, span / 8)
    : 0;
  const guardSeconds = Math.max(minimumGuardSeconds, tickGuard);
  if (!(span > guardSeconds * 2)) {
    return {
      safe: false,
      frameIndex,
      lowerSeconds: lower,
      upperSeconds: upper,
      spanSeconds: span,
      guardSeconds,
      reason: "no-provable-interior-after-browser-end-and-timestamp-guard",
    };
  }
  const sourceTargetSeconds = lower + guardSeconds;
  return {
    safe: true,
    frameIndex,
    lowerSeconds: lower,
    upperSeconds: upper,
    spanSeconds: span,
    guardSeconds,
    sourceTargetSeconds,
    browserTargetSeconds: sourceTargetSeconds - sourceToBrowserOffsetSeconds,
  };
}

function uniqueFinite(values) {
  const unique = [];
  for (const value of values) {
    if (!Number.isFinite(value)) continue;
    if (!unique.some((prior) => Math.abs(prior - value) < 1e-9)) unique.push(value);
  }
  return unique;
}

function candidateOffsets({ plan, browser, observations }) {
  const firstPts = plan.presentation.firstPtsSeconds;
  const streamStart = plan.stream.startTimeSeconds;
  const seekableStart = Number.isFinite(browser.effectiveMediaStart)
    ? browser.effectiveMediaStart
    : browser.seekable?.[0]?.start;
  const base = [
    { name: "post-demux-absolute", offsetSeconds: 0 },
    { name: "first-presentation-relative", offsetSeconds: firstPts },
    { name: "stream-start-relative", offsetSeconds: streamStart },
    {
      name: "seekable-start-aligned",
      offsetSeconds: Number.isFinite(seekableStart) ? firstPts - seekableStart : null,
    },
  ];

  // Observation-derived offsets are diagnostic candidates, not sufficient
  // proof on their own. The seek-at-or-before rule below prevents choosing a
  // neighbouring CFR frame merely because it also forms a clean affine grid.
  const pts = plan.presentation.ptsSeconds;
  const observedMediaTimes = observations
    .map((row) => row?.mediaTime)
    .filter(Number.isFinite);
  for (const mediaTime of observedMediaTimes.slice(0, 24)) {
    const approximateSource = mediaTime + firstPts;
    const nearest = nearestPresentationFrame(pts, approximateSource);
    base.push({ name: "observation-derived", offsetSeconds: nearest.ptsSeconds - mediaTime });
  }

  const offsets = uniqueFinite(base.map((entry) => entry.offsetSeconds));
  return offsets.map((offsetSeconds) => ({
    offsetSeconds,
    names: base
      .filter((entry) => Number.isFinite(entry.offsetSeconds)
        && Math.abs(entry.offsetSeconds - offsetSeconds) < 1e-9)
      .map((entry) => entry.name),
  }));
}

function scoreOffset(plan, observations, offsetSeconds, toleranceSeconds) {
  const pts = plan.presentation.ptsSeconds;
  let maxTimestampResidualSeconds = 0;
  let timestampMismatchCount = 0;
  let seekFrameMismatchCount = 0;
  let seekOvershootCount = 0;
  let mappedCount = 0;
  const mapped = [];

  for (const observation of observations) {
    if (!Number.isFinite(observation?.mediaTime)) continue;
    mappedCount += 1;
    const sourceTime = observation.mediaTime + offsetSeconds;
    const nearest = nearestPresentationFrame(pts, sourceTime);
    const residual = Math.abs(nearest.residualSeconds);
    maxTimestampResidualSeconds = Math.max(maxTimestampResidualSeconds, residual);
    if (residual > toleranceSeconds) timestampMismatchCount += 1;

    let expected = null;
    let seekFrameMatches = null;
    let overshot = null;
    if (observation.kind === "seek"
        && observation.seekPolicy !== "boundary-diagnostic"
        && Number.isFinite(observation.requestedTime)) {
      expected = presentationFrameAtOrBefore(pts, observation.requestedTime + offsetSeconds);
      seekFrameMatches = expected?.frameIndex === nearest.frameIndex;
      if (!seekFrameMatches) seekFrameMismatchCount += 1;
      overshot = nearest.ptsSeconds > observation.requestedTime + offsetSeconds + toleranceSeconds;
      if (overshot) seekOvershootCount += 1;
    }
    mapped.push({
      kind: observation.kind,
      label: observation.label,
      requestedTime: observation.requestedTime ?? null,
      mediaTime: observation.mediaTime,
      sourceTime,
      frameIndex: nearest.frameIndex,
      ptsSeconds: nearest.ptsSeconds,
      timestampResidualSeconds: nearest.residualSeconds,
      expectedFrameIndex: expected?.frameIndex ?? null,
      seekFrameMatches,
      overshot,
    });
  }

  return {
    offsetSeconds,
    mappedCount,
    timestampMismatchCount,
    seekFrameMismatchCount,
    seekOvershootCount,
    maxTimestampResidualSeconds,
    mapped,
  };
}

export function inferBrowserTimelineMapping({
  plan,
  browser,
  observations,
  toleranceSeconds = DEFAULT_TOLERANCE_SECONDS,
}) {
  if (!Array.isArray(plan?.presentation?.ptsSeconds) || !plan.presentation.ptsSeconds.length) {
    throw new Error("plan.presentation.ptsSeconds is required");
  }
  const candidates = candidateOffsets({ plan, browser, observations }).map((candidate) => ({
    ...candidate,
    ...scoreOffset(plan, observations, candidate.offsetSeconds, toleranceSeconds),
  }));
  candidates.sort((left, right) => (
    left.seekOvershootCount - right.seekOvershootCount
    || left.seekFrameMismatchCount - right.seekFrameMismatchCount
    || left.timestampMismatchCount - right.timestampMismatchCount
    || left.maxTimestampResidualSeconds - right.maxTimestampResidualSeconds
    || Math.abs(left.offsetSeconds) - Math.abs(right.offsetSeconds)
  ));
  const selected = candidates[0] ?? null;
  const selectedPasses = Boolean(selected
    && selected.mappedCount > 0
    && selected.timestampMismatchCount === 0
    && selected.seekFrameMismatchCount === 0
    && selected.seekOvershootCount === 0);
  const canonicalNames = new Set([
    "post-demux-absolute",
    "first-presentation-relative",
    "stream-start-relative",
    "seekable-start-aligned",
  ]);
  const competingCanonical = candidates.find((candidate) => (
    candidate !== selected
    && candidate.names.some((name) => canonicalNames.has(name))
    && candidate.timestampMismatchCount === selected?.timestampMismatchCount
    && candidate.seekFrameMismatchCount === selected?.seekFrameMismatchCount
    && candidate.seekOvershootCount === selected?.seekOvershootCount
    && Math.abs(candidate.maxTimestampResidualSeconds - selected.maxTimestampResidualSeconds)
      <= toleranceSeconds / 10
    && Math.abs(candidate.offsetSeconds - selected.offsetSeconds) > toleranceSeconds
  ));
  // A CFR grid can always manufacture observation-derived alternatives shifted
  // by one whole frame. Only distinct, independently anchored timeline models
  // count as genuine ambiguity.
  const ambiguous = Boolean(selectedPasses && competingCanonical);
  return { toleranceSeconds, selectedPasses, ambiguous, selected, candidates };
}

function gate(id, pass, detail, severity = "hard") {
  return { id, pass: Boolean(pass), severity, detail };
}

export function evaluateMediaTimeDomainProbe({ plan, browser, observations, errors = [] }) {
  const pts = plan.presentation.ptsSeconds;
  const timeBaseSeconds = Number(plan.stream.timeBaseSeconds);
  const toleranceSeconds = Math.max(
    DEFAULT_TOLERANCE_SECONDS,
    Number.isFinite(timeBaseSeconds) ? timeBaseSeconds * 2 : 0,
  );
  const successful = observations.filter((row) => Number.isFinite(row?.mediaTime));
  const mapping = inferBrowserTimelineMapping({ plan, browser, observations: successful, toleranceSeconds });
  const sequential = successful.filter((row) => row.kind === "sequential");
  const seeks = successful.filter((row) => row.kind === "seek"
    && row.seekPolicy !== "boundary-diagnostic");
  const boundarySeeks = successful.filter((row) => row.kind === "seek"
    && row.seekPolicy === "boundary-diagnostic");
  const tail = successful.filter((row) => row.kind === "tail");
  const presentedFramesValid = successful.every((row) => Number.isFinite(row.presentedFrames));
  const sequentialMonotonic = sequential.every((row, index) => (
    index === 0 || row.mediaTime > sequential[index - 1].mediaTime
  ));
  const callbackSkips = successful.reduce((count, row) => (
    count + (Number.isFinite(row.presentedFramesDelta) && row.presentedFramesDelta > 1 ? 1 : 0)
  ), 0);
  const selectedMapped = mapping.selected?.mapped ?? [];
  const tailMapped = selectedMapped.filter((row) => row.kind === "tail");
  const lastPts = plan.presentation.lastPtsSeconds;
  const tailShowsLastFrame = tailMapped.some((row) => (
    Math.abs(row.ptsSeconds - lastPts) <= toleranceSeconds
  ));
  const nonZeroOrigin = Math.abs(plan.presentation.firstPtsSeconds) > toleranceSeconds;

  const gates = [
    gate("rvfc-supported", browser.rvfcSupported, "requestVideoFrameCallback must exist"),
    gate("probe-completed", errors.length === 0, errors.length ? errors : "no browser probe errors"),
    gate("pts-affine-map", mapping.selectedPasses,
      mapping.selected
        ? `offset=${mapping.selected.offsetSeconds}s maxResidual=${mapping.selected.maxTimestampResidualSeconds}s`
        : "no mapping candidate"),
    gate("nonzero-origin-unambiguous", !nonZeroOrigin || !mapping.ambiguous,
      nonZeroOrigin ? `mapping ambiguous=${mapping.ambiguous}` : "source begins at zero"),
    gate("seek-current-frame", seeks.length > 0
      && (mapping.selected?.seekFrameMismatchCount ?? Infinity) === 0,
    `${seeks.length} seek observations; browser-presented frame must equal greatest PTS <= target`),
    gate("seek-no-overshoot", seeks.length > 0
      && (mapping.selected?.seekOvershootCount ?? Infinity) === 0,
    "a callback later than the requested presentation frame must never be silently accepted"),
    gate("sequential-monotonic", sequential.length >= 2 && sequentialMonotonic,
      `${sequential.length} sequential observations`),
    gate("presented-frames-observable", presentedFramesValid,
      `${callbackSkips} callback gaps detected; gaps are allowed only when inspected`, "hard"),
    gate("tail-last-frame", tail.length > 0 && tailShowsLastFrame,
      `last PTS=${lastPts}; tail observations=${tail.length}`),
    gate("exact-pts-boundary-is-diagnostic", true,
      `${boundarySeeks.length} exact-boundary observations; a prior frame here requires an interior seek bias and revalidation`,
    "policy"),
    gate("browser-duration-is-not-tail-authority", true,
      `hold boundary comes from lastPts + lastFrameDuration (${plan.presentation.displayEndSeconds}s), not video.duration`,
    "policy"),
    gate("current-time-is-not-frame-authority", true,
      "currentTime is diagnostic only; frame acceptance uses rVFC mediaTime", "policy"),
  ];
  return {
    toleranceSeconds,
    mapping,
    callbackSkips,
    gates,
    pass: gates.filter((item) => item.severity === "hard").every((item) => item.pass),
  };
}
