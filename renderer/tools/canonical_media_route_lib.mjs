import { createHash } from "node:crypto";
import { readFileSync, realpathSync } from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  readManifest as readCanonicalManifest,
  verifyCanonicalCache,
} from "./canonical_media_fallback/lib.mjs";
import {
  fingerprintFile,
  fingerprintsEqual,
  projectFile,
  projectRelativePath,
  verifyFingerprint,
} from "./media_source_map_lib.mjs";
import { findStaticVideoSources } from "./media_timing_bundle_lib.mjs";
import { expandPresentationPts } from "./media_timing_plan_lib.mjs";

export const CANONICAL_MEDIA_ROUTE_KIND = "hyperframes-canonical-media-route";
export const CANONICAL_MEDIA_ROUTE_SCHEMA_VERSION = 1;

export class CanonicalMediaRouteError extends Error {
  constructor(code, message, details = null) {
    super(message);
    this.name = "CanonicalMediaRouteError";
    this.code = code;
    this.details = details;
  }
}

function fail(code, message, details = null) {
  throw new CanonicalMediaRouteError(code, message, details);
}

function assert(condition, code, message, details = null) {
  if (!condition) fail(code, message, details);
}

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => (
      `${JSON.stringify(key)}:${stableJson(value[key])}`
    )).join(",")}}`;
  }
  return JSON.stringify(value);
}

function sha256Text(value) {
  return createHash("sha256").update(value).digest("hex");
}

function payloadHash(route) {
  const { integrity: _integrity, ...payload } = route;
  return sha256Text(stableJson(payload));
}

function withIntegrity(route) {
  return {
    ...route,
    integrity: {
      algorithm: "sha256-stable-json",
      payloadSha256: payloadHash(route),
    },
  };
}

function assertFingerprintShape(value, description) {
  assert(value && typeof value === "object" && !Array.isArray(value),
    "CANONICAL_ROUTE_INVALID", `${description} must be an object`);
  assert(Number.isSafeInteger(value.size) && value.size >= 0,
    "CANONICAL_ROUTE_INVALID", `${description}.size must be a non-negative safe integer`);
  assert(typeof value.mtimeNs === "string" && /^\d+$/.test(value.mtimeNs),
    "CANONICAL_ROUTE_INVALID", `${description}.mtimeNs must be an integer string`);
  assert(typeof value.sha256 === "string" && /^[a-f0-9]{64}$/.test(value.sha256),
    "CANONICAL_ROUTE_INVALID", `${description}.sha256 must be a lowercase SHA-256 digest`);
}

function assertRelativePath(value, description) {
  assert(typeof value === "string" && value.length > 0 && !isAbsolute(value),
    "CANONICAL_ROUTE_INVALID", `${description} must be project-relative`);
}

function projectPathContext(projectRoot) {
  const lexicalRoot = resolve(projectRoot);
  let realRoot;
  try {
    realRoot = realpathSync(lexicalRoot);
  } catch (error) {
    fail("CANONICAL_ROUTE_REALPATH_FAILED",
      `Cannot resolve canonical route project root ${lexicalRoot}: ${error.message}`);
  }
  return Object.freeze({ lexicalRoot, realRoot });
}

function realTargetInsideProject(context, candidatePath, description) {
  const lexicalPath = resolve(candidatePath);
  let realPath;
  try {
    realPath = realpathSync(lexicalPath);
  } catch (error) {
    fail("CANONICAL_ROUTE_REALPATH_FAILED",
      `Cannot resolve ${description} ${lexicalPath}: ${error.message}`);
  }
  const relativePath = relative(context.realRoot, realPath);
  assert(relativePath === "" || (!isAbsolute(relativePath)
    && relativePath !== ".." && !relativePath.startsWith(`..${sep}`)),
  "CANONICAL_ROUTE_REALPATH_OUTSIDE_PROJECT",
  `${description} resolves outside projectRoot`, {
    lexicalPath,
    realPath,
    projectRealRoot: context.realRoot,
  });
  return realPath;
}

function lexicalProjectPathForRealTarget(context, realPath, description) {
  const projectRelative = projectRelativePath(context.realRoot, realPath);
  return projectFile(context.lexicalRoot, projectRelative, description);
}

function normalizeEntryPath(context, entryPath) {
  const requestedPath = resolve(entryPath);
  const realPath = realTargetInsideProject(context, requestedPath, "canonical route entry HTML");
  let lexicalPath = requestedPath;
  try {
    projectRelativePath(context.lexicalRoot, lexicalPath);
  } catch {
    lexicalPath = lexicalProjectPathForRealTarget(
      context,
      realPath,
      "canonical route entry HTML",
    );
  }
  return Object.freeze({
    lexicalPath,
    realPath,
    projectRelative: projectRelativePath(context.lexicalRoot, lexicalPath),
  });
}

function indexAuthoredVideoSources({ context, entryPath }) {
  const sources = findStaticVideoSources({
    projectRoot: context.lexicalRoot,
    entryPath,
  });
  const byLexical = new Map();
  const byReal = new Map();
  for (const source of sources) {
    const lexicalPath = projectFile(
      context.lexicalRoot,
      source.source,
      `authored video source ${source.source}`,
    );
    const realPath = realTargetInsideProject(
      context,
      lexicalPath,
      `authored video source ${source.source}`,
    );
    const record = Object.freeze({ ...source, lexicalPath, realPath });
    byLexical.set(source.source, record);
    const aliases = byReal.get(realPath) ?? [];
    aliases.push(record);
    byReal.set(realPath, aliases);
  }
  return Object.freeze({ sources: Object.freeze([...byLexical.values()]), byLexical, byReal });
}

function assertUniqueAuthoredRealTarget(index, realPath, description) {
  const aliases = index.byReal.get(realPath) ?? [];
  assert(aliases.length > 0, "CANONICAL_ROUTE_SOURCE_NOT_AUTHORED",
    `Canonical source is not a static <video> in the render entry: ${description}`);
  assert(aliases.length === 1, "CANONICAL_ROUTE_SOURCE_AMBIGUOUS",
    `Multiple authored video URLs resolve to canonical source ${description}`, {
      aliases: aliases.map((entry) => entry.source),
      realPath,
    });
  return aliases[0];
}

function canonicalSnapshot(manifest) {
  return {
    sourceFingerprint: manifest.source.fingerprint,
    cacheFingerprint: manifest.cache.fingerprint,
    recipeHash: manifest.recipe.hash,
    fps: manifest.recipe.fps,
    outputTimeBase: manifest.recipe.outputTimeBase,
    outputFrameStepTicks: manifest.recipe.outputFrameStepTicks,
    frameCount: manifest.frameMap.cacheFrameCount,
    frameMapSha256: manifest.frameMap.entriesSha256,
  };
}

function assertCanonicalReady(manifest, description) {
  assert(manifest.status === "ready", "CANONICAL_ROUTE_CACHE_NOT_READY",
    `${description} is not ready`, { status: manifest.status ?? null });
  assert(manifest.acceptance?.passed === true, "CANONICAL_ROUTE_CACHE_NOT_ACCEPTED",
    `${description} has no passed acceptance record`);
  assert(manifest.recipe?.videoCodec === "h264" && manifest.recipe?.codecTag === "avc1",
    "CANONICAL_ROUTE_CACHE_CODEC_UNSUPPORTED", `${description} is not an avc1 H.264 cache`);
  assert(manifest.recipe?.pixelFormat === "yuv420p" && manifest.recipe?.bFrames === 0,
    "CANONICAL_ROUTE_CACHE_PROFILE_UNSUPPORTED",
    `${description} must be yuv420p with zero B-frames`);
  assert(manifest.recipe?.colorPolicy?.colorRange === "tv"
    && manifest.recipe?.colorPolicy?.colorSpace === "bt709"
    && manifest.recipe?.colorPolicy?.colorTransfer === "bt709"
    && manifest.recipe?.colorPolicy?.colorPrimaries === "bt709"
    && manifest.recipe?.colorPolicy?.chromaLocation === "left",
  "CANONICAL_ROUTE_CACHE_COLOR_UNSUPPORTED",
  `${description} is outside the BT.709 limited/chroma-left decoder contract`);
  assert(Number.isSafeInteger(manifest.frameMap?.cacheFrameCount)
    && manifest.frameMap.cacheFrameCount > 0,
  "CANONICAL_ROUTE_FRAME_MAP_INVALID", `${description} has no accepted frame map`);
}

function validateRouteShape(route) {
  assert(route && typeof route === "object" && !Array.isArray(route),
    "CANONICAL_ROUTE_INVALID", "Canonical media route must be an object");
  assert(route.kind === CANONICAL_MEDIA_ROUTE_KIND,
    "CANONICAL_ROUTE_FOREIGN", `Unsupported canonical route kind: ${route.kind ?? "missing"}`);
  assert(route.schemaVersion === CANONICAL_MEDIA_ROUTE_SCHEMA_VERSION,
    "CANONICAL_ROUTE_FOREIGN", `Unsupported canonical route schema: ${route.schemaVersion ?? "missing"}`);
  assert(route.integrity?.algorithm === "sha256-stable-json"
    && route.integrity?.payloadSha256 === payloadHash(route),
  "CANONICAL_ROUTE_INTEGRITY_FAILED", "Canonical route integrity hash does not match");
  assert(route.project && typeof route.project === "object",
    "CANONICAL_ROUTE_INVALID", "route.project is required");
  assertRelativePath(route.project.entry, "route.project.entry");
  assertFingerprintShape(route.project.entryFingerprint, "route.project.entryFingerprint");
  assert(Array.isArray(route.entries) && route.entries.length > 0,
    "CANONICAL_ROUTE_INVALID", "Canonical route must contain at least one mapping");
  const sources = new Set();
  const caches = new Set();
  for (const [index, entry] of route.entries.entries()) {
    const description = `route.entries[${index}]`;
    assert(entry && typeof entry === "object" && !Array.isArray(entry),
      "CANONICAL_ROUTE_INVALID", `${description} must be an object`);
    assertRelativePath(entry.source, `${description}.source`);
    assertRelativePath(entry.cache, `${description}.cache`);
    assertRelativePath(entry.canonicalManifest, `${description}.canonicalManifest`);
    assert(entry.source !== entry.cache, "CANONICAL_ROUTE_INVALID",
      `${description} source and cache cannot be identical`);
    assert(!sources.has(entry.source), "CANONICAL_ROUTE_DUPLICATE_SOURCE",
      `Duplicate canonical route source: ${entry.source}`);
    assert(!caches.has(entry.cache), "CANONICAL_ROUTE_DUPLICATE_CACHE",
      `Duplicate canonical route cache: ${entry.cache}`);
    sources.add(entry.source);
    caches.add(entry.cache);
    assertFingerprintShape(entry.canonicalManifestFingerprint,
      `${description}.canonicalManifestFingerprint`);
    assertFingerprintShape(entry.sourceFingerprint, `${description}.sourceFingerprint`);
    assertFingerprintShape(entry.cacheFingerprint, `${description}.cacheFingerprint`);
    assert(typeof entry.recipeHash === "string" && /^[a-f0-9]{64}$/.test(entry.recipeHash),
      "CANONICAL_ROUTE_INVALID", `${description}.recipeHash must be SHA-256`);
    assert(typeof entry.frameMapSha256 === "string" && /^[a-f0-9]{64}$/.test(entry.frameMapSha256),
      "CANONICAL_ROUTE_INVALID", `${description}.frameMapSha256 must be SHA-256`);
    assert(typeof entry.fps === "string" && /^\d+\/\d+$/.test(entry.fps),
      "CANONICAL_ROUTE_INVALID", `${description}.fps must be a rational`);
    assert(typeof entry.outputTimeBase === "string" && /^1\/\d+$/.test(entry.outputTimeBase),
      "CANONICAL_ROUTE_INVALID", `${description}.outputTimeBase must be 1/N`);
    assert(typeof entry.outputFrameStepTicks === "string" && /^\d+$/.test(entry.outputFrameStepTicks),
      "CANONICAL_ROUTE_INVALID", `${description}.outputFrameStepTicks must be an integer string`);
    assert(Number.isSafeInteger(entry.frameCount) && entry.frameCount > 0,
      "CANONICAL_ROUTE_INVALID", `${description}.frameCount must be positive`);
  }
  return route;
}

function normalizeVerifyMode(mode) {
  const value = mode === "hash" ? "sha256" : (mode ?? "sha256");
  assert(["stat", "sha256", "full"].includes(value), "CANONICAL_ROUTE_VERIFY_MODE_INVALID",
    `Canonical route verify mode must be stat, sha256, or full; got ${value}`);
  return value;
}

async function readStableCanonicalManifest(manifestPath) {
  const before = await fingerprintFile(manifestPath);
  const manifest = readCanonicalManifest(manifestPath);
  const after = await fingerprintFile(manifestPath);
  assert(fingerprintsEqual(before, after, true), "CANONICAL_ROUTE_MANIFEST_CHANGED",
    `Canonical manifest changed while it was being read: ${manifestPath}`);
  return { manifest, fingerprint: before };
}

function assertSnapshot(entry, manifest) {
  const expected = canonicalSnapshot(manifest);
  for (const field of Object.keys(expected)) {
    const left = stableJson(entry[field]);
    const right = stableJson(expected[field]);
    assert(left === right, "CANONICAL_ROUTE_MANIFEST_REASSIGNED",
      `Canonical manifest no longer matches routed ${field} for ${entry.source}`, {
        field,
        routed: entry[field],
        canonical: expected[field],
      });
  }
}

async function inspectRouteEntry({
  projectRoot,
  routeEntry,
  verifyMode,
  ffmpeg,
  ffprobe,
}) {
  const context = projectPathContext(projectRoot);
  const sourcePath = projectFile(context.lexicalRoot, routeEntry.source, "canonical route source");
  const cachePath = projectFile(context.lexicalRoot, routeEntry.cache, "canonical route cache");
  const canonicalManifestPath = projectFile(
    context.lexicalRoot,
    routeEntry.canonicalManifest,
    "canonical route manifest",
  );
  const sourceRealPath = realTargetInsideProject(context, sourcePath, "canonical route source");
  const cacheRealPath = realTargetInsideProject(context, cachePath, "canonical route cache");
  realTargetInsideProject(context, canonicalManifestPath, "canonical route manifest");
  await verifyFingerprint(
    canonicalManifestPath,
    routeEntry.canonicalManifestFingerprint,
    verifyMode === "stat" ? "stat" : "sha256",
    "canonical cache manifest",
  );
  const { manifest } = await readStableCanonicalManifest(canonicalManifestPath);
  assertCanonicalReady(manifest, canonicalManifestPath);
  const manifestSourceRealPath = realTargetInsideProject(
    context,
    resolve(manifest.source.path),
    "canonical manifest source",
  );
  const manifestCacheRealPath = realTargetInsideProject(
    context,
    resolve(manifest.cache.path),
    "canonical manifest cache",
  );
  assert(manifestSourceRealPath === sourceRealPath, "CANONICAL_ROUTE_SOURCE_PATH_MISMATCH",
    `Canonical manifest source path does not match ${routeEntry.source}`);
  assert(manifestCacheRealPath === cacheRealPath, "CANONICAL_ROUTE_CACHE_PATH_MISMATCH",
    `Canonical manifest cache path does not match ${routeEntry.cache}`);
  assertSnapshot(routeEntry, manifest);
  await verifyFingerprint(
    sourcePath,
    routeEntry.sourceFingerprint,
    verifyMode === "stat" ? "stat" : "sha256",
    `canonical route source ${routeEntry.source}`,
  );
  await verifyFingerprint(
    cachePath,
    routeEntry.cacheFingerprint,
    verifyMode === "stat" ? "stat" : "sha256",
    `canonical route cache ${routeEntry.cache}`,
  );
  if (verifyMode === "full") {
    await verifyCanonicalCache({
      manifest: canonicalManifestPath,
      ffmpeg,
      ffprobe,
    });
  }
  const [fpsNumerator, fpsDenominator] = routeEntry.fps.split("/").map(Number);
  return Object.freeze({
    id: `canonical:${routeEntry.recipeHash.slice(0, 16)}`,
    source: routeEntry.source,
    cache: routeEntry.cache,
    sourcePath,
    cachePath,
    sourceUrl: pathToFileURL(sourcePath).href,
    cacheUrl: pathToFileURL(cachePath).href,
    canonicalManifest: routeEntry.canonicalManifest,
    canonicalManifestPath,
    recipeKey: routeEntry.recipeHash,
    frameRate: fpsNumerator / fpsDenominator,
    canonical: Object.freeze({ ...routeEntry }),
    manifest,
  });
}

export async function createCanonicalMediaRoute({
  projectRoot,
  entryPath,
  canonicalManifestPaths,
  verifyMode = "full",
  ffmpeg = "ffmpeg",
  ffprobe = "ffprobe",
}) {
  const context = projectPathContext(projectRoot);
  const entry = normalizeEntryPath(context, entryPath);
  const mode = normalizeVerifyMode(verifyMode);
  assert(Array.isArray(canonicalManifestPaths) && canonicalManifestPaths.length > 0,
    "CANONICAL_ROUTE_MANIFEST_REQUIRED", "At least one canonical manifest is required");
  const authoredSources = indexAuthoredVideoSources({
    context,
    entryPath: entry.lexicalPath,
  });
  const routeEntries = [];
  for (const manifestInput of canonicalManifestPaths) {
    const canonicalManifestRealPath = realTargetInsideProject(
      context,
      resolve(manifestInput),
      "canonical cache manifest",
    );
    const canonicalManifestPath = lexicalProjectPathForRealTarget(
      context,
      canonicalManifestRealPath,
      "canonical cache manifest",
    );
    const canonicalManifest = projectRelativePath(context.lexicalRoot, canonicalManifestPath);
    const { manifest, fingerprint: canonicalManifestFingerprint } = await readStableCanonicalManifest(
      canonicalManifestPath,
    );
    assertCanonicalReady(manifest, canonicalManifestPath);
    const sourceRealPath = realTargetInsideProject(
      context,
      resolve(manifest.source.path),
      "canonical manifest source",
    );
    const authoredSource = assertUniqueAuthoredRealTarget(
      authoredSources,
      sourceRealPath,
      manifest.source.path,
    );
    const cacheRealPath = realTargetInsideProject(
      context,
      resolve(manifest.cache.path),
      "canonical manifest cache",
    );
    const source = authoredSource.source;
    const cache = projectRelativePath(context.realRoot, cacheRealPath);
    const snapshot = canonicalSnapshot(manifest);
    const routeEntry = {
      source,
      cache,
      canonicalManifest,
      canonicalManifestFingerprint,
      ...snapshot,
    };
    await inspectRouteEntry({
      projectRoot: context.lexicalRoot,
      routeEntry,
      verifyMode: mode,
      ffmpeg,
      ffprobe,
    });
    routeEntries.push(routeEntry);
  }
  routeEntries.sort((left, right) => left.source.localeCompare(right.source));
  return validateRouteShape(withIntegrity({
    kind: CANONICAL_MEDIA_ROUTE_KIND,
    schemaVersion: CANONICAL_MEDIA_ROUTE_SCHEMA_VERSION,
    createdAt: new Date().toISOString(),
    project: {
      entry: entry.projectRelative,
      entryFingerprint: await fingerprintFile(entry.lexicalPath),
    },
    policy: {
      route: "authored source URL -> accepted canonical cache URL",
      verification: "entry + route + canonical manifest + source + cache identity; fail closed",
      timing: "a separately verified timing bundle must bind both source and cache before decode",
    },
    entries: routeEntries,
  }));
}

export function readCanonicalMediaRoute(routePath) {
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(resolve(routePath), "utf8"));
  } catch (error) {
    fail("CANONICAL_ROUTE_READ_FAILED", `Cannot read canonical route ${routePath}: ${error.message}`);
  }
  return validateRouteShape(parsed);
}

export async function loadAndVerifyCanonicalMediaRoute({
  routePath,
  projectRoot,
  entryPath,
  verifyMode = "sha256",
  ffmpeg = "ffmpeg",
  ffprobe = "ffprobe",
}) {
  const context = projectPathContext(projectRoot);
  const entry = normalizeEntryPath(context, entryPath);
  const mode = normalizeVerifyMode(verifyMode);
  const routeRealPath = realTargetInsideProject(
    context,
    resolve(routePath),
    "canonical route manifest",
  );
  const normalizedRoutePath = lexicalProjectPathForRealTarget(
    context,
    routeRealPath,
    "canonical route manifest",
  );
  const route = readCanonicalMediaRoute(normalizedRoutePath);
  const expectedEntry = projectFile(context.lexicalRoot, route.project.entry, "canonical route entry");
  const expectedEntryRealPath = realTargetInsideProject(
    context,
    expectedEntry,
    "canonical route entry HTML",
  );
  assert(expectedEntryRealPath === entry.realPath, "CANONICAL_ROUTE_ENTRY_MISMATCH",
    `Canonical route entry ${expectedEntry} does not match render entry ${entry.lexicalPath}`);
  await verifyFingerprint(
    entry.lexicalPath,
    route.project.entryFingerprint,
    mode === "stat" ? "stat" : "sha256",
    "canonical route entry HTML",
  );
  const authoredSources = indexAuthoredVideoSources({
    context,
    entryPath: entry.lexicalPath,
  });
  const staleSources = route.entries.map((record) => record.source)
    .filter((source) => !authoredSources.byLexical.has(source));
  assert(staleSources.length === 0, "CANONICAL_ROUTE_SOURCE_SET_CHANGED",
    `Canonical route contains source(s) no longer authored by the entry: ${staleSources.join(", ")}`);
  for (const routeEntry of route.entries) {
    const authored = authoredSources.byLexical.get(routeEntry.source);
    assertUniqueAuthoredRealTarget(authoredSources, authored.realPath, routeEntry.source);
  }
  const entries = [];
  for (const routeEntry of route.entries) {
    entries.push(await inspectRouteEntry({
      projectRoot: context.lexicalRoot,
      routeEntry,
      verifyMode: mode,
      ffmpeg,
      ffprobe,
    }));
  }
  return Object.freeze({
    path: normalizedRoutePath,
    verifyMode: mode,
    route,
    entries: Object.freeze(entries),
  });
}

function mappingSourceRealPath(entry, description) {
  let candidate = entry?.sourcePath ?? null;
  if (!candidate && entry?.sourceUrl) {
    let url;
    try {
      url = new URL(entry.sourceUrl);
    } catch (error) {
      fail("CANONICAL_ROUTE_SOURCE_CONFLICT_CHECK_FAILED",
        `Cannot parse ${description} source URL: ${error.message}`);
    }
    assert(url.protocol === "file:", "CANONICAL_ROUTE_SOURCE_CONFLICT_CHECK_FAILED",
      `${description} source URL must be local: ${entry.sourceUrl}`);
    candidate = fileURLToPath(url);
  }
  if (!candidate) return null;
  try {
    return realpathSync(resolve(candidate));
  } catch (error) {
    fail("CANONICAL_ROUTE_SOURCE_CONFLICT_CHECK_FAILED",
      `Cannot resolve ${description} source identity: ${error.message}`);
  }
}

export function assertCanonicalMediaRouteSourceDisjoint({
  mediaSourceMapEntries = [],
  canonicalRouteEntries = [],
}) {
  assert(Array.isArray(mediaSourceMapEntries), "CANONICAL_ROUTE_INVALID",
    "mediaSourceMapEntries must be an array");
  assert(Array.isArray(canonicalRouteEntries), "CANONICAL_ROUTE_INVALID",
    "canonicalRouteEntries must be an array");
  const mediaSourceMapSources = new Set(mediaSourceMapEntries.map((entry) => entry.source));
  const mediaSourceMapByRealPath = new Map();
  for (const entry of mediaSourceMapEntries) {
    const realPath = mappingSourceRealPath(entry, `mediaSourceMap ${entry.source ?? "entry"}`);
    if (realPath) mediaSourceMapByRealPath.set(realPath, entry);
  }
  const aliasConflicts = [];
  const duplicateSources = [];
  for (const entry of canonicalRouteEntries) {
    const realPath = mappingSourceRealPath(entry, `canonical route ${entry.source ?? "entry"}`);
    const aliasedMediaSourceMap = realPath ? mediaSourceMapByRealPath.get(realPath) : null;
    if (mediaSourceMapSources.has(entry.source) || aliasedMediaSourceMap) {
      duplicateSources.push(entry.source);
      if (aliasedMediaSourceMap && aliasedMediaSourceMap.source !== entry.source) {
        aliasConflicts.push({
          canonicalSource: entry.source,
          mediaSourceMapSource: aliasedMediaSourceMap.source,
          realPath,
        });
      }
    }
  }
  assert(duplicateSources.length === 0, "CANONICAL_ROUTE_SOURCE_CONFLICT",
    "Canonical route and mediaSourceMap cannot both replace the same authored source", {
      duplicateSources,
      aliasConflicts,
    });
  return true;
}

export function mergeCanonicalMediaRouteMappings({
  mediaSourceMapEntries = [],
  canonicalRouteEntries = [],
}) {
  assertCanonicalMediaRouteSourceDisjoint({ mediaSourceMapEntries, canonicalRouteEntries });
  return Object.freeze([
    ...mediaSourceMapEntries,
    ...canonicalRouteEntries,
  ]);
}

function assertTimingFingerprint(plan, expected, description) {
  assert(plan.source.stat.size === expected.size && plan.source.sha256 === expected.sha256,
    "CANONICAL_ROUTE_TIMING_IDENTITY_MISMATCH",
    `${description} timing plan does not describe the routed file identity`, {
      timingSize: plan.source.stat.size,
      timingSha256: plan.source.sha256,
      expectedSize: expected.size,
      expectedSha256: expected.sha256,
    });
}

/**
 * Bind verified canonical route entries to an already verified timing bundle.
 * The returned entries have the same source/cache URL shape as media-source-map
 * entries, but cannot exist until both original and cache timelines match the
 * canonical manifest frame contract exactly.
 */
export function bindCanonicalMediaRouteToTimingEntries({ routeEntries, timingEntries }) {
  assert(Array.isArray(routeEntries) && routeEntries.length > 0,
    "CANONICAL_ROUTE_ENTRIES_REQUIRED", "Verified canonical route entries are required");
  assert(Array.isArray(timingEntries) && timingEntries.length > 0,
    "CANONICAL_ROUTE_TIMING_REQUIRED", "A verified media timing bundle is required");
  const bySource = new Map(timingEntries.map((entry) => [entry.source, entry]));
  const bound = [];
  for (const routeEntry of routeEntries) {
    const sourceTiming = bySource.get(routeEntry.source);
    const cacheTiming = bySource.get(routeEntry.cache);
    assert(sourceTiming?.roles?.includes("composition"), "CANONICAL_ROUTE_SOURCE_TIMING_MISSING",
      `No composition timing plan exists for ${routeEntry.source}`);
    assert(cacheTiming?.roles?.includes("decoder-cache")
      && cacheTiming.mapsFrom?.includes(routeEntry.source),
    "CANONICAL_ROUTE_CACHE_TIMING_MISSING",
    `No decoder-cache timing plan maps ${routeEntry.cache} from ${routeEntry.source}`);
    const canonical = routeEntry.canonical;
    assertTimingFingerprint(sourceTiming.plan, canonical.sourceFingerprint, routeEntry.source);
    assertTimingFingerprint(cacheTiming.plan, canonical.cacheFingerprint, routeEntry.cache);

    const sourcePts = expandPresentationPts(sourceTiming.plan).map(String);
    const manifestSourcePts = routeEntry.manifest.source.probe.timeline.presentationPtsTicks;
    assert(sourceTiming.plan.stream.timeBase === routeEntry.manifest.source.probe.timeline.sourceTimeBase
      && sourcePts.length === manifestSourcePts.length
      && sourcePts.every((pts, index) => pts === manifestSourcePts[index]),
    "CANONICAL_ROUTE_SOURCE_PTS_MISMATCH",
    `Source timing PTS differ from the accepted canonical frame map for ${routeEntry.source}`);

    const cachePts = expandPresentationPts(cacheTiming.plan);
    const frameStepTicks = Number(canonical.outputFrameStepTicks);
    assert(cacheTiming.plan.stream.timeBase === canonical.outputTimeBase,
      "CANONICAL_ROUTE_CACHE_TIME_BASE_MISMATCH",
      `Cache timing time base differs for ${routeEntry.cache}`);
    assert(cachePts.length === canonical.frameCount
      && cachePts.every((pts, index) => pts === index * frameStepTicks),
    "CANONICAL_ROUTE_CACHE_PTS_MISMATCH",
    `Cache timing PTS differ from the accepted canonical grid for ${routeEntry.cache}`);
    assert(routeEntry.manifest.frameMap.entries.length === cachePts.length
      && routeEntry.manifest.frameMap.entries.every((frame, index) => (
        frame.cacheFrameIndex === index && Number(frame.cachePtsTicks) === cachePts[index]
      )),
    "CANONICAL_ROUTE_FRAME_MAP_MISMATCH",
    `Canonical frame map differs from the verified cache timing plan for ${routeEntry.cache}`);
    bound.push(Object.freeze({
      id: routeEntry.id,
      source: routeEntry.source,
      cache: routeEntry.cache,
      // The verified timing bundle is the renderer's URL namespace. This also
      // keeps a project opened through a symlink coherent after the route
      // verifier has resolved its filesystem identities through realpath().
      sourceUrl: sourceTiming.sourceUrl,
      cacheUrl: cacheTiming.sourceUrl,
      recipeKey: routeEntry.recipeKey,
      frameRate: routeEntry.frameRate,
      canonical: Object.freeze({
        manifest: routeEntry.canonicalManifest,
        recipeHash: canonical.recipeHash,
        frameMapSha256: canonical.frameMapSha256,
        sourceIdentity: sourceTiming.plan.source.identity,
        cacheIdentity: cacheTiming.plan.source.identity,
        frameCount: canonical.frameCount,
      }),
    }));
  }
  return Object.freeze(bound);
}
