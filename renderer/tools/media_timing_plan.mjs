#!/usr/bin/env node

import { readFile, writeFile, mkdir, stat, readdir } from "node:fs/promises";
import { basename, dirname, extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  frameAtOrBefore,
  scanMediaTiming,
  validateTimingPlan,
  verifyTimingPlanSource,
} from "./media_timing_plan_lib.mjs";
import {
  buildMediaTimingBundle,
  loadAndVerifyMediaTimingBundle,
} from "./media_timing_bundle_lib.mjs";
import { loadAndVerifyMediaSourceMap } from "./media_source_map_lib.mjs";

const MEDIA_EXTENSIONS = new Set([
  ".3gp", ".avi", ".m2ts", ".m4v", ".mkv", ".mov", ".mp4", ".mpeg", ".mpg", ".mts", ".webm",
]);

function usage() {
  console.log(`Usage:
  node tools/media_timing_plan.mjs scan <video-or-directory> [...] [--output <file-or-directory>] [--ffprobe <path>] [--pretty]
  node tools/media_timing_plan.mjs bundle --projectRoot <dir> [--entry <html>] [--output <bundle.json>] [--mediaSourceMap <manifest>] [--verify stat|sha256] [--ffprobe <path>] [--pretty]
  node tools/media_timing_plan.mjs verify-bundle <bundle.json> --projectRoot <dir> [--entry <html>] [--verify stat|sha256]
  node tools/media_timing_plan.mjs verify <plan.json> [--source <video>] [--hash]
  node tools/media_timing_plan.mjs inspect <plan.json>
  node tools/media_timing_plan.mjs query <plan.json> <seconds> [--timeline media-relative|stream-absolute]

The scan stores displayed presentation PTS only. It creates no proxy media.`);
}

function takeOption(args, name, fallback = null) {
  const index = args.indexOf(name);
  if (index < 0) return fallback;
  if (index + 1 >= args.length) throw new Error(`${name} requires a value`);
  const value = args[index + 1];
  args.splice(index, 2);
  return value;
}

function takeFlag(args, name) {
  const index = args.indexOf(name);
  if (index < 0) return false;
  args.splice(index, 1);
  return true;
}

async function readPlan(path) {
  const plan = JSON.parse(await readFile(path, "utf8"));
  return validateTimingPlan(plan);
}

async function collectMedia(path) {
  const absolute = resolve(path);
  const info = await stat(absolute);
  if (info.isFile()) return [absolute];
  if (!info.isDirectory()) return [];
  const entries = await readdir(absolute, { withFileTypes: true });
  const nested = await Promise.all(entries
    .filter((entry) => !entry.name.startsWith("."))
    .map((entry) => collectMedia(join(absolute, entry.name))));
  return nested.flat().filter((file) => MEDIA_EXTENSIONS.has(extname(file).toLowerCase()));
}

function inspectSummary(plan) {
  const manifestBytes = Buffer.byteLength(JSON.stringify(plan));
  return {
    source: plan.source.path,
    sourceIdentity: plan.source.identity,
    codec: plan.stream.codec,
    dimensions: `${plan.stream.width}x${plan.stream.height}`,
    nominalFrameRate: plan.stream.nominalFrameRate,
    averageFrameRate: plan.stream.averageFrameRate,
    timeBase: plan.stream.timeBase,
    frameCount: plan.presentation.frameCount,
    classification: plan.presentation.classification,
    ptsEncoding: plan.presentation.pts.kind,
    ptsRunCount: plan.presentation.pts.kind === "linear"
      ? 1
      : (plan.presentation.pts.kind === "delta-rle"
        ? plan.presentation.pts.deltaRuns.length
        : plan.presentation.pts.deltas.length),
    keyframes: plan.presentation.keyframes.count,
    hasBFrames: plan.stream.hasBFrames,
    nonZeroOrigin: plan.timeline.nonZeroOrigin,
    presentationOriginSeconds: plan.timeline.presentationOriginSeconds,
    editListDetected: plan.timeline.editList.detected,
    manifestBytes,
  };
}

async function scanCommand(args) {
  const output = takeOption(args, "--output");
  const ffprobePath = takeOption(args, "--ffprobe", "ffprobe");
  const pretty = takeFlag(args, "--pretty");
  if (!args.length) throw new Error("scan requires at least one video or directory");
  const sources = [...new Set((await Promise.all(args.map(collectMedia))).flat())].sort();
  if (!sources.length) throw new Error("No supported video files found");

  let outputIsDirectory = sources.length > 1;
  if (output) {
    try {
      outputIsDirectory = (await stat(resolve(output))).isDirectory();
    } catch {
      outputIsDirectory = sources.length > 1 || extname(output).toLowerCase() !== ".json";
    }
  }
  if (sources.length > 1 && output && !outputIsDirectory) {
    throw new Error("--output must be a directory when scanning multiple videos");
  }
  if (output && outputIsDirectory) await mkdir(resolve(output), { recursive: true });

  const summaries = [];
  for (const source of sources) {
    const plan = await scanMediaTiming(source, { ffprobePath });
    const outputPath = output
      ? (outputIsDirectory
        ? join(resolve(output), `${basename(source)}.${plan.source.identity.slice(0, 12)}.timing-plan.json`)
        : resolve(output))
      : `${source}.timing-plan.json`;
    await mkdir(dirname(outputPath), { recursive: true });
    await writeFile(outputPath, `${JSON.stringify(plan, null, pretty ? 2 : 0)}\n`);
    summaries.push({ output: outputPath, ...inspectSummary(plan) });
  }
  console.log(JSON.stringify(summaries, null, 2));
}

async function verifyCommand(args) {
  const source = takeOption(args, "--source");
  const hash = takeFlag(args, "--hash");
  if (args.length !== 1) throw new Error("verify requires one timing-plan JSON file");
  const plan = await readPlan(resolve(args[0]));
  const result = await verifyTimingPlanSource(plan, source ?? plan.source.path, {
    mode: hash ? "hash" : "stat",
  });
  console.log(JSON.stringify({ mode: hash ? "hash" : "stat", ...result }, null, 2));
  if (!result.valid) process.exitCode = 2;
}

async function inspectCommand(args) {
  if (args.length !== 1) throw new Error("inspect requires one timing-plan JSON file");
  console.log(JSON.stringify(inspectSummary(await readPlan(resolve(args[0]))), null, 2));
}

async function queryCommand(args) {
  const timeline = takeOption(args, "--timeline", "media-relative");
  if (args.length !== 2) throw new Error("query requires a timing-plan JSON file and target seconds");
  const target = Number(args[1]);
  if (!Number.isFinite(target)) throw new Error(`Invalid target seconds: ${args[1]}`);
  const plan = await readPlan(resolve(args[0]));
  console.log(JSON.stringify(frameAtOrBefore(plan, target, { timeline }), null, 2));
}

async function bundleCommand(args) {
  const projectRoot = resolve(takeOption(args, "--projectRoot", "."));
  const entry = resolve(projectRoot, takeOption(args, "--entry", "index.html"));
  const output = resolve(projectRoot, takeOption(
    args,
    "--output",
    ".render-cache/media-timing/media-timing-bundle.json",
  ));
  const sourceMapOption = takeOption(args, "--mediaSourceMap");
  const verifyOption = takeOption(args, "--verify", "stat");
  const verify = verifyOption === "hash" ? "sha256" : verifyOption;
  const ffprobePath = takeOption(args, "--ffprobe", "ffprobe");
  const pretty = takeFlag(args, "--pretty");
  if (args.length) throw new Error(`Unexpected bundle arguments: ${args.join(" ")}`);
  let sourceMap = null;
  if (sourceMapOption) {
    sourceMap = await loadAndVerifyMediaSourceMap({
      manifestPath: resolve(projectRoot, sourceMapOption),
      projectRoot,
      verifyMode: verify,
    });
  }
  const bundle = await buildMediaTimingBundle({
    projectRoot,
    entryPath: entry,
    ffprobePath,
    extraSources: sourceMap?.entries.map((mapped) => ({
      absolutePath: fileURLToPath(mapped.cacheUrl),
      role: "decoder-cache",
      mapsFrom: mapped.source,
    })) ?? [],
  });
  await mkdir(dirname(output), { recursive: true });
  await writeFile(output, `${JSON.stringify(bundle, null, pretty ? 2 : 0)}\n`);
  console.log(JSON.stringify({
    output,
    compositionSources: bundle.entries.filter((entryRecord) => entryRecord.roles.includes("composition")).length,
    decoderCaches: bundle.entries.filter((entryRecord) => entryRecord.roles.includes("decoder-cache")).length,
    sources: bundle.entries.map((entryRecord) => ({
      source: entryRecord.source,
      roles: entryRecord.roles,
      frames: entryRecord.plan.presentation.frameCount,
      timestampSource: entryRecord.plan.probe.timestampSource,
      classification: entryRecord.plan.presentation.classification,
    })),
  }, null, 2));
}

async function verifyBundleCommand(args) {
  const projectRoot = resolve(takeOption(args, "--projectRoot", "."));
  const entry = resolve(projectRoot, takeOption(args, "--entry", "index.html"));
  const verifyOption = takeOption(args, "--verify", "stat");
  const verify = verifyOption === "hash" ? "sha256" : verifyOption;
  if (args.length !== 1) throw new Error("verify-bundle requires one bundle JSON file");
  const loaded = await loadAndVerifyMediaTimingBundle({
    manifestPath: resolve(args[0]),
    projectRoot,
    entryPath: entry,
    verifyMode: verify,
  });
  console.log(JSON.stringify({
    valid: true,
    path: loaded.path,
    verifyMode: loaded.verifyMode,
    entries: loaded.entries.length,
  }, null, 2));
}

async function main() {
  const args = process.argv.slice(2).flatMap((argument) => {
    const split = argument.startsWith("--") ? argument.indexOf("=") : -1;
    return split > 2 ? [argument.slice(0, split), argument.slice(split + 1)] : [argument];
  });
  const command = args.shift();
  if (!command || command === "--help" || command === "-h") {
    usage();
    return;
  }
  if (command === "scan") return scanCommand(args);
  if (command === "bundle" || command === "scan-bundle") return bundleCommand(args);
  if (command === "verify-bundle") return verifyBundleCommand(args);
  if (command === "verify") return verifyCommand(args);
  if (command === "inspect") return inspectCommand(args);
  if (command === "query") return queryCommand(args);
  throw new Error(`Unknown command: ${command}`);
}

main().catch((error) => {
  console.error(error.stack ?? error.message);
  process.exitCode = 1;
});
