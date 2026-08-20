import { app, BrowserWindow } from "electron";
import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";

function withTimeout(promise, timeoutMs, stage) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${stage} timed out after ${timeoutMs}ms`)), timeoutMs);
    }),
  ]).finally(() => clearTimeout(timer));
}

function reportStage(stage) {
  process.stderr.write(`COLOR_CAPTURE_STAGE ${stage}\n`);
}

function parseArgs(argv) {
  return Object.fromEntries(argv.slice(2).filter((arg) => arg.startsWith("--")).map((arg) => {
    const [key, ...rest] = arg.slice(2).split("=");
    return [key, rest.join("=")];
  }));
}

const args = parseArgs(process.argv);
const fixture = resolve(args.fixture ?? "fixtures/color-contract/srgb-color-chart.html");
const output = resolve(args.output ?? "results/color-contract/source.png");
const width = Number(args.width ?? 1280);
const height = Number(args.height ?? 720);

if (!Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0) {
  throw new Error(`Invalid capture size ${width}x${height}`);
}

app.commandLine.appendSwitch("force-color-profile", "srgb");
app.commandLine.appendSwitch("force-device-scale-factor", "1");

let failure = null;
let window = null;
try {
  reportStage("waiting-for-app-ready");
  await withTimeout(app.whenReady(), 15_000, "Electron app ready");
  reportStage("app-ready");
  window = new BrowserWindow({
    // Wayland may not submit compositor frames for an occluded hidden window.
    // The gate needs a real surface because it validates the same capture path
    // used by production, not an offscreen software approximation.
    show: process.platform === "linux",
    frame: false,
    width,
    height,
    useContentSize: true,
    backgroundColor: "#111318",
    webPreferences: {
      backgroundThrottling: false,
      contextIsolation: true,
      sandbox: true,
    },
  });
  reportStage("loading-fixture");
  await withTimeout(window.loadFile(fixture), 15_000, "fixture load");
  reportStage("settling-paint");
  await withTimeout(window.webContents.executeJavaScript(`(async () => {
    await document.fonts.ready;
    if (window.__COLOR_CONTRACT_READY__ !== true) throw new Error("fixture not ready");
    await Promise.race([
      new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))),
      new Promise((_, reject) => setTimeout(() => reject(new Error("paint settle timed out")), 5000)),
    ]);
    return true;
  })()`), 10_000, "fixture paint settle");

  reportStage("capturing-cdp");
  window.webContents.debugger.attach("1.3");
  await withTimeout(window.webContents.debugger.sendCommand("Page.enable"), 5_000, "CDP Page.enable");
  await withTimeout(window.webContents.debugger.sendCommand("Emulation.setDeviceMetricsOverride", {
    width,
    height,
    deviceScaleFactor: 1,
    mobile: false,
  }), 5_000, "CDP device metrics");
  const shot = await withTimeout(window.webContents.debugger.sendCommand("Page.captureScreenshot", {
    format: "png",
    fromSurface: true,
    captureBeyondViewport: false,
  }), 15_000, "CDP screenshot capture");
  await writeFile(output, Buffer.from(shot.data, "base64"));
  reportStage("capture-written");
} catch (error) {
  failure = error;
  process.stderr.write(`${error?.stack ?? error}\n`);
} finally {
  if (window?.webContents?.debugger?.isAttached()) window.webContents.debugger.detach();
  if (window && !window.isDestroyed()) window.destroy();
  app.exit(failure ? 1 : 0);
}
