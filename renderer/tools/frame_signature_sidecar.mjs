import { createHash } from "node:crypto";
import {
  constants,
  copyFileSync,
  createReadStream,
  createWriteStream,
  existsSync,
  readFileSync,
  statSync,
  unlinkSync,
} from "node:fs";
import { once } from "node:events";

export const FRAME_SIGNATURE_KIND = "hyperframes-frame-signature-sidecar";
export const FRAME_SIGNATURE_SCHEMA_VERSION = 1;
export const FRAME_SIGNATURE_GRID_WIDTH = 32;
export const FRAME_SIGNATURE_GRID_HEIGHT = 18;
export const FRAME_SIGNATURE_CHANNELS = 3;
export const FRAME_SIGNATURE_RECORD_BYTES = 4
  + FRAME_SIGNATURE_GRID_WIDTH * FRAME_SIGNATURE_GRID_HEIGHT * FRAME_SIGNATURE_CHANNELS;
export const FRAME_SIGNATURE_MAX_CHANNEL_DELTA = 192;
export const FRAME_SIGNATURE_MAX_MEAN_ABSOLUTE_DELTA = 16;
export const FRAME_SIGNATURE_MAX_FRACTION_ABOVE_128 = 0.006;

const HEADER_MAGIC = Buffer.from("HFSIGV1\0", "ascii");
const TRAILER_MAGIC = Buffer.from("HFSIGEND", "ascii");
const HASH_BYTES = 32;
const TRAILER_BYTES = TRAILER_MAGIC.length + 4 + HASH_BYTES;
const RENDER_IDENTITY_KEYS = Object.freeze([
  "project", "entry", "assets", "timingBundle", "canonicalMediaRoute", "decoderMappings",
]);

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

export function createFrameSignatureHeader({
  runId,
  renderIdentity,
  width,
  height,
  fps,
  frames,
  startFrame,
  startSeconds,
} = {}) {
  if (typeof runId !== "string" || runId.length === 0) throw new Error("Frame signature runId is required");
  if (!renderIdentity || typeof renderIdentity !== "object") throw new Error("Frame signature renderIdentity is required");
  const renderIdentityKeys = Object.keys(renderIdentity).sort();
  if (renderIdentityKeys.join(",") !== [...RENDER_IDENTITY_KEYS].sort().join(",")
      || RENDER_IDENTITY_KEYS.some((key) => !/^[a-f0-9]{64}$/i.test(String(renderIdentity[key] ?? "")))) {
    throw new Error("Frame signature renderIdentity must contain the complete versioned 64-hex identity set");
  }
  for (const [name, value] of [["width", width], ["height", height], ["frames", frames]]) {
    if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`Invalid frame signature ${name}: ${value}`);
  }
  if (!Number.isFinite(fps) || fps <= 0) throw new Error(`Invalid frame signature fps: ${fps}`);
  if (startFrame != null && (!Number.isSafeInteger(startFrame) || startFrame < 0)) throw new Error(`Invalid frame signature startFrame: ${startFrame}`);
  if (!Number.isFinite(startSeconds) || startSeconds < 0) throw new Error(`Invalid frame signature startSeconds: ${startSeconds}`);
  return Object.freeze({
    kind: FRAME_SIGNATURE_KIND,
    schemaVersion: FRAME_SIGNATURE_SCHEMA_VERSION,
    runId,
    renderIdentity,
    source: { width, height, fps, frames, startFrame, startSeconds },
    signature: {
      gridWidth: FRAME_SIGNATURE_GRID_WIDTH,
      gridHeight: FRAME_SIGNATURE_GRID_HEIGHT,
      channels: FRAME_SIGNATURE_CHANNELS,
      sampleFormat: "rgb24",
      captureAlgorithm: "electron-nativeimage-best-resize-bgra-to-rgb-v1",
      validationAlgorithm: "ffmpeg-area-scale-rgb24-v1",
      recordBytes: FRAME_SIGNATURE_RECORD_BYTES,
      maximumChannelDelta: FRAME_SIGNATURE_MAX_CHANNEL_DELTA,
      maximumMeanAbsoluteDelta: FRAME_SIGNATURE_MAX_MEAN_ABSOLUTE_DELTA,
      maximumFractionAbove128: FRAME_SIGNATURE_MAX_FRACTION_ABOVE_128,
    },
  });
}

export function rgbSignatureFromResizedBgra(bitmap) {
  const expected = FRAME_SIGNATURE_GRID_WIDTH * FRAME_SIGNATURE_GRID_HEIGHT * 4;
  if (!Buffer.isBuffer(bitmap) || bitmap.length !== expected) {
    throw new Error(`Resized BGRA signature bitmap must be ${expected} bytes; got ${bitmap?.length}`);
  }
  const rgb = Buffer.allocUnsafe(FRAME_SIGNATURE_GRID_WIDTH * FRAME_SIGNATURE_GRID_HEIGHT * 3);
  for (let source = 0, target = 0; source < bitmap.length; source += 4, target += 3) {
    rgb[target] = bitmap[source + 2];
    rgb[target + 1] = bitmap[source + 1];
    rgb[target + 2] = bitmap[source];
  }
  return rgb;
}

function encodeHeader(header) {
  const json = Buffer.from(stableJson(header), "utf8");
  const prefix = Buffer.allocUnsafe(HEADER_MAGIC.length + 4);
  HEADER_MAGIC.copy(prefix, 0);
  prefix.writeUInt32LE(json.length, HEADER_MAGIC.length);
  return Buffer.concat([prefix, json]);
}

function encodeRecord(frameIndex, signature) {
  if (!Number.isSafeInteger(frameIndex) || frameIndex < 0) throw new Error(`Invalid signature frame index: ${frameIndex}`);
  const expected = FRAME_SIGNATURE_RECORD_BYTES - 4;
  if (!Buffer.isBuffer(signature) || signature.length !== expected) {
    throw new Error(`Frame signature must be ${expected} bytes; got ${signature?.length}`);
  }
  const record = Buffer.allocUnsafe(FRAME_SIGNATURE_RECORD_BYTES);
  record.writeUInt32LE(frameIndex, 0);
  signature.copy(record, 4);
  return record;
}

async function streamingFileSha256(path) {
  const hash = createHash("sha256");
  const stream = createReadStream(path);
  stream.on("data", (chunk) => hash.update(chunk));
  await once(stream, "end");
  return `sha256:${hash.digest("hex")}`;
}

export function createFrameSignatureWriter({ stagingPath, finalPath, header } = {}) {
  if (existsSync(stagingPath)) throw new Error(`Frame signature staging file already exists: ${stagingPath}`);
  const encodedHeader = encodeHeader(header);
  const stream = createWriteStream(stagingPath, { flags: "wx", mode: 0o600 });
  const sequenceHash = createHash("sha256");
  let framesWritten = 0;
  let finalized = false;
  let streamError = null;
  stream.on("error", (error) => { streamError = error; });
  stream.write(encodedHeader);

  return {
    header,
    stagingPath,
    finalPath,
    async write(frameIndex, signature) {
      if (finalized) throw new Error("Frame signature writer is finalized");
      if (streamError) throw streamError;
      if (frameIndex !== framesWritten) throw new Error(`Frame signature index ${frameIndex}; expected ${framesWritten}`);
      const record = encodeRecord(frameIndex, signature);
      sequenceHash.update(record);
      framesWritten += 1;
      if (!stream.write(record)) await once(stream, "drain");
    },
    async finalize() {
      if (finalized) throw new Error("Frame signature writer already finalized");
      if (streamError) throw streamError;
      finalized = true;
      if (framesWritten !== header.source.frames) {
        stream.destroy();
        throw new Error(`Frame signature sidecar has ${framesWritten}/${header.source.frames} records`);
      }
      const sequenceSha256 = sequenceHash.digest("hex");
      const trailer = Buffer.allocUnsafe(TRAILER_BYTES);
      TRAILER_MAGIC.copy(trailer, 0);
      trailer.writeUInt32LE(framesWritten, TRAILER_MAGIC.length);
      Buffer.from(sequenceSha256, "hex").copy(trailer, TRAILER_MAGIC.length + 4);
      stream.end(trailer);
      await once(stream, "finish");
      return {
        kind: FRAME_SIGNATURE_KIND,
        schemaVersion: FRAME_SIGNATURE_SCHEMA_VERSION,
        path: finalPath,
        stagingPath,
        sizeBytes: statSync(stagingPath).size,
        sha256: await streamingFileSha256(stagingPath),
        sequenceSha256: `sha256:${sequenceSha256}`,
        frames: framesWritten,
        header,
      };
    },
    commit() {
      if (!finalized) throw new Error("Frame signature writer must be finalized before commit");
      copyFileSync(stagingPath, finalPath, constants.COPYFILE_EXCL);
      unlinkSync(stagingPath);
    },
    abort() {
      stream.destroy();
      if (existsSync(stagingPath)) unlinkSync(stagingPath);
    },
  };
}

export function parseFrameSignatureSidecar(path) {
  const bytes = readFileSync(path);
  if (bytes.length < HEADER_MAGIC.length + 4 + TRAILER_BYTES
      || !bytes.subarray(0, HEADER_MAGIC.length).equals(HEADER_MAGIC)) {
    throw new Error("Invalid frame signature sidecar magic/header");
  }
  const headerLength = bytes.readUInt32LE(HEADER_MAGIC.length);
  const headerStart = HEADER_MAGIC.length + 4;
  const recordsStart = headerStart + headerLength;
  let header;
  try { header = JSON.parse(bytes.subarray(headerStart, recordsStart).toString("utf8")); } catch (error) {
    throw new Error(`Invalid frame signature header JSON: ${error.message}`);
  }
  if (header.kind !== FRAME_SIGNATURE_KIND || header.schemaVersion !== FRAME_SIGNATURE_SCHEMA_VERSION) {
    throw new Error(`Unsupported frame signature schema: ${header.kind}/${header.schemaVersion}`);
  }
  const renderIdentityKeys = Object.keys(header.renderIdentity ?? {}).sort();
  if (renderIdentityKeys.join(",") !== [...RENDER_IDENTITY_KEYS].sort().join(",")
      || RENDER_IDENTITY_KEYS.some((key) => !/^[a-f0-9]{64}$/i.test(String(header.renderIdentity?.[key] ?? "")))) {
    throw new Error("Frame signature render identity is incomplete or malformed");
  }
  if (header.signature?.gridWidth !== FRAME_SIGNATURE_GRID_WIDTH
      || header.signature?.gridHeight !== FRAME_SIGNATURE_GRID_HEIGHT
      || header.signature?.channels !== FRAME_SIGNATURE_CHANNELS
      || header.signature?.sampleFormat !== "rgb24"
      || header.signature?.captureAlgorithm !== "electron-nativeimage-best-resize-bgra-to-rgb-v1"
      || header.signature?.validationAlgorithm !== "ffmpeg-area-scale-rgb24-v1"
      || header.signature?.recordBytes !== FRAME_SIGNATURE_RECORD_BYTES
      || header.signature?.maximumChannelDelta !== FRAME_SIGNATURE_MAX_CHANNEL_DELTA
      || header.signature?.maximumMeanAbsoluteDelta !== FRAME_SIGNATURE_MAX_MEAN_ABSOLUTE_DELTA
      || header.signature?.maximumFractionAbove128 !== FRAME_SIGNATURE_MAX_FRACTION_ABOVE_128) {
    throw new Error("Frame signature comparison contract was weakened or changed");
  }
  const frameCount = header.source?.frames;
  if (!Number.isSafeInteger(frameCount) || frameCount <= 0) throw new Error("Invalid frame signature frame count");
  const recordsBytes = frameCount * FRAME_SIGNATURE_RECORD_BYTES;
  const trailerStart = recordsStart + recordsBytes;
  if (trailerStart + TRAILER_BYTES !== bytes.length
      || !bytes.subarray(trailerStart, trailerStart + TRAILER_MAGIC.length).equals(TRAILER_MAGIC)) {
    throw new Error("Frame signature sidecar length/trailer mismatch");
  }
  const trailerFrames = bytes.readUInt32LE(trailerStart + TRAILER_MAGIC.length);
  if (trailerFrames !== frameCount) throw new Error(`Frame signature trailer has ${trailerFrames}/${frameCount} frames`);
  const sequenceHash = createHash("sha256");
  const signatures = [];
  for (let index = 0; index < frameCount; index += 1) {
    const offset = recordsStart + index * FRAME_SIGNATURE_RECORD_BYTES;
    const record = bytes.subarray(offset, offset + FRAME_SIGNATURE_RECORD_BYTES);
    if (record.readUInt32LE(0) !== index) throw new Error(`Frame signature record ${index} has wrong index ${record.readUInt32LE(0)}`);
    sequenceHash.update(record);
    signatures.push(record.subarray(4));
  }
  const sequenceSha256 = `sha256:${sequenceHash.digest("hex")}`;
  const trailerSha256 = `sha256:${bytes.subarray(trailerStart + TRAILER_MAGIC.length + 4).toString("hex")}`;
  if (sequenceSha256 !== trailerSha256) throw new Error("Frame signature sequence SHA-256 mismatch");
  return {
    path,
    sizeBytes: bytes.length,
    sha256: `sha256:${createHash("sha256").update(bytes).digest("hex")}`,
    sequenceSha256,
    frames: frameCount,
    header,
    signatures,
  };
}
