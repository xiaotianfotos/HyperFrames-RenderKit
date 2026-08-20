#!/usr/bin/env node

import assert from "node:assert/strict";
import {
  appendFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
  BIT_DEPTH_POLICY_10_TO_8,
  buildCanonicalCache,
  runProcess,
} from "./canonical_media_fallback/lib.mjs";
import {
  assertCanonicalMediaRouteSourceDisjoint,
  bindCanonicalMediaRouteToTimingEntries,
  createCanonicalMediaRoute,
  loadAndVerifyCanonicalMediaRoute,
  mergeCanonicalMediaRouteMappings,
  readCanonicalMediaRoute,
} from "./canonical_media_route_lib.mjs";
import {
  buildMediaTimingBundle,
  loadAndVerifyMediaTimingBundle,
} from "./media_timing_bundle_lib.mjs";
import { buildFullCanvasProductionDecoderPlan } from "./production_decoder_runtime/full_canvas_host.mjs";

async function generateTenBitSource(outputPath, hue = 0) {
  await runProcess("ffmpeg", [
    "-hide_banner", "-loglevel", "error", "-y",
    "-f", "lavfi", "-i", "testsrc2=size=160x90:rate=24:duration=0.5",
    "-vf", [
      `hue=h=${hue}`,
      "format=yuv420p10le",
      "setsar=1/1",
      "setparams=range=limited:color_primaries=bt709:color_trc=bt709:colorspace=bt709",
    ].join(","),
    "-c:v", "libx265", "-preset", "ultrafast",
    "-x265-params", "pools=1:frame-threads=1:keyint=24:min-keyint=24:scenecut=0",
    "-pix_fmt", "yuv420p10le", "-tag:v", "hvc1",
    "-color_range", "tv", "-color_primaries", "bt709", "-color_trc", "bt709",
    "-colorspace", "bt709", "-chroma_sample_location", "left",
    "-an", outputPath,
  ], { captureStdout: false });
}

const projectRoot = realpathSync(mkdtempSync(resolve(tmpdir(), "hf-canonical-route-test-")));
const projectRootAlias = `${projectRoot}-root-alias`;
const outsideRoot = realpathSync(mkdtempSync(resolve(tmpdir(), "hf-canonical-route-outside-")));
const mediaDirectory = resolve(projectRoot, ".media/video");
const cacheDirectory = resolve(projectRoot, ".render-cache/canonical-media");
const sourcePath = resolve(mediaDirectory, "video_002.mov");
const entryPath = resolve(projectRoot, "index.html");
const routePath = resolve(cacheDirectory, "canonical-media-route.json");
const timingPath = resolve(projectRoot, ".render-cache/media-timing/media-timing-bundle.json");

try {
  mkdirSync(mediaDirectory, { recursive: true });
  mkdirSync(cacheDirectory, { recursive: true });
  mkdirSync(resolve(projectRoot, ".render-cache/media-timing"), { recursive: true });
  writeFileSync(entryPath, '<video id="video_002" src=".media/video/video_002.mov"></video>\n');
  await generateTenBitSource(sourcePath);
  const cache = await buildCanonicalCache({
    input: sourcePath,
    fps: "60",
    cacheDirectory,
    profile: "quality",
    sampleCount: 3,
    bitDepthPolicy: BIT_DEPTH_POLICY_10_TO_8,
  });

  const route = await createCanonicalMediaRoute({
    projectRoot,
    entryPath,
    canonicalManifestPaths: [cache.manifestPath],
    verifyMode: "full",
  });
  writeFileSync(routePath, `${JSON.stringify(route, null, 2)}\n`);
  assert.equal(readCanonicalMediaRoute(routePath).entries.length, 1);

  const loadedRoute = await loadAndVerifyCanonicalMediaRoute({
    routePath,
    projectRoot,
    entryPath,
    verifyMode: "sha256",
  });
  assert.equal(loadedRoute.entries[0].source, ".media/video/video_002.mov");
  assert.equal(loadedRoute.entries[0].cachePath, realpathSync(cache.cachePath));

  const timingBundle = await buildMediaTimingBundle({
    projectRoot,
    entryPath,
    extraSources: loadedRoute.entries.map((entry) => ({
      absolutePath: entry.cachePath,
      role: "decoder-cache",
      mapsFrom: entry.source,
    })),
  });
  writeFileSync(timingPath, `${JSON.stringify(timingBundle, null, 2)}\n`);
  const loadedTiming = await loadAndVerifyMediaTimingBundle({
    manifestPath: timingPath,
    projectRoot,
    entryPath,
    verifyMode: "sha256",
    requiredDecoderMappings: loadedRoute.entries.map((entry) => ({
      source: entry.source,
      cache: entry.cache,
    })),
  });
  const bound = bindCanonicalMediaRouteToTimingEntries({
    routeEntries: loadedRoute.entries,
    timingEntries: loadedTiming.entries,
  });
  assert.equal(bound.length, 1);
  assert.equal(bound[0].canonical.frameCount, cache.manifest.frameMap.cacheFrameCount);
  assert.equal(bound[0].canonical.sourceIdentity,
    loadedTiming.entries.find((entry) => entry.source === bound[0].source).plan.source.identity);
  assert.equal(bound[0].sourceUrl,
    loadedTiming.entries.find((entry) => entry.source === bound[0].source).sourceUrl);
  assert.equal(bound[0].cacheUrl,
    loadedTiming.entries.find((entry) => entry.source === bound[0].cache).sourceUrl);

  const mergedMappings = mergeCanonicalMediaRouteMappings({
    mediaSourceMapEntries: [],
    canonicalRouteEntries: bound,
  });
  assert.equal(mergedMappings.length, 1);
  const decoderPlan = buildFullCanvasProductionDecoderPlan({
    timingEntries: loadedTiming.entries,
    sourceMapEntries: mergedMappings,
    tokenFactory: () => "canonical-route-test-token",
  });
  assert.equal(decoderPlan.hostSources.length, 1);
  assert.equal(decoderPlan.hostSources[0].filePath, realpathSync(cache.cachePath));
  assert.equal(decoderPlan.rendererSources[0].sourceUrl, bound[0].cacheUrl);
  assert.equal(decoderPlan.rendererSources[0].sourceIdentity, bound[0].canonical.cacheIdentity);

  assert.equal(assertCanonicalMediaRouteSourceDisjoint({
    mediaSourceMapEntries: [{ source: "media/other.mov" }],
    canonicalRouteEntries: bound,
  }), true);
  assert.throws(
    () => mergeCanonicalMediaRouteMappings({
      mediaSourceMapEntries: [{ source: bound[0].source, cache: "cache/legacy.mp4" }],
      canonicalRouteEntries: bound,
    }),
    (error) => error.code === "CANONICAL_ROUTE_SOURCE_CONFLICT"
      && error.details.duplicateSources[0] === bound[0].source,
  );

  const sourceBytes = readFileSync(sourcePath);
  const canonicalManifestRelative = relative(projectRoot, cache.manifestPath);
  const lexicalSource = ".media/video/video_002-link.mov";
  const lexicalSourcePath = resolve(projectRoot, lexicalSource);
  symlinkSync("video_002.mov", lexicalSourcePath);
  symlinkSync(projectRoot, projectRootAlias, "dir");
  const symlinkEntryPath = resolve(projectRootAlias, "symlink-entry.html");
  const symlinkRoutePath = resolve(
    projectRootAlias,
    ".render-cache/canonical-media/symlink-route.json",
  );
  const symlinkTimingPath = resolve(
    projectRootAlias,
    ".render-cache/media-timing/symlink-timing.json",
  );
  writeFileSync(symlinkEntryPath, `<video id="video_002" src="${lexicalSource}"></video>\n`);
  const symlinkRoute = await createCanonicalMediaRoute({
    projectRoot: projectRootAlias,
    entryPath: symlinkEntryPath,
    canonicalManifestPaths: [resolve(projectRootAlias, canonicalManifestRelative)],
    verifyMode: "sha256",
  });
  assert.equal(symlinkRoute.entries[0].source, lexicalSource,
    "route.source must preserve the authored lexical URL");
  writeFileSync(symlinkRoutePath, `${JSON.stringify(symlinkRoute, null, 2)}\n`);
  const loadedSymlinkRoute = await loadAndVerifyCanonicalMediaRoute({
    routePath: symlinkRoutePath,
    projectRoot: projectRootAlias,
    entryPath: symlinkEntryPath,
    verifyMode: "sha256",
  });
  assert.equal(loadedSymlinkRoute.entries[0].sourcePath,
    resolve(projectRootAlias, lexicalSource));
  assert.equal(realpathSync(loadedSymlinkRoute.entries[0].sourcePath), sourcePath);
  assert.equal(loadedSymlinkRoute.entries[0].cachePath,
    resolve(projectRootAlias, loadedSymlinkRoute.entries[0].cache));

  const symlinkTimingBundle = await buildMediaTimingBundle({
    projectRoot: projectRootAlias,
    entryPath: symlinkEntryPath,
    extraSources: loadedSymlinkRoute.entries.map((entry) => ({
      absolutePath: entry.cachePath,
      role: "decoder-cache",
      mapsFrom: entry.source,
    })),
  });
  writeFileSync(symlinkTimingPath, `${JSON.stringify(symlinkTimingBundle, null, 2)}\n`);
  const loadedSymlinkTiming = await loadAndVerifyMediaTimingBundle({
    manifestPath: symlinkTimingPath,
    projectRoot: projectRootAlias,
    entryPath: symlinkEntryPath,
    verifyMode: "sha256",
    requiredDecoderMappings: loadedSymlinkRoute.entries.map((entry) => ({
      source: entry.source,
      cache: entry.cache,
    })),
  });
  const boundSymlinkRoute = bindCanonicalMediaRouteToTimingEntries({
    routeEntries: loadedSymlinkRoute.entries,
    timingEntries: loadedSymlinkTiming.entries,
  });
  assert.equal(boundSymlinkRoute[0].source, lexicalSource);
  assert.equal(boundSymlinkRoute[0].sourceUrl,
    pathToFileURL(resolve(projectRootAlias, lexicalSource)).href);

  assert.throws(
    () => mergeCanonicalMediaRouteMappings({
      mediaSourceMapEntries: [{
        source: ".media/video/video_002.mov",
        sourceUrl: pathToFileURL(resolve(projectRootAlias, ".media/video/video_002.mov")).href,
      }],
      canonicalRouteEntries: loadedSymlinkRoute.entries,
    }),
    (error) => error.code === "CANONICAL_ROUTE_SOURCE_CONFLICT"
      && error.details.aliasConflicts[0].canonicalSource === lexicalSource,
  );

  const ambiguousEntryPath = resolve(projectRootAlias, "ambiguous-entry.html");
  writeFileSync(ambiguousEntryPath, [
    '<video src=".media/video/video_002.mov"></video>',
    `<video src="${lexicalSource}"></video>`,
  ].join("\n"));
  await assert.rejects(
    createCanonicalMediaRoute({
      projectRoot: projectRootAlias,
      entryPath: ambiguousEntryPath,
      canonicalManifestPaths: [resolve(projectRootAlias, canonicalManifestRelative)],
      verifyMode: "sha256",
    }),
    (error) => error.code === "CANONICAL_ROUTE_SOURCE_AMBIGUOUS"
      && error.details.aliases.length === 2,
  );

  const outsideFile = resolve(outsideRoot, "outside.mov");
  const outsideLink = resolve(projectRoot, ".media/video/outside.mov");
  const outsideEntryPath = resolve(projectRootAlias, "outside-entry.html");
  writeFileSync(outsideFile, "outside project root\n");
  symlinkSync(outsideFile, outsideLink);
  writeFileSync(outsideEntryPath, '<video src=".media/video/outside.mov"></video>\n');
  await assert.rejects(
    createCanonicalMediaRoute({
      projectRoot: projectRootAlias,
      entryPath: outsideEntryPath,
      canonicalManifestPaths: [resolve(projectRootAlias, canonicalManifestRelative)],
      verifyMode: "sha256",
    }),
    (error) => error.code === "CANONICAL_ROUTE_REALPATH_OUTSIDE_PROJECT",
  );

  const redirectTarget = resolve(projectRoot, ".media/video/video_002-redirect.mov");
  writeFileSync(redirectTarget, sourceBytes);
  unlinkSync(lexicalSourcePath);
  symlinkSync("video_002-redirect.mov", lexicalSourcePath);
  await assert.rejects(
    loadAndVerifyCanonicalMediaRoute({
      routePath: symlinkRoutePath,
      projectRoot: projectRootAlias,
      entryPath: symlinkEntryPath,
      verifyMode: "sha256",
    }),
    (error) => error.code === "CANONICAL_ROUTE_SOURCE_PATH_MISMATCH",
  );
  unlinkSync(lexicalSourcePath);
  symlinkSync("video_002.mov", lexicalSourcePath);

  const tamperedSource = Buffer.from(sourceBytes);
  tamperedSource[Math.floor(tamperedSource.length / 2)] ^= 0x01;
  writeFileSync(sourcePath, tamperedSource);
  await assert.rejects(
    loadAndVerifyCanonicalMediaRoute({
      routePath: symlinkRoutePath,
      projectRoot: projectRootAlias,
      entryPath: symlinkEntryPath,
      verifyMode: "sha256",
    }),
    /SHA-256 changed/,
  );
  writeFileSync(sourcePath, sourceBytes);
  assert.equal((await loadAndVerifyCanonicalMediaRoute({
    routePath: symlinkRoutePath,
    projectRoot: projectRootAlias,
    entryPath: symlinkEntryPath,
    verifyMode: "sha256",
  })).entries[0].source, lexicalSource);

  const missingCacheTiming = loadedTiming.entries.filter((entry) => entry.source !== bound[0].cache);
  assert.throws(
    () => bindCanonicalMediaRouteToTimingEntries({
      routeEntries: loadedRoute.entries,
      timingEntries: missingCacheTiming,
    }),
    (error) => error.code === "CANONICAL_ROUTE_CACHE_TIMING_MISSING",
  );

  const wrongCacheTiming = structuredClone(loadedTiming.entries);
  const wrongCache = wrongCacheTiming.find((entry) => entry.source === bound[0].cache);
  wrongCache.plan.stream.timeBase = "1/60001";
  assert.throws(
    () => bindCanonicalMediaRouteToTimingEntries({
      routeEntries: loadedRoute.entries,
      timingEntries: wrongCacheTiming,
    }),
    (error) => error.code === "CANONICAL_ROUTE_CACHE_TIME_BASE_MISMATCH",
  );

  const routeBytes = readFileSync(routePath);
  const tamperedRoute = JSON.parse(routeBytes);
  tamperedRoute.entries[0].frameCount += 1;
  writeFileSync(routePath, `${JSON.stringify(tamperedRoute, null, 2)}\n`);
  assert.throws(
    () => readCanonicalMediaRoute(routePath),
    (error) => error.code === "CANONICAL_ROUTE_INTEGRITY_FAILED",
  );
  writeFileSync(routePath, routeBytes);

  appendFileSync(cache.cachePath, "tampered");
  await assert.rejects(
    loadAndVerifyCanonicalMediaRoute({
      routePath,
      projectRoot,
      entryPath,
      verifyMode: "sha256",
    }),
    /size changed|SHA-256 changed/,
  );

  const mainSource = readFileSync(new URL("../full-canvas-main.mjs", import.meta.url), "utf8");
  const rendererSource = readFileSync(new URL("../full-canvas-renderer.js", import.meta.url), "utf8");
  assert.match(mainSource, /args\.canonicalMediaRoute/);
  assert.match(mainSource, /loadAndVerifyCanonicalMediaRoute\(\{/);
  assert.match(mainSource, /requiredDecoderMappings: decoderMappingRequirements/);
  assert.match(mainSource, /bindCanonicalMediaRouteToTimingEntries\(\{/);
  assert.match(mainSource, /sourceMapEntries: decoderSourceMappings/);
  assert.match(mainSource, /canonicalMediaRouteMappings: boundCanonicalMediaRoute/);
  assert.match(mainSource, /--canonicalMediaRoute requires production-webcodecs/);
  assert.match(rendererSource, /canonical media route renderer contract mismatch/);
  assert.match(rendererSource, /Canonical media route source timing identity changed/);
  assert.match(rendererSource, /Canonical media route frame contract changed/);

  process.stdout.write("canonical media route integration test passed\n");
} finally {
  try {
    unlinkSync(projectRootAlias);
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  rmSync(projectRoot, { recursive: true, force: true });
  rmSync(outsideRoot, { recursive: true, force: true });
}
