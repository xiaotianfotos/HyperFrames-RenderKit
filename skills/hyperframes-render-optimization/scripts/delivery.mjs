#!/usr/bin/env node

import { appendFileSync, createReadStream, existsSync, lstatSync, readFileSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { readdir } from "node:fs/promises";
import { createServer } from "node:http";
import { createHash } from "node:crypto";
import { basename, dirname, extname, isAbsolute, join, normalize, relative, resolve } from "node:path";
import { spawn } from "node:child_process";
import { pathToFileURL } from "node:url";
import { verifyMotionContract } from "./motion_contract.mjs";

const TEXT_EXTENSIONS = new Set([".html", ".htm", ".css", ".js", ".mjs", ".cjs", ".ts", ".tsx"]);
const LOCAL_MODULE_EXTENSIONS = [".mjs", ".js", ".cjs", ".json"];
const EXCLUDED_DIRECTORIES = new Set([
  ".git", ".render-cache", ".hyperframes", ".thumbnails", ".transcode-cache",
  "node_modules", "results", "renders", "output", "dist", "build", "backups",
]);

const RULES = Object.freeze([
  {
    id: "css-filter-compositing",
    severity: "blocker",
    pattern: /(?:(?:^|[;{,\s])(?:(?:-webkit-)?(?:backdrop-filter|filter)|backdropFilter)\s*:|\.style\.(?:filter|backdropFilter)\s*=)/gim,
    summary: "CSS/JS filter or backdrop-filter requires faithful browser compositing unless this exact feature has a golden proof.",
  },
  {
    id: "css-blend-mode",
    severity: "blocker",
    pattern: /(?:mix-blend-mode|background-blend-mode)\s*:/gim,
    summary: "Blend modes are not generally reproducible by manual video/DOM layering.",
  },
  {
    id: "css-mask",
    severity: "blocker",
    pattern: /(?:(?:^|[;{,\s])(?:(?:-webkit-)?mask(?:-image|-clip|-composite|-mode|-position|-repeat|-size)?|(?:webkit)?Mask(?:Image|Clip|Composite|Mode|Position|Repeat|Size)?)\s*:|\.style\.(?:webkitMask|mask)(?:Image|Clip|Composite|Mode|Position|Repeat|Size)?\s*=)/gim,
    summary: "CSS/JS masks require faithful browser compositing unless exact output has been proven.",
  },
  {
    id: "css-clip-path",
    severity: "blocker",
    pattern: /(?:(?:clip-path|clipPath)\s*:|\.style\.clipPath\s*=)/gim,
    summary: "CSS/JS clip-path can change media/DOM boundaries and needs a proven backend.",
  },
  {
    id: "css-3d-transform",
    severity: "blocker",
    pattern: /(?:perspective\s*:|transformPerspective\s*:|transform-style\s*:\s*preserve-3d|transformStyle\s*:\s*["']?preserve-3d|(?:rotation[XY]|translateZ|z)\s*:|(?:rotate3d|translate3d|matrix3d|perspective)\s*\()/gim,
    summary: "CSS/JS 3D transforms are not supported by the stable manual layered route.",
  },
  {
    id: "css-negative-stacking",
    severity: "blocker",
    pattern: /(?:z-index\s*:\s*-[0-9]|zIndex\s*:\s*-[0-9])/gim,
    summary: "Negative stacking can escape the captured element stacking context and must be proven against golden frames.",
  },
  {
    id: "svg-filter-compositing",
    severity: "blocker",
    pattern: /(?:<filter\b|\bfilter\s*=\s*["']\s*url\s*\()/gim,
    summary: "SVG filters require faithful browser compositing or exact golden-frame proof.",
  },
  {
    id: "svg-mask",
    severity: "blocker",
    pattern: /(?:<mask\b|\bmask\s*=\s*["']\s*url\s*\()/gim,
    summary: "SVG masks require faithful browser compositing or exact golden-frame proof.",
  },
  {
    id: "svg-clip-path",
    severity: "blocker",
    pattern: /(?:<clipPath\b|\bclip-path\s*=\s*["']\s*url\s*\()/gim,
    summary: "SVG clip paths require faithful browser compositing or exact golden-frame proof.",
  },
  {
    id: "css-video-geometry-review",
    severity: "review",
    pattern: /video[^{}]*\{[^{}]*(?:border(?:-radius)?|transform|object-position|opacity)\s*:/gims,
    summary: "Video styling changes geometry or edges; confirm object-fit, clipping, transform, border, and opacity handling.",
  },
  {
    id: "canvas-draw-dynamic-opacity",
    severity: "review",
    pattern: /(?:\.(?:to|from|fromTo|set)\s*\([^)]{0,1600}\b(?:opacity|autoAlpha)\s*:|\.style\.opacity\s*=)/gims,
    summary: "Runtime opacity/autoAlpha animation needs a proven CanvasDrawElement policy; Chrome 150 can omit dynamically partial-opacity descendants without throwing.",
  },
  {
    id: "canvas-draw-low-partial-opacity",
    severity: "blocker",
    pattern: /(?:\.(?:to|from|fromTo|set)\s*\([^)]{0,1600}\b(?:opacity|autoAlpha)\s*:\s*(?:0?\.(?:0[0-9]*[1-9][0-9]*|10*))(?![0-9])|\.style\.opacity\s*=\s*(?:0?\.(?:0[0-9]*[1-9][0-9]*|10*))(?![0-9]))/gims,
    summary: "A runtime opacity/autoAlpha target in (0, 0.1] cannot be promoted to full opacity faithfully; rewrite it with alpha-bearing color/asset pixels or use faithful screenshot capture.",
  },
  {
    id: "canvas-draw-explicit-partial-opacity",
    severity: "review",
    pattern: /(?:\.(?:to|from|fromTo|set)\s*\([^)]{0,1600}\b(?:opacity|autoAlpha)\s*:\s*(?:0?\.[0-9]*[1-9][0-9]*)(?![0-9])|\.style\.opacity\s*=\s*(?:0?\.[0-9]*[1-9][0-9]*)(?![0-9]))/gims,
    summary: "An explicit runtime partial-alpha target is not alpha-equivalent under promote-dynamic; review active frames and rewrite alpha-critical effects or select faithful screenshot capture.",
  },
  {
    id: "dom-embedded-document",
    severity: "blocker",
    pattern: /<(?:iframe|object|embed)\b/gim,
    summary: "Embedded documents require faithful Chromium capture.",
  },
  {
    id: "svg-foreign-object",
    severity: "blocker",
    pattern: /<foreignObject\b/gim,
    summary: "SVG foreignObject support is backend- and build-specific and must be proven.",
  },
  {
    id: "dom-shadow-root",
    severity: "blocker",
    pattern: /(?:attachShadow\s*\(|customElements\s*\.\s*define\s*\()/gim,
    summary: "Dynamic/custom shadow DOM is outside the simple static layer inventory.",
  },
  {
    id: "media-dynamic-source",
    severity: "blocker",
    pattern: /(?:\.srcObject\s*=|new\s+MediaSource\s*\(|URL\.createObjectURL\s*\()/gim,
    summary: "srcObject/MSE/blob media cannot use the static exact-source plan.",
  },
  {
    id: "dom-runtime-mutation",
    severity: "review",
    pattern: /(?:insertAdjacentHTML\s*\(|\.innerHTML\s*=|document\.createElement\s*\(|new\s+MutationObserver\s*\()/gim,
    summary: "Runtime DOM mutation can invalidate a static compatibility inventory; inspect the affected timeline.",
  },
  {
    id: "css-runtime-mutation",
    severity: "review",
    pattern: /(?:\.insertRule\s*\(|adoptedStyleSheets|CSSStyleSheet\s*\()/gim,
    summary: "Runtime CSSOM mutation can introduce features after preflight.",
  },
  {
    id: "dynamic-code",
    severity: "review",
    pattern: /(?:\beval\s*\(|new\s+Function\s*\()/gim,
    summary: "Dynamic code prevents a complete static compatibility proof.",
  },
  {
    id: "module-dynamic-dependency",
    severity: "blocker",
    pattern: /\b(?:import|require|importScripts)\s*\(\s*(?:(?!["'])|["'][^"']*["']\s*(?=[^)\s]))/gim,
    summary: "Computed module or script dependencies prevent a closed static source inventory.",
  },
  {
    id: "remote-runtime-dependency",
    severity: "blocker",
    pattern: /(?:\b(?:src|href|data-composition-src)\s*=\s*["']?(?:https?:)?\/\/|@import\s+(?:url\(\s*)?["']?(?:https?:)?\/\/|\b(?:import|export)\s+[^;]*?["'](?:https?:)?\/\/)/gim,
    summary: "Remote runtime/style dependencies are outside the frozen local project identity.",
  },
  {
    id: "authored-hidden-clip",
    severity: "info",
    pattern: /(?:\bdata-hidden(?:\s*=|\s|>)|\bhidden(?:\s*=|\s|>))/gim,
    summary: "Hidden authored elements must remain excluded from the render-layer inventory.",
  },
]);

function parseCli(argv) {
  const positional = [];
  const options = {};
  for (const token of argv) {
    if (!token.startsWith("--")) {
      positional.push(token);
      continue;
    }
    const equals = token.indexOf("=");
    if (equals === -1) options[token.slice(2)] = true;
    else options[token.slice(2, equals)] = token.slice(equals + 1);
  }
  return { positional, options };
}

function lineForOffset(text, offset) {
  let line = 1;
  for (let index = 0; index < offset; index += 1) if (text.charCodeAt(index) === 10) line += 1;
  return line;
}

function referencedTextPaths(file, text, root) {
  const references = new Set();
  const patterns = [
    /\b(?:src|href|data-composition-src)\s*=\s*(?:"([^"#?]+)"|'([^'#?]+)'|([^\s"'=<>`#?]+))/gim,
    /@import\s+(?:url\(\s*)?(?:"([^"#?]+)"|'([^'#?]+)'|([^;\s"')#?]+))/gim,
    /\bimport(?:\s|\/\*[\s\S]*?\*\/|\/\/[^\n]*\n)+["']([^"'#?]+)["']/gim,
    /\b(?:import|export)\s+(?:[^;]*?\s+from\s+)?["']([^"'#?]+)["']/gim,
    /\bimport\s*\(\s*["']([^"'#?]+)["']\s*\)/gim,
    /\b(?:require|importScripts)\s*\(\s*["']([^"'#?]+)["']\s*\)/gim,
  ];
  for (const pattern of patterns) {
    let match;
    while ((match = pattern.exec(text)) !== null) {
      const reference = match.slice(1).find((value) => typeof value === "string" && value.length > 0);
      if (!reference || /^(?:[a-z]+:|\/\/|#)/i.test(reference)) continue;
      let candidate = normalize(resolve(dirname(file), reference));
      const rel = relative(root, candidate);
      if (rel.startsWith("..") || isAbsolute(rel)) continue;
      if (!extname(candidate)) {
        for (const suffix of [".js", ".mjs", ".css", ".html"]) {
          if (existsSync(`${candidate}${suffix}`)) {
            candidate = `${candidate}${suffix}`;
            break;
          }
        }
      }
      if (existsSync(candidate) && statSync(candidate).isFile() && TEXT_EXTENSIONS.has(extname(candidate).toLowerCase())) {
        const realCandidate = realpathSync(candidate);
        const realRelative = relative(root, realCandidate);
        if (realRelative.startsWith("..") || isAbsolute(realRelative)) {
          throw new Error(`dependency resolves outside project root: ${reference}`);
        }
        references.add(realCandidate);
      }
    }
  }
  return references;
}

async function collectTextFiles(root, entryName = "index.html") {
  const entry = resolve(root, entryName);
  const entryRelative = relative(root, entry);
  if (entryRelative.startsWith("..") || isAbsolute(entryRelative)) {
    throw new Error(`compatibility entry escapes project root: ${entryName}`);
  }
  if (existsSync(entry)) {
    const realEntry = realpathSync(entry);
    const realEntryRelative = relative(root, realEntry);
    if (realEntryRelative.startsWith("..") || isAbsolute(realEntryRelative)) {
      throw new Error(`compatibility entry resolves outside project root: ${entryName}`);
    }
    const pending = [realEntry];
    const visited = new Set();
    while (pending.length > 0) {
      const file = pending.shift();
      if (visited.has(file)) continue;
      visited.add(file);
      const text = readFileSync(file, "utf8");
      for (const referenced of referencedTextPaths(file, text, root)) {
        if (!visited.has(referenced)) pending.push(referenced);
      }
    }
    return [...visited].sort();
  }
  const files = [];
  async function visit(directory) {
    for (const entryRecord of await readdir(directory, { withFileTypes: true })) {
      if (entryRecord.isDirectory()) {
        if (!EXCLUDED_DIRECTORIES.has(entryRecord.name)) await visit(join(directory, entryRecord.name));
        continue;
      }
      if (!entryRecord.isFile()) continue;
      const file = join(directory, entryRecord.name);
      if (TEXT_EXTENSIONS.has(extname(entryRecord.name).toLowerCase())) files.push(file);
    }
  }
  await visit(root);
  return files.sort();
}

export async function scanProject(projectRoot, {
  acknowledgedRuleIds = [],
  approvedRuleIds = [],
  entry = "index.html",
} = {}) {
  const root = realpathSync(resolve(projectRoot));
  const acknowledged = new Set([...approvedRuleIds, ...acknowledgedRuleIds]);
  const files = await collectTextFiles(root, entry);
  const projectScanSha256 = createHash("sha256").update(JSON.stringify(files.map((file) => ({
    file: relative(root, file).split("\\").join("/"),
    sha256: createHash("sha256").update(readFileSync(file)).digest("hex"),
  })))).digest("hex");
  const findings = [];
  for (const file of files) {
    const text = readFileSync(file, "utf8");
    if (/\.min\.(?:js|mjs|cjs)$/i.test(file)) continue;
    for (const rule of RULES) {
      const pattern = new RegExp(rule.pattern.source, rule.pattern.flags);
      let match;
      let count = 0;
      while ((match = pattern.exec(text)) !== null) {
        count += 1;
        if (count <= 12) {
          findings.push({
            ruleId: rule.id,
            severity: rule.severity,
            originalSeverity: rule.severity,
            acknowledged: acknowledged.has(rule.id),
            file: relative(root, file).split("\\").join("/"),
            line: lineForOffset(text, match.index),
            evidence: match[0].replace(/\s+/g, " ").slice(0, 180),
            summary: rule.summary,
          });
        }
        if (match[0].length === 0) pattern.lastIndex += 1;
      }
    }
  }
  const blockers = findings.filter((finding) => finding.severity === "blocker");
  const reviews = findings.filter((finding) => finding.severity === "review");
  const acknowledgedFindings = findings.filter((finding) => finding.acknowledged === true);
  return {
    kind: "hyperframes-delivery-compatibility-scan",
    schemaVersion: 2,
    projectRoot: root,
    entry,
    projectScanSha256,
    scanMode: existsSync(resolve(root, entry)) ? "configured-entry-closure" : "all-text-files",
    scannedFiles: files.length,
    findingCount: findings.length,
    blockerCount: blockers.length,
    reviewCount: reviews.length,
    acknowledgedFindingCount: acknowledgedFindings.length,
    acknowledgedRuleIds: [...acknowledged].sort(),
    legacyApprovedRuleIds: [...new Set(approvedRuleIds)].sort(),
    recommendedBackend: blockers.length === 0 ? "modified-electron-layered" : "faithful-chromium-screenshot",
    productionEligibleForLayered: blockers.length === 0,
    approvalSemantics: "acknowledgedRuleIds (and legacy approvedRuleIds) records review history; it never makes a blocker safe for layered rendering.",
    limitation: "Static conservative scan only; passing does not prove pixel equivalence.",
    findings,
  };
}

function runProcess(command, args, { env = process.env, inherit = false } = {}) {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(command, args, {
      env,
      stdio: inherit ? "inherit" : ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    if (!inherit) {
      child.stdout.on("data", (chunk) => { stdout += chunk; });
      child.stderr.on("data", (chunk) => { stderr += chunk; });
    }
    child.once("error", rejectPromise);
    child.once("close", (code, signal) => resolvePromise({ code, signal, stdout, stderr }));
  });
}

function fileSha256(file) {
  return new Promise((resolvePromise, rejectPromise) => {
    const hash = createHash("sha256");
    const stream = createReadStream(file);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.once("error", rejectPromise);
    stream.once("end", () => resolvePromise(hash.digest("hex")));
  });
}

export async function verifyRequiredFileSha256(requiredFileSha256 = {}) {
  if (requiredFileSha256 == null || typeof requiredFileSha256 !== "object" || Array.isArray(requiredFileSha256)) {
    throw new Error("requiredFileSha256 must be an object mapping absolute paths to SHA-256");
  }
  const verified = [];
  for (const [configuredPath, expected] of Object.entries(requiredFileSha256).sort(([left], [right]) => left.localeCompare(right))) {
    if (!isAbsolute(configuredPath)) throw new Error(`required file path must be absolute: ${configuredPath}`);
    if (typeof expected !== "string" || !/^[a-f0-9]{64}$/.test(expected)) {
      throw new Error(`invalid required SHA-256 for ${configuredPath}`);
    }
    const file = resolve(configuredPath);
    if (!existsSync(file) || !lstatSync(file).isFile()) throw new Error(`required file does not exist: ${file}`);
    const observed = await fileSha256(file);
    if (observed !== expected) throw new Error(`required file identity changed: ${file} (${observed})`);
    verified.push({ file, sha256: observed });
  }
  return verified;
}

function referencedLocalModulePaths(file, text) {
  const references = new Set();
  const patterns = [
    /\bimport(?:\s|\/\*[\s\S]*?\*\/|\/\/[^\n]*\n)+["']([^"']+)["']/gim,
    /\b(?:import|export)\s+(?:[^;]*?\s+from\s+)?["']([^"']+)["']/gim,
    /\bimport\s*\(\s*["']([^"']+)["']\s*\)/gim,
    /\brequire\s*\(\s*["']([^"']+)["']\s*\)/gim,
  ];
  for (const pattern of patterns) {
    let match;
    while ((match = pattern.exec(text)) !== null) {
      const reference = match[1];
      if (!(reference.startsWith(".") || isAbsolute(reference))) continue;
      const unresolved = resolve(dirname(file), reference);
      const candidates = extname(unresolved)
        ? [unresolved]
        : [
          unresolved,
          ...LOCAL_MODULE_EXTENSIONS.map((suffix) => `${unresolved}${suffix}`),
          ...LOCAL_MODULE_EXTENSIONS.map((suffix) => join(unresolved, `index${suffix}`)),
        ];
      const candidate = candidates.find((value) => existsSync(value) && lstatSync(value).isFile());
      if (!candidate) throw new Error(`local module dependency does not exist: ${reference} from ${file}`);
      references.add(realpathSync(candidate));
    }
  }
  return references;
}

export async function collectLocalModuleClosure(entryPath) {
  const entry = realpathSync(resolve(entryPath));
  const pending = [entry];
  const visited = new Set();
  while (pending.length > 0) {
    const file = pending.shift();
    if (visited.has(file)) continue;
    visited.add(file);
    if (extname(file).toLowerCase() === ".json") continue;
    const text = readFileSync(file, "utf8");
    for (const dependency of referencedLocalModulePaths(file, text)) {
      if (!visited.has(dependency)) pending.push(dependency);
    }
  }
  return [...visited].sort();
}

export async function verifyFrozenLocalModuleClosure(entryPathOrPaths, requiredFileSha256 = {}) {
  const roots = Array.isArray(entryPathOrPaths) ? entryPathOrPaths : [entryPathOrPaths];
  const files = [...new Set((await Promise.all(
    roots.map((entryPath) => collectLocalModuleClosure(entryPath)),
  )).flat())].sort();
  const frozen = [];
  for (const file of files) {
    const expected = requiredFileSha256[file];
    if (typeof expected !== "string" || !/^[a-f0-9]{64}$/.test(expected)) {
      throw new Error(`automatic routing requires a frozen SHA-256 for local module dependency ${file}`);
    }
    frozen.push({ file, sha256: expected });
  }
  return frozen;
}

function uniqueRiskFindings(scan, { treatReviewAsRisk = true } = {}) {
  const severities = new Set(treatReviewAsRisk ? ["blocker", "review"] : ["blocker"]);
  return scan.findings.filter((finding) => severities.has(finding.severity));
}

function requireFaithfulScreenshotRender(config, { requireCostApproval = true } = {}) {
  const policy = config.automaticFallback;
  if (policy == null || typeof policy !== "object" || Array.isArray(policy) || policy.enabled !== true) {
    throw new Error("automatic fallback is not enabled");
  }
  if (requireCostApproval && policy.allowWholeProjectScreenshotFallback !== true) {
    throw new Error(
      "whole-project screenshot fallback requires explicit "
      + "automaticFallback.allowWholeProjectScreenshotFallback=true approval",
    );
  }
  if (policy.onCompatibilityRisk !== "faithful-screenshot") {
    throw new Error("automaticFallback.onCompatibilityRisk must be faithful-screenshot");
  }
  if (policy.onCanonicalCacheRequired !== "faithful-screenshot") {
    throw new Error("automaticFallback.onCanonicalCacheRequired must be faithful-screenshot");
  }
  const fallback = policy.screenshotRender;
  if (fallback == null || typeof fallback !== "object" || Array.isArray(fallback)) {
    throw new Error("automaticFallback.screenshotRender must be an object");
  }
  const base = config.render ?? {};
  const render = {
    width: base.width,
    height: base.height,
    fps: base.fps,
    frames: base.frames,
    startFrame: base.startFrame ?? 0,
    bitrate: base.bitrate ?? 40_000_000,
    directMux: true,
    mediaFrameMode: "video",
    mediaTargetMode: "timing-plan",
    mediaAdvanceMode: "playback-step",
    mediaTailPolicy: base.mediaTailPolicy ?? "hold-last",
    mediaPlaybackRate: base.mediaPlaybackRate ?? 0.5,
    mixProjectAudio: base.mixProjectAudio ?? true,
    audioCodec: base.audioCodec ?? "pcm_s24le",
    audioSampleRate: base.audioSampleRate ?? 48_000,
    frameMetricsMode: base.frameMetricsMode ?? "bounded",
    waitMode: base.waitMode ?? "synchronous-paint",
    mediaTimingPlan: base.mediaTimingPlan,
    mediaTimingPlanVerify: base.mediaTimingPlanVerify ?? "sha256",
    ...fallback,
    compositeMode: "screenshot",
    outputBackend: "screenshot",
    mediaDecoderBackend: "html-video",
  };
  delete render.canonicalMediaRoute;
  delete render.canonicalMediaRouteVerify;
  if (typeof render.mediaTimingPlan !== "string" || render.mediaTimingPlan.length === 0) {
    throw new Error("faithful screenshot fallback requires a verified mediaTimingPlan");
  }
  if (render.mediaTimingPlanVerify !== "sha256") {
    throw new Error("faithful screenshot fallback requires mediaTimingPlanVerify=sha256");
  }
  if (!Array.isArray(render.extraArgs)) {
    throw new Error("faithful screenshot fallback requires an explicit extraArgs array");
  }
  const screenshotPolicy = render.extraArgs.filter((token) => String(token).startsWith("--screenshotMediaPolicy="));
  if (screenshotPolicy.length !== 1 || screenshotPolicy[0] !== "--screenshotMediaPolicy=faithful") {
    throw new Error("automatic screenshot fallback requires exactly --screenshotMediaPolicy=faithful");
  }
  if (!render.extraArgs.includes("--mediaSeekBiasFrames=0")) {
    throw new Error("automatic screenshot fallback requires --mediaSeekBiasFrames=0");
  }
  return render;
}

function requireFrozenAutomaticToolchain(config) {
  const required = config.requiredFileSha256;
  if (required == null || typeof required !== "object" || Array.isArray(required)) {
    throw new Error("automatic routing requires requiredFileSha256");
  }
  const projectRoot = resolve(config.projectRoot ?? "");
  const mainPath = resolve(config.main ?? "");
  const configuredPaths = [resolve(config.runtime ?? ""), mainPath];
  const mainDirectory = dirname(mainPath);
  // These files are loaded through computed paths/readFileSync by the custom
  // full-canvas runtime, so a static ESM closure alone cannot discover them.
  for (const relativeHelper of [
    "preload.mjs",
    "full-canvas-renderer.js",
    "media-timing-runtime.js",
    "decoder-lane-allocator.js",
    "bounded-metrics-recorder.js",
    "tools/production_decoder_runtime/browser.mjs",
  ]) {
    const helper = resolve(mainDirectory, relativeHelper);
    if (existsSync(helper)) configuredPaths.push(helper);
  }
  if (typeof config.hyperframesRuntime === "string" && config.hyperframesRuntime.length > 0) {
    configuredPaths.push(resolve(config.hyperframesRuntime));
  }
  if (typeof config.authoringMotionContract === "string" && config.authoringMotionContract.length > 0) {
    configuredPaths.push(isAbsolute(config.authoringMotionContract)
      ? resolve(config.authoringMotionContract)
      : resolve(projectRoot, config.authoringMotionContract));
  }
  for (const reference of [
    config.render?.mediaTimingPlan,
    config.automaticFallback?.screenshotRender?.mediaTimingPlan ?? config.render?.mediaTimingPlan,
    config.render?.canonicalMediaRoute,
  ]) {
    if (typeof reference === "string" && reference.length > 0) {
      configuredPaths.push(isAbsolute(reference) ? resolve(reference) : resolve(projectRoot, reference));
    }
  }
  for (const file of [...new Set(configuredPaths)]) {
    if (typeof required[file] !== "string" || !/^[a-f0-9]{64}$/.test(required[file])) {
      throw new Error(`automatic routing requires a frozen SHA-256 for ${file}`);
    }
  }
}

export function buildDeliveryRoutePlan(config, scan) {
  const automatic = config.automaticFallback?.enabled === true;
  if (automatic) {
    requireFaithfulScreenshotRender(config, { requireCostApproval: false });
    requireFrozenAutomaticToolchain(config);
  }
  const treatReviewAsRisk = automatic && config.automaticFallback?.treatReviewAsRisk !== false;
  const risks = uniqueRiskFindings(scan, { treatReviewAsRisk });
  if (risks.length === 0) {
    const approval = config.automaticFallback?.approvedExactProjectScanSha256;
    const exactApproved = !automatic
      || (typeof approval === "string" && /^[a-f0-9]{64}$/.test(approval) && approval === scan.projectScanSha256);
    if (automatic && !exactApproved) {
      requireFaithfulScreenshotRender(config);
      return {
        kind: "hyperframes-delivery-route-plan",
        schemaVersion: 1,
        initialRoute: "faithful-screenshot",
        selectedRoute: "faithful-screenshot",
        reason: "exact-route-project-approval-missing-or-stale",
        automaticFallbackEnabled: true,
        unresolvedRuleIds: [],
      };
    }
    return {
      kind: "hyperframes-delivery-route-plan",
      schemaVersion: 1,
      initialRoute: "production-exact",
      selectedRoute: "production-exact",
      reason: "compatibility-scan-exact-eligible",
      automaticFallbackEnabled: automatic,
      unresolvedRuleIds: [],
    };
  }
  const unresolvedRuleIds = [...new Set(risks.map((finding) => finding.ruleId))].sort();
  if (!automatic) {
    return {
      kind: "hyperframes-delivery-route-plan",
      schemaVersion: 1,
      initialRoute: "blocked",
      selectedRoute: "blocked",
      reason: "compatibility-scan-unresolved",
      automaticFallbackEnabled: false,
      unresolvedRuleIds,
    };
  }
  requireFaithfulScreenshotRender(config);
  return {
    kind: "hyperframes-delivery-route-plan",
    schemaVersion: 1,
    initialRoute: "faithful-screenshot",
    selectedRoute: "faithful-screenshot",
    reason: "compatibility-scan-unresolved",
    automaticFallbackEnabled: true,
    unresolvedRuleIds,
  };
}

function configForRoute(config, route) {
  if (route === "production-exact") return config;
  if (route === "faithful-screenshot") return { ...config, render: requireFaithfulScreenshotRender(config) };
  throw new Error(`unsupported delivery route: ${route}`);
}

function automaticRouteEvidencePath(config, output) {
  if (config.automaticFallback?.enabled !== true) return null;
  const evidence = resolve(config.routeEvidence ?? `${output}.delivery-route.jsonl`);
  if (dirname(evidence) !== dirname(output)) {
    throw new Error("automatic route evidence must be in the output directory");
  }
  if (evidence === output) throw new Error("automatic route evidence must differ from output");
  return evidence;
}

function appendRouteEvidence(file, event) {
  if (file == null) return;
  appendFileSync(file, `${JSON.stringify({ at: new Date().toISOString(), ...event })}\n`);
}

function ratioEqual(value, expected) {
  const [numerator, denominator] = String(value ?? "").split("/").map(Number);
  return Number.isFinite(numerator) && Number.isFinite(denominator) && denominator !== 0
    && Math.abs(numerator / denominator - expected) < 1e-9;
}

export async function verifyMovie(moviePath, {
  frames,
  fps,
  width,
  height,
  ffprobe = "ffprobe",
} = {}) {
  const movie = realpathSync(resolve(moviePath));
  if (!Number.isSafeInteger(frames) || frames <= 0) throw new Error("verify requires a positive integer frame count");
  if (!Number.isFinite(fps) || fps <= 0) throw new Error("verify requires a positive fps");
  const result = await runProcess(ffprobe, [
    "-v", "error", "-count_packets", "-select_streams", "v:0",
    "-show_entries", "stream=codec_name,codec_type,width,height,r_frame_rate,avg_frame_rate,start_time,duration,nb_read_packets,color_range,color_space,color_transfer,color_primaries",
    "-of", "json", movie,
  ]);
  if (result.code !== 0) throw new Error(`ffprobe failed (${result.code}): ${result.stderr.trim()}`);
  const probe = JSON.parse(result.stdout);
  const video = probe.streams?.[0];
  const errors = [];
  if (!video) errors.push("missing video stream");
  if (video && video.codec_name !== "h264") errors.push(`codec ${video.codec_name ?? "missing"}, expected h264 for packet-count proof`);
  if (video && Number(video.nb_read_packets) !== frames) errors.push(`video packets ${video.nb_read_packets ?? "missing"}, expected ${frames}`);
  if (video && !ratioEqual(video.r_frame_rate, fps)) errors.push(`r_frame_rate ${video.r_frame_rate ?? "missing"}, expected ${fps}`);
  if (video && !ratioEqual(video.avg_frame_rate, fps)) errors.push(`avg_frame_rate ${video.avg_frame_rate ?? "missing"}, expected ${fps}`);
  if (video && width != null && Number(video.width) !== width) errors.push(`width ${video.width ?? "missing"}, expected ${width}`);
  if (video && height != null && Number(video.height) !== height) errors.push(`height ${video.height ?? "missing"}, expected ${height}`);
  if (video && Math.abs(Number(video.start_time ?? 0)) > 1e-9) errors.push(`start_time ${video.start_time}, expected 0`);
  return {
    kind: "hyperframes-delivery-fast-verification",
    schemaVersion: 1,
    movie,
    expectedFrames: frames,
    observedPackets: Number(video?.nb_read_packets),
    fps,
    width: Number(video?.width),
    height: Number(video?.height),
    passed: errors.length === 0,
    errors,
    probe: video ?? null,
    limitation: "Fast H.264 one-packet-per-output-frame contract; not a full pixel decode.",
  };
}

function boolArg(value) {
  return value === true ? "true" : value === false ? "false" : String(value);
}

export function buildRenderInvocation(config) {
  if (config?.kind !== "hyperframes-delivery-config" || config.schemaVersion !== 1) {
    throw new Error("render config must be kind=hyperframes-delivery-config schemaVersion=1");
  }
  for (const key of ["runtime", "main", "projectRoot", "entry", "output"]) {
    if (typeof config[key] !== "string" || config[key].length === 0) throw new Error(`missing config.${key}`);
  }
  const runtime = resolve(config.runtime);
  const main = resolve(config.main);
  const hyperframesRuntime = config.hyperframesRuntime == null
    ? null
    : String(config.hyperframesRuntime);
  const projectRoot = realpathSync(resolve(config.projectRoot));
  const output = resolve(config.output);
  if (!isAbsolute(runtime) || !isAbsolute(main)) throw new Error("runtime and main must resolve to absolute paths");
  if (!existsSync(runtime) || !existsSync(main)) throw new Error("runtime or main does not exist");
  if (hyperframesRuntime != null) {
    if (!isAbsolute(hyperframesRuntime)) throw new Error("config.hyperframesRuntime must be an absolute path");
    if (!existsSync(hyperframesRuntime) || !lstatSync(hyperframesRuntime).isFile()) {
      throw new Error(`HyperFrames runtime does not exist: ${hyperframesRuntime}`);
    }
  }
  const entryPath = resolve(projectRoot, config.entry);
  const entryRelative = relative(projectRoot, entryPath);
  if (entryRelative.startsWith("..") || isAbsolute(entryRelative)) throw new Error("config.entry escapes projectRoot");
  if (!existsSync(entryPath) || !lstatSync(entryPath).isFile()) throw new Error(`render entry does not exist: ${entryPath}`);
  const render = config.render ?? {};
  const requiredNumbers = ["width", "height", "fps", "frames"];
  for (const key of requiredNumbers) {
    if (!Number.isFinite(Number(render[key])) || Number(render[key]) <= 0) throw new Error(`invalid config.render.${key}`);
  }
  const args = [
    ...(config.runtimeArgs ?? []),
    main,
    `--projectRoot=${projectRoot}`,
    `--entry=${config.entry}`,
    `--output=${output}`,
    `--width=${Number(render.width)}`,
    `--height=${Number(render.height)}`,
    `--fps=${Number(render.fps)}`,
    `--frames=${Number(render.frames)}`,
    `--startFrame=${Number(render.startFrame ?? 0)}`,
    `--bitrate=${Number(render.bitrate ?? 40_000_000)}`,
  ];
  if (hyperframesRuntime != null) args.push(`--hyperframesRuntime=${resolve(hyperframesRuntime)}`);
  const named = {
    directMux: render.directMux ?? true,
    compositeMode: render.compositeMode ?? "layered",
    outputBackend: render.outputBackend ?? "webcodecs",
    mediaDecoderBackend: render.mediaDecoderBackend ?? "production-webcodecs",
    mediaFrameMode: render.mediaFrameMode ?? "video",
    mediaTargetMode: render.mediaTargetMode ?? "timing-plan",
    mediaAdvanceMode: render.mediaAdvanceMode ?? "playback-step",
    mediaTailPolicy: render.mediaTailPolicy ?? "hold-last",
    mediaPlaybackRate: render.mediaPlaybackRate ?? 0.5,
    mixProjectAudio: render.mixProjectAudio ?? true,
    audioCodec: render.audioCodec ?? "pcm_s24le",
    audioSampleRate: render.audioSampleRate ?? 48_000,
    frameMetricsMode: render.frameMetricsMode ?? "bounded",
    waitMode: render.waitMode ?? "synchronous-paint",
  };
  for (const [key, value] of Object.entries(named)) args.push(`--${key}=${boolArg(value)}`);
  for (const key of ["mediaTimingPlan", "mediaTimingPlanVerify", "canonicalMediaRoute", "canonicalMediaRouteVerify"]) {
    if (render[key] != null) args.push(`--${key}=${render[key]}`);
  }
  for (const token of render.extraArgs ?? []) args.push(String(token));
  const env = { ...process.env, ...(config.environment ?? {}) };
  return { runtime, args, env, output, projectRoot, render };
}

export async function renderFromConfig(configPath, { dryRun = false, output = null } = {}) {
  const loadedConfig = JSON.parse(readFileSync(resolve(configPath), "utf8"));
  const config = output == null ? loadedConfig : { ...loadedConfig, output: resolve(output) };
  const requiredFiles = await verifyRequiredFileSha256(config.requiredFileSha256 ?? {});
  const frozenModuleRoots = Object.keys(config.requiredFileSha256 ?? {})
    .filter((file) => [".mjs", ".js", ".cjs"].includes(extname(file).toLowerCase()));
  const frozenMainModuleClosure = config.automaticFallback?.enabled === true
    ? await verifyFrozenLocalModuleClosure(frozenModuleRoots, config.requiredFileSha256 ?? {})
    : [];
  let motionContract = null;
  if (config.automaticFallback?.enabled === true) {
    if (typeof config.authoringMotionContract !== "string" || config.authoringMotionContract.length === 0) {
      throw new Error(
        "automatic routing requires authoringMotionContract captured from an approved native authoring preview",
      );
    }
    motionContract = verifyMotionContract(config.projectRoot, config.authoringMotionContract);
    if (!motionContract.passed) {
      throw new Error(`authoring motion contract failed: ${motionContract.errors.join("; ")}`);
    }
  }
  const scanEntry = config.automaticFallback?.enabled === true ? config.entry : (config.compatibilityEntry ?? "index.html");
  const acknowledgedRuleIds = config.acknowledgedRuleIds ?? config.approvedRuleIds ?? [];
  const acknowledgedProjectScanSha256 = config.acknowledgedProjectScanSha256 ?? config.approvedProjectScanSha256;
  const scan = await scanProject(config.projectRoot, { acknowledgedRuleIds, entry: scanEntry });
  if (acknowledgedRuleIds.length > 0) {
    if (typeof acknowledgedProjectScanSha256 !== "string" || !/^[a-f0-9]{64}$/.test(acknowledgedProjectScanSha256)) {
      throw new Error("acknowledgedRuleIds require acknowledgedProjectScanSha256 from the exact compatibility scan");
    }
    if (acknowledgedProjectScanSha256 !== scan.projectScanSha256) {
      throw new Error(`project compatibility identity changed: ${scan.projectScanSha256}`);
    }
  }
  const routePlan = buildDeliveryRoutePlan(config, scan);
  if (routePlan.selectedRoute === "blocked") {
    throw new Error(`delivery blocked by unresolved compatibility findings: ${routePlan.unresolvedRuleIds.join(", ")}`);
  }
  const hasDynamicOpacityRisk = scan.findings.some(
    (finding) => finding.ruleId === "canvas-draw-dynamic-opacity",
  );
  const exactOpacityPolicy = (config.render?.extraArgs ?? []).find(
    (token) => String(token).startsWith("--partialOpacityPolicy="),
  );
  if (routePlan.selectedRoute === "production-exact"
      && hasDynamicOpacityRisk
      && exactOpacityPolicy !== "--partialOpacityPolicy=promote-dynamic") {
    throw new Error(
      "production exact render contains runtime opacity animation; prove faithful screenshot instead "
      + "or explicitly set --partialOpacityPolicy=promote-dynamic and review representative transition frames",
    );
  }
  let selectedRoute = routePlan.selectedRoute;
  let selectedConfig = configForRoute(config, selectedRoute);
  let invocation = buildRenderInvocation(selectedConfig);
  const routeEvidence = automaticRouteEvidencePath(config, invocation.output);
  if (dryRun) {
    return {
      scan,
      requiredFiles,
      frozenMainModuleClosure,
      motionContract,
      routePlan,
      routeEvidence,
      invocation: { ...invocation, env: undefined },
      dryRun: true,
    };
  }
  if (existsSync(invocation.output)) throw new Error(`output already exists: ${invocation.output}`);
  if (routeEvidence != null) {
    if (existsSync(routeEvidence)) throw new Error(`route evidence already exists: ${routeEvidence}`);
    writeFileSync(routeEvidence, `${JSON.stringify({
      at: new Date().toISOString(),
      event: "route-selected",
      output: invocation.output,
      projectScanSha256: scan.projectScanSha256,
      motionContractSha256: motionContract?.contractSha256 ?? null,
      routePlan,
    })}\n`, { flag: "wx" });
  }
  const attempts = [];
  let run;
  try {
    run = await runProcess(invocation.runtime, invocation.args, { env: invocation.env, inherit: true });
  } catch (error) {
    appendRouteEvidence(routeEvidence, { event: "launch-error", route: selectedRoute, error: String(error?.message ?? error) });
    throw error;
  }
  attempts.push({ route: selectedRoute, exitCode: run.code, signal: run.signal ?? null });
  appendRouteEvidence(routeEvidence, { event: "attempt-finished", ...attempts.at(-1) });
  if (run.code === 2 && selectedRoute === "production-exact" && config.automaticFallback?.enabled === true) {
    if (existsSync(invocation.output)) {
      appendRouteEvidence(routeEvidence, {
        event: "fallback-refused",
        reason: "exact-preflight-created-output",
      });
      throw new Error("exact preflight returned canonical-cache-required after creating an output; refusing fallback");
    }
    let fallbackScan;
    try {
      await verifyRequiredFileSha256(config.requiredFileSha256 ?? {});
      const fallbackMotionContract = verifyMotionContract(config.projectRoot, config.authoringMotionContract);
      if (!fallbackMotionContract.passed
          || fallbackMotionContract.currentMotionSignatureSha256 !== motionContract.currentMotionSignatureSha256) {
        throw new Error("authoring motion identity changed between exact preflight and fallback");
      }
      fallbackScan = await scanProject(config.projectRoot, { acknowledgedRuleIds, entry: scanEntry });
      if (fallbackScan.projectScanSha256 !== scan.projectScanSha256) {
        throw new Error(`project compatibility identity changed between exact preflight and fallback: ${fallbackScan.projectScanSha256}`);
      }
    } catch (error) {
      appendRouteEvidence(routeEvidence, {
        event: "fallback-refused",
        reason: "identity-reverification-failed",
        error: String(error?.message ?? error),
      });
      throw error;
    }
    selectedRoute = "faithful-screenshot";
    selectedConfig = configForRoute(config, selectedRoute);
    invocation = buildRenderInvocation(selectedConfig);
    appendRouteEvidence(routeEvidence, {
      event: "fallback-selected",
      from: "production-exact",
      to: selectedRoute,
      reason: "canonical-cache-required",
    });
    try {
      run = await runProcess(invocation.runtime, invocation.args, { env: invocation.env, inherit: true });
    } catch (error) {
      appendRouteEvidence(routeEvidence, { event: "launch-error", route: selectedRoute, error: String(error?.message ?? error) });
      throw error;
    }
    attempts.push({ route: selectedRoute, exitCode: run.code, signal: run.signal ?? null });
    appendRouteEvidence(routeEvidence, { event: "attempt-finished", ...attempts.at(-1) });
  }
  if (run.code !== 0) throw new Error(`render exited ${run.code}${run.signal ? ` (${run.signal})` : ""}`);
  let verification;
  try {
    verification = await verifyMovie(invocation.output, {
      frames: Number(invocation.render.frames),
      fps: Number(invocation.render.fps),
      width: Number(invocation.render.width),
      height: Number(invocation.render.height),
      ffprobe: config.ffprobe ?? "ffprobe",
    });
  } catch (error) {
    appendRouteEvidence(routeEvidence, {
      event: "fast-verification-error",
      error: String(error?.message ?? error),
    });
    throw error;
  }
  appendRouteEvidence(routeEvidence, { event: "fast-verification", passed: verification.passed, errors: verification.errors });
  if (!verification.passed) throw new Error(`fast verification failed: ${verification.errors.join("; ")}`);
  return {
    scan,
    requiredFiles,
    motionContract,
    routePlan: { ...routePlan, selectedRoute, reason: attempts.length > 1 ? "canonical-cache-required-fell-back-to-faithful-screenshot" : routePlan.reason },
    routeEvidence,
    attempts,
    invocation: { output: invocation.output },
    verification,
    dryRun: false,
  };
}

function contentType(file) {
  switch (extname(file).toLowerCase()) {
    case ".mov": return "video/quicktime";
    case ".mp4": return "video/mp4";
    case ".webm": return "video/webm";
    default: return "application/octet-stream";
  }
}

export function startPreviewServer(moviePath, { host = "0.0.0.0", port = 8765 } = {}) {
  const movie = realpathSync(resolve(moviePath));
  const size = statSync(movie).size;
  const fileName = basename(movie);
  const route = `/video/${encodeURIComponent(fileName)}`;
  const server = createServer((request, response) => {
    if (request.url === "/") {
      const html = `<!doctype html><meta charset="utf-8"><title>${fileName}</title><style>html,body{margin:0;background:#111;color:#eee;font:14px system-ui}main{max-width:1400px;margin:auto;padding:16px}video{width:100%;max-height:calc(100vh - 80px);background:#000}</style><main><video controls autoplay src="${route}"></video><p>${fileName}</p></main>`;
      response.writeHead(200, { "Cache-Control": "no-store", "Content-Type": "text/html; charset=utf-8", "Content-Length": Buffer.byteLength(html) });
      response.end(html);
      return;
    }
    if (request.url !== route) {
      response.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
      response.end("Not found\n");
      return;
    }
    const range = request.headers.range;
    if (!range) {
      response.writeHead(200, { "Accept-Ranges": "bytes", "Cache-Control": "no-store", "Content-Length": size, "Content-Type": contentType(movie) });
      if (request.method === "HEAD") response.end();
      else createReadStream(movie).pipe(response);
      return;
    }
    const match = /^bytes=(\d*)-(\d*)$/.exec(range);
    if (!match) {
      response.writeHead(416, { "Content-Range": `bytes */${size}` });
      response.end();
      return;
    }
    const start = match[1] === "" ? Math.max(0, size - Number(match[2])) : Number(match[1]);
    const end = match[1] === "" ? size - 1 : Math.min(size - 1, match[2] === "" ? size - 1 : Number(match[2]));
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end < start || start >= size) {
      response.writeHead(416, { "Content-Range": `bytes */${size}` });
      response.end();
      return;
    }
    response.writeHead(206, {
      "Accept-Ranges": "bytes", "Cache-Control": "no-store", "Content-Type": contentType(movie),
      "Content-Length": end - start + 1, "Content-Range": `bytes ${start}-${end}/${size}`,
    });
    if (request.method === "HEAD") response.end();
    else createReadStream(movie, { start, end }).pipe(response);
  });
  return new Promise((resolvePromise, rejectPromise) => {
    server.once("error", rejectPromise);
    server.listen(port, host, () => resolvePromise({ server, url: `http://${host}:${port}/`, movie }));
  });
}

function printScan(scan, json) {
  if (json) {
    console.log(JSON.stringify(scan, null, 2));
    return;
  }
  console.log(`Scanned ${scan.scannedFiles} files; blockers=${scan.blockerCount}, review=${scan.reviewCount}`);
  console.log(`Recommended backend: ${scan.recommendedBackend}`);
  for (const finding of scan.findings) {
    const acknowledged = finding.acknowledged ? " ACKNOWLEDGED" : "";
    console.log(`${finding.severity.toUpperCase()}${acknowledged} ${finding.ruleId} ${finding.file}:${finding.line} ${finding.evidence}`);
  }
  console.log(scan.limitation);
}

function usage() {
  console.log(`HyperFrames delivery helper\n\nUsage:\n  delivery.mjs check <project-root> [--entry=index.html --json --acknowledge=rule-a,rule-b]\n  delivery.mjs plan --config=/abs/config.json\n  delivery.mjs render --config=/abs/config.json [--output=/abs/output.mov] [--dry-run]\n  delivery.mjs verify <movie> --frames=N --fps=60 [--width=3840 --height=2160 --ffprobe=ffprobe]\n  delivery.mjs preview <movie> [--host=0.0.0.0 --port=8765]`);
}

async function main(argv) {
  const { positional, options } = parseCli(argv);
  const command = positional[0];
  if (command === "check") {
    if (!positional[1]) throw new Error("check requires a project root");
    const scan = await scanProject(positional[1], {
      acknowledgedRuleIds: String(options.acknowledge ?? options.approve ?? "").split(",").filter(Boolean),
      entry: String(options.entry ?? "index.html"),
    });
    printScan(scan, options.json === true);
    process.exitCode = scan.productionEligibleForLayered ? 0 : 2;
    return;
  }
  if (command === "verify") {
    if (!positional[1]) throw new Error("verify requires a movie path");
    const verification = await verifyMovie(positional[1], {
      frames: Number(options.frames), fps: Number(options.fps ?? 60),
      width: options.width == null ? null : Number(options.width),
      height: options.height == null ? null : Number(options.height),
      ffprobe: options.ffprobe ?? "ffprobe",
    });
    console.log(JSON.stringify(verification, null, 2));
    process.exitCode = verification.passed ? 0 : 1;
    return;
  }
  if (command === "render") {
    if (typeof options.config !== "string") throw new Error("render requires --config=/abs/config.json");
    const result = await renderFromConfig(options.config, {
      dryRun: options["dry-run"] === true,
      output: typeof options.output === "string" ? options.output : null,
    });
    console.log(JSON.stringify(result, null, 2));
    return;
  }
  if (command === "plan") {
    if (typeof options.config !== "string") throw new Error("plan requires --config=/abs/config.json");
    const result = await renderFromConfig(options.config, { dryRun: true });
    console.log(JSON.stringify(result, null, 2));
    return;
  }
  if (command === "preview") {
    if (!positional[1]) throw new Error("preview requires a movie path");
    const preview = await startPreviewServer(positional[1], { host: String(options.host ?? "0.0.0.0"), port: Number(options.port ?? 8765) });
    console.log(`HyperFrames preview: ${preview.url}`);
    return;
  }
  usage();
  if (command && command !== "help" && !options.help) process.exitCode = 2;
}

const isDirectRun = process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url;
if (isDirectRun) {
  main(process.argv.slice(2)).catch((error) => {
    console.error(error?.stack ?? String(error));
    process.exitCode = 1;
  });
}
