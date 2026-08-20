#!/usr/bin/env electron

import { app, BrowserWindow } from "electron";
import {
  existsSync,
  readFileSync,
  realpathSync,
} from "node:fs";
import {
  mkdir,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { hostname, release } from "node:os";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import process from "node:process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parse } from "parse5";
import { transformProxyTreeHtml } from "../proxy_tree_transformer.mjs";
import { transformScreenshotHtml } from "../screenshot_entry_transformer.mjs";
import {
  buildScreenshotAuditEvidence,
  compareBitmaps,
  compileDetailedPlan,
  compileOracleOnlyPlan,
  rendererRoot,
  loadPlanRuntime,
  riskProfileKey,
  sha256,
  signatureIsFastProofEligible,
  uniqueGoldenFrames,
} from "./lib.mjs";

const moduleRoot = dirname(fileURLToPath(import.meta.url));

function parseArgs(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (!argument.startsWith("--")) continue;
    const split = argument.indexOf("=");
    const rawKey = argument.slice(2, split < 0 ? undefined : split);
    const key = rawKey.replace(/-([a-z])/g, (_match, character) => character.toUpperCase());
    if (split >= 0) options[key] = argument.slice(split + 1);
    else if (argv[index + 1] && !argv[index + 1].startsWith("--")) options[key] = argv[++index];
    else options[key] = "true";
  }
  return options;
}

function positiveInteger(value, name, fallback = null) {
  const parsed = value == null ? fallback : Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1) throw new Error(`${name} must be a positive integer`);
  return parsed;
}

function nonNegativeInteger(value, name, fallback = null) {
  const parsed = value == null ? fallback : Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) throw new Error(`${name} must be a non-negative integer`);
  return parsed;
}

function finiteNumber(value, name, fallback = null) {
  const parsed = value == null ? fallback : Number(value);
  if (!Number.isFinite(parsed)) throw new Error(`${name} must be finite`);
  return parsed;
}

function inside(root, candidate) {
  const path = relative(root, candidate);
  return path === "" || (!path.startsWith("..") && !isAbsolute(path));
}

function resolveExistingInside(projectRoot, value, name) {
  const candidate = resolve(projectRoot, value);
  if (!existsSync(candidate)) throw new Error(`${name} does not exist: ${candidate}`);
  const real = realpathSync(candidate);
  if (!inside(projectRoot, real)) throw new Error(`${name} escapes the real project root: ${real}`);
  return real;
}

function resolveOutputInside(projectRoot, value, name) {
  const candidate = resolve(projectRoot, value);
  if (!inside(projectRoot, candidate)) throw new Error(`${name} escapes the project root: ${candidate}`);
  let ancestor = dirname(candidate);
  while (!existsSync(ancestor)) {
    const parent = dirname(ancestor);
    if (parent === ancestor) break;
    ancestor = parent;
  }
  const realAncestor = realpathSync(ancestor);
  if (!inside(projectRoot, realAncestor)) throw new Error(`${name} parent escapes through a symlink: ${realAncestor}`);
  return candidate;
}

function compositionMetadata(entryPath) {
  const document = parse(readFileSync(entryPath, "utf8"));
  const roots = [];
  const walk = (node) => {
    if (node.tagName && node.attrs?.some((attribute) => attribute.name === "data-composition-id")) roots.push(node);
    for (const child of node.childNodes ?? []) walk(child);
    if (node.content) walk(node.content);
  };
  walk(document);
  if (roots.length !== 1) throw new Error(`entry must declare exactly one composition root; found ${roots.length}`);
  const attributes = Object.fromEntries(roots[0].attrs.map((attribute) => [attribute.name, attribute.value]));
  return {
    compositionId: attributes["data-composition-id"],
    width: Number(attributes["data-width"] || 0) || null,
    height: Number(attributes["data-height"] || 0) || null,
    duration: Number(attributes["data-duration"] || 0) || null,
  };
}

function safeAsciiIdentity(value, name) {
  if (value == null) return null;
  const normalized = String(value).trim();
  if (!normalized || normalized.length > 512 || /[^\x20-\x7e]/.test(normalized)) {
    throw new Error(`${name} must be 1-512 printable ASCII characters`);
  }
  return normalized;
}

function sha256Identity(value, name) {
  const normalized = safeAsciiIdentity(value, name);
  if (normalized != null && !/^sha256:[a-f0-9]{64}$/.test(normalized)) {
    throw new Error(`${name} must use the exact sha256:<64 lowercase hex> form`);
  }
  return normalized;
}

function loadIntrinsicMap(projectRoot, manifestPath) {
  if (!manifestPath) return null;
  const path = resolveExistingInside(projectRoot, manifestPath, "intrinsicMap");
  const manifest = JSON.parse(readFileSync(path, "utf8"));
  const entries = Array.isArray(manifest) ? manifest : manifest.entries;
  if (!Array.isArray(entries)) throw new Error("intrinsicMap must be an array or {entries: []}");
  const result = new Map();
  for (const [index, entry] of entries.entries()) {
    const rawSource = entry.sourceUrl ?? entry.source;
    if (!rawSource) throw new Error(`intrinsicMap[${index}] is missing source/sourceUrl`);
    const sourceUrl = String(rawSource).startsWith("file:")
      ? String(rawSource)
      : pathToFileURL(resolve(projectRoot, rawSource)).href;
    const width = entry.width ?? entry.plan?.stream?.width;
    const height = entry.height ?? entry.plan?.stream?.height;
    if (result.has(sourceUrl)) {
      const previous = result.get(sourceUrl);
      if (previous.width !== Number(width) || previous.height !== Number(height)) {
        throw new Error(`intrinsicMap has conflicting dimensions for ${sourceUrl}`);
      }
      continue;
    }
    result.set(sourceUrl, {
      width: positiveInteger(width, `intrinsicMap[${index}].width`),
      height: positiveInteger(height, `intrinsicMap[${index}].height`),
    });
  }
  return result;
}

function staticProxyGate(entryPath, intrinsicDimensionsBySource) {
  try {
    const transformed = transformProxyTreeHtml({ entryPath, intrinsicDimensionsBySource });
    return { passed: true, code: null, message: null, report: transformed.report };
  } catch (error) {
    return {
      passed: false,
      code: safeAsciiIdentity(error?.code ?? "HF_PROXY_STATIC_GATE_FAILED", "static gate error code"),
      message: String(error?.message ?? error),
      details: error?.details ?? null,
      report: null,
    };
  }
}

function buildExecutionProof({
  finalized,
  sourcePlan,
  screenshotAudit,
  explicitProjectIdentity,
  identities,
}) {
  const determinismSignature = `sha256:${sha256({
    projectIdentity: identities.projectIdentity,
    renderPlanIdentity: identities.renderPlanIdentity,
    machineProfileIdentity: identities.machineProfileIdentity,
    styleOverrideProfileHash: identities.styleOverrideProfileHash,
    determinism: sourcePlan.determinism,
    ranges: sourcePlan.ranges.map((range) => ({
      startFrame: range.startFrame,
      endFrameExclusive: range.endFrameExclusive,
      requiresBrowserPaint: range.requiresBrowserPaint,
      inventoryState: range.inventoryState,
      riskSignature: range.riskSignature,
    })),
  })}`;
  const boundedStaticReasons = [];
  if (!explicitProjectIdentity) boundedStaticReasons.push("project-identity-not-caller-supplied");
  if (!screenshotAudit.eligible) boundedStaticReasons.push("bounded-static-audit-failed");
  if (sourcePlan.determinism?.state !== "passed" || sourcePlan.determinism?.passes < 2) {
    boundedStaticReasons.push("dual-run-determinism-not-proven");
  }
  if (finalized.validationState !== "passed" || finalized.executable !== true) {
    boundedStaticReasons.push("screenshot-oracle-validation-not-proven");
  }
  const mediaPolicyCore = {
    kind: "hyperframes-screenshot-media-policy-proof",
    schemaVersion: 1,
    selectedPolicy: boundedStaticReasons.length === 0 ? "bounded-static" : "faithful",
    projectIdentity: identities.projectIdentity,
    renderPlanIdentity: identities.renderPlanIdentity,
    machineProfileIdentity: identities.machineProfileIdentity,
    styleOverrideProfileHash: identities.styleOverrideProfileHash,
    auditSignature: screenshotAudit.auditSignature,
    determinismSignature,
    determinismPasses: sourcePlan.determinism?.passes ?? 0,
    oracleValidationIdentity: finalized.validation?.validationIdentity ?? null,
    oracleBackendName: finalized.validation?.oracleBackendName ?? null,
    reasons: boundedStaticReasons,
  };
  const screenshotMediaPolicy = {
    ...mediaPolicyCore,
    proofSignature: `sha256:${sha256(mediaPolicyCore)}`,
  };
  const backendPlanCore = {
    kind: finalized.kind,
    schemaVersion: finalized.schemaVersion,
    projectIdentity: finalized.projectIdentity,
    renderPlanIdentity: finalized.renderPlanIdentity,
    machineProfileIdentity: finalized.machineProfileIdentity,
    styleOverrideProfileHash: finalized.styleOverrideProfileHash,
    startFrame: finalized.startFrame,
    frameCount: finalized.frameCount,
    fps: finalized.fps,
    ranges: finalized.ranges,
    validation: finalized.validation,
  };
  const proofCore = {
    kind: "hyperframes-backend-preflight-execution-proof",
    schemaVersion: 1,
    backendPlanSignature: `sha256:${sha256(backendPlanCore)}`,
    screenshotMediaPolicy,
  };
  return { ...proofCore, proofSignature: `sha256:${sha256(proofCore)}` };
}

function runtimeSource(path) {
  return `${readFileSync(path, "utf8")}\n//# sourceURL=${path.replaceAll("\\", "/")}`;
}

async function boundedPromise(promise, timeoutMs, label) {
  let timeout;
  try {
    return await Promise.race([
      promise,
      new Promise((_resolve, reject) => {
        timeout = setTimeout(() => reject(new Error(`${label} timed out after ${timeoutMs}ms`)), timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timeout);
  }
}

async function installHarness(window) {
  await window.webContents.executeJavaScript(runtimeSource(resolve(rendererRoot, "frame-backend-plan-runtime.js")));
  await window.webContents.executeJavaScript(runtimeSource(resolve(rendererRoot, "frame-risk-inventory-runtime.js")));
  await window.webContents.executeJavaScript(runtimeSource(resolve(moduleRoot, "browser_harness.js")));
}

async function createCompositionWindow({ entryPath, width, height, label }) {
  const window = new BrowserWindow({
    show: false,
    frame: false,
    width,
    height,
    useContentSize: true,
    backgroundColor: "#000000",
    webPreferences: {
      backgroundThrottling: false,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      offscreen: true,
    },
  });
  window.webContents.on("console-message", (_event, detailsOrLevel, legacyMessage) => {
    const message = typeof detailsOrLevel === "object" ? detailsOrLevel.message : legacyMessage;
    if (String(message).startsWith("HF_BACKEND_PREFLIGHT_")) process.stderr.write(`${label}: ${message}\n`);
  });
  await window.loadFile(entryPath);
  window.setContentSize(width, height);
  await installHarness(window);
  return window;
}

async function invokeHarness(window, method, ...arguments_) {
  const serialized = arguments_.map((value) => JSON.stringify(value)).join(",");
  return window.webContents.executeJavaScript(
    `globalThis.HyperframesBackendPreflightHarness.${method}(${serialized})`,
    true,
  );
}

async function capture(window, frame, config, { role, goldenDirectory = null } = {}) {
  const context = {
    timelineFrame: frame,
    timeSeconds: frame * config.fpsDenominator / config.fpsNumerator,
    offset: frame - config.startFrame,
    passIndex: 2,
    phase: "golden",
  };
  await invokeHarness(window, "seekAndSettle", context, config);
  const image = await window.webContents.capturePage({ x: 0, y: 0, width: config.width, height: config.height });
  const size = image.getSize();
  const scaleX = size.width / config.width;
  const scaleY = size.height / config.height;
  if (!Number.isFinite(scaleX) || scaleX < 1 || scaleX > 4 || Math.abs(scaleX - scaleY) > 1e-9) {
    throw new Error(
      `${role} capture scale is invalid: ${size.width}x${size.height} from `
      + `${config.width}x${config.height} logical pixels`,
    );
  }
  const bitmap = Buffer.from(image.toBitmap());
  if (bitmap.length !== size.width * size.height * 4) {
    throw new Error(`${role} bitmap length ${bitmap.length} != ${size.width * size.height * 4}`);
  }
  const png = image.toPNG();
  const record = {
    frame,
    role,
    width: size.width,
    height: size.height,
    deviceScaleFactor: scaleX,
    bitmapBytes: bitmap.length,
    pngBytes: png.length,
    pngSha256: sha256(png),
  };
  if (goldenDirectory) {
    const path = resolve(goldenDirectory, `${role}-frame-${String(frame).padStart(8, "0")}.png`);
    await writeFile(path, png, { flag: "wx" });
    record.path = path;
  }
  return { bitmap, record };
}

async function writeResult(output, result) {
  await mkdir(dirname(output), { recursive: true });
  const temporary = `${output}.tmp-${process.pid}`;
  await writeFile(temporary, `${JSON.stringify(result, null, 2)}\n`, { flag: "wx" });
  await rename(temporary, output);
}

const args = parseArgs(process.argv.slice(2));
const debugLog = (message) => {
  if (args.traceStages === "true") process.stderr.write(`HF_BACKEND_PREFLIGHT_DEBUG ${message}\n`);
};
if (!args.projectRoot) throw new Error("--project-root is required");
const projectRoot = realpathSync(resolve(args.projectRoot));
if (!existsSync(projectRoot)) throw new Error(`project root does not exist: ${projectRoot}`);
const resultsRoot = args.resultsRoot
  ? realpathSync(resolve(args.resultsRoot))
  : projectRoot;
if (!existsSync(resultsRoot)) throw new Error(`results root does not exist: ${resultsRoot}`);
const entryPath = resolveExistingInside(projectRoot, args.entry ?? "index.html", "entry");
const output = resolveOutputInside(resultsRoot, args.output ?? "frame-backend-plan.json", "output");
const metadata = compositionMetadata(entryPath);
const fpsNumerator = positiveInteger(args.fpsNumerator ?? args.fps ?? 60, "fpsNumerator");
const fpsDenominator = positiveInteger(args.fpsDenominator ?? 1, "fpsDenominator");
const startFrame = nonNegativeInteger(args.startFrame ?? 0, "startFrame");
const frameCount = positiveInteger(
  args.frames,
  "frames",
  metadata.duration == null ? null : Math.ceil(metadata.duration * fpsNumerator / fpsDenominator),
);
const width = positiveInteger(args.width, "width", metadata.width);
const height = positiveInteger(args.height, "height", metadata.height);
if (frameCount > positiveInteger(args.maxFrameCount ?? 1_000_000, "maxFrameCount")) {
  throw new Error(`frame count ${frameCount} exceeds bounded maxFrameCount`);
}
const maxRetainedRanges = positiveInteger(
  args.maxRetainedRanges ?? Math.min(frameCount, 100_000),
  "maxRetainedRanges",
);
const maxRetainedBlockerRanges = positiveInteger(args.maxRetainedBlockerRanges ?? 128, "maxRetainedBlockerRanges");
const maxGoldenFrames = positiveInteger(args.maxGoldenFrames ?? 2_048, "maxGoldenFrames");
const maxManifestEntries = positiveInteger(args.maxManifestEntries ?? 32_768, "maxManifestEntries");
const checkpointEvery = positiveInteger(args.checkpointEvery ?? 600, "checkpointEvery");
const settleDelayMs = nonNegativeInteger(args.settleDelayMs ?? 0, "settleDelayMs");
const timelineKey = safeAsciiIdentity(args.timelineKey ?? "main", "timelineKey");
const styleOverrideProfileHash = sha256Identity(args.styleOverrideProfileHash, "styleOverrideProfileHash");
const entrySha256 = sha256(readFileSync(entryPath));
const screenshotAuditReport = transformScreenshotHtml({ entryPath, projectRoot }).report;
const screenshotAudit = buildScreenshotAuditEvidence({
  report: screenshotAuditReport,
  projectRoot,
  entrySha256,
});
const explicitProjectIdentity = sha256Identity(args.projectIdentity, "projectIdentity");
const projectIdentity = explicitProjectIdentity ?? `entry-sha256:${entrySha256}`;
const outputDirectory = dirname(output);
const goldenDirectory = args.goldenDirectory
  ? resolveOutputInside(resultsRoot, args.goldenDirectory, "goldenDirectory")
  : null;
const candidateEntry = args.candidateEntry
  ? resolveExistingInside(projectRoot, args.candidateEntry, "candidateEntry")
  : null;
const comparisonThresholds = {
  maxAbsoluteDifference: nonNegativeInteger(args.maxAbsoluteDifference ?? 2, "maxAbsoluteDifference"),
  maxRmse: finiteNumber(args.maxRmse ?? 0.5, "maxRmse"),
  maxDifferentPixelRatio: finiteNumber(args.maxDifferentPixelRatio ?? 0.0001, "maxDifferentPixelRatio"),
};
if (comparisonThresholds.maxRmse < 0
    || comparisonThresholds.maxDifferentPixelRatio < 0
    || comparisonThresholds.maxDifferentPixelRatio > 1) {
  throw new Error("comparison thresholds are outside their valid ranges");
}

app.commandLine.appendSwitch("no-sandbox");
app.commandLine.appendSwitch("disable-setuid-sandbox");
app.commandLine.appendSwitch("force-device-scale-factor", "1");
app.commandLine.appendSwitch("force-color-profile", "srgb");
app.commandLine.appendSwitch("disable-background-timer-throttling");
app.commandLine.appendSwitch("disable-renderer-backgrounding");
app.commandLine.appendSwitch("disable-backgrounding-occluded-windows");
app.commandLine.appendSwitch("ignore-gpu-blocklist");
app.commandLine.appendSwitch("enable-gpu-rasterization");

let oracleWindow = null;
let candidateWindow = null;
let result = null;
let exitCode = 1;

async function runPreflight() {
try {
  debugLog("app ready; querying GPU profile");
  const gpuInfo = await boundedPromise(app.getGPUInfo("complete"), 5_000, "GPU profile query")
    .catch((error) => ({ unavailable: String(error) }));
  debugLog("GPU profile stage complete");
  const machineProfile = {
    hostname: hostname(),
    platform: process.platform,
    arch: process.arch,
    osRelease: release(),
    electron: process.versions.electron,
    chrome: process.versions.chrome,
    node: process.versions.node,
    gpuInfo,
  };
  const machineProfileIdentity = sha256Identity(args.machineProfileIdentity, "machineProfileIdentity")
    ?? `sha256:${sha256(machineProfile)}`;
  const renderPlanIdentity = sha256Identity(args.renderPlanIdentity, "renderPlanIdentity")
    ?? `sha256:${sha256({
      projectIdentity,
      entry: relative(projectRoot, entryPath),
      entrySha256,
      startFrame,
      frameCount,
      fpsNumerator,
      fpsDenominator,
      width,
      height,
      styleOverrideProfileHash,
    })}`;
  const intrinsicDimensionsBySource = loadIntrinsicMap(projectRoot, args.intrinsicMap);
  const staticGate = staticProxyGate(entryPath, intrinsicDimensionsBySource);
  const runtime = loadPlanRuntime();
  const config = {
    width,
    height,
    frameCount,
    startFrame,
    fpsNumerator,
    fpsDenominator,
    timelineKey,
    settleDelayMs,
    checkpointEvery,
    maxManifestEntries,
    maxRetainedRanges,
    maxRetainedBlockerRanges,
    projectIdentity,
    renderPlanIdentity,
    machineProfileIdentity,
    styleOverrideProfileHash,
  };
  const compilationOptions = { ...config };

  if (goldenDirectory) await mkdir(goldenDirectory, { recursive: true });
  debugLog("creating oracle window");
  oracleWindow = await createCompositionWindow({ entryPath, width, height, label: "oracle" });
  debugLog("oracle window loaded");
  await invokeHarness(oracleWindow, "waitForReady", config);
  debugLog("oracle ready; starting discovery");
  const discovery = await invokeHarness(oracleWindow, "discover", config);
  debugLog("discovery complete; starting deterministic production passes");
  const productionResult = await invokeHarness(oracleWindow, "production", config, discovery.expectedRisks);
  debugLog("deterministic production passes complete");

  if (!productionResult.ok || !productionResult.plan) {
    const diagnosticPlan = productionResult.plan;
    if (!diagnosticPlan) throw new Error(`${productionResult.code}: ${productionResult.message}`);
    const finalized = runtime.finalizeWithOracleValidation(diagnosticPlan, {
      passed: false,
      oracleBackendName: "screenshot",
      machineProfileIdentity,
      validationIdentity: `sha256:${sha256(productionResult)}`,
      validatedGoldenFrames: [],
    });
    result = {
      ...finalized,
      preflight: {
        state: "failed",
        error: productionResult,
        staticGate,
        discovery,
        identities: { projectIdentity, renderPlanIdentity, machineProfileIdentity, styleOverrideProfileHash },
      },
    };
  } else {
    const sourcePlan = productionResult.plan;
    if (sourcePlan.summary.blockerFrames > 0 || sourcePlan.determinism?.state !== "passed") {
      const finalized = runtime.finalizeWithOracleValidation(sourcePlan, {
        passed: false,
        oracleBackendName: "screenshot",
        machineProfileIdentity,
        validationIdentity: `sha256:${sha256(sourcePlan.determinism ?? {})}`,
        validatedGoldenFrames: [],
      });
      result = {
        ...finalized,
        preflight: {
          state: "failed",
          staticGate,
          discovery,
          reason: sourcePlan.summary.blockerFrames > 0 ? "hard-blocker" : "determinism-not-proven",
        },
      };
    } else {
      let backend = {
        eligible: false,
        ineligibleReason: staticGate.code ?? "HF_BACKEND_CANDIDATE_MISSING",
        gateProfileHash: null,
      };
      let candidateContract = null;
      if (staticGate.passed && candidateEntry && explicitProjectIdentity) {
        debugLog("creating candidate window");
        candidateWindow = await createCompositionWindow({
          entryPath: candidateEntry,
          width,
          height,
          label: "candidate",
        });
        await invokeHarness(candidateWindow, "waitForReady", config);
        debugLog("candidate window ready");
        candidateContract = await invokeHarness(candidateWindow, "candidateContract");
        const requestedGate = sha256Identity(args.gateProfileHash, "gateProfileHash");
        const contractGate = sha256Identity(candidateContract?.gateProfileHash, "candidate gateProfileHash");
        const contractValid = candidateContract?.schemaVersion === 1
          && candidateContract?.backend === "proxy-tree"
          && candidateContract?.renderContract === "proxy-tree-webcodecs-frame-exact"
          && contractGate != null
          && (requestedGate == null || requestedGate === contractGate);
        backend = contractValid
          ? { eligible: true, ineligibleReason: null, gateProfileHash: contractGate }
          : { eligible: false, ineligibleReason: "HF_BACKEND_CANDIDATE_CONTRACT_INVALID", gateProfileHash: null };
      } else if (!staticGate.passed) {
        backend.ineligibleReason = staticGate.code;
      } else if (!explicitProjectIdentity) {
        backend.ineligibleReason = "HF_PROJECT_IDENTITY_WEAK";
      }

      const sourceGoldenFrames = uniqueGoldenFrames(sourcePlan);
      const mustCollapseToOracle = !backend.eligible || sourceGoldenFrames.length > maxGoldenFrames;
      const collapseReason = !backend.eligible
        ? backend.ineligibleReason
        : "HF_GOLDEN_FRAME_BUDGET_EXCEEDED";
      const oracleCaptures = new Map();
      const candidateCaptures = new Map();
      const captureErrors = [];
      const comparisons = [];
      const comparisonsByFrame = new Map();

      const captureOracle = async (frame) => {
        if (!oracleCaptures.has(frame)) {
          oracleCaptures.set(frame, await capture(oracleWindow, frame, config, {
            role: "screenshot",
            goldenDirectory,
          }));
        }
        return oracleCaptures.get(frame);
      };
      const captureCandidate = async (frame) => {
        if (!candidateCaptures.has(frame)) {
          candidateCaptures.set(frame, await capture(candidateWindow, frame, config, {
            role: "proxy-tree",
            goldenDirectory,
          }));
        }
        return candidateCaptures.get(frame);
      };

      let plan;
      let provenRiskProfiles = new Set();
      if (mustCollapseToOracle) {
        plan = compileOracleOnlyPlan({
          runtime,
          options: compilationOptions,
          sourcePlan,
          reason: collapseReason,
        });
      } else {
        const framesByProfile = new Map();
        for (const range of sourcePlan.ranges) {
          if (!signatureIsFastProofEligible(range.riskSignature)) continue;
          const key = riskProfileKey(range);
          const record = framesByProfile.get(key) ?? { range, frames: new Set() };
          for (const frame of range.goldenFrames) record.frames.add(frame);
          framesByProfile.set(key, record);
        }
        for (const frame of sourceGoldenFrames) {
          try {
            await captureOracle(frame);
          } catch (error) {
            captureErrors.push({ frame, role: "screenshot", error: String(error?.stack ?? error) });
          }
        }
        for (const [profileKey, profile] of framesByProfile) {
          let passed = true;
          for (const frame of [...profile.frames].sort((left, right) => left - right)) {
            try {
              let comparison = comparisonsByFrame.get(frame);
              if (!comparison) {
                const oracle = await captureOracle(frame);
                const candidate = await captureCandidate(frame);
                comparison = compareBitmaps(oracle.bitmap, candidate.bitmap, {
                  width: oracle.record.width,
                  height: oracle.record.height,
                  ...comparisonThresholds,
                });
                comparisonsByFrame.set(frame, comparison);
                comparisons.push({ frame, ...comparison });
              }
              if (!comparison.passed) passed = false;
            } catch (error) {
              passed = false;
              captureErrors.push({ frame, role: "proxy-tree", error: String(error?.stack ?? error) });
            }
          }
          if (passed) provenRiskProfiles.add(profileKey);
        }
        plan = compileDetailedPlan({
          runtime,
          sourcePlan,
          options: compilationOptions,
          backend,
          provenRiskProfiles,
        });
      }

      const requiredGoldenFrames = uniqueGoldenFrames(plan);
      for (const frame of requiredGoldenFrames) {
        try {
          await captureOracle(frame);
        } catch (error) {
          captureErrors.push({ frame, role: "screenshot", error: String(error?.stack ?? error) });
        }
      }
      const validatedGoldenFrames = requiredGoldenFrames.filter((frame) => oracleCaptures.has(frame));
      const validationEvidence = {
        candidateContract,
        backend,
        staticGate,
        thresholds: comparisonThresholds,
        sourceGoldenFrameCount: sourceGoldenFrames.length,
        requiredGoldenFrames,
        oracleCaptures: [...oracleCaptures.values()].map((captureRecord) => captureRecord.record),
        candidateCaptures: [...candidateCaptures.values()].map((captureRecord) => captureRecord.record),
        comparisons,
        captureErrors,
        provenRiskProfileKeys: [...provenRiskProfiles].sort(),
      };
      const validationIdentity = `sha256:${sha256(validationEvidence)}`;
      const finalized = runtime.finalizeWithOracleValidation(plan, {
        passed: captureErrors.length === 0,
        oracleBackendName: "screenshot",
        machineProfileIdentity,
        validationIdentity,
        validatedGoldenFrames,
      });
      const executionProof = buildExecutionProof({
        finalized,
        sourcePlan,
        screenshotAudit,
        explicitProjectIdentity,
        identities: {
          projectIdentity,
          renderPlanIdentity,
          machineProfileIdentity,
          styleOverrideProfileHash,
        },
      });
      result = {
        ...finalized,
        proof: executionProof,
        preflight: {
          state: finalized.executable ? "passed" : "failed",
          generatedAt: new Date().toISOString(),
          projectRoot,
          resultsRoot,
          entry: relative(projectRoot, entryPath),
          candidateEntry: candidateEntry ? relative(projectRoot, candidateEntry) : null,
          composition: metadata,
          identities: {
            projectIdentity,
            projectIdentityPolicy: explicitProjectIdentity ? "caller-supplied-strong" : "entry-only-weak-fast-path-disabled",
            renderPlanIdentity,
            machineProfileIdentity,
            styleOverrideProfileHash,
          },
          machineProfile,
          discovery,
          staticGate,
          screenshotAudit,
          screenshotMediaPolicy: executionProof.screenshotMediaPolicy.selectedPolicy,
          screenshotMediaPolicyProof: executionProof.screenshotMediaPolicy,
          backend,
          oracleOnlyCollapsed: mustCollapseToOracle,
          oracleOnlyReason: mustCollapseToOracle ? collapseReason : null,
          validationEvidence,
        },
      };
    }
  }
  exitCode = result.executable ? 0 : 2;
  await writeResult(output, result);
  process.stdout.write(`HF_BACKEND_PREFLIGHT_RESULT ${output}\n`);
} catch (error) {
  result = {
    kind: "hyperframes-frame-backend-preflight-diagnostic",
    schemaVersion: 1,
    validationState: "failed",
    renderable: false,
    executable: false,
    error: {
      code: error?.code ?? null,
      message: String(error?.message ?? error),
      stack: error?.stack ?? null,
    },
  };
  await writeResult(output, result).catch(() => {});
  process.stderr.write(`${error?.stack ?? error}\n`);
  exitCode = 1;
} finally {
  oracleWindow?.destroy();
  candidateWindow?.destroy();
  await rm(resolve(outputDirectory, `.hf-backend-preflight-${process.pid}`), { recursive: true, force: true }).catch(() => {});
  app.exit(exitCode);
}
}

debugLog("waiting for app ready");
app.whenReady().then(runPreflight).catch(async (error) => {
  process.stderr.write(`${error?.stack ?? error}\n`);
  await writeResult(output, {
    kind: "hyperframes-frame-backend-preflight-diagnostic",
    schemaVersion: 1,
    validationState: "failed",
    renderable: false,
    executable: false,
    error: { code: error?.code ?? null, message: String(error?.message ?? error), stack: error?.stack ?? null },
  }).catch(() => {});
  app.exit(1);
});
