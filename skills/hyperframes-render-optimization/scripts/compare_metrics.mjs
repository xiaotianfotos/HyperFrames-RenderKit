#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { basename, dirname, extname, isAbsolute } from "node:path";

const rawArgs = process.argv.slice(2);
const strict = rawArgs.includes("--strict");
const files = rawArgs.filter((argument) => argument !== "--strict");
if (files.length < 2) {
  console.error("Usage: compare_metrics.mjs [--strict] baseline.metrics.json candidate.metrics.json [more.json ...]");
  process.exit(2);
}

const STRICT_VIDEO_CODEC = "h264";
const STRICT_PIXEL_FORMAT = "yuv420p";
const STRICT_AUDIO_CODEC = "pcm_s24le";
const STRICT_AUDIO_CHANNELS = 2;
const STRICT_AUDIO_LAYOUT = "stereo";
const STRICT_PRODUCTION_ROUTE = "direct-h264-avc1";
const STRICT_SCREENSHOT_ENCODERS = new Set(["vaapi", "videotoolbox", "nvenc"]);
const STRICT_SCREENSHOT_MEDIA_POLICIES = new Set(["faithful", "bounded-static"]);
const PRODUCTION_EVIDENCE_SCHEMA_VERSION = "1.0.0";
const ATOMIC_COMMIT_SCHEMA_VERSION = "1.0.0";
const PROBE_TIME_TOLERANCE_SECONDS = 0.000_001;
const ZERO_ANTI_EVIDENCE_COUNTERS = new Set([
  "cacheRequiredSources", "canonicalCacheDecisions", "canonicalCacheRequired", "acquireFailures",
  "validationFailures", "exactPtsFailures", "unexpectedOutputs", "duplicateOutputs", "fallbackFrames",
  "htmlVideoFallbacks", "protocolErrors", "allocationFailures",
]);
const FINAL_RESOURCE_ZERO_FIELDS = new Set([
  "finalActiveUrls", "finalActiveLeases", "pendingPayloadBytes", "outstandingFrames", "activeLeases",
  "waitingReservations", "currentBytes", "activeSources", "activeLanes", "activeCursors", "pendingBegins",
  "activeReads", "pendingCleanup",
]);
const CONTROL_STATE_VALUES = {
  status: new Set(["ok", "pass", "passed", "accepted", "success", "successful", "healthy", "ready", "complete", "completed", "closed", "disposed", "active", "inactive"]),
  state: new Set(["ready", "active", "inactive", "open", "closed", "disposed", "idle", "running", "complete", "completed", "healthy"]),
  result: new Set(["ok", "pass", "passed", "accepted", "success", "successful", "complete", "completed", STRICT_PRODUCTION_ROUTE]),
  mode: new Set(["full", "bounded", "bounded-static", "head-tail", "retained", "sequential", "exact", "timing-plan", "playback-step", "direct", "hardware", "cold", "warm", "benchmark", "throughput", "latency", "diagnostic"]),
  decision: new Set([STRICT_PRODUCTION_ROUTE, "faithful-screenshot", "faithful", "bounded-static", "accepted"]),
};
const FORBIDDEN_CONTROL_VALUE = /error|fail(?:ed|ure)?|fallback|emergency|cache[-_ ]?required|canonical[-_ ]cache|software[-_ ]route/i;
const NON_CONTROL_EVIDENCE_SUBTREE = /(?:^|[.[])(?:performance|benchmark|timing|telemetry|aggregates)(?:[.[]|$)/i;

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function owns(object, key) {
  return isObject(object) && Object.prototype.hasOwnProperty.call(object, key);
}

function numeric(value) {
  if (typeof value === "boolean" || value === null || value === undefined || value === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function jsonSafeInteger(value, { minimum = 0 } = {}) {
  return typeof value === "number"
    && Number.isFinite(value)
    && Number.isSafeInteger(value)
    && value >= minimum
    ? value
    : null;
}

function ratio(value) {
  if (typeof value === "number") return Number.isFinite(value) && value > 0 ? value : null;
  const match = String(value ?? "").match(/^(-?\d+(?:\.\d+)?)\s*\/\s*(-?\d+(?:\.\d+)?)$/);
  if (match && Number(match[2]) !== 0) {
    const valueAsRatio = Number(match[1]) / Number(match[2]);
    return Number.isFinite(valueAsRatio) && valueAsRatio > 0 ? valueAsRatio : null;
  }
  const parsed = numeric(value);
  return parsed != null && parsed > 0 ? parsed : null;
}

function format(value, digits = 2) {
  return value == null || !Number.isFinite(Number(value)) ? "?" : Number(value).toFixed(digits);
}

function field(label, object, key, { allowNumericString = false } = {}) {
  return { label, present: owns(object, key), value: object?.[key], allowNumericString };
}

function numberEvidence(candidates, { integer = false, minimum = null } = {}) {
  const present = candidates.filter((candidate) => candidate.present);
  if (present.length === 0) return { known: false, value: null, reason: "missing" };
  const parsed = present.map((candidate) => ({
    ...candidate,
    parsed: candidate.allowNumericString
      ? numeric(candidate.value)
      : (typeof candidate.value === "number" && Number.isFinite(candidate.value) ? candidate.value : null),
  }));
  const invalid = parsed.filter((candidate) => candidate.parsed == null
    || (integer && !Number.isSafeInteger(candidate.parsed))
    || (minimum != null && candidate.parsed < minimum));
  if (invalid.length) {
    return {
      known: false,
      value: null,
      reason: `invalid ${invalid.map((candidate) => candidate.label).join(", ")}`,
    };
  }
  const first = parsed[0].parsed;
  if (parsed.some((candidate) => candidate.parsed !== first)) {
    return {
      known: false,
      value: null,
      reason: `disagreement ${parsed.map((candidate) => `${candidate.label}=${candidate.parsed}`).join(", ")}`,
    };
  }
  return { known: true, value: first, reason: null };
}

function videoStream(item) {
  return Array.isArray(item.probe?.streams)
    ? item.probe.streams.find((stream) => stream?.codec_type === "video") ?? null
    : null;
}

function audioStream(item) {
  return Array.isArray(item.probe?.streams)
    ? item.probe.streams.find((stream) => stream?.codec_type === "audio") ?? null
    : null;
}

function finalStateGate(item) {
  const problems = [];
  if (!owns(item, "failure")) problems.push("final failure field is missing");
  else if (item.failure !== null) problems.push(`render reported failure: ${String(item.failure).slice(0, 180)}`);
  if (!owns(item, "failureKind")) problems.push("final failureKind field is missing");
  else if (item.failureKind !== null) problems.push(`failureKind is ${item.failureKind}`);
  if (!owns(item, "failureExitCode") || jsonSafeInteger(item.failureExitCode) == null) {
    problems.push("final failureExitCode is missing or invalid");
  } else if (item.failureExitCode !== 0) {
    problems.push(`failureExitCode is ${item.failureExitCode}`);
  }
  for (const key of ["finalError", "finalFailure", "renderError", "muxError", "validationError"]) {
    if (owns(item, key) && !neutralExplicitEvidence(item[key])) {
      problems.push(`${key} contains explicit final error/failure evidence`);
    }
  }
  for (const [label, root] of [
    ["renderer.frameMetrics", item.renderer?.frameMetrics],
    ["final", item.final],
  ]) {
    recursiveAntiEvidence(problems, root, label);
  }
  const explicitFailure = owns(item, "failure") && item.failure !== null;
  const explicitExit = owns(item, "failureExitCode") ? jsonSafeInteger(item.failureExitCode) : null;
  return {
    pass: problems.length === 0,
    failed: explicitFailure || (explicitExit != null && explicitExit !== 0),
    problems,
  };
}

function approximatelyEqual(left, right, tolerance = PROBE_TIME_TOLERANCE_SECONDS) {
  return Number.isFinite(left) && Number.isFinite(right) && Math.abs(left - right) <= tolerance;
}

function probeGate(item, frameResult, requestedFps) {
  const problems = [];
  if (!isObject(item.probe)) problems.push("final output probe is missing");
  if (!Array.isArray(item.probe?.streams)) problems.push("probe.streams is missing");
  const videoStreams = Array.isArray(item.probe?.streams)
    ? item.probe.streams.filter((stream) => stream?.codec_type === "video")
    : [];
  if (videoStreams.length !== 1) problems.push(`probe must contain exactly one video stream, found ${videoStreams.length}`);
  const video = videoStreams[0] ?? null;
  if (!isObject(item.probe?.format)) problems.push("probe.format is missing");
  if (!video || !isObject(item.config)) return { pass: false, problems };

  const expectedWidth = numeric(item.config.width);
  const expectedHeight = numeric(item.config.height);
  const probedWidth = numeric(video.width);
  const probedHeight = numeric(video.height);
  if (!Number.isSafeInteger(probedWidth) || probedWidth !== expectedWidth) {
    problems.push(`probed width ${video.width ?? "missing"}, expected ${expectedWidth ?? "valid config.width"}`);
  }
  if (!Number.isSafeInteger(probedHeight) || probedHeight !== expectedHeight) {
    problems.push(`probed height ${video.height ?? "missing"}, expected ${expectedHeight ?? "valid config.height"}`);
  }

  for (const key of ["r_frame_rate", "avg_frame_rate"]) {
    const probedFps = ratio(video[key]);
    if (requestedFps == null || probedFps == null || !approximatelyEqual(probedFps, requestedFps)) {
      problems.push(`probed ${key} ${video[key] ?? "missing"}, expected ${item.config.fps ?? "valid config.fps"}`);
    }
  }

  const expectedDuration = frameResult.requested != null && requestedFps != null
    ? frameResult.requested / requestedFps
    : null;
  const configuredDuration = numeric(item.config.duration);
  if (expectedDuration == null || configuredDuration == null
      || !approximatelyEqual(configuredDuration, expectedDuration)) {
    problems.push(
      `config.duration ${item.config.duration ?? "missing"}, expected ${expectedDuration ?? "frames/fps contract"}`,
    );
  }
  const videoDuration = numeric(video.duration);
  if (expectedDuration == null || videoDuration == null
      || !approximatelyEqual(videoDuration, expectedDuration)) {
    problems.push(`probed video duration ${video.duration ?? "missing"}, expected ${expectedDuration ?? "frames/fps contract"}`);
  }
  const formatDuration = numeric(item.probe?.format?.duration);
  if (expectedDuration == null || formatDuration == null
      || !approximatelyEqual(formatDuration, expectedDuration)) {
    problems.push(`probed container duration ${item.probe?.format?.duration ?? "missing"}, expected ${expectedDuration ?? "frames/fps contract"}`);
  }
  const startTime = numeric(video.start_time);
  if (startTime == null || !approximatelyEqual(startTime, 0)) {
    problems.push(`probed video start_time ${video.start_time ?? "missing"}, expected 0`);
  }
  if (video.codec_name !== STRICT_VIDEO_CODEC) {
    problems.push(`probed video codec ${video.codec_name ?? "missing"}, allowed ${STRICT_VIDEO_CODEC}`);
  }
  if (video.pix_fmt !== STRICT_PIXEL_FORMAT) {
    problems.push(`probed pixel format ${video.pix_fmt ?? "missing"}, allowed ${STRICT_PIXEL_FORMAT}`);
  }
  const requiredColor = {
    color_range: "tv",
    color_space: "bt709",
    color_transfer: "bt709",
    color_primaries: "bt709",
  };
  for (const [key, expected] of Object.entries(requiredColor)) {
    if (video[key] !== expected) problems.push(`probed ${key} ${video[key] ?? "missing"}, expected ${expected}`);
  }
  const readFrames = owns(video, "nb_read_frames") ? numeric(video.nb_read_frames) : null;
  if (!Number.isSafeInteger(readFrames) || readFrames < 0) {
    problems.push("probed video nb_read_frames is missing or invalid");
  } else if (frameResult.requested == null || readFrames !== frameResult.requested) {
    problems.push(`probed video nb_read_frames ${readFrames}, expected ${frameResult.requested ?? "requested frame contract"}`);
  }
  return { pass: problems.length === 0, problems };
}

function frameGate(item) {
  const video = videoStream(item);
  const requested = numberEvidence([
    field("config.frames", item.config, "frames"),
    field("frames", item, "frames"),
    field("renderer.frames", item.renderer, "frames"),
    field("screenshotSequence.expectedFrames", item.screenshotSequence, "expectedFrames"),
  ], { integer: true, minimum: 1 });
  const completed = numberEvidence([
    field("renderer.framesCompleted", item.renderer, "framesCompleted"),
    field("framesCompleted", item, "framesCompleted"),
    field("renderer.frameMetrics.framesCompleted", item.renderer?.frameMetrics, "framesCompleted"),
    field("screenshotSequence.capturedFrames", item.screenshotSequence, "capturedFrames"),
    field("probe.video.nb_read_frames", video, "nb_read_frames", { allowNumericString: true }),
  ], { integer: true, minimum: 0 });
  const problems = [];
  if (!requested.known) problems.push(`requested frame evidence is ${requested.reason}`);
  if (!completed.known) problems.push(`completed frame evidence is ${completed.reason}`);
  if (requested.known && completed.known && requested.value !== completed.value) {
    problems.push(`completed ${completed.value} of ${requested.value} requested frames`);
  }
  return {
    pass: problems.length === 0,
    requested: requested.value,
    completed: completed.value,
    label: `${completed.known ? completed.value : "?"}/${requested.known ? requested.value : "?"}`,
    problems,
  };
}

function fallbackGate(item) {
  const evidence = numberEvidence([
    field("screenshot_fallback_frames", item, "screenshot_fallback_frames"),
    field("fallback_frames", item, "fallback_frames"),
    field("renderer.frameMetrics.aggregates.anomalies.fallback", item.renderer?.frameMetrics?.aggregates?.anomalies, "fallback"),
  ], { integer: true, minimum: 0 });
  const problems = [];
  if (!evidence.known) problems.push(`fallback count is ${evidence.reason}`);
  else if (evidence.value !== 0) problems.push(`${evidence.value} unplanned fallback frame(s)`);
  return {
    pass: problems.length === 0,
    value: evidence.value,
    label: evidence.known ? String(evidence.value) : "unknown",
    problems,
  };
}

function walkEvidence(value, path, visitor) {
  if (Array.isArray(value)) {
    value.forEach((entry, index) => {
      const entryPath = `${path}[${index}]`;
      visitor({ value: entry, path: entryPath, key: String(index) });
      if (Array.isArray(entry) || isObject(entry)) walkEvidence(entry, entryPath, visitor);
    });
    return;
  }
  if (!isObject(value)) return;
  for (const [key, child] of Object.entries(value)) {
    const childPath = path ? `${path}.${key}` : key;
    visitor({ value: child, path: childPath, key });
    if (Array.isArray(child) || isObject(child)) walkEvidence(child, childPath, visitor);
  }
}

function neutralExplicitEvidence(value) {
  if (value == null) return true;
  if (typeof value === "boolean") return value === false;
  if (typeof value === "number") return Number.isFinite(value) && value === 0;
  if (typeof value === "string") return value.length === 0;
  if (Array.isArray(value)) return value.length === 0;
  if (isObject(value)) return Object.keys(value).length === 0;
  return false;
}

function recursiveAntiEvidence(problems, root, rootLabel, { production = false, screenshot = false } = {}) {
  if (!isObject(root)) return;
  const forbiddenDecision = production
    ? /CACHE_REQUIRED|CANONICAL_CACHE_REQUIRED|SOFTWARE[-_ ]FALLBACK|HTML[-_ ]VIDEO[-_ ]FALLBACK|EMERGENCY/i
    : /CACHE_REQUIRED|SOFTWARE[-_ ]FALLBACK|EMERGENCY|NEAREST[-_ ]FRAME/i;
  walkEvidence(root, rootLabel, ({ value, path, key }) => {
    if (NON_CONTROL_EVIDENCE_SUBTREE.test(path)) return;
    if (typeof value === "string" && FORBIDDEN_CONTROL_VALUE.test(value)) {
      problems.push(`${path} contains forbidden control state ${value}`);
    }
    if (owns(CONTROL_STATE_VALUES, key)) {
      const normalized = typeof value === "string" ? value.trim().toLowerCase() : null;
      if (normalized == null || normalized.length === 0 || !CONTROL_STATE_VALUES[key].has(normalized)) {
        problems.push(`${path} has unknown or forbidden ${key} value ${String(value)}`);
      }
    }
    if ((key === "pass" || /Pass$/.test(key)) && value !== true) {
      problems.push(`${path} must be boolean true`);
    }
    if (/(?:error|failure)/i.test(key) || key === "failureStages") {
      if (!neutralExplicitEvidence(value)) problems.push(`${path} contains explicit error/failure evidence`);
    }
    if (/(?:fallback|emergency)/i.test(key)) {
      if (!neutralExplicitEvidence(value)) problems.push(`${path} contains explicit fallback/emergency evidence`);
    }
    if (ZERO_ANTI_EVIDENCE_COUNTERS.has(key)) {
      if (typeof value !== "number" || !Number.isSafeInteger(value) || value !== 0) {
        problems.push(`${path} must be the number 0`);
      }
    }
    if (FINAL_RESOURCE_ZERO_FIELDS.has(key)
        && (screenshot || /afterDispose|brokerAfter|mediaGate/i.test(path))) {
      if (typeof value !== "number" || !Number.isFinite(value) || value !== 0) {
        problems.push(`${path} contains explicit final resource-leak evidence`);
      }
    }
    if (key === "frameOpen" && /afterDispose/i.test(path) && value !== false) {
      problems.push(`${path} contains an open final frame scope`);
    }
    if (key === "mediaRequestGate" && screenshot && value !== true) {
      problems.push(`${path} must be boolean true`);
    }
    if (production && (key === "htmlVideoFallback" || key === "cacheRequired")) {
      if (typeof value !== "boolean") problems.push(`${path} must be boolean`);
      else if (value) problems.push(`${path} is true`);
    }
    if (typeof value === "string" && forbiddenDecision.test(value)) {
      problems.push(`${path} contains forbidden route evidence ${value}`);
    }
    if (screenshot && /nearest.*frame/i.test(key) && !neutralExplicitEvidence(value)) {
      problems.push(`${path} proves an unapproved nearest-frame path`);
    }
  });
}

function requireSnapshotBoolean(problems, snapshot, label, key, expected) {
  if (!owns(snapshot, key) || typeof snapshot[key] !== "boolean") {
    problems.push(`${label}.${key} is missing or not boolean`);
  } else if (snapshot[key] !== expected) {
    problems.push(`${label}.${key} is ${snapshot[key]}, expected ${expected}`);
  }
}

function requireSnapshotCounter(problems, snapshot, label, key, expected = 0) {
  const value = owns(snapshot, key) && typeof snapshot[key] === "number" && Number.isFinite(snapshot[key])
    ? snapshot[key]
    : null;
  if (!Number.isSafeInteger(value) || value < 0) {
    problems.push(`${label}.${key} is missing or invalid`);
  } else if (value !== expected) {
    problems.push(`${label}.${key} is ${value}, expected ${expected}`);
  }
}

function requireNonnegativeCounter(problems, snapshot, label, key) {
  const value = owns(snapshot, key) && typeof snapshot[key] === "number" && Number.isFinite(snapshot[key])
    ? snapshot[key]
    : null;
  if (!Number.isSafeInteger(value) || value < 0) {
    problems.push(`${label}.${key} is missing or invalid`);
    return null;
  }
  return value;
}

function validateProductionRuntimeSnapshot(
  problems,
  snapshot,
  label,
  routeIdentities,
  { expectedOutputFrames, requireLaneEvidence = false, requireDisposed = false } = {},
) {
  if (!isObject(snapshot)) {
    problems.push(`${label} snapshot is missing`);
    return;
  }
  if (snapshot.schemaVersion !== PRODUCTION_EVIDENCE_SCHEMA_VERSION) {
    problems.push(`${label}.schemaVersion ${snapshot.schemaVersion ?? "missing"}, expected ${PRODUCTION_EVIDENCE_SCHEMA_VERSION}`);
  }
  requireSnapshotBoolean(problems, snapshot, label, "exactPtsPass", true);
  requireSnapshotBoolean(problems, snapshot, label, "validationPass", true);
  for (const key of [
    "cacheRequiredSources", "canonicalCacheDecisions", "acquireFailures", "fallbackFrames", "protocolErrors",
  ]) {
    requireSnapshotCounter(problems, snapshot, label, key, 0);
  }
  if (expectedOutputFrames != null) {
    requireSnapshotCounter(problems, snapshot, label, "outputFrames", expectedOutputFrames);
  } else {
    requireNonnegativeCounter(problems, snapshot, label, "outputFrames");
  }
  const activeSources = requireNonnegativeCounter(problems, snapshot, label, "activeSources");
  const activeLanes = requireNonnegativeCounter(problems, snapshot, label, "activeLanes");
  requireSnapshotBoolean(problems, snapshot, label, "frameOpen", false);
  if (requireDisposed && activeSources !== 0) problems.push(`${label}.activeSources is ${activeSources}, expected 0`);
  if (requireDisposed && activeLanes !== 0) problems.push(`${label}.activeLanes is ${activeLanes}, expected 0`);

  if (!Array.isArray(snapshot.sourceMetrics)) {
    problems.push(`${label}.sourceMetrics is missing or not an array`);
  } else if (!requireDisposed && snapshot.sourceMetrics.length === 0) {
    problems.push(`${label}.sourceMetrics has no source evidence`);
  }
  for (const [index, source] of (snapshot.sourceMetrics ?? []).entries()) {
    const sourceLabel = `${label}.sourceMetrics[${index}]`;
    if (!isObject(source)) {
      problems.push(`${sourceLabel} is not an object`);
      continue;
    }
    if (source.schemaVersion !== PRODUCTION_EVIDENCE_SCHEMA_VERSION) {
      problems.push(`${sourceLabel}.schemaVersion ${source.schemaVersion ?? "missing"}, expected ${PRODUCTION_EVIDENCE_SCHEMA_VERSION}`);
    }
    if (typeof source.sourceIdentity !== "string" || !routeIdentities.has(source.sourceIdentity)) {
      problems.push(`${sourceLabel}.sourceIdentity does not match an approved route identity`);
    }
    requireSnapshotCounter(problems, source, sourceLabel, "validationFailures", 0);
    const activeCursors = requireNonnegativeCounter(problems, source, sourceLabel, "activeCursors");
    const pendingCleanup = requireNonnegativeCounter(problems, source, sourceLabel, "pendingCleanup");
    if (requireDisposed && activeCursors !== 0) {
      problems.push(`${sourceLabel}.activeCursors is ${activeCursors}, expected 0`);
    }
    if (requireDisposed && pendingCleanup !== 0) {
      problems.push(`${sourceLabel}.pendingCleanup is ${pendingCleanup}, expected 0`);
    }
  }

  if (!Array.isArray(snapshot.laneMetrics)) {
    problems.push(`${label}.laneMetrics is missing or not an array`);
  } else if (requireLaneEvidence && snapshot.laneMetrics.length === 0) {
    problems.push(`${label}.laneMetrics has no exact-PTS lane evidence`);
  }
  for (const [index, lane] of (snapshot.laneMetrics ?? []).entries()) {
    const laneLabel = `${label}.laneMetrics[${index}]`;
    if (!isObject(lane)) {
      problems.push(`${laneLabel} is not an object`);
      continue;
    }
    if (lane.schemaVersion !== PRODUCTION_EVIDENCE_SCHEMA_VERSION) {
      problems.push(`${laneLabel}.schemaVersion ${lane.schemaVersion ?? "missing"}, expected ${PRODUCTION_EVIDENCE_SCHEMA_VERSION}`);
    }
    if (typeof lane.sourceIdentity !== "string" || !routeIdentities.has(lane.sourceIdentity)) {
      problems.push(`${laneLabel}.sourceIdentity does not match an approved route identity`);
    }
    requireSnapshotBoolean(problems, lane, laneLabel, "configured", true);
    const readyFrames = requireNonnegativeCounter(problems, lane, laneLabel, "readyFrameCount");
    if (requireDisposed && readyFrames !== 0) {
      problems.push(`${laneLabel}.readyFrameCount is ${readyFrames}, expected 0`);
    }
    for (const key of ["exactPtsFailures", "unexpectedOutputs", "duplicateOutputs"]) {
      requireSnapshotCounter(problems, lane, laneLabel, key, 0);
    }
  }

  const budget = snapshot.frameBudget;
  if (!isObject(budget)) {
    problems.push(`${label}.frameBudget is missing`);
  } else {
    const maximum = requireNonnegativeCounter(problems, budget, `${label}.frameBudget`, "maximumFrames");
    const outstanding = requireNonnegativeCounter(problems, budget, `${label}.frameBudget`, "outstandingFrames");
    const acquired = requireNonnegativeCounter(problems, budget, `${label}.frameBudget`, "acquiredFrames");
    const closed = requireNonnegativeCounter(problems, budget, `${label}.frameBudget`, "closedFrames");
    if (maximum === 0) problems.push(`${label}.frameBudget.maximumFrames must be positive`);
    if (maximum != null && outstanding != null && outstanding > maximum) {
      problems.push(`${label}.frameBudget.outstandingFrames exceeds maximumFrames`);
    }
    if (acquired != null && closed != null && outstanding != null && acquired - closed !== outstanding) {
      problems.push(`${label}.frameBudget acquired-closed does not equal outstandingFrames`);
    }
    if (requireDisposed && outstanding !== 0) {
      problems.push(`${label}.frameBudget.outstandingFrames is ${outstanding}, expected 0`);
    }
  }

  const allocator = snapshot.allocator;
  if (!isObject(allocator) || !isObject(allocator.metrics) || !isObject(allocator.limits)) {
    problems.push(`${label}.allocator metrics/limits evidence is missing`);
  } else {
    requireSnapshotCounter(problems, allocator.metrics, `${label}.allocator.metrics`, "allocationFailures", 0);
    for (const key of ["maxTotalLanes", "maxLanesPerSource", "readyFramesMax", "decodeQueueMax"]) {
      const limit = requireNonnegativeCounter(problems, allocator.limits, `${label}.allocator.limits`, key);
      if (limit === 0) problems.push(`${label}.allocator.limits.${key} must be positive`);
    }
  }
}

function validateProductionBrokerSnapshot(problems, broker, label) {
  if (!isObject(broker)) {
    problems.push(`${label} snapshot is missing`);
    return;
  }
  if (broker.schemaVersion !== PRODUCTION_EVIDENCE_SCHEMA_VERSION) {
    problems.push(`${label}.schemaVersion ${broker.schemaVersion ?? "missing"}, expected ${PRODUCTION_EVIDENCE_SCHEMA_VERSION}`);
  }
  for (const key of [
    "canonicalCacheRequired", "activeSources", "activeCursors", "pendingBegins", "activeReads", "protocolErrors",
  ]) {
    requireSnapshotCounter(problems, broker, label, key, 0);
  }
  const budget = broker.byteBudget;
  if (!isObject(budget)) {
    problems.push(`${label}.byteBudget is missing`);
    return;
  }
  const maximum = requireNonnegativeCounter(problems, budget, `${label}.byteBudget`, "maximumBytes");
  if (maximum === 0) problems.push(`${label}.byteBudget.maximumBytes must be positive`);
  for (const key of ["currentBytes", "activeLeases", "waitingReservations"]) {
    requireSnapshotCounter(problems, budget, `${label}.byteBudget`, key, 0);
  }
  const reservations = requireNonnegativeCounter(problems, budget, `${label}.byteBudget`, "reservations");
  const releases = requireNonnegativeCounter(problems, budget, `${label}.byteBudget`, "releases");
  if (reservations != null && releases != null && reservations !== releases) {
    problems.push(`${label}.byteBudget reservations ${reservations} differ from releases ${releases}`);
  }
}

function productionEvidenceGate(item, frameResult) {
  if (item.config?.mediaDecoderBackend !== "production-webcodecs") {
    return { pass: true, applicable: false, problems: [] };
  }
  const problems = [];
  const roots = [
    ["support.productionDecoder", item.support?.productionDecoder],
    ["renderer.support.productionDecoder", item.renderer?.support?.productionDecoder],
    ["productionDecoder", item.productionDecoder],
  ].filter(([, root]) => root != null);
  const routeIdentities = new Set(
    (item.productionDecoder?.route?.sources ?? [])
      .map((source) => source?.sourceIdentity)
      .filter((identity) => typeof identity === "string" && /^[a-f0-9]{64}$/i.test(identity)),
  );
  for (const [rootLabel, root] of roots) {
    if (!isObject(root)) {
      problems.push(`${rootLabel} evidence subtree is missing`);
      continue;
    }
    recursiveAntiEvidence(problems, root, rootLabel, { production: true });
    walkEvidence(root, rootLabel, ({ value, path, key }) => {
      if (NON_CONTROL_EVIDENCE_SUBTREE.test(path)) return;
      if ((key === "decision" || key === "openDecision") && value !== STRICT_PRODUCTION_ROUTE) {
        problems.push(`${path} ${String(value)} is not an allowed direct decision`);
      }
      if (/\.openDecisions\[\d+\]$/.test(path) && value !== STRICT_PRODUCTION_ROUTE && typeof value !== "object") {
        problems.push(`${path} ${String(value)} is not an allowed direct decision`);
      }
      if (key === "sourceIdentity") {
        if (typeof value !== "string" || !/^[a-f0-9]{64}$/i.test(value)) {
          problems.push(`${path} is missing or invalid`);
        } else if (!routeIdentities.has(value)) {
          problems.push(`${path} does not match an approved route source identity`);
        }
      }
    });
  }
  const decoder = item.renderer?.support?.productionDecoder;
  const initial = decoder?.initial;
  if (!isObject(initial)) {
    problems.push("renderer.support.productionDecoder.initial evidence is missing");
  } else {
    if (initial.schemaVersion !== PRODUCTION_EVIDENCE_SCHEMA_VERSION) {
      problems.push(
        `renderer.support.productionDecoder.initial.schemaVersion ${initial.schemaVersion ?? "missing"}, expected ${PRODUCTION_EVIDENCE_SCHEMA_VERSION}`,
      );
    }
    requireSnapshotBoolean(problems, initial, "renderer.support.productionDecoder.initial", "exactPts", true);
    requireSnapshotBoolean(problems, initial, "renderer.support.productionDecoder.initial", "exactPtsPass", true);
    requireSnapshotBoolean(problems, initial, "renderer.support.productionDecoder.initial", "validationPass", true);
    requireSnapshotBoolean(problems, initial, "renderer.support.productionDecoder.initial", "htmlVideoFallback", false);
    if (!Array.isArray(initial.openDecisions) || initial.openDecisions.length === 0) {
      problems.push("renderer.support.productionDecoder.initial.openDecisions is missing or empty");
    }
    for (const [index, decision] of (initial.openDecisions ?? []).entries()) {
      const decisionLabel = `renderer.support.productionDecoder.initial.openDecisions[${index}]`;
      if (!isObject(decision)) {
        problems.push(`${decisionLabel} is not an object`);
        continue;
      }
      if (decision.decision !== STRICT_PRODUCTION_ROUTE) {
        problems.push(`${decisionLabel}.decision ${decision.decision ?? "missing"} is not allowed`);
      }
      if (typeof decision.sourceIdentity !== "string"
          || !/^[a-f0-9]{64}$/i.test(decision.sourceIdentity)
          || !routeIdentities.has(decision.sourceIdentity)) {
        problems.push(`${decisionLabel}.sourceIdentity is missing, non-canonical, or not bound to the approved route`);
      }
    }
  }
  validateProductionRuntimeSnapshot(
    problems,
    initial?.runtime,
    "renderer.support.productionDecoder.initial.runtime",
    routeIdentities,
    { expectedOutputFrames: 0 },
  );
  validateProductionRuntimeSnapshot(
    problems,
    decoder?.final?.beforeDispose,
    "renderer.support.productionDecoder.final.beforeDispose",
    routeIdentities,
    { expectedOutputFrames: frameResult.requested, requireLaneEvidence: true },
  );
  validateProductionRuntimeSnapshot(
    problems,
    decoder?.final?.afterDispose,
    "renderer.support.productionDecoder.final.afterDispose",
    routeIdentities,
    { expectedOutputFrames: frameResult.requested, requireDisposed: true },
  );
  validateProductionBrokerSnapshot(
    problems,
    decoder?.final?.brokerAfterRendererDispose,
    "renderer.support.productionDecoder.final.brokerAfterRendererDispose",
  );
  return { pass: problems.length === 0, applicable: true, problems };
}

function routeGate(item, frameResult) {
  const config = item.config;
  const support = item.renderer?.support;
  const problems = [];
  if (!isObject(config)) return { pass: false, value: null, label: "unknown", problems: ["route config is missing"] };
  if (!isObject(support)) problems.push("renderer backend proof is missing");
  if (support?.outputBackend !== config.outputBackend) {
    problems.push(`renderer outputBackend ${support?.outputBackend ?? "missing"} differs from config ${config.outputBackend ?? "missing"}`);
  }
  if (support?.mediaDecoderBackend !== config.mediaDecoderBackend) {
    problems.push(
      `renderer mediaDecoderBackend ${support?.mediaDecoderBackend ?? "missing"} differs from config ${config.mediaDecoderBackend ?? "missing"}`,
    );
  }

  if (config.mediaDecoderBackend === "production-webcodecs") {
    if (config.outputBackend !== "webcodecs") problems.push("production decoder requires outputBackend=webcodecs");
    if (!new Set(["layered", "proxy-tree"]).has(config.compositeMode)) {
      problems.push(`production decoder compositeMode ${config.compositeMode ?? "missing"} is not allowed`);
    }
    if (config.mediaTargetMode !== "timing-plan") problems.push("production decoder requires mediaTargetMode=timing-plan");
    if (config.mediaFrameMode !== "video") problems.push("production decoder requires mediaFrameMode=video");
    if (support?.productionDecoder?.active !== true) problems.push("renderer production decoder was not explicitly active");

    const route = item.productionDecoder?.route;
    if (!isObject(route)) {
      problems.push("production decoder route proof is missing");
      return { pass: false, value: null, label: "unknown", problems };
    }
    if (route.backend !== "production-webcodecs") {
      problems.push(`production route backend ${route.backend ?? "missing"} is not allowed`);
    }
    if (route.decision !== STRICT_PRODUCTION_ROUTE) {
      problems.push(`production route decision ${route.decision ?? "missing"} is not allowed`);
    }
    if (route.renderStarted !== true) problems.push("production route does not prove renderStarted=true");
    if (!Array.isArray(route.sources) || route.sources.length === 0) {
      problems.push("production route source proof is missing");
    }
    const sourceContracts = [];
    for (const [index, source] of (route.sources ?? []).entries()) {
      const identity = source?.sourceIdentity;
      if (typeof identity !== "string" || !/^[a-f0-9]{64}$/i.test(identity)) {
        problems.push(`production route source ${index} identity is missing or invalid`);
      }
      if (source?.decision !== STRICT_PRODUCTION_ROUTE) {
        problems.push(`production route source ${index} decision ${source?.decision ?? "missing"} is not allowed`);
      }
      if (source?.summary?.codec !== "avc") {
        problems.push(`production route source ${index} codec ${source?.summary?.codec ?? "missing"} is not direct AVC`);
      }
      if (typeof source?.summary?.sampleEntry !== "string"
          || !/^avc1(?:\.|$)/.test(source.summary.sampleEntry)) {
        problems.push(`production route source ${index} sample entry ${source?.summary?.sampleEntry ?? "missing"} is not avc1`);
      }
      sourceContracts.push({
        sourceIdentity: identity ?? null,
        decision: source?.decision ?? null,
        codec: source?.summary?.codec ?? null,
        sampleEntry: source?.summary?.sampleEntry ?? null,
      });
    }
    const value = JSON.stringify({
      kind: "production-exact",
      backend: route.backend ?? null,
      decision: route.decision ?? null,
      sources: sourceContracts.sort((left, right) => String(left.sourceIdentity).localeCompare(String(right.sourceIdentity))),
    });
    return { pass: problems.length === 0, value, label: route.decision ?? "unknown", problems };
  }

  if (config.outputBackend === "screenshot" && config.mediaDecoderBackend === "html-video") {
    if (config.compositeMode !== "screenshot") problems.push("screenshot backend requires compositeMode=screenshot");
    if (config.mediaFrameMode !== "video") problems.push("screenshot backend requires mediaFrameMode=video");
    if (!STRICT_SCREENSHOT_ENCODERS.has(config.screenshotEncoder)) {
      problems.push(
        `screenshot encoder ${config.screenshotEncoder ?? "missing"} is not in the strict hardware-backed comparison set`,
      );
    }
    if (!STRICT_SCREENSHOT_MEDIA_POLICIES.has(config.screenshotMediaPolicy)) {
      problems.push(
        `screenshot media policy ${config.screenshotMediaPolicy ?? "missing"} is not faithful or bounded-static`,
      );
    }
    if (config.screenshotMediaPolicyRequested !== config.screenshotMediaPolicy) {
      problems.push(
        `requested screenshot media policy ${config.screenshotMediaPolicyRequested ?? "missing"} differs from selected policy ${config.screenshotMediaPolicy ?? "missing"}`,
      );
    }
    if (config.screenshotMediaRequestGate !== true) {
      problems.push("screenshot config does not prove mediaRequestGate=true");
    }
    if (config.mediaTargetMode !== "timing-plan") {
      problems.push(`screenshot mediaTargetMode ${config.mediaTargetMode ?? "missing"}, expected timing-plan`);
    }
    if (numeric(config.mediaSeekBiasFrames) !== 0) {
      problems.push(`screenshot mediaSeekBiasFrames ${config.mediaSeekBiasFrames ?? "missing"}, expected 0`);
    }
    const overshoot = numeric(config.mediaOvershootToleranceFrames);
    if (overshoot == null || overshoot < 0 || overshoot > 0.5) {
      problems.push(
        `screenshot mediaOvershootToleranceFrames ${config.mediaOvershootToleranceFrames ?? "missing"}, expected 0..0.5`,
      );
    }
    if (config.mediaAdvanceMode !== "playback-step") {
      problems.push(`screenshot mediaAdvanceMode ${config.mediaAdvanceMode ?? "missing"}, expected playback-step`);
    }
    if (!isObject(config.screenshotEntryTransform) || config.screenshotEntryTransform.domMutations !== 0) {
      problems.push(
        `screenshot config entry-transform domMutations is ${config.screenshotEntryTransform?.domMutations ?? "missing"}, expected 0`,
      );
    }
    const capture = support?.screenshotCapture;
    if (!isObject(capture)) problems.push("faithful screenshot capture proof is missing");
    if (capture?.sequential !== true) problems.push("screenshot capture does not prove sequential=true");
    if (capture?.authoredDomMutations !== 0) {
      problems.push(`screenshot authoredDomMutations is ${capture?.authoredDomMutations ?? "missing"}, expected 0`);
    }
    if (capture?.mediaRequestGate !== true) {
      problems.push("screenshot capture does not prove mediaRequestGate=true");
    }
    if (!isObject(capture?.entryTransform) || capture.entryTransform.domMutations !== 0) {
      problems.push(
        `screenshot capture entry-transform domMutations is ${capture?.entryTransform?.domMutations ?? "missing"}, expected 0`,
      );
    }
    if (capture?.mediaPolicy !== config.screenshotMediaPolicy) {
      problems.push(
        `screenshot media policy ${capture?.mediaPolicy ?? "missing"} differs from config ${config.screenshotMediaPolicy ?? "missing"}`,
      );
    }
    const sequence = item.screenshotSequence;
    if (!isObject(sequence)) problems.push("screenshot sequence proof is missing");
    const expectedFrames = owns(sequence, "expectedFrames") ? jsonSafeInteger(sequence.expectedFrames) : null;
    const capturedFrames = owns(sequence, "capturedFrames") ? jsonSafeInteger(sequence.capturedFrames) : null;
    if (!Number.isSafeInteger(expectedFrames) || expectedFrames !== frameResult.requested) {
      problems.push(
        `screenshot expectedFrames ${sequence?.expectedFrames ?? "missing"}, expected ${frameResult.requested ?? "frame contract"}`,
      );
    }
    if (!Number.isSafeInteger(capturedFrames) || capturedFrames !== frameResult.requested) {
      problems.push(
        `screenshot capturedFrames ${sequence?.capturedFrames ?? "missing"}, expected ${frameResult.requested ?? "frame contract"}`,
      );
    }
    const hashSequence = sequence?.frameHashSequence;
    if (!isObject(hashSequence)) problems.push("screenshot frameHashSequence proof is missing");
    const framesObserved = jsonSafeInteger(hashSequence?.framesObserved);
    if (framesObserved == null || framesObserved !== frameResult.requested) {
      problems.push(
        `screenshot frameHashSequence.framesObserved ${hashSequence?.framesObserved ?? "missing"}, expected ${frameResult.requested ?? "frame contract"}`,
      );
    }
    if (typeof hashSequence?.sequenceSha256 !== "string"
        || !/^[a-f0-9]{64}$/i.test(hashSequence.sequenceSha256)) {
      problems.push("screenshot frameHashSequence.sequenceSha256 is missing or invalid");
    }
    const mediaGate = sequence?.mediaGate;
    if (!isObject(mediaGate)) problems.push("screenshot mediaGate proof is missing");
    if (mediaGate?.requestedPolicy !== config.screenshotMediaPolicyRequested) {
      problems.push("screenshot mediaGate requestedPolicy differs from config");
    }
    if (mediaGate?.policy !== config.screenshotMediaPolicy) {
      problems.push("screenshot mediaGate policy differs from config");
    }
    for (const [rootLabel, root] of [
      ["support.screenshotCapture", item.support?.screenshotCapture],
      ["renderer.support.screenshotCapture", capture],
      ["screenshotSequence", sequence],
    ]) {
      if (!isObject(root)) continue;
      recursiveAntiEvidence(problems, root, rootLabel, { screenshot: true });
      walkEvidence(root, rootLabel, ({ value: evidenceValue, path, key }) => {
        if (NON_CONTROL_EVIDENCE_SUBTREE.test(path)) return;
        if (key === "domMutations") {
          const mutations = jsonSafeInteger(evidenceValue);
          if (!Number.isSafeInteger(mutations) || mutations !== 0) {
            problems.push(`${path} is ${evidenceValue ?? "missing"}, expected 0`);
          }
        }
        if (/nearest.*frame/i.test(key)) {
          const active = evidenceValue === true
            || (numeric(evidenceValue) != null && numeric(evidenceValue) > 0)
            || (typeof evidenceValue === "string" && evidenceValue.length > 0);
          if (active) problems.push(`${path} proves an unapproved nearest-frame path`);
        }
        if (typeof evidenceValue === "string" && /nearest[-_ ]frame/i.test(evidenceValue)) {
          problems.push(`${path} contains an unapproved nearest-frame decision`);
        }
      });
    }
    const value = JSON.stringify({
      kind: "faithful-screenshot",
      encoder: config.screenshotEncoder ?? null,
      mediaPolicy: config.screenshotMediaPolicy ?? null,
      mediaPolicyRequested: config.screenshotMediaPolicyRequested ?? null,
      mediaRequestGate: config.screenshotMediaRequestGate ?? null,
      mediaTargetMode: config.mediaTargetMode ?? null,
      mediaSeekBiasFrames: numeric(config.mediaSeekBiasFrames),
      mediaOvershootToleranceFrames: overshoot,
      mediaAdvanceMode: config.mediaAdvanceMode ?? null,
      sequenceSha256: hashSequence?.sequenceSha256 ?? null,
    });
    return { pass: problems.length === 0, value, label: "faithful-screenshot", problems };
  }

  problems.push(
    `backend route ${config.outputBackend ?? "missing"}/${config.mediaDecoderBackend ?? "missing"} is not in the strict accepted set`,
  );
  return { pass: false, value: null, label: "unapproved", problems };
}

function exactPtsGate(item) {
  const decoder = item.config?.mediaDecoderBackend;
  if (decoder === "html-video") {
    return { pass: true, applicable: false, errors: null, label: "n/a(html-video)", problems: [] };
  }
  if (decoder !== "production-webcodecs") {
    return {
      pass: false,
      applicable: null,
      errors: null,
      label: "unknown",
      problems: ["mediaDecoderBackend is missing or has no exact-PTS evidence contract"],
    };
  }
  const problems = [];
  const lanes = item.renderer?.support?.productionDecoder?.final?.beforeDispose?.laneMetrics;
  if (!Array.isArray(lanes) || lanes.length === 0) {
    problems.push("production exact-PTS lane counters are missing");
    return { pass: false, applicable: true, errors: null, label: "unknown", problems };
  }
  let errors = 0;
  for (let index = 0; index < lanes.length; index += 1) {
    for (const key of ["exactPtsFailures", "unexpectedOutputs", "duplicateOutputs"]) {
      const value = owns(lanes[index], key) ? jsonSafeInteger(lanes[index][key]) : null;
      if (value == null) {
        problems.push(`lane ${index} ${key} counter is missing or invalid`);
      } else {
        errors += value;
      }
    }
  }
  if (errors !== 0) problems.push(`production exact decoder errors total ${errors}`);
  return {
    pass: problems.length === 0,
    applicable: true,
    errors: problems.some((problem) => problem.includes("missing or invalid")) ? null : errors,
    label: problems.some((problem) => problem.includes("missing")) ? "unknown" : String(errors),
    problems,
  };
}

function requireZero(problems, values, label, object, key) {
  const value = owns(object, key) ? jsonSafeInteger(object[key]) : null;
  if (value == null) {
    problems.push(`${label} is missing or invalid`);
    values[label] = null;
  } else {
    values[label] = value;
    if (value !== 0) problems.push(`${label} is ${value}, expected 0`);
  }
}

function resourceGate(item) {
  const problems = [];
  const values = {};
  requireZero(problems, values, "renderer.pendingPayloadBytes", item.renderer, "pendingPayloadBytes");

  if (!isObject(item.memoryWatchdog) || !owns(item.memoryWatchdog, "violation")) {
    problems.push("memory watchdog final violation field is missing");
    values["memoryWatchdog.violation"] = "unknown";
  } else {
    values["memoryWatchdog.violation"] = item.memoryWatchdog.violation;
    if (item.memoryWatchdog.violation !== null) problems.push("memory watchdog reported a violation");
  }
  const peakRss = owns(item.memoryWatchdog, "peakAggregateRssBytes")
    ? jsonSafeInteger(item.memoryWatchdog.peakAggregateRssBytes)
    : null;
  if (peakRss == null) {
    problems.push("memoryWatchdog.peakAggregateRssBytes is missing or invalid");
  }
  values["memoryWatchdog.peakAggregateRssBytes"] = peakRss;
  const minimumAvailableFields = ["minimumAvailableBytes", "minAvailableBytes"]
    .filter((key) => owns(item.memoryWatchdog, key));
  const minimumAvailableValues = minimumAvailableFields
    .map((key) => item.memoryWatchdog[key]);
  const minimumAvailableValid = minimumAvailableValues.length > 0
    && minimumAvailableValues.every((value) => jsonSafeInteger(value) != null)
    && new Set(minimumAvailableValues).size === 1;
  if (!minimumAvailableValid) {
    problems.push("memory watchdog minimum available bytes is missing, invalid, or contradictory");
  }
  values["memoryWatchdog.minimumAvailableBytes"] = minimumAvailableValid ? minimumAvailableValues[0] : null;
  const samplesObserved = owns(item.memoryWatchdog, "samplesObserved")
    ? jsonSafeInteger(item.memoryWatchdog.samplesObserved, { minimum: 1 })
    : null;
  if (samplesObserved == null) {
    problems.push("memoryWatchdog.samplesObserved is missing or invalid");
  }
  if (isObject(item.memoryWatchdog)) {
    recursiveAntiEvidence(problems, item.memoryWatchdog, "memoryWatchdog");
    walkEvidence(item.memoryWatchdog, "memoryWatchdog", ({ value, path, key }) => {
      if ((/(?:errors?|failures?)$/i.test(key) || key === "finalError") && !neutralExplicitEvidence(value)) {
        problems.push(`${path} contains explicit watchdog error/failure evidence`);
      }
      if (/BreachCount$/.test(key)) {
        const count = jsonSafeInteger(value);
        if (count == null || count !== 0) {
          problems.push(`${path} is ${value ?? "missing"}, expected 0`);
        }
      }
    });
  }

  if (item.config?.mediaDecoderBackend === "production-webcodecs") {
    const runtime = item.renderer?.support?.productionDecoder?.final?.afterDispose;
    const broker = item.productionDecoder?.brokerAfterDispose;
    if (!isObject(runtime)) problems.push("production runtime after-dispose snapshot is missing");
    if (!isObject(broker)) problems.push("production main broker after-dispose snapshot is missing");
    validateProductionBrokerSnapshot(problems, broker, "productionDecoder.brokerAfterDispose");
    if (isObject(runtime)) {
      requireZero(problems, values, "runtime.activeSources", runtime, "activeSources");
      requireZero(problems, values, "runtime.activeLanes", runtime, "activeLanes");
      requireZero(problems, values, "runtime.outstandingFrames", runtime.frameBudget, "outstandingFrames");
      if (!owns(runtime, "frameOpen") || typeof runtime.frameOpen !== "boolean") {
        problems.push("runtime.frameOpen is missing or invalid");
        values["runtime.frameOpen"] = "unknown";
      } else {
        values["runtime.frameOpen"] = runtime.frameOpen;
        if (runtime.frameOpen) problems.push("runtime frame scope remained open");
      }
      const acquired = owns(runtime.frameBudget, "acquiredFrames")
        ? jsonSafeInteger(runtime.frameBudget.acquiredFrames)
        : null;
      const closed = owns(runtime.frameBudget, "closedFrames")
        ? jsonSafeInteger(runtime.frameBudget.closedFrames)
        : null;
      values["runtime.acquiredFrames"] = acquired;
      values["runtime.closedFrames"] = closed;
      if (acquired == null || closed == null) {
        problems.push("runtime acquired/closed frame counters are missing or invalid");
      } else if (acquired !== closed) {
        problems.push(`runtime acquired ${acquired} frames but closed ${closed}`);
      }
    }
    if (isObject(broker)) {
      requireZero(problems, values, "broker.activeSources", broker, "activeSources");
      requireZero(problems, values, "broker.activeCursors", broker, "activeCursors");
      requireZero(problems, values, "broker.pendingBegins", broker, "pendingBegins");
      requireZero(problems, values, "broker.activeReads", broker, "activeReads");
      requireZero(problems, values, "broker.currentBytes", broker.byteBudget, "currentBytes");
      requireZero(problems, values, "broker.activeLeases", broker.byteBudget, "activeLeases");
      requireZero(problems, values, "broker.waitingReservations", broker.byteBudget, "waitingReservations");
    }
  } else if (item.config?.outputBackend === "screenshot") {
    const gate = item.screenshotSequence?.mediaGate;
    if (!isObject(gate)) problems.push("screenshot media-gate final snapshot is missing");
    if (isObject(gate)) {
      requireZero(problems, values, "screenshot.finalActiveUrls", gate, "finalActiveUrls");
      requireZero(problems, values, "screenshot.finalActiveLeases", gate, "finalActiveLeases");
    }
  } else {
    problems.push("resource-zero snapshot contract is unknown for this backend");
  }

  const evidenceUnknown = problems.some((problem) => /missing|unknown|invalid/.test(problem));
  const leakCount = evidenceUnknown ? null : (problems.length === 0 ? 0 : 1);
  return {
    pass: problems.length === 0,
    count: leakCount,
    label: leakCount == null ? "unknown" : String(leakCount),
    values,
    problems,
  };
}

function stableSerialize(value) {
  if (Array.isArray(value)) return `[${value.map(stableSerialize).join(",")}]`;
  if (isObject(value)) {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableSerialize(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function canonicalEvidenceIdentity(value, key) {
  if (typeof value === "string" && /^[a-f0-9]{64}$/i.test(value)) return value.toLowerCase();
  if (key === "renderIdentity" && isObject(value)) {
    const fields = ["project", "entry", "assets", "timingBundle"];
    if (fields.every((fieldName) => typeof value[fieldName] === "string"
      && /^[a-f0-9]{64}$/i.test(value[fieldName]))) {
      return stableSerialize(Object.fromEntries(fields.map((fieldName) => [fieldName, value[fieldName].toLowerCase()])));
    }
  }
  return null;
}

function canonicalRenderIdentityDigest(value) {
  const canonical = canonicalEvidenceIdentity(value, "renderIdentity");
  return canonical == null ? null : createHash("sha256").update(canonical).digest("hex");
}

function explicitPixelEvidence(item) {
  const candidates = [
    ["colorValidation", item.colorValidation],
    ["pixelValidation", item.pixelValidation],
    ["colorContract", item.colorContract],
    ["colorEvidence", item.colorEvidence],
    ["pixelEvidence", item.pixelEvidence],
    ["colorReport", item.colorReport],
    ["pixelReport", item.pixelReport],
    ["outputValidation.color", item.outputValidation?.color],
    ["outputValidation.pixel", item.outputValidation?.pixel],
    ["outputAcceptance.color", item.outputAcceptance?.color],
    ["outputAcceptance.pixel", item.outputAcceptance?.pixel],
    ["validation.color", item.validation?.color],
    ["validation.pixel", item.validation?.pixel],
  ];
  const problems = [];
  const active = [];
  const pixelValues = [];
  const contractValues = [];
  const mainRenderIdentity = canonicalEvidenceIdentity(item.renderIdentity, "renderIdentity");
  const mainRenderIdentityDigest = canonicalRenderIdentityDigest(item.renderIdentity);
  if (mainRenderIdentity == null) problems.push("main renderIdentity is unavailable for color-evidence binding");
  if (!isObject(item.colorValidation)) {
    problems.push("colorValidation evidence is missing");
  } else {
    for (const key of ["pixelPass", "contractPass"]) {
      if (!owns(item.colorValidation, key) || item.colorValidation[key] !== true) {
        problems.push(`colorValidation.${key} must be explicitly boolean true`);
      }
    }
  }
  const identityKeys = new Set([
    "evidenceIdentity", "identity", "artifactIdentity", "reportIdentity", "manifestSha256", "reportSha256",
    "artifactSha256", "evidenceSha256",
    "renderIdentity",
  ]);
  const pixelBooleanKeys = new Set([
    "pixelPass", "pixelsPass", "decodedPixelPass", "colorPass", "expectationMet",
  ]);
  const contractBooleanKeys = new Set(["contractPass"]);
  const scopedPassParent = /pixel|color|contract|gate|validation|evidence|expectation|result|report/i;

  for (const [label, candidate] of candidates) {
    if (!isObject(candidate)) continue;
    const localPixels = [];
    const localContracts = [];
    const localRenderBindings = [];
    const localArtifactIdentities = [];

    function scan(value, path, parentKey, depth) {
      if (Array.isArray(value)) {
        value.forEach((entry, index) => {
          if (Array.isArray(entry) || isObject(entry)) scan(entry, `${path}[${index}]`, parentKey, depth + 1);
        });
        return;
      }
      if (!isObject(value)) return;
      const schemaMarksColorGate = ["kind", "type", "id", "name", "category", "gate"]
        .some((descriptorKey) => typeof value[descriptorKey] === "string"
          && /pixel|color|contract|evidence|expectation|bt709|srgb|range/i.test(value[descriptorKey]));
      for (const [key, child] of Object.entries(value)) {
        const childPath = `${path}.${key}`;
        if (identityKeys.has(key)) {
          const canonical = canonicalEvidenceIdentity(child, key);
          if (canonical == null) problems.push(`${childPath} evidence identity is empty or non-canonical`);
          else if (key === "renderIdentity") localRenderBindings.push({ label: childPath, value: canonical });
          else {
            localArtifactIdentities.push({ label: childPath, value: canonical });
            if (mainRenderIdentityDigest == null || canonical !== mainRenderIdentityDigest) {
              problems.push(`${childPath} is not bound to the main renderIdentity digest`);
            }
          }
        }
        let category = null;
        if (pixelBooleanKeys.has(key)) category = "pixel";
        else if (contractBooleanKeys.has(key)) category = "contract";
        else if (key === "pass" && (depth === 0 || scopedPassParent.test(parentKey) || schemaMarksColorGate)) {
          category = parentKey === "contract" ? "contract" : "pixel";
        }
        if (category != null) {
          if (typeof child !== "boolean") problems.push(`${childPath} is not boolean`);
          else if (category === "contract") localContracts.push({ label: childPath, value: child });
          else localPixels.push({ label: childPath, value: child });
        }
        if (Array.isArray(child) || isObject(child)) scan(child, childPath, key, depth + 1);
      }
    }
    scan(candidate, label, label.split(".").at(-1), 0);
    if (localPixels.length === 0 && localContracts.length === 0) continue;

    const distinctBindings = new Set(localRenderBindings.map((identity) => identity.value));
    if (localRenderBindings.length === 0) {
      problems.push(`${label} is not bound to the main renderIdentity`);
    } else if (distinctBindings.size > 1) {
      problems.push(`${label} contains conflicting renderIdentity bindings`);
    } else if (mainRenderIdentity != null && localRenderBindings[0].value !== mainRenderIdentity) {
      problems.push(`${label} renderIdentity binding differs from the main renderIdentity`);
    }
    const distinctArtifactIdentities = new Set(localArtifactIdentities.map((identity) => identity.value));
    if (distinctArtifactIdentities.size > 1) {
      problems.push(`${label} contains conflicting evidence identities`);
    }
    active.push({
      label,
      renderBinding: localRenderBindings.length > 0 && distinctBindings.size === 1
        ? localRenderBindings[0].value
        : null,
      artifactIdentity: localArtifactIdentities.length > 0 && distinctArtifactIdentities.size === 1
        ? localArtifactIdentities[0].value
        : null,
    });
    pixelValues.push(...localPixels);
    contractValues.push(...localContracts);
  }

  if (active.some((candidate) => candidate.renderBinding == null)) {
    problems.push("every pixel/color evidence source requires a main renderIdentity binding");
  } else if (active.length > 0 && mainRenderIdentity != null
      && active.some((candidate) => candidate.renderBinding !== mainRenderIdentity)) {
    problems.push("pixel/color evidence includes a foreign renderIdentity binding");
  }
  if (active.length > 1 && active.some((candidate) => candidate.artifactIdentity != null)) {
    if (active.some((candidate) => candidate.artifactIdentity == null)) {
      problems.push("repeated pixel/color evidence artifact identities are incomplete");
    } else if (new Set(active.map((candidate) => candidate.artifactIdentity)).size !== 1) {
      problems.push("repeated pixel/color evidence identities conflict");
    }
  }
  if (pixelValues.length === 0) problems.push("decoded pixel/color gate evidence is missing");
  const failedPixels = pixelValues.filter((evidence) => evidence.value === false);
  if (failedPixels.length) {
    problems.push(`decoded pixel/color gate failed: ${failedPixels.map((evidence) => evidence.label).join(", ")}`);
  }
  const failedContracts = contractValues.filter((evidence) => evidence.value === false);
  if (failedContracts.length) {
    problems.push(`decoded color contract gate failed: ${failedContracts.map((evidence) => evidence.label).join(", ")}`);
  }
  return {
    pass: problems.length === 0,
    known: pixelValues.length > 0,
    failed: failedPixels.length > 0 || failedContracts.length > 0,
    problems,
  };
}

function colorGate(item) {
  const stream = videoStream(item);
  const tagFields = ["color_range", "color_space", "color_transfer", "color_primaries"];
  const tagsKnown = stream != null && tagFields.every((key) => owns(stream, key)
    && typeof stream[key] === "string" && stream[key].length > 0);
  const tagsPass = tagsKnown
    && stream.color_range === "tv"
    && stream.color_space === "bt709"
    && stream.color_transfer === "bt709"
    && stream.color_primaries === "bt709";
  const pixelEvidence = explicitPixelEvidence(item);
  const problems = [];
  if (!tagsKnown) problems.push("BT.709 output tags are missing");
  else if (!tagsPass) problems.push("BT.709 output tags do not match tv/bt709/bt709/bt709");
  problems.push(...pixelEvidence.problems);
  let label = "unknown";
  if (tagsKnown && !tagsPass) label = "tag-mismatch";
  else if (tagsPass && !pixelEvidence.known) label = "tags-only";
  else if (tagsPass && pixelEvidence.failed) label = "pixel-fail";
  else if (tagsPass && !pixelEvidence.pass) label = "evidence-conflict";
  else if (tagsPass && pixelEvidence.pass) label = "bt709-tags+pixels";
  return { pass: problems.length === 0, label, problems };
}

function explicitExpectedAudioSamples(item) {
  const candidates = [
    field("decodedAudio.expectedSamplesPerChannel", item.decodedAudio, "expectedSamplesPerChannel"),
    field("audioSampleContract.expectedSamplesPerChannel", item.audioSampleContract, "expectedSamplesPerChannel"),
    field("config.audioSampleContract.expectedSamplesPerChannel", item.config?.audioSampleContract, "expectedSamplesPerChannel"),
  ];
  return numberEvidence(candidates, { integer: true, minimum: 0 });
}

function audioGate(item, frameResult, fps) {
  const problems = [];
  if (!owns(item.config, "mixProjectAudio") || typeof item.config.mixProjectAudio !== "boolean") {
    return { pass: false, label: "unknown", problems: ["explicit audio/no-audio contract is missing"] };
  }
  const streams = Array.isArray(item.probe?.streams)
    ? item.probe.streams.filter((stream) => stream?.codec_type === "audio")
    : [];
  if (item.config.mixProjectAudio === false) {
    if (!owns(item, "decodedAudio") || item.decodedAudio !== null) {
      problems.push("no-audio contract requires decodedAudio: null");
    }
    if (!isObject(item.probe)) problems.push("no-audio contract requires a final probe");
    if (streams.length !== 0) problems.push(`no-audio contract produced ${streams.length} audio stream(s)`);
    return { pass: problems.length === 0, label: problems.length ? "unknown" : "none(explicit)", problems };
  }

  if (streams.length !== 1) problems.push(`PCM contract requires exactly one audio stream, found ${streams.length}`);
  const stream = streams[0] ?? null;
  if (item.config.audioCodec !== STRICT_AUDIO_CODEC) {
    problems.push(`config audio codec ${item.config.audioCodec ?? "missing"}, required ${STRICT_AUDIO_CODEC}`);
  }
  const configuredSampleRate = owns(item.config, "audioSampleRate")
    ? jsonSafeInteger(item.config.audioSampleRate, { minimum: 1 })
    : null;
  if (configuredSampleRate == null) {
    problems.push("config audioSampleRate is missing or invalid");
  }
  const actual = owns(item.decodedAudio, "samplesPerChannel")
    ? jsonSafeInteger(item.decodedAudio.samplesPerChannel)
    : null;
  if (actual == null) problems.push("decoded samplesPerChannel is missing or invalid");
  const decodedFrameCount = owns(item.decodedAudio, "frameCount")
    ? jsonSafeInteger(item.decodedAudio.frameCount, { minimum: 1 })
    : null;
  if (decodedFrameCount == null) {
    problems.push("decoded audio frameCount is missing or invalid");
  }
  const sampleRate = stream && owns(stream, "sample_rate") ? numeric(stream.sample_rate) : null;
  if (!Number.isSafeInteger(sampleRate) || sampleRate <= 0) problems.push("probed audio sample rate is missing or invalid");
  if (Number.isSafeInteger(sampleRate) && Number.isSafeInteger(configuredSampleRate)
      && sampleRate !== configuredSampleRate) {
    problems.push(`probed audio sample rate ${sampleRate} differs from config ${item.config.audioSampleRate}`);
  }
  if (stream && stream.codec_name !== STRICT_AUDIO_CODEC) {
    problems.push(`probed audio codec ${stream.codec_name ?? "missing"}, required ${STRICT_AUDIO_CODEC}`);
  }
  const channels = stream && owns(stream, "channels") ? numeric(stream.channels) : null;
  if (channels !== STRICT_AUDIO_CHANNELS) {
    problems.push(`probed audio channels ${stream?.channels ?? "missing"}, required ${STRICT_AUDIO_CHANNELS}`);
  }
  if (stream?.channel_layout !== STRICT_AUDIO_LAYOUT) {
    problems.push(`probed audio channel_layout ${stream?.channel_layout ?? "missing"}, required ${STRICT_AUDIO_LAYOUT}`);
  }
  const audioStart = stream && owns(stream, "start_time") ? numeric(stream.start_time) : null;
  const startTolerance = Number.isSafeInteger(sampleRate) && sampleRate > 0 ? 1 / sampleRate : 0;
  if (audioStart == null || !approximatelyEqual(audioStart, 0, startTolerance)) {
    problems.push(`probed audio start_time ${stream?.start_time ?? "missing"}, expected 0 within one sample`);
  }
  const expectedDuration = frameResult.requested != null && fps != null
    ? frameResult.requested / fps
    : null;
  const audioDuration = stream && owns(stream, "duration") ? numeric(stream.duration) : null;
  if (audioDuration == null || expectedDuration == null
      || !approximatelyEqual(audioDuration, expectedDuration)) {
    problems.push(`probed audio duration ${stream?.duration ?? "missing"}, expected ${expectedDuration ?? "frames/fps contract"}`);
  }

  let expected = null;
  let schedule = "unknown";
  if (frameResult.requested != null && sampleRate != null && fps != null) {
    const rawExpected = frameResult.requested * sampleRate / fps;
    const nearest = Math.round(rawExpected);
    if (Math.abs(rawExpected - nearest) <= 1e-9) {
      expected = nearest;
      schedule = "integral";
    } else {
      const explicit = explicitExpectedAudioSamples(item);
      const boundaryPolicy = item.audioSampleContract?.boundaryPolicy
        ?? item.config?.audioSampleContract?.boundaryPolicy;
      if (!explicit.known || typeof boundaryPolicy !== "string" || boundaryPolicy.length === 0) {
        problems.push("non-integral audio schedule lacks an explicit expected sample count and boundary policy");
      } else {
        expected = explicit.value;
        schedule = boundaryPolicy;
      }
    }
  } else {
    problems.push("audio sample schedule cannot be derived from completed frames, sample rate, and fps");
  }
  if (actual != null && expected != null && actual !== expected) {
    problems.push(`decoded audio samples ${actual}, expected ${expected}`);
  }
  return {
    pass: problems.length === 0,
    label: actual == null ? "unknown" : `${actual}/${expected ?? "?"} (${schedule})`,
    problems,
  };
}

function atomicGate(item) {
  const commit = item.outputCommit;
  const problems = [];
  if (!isObject(commit)) return { pass: false, problems: ["atomic outputCommit evidence is missing"] };
  if (commit.schemaVersion !== ATOMIC_COMMIT_SCHEMA_VERSION) {
    problems.push(
      `outputCommit.schemaVersion ${commit.schemaVersion ?? "missing"}, expected ${ATOMIC_COMMIT_SCHEMA_VERSION}`,
    );
  }
  if (typeof item.runId !== "string" || !/^[a-z0-9._-]+$/i.test(item.runId)) {
    problems.push("runId is missing or invalid for atomic commit binding");
  }
  if (commit.runId !== item.runId) problems.push("outputCommit.runId differs from the metrics runId");
  const finalOutput = item.config?.output;
  if (typeof finalOutput !== "string" || !isAbsolute(finalOutput) || extname(finalOutput).toLowerCase() !== ".mov") {
    problems.push("config.output must be an absolute final MOV path");
  }
  if (commit.finalOutput !== finalOutput) problems.push("outputCommit.finalOutput differs from config.output");
  if (typeof commit.stagingOutput !== "string" || !isAbsolute(commit.stagingOutput)) {
    problems.push("outputCommit.stagingOutput is missing or not absolute");
  } else {
    if (commit.stagingOutput === finalOutput) problems.push("staging and final output paths are identical");
    if (typeof finalOutput === "string" && dirname(commit.stagingOutput) !== dirname(finalOutput)) {
      problems.push("staging and final output must share a destination filesystem directory");
    }
    if (typeof item.runId === "string" && !basename(commit.stagingOutput).includes(`hf-partial-${item.runId}`)) {
      problems.push("staging output name is not bound to runId");
    }
  }
  const commitRenderIdentity = canonicalEvidenceIdentity(commit.renderIdentity, "renderIdentity");
  const mainRenderIdentity = canonicalEvidenceIdentity(item.renderIdentity, "renderIdentity");
  if (commitRenderIdentity == null || mainRenderIdentity == null || commitRenderIdentity !== mainRenderIdentity) {
    problems.push("outputCommit.renderIdentity is missing or differs from main renderIdentity");
  }
  if (!owns(commit, "committed") || commit.committed !== true) {
    problems.push("final movie was not atomically committed");
  }
  if (!owns(commit, "partialRemoved") || typeof commit.partialRemoved !== "boolean") {
    problems.push("outputCommit.partialRemoved evidence is missing");
  } else if (commit.committed === true && commit.partialRemoved === true) {
    problems.push("outputCommit is internally inconsistent (committed and partialRemoved)");
  }
  return { pass: problems.length === 0, problems };
}

function identityGate(item) {
  const problems = [];
  const identity = {};
  for (const key of ["project", "entry", "assets", "timingBundle"]) {
    const value = item.renderIdentity?.[key];
    if (typeof value !== "string" || !/^[a-f0-9]{64}$/i.test(value)) {
      problems.push(`renderIdentity.${key} SHA-256 identity is missing or invalid`);
    }
    identity[key] = value ?? null;
  }
  return {
    pass: problems.length === 0,
    value: problems.length === 0 ? JSON.stringify(identity) : null,
    problems,
  };
}

function contractGate(item, frameResult, fps) {
  const stream = videoStream(item);
  const config = item.config;
  const problems = [];
  if (!isObject(config)) return { pass: false, value: null, problems: ["config/output contract is missing"] };
  const requiredNumbers = [
    ["width", config.width, true, 1],
    ["height", config.height, true, 1],
    ["startFrame", config.startFrame, true, 0],
    ["bitrate", config.bitrate, false, 1],
  ];
  for (const [name, value, integer, minimum] of requiredNumbers) {
    const parsed = numeric(value);
    if (parsed == null || (integer && !Number.isSafeInteger(parsed)) || parsed < minimum) {
      problems.push(`config.${name} is missing or invalid`);
    }
  }
  if (fps == null) problems.push("rational fps contract is missing or invalid");
  if (!frameResult.requested) problems.push("requested frame contract is missing");
  for (const key of ["outputBackend", "mediaDecoderBackend"]) {
    if (typeof config[key] !== "string" || config[key].length === 0) problems.push(`config.${key} is missing`);
  }
  if (config.outputBackend === "screenshot"
      && (typeof config.screenshotEncoder !== "string" || config.screenshotEncoder.length === 0)) {
    problems.push("screenshot encoder identity is missing");
  }
  if (!stream?.codec_name) problems.push("probed video codec is missing");
  if (!stream?.pix_fmt) problems.push("probed pixel format is missing");
  const audio = audioStream(item);
  const value = {
    width: numeric(config.width),
    height: numeric(config.height),
    fps,
    startFrame: numeric(config.startFrame),
    frames: frameResult.requested,
    bitrate: numeric(config.bitrate),
    bitrateMode: config.bitrateMode ?? null,
    outputBackend: config.outputBackend ?? null,
    decoderBackend: config.mediaDecoderBackend ?? null,
    screenshotEncoder: config.outputBackend === "screenshot" ? config.screenshotEncoder ?? null : null,
    compositeMode: config.compositeMode ?? null,
    mediaTargetMode: config.mediaTargetMode ?? null,
    videoCodec: stream?.codec_name ?? null,
    pixelFormat: stream?.pix_fmt ?? null,
    mixProjectAudio: owns(config, "mixProjectAudio") ? config.mixProjectAudio : null,
    audioCodec: audio?.codec_name ?? null,
    audioSampleRate: audio?.sample_rate == null ? null : numeric(audio.sample_rate),
    audioChannels: audio?.channels == null ? null : numeric(audio.channels),
    audioChannelLayout: audio?.channel_layout ?? null,
    audioStartTime: audio?.start_time == null ? null : numeric(audio.start_time),
    audioDuration: audio?.duration == null ? null : numeric(audio.duration),
  };
  return { pass: problems.length === 0, value, problems };
}

function backendIdentity(item) {
  const output = item.config?.outputBackend;
  if (output === "screenshot") {
    return `screenshot/${item.config?.screenshotEncoder ?? "unknown-encoder"}`;
  }
  return output ?? "unknown";
}

async function loadMetrics(file) {
  let raw;
  try {
    raw = JSON.parse(await readFile(file, "utf8"));
  } catch (error) {
    throw new Error(`${file}: ${error.message}`);
  }
  const final = finalStateGate(raw);
  const fps = ratio(raw.config?.fps);
  const frames = frameGate(raw);
  const probe = probeGate(raw, frames, fps);
  const route = routeGate(raw, frames);
  const productionEvidence = productionEvidenceGate(raw, frames);
  const fallback = fallbackGate(raw);
  const exactPts = exactPtsGate(raw);
  const resources = resourceGate(raw);
  const color = colorGate(raw);
  const audio = audioGate(raw, frames, fps);
  const atomic = atomicGate(raw);
  const identity = identityGate(raw);
  const contract = contractGate(raw, frames, fps);
  const gates = {
    final, probe, frames, route, productionEvidence, fallback, exactPts, resources, color, audio, atomic, identity, contract,
  };
  const problems = Object.entries(gates).flatMap(([name, gate]) => gate.problems.map((problem) => `${name}: ${problem}`));
  const processWallMs = numeric(raw.processWallMs ?? raw.wall_ms ?? raw.wallMs);
  const rendererWallMs = numeric(raw.renderer?.wallMs ?? raw.renderer_wall_ms);
  const effectiveFps = frames.completed != null && rendererWallMs != null && rendererWallMs > 0
    ? frames.completed / (rendererWallMs / 1000)
    : null;
  const peakRssBytes = numeric(
    raw.memoryWatchdog?.peakAggregateRssBytes
      ?? (raw.system_memory_peak_delta_mib == null ? null : Number(raw.system_memory_peak_delta_mib) * 1024 * 1024),
  );
  return {
    raw,
    file: `${basename(dirname(file))}/${basename(file)}`,
    identity: identity.value,
    contract: contract.value == null ? null : JSON.stringify(contract.value),
    routeContract: route.value,
    intrinsicAccepted: problems.length === 0,
    status: final.failed ? "failed" : (problems.length === 0 ? "accepted" : "unverified"),
    problems,
    frames,
    processWallMs,
    rendererWallMs,
    effectiveFps,
    peakRssBytes,
    backend: backendIdentity(raw),
    decoder: raw.config?.mediaDecoderBackend ?? "unknown",
    route: route.label,
    fallback,
    exactPts,
    resources,
    color,
    audio,
  };
}

let metrics;
try {
  metrics = await Promise.all(files.map(loadMetrics));
} catch (error) {
  console.error(error.message);
  process.exit(2);
}

console.table(metrics.map((item) => ({
  file: item.file,
  status: item.status,
  frames: item.frames.label,
  process_s: format(item.processWallMs == null ? null : item.processWallMs / 1000, 2),
  renderer_s: format(item.rendererWallMs == null ? null : item.rendererWallMs / 1000, 2),
  effective_fps: format(item.effectiveFps, 2),
  peak_rss_mib: format(item.peakRssBytes == null ? null : item.peakRssBytes / 1024 / 1024, 1),
  backend: item.backend,
  decoder: item.decoder,
  route: item.route,
  fallback: item.fallback.label,
  exact_pts_err: item.exactPts.label,
  resources: item.resources.label,
  color: item.color.label,
  audio_samples: item.audio.label,
})));

const baseline = metrics[0];
const comparisonProblems = [];
for (const item of metrics) {
  for (const problem of item.problems) comparisonProblems.push(`${item.file}: ${problem}`);
  if (item.identity != null && baseline.identity != null && item.identity !== baseline.identity) {
    comparisonProblems.push(`${item.file}: render identity differs from baseline`);
  }
  if (item.contract != null && baseline.contract != null && item.contract !== baseline.contract) {
    comparisonProblems.push(`${item.file}: final-output/backend contract differs from baseline`);
  }
  if (item.routeContract != null && baseline.routeContract != null
      && item.routeContract !== baseline.routeContract) {
    comparisonProblems.push(`${item.file}: verified route contract differs from baseline`);
  }
}

for (const item of metrics.slice(1)) {
  const comparable = item.intrinsicAccepted
    && baseline.intrinsicAccepted
    && item.identity != null
    && baseline.identity != null
    && item.identity === baseline.identity
    && item.contract != null
    && item.contract === baseline.contract
    && item.routeContract != null
    && item.routeContract === baseline.routeContract;
  if (!comparable || !item.effectiveFps || !baseline.effectiveFps) {
    console.log(`${item.file}: speedup not reported (runs are not proven accepted and comparable)`);
    continue;
  }
  const speedup = item.effectiveFps / baseline.effectiveFps;
  console.log(`${item.file}: ${format(speedup, 3)}x vs ${baseline.file} (${format((speedup - 1) * 100, 1)}%)`);
}

if (comparisonProblems.length) {
  console.error(strict ? "Strict comparison rejected:" : "Comparison is unverified:");
  for (const problem of [...new Set(comparisonProblems)]) console.error(`- ${problem}`);
}
if (strict && comparisonProblems.length) process.exit(1);
