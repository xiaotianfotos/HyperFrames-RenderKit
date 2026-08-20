#!/usr/bin/env node

import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, extname, isAbsolute, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const CONTRACT_KIND = "hyperframes-authoring-motion-contract";
const CONTRACT_SCHEMA_VERSION = 1;
const TEXT_EXTENSIONS = new Set([".html", ".htm", ".js", ".mjs", ".cjs", ".ts", ".tsx"]);
const RASTER_EXTENSIONS = "png|jpe?g|webp|avif|gif";

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function normalizeRelative(file) {
  return file.split(sep).join("/");
}

function countMatches(text, pattern) {
  return [...text.matchAll(pattern)].length;
}

function localReferences(text) {
  const references = new Set();
  const patterns = [
    /\b(?:src|href|data-composition-src|data-composition-file)\s*=\s*(["'])(.*?)\1/gis,
    /\b(?:src|href|data-composition-src|data-composition-file)\s*=\s*([^\s>"']+)/gis,
    /\b(?:import|export)\s+(?:[^"']*?\s+from\s+)?["']([^"']+)["']/g,
    /\b(?:import|require|importScripts)\s*\(\s*["']([^"']+)["']\s*\)/g,
    /@import\s+(?:url\(\s*)?["']([^"']+)["']/g,
    /url\(\s*["']?([^)'"\s]+)["']?\s*\)/g,
  ];
  for (const pattern of patterns) {
    for (const match of text.matchAll(pattern)) {
      references.add(match[2] ?? match[1]);
    }
  }
  return [...references];
}

function resolveLocalTextReference(projectRoot, owner, reference) {
  const clean = String(reference).split("#", 1)[0].split("?", 1)[0];
  if (!clean || clean.startsWith("#") || clean.startsWith("//")
      || /^[a-z][a-z0-9+.-]*:/i.test(clean)) return null;
  const base = resolve(dirname(owner), clean);
  const relativePath = relative(projectRoot, base);
  if (relativePath === ".." || relativePath.startsWith(`..${sep}`)) return null;
  const candidates = extname(base) ? [base] : [base, ...[".js", ".mjs", ".cjs", ".html", ".css"].map((suffix) => `${base}${suffix}`)];
  for (const candidate of candidates) {
    if (existsSync(candidate) && statSync(candidate).isFile()
        && TEXT_EXTENSIONS.has(extname(candidate).toLowerCase())) return candidate;
  }
  return null;
}

function collectTextFiles(projectRoot, entry) {
  const entryFile = resolve(projectRoot, entry);
  const entryRelative = relative(projectRoot, entryFile);
  if (entryRelative === ".." || entryRelative.startsWith(`..${sep}`)
      || !existsSync(entryFile) || !statSync(entryFile).isFile()) {
    throw new Error(`motion contract entry is not a project file: ${entry}`);
  }
  const pending = [entryFile];
  const visited = new Set();
  while (pending.length > 0) {
    const file = pending.shift();
    if (visited.has(file)) continue;
    visited.add(file);
    const text = readFileSync(file, "utf8");
    for (const reference of localReferences(text)) {
      const dependency = resolveLocalTextReference(projectRoot, file, reference);
      if (dependency != null && !visited.has(dependency)) pending.push(dependency);
    }
  }
  return [...visited].sort();
}

function rasterReferences(text) {
  const pattern = new RegExp(String.raw`["'\x60]([^"'\x60]+\.(?:${RASTER_EXTENSIONS})(?:[?#][^"'\x60]*)?)["'\x60]`, "gi");
  return [...new Set([...text.matchAll(pattern)].map((match) => match[1]))].sort();
}

function animatedProperties(text) {
  const names = [
    "autoAlpha", "opacity", "x", "y", "xPercent", "yPercent", "scale", "scaleX", "scaleY",
    "rotation", "rotationX", "rotationY", "clipPath", "filter", "maskImage", "drawSVG",
    "strokeDashoffset", "backgroundPosition", "transformOrigin",
  ];
  const found = [];
  for (const name of names) {
    const pattern = new RegExp(String.raw`(?:\b${name}\b\s*:|["']${name}["']\s*:)`, "g");
    if (pattern.test(text)) found.push(name);
  }
  return found;
}

function analyzeMotionFile(projectRoot, file) {
  if (/\.min\.js$/i.test(file)) return null;
  const text = readFileSync(file, "utf8");
  const timelineNames = new Set(["gsap"]);
  for (const match of text.matchAll(
    /\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:gsap\s*\.\s*timeline\s*\(|new\s+(?:TimelineLite|TimelineMax)\s*\()/g,
  )) {
    timelineNames.add(match[1]);
  }
  const escapedOwners = [...timelineNames]
    .map((name) => name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
    .join("|");
  const countTimelineMethod = (method) => countMatches(
    text,
    new RegExp(String.raw`\b(?:${escapedOwners})\s*\.\s*${method}\s*\(`, "g"),
  );
  const tweenMethods = {
    fromTo: countTimelineMethod("fromTo"),
    from: countTimelineMethod("from"),
    to: countTimelineMethod("to"),
    set: countTimelineMethod("set"),
    call: countTimelineMethod("call"),
    add: countTimelineMethod("add"),
    quickTo: countTimelineMethod("quickTo"),
  };
  const tweenCalls = Object.values(tweenMethods).reduce((sum, value) => sum + value, 0);
  const metrics = {
    timelineFactories: countMatches(text, /\b(?:gsap\s*\.\s*timeline|TimelineLite|TimelineMax)\s*\(/g),
    timelineRegistrations: countMatches(text, /(?:window\s*\.\s*__timelines|window\s*\[\s*["']__timelines["']\s*\])\s*(?:\.|\[)/g),
    tweenCalls,
    tweenMethods,
    keyframes: countMatches(text, /\bkeyframes\s*:/g),
    onUpdateHooks: countMatches(text, /\bonUpdate\s*:/g),
    frameCallbacks: countMatches(text, /\brequestAnimationFrame\s*\(/g),
    webglDrawCalls: countMatches(text, /\.\s*(?:drawArrays|drawElements)\s*\(/g),
    animatedProperties: animatedProperties(text),
    rasterReferences: rasterReferences(text),
  };
  const motionBearing = metrics.timelineFactories > 0
    || metrics.timelineRegistrations > 0
    || metrics.tweenCalls > 0
    || metrics.keyframes > 0
    || metrics.onUpdateHooks > 0
    || metrics.frameCallbacks > 0
    || metrics.webglDrawCalls > 0;
  if (!motionBearing) return null;
  return {
    file: normalizeRelative(relative(projectRoot, file)),
    sourceSha256: sha256(text),
    ...metrics,
  };
}

function totalsFor(files) {
  const numericKeys = [
    "timelineFactories", "timelineRegistrations", "tweenCalls", "keyframes",
    "onUpdateHooks", "frameCallbacks", "webglDrawCalls",
  ];
  return Object.fromEntries(numericKeys.map((key) => [
    key,
    files.reduce((sum, file) => sum + Number(file[key] ?? 0), 0),
  ]));
}

function stableSignature(files, totals) {
  const semanticFiles = files.map(({ sourceSha256: _sourceSha256, ...file }) => file);
  return sha256(JSON.stringify({ files: semanticFiles, totals }));
}

function assertProjectRoot(projectRoot) {
  const root = resolve(projectRoot);
  if (!existsSync(root) || !statSync(root).isDirectory()) {
    throw new Error(`project root is not a directory: ${root}`);
  }
  return root;
}

export function captureMotionContract(projectRoot, {
  entry = "index.html",
  approvalNote,
} = {}) {
  const root = assertProjectRoot(projectRoot);
  if (typeof approvalNote !== "string" || approvalNote.trim().length < 8) {
    throw new Error("motion contract requires --approval-note describing the approved authoring preview");
  }
  const files = collectTextFiles(root, entry)
    .map((file) => analyzeMotionFile(root, file))
    .filter(Boolean);
  const totals = totalsFor(files);
  return {
    kind: CONTRACT_KIND,
    schemaVersion: CONTRACT_SCHEMA_VERSION,
    createdAt: new Date().toISOString(),
    entry,
    approvalNote: approvalNote.trim(),
    motionSignatureSha256: stableSignature(files, totals),
    totals,
    files,
  };
}

function resolveContractPath(projectRoot, contractPath) {
  return isAbsolute(contractPath) ? resolve(contractPath) : resolve(projectRoot, contractPath);
}

export function verifyMotionContract(projectRoot, contractPath) {
  const root = assertProjectRoot(projectRoot);
  const resolvedContract = resolveContractPath(root, contractPath);
  const contract = JSON.parse(readFileSync(resolvedContract, "utf8"));
  if (contract.kind !== CONTRACT_KIND || contract.schemaVersion !== CONTRACT_SCHEMA_VERSION) {
    throw new Error(`unsupported authoring motion contract: ${resolvedContract}`);
  }
  const current = captureMotionContract(root, {
    entry: contract.entry,
    approvalNote: contract.approvalNote,
  });
  const currentByFile = new Map(current.files.map((file) => [file.file, file]));
  const errors = [];
  const warnings = [];
  const monotonicKeys = [
    "timelineFactories", "timelineRegistrations", "tweenCalls", "keyframes",
    "onUpdateHooks", "frameCallbacks", "webglDrawCalls",
  ];
  for (const baseline of contract.files ?? []) {
    const observed = currentByFile.get(baseline.file);
    if (observed == null) {
      errors.push(`${baseline.file}: approved motion-bearing source disappeared`);
      continue;
    }
    for (const key of monotonicKeys) {
      if (Number(observed[key] ?? 0) < Number(baseline[key] ?? 0)) {
        errors.push(`${baseline.file}: ${key} regressed ${baseline[key]} -> ${observed[key]}`);
      }
    }
    const baselineRasters = new Set(baseline.rasterReferences ?? []);
    const newRasters = (observed.rasterReferences ?? []).filter((asset) => !baselineRasters.has(asset));
    if (newRasters.length > 0) {
      errors.push(`${baseline.file}: new raster references after approval (${newRasters.join(", ")})`);
    }
    const removedProperties = (baseline.animatedProperties ?? [])
      .filter((property) => !(observed.animatedProperties ?? []).includes(property));
    if (removedProperties.length > 0) {
      errors.push(`${baseline.file}: animated properties disappeared (${removedProperties.join(", ")})`);
    }
    if (baseline.sourceSha256 !== observed.sourceSha256 && !errors.some((error) => error.startsWith(`${baseline.file}:`))) {
      warnings.push(`${baseline.file}: source changed but measured motion structure did not regress`);
    }
  }
  for (const key of monotonicKeys) {
    if (Number(current.totals[key] ?? 0) < Number(contract.totals?.[key] ?? 0)) {
      errors.push(`project total ${key} regressed ${contract.totals?.[key] ?? 0} -> ${current.totals[key] ?? 0}`);
    }
  }
  return {
    passed: errors.length === 0,
    contractPath: resolvedContract,
    contractSha256: sha256(readFileSync(resolvedContract)),
    baselineMotionSignatureSha256: contract.motionSignatureSha256,
    currentMotionSignatureSha256: current.motionSignatureSha256,
    errors,
    warnings,
    baselineTotals: contract.totals,
    currentTotals: current.totals,
  };
}

function parseArgs(tokens) {
  const positional = [];
  const options = {};
  for (const token of tokens) {
    if (!token.startsWith("--")) {
      positional.push(token);
      continue;
    }
    const [key, ...rest] = token.slice(2).split("=");
    options[key] = rest.length === 0 ? true : rest.join("=");
  }
  return { positional, options };
}

function writeContract(projectRoot, output, contract, { replace = false } = {}) {
  const root = assertProjectRoot(projectRoot);
  const file = resolveContractPath(root, output);
  const relativeOutput = relative(root, file);
  if (relativeOutput.startsWith(`..${sep}`) || relativeOutput === "..") {
    throw new Error("motion contract output must stay inside the project root");
  }
  if (existsSync(file) && !replace) {
    throw new Error(`motion contract already exists: ${file}; use --replace only after editorial approval`);
  }
  mkdirSync(dirname(file), { recursive: true });
  const temporary = `${file}.tmp-${process.pid}`;
  try {
    writeFileSync(temporary, `${JSON.stringify(contract, null, 2)}\n`, { flag: "wx" });
    renameSync(temporary, file);
  } finally {
    if (existsSync(temporary)) unlinkSync(temporary);
  }
  return file;
}

async function main() {
  const [command, ...tokens] = process.argv.slice(2);
  const { positional, options } = parseArgs(tokens);
  const projectRoot = positional[0];
  if (!command || !projectRoot) {
    throw new Error("usage: motion_contract.mjs freeze|check <project-root> [--output=...] [--contract=...]");
  }
  if (command === "freeze") {
    const output = String(options.output ?? ".hyperframes/authoring-motion-contract.json");
    const contract = captureMotionContract(projectRoot, {
      entry: String(options.entry ?? "index.html"),
      approvalNote: options["approval-note"],
    });
    const file = writeContract(projectRoot, output, contract, { replace: options.replace === true });
    process.stdout.write(`${JSON.stringify({ passed: true, file, contract }, null, 2)}\n`);
    return;
  }
  if (command === "check") {
    const result = verifyMotionContract(
      projectRoot,
      String(options.contract ?? ".hyperframes/authoring-motion-contract.json"),
    );
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    if (!result.passed) process.exitCode = 2;
    return;
  }
  throw new Error(`unknown motion-contract command: ${command}`);
}

const isDirectRun = process.argv[1] != null
  && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));
if (isDirectRun) {
  main().catch((error) => {
    process.stderr.write(`${error?.stack ?? error}\n`);
    process.exitCode = 1;
  });
}
