import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  PACKET_PTS_FAST_PATH_CONTRACT,
  scanMediaTiming,
  validateTimingPlan,
  verifyTimingPlanSource,
} from "./media_timing_plan_lib.mjs";
import {
  fingerprintFile,
  projectFile,
  projectRelativePath,
  verifyFingerprint,
} from "./media_source_map_lib.mjs";

export const MEDIA_TIMING_BUNDLE_KIND = "hyperframes-project-media-timing-bundle";
// Version 2 invalidates bundles produced by the former packet-count-only
// shortcut. Plans remain schema v1 because their runtime query shape did not
// change; the bundle is the persisted scanner-policy boundary.
export const MEDIA_TIMING_BUNDLE_SCHEMA_VERSION = 2;

function assertObject(value, name) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${name} must be an object`);
  }
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

function sha256Json(value) {
  return createHash("sha256").update(stableJson(value)).digest("hex");
}

function assertCurrentTimestampAudit(plan, source) {
  const timestampAudit = plan.probe?.timestampAudit;
  assertObject(timestampAudit, `timing plan ${source} timestamp audit`);
  if (timestampAudit.packetContract !== PACKET_PTS_FAST_PATH_CONTRACT) {
    throw new Error(
      `Timing source ${source} was produced by an obsolete packet timing policy; rebuild the bundle`,
    );
  }
  if (timestampAudit.selectedPath === "packet-pts") {
    if (!timestampAudit.packetMetadataEligible
        || timestampAudit.packetValidationError != null
        || !Array.isArray(timestampAudit.rejectionReasons)
        || timestampAudit.rejectionReasons.length
        || plan.probe.timestampSource !== "packet-pts-iso-bmff-access-unit-verified") {
      throw new Error(`Timing source ${source} has an unaudited packet-PTS fast path`);
    }
  } else if (timestampAudit.selectedPath === "decoded-frame-pts") {
    if (!String(plan.probe.timestampSource).startsWith("decoded-frame-pts-fallback:")
        || timestampAudit.decodedFrameCount !== plan.probe.presentationRows) {
      throw new Error(`Timing source ${source} has an incomplete decoded-frame timing audit`);
    }
  } else {
    throw new Error(`Timing source ${source} has unsupported timing path ${timestampAudit.selectedPath}`);
  }
}

function parseAttribute(tag, name) {
  const match = tag.match(new RegExp(`\\b${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, "i"));
  return match ? (match[1] ?? match[2] ?? match[3]) : null;
}

function decodeHtmlAttribute(value) {
  return value
    .replaceAll("&amp;", "&")
    .replaceAll("&quot;", "\"")
    .replaceAll("&#39;", "'")
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">");
}

function localSourceFromHtml({ source, projectRoot, entryPath }) {
  const decoded = decodeHtmlAttribute(source);
  const url = new URL(decoded, pathToFileURL(entryPath));
  if (url.protocol !== "file:") {
    throw new Error(`Timing bundles only support local file video sources, got ${url.href}`);
  }
  const absolutePath = fileURLToPath(url);
  return {
    source: projectRelativePath(projectRoot, absolutePath),
    absolutePath,
    htmlSource: decoded,
  };
}

export function findStaticVideoSources({ projectRoot, entryPath }) {
  const root = resolve(projectRoot);
  const entry = resolve(entryPath);
  const html = readFileSync(entry, "utf8");
  const found = new Map();
  const videoPattern = /<video\b([^>]*)>([\s\S]*?)<\/video\s*>|<video\b([^>]*)\/?\s*>/gi;
  for (const match of html.matchAll(videoPattern)) {
    const opening = `<video ${match[1] ?? match[3] ?? ""}>`;
    const directSource = parseAttribute(opening, "src");
    const candidates = directSource ? [directSource] : [];
    if (!directSource && match[2]) {
      for (const sourceTag of match[2].matchAll(/<source\b[^>]*>/gi)) {
        const nestedSource = parseAttribute(sourceTag[0], "src");
        if (nestedSource) candidates.push(nestedSource);
      }
    }
    for (const candidate of candidates) {
      const resolved = localSourceFromHtml({ source: candidate, projectRoot: root, entryPath: entry });
      found.set(resolved.source, resolved);
    }
  }
  return [...found.values()].sort((left, right) => left.source.localeCompare(right.source));
}

export function assertBrowserCurrentTimeCompatible(plan, description = "timing plan") {
  validateTimingPlan(plan);
  const issues = [];
  if (plan.timeline.presentationOriginTicks !== 0) {
    issues.push(`presentation origin ${plan.timeline.presentationOriginTicks}`);
  }
  if (plan.presentation.firstPtsTicks !== 0) {
    issues.push(`first presentation PTS ${plan.presentation.firstPtsTicks}`);
  }
  if (plan.stream.startPtsTicks !== 0) issues.push(`stream start PTS ${plan.stream.startPtsTicks}`);
  if (!Number.isFinite(plan.stream.startTimeSeconds) || Math.abs(plan.stream.startTimeSeconds) > 1e-9) {
    issues.push(`stream start time ${plan.stream.startTimeSeconds}`);
  }
  if (issues.length) {
    throw new Error(
      `${description} cannot use browser currentTime without a calibrated non-zero/edit-list mapping: `
      + issues.join("; "),
    );
  }
  return {
    compatible: true,
    liveCalibrationRequired: true,
    editListDetected: Boolean(plan.timeline.editList?.detected),
    policy: "zero-origin post-demux presentation PTS; renderer must verify rVFC mediaTime",
  };
}

export function validateMediaTimingBundle(bundle) {
  assertObject(bundle, "bundle");
  if (bundle.kind !== MEDIA_TIMING_BUNDLE_KIND) throw new Error(`Unsupported bundle kind: ${bundle.kind}`);
  if (bundle.schemaVersion !== MEDIA_TIMING_BUNDLE_SCHEMA_VERSION) {
    throw new Error(`Unsupported timing bundle schema: ${bundle.schemaVersion}`);
  }
  assertObject(bundle.project, "bundle.project");
  if (typeof bundle.project.entry !== "string" || !bundle.project.entry) {
    throw new Error("bundle.project.entry must be project-relative");
  }
  if (isAbsolute(bundle.project.entry)) throw new Error("bundle.project.entry must be project-relative");
  assertObject(bundle.project.entryFingerprint, "bundle.project.entryFingerprint");
  if (!Array.isArray(bundle.entries) || !bundle.entries.length) {
    throw new Error("Timing bundle must contain at least one video source");
  }
  const sources = new Set();
  for (const [index, entry] of bundle.entries.entries()) {
    assertObject(entry, `bundle.entries[${index}]`);
    if (typeof entry.source !== "string" || !entry.source || isAbsolute(entry.source)) {
      throw new Error(`bundle.entries[${index}].source must be project-relative`);
    }
    if (sources.has(entry.source)) throw new Error(`Duplicate timing source: ${entry.source}`);
    if (!Array.isArray(entry.roles) || !entry.roles.length) {
      throw new Error(`Timing source ${entry.source} must record at least one role`);
    }
    validateTimingPlan(entry.plan);
    assertCurrentTimestampAudit(entry.plan, entry.source);
    if (entry.planSha256 !== sha256Json(entry.plan)) {
      throw new Error(`Timing plan digest mismatch for ${entry.source}`);
    }
    assertBrowserCurrentTimeCompatible(entry.plan, entry.source);
    sources.add(entry.source);
  }
  return bundle;
}

export async function buildMediaTimingBundle({
  projectRoot,
  entryPath,
  extraSources = [],
  reuseEntries = [],
  ffprobePath = "ffprobe",
}) {
  const startedAtMs = Date.now();
  const root = resolve(projectRoot);
  const entry = resolve(entryPath);
  const compositionSources = findStaticVideoSources({ projectRoot: root, entryPath: entry });
  if (!compositionSources.length) throw new Error(`No static <video src> sources found in ${entry}`);
  const records = new Map(compositionSources.map((source) => [source.source, {
    ...source,
    roles: ["composition"],
    mapsFrom: [],
  }]));
  for (const extra of extraSources) {
    const absolutePath = resolve(extra.absolutePath);
    const source = projectRelativePath(root, absolutePath);
    const current = records.get(source) ?? { source, absolutePath, roles: [], mapsFrom: [] };
    if (!current.roles.includes(extra.role ?? "decoder-cache")) current.roles.push(extra.role ?? "decoder-cache");
    if (extra.mapsFrom && !current.mapsFrom.includes(extra.mapsFrom)) current.mapsFrom.push(extra.mapsFrom);
    records.set(source, current);
  }

  if (!Array.isArray(reuseEntries)) throw new Error("reuseEntries must be an array");
  const reusableBySource = new Map();
  for (const [index, reusable] of reuseEntries.entries()) {
    assertObject(reusable, `reuseEntries[${index}]`);
    if (typeof reusable.source !== "string" || !reusable.source || isAbsolute(reusable.source)) {
      throw new Error(`reuseEntries[${index}].source must be project-relative`);
    }
    if (reusableBySource.has(reusable.source)) {
      throw new Error(`Duplicate reusable timing source: ${reusable.source}`);
    }
    validateTimingPlan(reusable.plan);
    assertCurrentTimestampAudit(reusable.plan, reusable.source);
    if (reusable.planSha256 != null && reusable.planSha256 !== sha256Json(reusable.plan)) {
      throw new Error(`Reusable timing plan digest mismatch for ${reusable.source}`);
    }
    reusableBySource.set(reusable.source, reusable);
  }

  const entries = [];
  const reusedSources = [];
  const scannedSources = [];
  // Deliberately sequential: the audited ISO-BMFF AVC/HEVC packet path is
  // cheap, while the correctness fallback decodes show_frames and can be
  // large. Never buffer several decoded-frame scans at once.
  for (const record of [...records.values()].sort((left, right) => left.source.localeCompare(right.source))) {
    let plan = null;
    const reusable = reusableBySource.get(record.source);
    if (reusable) {
      const verification = await verifyTimingPlanSource(reusable.plan, record.absolutePath, { mode: "hash" });
      if (verification.valid) {
        plan = reusable.plan;
        reusedSources.push(record.source);
      }
    }
    if (!plan) {
      plan = await scanMediaTiming(record.absolutePath, { ffprobePath });
      scannedSources.push(record.source);
    }
    assertBrowserCurrentTimeCompatible(plan, record.source);
    entries.push({
      source: record.source,
      roles: record.roles.sort(),
      mapsFrom: record.mapsFrom.sort(),
      plan,
      planSha256: sha256Json(plan),
    });
  }
  return validateMediaTimingBundle({
    kind: MEDIA_TIMING_BUNDLE_KIND,
    schemaVersion: MEDIA_TIMING_BUNDLE_SCHEMA_VERSION,
    createdAt: new Date().toISOString(),
    project: {
      entry: projectRelativePath(root, entry),
      entryFingerprint: await fingerprintFile(entry),
    },
    policy: {
      target: "greatest presentation PTS less than or equal to raw media target",
      timestampOrder: "presentation PTS; B-frame decode order is ignored",
      browserCurrentTime: "zero-origin only plus live rVFC calibration",
      tail: "renderer must choose hold-last, transparent, or fail",
    },
    build: {
      elapsedMs: Date.now() - startedAtMs,
      sourceCount: entries.length,
      reusedSourceCount: reusedSources.length,
      scannedSourceCount: scannedSources.length,
      reusedSources,
      scannedSources,
    },
    entries,
  });
}

export async function loadAndVerifyMediaTimingBundle({
  manifestPath,
  projectRoot,
  entryPath,
  verifyMode = "stat",
  requiredDecoderSources = [],
  requiredDecoderMappings = [],
}) {
  verifyMode = verifyMode === "hash" ? "sha256" : verifyMode;
  if (!["stat", "sha256"].includes(verifyMode)) {
    throw new Error(`mediaTimingPlan verify mode must be stat or sha256, got ${verifyMode}`);
  }
  const root = resolve(projectRoot);
  const manifest = resolve(manifestPath);
  const bundle = validateMediaTimingBundle(JSON.parse(readFileSync(manifest, "utf8")));
  const entry = resolve(entryPath);
  const expectedEntry = projectFile(root, bundle.project.entry, "timing bundle entry");
  if (expectedEntry !== entry) {
    throw new Error(`Timing bundle entry ${expectedEntry} does not match render entry ${entry}`);
  }
  await verifyFingerprint(entry, bundle.project.entryFingerprint, verifyMode, "timing bundle entry HTML");

  const staticSources = findStaticVideoSources({ projectRoot: root, entryPath: entry });
  const expectedComposition = new Set(staticSources.map((source) => source.source));
  const bundledComposition = new Set(bundle.entries
    .filter((entryRecord) => entryRecord.roles.includes("composition"))
    .map((entryRecord) => entryRecord.source));
  const missingComposition = [...expectedComposition].filter((source) => !bundledComposition.has(source));
  const staleComposition = [...bundledComposition].filter((source) => !expectedComposition.has(source));
  if (missingComposition.length || staleComposition.length) {
    throw new Error(
      `Timing bundle composition source set changed; missing=${missingComposition.join(",") || "none"}; `
      + `stale=${staleComposition.join(",") || "none"}`,
    );
  }

  const entries = [];
  for (const entryRecord of bundle.entries) {
    const sourcePath = projectFile(root, entryRecord.source, `timing source ${entryRecord.source}`);
    const verification = await verifyTimingPlanSource(entryRecord.plan, sourcePath, {
      mode: verifyMode === "sha256" ? "hash" : "stat",
    });
    if (!verification.valid) {
      throw new Error(`Timing source ${entryRecord.source} failed ${verifyMode} verification: ${verification.reason}`);
    }
    entries.push({
      source: entryRecord.source,
      sourcePath,
      sourceUrl: pathToFileURL(sourcePath).href,
      roles: entryRecord.roles,
      mapsFrom: entryRecord.mapsFrom,
      plan: entryRecord.plan,
      compatibility: assertBrowserCurrentTimeCompatible(entryRecord.plan, entryRecord.source),
    });
  }
  const bySource = new Map(entries.map((entryRecord) => [entryRecord.source, entryRecord]));
  const requiredSources = [
    ...requiredDecoderSources,
    ...requiredDecoderMappings.map((mapping) => mapping.cache),
  ];
  const missingDecoderPlans = requiredSources.filter((source) => !bySource.has(source));
  if (missingDecoderPlans.length) {
    throw new Error(
      `Timing bundle has no plan for mapped decoder source(s): ${missingDecoderPlans.join(", ")}. `
      + "Regenerate it with the same mediaSourceMap.",
    );
  }
  for (const mapping of requiredDecoderMappings) {
    const decoderEntry = bySource.get(mapping.cache);
    if (!decoderEntry.roles.includes("decoder-cache") || !decoderEntry.mapsFrom.includes(mapping.source)) {
      throw new Error(
        `Timing decoder plan ${mapping.cache} is not recorded as a cache mapped from ${mapping.source}. `
        + "Regenerate the timing bundle with the current mediaSourceMap.",
      );
    }
  }
  return {
    path: manifest,
    verifyMode,
    bundle,
    entries,
  };
}
