#!/usr/bin/env node

import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { copyFile, mkdtemp, readFile, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { expandPresentationPts, scanMediaTiming } from "../media_timing_plan_lib.mjs";
import { createProductionDemuxBroker } from "./main.mjs";
import {
  buildFullCanvasProductionDecoderPlan,
  preflightFullCanvasProductionDecoder,
} from "./full_canvas_host.mjs";
import { CACHE_DECISION, DIRECT_DECISION, ticksToMicrosecondsExact } from "./contract.mjs";

const execFileAsync = promisify(execFile);
const rendererRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const fixture = resolve(rendererRoot, "results/deterministic-decoder-poc/fixture/h264-bframes-120.mp4");
const temporary = await mkdtemp(join(tmpdir(), "full-canvas-production-decoder-"));

try {
  const tagged = join(temporary, "tagged-bt709.mp4");
  await execFileAsync("ffmpeg", [
    "-hide_banner", "-loglevel", "error", "-y", "-i", fixture,
    "-map", "0:v:0", "-c", "copy",
    "-color_range", "tv", "-colorspace", "bt709",
    "-color_primaries", "bt709", "-color_trc", "bt709",
    "-chroma_sample_location", "left", tagged,
  ]);
  const [authoredPlan, taggedPlan] = await Promise.all([
    scanMediaTiming(fixture),
    scanMediaTiming(tagged),
  ]);
  const authoredEntry = {
    source: "media/authored.mp4",
    sourcePath: fixture,
    sourceUrl: pathToFileURL(fixture).href,
    roles: ["composition"],
    mapsFrom: [],
    plan: authoredPlan,
  };
  const taggedEntry = {
    source: "cache/tagged.mp4",
    sourcePath: tagged,
    sourceUrl: pathToFileURL(tagged).href,
    roles: ["decoder-cache"],
    mapsFrom: [authoredEntry.source],
    plan: taggedPlan,
  };

  const mappedPlan = buildFullCanvasProductionDecoderPlan({
    timingEntries: [authoredEntry, taggedEntry],
    sourceMapEntries: [{
      source: authoredEntry.source,
      sourceUrl: authoredEntry.sourceUrl,
      cache: taggedEntry.source,
      cacheUrl: taggedEntry.sourceUrl,
    }],
  });
  assert.equal(mappedPlan.hostSources.length, 1);
  assert.equal(mappedPlan.hostSources[0].filePath, tagged);
  assert.equal(mappedPlan.rendererSources[0].sourceUrl, taggedEntry.sourceUrl);
  assert.equal("filePath" in mappedPlan.rendererSources[0], false);

  const broker = createProductionDemuxBroker();
  const direct = await preflightFullCanvasProductionDecoder({
    broker,
    plan: mappedPlan,
    readyFramesMax: 8,
  });
  assert.equal(direct.decision, DIRECT_DECISION);
  assert.equal(direct.sources[0].summary.strictSdrProfile.colorRange, "tv");
  assert.equal(direct.sources[0].summary.strictSdrProfile.chromaLocation, "left");
  assert.equal(direct.sources[0].summary.timingIndexAudit.verifiedFrames, 120);
  assert.equal(direct.sources[0].summary.timingIndexAudit.digest,
    direct.sources[0].summary.presentationTimingDigest);
  assert.equal(JSON.stringify(direct).includes(tagged), false, "route must not expose an absolute source path");
  await broker.dispose();
  assert.equal(broker.snapshot().activeSources, 0);
  assert.equal(broker.snapshot().byteBudget.currentBytes, 0);

  const insufficientLeadBroker = createProductionDemuxBroker();
  const insufficientLead = await preflightFullCanvasProductionDecoder({
    broker: insufficientLeadBroker,
    plan: mappedPlan,
    decodeLeadMax: 4,
    readyFramesMax: 8,
  });
  assert.equal(insufficientLead.decision, CACHE_DECISION);
  assert.equal(insufficientLead.sources[0].reason.code, "CACHE_REQUIRED_DECODE_LEAD");
  assert.equal(insufficientLead.sources[0].reason.details.requiredDecodeLead, 5);
  await insufficientLeadBroker.dispose();

  const insufficientReadyBroker = createProductionDemuxBroker();
  const insufficientReady = await preflightFullCanvasProductionDecoder({
    broker: insufficientReadyBroker,
    plan: mappedPlan,
    decodeLeadMax: 8,
    readyFramesMax: 4,
  });
  assert.equal(insufficientReady.decision, CACHE_DECISION);
  assert.equal(insufficientReady.sources[0].reason.code, "CACHE_REQUIRED_READY_FRAMES");
  assert.equal(insufficientReady.sources[0].reason.details.requiredReadyFrames, 5);
  await insufficientReadyBroker.dispose();

  const duplicate = join(temporary, "tagged-copy.mp4");
  const linked = join(temporary, "tagged-link.mp4");
  await copyFile(tagged, duplicate);
  await symlink(tagged, linked);
  const [duplicatePlan, linkedPlan] = await Promise.all([
    scanMediaTiming(duplicate),
    scanMediaTiming(linked),
  ]);
  assert.equal(duplicatePlan.source.identity, taggedPlan.source.identity);
  assert.equal(linkedPlan.source.identity, taggedPlan.source.identity);
  const duplicateEntries = [
    {
      source: "media/tagged-copy.mp4",
      sourcePath: duplicate,
      sourceUrl: pathToFileURL(duplicate).href,
      roles: ["composition"],
      mapsFrom: [],
      plan: duplicatePlan,
    },
    {
      source: "media/tagged-link.mp4",
      sourcePath: linked,
      sourceUrl: pathToFileURL(linked).href,
      roles: ["composition"],
      mapsFrom: [],
      plan: linkedPlan,
    },
  ];
  let duplicateTokenSerial = 0;
  const duplicateIdentityPlan = buildFullCanvasProductionDecoderPlan({
    timingEntries: duplicateEntries,
    tokenFactory: () => `duplicate-identity-token-${duplicateTokenSerial++}`,
  });
  assert.equal(duplicateIdentityPlan.hostSources.length, 1,
    "byte-identical paths must share one host source");
  assert.equal(duplicateIdentityPlan.approvedByToken.size, 1,
    "byte-identical paths must share one main-only token");
  assert.equal(duplicateIdentityPlan.rendererSources.length, 2,
    "each authored URL still needs a renderer descriptor");
  assert.equal(duplicateIdentityPlan.rendererSources[0].sourceToken,
    duplicateIdentityPlan.rendererSources[1].sourceToken);
  assert.notEqual(duplicateIdentityPlan.rendererSources[0].sourceUrl,
    duplicateIdentityPlan.rendererSources[1].sourceUrl);
  const duplicateBroker = createProductionDemuxBroker();
  const duplicateDirect = await preflightFullCanvasProductionDecoder({
    broker: duplicateBroker,
    plan: duplicateIdentityPlan,
    readyFramesMax: 8,
  });
  assert.equal(duplicateDirect.decision, DIRECT_DECISION);
  assert.equal(duplicateDirect.sources[0].summary.timingIndexAudit.verifiedPlans, 2);
  assert.equal(duplicateBroker.snapshot().sourceOpenRequests, 1,
    "identity aliases must never ask the broker to open a second path");
  await duplicateBroker.dispose();
  assert.equal(duplicateBroker.snapshot().activeSources, 0);
  assert.equal(duplicateBroker.snapshot().byteBudget.currentBytes, 0);

  const untaggedPlan = buildFullCanvasProductionDecoderPlan({ timingEntries: [authoredEntry] });
  const untaggedBroker = createProductionDemuxBroker();
  const colorRoute = await preflightFullCanvasProductionDecoder({
    broker: untaggedBroker,
    plan: untaggedPlan,
    readyFramesMax: 4,
  });
  assert.equal(colorRoute.decision, CACHE_DECISION);
  assert.equal(colorRoute.sources[0].reason.code, "CACHE_REQUIRED_COLOR_PROFILE");
  assert.equal(colorRoute.sources[0].canonicalContract.integration, "tools/canonical_media_fallback");
  assert.equal(untaggedBroker.snapshot().activeSources, 0, "color rejection must happen before demux open");
  await untaggedBroker.dispose();

  const driftedPlan = structuredClone(taggedPlan);
  const driftedPts = [...expandPresentationPts(taggedPlan)];
  const middle = Math.floor(driftedPts.length / 2);
  driftedPts[middle] += 1;
  driftedPlan.presentation.pts = {
    kind: "delta",
    firstPtsTicks: driftedPts[0],
    deltas: driftedPts.slice(1).map((pts, index) => pts - driftedPts[index]),
  };
  const driftedEntry = { ...taggedEntry, plan: driftedPlan };
  const driftedHostPlan = buildFullCanvasProductionDecoderPlan({
    timingEntries: [authoredEntry, driftedEntry],
    sourceMapEntries: [{
      source: authoredEntry.source,
      sourceUrl: authoredEntry.sourceUrl,
      cache: driftedEntry.source,
      cacheUrl: driftedEntry.sourceUrl,
    }],
  });
  const driftedBroker = createProductionDemuxBroker();
  const driftedRoute = await preflightFullCanvasProductionDecoder({
    broker: driftedBroker,
    plan: driftedHostPlan,
    readyFramesMax: 4,
  });
  assert.equal(driftedRoute.decision, CACHE_DECISION);
  assert.equal(driftedRoute.sources[0].reason.code, "CACHE_REQUIRED_TIMING_INDEX");
  await driftedBroker.dispose();

  const durationDriftPlan = structuredClone(taggedPlan);
  durationDriftPlan.presentation.lastFrameDurationTicks += 1;
  durationDriftPlan.presentation.displayEndTicks += 1;
  const durationDriftEntry = { ...taggedEntry, plan: durationDriftPlan };
  const durationDriftHostPlan = buildFullCanvasProductionDecoderPlan({
    timingEntries: [authoredEntry, durationDriftEntry],
    sourceMapEntries: [{
      source: authoredEntry.source,
      sourceUrl: authoredEntry.sourceUrl,
      cache: durationDriftEntry.source,
      cacheUrl: durationDriftEntry.sourceUrl,
    }],
  });
  const durationDriftBroker = createProductionDemuxBroker();
  const durationDriftRoute = await preflightFullCanvasProductionDecoder({
    broker: durationDriftBroker,
    plan: durationDriftHostPlan,
    readyFramesMax: 4,
  });
  assert.equal(durationDriftRoute.decision, CACHE_DECISION);
  assert.equal(durationDriftRoute.sources[0].reason.code, "CACHE_REQUIRED_TIMING_INDEX");
  await durationDriftBroker.dispose();

  assert.equal(ticksToMicrosecondsExact(1_000, "1/60000"), 16_666);
  assert.equal(ticksToMicrosecondsExact(3_000, "1/60000"), 50_000);

  const [main, renderer, preload] = await Promise.all([
    readFile(resolve(rendererRoot, "full-canvas-main.mjs"), "utf8"),
    readFile(resolve(rendererRoot, "full-canvas-renderer.js"), "utf8"),
    readFile(resolve(rendererRoot, "preload.mjs"), "utf8"),
  ]);
  assert.match(main, /args\.mediaDecoderBackend \?\? "html-video"/);
  assert.match(main, /failureExitCode = 2/);
  assert.match(main, /prepareProductionDecoderBackend\(\)/);
  assert.match(main, /validateDemuxConcurrencyBudget\(\{/);
  assert.match(main, /args\.productionDecoderOpenCursors \?\? Number\(args\.mediaDecoderLanesTotal \?\? 12\)/);
  assert.match(main, /Math\.max\(\s*32 \* 1024 \* 1024,[\s\S]*args\.mediaDecoderLanesTotal/);
  assert.match(main, /demuxConcurrencyBudget = validateDemuxConcurrencyBudget/);
  assert.match(main, /h264_metadata=video_full_range_flag=0:colour_primaries=1/);
  assert.match(main, /Production decoder IPC did not originate from the active render window/);
  assert.match(renderer, /PRODUCTION_HTMLVIDEO_FALLBACK_FORBIDDEN/);
  assert.match(renderer, /ticksToMicrosecondsExact/);
  assert.match(renderer, /runtime-owned-do-not-close/);
  assert.match(renderer, /await disposeActiveProductionDecoder\(\)/);
  for (const method of [
    "decoderOpenSource", "decoderResolveTarget", "decoderBeginCursor", "decoderNextBatch",
    "decoderAckBatch", "decoderReleaseCursor", "decoderCloseSource", "decoderStats",
  ]) assert.match(preload, new RegExp(`${method}:`));

  console.log(JSON.stringify({
    test: "production_decoder_full_canvas_integration",
    defaultBackend: "html-video",
    explicitBackend: "production-webcodecs",
    directColorGate: direct.sources[0].summary.strictSdrProfile,
    unknownColorRoute: colorRoute.sources[0].reason.code,
    timingDriftRoute: driftedRoute.sources[0].reason.code,
    durationDriftRoute: durationDriftRoute.sources[0].reason.code,
    exactPtsUs: [16_666, 50_000],
    noManifestIpc: true,
    saturationBudgetGate: true,
    outputBt709MetadataGate: true,
    duplicateIdentityAliases: true,
    resourceCleanup: true,
    pass: true,
  }));
} finally {
  await rm(temporary, { recursive: true, force: true });
}
