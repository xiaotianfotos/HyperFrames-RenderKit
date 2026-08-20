import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
  createReadStream,
  existsSync,
  readFileSync,
  statSync,
} from "node:fs";
import {
  basename,
  isAbsolute,
  relative,
  resolve,
  sep,
} from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export const MEDIA_SOURCE_MAP_KIND = "hyperframes-hidden-decoder-source-map";
export const MEDIA_SOURCE_MAP_SCHEMA_VERSION = 1;
export const CFR_TARGET_IDS = Object.freeze(["video_008", "video_009", "video_014"]);
export const CFR_FPS = 60;

const TARGET_ID_SET = new Set(CFR_TARGET_IDS);

function normalizePathForManifest(value) {
  return value.split(sep).join("/");
}

function assertObject(value, description) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${description} must be an object`);
  }
}

function assertFingerprint(value, description) {
  assertObject(value, description);
  if (!Number.isSafeInteger(value.size) || value.size < 0) {
    throw new Error(`${description}.size must be a non-negative safe integer`);
  }
  if (typeof value.mtimeNs !== "string" || !/^\d+$/.test(value.mtimeNs)) {
    throw new Error(`${description}.mtimeNs must be an integer string`);
  }
  if (typeof value.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(value.sha256)) {
    throw new Error(`${description}.sha256 must be a lowercase SHA-256 digest`);
  }
}

export function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => (
      `${JSON.stringify(key)}:${stableJson(value[key])}`
    )).join(",")}}`;
  }
  return JSON.stringify(value);
}

export function sha256Text(value) {
  return createHash("sha256").update(value).digest("hex");
}

export function projectFile(projectRoot, projectRelativePath, description = "path") {
  if (typeof projectRelativePath !== "string" || !projectRelativePath.trim()) {
    throw new Error(`${description} must be a non-empty project-relative path`);
  }
  if (isAbsolute(projectRelativePath)) {
    throw new Error(`${description} must be relative to projectRoot: ${projectRelativePath}`);
  }
  const root = resolve(projectRoot);
  const absolute = resolve(root, projectRelativePath);
  const relativePath = relative(root, absolute);
  if (!relativePath || relativePath === ".." || relativePath.startsWith(`..${sep}`) || isAbsolute(relativePath)) {
    throw new Error(`${description} escapes projectRoot: ${projectRelativePath}`);
  }
  return absolute;
}

export function projectRelativePath(projectRoot, absolutePath) {
  const root = resolve(projectRoot);
  const absolute = resolve(absolutePath);
  const relativePath = relative(root, absolute);
  if (!relativePath || relativePath === ".." || relativePath.startsWith(`..${sep}`) || isAbsolute(relativePath)) {
    throw new Error(`Path is outside projectRoot: ${absolute}`);
  }
  return normalizePathForManifest(relativePath);
}

export async function sha256File(filePath) {
  const hash = createHash("sha256");
  await new Promise((resolveHash, rejectHash) => {
    const stream = createReadStream(filePath);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.once("error", rejectHash);
    stream.once("end", resolveHash);
  });
  return hash.digest("hex");
}

export async function fingerprintFile(filePath) {
  const before = statSync(filePath, { bigint: true });
  if (!before.isFile()) throw new Error(`Not a regular file: ${filePath}`);
  const size = Number(before.size);
  if (!Number.isSafeInteger(size)) throw new Error(`File is too large to fingerprint safely: ${filePath}`);
  const sha256 = await sha256File(filePath);
  const after = statSync(filePath, { bigint: true });
  if (before.size !== after.size || before.mtimeNs !== after.mtimeNs) {
    throw new Error(`File changed while being fingerprinted: ${filePath}`);
  }
  return {
    size,
    mtimeNs: String(before.mtimeNs),
    sha256,
  };
}

export function statFingerprint(filePath) {
  const stat = statSync(filePath, { bigint: true });
  if (!stat.isFile()) throw new Error(`Not a regular file: ${filePath}`);
  const size = Number(stat.size);
  if (!Number.isSafeInteger(size)) throw new Error(`File is too large to fingerprint safely: ${filePath}`);
  return { size, mtimeNs: String(stat.mtimeNs) };
}

export function fingerprintsEqual(left, right, includeHash = true) {
  return Boolean(left && right
    && left.size === right.size
    && left.mtimeNs === right.mtimeNs
    && (!includeHash || left.sha256 === right.sha256));
}

export async function verifyFingerprint(filePath, expected, verifyMode, description) {
  if (!existsSync(filePath)) throw new Error(`${description} is missing: ${filePath}`);
  const before = statFingerprint(filePath);
  if (verifyMode === "stat" && !fingerprintsEqual(before, expected, false)) {
    throw new Error(
      `${description} stat changed (expected ${expected.size} bytes @ ${expected.mtimeNs}, `
      + `got ${before.size} bytes @ ${before.mtimeNs}): ${filePath}`,
    );
  }
  if (verifyMode === "sha256") {
    if (before.size !== expected.size) {
      throw new Error(`${description} size changed (expected ${expected.size}, got ${before.size}): ${filePath}`);
    }
    const actualHash = await sha256File(filePath);
    const after = statFingerprint(filePath);
    if (!fingerprintsEqual(before, after, false)) {
      throw new Error(`${description} changed while SHA-256 was being verified: ${filePath}`);
    }
    if (actualHash !== expected.sha256) {
      throw new Error(`${description} SHA-256 changed: ${filePath}`);
    }
  }
}

function parseAttribute(tag, name) {
  const match = tag.match(new RegExp(`\\b${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, "i"));
  return match ? (match[1] ?? match[2] ?? match[3]) : null;
}

function decodeHtmlAttribute(value) {
  return value
    .replaceAll("&amp;", "&")
    .replaceAll("&quot;", "\"")
    .replaceAll("&#39;", "'")
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">");
}

function targetIdForSource(source) {
  let pathName = source;
  try {
    pathName = new URL(source, "file:///").pathname;
  } catch {
    // The caller will report a more useful URL/path error later.
  }
  let fileName = basename(decodeURIComponent(pathName)).toLowerCase();
  const queryIndex = fileName.search(/[?#]/);
  if (queryIndex >= 0) fileName = fileName.slice(0, queryIndex);
  return CFR_TARGET_IDS.find((id) => (
    fileName === id || fileName.startsWith(`${id}.`) || fileName.startsWith(`${id}-`) || fileName.startsWith(`${id}_`)
  )) ?? null;
}

export function findCfrTargetSources({ projectRoot, entryPath }) {
  const root = resolve(projectRoot);
  const entry = resolve(entryPath);
  const html = readFileSync(entry, "utf8");
  const entryUrl = pathToFileURL(entry);
  const byId = new Map();
  for (const tag of html.matchAll(/<video\b[^>]*>/gi)) {
    const rawSource = parseAttribute(tag[0], "src");
    if (!rawSource) continue;
    const source = decodeHtmlAttribute(rawSource);
    const id = targetIdForSource(source);
    if (!id) continue;
    const sourceUrl = new URL(source, entryUrl);
    if (sourceUrl.protocol !== "file:") {
      throw new Error(`${id} must use a local file source, got ${sourceUrl.href}`);
    }
    const absolutePath = fileURLToPath(sourceUrl);
    const relativePath = projectRelativePath(root, absolutePath);
    const previous = byId.get(id);
    if (previous && previous.source !== relativePath) {
      throw new Error(`${id} resolves to multiple source files: ${previous.source}, ${relativePath}`);
    }
    byId.set(id, { id, source: relativePath, absolutePath, htmlSource: source });
  }
  const missing = CFR_TARGET_IDS.filter((id) => !byId.has(id));
  if (missing.length) {
    throw new Error(`Composition is missing CFR cache targets: ${missing.join(", ")}`);
  }
  return CFR_TARGET_IDS.map((id) => byId.get(id));
}

export function ratioValue(value) {
  const [numerator, denominator = "1"] = String(value ?? "0").split("/");
  return Number(numerator) / Number(denominator);
}

function runProcess(command, args) {
  return new Promise((resolveProcess, rejectProcess) => {
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.once("error", rejectProcess);
    child.once("close", (code) => {
      if (code === 0) resolveProcess({ stdout, stderr });
      else rejectProcess(new Error(`${command} exited ${code}: ${stderr}`));
    });
  });
}

export async function commandVersion(command) {
  const result = await runProcess(command, ["-version"]);
  return result.stdout.split(/\r?\n/, 1)[0].trim();
}

export async function ffmpegHasEncoder(ffmpeg, encoder) {
  const result = await runProcess(ffmpeg, ["-hide_banner", "-encoders"]);
  return result.stdout.split(/\s+/).includes(encoder);
}

export async function probeMedia(ffprobe, filePath) {
  const result = await runProcess(ffprobe, [
    "-v", "error", "-count_frames",
    "-show_entries",
    "format=duration,size:stream=index,codec_type,codec_name,pix_fmt,width,height,r_frame_rate,avg_frame_rate,nb_read_frames,duration,start_time,time_base",
    "-of", "json", filePath,
  ]);
  const parsed = JSON.parse(result.stdout);
  const video = parsed.streams?.find((stream) => stream.codec_type === "video") ?? null;
  return {
    formatDuration: parsed.format?.duration ?? null,
    formatSize: parsed.format?.size ?? null,
    audioStreams: parsed.streams?.filter((stream) => stream.codec_type === "audio").length ?? 0,
    video: video ? {
      codecName: video.codec_name ?? null,
      pixelFormat: video.pix_fmt ?? null,
      width: video.width ?? null,
      height: video.height ?? null,
      rFrameRate: video.r_frame_rate ?? null,
      avgFrameRate: video.avg_frame_rate ?? null,
      nbReadFrames: video.nb_read_frames ?? null,
      duration: video.duration ?? null,
      startTime: video.start_time ?? null,
      timeBase: video.time_base ?? null,
    } : null,
  };
}

export async function auditCfrFrameTimeline(ffprobe, filePath) {
  const result = await runProcess(ffprobe, [
    "-v", "error", "-select_streams", "v:0",
    "-show_entries", "stream=time_base:frame=best_effort_timestamp,best_effort_timestamp_time",
    "-of", "json", filePath,
  ]);
  const parsed = JSON.parse(result.stdout);
  const timeBase = parsed.streams?.[0]?.time_base ?? null;
  const [timeBaseNumerator, timeBaseDenominator] = String(timeBase ?? "0/0").split("/").map(Number);
  const stepTicksValue = timeBaseNumerator > 0 && timeBaseDenominator > 0
    ? timeBaseDenominator / timeBaseNumerator / CFR_FPS
    : Number.NaN;
  const stepTicks = Number.isInteger(stepTicksValue) ? BigInt(stepTicksValue) : null;
  const frames = parsed.frames ?? [];
  let firstTimestamp = null;
  let lastTimestamp = null;
  let maxGridErrorTicks = 0n;
  let firstMismatch = null;

  for (const [frameIndex, frame] of frames.entries()) {
    const rawTimestamp = frame.best_effort_timestamp;
    let timestamp = null;
    try {
      if (rawTimestamp != null && /^-?\d+$/.test(String(rawTimestamp))) timestamp = BigInt(rawTimestamp);
    } catch {
      timestamp = null;
    }
    if (frameIndex === 0 && timestamp != null) firstTimestamp = timestamp;
    if (timestamp != null) lastTimestamp = timestamp;
    if (timestamp == null || stepTicks == null) {
      firstMismatch ??= {
        frameIndex,
        timestamp: rawTimestamp ?? null,
        expectedTimestamp: stepTicks == null ? null : String(BigInt(frameIndex) * stepTicks),
      };
      continue;
    }
    const expectedTimestamp = BigInt(frameIndex) * stepTicks;
    const difference = timestamp >= expectedTimestamp
      ? timestamp - expectedTimestamp
      : expectedTimestamp - timestamp;
    if (difference > maxGridErrorTicks) maxGridErrorTicks = difference;
    if (difference !== 0n && !firstMismatch) {
      firstMismatch = {
        frameIndex,
        timestamp: String(timestamp),
        expectedTimestamp: String(expectedTimestamp),
      };
    }
  }

  return {
    gridFps: CFR_FPS,
    timeBase,
    frameCount: frames.length,
    expectedStepTicks: stepTicks == null ? null : Number(stepTicks),
    firstTimestamp: firstTimestamp == null ? null : String(firstTimestamp),
    lastTimestamp: lastTimestamp == null ? null : String(lastTimestamp),
    startsAtZero: firstTimestamp === 0n,
    onGrid: frames.length > 0 && firstMismatch == null,
    maxGridErrorTicks: String(maxGridErrorTicks),
    firstMismatch,
  };
}

export async function auditSourceFrameTimeline(ffprobe, filePath) {
  const result = await runProcess(ffprobe, [
    "-v", "error", "-select_streams", "v:0",
    "-show_entries", "stream=time_base:frame=best_effort_timestamp,best_effort_timestamp_time",
    "-of", "json", filePath,
  ]);
  const parsed = JSON.parse(result.stdout);
  const timeBase = parsed.streams?.[0]?.time_base ?? null;
  const [timeBaseNumerator, timeBaseDenominator] = String(timeBase ?? "0/0").split("/").map(Number);
  const validTimeBase = Number.isInteger(timeBaseNumerator)
    && Number.isInteger(timeBaseDenominator)
    && timeBaseNumerator > 0
    && timeBaseDenominator > 0;
  const frames = parsed.frames ?? [];
  const gridToleranceSeconds = 0.000_001;
  const firstGridIndices = [];
  let firstTimestamp = null;
  let firstGridErrorSeconds = null;
  let lastTimestamp = null;
  let lastGridIndex = null;
  let maxGridErrorSeconds = 0;
  let missingGridFrames = 0;
  let maxGapFrames = 0;
  let firstMismatch = null;
  let strictlyIncreasing = true;

  for (const [frameIndex, frame] of frames.entries()) {
    const rawTimestamp = frame.best_effort_timestamp;
    const timestamp = rawTimestamp == null ? Number.NaN : Number(rawTimestamp);
    if (frameIndex === 0) firstTimestamp = rawTimestamp == null ? null : String(rawTimestamp);
    if (rawTimestamp != null) lastTimestamp = String(rawTimestamp);
    if (!validTimeBase || !Number.isSafeInteger(timestamp)) {
      firstMismatch ??= { frameIndex, timestamp: rawTimestamp ?? null, reason: "invalid timestamp/time base" };
      continue;
    }
    const timestampSeconds = timestamp * timeBaseNumerator / timeBaseDenominator;
    const gridPosition = timestampSeconds * CFR_FPS;
    const gridIndex = Math.round(gridPosition);
    const gridErrorSeconds = Math.abs(gridPosition - gridIndex) / CFR_FPS;
    if (frameIndex === 0) firstGridErrorSeconds = gridErrorSeconds;
    maxGridErrorSeconds = Math.max(maxGridErrorSeconds, gridErrorSeconds);
    if (firstGridIndices.length < 8) firstGridIndices.push(gridIndex);
    if (gridErrorSeconds > gridToleranceSeconds) {
      firstMismatch ??= {
        frameIndex,
        timestamp: String(rawTimestamp),
        timestampTime: frame.best_effort_timestamp_time ?? null,
        gridPosition,
        nearestGridIndex: gridIndex,
        reason: "timestamp is off the 1/60 grid",
      };
    }
    if (lastGridIndex != null) {
      const gap = gridIndex - lastGridIndex;
      if (gap <= 0) {
        strictlyIncreasing = false;
        firstMismatch ??= {
          frameIndex,
          timestamp: String(rawTimestamp),
          gridIndex,
          previousGridIndex: lastGridIndex,
          reason: "grid indices are not strictly increasing",
        };
      } else {
        missingGridFrames += Math.max(0, gap - 1);
        maxGapFrames = Math.max(maxGapFrames, gap - 1);
      }
    }
    lastGridIndex = gridIndex;
  }

  const firstGridIndex = firstGridIndices[0] ?? null;
  return {
    gridFps: CFR_FPS,
    gridToleranceSeconds,
    timeBase,
    frameCount: frames.length,
    firstTimestamp,
    lastTimestamp,
    firstGridIndex,
    lastGridIndex,
    firstGridIndices,
    startsAtZero: firstTimestamp === "0"
      && firstGridIndex === 0
      && firstGridErrorSeconds != null
      && firstGridErrorSeconds <= gridToleranceSeconds,
    onGrid: frames.length > 0 && firstMismatch == null,
    strictlyIncreasing,
    missingGridFrames,
    maxGapFrames,
    maxGridErrorSeconds,
    firstMismatch,
  };
}

export function validateSourceTimelineAudit(audit, expectedFrameCount = null) {
  const issues = [];
  if (!audit || typeof audit !== "object") return ["source timeline audit is missing"];
  if (audit.gridFps !== CFR_FPS) issues.push(`source grid fps is ${audit.gridFps}`);
  if (!Number.isInteger(audit.frameCount) || audit.frameCount <= 0) {
    issues.push(`source timeline frame count is ${audit.frameCount}`);
  }
  if (expectedFrameCount != null && Number(expectedFrameCount) !== audit.frameCount) {
    issues.push(`source timeline has ${audit.frameCount} frames, probe reports ${expectedFrameCount}`);
  }
  if (!audit.startsAtZero || audit.firstGridIndex !== 0) {
    issues.push(
      `source timeline starts at timestamp ${audit.firstTimestamp}, grid index ${audit.firstGridIndex}`,
    );
  }
  if (!audit.onGrid || audit.firstMismatch != null) {
    const mismatch = audit.firstMismatch
      ? ` at frame ${audit.firstMismatch.frameIndex}: ${audit.firstMismatch.reason}`
      : "";
    issues.push(`source timestamps are not on the 1/60 grid${mismatch}`);
  }
  if (!audit.strictlyIncreasing) issues.push("source grid indices are not strictly increasing");
  return issues;
}

export function validateCfrTimelineAudit(audit, expectedFrameCount = null) {
  const issues = [];
  if (!audit || typeof audit !== "object") return ["cache timeline audit is missing"];
  if (audit.gridFps !== CFR_FPS) issues.push(`timeline grid fps is ${audit.gridFps}`);
  if (audit.timeBase !== "1/60000") issues.push(`timeline time_base is ${audit.timeBase}`);
  if (!Number.isInteger(audit.frameCount) || audit.frameCount <= 0) {
    issues.push(`timeline frame count is ${audit.frameCount}`);
  }
  if (expectedFrameCount != null && Number(expectedFrameCount) !== audit.frameCount) {
    issues.push(`timeline has ${audit.frameCount} frames, probe reports ${expectedFrameCount}`);
  }
  if (audit.expectedStepTicks !== 1000) issues.push(`timeline step is ${audit.expectedStepTicks} ticks`);
  if (!audit.startsAtZero || audit.firstTimestamp !== "0") {
    issues.push(`timeline first timestamp is ${audit.firstTimestamp}`);
  }
  if (!audit.onGrid || audit.maxGridErrorTicks !== "0" || audit.firstMismatch != null) {
    const mismatch = audit.firstMismatch
      ? ` at frame ${audit.firstMismatch.frameIndex} (${audit.firstMismatch.timestamp} != ${audit.firstMismatch.expectedTimestamp})`
      : "";
    issues.push(`timeline timestamps are not on the 1/60 grid${mismatch}`);
  }
  if (Number.isInteger(audit.frameCount) && audit.frameCount > 0) {
    const expectedLast = String((audit.frameCount - 1) * 1000);
    if (audit.lastTimestamp !== expectedLast) {
      issues.push(`timeline last timestamp is ${audit.lastTimestamp}, expected ${expectedLast}`);
    }
  }
  return issues;
}

export function validateCfrCacheProbe(cacheProbe, sourceProbe) {
  const issues = [];
  const cacheVideo = cacheProbe?.video;
  const sourceVideo = sourceProbe?.video;
  if (!cacheVideo) return ["cache has no video stream"];
  if (!sourceVideo) issues.push("source has no video stream");
  if (cacheVideo.codecName !== "h264") issues.push(`cache codec is ${cacheVideo.codecName}`);
  if (cacheVideo.pixelFormat !== "yuv420p" && cacheVideo.pixelFormat !== "nv12") {
    issues.push(`cache pixel format is ${cacheVideo.pixelFormat}`);
  }
  if (Math.abs(ratioValue(cacheVideo.rFrameRate) - CFR_FPS) > 0.000_001) {
    issues.push(`cache r_frame_rate is ${cacheVideo.rFrameRate}`);
  }
  if (Math.abs(ratioValue(cacheVideo.avgFrameRate) - CFR_FPS) > 0.000_001) {
    issues.push(`cache avg_frame_rate is ${cacheVideo.avgFrameRate}`);
  }
  if (cacheVideo.timeBase !== "1/60000") issues.push(`cache time_base is ${cacheVideo.timeBase}`);
  if (cacheVideo.startTime != null && Math.abs(Number(cacheVideo.startTime)) > 1 / 60000) {
    issues.push(`cache start_time is ${cacheVideo.startTime}`);
  }
  if (!Number.isInteger(Number(cacheVideo.nbReadFrames)) || Number(cacheVideo.nbReadFrames) <= 0) {
    issues.push(`cache frame count is ${cacheVideo.nbReadFrames}`);
  }
  if (cacheProbe.audioStreams !== 0) issues.push(`cache has ${cacheProbe.audioStreams} audio stream(s)`);
  if (sourceVideo && (cacheVideo.width !== sourceVideo.width || cacheVideo.height !== sourceVideo.height)) {
    issues.push(
      `cache resolution ${cacheVideo.width}x${cacheVideo.height} differs from source `
      + `${sourceVideo.width}x${sourceVideo.height}`,
    );
  }
  const cacheDurationValue = cacheVideo.duration ?? cacheProbe.formatDuration;
  const sourceDurationValue = sourceVideo?.duration ?? sourceProbe?.formatDuration;
  const cacheDuration = cacheDurationValue == null ? Number.NaN : Number(cacheDurationValue);
  const sourceDuration = sourceDurationValue == null ? Number.NaN : Number(sourceDurationValue);
  if (Number.isFinite(cacheDuration) && Number.isFinite(sourceDuration)
      && Math.abs(cacheDuration - sourceDuration) > 2 / CFR_FPS + 0.001) {
    issues.push(`cache duration ${cacheDuration} differs from source ${sourceDuration}`);
  }
  if (Number.isFinite(cacheDuration) && Number.isInteger(Number(cacheVideo.nbReadFrames))) {
    const frameDuration = Number(cacheVideo.nbReadFrames) / CFR_FPS;
    if (Math.abs(frameDuration - cacheDuration) > 1 / CFR_FPS + 0.001) {
      issues.push(`cache duration ${cacheDuration} does not match ${cacheVideo.nbReadFrames} frames at 60fps`);
    }
  }
  return issues;
}

export function createCfrRecipe({ encoder, device = "/dev/dri/renderD128", ffmpegVersion }) {
  if (encoder !== "vaapi" && encoder !== "libx264") throw new Error(`Unsupported encoder: ${encoder}`);
  const recipe = {
    schemaVersion: 2,
    purpose: "Normalize selected VFR browser decoder inputs to frame-indexed CFR60",
    fps: CFR_FPS,
    videoCodec: "h264",
    pixelFormat: "yuv420p",
    gop: 60,
    bFrames: 0,
    encoder,
    quality: encoder === "vaapi" ? { rcMode: "CQP", qp: 18, quality: 1, asyncDepth: 8 } : { crf: 18, preset: "fast" },
    device: encoder === "vaapi" ? device : null,
    hardwareDeviceName: encoder === "vaapi" ? "va" : null,
    fpsFilter: "fps=60:start_time=0:round=up:eof_action=round",
    videoTrackTimescale: 60000,
    colorMetadata: "bt709",
    ffmpegVersion,
  };
  return { ...recipe, key: sha256Text(stableJson(recipe)) };
}

export function buildCfrFfmpegArgs({ recipe, sourcePath, outputPath }) {
  const args = ["-hide_banner", "-loglevel", "warning", "-y"];
  if (recipe.encoder === "vaapi") {
    args.push(
      "-init_hw_device", `vaapi=${recipe.hardwareDeviceName}:${recipe.device}`,
      "-filter_hw_device", recipe.hardwareDeviceName,
      "-hwaccel", "vaapi",
      "-hwaccel_device", recipe.hardwareDeviceName,
      "-hwaccel_output_format", "vaapi",
    );
  }
  args.push("-i", sourcePath, "-map", "0:v:0", "-an");
  if (recipe.encoder === "vaapi") {
    args.push(
      "-vf", `${recipe.fpsFilter},scale_vaapi=format=nv12`,
      "-c:v", "h264_vaapi",
      "-profile:v", "high", "-level:v", "5.2",
      "-rc_mode", "CQP", "-qp", String(recipe.quality.qp),
      "-quality", String(recipe.quality.quality),
      "-async_depth", String(recipe.quality.asyncDepth),
    );
  } else {
    args.push(
      "-vf", `${recipe.fpsFilter},format=yuv420p`,
      "-c:v", "libx264",
      "-profile:v", "high", "-level:v", "5.2",
      "-crf", String(recipe.quality.crf), "-preset", recipe.quality.preset,
    );
  }
  args.push(
    "-g", String(recipe.gop), "-bf", String(recipe.bFrames),
    "-fps_mode", "passthrough",
    "-video_track_timescale", String(recipe.videoTrackTimescale),
    "-color_primaries", "bt709", "-color_trc", "bt709", "-colorspace", "bt709",
    "-movflags", "+faststart",
    outputPath,
  );
  return args;
}

export function validateManifestShape(manifest) {
  assertObject(manifest, "manifest");
  if (manifest.kind !== MEDIA_SOURCE_MAP_KIND) throw new Error(`Unexpected manifest kind: ${manifest.kind}`);
  if (manifest.schemaVersion !== MEDIA_SOURCE_MAP_SCHEMA_VERSION) {
    throw new Error(`Unsupported manifest schemaVersion: ${manifest.schemaVersion}`);
  }
  assertObject(manifest.recipe, "manifest.recipe");
  if (manifest.recipe.fps !== CFR_FPS || manifest.recipe.videoCodec !== "h264") {
    throw new Error("Manifest recipe must describe H.264 CFR60 caches");
  }
  if (typeof manifest.recipe.key !== "string" || !/^[a-f0-9]{64}$/.test(manifest.recipe.key)) {
    throw new Error("manifest.recipe.key must be a SHA-256 digest");
  }
  const { key: recipeKey, ...recipeBody } = manifest.recipe;
  if (sha256Text(stableJson(recipeBody)) !== recipeKey) {
    throw new Error("manifest.recipe.key does not match the recorded recipe");
  }
  if (!Array.isArray(manifest.entries)) throw new Error("manifest.entries must be an array");
  const ids = new Set();
  const sources = new Set();
  for (const [index, entry] of manifest.entries.entries()) {
    assertObject(entry, `manifest.entries[${index}]`);
    if (!TARGET_ID_SET.has(entry.id)) throw new Error(`Unexpected cache target: ${entry.id}`);
    if (ids.has(entry.id)) throw new Error(`Duplicate cache target: ${entry.id}`);
    if (typeof entry.source !== "string" || typeof entry.cache !== "string") {
      throw new Error(`Manifest entry ${entry.id} must contain source and cache paths`);
    }
    if (sources.has(entry.source)) throw new Error(`Duplicate mapped source: ${entry.source}`);
    if (entry.source === entry.cache) throw new Error(`Source and cache paths are identical for ${entry.id}`);
    if (entry.recipeKey !== manifest.recipe.key) throw new Error(`Recipe key mismatch for ${entry.id}`);
    assertFingerprint(entry.sourceFingerprint, `${entry.id}.sourceFingerprint`);
    assertFingerprint(entry.cacheFingerprint, `${entry.id}.cacheFingerprint`);
    const sourceTimelineIssues = validateSourceTimelineAudit(
      entry.sourceTimeline,
      entry.sourceMedia?.video?.nbReadFrames,
    );
    if (sourceTimelineIssues.length) {
      throw new Error(`${entry.id} source timeline is invalid: ${sourceTimelineIssues.join("; ")}`);
    }
    const probeIssues = validateCfrCacheProbe(entry.cacheMedia, entry.sourceMedia);
    if (probeIssues.length) throw new Error(`${entry.id} cache metadata is invalid: ${probeIssues.join("; ")}`);
    const timelineIssues = validateCfrTimelineAudit(
      entry.cacheTimeline,
      entry.cacheMedia?.video?.nbReadFrames,
    );
    if (timelineIssues.length) {
      throw new Error(`${entry.id} cache timeline is invalid: ${timelineIssues.join("; ")}`);
    }
    ids.add(entry.id);
    sources.add(entry.source);
  }
  const missing = CFR_TARGET_IDS.filter((id) => !ids.has(id));
  if (missing.length) throw new Error(`Manifest is missing cache targets: ${missing.join(", ")}`);
  return manifest;
}

export function readMediaSourceMapManifest(manifestPath) {
  let manifest;
  try {
    manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  } catch (error) {
    throw new Error(`Cannot read media source map ${manifestPath}: ${error.message}`);
  }
  return validateManifestShape(manifest);
}

export async function loadAndVerifyMediaSourceMap({
  manifestPath,
  projectRoot,
  verifyMode = "stat",
}) {
  if (verifyMode !== "stat" && verifyMode !== "sha256") {
    throw new Error(`mediaSourceMap verify mode must be stat or sha256, got ${verifyMode}`);
  }
  const absoluteManifestPath = resolve(manifestPath);
  const manifest = readMediaSourceMapManifest(absoluteManifestPath);
  const entries = [];
  for (const entry of manifest.entries) {
    const sourcePath = projectFile(projectRoot, entry.source, `${entry.id}.source`);
    const cachePath = projectFile(projectRoot, entry.cache, `${entry.id}.cache`);
    await verifyFingerprint(sourcePath, entry.sourceFingerprint, verifyMode, `${entry.id} source`);
    await verifyFingerprint(cachePath, entry.cacheFingerprint, verifyMode, `${entry.id} cache`);
    entries.push({
      id: entry.id,
      source: entry.source,
      cache: entry.cache,
      sourceUrl: pathToFileURL(sourcePath).href,
      cacheUrl: pathToFileURL(cachePath).href,
      recipeKey: entry.recipeKey,
      frameRate: manifest.recipe.fps,
    });
  }
  return {
    path: absoluteManifestPath,
    verifyMode,
    recipe: manifest.recipe,
    entries,
  };
}

export function defaultManifestPath(projectRoot, cacheDirectory = ".render-cache/cfr60") {
  return resolve(projectRoot, cacheDirectory, "media-source-map.json");
}

export function cachePathForTarget(projectRoot, cacheDirectory, id, sourceHash = null, recipeKey = null) {
  const variant = sourceHash && recipeKey
    ? `.${sourceHash.slice(0, 12)}.${recipeKey.slice(0, 12)}`
    : "";
  return resolve(projectRoot, cacheDirectory, `${id}${variant}.cfr60.h264.mp4`);
}
