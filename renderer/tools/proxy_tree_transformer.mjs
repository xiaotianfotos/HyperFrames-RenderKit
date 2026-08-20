import { existsSync, readFileSync } from "node:fs";
import { basename, isAbsolute, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parse, serialize } from "parse5";
import { proveStaticSelectorTargets } from "./static_selector_proof.mjs";

const MEDIA_ONLY_ATTRIBUTES = new Set([
  "autoplay",
  "controls",
  "controlslist",
  "crossorigin",
  "disablepictureinpicture",
  "disableremoteplayback",
  "loop",
  "muted",
  "playsinline",
  "poster",
  "preload",
  "src",
]);

const VIDEO_MEMBER_APIS = [
  "addTextTrack",
  "autoplay",
  "buffered",
  "canPlayType",
  "cancelVideoFrameCallback",
  "captureStream",
  "controls",
  "controlsList",
  "currentSrc",
  "currentTime",
  "defaultMuted",
  "defaultPlaybackRate",
  "disablePictureInPicture",
  "disableRemotePlayback",
  "duration",
  "ended",
  "error",
  "fastSeek",
  "load",
  "loop",
  "mediaKeys",
  "networkState",
  "onencrypted",
  "onwaitingforkey",
  "pause",
  "paused",
  "play",
  "playbackRate",
  "poster",
  "preservesPitch",
  "readyState",
  "requestPictureInPicture",
  "requestVideoFrameCallback",
  "remote",
  "seekable",
  "seeking",
  "setMediaKeys",
  "setSinkId",
  "sinkId",
  "src",
  "srcObject",
  "textTracks",
  "videoHeight",
  "videoTracks",
  "videoWidth",
  "volume",
];

export class ProxyTreeTransformError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = "ProxyTreeTransformError";
    this.code = code;
    this.blocker = true;
    this.details = details;
  }
}

function fail(code, message, details = {}) {
  throw new ProxyTreeTransformError(code, message, details);
}

function attribute(node, name) {
  return node.attrs?.find((item) => item.name.toLowerCase() === name.toLowerCase())?.value ?? null;
}

function hasAttribute(node, name) {
  return node.attrs?.some((item) => item.name.toLowerCase() === name.toLowerCase()) ?? false;
}

function setAttribute(node, name, value) {
  const existing = node.attrs?.find((item) => item.name.toLowerCase() === name.toLowerCase());
  if (existing) existing.value = String(value);
  else (node.attrs ??= []).push({ name, value: String(value) });
}

function positiveIntegerAttribute(node, name) {
  if (!hasAttribute(node, name)) return null;
  const raw = String(attribute(node, name)).trim();
  if (!/^\d+$/.test(raw) || Number(raw) < 1 || !Number.isSafeInteger(Number(raw))) {
    fail("HF_PROXY_INVALID_INTRINSIC_SIZE", `${nodeDescription(node)} has invalid ${name}=${raw}`, {
      video: nodeDescription(node),
      attribute: name,
      value: raw,
    });
  }
  return Number(raw);
}

function classTokens(node) {
  return String(attribute(node, "class") ?? "").split(/\s+/).filter(Boolean);
}

function childrenOf(node) {
  const children = [...(node.childNodes ?? [])];
  if (node.content) children.push(node.content);
  return children;
}

function walk(node, visit, parent = null) {
  visit(node, parent);
  for (const child of childrenOf(node)) walk(child, visit, node);
}

function injectExplicitBaseUrl(document, rawBaseUrl) {
  let url;
  try {
    url = new URL(String(rawBaseUrl));
  } catch (error) {
    fail("HF_PROXY_BASE_URL_INVALID", `proxy-tree base URL is invalid: ${rawBaseUrl}`, { cause: String(error) });
  }
  if (url.protocol !== "file:" || url.search || url.hash) {
    fail("HF_PROXY_BASE_URL_INVALID", `proxy-tree base URL must be a plain file URL: ${url.href}`, { baseUrl: url.href });
  }
  let head = null;
  walk(document, (node) => {
    if (!head && node.tagName === "head") head = node;
  });
  if (!head) fail("HF_PROXY_HEAD_MISSING", "proxy-tree parser did not produce a document head");
  const baseDocument = parse(`<base data-hf-proxy-base="" href="${url.href}">`);
  let base = null;
  walk(baseDocument, (node) => {
    if (!base && node.tagName === "base") base = node;
  });
  if (!base) fail("HF_PROXY_BASE_INJECTION_FAILED", "proxy-tree could not construct the explicit base element");
  base.parentNode = head;
  head.childNodes.unshift(base);
  return url.href;
}

function nodeDescription(node) {
  const id = attribute(node, "id");
  const location = node.sourceCodeLocation?.startLine;
  return `<${node.tagName ?? node.nodeName}${id ? `#${id}` : ""}>${location ? ` at line ${location}` : ""}`;
}

function resolveLocalReference(rawReference, entryPath, kind, { requireExists = true } = {}) {
  const raw = String(rawReference ?? "").trim();
  if (!raw) fail("HF_PROXY_UNRESOLVED_REFERENCE", `${kind} reference is empty`, { kind, raw });
  let url;
  try {
    if (isAbsolute(raw)) url = pathToFileURL(raw);
    else url = new URL(raw, pathToFileURL(entryPath));
  } catch (error) {
    fail("HF_PROXY_UNRESOLVED_REFERENCE", `Cannot resolve ${kind} reference ${raw}`, {
      kind,
      raw,
      cause: String(error),
    });
  }
  if (url.protocol !== "file:" || url.search || url.hash) {
    fail("HF_PROXY_NONLOCAL_REFERENCE", `${kind} must be a plain local file reference: ${raw}`, {
      kind,
      raw,
      resolved: url.href,
    });
  }
  const path = fileURLToPath(url);
  if (requireExists && !existsSync(path)) {
    fail("HF_PROXY_MISSING_REFERENCE", `${kind} does not exist: ${path}`, { kind, raw, path });
  }
  return { raw, path, url: url.href };
}

function stripCssCommentsAndStrings(css) {
  let output = "";
  let quote = null;
  let comment = false;
  let escaped = false;
  for (let index = 0; index < css.length; index += 1) {
    const character = css[index];
    const next = css[index + 1];
    if (comment) {
      if (character === "*" && next === "/") {
        output += "  ";
        index += 1;
        comment = false;
      } else output += character === "\n" ? "\n" : " ";
      continue;
    }
    if (!quote && character === "/" && next === "*") {
      output += "  ";
      index += 1;
      comment = true;
      continue;
    }
    if (quote) {
      output += character === "\n" ? "\n" : " ";
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === quote) quote = null;
      continue;
    }
    if (character === "'" || character === '"') {
      quote = character;
      output += " ";
      continue;
    }
    output += character;
  }
  return output;
}

function withoutAttributeSelectors(selector) {
  let output = "";
  let depth = 0;
  for (const character of selector) {
    if (character === "[") {
      depth += 1;
      output += " ";
    } else if (character === "]" && depth > 0) {
      depth -= 1;
      output += " ";
    } else output += depth > 0 ? " " : character;
  }
  return output;
}

export function selectorUsesVideoTag(selector) {
  const candidate = withoutAttributeSelectors(stripCssCommentsAndStrings(String(selector)));
  return /(^|[\s>+~,(|])video(?=$|[\s>+~.#:[\],)|])/i.test(candidate);
}

function selectorUsesVideoOnlyPseudo(selector) {
  const candidate = stripCssCommentsAndStrings(String(selector));
  return /(?:::cue(?:-region)?|::-webkit-media-controls|:(?:playing|paused|seeking|buffering|stalled|muted|volume-locked)\b)/i.test(candidate);
}

function selectorDependsOnCaptureReparenting(selector) {
  const rawCandidate = stripCssCommentsAndStrings(String(selector));
  const candidate = withoutAttributeSelectors(rawCandidate);
  if (/(^|[\s,(])(?:html|body)\b[^,{]*(?:>|\+|~)/i.test(candidate)) return true;
  for (const segment of rawCandidate.split(",")) {
    const rootAttribute = segment.toLowerCase().indexOf("[data-composition-id");
    if (rootAttribute < 0) continue;
    const before = segment.slice(0, rootAttribute);
    const closingBracket = segment.indexOf("]", rootAttribute);
    const after = closingBracket < 0 ? "" : segment.slice(closingBracket + 1);
    if (/[>+~]\s*$/.test(before) || /^\s*[+~]/.test(after)) return true;
  }
  return false;
}

function cssSelectorPreludes(css) {
  const clean = stripCssCommentsAndStrings(css);
  const preludes = [];
  let segmentStart = 0;
  for (let index = 0; index < clean.length; index += 1) {
    const character = clean[index];
    if (character === "{") {
      const prelude = clean.slice(segmentStart, index).trim();
      if (prelude) preludes.push(prelude);
      segmentStart = index + 1;
    } else if (character === "}" || character === ";") {
      segmentStart = index + 1;
    }
  }
  return preludes;
}

function assertCssCompatible(css, source) {
  const clean = stripCssCommentsAndStrings(css);
  if (/@import\b/i.test(clean)) {
    fail("HF_PROXY_CSS_IMPORT_UNAUDITED", `proxy-tree cannot audit CSS @import in ${source}`, { source });
  }
  for (const prelude of cssSelectorPreludes(css)) {
    if (prelude.includes("\\")) {
      fail("HF_PROXY_ESCAPED_CSS_SELECTOR", `proxy-tree cannot prove escaped CSS selector semantics in ${source}: ${prelude}`, {
        source,
        selector: prelude,
      });
    }
    if (selectorDependsOnCaptureReparenting(prelude)) {
      fail(
        "HF_PROXY_REPARENT_SELECTOR_UNSUPPORTED",
        `CSS in ${source} depends on html/body child or sibling structure changed by the capture canvas: ${prelude}`,
        { source, selector: prelude },
      );
    }
    if (/^@(?:scope|supports)\b/i.test(prelude)
        && (selectorUsesVideoTag(prelude) || selectorUsesVideoOnlyPseudo(prelude))) {
      fail("HF_PROXY_VIDEO_TAG_SELECTOR", `CSS in ${source} has a video-dependent at-rule: ${prelude}`, {
        source,
        selector: prelude,
      });
    }
    if (prelude.startsWith("@") || /^(?:from|to|\d+(?:\.\d+)?%)$/i.test(prelude)) continue;
    if (selectorUsesVideoTag(prelude) || selectorUsesVideoOnlyPseudo(prelude)) {
      fail("HF_PROXY_VIDEO_TAG_SELECTOR", `CSS in ${source} depends on the <video> tag selector: ${prelude}`, {
        source,
        selector: prelude,
      });
    }
  }
}

function stripJavaScriptComments(script) {
  let output = "";
  let quote = null;
  let blockComment = false;
  let lineComment = false;
  let escaped = false;
  for (let index = 0; index < script.length; index += 1) {
    const character = script[index];
    const next = script[index + 1];
    if (blockComment) {
      if (character === "*" && next === "/") {
        output += "  ";
        index += 1;
        blockComment = false;
      } else output += character === "\n" ? "\n" : " ";
      continue;
    }
    if (lineComment) {
      if (character === "\n") {
        lineComment = false;
        output += "\n";
      } else output += " ";
      continue;
    }
    if (!quote && character === "/" && next === "*") {
      output += "  ";
      index += 1;
      blockComment = true;
      continue;
    }
    if (!quote && character === "/" && next === "/") {
      output += "  ";
      index += 1;
      lineComment = true;
      continue;
    }
    output += character;
    if (quote) {
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === quote) quote = null;
    } else if (character === "'" || character === '"' || character === "`") quote = character;
  }
  return output;
}

function quotedArgumentMatches(script, methodNames, predicate) {
  const methods = methodNames.join("|");
  const expression = new RegExp(`\\b(?:${methods})\\s*\\(\\s*([\"'\\x60])([^\"'\\x60]*?)\\1`, "gi");
  for (const match of script.matchAll(expression)) {
    if (predicate(match[2])) return { method: match[0].slice(0, match[0].indexOf("(")), value: match[2] };
  }
  return null;
}

function stringLiteralBindings(script) {
  const bindings = new Map();
  const literalAssignment = /\b(?:(?:const|let|var)\s+)?([A-Za-z_$][\w$]*)\s*=\s*(["'`])([^"'`]*?)\2/g;
  for (const match of script.matchAll(literalAssignment)) bindings.set(match[1], match[3]);
  let changed = true;
  while (changed) {
    changed = false;
    const aliasAssignment = /\b(?:(?:const|let|var)\s+)?([A-Za-z_$][\w$]*)\s*=\s*([A-Za-z_$][\w$]*)\b/g;
    for (const match of script.matchAll(aliasAssignment)) {
      if (!bindings.has(match[1]) && bindings.has(match[2])) {
        bindings.set(match[1], bindings.get(match[2]));
        changed = true;
      }
    }
  }
  return bindings;
}

function selectorLiteralIsUnsafe(value) {
  return value.includes("\\") || selectorUsesVideoTag(value);
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function assertJavaScriptCompatible(
  script,
  source,
  videoIds,
  styleIds = [],
  { allowOpaqueSelectorRuntime = false } = {},
) {
  const clean = stripJavaScriptComments(script);
  const explicitPatterns = [
    [/\bHTMLVideoElement\b/, "HTMLVideoElement"],
    [/\bHTMLMediaElement\b/, "HTMLMediaElement"],
    [/\b(?:request|cancel)VideoFrameCallback\b/, "video-frame callback API"],
    [/\.\s*(?:videoWidth|videoHeight|currentSrc|srcObject|requestPictureInPicture|disablePictureInPicture)\b/, "video-only member API"],
    [/\b(?:(?:window|document)\s*\.\s*)?(?:location|URL|documentURI|baseURI)\b/, "entry-URL-dependent API"],
  ];
  for (const [pattern, api] of explicitPatterns) {
    if (pattern.test(clean)) {
      fail("HF_PROXY_VIDEO_SCRIPT_API", `JavaScript in ${source} uses ${api}`, { source, api });
    }
  }
  const unauditedDynamicPatterns = [
    [/\beval\s*\(/, "eval"],
    [/\bnew\s+Function\s*\(/, "Function constructor"],
    [/\bimport\s*\(/, "dynamic import"],
    [/\bdocument\s*\.\s*write(?:ln)?\s*\(/, "document.write"],
    [/\.\s*(?:insertRule|replaceSync)\s*\(/, "dynamic stylesheet mutation"],
    [/(?:document\s*\.\s*styleSheets(?:\s*\[[^\]]+\])?|\.\s*sheet)\s*\.\s*replace\s*\(/, "dynamic stylesheet replacement"],
    [/\bdocument\s*(?:\.\s*styleSheets|\[\s*["']styleSheets["']\s*\])/, "dynamic document.styleSheets access"],
    [/\b(?:new\s+)?CSSStyleSheet\b|\badoptedStyleSheets\b/, "constructable stylesheet"],
    [/\bcreateElement\s*\(\s*["'](?:script|style|link)["']/, "dynamic script/style element"],
  ];
  for (const [pattern, api] of unauditedDynamicPatterns) {
    if (pattern.test(clean)) {
      fail("HF_PROXY_DYNAMIC_CODE_UNAUDITED", `JavaScript in ${source} uses unaudited ${api}`, { source, api });
    }
  }
  const styleSelectors = ["style", ...styleIds.filter(Boolean).map((id) => `#${id}`)];
  for (const selector of styleSelectors) {
    const escapedSelector = escapeRegExp(selector);
    const idAlternative = selector.startsWith("#")
      ? `|getElementById\\s*\\(\\s*["']${escapeRegExp(selector.slice(1))}["']\\s*\\)`
      : "";
    const directStyleMutation = new RegExp(
      `(?:querySelector\\s*\\(\\s*["']${escapedSelector}["']\\s*\\)${idAlternative})\\s*(?:\\.|\\?\\.)\\s*(?:textContent|innerHTML|innerText)\\s*=`,
      "i",
    );
    if (directStyleMutation.test(clean)) {
      fail("HF_PROXY_DYNAMIC_CODE_UNAUDITED", `JavaScript in ${source} mutates an existing <style> element`, {
        source,
        selector,
      });
    }
  }
  const styleVariables = new Set();
  const styleVariableAssignment = /\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:document\s*\.\s*)?querySelector\s*\(\s*["']style["']\s*\)/gi;
  for (const match of clean.matchAll(styleVariableAssignment)) styleVariables.add(match[1]);
  for (const styleId of styleIds.filter(Boolean)) {
    const escapedStyleId = escapeRegExp(styleId);
    const styleIdAssignment = new RegExp(
      `\\b(?:const|let|var)\\s+([A-Za-z_$][\\w$]*)\\s*=\\s*(?:document\\s*\\.\\s*)?(?:getElementById\\s*\\(\\s*["']${escapedStyleId}["']\\s*\\)|querySelector\\s*\\(\\s*["']#${escapedStyleId}["']\\s*\\))`,
      "gi",
    );
    for (const match of clean.matchAll(styleIdAssignment)) styleVariables.add(match[1]);
    if (/^[A-Za-z_$][\w$]*$/.test(styleId)
        && new RegExp(`\\b${escapedStyleId}\\s*(?:\\.|\\?\\.)\\s*(?:textContent|innerHTML|innerText)\\s*=`, "i").test(clean)) {
      fail("HF_PROXY_DYNAMIC_CODE_UNAUDITED", `JavaScript in ${source} mutates global <style> #${styleId}`, {
        source,
        id: styleId,
      });
    }
  }
  let styleAliasesChanged = true;
  while (styleAliasesChanged) {
    styleAliasesChanged = false;
    const aliasAssignment = /\b(?:(?:const|let|var)\s+)?([A-Za-z_$][\w$]*)\s*=\s*([A-Za-z_$][\w$]*)\b/g;
    for (const match of clean.matchAll(aliasAssignment)) {
      if (!styleVariables.has(match[1]) && styleVariables.has(match[2])) {
        styleVariables.add(match[1]);
        styleAliasesChanged = true;
      }
    }
  }
  for (const variableName of styleVariables) {
    if (new RegExp(`\\b${escapeRegExp(variableName)}\\s*(?:\\.|\\?\\.)\\s*(?:textContent|innerHTML|innerText)\\s*=`, "i").test(clean)) {
      fail("HF_PROXY_DYNAMIC_CODE_UNAUDITED", `JavaScript in ${source} mutates existing <style> variable ${variableName}`, {
        source,
        variable: variableName,
      });
    }
  }

  const selectorUse = quotedArgumentMatches(
    clean,
    ["querySelector", "querySelectorAll", "matches", "closest"],
    selectorLiteralIsUnsafe,
  );
  if (selectorUse) {
    fail("HF_PROXY_VIDEO_SCRIPT_SELECTOR", `JavaScript in ${source} selects by <video> tag`, {
      source,
      method: selectorUse.method,
      selector: selectorUse.value,
    });
  }
  const gsapSelectorExpression = /\bgsap\s*\.\s*(?:to|from|fromTo|set|quickTo|quickSetter)\s*\(\s*(["'`])([^"'`]*?)\1/gi;
  for (const match of clean.matchAll(gsapSelectorExpression)) {
    if (selectorLiteralIsUnsafe(match[2])) {
      fail("HF_PROXY_VIDEO_SCRIPT_SELECTOR", `GSAP in ${source} targets by <video> tag`, {
        source,
        method: match[0].slice(0, match[0].indexOf("(")),
        selector: match[2],
      });
    }
  }
  const timelineVariables = new Set();
  const timelineAssignment = /\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*gsap\s*\.\s*timeline\s*\(/gi;
  for (const match of clean.matchAll(timelineAssignment)) timelineVariables.add(match[1]);
  for (const variableName of timelineVariables) {
    const variable = escapeRegExp(variableName);
    const timelineSelector = new RegExp(
      `\\b${variable}\\s*(?:\\.|\\?\\.)\\s*(?:to|from|fromTo|set)\\s*\\(\\s*([\"'\\x60])([^\"'\\x60]*?)\\1`,
      "gi",
    );
    for (const match of clean.matchAll(timelineSelector)) {
      if (selectorLiteralIsUnsafe(match[2])) {
        fail("HF_PROXY_VIDEO_SCRIPT_SELECTOR", `GSAP timeline ${variableName} in ${source} targets by <video> tag`, {
          source,
          variable: variableName,
          selector: match[2],
        });
      }
    }
  }
  const chainedTimelineSelector = /\bgsap\s*\.\s*timeline\s*\([^)]*\)\s*\.\s*(?:to|from|fromTo|set)\s*\(\s*(["'`])([^"'`]*?)\1/gi;
  for (const match of clean.matchAll(chainedTimelineSelector)) {
    if (selectorLiteralIsUnsafe(match[2])) {
      fail("HF_PROXY_VIDEO_SCRIPT_SELECTOR", `Chained GSAP timeline in ${source} targets by <video> tag`, {
        source,
        selector: match[2],
      });
    }
  }
  const tagLookup = quotedArgumentMatches(clean, ["getElementsByTagName", "createElement"], (value) => (
    value.trim().toLowerCase() === "video"
  ));
  if (tagLookup) {
    fail("HF_PROXY_VIDEO_SCRIPT_TAG_API", `JavaScript in ${source} dynamically accesses <video>`, {
      source,
      method: tagLookup.method,
      value: tagLookup.value,
    });
  }

  const computedSelectorCall = /\[\s*(["'`])(querySelector|querySelectorAll|matches|closest|getElementsByTagName|createElement)\1\s*\]\s*\(\s*(["'`])([^"'`]*?)\3/gi;
  for (const match of clean.matchAll(computedSelectorCall)) {
    const value = match[4];
    const tagMethod = /^(?:getElementsByTagName|createElement)$/i.test(match[2]);
    if ((tagMethod && value.trim().toLowerCase() === "video")
        || (!tagMethod && selectorLiteralIsUnsafe(value))) {
      fail("HF_PROXY_VIDEO_SCRIPT_SELECTOR", `JavaScript in ${source} uses computed video selector API`, {
        source,
        method: match[2],
        selector: value,
      });
    }
  }

  const genericAnimationSelector = /\.\s*(?:to|from|fromTo|set|quickTo|quickSetter|toArray)\s*\(\s*(["'`])([^"'`]*?)\1/gi;
  for (const match of clean.matchAll(genericAnimationSelector)) {
    if (selectorLiteralIsUnsafe(match[2])) {
      fail("HF_PROXY_VIDEO_SCRIPT_SELECTOR", `Animation code in ${source} targets by <video> tag`, {
        source,
        selector: match[2],
      });
    }
  }

  for (const [variableName, value] of stringLiteralBindings(clean)) {
    if (!selectorLiteralIsUnsafe(value)) continue;
    const variable = escapeRegExp(variableName);
    const dynamicSelectorUse = new RegExp(
      `(?:\\b(?:querySelector|querySelectorAll|matches|closest|getElementsByTagName|createElement)\\s*\\(|\\.\\s*(?:to|from|fromTo|set|quickTo|quickSetter|toArray)\\s*\\()\\s*${variable}\\b`,
      "i",
    );
    if (dynamicSelectorUse.test(clean)) {
      fail("HF_PROXY_VIDEO_SCRIPT_SELECTOR", `JavaScript in ${source} aliases a <video> selector through ${variableName}`, {
        source,
        variable: variableName,
        selector: value,
      });
    }
  }
  let selectorProof = null;
  if (!allowOpaqueSelectorRuntime) {
    try {
      selectorProof = proveStaticSelectorTargets({ source: script, sourceLabel: source });
    } catch (error) {
      fail(
        "HF_PROXY_DYNAMIC_SELECTOR_UNAUDITED",
        `JavaScript in ${source} could not be parsed for restricted static selector proof`,
        { source, reason: "selector-proof-parse-failed", cause: String(error) },
      );
    }
    const unsafeTarget = selectorProof.targets.find((target) => (
      target.selectors.some(selectorLiteralIsUnsafe)
    ));
    if (unsafeTarget) {
      fail(
        "HF_PROXY_VIDEO_SCRIPT_SELECTOR",
        `JavaScript in ${source} resolves a selector/animation target to <video>`,
        {
          source,
          method: unsafeTarget.method,
          selectors: unsafeTarget.selectors,
          line: unsafeTarget.line,
          selectorProofIdentity: selectorProof.proofIdentity,
        },
      );
    }
    if (!selectorProof.eligible) {
      const first = selectorProof.blockers[0];
      fail(
        "HF_PROXY_DYNAMIC_SELECTOR_UNAUDITED",
        `JavaScript in ${source} uses a selector/animation target that restricted AST analysis cannot prove`,
        {
          source,
          reason: first?.reason ?? "selector-proof-failed",
          expression: first?.expression ?? null,
          line: first?.line ?? null,
          selectorProofIdentity: selectorProof.proofIdentity,
          blockerCount: selectorProof.blockers.length,
        },
      );
    }
  }

  const memberPattern = VIDEO_MEMBER_APIS.join("|");
  const selectedVariables = new Set();
  const selectedAssignment = /\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:document\s*\.\s*)?(?:getElementById|querySelector)\s*\(/gi;
  for (const match of clean.matchAll(selectedAssignment)) selectedVariables.add(match[1]);
  let selectedAliasesChanged = true;
  while (selectedAliasesChanged) {
    selectedAliasesChanged = false;
    const aliasAssignment = /\b(?:(?:const|let|var)\s+)?([A-Za-z_$][\w$]*)\s*=\s*([A-Za-z_$][\w$]*)\b/g;
    for (const match of clean.matchAll(aliasAssignment)) {
      if (!selectedVariables.has(match[1]) && selectedVariables.has(match[2])) {
        selectedVariables.add(match[1]);
        selectedAliasesChanged = true;
      }
    }
  }
  for (const variableName of selectedVariables) {
    const variable = escapeRegExp(variableName);
    const mediaMember = new RegExp(
      `\\b${variable}\\s*(?:(?:\\.|\\?\\.)\\s*(?:${memberPattern})\\b|\\[\\s*[\"'](?:${memberPattern})[\"']\\s*\\])`,
      "i",
    );
    if (mediaMember.test(clean)) {
      fail("HF_PROXY_VIDEO_SCRIPT_API", `JavaScript in ${source} calls a media API on selected DOM variable ${variableName}`, {
        source,
        variable: variableName,
      });
    }
    const mediaEvent = new RegExp(
      `\\b${variable}\\s*(?:\\.|\\?\\.)\\s*addEventListener\\s*\\(\\s*[\"'](?:loadedmetadata|loadeddata|canplay|durationchange|emptied|ended|pause|play|playing|progress|ratechange|seeked|seeking|stalled|suspend|timeupdate|volumechange|waiting)[\"']`,
      "i",
    );
    if (mediaEvent.test(clean)) {
      fail("HF_PROXY_VIDEO_SCRIPT_API", `JavaScript in ${source} subscribes to a media event on ${variableName}`, {
        source,
        variable: variableName,
      });
    }
    const mediaAttribute = new RegExp(
      `\\b${variable}\\s*(?:\\.|\\?\\.)\\s*(?:getAttribute|hasAttribute|setAttribute|removeAttribute)\\s*\\(\\s*[\"'](?:src|poster|preload|autoplay|controls|loop|muted|playsinline|crossorigin)[\"']`,
      "i",
    );
    if (mediaAttribute.test(clean)) {
      fail("HF_PROXY_VIDEO_SCRIPT_API", `JavaScript in ${source} reads or writes a media attribute on ${variableName}`, {
        source,
        variable: variableName,
      });
    }
    const replacedIdentity = new RegExp(
      `\\b${variable}\\s*(?:\\.|\\?\\.)\\s*(?:tagName|localName|nodeName|children|childNodes|firstChild|firstElementChild|lastChild|lastElementChild)\\b`,
      "i",
    );
    if (replacedIdentity.test(clean)) {
      fail("HF_PROXY_VIDEO_SCRIPT_IDENTITY", `JavaScript in ${source} inspects replaced-node identity through ${variableName}`, {
        source,
        variable: variableName,
      });
    }
    const nestedSourceQuery = new RegExp(
      `\\b${variable}\\s*(?:\\.|\\?\\.)\\s*(?:querySelector|querySelectorAll)\\s*\\(\\s*[\"'][^\"']*\\bsource\\b`,
      "i",
    );
    if (nestedSourceQuery.test(clean)) {
      fail("HF_PROXY_VIDEO_SCRIPT_IDENTITY", `JavaScript in ${source} inspects nested <source> nodes through ${variableName}`, {
        source,
        variable: variableName,
      });
    }
  }
  for (const id of videoIds.filter(Boolean)) {
    const escapedId = escapeRegExp(id);
    const direct = new RegExp(
      `(?:getElementById\\s*\\(\\s*[\"']${escapedId}[\"']\\s*\\)|querySelector\\s*\\(\\s*[\"']#${escapedId}[\"']\\s*\\))\\s*(?:(?:\\.|\\?\\.)\\s*(?:${memberPattern})\\b|\\[\\s*[\"'](?:${memberPattern})[\"']\\s*\\])`,
      "i",
    );
    if (direct.test(clean)) {
      fail("HF_PROXY_VIDEO_SCRIPT_API", `JavaScript in ${source} calls a media API on #${id}`, { source, id });
    }
    const directIdentity = new RegExp(
      `(?:getElementById\\s*\\(\\s*[\"']${escapedId}[\"']\\s*\\)|querySelector\\s*\\(\\s*[\"']#${escapedId}[\"']\\s*\\))\\s*(?:\\.|\\?\\.)\\s*(?:tagName|localName|nodeName|children|childNodes|firstChild|firstElementChild|lastChild|lastElementChild)\\b`,
      "i",
    );
    if (directIdentity.test(clean)) {
      fail("HF_PROXY_VIDEO_SCRIPT_IDENTITY", `JavaScript in ${source} inspects replaced-node identity for #${id}`, {
        source,
        id,
      });
    }
    const assignment = new RegExp(
      `\\b(?:const|let|var)\\s+([A-Za-z_$][\\w$]*)\\s*=\\s*(?:document\\s*\\.\\s*)?(?:getElementById\\s*\\(\\s*[\"']${escapedId}[\"']\\s*\\)|querySelector\\s*\\(\\s*[\"']#${escapedId}[\"']\\s*\\))`,
      "gi",
    );
    for (const match of clean.matchAll(assignment)) {
      const variable = escapeRegExp(match[1]);
      if (new RegExp(`\\b${variable}\\s*\\.\\s*(?:${memberPattern})\\b`, "i").test(clean.slice(match.index + match[0].length))) {
        fail("HF_PROXY_VIDEO_SCRIPT_API", `JavaScript in ${source} calls a media API on #${id} via ${match[1]}`, {
          source,
          id,
          variable: match[1],
        });
      }
    }
    if (/^[A-Za-z_$][\w$]*$/.test(id)) {
      const globalIdMediaAccess = new RegExp(
        `\\b${escapedId}\\s*(?:(?:\\.|\\?\\.)\\s*(?:${memberPattern})\\b|\\[\\s*[\"'](?:${memberPattern})[\"']\\s*\\])`,
        "i",
      );
      if (globalIdMediaAccess.test(clean)) {
        fail("HF_PROXY_VIDEO_SCRIPT_API", `JavaScript in ${source} uses global-id media access for #${id}`, {
          source,
          id,
        });
      }
      const globalIdIdentity = new RegExp(
        `\\b${escapedId}\\s*(?:\\.|\\?\\.)\\s*(?:tagName|localName|nodeName|children|childNodes|firstChild|firstElementChild|lastChild|lastElementChild)\\b`,
        "i",
      );
      if (globalIdIdentity.test(clean)) {
        fail("HF_PROXY_VIDEO_SCRIPT_IDENTITY", `JavaScript in ${source} inspects replaced-node identity through global #${id}`, {
          source,
          id,
        });
      }
    }
  }
  return selectorProof;
}

function textContent(node) {
  return (node.childNodes ?? []).map((child) => child.value ?? child.data ?? "").join("");
}

function scriptIsJavaScript(node) {
  const type = String(attribute(node, "type") ?? "").trim().toLowerCase();
  return !type || ["text/javascript", "application/javascript"].includes(type) || type === "module";
}

function isKnownGsapSelectorRuntime(path, script) {
  return /^gsap(?:\.min)?\.js$/i.test(basename(path))
    && /\bgsap\b/i.test(script)
    && /querySelectorAll/.test(script);
}

function resolveVideoSource(video, entryPath) {
  const directSource = String(attribute(video, "src") ?? "").trim();
  const elementChildren = (video.childNodes ?? []).filter((child) => child.tagName);
  const sourceChildren = elementChildren.filter((child) => child.tagName === "source");
  const unsupportedChildren = elementChildren.filter((child) => child.tagName !== "source");
  const fallbackText = (video.childNodes ?? [])
    .filter((child) => child.nodeName === "#text")
    .map((child) => child.value ?? "")
    .join("")
    .trim();
  if (unsupportedChildren.length || fallbackText) {
    fail("HF_PROXY_VIDEO_CHILDREN_UNSUPPORTED", `${nodeDescription(video)} has fallback content that proxy-tree cannot preserve`, {
      video: nodeDescription(video),
    });
  }
  if (directSource && sourceChildren.length) {
    fail("HF_PROXY_AMBIGUOUS_VIDEO_SOURCE", `${nodeDescription(video)} mixes src with nested <source>`, {
      video: nodeDescription(video),
    });
  }
  if (!directSource && sourceChildren.length !== 1) {
    fail("HF_PROXY_AMBIGUOUS_VIDEO_SOURCE", `${nodeDescription(video)} must declare exactly one resolvable media source`, {
      video: nodeDescription(video),
      sourceCount: sourceChildren.length,
    });
  }
  const sourceNode = sourceChildren[0] ?? null;
  if (sourceNode && hasAttribute(sourceNode, "media")) {
    fail("HF_PROXY_CONDITIONAL_VIDEO_SOURCE", `${nodeDescription(video)} uses a conditional <source media>`, {
      video: nodeDescription(video),
    });
  }
  if (sourceNode && (sourceNode.childNodes ?? []).some((child) => (
    child.nodeName !== "#text" || String(child.value ?? "").trim()
  ))) {
    fail("HF_PROXY_VIDEO_SOURCE_CHILDREN", `${nodeDescription(sourceNode)} has unsupported content`, {
      video: nodeDescription(video),
    });
  }
  const raw = directSource || String(attribute(sourceNode, "src") ?? "").trim();
  const resolved = resolveLocalReference(raw, entryPath, "video source");
  return {
    raw,
    resolvedPath: resolved.path,
    resolvedUrl: resolved.url,
    sourceKind: directSource ? "src" : "source",
    type: sourceNode ? String(attribute(sourceNode, "type") ?? "").trim() || null : null,
  };
}

function intrinsicDimensionsForSource(intrinsicDimensionsBySource, sourceUrl) {
  const raw = intrinsicDimensionsBySource instanceof Map
    ? intrinsicDimensionsBySource.get(sourceUrl)
    : intrinsicDimensionsBySource?.[sourceUrl];
  if (raw == null) return null;
  const width = Number(raw.width);
  const height = Number(raw.height);
  if (!Number.isSafeInteger(width) || width < 1 || !Number.isSafeInteger(height) || height < 1) {
    fail("HF_PROXY_INVALID_SOURCE_DIMENSIONS", `Timing plan has invalid source dimensions for ${sourceUrl}`, {
      sourceUrl,
      width: raw.width,
      height: raw.height,
    });
  }
  return { width, height };
}

function establishProxyIntrinsicSize(video, media, intrinsicDimensionsBySource) {
  const declaredWidth = positiveIntegerAttribute(video, "width");
  const declaredHeight = positiveIntegerAttribute(video, "height");
  const sourceDimensions = intrinsicDimensionsForSource(intrinsicDimensionsBySource, media.resolvedUrl);
  if ((declaredWidth == null || declaredHeight == null) && !sourceDimensions) {
    fail(
      "HF_PROXY_INTRINSIC_SIZE_UNPROVEN",
      `${nodeDescription(video)} needs verified source dimensions before proxy-tree can preserve auto/aspect-ratio layout`,
      { video: nodeDescription(video), sourceUrl: media.resolvedUrl },
    );
  }
  let proxyWidth = declaredWidth;
  let proxyHeight = declaredHeight;
  if (proxyWidth == null && proxyHeight == null) {
    proxyWidth = sourceDimensions.width;
    proxyHeight = sourceDimensions.height;
  } else if (proxyWidth == null) {
    proxyWidth = Math.max(1, Math.round(proxyHeight * sourceDimensions.width / sourceDimensions.height));
  } else if (proxyHeight == null) {
    proxyHeight = Math.max(1, Math.round(proxyWidth * sourceDimensions.height / sourceDimensions.width));
  }
  setAttribute(video, "width", proxyWidth);
  setAttribute(video, "height", proxyHeight);
  return {
    width: proxyWidth,
    height: proxyHeight,
    sourceWidth: sourceDimensions?.width ?? null,
    sourceHeight: sourceDimensions?.height ?? null,
    policy: declaredWidth != null && declaredHeight != null
      ? "preserved-explicit-width-height"
      : declaredWidth != null
        ? "derived-height-from-verified-source-ratio"
        : declaredHeight != null
          ? "derived-width-from-verified-source-ratio"
          : "verified-source-intrinsic-dimensions",
  };
}

function assertVideoNodeCompatible(video, parent, compositionRoots) {
  if (!compositionRoots.has(parent) || !classTokens(video).includes("clip")) {
    fail(
      "HF_PROXY_VIDEO_DOM_UNSUPPORTED",
      `${nodeDescription(video)} must be a direct .clip child of [data-composition-id]`,
      { video: nodeDescription(video) },
    );
  }
  if (hasAttribute(video, "controls")) {
    fail("HF_PROXY_VIDEO_CONTROLS_UNSUPPORTED", `${nodeDescription(video)} uses visible native video controls`, {
      video: nodeDescription(video),
    });
  }
  for (const item of video.attrs ?? []) {
    if (item.name.toLowerCase().startsWith("on")) {
      fail("HF_PROXY_VIDEO_INLINE_EVENT", `${nodeDescription(video)} uses inline media/event handler ${item.name}`, {
        video: nodeDescription(video),
        attribute: item.name,
      });
    }
  }
  for (const reserved of [
    "data-hf-video-proxy",
    "data-hf-video-src",
    "data-hf-video-source-kind",
    "data-hf-video-type",
    "data-hf-video-source-width",
    "data-hf-video-source-height",
  ]) {
    if (hasAttribute(video, reserved)) {
      fail("HF_PROXY_RESERVED_ATTRIBUTE", `${nodeDescription(video)} already uses reserved attribute ${reserved}`, {
        video: nodeDescription(video),
        attribute: reserved,
      });
    }
  }
}

function convertVideoToProxy(video, media, intrinsicSize) {
  video.nodeName = "canvas";
  video.tagName = "canvas";
  // Keep media-only attributes and nested <source> nodes as inert compatibility
  // mirrors. A canvas never loads them, while authored selectors such as
  // `.clip[src]`, `#hero[muted]`, or `.clip:has(> source)` retain their result.
  // The data-hf descriptor remains the only renderer/media-loader authority.
  video.attrs.push(
    { name: "data-hf-video-proxy", value: "" },
    { name: "data-hf-video-src", value: media.raw },
    { name: "data-hf-video-source-kind", value: media.sourceKind },
  );
  if (media.type) video.attrs.push({ name: "data-hf-video-type", value: media.type });
  if (intrinsicSize.sourceWidth && intrinsicSize.sourceHeight) {
    video.attrs.push(
      { name: "data-hf-video-source-width", value: String(intrinsicSize.sourceWidth) },
      { name: "data-hf-video-source-height", value: String(intrinsicSize.sourceHeight) },
    );
  }
}

function inspectStylesAndScripts(document, entryPath, videoIds) {
  const resources = { stylesheets: [], scripts: [] };
  const styleIds = [];
  walk(document, (node) => {
    if (node.tagName === "style" && attribute(node, "id")) styleIds.push(attribute(node, "id"));
  });
  walk(document, (node) => {
    const inlineHandler = node.attrs?.find((item) => item.name.toLowerCase().startsWith("on"));
    if (inlineHandler) {
      fail("HF_PROXY_INLINE_HANDLER_UNAUDITED", `${nodeDescription(node)} uses inline handler ${inlineHandler.name}`, {
        element: nodeDescription(node),
        attribute: inlineHandler.name,
      });
    }
    if (node.tagName === "style") {
      const source = `${entryPath}:inline-style:${node.sourceCodeLocation?.startLine ?? "?"}`;
      assertCssCompatible(textContent(node), source);
      resources.stylesheets.push({ source, kind: "inline" });
      return;
    }
    if (node.tagName === "link"
        && String(attribute(node, "rel") ?? "").toLowerCase().split(/\s+/).includes("stylesheet")) {
      const reference = resolveLocalReference(attribute(node, "href"), entryPath, "stylesheet");
      assertCssCompatible(readFileSync(reference.path, "utf8"), reference.path);
      resources.stylesheets.push({ source: reference.path, kind: "local" });
      return;
    }
    if (node.tagName !== "script" || !scriptIsJavaScript(node)) return;
    const type = String(attribute(node, "type") ?? "").trim().toLowerCase();
    if (type === "module") {
      fail("HF_PROXY_MODULE_SCRIPT_UNAUDITED", `proxy-tree cannot recursively audit module script at ${nodeDescription(node)}`, {
        script: nodeDescription(node),
      });
    }
    const src = attribute(node, "src");
    if (src) {
      const reference = resolveLocalReference(src, entryPath, "script");
      const script = readFileSync(reference.path, "utf8");
      const allowOpaqueSelectorRuntime = isKnownGsapSelectorRuntime(reference.path, script);
      const selectorProof = assertJavaScriptCompatible(
        script,
        reference.path,
        videoIds,
        styleIds,
        { allowOpaqueSelectorRuntime },
      );
      resources.scripts.push({
        source: reference.path,
        kind: "local",
        selectorAudit: allowOpaqueSelectorRuntime ? "known-gsap-runtime-callers-audited" : "strict-static",
        selectorProofIdentity: selectorProof?.proofIdentity ?? null,
        selectorProofTargetCount: selectorProof?.targets.length ?? null,
      });
    } else {
      const source = `${entryPath}:inline-script:${node.sourceCodeLocation?.startLine ?? "?"}`;
      const selectorProof = assertJavaScriptCompatible(textContent(node), source, videoIds, styleIds);
      resources.scripts.push({
        source,
        kind: "inline",
        selectorAudit: "strict-static",
        selectorProofIdentity: selectorProof?.proofIdentity ?? null,
        selectorProofTargetCount: selectorProof?.targets.length ?? null,
      });
    }
  });
  return resources;
}

export function transformProxyTreeHtml({
  entryPath,
  html = null,
  intrinsicDimensionsBySource = null,
  baseUrl = null,
} = {}) {
  const absoluteEntry = resolve(entryPath ?? "");
  if (!entryPath || (html == null && !existsSync(absoluteEntry))) {
    fail("HF_PROXY_ENTRY_MISSING", `proxy-tree entry does not exist: ${absoluteEntry}`, { entryPath: absoluteEntry });
  }
  const originalHtml = html ?? readFileSync(absoluteEntry, "utf8");
  const document = parse(originalHtml, { sourceCodeLocationInfo: true });
  const compositionRoots = new Set();
  const videos = [];
  const baseElements = [];
  const parents = new Map();
  walk(document, (node, parent) => {
    if (node.tagName && hasAttribute(node, "data-composition-id")) compositionRoots.add(node);
    if (node.tagName === "video") videos.push(node);
    if (node.tagName === "base") baseElements.push(node);
    if (parent) parents.set(node, parent);
  });
  if (baseElements.length) {
    fail("HF_PROXY_BASE_URL_UNSUPPORTED", "proxy-tree cannot prove relative source identity when the entry declares <base>", {
      count: baseElements.length,
    });
  }
  if (compositionRoots.size !== 1) {
    fail("HF_PROXY_COMPOSITION_ROOT_COUNT", `proxy-tree requires exactly one [data-composition-id] root; found ${compositionRoots.size}`, {
      count: compositionRoots.size,
    });
  }
  if (!videos.length) fail("HF_PROXY_NO_VIDEO", "proxy-tree requires at least one statically declared <video>");

  const videoIds = videos.map((video) => attribute(video, "id")).filter(Boolean);
  const resources = inspectStylesAndScripts(document, absoluteEntry, videoIds);
  const proxies = [];
  for (const video of videos) {
    assertVideoNodeCompatible(video, parents.get(video), compositionRoots);
    const media = resolveVideoSource(video, absoluteEntry);
    const intrinsicSize = establishProxyIntrinsicSize(video, media, intrinsicDimensionsBySource);
    const descriptor = {
      id: attribute(video, "id") || null,
      source: media.raw,
      sourceUrl: media.resolvedUrl,
      sourceKind: media.sourceKind,
      type: media.type,
      intrinsicSize,
      line: video.sourceCodeLocation?.startLine ?? null,
    };
    convertVideoToProxy(video, media, intrinsicSize);
    proxies.push(descriptor);
  }
  const originalEntryUrl = pathToFileURL(absoluteEntry).href;
  if (baseUrl != null && String(baseUrl) !== originalEntryUrl) {
    fail("HF_PROXY_BASE_URL_MISMATCH", "proxy-tree base URL must equal the original entry URL", {
      expected: originalEntryUrl,
      received: String(baseUrl),
    });
  }
  const resolvedBaseUrl = injectExplicitBaseUrl(document, originalEntryUrl);

  return {
    html: serialize(document),
    report: {
      version: 1,
      backend: "proxy-tree",
      entry: absoluteEntry,
      baseUrl: resolvedBaseUrl,
      proxyCount: proxies.length,
      proxies,
      auditedResources: resources,
      inertMediaAttributeMirrors: [...MEDIA_ONLY_ATTRIBUTES].sort(),
      invariants: {
        earlyAstTransform: true,
        videoTagSelectorsRejected: true,
        videoElementApisRejected: true,
        oneStaticSourcePerProxy: true,
        inertMediaSelectorMirrorPreserved: true,
        directTopLevelClipOnly: true,
        verifiedIntrinsicSizing: true,
        inlineHandlersRejected: true,
        unauditedDynamicCodeRejected: true,
        explicitOriginalEntryBaseUrl: true,
      },
    },
  };
}
