#!/usr/bin/env node

import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

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

function run(command, args, { capture = false, env = process.env } = {}) {
  return new Promise((resolveRun, rejectRun) => {
    const child = spawn(command, args, {
      stdio: ["ignore", capture ? "pipe" : "inherit", capture ? "pipe" : "inherit"],
      env,
    });
    let stdout = "";
    let stderr = "";
    if (capture) {
      child.stdout.setEncoding("utf8");
      child.stderr.setEncoding("utf8");
      child.stdout.on("data", (chunk) => { stdout += chunk; });
      child.stderr.on("data", (chunk) => { stderr += chunk; });
    }
    child.once("error", rejectRun);
    child.once("close", (code) => resolveRun({ code, stdout, stderr }));
  });
}

async function electronRendererTest(targetSeconds) {
  const video = document.querySelector("video");
  const waitForEvent = (event) => new Promise((resolveEvent, rejectEvent) => {
    const timer = setTimeout(() => rejectEvent(new Error(`${event} timeout`)), 10_000);
    video.addEventListener(event, () => {
      clearTimeout(timer);
      resolveEvent();
    }, { once: true });
    video.addEventListener("error", () => {
      clearTimeout(timer);
      rejectEvent(new Error(video.error?.message || "video error"));
    }, { once: true });
  });
  if (video.readyState < HTMLMediaElement.HAVE_CURRENT_DATA) await waitForEvent("loadeddata");
  const waitForCurrentData = () => new Promise((resolveData, rejectData) => {
    if (video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA) {
      resolveData();
      return;
    }
    let poll = null;
    let timer = null;
    const events = ["seeked", "canplay", "loadeddata"];
    const cleanup = () => {
      clearTimeout(timer);
      clearInterval(poll);
      for (const event of events) video.removeEventListener(event, check);
    };
    const check = () => {
      if (video.error) {
        cleanup();
        rejectData(new Error(video.error.message || "video error"));
      } else if (video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA) {
        cleanup();
        resolveData();
      }
    };
    for (const event of events) video.addEventListener(event, check);
    poll = setInterval(check, 10);
    timer = setTimeout(() => {
      cleanup();
      rejectData(new Error(`HAVE_CURRENT_DATA timeout: ready=${video.readyState} seeking=${video.seeking}`));
    }, 10_000);
    queueMicrotask(check);
  });
  const bootstrap = await new Promise((resolveFrame, rejectFrame) => {
    const timer = setTimeout(() => rejectFrame(new Error("bootstrap rVFC timeout")), 10_000);
    video.requestVideoFrameCallback((_now, metadata) => {
      clearTimeout(timer);
      video.pause();
      resolveFrame(metadata.mediaTime);
    });
    video.playbackRate = 0.5;
    video.play().catch(rejectFrame);
  });

  const expected = targetSeconds;
  const tolerance = 1e-6;
  const seekTarget = expected + 4e-6;
  const history = [];
  const result = await new Promise((resolveFrame, rejectFrame) => {
    let callbackId = 0;
    let settled = false;
    const timer = setTimeout(() => finish(new Error(`planned seek timeout: ${JSON.stringify(history)}`)), 10_000);
    const finish = (error, value = null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (callbackId) video.cancelVideoFrameCallback?.(callbackId);
      video.pause();
      if (error) rejectFrame(error);
      else resolveFrame(value);
    };
    const requestNext = () => { callbackId = video.requestVideoFrameCallback(onFrame); };
    const onFrame = (_now, metadata) => {
      const decision = window.HyperframesMediaTiming.classifyPresentedFrame({
        expected,
        tolerance,
        mediaTime: metadata.mediaTime,
        seeking: video.seeking,
        paused: video.paused,
      });
      history.push({
        mediaTime: metadata.mediaTime,
        seeking: video.seeking,
        paused: video.paused,
        readyState: video.readyState,
        status: decision.status,
      });
      if (decision.status === "exact") {
        video.pause();
        const complete = () => finish(null, {
          mediaTime: metadata.mediaTime,
          decision,
          history,
          settledReadyState: video.readyState,
          settledSeeking: video.seeking,
        });
        if (video.seeking || video.readyState < HTMLMediaElement.HAVE_CURRENT_DATA) {
          waitForCurrentData().then(complete, finish);
        } else {
          complete();
        }
        return;
      }
      if (decision.status === "waiting-for-seek" || decision.status === "stale-before-target") {
        requestNext();
        if (decision.play) {
          video.playbackRate = 0.5;
          video.play().catch(finish);
        }
        return;
      }
      finish(new Error(`unexpected presentation: ${JSON.stringify(history)}`));
    };
    requestNext();
    video.pause();
    video.currentTime = seekTarget;
  });
  return {
    passed: true,
    bootstrap,
    expected,
    seekTarget,
    result,
    finalSeeking: video.seeking,
    finalPaused: video.paused,
  };
}

async function runInsideElectron(options) {
  const { app, BrowserWindow } = await import("electron");
  app.commandLine.appendSwitch("no-sandbox");
  app.commandLine.appendSwitch("disable-background-timer-throttling");
  app.commandLine.appendSwitch("disable-renderer-backgrounding");
  app.commandLine.appendSwitch("disable-backgrounding-occluded-windows");
  let exitCode = 1;
  try {
    await app.whenReady();
    const window = new BrowserWindow({
      show: false,
      paintWhenInitiallyHidden: true,
      webPreferences: {
        sandbox: false,
        contextIsolation: false,
        nodeIntegration: false,
        backgroundThrottling: false,
        autoplayPolicy: "no-user-gesture-required",
        webSecurity: false,
      },
    });
    await window.loadFile(resolve(options.html));
    const runtimeSource = await readFile(resolve(rendererRoot, "media-timing-runtime.js"), "utf8");
    const result = await window.webContents.executeJavaScript(
      `${runtimeSource}\n(${electronRendererTest.toString()})(${Number(options.target)})`,
    );
    console.log(`ELECTRON_RVFC_RESULT ${JSON.stringify(result)}`);
    exitCode = result.passed ? 0 : 1;
    window.destroy();
  } catch (error) {
    console.error(`ELECTRON_RVFC_FAILURE ${error?.stack || error}`);
  } finally {
    app.exit(exitCode);
  }
}

async function runWrapper(options) {
  const electron = options.electron || process.env.ELECTRON_BINARY;
  if (!electron) {
    throw new Error("Pass --electron=/absolute/path/to/electron or set ELECTRON_BINARY");
  }
  const fixtureRoot = await mkdtemp(join(tmpdir(), "electron-rvfc-seek-"));
  try {
    const videoPath = resolve(fixtureRoot, "seek-source.mp4");
    const htmlPath = resolve(fixtureRoot, "fixture.html");
    const ffmpeg = await run("ffmpeg", [
      "-v", "error", "-y",
      "-f", "lavfi", "-i", "testsrc2=size=320x180:rate=60:duration=6",
      "-c:v", "libx264", "-bf", "2", "-g", "120", "-pix_fmt", "yuv420p",
      "-video_track_timescale", "60000",
      videoPath,
    ]);
    if (ffmpeg.code !== 0) throw new Error(`ffmpeg fixture generation exited ${ffmpeg.code}`);
    await writeFile(htmlPath, [
      "<!doctype html><meta charset=\"utf-8\">",
      `<video muted playsinline preload="auto" src="${pathToFileURL(videoPath).href}"></video>`,
    ].join("\n"));
    const childEnv = { ...process.env };
    delete childEnv.ELECTRON_RUN_AS_NODE;
    const result = await run(resolve(electron), [
      toolPath,
      "--fixture-mode=true",
      `--html=${htmlPath}`,
      `--target=${options.target ?? "3.4"}`,
      "--no-sandbox",
    ], { capture: true, env: childEnv });
    const output = `${result.stdout}\n${result.stderr}`;
    const match = output.match(/ELECTRON_RVFC_RESULT (\{.*\})/);
    if (result.code !== 0 || !match) {
      throw new Error(`Electron integration exited ${result.code}:\n${output}`);
    }
    const parsed = JSON.parse(match[1]);
    if (!parsed.passed || Math.abs(parsed.result.mediaTime - parsed.expected) > 1e-6) {
      throw new Error(`Electron returned an unverified frame: ${JSON.stringify(parsed)}`);
    }
    console.log(JSON.stringify(parsed, null, 2));
    console.log("Electron rVFC seek integration test passed");
  } finally {
    await rm(fixtureRoot, { recursive: true, force: true });
  }
}

const options = parseArguments(process.argv.slice(2));
if (process.versions.electron && options["fixture-mode"] === "true") {
  await runInsideElectron(options);
} else {
  await runWrapper(options);
}
