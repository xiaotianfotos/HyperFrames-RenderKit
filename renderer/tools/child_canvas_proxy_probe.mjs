#!/usr/bin/env electron

import { app, BrowserWindow, nativeImage } from "electron";
import { appendFileSync } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { performance } from "node:perf_hooks";
import {
  DEFAULT_CHILD_CANVAS_THRESHOLDS,
  buildProxyReplacementPlan,
  classifyDirectVideoControl,
  compareBitmaps,
  evaluateChildCanvasGate,
  makeAmplifiedDifference,
} from "./child_canvas_proxy_probe_lib.mjs";

const toolsRoot = path.dirname(fileURLToPath(import.meta.url));
const rendererRoot = path.dirname(toolsRoot);

function parseArgs(argv) {
  const values = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (!arg.startsWith("--")) continue;
    const equal = arg.indexOf("=");
    if (equal >= 0) values[arg.slice(2, equal)] = arg.slice(equal + 1);
    else if (argv[index + 1] && !argv[index + 1].startsWith("--")) values[arg.slice(2)] = argv[++index];
    else values[arg.slice(2)] = "true";
  }
  return values;
}

function numberArg(args, name, fallback) {
  if (args[name] == null) return fallback;
  const value = Number(args[name]);
  if (!Number.isFinite(value)) throw new Error(`--${name} must be a finite number`);
  return value;
}

function containedOutputDirectory(raw) {
  const candidate = path.resolve(rendererRoot, raw ?? "results/child-canvas-proxy-probe");
  const relative = path.relative(rendererRoot, candidate);
  if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error(`Output directory must stay inside ${rendererRoot}: ${candidate}`);
  }
  return candidate;
}

const args = parseArgs(process.argv.slice(2));
const outputDirectory = containedOutputDirectory(args.output);
const thresholds = {
  ...DEFAULT_CHILD_CANVAS_THRESHOLDS,
  full: {
    ...DEFAULT_CHILD_CANVAS_THRESHOLDS.full,
    maximumMeanAbsoluteError: numberArg(args, "full-mae", DEFAULT_CHILD_CANVAS_THRESHOLDS.full.maximumMeanAbsoluteError),
    maximumBadPixelFraction: numberArg(args, "full-bad-fraction", DEFAULT_CHILD_CANVAS_THRESHOLDS.full.maximumBadPixelFraction),
    minimumLumaSsim: numberArg(args, "full-ssim", DEFAULT_CHILD_CANVAS_THRESHOLDS.full.minimumLumaSsim),
  },
  feature: {
    ...DEFAULT_CHILD_CANVAS_THRESHOLDS.feature,
    maximumMeanAbsoluteError: numberArg(args, "feature-mae", DEFAULT_CHILD_CANVAS_THRESHOLDS.feature.maximumMeanAbsoluteError),
    maximumBadPixelFraction: numberArg(args, "feature-bad-fraction", DEFAULT_CHILD_CANVAS_THRESHOLDS.feature.maximumBadPixelFraction),
    minimumLumaSsim: numberArg(args, "feature-ssim", DEFAULT_CHILD_CANVAS_THRESHOLDS.feature.minimumLumaSsim),
  },
};
const stepTimeoutMs = numberArg(args, "step-timeout-ms", 15_000);
const captureTimeoutMs = numberArg(args, "capture-timeout-ms", 10_000);
const totalTimeoutMs = numberArg(args, "total-timeout-ms", 45_000);
const processStartedAt = performance.now();
const stages = [];
let stageLogReady = false;
let activeWindow = null;
let lastSupport = null;
let resultPersisted = false;
let latestChildGateResult = null;

// Keep Electron alive until the authoritative result has been atomically persisted.
// On Linux the default all-windows-closed behavior can otherwise terminate the app
// between the child-gate checkpoint and the final optional-control result.
app.on("window-all-closed", () => {});

function logStage(name, status = "begin", detail = null) {
  const entry = {
    name,
    status,
    atMs: performance.now() - processStartedAt,
    ...(detail == null ? {} : { detail }),
  };
  stages.push(entry);
  const line = `CHILD_CANVAS_PROXY_STAGE ${JSON.stringify(entry)}`;
  process.stdout.write(`${line}\n`);
  if (stageLogReady) {
    try {
      appendFileSync(path.join(outputDirectory, "stages.log"), `${line}\n`);
    } catch (error) {
      process.stderr.write(`Unable to append stages.log: ${error}\n`);
    }
  }
  return entry;
}

async function withTimeout(label, work, timeoutMs = stepTimeoutMs) {
  logStage(label, "begin", { timeoutMs });
  let timer;
  const startedAt = performance.now();
  try {
    const value = await Promise.race([
      Promise.resolve().then(work),
      new Promise((_, reject) => {
        timer = setTimeout(() => {
          const error = new Error(`Stage ${label} timed out after ${timeoutMs}ms`);
          error.code = "PROBE_STAGE_TIMEOUT";
          error.stage = label;
          reject(error);
        }, timeoutMs);
      }),
    ]);
    logStage(label, "complete", { wallMs: performance.now() - startedAt });
    return value;
  } catch (error) {
    logStage(label, "failed", {
      wallMs: performance.now() - startedAt,
      error: error?.message ?? String(error),
    });
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

async function writeResultDocument(result) {
  const enriched = {
    ...result,
    stages: [...stages],
    lastStage: stages.at(-1) ?? null,
  };
  const resultPath = path.join(outputDirectory, "result.json");
  const temporary = path.join(outputDirectory, `result.json.tmp-${process.pid}-${Date.now()}`);
  try {
    await fs.writeFile(temporary, `${JSON.stringify(enriched, null, 2)}\n`);
    await fs.rename(temporary, resultPath);
  } catch (error) {
    process.stderr.write(`Atomic result write failed: ${error?.stack ?? error}\n`);
    await fs.writeFile(resultPath, `${JSON.stringify(enriched, null, 2)}\n`);
  }
  return resultPath;
}

async function persistResult(result) {
  if (resultPersisted) return path.join(outputDirectory, "result.json");
  resultPersisted = true;
  return writeResultDocument(result);
}

async function checkpointChildGate(result) {
  logStage("child-canvas:checkpoint-result", "begin", {
    pass: result.childCanvasGate?.pass === true,
  });
  const resultPath = await writeResultDocument({
    ...result,
    status: "child-gate-complete-control-pending",
  });
  logStage("child-canvas:checkpoint-result", "complete", { resultPath });
  return resultPath;
}

function preserveChildGateWithUnavailableControl(childGateResult, error, {
  failureStage = error?.stage ?? stages.at(-1)?.name ?? "direct-video",
  wallMs = performance.now() - processStartedAt,
} = {}) {
  return {
    ...childGateResult,
    status: "complete-with-control-unavailable",
    directVideo: null,
    directVideoControl: {
      classification: "control-unavailable",
      failure: error?.stack ?? String(error),
      failureCode: error?.code ?? null,
      failureStage,
      interpretation: "The optional direct-video control failed; the completed child-canvas pixel gate remains authoritative",
    },
    wallMs,
  };
}

app.commandLine.appendSwitch("no-sandbox");
app.commandLine.appendSwitch("disable-setuid-sandbox");
app.commandLine.appendSwitch("ignore-gpu-blocklist");
app.commandLine.appendSwitch("enable-gpu-rasterization");
app.commandLine.appendSwitch("enable-zero-copy");
app.commandLine.appendSwitch("enable-native-gpu-memory-buffers");
app.commandLine.appendSwitch("force-color-profile", "srgb");
app.commandLine.appendSwitch("force-device-scale-factor", "1");
app.commandLine.appendSwitch("autoplay-policy", "no-user-gesture-required");
app.commandLine.appendSwitch("disable-background-timer-throttling");
app.commandLine.appendSwitch("disable-renderer-backgrounding");
app.commandLine.appendSwitch("disable-backgrounding-occluded-windows");
app.commandLine.appendSwitch("enable-features", "CanvasDrawElement,AcceleratedVideoDecoder");
app.commandLine.appendSwitch("enable-blink-features", "CanvasDrawElement");
if (args.angle) {
  app.commandLine.appendSwitch("use-gl", "angle");
  app.commandLine.appendSwitch("use-angle", args.angle);
}

function assertImageSize(image, width, height, name) {
  const size = image.getSize();
  if (size.width !== width || size.height !== height) {
    throw new Error(`${name} is ${size.width}x${size.height}; expected ${width}x${height}. Check device scale factor.`);
  }
}

async function writeImage(file, image) {
  await fs.writeFile(path.join(outputDirectory, file), image.toPNG());
}

async function writeDifference(file, reference, candidate, width, height) {
  const bitmap = makeAmplifiedDifference(reference, candidate, width, height, 4);
  const image = nativeImage.createFromBitmap(bitmap, { width, height, scaleFactor: 1 });
  await writeImage(file, image);
}

async function captureCase(window, name) {
  const prepared = await withTimeout(
    `${name}:execute:prepareCase`,
    () => window.webContents.executeJavaScript(
      `window.childCanvasProxyProbe.prepareCase(${JSON.stringify(name)})`,
      true,
    ),
  );
  logStage(`${name}:layout`, "info", prepared.layout ?? {
    goldenRect: prepared.goldenRect,
    paintReason: prepared.paintReason,
  });
  if (prepared.goldenRect?.width !== 640 || prepared.goldenRect?.height !== 480) {
    throw new Error(`${name} golden root did not lay out at 640x480: ${JSON.stringify(prepared.goldenRect)}`);
  }
  if (prepared.layout?.targetConnected !== true
    || prepared.layout?.targetParentTag !== "CANVAS"
    || prepared.layout?.targetRect?.width !== 640
    || prepared.layout?.targetRect?.height !== 480) {
    throw new Error(`${name} canvas fallback child layout is invalid: ${JSON.stringify(prepared.layout)}`);
  }
  const goldenImage = await withTimeout(
    `${name}:capturePage`,
    () => window.webContents.capturePage(prepared.goldenRect),
    captureTimeoutMs,
  );
  const captured = await withTimeout(
    `${name}:execute:captureTarget`,
    () => window.webContents.executeJavaScript("window.childCanvasProxyProbe.captureTarget()", true),
  );
  const drawElementImage = nativeImage.createFromDataURL(captured.dataUrl);
  const { width, height } = prepared.goldenRect;
  assertImageSize(goldenImage, width, height, `${name} capturePage golden`);
  assertImageSize(drawElementImage, width, height, `${name} drawElementImage result`);
  const goldenBitmap = goldenImage.toBitmap({ scaleFactor: 1 });
  const drawBitmap = drawElementImage.toBitmap({ scaleFactor: 1 });
  const fullMetric = compareBitmaps(goldenBitmap, drawBitmap, width, height, {
    badPixelChannelDelta: thresholds.badPixelChannelDelta,
  });
  const featureMetrics = prepared.featureRegions.map((region) => compareBitmaps(
    goldenBitmap,
    drawBitmap,
    width,
    height,
    { region, badPixelChannelDelta: thresholds.badPixelChannelDelta },
  ));
  await withTimeout(`${name}:write-artifacts`, async () => {
    await writeImage(`${name}.capture-page-golden.png`, goldenImage);
    await writeImage(`${name}.draw-element-image.png`, drawElementImage);
    await writeDifference(`${name}.difference-x4.png`, goldenBitmap, drawBitmap, width, height);
  });
  return {
    name,
    prepared,
    capture: {
      drawElementImageMs: captured.drawElementImageMs,
      paintReason: captured.paintReason,
    },
    fullMetric,
    featureMetrics,
  };
}

async function run() {
  await fs.mkdir(outputDirectory, { recursive: true });
  stageLogReady = true;
  logStage("run", "begin", {
    outputDirectory,
    showWindow: args.show !== "false",
    stepTimeoutMs,
    captureTimeoutMs,
    totalTimeoutMs,
  });
  const startedAt = performance.now();
  let window = null;
  let result;
  try {
    window = new BrowserWindow({
      width: 1340,
      height: 520,
      useContentSize: true,
      // Wayland may not submit compositor frames for a never-shown window. Default to
      // visible for this pixel probe; --show=false remains available for diagnostics.
      show: args.show !== "false",
      backgroundColor: "#080b12",
      webPreferences: {
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        backgroundThrottling: false,
      },
    });
    activeWindow = window;
    window.on("unresponsive", () => logStage("browser-window", "unresponsive"));
    window.on("responsive", () => logStage("browser-window", "responsive"));
    window.on("closed", () => logStage("browser-window", "closed"));
    window.webContents.on("render-process-gone", (_event, details) => {
      logStage("renderer-process", "gone", details);
    });
    window.webContents.on("did-fail-load", (_event, code, description, url, isMainFrame) => {
      logStage("page-load", "did-fail-load", { code, description, url, isMainFrame });
    });
    window.webContents.on("console-message", (_event, details) => {
      const message = typeof details === "object" ? details.message : String(details ?? "");
      if (message) logStage("page-console", "info", { message });
    });

    await withTimeout(
      "window:loadFile",
      () => window.loadFile(path.join(toolsRoot, "child_canvas_proxy_probe.html")),
    );
    if (args.show !== "false") window.showInactive();
    const support = await withTimeout(
      "page:ready-and-support",
      () => window.webContents.executeJavaScript("window.__childCanvasProxyProbeReady", true),
    );
    lastSupport = support;
    const initialDiagnostics = await withTimeout(
      "page:initial-diagnostics",
      () => window.webContents.executeJavaScript("window.childCanvasProxyProbe.diagnostics()", true),
    );
    logStage("page:initial-diagnostics", "info", initialDiagnostics);
    const base = {
      schemaVersion: "0.1.0",
      createdAt: new Date().toISOString(),
      electron: process.versions,
      platform: { platform: process.platform, arch: process.arch },
      support,
      gpuFeatureStatus: app.getGPUFeatureStatus(),
      thresholds,
      outputDirectory,
      timeoutPolicy: { stepTimeoutMs, captureTimeoutMs, totalTimeoutMs },
      initialDiagnostics,
    };
    if (!support.drawElementImage || !support.requestPaint) {
      result = {
        ...base,
        childCanvasGate: {
          pass: false,
          reason: !support.drawElementImage ? "drawElementImage-unavailable" : "requestPaint-unavailable",
        },
        directVideoControl: null,
        replacementPlan: { eligible: false, reason: "html-in-canvas-capability-unavailable", steps: [] },
        wallMs: performance.now() - startedAt,
      };
    } else {
      const childCanvas = await captureCase(window, "child-canvas");
      const childCanvasGate = evaluateChildCanvasGate({
        fullMetric: childCanvas.fullMetric,
        featureMetrics: childCanvas.featureMetrics,
        support,
        thresholds,
      });
      const replacementPlan = buildProxyReplacementPlan({
        videoDescriptor: {
          source: "RenderPlan-selected media source",
          attributes: {
            id: "original-video-id",
            class: "original class list",
            style: "original inline style",
            "data-start": "original timing",
            "data-duration": "original timing",
            "data-track-index": "original track",
            "data-media-start": "original media offset",
          },
        },
        childCanvasGate,
      });
      const childGateResult = {
        ...base,
        childCanvas,
        childCanvasGate,
        directVideo: null,
        directVideoControl: { classification: "control-pending" },
        replacementPlan,
        hardDecision: childCanvasGate.pass
          ? "child-canvas-proxy-candidate"
          : "reject-child-canvas-proxy-use-screenshot-fallback",
        wallMs: performance.now() - startedAt,
      };
      latestChildGateResult = childGateResult;
      await checkpointChildGate(childGateResult);

      let directVideo = null;
      let directVideoControl;
      try {
        logStage("direct-video:optional-control", "begin");
        directVideo = await captureCase(window, "direct-video");
        directVideoControl = classifyDirectVideoControl(directVideo.fullMetric, { thresholds });
        logStage("direct-video:optional-control", "complete", {
          classification: directVideoControl.classification,
        });
      } catch (controlError) {
        const preserved = preserveChildGateWithUnavailableControl(childGateResult, controlError, {
          wallMs: performance.now() - startedAt,
        });
        directVideo = preserved.directVideo;
        directVideoControl = preserved.directVideoControl;
        logStage("direct-video:optional-control", "failed-optional", {
          error: controlError?.message ?? String(controlError),
          stage: directVideoControl.failureStage,
        });
      }
      result = {
        ...childGateResult,
        status: directVideoControl.classification === "control-unavailable"
          ? "complete-with-control-unavailable"
          : "complete",
        directVideo: directVideo == null ? null : {
          capture: directVideo.capture,
          fullMetric: directVideo.fullMetric,
        },
        directVideoControl,
        wallMs: performance.now() - startedAt,
      };
      latestChildGateResult = result;
    }
  } catch (error) {
    const failureStage = error?.stage ?? stages.at(-1)?.name ?? null;
    logStage("run", "failed", {
      error: error?.message ?? String(error),
      code: error?.code ?? null,
      stage: error?.stage ?? null,
    });
    if (latestChildGateResult) {
      result = preserveChildGateWithUnavailableControl(latestChildGateResult, error, {
        failureStage,
        wallMs: performance.now() - startedAt,
      });
    } else {
      result = {
        schemaVersion: "0.1.0",
        createdAt: new Date().toISOString(),
        electron: process.versions,
        outputDirectory,
        support: lastSupport,
        timeoutPolicy: { stepTimeoutMs, captureTimeoutMs, totalTimeoutMs },
        failure: error?.stack ?? String(error),
        failureCode: error?.code ?? null,
        failureStage,
        childCanvasGate: { pass: false, reason: "probe-failure" },
        wallMs: performance.now() - startedAt,
      };
    }
  } finally {
    if (window?.isDestroyed()) activeWindow = null;
  }
  return result;
}

app.whenReady().then(async () => {
  await fs.mkdir(outputDirectory, { recursive: true });
  await fs.writeFile(path.join(outputDirectory, "stages.log"), "");
  await fs.writeFile(path.join(outputDirectory, "result.json"), `${JSON.stringify({
    schemaVersion: "0.1.0",
    status: "running",
    createdAt: new Date().toISOString(),
    outputDirectory,
    timeoutPolicy: { stepTimeoutMs, captureTimeoutMs, totalTimeoutMs },
  }, null, 2)}\n`);
  stageLogReady = true;
  const watchdog = setTimeout(async () => {
    const childGateCompleted = latestChildGateResult != null;
    logStage("global-watchdog", childGateCompleted ? "failed-optional" : "failed", {
      totalTimeoutMs,
      childGateCompleted,
    });
    const timeoutError = new Error(`Global probe watchdog expired after ${totalTimeoutMs}ms`);
    timeoutError.code = "PROBE_GLOBAL_TIMEOUT";
    timeoutError.stage = "global-watchdog";
    const emergencyResult = latestChildGateResult
      ? preserveChildGateWithUnavailableControl(latestChildGateResult, timeoutError, {
        failureStage: "global-watchdog",
      })
      : {
        schemaVersion: "0.1.0",
        createdAt: new Date().toISOString(),
        electron: process.versions,
        outputDirectory,
        support: lastSupport,
        timeoutPolicy: { stepTimeoutMs, captureTimeoutMs, totalTimeoutMs },
        failure: timeoutError.stack,
        failureCode: timeoutError.code,
        failureStage: timeoutError.stage,
        childCanvasGate: { pass: false, reason: "global-timeout" },
        wallMs: performance.now() - processStartedAt,
      };
    const resultPath = await persistResult(emergencyResult);
    process.stdout.write(`CHILD_CANVAS_PROXY_RESULT ${JSON.stringify({
      resultPath,
      pass: emergencyResult.childCanvasGate?.pass === true,
      directVideo: emergencyResult.directVideoControl?.classification ?? null,
      failure: emergencyResult.failure ?? null,
    })}\n`);
    activeWindow?.destroy();
    activeWindow = null;
    app.exit(latestChildGateResult
      ? (emergencyResult.childCanvasGate?.pass === true ? 0 : 2)
      : 1);
  }, totalTimeoutMs);
  const result = await run();
  clearTimeout(watchdog);
  logStage("run", "complete", {
    pass: result.childCanvasGate?.pass === true,
    wallMs: result.wallMs,
  });
  const resultPath = await persistResult(result);
  process.stdout.write(`CHILD_CANVAS_PROXY_RESULT ${JSON.stringify({
    resultPath,
    pass: result.childCanvasGate?.pass === true,
    directVideo: result.directVideoControl?.classification ?? null,
    failure: result.failure ?? null,
  })}\n`);
  activeWindow?.destroy();
  activeWindow = null;
  app.exit(result.childCanvasGate?.pass === true ? 0 : result.failure ? 1 : 2);
}).catch(async (error) => {
  await fs.mkdir(outputDirectory, { recursive: true });
  stageLogReady = true;
  logStage("app-startup", "failed", { error: error?.message ?? String(error) });
  const result = {
    schemaVersion: "0.1.0",
    createdAt: new Date().toISOString(),
    electron: process.versions,
    outputDirectory,
    timeoutPolicy: { stepTimeoutMs, captureTimeoutMs, totalTimeoutMs },
    failure: error?.stack ?? String(error),
    failureCode: error?.code ?? null,
    failureStage: error?.stage ?? stages.at(-1)?.name ?? "app-startup",
    childCanvasGate: { pass: false, reason: "app-startup-failure" },
    wallMs: performance.now() - processStartedAt,
  };
  await persistResult(result);
  activeWindow?.destroy();
  activeWindow = null;
  process.stderr.write(`${error?.stack ?? error}\n`);
  app.exit(1);
});
