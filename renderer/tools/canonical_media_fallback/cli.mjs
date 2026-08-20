#!/usr/bin/env node

import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  BIT_DEPTH_POLICY_10_TO_8,
  COLOR_POLICY_UNTAGGED_BT709_LIMITED,
  CanonicalMediaError,
  buildCanonicalCache,
  inspectCanonicalSource,
  parseFps,
  verifyCanonicalCache,
} from "./lib.mjs";

const USAGE = `
Canonical media fallback (fail-closed)

Usage:
  node tools/canonical_media_fallback/cli.mjs inspect --input=VIDEO --fps=60
  node tools/canonical_media_fallback/cli.mjs build   --input=VIDEO --fps=60 [options]
  node tools/canonical_media_fallback/cli.mjs verify  --manifest=FILE [options]

Options:
  --cache-dir=DIR       Content-addressed cache root (default: .render-cache/canonical-media)
  --profile=quality     libx264 slow, CRF 10 (default)
  --profile=speed       optional VAAPI h264_vaapi, CQP 16; never auto-falls back
  --device=PATH         VAAPI render node (default: /dev/dri/renderD128)
  --ffmpeg=COMMAND      FFmpeg executable (default: ffmpeg)
  --ffprobe=COMMAND     FFprobe executable (default: ffprobe)
  --sample-count=N      Pixel acceptance sample target, 3..24 (default: 9)
  --sample-aspect-ratio=N:D
                        Explicitly declare SAR only when source metadata is
                        missing (for example 1:1); conflicts are rejected
  --bit-depth-policy=${BIT_DEPTH_POLICY_10_TO_8}
                        Explicit BT.709 limited yuv420p10le -> yuv420p8 zscale
                        error-diffusion contract (default: reject non-8-bit)
  --color-policy=${COLOR_POLICY_UNTAGGED_BT709_LIMITED}
                        Explicitly declare missing range/primaries/transfer/
                        matrix metadata as BT.709 limited. Chroma location must
                        still be present and left; conflicting tags are rejected.
  --json                Suppress progress events; final result remains JSON

Supported input is deliberately narrow: one opaque, progressive, even-sized,
8-bit video stream, or yuv420p10le only with the exact policy above, with
explicit BT.709 limited-range metadata and no rotation,
display matrix, crop metadata, or HDR side data. Unsupported transforms exit 2
as cache-required-with-policy. No tone-map, alpha flatten, crop, rotate,
deinterlace, or color guess is ever performed implicitly.
`.trim();

export function parseArguments(argv) {
  const positional = [];
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (!argument.startsWith("--")) {
      positional.push(argument);
      continue;
    }
    const separator = argument.indexOf("=");
    if (separator >= 0) {
      options[argument.slice(2, separator)] = argument.slice(separator + 1);
      continue;
    }
    const key = argument.slice(2);
    if (key === "json" || key === "help") options[key] = true;
    else if (argv[index + 1] != null && !argv[index + 1].startsWith("--")) {
      options[key] = argv[index + 1];
      index += 1;
    } else options[key] = true;
  }
  return { command: positional[0] ?? "help", options };
}

function required(options, key) {
  const value = options[key];
  if (typeof value !== "string" || !value.trim()) {
    throw new CanonicalMediaError(`--${key} is required`, { code: `${key.toUpperCase().replaceAll("-", "_")}_REQUIRED` });
  }
  return value;
}

function positiveInteger(value, fallback) {
  if (value == null) return fallback;
  const numeric = Number(value);
  if (!Number.isInteger(numeric) || numeric < 3 || numeric > 24) {
    throw new CanonicalMediaError(`--sample-count must be an integer from 3 to 24; got ${value}`, {
      code: "INVALID_SAMPLE_COUNT",
    });
  }
  return numeric;
}

function compactInspection(inspection, fps) {
  return {
    status: inspection.status,
    inputPath: inspection.inputPath,
    requestedFps: fps.text,
    stream: inspection.stream,
    timeline: inspection.timeline,
    frameColorConsistency: inspection.frameColorConsistency,
    colorResolution: inspection.colorResolution,
    bitDepthConversion: inspection.bitDepthConversion,
    sarResolution: inspection.sarResolution,
    blockers: inspection.blockers,
  };
}

function progressPrinter(silent) {
  if (silent) return () => {};
  return (event) => {
    if (event.type === "source-probed") {
      process.stderr.write(`SOURCE_PROBED status=${event.status} frames=${event.frameCount}\n`);
    } else if (event.type === "cache-hit") {
      process.stderr.write(`CACHE_HIT ${event.cachePath}\n`);
    } else if (event.type === "cache-build") {
      process.stderr.write(`CACHE_BUILD profile=${event.profile} ${event.cachePath}\n`);
    } else if (event.type === "cache-ready") {
      process.stderr.write(`CACHE_READY frames=${event.frameCount} ${event.cachePath}\n`);
    }
  };
}

export async function main(argv = process.argv.slice(2)) {
  const { command, options } = parseArguments(argv);
  if (command === "help" || options.help) {
    process.stdout.write(`${USAGE}\n`);
    return { status: "help" };
  }
  const ffmpeg = options.ffmpeg ?? "ffmpeg";
  const ffprobe = options.ffprobe ?? "ffprobe";
  const sampleCount = options["sample-count"] == null
    ? undefined
    : positiveInteger(options["sample-count"], 9);
  const bitDepthPolicy = options["bit-depth-policy"] ?? "reject";
  if (command === "inspect") {
    const input = required(options, "input");
    const fps = parseFps(required(options, "fps"));
    const inspection = await inspectCanonicalSource({
      input,
      ffprobe,
      bitDepthPolicy,
      colorPolicy: options["color-policy"] ?? "reject",
      sampleAspectRatio: options["sample-aspect-ratio"] ?? null,
    });
    const output = compactInspection(inspection, fps);
    process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
    return output;
  }
  if (command === "build") {
    const result = await buildCanonicalCache({
      input: required(options, "input"),
      fps: required(options, "fps"),
      cacheDirectory: resolve(options["cache-dir"] ?? ".render-cache/canonical-media"),
      profile: options.profile ?? "quality",
      ffmpeg,
      ffprobe,
      device: options.device ?? "/dev/dri/renderD128",
      sampleCount,
      bitDepthPolicy,
      colorPolicy: options["color-policy"] ?? "reject",
      sampleAspectRatio: options["sample-aspect-ratio"] ?? null,
      onEvent: progressPrinter(Boolean(options.json)),
    });
    const output = {
      status: result.status,
      hit: result.hit,
      cachePath: result.cachePath,
      manifestPath: result.manifestPath,
      sourceSha256: result.manifest.source.fingerprint.sha256,
      recipeSha256: result.manifest.recipe.hash,
      cacheSha256: result.manifest.cache.fingerprint.sha256,
      frameCount: result.manifest.frameMap.cacheFrameCount,
      acceptancePassed: result.manifest.acceptance.passed,
    };
    process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
    return output;
  }
  if (command === "verify") {
    const output = await verifyCanonicalCache({
      manifest: required(options, "manifest"),
      ffmpeg,
      ffprobe,
      sampleCount,
    });
    process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
    return output;
  }
  throw new CanonicalMediaError(`Unknown command: ${command}\n\n${USAGE}`, { code: "UNKNOWN_COMMAND" });
}

function errorPayload(error) {
  if (error instanceof CanonicalMediaError) {
    return {
      status: error.status,
      code: error.code,
      message: error.message,
      ...(error.details ? { details: error.details } : {}),
    };
  }
  return { status: "rejected", code: "UNEXPECTED_ERROR", message: error?.stack ?? String(error) };
}

const isDirect = process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));
if (isDirect) {
  main().catch((error) => {
    process.stderr.write(`${JSON.stringify(errorPayload(error), null, 2)}\n`);
    process.exitCode = error?.status === "cache-required-with-policy" ? 2 : 1;
  });
}
