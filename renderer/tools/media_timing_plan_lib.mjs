import { execFile, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { realpath, stat } from "node:fs/promises";
import { createInterface } from "node:readline";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export const MEDIA_TIMING_PLAN_KIND = "hyperframes-media-timing-plan";
export const MEDIA_TIMING_PLAN_SCHEMA_VERSION = 1;

const expandedPtsCache = new WeakMap();
const keyframeCache = new WeakMap();

function assertObject(value, name) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${name} must be an object`);
  }
}

function asSafeInteger(value, name) {
  const number = Number(value);
  if (!Number.isSafeInteger(number)) {
    throw new Error(`${name} is not a safe integer: ${value}`);
  }
  return number;
}

function asOptionalNumber(value) {
  if (value === undefined || value === null || value === "N/A") return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function asOptionalSafeInteger(value, name) {
  if (value === undefined || value === null || value === "N/A" || value === "") return null;
  return asSafeInteger(value, name);
}

function hasTimestamp(value) {
  return value !== undefined && value !== null && value !== "N/A" && value !== "";
}

export function parseRatio(value, name = "ratio") {
  const match = String(value ?? "").match(/^(-?\d+)\/(-?\d+)$/);
  if (!match) throw new Error(`${name} must be an integer ratio, got ${value}`);
  const numerator = asSafeInteger(match[1], `${name} numerator`);
  const denominator = asSafeInteger(match[2], `${name} denominator`);
  if (denominator === 0) throw new Error(`${name} denominator must not be zero`);
  return { numerator, denominator };
}

export function ratioToNumber(value) {
  const { numerator, denominator } = parseRatio(value);
  return numerator / denominator;
}

export function ticksToSeconds(ticks, timeBase) {
  const { numerator, denominator } = parseRatio(timeBase, "timeBase");
  if (numerator <= 0 || denominator <= 0) throw new Error(`timeBase must be positive, got ${timeBase}`);
  return ticks * numerator / denominator;
}

export function secondsToTicksFloor(seconds, timeBase) {
  if (!Number.isFinite(seconds)) throw new Error(`seconds must be finite, got ${seconds}`);
  const { numerator, denominator } = parseRatio(timeBase, "timeBase");
  if (numerator <= 0 || denominator <= 0) throw new Error(`timeBase must be positive, got ${timeBase}`);
  const unrounded = seconds * denominator / numerator;
  // JS arithmetic can produce 599.9999999999999 for an exact media-grid
  // boundary. The tolerance is far below a timestamp tick and cannot jump a
  // genuinely earlier target across the next frame boundary.
  const tolerance = Math.max(1, Math.abs(unrounded)) * Number.EPSILON * 8;
  return Math.floor(unrounded + tolerance);
}

function deltaRuns(values) {
  if (values.length < 2) return [];
  const runs = [];
  let previous = values[0];
  let delta = values[1] - previous;
  let count = 0;
  for (let index = 1; index < values.length; index += 1) {
    const nextDelta = values[index] - previous;
    if (nextDelta <= 0) {
      throw new Error(`Presentation PTS must be strictly increasing at frame ${index}`);
    }
    if (nextDelta === delta) {
      count += 1;
    } else {
      runs.push([delta, count]);
      delta = nextDelta;
      count = 1;
    }
    previous = values[index];
  }
  runs.push([delta, count]);
  return runs;
}

function encodePts(ptsTicks) {
  const runs = deltaRuns(ptsTicks);
  if (ptsTicks.length <= 1 || runs.length === 1) {
    return {
      kind: "linear",
      firstPtsTicks: ptsTicks[0],
      stepTicks: runs[0]?.[0] ?? null,
    };
  }
  const deltas = [];
  for (const [delta, count] of runs) {
    for (let index = 0; index < count; index += 1) deltas.push(delta);
  }
  const rle = {
    kind: "delta-rle",
    firstPtsTicks: ptsTicks[0],
    deltaRuns: runs,
  };
  const plain = {
    kind: "delta",
    firstPtsTicks: ptsTicks[0],
    deltas,
  };
  return JSON.stringify(rle).length <= JSON.stringify(plain).length ? rle : plain;
}

function encodeIndexDeltas(indices) {
  let previous = 0;
  return indices.map((index, position) => {
    const value = position === 0 ? index : index - previous;
    previous = index;
    return value;
  });
}

function decodeIndexDeltas(values) {
  let index = 0;
  return values.map((value, position) => {
    index = position === 0 ? value : index + value;
    return index;
  });
}

export function expandPresentationPts(plan) {
  validateTimingPlan(plan);
  const cached = expandedPtsCache.get(plan);
  if (cached) return cached;

  const { frameCount, pts } = plan.presentation;
  let expanded;
  if (pts.kind === "linear") {
    expanded = Array.from({ length: frameCount }, (_, index) => (
      pts.firstPtsTicks + index * (pts.stepTicks ?? 0)
    ));
  } else if (pts.kind === "delta-rle") {
    expanded = [pts.firstPtsTicks];
    let current = pts.firstPtsTicks;
    for (const [delta, count] of pts.deltaRuns) {
      for (let index = 0; index < count; index += 1) {
        current += delta;
        expanded.push(current);
      }
    }
  } else {
    expanded = [pts.firstPtsTicks];
    let current = pts.firstPtsTicks;
    for (const delta of pts.deltas) {
      current += delta;
      expanded.push(current);
    }
  }
  if (expanded.length !== frameCount) {
    throw new Error(`PTS encoding expands to ${expanded.length} frames, expected ${frameCount}`);
  }
  expandedPtsCache.set(plan, expanded);
  return expanded;
}

export function keyframeIndices(plan) {
  validateTimingPlan(plan);
  const cached = keyframeCache.get(plan);
  if (cached) return cached;
  const decoded = decodeIndexDeltas(plan.presentation.keyframes.indexDeltas);
  keyframeCache.set(plan, decoded);
  return decoded;
}

export function validateTimingPlan(plan) {
  assertObject(plan, "plan");
  if (plan.kind !== MEDIA_TIMING_PLAN_KIND) throw new Error(`Unsupported plan kind: ${plan.kind}`);
  if (plan.schemaVersion !== MEDIA_TIMING_PLAN_SCHEMA_VERSION) {
    throw new Error(`Unsupported plan schema version: ${plan.schemaVersion}`);
  }
  assertObject(plan.source, "plan.source");
  assertObject(plan.source.stat, "plan.source.stat");
  if (!Number.isSafeInteger(plan.source.stat.size) || plan.source.stat.size < 0) {
    throw new Error("plan.source.stat.size must be a non-negative safe integer");
  }
  if (typeof plan.source.stat.mtimeNs !== "string" || !/^\d+$/.test(plan.source.stat.mtimeNs)) {
    throw new Error("plan.source.stat.mtimeNs must be an integer string");
  }
  if (typeof plan.source.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(plan.source.sha256)) {
    throw new Error("plan.source.sha256 must be a lowercase SHA-256 digest");
  }
  if (typeof plan.source.identity !== "string" || !/^[a-f0-9]{64}$/.test(plan.source.identity)) {
    throw new Error("plan.source.identity must be a lowercase SHA-256 digest");
  }
  assertObject(plan.stream, "plan.stream");
  if (!Number.isSafeInteger(plan.stream.index) || plan.stream.index < 0) {
    throw new Error("plan.stream.index must be a non-negative safe integer");
  }
  const expectedIdentity = createHash("sha256")
    .update(`${plan.source.stat.size}:${plan.source.sha256}:stream:${plan.stream.index}`)
    .digest("hex");
  if (plan.source.identity !== expectedIdentity) {
    throw new Error("plan.source.identity does not match source fingerprint and stream index");
  }
  const parsedTimeBase = parseRatio(plan.stream.timeBase, "plan.stream.timeBase");
  if (parsedTimeBase.numerator <= 0 || parsedTimeBase.denominator <= 0) {
    throw new Error("plan.stream.timeBase must be positive");
  }
  assertObject(plan.timeline, "plan.timeline");
  if (!Number.isSafeInteger(plan.timeline.presentationOriginTicks)) {
    throw new Error("plan.timeline.presentationOriginTicks must be a safe integer");
  }
  assertObject(plan.presentation, "plan.presentation");
  const {
    frameCount,
    firstPtsTicks,
    lastPtsTicks,
    lastFrameDurationTicks,
    displayEndTicks,
    pts,
    keyframes,
  } = plan.presentation;
  if (!Number.isSafeInteger(frameCount) || frameCount < 1) {
    throw new Error("plan.presentation.frameCount must be a positive safe integer");
  }
  if (!Number.isSafeInteger(firstPtsTicks) || !Number.isSafeInteger(lastPtsTicks)) {
    throw new Error("plan presentation PTS bounds must be safe integers");
  }
  if (!Number.isSafeInteger(lastFrameDurationTicks) || lastFrameDurationTicks <= 0) {
    throw new Error("plan.presentation.lastFrameDurationTicks must be a positive safe integer");
  }
  if (!Number.isSafeInteger(displayEndTicks) || displayEndTicks !== lastPtsTicks + lastFrameDurationTicks) {
    throw new Error("plan.presentation.displayEndTicks must equal lastPtsTicks + lastFrameDurationTicks");
  }
  if (typeof plan.presentation.lastFrameDurationSource !== "string"
      || !plan.presentation.lastFrameDurationSource) {
    throw new Error("plan.presentation.lastFrameDurationSource must be recorded");
  }
  assertObject(pts, "plan.presentation.pts");
  if (pts.firstPtsTicks !== firstPtsTicks) throw new Error("PTS origin does not match firstPtsTicks");
  let encodedLastPts = firstPtsTicks;
  if (pts.kind === "linear") {
    if (frameCount > 1 && (!Number.isSafeInteger(pts.stepTicks) || pts.stepTicks <= 0)) {
      throw new Error("linear PTS stepTicks must be positive when frameCount > 1");
    }
    encodedLastPts += (frameCount - 1) * (pts.stepTicks ?? 0);
  } else if (pts.kind === "delta-rle") {
    if (!Array.isArray(pts.deltaRuns) || pts.deltaRuns.some((run) => (
      !Array.isArray(run) || run.length !== 2
      || !Number.isSafeInteger(run[0]) || run[0] <= 0
      || !Number.isSafeInteger(run[1]) || run[1] <= 0
    ))) {
      throw new Error("delta-rle PTS must contain positive [deltaTicks,count] runs");
    }
    const deltaCount = pts.deltaRuns.reduce((sum, run) => sum + run[1], 0);
    if (deltaCount !== frameCount - 1) {
      throw new Error(`delta-rle contains ${deltaCount} deltas, expected ${frameCount - 1}`);
    }
    encodedLastPts += pts.deltaRuns.reduce((sum, [delta, count]) => sum + delta * count, 0);
  } else if (pts.kind === "delta") {
    if (!Array.isArray(pts.deltas) || pts.deltas.some((delta) => (
      !Number.isSafeInteger(delta) || delta <= 0
    ))) {
      throw new Error("delta PTS must contain positive timestamp deltas");
    }
    if (pts.deltas.length !== frameCount - 1) {
      throw new Error(`delta PTS contains ${pts.deltas.length} deltas, expected ${frameCount - 1}`);
    }
    encodedLastPts += pts.deltas.reduce((sum, delta) => sum + delta, 0);
  } else {
    throw new Error(`Unsupported PTS encoding: ${pts.kind}`);
  }
  if (!Number.isSafeInteger(encodedLastPts) || encodedLastPts !== lastPtsTicks) {
    throw new Error(`PTS encoding ends at ${encodedLastPts}, expected ${lastPtsTicks}`);
  }
  assertObject(keyframes, "plan.presentation.keyframes");
  if (!Array.isArray(keyframes.indexDeltas)) throw new Error("keyframe indexDeltas must be an array");
  const decodedKeys = decodeIndexDeltas(keyframes.indexDeltas);
  if (keyframes.count !== decodedKeys.length) {
    throw new Error(`keyframe count is ${keyframes.count}, expected ${decodedKeys.length}`);
  }
  if (decodedKeys.some((index, position) => (
    !Number.isSafeInteger(index) || index < 0 || index >= frameCount
    || (position > 0 && index <= decodedKeys[position - 1])
  ))) {
    throw new Error("keyframe indexDeltas do not decode to increasing in-range indices");
  }
  return plan;
}

export function presentationPtsFromFrames(frames, streamIndex) {
  const videoFrames = frames
    .filter((frame) => frame.media_type === undefined || frame.media_type === "video")
    .filter((frame) => frame.stream_index === undefined || Number(frame.stream_index) === streamIndex);
  if (!videoFrames.length) throw new Error("ffprobe found no decoded video frames");
  const rows = videoFrames.map((frame, decodeOrdinal) => {
    const rawPts = hasTimestamp(frame.best_effort_timestamp)
      ? frame.best_effort_timestamp
      : (hasTimestamp(frame.pts) ? frame.pts : null);
    if (!hasTimestamp(rawPts)) {
      throw new Error(`Decoded frame ${decodeOrdinal} has no presentation PTS`);
    }
    return {
      ptsTicks: asSafeInteger(rawPts, `frame ${decodeOrdinal} presentation PTS`),
      durationTicks: asOptionalSafeInteger(
        frame.pkt_duration ?? frame.duration,
        `frame ${decodeOrdinal} duration`,
      ),
      keyFrame: Number(frame.key_frame ?? 0) === 1,
      pictType: frame.pict_type ?? "?",
    };
  }).sort((left, right) => left.ptsTicks - right.ptsTicks);

  const uniqueRows = [];
  for (const row of rows) {
    const prior = uniqueRows.at(-1);
    if (prior?.ptsTicks === row.ptsTicks) {
      throw new Error(`Two displayed frames share presentation PTS ${row.ptsTicks}`);
    }
    uniqueRows.push(row);
  }
  if (!uniqueRows.length) throw new Error("ffprobe found no displayed video frames with a PTS");
  return uniqueRows;
}

export function presentationPtsFromPackets(packets, streamIndex) {
  const videoPackets = packets.filter((packet) => (
    packet.stream_index === undefined || Number(packet.stream_index) === streamIndex
  ));
  if (!videoPackets.length) throw new Error("ffprobe found no video packets");
  const rows = videoPackets.map((packet, packetOrdinal) => {
    if (packet.pts === undefined || packet.pts === null || packet.pts === "N/A" || packet.pts === "") {
      throw new Error(`Video packet ${packetOrdinal} has no presentation PTS`);
    }
    return {
      ptsTicks: asSafeInteger(packet.pts, `packet ${packetOrdinal} presentation PTS`),
      durationTicks: asOptionalSafeInteger(packet.duration, `packet ${packetOrdinal} duration`),
      keyFrame: String(packet.flags ?? "").includes("K"),
      pictType: "?",
    };
  }).sort((left, right) => left.ptsTicks - right.ptsTicks);
  for (let index = 1; index < rows.length; index += 1) {
    if (rows[index].ptsTicks === rows[index - 1].ptsTicks) {
      throw new Error(`Two video packets share presentation PTS ${rows[index].ptsTicks}`);
    }
  }
  return rows;
}

export function parseEditListTrace(trace, streamIndex = 0) {
  const atomDetected = /type:'elst'\s+parent:'edts'/.test(trace);
  const trackEditCounts = [...trace.matchAll(/track\[(\d+)\]\.edit_count\s*=\s*(\d+)/g)].map((match) => ({
    trackIndex: Number(match[1]),
    editCount: Number(match[2]),
  }));
  const entries = [...trace.matchAll(
    /Processing st:\s*(\d+),\s*edit list\s*(\d+)\s*-\s*media time:\s*(-?\d+),\s*duration:\s*(\d+)/g,
  )]
    .map((match) => ({
      streamIndex: Number(match[1]),
      editIndex: Number(match[2]),
      mediaTime: match[3],
      duration: match[4],
    }))
    .filter((entry) => entry.streamIndex === streamIndex);
  return {
    detected: entries.length > 0 || (atomDetected && trackEditCounts.some((entry) => entry.editCount > 0)),
    atomDetected,
    trackEditCounts,
    entries,
    policy: "diagnostic-only; displayed PTS are post-demux and remain authoritative",
  };
}

export function buildTimingPlan({
  sourcePath,
  sourceStat,
  sourceSha256,
  ffprobeVersion,
  probe,
  editListTrace = "",
  presentationRows = null,
  timestampSource = null,
  timestampAudit = null,
}) {
  const videoStream = probe.streams?.find((stream) => stream.codec_type === "video");
  if (!videoStream) throw new Error("ffprobe found no video stream");
  const streamIndex = Number(videoStream.index);
  const rows = presentationRows ?? presentationPtsFromFrames(probe.frames ?? [], streamIndex);
  const ptsTicks = rows.map((row) => row.ptsTicks);
  const encodedPts = encodePts(ptsTicks);
  const keyframes = rows.flatMap((row, index) => row.keyFrame ? [index] : []);
  const frameTypes = rows.reduce((counts, row) => {
    counts[row.pictType] = (counts[row.pictType] ?? 0) + 1;
    return counts;
  }, {});
  const timeBase = videoStream.time_base;
  parseRatio(timeBase, "video stream time_base");
  const firstPtsTicks = ptsTicks[0];
  const lastPtsTicks = ptsTicks.at(-1);
  const explicitLastDuration = rows.at(-1)?.durationTicks;
  const streamDurationTicks = asOptionalSafeInteger(videoStream.duration_ts, "stream duration_ts");
  let lastFrameDurationTicks = explicitLastDuration && explicitLastDuration > 0
    ? explicitLastDuration
    : null;
  let lastFrameDurationSource = lastFrameDurationTicks == null ? null : "packet-or-frame-duration";
  if (lastFrameDurationTicks == null && streamDurationTicks != null
      && streamDurationTicks - lastPtsTicks > 0) {
    lastFrameDurationTicks = streamDurationTicks - lastPtsTicks;
    lastFrameDurationSource = "stream-duration-minus-last-pts";
  }
  if (lastFrameDurationTicks == null && ptsTicks.length > 1) {
    lastFrameDurationTicks = ptsTicks.at(-1) - ptsTicks.at(-2);
    lastFrameDurationSource = "previous-presentation-delta";
  }
  if (lastFrameDurationTicks == null || lastFrameDurationTicks <= 0) {
    throw new Error("Cannot establish the final displayed frame duration");
  }
  const displayEndTicks = lastPtsTicks + lastFrameDurationTicks;
  const streamStartPts = videoStream.start_pts === undefined || videoStream.start_pts === "N/A"
    ? null
    : asSafeInteger(videoStream.start_pts, "stream start_pts");
  const hasBFrames = Number(videoStream.has_b_frames ?? 0);
  const sourceIdentity = createHash("sha256")
    .update(`${sourceStat.size}:${sourceSha256}:stream:${streamIndex}`)
    .digest("hex");
  const deltas = ptsTicks.slice(1).map((pts, index) => pts - ptsTicks[index]);
  let minimumDelta = null;
  let maximumDelta = null;
  for (const delta of deltas) {
    minimumDelta = minimumDelta === null ? delta : Math.min(minimumDelta, delta);
    maximumDelta = maximumDelta === null ? delta : Math.max(maximumDelta, delta);
  }

  const plan = {
    kind: MEDIA_TIMING_PLAN_KIND,
    schemaVersion: MEDIA_TIMING_PLAN_SCHEMA_VERSION,
    source: {
      path: sourcePath,
      stat: sourceStat,
      sha256: sourceSha256,
      identity: sourceIdentity,
    },
    probe: {
      ffprobeVersion,
      scannedAt: new Date().toISOString(),
      timestampSource: timestampSource ?? (presentationRows ? "prevalidated-rows" : "decoded-frame-pts"),
      presentationRows: rows.length,
      ...(timestampAudit ? { timestampAudit } : {}),
    },
    stream: {
      index: streamIndex,
      codec: videoStream.codec_name ?? null,
      profile: videoStream.profile ?? null,
      width: asOptionalNumber(videoStream.width),
      height: asOptionalNumber(videoStream.height),
      pixelFormat: videoStream.pix_fmt ?? null,
      timeBase,
      nominalFrameRate: videoStream.r_frame_rate ?? null,
      averageFrameRate: videoStream.avg_frame_rate ?? null,
      startPtsTicks: streamStartPts,
      startTimeSeconds: asOptionalNumber(videoStream.start_time),
      hasBFrames,
      decodeOrderReordered: hasBFrames > 0 || (frameTypes.B ?? 0) > 0,
      timestampPolicy: "presentation PTS only; DTS and decode order must not select displayed frames",
    },
    timeline: {
      presentationOriginTicks: firstPtsTicks,
      presentationOriginSeconds: ticksToSeconds(firstPtsTicks, timeBase),
      nonZeroOrigin: firstPtsTicks !== 0,
      streamStartDiffTicks: streamStartPts === null ? null : firstPtsTicks - streamStartPts,
      mediaRelativePolicy: "media-relative target 0 maps to first displayed presentation PTS",
      editList: parseEditListTrace(editListTrace, streamIndex),
    },
    presentation: {
      frameCount: ptsTicks.length,
      firstPtsTicks,
      lastPtsTicks,
      firstPtsSeconds: ticksToSeconds(firstPtsTicks, timeBase),
      lastPtsSeconds: ticksToSeconds(lastPtsTicks, timeBase),
      lastFrameDurationTicks,
      lastFrameDurationSeconds: ticksToSeconds(lastFrameDurationTicks, timeBase),
      lastFrameDurationSource,
      displayEndTicks,
      displayEndSeconds: ticksToSeconds(displayEndTicks, timeBase),
      classification: encodedPts.kind === "linear" ? "cfr-integer-grid" : "vfr-or-discontinuous",
      pts: encodedPts,
      deltaStats: deltas.length ? {
        minTicks: minimumDelta,
        maxTicks: maximumDelta,
        runCount: encodedPts.kind === "linear"
          ? 1
          : (encodedPts.kind === "delta-rle" ? encodedPts.deltaRuns.length : encodedPts.deltas.length),
      } : null,
      keyframes: {
        encoding: "index-delta",
        count: keyframes.length,
        indexDeltas: encodeIndexDeltas(keyframes),
      },
      frameTypes,
    },
  };
  return validateTimingPlan(plan);
}

async function sha256File(filePath) {
  const hash = createHash("sha256");
  await new Promise((resolveHash, rejectHash) => {
    const stream = createReadStream(filePath);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.once("error", rejectHash);
    stream.once("end", resolveHash);
  });
  return hash.digest("hex");
}

async function sourceStat(filePath) {
  const info = await stat(filePath, { bigint: true });
  if (!info.isFile()) throw new Error(`Source is not a regular file: ${filePath}`);
  const size = Number(info.size);
  if (!Number.isSafeInteger(size)) throw new Error(`Source is too large to fingerprint safely: ${filePath}`);
  return { size, mtimeNs: String(info.mtimeNs) };
}

async function runFfprobe(ffprobePath, args, maxBuffer = 512 * 1024 * 1024) {
  const result = await execFileAsync(ffprobePath, args, {
    encoding: "utf8",
    maxBuffer,
    windowsHide: true,
  });
  return result;
}

function parseCompactRow(line) {
  const row = {};
  for (const token of line.split("|")) {
    const split = token.indexOf("=");
    if (split <= 0) continue;
    row[token.slice(0, split)] = token.slice(split + 1);
  }
  return row;
}

async function streamFfprobeRows(ffprobePath, args) {
  const child = spawn(ffprobePath, args, { stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
  const exitPromise = new Promise((resolveExit, rejectExit) => {
    child.once("error", rejectExit);
    child.once("close", resolveExit);
  });
  const rows = [];
  let stderr = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  const lines = createInterface({ input: child.stdout, crlfDelay: Number.POSITIVE_INFINITY });
  for await (const line of lines) {
    if (line.trim()) rows.push(parseCompactRow(line));
  }
  const code = await exitPromise;
  if (code !== 0) throw new Error(`${ffprobePath} exited ${code}: ${stderr}`);
  return rows;
}

function declaredFrameCount(stream) {
  const value = stream?.nb_frames;
  if (value == null || value === "N/A" || value === "") return null;
  const count = Number(value);
  return Number.isSafeInteger(count) && count > 0 ? count : null;
}

export const PACKET_PTS_FAST_PATH_CONTRACT =
  "iso-bmff-progressive-avc-hevc-sample-is-one-access-unit-v1";

const ISO_BMFF_AVC_HEVC_TAGS = new Map([
  ["h264", new Set(["avc1", "avc3"])],
  ["hevc", new Set(["hvc1", "hev1"])],
]);

/**
 * Packet PTS are not presentation-frame PTS in the general case. In
 * particular, VP9 superframes and AV1 temporal units can contain more than one
 * displayed frame. The only packet shortcut accepted here is the narrow
 * ISO-BMFF AVC/HEVC sample contract: a progressive video sample is one coded
 * access unit, and the demuxer's sample count agrees with the declared frame
 * count. Every packet is still validated after this metadata gate.
 */
export function auditPacketPtsFastPath(probe) {
  const videoStream = probe?.streams?.find((stream) => stream.codec_type === "video");
  if (!videoStream) throw new Error("ffprobe found no video stream");
  const codec = String(videoStream.codec_name ?? "").toLowerCase();
  const codecTag = String(videoStream.codec_tag_string ?? "").toLowerCase();
  const formatName = String(probe?.format?.format_name ?? "");
  const formatNames = new Set(formatName.split(",").map((value) => value.trim()).filter(Boolean));
  const expectedFrames = declaredFrameCount(videoStream);
  const packetCountValue = Number(videoStream.nb_read_packets);
  const packetCount = Number.isSafeInteger(packetCountValue) && packetCountValue > 0
    ? packetCountValue
    : null;
  const reasons = [];
  const allowedTags = ISO_BMFF_AVC_HEVC_TAGS.get(codec);

  if (!allowedTags) {
    reasons.push(`codec ${codec || "unknown"} has no audited one-packet/one-frame contract`);
  } else if (!allowedTags.has(codecTag)) {
    reasons.push(`codec tag ${codecTag || "unknown"} is not an audited ${codec} ISO-BMFF sample entry`);
  }
  if (!(formatNames.has("mov") && formatNames.has("mp4"))) {
    reasons.push(`demuxer ${formatName || "unknown"} is not the audited ISO-BMFF family`);
  }
  if (videoStream.field_order !== "progressive") {
    reasons.push(`field order ${videoStream.field_order ?? "unknown"} is not explicitly progressive`);
  }
  const extradataSize = Number(videoStream.extradata_size);
  if (!Number.isSafeInteger(extradataSize) || extradataSize <= 0) {
    reasons.push("AVC/HEVC decoder configuration record is unavailable");
  }
  if (Number(videoStream.start_pts) !== 0
      || !Number.isFinite(Number(videoStream.start_time))
      || Math.abs(Number(videoStream.start_time)) > 1e-9) {
    reasons.push(`stream origin is start_pts=${videoStream.start_pts}, start_time=${videoStream.start_time}`);
  }
  // Older ffprobe builds omit newer zero-valued disposition fields. The
  // audited AVC/HEVC sample-entry tags already exclude layered sample-entry
  // families, so an omitted flag is equivalent to its FFmpeg default (zero).
  if (Number(videoStream.disposition?.attached_pic ?? 0) !== 0) {
    reasons.push("attached-picture disposition is not explicitly disabled");
  }
  if (Number(videoStream.disposition?.multilayer ?? 0) !== 0) {
    reasons.push("multilayer disposition is not explicitly disabled");
  }
  if (expectedFrames == null) reasons.push("stream nb_frames is unavailable");
  if (packetCount == null) reasons.push("stream nb_read_packets is unavailable");
  if (expectedFrames != null && packetCount != null && packetCount !== expectedFrames) {
    reasons.push(`nb_read_packets ${packetCount} does not equal nb_frames ${expectedFrames}`);
  }

  return {
    contract: PACKET_PTS_FAST_PATH_CONTRACT,
    eligible: reasons.length === 0,
    codec,
    codecTag,
    formatName,
    fieldOrder: videoStream.field_order ?? null,
    expectedFrames,
    packetCount,
    reasons,
  };
}

function presentationRowsFromAuditedPackets(packets, streamIndex, expectedFrames) {
  if (packets.length !== expectedFrames) {
    throw new Error(`packet scan returned ${packets.length} rows, declared frame count is ${expectedFrames}`);
  }
  for (const [packetOrdinal, packet] of packets.entries()) {
    const size = Number(packet.size);
    if (!Number.isSafeInteger(size) || size <= 0) {
      throw new Error(`Video packet ${packetOrdinal} has no positive encoded size`);
    }
    const duration = asOptionalSafeInteger(packet.duration, `packet ${packetOrdinal} duration`);
    if (duration == null || duration <= 0) {
      throw new Error(`Video packet ${packetOrdinal} has no positive presentation duration`);
    }
    const flags = String(packet.flags ?? "");
    if (flags.includes("C") || flags.includes("D")) {
      throw new Error(`Video packet ${packetOrdinal} is corrupt or discard-only (flags=${flags})`);
    }
  }
  const rows = presentationPtsFromPackets(packets, streamIndex);
  if (rows.length !== expectedFrames) {
    throw new Error(`packet PTS produced ${rows.length} frames, expected ${expectedFrames}`);
  }
  return rows;
}

export async function scanMediaTiming(source, { ffprobePath = "ffprobe" } = {}) {
  const sourcePath = await realpath(source);
  const before = await sourceStat(sourcePath);
  const [hash, versionResult, streamResult, traceResult] = await Promise.all([
    sha256File(sourcePath),
    runFfprobe(ffprobePath, ["-version"], 1024 * 1024),
    runFfprobe(ffprobePath, [
      "-v", "error", "-count_packets",
      "-select_streams", "v:0",
      "-show_streams",
      "-show_format",
      "-show_entries",
      "stream=index,codec_type,codec_name,codec_tag_string,profile,width,height,pix_fmt,field_order,"
        + "time_base,r_frame_rate,avg_frame_rate,start_pts,start_time,duration_ts,duration,has_b_frames,"
        + "nb_frames,nb_read_packets,extradata_size:stream_disposition=attached_pic,multilayer:format=format_name",
      "-of", "json",
      sourcePath,
    ], 8 * 1024 * 1024),
    runFfprobe(ffprobePath, [
      // debug prints FFmpeg's applied edit-list entries but avoids trace's
      // per-packet AVIndex dump, which can be huge for long-form sources.
      "-v", "debug",
      "-select_streams", "v:0",
      "-show_entries", "stream=index",
      "-of", "json",
      sourcePath,
    ], 16 * 1024 * 1024),
  ]);
  const ffprobeVersion = versionResult.stdout.split(/\r?\n/, 1)[0].trim();
  const probe = JSON.parse(streamResult.stdout);
  const videoStream = probe.streams?.find((stream) => stream.codec_type === "video");
  if (!videoStream) throw new Error("ffprobe found no video stream");
  const expectedFrames = declaredFrameCount(videoStream);
  const packetAudit = auditPacketPtsFastPath(probe);
  let presentationRows = null;
  let timestampSource = null;
  let packetFallbackReason = packetAudit.reasons.join("; ") || null;
  let packetValidationError = null;

  if (packetAudit.eligible) {
    try {
      const packets = await streamFfprobeRows(ffprobePath, [
        "-v", "error", "-select_streams", "v:0",
        "-show_packets",
        "-show_entries", "packet=stream_index,pts,duration,size,flags",
        "-of", "compact=p=0:nk=0",
        sourcePath,
      ]);
      presentationRows = presentationRowsFromAuditedPackets(
        packets,
        Number(videoStream.index),
        expectedFrames,
      );
      timestampSource = "packet-pts-iso-bmff-access-unit-verified";
    } catch (error) {
      packetValidationError = error.message;
      packetFallbackReason = `packet validation failed: ${error.message}`;
    }
  }

  if (!presentationRows) {
    const decodedFrames = await streamFfprobeRows(ffprobePath, [
      "-v", "error", "-select_streams", "v:0",
      "-show_frames",
      "-show_entries",
      "frame=media_type,stream_index,key_frame,pts,best_effort_timestamp,pict_type,pkt_duration,duration",
      "-of", "compact=p=0:nk=0",
      sourcePath,
    ]);
    presentationRows = presentationPtsFromFrames(decodedFrames, Number(videoStream.index));
    timestampSource = `decoded-frame-pts-fallback: ${packetFallbackReason ?? "packet contract unavailable"}`;
  }

  const after = await sourceStat(sourcePath);
  if (before.size !== after.size || before.mtimeNs !== after.mtimeNs) {
    throw new Error(`Source changed while its timing plan was scanned: ${sourcePath}`);
  }

  return buildTimingPlan({
    sourcePath,
    sourceStat: after,
    sourceSha256: hash,
    ffprobeVersion,
    probe,
    editListTrace: traceResult.stderr,
    presentationRows,
    timestampSource,
    timestampAudit: {
      packetContract: packetAudit.contract,
      packetMetadataEligible: packetAudit.eligible,
      selectedPath: timestampSource.startsWith("packet-pts-") ? "packet-pts" : "decoded-frame-pts",
      codec: packetAudit.codec,
      codecTag: packetAudit.codecTag,
      formatName: packetAudit.formatName,
      fieldOrder: packetAudit.fieldOrder,
      declaredFrameCount: packetAudit.expectedFrames,
      packetCount: packetAudit.packetCount,
      decodedFrameCount: timestampSource.startsWith("decoded-frame-") ? presentationRows.length : null,
      countMismatch: expectedFrames == null ? null : presentationRows.length !== expectedFrames,
      rejectionReasons: packetAudit.reasons,
      packetValidationError,
    },
  });
}

export async function verifyTimingPlanSource(plan, source = plan.source.path, { mode = "stat" } = {}) {
  validateTimingPlan(plan);
  const sourcePath = await realpath(source);
  const actualStat = await sourceStat(sourcePath);
  if (actualStat.size !== plan.source.stat.size) {
    return { valid: false, reason: "size", sourcePath, actualStat };
  }
  if (mode === "stat") {
    const valid = actualStat.mtimeNs === plan.source.stat.mtimeNs;
    return { valid, reason: valid ? null : "mtime", sourcePath, actualStat };
  }
  if (mode !== "hash") throw new Error(`Unsupported verification mode: ${mode}`);
  const actualSha256 = await sha256File(sourcePath);
  const valid = actualSha256 === plan.source.sha256;
  return { valid, reason: valid ? null : "sha256", sourcePath, actualStat, actualSha256 };
}

function absoluteTargetTicks(plan, rawTargetTicks, timeline) {
  if (!Number.isSafeInteger(rawTargetTicks)) {
    throw new Error(`rawTargetTicks must be a safe integer, got ${rawTargetTicks}`);
  }
  if (timeline === "media-relative") {
    return plan.timeline.presentationOriginTicks + rawTargetTicks;
  }
  if (timeline === "stream-absolute") return rawTargetTicks;
  throw new Error(`Unsupported target timeline: ${timeline}`);
}

function frameAtOrBeforeTicksUnchecked(plan, rawTargetTicks, timeline, expandedVfrPts = null) {
  const targetPtsTicks = absoluteTargetTicks(plan, rawTargetTicks, timeline);
  const { frameCount, firstPtsTicks, lastPtsTicks, displayEndTicks, pts } = plan.presentation;
  if (targetPtsTicks < firstPtsTicks) return null;

  let frameIndex;
  let lookup;
  if (pts.kind === "linear") {
    frameIndex = pts.stepTicks === null
      ? 0
      : Math.floor((targetPtsTicks - pts.firstPtsTicks) / pts.stepTicks);
    frameIndex = Math.min(frameCount - 1, frameIndex);
    lookup = "cfr-integer-fast-path";
  } else {
    const expanded = expandedVfrPts ?? expandPresentationPts(plan);
    let low = 0;
    let high = expanded.length - 1;
    while (low <= high) {
      const middle = (low + high) >>> 1;
      if (expanded[middle] <= targetPtsTicks) low = middle + 1;
      else high = middle - 1;
    }
    frameIndex = Math.max(0, high);
    lookup = "vfr-binary-search";
  }
  const ptsTicks = pts.kind === "linear"
    ? pts.firstPtsTicks + frameIndex * (pts.stepTicks ?? 0)
    : (expandedVfrPts ?? expandPresentationPts(plan))[frameIndex];
  const mediaRelativePtsTicks = ptsTicks - plan.timeline.presentationOriginTicks;
  return {
    sourceIdentity: plan.source.identity,
    streamIndex: plan.stream.index,
    timeline,
    rawTargetTicks,
    targetPtsTicks,
    frameIndex,
    ptsTicks,
    ptsSeconds: ticksToSeconds(ptsTicks, plan.stream.timeBase),
    mediaRelativePtsTicks,
    mediaRelativeSeconds: ticksToSeconds(mediaRelativePtsTicks, plan.stream.timeBase),
    lookup,
    atOrAfterLastPts: targetPtsTicks >= lastPtsTicks,
    pastDisplayEnd: targetPtsTicks >= displayEndTicks,
    displayEndTicks,
    displayEndSeconds: ticksToSeconds(displayEndTicks, plan.stream.timeBase),
  };
}

export function frameAtOrBeforeTicks(plan, rawTargetTicks, { timeline = "media-relative" } = {}) {
  validateTimingPlan(plan);
  return frameAtOrBeforeTicksUnchecked(plan, rawTargetTicks, timeline);
}

export function frameAtOrBefore(plan, rawTargetSeconds, { timeline = "media-relative" } = {}) {
  const targetTicks = secondsToTicksFloor(rawTargetSeconds, plan.stream.timeBase);
  return frameAtOrBeforeTicks(plan, targetTicks, { timeline });
}

export function samePresentationFrame(previous, next) {
  return Boolean(previous && next
    && previous.sourceIdentity === next.sourceIdentity
    && previous.streamIndex === next.streamIndex
    && previous.ptsTicks === next.ptsTicks);
}

export function createTimingPlanQuery(plan, { timeline = "media-relative" } = {}) {
  validateTimingPlan(plan);
  // VFR expansion happens once when a renderer opens the source. CFR keeps no
  // frame table at all and stays integer arithmetic only.
  const expandedVfrPts = plan.presentation.pts.kind !== "linear"
    ? expandPresentationPts(plan)
    : null;
  return Object.freeze({
    plan,
    timeline,
    atOrBeforeTicks(rawTargetTicks) {
      return frameAtOrBeforeTicksUnchecked(plan, rawTargetTicks, timeline, expandedVfrPts);
    },
    atOrBefore(rawTargetSeconds) {
      const rawTargetTicks = secondsToTicksFloor(rawTargetSeconds, plan.stream.timeBase);
      return frameAtOrBeforeTicksUnchecked(plan, rawTargetTicks, timeline, expandedVfrPts);
    },
    sameFrame: samePresentationFrame,
  });
}

export function precedingKeyframe(plan, frameIndex) {
  if (!Number.isSafeInteger(frameIndex) || frameIndex < 0 || frameIndex >= plan.presentation.frameCount) {
    throw new Error(`frameIndex is out of range: ${frameIndex}`);
  }
  const indices = keyframeIndices(plan);
  let low = 0;
  let high = indices.length - 1;
  while (low <= high) {
    const middle = (low + high) >>> 1;
    if (indices[middle] <= frameIndex) low = middle + 1;
    else high = middle - 1;
  }
  return high < 0 ? null : indices[high];
}
