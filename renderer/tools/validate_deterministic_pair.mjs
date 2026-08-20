#!/usr/bin/env node

import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { basename, relative, resolve, sep } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

const DEFAULT_SSIM_MIN = 0.999;
const DEFAULT_PSNR_MIN_DB = 55;

const SEMANTIC_CONFIG_KEYS = [
  "width",
  "height",
  "fps",
  "frames",
  "startFrame",
  "start",
  "compositeMode",
  "outputBackend",
  "mediaFrameMode",
  "mediaTargetMode",
  "mediaTailPolicy",
  "mediaSeekBiasFrames",
  "mediaAdvanceMode",
  "mediaPlaybackRate",
  "mediaDecoderLanesTotal",
  "mediaDecoderLanesPerSource",
  "waitMode",
  "screenshotWindowMode",
  "screenshotMediaPolicyRequested",
  "screenshotMediaPolicy",
  "screenshotMediaRequestGate",
  "mediaTimingPlanVerify",
  "mediaSourceMapVerify",
  "mediaSourceMapRecipeKey",
  "directMux",
  "mixProjectAudio",
  "audioCodec",
  "audioSampleRate",
  "allowAudioCodecPadding",
];

function usage() {
  return `
Validate two completed MOV renders as the same deterministic render job.

Usage:
  node tools/validate_deterministic_pair.mjs --a=first.mov --b=second.mov [options]

Inputs and identity:
  --metrics-a=PATH       Default: <a>.metrics.json
  --metrics-b=PATH       Default: <b>.metrics.json
  --output-dir=PATH      Default: <a>.vs-<b>.determinism

Visual gates:
  --ssim-min=0.999       Minimum SSIM of every decoded frame
  --psnr-min=55          Minimum PSNR (dB) of every decoded frame

Runtime:
  --ffmpeg=ffmpeg
  --ffprobe=ffprobe
  --require-pcm=true     Require PCM when the render contains audio

The gate is deliberately not bit-exact. Raw PNG or pixel hashes may differ
between GPU/driver paths because of legal rounding differences. Render/job
identity, every video PTS, frame count, and decoded PCM duration remain exact.
`;
}

export function parseArgs(argv) {
  const result = {};
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith("--")) throw new Error(`Unexpected argument: ${token}`);
    const separator = token.indexOf("=");
    if (separator >= 0) result[token.slice(2, separator)] = token.slice(separator + 1);
    else {
      const key = token.slice(2);
      const next = argv[index + 1];
      if (next && !next.startsWith("--")) {
        result[key] = next;
        index += 1;
      } else result[key] = "true";
    }
  }
  return result;
}

function numberArg(args, key, fallback, { minimum = -Infinity, maximum = Infinity } = {}) {
  const value = Number(args[key] ?? fallback);
  if (!Number.isFinite(value) || value < minimum || value > maximum) {
    throw new Error(`Invalid --${key}: ${args[key]}`);
  }
  return value;
}

function booleanArg(args, key, fallback) {
  if (!(key in args)) return fallback;
  const value = String(args[key]).toLowerCase();
  if (["true", "1", "yes"].includes(value)) return true;
  if (["false", "0", "no"].includes(value)) return false;
  throw new Error(`Invalid --${key}: ${args[key]}`);
}

function run(command, args, { cwd } = {}) {
  return new Promise((resolveRun, rejectRun) => {
    const child = spawn(command, args, {
      cwd,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.once("error", rejectRun);
    child.once("close", (code, signal) => {
      if (code === 0) resolveRun({ stdout, stderr, code });
      else rejectRun(Object.assign(
        new Error(`${command} exited ${code ?? signal}: ${stderr.trim().slice(-4_000)}`),
        { command, args, stdout, stderr, code, signal },
      ));
    });
  });
}

function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stableValue(value[key])]));
  }
  return value;
}

function digest(value) {
  return createHash("sha256").update(JSON.stringify(stableValue(value))).digest("hex");
}

function firstDefined(...values) {
  return values.find((value) => value !== undefined && value !== null && value !== "");
}

function relativeEntry(config) {
  if (!config?.entry) return null;
  if (!config?.projectRoot) return String(config.entry).split(/[\\/]/).at(-1);
  const root = String(config.projectRoot).replaceAll("\\", "/").replace(/\/+$/, "");
  const entry = String(config.entry).replaceAll("\\", "/");
  return entry.startsWith(`${root}/`) ? entry.slice(root.length + 1) : entry.split("/").at(-1);
}

function relativeScript(config, script) {
  const root = String(config?.projectRoot ?? "").replaceAll("\\", "/").replace(/\/+$/, "");
  const value = String(script).replaceAll("\\", "/");
  return root && value.startsWith(`${root}/`) ? value.slice(root.length + 1) : value.split("/").at(-1);
}

function compactEntryAudit(config) {
  const audit = config?.screenshotEntryTransform ?? config?.proxyTreeTransform ?? null;
  if (!audit) return null;
  const bounded = audit.boundedStatic ?? {};
  return {
    kind: audit.kind ?? null,
    schemaVersion: audit.schemaVersion ?? null,
    policy: audit.policy ?? null,
    domMutations: audit.domMutations ?? null,
    videos: (audit.videos ?? []).map((item) => ({
      id: item.id ?? null,
      source: item.source ?? null,
      authoredPreload: item.authoredPreload ?? null,
    })),
    media: (bounded.media ?? []).map((item) => ({
      tagName: item.tagName ?? null,
      id: item.id ?? null,
      sources: item.sources ?? [],
    })),
    scannedScripts: (bounded.scannedScripts ?? []).map((item) => relativeScript(config, item)),
    blockers: bounded.blockers ?? audit.blockers ?? [],
  };
}

function normalizedTimingPlans(metrics) {
  const plans = metrics?.config?.mediaTimingPlans
    ?? metrics?.support?.mediaTimingPlan?.entries
    ?? metrics?.renderer?.support?.mediaTimingPlan?.entries
    ?? [];
  return [...plans].map((plan) => stableValue(plan)).sort((a, b) => String(a.source).localeCompare(String(b.source)));
}

function explicitIdentity(metrics, name) {
  const title = `${name[0].toUpperCase()}${name.slice(1)}`;
  return firstDefined(
    metrics?.renderIdentity?.[name],
    metrics?.identities?.[name],
    metrics?.config?.[`${name}Identity`],
    metrics?.config?.[`${name}Signature`],
    metrics?.[`${name}Identity`],
    metrics?.[`${name}Signature`],
    metrics?.support?.[`${name}Identity`],
    metrics?.support?.[`render${title}Identity`],
  );
}

export function deriveRenderIdentities(metrics) {
  const config = metrics?.config ?? {};
  const timingPlans = normalizedTimingPlans(metrics);
  const assets = timingPlans.map((plan) => ({
    source: plan.source ?? null,
    sourceIdentity: plan.sourceIdentity ?? null,
    mapsFrom: plan.mapsFrom ?? [],
    roles: plan.roles ?? [],
  }));
  const entryAudit = compactEntryAudit(config);
  const derived = {
    project: digest({
      projectName: String(config.projectRoot ?? "").replaceAll("\\", "/").split("/").filter(Boolean).at(-1) ?? null,
      entry: relativeEntry(config),
      entryAudit,
    }),
    entry: digest({ entry: relativeEntry(config), entryAudit }),
    assets: digest(assets),
    timingBundle: digest(timingPlans),
  };
  const evidence = {
    project: Boolean(config.projectRoot && config.entry && entryAudit),
    entry: Boolean(config.entry && entryAudit),
    assets: timingPlans.length === 0
      ? false
      : timingPlans.every((plan) => plan.source && plan.sourceIdentity),
    timingBundle: timingPlans.length > 0,
  };
  return Object.fromEntries(Object.entries(derived).map(([name, value]) => {
    const explicit = explicitIdentity(metrics, name);
    return [name, {
      value: explicit ?? value,
      provenance: explicit ? "explicit" : "derived-from-adjacent-metrics",
      evidenceComplete: Boolean(explicit) || evidence[name],
    }];
  }));
}

function ratio(value, field) {
  const match = String(value ?? "").match(/^(-?\d+)(?:\/(\d+))?$/);
  if (!match || BigInt(match[2] ?? 1) === 0n) throw new Error(`Invalid ${field}: ${value}`);
  return { numerator: BigInt(match[1]), denominator: BigInt(match[2] ?? 1) };
}

function numericRatio(value, field) {
  const parsed = ratio(value, field);
  return Number(parsed.numerator) / Number(parsed.denominator);
}

function jsonEqual(a, b) {
  return JSON.stringify(stableValue(a)) === JSON.stringify(stableValue(b));
}

function addCheck(report, name, expected, actual, pass, category = "contract") {
  report.checks.push({ name, expected, actual, pass: Boolean(pass), category });
  if (!pass) report.errors.push(`${name}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}

function loadMetrics(path) {
  if (!existsSync(path)) throw new Error(`Metrics file does not exist: ${path}`);
  return JSON.parse(readFileSync(path, "utf8"));
}

function validateCompletion(report, label, metrics, movPath) {
  addCheck(report, `${label}.failure`, null, metrics.failure ?? null, metrics.failure == null, "completion");
  const completed = metrics?.renderer?.framesCompleted;
  const frames = metrics?.config?.frames;
  addCheck(report, `${label}.framesCompleted`, frames, completed, completed === frames, "completion");
  addCheck(
    report,
    `${label}.metricsOutputBasename`,
    basename(movPath),
    basename(metrics?.config?.output ?? ""),
    basename(metrics?.config?.output ?? "") === basename(movPath),
    "completion",
  );
  if (metrics?.probe?.format?.size != null) {
    const actualSize = statSync(movPath).size;
    addCheck(
      report,
      `${label}.metricsFileSize`,
      Number(metrics.probe.format.size),
      actualSize,
      Number(metrics.probe.format.size) === actualSize,
      "completion",
    );
  }
  if (metrics?.screenshotSequence) {
    addCheck(
      report,
      `${label}.screenshotSequence.capturedFrames`,
      frames,
      metrics.screenshotSequence.capturedFrames,
      metrics.screenshotSequence.capturedFrames === frames,
      "completion",
    );
  }
  if (metrics?.outputCommit) {
    addCheck(
      report,
      `${label}.outputCommit.committed`,
      true,
      metrics.outputCommit.committed,
      metrics.outputCommit.committed === true,
      "completion",
    );
  }
}

async function probe(path, ffprobe) {
  const result = await run(ffprobe, [
    "-v", "error",
    "-show_entries",
    [
      "stream=index,codec_type,codec_name,pix_fmt,width,height,r_frame_rate,avg_frame_rate,time_base,start_time,sample_rate,channels,channel_layout,duration_ts,nb_frames",
      "frame=media_type,stream_index,pts,best_effort_timestamp,pkt_duration,duration,nb_samples",
      "format=start_time,duration,size",
    ].join(":"),
    "-of", "json",
    path,
  ]);
  return JSON.parse(result.stdout);
}

function inspectVideoTimeline(report, label, probeResult, config) {
  const stream = probeResult.streams?.find((item) => item.codec_type === "video");
  if (!stream) {
    addCheck(report, `${label}.videoStream`, "present", "missing", false, "timeline");
    return null;
  }
  const frames = (probeResult.frames ?? []).filter((item) => item.media_type === "video");
  addCheck(report, `${label}.video.width`, config.width, stream.width, stream.width === config.width, "timeline");
  addCheck(report, `${label}.video.height`, config.height, stream.height, stream.height === config.height, "timeline");
  addCheck(report, `${label}.video.frameCount`, config.frames, frames.length, frames.length === config.frames, "timeline");
  const avgFps = numericRatio(stream.avg_frame_rate, `${label} avg_frame_rate`);
  const nominalFps = numericRatio(stream.r_frame_rate, `${label} r_frame_rate`);
  addCheck(report, `${label}.video.avgFps`, config.fps, avgFps, avgFps === config.fps, "timeline");
  addCheck(report, `${label}.video.nominalFps`, config.fps, nominalFps, nominalFps === config.fps, "timeline");

  const timeBase = ratio(stream.time_base, `${label} video time_base`);
  const fps = ratio(String(config.fps), `${label} config fps`);
  let exact = frames.length === config.frames;
  let firstFailure = null;
  const pts = [];
  for (let index = 0; index < frames.length; index += 1) {
    const raw = firstDefined(frames[index].best_effort_timestamp, frames[index].pts);
    if (raw == null || !/^-?\d+$/.test(String(raw))) {
      exact = false;
      firstFailure ??= { index, reason: "missing/integer PTS", actual: raw };
      continue;
    }
    const tick = BigInt(raw);
    pts.push(String(tick));
    const left = tick * timeBase.numerator * fps.numerator;
    const right = BigInt(index) * fps.denominator * timeBase.denominator;
    if (left !== right) {
      exact = false;
      firstFailure ??= { index, reason: "off exact CFR grid", actual: String(tick) };
    }
  }
  addCheck(
    report,
    `${label}.video.exactPtsGrid`,
    `PTS(n) = n/${config.fps}, starting at zero`,
    firstFailure ?? "exact",
    exact,
    "timeline",
  );
  return { stream, frames, pts };
}

function inspectAudioTimeline(report, label, probeResult, config, metrics, requirePcm) {
  const stream = probeResult.streams?.find((item) => item.codec_type === "audio");
  const expectsAudio = config.mixProjectAudio === true || config.audioCodec != null;
  if (!stream) {
    addCheck(report, `${label}.audioStream`, expectsAudio ? "present" : "absent", "absent", !expectsAudio, "audio");
    return null;
  }
  const expectedCodec = config.audioCodec ?? (requirePcm ? "pcm_*" : "any");
  const codecOkay = config.audioCodec
    ? stream.codec_name === config.audioCodec
    : (!requirePcm || String(stream.codec_name).startsWith("pcm_"));
  addCheck(report, `${label}.audio.codec`, expectedCodec, stream.codec_name, codecOkay, "audio");
  const sampleRate = Number(stream.sample_rate);
  addCheck(report, `${label}.audio.sampleRate`, config.audioSampleRate, sampleRate, sampleRate === config.audioSampleRate, "audio");
  const audioFrames = (probeResult.frames ?? []).filter((item) => item.media_type === "audio");
  const timeBase = ratio(stream.time_base, `${label} audio time_base`);
  let samples = 0n;
  let contiguous = true;
  let firstFailure = null;
  for (const [index, frame] of audioFrames.entries()) {
    const frameSamples = Number(frame.nb_samples);
    const rawPts = firstDefined(frame.best_effort_timestamp, frame.pts);
    if (!Number.isInteger(frameSamples) || frameSamples <= 0 || rawPts == null || !/^-?\d+$/.test(String(rawPts))) {
      contiguous = false;
      firstFailure ??= { index, reason: "missing PTS or nb_samples", pts: rawPts, nbSamples: frame.nb_samples };
      continue;
    }
    const tick = BigInt(rawPts);
    const left = tick * timeBase.numerator * BigInt(sampleRate);
    const right = samples * timeBase.denominator;
    if (left !== right) {
      contiguous = false;
      firstFailure ??= { index, reason: "audio gap/overlap", pts: String(tick), expectedSample: String(samples) };
    }
    samples += BigInt(frameSamples);
  }
  const fps = ratio(String(config.fps), `${label} config fps`);
  const expectedNumerator = BigInt(config.frames) * BigInt(sampleRate) * fps.denominator;
  const expectedInteger = expectedNumerator % fps.numerator === 0n;
  const expectedSamples = expectedInteger ? expectedNumerator / fps.numerator : null;
  addCheck(report, `${label}.audio.contiguousPts`, "zero-origin, no gap/overlap", firstFailure ?? "exact", contiguous, "audio");
  addCheck(
    report,
    `${label}.audio.decodedSamplesPerChannel`,
    expectedSamples == null ? "integer frame-grid duration" : Number(expectedSamples),
    Number(samples),
    expectedSamples != null && samples === expectedSamples,
    "audio",
  );
  addCheck(
    report,
    `${label}.metrics.decodedAudio.samplesPerChannel`,
    Number(samples),
    metrics?.decodedAudio?.samplesPerChannel,
    metrics?.decodedAudio?.samplesPerChannel === Number(samples),
    "audio",
  );
  if (metrics?.decodedAudio?.frameCount != null) {
    addCheck(
      report,
      `${label}.metrics.decodedAudio.frameCount`,
      audioFrames.length,
      metrics.decodedAudio.frameCount,
      metrics.decodedAudio.frameCount === audioFrames.length,
      "audio",
    );
  }
  return { stream, samplesPerChannel: Number(samples), packetFrames: audioFrames.length };
}

function parseSsim(path) {
  return readFileSync(path, "utf8").trim().split(/\r?\n/).filter(Boolean).map((line, index) => {
    const match = line.match(/\bn:(\d+).*\bAll:([0-9.]+)/);
    if (!match) throw new Error(`Could not parse SSIM line ${index + 1}: ${line}`);
    return { frame: Number(match[1]) - 1, value: Number(match[2]) };
  });
}

function parsePsnr(path) {
  return readFileSync(path, "utf8").trim().split(/\r?\n/).filter(Boolean).map((line, index) => {
    const match = line.match(/\bn:(\d+).*\bpsnr_avg:([^ ]+)/);
    if (!match) throw new Error(`Could not parse PSNR line ${index + 1}: ${line}`);
    const raw = match[2];
    const value = raw === "inf" ? Infinity : Number(raw);
    if (!Number.isFinite(value) && value !== Infinity) throw new Error(`Invalid PSNR line ${index + 1}: ${line}`);
    return { frame: Number(match[1]) - 1, value };
  });
}

function finiteSummary(values) {
  return {
    minimum: Math.min(...values),
    average: values.reduce((sum, value) => sum + value, 0) / values.length,
    maximum: Math.max(...values),
  };
}

async function compareVisuals(a, b, { ffmpeg, frames, tempDir, ssimMin, psnrMin }) {
  const ssimPath = resolve(tempDir, "frames.ssim.log");
  const psnrPath = resolve(tempDir, "frames.psnr.log");
  await run(ffmpeg, [
    "-hide_banner", "-loglevel", "warning", "-nostdin",
    "-i", a,
    "-i", b,
    "-filter_complex",
    `[0:v:0]settb=AVTB,setpts=PTS-STARTPTS,split=2[a1][a2];`
      + `[1:v:0]settb=AVTB,setpts=PTS-STARTPTS,split=2[b1][b2];`
      + `[a1][b1]ssim=stats_file=${basename(ssimPath)}[ssimout];`
      + `[a2][b2]psnr=stats_file=${basename(psnrPath)}[psnrout]`,
    "-map", "[ssimout]", "-map", "[psnrout]",
    "-frames:v", String(frames),
    "-an", "-sn", "-dn", "-f", "null", "-",
  ], { cwd: tempDir });
  const ssim = parseSsim(ssimPath);
  const psnr = parsePsnr(psnrPath);
  if (ssim.length !== frames || psnr.length !== frames) {
    throw new Error(`Visual metric frame count mismatch: SSIM=${ssim.length}, PSNR=${psnr.length}, expected=${frames}`);
  }
  const perFrame = ssim.map((item, index) => {
    const psnrItem = psnr[index];
    if (item.frame !== index || psnrItem.frame !== index) {
      throw new Error(`Visual metric index mismatch at ${index}: SSIM=${item.frame}, PSNR=${psnrItem.frame}`);
    }
    return {
      frame: index,
      ssim: item.value,
      psnrDb: psnrItem.value === Infinity ? "Infinity" : psnrItem.value,
      pass: item.value >= ssimMin && psnrItem.value >= psnrMin,
    };
  });
  const psnrNumeric = psnr.map((item) => item.value);
  return {
    thresholds: { ssimMinimum: ssimMin, psnrMinimumDb: psnrMin },
    frameCount: frames,
    ssim: finiteSummary(ssim.map((item) => item.value)),
    psnrDb: finiteSummary(psnrNumeric),
    failingFrames: perFrame.filter((item) => !item.pass),
    perFrame,
  };
}

function markdownValue(value) {
  if (value === Infinity) return "Infinity";
  if (typeof value === "number") return Number.isInteger(value) ? String(value) : value.toFixed(6);
  if (typeof value === "string") return value;
  return `\`${JSON.stringify(value)}\``;
}

function linkFrom(reportDir, path) {
  return relative(reportDir, path).split(sep).join("/");
}

function renderMarkdown(report) {
  const lines = [
    "# Deterministic render pair gate",
    "",
    `- Result: **${report.ok ? "PASS" : "FAIL"}**`,
    `- A: \`${report.inputs.a}\``,
    `- B: \`${report.inputs.b}\``,
    `- Created: ${report.createdAt}`,
    "",
    "> Raw PNG/pixel hashes are evidence, not the sole gate. Different GPU and driver paths may make legal rounding choices. Render identity and all timing checks remain exact; every decoded frame must still pass SSIM and PSNR.",
    "",
    "## Identity and exact contract",
    "",
    "| Check | Expected | Actual | Result |",
    "|---|---|---|:---:|",
  ];
  for (const check of report.checks) {
    lines.push(`| ${check.name.replaceAll("|", "\\|")} | ${markdownValue(check.expected).replaceAll("|", "\\|")} | ${markdownValue(check.actual).replaceAll("|", "\\|")} | ${check.pass ? "PASS" : "FAIL"} |`);
  }
  lines.push("", "## Per-frame visual equivalence", "");
  if (report.visual) {
    lines.push(
      `- Thresholds: SSIM >= ${report.visual.thresholds.ssimMinimum}; PSNR >= ${report.visual.thresholds.psnrMinimumDb} dB on every frame`,
      `- SSIM: min ${report.visual.ssim.minimum.toFixed(6)}, average ${report.visual.ssim.average.toFixed(6)}`,
      `- PSNR: min ${markdownValue(report.visual.psnrDb.minimum)} dB, average ${markdownValue(report.visual.psnrDb.average)} dB`,
      `- Failing frames: ${report.visual.failingFrames.length}`,
      "",
      "| Frame | SSIM | PSNR dB | Result |",
      "|---:|---:|---:|:---:|",
    );
    for (const frame of report.visual.perFrame) {
      lines.push(`| ${frame.frame} | ${frame.ssim.toFixed(6)} | ${markdownValue(frame.psnrDb)} | ${frame.pass ? "PASS" : "FAIL"} |`);
    }
  } else lines.push("Visual comparison was not run because an exact precondition failed.");
  lines.push("", "## Raw capture hash evidence", "");
  lines.push(
    `- A sequence SHA-256: \`${report.rawCaptureHashes.a ?? "not recorded"}\``,
    `- B sequence SHA-256: \`${report.rawCaptureHashes.b ?? "not recorded"}\``,
    `- Equal: **${report.rawCaptureHashes.equal ? "yes" : "no"}** (informational only)`,
  );
  if (report.errors.length) {
    lines.push("", "## Failures", "");
    for (const error of report.errors) lines.push(`- ${error}`);
  }
  if (report.warnings.length) {
    lines.push("", "## Warnings", "");
    for (const warning of report.warnings) lines.push(`- ${warning}`);
  }
  lines.push("", `Machine-readable report: [report.json](${linkFrom(report.outputDir, report.reportJson)})`, "");
  return lines.join("\n");
}

export async function validateDeterministicPair(options) {
  const a = resolve(options.a);
  const b = resolve(options.b);
  const metricsAPath = resolve(options.metricsA ?? `${a}.metrics.json`);
  const metricsBPath = resolve(options.metricsB ?? `${b}.metrics.json`);
  for (const path of [a, b]) if (!existsSync(path)) throw new Error(`MOV does not exist: ${path}`);
  const metricsA = loadMetrics(metricsAPath);
  const metricsB = loadMetrics(metricsBPath);
  const outputDir = resolve(options.outputDir);
  mkdirSync(outputDir, { recursive: true });
  const report = {
    kind: "hyperframes-deterministic-render-pair-gate",
    schemaVersion: 1,
    createdAt: new Date().toISOString(),
    ok: false,
    inputs: { a, b, metricsA: metricsAPath, metricsB: metricsBPath },
    outputDir,
    checks: [],
    errors: [],
    warnings: [],
    identities: {},
    timelines: {},
    audio: {},
    visual: null,
    rawCaptureHashes: {
      a: metricsA?.screenshotSequence?.frameHashSequence?.sequenceSha256 ?? null,
      b: metricsB?.screenshotSequence?.frameHashSequence?.sequenceSha256 ?? null,
      equal: false,
      gate: false,
    },
  };
  report.rawCaptureHashes.equal = Boolean(report.rawCaptureHashes.a)
    && report.rawCaptureHashes.a === report.rawCaptureHashes.b;

  validateCompletion(report, "A", metricsA, a);
  validateCompletion(report, "B", metricsB, b);

  const identitiesA = deriveRenderIdentities(metricsA);
  const identitiesB = deriveRenderIdentities(metricsB);
  report.identities = { a: identitiesA, b: identitiesB };
  for (const name of ["project", "entry", "assets", "timingBundle"]) {
    addCheck(
      report,
      `identity.${name}.evidence`,
      "explicit identity or complete derivation inputs",
      `${identitiesA[name].provenance}/${identitiesB[name].provenance}`,
      identitiesA[name].evidenceComplete && identitiesB[name].evidenceComplete,
      "identity",
    );
    addCheck(
      report,
      `identity.${name}`,
      identitiesA[name].value,
      identitiesB[name].value,
      identitiesA[name].value === identitiesB[name].value,
      "identity",
    );
    if (identitiesA[name].provenance !== "explicit" || identitiesB[name].provenance !== "explicit") {
      report.warnings.push(`${name} identity was derived from adjacent metrics; future renderers should record an explicit content identity.`);
    }
  }

  const configA = metricsA.config ?? {};
  const configB = metricsB.config ?? {};
  for (const key of SEMANTIC_CONFIG_KEYS) {
    const aValue = configA[key];
    const bValue = configB[key];
    if (aValue === undefined && bValue === undefined) continue;
    addCheck(report, `config.${key}`, aValue, bValue, jsonEqual(aValue, bValue), "contract");
  }
  for (const [name, value] of Object.entries({ width: configA.width, height: configA.height, fps: configA.fps, frames: configA.frames, startFrame: configA.startFrame })) {
    const valid = Number.isInteger(value) && value > (name === "startFrame" ? -1 : 0);
    addCheck(report, `config.A.${name}.valid`, name === "startFrame" ? "integer >= 0" : "integer > 0", value, valid, "contract");
  }
  const exactStart = Number.isInteger(configA.startFrame)
    && Number.isInteger(configA.fps)
    && configA.startFrame / configA.fps === configA.start;
  addCheck(report, "config.A.startIdentity", "start = startFrame/fps", configA.start, exactStart, "timeline");
  for (const [label, metrics, config] of [["A", metricsA, configA], ["B", metricsB, configB]]) {
    const rendererBackend = metrics?.support?.outputBackend ?? metrics?.renderer?.support?.outputBackend;
    addCheck(
      report,
      `${label}.renderer.outputBackend`,
      config.outputBackend,
      rendererBackend,
      rendererBackend === config.outputBackend,
      "contract",
    );
  }

  const [probeA, probeB] = await Promise.all([
    probe(a, options.ffprobe),
    probe(b, options.ffprobe),
  ]);
  const timelineA = inspectVideoTimeline(report, "A", probeA, configA);
  const timelineB = inspectVideoTimeline(report, "B", probeB, configB);
  report.timelines = {
    a: timelineA ? { timeBase: timelineA.stream.time_base, frames: timelineA.frames.length } : null,
    b: timelineB ? { timeBase: timelineB.stream.time_base, frames: timelineB.frames.length } : null,
  };
  if (timelineA && timelineB) {
    addCheck(report, "video.codec", timelineA.stream.codec_name, timelineB.stream.codec_name, timelineA.stream.codec_name === timelineB.stream.codec_name, "visual");
    addCheck(report, "video.pixelFormat", timelineA.stream.pix_fmt, timelineB.stream.pix_fmt, timelineA.stream.pix_fmt === timelineB.stream.pix_fmt, "visual");
  }
  const audioA = inspectAudioTimeline(report, "A", probeA, configA, metricsA, options.requirePcm);
  const audioB = inspectAudioTimeline(report, "B", probeB, configB, metricsB, options.requirePcm);
  report.audio = { a: audioA, b: audioB };
  addCheck(
    report,
    "audio.presence",
    Boolean(audioA),
    Boolean(audioB),
    Boolean(audioA) === Boolean(audioB),
    "audio",
  );
  if (audioA && audioB) {
    addCheck(report, "audio.codec", audioA.stream.codec_name, audioB.stream.codec_name, audioA.stream.codec_name === audioB.stream.codec_name, "audio");
    addCheck(report, "audio.channels", audioA.stream.channels, audioB.stream.channels, audioA.stream.channels === audioB.stream.channels, "audio");
    addCheck(
      report,
      "audio.samplesPerChannel",
      audioA.samplesPerChannel,
      audioB.samplesPerChannel,
      audioA.samplesPerChannel === audioB.samplesPerChannel,
      "audio",
    );
  }

  const exactPreconditionsOkay = report.checks
    .filter((check) => check.category !== "visual")
    .every((check) => check.pass);
  if (exactPreconditionsOkay) {
    const tempDir = mkdtempSync(resolve(tmpdir(), "hf-deterministic-pair-"));
    try {
      report.visual = await compareVisuals(a, b, {
        ffmpeg: options.ffmpeg,
        frames: configA.frames,
        tempDir,
        ssimMin: options.ssimMin,
        psnrMin: options.psnrMin,
      });
      addCheck(
        report,
        "visual.everyFrameThreshold",
        `SSIM >= ${options.ssimMin} and PSNR >= ${options.psnrMin} dB`,
        `${report.visual.failingFrames.length} failing frame(s)`,
        report.visual.failingFrames.length === 0,
        "visual",
      );
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  } else {
    report.warnings.push("Visual comparison skipped because an exact identity/timeline/audio precondition failed.");
  }

  report.ok = report.checks.every((check) => check.pass) && report.visual != null;
  report.reportJson = resolve(outputDir, "report.json");
  report.reportMarkdown = resolve(outputDir, "report.md");
  writeFileSync(report.reportJson, `${JSON.stringify(report, (_key, value) => value === Infinity ? "Infinity" : value, 2)}\n`);
  writeFileSync(report.reportMarkdown, renderMarkdown(report));
  return report;
}

export async function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  if (args.help === "true" || args.h === "true") {
    process.stdout.write(usage());
    return 0;
  }
  if (!args.a || !args.b) throw new Error("Both --a and --b are required.\n" + usage());
  const a = resolve(args.a);
  const b = resolve(args.b);
  const outputDir = resolve(args["output-dir"] ?? `${a}.vs-${basename(b)}.determinism`);
  const report = await validateDeterministicPair({
    a,
    b,
    metricsA: args["metrics-a"],
    metricsB: args["metrics-b"],
    outputDir,
    ffmpeg: args.ffmpeg ?? "ffmpeg",
    ffprobe: args.ffprobe ?? "ffprobe",
    requirePcm: booleanArg(args, "require-pcm", true),
    ssimMin: numberArg(args, "ssim-min", DEFAULT_SSIM_MIN, { minimum: 0, maximum: 1 }),
    psnrMin: numberArg(args, "psnr-min", DEFAULT_PSNR_MIN_DB, { minimum: 0 }),
  });
  process.stdout.write(`${JSON.stringify({
    ok: report.ok,
    reportJson: report.reportJson,
    reportMarkdown: report.reportMarkdown,
    visual: report.visual ? {
      minimumSsim: report.visual.ssim.minimum,
      minimumPsnrDb: report.visual.psnrDb.minimum,
      failingFrames: report.visual.failingFrames.length,
    } : null,
    errors: report.errors,
  }, null, 2)}\n`);
  return report.ok ? 0 : 1;
}

const isCli = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isCli) {
  main().then((code) => { process.exitCode = code; }).catch((error) => {
    process.stderr.write(`${error.stack ?? error.message}\n`);
    process.exitCode = 2;
  });
}
