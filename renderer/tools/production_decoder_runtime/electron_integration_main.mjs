#!/usr/bin/env node

import { app, BrowserWindow, ipcMain } from "electron";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import {
  createProductionDecoderMainBridge,
  createProductionDemuxBroker,
  serializeProductionDecoderError,
} from "./main.mjs";

const directory = path.dirname(fileURLToPath(import.meta.url));
const rendererRoot = path.resolve(directory, "../..");

function parseArguments(argv) {
  const options = {};
  for (const argument of argv) {
    if (!argument.startsWith("--")) continue;
    const separator = argument.indexOf("=");
    options[argument.slice(2, separator === -1 ? undefined : separator)] =
      separator === -1 ? "true" : argument.slice(separator + 1);
  }
  return options;
}

function withinLab(filePath, label) {
  const resolved = path.resolve(rendererRoot, filePath);
  const relative = path.relative(rendererRoot, resolved);
  if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error(`${label} must remain inside the renderkit: ${resolved}`);
  }
  return resolved;
}

function buildRequestPlan(frames) {
  const ordinals = [];
  const addRange = (start, end) => {
    for (let ordinal = start; ordinal <= end; ordinal += 1) ordinals.push(ordinal);
  };
  addRange(0, 19);
  ordinals.push(19, 19);
  addRange(20, 29);
  ordinals.push(75);
  addRange(76, 82);
  ordinals.push(12);
  addRange(13, 20);
  addRange(60, 70);
  if (ordinals.length !== 60) throw new Error(`Integration request plan is ${ordinals.length}, expected 60`);
  return ordinals.map((ordinal) => ({ ordinal, ptsUs: frames[ordinal].ptsUs }));
}

function withTimeout(promise, timeoutMs) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`Electron integration timed out after ${timeoutMs}ms`)), timeoutMs);
    }),
  ]).finally(() => clearTimeout(timer));
}

const options = parseArguments(process.argv.slice(2));
const fixtureManifestPath = withinLab(
  options.fixture ?? "results/deterministic-decoder-poc/fixture/fixture.json",
  "fixture",
);
const outputPath = withinLab(
  options.output ?? "results/deterministic-decoder-poc/production-runtime-electron.json",
  "output",
);
const fixture = JSON.parse(await readFile(fixtureManifestPath, "utf8"));
const sourcePath = withinLab(path.resolve(path.dirname(fixtureManifestPath), fixture.source.file), "fixture source");
const sourceIdentity = `sha256:${fixture.source.sha256}`;
const requests = buildRequestPlan(fixture.presentationPlan.frames);
const triple = [30, 90, 30].map((ordinal) => ({
  ordinal,
  ptsUs: fixture.presentationPlan.frames[ordinal].ptsUs,
}));
const sourceToken = "production-runtime-fixture";
const broker = createProductionDemuxBroker({
  maximumBatchPackets: 8,
  maximumBatchBytes: 8 * 1024 * 1024,
  maximumGlobalDemuxBytes: 32 * 1024 * 1024,
  maximumOpenCursors: 4,
});
const bridge = createProductionDecoderMainBridge({
  broker,
  async resolveSource(request) {
    if (request.sourceToken !== sourceToken || request.sourceIdentity !== sourceIdentity) {
      throw new Error("Renderer requested an unapproved integration source");
    }
    return { filePath: sourcePath, sourceIdentity };
  },
});

const channel = (name) => `hf:production-decoder:${name}`;
const handlers = new Map([
  ["open-source", bridge.decoderOpenSource],
  ["resolve-target", bridge.decoderResolveTarget],
  ["begin-cursor", bridge.decoderBeginCursor],
  ["next-batch", bridge.decoderNextBatch],
  ["ack-batch", bridge.decoderAckBatch],
  ["release-cursor", bridge.decoderReleaseCursor],
  ["close-source", bridge.decoderCloseSource],
  ["stats", bridge.decoderStats],
]);
for (const [name, handler] of handlers) {
  ipcMain.handle(channel(name), (_event, request) => handler(request));
}
ipcMain.handle(channel("integration-config"), () => ({
  sourceIdentity,
  sourceToken,
  requests,
  triple,
  runtimeLimits: {
    decodeQueueMax: 4,
    decodeLeadMax: 4,
    readyFramesMax: 4,
    maxWarmAdvanceFrames: 12,
    maxTotalLanes: 4,
    maxLanesPerSource: 2,
    idleUnloadFrames: 120,
    batchSize: 8,
  },
}));

app.commandLine.appendSwitch("disable-renderer-backgrounding");
app.commandLine.appendSwitch("disable-background-timer-throttling");

async function runAfterReady() {
  let exitCode = 1;
  let result;
  let integrationWindow = null;
  try {
    integrationWindow = new BrowserWindow({
      width: 640,
      height: 360,
      show: false,
      webPreferences: {
        preload: path.resolve(directory, "electron_integration_preload.cjs"),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: false,
        backgroundThrottling: false,
      },
    });
    const rendererResult = new Promise((resolve, reject) => {
      ipcMain.once(channel("integration-result"), (_event, value) => resolve(value));
      ipcMain.once(channel("integration-error"), (_event, error) => {
        reject(Object.assign(new Error(error?.message ?? "Renderer integration failed"), error));
      });
      integrationWindow.webContents.once("render-process-gone", (_event, details) => {
        reject(new Error(`Renderer process exited: ${details.reason} (${details.exitCode})`));
      });
    });
    await integrationWindow.loadFile(path.resolve(directory, "electron_integration.html"));
    result = await withTimeout(rendererResult, Number(options.timeoutMs ?? 60_000));
    result.mainFinalMetrics = broker.snapshot();
    exitCode = result.status === "pass" ? 0 : result.status === "canonical-cache-required" ? 2 : 1;
  } catch (error) {
    result = {
      schemaVersion: "1.0.0",
      status: "failed",
      error: serializeProductionDecoderError(error),
      mainFinalMetrics: broker.snapshot(),
    };
    exitCode = 1;
  } finally {
    if (integrationWindow && !integrationWindow.isDestroyed()) integrationWindow.destroy();
    try {
      await broker.dispose();
      result.afterMainDisposeMetrics = broker.snapshot();
    } catch (error) {
      result.cleanupError = serializeProductionDecoderError(error);
      exitCode = 1;
    }
    await writeFile(outputPath, `${JSON.stringify(result, null, 2)}\n`);
    process.stdout.write(`${JSON.stringify(result)}\n`);
    app.exit(exitCode);
  }
}

app.whenReady().then(runAfterReady);
