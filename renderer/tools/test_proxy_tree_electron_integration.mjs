#!/usr/bin/env node

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const toolsRoot = dirname(fileURLToPath(import.meta.url));
const rendererRoot = resolve(toolsRoot, "..");

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

function runBinary(command, args, { timeoutMs = 60_000 } = {}) {
  return new Promise((resolveRun, rejectRun) => {
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
    const stdout = [];
    let stderr = "";
    let timedOut = false;
    child.stdout.on("data", (chunk) => stdout.push(chunk));
    child.stderr.setEncoding("utf8");
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
      resolveRun({ code, signal, stdout: Buffer.concat(stdout), stderr, timedOut });
    });
  });
}

function compositionHtml(width, height) {
  return `<!doctype html>
<meta charset="utf-8">
<link rel="stylesheet" href="assets/proxy.css">
<style>
html,body{margin:0;background:linear-gradient(135deg,#08142a,#132847);overflow:hidden}
[data-composition-id]{position:relative;width:${width}px;height:${height}px;background-color:#7c1838;background-image:linear-gradient(90deg,#7c1838,#173e72)}
.clip{position:absolute;inset:12px;width:${width - 24}px;height:${height - 24}px;object-fit:cover;border-radius:18px;transform:rotate(1deg);filter:saturate(1.05)}
#pip{inset:auto 12px 12px auto;width:${Math.round(width * 0.36)}px;height:${Math.round(height * 0.36)}px;border:2px solid white;z-index:1;transform:rotate(-2deg);object-fit:contain}
#pip:has(> source){outline:1px solid #5cf}
#label{position:absolute;z-index:2;right:10px;bottom:8px;color:white;background:#c20;padding:3px 8px;font:14px sans-serif}
</style>
<div data-composition-id="proxy-tree-fixture">
  <video id="main" class="clip" muted playsinline preload="auto" src="source.mp4"
    data-start="0" data-duration="2" data-media-start="0" data-track-index="0"></video>
  <video id="pip" class="clip" muted playsinline preload="auto"
    data-start="0" data-duration="2" data-media-start="0" data-track-index="1"><source src="source.mp4" type="video/mp4"></video>
  <div id="label">proxy-tree</div>
</div>
<script src="assets/proxy.js"></script>
<script>
const proxiesAtPageStart = [document.getElementById("main"), document.getElementById("pip")];
if (proxiesAtPageStart.length !== 2
    || !proxiesAtPageStart.every((element) => element instanceof HTMLCanvasElement
      && element.hasAttribute("data-hf-video-proxy"))
    || !document.getElementById("pip").matches(".clip:has(> source)")
    || window.__proxyExternalDependency !== "loaded"
    || getComputedStyle(document.getElementById("label")).letterSpacing !== "3px") {
  throw new Error("video proxy was not installed before the composition script");
}
window.__timelines={main:{seek(time){document.getElementById("label").style.opacity=String(.7 + time)}}};
</script>`;
}

function transparentAncestorHtml(width, height) {
  return `<!doctype html>
<meta charset="utf-8">
<style>
html,body{margin:0;background:linear-gradient(90deg,#91264a,#164b8e);overflow:hidden}
[data-composition-id]{position:relative;width:${width}px;height:${height}px;background:transparent}
.clip{position:absolute;inset:0;width:${width}px;height:${height}px;object-fit:cover}
</style>
<div data-composition-id="ancestor-background-fixture">
  <video id="main" class="clip" muted playsinline src="source.mp4"
    data-start="0" data-duration="2" data-media-start="0" data-track-index="0"></video>
</div>
<script>window.__timelines={main:{seek(){}}};</script>`;
}

function opaqueMediaHtml(width, height, sourceName) {
  return `<!doctype html>
<meta charset="utf-8">
<style>html,body{margin:0;background:#111}.root{position:relative;width:${width}px;height:${height}px;background:#182438}.clip{position:absolute;inset:0;width:100%;height:100%;object-fit:cover}</style>
<div class="root" data-composition-id="display-audit-fixture">
  <video class="clip" muted playsinline src="${sourceName}" data-start="0" data-duration="2"></video>
</div>
<script>window.__timelines={main:{seek(){}}};</script>`;
}

async function main(options) {
  const electron = options.electron || process.env.ELECTRON_BINARY;
  if (!electron) throw new Error("Pass --electron=/absolute/path/to/electron or set ELECTRON_BINARY");
  const projectRoot = await mkdtemp(join(tmpdir(), "proxy-tree-electron-"));
  const runRoot = await mkdtemp(join(tmpdir(), "proxy-tree-electron-run-"));
  // The production VAAPI encoder contract is validated at delivery-class
  // dimensions. Some drivers intentionally reject tiny H.264 surfaces even
  // though the 1080p/4K profiles are available.
  const width = Number(options.width ?? 1920);
  const height = Number(options.height ?? 1080);
  const frames = Number(options.frames ?? 3);
  try {
    const ffmpegLookup = await run("/usr/bin/which", ["ffmpeg"]);
    const ffprobeLookup = await run("/usr/bin/which", ["ffprobe"]);
    if (ffmpegLookup.code !== 0 || ffprobeLookup.code !== 0) throw new Error("ffmpeg and ffprobe must be on PATH");
    const ffmpeg = ffmpegLookup.stdout.trim();
    const ffprobe = ffprobeLookup.stdout.trim();
    const source = resolve(projectRoot, "source.mp4");
    const generated = await run(ffmpeg, [
      "-v", "error", "-y",
      "-f", "lavfi", "-i", `color=c=lime:size=${width}x${height}:rate=60:duration=2`,
      "-c:v", "libx264", "-bf", "2", "-g", "60", "-pix_fmt", "yuv420p",
      "-video_track_timescale", "60000",
      source,
    ]);
    if (generated.code !== 0) throw new Error(`Fixture generation failed: ${generated.stderr}`);

    const entry = "index.html";
    const entryPath = resolve(projectRoot, entry);
    await mkdir(resolve(projectRoot, "assets"), { recursive: true });
    await writeFile(resolve(projectRoot, "assets/proxy.css"), "#label{letter-spacing:3px}\n");
    await writeFile(resolve(projectRoot, "assets/proxy.js"), 'window.__proxyExternalDependency = "loaded";\n');
    await writeFile(entryPath, compositionHtml(width, height));
    const bundle = resolve(projectRoot, "timing-bundle.json");
    const bundled = await run(process.execPath, [
      resolve(rendererRoot, "tools/media_timing_plan.mjs"),
      "bundle",
      `--projectRoot=${projectRoot}`,
      `--entry=${entry}`,
      `--output=${bundle}`,
    ]);
    if (bundled.code !== 0) throw new Error(`Timing bundle failed:\n${bundled.stdout}\n${bundled.stderr}`);

    const output = resolve(runRoot, "proxy-tree.mov");
    const positiveRuntimeTemp = resolve(runRoot, "runtime-positive");
    await Promise.all([
      entryPath,
      bundle,
      source,
      resolve(projectRoot, "assets/proxy.css"),
      resolve(projectRoot, "assets/proxy.js"),
    ].map((path) => chmod(path, 0o444)));
    await chmod(resolve(projectRoot, "assets"), 0o555);
    await chmod(projectRoot, 0o555);
    const childEnv = { ...process.env };
    delete childEnv.ELECTRON_RUN_AS_NODE;
    const electronArgs = ["--no-sandbox"];
    const ozonePlatform = options["ozone-platform"] ?? options.ozonePlatform;
    if (ozonePlatform) electronArgs.push(`--ozone-platform=${ozonePlatform}`);
    const rendered = await run(resolve(electron), [
      ...electronArgs,
      resolve(rendererRoot, "full-canvas-main.mjs"),
      `--projectRoot=${projectRoot}`,
      `--entry=${entry}`,
      `--output=${output}`,
      `--width=${width}`,
      `--height=${height}`,
      "--fps=60",
      `--frames=${frames}`,
      "--start=0",
      "--compositeMode=proxy-tree",
      "--mediaTargetMode=timing-plan",
      `--mediaTimingPlan=${bundle}`,
      `--ffmpegPath=${ffmpeg}`,
      `--ffprobePath=${ffprobe}`,
      `--runtimeTempDir=${positiveRuntimeTemp}`,
      "--mediaTimingPlanVerify=stat",
      "--mediaAdvanceMode=playback-step",
      "--mediaDecoderLanesTotal=2",
      "--mediaDecoderLanesPerSource=2",
      "--frameMetricsMode=full",
      "--seekTimeoutMs=10000",
      "--paintTimeoutMs=500",
      `--waitMode=${options.waitMode ?? "paint"}`,
      "--cdp=0",
      `--angle=${options.angle ?? (process.platform === "darwin" ? "metal" : "gl")}`,
    ], { timeoutMs: 90_000, env: childEnv });
    await chmod(projectRoot, 0o755);
    if (rendered.code !== 0) {
      throw new Error(
        `Electron proxy-tree render failed (code=${rendered.code}, signal=${rendered.signal}, timeout=${rendered.timedOut}):\n`
        + `${rendered.stdout}\n${rendered.stderr}`,
      );
    }

    const metrics = JSON.parse(await readFile(`${output}.metrics.json`, "utf8"));
    assert.equal(metrics.failure, null, JSON.stringify(metrics.failure));
    assert.equal(metrics.config.compositeMode, "proxy-tree");
    assert.equal(metrics.config.proxyTreeTransform.proxyCount, 2);
    assert.equal(metrics.config.proxyTreeTransform.baseUrl, pathToFileURL(entryPath).href);
    assert.equal(metrics.config.ffmpegPath, ffmpeg);
    assert.equal(metrics.config.ffprobePath, ffprobe);
    assert.equal(metrics.config.runtimeTempDir, positiveRuntimeTemp);
    // Electron may add platform-specific environment variables before loading
    // the application. Environment-contract binding is covered by the segment
    // executor tests; this visual integration records the observed digest but
    // deliberately does not pre-sign a parent-process environment that Electron
    // can legitimately normalize on launch.
    assert.equal(metrics.config.spawnEnvironmentSha256, null);
    assert.match(metrics.config.observedProcessEnvironmentSha256, /^sha256:[0-9a-f]{64}$/);
    assert.ok(metrics.config.proxyTreeTransform.auditedResources.stylesheets.some((item) => item.source.endsWith("/assets/proxy.css")));
    assert.ok(metrics.config.proxyTreeTransform.auditedResources.scripts.some((item) => item.source.endsWith("/assets/proxy.js")));
    assert.ok(metrics.config.proxyTreeTransform.proxies.every((proxy) => (
      proxy.intrinsicSize.width === width
      && proxy.intrinsicSize.height === height
      && proxy.intrinsicSize.sourceWidth === width
      && proxy.intrinsicSize.sourceHeight === height
      && proxy.intrinsicSize.policy === "verified-source-intrinsic-dimensions"
    )));
    assert.equal(metrics.support.proxyTree.active, true);
    assert.equal(metrics.support.proxyTree.proxyCount, 2);
    assert.equal(metrics.support.layoutDiagnostics.authoredBackgroundPreserved, true);
    assert.match(metrics.support.layoutDiagnostics.rootBackgroundImage, /linear-gradient/);
    assert.match(metrics.support.layoutDiagnostics.bodyBackgroundImage, /linear-gradient/);
    assert.match(metrics.support.layoutDiagnostics.htmlBackgroundImage, /linear-gradient/);
    assert.equal(metrics.support.videoClips.length, 2);
    assert.ok(metrics.support.videoClips.every((clip) => clip.proxy === true));
    assert.equal(metrics.support.mediaTimingPlan.active, true);
    assert.equal(metrics.support.mediaDecoderLanePool.active, true);
    assert.equal(metrics.renderer.support.mediaDecoderLanePool.final.stats.createdLanes, 1);
    assert.equal(metrics.renderer.frameTimings.length, frames);
    for (const frame of metrics.renderer.frameTimings) {
      assert.equal(frame.layerBandCount, 1);
      assert.equal(frame.proxyCanvasUpdates.length, 2);
      assert.ok(frame.proxyCanvasUpdates.every((update) => update.drawn === true));
      assert.ok(frame.proxyCanvasUpdates.every((update) => update.width > 0 && update.height > 0));
      assert.deepEqual(frame.proxyCanvasUpdates.map((update) => update.objectFit), ["cover", "contain"]);
      assert.equal(frame.mediaTimes.length, 2);
      assert.ok(frame.mediaTimes.every((media) => media.verifiedPts === true));
      assert.equal(new Set(frame.mediaTimes.map((media) => media.decoderLaneId)).size, 1);
    }
    const corner = await runBinary(ffmpeg, [
      "-v", "error", "-i", output,
      "-vf", "format=rgb24,crop=2:2:0:0",
      "-frames:v", "1", "-f", "rawvideo", "-pix_fmt", "rgb24", "pipe:1",
    ]);
    assert.equal(corner.code, 0, corner.stderr);
    assert.equal(corner.stdout.length, 12, "expected one 2x2 RGB corner sample");
    assert.ok(
      Math.max(...corner.stdout) > 40,
      `authored root gradient was lost to a forced black background: ${[...corner.stdout]}`,
    );
    const center = await runBinary(ffmpeg, [
      "-v", "error", "-i", output,
      "-vf", `format=rgb24,crop=8:8:${Math.floor(width / 2) - 4}:${Math.floor(height / 2) - 4}`,
      "-frames:v", "1", "-f", "rawvideo", "-pix_fmt", "rgb24", "pipe:1",
    ]);
    assert.equal(center.code, 0, center.stderr);
    assert.equal(center.stdout.length, 8 * 8 * 3, "expected one 8x8 RGB center sample");
    const channels = { red: 0, green: 0, blue: 0 };
    for (let index = 0; index < center.stdout.length; index += 3) {
      channels.red += center.stdout[index];
      channels.green += center.stdout[index + 1];
      channels.blue += center.stdout[index + 2];
    }
    const pixels = center.stdout.length / 3;
    channels.red /= pixels;
    channels.green /= pixels;
    channels.blue /= pixels;
    assert.ok(
      channels.green > 160
        && channels.green > channels.red + 60
        && channels.green > channels.blue + 60,
      `proxy child canvas did not contribute the decoded lime frame at center: ${JSON.stringify(channels)}`,
    );

    const ancestorEntry = "ancestor-background.html";
    await writeFile(resolve(projectRoot, ancestorEntry), transparentAncestorHtml(width, height));
    const ancestorBundle = resolve(projectRoot, "ancestor-background-bundle.json");
    const ancestorBundled = await run(process.execPath, [
      resolve(rendererRoot, "tools/media_timing_plan.mjs"),
      "bundle",
      `--projectRoot=${projectRoot}`,
      `--entry=${ancestorEntry}`,
      `--output=${ancestorBundle}`,
    ]);
    assert.equal(ancestorBundled.code, 0, ancestorBundled.stderr);
    const ancestorOutput = resolve(runRoot, "ancestor-background.mov");
    const ancestorRender = await run(resolve(electron), [
      ...electronArgs,
      resolve(rendererRoot, "full-canvas-main.mjs"),
      `--projectRoot=${projectRoot}`,
      `--entry=${ancestorEntry}`,
      `--output=${ancestorOutput}`,
      `--width=${width}`,
      `--height=${height}`,
      "--fps=60",
      "--frames=1",
      "--compositeMode=proxy-tree",
      "--mediaTargetMode=timing-plan",
      `--mediaTimingPlan=${ancestorBundle}`,
      `--ffmpegPath=${ffmpeg}`,
      `--ffprobePath=${ffprobe}`,
      `--runtimeTempDir=${resolve(runRoot, "runtime-ancestor")}`,
      "--mediaTimingPlanVerify=stat",
      "--mediaAdvanceMode=playback-step",
      "--cdp=0",
      `--angle=${options.angle ?? (process.platform === "darwin" ? "metal" : "gl")}`,
    ], { timeoutMs: 60_000, env: childEnv });
    assert.equal(ancestorRender.code, 1, ancestorRender.stdout + ancestorRender.stderr);
    assert.match(
      ancestorRender.stdout + ancestorRender.stderr,
      /HF_PROXY_ANCESTOR_BACKGROUND_UNSUPPORTED/,
    );

    const expectDisplayAuditBlocker = async ({ name, sourceName, expected }) => {
      const displayEntry = `${name}.html`;
      await writeFile(resolve(projectRoot, displayEntry), opaqueMediaHtml(width, height, sourceName));
      const displayBundle = resolve(projectRoot, `${name}-bundle.json`);
      const displayBundled = await run(process.execPath, [
        resolve(rendererRoot, "tools/media_timing_plan.mjs"),
        "bundle",
        `--projectRoot=${projectRoot}`,
        `--entry=${displayEntry}`,
        `--output=${displayBundle}`,
      ]);
      assert.equal(displayBundled.code, 0, displayBundled.stderr);
      const displayRender = await run(resolve(electron), [
        ...electronArgs,
        resolve(rendererRoot, "full-canvas-main.mjs"),
        `--projectRoot=${projectRoot}`,
        `--entry=${displayEntry}`,
        `--output=${resolve(runRoot, `${name}.mov`)}`,
        `--width=${width}`,
        `--height=${height}`,
        "--fps=60",
        "--frames=1",
        "--compositeMode=proxy-tree",
        "--mediaTargetMode=timing-plan",
        `--mediaTimingPlan=${displayBundle}`,
        `--ffmpegPath=${ffmpeg}`,
        `--ffprobePath=${ffprobe}`,
        `--runtimeTempDir=${resolve(runRoot, `runtime-${name}`)}`,
        "--mediaTimingPlanVerify=stat",
        "--mediaAdvanceMode=playback-step",
        "--cdp=0",
        `--angle=${options.angle ?? (process.platform === "darwin" ? "metal" : "gl")}`,
      ], { timeoutMs: 60_000, env: childEnv });
      assert.equal(displayRender.code, 1, displayRender.stdout + displayRender.stderr);
      assert.match(displayRender.stdout + displayRender.stderr, expected);
    };

    const sarSource = resolve(projectRoot, "source-sar.mp4");
    const generatedSar = await run(ffmpeg, [
      "-v", "error", "-y",
      "-f", "lavfi", "-i", `testsrc2=size=${width}x${height}:rate=60:duration=0.2`,
      "-vf", "setsar=2/1",
      "-c:v", "libx264", "-pix_fmt", "yuv420p", "-video_track_timescale", "60000",
      sarSource,
    ]);
    assert.equal(generatedSar.code, 0, generatedSar.stderr);
    await expectDisplayAuditBlocker({
      name: "display-sar",
      sourceName: "source-sar.mp4",
      expected: /does not yet support non-square sample aspect ratio 2:1/,
    });

    const rotatedSource = resolve(projectRoot, "source-rotated.mp4");
    const generatedRotated = await run(ffmpeg, [
      "-v", "error", "-y",
      "-display_rotation:v:0", "90", "-i", source,
      "-c", "copy", rotatedSource,
    ]);
    assert.equal(generatedRotated.code, 0, generatedRotated.stderr);
    await expectDisplayAuditBlocker({
      name: "display-rotation",
      sourceName: "source-rotated.mp4",
      expected: /does not yet support rotated display metadata \(90 degrees\)/,
    });
    const originalHtml = await readFile(entryPath, "utf8");
    assert.match(originalHtml, /<video\b/, "proxy-tree must leave the original entry untouched");
    const leftovers = (await readdir(projectRoot)).filter((name) => name.startsWith(".hf-proxy-tree-"));
    assert.deepEqual(leftovers, [], "generated proxy entry must be removed after render");
    assert.deepEqual(await readdir(positiveRuntimeTemp), [], "generated proxy entry must be cleaned from the per-segment runtime temp");
    const videoStream = metrics.probe.streams.find((stream) => stream.codec_type === "video");
    const probedFrames = Number(videoStream.nb_read_frames ?? videoStream.nb_frames ?? videoStream.nb_read_packets);
    assert.equal(probedFrames, frames);

    console.log(JSON.stringify({
      frames,
      proxyCanvasUpdates: metrics.renderer.frameTimings.map((frame) => frame.proxyCanvasUpdates),
      laneStats: metrics.renderer.support.mediaDecoderLanePool.final.stats,
      wallMs: metrics.renderer.wallMs,
    }, null, 2));
    console.log("proxy_tree_electron_integration: ok");
  } finally {
    await chmod(projectRoot, 0o755).catch(() => {});
    await chmod(resolve(projectRoot, "assets"), 0o755).catch(() => {});
    await rm(projectRoot, { recursive: true, force: true });
    await rm(runRoot, { recursive: true, force: true });
  }
}

await main(parseArguments(process.argv.slice(2)));
