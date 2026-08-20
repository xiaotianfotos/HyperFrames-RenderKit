#!/usr/bin/env node

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const toolPath = fileURLToPath(import.meta.url);
const rendererRoot = resolve(dirname(toolPath), "..");

function parseArguments(argv) {
  return Object.fromEntries(argv.filter((argument) => argument.startsWith("--")).map((argument) => {
    const split = argument.indexOf("=");
    return split < 0
      ? [argument.slice(2), "true"]
      : [argument.slice(2, split), argument.slice(split + 1)];
  }));
}

function run(command, args, { timeoutMs = 60_000, env = process.env } = {}) {
  return new Promise((resolveRun, rejectRun) => {
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"], env });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    const timeout = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
      setTimeout(() => child.kill("SIGKILL"), 2_000).unref();
    }, timeoutMs);
    child.once("error", (error) => {
      clearTimeout(timeout);
      rejectRun(error);
    });
    child.once("close", (code, signal) => {
      clearTimeout(timeout);
      resolveRun({ code, signal, stdout, stderr, timedOut });
    });
  });
}

function compositionHtml(secondMediaStart, width, height, { hidePipAfterFirst = false } = {}) {
  return `<!doctype html>
<meta charset="utf-8">
<style>
html,body{margin:0;background:#000;overflow:hidden}
[data-composition-id]{position:relative;width:${width}px;height:${height}px;background:#000}
.clip{position:absolute;inset:0;width:${width}px;height:${height}px;object-fit:cover}
#pip{left:55%;top:49%;width:40%;height:40%;border-radius:8px;opacity:.85}
</style>
<div data-composition-id="decoder-lane-fixture">
  <video id="main" class="clip" muted playsinline preload="auto" src="source.mp4"
    data-start="0" data-duration="2" data-media-start="0" data-track-index="0"></video>
  <video id="pip" class="clip" muted playsinline preload="auto" src="source.mp4"
    data-start="0" data-duration="2" data-media-start="${secondMediaStart}" data-track-index="1"></video>
</div>
<script>window.__timelines={main:{seek(time){${hidePipAfterFirst
    ? "document.getElementById('pip').style.opacity=time<1/120?'.85':'0';"
    : ""}}}};</script>`;
}

async function buildBundle(projectRoot, entry) {
  const bundle = resolve(projectRoot, `${entry}.timing-bundle.json`);
  const result = await run(process.execPath, [
    resolve(rendererRoot, "tools/media_timing_plan.mjs"),
    "bundle",
    `--projectRoot=${projectRoot}`,
    `--entry=${entry}`,
    `--output=${bundle}`,
  ]);
  if (result.code !== 0) {
    throw new Error(`Timing bundle failed:\n${result.stdout}\n${result.stderr}`);
  }
  return bundle;
}

async function renderFixture(electron, projectRoot, name, secondMediaStart, runtimeOptions = {}) {
  const entry = `${name}.html`;
  const width = runtimeOptions.width ?? 320;
  const height = runtimeOptions.height ?? 180;
  const frames = runtimeOptions.frames ?? 1;
  await writeFile(resolve(projectRoot, entry), compositionHtml(secondMediaStart, width, height, {
    hidePipAfterFirst: runtimeOptions.hidePipAfterFirst === true,
  }));
  const bundle = await buildBundle(projectRoot, entry);
  const output = resolve(projectRoot, `${name}.mov`);
  const childEnv = { ...process.env };
  delete childEnv.ELECTRON_RUN_AS_NODE;
  const electronSwitches = ["--no-sandbox"];
  if (runtimeOptions.ozonePlatform) {
    electronSwitches.push(`--ozone-platform=${runtimeOptions.ozonePlatform}`);
  }
  const result = await run(resolve(electron), [
    ...electronSwitches,
    resolve(rendererRoot, "full-canvas-main.mjs"),
    `--projectRoot=${projectRoot}`,
    `--entry=${entry}`,
    `--output=${output}`,
    `--width=${width}`,
    `--height=${height}`,
    "--fps=60",
    `--frames=${frames}`,
    "--start=0",
    "--compositeMode=layered",
    "--mediaTargetMode=timing-plan",
    `--mediaTimingPlan=${bundle}`,
    "--mediaTimingPlanVerify=stat",
    "--mediaAdvanceMode=playback-step",
    "--mediaDecoderLanesTotal=2",
    "--mediaDecoderLanesPerSource=2",
    `--mediaDecoderIdleFrames=${runtimeOptions.idleFrames ?? 2}`,
    "--frameMetricsMode=full",
    "--seekTimeoutMs=10000",
    "--paintTimeoutMs=500",
    "--cdp=0",
    `--angle=${runtimeOptions.angle ?? (process.platform === "darwin" ? "metal" : "gl")}`,
  ], { timeoutMs: 90_000, env: childEnv });
  if (result.code !== 0) {
    throw new Error(
      `Electron ${name} render failed (code=${result.code}, signal=${result.signal}, timeout=${result.timedOut}):\n`
      + `${result.stdout}\n${result.stderr}`,
    );
  }
  const metrics = JSON.parse(await readFile(`${output}.metrics.json`, "utf8"));
  assert.equal(metrics.failure, null, JSON.stringify(metrics.failure));
  assert.equal(metrics.renderer.frameTimings.length, frames);
  for (const frame of metrics.renderer.frameTimings) {
    assert.ok(frame.mediaTimes.filter((item) => !item.skipped).every((item) => item.verifiedPts === true));
  }
  return { metrics, frame: metrics.renderer.frameTimings[0] };
}

async function main(options) {
  const electron = options.electron || process.env.ELECTRON_BINARY;
  if (!electron) {
    throw new Error("Pass --electron=/absolute/path/to/electron or set ELECTRON_BINARY");
  }
  const projectRoot = await mkdtemp(join(tmpdir(), "decoder-lane-electron-"));
  const runtimeOptions = {
    angle: options.angle,
    ozonePlatform: options["ozone-platform"] ?? options.ozonePlatform,
    width: Number(options.width ?? 320),
    height: Number(options.height ?? 180),
  };
  try {
    const source = resolve(projectRoot, "source.mp4");
    const generated = await run("ffmpeg", [
      "-v", "error", "-y",
      "-f", "lavfi", "-i", `testsrc2=size=${runtimeOptions.width}x${runtimeOptions.height}:rate=60:duration=2`,
      "-c:v", "libx264", "-bf", "2", "-g", "60", "-pix_fmt", "yuv420p",
      "-video_track_timescale", "60000",
      source,
    ]);
    if (generated.code !== 0) throw new Error(`Fixture generation failed: ${generated.stderr}`);

    const shared = await renderFixture(electron, projectRoot, "shared", "0", runtimeOptions);
    const sharedLaneIds = new Set(shared.frame.mediaTimes.map((item) => item.decoderLaneId));
    assert.equal(sharedLaneIds.size, 1);
    assert.equal(shared.frame.mediaTimes[1].decoderLaneShared, true);
    assert.equal(shared.metrics.renderer.support.mediaDecoderLanePool.final.stats.createdLanes, 1);

    const divergent = await renderFixture(electron, projectRoot, "divergent", "0.5", runtimeOptions);
    const divergentLaneIds = new Set(divergent.frame.mediaTimes.map((item) => item.decoderLaneId));
    assert.equal(divergentLaneIds.size, 2);
    assert.equal(divergent.metrics.renderer.support.mediaDecoderLanePool.final.stats.createdLanes, 2);
    assert.equal(divergent.metrics.renderer.support.mediaDecoderLanePool.final.stats.peakActiveLanes, 2);

    const idle = await renderFixture(electron, projectRoot, "idle", "0.5", {
      ...runtimeOptions,
      frames: 61,
      hidePipAfterFirst: true,
      idleFrames: 120,
    });
    const idleFrames = idle.metrics.renderer.frameTimings;
    const idlePauseEvents = idleFrames
      .filter((frame) => frame.decoderLaneMaintenance.pauseLaneIds.length)
      .map((frame) => ({ frameIndex: frame.frameIndex, laneIds: frame.decoderLaneMaintenance.pauseLaneIds }));
    assert.deepEqual(idleFrames[0].decoderLaneMaintenance.pauseLaneIds, []);
    assert.equal(idlePauseEvents.length, 1, JSON.stringify({
      idlePauseEvents,
      laneClaims: idleFrames.map((frame) => frame.mediaTimes.map((item) => ({
        id: item.id,
        skipped: item.skipped,
        laneId: item.decoderLaneId,
        laneReason: item.decoderLaneReason,
      }))),
    }));
    assert.equal(idlePauseEvents[0].frameIndex, 1);
    assert.equal(idle.metrics.renderer.support.mediaDecoderLanePool.final.stats.pausedIdleLanes, 1);
    const idleMainTimes = idleFrames.flatMap((frame) => frame.mediaTimes.filter((item) => item.id === "main"));
    assert.equal(new Set(idleMainTimes.map((item) => item.decoderLaneId)).size, 1);
    assert.ok(idleMainTimes.slice(1).every((item) => item.decoderLaneReason === "clip-continuity"));
    const idleAdvanceFallbackFrames = idleFrames
      .filter((frame) => frame.mediaTimes.some((item) => item.advanceFallback))
      .map((frame) => frame.frameIndex);

    console.log(JSON.stringify({
      sharedLaneIds: [...sharedLaneIds],
      divergentLaneIds: [...divergentLaneIds],
      sharedReasons: shared.frame.mediaTimes.map((item) => item.decoderLaneReason),
      divergentReasons: divergent.frame.mediaTimes.map((item) => item.decoderLaneReason),
      idlePauseEvents,
      idleAdvanceFallbackFrames,
    }, null, 2));
    console.log("Electron decoder lane integration test passed");
  } finally {
    await rm(projectRoot, { recursive: true, force: true });
  }
}

await main(parseArguments(process.argv.slice(2)));
