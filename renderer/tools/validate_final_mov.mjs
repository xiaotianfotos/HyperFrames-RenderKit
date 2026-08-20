#!/usr/bin/env node

import { createHash, randomUUID } from "node:crypto";
import {
  createReadStream,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { spawn } from "node:child_process";
import { basename, dirname, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  FRAME_SIGNATURE_GRID_HEIGHT,
  FRAME_SIGNATURE_GRID_WIDTH,
  FRAME_SIGNATURE_MAX_CHANNEL_DELTA,
  FRAME_SIGNATURE_MAX_FRACTION_ABOVE_128,
  FRAME_SIGNATURE_MAX_MEAN_ABSOLUTE_DELTA,
  parseFrameSignatureSidecar,
} from "./frame_signature_sidecar.mjs";
import { canonicalJson } from "./frame_backend_preflight/lib.mjs";

const GOLDEN_MANIFEST_KIND = "hyperframes-golden-clip-manifest";
const GOLDEN_MANIFEST_SCHEMA_VERSION = 2;
const FULL_AUDIO_ORACLE_SCHEMA_VERSION = 1;
const FULL_VIDEO_ORACLE_SCHEMA_VERSION = 1;
const PRODUCTION_DECODER_EVIDENCE_SCHEMA_VERSION = 1;

function usage() {
  return `
Strictly validate a completed direct-to-MOV render without modifying it.

Usage:
  node tools/validate_final_mov.mjs --input=/path/final.mov --golden-manifest=/path/goldens.json [options]

The adjacent <input>.metrics.json is mandatory. The validator accepts either
full-canvas renderer metrics or segment-executor completion metrics. For the
latter it also opens every referenced segment metrics file. Missing evidence is
a failure, never an implicit zero/pass.

Required output contract:
  --frames=N                      Exact decoded video frame count
  --fps=60                        Exact average/nominal CFR
  --width=3840 --height=2160      Display dimensions
  --video-codec=h264              Video decoder name
  --video-tag=avc1                ISO BMFF sample entry
  --pixel-format=yuv420p          Decoded pixel format
  --audio-codec=pcm_s24le         PCM codec
  --audio-tag=in24                MOV PCM sample entry
  --audio-sample-format=s32       FFmpeg decoded sample format
  --audio-bits=24                 Valid bits in each decoded s32 sample
  --audio-rate=48000              Sample rate
  --audio-channels=2              Stereo; exact samples derive from frames/fps/rate

Evidence/output options:
  --metrics=PATH                  Completion metrics (default: <input>.metrics.json)
  --output-dir=PATH               Report destination (default: <input>.validation)
  --times=0,1.5,...               Optional representative positions
  --golden-manifest=PATH          Required identity-bound approved clip manifest
  --golden-crop-top=240           Crop known top-bar difference for the SSIM gate
  --ssim-min=0.98                 Minimum SSIM at every selected golden frame
  --skip-audio-scan=true          Skip informational volumedetect only; sample scan remains mandatory
  --skip-screenshots=true         Diagnostic only; final acceptance will fail without frame evidence

Oracle contract builders (print a manifest-ready JSON object; they do not approve it):
  --build-audio-oracle=PATH --project-identity=sha256:... [--audio-input-format=media|s24le]
  --build-video-oracle=PATH --project-identity=sha256:... --frames=N --width=W --height=H

The schema-v2 golden manifest must also bind two independent full-length oracles:
  fullAudioOracle                Lossless PCM reference + file/decoded-PCM SHA-256
  fullVideoOracle                Approved master + file SHA-256 + all-frame SSIM contract

The audio gate hashes every decoded canonical s32le sample. The video gate decodes
both complete streams and requires every scaled frame to meet the signed SSIM
threshold. Representative clips remain mandatory as human-readable evidence.
`;
}

function parseArgs(argv) {
  const result = {};
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith("--")) throw new Error(`Unexpected argument: ${token}`);
    const separator = token.indexOf("=");
    if (separator >= 0) {
      result[token.slice(2, separator)] = token.slice(separator + 1);
    } else {
      const key = token.slice(2);
      const next = argv[index + 1];
      if (next && !next.startsWith("--")) {
        result[key] = next;
        index += 1;
      } else {
        result[key] = "true";
      }
    }
  }
  return result;
}

function numberValue(value, name, fallback, { integer = false, minimum = -Infinity } = {}) {
  const parsed = Number(value ?? fallback);
  if (!Number.isFinite(parsed) || parsed < minimum || (integer && !Number.isInteger(parsed))) {
    throw new Error(`Invalid ${name}: ${value}`);
  }
  return parsed;
}

function booleanValue(value, name, fallback = false) {
  if (value == null) return fallback;
  if (["true", "1", "yes"].includes(String(value).toLowerCase())) return true;
  if (["false", "0", "no"].includes(String(value).toLowerCase())) return false;
  throw new Error(`Invalid ${name}: ${value}`);
}

function greatestCommonDivisor(left, right) {
  let a = left < 0n ? -left : left;
  let b = right < 0n ? -right : right;
  while (b !== 0n) [a, b] = [b, a % b];
  return a;
}

function rational(value, name, { positive = true } = {}) {
  if (value && typeof value === "object" && "numerator" in value) {
    return rational(`${value.numerator}/${value.denominator}`, name, { positive });
  }
  const parts = String(value ?? "").split("/");
  if (parts.length > 2 || !/^-?\d+$/.test(parts[0] ?? "") || !/^\d+$/.test(parts[1] ?? "1")) {
    throw new Error(`${name} is not a rational: ${value}`);
  }
  let numerator = BigInt(parts[0]);
  let denominator = BigInt(parts[1] ?? "1");
  if (denominator === 0n || (positive && numerator <= 0n)) {
    throw new Error(`${name} must be ${positive ? "positive" : "finite"}: ${value}`);
  }
  const divisor = greatestCommonDivisor(numerator, denominator);
  numerator /= divisor;
  denominator /= divisor;
  return { numerator, denominator };
}

function rationalString(value) {
  return `${value.numerator}/${value.denominator}`;
}

function rationalNumber(value) {
  return Number(value.numerator) / Number(value.denominator);
}

function ticksEqualDuration(ticks, timeBase, duration) {
  if (!Number.isSafeInteger(Number(ticks))) return false;
  const tickCount = BigInt(ticks);
  return tickCount * timeBase.numerator * duration.denominator
    === duration.numerator * timeBase.denominator;
}

function ratioEqual(actual, expected) {
  try {
    const parsed = rational(actual, "observed ratio");
    return parsed.numerator * expected.denominator === expected.numerator * parsed.denominator;
  } catch {
    return false;
  }
}

function decimalClose(actual, expected, tolerance = 0.000_001) {
  const parsed = Number(actual);
  return Number.isFinite(parsed) && Math.abs(parsed - expected) <= tolerance;
}

function own(object, key) {
  return object != null && Object.prototype.hasOwnProperty.call(object, key);
}

function display(value) {
  if (value === undefined) return "<missing>";
  if (value === null) return "null";
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}

function run(command, args, { cwd } = {}) {
  return new Promise((resolveRun, rejectRun) => {
    const child = spawn(command, args, {
      cwd,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.once("error", rejectRun);
    child.once("close", (code, signal) => {
      if (code === 0) resolveRun({ command, args, stdout, stderr, code });
      else rejectRun(Object.assign(
        new Error(`${command} exited ${code ?? signal}: ${stderr.trim().slice(-4_000)}`),
        { command, args, stdout, stderr, code, signal },
      ));
    });
  });
}

function hashCommandStdout(command, args, { cwd } = {}) {
  return new Promise((resolveHash, rejectHash) => {
    const child = spawn(command, args, {
      cwd,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const hash = createHash("sha256");
    let byteCount = 0;
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      hash.update(chunk);
      byteCount += chunk.length;
    });
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.once("error", rejectHash);
    child.once("close", (code, signal) => {
      if (code === 0) {
        resolveHash({
          sha256: `sha256:${hash.digest("hex")}`,
          byteCount,
          command,
          args,
        });
      } else {
        rejectHash(new Error(`${command} exited ${code ?? signal}: ${stderr.trim().slice(-4_000)}`));
      }
    });
  });
}

function canonicalPcmInputArgs(path, inputFormat, sampleRate, channels) {
  if (inputFormat === "s24le") {
    return ["-f", "s24le", "-ar", String(sampleRate), "-ac", String(channels), "-i", path];
  }
  if (inputFormat !== "media") throw new Error(`Unsupported fullAudioOracle.inputFormat: ${inputFormat}`);
  return ["-i", path];
}

export async function computeCanonicalPcmIdentity({
  path,
  inputFormat = "media",
  sampleRate = 48_000,
  channels = 2,
} = {}) {
  const resolvedPath = resolve(path);
  const result = await hashCommandStdout("ffmpeg", [
    "-hide_banner", "-loglevel", "error", "-nostdin", "-fflags", "+bitexact",
    ...canonicalPcmInputArgs(resolvedPath, inputFormat, sampleRate, channels),
    "-map", "0:a:0", "-vn", "-sn", "-dn",
    "-ac", String(channels), "-ar", String(sampleRate),
    "-c:a", "pcm_s32le", "-flags:a", "+bitexact", "-f", "s32le", "-",
  ]);
  const bytesPerSample = 4;
  const sampleStride = channels * bytesPerSample;
  if (result.byteCount % sampleStride !== 0) {
    throw new Error(`Canonical PCM byte count ${result.byteCount} is not divisible by ${sampleStride}`);
  }
  return {
    ...result,
    sampleRate,
    channels,
    canonicalSampleFormat: "s32le",
    samplesPerChannel: result.byteCount / sampleStride,
  };
}

export async function buildFullAudioOracleContract({
  path,
  projectIdentity,
  inputFormat = "media",
  sampleRate = 48_000,
  channels = 2,
  expectedSamplesPerChannel,
} = {}) {
  const canonicalProjectIdentity = canonicalSha256(projectIdentity);
  if (!canonicalProjectIdentity) throw new Error("full audio oracle builder requires projectIdentity=sha256:<64 hex>");
  const resolvedPath = resolve(path);
  if (!existsSync(resolvedPath) || statSync(resolvedPath).size === 0) throw new Error(`Audio oracle does not exist or is empty: ${resolvedPath}`);
  const identity = await computeCanonicalPcmIdentity({ path: resolvedPath, inputFormat, sampleRate, channels });
  if (expectedSamplesPerChannel != null && identity.samplesPerChannel !== expectedSamplesPerChannel) {
    throw new Error(`Audio oracle has ${identity.samplesPerChannel} samples/channel; expected ${expectedSamplesPerChannel}`);
  }
  return {
    schemaVersion: FULL_AUDIO_ORACLE_SCHEMA_VERSION,
    path: resolvedPath,
    fileSha256: await hashFileStreaming(resolvedPath),
    projectIdentity: canonicalProjectIdentity,
    inputFormat,
    sampleRate,
    channels,
    samplesPerChannel: identity.samplesPerChannel,
    canonicalSampleFormat: "s32le",
    decodedPcmSha256: identity.sha256,
  };
}

export async function buildFullVideoOracleContract({
  path,
  projectIdentity,
  frameCount,
  width,
  height,
  fps = "60",
  comparisonWidth = 960,
  comparisonHeight = 540,
  cropTop = 0,
  minimumSsim = 0.98,
} = {}) {
  const canonicalProjectIdentity = canonicalSha256(projectIdentity);
  if (!canonicalProjectIdentity) throw new Error("full video oracle builder requires projectIdentity=sha256:<64 hex>");
  const resolvedPath = resolve(path);
  if (!existsSync(resolvedPath) || statSync(resolvedPath).size === 0) throw new Error(`Video oracle does not exist or is empty: ${resolvedPath}`);
  if (!Number.isSafeInteger(comparisonWidth) || comparisonWidth <= 0 || comparisonWidth % 2 !== 0
    || !Number.isSafeInteger(comparisonHeight) || comparisonHeight <= 0 || comparisonHeight % 2 !== 0
    || !Number.isSafeInteger(cropTop) || cropTop < 0 || cropTop >= height
    || typeof minimumSsim !== "number" || minimumSsim <= 0 || minimumSsim > 1) {
    throw new Error("Invalid full-video all-frame SSIM comparison contract");
  }
  const probe = await probeFile(resolvedPath, true);
  const videoStreams = probe.streams?.filter((stream) => stream.codec_type === "video") ?? [];
  const video = videoStreams[0];
  const fpsRatio = rational(fps, "video oracle builder fps");
  if (videoStreams.length !== 1
    || Number(video?.nb_read_frames) !== frameCount
    || video?.width !== width
    || video?.height !== height
    || !ratioEqual(video?.avg_frame_rate, fpsRatio)
    || Number(video?.start_pts) !== 0) {
    throw new Error(`Video oracle does not satisfy the requested full-timeline contract: ${JSON.stringify({
      streams: videoStreams.length,
      frames: video?.nb_read_frames,
      width: video?.width,
      height: video?.height,
      fps: video?.avg_frame_rate,
      startPts: video?.start_pts,
    })}`);
  }
  return {
    schemaVersion: FULL_VIDEO_ORACLE_SCHEMA_VERSION,
    path: resolvedPath,
    fileSha256: await hashFileStreaming(resolvedPath),
    projectIdentity: canonicalProjectIdentity,
    frameCount,
    comparison: {
      kind: "all-frame-ssim-scaled-yuv420p-v1",
      width: comparisonWidth,
      height: comparisonHeight,
      cropTop,
      minimumSsim,
    },
  };
}

async function probeFile(file, countFrames = true) {
  const args = ["-v", "error"];
  if (countFrames) args.push("-count_frames", "-count_packets");
  args.push(
    "-show_entries",
    [
      "format=format_name,start_time,duration,size,bit_rate",
      "stream=index,codec_type,codec_name,codec_tag_string,profile,pix_fmt,width,height,"
        + "field_order,r_frame_rate,avg_frame_rate,nb_frames,nb_read_frames,nb_read_packets,"
        + "duration,duration_ts,time_base,start_time,start_pts,sample_fmt,sample_rate,channels,"
        + "channel_layout,bits_per_sample,bits_per_raw_sample,color_range,color_space,"
        + "color_transfer,color_primaries,chroma_location,sample_aspect_ratio",
    ].join(":"),
    "-of", "json",
    file,
  );
  return JSON.parse((await run("ffprobe", args)).stdout);
}

async function probeVideoTimeline(file) {
  const result = await run("ffprobe", [
    "-v", "error", "-select_streams", "v:0", "-show_frames",
    "-show_entries", "frame=best_effort_timestamp", "-of", "json", file,
  ]);
  const frames = JSON.parse(result.stdout).frames ?? [];
  return frames.map((frame, index) => {
    const value = Number(frame.best_effort_timestamp);
    if (!Number.isSafeInteger(value)) throw new Error(`video frame ${index} has no integral presentation timestamp`);
    return value;
  });
}

async function probeAudioTimeline(file, sampleRate, timeBase) {
  const result = await run("ffprobe", [
    "-v", "error", "-select_streams", "a:0", "-show_frames",
    "-show_entries", "frame=best_effort_timestamp,nb_samples", "-of", "json", file,
  ]);
  const frames = JSON.parse(result.stdout).frames ?? [];
  let samplesPerChannel = 0n;
  const mismatches = [];
  let mismatchCount = 0;
  for (let index = 0; index < frames.length; index += 1) {
    const timestamp = Number(frames[index].best_effort_timestamp);
    const samples = Number(frames[index].nb_samples);
    if (!Number.isSafeInteger(timestamp)) throw new Error(`audio frame ${index} has no integral presentation timestamp`);
    if (!Number.isSafeInteger(samples) || samples <= 0) throw new Error(`audio frame ${index} has invalid nb_samples`);
    const observedNumerator = BigInt(timestamp) * timeBase.numerator * BigInt(sampleRate);
    const expectedNumerator = samplesPerChannel * timeBase.denominator;
    if (observedNumerator !== expectedNumerator) {
      mismatchCount += 1;
      if (mismatches.length < 16) {
        mismatches.push({ index, timestamp, expectedStartSample: Number(samplesPerChannel) });
      }
    }
    samplesPerChannel += BigInt(samples);
  }
  return {
    frameCount: frames.length,
    samplesPerChannel,
    firstTimestamp: frames[0]?.best_effort_timestamp ?? null,
    mismatchCount,
    mismatches,
  };
}

function hashFile(file) {
  return createHash("sha256").update(readFileSync(file)).digest("hex");
}

function hashFileStreaming(file) {
  return new Promise((resolveHash, rejectHash) => {
    const hash = createHash("sha256");
    const stream = createReadStream(file);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.once("error", rejectHash);
    stream.once("end", () => resolveHash(`sha256:${hash.digest("hex")}`));
  });
}

function canonicalSha256(value) {
  const normalized = String(value ?? "").toLowerCase();
  const match = normalized.match(/^(?:sha256:)?([0-9a-f]{64})$/);
  return match ? `sha256:${match[1]}` : null;
}

function manifestRelativePath(manifestPath, value) {
  if (typeof value !== "string" || value.length === 0) return null;
  return resolve(dirname(manifestPath), value);
}

async function extractExactFrames(file, frameIndices, outputDirectory, label) {
  mkdirSync(outputDirectory, { recursive: true });
  const pattern = resolve(outputDirectory, `${label}-%03d.png`);
  const expression = frameIndices.map((frame) => `eq(n\\,${frame})`).join("+");
  await run("ffmpeg", [
    "-hide_banner", "-loglevel", "error", "-nostdin", "-y",
    "-i", file, "-map", "0:v:0", "-an", "-sn", "-dn",
    "-vf", `select=${expression},format=rgb24`, "-fps_mode", "vfr",
    "-start_number", "0", "-c:v", "png", pattern,
  ]);
  const records = [];
  for (let index = 0; index < frameIndices.length; index += 1) {
    const path = resolve(outputDirectory, `${label}-${String(index).padStart(3, "0")}.png`);
    if (!existsSync(path) || statSync(path).size === 0) {
      throw new Error(`${label} exact-frame extraction produced fewer than ${frameIndices.length} PNG files`);
    }
    records.push({ frame: frameIndices[index], path, sha256: hashFile(path), sizeBytes: statSync(path).size });
  }
  return records;
}

async function comparePngSsim(actual, golden, statsPath, cropTop = 0) {
  const statsName = basename(statsPath);
  const filter = cropTop > 0
    ? `[0:v]crop=iw:ih-${cropTop}:0:${cropTop}[actual];[1:v]crop=iw:ih-${cropTop}:0:${cropTop}[golden];[actual][golden]ssim=stats_file=${statsName}`
    : `[0:v][1:v]ssim=stats_file=${statsName}`;
  await run("ffmpeg", [
    "-hide_banner", "-loglevel", "warning", "-nostdin", "-y",
    "-i", actual, "-i", golden,
    "-lavfi", filter, "-frames:v", "1", "-f", "null", "-",
  ], { cwd: dirname(statsPath) });
  const line = readFileSync(statsPath, "utf8").trim().split(/\r?\n/).at(-1) ?? "";
  const match = line.match(/\bAll:([0-9.]+)/);
  if (!match) throw new Error(`Could not parse SSIM from ${statsPath}: ${line}`);
  return { all: Number(match[1]), raw: line, statsPath };
}

async function compareFullVideoOracle({ input, oraclePath, comparison, expectedFrames, artifactDir }) {
  mkdirSync(artifactDir, { recursive: true });
  const statsPath = resolve(artifactDir, "full-video-oracle-ssim.log");
  const statsName = basename(statsPath);
  const crop = comparison.cropTop > 0
    ? `crop=iw:ih-${comparison.cropTop}:0:${comparison.cropTop},`
    : "";
  const common = `${crop}scale=${comparison.width}:${comparison.height}:flags=bicubic,format=yuv420p`;
  await run("ffmpeg", [
    "-hide_banner", "-loglevel", "warning", "-nostdin", "-y",
    "-i", input, "-i", oraclePath,
    "-filter_complex_threads", "1",
    "-filter_complex", `[0:v:0]${common}[actual];[1:v:0]${common}[oracle];[actual][oracle]ssim=stats_file=${statsName}[checked]`,
    "-map", "[checked]", "-an", "-sn", "-dn",
    "-frames:v", String(expectedFrames), "-f", "null", "-",
  ], { cwd: artifactDir });

  const lines = readFileSync(statsPath, "utf8").trim().split(/\r?\n/).filter(Boolean);
  const frames = [];
  for (const line of lines) {
    const match = line.match(/\bn:(\d+)\b.*\bAll:([0-9.]+)/);
    if (!match) throw new Error(`Could not parse full-video SSIM line: ${line}`);
    frames.push({ frame: Number(match[1]) - 1, ssim: Number(match[2]) });
  }
  const sequential = frames.every((entry, index) => entry.frame === index);
  const failures = frames.filter((entry) => entry.ssim < comparison.minimumSsim);
  return {
    schemaVersion: 1,
    kind: "hyperframes-all-frame-ssim-result",
    oraclePath,
    statsPath,
    width: comparison.width,
    height: comparison.height,
    cropTop: comparison.cropTop,
    minimumSsimRequired: comparison.minimumSsim,
    frameCount: frames.length,
    sequential,
    minimum: frames.length ? Math.min(...frames.map((entry) => entry.ssim)) : null,
    average: average(frames.map((entry) => entry.ssim)),
    failedFrameCount: failures.length,
    failureSamples: failures.slice(0, 32),
  };
}

async function compareFinalToCaptureSignatures({ input, sidecars, expectedFrames }) {
  const signatureBytes = FRAME_SIGNATURE_GRID_WIDTH * FRAME_SIGNATURE_GRID_HEIGHT * 3;
  const expected = sidecars.flatMap((sidecar) => sidecar.signatures);
  if (expected.length !== expectedFrames) {
    throw new Error(`Capture signature coverage is ${expected.length}/${expectedFrames} frames`);
  }
  return new Promise((resolveComparison, rejectComparison) => {
    const child = spawn("ffmpeg", [
      "-hide_banner", "-loglevel", "error", "-nostdin", "-i", input,
      "-map", "0:v:0", "-an", "-sn", "-dn",
      "-vf", `scale=${FRAME_SIGNATURE_GRID_WIDTH}:${FRAME_SIGNATURE_GRID_HEIGHT}:flags=area,format=rgb24`,
      "-fps_mode", "passthrough", "-f", "rawvideo", "-pix_fmt", "rgb24", "-",
    ], { env: process.env, stdio: ["ignore", "pipe", "pipe"] });
    let pending = Buffer.alloc(0);
    let frameIndex = 0;
    let stderr = "";
    let minimumFrameSimilarity = 1;
    let globalMaximumChannelDelta = 0;
    let globalMeanAbsoluteDeltaSum = 0;
    let globalMaximumFractionAbove64 = 0;
    let globalMaximumFractionAbove128 = 0;
    let globalMaximumAverageHashDistance = 0;
    let globalMaximumDifferenceHashDistance = 0;
    let failureCount = 0;
    const failures = [];
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => { stderr = (stderr + chunk).slice(-8_000); });
    child.stdout.on("data", (chunk) => {
      pending = pending.length ? Buffer.concat([pending, chunk]) : chunk;
      while (pending.length >= signatureBytes) {
        const actual = pending.subarray(0, signatureBytes);
        pending = pending.subarray(signatureBytes);
        const reference = expected[frameIndex];
        if (!reference) {
          failureCount += 1;
          if (failures.length < 64) failures.push({ frame: frameIndex, reason: "unexpected decoded frame" });
          frameIndex += 1;
          continue;
        }
        let maximumChannelDelta = 0;
        let totalAbsoluteDelta = 0;
        let channelsAbove64 = 0;
        let channelsAbove128 = 0;
        for (let index = 0; index < signatureBytes; index += 1) {
          const delta = Math.abs(actual[index] - reference[index]);
          if (delta > maximumChannelDelta) maximumChannelDelta = delta;
          if (delta > 64) channelsAbove64 += 1;
          if (delta > 128) channelsAbove128 += 1;
          totalAbsoluteDelta += delta;
        }
        const meanAbsoluteDelta = totalAbsoluteDelta / signatureBytes;
        const fractionAbove64 = channelsAbove64 / signatureBytes;
        const fractionAbove128 = channelsAbove128 / signatureBytes;
        const similarity = 1 - totalAbsoluteDelta / (signatureBytes * 255);
        const actualLuma = [];
        const referenceLuma = [];
        for (let index = 0; index < signatureBytes; index += 3) {
          actualLuma.push(actual[index] * 0.2126 + actual[index + 1] * 0.7152 + actual[index + 2] * 0.0722);
          referenceLuma.push(reference[index] * 0.2126 + reference[index + 1] * 0.7152 + reference[index + 2] * 0.0722);
        }
        const actualLumaMean = actualLuma.reduce((sum, value) => sum + value, 0) / actualLuma.length;
        const referenceLumaMean = referenceLuma.reduce((sum, value) => sum + value, 0) / referenceLuma.length;
        let averageHashDifferences = 0;
        let differenceHashDifferences = 0;
        let differenceHashBits = 0;
        for (let index = 0; index < actualLuma.length; index += 1) {
          if ((actualLuma[index] >= actualLumaMean) !== (referenceLuma[index] >= referenceLumaMean)) {
            averageHashDifferences += 1;
          }
          const x = index % FRAME_SIGNATURE_GRID_WIDTH;
          if (x + 1 < FRAME_SIGNATURE_GRID_WIDTH) {
            if ((actualLuma[index + 1] >= actualLuma[index]) !== (referenceLuma[index + 1] >= referenceLuma[index])) {
              differenceHashDifferences += 1;
            }
            differenceHashBits += 1;
          }
        }
        const averageHashDistance = averageHashDifferences / actualLuma.length;
        const differenceHashDistance = differenceHashDifferences / differenceHashBits;
        minimumFrameSimilarity = Math.min(minimumFrameSimilarity, similarity);
        globalMaximumChannelDelta = Math.max(globalMaximumChannelDelta, maximumChannelDelta);
        globalMaximumFractionAbove64 = Math.max(globalMaximumFractionAbove64, fractionAbove64);
        globalMaximumFractionAbove128 = Math.max(globalMaximumFractionAbove128, fractionAbove128);
        globalMaximumAverageHashDistance = Math.max(globalMaximumAverageHashDistance, averageHashDistance);
        globalMaximumDifferenceHashDistance = Math.max(globalMaximumDifferenceHashDistance, differenceHashDistance);
        globalMeanAbsoluteDeltaSum += meanAbsoluteDelta;
        if (maximumChannelDelta > FRAME_SIGNATURE_MAX_CHANNEL_DELTA
            || meanAbsoluteDelta > FRAME_SIGNATURE_MAX_MEAN_ABSOLUTE_DELTA
            || fractionAbove128 > FRAME_SIGNATURE_MAX_FRACTION_ABOVE_128) {
          failureCount += 1;
          if (failures.length < 64) {
            failures.push({
              frame: frameIndex, maximumChannelDelta, meanAbsoluteDelta, fractionAbove64, fractionAbove128,
              averageHashDistance, differenceHashDistance, similarity,
            });
          }
        }
        frameIndex += 1;
      }
    });
    child.once("error", rejectComparison);
    child.once("close", (code, signal) => {
      if (code !== 0) {
        rejectComparison(new Error(`ffmpeg frame-signature decode exited ${code ?? signal}: ${stderr}`));
        return;
      }
      if (pending.length !== 0) {
        failureCount += 1;
        if (failures.length < 64) failures.push({ frame: frameIndex, reason: `${pending.length} trailing signature bytes` });
      }
      resolveComparison({
        kind: "hyperframes-final-vs-capture-frame-signatures",
        schemaVersion: 1,
        frameCount: frameIndex,
        expectedFrames,
        maximumChannelDeltaAllowed: FRAME_SIGNATURE_MAX_CHANNEL_DELTA,
        maximumMeanAbsoluteDeltaAllowed: FRAME_SIGNATURE_MAX_MEAN_ABSOLUTE_DELTA,
        maximumFractionAbove128Allowed: FRAME_SIGNATURE_MAX_FRACTION_ABOVE_128,
        globalMaximumChannelDelta,
        globalMaximumFractionAbove64,
        globalMaximumFractionAbove128,
        globalMaximumAverageHashDistance,
        globalMaximumDifferenceHashDistance,
        averageMeanAbsoluteDelta: frameIndex ? globalMeanAbsoluteDeltaSum / frameIndex : null,
        minimumFrameSimilarity: frameIndex ? minimumFrameSimilarity : null,
        failedFrameCount: failureCount,
        failureSamples: failures,
      });
    });
  });
}

async function validateFullAudioOracleContent({ input, oracle, contract, add }) {
  console.error(`[validate] hashing every canonical PCM sample from final and approved audio oracle`);
  const [finalIdentity, oracleIdentity] = await Promise.all([
    computeCanonicalPcmIdentity({
      path: input,
      inputFormat: "media",
      sampleRate: contract.audioRate,
      channels: contract.audioChannels,
    }),
    computeCanonicalPcmIdentity({
      path: oracle.path,
      inputFormat: oracle.inputFormat,
      sampleRate: contract.audioRate,
      channels: contract.audioChannels,
    }),
  ]);
  add("audio oracle decoded PCM identity", canonicalSha256(oracle.decodedPcmSha256), oracleIdentity.sha256,
    canonicalSha256(oracle.decodedPcmSha256) != null && canonicalSha256(oracle.decodedPcmSha256) === oracleIdentity.sha256);
  add("audio oracle decoded samples/channel", contract.expectedAudioSamplesPerChannel, oracleIdentity.samplesPerChannel,
    oracleIdentity.samplesPerChannel === contract.expectedAudioSamplesPerChannel);
  add("audio oracle declared samples/channel", contract.expectedAudioSamplesPerChannel, oracle.samplesPerChannel,
    oracle.samplesPerChannel === contract.expectedAudioSamplesPerChannel);
  add("final full PCM content", oracleIdentity.sha256, finalIdentity.sha256,
    finalIdentity.sha256 === oracleIdentity.sha256);
  add("final canonical PCM samples/channel", contract.expectedAudioSamplesPerChannel, finalIdentity.samplesPerChannel,
    finalIdentity.samplesPerChannel === contract.expectedAudioSamplesPerChannel);
  return { final: finalIdentity, oracle: oracleIdentity };
}

function average(values) {
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null;
}

function atomicWrite(path, content) {
  mkdirSync(dirname(path), { recursive: true });
  const temporary = resolve(dirname(path), `.${basename(path)}.tmp-${process.pid}-${randomUUID()}`);
  try {
    writeFileSync(temporary, content, { flag: "wx" });
    renameSync(temporary, path);
  } finally {
    if (existsSync(temporary)) unlinkSync(temporary);
  }
}

function relativeLink(reportDir, target) {
  return relative(reportDir, target).split("\\").join("/");
}

function markdownEscape(value) {
  return display(value).replaceAll("|", "\\|").replaceAll("\n", " ");
}

function renderMarkdown(report) {
  const lines = [
    "# Final MOV 严格验收报告",
    "",
    `- 结果：**${report.ok ? "PASS" : "FAIL"}**`,
    `- 文件：\`${report.input}\``,
    `- 验收时间：${report.createdAt}`,
    `- 目标：${report.contract.width}×${report.contract.height} / ${report.contract.fps} / ${report.contract.frames} 帧 / ${report.contract.durationSeconds.toFixed(6)} 秒`,
    `- 目标音频：${report.contract.audioCodec}/${report.contract.audioTag}，${report.contract.audioSampleFormat}(${report.contract.audioBits}-bit valid)，${report.contract.audioRate} Hz，${report.contract.expectedAudioSamplesPerChannel.toLocaleString()} samples/channel`,
    "",
    "## 门禁",
    "",
    "| 项目 | 预期 | 实际 | 结果 |",
    "|---|---|---|:---:|",
  ];
  for (const check of report.checks) {
    lines.push(`| ${markdownEscape(check.name)} | ${markdownEscape(check.expected)} | ${markdownEscape(check.actual)} | ${check.pass ? "PASS" : "FAIL"} |`);
  }

  lines.push("", "## 解码时间轴", "");
  if (report.videoTimeline) {
    lines.push(`- 视频：${report.videoTimeline.frameCount} 帧；首/尾 PTS ${report.videoTimeline.firstTimestamp}/${report.videoTimeline.lastTimestamp}；CFR 错位 ${report.videoTimeline.mismatchCount}`);
  }
  if (report.audioTimeline) {
    lines.push(`- 音频：${report.audioTimeline.frameCount} 个解码块；${report.audioTimeline.samplesPerChannel} samples/channel；连续性错位 ${report.audioTimeline.mismatchCount}`);
  }

  lines.push("", "## 全片内容 Oracle", "");
  if (report.fullVideoOracle?.result) {
    const result = report.fullVideoOracle.result;
    lines.push(`- 视频：逐帧比较 ${result.frameCount} 帧，最低/平均 SSIM ${result.minimum?.toFixed(6) ?? "-"}/${result.average?.toFixed(6) ?? "-"}，低于门槛 ${result.failedFrameCount} 帧。`);
  } else {
    lines.push(report.frameSignatures?.result
      ? "- 视频母版：未使用；完整时间线由 renderer capture 指纹覆盖。"
      : "- 视频：缺少可执行的完整母版或 capture 指纹合同。 ");
  }
  if (report.frameSignatures?.result) {
    const result = report.frameSignatures.result;
    lines.push(`- Capture 指纹：逐帧核对 ${result.frameCount} 帧，失败 ${result.failedFrameCount} 帧；最大通道差 ${result.globalMaximumChannelDelta}，平均绝对差 ${result.averageMeanAbsoluteDelta?.toFixed(4) ?? "-"}。`);
  }
  if (report.fullAudioOracle?.result) {
    lines.push(`- 音频：最终/Oracle 规范 PCM SHA-256 ${report.fullAudioOracle.result.final.sha256}/${report.fullAudioOracle.result.oracle.sha256}。`);
  } else {
    lines.push("- 音频：缺少可执行的完整无损 PCM 合同。 ");
  }

  lines.push("", "## 代表帧与 Golden", "");
  if (report.screenshots?.skipped) {
    lines.push("未提取代表帧；最终验收因此不能通过。");
  } else if (report.screenshots) {
    lines.push("| 帧 | 时间（秒） | 当前输出 | Golden | 全画面 SSIM | 裁切 SSIM |", "|---:|---:|---|---|---:|---:|");
    for (const frame of report.screenshots.frames) {
      const actual = frame.actualPath ? `[PNG](${relativeLink(report.reportDir, frame.actualPath)})` : "-";
      const comparisons = frame.comparisons ?? [];
      const golden = comparisons.length
        ? comparisons.map((item) => `${item.clipId}:[PNG](${relativeLink(report.reportDir, item.goldenPath)})`).join("<br>")
        : "-";
      const fullMinimum = comparisons.length ? Math.min(...comparisons.map((item) => item.ssimFull)) : null;
      const croppedMinimum = comparisons.length ? Math.min(...comparisons.map((item) => item.ssimCropped)) : null;
      lines.push(`| ${frame.frame} | ${frame.seconds.toFixed(6)} | ${actual} | ${golden} | ${fullMinimum?.toFixed(6) ?? "-"} | ${croppedMinimum?.toFixed(6) ?? "-"} |`);
    }
  }
  if (report.golden) {
    lines.push(
      "",
      `- Golden manifest：${report.golden.available ? `\`${report.golden.manifestPath}\`` : "缺失"}`,
      `- 身份：${report.golden.projectIdentity ?? "-"}`,
      `- 强制全局帧：${report.golden.requiredGlobalFrames?.join(", ") || "-"}`,
      `- SSIM 门槛：每个代表帧 ≥ ${report.golden.threshold}`,
      `- 全画面最低/平均：${report.golden.full.minimum?.toFixed(6) ?? "-"} / ${report.golden.full.average?.toFixed(6) ?? "-"}`,
      `- 裁掉顶部 ${report.golden.cropTop}px 后最低/平均：${report.golden.cropped.minimum?.toFixed(6) ?? "-"} / ${report.golden.cropped.average?.toFixed(6) ?? "-"}`,
    );
  }

  lines.push("", "## 音频响度（信息项）", "");
  if (report.audioScan?.skipped) lines.push(`已跳过：${report.audioScan.reason ?? "命令行选择"}`);
  else if (report.audioScan) {
    lines.push(`- 平均响度：${report.audioScan.meanVolume ?? "未读到"}`);
    lines.push(`- 峰值：${report.audioScan.maxVolume ?? "未读到"}`);
    lines.push(`- 日志：[audio-volumedetect.log](${relativeLink(report.reportDir, report.audioScan.logPath)})`);
  }

  if (report.errors.length) {
    lines.push("", "## 失败原因", "");
    for (const error of report.errors) lines.push(`- ${error}`);
  }
  if (report.warnings.length) {
    lines.push("", "## 提醒", "");
    for (const warning of report.warnings) lines.push(`- ${warning}`);
  }
  lines.push("");
  return lines.join("\n");
}

function makeCheckAppender(checks, prefix = "") {
  return (name, expected, actual, pass) => checks.push({
    name: prefix ? `${prefix}: ${name}` : name,
    expected,
    actual,
    pass: Boolean(pass),
  });
}

function comparablePath(value) {
  if (typeof value !== "string" || value.length === 0) return null;
  const absolute = resolve(value);
  try {
    return existsSync(absolute) ? realpathSync(absolute) : absolute;
  } catch {
    return absolute;
  }
}

function pathsMatch(left, right) {
  const leftPath = comparablePath(left);
  const rightPath = comparablePath(right);
  return leftPath != null && rightPath != null && leftPath === rightPath;
}

function validateZeroCounter(object, key, label, add) {
  const value = object?.[key];
  add(label, 0, own(object, key) ? value : undefined, own(object, key) && Number.isSafeInteger(value) && value === 0);
}

function validateVersionedEvidence(record, label, kind, add) {
  add(`${label} kind`, kind, record?.kind, record?.kind === kind);
  add(
    `${label} schema`,
    PRODUCTION_DECODER_EVIDENCE_SCHEMA_VERSION,
    record?.schemaVersion,
    record?.schemaVersion === PRODUCTION_DECODER_EVIDENCE_SCHEMA_VERSION,
  );
}

function validatePositiveInteger(object, key, label, add) {
  const value = object?.[key];
  add(label, "positive safe integer", own(object, key) ? value : undefined, own(object, key) && Number.isSafeInteger(value) && value > 0);
}

function validateNonnegativeInteger(object, key, label, add) {
  const value = object?.[key];
  add(label, "non-negative safe integer", own(object, key) ? value : undefined,
    own(object, key) && Number.isSafeInteger(value) && value >= 0);
}

function validateDecoderSnapshotProtocol(snapshot, label, add, {
  phase,
  expectedFrames,
  requireActiveEvidence = false,
} = {}) {
  add(`${label} protocol snapshot`, "present", snapshot ? "present" : undefined, Boolean(snapshot));
  if (!snapshot) return;

  validateVersionedEvidence(snapshot, label, "hyperframes-production-decoder-snapshot", add);
  add(`${label} phase`, phase, snapshot.phase, snapshot.phase === phase);
  validatePositiveInteger(snapshot, "directSources", `${label} direct sources`, add);
  validatePositiveInteger(snapshot, "outputFrames", `${label} output frames`, add);
  if (Number.isSafeInteger(expectedFrames)) {
    add(`${label} output-frame coverage`, expectedFrames, snapshot.outputFrames, snapshot.outputFrames === expectedFrames);
  }

  validateZeroCounter(snapshot, "cacheRequiredSources", `${label} cache-required sources`, add);
  validateZeroCounter(snapshot, "canonicalCacheDecisions", `${label} canonical-cache decisions`, add);
  validateZeroCounter(snapshot, "acquireFailures", `${label} acquire failures`, add);
  validateZeroCounter(snapshot.allocator?.metrics, "allocationFailures", `${label} lane allocation failures`, add);
  validateNonnegativeInteger(snapshot, "activeSources", `${label} active sources shape`, add);
  validateNonnegativeInteger(snapshot, "activeLanes", `${label} active lanes shape`, add);
  add(`${label} frame-open shape`, "boolean", snapshot.frameOpen, typeof snapshot.frameOpen === "boolean");
  validateNonnegativeInteger(snapshot.frameBudget, "outstandingFrames", `${label} outstanding-frame shape`, add);
  validateNonnegativeInteger(snapshot.frameBudget, "acquiredFrames", `${label} acquired-frame shape`, add);
  validateNonnegativeInteger(snapshot.frameBudget, "closedFrames", `${label} closed-frame shape`, add);

  const sources = snapshot.sourceMetrics;
  const lanes = snapshot.laneMetrics;
  add(`${label} source metrics`, "array", Array.isArray(sources) ? sources.length : undefined, Array.isArray(sources));
  add(`${label} lane metrics`, "array", Array.isArray(lanes) ? lanes.length : undefined, Array.isArray(lanes));
  if (!Array.isArray(sources) || !Array.isArray(lanes)) return;
  if (requireActiveEvidence) {
    add(`${label} direct source protocol evidence`, snapshot.directSources, sources.length, sources.length === snapshot.directSources && sources.length > 0);
    add(`${label} decoder lane protocol evidence`, "> 0 entries", lanes.length, lanes.length > 0);
  } else {
    add(`${label} disposed source metric entries`, 0, sources.length, sources.length === 0);
    add(`${label} disposed lane metric entries`, 0, lanes.length, lanes.length === 0);
  }
  for (let index = 0; index < sources.length; index += 1) {
    validateVersionedEvidence(sources[index], `${label} source ${index}`, "hyperframes-production-decoder-source-metrics", add);
    add(`${label} source ${index} id`, "non-empty string", sources[index]?.sourceId, typeof sources[index]?.sourceId === "string" && sources[index].sourceId.length > 0);
    validatePositiveInteger(sources[index], "framesAcquired", `${label} source ${index} frames acquired`, add);
    validateZeroCounter(sources[index], "validationFailures", `${label} source ${index} validation failures`, add);
  }
  for (let index = 0; index < lanes.length; index += 1) {
    validateVersionedEvidence(lanes[index], `${label} lane ${index}`, "hyperframes-production-decoder-lane-metrics", add);
    add(`${label} lane ${index} id`, "non-empty string", lanes[index]?.laneId, typeof lanes[index]?.laneId === "string" && lanes[index].laneId.length > 0);
    add(`${label} lane ${index} source id`, "non-empty string", lanes[index]?.sourceId, typeof lanes[index]?.sourceId === "string" && lanes[index].sourceId.length > 0);
    validatePositiveInteger(lanes[index], "framesDecoded", `${label} lane ${index} frames decoded`, add);
    validateZeroCounter(lanes[index], "exactPtsFailures", `${label} lane ${index} exact-PTS failures`, add);
    validateZeroCounter(lanes[index], "unexpectedOutputs", `${label} lane ${index} unexpected outputs`, add);
    validateZeroCounter(lanes[index], "duplicateOutputs", `${label} lane ${index} duplicate outputs`, add);
    if (requireActiveEvidence) {
      add(`${label} lane ${index} source reference`, "one declared source id", lanes[index]?.sourceId,
        sources.some((source) => source?.sourceId === lanes[index]?.sourceId));
    }
  }
}

function validateBrokerProtocol(snapshot, label, add, phase) {
  add(`${label} protocol snapshot`, "present", snapshot ? "present" : undefined, Boolean(snapshot));
  if (!snapshot) return;
  validateVersionedEvidence(snapshot, label, "hyperframes-production-decoder-broker-snapshot", add);
  add(`${label} phase`, phase, snapshot.phase, snapshot.phase === phase);
  validateVersionedEvidence(snapshot.byteBudget, `${label} byte budget`, "hyperframes-production-decoder-byte-budget", add);
  validateZeroCounter(snapshot, "canonicalCacheRequired", `${label} canonical-cache required`, add);
  validateZeroCounter(snapshot.byteBudget, "abortedWaits", `${label} aborted byte reservations`, add);
  validateNonnegativeInteger(snapshot, "activeSources", `${label} active sources shape`, add);
  validateNonnegativeInteger(snapshot, "activeCursors", `${label} active cursors shape`, add);
  validateNonnegativeInteger(snapshot, "pendingBegins", `${label} pending begins shape`, add);
  validateNonnegativeInteger(snapshot, "activeReads", `${label} active reads shape`, add);
  validateNonnegativeInteger(snapshot.byteBudget, "currentBytes", `${label} current-byte shape`, add);
  validateNonnegativeInteger(snapshot.byteBudget, "activeLeases", `${label} active-lease shape`, add);
  validateNonnegativeInteger(snapshot.byteBudget, "waitingReservations", `${label} waiting-reservation shape`, add);
}

function validateProductionResourceEvidence(metrics, add, expectedFrames) {
  const rendererContainer = metrics.renderer?.support?.productionDecoder;
  const mainContainer = metrics.productionDecoder;
  validateVersionedEvidence(rendererContainer, "renderer production-decoder evidence", "hyperframes-production-decoder-renderer-evidence", add);
  validateVersionedEvidence(mainContainer, "main production-decoder evidence", "hyperframes-production-decoder-main-evidence", add);
  const rendererFinal = rendererContainer?.final;
  validateVersionedEvidence(rendererFinal, "renderer production-decoder final evidence", "hyperframes-production-decoder-final-evidence", add);
  const before = rendererFinal?.beforeDispose;
  const after = rendererFinal?.afterDispose;
  const brokerBefore = mainContainer?.brokerBeforeDispose;
  const broker = mainContainer?.brokerAfterDispose;
  const brokerAfterRenderer = rendererFinal?.brokerAfterRendererDispose;
  validateDecoderSnapshotProtocol(before, "decoder before-dispose", add, {
    phase: "before-dispose", expectedFrames, requireActiveEvidence: true,
  });
  validateDecoderSnapshotProtocol(after, "decoder after-dispose", add, {
    phase: "after-dispose", expectedFrames,
  });
  validateBrokerProtocol(brokerBefore, "broker before-dispose", add, "before-dispose");
  validateBrokerProtocol(broker, "broker after-dispose", add, "after-dispose");
  validateBrokerProtocol(brokerAfterRenderer, "broker after-renderer-dispose", add, "after-renderer-dispose");
  add("decoder after-dispose evidence", "present", after ? "present" : undefined, Boolean(after));
  add("decoder active sources", 0, after?.activeSources, after?.activeSources === 0);
  add("decoder active lanes", 0, after?.activeLanes, after?.activeLanes === 0);
  add("decoder frame scope open", false, after?.frameOpen, after?.frameOpen === false);
  add("decoder outstanding frames", 0, after?.frameBudget?.outstandingFrames, after?.frameBudget?.outstandingFrames === 0);
  add(
    "decoder acquired/closed frames",
    "equal",
    `${display(after?.frameBudget?.acquiredFrames)}/${display(after?.frameBudget?.closedFrames)}`,
    Number.isSafeInteger(after?.frameBudget?.acquiredFrames)
      && after.frameBudget.acquiredFrames === after.frameBudget.closedFrames,
  );
  add("broker after-dispose evidence", "present", broker ? "present" : undefined, Boolean(broker));
  add("broker active sources", 0, broker?.activeSources, broker?.activeSources === 0);
  add("broker active cursors", 0, broker?.activeCursors, broker?.activeCursors === 0);
  add("broker pending begins", 0, broker?.pendingBegins, broker?.pendingBegins === 0);
  add("broker active reads", 0, broker?.activeReads, broker?.activeReads === 0);
  add("broker demux bytes", 0, broker?.byteBudget?.currentBytes, broker?.byteBudget?.currentBytes === 0);
  add("broker packet leases", 0, broker?.byteBudget?.activeLeases, broker?.byteBudget?.activeLeases === 0);
  add("broker waiting reservations", 0, broker?.byteBudget?.waitingReservations, broker?.byteBudget?.waitingReservations === 0);
  add("broker renderer-dispose sources", 0, brokerAfterRenderer?.activeSources, brokerAfterRenderer?.activeSources === 0);
  add("broker renderer-dispose cursors", 0, brokerAfterRenderer?.activeCursors, brokerAfterRenderer?.activeCursors === 0);
}

function findStagingSiblings(outputPath) {
  if (!existsSync(dirname(outputPath))) return [];
  const prefix = `.${basename(outputPath)}.hf-partial-`;
  return readdirSync(dirname(outputPath)).filter((name) => name.startsWith(prefix));
}

function validateFrameSignatureMetrics({ metrics, outputPath, expectedFrames, expectedStartFrame, contract, add }) {
  const evidence = metrics.screenshotSequence?.frameSignatureSidecar;
  add("frame signature evidence", "present, or fullVideoOracle fallback", evidence ? "present" : "manifest fallback required", true);
  if (!evidence) return null;
  const expectedPath = `${outputPath}.frame-signatures.bin`;
  add("frame signature committed", true, evidence.committed, evidence.committed === true);
  add("frame signature path", comparablePath(expectedPath), evidence.path, pathsMatch(evidence.path, expectedPath));
  add("frame signature file exists", true, existsSync(expectedPath), existsSync(expectedPath));
  add("frame signature staging absent", false,
    typeof evidence.stagingPath === "string" ? existsSync(evidence.stagingPath) : undefined,
    typeof evidence.stagingPath === "string" && !existsSync(evidence.stagingPath));
  if (!existsSync(expectedPath)) return null;
  try {
    const parsed = parseFrameSignatureSidecar(expectedPath);
    add("frame signature size", parsed.sizeBytes, evidence.sizeBytes, evidence.sizeBytes === parsed.sizeBytes);
    add("frame signature file SHA-256", parsed.sha256, canonicalSha256(evidence.sha256), canonicalSha256(evidence.sha256) === parsed.sha256);
    add("frame signature sequence SHA-256", parsed.sequenceSha256, canonicalSha256(evidence.sequenceSha256), canonicalSha256(evidence.sequenceSha256) === parsed.sequenceSha256);
    add("frame signature metrics header", "exact sidecar header", "metrics header",
      canonicalJson(evidence.header) === canonicalJson(parsed.header));
    add("frame signature frames", expectedFrames, parsed.frames, parsed.frames === expectedFrames && evidence.frames === expectedFrames);
    add("frame signature run id", metrics.runId, parsed.header.runId, typeof metrics.runId === "string" && parsed.header.runId === metrics.runId);
    const renderIdentityKeys = ["project", "entry", "assets", "timingBundle", "canonicalMediaRoute", "decoderMappings"];
    add("frame signature render identity fields", renderIdentityKeys,
      Object.keys(metrics.renderIdentity ?? {}).sort(),
      Object.keys(metrics.renderIdentity ?? {}).sort().join(",") === [...renderIdentityKeys].sort().join(","));
    for (const key of renderIdentityKeys) {
      add(`frame signature ${key} identity`, metrics.renderIdentity?.[key], parsed.header.renderIdentity?.[key],
        /^[a-f0-9]{64}$/i.test(String(metrics.renderIdentity?.[key] ?? ""))
          && parsed.header.renderIdentity?.[key] === metrics.renderIdentity?.[key]);
    }
    add("frame signature source dimensions", `${contract.width}x${contract.height}`,
      `${display(parsed.header.source?.width)}x${display(parsed.header.source?.height)}`,
      parsed.header.source?.width === contract.width && parsed.header.source?.height === contract.height);
    add("frame signature source fps", contract.fps, parsed.header.source?.fps,
      ratioEqual(parsed.header.source?.fps, contract.fpsRatio));
    add("frame signature source frames", expectedFrames, parsed.header.source?.frames,
      parsed.header.source?.frames === expectedFrames);
    add("frame signature source start frame", expectedStartFrame, parsed.header.source?.startFrame,
      parsed.header.source?.startFrame === expectedStartFrame);
    const expectedStartSeconds = expectedStartFrame / contract.fpsNumber;
    add("frame signature source start seconds", expectedStartSeconds, parsed.header.source?.startSeconds,
      decimalClose(parsed.header.source?.startSeconds, expectedStartSeconds, 1e-12));
    return parsed;
  } catch (error) {
    add("frame signature parse/integrity", "valid", error.message, false);
    return null;
  }
}

function validateRendererMetrics({ metrics, metricsPath, outputPath, expectedFrames, expectedStartFrame, contract, add }) {
  add("metrics failure field", "explicit null", own(metrics, "failure") ? metrics.failure : undefined, own(metrics, "failure") && metrics.failure === null);
  add("metrics failure kind", "explicit null", own(metrics, "failureKind") ? metrics.failureKind : undefined, own(metrics, "failureKind") && metrics.failureKind === null);
  add("metrics exit code", 0, metrics.failureExitCode, metrics.failureExitCode === 0);
  add("metrics final probe", "present", metrics.probe ? "present" : undefined, Boolean(metrics.probe));
  add("metrics output commit", true, metrics.outputCommit?.committed, metrics.outputCommit?.committed === true);
  if (own(metrics.outputCommit, "atomicRename")) {
    add("metrics atomic rename", true, metrics.outputCommit.atomicRename, metrics.outputCommit.atomicRename === true);
  }
  add(
    "metrics output path",
    comparablePath(outputPath),
    metrics.config?.output,
    pathsMatch(metrics.config?.output, outputPath),
  );
  add("metrics frame count", expectedFrames, metrics.config?.frames, Number(metrics.config?.frames) === expectedFrames);
  add("metrics start frame", expectedStartFrame, metrics.config?.startFrame, Number(metrics.config?.startFrame) === expectedStartFrame);
  add("metrics width", contract.width, metrics.config?.width, Number(metrics.config?.width) === contract.width);
  add("metrics height", contract.height, metrics.config?.height, Number(metrics.config?.height) === contract.height);
  add("metrics fps", contract.fps, metrics.config?.fps, ratioEqual(metrics.config?.fps, contract.fpsRatio));
  add("metrics project audio", true, metrics.config?.mixProjectAudio, metrics.config?.mixProjectAudio === true);
  add("metrics audio codec", contract.audioCodec, metrics.config?.audioCodec, metrics.config?.audioCodec === contract.audioCodec);
  add("metrics audio rate", contract.audioRate, metrics.config?.audioSampleRate, Number(metrics.config?.audioSampleRate) === contract.audioRate);
  add("renderer completed frames", expectedFrames, metrics.renderer?.framesCompleted, Number(metrics.renderer?.framesCompleted) === expectedFrames);
  add("renderer output chunks", expectedFrames, metrics.renderer?.outputChunks, Number(metrics.renderer?.outputChunks) === expectedFrames);
  add("renderer pending payload bytes", 0, metrics.renderer?.pendingPayloadBytes, metrics.renderer?.pendingPayloadBytes === 0);
  add("renderer media seek errors", 0, metrics.renderer?.mediaSeekErrors?.length, Array.isArray(metrics.renderer?.mediaSeekErrors) && metrics.renderer.mediaSeekErrors.length === 0);

  const expectedSamples = Number(BigInt(expectedFrames) * BigInt(contract.audioRate)
    * contract.fpsRatio.denominator / contract.fpsRatio.numerator);
  add("metrics decoded audio samples/channel", expectedSamples, metrics.decodedAudio?.samplesPerChannel, metrics.decodedAudio?.samplesPerChannel === expectedSamples);
  add("memory watchdog enabled", true, metrics.config?.memoryWatchdogEnabled, metrics.config?.memoryWatchdogEnabled === true);
  add("memory watchdog samples", "> 0", metrics.memoryWatchdog?.samplesObserved, Number(metrics.memoryWatchdog?.samplesObserved) > 0);
  add("memory watchdog violation", "explicit null", own(metrics.memoryWatchdog, "violation") ? metrics.memoryWatchdog.violation : undefined, own(metrics.memoryWatchdog, "violation") && metrics.memoryWatchdog.violation === null);

  const staged = metrics.outputCommit?.stagingOutput;
  add("staging output recorded", "non-empty path", staged, typeof staged === "string" && staged.length > 0);
  add("staging output differs from published output", true, staged, typeof staged === "string" && staged.length > 0 && !pathsMatch(staged, outputPath));
  add("staging output absent after commit", false, typeof staged === "string" ? existsSync(resolve(staged)) : undefined, typeof staged === "string" && !existsSync(resolve(staged)));
  add("no sibling partial outputs", 0, findStagingSiblings(outputPath).length, findStagingSiblings(outputPath).length === 0);
  const internalSize = Number(metrics.probe?.format?.size);
  add("metrics probe size", statSync(outputPath).size, Number.isFinite(internalSize) ? internalSize : undefined, internalSize === statSync(outputPath).size);
  add("metrics written after movie", true, statSync(metricsPath).mtimeMs >= statSync(outputPath).mtimeMs, statSync(metricsPath).mtimeMs >= statSync(outputPath).mtimeMs);

  let frameSignature = null;
  if (metrics.config?.mediaDecoderBackend === "production-webcodecs") {
    validateProductionResourceEvidence(metrics, add, expectedFrames);
  } else if (metrics.config?.outputBackend === "screenshot") {
    const gate = metrics.screenshotSequence?.mediaGate;
    add("screenshot captured frames", expectedFrames, metrics.screenshotSequence?.capturedFrames, metrics.screenshotSequence?.capturedFrames === expectedFrames);
    add("screenshot hash frames observed", expectedFrames, metrics.screenshotSequence?.frameHashSequence?.framesObserved, metrics.screenshotSequence?.frameHashSequence?.framesObserved === expectedFrames);
    add("screenshot media-gate evidence", "present", gate ? "present" : undefined, Boolean(gate));
    add("screenshot active URLs after render", 0, gate?.finalActiveUrls, gate?.finalActiveUrls === 0);
    add("screenshot active leases after render", 0, gate?.finalActiveLeases, gate?.finalActiveLeases === 0);
    frameSignature = validateFrameSignatureMetrics({
      metrics, outputPath, expectedFrames, expectedStartFrame, contract, add,
    });
  } else {
    add("known semantic backend", "screenshot or production-webcodecs", `${display(metrics.config?.outputBackend)}/${display(metrics.config?.mediaDecoderBackend)}`, false);
  }
  return { frameSignature };
}

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

function validateCompletionMetrics({ metricsPath, input, contract, add }) {
  add("adjacent completion metrics", "present", existsSync(metricsPath) ? metricsPath : undefined, existsSync(metricsPath));
  if (!existsSync(metricsPath)) return { metrics: null, flavor: null, rendererMetrics: [] };
  let metrics;
  try {
    metrics = readJson(metricsPath);
  } catch (error) {
    add("completion metrics JSON", "valid", error.message, false);
    return { metrics: null, flavor: null, rendererMetrics: [] };
  }
  add("completion metrics JSON", "valid", "valid", true);
  if (metrics.kind === "hyperframes-segment-executor-completion") {
    const executorAdd = (name, expected, actual, pass) => add(`executor ${name}`, expected, actual, pass);
    executorAdd("kind", "hyperframes-segment-executor-completion", metrics.kind, true);
    executorAdd("schema", 1, metrics.schemaVersion, metrics.schemaVersion === 1);
    executorAdd("failure", "explicit null", own(metrics, "failure") ? metrics.failure : undefined, own(metrics, "failure") && metrics.failure === null);
    executorAdd("commit", true, metrics.outputCommit?.committed, metrics.outputCommit?.committed === true);
    executorAdd("atomic rename", true, metrics.outputCommit?.atomicRename, metrics.outputCommit?.atomicRename === true);
    executorAdd("final output", comparablePath(input), metrics.finalOutput, pathsMatch(metrics.finalOutput, input));
    executorAdd("final observed output", comparablePath(input), metrics.finalObserved?.file, pathsMatch(metrics.finalObserved?.file, input));
    executorAdd("final size", statSync(input).size, metrics.finalSizeBytes, metrics.finalSizeBytes === statSync(input).size);
    executorAdd("metrics written after movie", true, statSync(metricsPath).mtimeMs >= statSync(input).mtimeMs, statSync(metricsPath).mtimeMs >= statSync(input).mtimeMs);
    executorAdd("no sibling partial outputs", 0, findStagingSiblings(input).length, findStagingSiblings(input).length === 0);
    executorAdd("final observed frame count", contract.frames, metrics.finalObserved?.video?.frameCount, metrics.finalObserved?.video?.frameCount === contract.frames);
    executorAdd("final observed samples/channel", contract.expectedAudioSamplesPerChannel, metrics.finalObserved?.audio?.sampleCount, metrics.finalObserved?.audio?.sampleCount === contract.expectedAudioSamplesPerChannel);
    const segments = Array.isArray(metrics.segments) ? metrics.segments : [];
    executorAdd("segments", "> 0", segments.length, segments.length > 0);
    let cursor = 0;
    const rendererMetrics = [];
    for (let index = 0; index < segments.length; index += 1) {
      const segment = segments[index];
      const segmentAdd = (name, expected, actual, pass) => add(`segment ${index} ${name}`, expected, actual, pass);
      segmentAdd("start frame", cursor, segment.startFrame, segment.startFrame === cursor);
      segmentAdd("frame count", "> 0", segment.frameCount, Number.isSafeInteger(segment.frameCount) && segment.frameCount > 0);
      if (Number.isSafeInteger(segment.frameCount) && segment.frameCount > 0) cursor += segment.frameCount;
      const outputPath = typeof segment.outputPath === "string" ? resolve(segment.outputPath) : null;
      const segmentMetricsPath = typeof segment.metricsPath === "string" ? resolve(segment.metricsPath) : null;
      segmentAdd("observed movie path", comparablePath(outputPath), segment.observed?.file, Boolean(outputPath && pathsMatch(segment.observed?.file, outputPath)));
      segmentAdd("adjacent metrics path", outputPath ? comparablePath(`${outputPath}.metrics.json`) : undefined, segmentMetricsPath, Boolean(outputPath && segmentMetricsPath && pathsMatch(segmentMetricsPath, `${outputPath}.metrics.json`)));
      segmentAdd("movie exists", true, outputPath ? existsSync(outputPath) : undefined, Boolean(outputPath && existsSync(outputPath)));
      segmentAdd("metrics exists", true, segmentMetricsPath ? existsSync(segmentMetricsPath) : undefined, Boolean(segmentMetricsPath && existsSync(segmentMetricsPath)));
      if (outputPath && segmentMetricsPath && existsSync(outputPath) && existsSync(segmentMetricsPath)) {
        try {
          const childMetrics = readJson(segmentMetricsPath);
          const evidence = validateRendererMetrics({
            metrics: childMetrics,
            metricsPath: segmentMetricsPath,
            outputPath,
            expectedFrames: segment.frameCount,
            expectedStartFrame: segment.startFrame,
            contract,
            add: segmentAdd,
          });
          rendererMetrics.push({ metricsPath: segmentMetricsPath, outputPath, metrics: childMetrics, ...evidence });
        } catch (error) {
          segmentAdd("metrics validation", "valid", error.message, false);
        }
      }
    }
    executorAdd("segment coverage", contract.frames, cursor, cursor === contract.frames);
    return { metrics, flavor: "segment-executor", rendererMetrics };
  }

  const evidence = validateRendererMetrics({
    metrics,
    metricsPath,
    outputPath: input,
    expectedFrames: contract.frames,
    expectedStartFrame: 0,
    contract,
    add: (name, expected, actual, pass) => add(`renderer ${name}`, expected, actual, pass),
  });
  return { metrics, flavor: "renderer", rendererMetrics: [{ metricsPath, outputPath: input, metrics, ...evidence }] };
}

function validateGoldenMetrics({
  metrics,
  metricsPath,
  moviePath,
  clip,
  approvedIdentity,
  projectIdentity,
  contract,
  add,
}) {
  const legacyApproved = approvedIdentity.legacyMetricsApproved === true;
  add("metrics failure", "explicit null", own(metrics, "failure") ? metrics.failure : undefined, own(metrics, "failure") && metrics.failure === null);
  add(
    "metrics failure kind",
    "null, or explicitly approved legacy omission",
    own(metrics, "failureKind") ? metrics.failureKind : "legacy-missing",
    own(metrics, "failureKind") ? metrics.failureKind === null : legacyApproved,
  );
  add(
    "metrics exit code",
    "0, or explicitly approved legacy omission",
    own(metrics, "failureExitCode") ? metrics.failureExitCode : "legacy-missing",
    own(metrics, "failureExitCode") ? metrics.failureExitCode === 0 : legacyApproved,
  );
  add("metrics commit", true, metrics.outputCommit?.committed, metrics.outputCommit?.committed === true);
  add("metrics output path", comparablePath(moviePath), metrics.config?.output, pathsMatch(metrics.config?.output, moviePath));
  add("metrics run id", approvedIdentity.metricsRunId, metrics.runId, typeof approvedIdentity.metricsRunId === "string" && metrics.runId === approvedIdentity.metricsRunId);
  add("metrics global start frame", clip.globalStartFrame, metrics.config?.startFrame, metrics.config?.startFrame === clip.globalStartFrame);
  add("metrics clip frame count", clip.frameCount, metrics.config?.frames, metrics.config?.frames === clip.frameCount);
  add("metrics fps", contract.fps, metrics.config?.fps, ratioEqual(metrics.config?.fps, contract.fpsRatio));
  add("metrics width", contract.width, metrics.config?.width, metrics.config?.width === contract.width);
  add("metrics height", contract.height, metrics.config?.height, metrics.config?.height === contract.height);
  add("metrics screenshot oracle", "screenshot/screenshot", `${display(metrics.config?.outputBackend)}/${display(metrics.config?.compositeMode)}`, metrics.config?.outputBackend === "screenshot" && metrics.config?.compositeMode === "screenshot");
  add("metrics completed frames", clip.frameCount, metrics.renderer?.framesCompleted, metrics.renderer?.framesCompleted === clip.frameCount);
  add("metrics output chunks", clip.frameCount, metrics.renderer?.outputChunks, metrics.renderer?.outputChunks === clip.frameCount);
  add("metrics pending payload bytes", 0, metrics.renderer?.pendingPayloadBytes, metrics.renderer?.pendingPayloadBytes === 0);
  add("metrics media seek errors", 0, metrics.renderer?.mediaSeekErrors?.length, Array.isArray(metrics.renderer?.mediaSeekErrors) && metrics.renderer.mediaSeekErrors.length === 0);
  add("metrics captured frames", clip.frameCount, metrics.screenshotSequence?.capturedFrames, metrics.screenshotSequence?.capturedFrames === clip.frameCount);
  add("metrics hash frames observed", clip.frameCount, metrics.screenshotSequence?.frameHashSequence?.framesObserved, metrics.screenshotSequence?.frameHashSequence?.framesObserved === clip.frameCount);
  add(
    "approved screenshot-sequence identity",
    canonicalSha256(approvedIdentity.screenshotSequenceSha256),
    canonicalSha256(metrics.screenshotSequence?.frameHashSequence?.sequenceSha256),
    canonicalSha256(approvedIdentity.screenshotSequenceSha256) != null
      && canonicalSha256(approvedIdentity.screenshotSequenceSha256)
        === canonicalSha256(metrics.screenshotSequence?.frameHashSequence?.sequenceSha256),
  );
  add("metrics active URLs after render", 0, metrics.screenshotSequence?.mediaGate?.finalActiveUrls, metrics.screenshotSequence?.mediaGate?.finalActiveUrls === 0);
  add("metrics active leases after render", 0, metrics.screenshotSequence?.mediaGate?.finalActiveLeases, metrics.screenshotSequence?.mediaGate?.finalActiveLeases === 0);
  const expectedSamples = Number(BigInt(clip.frameCount) * BigInt(contract.audioRate)
    * contract.fpsRatio.denominator / contract.fpsRatio.numerator);
  add("metrics decoded samples/channel", expectedSamples, metrics.decodedAudio?.samplesPerChannel, metrics.decodedAudio?.samplesPerChannel === expectedSamples);
  add("metrics watchdog samples", "> 0", metrics.memoryWatchdog?.samplesObserved, Number(metrics.memoryWatchdog?.samplesObserved) > 0);
  add("metrics watchdog violation", "explicit null", own(metrics.memoryWatchdog, "violation") ? metrics.memoryWatchdog.violation : undefined, own(metrics.memoryWatchdog, "violation") && metrics.memoryWatchdog.violation === null);
  add("approved project identity", projectIdentity, canonicalSha256(approvedIdentity.projectIdentity), projectIdentity != null
    && canonicalSha256(approvedIdentity.projectIdentity) === projectIdentity);
  if (metrics.renderIdentity?.project != null) {
    add("approved render identity", approvedIdentity.renderIdentityProject, metrics.renderIdentity.project, typeof approvedIdentity.renderIdentityProject === "string" && metrics.renderIdentity.project === approvedIdentity.renderIdentityProject);
  } else {
    add("legacy render identity omission approved", true, legacyApproved, legacyApproved);
  }
  add("metrics probe size", statSync(moviePath).size, metrics.probe?.format?.size, Number(metrics.probe?.format?.size) === statSync(moviePath).size);
  add("metrics written after clip", true, statSync(metricsPath).mtimeMs >= statSync(moviePath).mtimeMs, statSync(metricsPath).mtimeMs >= statSync(moviePath).mtimeMs);
  const staging = metrics.outputCommit?.stagingOutput;
  add("clip staging output recorded", "non-empty path", staging, typeof staging === "string" && staging.length > 0);
  add("clip staging differs from movie", true, staging, typeof staging === "string" && staging.length > 0 && !pathsMatch(staging, moviePath));
  add("clip staging output absent", false, typeof staging === "string" ? existsSync(resolve(staging)) : undefined, typeof staging === "string" && !existsSync(resolve(staging)));
}

async function validateFullAudioOracleManifest({ raw, manifestPath, input, finalMovieSha256, projectIdentity, contract, add }) {
  add("full audio oracle", "object", raw, raw != null && typeof raw === "object" && !Array.isArray(raw));
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  add("full audio oracle schema", FULL_AUDIO_ORACLE_SCHEMA_VERSION, raw.schemaVersion, raw.schemaVersion === FULL_AUDIO_ORACLE_SCHEMA_VERSION);
  const path = manifestRelativePath(manifestPath, raw.path);
  add("full audio oracle file", "existing non-empty file", path, Boolean(path && existsSync(path) && statSync(path).size > 0));
  if (!path || !existsSync(path) || statSync(path).size === 0) return null;
  const realPath = realpathSync(path);
  add("full audio oracle is not final path", true, realPath, realPath !== realpathSync(input));
  const fileSha256 = await hashFileStreaming(path);
  add("full audio oracle file SHA-256", canonicalSha256(raw.fileSha256), fileSha256,
    canonicalSha256(raw.fileSha256) != null && canonicalSha256(raw.fileSha256) === fileSha256);
  add("full audio oracle is not copied final", "different file SHA-256", fileSha256, fileSha256 !== finalMovieSha256);
  add("full audio oracle project identity", projectIdentity, canonicalSha256(raw.projectIdentity),
    projectIdentity != null && canonicalSha256(raw.projectIdentity) === projectIdentity);
  add("full audio oracle input format", "media or s24le", raw.inputFormat,
    raw.inputFormat === "media" || raw.inputFormat === "s24le");
  add("full audio oracle sample rate", contract.audioRate, raw.sampleRate, raw.sampleRate === contract.audioRate);
  add("full audio oracle channels", contract.audioChannels, raw.channels, raw.channels === contract.audioChannels);
  add("full audio oracle samples/channel", contract.expectedAudioSamplesPerChannel, raw.samplesPerChannel,
    raw.samplesPerChannel === contract.expectedAudioSamplesPerChannel);
  add("full audio oracle canonical format", "s32le", raw.canonicalSampleFormat, raw.canonicalSampleFormat === "s32le");
  add("full audio oracle decoded PCM SHA-256", "sha256:<64 hex>", raw.decodedPcmSha256,
    canonicalSha256(raw.decodedPcmSha256) != null);
  return {
    schemaVersion: raw.schemaVersion,
    path,
    fileSha256,
    projectIdentity: canonicalSha256(raw.projectIdentity),
    inputFormat: raw.inputFormat,
    sampleRate: raw.sampleRate,
    channels: raw.channels,
    samplesPerChannel: raw.samplesPerChannel,
    canonicalSampleFormat: raw.canonicalSampleFormat,
    decodedPcmSha256: canonicalSha256(raw.decodedPcmSha256),
  };
}

async function validateFullVideoOracleManifest({ raw, manifestPath, input, finalMovieSha256, projectIdentity, contract, add, required }) {
  add("full video oracle", required ? "object (capture sidecars do not cover the full timeline)" : "optional object",
    raw, required ? raw != null && typeof raw === "object" && !Array.isArray(raw) : raw == null || (typeof raw === "object" && !Array.isArray(raw)));
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  add("full video oracle schema", FULL_VIDEO_ORACLE_SCHEMA_VERSION, raw.schemaVersion, raw.schemaVersion === FULL_VIDEO_ORACLE_SCHEMA_VERSION);
  const path = manifestRelativePath(manifestPath, raw.path);
  add("full video oracle file", "existing non-empty file", path, Boolean(path && existsSync(path) && statSync(path).size > 0));
  if (!path || !existsSync(path) || statSync(path).size === 0) return null;
  const realPath = realpathSync(path);
  add("full video oracle is not final path", true, realPath, realPath !== realpathSync(input));
  const fileSha256 = await hashFileStreaming(path);
  add("full video oracle file SHA-256", canonicalSha256(raw.fileSha256), fileSha256,
    canonicalSha256(raw.fileSha256) != null && canonicalSha256(raw.fileSha256) === fileSha256);
  add("full video oracle is not copied final", "different file SHA-256", fileSha256, fileSha256 !== finalMovieSha256);
  add("full video oracle project identity", projectIdentity, canonicalSha256(raw.projectIdentity),
    projectIdentity != null && canonicalSha256(raw.projectIdentity) === projectIdentity);
  add("full video oracle frame count", contract.frames, raw.frameCount, raw.frameCount === contract.frames);

  const comparison = raw.comparison;
  add("full video oracle comparison", "object", comparison, comparison != null && typeof comparison === "object" && !Array.isArray(comparison));
  const comparisonValid = comparison != null && typeof comparison === "object" && !Array.isArray(comparison);
  if (comparisonValid) {
    add("full video comparison kind", "all-frame-ssim-scaled-yuv420p-v1", comparison.kind,
      comparison.kind === "all-frame-ssim-scaled-yuv420p-v1");
    add("full video comparison width", "positive even integer", comparison.width,
      Number.isSafeInteger(comparison.width) && comparison.width > 0 && comparison.width % 2 === 0 && comparison.width <= contract.width);
    add("full video comparison height", "positive even integer", comparison.height,
      Number.isSafeInteger(comparison.height) && comparison.height > 0 && comparison.height % 2 === 0 && comparison.height <= contract.height);
    add("full video comparison crop top", `integer 0..${contract.height - 1}`, comparison.cropTop,
      Number.isSafeInteger(comparison.cropTop) && comparison.cropTop >= 0 && comparison.cropTop < contract.height);
    add("full video comparison minimum SSIM", "number in (0,1]", comparison.minimumSsim,
      typeof comparison.minimumSsim === "number" && comparison.minimumSsim > 0 && comparison.minimumSsim <= 1);
  }

  const probe = await probeFile(path, true);
  const videoStreams = probe.streams?.filter((stream) => stream.codec_type === "video") ?? [];
  const video = videoStreams[0];
  add("full video oracle video stream count", 1, videoStreams.length, videoStreams.length === 1);
  add("full video oracle decoded frame count", contract.frames, video?.nb_read_frames,
    Number(video?.nb_read_frames) === contract.frames);
  add("full video oracle dimensions", `${contract.width}x${contract.height}`, `${display(video?.width)}x${display(video?.height)}`,
    video?.width === contract.width && video?.height === contract.height);
  add("full video oracle fps", contract.fps, video?.avg_frame_rate, ratioEqual(video?.avg_frame_rate, contract.fpsRatio));
  add("full video oracle start PTS", 0, video?.start_pts, Number(video?.start_pts) === 0);
  return {
    schemaVersion: raw.schemaVersion,
    path,
    fileSha256,
    projectIdentity: canonicalSha256(raw.projectIdentity),
    frameCount: raw.frameCount,
    comparison: comparisonValid ? {
      kind: comparison.kind,
      width: comparison.width,
      height: comparison.height,
      cropTop: comparison.cropTop,
      minimumSsim: comparison.minimumSsim,
    } : null,
    probe,
  };
}

async function validateGoldenManifest({
  manifestPath,
  input,
  finalMovieSha256,
  completion,
  contract,
  additionalTimes,
  add,
}) {
  add("golden manifest supplied", "existing file", manifestPath ?? undefined, Boolean(manifestPath && existsSync(manifestPath)));
  if (!manifestPath || !existsSync(manifestPath)) return null;
  let manifest;
  try {
    manifest = readJson(manifestPath);
  } catch (error) {
    add("golden manifest JSON", "valid", error.message, false);
    return null;
  }
  add("golden manifest kind", GOLDEN_MANIFEST_KIND, manifest.kind, manifest.kind === GOLDEN_MANIFEST_KIND);
  add("golden manifest schema", GOLDEN_MANIFEST_SCHEMA_VERSION, manifest.schemaVersion, manifest.schemaVersion === GOLDEN_MANIFEST_SCHEMA_VERSION);
  const projectIdentity = canonicalSha256(manifest.projectIdentity);
  add("golden manifest project identity", "sha256:<64 hex>", manifest.projectIdentity, projectIdentity != null);

  const captureSidecars = completion.rendererMetrics
    .map((entry) => entry.frameSignature)
    .filter(Boolean);
  const captureSidecarFrames = captureSidecars.reduce((sum, sidecar) => sum + sidecar.frames, 0);
  let captureCursor = 0;
  const captureSidecarRanges = captureSidecars.map((sidecar) => {
    const startFrame = sidecar.header.source.startFrame;
    const range = { path: sidecar.path, startFrame, frameCount: sidecar.frames, endFrame: startFrame + sidecar.frames };
    add(`capture sidecar range ${range.path}`, `start ${captureCursor}`, startFrame, startFrame === captureCursor);
    captureCursor += sidecar.frames;
    return range;
  });
  const captureSidecarsCoverFullTimeline = captureSidecars.length === completion.rendererMetrics.length
    && captureSidecarFrames === contract.frames
    && captureCursor === contract.frames
    && captureSidecarRanges.every((range, index) => range.startFrame === (index === 0 ? 0 : captureSidecarRanges[index - 1].endFrame));
  add("capture frame-signature coverage", contract.frames, captureSidecarFrames,
    captureSidecarsCoverFullTimeline || manifest.fullVideoOracle != null);

  const fullAudioOracle = await validateFullAudioOracleManifest({
    raw: manifest.fullAudioOracle,
    manifestPath,
    input,
    finalMovieSha256,
    projectIdentity,
    contract,
    add,
  });
  const fullVideoOracle = await validateFullVideoOracleManifest({
    raw: manifest.fullVideoOracle,
    manifestPath,
    input,
    finalMovieSha256,
    projectIdentity,
    contract,
    add,
    required: !captureSidecarsCoverFullTimeline,
  });

  const finalWholeProjectIdentity = canonicalSha256(completion.metrics?.projectIdentityVerification?.projectIdentity);
  const finalRendererIdentities = [...new Set(completion.rendererMetrics
    .map((entry) => entry.metrics?.renderIdentity?.project)
    .filter((value) => typeof value === "string" && value.length > 0))];
  if (completion.flavor === "segment-executor") {
    add(
      "executor canonical project identity",
      projectIdentity,
      completion.metrics?.projectIdentityVerification?.projectIdentity,
      projectIdentity != null && finalWholeProjectIdentity != null && finalWholeProjectIdentity === projectIdentity,
    );
  } else {
    const approvedFinalRendererIdentity = manifest.finalRenderIdentityProject;
    add(
      "direct renderer/manifest render identity",
      "explicit non-empty finalRenderIdentityProject shared by all renderer metrics",
      finalRendererIdentities,
      typeof approvedFinalRendererIdentity === "string"
        && approvedFinalRendererIdentity.length > 0
        && finalRendererIdentities.length > 0
        && finalRendererIdentities.every((identity) => identity === approvedFinalRendererIdentity),
    );
  }

  const additionalFrames = additionalTimes.map((seconds) => Math.min(
    contract.frames - 1,
    Math.round(seconds * contract.fpsNumber),
  ));
  const declaredRequiredFrames = Array.isArray(manifest.requiredGlobalFrames)
    ? manifest.requiredGlobalFrames
    : [];
  const declaredValid = declaredRequiredFrames.every((frame) => Number.isSafeInteger(frame)
    && frame >= 0 && frame < contract.frames);
  add("manifest additional required frames", "valid frame indices", declaredRequiredFrames, declaredValid);
  const requiredGlobalFrames = [...new Set([
    ...additionalFrames,
    ...(declaredValid ? declaredRequiredFrames : []),
  ])].sort((left, right) => left - right);

  const rawClips = Array.isArray(manifest.clips) ? manifest.clips : [];
  add("approved golden clips", "> 0", rawClips.length, rawClips.length > 0);
  const clips = [];
  const seenIds = new Set();
  const seenPaths = new Set();
  for (let index = 0; index < rawClips.length; index += 1) {
    const rawClip = rawClips[index];
    const clipAdd = (name, expected, actual, pass) => add(`golden clip ${index} ${name}`, expected, actual, pass);
    const id = typeof rawClip.id === "string" && rawClip.id.length > 0 ? rawClip.id : null;
    clipAdd("id", "unique non-empty string", id, Boolean(id && !seenIds.has(id)));
    if (id) seenIds.add(id);
    const moviePath = manifestRelativePath(manifestPath, rawClip.path);
    const metricsPath = manifestRelativePath(manifestPath, rawClip.metrics ?? rawClip.metricsPath ?? (rawClip.path ? `${rawClip.path}.metrics.json` : null));
    clipAdd("movie", "existing file", moviePath, Boolean(moviePath && existsSync(moviePath)));
    clipAdd("metrics", "existing file", metricsPath, Boolean(metricsPath && existsSync(metricsPath)));
    const resolvedRealPath = moviePath && existsSync(moviePath) ? realpathSync(moviePath) : null;
    clipAdd("unique movie path", true, resolvedRealPath, Boolean(resolvedRealPath && !seenPaths.has(resolvedRealPath)));
    if (resolvedRealPath) seenPaths.add(resolvedRealPath);
    clipAdd("not final movie path", true, resolvedRealPath, Boolean(resolvedRealPath && resolvedRealPath !== realpathSync(input)));
    const globalStartFrame = Number(rawClip.globalStartFrame);
    const frameCount = Number(rawClip.frameCount);
    clipAdd("global start frame", "integer >= 0", rawClip.globalStartFrame, Number.isSafeInteger(globalStartFrame) && globalStartFrame >= 0);
    clipAdd("frame count", "integer > 0", rawClip.frameCount, Number.isSafeInteger(frameCount) && frameCount > 0);
    clipAdd("interval inside final timeline", true, `${globalStartFrame}+${frameCount}`, Number.isSafeInteger(globalStartFrame)
      && Number.isSafeInteger(frameCount) && frameCount > 0 && globalStartFrame + frameCount <= contract.frames);
    const approvedIdentity = rawClip.approvedIdentity;
    clipAdd("approved identity", "object", approvedIdentity, approvedIdentity != null && typeof approvedIdentity === "object" && !Array.isArray(approvedIdentity));
    if (!moviePath || !metricsPath || !existsSync(moviePath) || !existsSync(metricsPath)
      || !approvedIdentity || typeof approvedIdentity !== "object") continue;

    const movieSha256 = await hashFileStreaming(moviePath);
    const metricsSha256 = await hashFileStreaming(metricsPath);
    clipAdd("movie SHA-256", canonicalSha256(approvedIdentity.movieSha256), movieSha256, canonicalSha256(approvedIdentity.movieSha256) === movieSha256);
    clipAdd("metrics SHA-256", canonicalSha256(approvedIdentity.metricsSha256), metricsSha256, canonicalSha256(approvedIdentity.metricsSha256) === metricsSha256);
    clipAdd("not a copied final self-golden", "different SHA-256 from final", movieSha256, movieSha256 !== finalMovieSha256);
    let metrics;
    try {
      metrics = readJson(metricsPath);
      validateGoldenMetrics({
        metrics,
        metricsPath,
        moviePath,
        clip: { globalStartFrame, frameCount },
        approvedIdentity,
        projectIdentity,
        contract,
        add: clipAdd,
      });
    } catch (error) {
      clipAdd("metrics validation", "valid", error.message, false);
      continue;
    }

    const probe = await probeFile(moviePath, true);
    const video = probe.streams?.filter((stream) => stream.codec_type === "video") ?? [];
    const primary = video[0];
    clipAdd("video stream count", 1, video.length, video.length === 1);
    clipAdd("decoded frame count", frameCount, primary?.nb_read_frames, Number(primary?.nb_read_frames) === frameCount);
    clipAdd("container frame count", frameCount, primary?.nb_frames, Number(primary?.nb_frames) === frameCount);
    clipAdd("width", contract.width, primary?.width, primary?.width === contract.width);
    clipAdd("height", contract.height, primary?.height, primary?.height === contract.height);
    clipAdd("fps", contract.fps, primary?.avg_frame_rate, ratioEqual(primary?.avg_frame_rate, contract.fpsRatio));
    clipAdd("local start", 0, primary?.start_pts, Number(primary?.start_pts) === 0);
    clipAdd("codec/sample entry", `${contract.videoCodec}/${contract.videoTag}`, `${display(primary?.codec_name)}/${display(primary?.codec_tag_string)}`, primary?.codec_name === contract.videoCodec && primary?.codec_tag_string === contract.videoTag);
    clipAdd("pixel/color/scan", `${contract.pixelFormat}/tv/bt709/progressive`, `${display(primary?.pix_fmt)}/${display(primary?.color_range)}/${display(primary?.color_space)}/${display(primary?.field_order)}`, primary?.pix_fmt === contract.pixelFormat
      && primary?.color_range === "tv" && primary?.color_space === "bt709"
      && primary?.color_transfer === "bt709" && primary?.color_primaries === "bt709"
      && primary?.field_order === "progressive");
    let clipDuration = null;
    try { clipDuration = rational(primary?.time_base, `golden clip ${index} video.time_base`); } catch {}
    const expectedDuration = { numerator: BigInt(frameCount) * contract.fpsRatio.denominator, denominator: contract.fpsRatio.numerator };
    clipAdd("exact duration", rationalString(expectedDuration), `${display(primary?.duration_ts)} × ${display(primary?.time_base)}`, Boolean(clipDuration && ticksEqualDuration(Number(primary?.duration_ts), clipDuration, expectedDuration)));
    clips.push({
      id,
      moviePath,
      metricsPath,
      globalStartFrame,
      frameCount,
      approvedIdentity,
      movieSha256,
      metricsSha256,
      probe,
      metrics,
      requiredGlobalFrames: [],
    });
  }

  for (const frame of requiredGlobalFrames) {
    const covering = clips.filter((clip) => frame >= clip.globalStartFrame
      && frame < clip.globalStartFrame + clip.frameCount);
    add(`golden coverage global frame ${frame}`, ">= 1 approved clip", covering.map((clip) => clip.id), covering.length > 0);
    for (const clip of covering) clip.requiredGlobalFrames.push(frame);
  }
  return {
    path: manifestPath,
    sha256: await hashFileStreaming(manifestPath),
    projectIdentity,
    requiredGlobalFrames,
    clips,
    fullAudioOracle,
    fullVideoOracle,
    captureSidecars,
    captureSidecarRanges,
    captureSidecarsCoverFullTimeline,
    raw: manifest,
  };
}

function buildOptions(raw = {}) {
  if (!raw.input) throw new Error("--input is required");
  if (raw.frames == null) throw new Error("--frames is required");
  const frames = numberValue(raw.frames, "--frames", null, { integer: true, minimum: 1 });
  const fpsRatio = rational(raw.fps ?? "60", "--fps");
  const width = numberValue(raw.width, "--width", 3_840, { integer: true, minimum: 1 });
  const height = numberValue(raw.height, "--height", 2_160, { integer: true, minimum: 1 });
  const audioRate = numberValue(raw.audioRate ?? raw["audio-rate"], "--audio-rate", 48_000, { integer: true, minimum: 1 });
  const audioChannels = numberValue(raw.audioChannels ?? raw["audio-channels"], "--audio-channels", 2, { integer: true, minimum: 1 });
  const audioBits = numberValue(raw.audioBits ?? raw["audio-bits"], "--audio-bits", 24, { integer: true, minimum: 1 });
  const sampleNumerator = BigInt(frames) * BigInt(audioRate) * fpsRatio.denominator;
  if (sampleNumerator % fpsRatio.numerator !== 0n) {
    throw new Error("The requested frame/fps/audio-rate contract does not end on an integral sample boundary");
  }
  const duration = { numerator: BigInt(frames) * fpsRatio.denominator, denominator: fpsRatio.numerator };
  const requestedTimes = (Array.isArray(raw.times) ? raw.times : String(raw.times ?? "").split(","))
    .filter((value) => String(value).length > 0)
    .map((value) => Number(value));
  if (requestedTimes.some((value) => !Number.isFinite(value) || value < 0)) {
    throw new Error(`Invalid --times: ${raw.times}`);
  }
  const input = resolve(raw.input);
  return {
    input,
    metricsPath: resolve(raw.metrics ?? `${input}.metrics.json`),
    reportDir: resolve(raw.outputDir ?? raw["output-dir"] ?? `${input}.validation`),
    goldenManifestPath: raw.goldenManifest ?? raw["golden-manifest"]
      ? resolve(raw.goldenManifest ?? raw["golden-manifest"])
      : null,
    unsupportedRawGoldenPath: raw.golden ? resolve(raw.golden) : null,
    cropTop: numberValue(raw.cropTop ?? raw["golden-crop-top"], "--golden-crop-top", 240, { integer: true, minimum: 0 }),
    ssimMinimum: numberValue(raw.ssimMinimum ?? raw["ssim-min"], "--ssim-min", 0.98, { minimum: 0 }),
    skipAudioScan: booleanValue(raw.skipAudioScan ?? raw["skip-audio-scan"], "--skip-audio-scan", false),
    skipScreenshots: booleanValue(raw.skipScreenshots ?? raw["skip-screenshots"], "--skip-screenshots", false),
    requestedTimes,
    contract: {
      frames,
      fps: rationalString(fpsRatio),
      fpsRatio,
      fpsNumber: rationalNumber(fpsRatio),
      width,
      height,
      duration,
      durationSeconds: rationalNumber(duration),
      videoCodec: raw.videoCodec ?? raw["video-codec"] ?? "h264",
      videoTag: raw.videoTag ?? raw["video-tag"] ?? "avc1",
      pixelFormat: raw.pixelFormat ?? raw["pixel-format"] ?? "yuv420p",
      audioCodec: raw.audioCodec ?? raw["audio-codec"] ?? "pcm_s24le",
      audioTag: raw.audioTag ?? raw["audio-tag"] ?? "in24",
      audioSampleFormat: raw.audioSampleFormat ?? raw["audio-sample-format"] ?? "s32",
      audioBits,
      audioRate,
      audioChannels,
      expectedAudioSamplesPerChannel: Number(sampleNumerator / fpsRatio.numerator),
    },
  };
}

export async function validateFinalMov(rawOptions = {}) {
  const options = buildOptions(rawOptions);
  const {
    input,
    metricsPath,
    reportDir,
    goldenManifestPath,
    unsupportedRawGoldenPath,
    cropTop,
    ssimMinimum,
    contract,
  } = options;
  if (existsSync(reportDir) && !statSync(reportDir).isDirectory()) {
    throw new Error(`Output directory is not a directory: ${reportDir}`);
  }
  mkdirSync(reportDir, { recursive: true });
  const artifactDir = resolve(reportDir, `artifacts-${Date.now()}-${randomUUID()}`);
  const report = {
    kind: "hyperframes-final-mov-acceptance",
    schemaVersion: 2,
    createdAt: new Date().toISOString(),
    input,
    metricsPath,
    reportDir,
    artifactDir,
    contract: {
      ...contract,
      fpsRatio: rationalString(contract.fpsRatio),
      duration: rationalString(contract.duration),
    },
    completionMetrics: null,
    inputSha256: null,
    probe: null,
    videoTimeline: null,
    audioTimeline: null,
    fullAudioOracle: null,
    fullVideoOracle: null,
    frameSignatures: null,
    audioScan: null,
    screenshots: null,
    golden: {
      required: true,
      manifestPath: goldenManifestPath,
      available: Boolean(goldenManifestPath && existsSync(goldenManifestPath)),
      cropTop,
      threshold: ssimMinimum,
      full: { average: null, minimum: null },
      cropped: { average: null, minimum: null },
      requiredGlobalFrames: [],
      clips: [],
    },
    checks: [],
    errors: [],
    warnings: [],
    ok: false,
  };
  const add = makeCheckAppender(report.checks);
  const fatal = [];

  try {
    add("input movie exists", true, existsSync(input), existsSync(input));
    if (!existsSync(input)) throw new Error(`Input does not exist: ${input}`);
    add("input movie non-empty", "> 0", statSync(input).size, statSync(input).size > 0);

    const completion = validateCompletionMetrics({ metricsPath, input, contract, add });
    report.completionMetrics = completion.metrics ? {
      flavor: completion.flavor,
      kind: completion.metrics.kind ?? "full-canvas-renderer-metrics",
      createdAt: completion.metrics.createdAt,
      processWallMs: completion.metrics.processWallMs,
      finalizeMs: completion.metrics.finalizeMs,
      failure: completion.metrics.failure,
      rendererMetrics: completion.rendererMetrics.map((entry) => entry.metricsPath),
    } : null;
    report.warnings.push(
      "Current renderer/executor metrics do not contain a cryptographic final-output digest. "
      + "This validator therefore hard-binds every metrics record to the resolved MOV path, file size, probe evidence, and write ordering, "
      + "then hashes the MOV independently. A future metrics schema should record that SHA-256 at commit time to close preserved-mtime/same-size post-commit replacement.",
    );
    add("raw --golden is forbidden", "not supplied; use --golden-manifest", unsupportedRawGoldenPath, unsupportedRawGoldenPath == null);
    console.error("[validate] hashing final movie to forbid copied self-goldens");
    report.inputSha256 = await hashFileStreaming(input);
    const goldenManifest = await validateGoldenManifest({
      manifestPath: goldenManifestPath,
      input,
      finalMovieSha256: report.inputSha256,
      completion,
      contract,
      additionalTimes: options.requestedTimes,
      add,
    });
    if (goldenManifest) {
      report.golden.available = true;
      report.golden.manifestSha256 = goldenManifest.sha256;
      report.golden.projectIdentity = goldenManifest.projectIdentity;
      report.golden.requiredGlobalFrames = goldenManifest.requiredGlobalFrames;
      report.golden.clips = goldenManifest.clips.map((clip) => ({
        id: clip.id,
        path: clip.moviePath,
        metricsPath: clip.metricsPath,
        globalStartFrame: clip.globalStartFrame,
        frameCount: clip.frameCount,
        movieSha256: clip.movieSha256,
        metricsSha256: clip.metricsSha256,
        requiredGlobalFrames: clip.requiredGlobalFrames,
      }));
      report.fullAudioOracle = goldenManifest.fullAudioOracle
        ? { contract: goldenManifest.fullAudioOracle, result: null }
        : null;
      report.fullVideoOracle = goldenManifest.fullVideoOracle
        ? { contract: { ...goldenManifest.fullVideoOracle, probe: undefined }, result: null }
        : null;
      report.frameSignatures = goldenManifest.captureSidecars.length
        ? {
          contracts: goldenManifest.captureSidecars.map((sidecar) => ({
            path: sidecar.path,
            sha256: sidecar.sha256,
            sequenceSha256: sidecar.sequenceSha256,
            frames: sidecar.frames,
            header: sidecar.header,
          })),
          result: null,
        }
        : null;
    }

    console.error(`[validate] decoding/probing all ${contract.frames} video frames`);
    const probe = await probeFile(input, true);
    report.probe = probe;
    const videoStreams = probe.streams?.filter((stream) => stream.codec_type === "video") ?? [];
    const audioStreams = probe.streams?.filter((stream) => stream.codec_type === "audio") ?? [];
    const video = videoStreams[0];
    const audio = audioStreams[0];
    add("stream count", 2, probe.streams?.length, probe.streams?.length === 2);
    add("video stream count", 1, videoStreams.length, videoStreams.length === 1);
    add("audio stream count", 1, audioStreams.length, audioStreams.length === 1);
    add("container", "mov", probe.format?.format_name, String(probe.format?.format_name ?? "").split(",").includes("mov"));
    add("width", contract.width, video?.width, video?.width === contract.width);
    add("height", contract.height, video?.height, video?.height === contract.height);
    add("video codec", contract.videoCodec, video?.codec_name, video?.codec_name === contract.videoCodec);
    add("video sample entry", contract.videoTag, video?.codec_tag_string, video?.codec_tag_string === contract.videoTag);
    add("pixel format", contract.pixelFormat, video?.pix_fmt, video?.pix_fmt === contract.pixelFormat);
    add("field order", "progressive", video?.field_order, video?.field_order === "progressive");
    add("average frame rate", contract.fps, video?.avg_frame_rate, ratioEqual(video?.avg_frame_rate, contract.fpsRatio));
    add("nominal frame rate", contract.fps, video?.r_frame_rate, ratioEqual(video?.r_frame_rate, contract.fpsRatio));
    add("decoded frame count", contract.frames, video?.nb_read_frames, Number(video?.nb_read_frames) === contract.frames);
    add("packet frame count", contract.frames, video?.nb_read_packets, Number(video?.nb_read_packets) === contract.frames);
    add("container frame count", contract.frames, video?.nb_frames, Number(video?.nb_frames) === contract.frames);
    add("video start PTS", 0, video?.start_pts, Number(video?.start_pts) === 0);
    add("video start time", 0, video?.start_time, decimalClose(video?.start_time, 0));
    add("color range", "tv", video?.color_range, video?.color_range === "tv");
    add("color matrix", "bt709", video?.color_space, video?.color_space === "bt709");
    add("color transfer", "bt709", video?.color_transfer, video?.color_transfer === "bt709");
    add("color primaries", "bt709", video?.color_primaries, video?.color_primaries === "bt709");

    let videoTimeBase = null;
    let audioTimeBase = null;
    try { videoTimeBase = rational(video?.time_base, "video.time_base"); } catch (error) { fatal.push(error.message); }
    try { audioTimeBase = rational(audio?.time_base, "audio.time_base"); } catch (error) { fatal.push(error.message); }
    add("video exact duration", rationalString(contract.duration), `${display(video?.duration_ts)} × ${display(video?.time_base)}`, Boolean(videoTimeBase && ticksEqualDuration(Number(video?.duration_ts), videoTimeBase, contract.duration)));
    add("video decimal duration", contract.durationSeconds.toFixed(6), video?.duration, decimalClose(video?.duration, contract.durationSeconds));

    add("audio codec", contract.audioCodec, audio?.codec_name, audio?.codec_name === contract.audioCodec);
    add("audio sample entry", contract.audioTag, audio?.codec_tag_string, audio?.codec_tag_string === contract.audioTag);
    add("audio decoded sample format", contract.audioSampleFormat, audio?.sample_fmt, audio?.sample_fmt === contract.audioSampleFormat);
    add("audio valid bits", contract.audioBits, `${display(audio?.bits_per_sample)}/${display(audio?.bits_per_raw_sample)}`, Number(audio?.bits_per_sample) === contract.audioBits && Number(audio?.bits_per_raw_sample) === contract.audioBits);
    add("audio sample rate", contract.audioRate, audio?.sample_rate, Number(audio?.sample_rate) === contract.audioRate);
    add("audio channels", contract.audioChannels, audio?.channels, Number(audio?.channels) === contract.audioChannels);
    add("audio layout", "stereo", audio?.channel_layout, audio?.channel_layout === "stereo");
    add("audio start PTS", 0, audio?.start_pts, Number(audio?.start_pts) === 0);
    add("audio start time", 0, audio?.start_time, decimalClose(audio?.start_time, 0));
    add("audio exact duration", rationalString(contract.duration), `${display(audio?.duration_ts)} × ${display(audio?.time_base)}`, Boolean(audioTimeBase && ticksEqualDuration(Number(audio?.duration_ts), audioTimeBase, contract.duration)));
    add("audio decimal duration", contract.durationSeconds.toFixed(6), audio?.duration, decimalClose(audio?.duration, contract.durationSeconds));
    add("container start", 0, probe.format?.start_time, decimalClose(probe.format?.start_time, 0));
    add("container duration", contract.durationSeconds.toFixed(6), probe.format?.duration, decimalClose(probe.format?.duration, contract.durationSeconds));
    add("file size", statSync(input).size, probe.format?.size, Number(probe.format?.size) === statSync(input).size);

    if (videoTimeBase) {
      const presentationTimestamps = await probeVideoTimeline(input);
      const mismatches = [];
      let mismatchCount = 0;
      for (let index = 0; index < presentationTimestamps.length; index += 1) {
        const timestamp = BigInt(presentationTimestamps[index]);
        const left = timestamp * videoTimeBase.numerator * contract.fpsRatio.numerator;
        const right = BigInt(index) * videoTimeBase.denominator * contract.fpsRatio.denominator;
        if (left !== right) {
          mismatchCount += 1;
          if (mismatches.length < 16) {
            mismatches.push({ index, timestamp: presentationTimestamps[index] });
          }
        }
      }
      report.videoTimeline = {
        frameCount: presentationTimestamps.length,
        firstTimestamp: presentationTimestamps[0] ?? null,
        lastTimestamp: presentationTimestamps.at(-1) ?? null,
        mismatchCount,
        mismatchSamples: mismatches,
      };
      add("decoded video timeline count", contract.frames, presentationTimestamps.length, presentationTimestamps.length === contract.frames);
      add("decoded video CFR PTS", "every frame on exact output grid from zero", mismatchCount, mismatchCount === 0);
    }

    if (goldenManifest?.captureSidecarsCoverFullTimeline) {
      console.error(`[validate] comparing all ${contract.frames} decoded frames with renderer capture signatures`);
      const result = await compareFinalToCaptureSignatures({
        input,
        sidecars: goldenManifest.captureSidecars,
        expectedFrames: contract.frames,
      });
      report.frameSignatures.result = result;
      add("capture-signature decoded frame count", contract.frames, result.frameCount,
        result.frameCount === contract.frames);
      add("capture-signature every-frame content", 0, result.failedFrameCount,
        result.failedFrameCount === 0);
    }

    if (goldenManifest?.fullVideoOracle?.comparison) {
      console.error(`[validate] comparing every decoded video frame with the approved full master`);
      const result = await compareFullVideoOracle({
        input,
        oraclePath: goldenManifest.fullVideoOracle.path,
        comparison: goldenManifest.fullVideoOracle.comparison,
        expectedFrames: contract.frames,
        artifactDir,
      });
      report.fullVideoOracle.result = result;
      add("full-video oracle decoded frame count", contract.frames, result.frameCount, result.frameCount === contract.frames);
      add("full-video oracle frame order", "0..N-1", result.sequential, result.sequential === true);
      add("full-video oracle every-frame SSIM", 0, result.failedFrameCount, result.failedFrameCount === 0);
    }

    if (audioTimeBase) {
      const timeline = await probeAudioTimeline(input, contract.audioRate, audioTimeBase);
      report.audioTimeline = {
        frameCount: timeline.frameCount,
        samplesPerChannel: Number(timeline.samplesPerChannel),
        firstTimestamp: timeline.firstTimestamp,
        mismatchCount: timeline.mismatchCount,
        mismatchSamples: timeline.mismatches,
      };
      add("decoded audio frames", "> 0", timeline.frameCount, timeline.frameCount > 0);
      add("decoded audio samples/channel", contract.expectedAudioSamplesPerChannel, Number(timeline.samplesPerChannel), timeline.samplesPerChannel === BigInt(contract.expectedAudioSamplesPerChannel));
      add("decoded audio PTS continuity", "zero-origin and sample-contiguous", timeline.mismatchCount, timeline.mismatchCount === 0);
    }

    if (goldenManifest?.fullAudioOracle) {
      const result = await validateFullAudioOracleContent({
        input,
        oracle: goldenManifest.fullAudioOracle,
        contract,
        add,
      });
      report.fullAudioOracle.result = result;
    }

    if (options.skipAudioScan) {
      report.audioScan = { skipped: true, reason: "--skip-audio-scan=true; exact decoded-sample scan still completed" };
    } else {
      console.error("[validate] scanning complete audio stream with volumedetect");
      const volume = await run("ffmpeg", [
        "-hide_banner", "-nostats", "-nostdin", "-i", input,
        "-map", "0:a:0", "-af", "volumedetect", "-f", "null", "-",
      ]);
      mkdirSync(artifactDir, { recursive: true });
      const logPath = resolve(artifactDir, "audio-volumedetect.log");
      writeFileSync(logPath, volume.stderr);
      const meanVolume = volume.stderr.match(/mean_volume:\s*([^\r\n]+)/)?.[1]?.trim() ?? null;
      const maxVolume = volume.stderr.match(/max_volume:\s*([^\r\n]+)/)?.[1]?.trim() ?? null;
      report.audioScan = { skipped: false, meanVolume, maxVolume, logPath };
      if (!meanVolume || !maxVolume) report.warnings.push("volumedetect did not return both mean_volume and max_volume.");
      if (maxVolume?.startsWith("-inf")) report.warnings.push("The complete audio stream appears silent.");
    }

    if (options.skipScreenshots) {
      report.screenshots = { skipped: true, frames: [] };
      add("representative frame extraction", "completed", "skipped", false);
    } else {
      const fallbackFrames = options.requestedTimes.length > 0
        ? [...new Set(options.requestedTimes
          .map((seconds) => Math.min(contract.frames - 1, Math.round(seconds * contract.fpsNumber))))]
          .sort((left, right) => left - right)
        : [...new Set([0, Math.floor((contract.frames - 1) / 2), contract.frames - 1])];
      const uniqueFrames = goldenManifest?.requiredGlobalFrames ?? fallbackFrames;
      mkdirSync(artifactDir, { recursive: true });
      console.error(`[validate] extracting ${uniqueFrames.length} exact representative frames in one decode pass`);
      const actualRecords = await extractExactFrames(input, uniqueFrames, artifactDir, "actual");
      add("representative frame extraction", uniqueFrames.length, actualRecords.length, actualRecords.length === uniqueFrames.length);
      const frameRecords = actualRecords.map((record) => ({
        frame: record.frame,
        seconds: record.frame / contract.fpsNumber,
        actualPath: record.path,
        actualSha256: record.sha256,
        goldenPath: null,
        goldenSha256: null,
        ssimFull: null,
        ssimCropped: null,
        comparisons: [],
      }));

      if (goldenManifest) {
        if (cropTop >= contract.height) throw new Error(`--golden-crop-top must be smaller than ${contract.height}`);
        const fullValues = [];
        const croppedValues = [];
        for (let clipIndex = 0; clipIndex < goldenManifest.clips.length; clipIndex += 1) {
          const clip = goldenManifest.clips[clipIndex];
          if (!clip.requiredGlobalFrames.length) continue;
          const localFrames = clip.requiredGlobalFrames.map((frame) => frame - clip.globalStartFrame);
          console.error(`[validate] extracting ${localFrames.length} approved frames from golden clip ${clip.id}`);
          const goldenRecords = await extractExactFrames(
            clip.moviePath,
            localFrames,
            artifactDir,
            `golden-${String(clipIndex).padStart(3, "0")}`,
          );
          for (let index = 0; index < clip.requiredGlobalFrames.length; index += 1) {
            const globalFrame = clip.requiredGlobalFrames[index];
            const frame = frameRecords.find((record) => record.frame === globalFrame);
            const golden = goldenRecords[index];
            if (!frame || !golden) throw new Error(`Missing mapped golden evidence for global frame ${globalFrame}`);
            const stem = `${String(globalFrame).padStart(8, "0")}-${String(clipIndex).padStart(3, "0")}`;
            const full = await comparePngSsim(frame.actualPath, golden.path, resolve(artifactDir, `ssim-${stem}-full.log`));
            const cropped = cropTop > 0
              ? await comparePngSsim(frame.actualPath, golden.path, resolve(artifactDir, `ssim-${stem}-crop.log`), cropTop)
              : full;
            const comparison = {
              clipId: clip.id,
              clipPath: clip.moviePath,
              localFrame: golden.frame,
              goldenPath: golden.path,
              goldenSha256: golden.sha256,
              ssimFull: full.all,
              ssimCropped: cropped.all,
            };
            frame.comparisons.push(comparison);
            if (!frame.goldenPath) {
              frame.goldenPath = golden.path;
              frame.goldenSha256 = golden.sha256;
              frame.ssimFull = full.all;
              frame.ssimCropped = cropped.all;
            }
            fullValues.push(full.all);
            croppedValues.push(cropped.all);
            add(`golden ${clip.id} global frame ${globalFrame} SSIM`, `>= ${ssimMinimum}`, cropped.all, cropped.all >= ssimMinimum);
          }
        }
        report.golden.full = { average: average(fullValues), minimum: fullValues.length ? Math.min(...fullValues) : null };
        report.golden.cropped = { average: average(croppedValues), minimum: croppedValues.length ? Math.min(...croppedValues) : null };
      }
      report.screenshots = { skipped: false, timesRequested: options.requestedTimes, frames: frameRecords };
    }
  } catch (error) {
    fatal.push(error?.stack ?? String(error));
  }

  for (const message of fatal) report.errors.push(`fatal: ${message}`);
  report.errors.push(...report.checks.filter((check) => !check.pass)
    .map((check) => `${check.name}: expected ${display(check.expected)}, got ${display(check.actual)}`));
  report.ok = report.errors.length === 0;
  const jsonPath = resolve(reportDir, "validation.json");
  const markdownPath = resolve(reportDir, "validation.md");
  report.reportJson = jsonPath;
  report.reportMarkdown = markdownPath;
  atomicWrite(jsonPath, `${JSON.stringify(report, null, 2)}\n`);
  atomicWrite(markdownPath, `${renderMarkdown(report)}\n`);
  return report;
}

async function main() {
  const rawArgs = parseArgs(process.argv.slice(2));
  if (rawArgs.help === "true") {
    console.log(usage().trim());
    return;
  }
  if (rawArgs["build-audio-oracle"]) {
    if (rawArgs.frames == null) throw new Error("--frames is required when building an audio oracle");
    const frames = numberValue(rawArgs.frames, "--frames", null, { integer: true, minimum: 1 });
    const fpsRatio = rational(rawArgs.fps ?? "60", "--fps");
    const sampleRate = numberValue(rawArgs["audio-rate"], "--audio-rate", 48_000, { integer: true, minimum: 1 });
    const channels = numberValue(rawArgs["audio-channels"], "--audio-channels", 2, { integer: true, minimum: 1 });
    const sampleNumerator = BigInt(frames) * BigInt(sampleRate) * fpsRatio.denominator;
    if (sampleNumerator % fpsRatio.numerator !== 0n) throw new Error("Audio oracle contract does not end on an integral sample boundary");
    const contract = await buildFullAudioOracleContract({
      path: rawArgs["build-audio-oracle"],
      projectIdentity: rawArgs["project-identity"],
      inputFormat: rawArgs["audio-input-format"] ?? "media",
      sampleRate,
      channels,
      expectedSamplesPerChannel: Number(sampleNumerator / fpsRatio.numerator),
    });
    console.log(JSON.stringify(contract, null, 2));
    return;
  }
  if (rawArgs["build-video-oracle"]) {
    if (rawArgs.frames == null) throw new Error("--frames is required when building a video oracle");
    const contract = await buildFullVideoOracleContract({
      path: rawArgs["build-video-oracle"],
      projectIdentity: rawArgs["project-identity"],
      frameCount: numberValue(rawArgs.frames, "--frames", null, { integer: true, minimum: 1 }),
      width: numberValue(rawArgs.width, "--width", 3_840, { integer: true, minimum: 1 }),
      height: numberValue(rawArgs.height, "--height", 2_160, { integer: true, minimum: 1 }),
      fps: rawArgs.fps ?? "60",
      comparisonWidth: numberValue(rawArgs["comparison-width"], "--comparison-width", 960, { integer: true, minimum: 2 }),
      comparisonHeight: numberValue(rawArgs["comparison-height"], "--comparison-height", 540, { integer: true, minimum: 2 }),
      cropTop: numberValue(rawArgs["golden-crop-top"], "--golden-crop-top", 0, { integer: true, minimum: 0 }),
      minimumSsim: numberValue(rawArgs["ssim-min"], "--ssim-min", 0.98, { minimum: 0 }),
    });
    console.log(JSON.stringify(contract, null, 2));
    return;
  }
  const report = await validateFinalMov(rawArgs);
  console.log(JSON.stringify({
    ok: report.ok,
    input: basename(report.input),
    jsonPath: report.reportJson,
    markdownPath: report.reportMarkdown,
    failedChecks: report.errors,
    decodedAudioSamplesPerChannel: report.audioTimeline?.samplesPerChannel ?? null,
    golden: report.golden ? {
      available: report.golden.available,
      manifestPath: report.golden.manifestPath,
      requiredGlobalFrames: report.golden.requiredGlobalFrames,
      clipCount: report.golden.clips?.length ?? 0,
      threshold: report.golden.threshold,
      full: report.golden.full,
      cropped: report.golden.cropped,
    } : null,
  }, null, 2));
  if (!report.ok) process.exitCode = 1;
}

const isCli = process.argv[1]
  && pathToFileURL(resolve(process.argv[1])).href === pathToFileURL(fileURLToPath(import.meta.url)).href;
if (isCli) {
  main().catch((error) => {
    console.error(error?.stack ?? error);
    process.exitCode = 1;
  });
}
