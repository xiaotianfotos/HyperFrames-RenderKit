#!/usr/bin/env node

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { copyFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

import { validateDeterministicPair } from "./validate_deterministic_pair.mjs";

function run(command, args) {
  return new Promise((resolveRun, rejectRun) => {
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stderr = "";
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.once("error", rejectRun);
    child.once("close", (code) => {
      if (code === 0) resolveRun();
      else rejectRun(new Error(`${command} exited ${code}: ${stderr.slice(-2_000)}`));
    });
  });
}

function runForExit(command, args) {
  return new Promise((resolveRun, rejectRun) => {
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.once("error", rejectRun);
    child.once("close", (code) => resolveRun({ code, stdout, stderr }));
  });
}

async function makeFixture(path, { altered = false } = {}) {
  const args = [
    "-hide_banner", "-loglevel", "error", "-nostdin", "-y",
    "-f", "lavfi", "-i", "testsrc2=size=64x64:rate=60:duration=0.2",
    "-f", "lavfi", "-i", "sine=frequency=997:sample_rate=48000:duration=0.2",
  ];
  if (altered) args.push("-vf", "drawbox=x=0:y=0:w=20:h=20:color=red:t=fill:enable=eq(n\\,4)");
  args.push(
    "-map", "0:v:0", "-map", "1:a:0",
    "-frames:v", "12", "-t", "0.2",
    "-c:v", "libx264", "-preset", "ultrafast", "-qp", "0", "-pix_fmt", "yuv420p",
    "-c:a", "pcm_s24le", "-ar", "48000", "-ac", "2",
    path,
  );
  await run("ffmpeg", args);
}

function metrics(output) {
  return {
    failure: null,
    renderIdentity: {
      project: "fixture-project-v1",
      entry: "fixture-entry-v1",
      assets: "fixture-assets-v1",
      timingBundle: "fixture-timing-v1",
    },
    config: {
      projectRoot: "/fixture/project",
      entry: "/fixture/project/index.html",
      output,
      width: 64,
      height: 64,
      fps: 60,
      frames: 12,
      start: 0,
      startFrame: 0,
      compositeMode: "screenshot",
      outputBackend: "screenshot",
      mediaFrameMode: "video",
      mediaTargetMode: "timing-plan",
      mediaTailPolicy: "hold-last",
      mediaSeekBiasFrames: 0,
      mediaAdvanceMode: "playback-step",
      mediaPlaybackRate: 1,
      waitMode: "paint",
      screenshotMediaPolicy: "bounded-static",
      screenshotMediaRequestGate: true,
      mixProjectAudio: true,
      audioCodec: "pcm_s24le",
      audioSampleRate: 48000,
      allowAudioCodecPadding: false,
    },
    renderer: { framesCompleted: 12 },
    support: { outputBackend: "screenshot" },
    decodedAudio: { samplesPerChannel: 9600 },
    outputCommit: { committed: true },
    screenshotSequence: {
      capturedFrames: 12,
      frameHashSequence: { sequenceSha256: "informational-only-fixture-hash" },
    },
  };
}

async function runGate(root, a, b, suffix, overrides = {}) {
  return validateDeterministicPair({
    a,
    b,
    metricsA: `${a}.metrics.json`,
    metricsB: `${b}.metrics.json`,
    outputDir: resolve(root, suffix),
    ffmpeg: "ffmpeg",
    ffprobe: "ffprobe",
    requirePcm: true,
    ssimMin: 0.999,
    psnrMin: 55,
    ...overrides,
  });
}

const root = mkdtempSync(resolve(tmpdir(), "hf-deterministic-pair-test-"));
try {
  const a = resolve(root, "a.mov");
  const b = resolve(root, "b.mov");
  const altered = resolve(root, "altered.mov");
  await makeFixture(a);
  copyFileSync(a, b);
  await makeFixture(altered, { altered: true });
  writeFileSync(`${a}.metrics.json`, `${JSON.stringify(metrics(a), null, 2)}\n`);
  writeFileSync(`${b}.metrics.json`, `${JSON.stringify(metrics(b), null, 2)}\n`);
  writeFileSync(`${altered}.metrics.json`, `${JSON.stringify(metrics(altered), null, 2)}\n`);

  const positive = await runGate(root, a, b, "positive");
  assert.equal(positive.ok, true);
  assert.equal(positive.visual.frameCount, 12);
  assert.equal(positive.visual.failingFrames.length, 0);
  assert.equal(positive.audio.a.samplesPerChannel, 9600);
  assert.match(readFileSync(positive.reportMarkdown, "utf8"), /Result: \*\*PASS\*\*/);

  const badMetrics = metrics(b);
  badMetrics.config.startFrame = 1;
  writeFileSync(`${b}.metrics.json`, `${JSON.stringify(badMetrics, null, 2)}\n`);
  const wrongTime = await runGate(root, a, b, "wrong-time");
  assert.equal(wrongTime.ok, false);
  assert.equal(wrongTime.visual, null);
  assert.ok(wrongTime.errors.some((error) => error.includes("config.startFrame")));
  const cliWrongTime = await runForExit(process.execPath, [
    resolve("tools/validate_deterministic_pair.mjs"),
    `--a=${a}`,
    `--b=${b}`,
    `--output-dir=${resolve(root, "wrong-time-cli")}`,
  ]);
  assert.equal(cliWrongTime.code, 1, cliWrongTime.stderr);

  writeFileSync(`${b}.metrics.json`, `${JSON.stringify(metrics(b), null, 2)}\n`);
  const wrongPixels = await runGate(root, a, altered, "wrong-pixels");
  assert.equal(wrongPixels.ok, false);
  assert.ok(wrongPixels.visual.failingFrames.some((frame) => frame.frame === 4));
  assert.ok(wrongPixels.errors.some((error) => error.includes("visual.everyFrameThreshold")));

  process.stdout.write(`${JSON.stringify({
    ok: true,
    positive: {
      minimumSsim: positive.visual.ssim.minimum,
      minimumPsnrDb: positive.visual.psnrDb.minimum === Infinity
        ? "Infinity"
        : positive.visual.psnrDb.minimum,
    },
    negativeTimingRejected: !wrongTime.ok,
    negativeCliExitCode: cliWrongTime.code,
    negativeVisualRejected: !wrongPixels.ok,
  }, null, 2)}\n`);
} finally {
  rmSync(root, { recursive: true, force: true });
}
