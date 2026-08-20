#!/usr/bin/env node

import { spawn } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
  MEDIA_SOURCE_MAP_KIND,
  MEDIA_SOURCE_MAP_SCHEMA_VERSION,
  auditCfrFrameTimeline,
  auditSourceFrameTimeline,
  buildCfrFfmpegArgs,
  cachePathForTarget,
  commandVersion,
  createCfrRecipe,
  defaultManifestPath,
  ffmpegHasEncoder,
  findCfrTargetSources,
  fingerprintFile,
  loadAndVerifyMediaSourceMap,
  probeMedia,
  projectFile,
  projectRelativePath,
  readMediaSourceMapManifest,
  validateCfrCacheProbe,
  validateCfrTimelineAudit,
  validateSourceTimelineAudit,
} from "./media_source_map_lib.mjs";

const USAGE = `
Usage:
  node tools/media_cfr_cache.mjs generate [options]
  node tools/media_cfr_cache.mjs verify [options]
  node tools/media_cfr_cache.mjs plan [options]

Options:
  --projectRoot=PATH     HyperFrames project root (default: current directory)
  --entry=PATH           Composition HTML relative to projectRoot (default: index.html)
  --cacheDir=PATH        Cache directory relative to projectRoot (default: .render-cache/cfr60)
  --manifest=PATH        Manifest relative to projectRoot (default: CACHE_DIR/media-source-map.json)
  --encoder=auto|vaapi|libx264 (default: auto)
  --device=PATH          VAAPI render node (default: /dev/dri/renderD128)
  --ffmpeg=COMMAND       FFmpeg executable (default: ffmpeg)
  --ffprobe=COMMAND      FFprobe executable (default: ffprobe)
  --verify=stat|sha256   verify command strength (default: sha256)

Only video_008, video_009, and video_014 are discovered and cached. The HTML and
source media are read-only; generated files live under cacheDir.
`.trim();

export function parseToolArguments(argv) {
  const positional = [];
  const options = {};
  for (const arg of argv) {
    if (!arg.startsWith("--")) {
      positional.push(arg);
      continue;
    }
    const split = arg.indexOf("=");
    if (split === -1) options[arg.slice(2)] = "true";
    else options[arg.slice(2, split)] = arg.slice(split + 1);
  }
  return { command: positional[0] ?? "help", options };
}

function runFfmpeg(ffmpeg, args) {
  return new Promise((resolveRun, rejectRun) => {
    const child = spawn(ffmpeg, args, { stdio: ["ignore", "inherit", "inherit"] });
    child.once("error", rejectRun);
    child.once("close", (code) => {
      if (code === 0) resolveRun();
      else rejectRun(new Error(`${ffmpeg} exited ${code}`));
    });
  });
}

function atomicWriteJson(filePath, value) {
  mkdirSync(dirname(filePath), { recursive: true });
  const temporary = `${filePath}.partial-${process.pid}`;
  writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`);
  renameSync(temporary, filePath);
}

function readReusableManifest(manifestPath) {
  if (!existsSync(manifestPath)) return null;
  try {
    return readMediaSourceMapManifest(manifestPath);
  } catch (error) {
    console.warn(`Ignoring stale/invalid manifest: ${error.message}`);
    return null;
  }
}

async function chooseEncoder(requested, ffmpeg, device) {
  if (requested !== "auto" && requested !== "vaapi" && requested !== "libx264") {
    throw new Error(`encoder must be auto, vaapi, or libx264; got ${requested}`);
  }
  if (requested === "vaapi") {
    if (!existsSync(device)) throw new Error(`VAAPI render node is missing: ${device}`);
    if (!await ffmpegHasEncoder(ffmpeg, "h264_vaapi")) throw new Error(`${ffmpeg} has no h264_vaapi encoder`);
    return "vaapi";
  }
  if (requested === "libx264") {
    if (!await ffmpegHasEncoder(ffmpeg, "libx264")) throw new Error(`${ffmpeg} has no libx264 encoder`);
    return "libx264";
  }
  if (existsSync(device) && await ffmpegHasEncoder(ffmpeg, "h264_vaapi")) return "vaapi";
  if (await ffmpegHasEncoder(ffmpeg, "libx264")) return "libx264";
  throw new Error(`${ffmpeg} has neither h264_vaapi nor libx264`);
}

function resolveConfiguration(options) {
  const projectRoot = resolve(options.projectRoot ?? process.cwd());
  const entryPath = resolve(projectRoot, options.entry ?? "index.html");
  const cacheDirectoryOption = options.cacheDir ?? ".render-cache/cfr60";
  const cacheDirectory = resolve(projectRoot, cacheDirectoryOption);
  const manifestPath = options.manifest
    ? resolve(projectRoot, options.manifest)
    : defaultManifestPath(projectRoot, cacheDirectoryOption);
  if (!existsSync(entryPath)) throw new Error(`Composition entry is missing: ${entryPath}`);
  projectRelativePath(projectRoot, entryPath);
  projectRelativePath(projectRoot, cacheDirectory);
  projectRelativePath(projectRoot, manifestPath);
  return {
    projectRoot,
    entryPath,
    cacheDirectory,
    manifestPath,
    encoder: options.encoder ?? "auto",
    device: options.device ?? "/dev/dri/renderD128",
    ffmpeg: options.ffmpeg ?? "ffmpeg",
    ffprobe: options.ffprobe ?? "ffprobe",
  };
}

async function generateCaches(configuration) {
  const {
    projectRoot,
    entryPath,
    cacheDirectory,
    manifestPath,
    ffmpeg,
    ffprobe,
    device,
  } = configuration;
  const targets = findCfrTargetSources({ projectRoot, entryPath });
  const encoder = await chooseEncoder(configuration.encoder, ffmpeg, device);
  const ffmpegVersion = await commandVersion(ffmpeg);
  const ffprobeVersion = await commandVersion(ffprobe);
  const recipe = createCfrRecipe({ encoder, device, ffmpegVersion });
  const previousManifest = readReusableManifest(manifestPath);
  const previousById = new Map(previousManifest?.entries.map((entry) => [entry.id, entry]) ?? []);
  mkdirSync(cacheDirectory, { recursive: true });
  const entries = [];

  for (const target of targets) {
    const sourcePath = projectFile(projectRoot, target.source, `${target.id}.source`);
    if (!existsSync(sourcePath)) throw new Error(`${target.id} source is missing: ${sourcePath}`);
    const sourceFingerprint = await fingerprintFile(sourcePath);
    const sourceMedia = await probeMedia(ffprobe, sourcePath);
    const sourceTimeline = await auditSourceFrameTimeline(ffprobe, sourcePath);
    const sourceTimelineIssues = validateSourceTimelineAudit(
      sourceTimeline,
      sourceMedia.video?.nbReadFrames,
    );
    if (sourceTimelineIssues.length) {
      throw new Error(`${target.id} source timeline validation failed: ${sourceTimelineIssues.join("; ")}`);
    }
    console.log(
      `SOURCE_TIMELINE ${target.id} firstGrid=${sourceTimeline.firstGridIndex} `
      + `missing=${sourceTimeline.missingGridFrames} first=${sourceTimeline.firstGridIndices.join(",")}`,
    );
    const cachePath = cachePathForTarget(
      projectRoot,
      projectRelativePath(projectRoot, cacheDirectory),
      target.id,
      sourceFingerprint.sha256,
      recipe.key,
    );
    const cacheRelative = projectRelativePath(projectRoot, cachePath);
    const previous = previousById.get(target.id);
    const sameSourceContent = previous
      && previous.sourceFingerprint.size === sourceFingerprint.size
      && previous.sourceFingerprint.sha256 === sourceFingerprint.sha256;
    const existingCacheFingerprint = existsSync(cachePath) ? await fingerprintFile(cachePath) : null;
    const sameCacheContent = previous
      && existingCacheFingerprint
      && previous.cacheFingerprint.size === existingCacheFingerprint.size
      && previous.cacheFingerprint.sha256 === existingCacheFingerprint.sha256;
    const reusable = Boolean(previous
      && previous.source === target.source
      && previous.cache === cacheRelative
      && previous.recipeKey === recipe.key
      && sameSourceContent
      && sameCacheContent);

    if (reusable) {
      console.log(`CACHE_HIT ${target.id} ${cacheRelative}`);
      entries.push({
        ...previous,
        sourceFingerprint,
        cacheFingerprint: existingCacheFingerprint,
        sourceMedia,
        sourceTimeline,
      });
      continue;
    }

    const temporaryCachePath = `${cachePath}.partial-${process.pid}.mp4`;
    rmSync(temporaryCachePath, { force: true });
    const ffmpegArgs = buildCfrFfmpegArgs({ recipe, sourcePath, outputPath: temporaryCachePath });
    console.log(`CACHE_BUILD ${target.id} ${target.source} -> ${cacheRelative}`);
    try {
      await runFfmpeg(ffmpeg, ffmpegArgs);
      const cacheMedia = await probeMedia(ffprobe, temporaryCachePath);
      const issues = validateCfrCacheProbe(cacheMedia, sourceMedia);
      if (issues.length) throw new Error(`${target.id} cache validation failed: ${issues.join("; ")}`);
      const cacheTimeline = await auditCfrFrameTimeline(ffprobe, temporaryCachePath);
      const timelineIssues = validateCfrTimelineAudit(cacheTimeline, cacheMedia.video.nbReadFrames);
      if (timelineIssues.length) {
        throw new Error(`${target.id} cache timeline validation failed: ${timelineIssues.join("; ")}`);
      }
      renameSync(temporaryCachePath, cachePath);
      const cacheFingerprint = await fingerprintFile(cachePath);
      entries.push({
        id: target.id,
        source: target.source,
        cache: cacheRelative,
        sourceFingerprint,
        cacheFingerprint,
        sourceMedia,
        sourceTimeline,
        cacheMedia,
        cacheTimeline,
        recipeKey: recipe.key,
      });
      console.log(
        `CACHE_READY ${target.id} ${cacheMedia.video.nbReadFrames} frames `
        + `pts=${cacheTimeline.firstTimestamp} step=${cacheTimeline.expectedStepTicks}ticks`,
      );
    } finally {
      rmSync(temporaryCachePath, { force: true });
    }
  }

  const manifest = {
    kind: MEDIA_SOURCE_MAP_KIND,
    schemaVersion: MEDIA_SOURCE_MAP_SCHEMA_VERSION,
    createdAt: new Date().toISOString(),
    project: { entry: projectRelativePath(projectRoot, entryPath) },
    recipe,
    toolchain: { ffmpeg: ffmpegVersion, ffprobe: ffprobeVersion },
    entries,
  };
  atomicWriteJson(manifestPath, manifest);
  await loadAndVerifyMediaSourceMap({ manifestPath, projectRoot, verifyMode: "stat" });
  console.log(`CACHE_MANIFEST ${manifestPath}`);
  return manifest;
}

async function verifyCaches(configuration, verifyMode) {
  const loaded = await loadAndVerifyMediaSourceMap({
    manifestPath: configuration.manifestPath,
    projectRoot: configuration.projectRoot,
    verifyMode,
  });
  const manifest = readMediaSourceMapManifest(configuration.manifestPath);
  for (const entry of manifest.entries) {
    const sourcePath = projectFile(configuration.projectRoot, entry.source, `${entry.id}.source`);
    const cachePath = projectFile(configuration.projectRoot, entry.cache, `${entry.id}.cache`);
    const sourceMedia = await probeMedia(configuration.ffprobe, sourcePath);
    const sourceTimeline = await auditSourceFrameTimeline(configuration.ffprobe, sourcePath);
    const sourceTimelineIssues = validateSourceTimelineAudit(
      sourceTimeline,
      sourceMedia.video?.nbReadFrames,
    );
    if (sourceTimelineIssues.length) {
      throw new Error(`${entry.id} source timeline validation failed: ${sourceTimelineIssues.join("; ")}`);
    }
    const cacheMedia = await probeMedia(configuration.ffprobe, cachePath);
    const issues = validateCfrCacheProbe(cacheMedia, sourceMedia);
    if (issues.length) throw new Error(`${entry.id} cache validation failed: ${issues.join("; ")}`);
    const cacheTimeline = await auditCfrFrameTimeline(configuration.ffprobe, cachePath);
    const timelineIssues = validateCfrTimelineAudit(cacheTimeline, cacheMedia.video.nbReadFrames);
    if (timelineIssues.length) {
      throw new Error(`${entry.id} cache timeline validation failed: ${timelineIssues.join("; ")}`);
    }
    console.log(
      `CACHE_VALID ${entry.id} ${cacheMedia.video.nbReadFrames} frames ${verifyMode} `
      + `pts=${cacheTimeline.firstTimestamp} step=${cacheTimeline.expectedStepTicks}ticks`,
    );
  }
  console.log(`CACHE_MAP_READY ${loaded.entries.length} entries ${loaded.recipe.key}`);
  return loaded;
}

async function printPlan(configuration) {
  const targets = findCfrTargetSources({
    projectRoot: configuration.projectRoot,
    entryPath: configuration.entryPath,
  });
  const encoder = await chooseEncoder(configuration.encoder, configuration.ffmpeg, configuration.device);
  const recipe = createCfrRecipe({
    encoder,
    device: configuration.device,
    ffmpegVersion: await commandVersion(configuration.ffmpeg),
  });
  for (const target of targets) {
    const sourcePath = projectFile(configuration.projectRoot, target.source, `${target.id}.source`);
    const sourceFingerprint = await fingerprintFile(sourcePath);
    const outputPath = cachePathForTarget(
      configuration.projectRoot,
      projectRelativePath(configuration.projectRoot, configuration.cacheDirectory),
      target.id,
      sourceFingerprint.sha256,
      recipe.key,
    );
    console.log(JSON.stringify({
      id: target.id,
      source: target.source,
      cache: projectRelativePath(configuration.projectRoot, outputPath),
      ffmpeg: configuration.ffmpeg,
      args: buildCfrFfmpegArgs({ recipe, sourcePath, outputPath }),
    }));
  }
}

export async function main(argv = process.argv.slice(2)) {
  const { command, options } = parseToolArguments(argv);
  if (command === "help" || options.help === "true") {
    console.log(USAGE);
    return;
  }
  const configuration = resolveConfiguration(options);
  if (command === "generate") {
    await generateCaches(configuration);
    return;
  }
  if (command === "verify") {
    const verifyMode = options.verify ?? "sha256";
    if (verifyMode !== "stat" && verifyMode !== "sha256") {
      throw new Error(`verify must be stat or sha256; got ${verifyMode}`);
    }
    await verifyCaches(configuration, verifyMode);
    return;
  }
  if (command === "plan") {
    await printPlan(configuration);
    return;
  }
  throw new Error(`Unknown command: ${command}\n\n${USAGE}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((error) => {
    console.error(error?.stack || String(error));
    process.exitCode = 1;
  });
}
