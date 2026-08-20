#!/usr/bin/env node

import { createHash, randomUUID } from "node:crypto";
import {
  createReadStream,
  existsSync,
  readFileSync,
  readdirSync,
  renameSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, relative, resolve, sep } from "node:path";
import { buildFullAudioOracleContract } from "./validate_final_mov.mjs";

const KIND = "hyperframes-golden-clip-manifest";
const SCHEMA_VERSION = 2;
const SHA256_PATTERN = /^(?:sha256:)?[a-f0-9]{64}$/i;

function parseArgs(argv) {
  const result = { extraClip: [] };
  for (const token of argv) {
    if (!token.startsWith("--")) throw new Error(`Unexpected argument: ${token}`);
    const split = token.indexOf("=");
    const key = split < 0 ? token.slice(2) : token.slice(2, split);
    const value = split < 0 ? "true" : token.slice(split + 1);
    if (key === "extra-clip") result.extraClip.push(value);
    else result[key] = value;
  }
  return result;
}

function canonicalSha256(value, name) {
  const text = String(value ?? "").toLowerCase();
  if (!SHA256_PATTERN.test(text)) throw new Error(`${name} must be a SHA-256 identity`);
  return text.startsWith("sha256:") ? text : `sha256:${text}`;
}

function readJson(path, name) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    throw new Error(`${name} is unreadable: ${error.message}`);
  }
}

function hashFile(path) {
  return new Promise((resolveHash, rejectHash) => {
    const hash = createHash("sha256");
    const input = createReadStream(path);
    input.on("data", (chunk) => hash.update(chunk));
    input.once("error", rejectHash);
    input.once("end", () => resolveHash(`sha256:${hash.digest("hex")}`));
  });
}

function portableRelative(from, to) {
  return relative(from, to).split(sep).join("/");
}

function discoverOneFrameClips(directory) {
  if (!existsSync(directory) || !statSync(directory).isDirectory()) {
    throw new Error(`--discover-dir is not a directory: ${directory}`);
  }
  const clips = [];
  for (const name of readdirSync(directory).sort()) {
    const match = /^frame-(\d+)\.mov$/.exec(name);
    if (!match) continue;
    clips.push({
      id: `reference-oracle-frame-${match[1]}`,
      moviePath: resolve(directory, name),
      metricsPath: resolve(directory, `${name}.metrics.json`),
      globalStartFrame: Number(match[1]),
      frameCount: 1,
      legacyMetricsApproved: false,
    });
  }
  return clips;
}

function clipsFromBaseManifest(manifestPath) {
  const manifest = readJson(manifestPath, "base golden manifest");
  if (manifest.kind !== KIND || ![1, 2].includes(manifest.schemaVersion) || !Array.isArray(manifest.clips)) {
    throw new Error("--base-manifest must be a schema v1/v2 HyperFrames golden clip manifest");
  }
  const baseDirectory = dirname(manifestPath);
  return {
    manifest,
    clips: manifest.clips.map((clip, index) => {
      if (typeof clip?.id !== "string" || !clip.id
          || typeof clip.path !== "string" || typeof clip.metrics !== "string") {
        throw new Error(`Base manifest clip ${index} lacks id/path/metrics`);
      }
      return {
        id: clip.id,
        moviePath: resolve(baseDirectory, clip.path),
        metricsPath: resolve(baseDirectory, clip.metrics),
        globalStartFrame: clip.globalStartFrame,
        frameCount: clip.frameCount,
        legacyMetricsApproved: clip.approvedIdentity?.legacyMetricsApproved === true,
      };
    }),
  };
}

function parseExtraClip(value) {
  const parts = String(value).split("@");
  if (parts.length < 3 || parts.length > 4) {
    throw new Error("--extra-clip must be MOV@GLOBAL_START_FRAME@FRAME_COUNT[@legacy]");
  }
  const [rawMoviePath, rawStart, rawCount, legacy = ""] = parts;
  const moviePath = resolve(rawMoviePath);
  return {
    id: `${basename(moviePath, ".mov")}-${rawStart}-${rawCount}`,
    moviePath,
    metricsPath: `${moviePath}.metrics.json`,
    globalStartFrame: Number(rawStart),
    frameCount: Number(rawCount),
    legacyMetricsApproved: legacy === "legacy",
  };
}

function requireSuccessfulClip(clip, metrics, projectIdentity, finalRenderIdentityProject) {
  if (!existsSync(clip.moviePath) || !statSync(clip.moviePath).isFile()) {
    throw new Error(`Golden MOV is missing: ${clip.moviePath}`);
  }
  if (!existsSync(clip.metricsPath) || !statSync(clip.metricsPath).isFile()) {
    throw new Error(`Golden metrics are missing: ${clip.metricsPath}`);
  }
  if (!Number.isSafeInteger(clip.globalStartFrame) || clip.globalStartFrame < 0
      || !Number.isSafeInteger(clip.frameCount) || clip.frameCount <= 0) {
    throw new Error(`Invalid golden frame interval for ${clip.id}`);
  }
  if (metrics.failure !== null) throw new Error(`${clip.id} metrics do not explicitly report success`);
  if (metrics.outputCommit?.committed !== true
      || typeof metrics.outputCommit?.stagingOutput !== "string"
      || existsSync(metrics.outputCommit.stagingOutput)) {
    throw new Error(`${clip.id} was not atomically committed`);
  }
  if (metrics.config?.startFrame !== clip.globalStartFrame
      || metrics.config?.frames !== clip.frameCount
      || metrics.renderer?.framesCompleted !== clip.frameCount
      || metrics.screenshotSequence?.capturedFrames !== clip.frameCount) {
    throw new Error(`${clip.id} frame interval/completion evidence does not match`);
  }
  if (!metrics.runId || !SHA256_PATTERN.test(String(metrics.screenshotSequence?.frameHashSequence?.sequenceSha256 ?? ""))) {
    throw new Error(`${clip.id} lacks run/PNG-sequence identity evidence`);
  }
  if (metrics.screenshotSequence?.mediaGate?.finalActiveUrls !== 0
      || metrics.screenshotSequence?.mediaGate?.finalActiveLeases !== 0
      || metrics.memoryWatchdog?.violation !== null) {
    throw new Error(`${clip.id} resource/lease/watchdog evidence is not clean`);
  }
  if (metrics.renderIdentity?.project != null
      && metrics.renderIdentity.project !== finalRenderIdentityProject) {
    throw new Error(`${clip.id} render identity does not match --final-render-identity`);
  }
  if (metrics.renderIdentity?.project == null && !clip.legacyMetricsApproved) {
    throw new Error(`${clip.id} lacks render identity and was not explicitly approved as legacy evidence`);
  }
  const observedProject = metrics.config?.projectIdentity ?? metrics.projectIdentityVerification?.projectIdentity;
  if (observedProject && canonicalSha256(observedProject, `${clip.id} project identity`) !== projectIdentity) {
    throw new Error(`${clip.id} project identity does not match --project-identity`);
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.output || !args["project-identity"] || !args["final-render-identity"]
      || (!args["discover-dir"] && !args["base-manifest"])
      || !args["audio-oracle-json"]) {
    throw new Error(
      "Usage: node tools/build_golden_clip_manifest.mjs --output=FILE --project-identity=sha256:... "
      + "--final-render-identity=HEX (--base-manifest=FILE | --discover-dir=DIR) --audio-oracle-json=FILE "
      + "--frames=N [--fps=60] [--extra-clip=MOV@START@COUNT@legacy]",
    );
  }
  const output = resolve(args.output);
  const projectIdentity = canonicalSha256(args["project-identity"], "--project-identity");
  const finalRenderIdentityProject = String(args["final-render-identity"]);
  if (!/^[a-f0-9]{64}$/i.test(finalRenderIdentityProject)) {
    throw new Error("--final-render-identity must be a 64-hex renderer project identity");
  }
  if (args.frames == null) throw new Error("--frames is required");
  const frameCount = Number(args.frames);
  const fps = Number(args.fps ?? 60);
  const audioOracleJsonPath = resolve(args["audio-oracle-json"]);
  const audioOracleRecord = readJson(audioOracleJsonPath, "audio oracle JSON");
  if (audioOracleRecord.schemaVersion !== 1) throw new Error("Audio oracle JSON schemaVersion must be 1");
  const declaredAudioOutput = audioOracleRecord.output && typeof audioOracleRecord.output === "object"
    ? audioOracleRecord.output
    : {};
  const audioPathValue = declaredAudioOutput.path ?? audioOracleRecord.path ?? audioOracleRecord.audioPath;
  const inferredAudioPath = audioOracleJsonPath.endsWith(".oracle.json")
    ? audioOracleJsonPath.slice(0, -".oracle.json".length)
    : null;
  const audioPath = audioPathValue
    ? resolve(dirname(audioOracleJsonPath), audioPathValue)
    : inferredAudioPath;
  if (!audioPath || !existsSync(audioPath)) throw new Error(`Audio oracle media is missing: ${audioPath ?? "unspecified"}`);
  const sampleRate = Number(audioOracleRecord.sampleRate ?? 48_000);
  const channels = Number(audioOracleRecord.channels ?? 2);
  const expectedSamplesPerChannel = Number(audioOracleRecord.samplesPerChannel
    ?? audioOracleRecord.sampleCountPerChannel
    ?? (frameCount * sampleRate / fps));
  if (!Number.isSafeInteger(frameCount) || frameCount <= 0 || !Number.isFinite(fps) || fps <= 0
      || !Number.isSafeInteger(expectedSamplesPerChannel) || expectedSamplesPerChannel <= 0) {
    throw new Error("Invalid full-timeline frame/fps/audio sample contract");
  }
  const fullAudioOracle = await buildFullAudioOracleContract({
    path: audioPath,
    projectIdentity,
    inputFormat: audioOracleRecord.inputFormat ?? "media",
    sampleRate,
    channels,
    expectedSamplesPerChannel,
  });
  if (declaredAudioOutput.sizeBytes != null
      && Number(declaredAudioOutput.sizeBytes) !== statSync(audioPath).size) {
    throw new Error("Audio oracle output sizeBytes does not match the independently observed file");
  }
  for (const [name, declared, observed] of [
    ["file SHA-256", declaredAudioOutput.sha256 ?? audioOracleRecord.fileSha256 ?? audioOracleRecord.wavSha256, fullAudioOracle.fileSha256],
    ["decoded PCM SHA-256", declaredAudioOutput.decodedPcmS32leSha256
      ?? audioOracleRecord.decodedPcmSha256 ?? audioOracleRecord.decodedS32leSha256, fullAudioOracle.decodedPcmSha256],
    ["project identity", audioOracleRecord.projectIdentity, fullAudioOracle.projectIdentity],
  ]) {
    if (declared != null && canonicalSha256(declared, `audio oracle ${name}`) !== observed) {
      throw new Error(`Audio oracle ${name} does not match independently observed evidence`);
    }
  }
  if (args["project-manifest"]) {
    const projectManifest = readJson(resolve(args["project-manifest"]), "whole-project identity manifest");
    if (canonicalSha256(projectManifest.projectIdentity, "project manifest projectIdentity") !== projectIdentity) {
      throw new Error("Project manifest identity does not match --project-identity");
    }
    const entryRecord = projectManifest.files?.find((item) => item.path === projectManifest.entry);
    const declaredEntrySha256 = audioOracleRecord.entry?.sha256;
    if (!entryRecord || declaredEntrySha256 == null
        || canonicalSha256(declaredEntrySha256, "audio oracle entry SHA-256")
          !== canonicalSha256(entryRecord.sha256, "project manifest entry SHA-256")) {
      throw new Error("Audio oracle entry SHA-256 does not match the whole-project manifest entry");
    }
  }
  fullAudioOracle.path = portableRelative(dirname(output), audioPath);
  const base = args["base-manifest"] ? clipsFromBaseManifest(resolve(args["base-manifest"])) : null;
  if (base?.manifest.projectIdentity != null
      && canonicalSha256(base.manifest.projectIdentity, "base manifest projectIdentity") !== projectIdentity) {
    throw new Error("Base manifest projectIdentity does not match --project-identity");
  }
  const clips = [
    ...(base?.clips ?? []),
    ...(args["discover-dir"] ? discoverOneFrameClips(resolve(args["discover-dir"])) : []),
    ...args.extraClip.map(parseExtraClip),
  ];
  if (!clips.length) throw new Error("No golden clips were discovered");
  const seenIds = new Set();
  const records = [];
  for (const clip of clips) {
    if (seenIds.has(clip.id)) throw new Error(`Duplicate golden clip id: ${clip.id}`);
    seenIds.add(clip.id);
    const metrics = readJson(clip.metricsPath, `${clip.id} metrics`);
    requireSuccessfulClip(clip, metrics, projectIdentity, finalRenderIdentityProject);
    records.push({
      id: clip.id,
      path: portableRelative(dirname(output), clip.moviePath),
      metrics: portableRelative(dirname(output), clip.metricsPath),
      globalStartFrame: clip.globalStartFrame,
      frameCount: clip.frameCount,
      approvedIdentity: {
        movieSha256: await hashFile(clip.moviePath),
        metricsSha256: await hashFile(clip.metricsPath),
        metricsRunId: metrics.runId,
        screenshotSequenceSha256: metrics.screenshotSequence.frameHashSequence.sequenceSha256,
        projectIdentity,
        renderIdentityProject: finalRenderIdentityProject,
        ...(clip.legacyMetricsApproved ? { legacyMetricsApproved: true } : {}),
      },
    });
  }
  records.sort((left, right) => left.globalStartFrame - right.globalStartFrame || left.id.localeCompare(right.id));
  const manifest = {
    kind: KIND,
    schemaVersion: SCHEMA_VERSION,
    projectIdentity,
    finalRenderIdentityProject,
    fullAudioOracle,
    clips: records,
  };
  const staging = `${output}.hf-partial-${process.pid}-${randomUUID()}`;
  writeFileSync(staging, `${JSON.stringify(manifest, null, 2)}\n`, { flag: "wx" });
  renameSync(staging, output);
  process.stdout.write(`${JSON.stringify({
    output,
    clipCount: records.length,
    projectIdentity,
    schemaVersion: SCHEMA_VERSION,
    fullAudioOracle: {
      path: fullAudioOracle.path,
      samplesPerChannel: fullAudioOracle.samplesPerChannel,
      decodedPcmSha256: fullAudioOracle.decodedPcmSha256,
    },
  }, null, 2)}\n`);
}

main().catch((error) => {
  console.error(error?.stack ?? String(error));
  process.exitCode = 1;
});
