import { readFileSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parse } from "parse5";

function walk(node, visit) {
  visit(node);
  for (const child of node.childNodes ?? []) walk(child, visit);
  if (node.content) walk(node.content, visit);
}

function attribute(node, name) {
  return node.attrs?.find((item) => item.name === name) ?? null;
}

function textContent(node) {
  if (node.nodeName === "#text") return node.value ?? "";
  return (node.childNodes ?? []).map(textContent).join("");
}

function insideRoot(path, root) {
  const delta = relative(root, path);
  return delta === "" || (!delta.startsWith("..") && !delta.startsWith("/"));
}

const MEDIA_OBSERVABLE_PATTERNS = [
  [/\b(?:HTMLMediaElement|HTMLVideoElement|MediaSource|SourceBuffer)\b/, "media-runtime-api"],
  [/\b(?:srcObject|currentSrc|networkState|requestVideoFrameCallback|cancelVideoFrameCallback|videoWidth|videoHeight|captureStream)\b/, "media-observable-state"],
  [/\bcreateElement\s*\(\s*["'](?:video|audio|source)["']/, "dynamic-media-element"],
  [/\bimport\s*\(/, "dynamic-import"],
];

const TARGETED_MEDIA_MEMBERS = [
  "currentTime", "readyState", "networkState", "srcObject", "currentSrc", "duration", "error",
  "buffered", "seekable", "seeking", "ended", "videoWidth", "videoHeight", "preload", "autoplay",
  "load", "play", "pause", "requestVideoFrameCallback", "cancelVideoFrameCallback",
];

function auditBoundedStaticMedia({ document, entryPath, projectRoot }) {
  const blockers = [];
  const scriptPaths = new Set();
  const inlineScripts = [];
  const media = [];
  const root = resolve(projectRoot ?? dirname(entryPath));
  const addBlocker = (code, details = {}) => blockers.push({ code, ...details });

  walk(document, (node) => {
    if (node.tagName === "script") {
      const type = attribute(node, "type")?.value?.trim().toLowerCase() ?? "";
      if (type && !["text/javascript", "application/javascript", "module"].includes(type)) return;
      const src = attribute(node, "src")?.value ?? null;
      if (src) {
        try {
          const url = new URL(src, pathToFileURL(entryPath));
          if (url.protocol !== "file:") addBlocker("HF_SCREENSHOT_EXTERNAL_SCRIPT_UNAUDITED", { source: src });
          else {
            const path = fileURLToPath(url);
            if (!insideRoot(path, root)) addBlocker("HF_SCREENSHOT_SCRIPT_PATH_ESCAPE", { source: src });
            else scriptPaths.add(path);
          }
        } catch {
          addBlocker("HF_SCREENSHOT_INVALID_SCRIPT_URL", { source: src });
        }
      } else {
        inlineScripts.push({ source: `${entryPath}#inline-script`, code: textContent(node) });
      }
      return;
    }
    if (node.tagName !== "video" && node.tagName !== "audio") return;
    const id = attribute(node, "id")?.value ?? null;
    const sources = [];
    const direct = attribute(node, "src")?.value ?? null;
    if (direct) sources.push(direct);
    for (const child of node.childNodes ?? []) {
      if (child.tagName === "source") {
        const nested = attribute(child, "src")?.value ?? null;
        if (nested) sources.push(nested);
      }
    }
    if (!sources.length) addBlocker("HF_SCREENSHOT_DYNAMIC_MEDIA_SOURCE", { element: id ?? node.tagName });
    if (attribute(node, "autoplay")) addBlocker("HF_SCREENSHOT_AUTOPLAY_MEDIA", { element: id ?? node.tagName });
    for (const item of node.attrs ?? []) {
      if (item.name.toLowerCase().startsWith("on")) {
        addBlocker("HF_SCREENSHOT_INLINE_MEDIA_HANDLER", { element: id ?? node.tagName, attribute: item.name });
      }
    }
    for (const source of sources) {
      try {
        const url = new URL(source, pathToFileURL(entryPath));
        if (url.protocol !== "file:") {
          addBlocker("HF_SCREENSHOT_NON_FILE_MEDIA", { element: id ?? node.tagName, source });
        } else if (!insideRoot(fileURLToPath(url), root)) {
          addBlocker("HF_SCREENSHOT_MEDIA_PATH_ESCAPE", { element: id ?? node.tagName, source });
        }
      } catch {
        addBlocker("HF_SCREENSHOT_INVALID_MEDIA_URL", { element: id ?? node.tagName, source });
      }
    }
    media.push({ tagName: node.tagName, id, sources });
  });

  const queue = [...scriptPaths];
  const scannedScripts = [];
  const seen = new Set();
  while (queue.length) {
    const path = queue.shift();
    if (seen.has(path)) continue;
    seen.add(path);
    let code;
    try {
      code = readFileSync(path, "utf8");
    } catch (error) {
      addBlocker("HF_SCREENSHOT_SCRIPT_UNREADABLE", { source: path, error: error?.message || String(error) });
      continue;
    }
    scannedScripts.push(path);
    for (const match of code.matchAll(/(?:import|export)\s+(?:[^"']*?\s+from\s+)?["']([^"']+)["']/g)) {
      const specifier = match[1];
      if (!specifier.startsWith(".")) continue;
      let dependency = resolve(dirname(path), specifier);
      if (!/\.[cm]?js$/i.test(dependency)) dependency += ".js";
      if (!insideRoot(dependency, root)) addBlocker("HF_SCREENSHOT_SCRIPT_PATH_ESCAPE", { source: specifier, importer: path });
      else queue.push(dependency);
    }
    inlineScripts.push({ source: path, code });
  }

  for (const script of inlineScripts) {
    for (const [pattern, code] of MEDIA_OBSERVABLE_PATTERNS) {
      if (pattern.test(script.code)) addBlocker(`HF_SCREENSHOT_${code.toUpperCase().replaceAll("-", "_")}`, { source: script.source });
    }
    const memberPattern = TARGETED_MEDIA_MEMBERS.join("|");
    const directSelector = new RegExp(
      `(?:getElementById|querySelector)\\s*\\([^)]*\\)\\s*(?:\\?\\.|\\.)\\s*(?:${memberPattern})\\b`,
    );
    const namedMediaTarget = new RegExp(
      `\\b(?:[A-Za-z_$][\\w$]*(?:Video|Audio|Media|Player)|(?:video|audio|media|player)[\\w$]*)`
      + `\\s*(?:\\?\\.|\\.)\\s*(?:${memberPattern})\\b`,
    );
    if (directSelector.test(script.code) || namedMediaTarget.test(script.code)) {
      addBlocker("HF_SCREENSHOT_TARGETED_MEDIA_STATE_OR_LIFECYCLE", { source: script.source });
    }
  }

  const uniqueBlockers = [...new Map(blockers.map((item) => [JSON.stringify(item), item])).values()];
  return {
    eligible: uniqueBlockers.length === 0,
    contract: "static file-backed media with no audited project access to media loading state",
    media,
    scannedScripts,
    blockers: uniqueBlockers,
  };
}

/**
 * Inventory authored media without rewriting it. The main process installs a
 * request gate before navigation, so early media fetches can be blocked while
 * CSS selectors and project scripts still observe the exact authored DOM.
 */
export function transformScreenshotHtml({ entryPath, projectRoot = dirname(entryPath) }) {
  const html = readFileSync(entryPath, "utf8");
  const document = parse(html, { sourceCodeLocationInfo: true });
  const videos = [];
  walk(document, (node) => {
    if (node.tagName !== "video") return;
    const preload = attribute(node, "preload");
    videos.push({
      id: attribute(node, "id")?.value ?? null,
      source: attribute(node, "src")?.value ?? null,
      authoredPreload: preload?.value ?? null,
    });
  });
  return {
    html,
    report: {
      kind: "hyperframes-screenshot-entry-audit",
      schemaVersion: 2,
      policy: "authored HTML is byte-identical; main-process media requests stay blocked until the frame scheduler activates a verified source",
      domMutations: 0,
      videoCount: videos.length,
      videos,
      boundedStatic: auditBoundedStaticMedia({ document, entryPath, projectRoot }),
    },
  };
}
