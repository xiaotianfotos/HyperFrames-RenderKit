#!/usr/bin/env electron

import { app, BrowserWindow } from "electron";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

app.commandLine.appendSwitch("no-sandbox");
app.commandLine.appendSwitch("disable-setuid-sandbox");
app.commandLine.appendSwitch("ignore-gpu-blocklist");
app.commandLine.appendSwitch("enable-gpu-rasterization");
app.commandLine.appendSwitch("enable-zero-copy");
app.commandLine.appendSwitch("enable-native-gpu-memory-buffers");
app.commandLine.appendSwitch("force-color-profile", "srgb");
app.commandLine.appendSwitch("force-device-scale-factor", "1");
app.commandLine.appendSwitch("use-gl", "angle");
app.commandLine.appendSwitch("use-angle", "gl");
app.commandLine.appendSwitch("disable-software-rasterizer");
app.commandLine.appendSwitch("disable-background-timer-throttling");
app.commandLine.appendSwitch("disable-renderer-backgrounding");
app.commandLine.appendSwitch("disable-backgrounding-occluded-windows");
app.commandLine.appendSwitch("enable-features", [
  "CanvasDrawElement",
  "AcceleratedVideoDecoder",
  "AcceleratedVideoDecodeLinuxGL",
  "AcceleratedVideoDecodeLinuxZeroCopyGL",
].join(","));

const args = Object.fromEntries(process.argv.slice(2).filter((value) => value.startsWith("--")).map((value) => {
  const separator = value.indexOf("=");
  return separator === -1 ? [value.slice(2), true] : [value.slice(2, separator), value.slice(separator + 1)];
}));

const projectRoot = resolve(String(args.projectRoot ?? ""));
const entry = resolve(projectRoot, String(args.entry ?? "index.html"));
const runtimeMode = String(args.runtimeMode ?? "inject");
const runtimePath = args.runtime ? resolve(String(args.runtime)) : null;
const output = resolve(String(args.output ?? "hyperframes-runtime-probe.json"));
const screenshot = args.screenshot ? resolve(String(args.screenshot)) : null;
const timeoutMs = Number(args.timeoutMs ?? 20_000);
const targetTime = Number(args.time ?? 0);

if (!args.projectRoot || !["inject", "preloaded"].includes(runtimeMode)
    || (runtimeMode === "inject" && !runtimePath)
    || !Number.isFinite(timeoutMs) || timeoutMs <= 0
    || !Number.isFinite(targetTime) || targetTime < 0) {
  throw new Error("Usage: electron probe_hyperframes_runtime_injection.mjs --projectRoot=/abs/project --entry=index.html --runtimeMode=inject|preloaded [--runtime=/abs/hyperframe.runtime.iife.js] --output=/abs/result.json [--time=SECONDS] [--screenshot=/abs/frame.png]");
}

const result = {
  kind: "hyperframes-runtime-injection-probe",
  schemaVersion: 1,
  projectRoot,
  entry,
  runtimeMode,
  runtimePath,
  targetTime,
  startedAt: new Date().toISOString(),
  before: null,
  after: null,
  console: [],
  failure: null,
};

let window = null;
async function run() {
 try {
  window = new BrowserWindow({
    width: 1920,
    height: 1080,
    show: false,
    webPreferences: { contextIsolation: false, nodeIntegration: false, sandbox: false },
  });
  window.webContents.on("console-message", (_event, level, message, line, sourceId) => {
    if (result.console.length < 200) result.console.push({ level, message, line, sourceId });
  });
  await window.loadFile(entry);
  result.before = await window.webContents.executeJavaScript(`(() => ({
    nestedHosts: document.querySelectorAll('[data-composition-src],[data-composition-file]').length,
    innerRoots: document.querySelectorAll('[data-hf-inner-root]').length,
    compositionRoots: document.querySelectorAll('[data-composition-id]').length,
    timelineKeys: Object.keys(window.__timelines || {}),
    hasPlayer: !!window.__player,
    hasRuntime: !!window.__hf || !!window.__hyperframes,
  }))()`);

  if (runtimeMode === "inject") {
    const runtimeSource = readFileSync(runtimePath, "utf8");
    await window.webContents.executeJavaScript(`${runtimeSource}\n//# sourceURL=hyperframe.runtime.iife.js`);
  }
  result.after = await window.webContents.executeJavaScript(`new Promise((resolve, reject) => {
    const started = performance.now();
    const timer = setInterval(async () => {
      const player = window.__player;
      const duration = typeof player?.getDuration === 'function' ? Number(player.getDuration()) : null;
      const nestedHosts = document.querySelectorAll('[data-composition-src],[data-composition-file]').length;
      const innerRoots = document.querySelectorAll('[data-hf-inner-root]').length;
      if (duration > 0 && innerRoots >= nestedHosts) {
        clearInterval(timer);
        try {
          if (typeof player.seek === 'function') await player.seek(${JSON.stringify(targetTime)});
          if (typeof player.pause === 'function') player.pause();
          await new Promise((next) => requestAnimationFrame(() => requestAnimationFrame(next)));
        } catch (error) {
          reject(error);
          return;
        }
        resolve({
          nestedHosts,
          innerRoots,
          compositionRoots: document.querySelectorAll('[data-composition-id]').length,
          timelineKeys: Object.keys(window.__timelines || {}),
          hasPlayer: true,
          hasRuntime: !!window.__hf || !!window.__hyperframes,
          duration,
          targetTime: ${JSON.stringify(targetTime)},
          elapsedMs: performance.now() - started,
          failedAssets: performance.getEntriesByType('resource').filter((entry) => entry.duration === 0).map((entry) => entry.name),
        });
        return;
      }
      if (performance.now() - started > ${JSON.stringify(timeoutMs)}) {
        clearInterval(timer);
        reject(new Error('HyperFrames runtime readiness timeout: nested=' + nestedHosts + ', inner=' + innerRoots + ', duration=' + duration));
      }
    }, 50);
  })`);
  result.activeNestedCompositions = await window.webContents.executeJavaScript(`(() => {
    const targetTime = ${JSON.stringify(targetTime)};
    return [...document.querySelectorAll('[data-composition-src],[data-composition-file]')]
      .filter((host) => {
        const style = getComputedStyle(host);
        return style.display !== 'none' && style.visibility !== 'hidden' && Number(style.opacity) > 0;
      })
      .map((host) => {
        const inner = host.querySelector('[data-hf-inner-root]');
        const composition = inner?.querySelector('[data-composition-id]') || inner?.firstElementChild || null;
        const style = composition ? getComputedStyle(composition) : null;
        return {
          hostId: host.id,
          compositionId: host.dataset.compositionId,
          source: host.getAttribute('data-composition-src') || host.getAttribute('data-composition-file'),
          compiled: host.hasAttribute('data-composition-file'),
          start: Number(host.dataset.start || 0),
          duration: Number(host.dataset.duration || 0),
          innerChildCount: inner?.childElementCount ?? null,
          innerStyleCount: inner?.querySelectorAll('style').length ?? null,
          documentStyleCount: document.querySelectorAll('style').length,
          compositionTag: composition?.tagName ?? null,
          compositionIdObserved: composition?.id ?? null,
          computed: style ? {
            position: style.position,
            width: style.width,
            height: style.height,
            color: style.color,
            fontSize: style.fontSize,
            opacity: style.opacity,
            background: style.backgroundImage || style.backgroundColor,
          } : null,
          innerHtmlPrefix: inner?.innerHTML.slice(0, 1000) ?? null,
        };
      });
  })()`);
  result.nestedHostInventory = await window.webContents.executeJavaScript(`(() => [...document.querySelectorAll('[data-composition-src],[data-composition-file]')].map((host) => ({
    id: host.id,
    source: host.getAttribute('data-composition-src') || host.getAttribute('data-composition-file'),
    compiled: host.hasAttribute('data-composition-file'),
    startAttribute: host.getAttribute('data-start'),
    durationAttribute: host.getAttribute('data-duration'),
    datasetStart: host.dataset.start,
    datasetDuration: host.dataset.duration,
    childCount: host.childElementCount,
    display: getComputedStyle(host).display,
    visibility: getComputedStyle(host).visibility,
    opacity: getComputedStyle(host).opacity,
  })))()`);
  if (screenshot) {
    const image = await window.webContents.capturePage();
    writeFileSync(screenshot, image.toPNG(), { flag: "wx" });
    result.screenshot = screenshot;
  }
 } catch (error) {
   result.failure = { name: error?.name ?? "Error", message: error?.message ?? String(error), stack: error?.stack ?? null };
   process.exitCode = 1;
 } finally {
   result.finishedAt = new Date().toISOString();
   writeFileSync(output, `${JSON.stringify(result, null, 2)}\n`, { flag: "wx" });
   window?.destroy();
   app.exit(result.failure ? 1 : 0);
 }
}

app.whenReady().then(run, (error) => {
  result.failure = { name: error?.name ?? "Error", message: error?.message ?? String(error), stack: error?.stack ?? null };
  result.finishedAt = new Date().toISOString();
  writeFileSync(output, `${JSON.stringify(result, null, 2)}\n`, { flag: "wx" });
  app.exit(1);
});
