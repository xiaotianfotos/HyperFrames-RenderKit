import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import {
  closeSync,
  createReadStream,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, extname, resolve } from "node:path";

export const MANIFEST_KIND = "canonical-media-fallback-cache";
export const MANIFEST_SCHEMA_VERSION = 2;
export const TOOL_CONTRACT_VERSION = 3;
export const BIT_DEPTH_POLICY_10_TO_8 = "bt709-limited-yuv420p10-to-yuv420p8-zscale-error-diffusion";
export const COLOR_POLICY_UNTAGGED_BT709_LIMITED = "explicit-untagged-sdr-bt709-limited";

const MAX_TIMESCALE = 2_000_000_000n;
const HDR_TRANSFERS = new Set(["smpte2084", "arib-std-b67"]);
const HDR_PRIMARIES = new Set(["bt2020"]);
const HDR_SPACES = new Set(["bt2020nc", "bt2020c", "ictcp"]);
const HDR_SIDE_DATA_PATTERN = /(mastering display|content light|dolby vision|hdr10\+|dynamic hdr)/i;
const REQUIRED_BT709 = Object.freeze({
  colorRange: "tv",
  colorSpace: "bt709",
  colorTransfer: "bt709",
  colorPrimaries: "bt709",
  chromaLocation: "left",
});

export class CanonicalMediaError extends Error {
  constructor(message, { code = "CANONICAL_MEDIA_ERROR", status = "rejected", details = null } = {}) {
    super(message);
    this.name = "CanonicalMediaError";
    this.code = code;
    this.status = status;
    this.details = details;
  }
}

export class CanonicalPolicyRequiredError extends CanonicalMediaError {
  constructor(blockers) {
    super(
      `Input needs an explicit media policy before canonical caching: ${blockers.map((item) => item.code).join(", ")}`,
      {
        code: "CANONICAL_MEDIA_POLICY_REQUIRED",
        status: "cache-required-with-policy",
        details: { blockers },
      },
    );
    this.name = "CanonicalPolicyRequiredError";
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

function fileStat(filePath) {
  const value = statSync(filePath, { bigint: true });
  if (!value.isFile()) throw new CanonicalMediaError(`Not a regular file: ${filePath}`, { code: "INPUT_NOT_FILE" });
  const size = Number(value.size);
  if (!Number.isSafeInteger(size)) {
    throw new CanonicalMediaError(`File is too large to fingerprint safely: ${filePath}`, {
      code: "UNSAFE_FILE_SIZE",
    });
  }
  return { size, mtimeNs: String(value.mtimeNs) };
}

function sameStat(left, right) {
  return left?.size === right?.size && left?.mtimeNs === right?.mtimeNs;
}

async function fingerprintStableFile(filePath, expectedStat = null) {
  const before = fileStat(filePath);
  if (expectedStat && !sameStat(before, expectedStat)) {
    throw new CanonicalMediaError(`Source changed after probing: ${filePath}`, { code: "SOURCE_CHANGED" });
  }
  const sha256 = await sha256File(filePath);
  const after = fileStat(filePath);
  if (!sameStat(before, after)) {
    throw new CanonicalMediaError(`File changed while hashing: ${filePath}`, { code: "SOURCE_CHANGED" });
  }
  return { ...after, sha256 };
}

function conciseProcessError(command, code, stderr) {
  const tail = stderr.trim().split(/\r?\n/).slice(-20).join("\n");
  return new CanonicalMediaError(`${command} exited ${code}${tail ? `:\n${tail}` : ""}`, {
    code: "MEDIA_TOOL_FAILED",
  });
}

export function runProcess(command, args, { captureStdout = true, inheritStderr = false } = {}) {
  return new Promise((resolveRun, rejectRun) => {
    const child = spawn(command, args, {
      stdio: ["ignore", captureStdout ? "pipe" : "ignore", inheritStderr ? "inherit" : "pipe"],
    });
    const stdout = [];
    let stderr = "";
    if (captureStdout) child.stdout.on("data", (chunk) => stdout.push(chunk));
    if (!inheritStderr) {
      child.stderr.setEncoding("utf8");
      child.stderr.on("data", (chunk) => { stderr += chunk; });
    }
    child.once("error", (error) => {
      rejectRun(new CanonicalMediaError(`Unable to start ${command}: ${error.message}`, {
        code: "MEDIA_TOOL_UNAVAILABLE",
      }));
    });
    child.once("close", (code) => {
      if (code === 0) resolveRun({ stdout: Buffer.concat(stdout), stderr });
      else rejectRun(conciseProcessError(command, code, stderr));
    });
  });
}

async function runJson(command, args) {
  const result = await runProcess(command, args);
  try {
    return JSON.parse(result.stdout.toString("utf8"));
  } catch (error) {
    throw new CanonicalMediaError(`${command} returned invalid JSON: ${error.message}`, {
      code: "INVALID_PROBE_JSON",
    });
  }
}

export async function commandVersion(command) {
  const result = await runProcess(command, ["-version"]);
  return result.stdout.toString("utf8").split(/\r?\n/, 1)[0].trim();
}

async function encoderAvailable(ffmpeg, encoder) {
  const result = await runProcess(ffmpeg, ["-hide_banner", "-encoders"]);
  return result.stdout.toString("utf8").split(/\s+/).includes(encoder);
}

async function filterAvailable(ffmpeg, filterName) {
  const result = await runProcess(ffmpeg, ["-hide_banner", "-filters"]);
  return result.stdout.toString("utf8").split(/\r?\n/)
    .some((line) => line.trim().split(/\s+/).includes(filterName));
}

function gcd(left, right) {
  let a = left < 0n ? -left : left;
  let b = right < 0n ? -right : right;
  while (b !== 0n) [a, b] = [b, a % b];
  return a;
}

function normalizedRatio(numerator, denominator) {
  if (denominator === 0n) throw new CanonicalMediaError("Ratio denominator cannot be zero", { code: "INVALID_RATIO" });
  const sign = denominator < 0n ? -1n : 1n;
  const common = gcd(numerator, denominator);
  return { numerator: numerator / common * sign, denominator: denominator / common * sign };
}

export function parseFps(value) {
  const raw = String(value ?? "").trim();
  if (!raw) throw new CanonicalMediaError("--fps is required", { code: "FPS_REQUIRED" });
  let numerator;
  let denominator;
  if (/^\d+\/\d+$/.test(raw)) {
    const parts = raw.split("/");
    numerator = BigInt(parts[0]);
    denominator = BigInt(parts[1]);
  } else if (/^\d+(?:\.\d+)?$/.test(raw)) {
    const [whole, fraction = ""] = raw.split(".");
    denominator = 10n ** BigInt(fraction.length);
    numerator = BigInt(`${whole}${fraction}`);
  } else {
    throw new CanonicalMediaError(`Invalid fps: ${raw}. Use an integer, decimal, or rational such as 30000/1001.`, {
      code: "INVALID_FPS",
    });
  }
  const ratio = normalizedRatio(numerator, denominator);
  const numeric = Number(ratio.numerator) / Number(ratio.denominator);
  if (ratio.numerator <= 0n || ratio.denominator <= 0n || !Number.isFinite(numeric) || numeric < 1 || numeric > 240) {
    throw new CanonicalMediaError(`fps must be between 1 and 240; got ${raw}`, { code: "INVALID_FPS" });
  }
  const timescale = ratio.numerator * 1000n;
  if (timescale > MAX_TIMESCALE) {
    throw new CanonicalMediaError(`fps ${raw} requires an unsafe MP4 timescale (${timescale})`, {
      code: "UNSUPPORTED_FPS_TIMESCALE",
    });
  }
  return {
    text: `${ratio.numerator}/${ratio.denominator}`,
    numerator: ratio.numerator,
    denominator: ratio.denominator,
    numeric,
    timescale,
    frameStepTicks: ratio.denominator * 1000n,
  };
}

function parseTimeBase(value, description) {
  const raw = String(value ?? "");
  if (!/^\d+\/\d+$/.test(raw)) {
    throw new CanonicalMediaError(`${description} is invalid: ${raw || "missing"}`, {
      code: "INVALID_TIME_BASE",
    });
  }
  const [numerator, denominator] = raw.split("/").map(BigInt);
  if (numerator <= 0n || denominator <= 0n) {
    throw new CanonicalMediaError(`${description} is invalid: ${raw}`, { code: "INVALID_TIME_BASE" });
  }
  return { text: raw, numerator, denominator };
}

function parseSar(value) {
  const raw = String(value ?? "");
  if (!/^\d+:\d+$/.test(raw)) return null;
  const [numerator, denominator] = raw.split(":").map(BigInt);
  if (numerator <= 0n || denominator <= 0n) return null;
  const normalized = normalizedRatio(numerator, denominator);
  return {
    text: `${normalized.numerator}:${normalized.denominator}`,
    numerator: normalized.numerator,
    denominator: normalized.denominator,
  };
}

function integerTicks(value, description) {
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value)) {
      throw new CanonicalMediaError(`${description} is not a safe integer`, { code: "UNSAFE_TIMESTAMP" });
    }
    return BigInt(value);
  }
  const raw = String(value ?? "");
  if (!/^-?\d+$/.test(raw)) {
    throw new CanonicalMediaError(`${description} is missing or invalid`, { code: "MISSING_PRESENTATION_PTS" });
  }
  return BigInt(raw);
}

function streamColor(stream) {
  return {
    colorRange: stream.color_range ?? null,
    colorSpace: stream.color_space ?? null,
    colorTransfer: stream.color_transfer ?? null,
    colorPrimaries: stream.color_primaries ?? null,
    chromaLocation: stream.chroma_location ?? null,
  };
}

function frameColor(frame) {
  return {
    colorRange: frame.color_range ?? null,
    colorSpace: frame.color_space ?? null,
    colorTransfer: frame.color_transfer ?? null,
    colorPrimaries: frame.color_primaries ?? null,
    chromaLocation: frame.chroma_location ?? null,
  };
}

function allSideData(streams, frames) {
  const values = [];
  for (const stream of streams) {
    for (const sideData of stream.side_data_list ?? []) values.push({ scope: "stream", ...sideData });
  }
  for (const [frameIndex, frame] of frames.entries()) {
    for (const sideData of frame.side_data_list ?? []) values.push({ scope: "frame", frameIndex, ...sideData });
  }
  return values;
}

async function probeStreams(ffprobe, inputPath) {
  return runJson(ffprobe, [
    "-v", "error",
    "-show_entries",
    [
      "format=format_name,duration,size",
      [
        "stream=index,codec_type,codec_name,codec_tag_string,profile,pix_fmt,width,height",
        "sample_aspect_ratio,display_aspect_ratio,field_order,color_range,color_space",
        "color_transfer,color_primaries,chroma_location,time_base,start_pts,start_time",
        "duration_ts,duration,nb_frames,avg_frame_rate,r_frame_rate",
      ].join(","),
      "stream_tags=rotate",
      "stream_disposition=attached_pic",
      "stream_side_data=side_data_type,rotation,displaymatrix,max_content",
    ].join(":"),
    "-of", "json",
    inputPath,
  ]);
}

async function probeFrames(ffprobe, inputPath, streamSpecifier = "v:0") {
  return runJson(ffprobe, [
    "-v", "error", "-select_streams", String(streamSpecifier), "-show_frames",
    "-show_entries",
    [
      [
        "frame=pts,best_effort_timestamp,best_effort_timestamp_time,pkt_dts,duration",
        "key_frame,pict_type,pix_fmt,sample_aspect_ratio,width,height,crop_top,crop_bottom",
        "crop_left,crop_right,interlaced_frame,top_field_first,color_range,color_space",
        "color_transfer,color_primaries,chroma_location",
      ].join(","),
      "frame_side_data=side_data_type,rotation,displaymatrix,max_content",
    ].join(":"),
    "-of", "json",
    inputPath,
  ]);
}

async function probePixelFormats(ffprobe) {
  return runJson(ffprobe, ["-v", "error", "-show_pixel_formats", "-of", "json"]);
}

function blocker(code, message, evidence, policy) {
  return { code, message, evidence, requiredPolicy: policy };
}

function analyzeInputPolicy({ stream, frames, pixelFormat, sideData, sar, bitDepthPolicy, colorPolicy }) {
  const blockers = [];
  const color = streamColor(stream);
  const sideDataNames = sideData.map((item) => item.side_data_type ?? "unknown");
  const hdrEvidence = [];
  if (HDR_TRANSFERS.has(color.colorTransfer)) hdrEvidence.push(`transfer=${color.colorTransfer}`);
  if (HDR_PRIMARIES.has(color.colorPrimaries)) hdrEvidence.push(`primaries=${color.colorPrimaries}`);
  if (HDR_SPACES.has(color.colorSpace)) hdrEvidence.push(`space=${color.colorSpace}`);
  for (const name of sideDataNames) if (HDR_SIDE_DATA_PATTERN.test(name)) hdrEvidence.push(`side_data=${name}`);
  if (hdrEvidence.length) {
    blockers.push(blocker(
      "HDR_POLICY_REQUIRED",
      "HDR/BT.2020 media is never tone-mapped implicitly.",
      hdrEvidence,
      "Provide an approved HDR-preservation or explicit tone-map transform before using this SDR cache.",
    ));
  }

  if (!pixelFormat) {
    blockers.push(blocker(
      "PIXEL_FORMAT_UNKNOWN",
      `ffprobe did not describe pixel format ${stream.pix_fmt ?? "unknown"}.`,
      { pixelFormat: stream.pix_fmt ?? null },
      "Transcode explicitly to a known opaque 8-bit format.",
    ));
  } else {
    const componentDepths = (pixelFormat.components ?? []).map((item) => Number(item.bit_depth));
    if (pixelFormat.flags?.alpha === 1) {
      blockers.push(blocker(
        "ALPHA_POLICY_REQUIRED",
        "The source has an alpha channel; flattening is a creative/compositing decision.",
        { pixelFormat: pixelFormat.name },
        "Flatten against an explicitly approved background, then rerun.",
      ));
    }
    const approvedTenToEight = bitDepthPolicy === BIT_DEPTH_POLICY_10_TO_8
      && pixelFormat.name === "yuv420p10le"
      && componentDepths.length === 3
      && componentDepths.every((depth) => depth === 10);
    if (!componentDepths.length
        || (componentDepths.some((depth) => depth !== 8) && !approvedTenToEight)) {
      blockers.push(blocker(
        "BIT_DEPTH_POLICY_REQUIRED",
        "Non-8-bit sources require the exact approved SDR dithering contract.",
        { pixelFormat: pixelFormat.name, componentDepths, requestedPolicy: bitDepthPolicy },
        `For BT.709 limited yuv420p10le only, rerun with ${BIT_DEPTH_POLICY_10_TO_8}; `
        + "other bit depth/chroma conversions remain unsupported.",
      ));
    }
    if (pixelFormat.flags?.palette === 1 || pixelFormat.flags?.bitstream === 1 || pixelFormat.flags?.hwaccel === 1) {
      blockers.push(blocker(
        "PIXEL_LAYOUT_POLICY_REQUIRED",
        "Paletted, bitstream, or hardware-only pixel layouts are outside the cache contract.",
        { pixelFormat: pixelFormat.name, flags: pixelFormat.flags },
        "Normalize explicitly to opaque 8-bit video before caching.",
      ));
    }
  }

  const rotationTag = stream.tags?.rotate == null ? null : Number(stream.tags.rotate);
  const displayMatrices = sideData.filter((item) => item.side_data_type === "Display Matrix");
  if ((Number.isFinite(rotationTag) && ((rotationTag % 360) + 360) % 360 !== 0) || displayMatrices.length) {
    blockers.push(blocker(
      "ORIENTATION_POLICY_REQUIRED",
      "Rotation/display-matrix metadata is not baked automatically.",
      { rotateTag: stream.tags?.rotate ?? null, displayMatrices },
      "Bake the approved orientation into pixels and clear display metadata, then rerun.",
    ));
  }

  if (!sar) {
    blockers.push(blocker(
      "SAR_POLICY_REQUIRED",
      "Sample aspect ratio is missing or invalid.",
      { sampleAspectRatio: stream.sample_aspect_ratio ?? null },
      "Declare the intended sample aspect ratio explicitly before caching.",
    ));
  } else if (sar.numerator > 65_535n || sar.denominator > 65_535n) {
    blockers.push(blocker(
      "SAR_REPRESENTATION_POLICY_REQUIRED",
      "Sample aspect ratio exceeds the exact H.264 canonical representation bound.",
      { sampleAspectRatio: sar.text, maximumComponent: 65_535 },
      "Normalize geometry/SAR explicitly before caching.",
    ));
  }
  if (!Number.isInteger(stream.width) || !Number.isInteger(stream.height)
      || stream.width <= 0 || stream.height <= 0 || stream.width % 2 || stream.height % 2) {
    blockers.push(blocker(
      "GEOMETRY_POLICY_REQUIRED",
      "H.264 yuv420p output requires a positive even width and height; this tool never crops or pads silently.",
      { width: stream.width ?? null, height: stream.height ?? null },
      "Apply an explicit crop/pad/scale policy before caching.",
    ));
  }
  if (frames.some((frame) => Number(frame.interlaced_frame ?? 0) !== 0)
      || ![null, undefined, "unknown", "progressive"].includes(stream.field_order)) {
    blockers.push(blocker(
      "INTERLACE_POLICY_REQUIRED",
      "Interlaced content is not deinterlaced implicitly.",
      { fieldOrder: stream.field_order ?? null },
      "Apply an approved deinterlacing policy before caching.",
    ));
  }
  const croppedFrame = frames.findIndex((frame) => (
    Number(frame.crop_top ?? 0) !== 0 || Number(frame.crop_bottom ?? 0) !== 0
    || Number(frame.crop_left ?? 0) !== 0 || Number(frame.crop_right ?? 0) !== 0
  ));
  if (croppedFrame >= 0) {
    blockers.push(blocker(
      "CROP_POLICY_REQUIRED",
      "Bitstream crop metadata is present; geometry is not baked silently.",
      { firstCroppedFrame: croppedFrame },
      "Bake or explicitly approve the crop before caching.",
    ));
  }

  for (const [field, expected] of Object.entries(REQUIRED_BT709)) {
    if (color[field] == null) {
      const explicitlyDeclaredUntaggedColor = colorPolicy === COLOR_POLICY_UNTAGGED_BT709_LIMITED
        && field !== "chromaLocation";
      if (explicitlyDeclaredUntaggedColor) continue;
      blockers.push(blocker(
        "COLOR_METADATA_POLICY_REQUIRED",
        `Required source color field ${field} is missing.`,
        { field, actual: null, expected },
        "Tag or convert the source with an explicit color policy before caching.",
      ));
    } else if (color[field] !== expected) {
      blockers.push(blocker(
        "NON_CANONICAL_COLOR_POLICY_REQUIRED",
        `Source ${field}=${color[field]} is outside the tagged BT.709 limited-range contract.`,
        { field, actual: color[field], expected },
        "Use an explicitly approved color conversion; no conversion or tone-map is inferred here.",
      ));
    }
  }
  return blockers;
}

function summarizeFrameColorConsistency(frames, expectedColor) {
  const fields = Object.keys(REQUIRED_BT709);
  const mismatches = [];
  const reported = Object.fromEntries(fields.map((field) => [field, 0]));
  for (const [frameIndex, frame] of frames.entries()) {
    const color = frameColor(frame);
    for (const field of fields) {
      if (color[field] == null) continue;
      reported[field] += 1;
      if (color[field] !== expectedColor[field] && mismatches.length < 20) {
        mismatches.push({ frameIndex, field, actual: color[field], expected: expectedColor[field] });
      }
    }
  }
  return { frameCount: frames.length, reported, mismatches, consistent: mismatches.length === 0 };
}

export async function inspectCanonicalSource({
  input,
  ffprobe = "ffprobe",
  bitDepthPolicy = "reject",
  colorPolicy = "reject",
  sampleAspectRatio = null,
}) {
  if (bitDepthPolicy !== "reject" && bitDepthPolicy !== BIT_DEPTH_POLICY_10_TO_8) {
    throw new CanonicalMediaError(`Unsupported bit-depth policy: ${bitDepthPolicy}`, {
      code: "INVALID_BIT_DEPTH_POLICY",
    });
  }
  if (colorPolicy !== "reject" && colorPolicy !== COLOR_POLICY_UNTAGGED_BT709_LIMITED) {
    throw new CanonicalMediaError(`Unsupported color policy: ${colorPolicy}`, {
      code: "INVALID_COLOR_POLICY",
    });
  }
  const declaredSar = sampleAspectRatio == null ? null : parseSar(sampleAspectRatio);
  if (sampleAspectRatio != null && !declaredSar) {
    throw new CanonicalMediaError(
      `Explicit sample aspect ratio is invalid: ${sampleAspectRatio}`,
      { code: "INVALID_SAMPLE_ASPECT_RATIO_POLICY" },
    );
  }
  const requestedPath = resolve(input);
  if (!existsSync(requestedPath)) {
    throw new CanonicalMediaError(`Input is missing: ${requestedPath}`, { code: "INPUT_MISSING" });
  }
  const inputPath = realpathSync(requestedPath);
  const before = fileStat(inputPath);
  const [streamProbe, pixelFormats] = await Promise.all([
    probeStreams(ffprobe, inputPath),
    probePixelFormats(ffprobe),
  ]);
  const streams = streamProbe.streams ?? [];
  const videoStreams = streams.filter((stream) => stream.codec_type === "video" && stream.disposition?.attached_pic !== 1);
  if (videoStreams.length !== 1) {
    throw new CanonicalMediaError(`Expected exactly one non-attached video stream, found ${videoStreams.length}`, {
      code: "AMBIGUOUS_VIDEO_STREAM",
      details: { streamCount: streams.length, videoStreamCount: videoStreams.length },
    });
  }
  const stream = videoStreams[0];
  const frameProbe = await probeFrames(ffprobe, inputPath, stream.index);
  const after = fileStat(inputPath);
  if (!sameStat(before, after)) {
    throw new CanonicalMediaError(`Source changed while ffprobe was reading it: ${inputPath}`, {
      code: "SOURCE_CHANGED",
    });
  }
  const frames = frameProbe.frames ?? [];
  if (!frames.length) {
    throw new CanonicalMediaError("The selected video stream decoded no frames", { code: "EMPTY_VIDEO" });
  }
  const timeBase = parseTimeBase(stream.time_base, "source time_base");
  const presentationPts = [];
  let previousPts = null;
  for (const [frameIndex, frame] of frames.entries()) {
    if (frame.pts == null) {
      throw new CanonicalMediaError(`Source frame ${frameIndex} has no presentation PTS`, {
        code: "MISSING_PRESENTATION_PTS",
      });
    }
    const pts = integerTicks(frame.pts, `source frame ${frameIndex} PTS`);
    if (frame.best_effort_timestamp != null) {
      const bestEffort = integerTicks(frame.best_effort_timestamp, `source frame ${frameIndex} best-effort PTS`);
      if (bestEffort !== pts) {
        throw new CanonicalMediaError(
          `Source frame ${frameIndex} PTS (${pts}) differs from best-effort presentation timestamp (${bestEffort})`,
          { code: "AMBIGUOUS_PRESENTATION_PTS" },
        );
      }
    }
    if (previousPts != null && pts <= previousPts) {
      throw new CanonicalMediaError(`Source presentation PTS is not strictly increasing at frame ${frameIndex}`, {
        code: "NON_MONOTONIC_PRESENTATION_PTS",
        details: { frameIndex, previousPtsTicks: String(previousPts), ptsTicks: String(pts) },
      });
    }
    presentationPts.push(pts);
    previousPts = pts;
  }

  const pixelFormat = (pixelFormats.pixel_formats ?? []).find((item) => item.name === stream.pix_fmt) ?? null;
  const sourceSar = parseSar(stream.sample_aspect_ratio);
  if (sourceSar && declaredSar && sourceSar.text !== declaredSar.text) {
    throw new CanonicalMediaError(
      `Explicit sample aspect ratio ${declaredSar.text} conflicts with source metadata ${sourceSar.text}`,
      {
        code: "SAMPLE_ASPECT_RATIO_POLICY_CONFLICT",
        details: { source: sourceSar.text, declared: declaredSar.text },
      },
    );
  }
  const sar = sourceSar ?? declaredSar;
  const sarResolution = Object.freeze({
    mode: sourceSar
      ? (declaredSar ? "source-metadata-confirmed" : "source-metadata")
      : (declaredSar ? "explicit-for-missing-source-metadata" : "missing"),
    source: sourceSar?.text ?? null,
    declared: declaredSar?.text ?? null,
    effective: sar?.text ?? null,
  });
  const sideData = allSideData(streams, frames);
  const blockers = analyzeInputPolicy({
    stream,
    frames,
    pixelFormat,
    sideData,
    sar,
    bitDepthPolicy,
    colorPolicy,
  });
  const componentDepths = (pixelFormat?.components ?? []).map((item) => Number(item.bit_depth));
  const bitDepthConversion = {
    requestedPolicy: bitDepthPolicy,
    active: bitDepthPolicy === BIT_DEPTH_POLICY_10_TO_8
      && pixelFormat?.name === "yuv420p10le"
      && componentDepths.length === 3
      && componentDepths.every((depth) => depth === 10),
    sourcePixelFormat: pixelFormat?.name ?? stream.pix_fmt ?? null,
    sourceComponentDepths: componentDepths,
    outputPixelFormat: "yuv420p",
    dither: bitDepthPolicy === BIT_DEPTH_POLICY_10_TO_8 ? "zscale-error-diffusion" : "none",
    colorTransform: bitDepthPolicy === BIT_DEPTH_POLICY_10_TO_8
      ? "BT.709 limited -> BT.709 limited; no tone-map, gamut or transfer conversion"
      : "none",
  };
  const color = streamColor(stream);
  const assumedColorFields = Object.keys(REQUIRED_BT709).filter((field) => (
    color[field] == null
    && colorPolicy === COLOR_POLICY_UNTAGGED_BT709_LIMITED
    && field !== "chromaLocation"
  ));
  const effectiveColor = Object.fromEntries(Object.entries(REQUIRED_BT709).map(([field, expected]) => [
    field,
    color[field] ?? (assumedColorFields.includes(field) ? expected : null),
  ]));
  const colorResolution = Object.freeze({
    requestedPolicy: colorPolicy,
    mode: assumedColorFields.length
      ? COLOR_POLICY_UNTAGGED_BT709_LIMITED
      : "source-metadata",
    source: color,
    effective: effectiveColor,
    assumedFields: assumedColorFields,
  });
  const frameColorConsistency = summarizeFrameColorConsistency(frames, effectiveColor);
  if (!frameColorConsistency.consistent) {
    blockers.push(blocker(
      "FRAME_COLOR_METADATA_POLICY_REQUIRED",
      "Decoded frames disagree with the stream color contract.",
      frameColorConsistency.mismatches,
      "Normalize or repair color metadata before caching.",
    ));
  }
  const deltas = presentationPts.slice(1).map((pts, index) => pts - presentationPts[index]);
  const uniqueDeltas = new Set(deltas.map(String));
  const firstPts = presentationPts[0];
  const timeline = {
    sourceTimeBase: timeBase.text,
    frameCount: frames.length,
    firstPtsTicks: String(firstPts),
    lastPtsTicks: String(presentationPts.at(-1)),
    presentationPtsTicks: presentationPts.map(String),
    presentationPtsSha256: sha256Text(presentationPts.map(String).join("\n")),
    strictlyIncreasing: true,
    uniqueDeltaTicks: [...uniqueDeltas].sort(),
    variableFrameRate: uniqueDeltas.size > 1,
    hasBFrames: frames.some((frame) => frame.pict_type === "B"),
  };
  return {
    status: blockers.length ? "cache-required-with-policy" : "supported",
    inputPath,
    stableStat: after,
    format: {
      name: streamProbe.format?.format_name ?? null,
      duration: streamProbe.format?.duration ?? null,
      size: streamProbe.format?.size ?? null,
    },
    stream: {
      index: stream.index,
      codecName: stream.codec_name ?? null,
      codecTag: stream.codec_tag_string ?? null,
      profile: stream.profile ?? null,
      pixelFormat: stream.pix_fmt ?? null,
      pixelFormatDescriptor: pixelFormat ? {
        components: pixelFormat.nb_components ?? null,
        bitsPerPixel: pixelFormat.bits_per_pixel ?? null,
        componentDepths: (pixelFormat.components ?? []).map((item) => Number(item.bit_depth)),
        flags: pixelFormat.flags ?? null,
      } : null,
      width: stream.width ?? null,
      height: stream.height ?? null,
      sampleAspectRatio: sar?.text ?? stream.sample_aspect_ratio ?? null,
      sourceSampleAspectRatio: sourceSar?.text ?? null,
      sampleAspectRatioPolicy: sarResolution,
      displayAspectRatio: stream.display_aspect_ratio ?? null,
      fieldOrder: stream.field_order ?? null,
      ...color,
      effectiveColor,
      colorPolicy: colorResolution,
      averageFrameRate: stream.avg_frame_rate ?? null,
      nominalFrameRate: stream.r_frame_rate ?? null,
      audioStreamCount: streams.filter((item) => item.codec_type === "audio").length,
      subtitleStreamCount: streams.filter((item) => item.codec_type === "subtitle").length,
      sideData,
    },
    sar,
    sarResolution,
    timeline,
    frames: frames.map((frame, frameIndex) => ({
      frameIndex,
      ptsTicks: presentationPts[frameIndex].toString(),
      ptsTime: frame.best_effort_timestamp_time ?? null,
      durationTicks: frame.duration == null ? null : String(frame.duration),
      packetDtsTicks: frame.pkt_dts == null ? null : String(frame.pkt_dts),
      keyFrame: Number(frame.key_frame ?? 0) === 1,
      pictureType: frame.pict_type ?? null,
      pixelFormat: frame.pix_fmt ?? null,
      sampleAspectRatio: frame.sample_aspect_ratio ?? null,
      color: frameColor(frame),
    })),
    frameColorConsistency,
    colorResolution,
    bitDepthConversion,
    blockers,
  };
}

function sourceInspectionForManifest(inspection) {
  return {
    status: inspection.status,
    format: inspection.format,
    stream: inspection.stream,
    timeline: inspection.timeline,
    frameColorConsistency: inspection.frameColorConsistency,
    colorResolution: inspection.colorResolution,
    bitDepthConversion: inspection.bitDepthConversion,
    sarResolution: inspection.sarResolution,
    blockers: inspection.blockers,
  };
}

function canonicalFilter({ fps, inspection, profile }) {
  const sar = inspection.sar;
  const common = [
    "setpts=PTS-STARTPTS",
    `fps=fps=${fps.text}:start_time=0:round=down:eof_action=pass`,
  ];
  if (inspection.bitDepthConversion?.active) {
    common.push(
      "zscale=rangein=limited:range=limited:"
      + "primariesin=bt709:primaries=bt709:"
      + "transferin=bt709:transfer=bt709:"
      + "matrixin=bt709:matrix=bt709:dither=error_diffusion",
    );
  }
  common.push(
    "format=yuv420p",
    `setsar=${sar.numerator}/${sar.denominator}:max=65535`,
    "setparams=range=limited:color_primaries=bt709:color_trc=bt709:colorspace=bt709",
  );
  if (profile === "speed") common.push("format=nv12", "hwupload");
  return common.join(",");
}

function gopFramesForFps(fps) {
  return Number((fps.numerator + fps.denominator - 1n) / fps.denominator);
}

function normalizeSampleCount(value) {
  const numeric = Number(value ?? 9);
  if (!Number.isInteger(numeric) || numeric < 3 || numeric > 24) {
    throw new CanonicalMediaError(`pixel sample target must be an integer from 3 to 24; got ${value}`, {
      code: "INVALID_SAMPLE_COUNT",
    });
  }
  return numeric;
}

export async function createRecipe({
  fps,
  inspection,
  profile = "quality",
  ffmpeg = "ffmpeg",
  ffprobe = "ffprobe",
  device = "/dev/dri/renderD128",
  sampleCount = 9,
}) {
  if (profile !== "quality" && profile !== "speed") {
    throw new CanonicalMediaError(`profile must be quality or speed; got ${profile}`, { code: "INVALID_PROFILE" });
  }
  const [ffmpegVersion, ffprobeVersion] = await Promise.all([
    commandVersion(ffmpeg),
    commandVersion(ffprobe),
  ]);
  const encoder = profile === "quality" ? "libx264" : "h264_vaapi";
  if (!await encoderAvailable(ffmpeg, encoder)) {
    throw new CanonicalMediaError(`${ffmpeg} does not provide the required ${encoder} encoder`, {
      code: "ENCODER_UNAVAILABLE",
    });
  }
  if (profile === "speed" && !existsSync(device)) {
    throw new CanonicalMediaError(`VAAPI device is missing: ${device}`, { code: "VAAPI_DEVICE_MISSING" });
  }
  if (inspection.bitDepthConversion?.active && !await filterAvailable(ffmpeg, "zscale")) {
    throw new CanonicalMediaError(
      "The approved 10-bit to 8-bit policy requires FFmpeg zscale with error-diffusion dithering",
      { code: "ZIMG_FILTER_UNAVAILABLE" },
    );
  }
  const gopFrames = gopFramesForFps(fps);
  const recipe = {
    contractVersion: TOOL_CONTRACT_VERSION,
    purpose: "Predictable frame-indexed fallback when direct WebCodecs decode cannot satisfy the render contract",
    profile,
    encoder,
    fps: fps.text,
    outputTimeBase: `1/${fps.timescale}`,
    outputFrameStepTicks: String(fps.frameStepTicks),
    videoCodec: "h264",
    codecTag: "avc1",
    pixelFormat: "yuv420p",
    audio: "none",
    closedGop: true,
    gopFrames,
    bFrames: 0,
    frameSelection: "latest source presentation frame whose floor((PTS-firstPTS)*fps) <= cacheFrameIndex",
    fpsFilter: `fps=fps=${fps.text}:start_time=0:round=down:eof_action=pass`,
    muxFpsMode: "passthrough-after-fps-filter",
    videoTrackTimescale: String(fps.timescale),
    sarPolicy: inspection.sarResolution,
    colorPolicy: {
      mode: inspection.colorResolution.mode,
      requestedPolicy: inspection.colorResolution.requestedPolicy,
      source: inspection.colorResolution.source,
      assumedFields: inspection.colorResolution.assumedFields,
      ...REQUIRED_BT709,
    },
    bitDepthPolicy: inspection.bitDepthConversion,
    unsupportedPolicy: "hard-reject; never auto-rotate, flatten alpha, deinterlace, crop, tone-map, "
      + "or dither outside the exact hashed zscale error-diffusion contract",
    acceptance: { pixelGrid: "16x16-rgb24-area", pixelSampleTarget: normalizeSampleCount(sampleCount) },
    quality: profile === "quality"
      ? { crf: 10, preset: "slow", encoder: "libx264" }
      : { rcMode: "CQP", qp: 16, encoder: "h264_vaapi", device },
    toolchain: { ffmpegVersion, ffprobeVersion },
  };
  return { ...recipe, hash: sha256Text(stableJson(recipe)) };
}

export function buildEncodeArguments({ recipe, inspection, sourcePath, outputPath, device }) {
  const fps = parseFps(recipe.fps);
  const args = ["-hide_banner", "-loglevel", "warning", "-y", "-noautorotate"];
  if (recipe.profile === "speed") {
    args.push("-init_hw_device", `vaapi=canonicalva:${device}`, "-filter_hw_device", "canonicalva");
  }
  args.push(
    "-i", sourcePath,
    "-map", "0:v:0", "-an", "-sn", "-dn",
    "-map_metadata", "-1", "-map_chapters", "-1",
    "-vf", canonicalFilter({ fps, inspection, profile: recipe.profile }),
  );
  if (recipe.profile === "quality") {
    args.push(
      "-c:v", "libx264", "-preset", "slow", "-crf", "10",
      "-pix_fmt", "yuv420p", "-profile:v", "high",
      "-g", String(recipe.gopFrames), "-keyint_min", String(recipe.gopFrames),
      "-sc_threshold", "0", "-bf", "0", "-flags", "+cgop",
      "-x264-params", `keyint=${recipe.gopFrames}:min-keyint=${recipe.gopFrames}:scenecut=0:open-gop=0:bframes=0:force-cfr=1`,
    );
  } else {
    args.push(
      "-c:v", "h264_vaapi", "-profile:v", "high",
      "-rc_mode", "CQP", "-qp", "16",
      "-g", String(recipe.gopFrames), "-bf", "0", "-flags", "+cgop",
    );
  }
  args.push(
    "-fps_mode", "passthrough", "-enc_time_base", "filter",
    "-tag:v", "avc1", "-video_track_timescale", String(fps.timescale),
    "-color_range", "tv", "-color_primaries", "bt709",
    "-color_trc", "bt709", "-colorspace", "bt709",
    "-chroma_sample_location", "left",
    "-movflags", "+faststart+write_colr", "-write_tmcd", "0",
    outputPath,
  );
  return args;
}

function cacheBaseName(inputPath) {
  const extension = extname(inputPath);
  const raw = basename(inputPath, extension).normalize("NFKD").replace(/[^a-zA-Z0-9._-]+/g, "-");
  return (raw.replace(/^-+|-+$/g, "") || "video").slice(0, 80);
}

export function cachePaths({ inputPath, cacheDirectory, sourceHash, recipe }) {
  const fpsSlug = recipe.fps.replace("/", "-");
  const stem = [
    cacheBaseName(inputPath),
    sha256Text(resolve(inputPath)).slice(0, 8),
    sourceHash.slice(0, 16),
    recipe.hash.slice(0, 16),
    `cfr-${fpsSlug}`,
    recipe.profile,
  ].join(".");
  const cachePath = resolve(cacheDirectory, `${stem}.mp4`);
  return { cachePath, manifestPath: `${cachePath}.canonical.json` };
}

function floorDivNonNegative(numerator, denominator) {
  if (numerator < 0n || denominator <= 0n) throw new Error("floorDivNonNegative domain error");
  return numerator / denominator;
}

export function buildFrameMap({ sourceFrames, sourceTimeBase, fps, outputFrameCount }) {
  if (!Number.isSafeInteger(outputFrameCount) || outputFrameCount <= 0) {
    throw new CanonicalMediaError(`Invalid output frame count: ${outputFrameCount}`, { code: "INVALID_CACHE_FRAME_COUNT" });
  }
  const timeBase = parseTimeBase(sourceTimeBase, "source time_base");
  const firstPts = BigInt(sourceFrames[0].ptsTicks);
  const sourceGrid = sourceFrames.map((frame) => {
    const pts = BigInt(frame.ptsTicks);
    const normalized = pts - firstPts;
    const numerator = normalized * timeBase.numerator * fps.numerator;
    const denominator = timeBase.denominator * fps.denominator;
    return floorDivNonNegative(numerator, denominator);
  });
  const entries = [];
  let selectedSourceFrameIndex = 0;
  for (let cacheFrameIndex = 0; cacheFrameIndex < outputFrameCount; cacheFrameIndex += 1) {
    const cacheIndex = BigInt(cacheFrameIndex);
    while (selectedSourceFrameIndex + 1 < sourceFrames.length
        && sourceGrid[selectedSourceFrameIndex + 1] <= cacheIndex) {
      selectedSourceFrameIndex += 1;
    }
    const sourceFrame = sourceFrames[selectedSourceFrameIndex];
    entries.push({
      cacheFrameIndex,
      cachePtsTicks: String(cacheIndex * fps.frameStepTicks),
      sourceFrameIndex: selectedSourceFrameIndex,
      sourcePtsTicks: sourceFrame.ptsTicks,
    });
  }
  return {
    selectionPolicy: "zero-order-hold on presentation PTS after subtracting firstPTS; fps round=down",
    sourceTimeBase,
    sourceFirstPtsTicks: String(firstPts),
    cacheTimeBase: `1/${fps.timescale}`,
    cacheFrameStepTicks: String(fps.frameStepTicks),
    cacheFrameCount: outputFrameCount,
    entries,
    entriesSha256: sha256Text(stableJson(entries)),
  };
}

function ratioEqual(left, right) {
  try {
    const [ln, ld] = String(left).split("/").map(BigInt);
    const [rn, rd] = String(right).split("/").map(BigInt);
    return ln * rd === rn * ld;
  } catch {
    return false;
  }
}

async function inspectCache({ cachePath, ffprobe }) {
  const streamProbe = await probeStreams(ffprobe, cachePath);
  const streams = streamProbe.streams ?? [];
  const videoStreams = streams.filter((stream) => stream.codec_type === "video" && stream.disposition?.attached_pic !== 1);
  if (videoStreams.length !== 1) {
    throw new CanonicalMediaError(`Cache must have exactly one video stream; found ${videoStreams.length}`, {
      code: "CACHE_STREAM_CONTRACT_FAILED",
    });
  }
  const frameProbe = await probeFrames(ffprobe, cachePath, videoStreams[0].index);
  return { streamProbe, stream: videoStreams[0], streams, frames: frameProbe.frames ?? [] };
}

function validateCacheStructure({ cache, inspection, recipe, fps }) {
  const issues = [];
  const stream = cache.stream;
  const frames = cache.frames;
  const expectedTimeBase = recipe.outputTimeBase;
  if (stream.codec_name !== "h264") issues.push(`codec=${stream.codec_name ?? "missing"}, expected h264`);
  if (stream.codec_tag_string !== "avc1") issues.push(`codec_tag=${stream.codec_tag_string ?? "missing"}, expected avc1`);
  if (stream.pix_fmt !== "yuv420p") issues.push(`pix_fmt=${stream.pix_fmt ?? "missing"}, expected yuv420p`);
  if (stream.time_base !== expectedTimeBase) issues.push(`time_base=${stream.time_base ?? "missing"}, expected ${expectedTimeBase}`);
  if (!ratioEqual(stream.avg_frame_rate, recipe.fps)) issues.push(`avg_frame_rate=${stream.avg_frame_rate}, expected ${recipe.fps}`);
  if (!ratioEqual(stream.r_frame_rate, recipe.fps)) issues.push(`r_frame_rate=${stream.r_frame_rate}, expected ${recipe.fps}`);
  if (stream.width !== inspection.stream.width || stream.height !== inspection.stream.height) {
    issues.push(`geometry=${stream.width}x${stream.height}, expected ${inspection.stream.width}x${inspection.stream.height}`);
  }
  if (stream.sample_aspect_ratio !== inspection.stream.sampleAspectRatio) {
    issues.push(`SAR=${stream.sample_aspect_ratio}, expected ${inspection.stream.sampleAspectRatio}`);
  }
  for (const [field, expected] of Object.entries(REQUIRED_BT709)) {
    const rawField = {
      colorRange: "color_range",
      colorSpace: "color_space",
      colorTransfer: "color_transfer",
      colorPrimaries: "color_primaries",
      chromaLocation: "chroma_location",
    }[field];
    if (stream[rawField] !== expected) issues.push(`${rawField}=${stream[rawField] ?? "missing"}, expected ${expected}`);
  }
  if (cache.streams.some((item) => item.codec_type === "audio")) issues.push("audio stream is present");
  if (!frames.length) issues.push("cache decoded no frames");
  const frameColorAudit = summarizeFrameColorConsistency(frames, REQUIRED_BT709);
  if (!frameColorAudit.consistent) issues.push(`frame color mismatch: ${JSON.stringify(frameColorAudit.mismatches[0])}`);
  if (frames[0] && Number(frames[0].key_frame ?? 0) !== 1) issues.push("first frame is not a key frame");
  let previousKeyFrame = null;
  const keyFrameIndices = [];
  for (const [frameIndex, frame] of frames.entries()) {
    let pts;
    try {
      pts = integerTicks(frame.pts, `cache frame ${frameIndex} PTS`);
    } catch (error) {
      issues.push(error.message);
      break;
    }
    const expectedPts = BigInt(frameIndex) * fps.frameStepTicks;
    if (pts !== expectedPts) {
      issues.push(`frame ${frameIndex} PTS=${pts}, expected ${expectedPts}`);
      break;
    }
    let duration = null;
    try {
      duration = integerTicks(frame.duration, `cache frame ${frameIndex} duration`);
    } catch (error) {
      issues.push(error.message);
    }
    if (duration != null && duration !== fps.frameStepTicks) {
      issues.push(`frame ${frameIndex} duration=${duration}, expected ${fps.frameStepTicks}`);
    }
    if (frame.pix_fmt !== "yuv420p") issues.push(`frame ${frameIndex} pix_fmt=${frame.pix_fmt ?? "missing"}`);
    if (frame.width !== inspection.stream.width || frame.height !== inspection.stream.height) {
      issues.push(`frame ${frameIndex} geometry=${frame.width}x${frame.height}`);
    }
    if (frame.sample_aspect_ratio !== inspection.stream.sampleAspectRatio) {
      issues.push(`frame ${frameIndex} SAR=${frame.sample_aspect_ratio ?? "missing"}`);
    }
    if (Number(frame.interlaced_frame ?? 0) !== 0) issues.push(`frame ${frameIndex} is interlaced`);
    const decodedColor = frameColor(frame);
    for (const [field, expected] of Object.entries(REQUIRED_BT709)) {
      if (decodedColor[field] !== expected) {
        issues.push(`frame ${frameIndex} ${field}=${decodedColor[field] ?? "missing"}, expected ${expected}`);
      }
    }
    if (frame.pict_type === "B") issues.push(`frame ${frameIndex} is a B frame; cache contract requires bframes=0`);
    if (Number(frame.key_frame ?? 0) === 1) {
      keyFrameIndices.push(frameIndex);
      if (previousKeyFrame != null && frameIndex - previousKeyFrame > recipe.gopFrames) {
        issues.push(`keyframe gap ${frameIndex - previousKeyFrame} exceeds GOP ${recipe.gopFrames}`);
      }
      previousKeyFrame = frameIndex;
    }
  }
  if (previousKeyFrame != null && frames.length - 1 - previousKeyFrame >= recipe.gopFrames) {
    issues.push(`tail keyframe gap ${frames.length - 1 - previousKeyFrame} exceeds GOP ${recipe.gopFrames}`);
  }
  if (issues.length) {
    throw new CanonicalMediaError(`Canonical cache acceptance failed: ${issues.join("; ")}`, {
      code: "CACHE_ACCEPTANCE_FAILED",
      details: { issues },
    });
  }
  return {
    passed: true,
    codec: stream.codec_name,
    codecTag: stream.codec_tag_string,
    pixelFormat: stream.pix_fmt,
    width: stream.width,
    height: stream.height,
    sampleAspectRatio: stream.sample_aspect_ratio,
    timeBase: stream.time_base,
    averageFrameRate: stream.avg_frame_rate,
    nominalFrameRate: stream.r_frame_rate,
    frameCount: frames.length,
    audioStreamCount: 0,
    firstPtsTicks: String(frames[0].pts),
    lastPtsTicks: String(frames.at(-1).pts),
    ptsCheckedPerFrame: true,
    durationCheckedPerFrame: true,
    colorCheckedPerFrame: true,
    bFrames: 0,
    keyFrameIndices,
    closedGopValidated: recipe.closedGop === true
      && keyFrameIndices[0] === 0
      && frames.every((frame) => frame.pict_type !== "B"),
    color: streamColor(stream),
    frameColorAudit,
  };
}

function choosePixelSampleIndices(frameMap, requestedCount) {
  const total = frameMap.entries.length;
  const limit = Math.max(3, Math.min(24, Number(requestedCount) || 9));
  const values = new Set([0, total - 1]);
  if (limit > 1) {
    for (let index = 0; index < limit; index += 1) {
      values.add(Math.round(index * (total - 1) / (limit - 1)));
    }
  }
  let duplicateBudget = 3;
  for (let index = 1; index < total && duplicateBudget > 0; index += 1) {
    if (frameMap.entries[index].sourceFrameIndex === frameMap.entries[index - 1].sourceFrameIndex) {
      values.add(index);
      duplicateBudget -= 1;
    }
  }
  return [...values].filter((value) => value >= 0 && value < total).sort((a, b) => a - b).slice(0, limit + 3);
}

async function extractPixelGrids({
  ffmpeg,
  filePath,
  frameIndices,
  gridSize = 16,
  normalizeTenBit = false,
  declareUntaggedBt709 = false,
}) {
  if (!frameIndices.length) return new Map();
  const selectExpression = frameIndices.map((index) => `eq(n\\,${index})`).join("+");
  const filters = [];
  if (declareUntaggedBt709) {
    filters.push("setparams=range=limited:color_primaries=bt709:color_trc=bt709:colorspace=bt709");
  }
  if (normalizeTenBit) {
    filters.push(
      "zscale=rangein=limited:range=limited:"
      + "primariesin=bt709:primaries=bt709:"
      + "transferin=bt709:transfer=bt709:"
      + "matrixin=bt709:matrix=bt709:dither=error_diffusion",
      "format=yuv420p",
    );
  }
  filters.push(`select=${selectExpression}`, `scale=${gridSize}:${gridSize}:flags=area`, "format=rgb24");
  const result = await runProcess(ffmpeg, [
    "-hide_banner", "-loglevel", "error", "-noautorotate", "-i", filePath,
    "-map", "0:v:0", "-an", "-sn", "-dn",
    "-vf", filters.join(","),
    "-fps_mode", "passthrough", "-f", "rawvideo", "pipe:1",
  ]);
  const bytesPerFrame = gridSize * gridSize * 3;
  const expectedBytes = frameIndices.length * bytesPerFrame;
  if (result.stdout.length !== expectedBytes) {
    throw new CanonicalMediaError(
      `Pixel sampler decoded ${result.stdout.length} bytes, expected ${expectedBytes}`,
      { code: "PIXEL_SAMPLE_DECODE_FAILED" },
    );
  }
  const grids = new Map();
  for (const [position, frameIndex] of frameIndices.entries()) {
    grids.set(frameIndex, result.stdout.subarray(position * bytesPerFrame, (position + 1) * bytesPerFrame));
  }
  return grids;
}

function comparePixelGrids(source, cache) {
  if (source.length !== cache.length) throw new Error("Pixel grid length mismatch");
  let absoluteError = 0;
  let peakAbsoluteError = 0;
  let squaredError = 0;
  for (let index = 0; index < source.length; index += 1) {
    const difference = Math.abs(source[index] - cache[index]);
    absoluteError += difference;
    squaredError += difference * difference;
    peakAbsoluteError = Math.max(peakAbsoluteError, difference);
  }
  return {
    meanAbsoluteError: absoluteError / source.length,
    rootMeanSquaredError: Math.sqrt(squaredError / source.length),
    peakAbsoluteError,
  };
}

async function auditPixelSamples({
  ffmpeg,
  sourcePath,
  cachePath,
  frameMap,
  profile,
  sampleCount,
  inspection,
}) {
  const cacheIndices = choosePixelSampleIndices(frameMap, sampleCount);
  const sourceIndices = [...new Set(cacheIndices.map((index) => frameMap.entries[index].sourceFrameIndex))].sort((a, b) => a - b);
  const [sourceGrids, cacheGrids] = await Promise.all([
    extractPixelGrids({
      ffmpeg,
      filePath: sourcePath,
      frameIndices: sourceIndices,
      normalizeTenBit: inspection.bitDepthConversion?.active === true,
      declareUntaggedBt709: inspection.colorResolution?.mode === COLOR_POLICY_UNTAGGED_BT709_LIMITED,
    }),
    extractPixelGrids({ ffmpeg, filePath: cachePath, frameIndices: cacheIndices }),
  ]);
  const thresholds = profile === "quality"
    ? { meanAbsoluteError: 3.0, rootMeanSquaredError: 5.0, peakAbsoluteError: 32 }
    : { meanAbsoluteError: 7.0, rootMeanSquaredError: 11.0, peakAbsoluteError: 56 };
  const samples = cacheIndices.map((cacheFrameIndex) => {
    const mapping = frameMap.entries[cacheFrameIndex];
    const sourceGrid = sourceGrids.get(mapping.sourceFrameIndex);
    const cacheGrid = cacheGrids.get(cacheFrameIndex);
    const metrics = comparePixelGrids(sourceGrid, cacheGrid);
    return {
      cacheFrameIndex,
      cachePtsTicks: mapping.cachePtsTicks,
      sourceFrameIndex: mapping.sourceFrameIndex,
      sourcePtsTicks: mapping.sourcePtsTicks,
      sourceRgbGridSha256: createHash("sha256").update(sourceGrid).digest("hex"),
      cacheRgbGridSha256: createHash("sha256").update(cacheGrid).digest("hex"),
      ...metrics,
      passed: metrics.meanAbsoluteError <= thresholds.meanAbsoluteError
        && metrics.rootMeanSquaredError <= thresholds.rootMeanSquaredError
        && metrics.peakAbsoluteError <= thresholds.peakAbsoluteError,
    };
  });
  const failed = samples.filter((sample) => !sample.passed);
  if (failed.length) {
    throw new CanonicalMediaError(
      `Pixel acceptance failed for ${failed.length}/${samples.length} samples; first cache frame ${failed[0].cacheFrameIndex}`,
      { code: "PIXEL_ACCEPTANCE_FAILED", details: { thresholds, failed } },
    );
  }
  return { passed: true, grid: "16x16-rgb24-area", thresholds, samples };
}

async function acceptCache({
  cachePath,
  sourcePath,
  inspection,
  recipe,
  ffmpeg,
  ffprobe,
  sampleCount,
}) {
  const fps = parseFps(recipe.fps);
  const cache = await inspectCache({ cachePath, ffprobe });
  const structure = validateCacheStructure({ cache, inspection, recipe, fps });
  const frameMap = buildFrameMap({
    sourceFrames: inspection.frames,
    sourceTimeBase: inspection.timeline.sourceTimeBase,
    fps,
    outputFrameCount: cache.frames.length,
  });
  const pixelSampling = await auditPixelSamples({
    ffmpeg,
    sourcePath,
    cachePath,
    frameMap,
    profile: recipe.profile,
    sampleCount,
    inspection,
  });
  return {
    frameMap,
    acceptance: {
      passed: true,
      structure,
      pixelSampling,
    },
  };
}

function manifestPayloadHash(manifest) {
  const { integrity: _integrity, ...payload } = manifest;
  return sha256Text(stableJson(payload));
}

function withManifestIntegrity(manifest) {
  return {
    ...manifest,
    integrity: {
      algorithm: "sha256-stable-json",
      payloadSha256: manifestPayloadHash(manifest),
    },
  };
}

function assertManifestIntegrity(manifest) {
  if (!manifest || typeof manifest !== "object" || Array.isArray(manifest)) {
    throw new CanonicalMediaError("Manifest must be an object", { code: "INVALID_MANIFEST" });
  }
  if (manifest.kind !== MANIFEST_KIND || manifest.schemaVersion !== MANIFEST_SCHEMA_VERSION) {
    throw new CanonicalMediaError("Manifest kind/schema does not belong to this tool", {
      code: "FOREIGN_MANIFEST",
    });
  }
  const expected = manifestPayloadHash(manifest);
  if (manifest.integrity?.algorithm !== "sha256-stable-json" || manifest.integrity?.payloadSha256 !== expected) {
    throw new CanonicalMediaError("Manifest integrity hash does not match", { code: "MANIFEST_INTEGRITY_FAILED" });
  }
  if (manifest.recipe?.hash == null) {
    throw new CanonicalMediaError("Manifest recipe hash is missing", { code: "INVALID_MANIFEST" });
  }
  const { hash, ...recipeBody } = manifest.recipe;
  if (sha256Text(stableJson(recipeBody)) !== hash) {
    throw new CanonicalMediaError("Manifest recipe hash does not match", { code: "RECIPE_HASH_FAILED" });
  }
  if (sha256Text(stableJson(manifest.frameMap?.entries ?? [])) !== manifest.frameMap?.entriesSha256) {
    throw new CanonicalMediaError("Manifest frame map hash does not match", { code: "FRAME_MAP_HASH_FAILED" });
  }
}

export function readManifest(manifestPath) {
  let manifest;
  try {
    manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  } catch (error) {
    throw new CanonicalMediaError(`Unable to read manifest ${manifestPath}: ${error.message}`, {
      code: "INVALID_MANIFEST",
    });
  }
  assertManifestIntegrity(manifest);
  return manifest;
}

function atomicWriteJson(filePath, value) {
  mkdirSync(dirname(filePath), { recursive: true });
  const temporaryPath = `${filePath}.partial-${process.pid}-${randomBytes(4).toString("hex")}`;
  try {
    writeFileSync(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, { flag: "wx" });
    renameSync(temporaryPath, filePath);
  } finally {
    rmSync(temporaryPath, { force: true });
  }
}

function acquireLock(lockPath) {
  let descriptor;
  try {
    descriptor = openSync(lockPath, "wx");
    writeFileSync(descriptor, `${JSON.stringify({ pid: process.pid, createdAt: new Date().toISOString() })}\n`);
  } catch (error) {
    if (error.code === "EEXIST") {
      throw new CanonicalMediaError(`Cache build lock already exists: ${lockPath}`, {
        code: "CACHE_BUILD_LOCKED",
      });
    }
    throw error;
  }
  return () => {
    closeSync(descriptor);
    if (existsSync(lockPath)) unlinkSync(lockPath);
  };
}

async function verifyFingerprint(filePath, expected, description) {
  if (!existsSync(filePath)) {
    throw new CanonicalMediaError(`${description} is missing: ${filePath}`, { code: "CACHE_FILE_MISSING" });
  }
  const actual = await fingerprintStableFile(filePath);
  if (actual.size !== expected.size || actual.sha256 !== expected.sha256) {
    throw new CanonicalMediaError(`${description} fingerprint changed: ${filePath}`, {
      code: "FINGERPRINT_MISMATCH",
      details: { expected, actual },
    });
  }
  return actual;
}

async function reusableManifest({ manifestPath, cachePath, sourceFingerprint, recipe }) {
  if (!existsSync(cachePath) && !existsSync(manifestPath)) return null;
  if (!existsSync(manifestPath)) {
    throw new CanonicalMediaError(`Refusing to overwrite an unowned cache file without its manifest: ${cachePath}`, {
      code: "CACHE_OWNERSHIP_UNKNOWN",
    });
  }
  const manifest = readManifest(manifestPath);
  if (resolve(manifest.cache.path) !== resolve(cachePath)) {
    throw new CanonicalMediaError("Manifest cache path does not match the requested cache path", {
      code: "INVALID_MANIFEST",
    });
  }
  const sameSource = manifest.source.fingerprint.sha256 === sourceFingerprint.sha256
    && manifest.source.fingerprint.size === sourceFingerprint.size;
  const sameRecipe = manifest.recipe.hash === recipe.hash;
  if (!sameSource || !sameRecipe || !existsSync(cachePath)) return null;
  await verifyFingerprint(cachePath, manifest.cache.fingerprint, "cache");
  return manifest;
}

export async function buildCanonicalCache({
  input,
  fps: fpsInput,
  cacheDirectory = resolve(process.cwd(), ".render-cache/canonical-media"),
  profile = "quality",
  ffmpeg = "ffmpeg",
  ffprobe = "ffprobe",
  device = "/dev/dri/renderD128",
  sampleCount = 9,
  bitDepthPolicy = "reject",
  colorPolicy = "reject",
  sampleAspectRatio = null,
  onEvent = () => {},
}) {
  // Probe the decoded presentation timeline and media policy before hashing or encoding.
  const inspection = await inspectCanonicalSource({
    input,
    ffprobe,
    bitDepthPolicy,
    colorPolicy,
    sampleAspectRatio,
  });
  onEvent({ type: "source-probed", status: inspection.status, frameCount: inspection.timeline.frameCount });
  if (inspection.status !== "supported") throw new CanonicalPolicyRequiredError(inspection.blockers);
  const fps = parseFps(fpsInput);
  const normalizedSampleCount = normalizeSampleCount(sampleCount);
  const sourceFingerprint = await fingerprintStableFile(inspection.inputPath, inspection.stableStat);
  const recipe = await createRecipe({
    fps,
    inspection,
    profile,
    ffmpeg,
    ffprobe,
    device,
    sampleCount: normalizedSampleCount,
  });
  const paths = cachePaths({
    inputPath: inspection.inputPath,
    cacheDirectory: resolve(cacheDirectory),
    sourceHash: sourceFingerprint.sha256,
    recipe,
  });
  mkdirSync(dirname(paths.cachePath), { recursive: true });
  const existing = await reusableManifest({
    manifestPath: paths.manifestPath,
    cachePath: paths.cachePath,
    sourceFingerprint,
    recipe,
  });
  if (existing) {
    onEvent({ type: "cache-hit", cachePath: paths.cachePath });
    return { status: "hit", hit: true, cachePath: paths.cachePath, manifestPath: paths.manifestPath, manifest: existing };
  }

  const releaseLock = acquireLock(`${paths.cachePath}.lock`);
  const temporaryPath = `${paths.cachePath}.partial-${process.pid}-${randomBytes(4).toString("hex")}.mp4`;
  try {
    onEvent({ type: "cache-build", cachePath: paths.cachePath, profile });
    const encodeArgs = buildEncodeArguments({
      recipe,
      inspection,
      sourcePath: inspection.inputPath,
      outputPath: temporaryPath,
      device,
    });
    await runProcess(ffmpeg, encodeArgs, { captureStdout: false });
    const accepted = await acceptCache({
      cachePath: temporaryPath,
      sourcePath: inspection.inputPath,
      inspection,
      recipe,
      ffmpeg,
      ffprobe,
      sampleCount: normalizedSampleCount,
    });
    const sourceFingerprintAfterAcceptance = await fingerprintStableFile(
      inspection.inputPath,
      { size: sourceFingerprint.size, mtimeNs: sourceFingerprint.mtimeNs },
    );
    if (sourceFingerprintAfterAcceptance.sha256 !== sourceFingerprint.sha256) {
      throw new CanonicalMediaError("Source content changed while the cache was being encoded or accepted", {
        code: "SOURCE_CHANGED",
      });
    }
    const cacheFingerprint = await fingerprintStableFile(temporaryPath);
    const manifest = withManifestIntegrity({
      kind: MANIFEST_KIND,
      schemaVersion: MANIFEST_SCHEMA_VERSION,
      status: "ready",
      createdAt: new Date().toISOString(),
      source: {
        path: inspection.inputPath,
        fingerprint: sourceFingerprint,
        probe: sourceInspectionForManifest(inspection),
      },
      recipe,
      cache: {
        path: paths.cachePath,
        fingerprint: cacheFingerprint,
      },
      frameMap: accepted.frameMap,
      acceptance: accepted.acceptance,
    });
    renameSync(temporaryPath, paths.cachePath);
    atomicWriteJson(paths.manifestPath, manifest);
    onEvent({ type: "cache-ready", cachePath: paths.cachePath, frameCount: accepted.frameMap.cacheFrameCount });
    return { status: "built", hit: false, cachePath: paths.cachePath, manifestPath: paths.manifestPath, manifest };
  } finally {
    rmSync(temporaryPath, { force: true });
    releaseLock();
  }
}

function inspectionMatchesManifest(inspection, manifest) {
  const summary = sourceInspectionForManifest(inspection);
  return stableJson(summary) === stableJson(manifest.source.probe);
}

export async function verifyCanonicalCache({
  manifest: manifestInput,
  ffmpeg = "ffmpeg",
  ffprobe = "ffprobe",
  sampleCount = null,
}) {
  const manifestPath = resolve(manifestInput);
  const manifest = readManifest(manifestPath);
  const [ffmpegVersion, ffprobeVersion] = await Promise.all([
    commandVersion(ffmpeg),
    commandVersion(ffprobe),
  ]);
  if (manifest.recipe.toolchain?.ffmpegVersion !== ffmpegVersion
      || manifest.recipe.toolchain?.ffprobeVersion !== ffprobeVersion) {
    throw new CanonicalMediaError("Current FFmpeg/FFprobe versions differ from the hashed cache recipe; rebuild required", {
      code: "TOOLCHAIN_INVALIDATED",
      details: {
        expected: manifest.recipe.toolchain ?? null,
        actual: { ffmpegVersion, ffprobeVersion },
      },
    });
  }
  const sourcePath = resolve(manifest.source.path);
  const cachePath = resolve(manifest.cache.path);
  const inspection = await inspectCanonicalSource({
    input: sourcePath,
    ffprobe,
    bitDepthPolicy: manifest.recipe.bitDepthPolicy?.requestedPolicy ?? "reject",
    colorPolicy: manifest.recipe.colorPolicy?.requestedPolicy ?? "reject",
    sampleAspectRatio: manifest.recipe.sarPolicy?.mode === "explicit-for-missing-source-metadata"
      ? manifest.recipe.sarPolicy.declared
      : null,
  });
  if (inspection.status !== "supported") throw new CanonicalPolicyRequiredError(inspection.blockers);
  const sourceFingerprint = await fingerprintStableFile(sourcePath, inspection.stableStat);
  if (sourceFingerprint.sha256 !== manifest.source.fingerprint.sha256
      || sourceFingerprint.size !== manifest.source.fingerprint.size) {
    throw new CanonicalMediaError("Source fingerprint no longer matches the manifest", {
      code: "SOURCE_INVALIDATED",
    });
  }
  if (!inspectionMatchesManifest(inspection, manifest)) {
    throw new CanonicalMediaError("Source ffprobe contract no longer matches the manifest", {
      code: "SOURCE_PROBE_INVALIDATED",
    });
  }
  await verifyFingerprint(cachePath, manifest.cache.fingerprint, "cache");
  const accepted = await acceptCache({
    cachePath,
    sourcePath,
    inspection,
    recipe: manifest.recipe,
    ffmpeg,
    ffprobe,
    sampleCount: sampleCount == null
      ? normalizeSampleCount(manifest.recipe.acceptance?.pixelSampleTarget ?? 9)
      : normalizeSampleCount(sampleCount),
  });
  if (accepted.frameMap.entriesSha256 !== manifest.frameMap.entriesSha256
      || stableJson(accepted.frameMap.entries) !== stableJson(manifest.frameMap.entries)) {
    throw new CanonicalMediaError("Recomputed cacheFrameIndex -> source PTS map differs from the manifest", {
      code: "FRAME_MAP_ACCEPTANCE_FAILED",
    });
  }
  return {
    status: "verified",
    cachePath,
    manifestPath,
    frameCount: accepted.frameMap.cacheFrameCount,
    acceptance: accepted.acceptance,
  };
}
