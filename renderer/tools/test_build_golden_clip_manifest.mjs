#!/usr/bin/env node

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, resolve } from "node:path";
import { buildFullAudioOracleContract } from "./validate_final_mov.mjs";

function run(command, args, { expectCode = 0 } = {}) {
  return new Promise((resolveRun, rejectRun) => {
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.once("error", rejectRun);
    child.once("close", (code) => {
      if (code === expectCode) resolveRun({ code, stdout, stderr });
      else rejectRun(new Error(`${command} exited ${code}, expected ${expectCode}: ${stderr}`));
    });
  });
}

const root = mkdtempSync(resolve(tmpdir(), "hf-golden-builder-"));
try {
  const discoverDir = resolve(root, "clips");
  mkdirSync(discoverDir);
  const clipPath = resolve(discoverDir, "frame-0.mov");
  writeFileSync(clipPath, "approved-one-frame-fixture");
  const projectIdentity = `sha256:${"11".repeat(32)}`;
  const renderIdentity = "22".repeat(32);
  const absentStaging = resolve(root, "absent-staging.mov");
  writeFileSync(`${clipPath}.metrics.json`, `${JSON.stringify({
    runId: "golden-builder-fixture",
    failure: null,
    renderIdentity: { project: renderIdentity },
    config: { startFrame: 0, frames: 1 },
    renderer: { framesCompleted: 1 },
    screenshotSequence: {
      capturedFrames: 1,
      frameHashSequence: { sequenceSha256: "33".repeat(32) },
      mediaGate: { finalActiveUrls: 0, finalActiveLeases: 0 },
    },
    memoryWatchdog: { violation: null },
    outputCommit: { committed: true, stagingOutput: absentStaging },
  }, null, 2)}\n`);

  const audioPath = resolve(root, "audio.wav");
  await run("ffmpeg", [
    "-hide_banner", "-loglevel", "error", "-nostdin", "-y",
    "-f", "lavfi", "-i", "sine=frequency=997:sample_rate=48000:duration=0.2",
    "-c:a", "pcm_s24le", "-ar", "48000", "-ac", "2", audioPath,
  ]);
  const audioContract = await buildFullAudioOracleContract({
    path: audioPath,
    projectIdentity,
    inputFormat: "media",
    sampleRate: 48_000,
    channels: 2,
    expectedSamplesPerChannel: 9_600,
  });
  const audioJsonPath = `${audioPath}.oracle.json`;
  const entrySha256 = `sha256:${"77".repeat(32)}`;
  writeFileSync(audioJsonPath, `${JSON.stringify({
    schemaVersion: 1,
    projectIdentity,
    sampleRate: audioContract.sampleRate,
    channels: audioContract.channels,
    samplesPerChannel: audioContract.samplesPerChannel,
    entry: { sha256: entrySha256 },
    output: {
      path: basename(audioPath),
      sizeBytes: readFileSync(audioPath).length,
      sha256: audioContract.fileSha256,
      decodedPcmS32leSha256: audioContract.decodedPcmSha256,
    },
  }, null, 2)}\n`);
  const projectManifestPath = resolve(root, "project-identity.json");
  writeFileSync(projectManifestPath, `${JSON.stringify({
    projectIdentity,
    entry: "index.html",
    files: [{ path: "index.html", sha256: entrySha256 }],
  }, null, 2)}\n`);

  const baseManifestPath = resolve(root, "schema1-goldens.json");
  writeFileSync(baseManifestPath, `${JSON.stringify({
    kind: "hyperframes-golden-clip-manifest",
    schemaVersion: 1,
    projectIdentity,
    finalRenderIdentityProject: renderIdentity,
    clips: [{
      id: "preserved-approved-frame",
      path: "clips/frame-0.mov",
      metrics: "clips/frame-0.mov.metrics.json",
      globalStartFrame: 0,
      frameCount: 1,
      approvedIdentity: { legacyMetricsApproved: false },
    }],
  }, null, 2)}\n`);

  const output = resolve(root, "goldens.json");
  const result = await run(process.execPath, [
    resolve("tools/build_golden_clip_manifest.mjs"),
    `--output=${output}`,
    `--project-identity=${projectIdentity}`,
    `--final-render-identity=${renderIdentity}`,
    `--base-manifest=${baseManifestPath}`,
    `--audio-oracle-json=${audioJsonPath}`,
    `--project-manifest=${projectManifestPath}`,
    "--frames=12", "--fps=60",
  ]);
  const manifest = JSON.parse(readFileSync(output, "utf8"));
  assert.equal(manifest.schemaVersion, 2);
  assert.equal(manifest.clips.length, 1);
  assert.equal(manifest.clips[0].id, "preserved-approved-frame");
  assert.equal(manifest.fullAudioOracle.samplesPerChannel, 9_600);
  assert.equal(manifest.fullAudioOracle.decodedPcmSha256, audioContract.decodedPcmSha256);
  assert.equal(manifest.fullAudioOracle.projectIdentity, projectIdentity);
  assert.match(result.stdout, /"schemaVersion": 2/);

  const badAudioJsonPath = resolve(root, "bad-audio.oracle.json");
  writeFileSync(badAudioJsonPath, `${JSON.stringify({
    schemaVersion: 1,
    projectIdentity,
    samplesPerChannel: audioContract.samplesPerChannel,
    output: {
      path: audioPath,
      sizeBytes: readFileSync(audioPath).length,
      sha256: audioContract.fileSha256,
      decodedPcmS32leSha256: `sha256:${"ff".repeat(32)}`,
    },
  }, null, 2)}\n`);
  const rejected = await run(process.execPath, [
    resolve("tools/build_golden_clip_manifest.mjs"),
    `--output=${resolve(root, "bad-goldens.json")}`,
    `--project-identity=${projectIdentity}`,
    `--final-render-identity=${renderIdentity}`,
    `--base-manifest=${baseManifestPath}`,
    `--audio-oracle-json=${badAudioJsonPath}`,
    "--frames=12", "--fps=60",
  ], { expectCode: 1 });
  assert.match(rejected.stderr, /decoded PCM SHA-256 does not match/);

  process.stdout.write(`${JSON.stringify({
    ok: true,
    schemaVersion: manifest.schemaVersion,
    clipCount: manifest.clips.length,
    schema1ClipIdPreserved: manifest.clips[0].id,
    audioSamplesPerChannel: manifest.fullAudioOracle.samplesPerChannel,
    tamperedAudioIdentityRejected: true,
  }, null, 2)}\n`);
} finally {
  rmSync(root, { recursive: true, force: true });
}
