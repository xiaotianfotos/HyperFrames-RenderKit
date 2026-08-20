#!/usr/bin/env node

import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  createReadStream,
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { parse } from "parse5";

const KIND = "hyperframes-project-audio-oracle";
const SCHEMA_VERSION = 1;

function parseArgs(argv) {
  const result = {};
  for (const token of argv) {
    if (!token.startsWith("--") || !token.includes("=")) throw new Error(`Invalid argument: ${token}`);
    const split = token.indexOf("=");
    result[token.slice(2, split)] = token.slice(split + 1);
  }
  return result;
}

function finiteInteger(value, name, minimum = 1) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum) throw new Error(`${name} must be an integer >= ${minimum}`);
  return parsed;
}

function attributeMap(node) {
  return new Map((node.attrs ?? []).map((entry) => [entry.name, entry.value]));
}

function walk(node, visit, parent = null) {
  visit(node, parent);
  for (const child of node.childNodes ?? []) walk(child, visit, node);
}

function projectPath(projectRoot, entryDir, value, label) {
  const requested = resolve(entryDir, value);
  const real = realpathSync(requested);
  const rel = relative(projectRoot, real);
  if (!rel || rel === "." || rel.startsWith("..") || isAbsolute(rel)) {
    throw new Error(`${label} escapes projectRoot: ${requested}`);
  }
  if (!statSync(real).isFile()) throw new Error(`${label} is not a regular file: ${real}`);
  return { requested, real, relativePath: rel.split(sep).join("/") };
}

function sha256File(path) {
  return new Promise((resolveHash, rejectHash) => {
    const hash = createHash("sha256");
    const stream = createReadStream(path);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.once("error", rejectHash);
    stream.once("end", () => resolveHash(`sha256:${hash.digest("hex")}`));
  });
}

function run(command, args, { stdout = "ignore" } = {}) {
  return new Promise((resolveRun, rejectRun) => {
    const child = spawn(command, args, { stdio: ["ignore", stdout, "pipe"] });
    let stderr = "";
    let output = "";
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => { stderr = (stderr + chunk).slice(-32_768); });
    if (child.stdout) {
      child.stdout.setEncoding("utf8");
      child.stdout.on("data", (chunk) => { output += chunk; });
    }
    child.once("error", rejectRun);
    child.once("close", (code, signal) => {
      if (code === 0) resolveRun({ stdout: output, stderr });
      else rejectRun(new Error(`${command} exited ${code ?? signal}: ${stderr.trim()}`));
    });
  });
}

function hashDecodedPcm(ffmpeg, input) {
  return new Promise((resolveHash, rejectHash) => {
    const child = spawn(ffmpeg, [
      "-hide_banner", "-loglevel", "error", "-i", input,
      "-map", "0:a:0", "-f", "s32le", "-acodec", "pcm_s32le", "-ar", "48000", "-ac", "2", "pipe:1",
    ], { stdio: ["ignore", "pipe", "pipe"] });
    const hash = createHash("sha256");
    let byteCount = 0;
    let stderr = "";
    child.stdout.on("data", (chunk) => { hash.update(chunk); byteCount += chunk.byteLength; });
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => { stderr = (stderr + chunk).slice(-32_768); });
    child.once("error", rejectHash);
    child.once("close", (code, signal) => {
      if (code !== 0) {
        rejectHash(new Error(`${ffmpeg} PCM decode exited ${code ?? signal}: ${stderr.trim()}`));
        return;
      }
      resolveHash({ sha256: `sha256:${hash.digest("hex")}`, byteCount });
    });
  });
}

function discoverAudioClips({ entry, projectRoot, sampleRate, outputSamples }) {
  const html = readFileSync(entry, "utf8");
  const document = parse(html);
  let compositionRoot = null;
  walk(document, (node) => {
    if (!node.tagName) return;
    const attrs = attributeMap(node);
    if (attrs.has("data-composition-id")) {
      if (compositionRoot) throw new Error("Entry has more than one composition root");
      compositionRoot = node;
    }
  });
  if (!compositionRoot) throw new Error("Entry has no [data-composition-id] root");
  const entryDir = dirname(entry);
  const toSample = (seconds, label) => {
    const value = Number(seconds);
    if (!Number.isFinite(value) || value < 0) throw new Error(`${label} is not a non-negative number`);
    return Math.round(value * sampleRate);
  };
  const clips = [];
  for (const node of compositionRoot.childNodes ?? []) {
    if (node.tagName !== "audio") continue;
    const attrs = attributeMap(node);
    if (attrs.has("hidden") || attrs.has("data-hidden")) continue;
    const id = attrs.get("id") ?? null;
    const src = String(attrs.get("src") ?? "").trim();
    if (!src) throw new Error(`Audio ${id ?? "<without id>"} has no src`);
    const startSample = toSample(attrs.get("data-start") ?? "0", `${id}.start`);
    const durationSamples = toSample(attrs.get("data-duration"), `${id}.duration`);
    const mediaStartSample = toSample(attrs.get("data-media-start") ?? "0", `${id}.mediaStart`);
    const endSample = startSample + durationSamples;
    const overlapStart = Math.max(0, startSample);
    const overlapEnd = Math.min(outputSamples, endSample);
    if (overlapEnd <= overlapStart) continue;
    const volume = Number(attrs.get("data-volume") ?? "1");
    if (!Number.isFinite(volume) || volume < 0) throw new Error(`${id}.volume is invalid`);
    const source = projectPath(projectRoot, entryDir, src, `${id}.src`);
    clips.push({
      id,
      src,
      sourcePath: source.real,
      sourceRelativePath: source.relativePath,
      startSample,
      durationSamples: overlapEnd - overlapStart,
      inputStartSample: mediaStartSample + overlapStart - startSample,
      delaySamples: overlapStart,
      volume,
    });
  }
  if (!clips.length) throw new Error("No enabled top-level audio clips were found");
  return clips;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args["project-root"] || !args.entry || !args.output) {
    throw new Error("Usage: node tools/build_project_audio_oracle.mjs --project-root=DIR --entry=FILE --output=FILE.wav --frames=N [--fps=60]");
  }
  const projectRoot = realpathSync(resolve(args["project-root"]));
  const entry = projectPath(projectRoot, projectRoot, args.entry, "entry").real;
  const output = resolve(args.output);
  if (args.frames == null) throw new Error("--frames is required");
  const frames = finiteInteger(args.frames, "--frames");
  const fps = finiteInteger(args.fps ?? 60, "--fps");
  const sampleRate = finiteInteger(args["sample-rate"] ?? 48_000, "--sample-rate");
  const numerator = BigInt(frames) * BigInt(sampleRate);
  if (numerator % BigInt(fps) !== 0n) throw new Error("frames × sampleRate must be divisible by fps");
  const outputSamples = Number(numerator / BigInt(fps));
  const ffmpeg = args.ffmpeg ?? "ffmpeg";
  const ffprobe = args.ffprobe ?? "ffprobe";
  if (existsSync(output) || existsSync(`${output}.oracle.json`)) throw new Error(`Output already exists: ${output}`);
  mkdirSync(dirname(output), { recursive: true });
  const clips = discoverAudioClips({ entry, projectRoot, sampleRate, outputSamples });
  const inputs = [];
  const filters = [];
  for (let index = 0; index < clips.length; index += 1) {
    const clip = clips[index];
    inputs.push("-i", clip.sourcePath);
    const sourceEndSample = clip.inputStartSample + clip.durationSamples;
    filters.push(
      `[${index}:a:0]aresample=${sampleRate}:async=0,`
      + `aformat=sample_fmts=fltp:sample_rates=${sampleRate}:channel_layouts=stereo,`
      + `atrim=start_sample=${clip.inputStartSample}:end_sample=${sourceEndSample},`
      + `asetpts=PTS-STARTPTS,apad=whole_len=${clip.durationSamples},`
      + `atrim=end_sample=${clip.durationSamples},volume=${clip.volume.toFixed(9)},`
      + `adelay=${clip.delaySamples}S:all=1[a${index}]`,
    );
  }
  const mixInputs = clips.map((_, index) => `[a${index}]`).join("");
  filters.push(
    `${mixInputs}amix=inputs=${clips.length}:duration=longest:dropout_transition=0:normalize=0,`
    + `apad=whole_len=${outputSamples},atrim=end_sample=${outputSamples},asetpts=N/SR/TB[aout]`,
  );
  const temporary = `${output}.hf-partial-${process.pid}-${randomUUID()}`;
  try {
    await run(ffmpeg, [
      "-hide_banner", "-loglevel", "error", "-nostdin", ...inputs,
      "-filter_complex", filters.join(";"), "-map", "[aout]",
      "-c:a", "pcm_s24le", "-ar", String(sampleRate), "-ac", "2",
      "-f", "wav", temporary,
    ]);
    const probe = JSON.parse((await run(ffprobe, [
      "-v", "error", "-show_entries",
      "format=duration,size:stream=codec_type,codec_name,sample_fmt,sample_rate,channels,channel_layout,duration_ts,time_base,start_time",
      "-of", "json", temporary,
    ], { stdout: "pipe" })).stdout);
    const audioStreams = (probe.streams ?? []).filter((stream) => stream.codec_type === "audio");
    const audio = audioStreams[0];
    if (audioStreams.length !== 1 || audio?.codec_name !== "pcm_s24le"
        || audio?.sample_fmt !== "s32" || Number(audio?.sample_rate) !== sampleRate
        || Number(audio?.channels) !== 2 || audio?.channel_layout !== "stereo"
        || (audio?.start_time != null && Number(audio.start_time) !== 0)
        || audio?.time_base !== `1/${sampleRate}`
        || Number(audio?.duration_ts) !== outputSamples) {
      throw new Error(`Audio oracle probe contract failed: ${JSON.stringify(probe)}`);
    }
    const decoded = await hashDecodedPcm(ffmpeg, temporary);
    const expectedDecodedBytes = outputSamples * 2 * 4;
    if (decoded.byteCount !== expectedDecodedBytes) {
      throw new Error(`Decoded PCM length mismatch: expected ${expectedDecodedBytes}, got ${decoded.byteCount}`);
    }
    renameSync(temporary, output);
    const manifest = {
      kind: KIND,
      schemaVersion: SCHEMA_VERSION,
      createdAt: new Date().toISOString(),
      projectRoot,
      entry: {
        path: entry,
        sha256: await sha256File(entry),
      },
      contract: { frames, fps, sampleRate, channels: 2, codec: "pcm_s24le", sampleFormat: "s32", outputSamples },
      clips: clips.map(({ sourcePath: _sourcePath, ...clip }) => clip),
      output: {
        path: output,
        sizeBytes: statSync(output).size,
        sha256: await sha256File(output),
        decodedPcmS32leSha256: decoded.sha256,
        decodedPcmS32leBytes: decoded.byteCount,
      },
      probe,
    };
    const manifestPath = `${output}.oracle.json`;
    const stagingManifest = `${manifestPath}.hf-partial-${process.pid}-${randomUUID()}`;
    writeFileSync(stagingManifest, `${JSON.stringify(manifest, null, 2)}\n`, { flag: "wx" });
    renameSync(stagingManifest, manifestPath);
    process.stdout.write(`${JSON.stringify({ output, manifestPath, clipCount: clips.length, outputSamples, decodedPcmS32leSha256: decoded.sha256 }, null, 2)}\n`);
  } catch (error) {
    if (existsSync(temporary)) unlinkSync(temporary);
    throw error;
  }
}

main().catch((error) => {
  console.error(error?.stack ?? String(error));
  process.exitCode = 1;
});
