import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { expandPresentationPts } from "../media_timing_plan_lib.mjs";
import {
  CACHE_DECISION,
  DIRECT_DECISION,
  ProductionDecoderError,
  cacheRequiredDecision,
  ticksToMicrosecondsExact,
} from "./contract.mjs";
import { digestPresentationTimingMicroseconds } from "./main_broker.mjs";

const execFileAsync = promisify(execFile);

function assert(condition, code, message, details = {}) {
  if (!condition) throw new ProductionDecoderError(code, message, details);
}

/**
 * Resolve only the timing-bundle sources the hidden production decoder will
 * actually consume. A verified source-map substitution is applied before the
 * allow-list is made, so an unused authored HEVC source cannot accidentally be
 * opened alongside its canonical H.264 cache.
 */
export function buildFullCanvasProductionDecoderPlan({
  timingEntries,
  sourceMapEntries = [],
  tokenFactory = randomUUID,
}) {
  assert(Array.isArray(timingEntries) && timingEntries.length > 0,
    "PRODUCTION_DECODER_TIMING_PLAN_REQUIRED",
    "production-webcodecs requires a verified media timing bundle");
  const timingByUrl = new Map(timingEntries.map((entry) => [entry.sourceUrl, entry]));
  const mappedBySourceUrl = new Map(sourceMapEntries.map((entry) => [entry.sourceUrl, entry]));
  const compositionEntries = timingEntries.filter((entry) => entry.roles?.includes("composition"));
  assert(compositionEntries.length > 0, "PRODUCTION_DECODER_COMPOSITION_SOURCES_REQUIRED",
    "The verified timing bundle has no composition video sources");

  const selectedByUrl = new Map();
  for (const authored of compositionEntries) {
    const mapping = mappedBySourceUrl.get(authored.sourceUrl) ?? null;
    const decoderUrl = mapping?.cacheUrl ?? authored.sourceUrl;
    const selected = timingByUrl.get(decoderUrl);
    assert(selected != null, "PRODUCTION_DECODER_SELECTED_TIMING_PLAN_MISSING",
      "The selected decoder source has no verified timing plan", {
        authoredSource: authored.source,
        decoderSource: mapping?.cache ?? authored.source,
      });
    selectedByUrl.set(decoderUrl, selected);
  }

  // One byte-identical stream can legitimately be referenced through multiple
  // project paths (copies, symlinks, or two authored URLs). The broker owns
  // sources by content identity and deliberately rejects one identity opened
  // through two paths, so collapse the host allow-list by identity while still
  // retaining one renderer descriptor for every selected URL.
  const selectedByIdentity = new Map();
  for (const entry of [...selectedByUrl.values()].sort((left, right) => (
    left.source.localeCompare(right.source) || left.sourceUrl.localeCompare(right.sourceUrl)
  ))) {
    const sourceIdentity = entry.plan.source.identity;
    const aliases = selectedByIdentity.get(sourceIdentity) ?? [];
    aliases.push(entry);
    selectedByIdentity.set(sourceIdentity, aliases);
  }

  const approvedByToken = new Map();
  const rendererSources = [];
  const hostSources = [];
  for (const [sourceIdentity, entries] of selectedByIdentity) {
    const sourceToken = tokenFactory();
    const entry = entries[0];
    const aliases = Object.freeze(entries.map((alias) => Object.freeze({
      source: alias.source,
      sourceUrl: alias.sourceUrl,
      filePath: alias.sourcePath,
      plan: alias.plan,
    })));
    const record = Object.freeze({
      sourceToken,
      sourceIdentity,
      source: entry.source,
      sourceUrl: entry.sourceUrl,
      filePath: entry.sourcePath,
      plan: entry.plan,
      aliases,
    });
    approvedByToken.set(sourceToken, record);
    for (const alias of aliases) {
      rendererSources.push(Object.freeze({
        sourceToken,
        sourceIdentity,
        source: alias.source,
        sourceUrl: alias.sourceUrl,
      }));
    }
    hostSources.push(record);
  }
  return Object.freeze({
    approvedByToken,
    rendererSources: Object.freeze(rendererSources),
    hostSources: Object.freeze(hostSources),
  });
}

function assertDirectSummaryMatchesTimingPlan(record, opened) {
  const { plan } = record;
  try {
    const ptsTicks = expandPresentationPts(plan);
    const ptsUs = new Float64Array(ptsTicks.length);
    const durationUs = new Float64Array(ptsTicks.length);
    for (let index = 0; index < ptsTicks.length; index += 1) {
      const durationTicks = index + 1 < ptsTicks.length
        ? ptsTicks[index + 1] - ptsTicks[index]
        : plan.presentation.lastFrameDurationTicks;
      ptsUs[index] = ticksToMicrosecondsExact(ptsTicks[index], plan.stream.timeBase);
      durationUs[index] = ticksToMicrosecondsExact(durationTicks, plan.stream.timeBase);
    }
    const timingDigest = digestPresentationTimingMicroseconds(ptsUs, durationUs);
    const firstPtsUs = ptsUs[0];
    const lastPtsUs = ptsUs.at(-1);
    if (opened.summary.presentationFrameCount !== ptsUs.length
        || opened.summary.firstPtsUs !== firstPtsUs
        || opened.summary.lastPtsUs !== lastPtsUs
        || opened.summary.presentationTimingDigest !== timingDigest) {
      throw new ProductionDecoderError(
        "CACHE_REQUIRED_TIMING_INDEX",
        "The complete Mediabunny PTS/duration index differs from the verified timing plan",
        {
          source: record.source,
          timingFrameCount: ptsUs.length,
          demuxFrameCount: opened.summary.presentationFrameCount,
          timingFirstPtsUs: firstPtsUs,
          demuxFirstPtsUs: opened.summary.firstPtsUs,
          timingLastPtsUs: lastPtsUs,
          demuxLastPtsUs: opened.summary.lastPtsUs,
          timingDigest,
          demuxTimingDigest: opened.summary.presentationTimingDigest ?? null,
        },
      );
    }
    return Object.freeze({
      verifiedFrames: ptsUs.length,
      digest: timingDigest,
      encoding: "pts-us-u64be+duration-us-u64be/sha256",
    });
  } catch (error) {
    if (error?.code === "CACHE_REQUIRED_TIMING_INDEX") throw error;
    throw new ProductionDecoderError(
      "CACHE_REQUIRED_TIMING_INDEX",
      "The verified timing plan cannot be represented by the exact decoder microsecond index",
      {
        source: record.source,
        causeCode: error?.code ?? null,
        cause: error?.message ?? String(error),
      },
    );
  }
}

async function inspectStrictSdrProfile(filePath, ffprobePath) {
  const { stdout } = await execFileAsync(ffprobePath, [
    "-v", "error", "-select_streams", "v:0",
    "-show_entries",
    "stream=pix_fmt,color_range,color_space,color_transfer,color_primaries,chroma_location",
    "-of", "json", filePath,
  ], { encoding: "utf8", maxBuffer: 1024 * 1024 });
  const stream = JSON.parse(stdout).streams?.[0] ?? null;
  assert(stream != null, "CACHE_REQUIRED_VIDEO_TRACK", "ffprobe found no primary video stream");
  const expected = {
    pix_fmt: "yuv420p",
    color_range: "tv",
    color_space: "bt709",
    color_transfer: "bt709",
    color_primaries: "bt709",
    chroma_location: "left",
  };
  const mismatches = Object.entries(expected)
    .filter(([key, value]) => stream[key] !== value)
    .map(([key, value]) => `${key}:${stream[key] ?? "missing"}->${value}`);
  if (mismatches.length) {
    const pixelFormatMismatch = stream.pix_fmt !== expected.pix_fmt;
    const highBitDepth = /(?:10|12|16)(?:le|be)?$/i.test(String(stream.pix_fmt ?? ""));
    throw new ProductionDecoderError(
      highBitDepth
        ? "CACHE_REQUIRED_BIT_DEPTH"
        : pixelFormatMismatch
          ? "CACHE_REQUIRED_PIXEL_FORMAT"
          : "CACHE_REQUIRED_COLOR_PROFILE",
      "Direct H.264 requires an explicit BT.709 limited-range yuv420p/chroma-left profile",
      {
        pixelFormat: stream.pix_fmt ?? null,
        colorRange: stream.color_range ?? null,
        colorSpace: stream.color_space ?? null,
        colorTransfer: stream.color_transfer ?? null,
        colorPrimaries: stream.color_primaries ?? null,
        chromaLocation: stream.chroma_location ?? null,
        mismatches: mismatches.join(","),
      },
    );
  }
  return Object.freeze({
    pixelFormat: stream.pix_fmt,
    colorRange: stream.color_range,
    colorSpace: stream.color_space,
    colorTransfer: stream.color_transfer,
    colorPrimaries: stream.color_primaries,
    chromaLocation: stream.chroma_location,
  });
}

/** Preflight every selected source before the muxer or renderer starts. */
export async function preflightFullCanvasProductionDecoder({
  broker,
  plan,
  ffprobePath = "ffprobe",
  decodeLeadMax = 8,
  readyFramesMax = 8,
}) {
  const sources = [];
  let decision = DIRECT_DECISION;
  for (const record of plan.hostSources) {
    let strictSdrProfile;
    try {
      strictSdrProfile = await inspectStrictSdrProfile(record.filePath, ffprobePath);
    } catch (error) {
      if (!String(error?.code ?? "").startsWith("CACHE_REQUIRED_")) throw error;
      decision = CACHE_DECISION;
      const route = cacheRequiredDecision(error, record.sourceIdentity);
      sources.push(Object.freeze({
        source: record.source,
        sourceIdentity: record.sourceIdentity,
        decision: route.decision,
        reason: route.reason,
        canonicalContract: route.canonicalContract,
      }));
      break;
    }
    const opened = await broker.openSource({
      filePath: record.filePath,
      sourceIdentity: record.sourceIdentity,
    });
    if (opened.decision === CACHE_DECISION) {
      decision = CACHE_DECISION;
      sources.push(Object.freeze({
        source: record.source,
        sourceIdentity: record.sourceIdentity,
        decision: opened.decision,
        reason: opened.reason,
        canonicalContract: opened.canonicalContract,
      }));
      break;
    }
    assert(opened.decision === DIRECT_DECISION, "PRODUCTION_DECODER_INVALID_ROUTE_DECISION",
      "Production decoder broker returned an unknown route decision", { decision: opened.decision });
    let timingIndexAudit;
    try {
      const timingRecords = record.aliases?.length ? record.aliases : [record];
      const timingAudits = timingRecords.map((timingRecord) => (
        assertDirectSummaryMatchesTimingPlan({
          ...timingRecord,
          sourceIdentity: record.sourceIdentity,
        }, opened)
      ));
      timingIndexAudit = Object.freeze({
        ...timingAudits[0],
        verifiedPlans: timingAudits.length,
      });
    } catch (error) {
      if (!String(error?.code ?? "").startsWith("CACHE_REQUIRED_")) throw error;
      decision = CACHE_DECISION;
      const route = cacheRequiredDecision(error, record.sourceIdentity);
      sources.push(Object.freeze({
        source: record.source,
        sourceIdentity: record.sourceIdentity,
        decision: route.decision,
        reason: route.reason,
        canonicalContract: route.canonicalContract,
      }));
      break;
    }
    if (opened.summary.maximumPresentationReorderDepth > readyFramesMax) {
      decision = CACHE_DECISION;
      const route = cacheRequiredDecision(new ProductionDecoderError(
        "CACHE_REQUIRED_REORDER_DEPTH",
        "H.264 reorder depth exceeds the validated renderer frame-retention profile",
        {
          maximumPresentationReorderDepth: opened.summary.maximumPresentationReorderDepth,
          readyFramesMax,
        },
      ), record.sourceIdentity);
      sources.push(Object.freeze({
        source: record.source,
        sourceIdentity: record.sourceIdentity,
        decision: route.decision,
        reason: route.reason,
        canonicalContract: route.canonicalContract,
      }));
      break;
    }
    // WebCodecs implementations may retain reorderDepth + 1 pictures before
    // producing the first presentation frame. Keep one additional submitted
    // picture available so bounded backpressure cannot deadlock the first GOP.
    const requiredDecodeLead = opened.summary.maximumPresentationReorderDepth + 2;
    if (requiredDecodeLead > decodeLeadMax) {
      decision = CACHE_DECISION;
      const route = cacheRequiredDecision(new ProductionDecoderError(
        "CACHE_REQUIRED_DECODE_LEAD",
        "H.264 reorder depth exceeds the configured decoder input-lead budget",
        {
          maximumPresentationReorderDepth: opened.summary.maximumPresentationReorderDepth,
          requiredDecodeLead,
          decodeLeadMax,
        },
      ), record.sourceIdentity);
      sources.push(Object.freeze({
        source: record.source,
        sourceIdentity: record.sourceIdentity,
        decision: route.decision,
        reason: route.reason,
        canonicalContract: route.canonicalContract,
      }));
      break;
    }
    if (requiredDecodeLead > readyFramesMax) {
      decision = CACHE_DECISION;
      const route = cacheRequiredDecision(new ProductionDecoderError(
        "CACHE_REQUIRED_READY_FRAMES",
        "H.264 reorder depth exceeds the configured decoded-frame retention budget",
        {
          maximumPresentationReorderDepth: opened.summary.maximumPresentationReorderDepth,
          requiredReadyFrames: requiredDecodeLead,
          readyFramesMax,
        },
      ), record.sourceIdentity);
      sources.push(Object.freeze({
        source: record.source,
        sourceIdentity: record.sourceIdentity,
        decision: route.decision,
        reason: route.reason,
        canonicalContract: route.canonicalContract,
      }));
      break;
    }
    sources.push(Object.freeze({
      source: record.source,
      sourceIdentity: record.sourceIdentity,
      decision: opened.decision,
      summary: Object.freeze({
        codec: opened.summary.codec,
        sampleEntry: opened.summary.sampleEntry,
        timing: opened.summary.timing,
        presentationFrameCount: opened.summary.presentationFrameCount,
        maximumPresentationReorderDepth: opened.summary.maximumPresentationReorderDepth,
        presentationTimingDigest: opened.summary.presentationTimingDigest,
        timingIndexAudit,
        indexDigest: opened.summary.indexDigest,
        strictSdrProfile,
      }),
    }));
  }
  return Object.freeze({ decision, sources: Object.freeze(sources) });
}
