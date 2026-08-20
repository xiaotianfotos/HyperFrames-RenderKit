#!/usr/bin/env node

import { mkdir, rename, rm, writeFile } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { dirname, resolve } from "node:path";
import {
  bindCanonicalMediaRouteToTimingEntries,
  createCanonicalMediaRoute,
  loadAndVerifyCanonicalMediaRoute,
} from "./canonical_media_route_lib.mjs";
import {
  buildMediaTimingBundle,
  loadAndVerifyMediaTimingBundle,
} from "./media_timing_bundle_lib.mjs";

function usage() {
  console.log(`Usage:
  node tools/canonical_media_route.mjs create \\
    --project-root <project> --entry <html> \\
    --canonical-manifest <cache.mp4.canonical.json> [--canonical-manifest ...] \\
    [--output .render-cache/canonical-media/canonical-media-route.json] \\
    [--verify full|sha256|stat] [--ffmpeg ffmpeg] [--ffprobe ffprobe]

  node tools/canonical_media_route.mjs bundle \\
    --project-root <project> --entry <html> --route <route.json> \\
    [--output .render-cache/media-timing/media-timing-bundle.json] \\
    [--reuse-bundle <previous-media-timing-bundle.json>] \\
    [--verify full|sha256|stat] [--ffprobe ffprobe]

  node tools/canonical_media_route.mjs verify \\
    --project-root <project> --entry <html> --route <route.json> \\
    --timing-bundle <media-timing-bundle.json> \\
    [--verify full|sha256|stat] [--ffmpeg ffmpeg] [--ffprobe ffprobe]`);
}

function parseArguments(argv) {
  const args = [...argv];
  const command = args.shift();
  const options = new Map();
  while (args.length) {
    const raw = args.shift();
    if (!raw.startsWith("--")) throw new Error(`Unexpected argument: ${raw}`);
    const equals = raw.indexOf("=");
    const key = equals >= 0 ? raw.slice(2, equals) : raw.slice(2);
    const value = equals >= 0 ? raw.slice(equals + 1) : args.shift();
    if (value == null || value.startsWith("--")) throw new Error(`--${key} requires a value`);
    const values = options.get(key) ?? [];
    values.push(value);
    options.set(key, values);
  }
  return { command, options };
}

function one(options, name, fallback = null) {
  const values = options.get(name) ?? [];
  if (values.length > 1) throw new Error(`--${name} may be provided only once`);
  return values[0] ?? fallback;
}

function required(options, name) {
  const value = one(options, name);
  if (!value) throw new Error(`--${name} is required`);
  return value;
}

function many(options, name) {
  return options.get(name) ?? [];
}

async function writeJson(filePath, value) {
  await mkdir(dirname(filePath), { recursive: true });
  const temporaryPath = `${filePath}.partial-${process.pid}-${randomBytes(4).toString("hex")}`;
  try {
    await writeFile(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, { flag: "wx" });
    await rename(temporaryPath, filePath);
  } finally {
    await rm(temporaryPath, { force: true });
  }
}

async function createCommand(options) {
  const projectRoot = resolve(required(options, "project-root"));
  const entryPath = resolve(projectRoot, required(options, "entry"));
  const output = resolve(projectRoot, one(
    options,
    "output",
    ".render-cache/canonical-media/canonical-media-route.json",
  ));
  const canonicalManifestPaths = many(options, "canonical-manifest").map((value) => resolve(projectRoot, value));
  const route = await createCanonicalMediaRoute({
    projectRoot,
    entryPath,
    canonicalManifestPaths,
    verifyMode: one(options, "verify", "full"),
    ffmpeg: one(options, "ffmpeg", "ffmpeg"),
    ffprobe: one(options, "ffprobe", "ffprobe"),
  });
  await writeJson(output, route);
  console.log(JSON.stringify({
    valid: true,
    output,
    mappings: route.entries.map((entry) => ({
      source: entry.source,
      cache: entry.cache,
      fps: entry.fps,
      frames: entry.frameCount,
      recipeHash: entry.recipeHash,
    })),
  }, null, 2));
}

async function loadRouteOptions(options) {
  const projectRoot = resolve(required(options, "project-root"));
  const entryPath = resolve(projectRoot, required(options, "entry"));
  const loaded = await loadAndVerifyCanonicalMediaRoute({
    routePath: resolve(projectRoot, required(options, "route")),
    projectRoot,
    entryPath,
    verifyMode: one(options, "verify", "sha256"),
    ffmpeg: one(options, "ffmpeg", "ffmpeg"),
    ffprobe: one(options, "ffprobe", "ffprobe"),
  });
  return { projectRoot, entryPath, loaded };
}

async function bundleCommand(options) {
  const { projectRoot, entryPath, loaded } = await loadRouteOptions(options);
  const output = resolve(projectRoot, one(
    options,
    "output",
    ".render-cache/media-timing/media-timing-bundle.json",
  ));
  const reuseBundlePath = one(options, "reuse-bundle");
  const reusable = reuseBundlePath
    ? await loadAndVerifyMediaTimingBundle({
      manifestPath: resolve(projectRoot, reuseBundlePath),
      projectRoot,
      entryPath,
      verifyMode: "sha256",
    })
    : null;
  const bundle = await buildMediaTimingBundle({
    projectRoot,
    entryPath,
    ffprobePath: one(options, "ffprobe", "ffprobe"),
    reuseEntries: reusable?.entries ?? [],
    extraSources: loaded.entries.map((mapped) => ({
      absolutePath: mapped.cachePath,
      role: "decoder-cache",
      mapsFrom: mapped.source,
    })),
  });
  await writeJson(output, bundle);
  console.log(JSON.stringify({
    valid: true,
    output,
    compositionSources: bundle.entries.filter((entry) => entry.roles.includes("composition")).length,
    decoderCaches: bundle.entries.filter((entry) => entry.roles.includes("decoder-cache")).length,
    build: bundle.build,
  }, null, 2));
}

async function verifyCommand(options) {
  const { projectRoot, entryPath, loaded } = await loadRouteOptions(options);
  const verify = one(options, "verify", "sha256");
  const timing = await loadAndVerifyMediaTimingBundle({
    manifestPath: resolve(projectRoot, required(options, "timing-bundle")),
    projectRoot,
    entryPath,
    verifyMode: verify === "full" ? "sha256" : verify,
    requiredDecoderMappings: loaded.entries.map((mapped) => ({
      source: mapped.source,
      cache: mapped.cache,
    })),
  });
  const bound = bindCanonicalMediaRouteToTimingEntries({
    routeEntries: loaded.entries,
    timingEntries: timing.entries,
  });
  console.log(JSON.stringify({
    valid: true,
    route: loaded.path,
    timingBundle: timing.path,
    mappings: bound.map((entry) => ({
      source: entry.source,
      cache: entry.cache,
      sourceIdentity: entry.canonical.sourceIdentity,
      cacheIdentity: entry.canonical.cacheIdentity,
      frameCount: entry.canonical.frameCount,
      frameMapSha256: entry.canonical.frameMapSha256,
    })),
  }, null, 2));
}

async function main() {
  const { command, options } = parseArguments(process.argv.slice(2));
  if (!command || command === "help" || command === "--help" || command === "-h") {
    usage();
    return;
  }
  if (command === "create") return createCommand(options);
  if (command === "bundle") return bundleCommand(options);
  if (command === "verify") return verifyCommand(options);
  throw new Error(`Unknown command: ${command}`);
}

main().catch((error) => {
  console.error(JSON.stringify({
    valid: false,
    code: error.code ?? "CANONICAL_ROUTE_FAILED",
    error: error.message,
    details: error.details ?? null,
  }, null, 2));
  process.exitCode = 1;
});
