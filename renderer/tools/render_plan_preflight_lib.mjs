import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export const RENDER_PLAN_SCHEMA_VERSION = "0.1.0";

const VOID_TAGS = new Set([
  "area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta",
  "param", "source", "track", "wbr",
]);

const MEDIA_TAGS = new Set(["video", "audio"]);
const NON_VISUAL_TAGS = new Set([
  "audio", "base", "head", "html", "link", "meta", "script", "source", "style", "title", "track",
]);

const STACKING_PROPERTIES = new Set([
  "position", "z-index", "opacity", "transform", "transform-style", "filter", "backdrop-filter",
  "mix-blend-mode", "isolation", "will-change", "contain", "perspective", "clip-path",
  "mask", "mask-image", "-webkit-mask", "-webkit-mask-image",
]);

const MANUAL_RELEVANT_PROPERTIES = new Set([
  ...STACKING_PROPERTIES,
  "animation", "animation-name", "transition", "transition-property",
  "border", "border-width", "border-left-width", "border-right-width", "border-top-width",
  "border-bottom-width", "border-radius", "border-top-left-radius", "border-top-right-radius",
  "border-bottom-right-radius", "border-bottom-left-radius", "box-shadow", "object-fit",
  "object-position", "overflow", "overflow-x", "overflow-y",
]);

const SAFE_MANUAL_TRANSFORMS = new Set([
  "translate", "translatex", "translatey", "translate3d", "scale", "scalex", "scaley", "scale3d",
]);

function sha256(text) {
  return crypto.createHash("sha256").update(text).digest("hex");
}

function isWithin(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

async function nearestExistingRealpath(candidate) {
  let cursor = candidate;
  while (true) {
    try {
      return await fs.realpath(cursor);
    } catch (error) {
      if (error?.code !== "ENOENT" && error?.code !== "ENOTDIR") throw error;
      const parent = path.dirname(cursor);
      if (parent === cursor) throw error;
      cursor = parent;
    }
  }
}

async function resolveContainedPath(projectRootReal, candidate, { mustExist = false } = {}) {
  const absolute = path.resolve(candidate);
  if (!isWithin(projectRootReal, absolute)) {
    return {
      ok: false,
      code: "path-outside-project",
      message: `Path escapes the project root: ${absolute}`,
      absolute,
    };
  }

  let exists = true;
  let real;
  try {
    real = await fs.realpath(absolute);
  } catch (error) {
    if (error?.code !== "ENOENT" && error?.code !== "ENOTDIR") throw error;
    exists = false;
    real = absolute;
  }

  if (exists && !isWithin(projectRootReal, real)) {
    return {
      ok: false,
      code: "symlink-outside-project",
      message: `Path resolves through a symlink outside the project root: ${absolute}`,
      absolute,
      real,
    };
  }

  if (!exists) {
    const ancestorReal = await nearestExistingRealpath(path.dirname(absolute));
    if (!isWithin(projectRootReal, ancestorReal)) {
      return {
        ok: false,
        code: "missing-path-parent-outside-project",
        message: `Missing path has a parent outside the project root: ${absolute}`,
        absolute,
        ancestorReal,
      };
    }
  }

  if (mustExist && !exists) {
    return {
      ok: false,
      code: "path-does-not-exist",
      message: `Required path does not exist: ${absolute}`,
      absolute,
    };
  }

  return {
    ok: true,
    absolute,
    real: exists ? real : null,
    exists,
    projectRelative: path.relative(projectRootReal, absolute).split(path.sep).join("/"),
  };
}

function decodeHtmlEntities(value) {
  return value
    .replace(/&#x([0-9a-f]+);?/gi, (_match, digits) => String.fromCodePoint(Number.parseInt(digits, 16)))
    .replace(/&#([0-9]+);?/g, (_match, digits) => String.fromCodePoint(Number.parseInt(digits, 10)))
    .replaceAll("&amp;", "&")
    .replaceAll("&quot;", "\"")
    .replaceAll("&apos;", "'")
    .replaceAll("&#39;", "'")
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&sol;", "/")
    .replaceAll("&period;", ".")
    .replaceAll("&colon;", ":");
}

function lineColumnAt(text, offset) {
  const before = text.slice(0, offset);
  const lines = before.split("\n");
  return { line: lines.length, column: lines.at(-1).length + 1 };
}

function findTagEnd(source, start) {
  let quote = null;
  for (let index = start + 1; index < source.length; index += 1) {
    const char = source[index];
    if (quote) {
      if (char === quote) quote = null;
      continue;
    }
    if (char === "\"" || char === "'") {
      quote = char;
      continue;
    }
    if (char === ">") return index;
  }
  return -1;
}

function parseAttributes(raw) {
  const attributes = new Map();
  let index = 0;
  while (index < raw.length) {
    while (/\s/.test(raw[index] ?? "")) index += 1;
    if (index >= raw.length || raw[index] === "/") break;
    const nameStart = index;
    while (index < raw.length && !/[\s=/>]/.test(raw[index])) index += 1;
    const name = raw.slice(nameStart, index).toLowerCase();
    if (!name) {
      index += 1;
      continue;
    }
    while (/\s/.test(raw[index] ?? "")) index += 1;
    let value = "";
    if (raw[index] === "=") {
      index += 1;
      while (/\s/.test(raw[index] ?? "")) index += 1;
      const quote = raw[index] === "\"" || raw[index] === "'" ? raw[index] : null;
      if (quote) {
        index += 1;
        const valueStart = index;
        while (index < raw.length && raw[index] !== quote) index += 1;
        value = raw.slice(valueStart, index);
        if (raw[index] === quote) index += 1;
      } else {
        const valueStart = index;
        while (index < raw.length && !/[\s>]/.test(raw[index])) index += 1;
        value = raw.slice(valueStart, index);
      }
    }
    attributes.set(name, decodeHtmlEntities(value));
  }
  return attributes;
}

function parseHtml(source, file) {
  const documentNode = {
    uid: `${file}:document`,
    tag: "#document",
    attrs: new Map(),
    children: [],
    parent: null,
    rawText: "",
    location: { line: 1, column: 1 },
  };
  const nodes = [];
  const issues = [];
  const stack = [documentNode];
  let cursor = 0;
  let serial = 0;

  while (cursor < source.length) {
    const open = source.indexOf("<", cursor);
    if (open < 0) {
      stack.at(-1).rawText += source.slice(cursor);
      break;
    }
    stack.at(-1).rawText += source.slice(cursor, open);
    if (source.startsWith("<!--", open)) {
      const close = source.indexOf("-->", open + 4);
      cursor = close < 0 ? source.length : close + 3;
      continue;
    }
    if (/^<!doctype\b/i.test(source.slice(open))) {
      const close = findTagEnd(source, open);
      cursor = close < 0 ? source.length : close + 1;
      continue;
    }
    const close = findTagEnd(source, open);
    if (close < 0) {
      issues.push({
        code: "malformed-html-unclosed-tag",
        message: "An HTML tag is not closed",
        location: lineColumnAt(source, open),
      });
      break;
    }
    const rawTag = source.slice(open + 1, close).trim();
    if (rawTag.startsWith("?")) {
      cursor = close + 1;
      continue;
    }
    if (rawTag.startsWith("/")) {
      const closingTag = rawTag.slice(1).trim().split(/\s+/, 1)[0].toLowerCase();
      let matchIndex = stack.length - 1;
      while (matchIndex > 0 && stack[matchIndex].tag !== closingTag) matchIndex -= 1;
      if (matchIndex === 0) {
        issues.push({
          code: "malformed-html-unmatched-close",
          message: `Unmatched closing tag </${closingTag}>`,
          location: lineColumnAt(source, open),
        });
      } else {
        stack.length = matchIndex;
      }
      cursor = close + 1;
      continue;
    }

    const selfClosing = /\/\s*$/.test(rawTag);
    const match = rawTag.match(/^([^\s/>]+)/);
    if (!match) {
      cursor = close + 1;
      continue;
    }
    const tag = match[1].toLowerCase();
    const attributesRaw = rawTag.slice(match[0].length, selfClosing ? rawTag.lastIndexOf("/") : undefined);
    const node = {
      uid: `${file}:n${serial++}`,
      tag,
      attrs: parseAttributes(attributesRaw),
      children: [],
      parent: stack.at(-1),
      rawText: "",
      location: lineColumnAt(source, open),
    };
    stack.at(-1).children.push(node);
    nodes.push(node);
    cursor = close + 1;

    if (tag === "script" || tag === "style") {
      const closingPattern = new RegExp(`</${tag}\\s*>`, "ig");
      closingPattern.lastIndex = cursor;
      const rawClose = closingPattern.exec(source);
      if (!rawClose) {
        node.rawText = source.slice(cursor);
        issues.push({
          code: `malformed-${tag}-unclosed`,
          message: `<${tag}> has no closing tag`,
          location: node.location,
        });
        cursor = source.length;
      } else {
        node.rawText = source.slice(cursor, rawClose.index);
        cursor = rawClose.index + rawClose[0].length;
      }
      continue;
    }

    if (!selfClosing && !VOID_TAGS.has(tag)) stack.push(node);
  }

  return { documentNode, nodes, issues };
}

function attribute(node, name) {
  return node.attrs.get(name.toLowerCase()) ?? null;
}

function hasClass(node, className) {
  return (attribute(node, "class") ?? "").split(/\s+/).filter(Boolean).includes(className);
}

function nodeLabel(node) {
  const id = attribute(node, "id");
  if (id) return `${node.tag}#${id}`;
  const classes = (attribute(node, "class") ?? "").split(/\s+/).filter(Boolean).slice(0, 2);
  return `${node.tag}${classes.map((item) => `.${item}`).join("")}`;
}

function childElementIndex(node) {
  if (!node.parent) return 1;
  const sameTag = node.parent.children.filter((child) => child.tag === node.tag);
  return sameTag.indexOf(node) + 1;
}

function nodeSelectorPath(node, boundary = null) {
  const parts = [];
  let cursor = node;
  while (cursor && cursor.tag !== "#document") {
    const id = attribute(cursor, "id");
    parts.unshift(id ? `${cursor.tag}#${id}` : `${cursor.tag}:nth-of-type(${childElementIndex(cursor)})`);
    if (cursor === boundary || id) break;
    cursor = cursor.parent;
  }
  return parts.join(" > ");
}

function descendants(node) {
  const result = [];
  const queue = [...node.children];
  while (queue.length) {
    const current = queue.shift();
    result.push(current);
    queue.unshift(...current.children);
  }
  return result;
}

function stripCssComments(css) {
  return css.replace(/\/\*[\s\S]*?\*\//g, "");
}

function findMatchingBrace(css, openIndex) {
  let depth = 0;
  let quote = null;
  for (let index = openIndex; index < css.length; index += 1) {
    const char = css[index];
    if (quote) {
      if (char === "\\") index += 1;
      else if (char === quote) quote = null;
      continue;
    }
    if (char === "\"" || char === "'") {
      quote = char;
      continue;
    }
    if (char === "{") depth += 1;
    else if (char === "}") {
      depth -= 1;
      if (depth === 0) return index;
    }
  }
  return -1;
}

function splitTopLevel(text, separator) {
  const parts = [];
  let start = 0;
  let round = 0;
  let square = 0;
  let quote = null;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (quote) {
      if (char === "\\") index += 1;
      else if (char === quote) quote = null;
      continue;
    }
    if (char === "\"" || char === "'") quote = char;
    else if (char === "(") round += 1;
    else if (char === ")") round = Math.max(0, round - 1);
    else if (char === "[") square += 1;
    else if (char === "]") square = Math.max(0, square - 1);
    else if (char === separator && round === 0 && square === 0) {
      parts.push(text.slice(start, index));
      start = index + 1;
    }
  }
  parts.push(text.slice(start));
  return parts;
}

function parseDeclarations(block, sourceInfo) {
  const declarations = [];
  for (const raw of splitTopLevel(block, ";")) {
    const colonParts = splitTopLevel(raw, ":");
    if (colonParts.length < 2) continue;
    const property = colonParts.shift().trim().toLowerCase();
    let value = colonParts.join(":").trim();
    if (!property || !value) continue;
    const important = /!important\s*$/i.test(value);
    value = value.replace(/!important\s*$/i, "").trim();
    declarations.push({ property, value, important, ...sourceInfo });
  }
  return declarations;
}

function parseCss(cssText, sourceName, { condition = null, orderStart = 0 } = {}) {
  const css = stripCssComments(cssText);
  const rules = [];
  const imports = [];
  const keyframes = [];
  const issues = [];
  let order = orderStart;
  let cursor = 0;
  while (cursor < css.length) {
    while (/\s/.test(css[cursor] ?? "")) cursor += 1;
    if (cursor >= css.length) break;

    if (/^@import\b/i.test(css.slice(cursor))) {
      const semi = css.indexOf(";", cursor);
      if (semi < 0) {
        issues.push({ code: "css-import-unclosed", source: sourceName });
        break;
      }
      const statement = css.slice(cursor, semi + 1);
      const match = statement.match(/@import\s+(?:url\(\s*)?["']?([^"')\s;]+)["']?\s*\)?/i);
      if (match) imports.push({ href: match[1], statement, source: sourceName });
      cursor = semi + 1;
      continue;
    }

    const open = css.indexOf("{", cursor);
    const semi = css.indexOf(";", cursor);
    if (open < 0 || (semi >= 0 && semi < open)) {
      cursor = semi >= 0 ? semi + 1 : css.length;
      continue;
    }
    const close = findMatchingBrace(css, open);
    if (close < 0) {
      issues.push({ code: "css-unclosed-block", source: sourceName, prelude: css.slice(cursor, open).trim() });
      break;
    }
    const prelude = css.slice(cursor, open).trim();
    const body = css.slice(open + 1, close);
    if (/^@(media|supports|container)\b/i.test(prelude)) {
      const nested = parseCss(body, sourceName, {
        condition: condition ? `${condition} && ${prelude}` : prelude,
        orderStart: order,
      });
      rules.push(...nested.rules);
      imports.push(...nested.imports);
      keyframes.push(...nested.keyframes);
      issues.push(...nested.issues);
      order = nested.nextOrder;
    } else if (/^@(layer|scope)\b/i.test(prelude)) {
      const nested = parseCss(body, sourceName, { condition, orderStart: order });
      rules.push(...nested.rules);
      imports.push(...nested.imports);
      keyframes.push(...nested.keyframes);
      issues.push(...nested.issues);
      order = nested.nextOrder;
    } else if (/^@(?:-webkit-)?keyframes\b/i.test(prelude)) {
      const name = prelude.replace(/^@(?:-webkit-)?keyframes\s+/i, "").trim();
      const steps = parseCss(body, sourceName, { condition, orderStart: order });
      const rawDeclarations = [];
      const stepPattern = /(?:^|})\s*([^{}]+)\s*\{([^{}]*)\}/g;
      let stepMatch;
      while ((stepMatch = stepPattern.exec(body))) {
        rawDeclarations.push(...parseDeclarations(stepMatch[2], {
          source: sourceName,
          selector: stepMatch[1].trim(),
          order: order++,
          condition,
        }));
      }
      keyframes.push({ name, source: sourceName, declarations: rawDeclarations });
      order = Math.max(order, steps.nextOrder);
    } else if (!prelude.startsWith("@")) {
      const declarations = parseDeclarations(body, {
        source: sourceName,
        selector: prelude,
        order,
        condition,
      });
      for (const selector of splitTopLevel(prelude, ",").map((value) => value.trim()).filter(Boolean)) {
        rules.push({ selector, declarations, source: sourceName, order, condition });
      }
      order += 1;
    }
    cursor = close + 1;
  }
  return { rules, imports, keyframes, issues, nextOrder: order };
}

function parseAttributeSelector(content) {
  const match = content.trim().match(/^([\w:-]+)\s*(?:([~|^$*]?=)\s*(?:"([^"]*)"|'([^']*)'|([^\s]+)))?$/);
  if (!match) return null;
  return {
    name: match[1].toLowerCase(),
    operator: match[2] ?? null,
    value: match[3] ?? match[4] ?? match[5] ?? null,
  };
}

function parseCompoundSelector(compound) {
  let cursor = 0;
  const tests = [];
  let ids = 0;
  let classes = 0;
  let tags = 0;
  if (compound.startsWith(":root")) {
    tests.push({ kind: "root" });
    classes += 1;
    cursor = 5;
  } else {
    const tagMatch = compound.slice(cursor).match(/^(\*|[a-zA-Z][\w-]*)/);
    if (tagMatch) {
      if (tagMatch[1] !== "*") {
        tests.push({ kind: "tag", value: tagMatch[1].toLowerCase() });
        tags += 1;
      }
      cursor += tagMatch[0].length;
    }
  }
  while (cursor < compound.length) {
    const rest = compound.slice(cursor);
    let match;
    if ((match = rest.match(/^#([\w-]+)/))) {
      tests.push({ kind: "id", value: match[1] });
      ids += 1;
      cursor += match[0].length;
    } else if ((match = rest.match(/^\.([\w-]+)/))) {
      tests.push({ kind: "class", value: match[1] });
      classes += 1;
      cursor += match[0].length;
    } else if (rest.startsWith("[")) {
      const end = rest.indexOf("]");
      if (end < 0) return null;
      const parsed = parseAttributeSelector(rest.slice(1, end));
      if (!parsed) return null;
      tests.push({ kind: "attribute", ...parsed });
      classes += 1;
      cursor += end + 1;
    } else {
      return null;
    }
  }
  return { tests, specificity: [0, ids, classes, tags] };
}

function parseSelector(selector) {
  if (/[+~]|::|\\/.test(selector)) return null;
  if (/:(?!root\b)/.test(selector)) return null;
  const normalized = selector.trim().replace(/\s*>\s*/g, " > ");
  const tokens = normalized.split(/\s+/).filter(Boolean);
  const parts = [];
  let nextCombinator = parts.length ? "descendant" : null;
  for (const token of tokens) {
    if (token === ">") {
      if (!parts.length || nextCombinator === "child") return null;
      nextCombinator = "child";
      continue;
    }
    const compound = parseCompoundSelector(token);
    if (!compound) return null;
    parts.push({ ...compound, combinatorBefore: parts.length ? nextCombinator ?? "descendant" : null });
    nextCombinator = "descendant";
  }
  if (!parts.length || tokens.at(-1) === ">") return null;
  const specificity = parts.reduce(
    (sum, part) => sum.map((value, index) => value + part.specificity[index]),
    [0, 0, 0, 0],
  );
  return { parts, specificity };
}

function testCompound(node, compound) {
  for (const test of compound.tests) {
    if (test.kind === "root") {
      if (node.parent?.tag !== "#document") return false;
    } else if (test.kind === "tag") {
      if (node.tag !== test.value) return false;
    } else if (test.kind === "id") {
      if (attribute(node, "id") !== test.value) return false;
    } else if (test.kind === "class") {
      if (!hasClass(node, test.value)) return false;
    } else if (test.kind === "attribute") {
      const actual = attribute(node, test.name);
      if (actual == null) return false;
      if (!test.operator) continue;
      if (test.operator === "=" && actual !== test.value) return false;
      if (test.operator === "~=" && !actual.split(/\s+/).includes(test.value)) return false;
      if (test.operator === "|=" && actual !== test.value && !actual.startsWith(`${test.value}-`)) return false;
      if (test.operator === "^=" && !actual.startsWith(test.value)) return false;
      if (test.operator === "$=" && !actual.endsWith(test.value)) return false;
      if (test.operator === "*=" && !actual.includes(test.value)) return false;
    }
  }
  return true;
}

function selectorMatches(node, parsed) {
  const matchAt = (cursor, index) => {
    if (!cursor || cursor.tag === "#document" || !testCompound(cursor, parsed.parts[index])) return false;
    if (index === 0) return true;
    if (parsed.parts[index].combinatorBefore === "child") {
      return matchAt(cursor.parent, index - 1);
    }
    let ancestor = cursor.parent;
    while (ancestor && ancestor.tag !== "#document") {
      if (matchAt(ancestor, index - 1)) return true;
      ancestor = ancestor.parent;
    }
    return false;
  };
  return matchAt(node, parsed.parts.length - 1);
}

function compareSpecificity(left, right) {
  for (let index = 0; index < left.length; index += 1) {
    if (left[index] !== right[index]) return left[index] - right[index];
  }
  return 0;
}

function parseInlineStyle(node, order) {
  const raw = attribute(node, "style");
  if (!raw) return [];
  return parseDeclarations(raw, {
    source: "inline-style",
    selector: nodeLabel(node),
    order,
    condition: null,
    inline: true,
  });
}

function relevantDeclaration(declaration) {
  return MANUAL_RELEVANT_PROPERTIES.has(declaration.property)
    || declaration.property.startsWith("mask-")
    || declaration.property.startsWith("-webkit-mask-")
    || declaration.property.startsWith("border-");
}

function collectNodeStyles(nodes, cssRules, dynamicItems) {
  const parsedRules = cssRules.map((rule) => ({ ...rule, parsed: parseSelector(rule.selector) }));
  for (const rule of parsedRules) {
    if (!rule.parsed && rule.declarations.some(relevantDeclaration)) {
      dynamicItems.push({
        code: "unsupported-css-selector",
        severity: "requires-runtime-inventory",
        source: rule.source,
        selector: rule.selector,
        properties: rule.declarations.filter(relevantDeclaration).map((item) => item.property),
        message: "The static preflight cannot prove which elements this selector affects",
      });
    }
    if (rule.condition && rule.declarations.some(relevantDeclaration)) {
      dynamicItems.push({
        code: "conditional-css-rule",
        severity: "requires-runtime-inventory",
        source: rule.source,
        selector: rule.selector,
        condition: rule.condition,
        message: "A media/support/container condition can change the active paint or stacking rules",
      });
    }
  }

  const stylesByNode = new Map();
  for (const node of nodes) {
    const candidates = [];
    for (const rule of parsedRules) {
      if (rule.parsed && selectorMatches(node, rule.parsed)) {
        for (const declaration of rule.declarations) {
          candidates.push({ ...declaration, specificity: rule.parsed.specificity });
        }
      }
    }
    for (const declaration of parseInlineStyle(node, Number.MAX_SAFE_INTEGER - 1)) {
      candidates.push({ ...declaration, specificity: [1, 0, 0, 0] });
    }
    for (const declaration of candidates.filter(relevantDeclaration)) {
      if (/\b(?:var|env|attr)\s*\(/i.test(declaration.value)) {
        dynamicItems.push({
          code: "runtime-css-value",
          severity: "requires-runtime-inventory",
          source: declaration.source,
          selector: declaration.selector,
          property: declaration.property,
          value: declaration.value,
          message: "A CSS variable/environment/attribute value must be resolved in the browser before selecting a manual backend",
        });
      }
    }
    const effective = new Map();
    for (const declaration of candidates) {
      const previous = effective.get(declaration.property);
      if (!previous
        || Number(declaration.important) > Number(previous.important)
        || (declaration.important === previous.important
          && (compareSpecificity(declaration.specificity, previous.specificity) > 0
            || (compareSpecificity(declaration.specificity, previous.specificity) === 0
              && declaration.order >= previous.order)))) {
        effective.set(declaration.property, declaration);
      }
    }
    stylesByNode.set(node, { candidates, effective });
  }
  return stylesByNode;
}

function normalizedStyle(styles, property, fallback) {
  return styles?.effective.get(property)?.value?.trim().toLowerCase() ?? fallback;
}

function finiteNumber(raw, fallback = null) {
  if (raw == null || raw === "") return fallback;
  const value = Number(raw);
  return Number.isFinite(value) ? value : null;
}

function transformRisk(value) {
  const normalized = value.trim().toLowerCase();
  if (!normalized || normalized === "none") return null;
  if (/var\(|calc\(|env\(/.test(normalized)) return "dynamic-transform-value";
  const calls = [...normalized.matchAll(/([a-z0-9]+)\s*\(([^)]*)\)/g)];
  if (!calls.length || calls.map((item) => item[0]).join(" ").replaceAll(/\s+/g, "") !== normalized.replaceAll(/\s+/g, "")) {
    return "unparsed-transform";
  }
  for (const call of calls) {
    const name = call[1];
    if (name === "matrix") {
      const values = call[2].split(",").map(Number);
      if (values.length !== 6 || values.some((item) => !Number.isFinite(item))) return "unparsed-transform";
      if (Math.abs(values[1]) > 1e-9 || Math.abs(values[2]) > 1e-9) return "rotated-or-skewed-matrix";
      continue;
    }
    if (name === "translate3d" || name === "scale3d") {
      const values = call[2].split(",").map((item) => item.trim());
      const z = values[2] ?? (name === "scale3d" ? "1" : "0");
      if ((name === "translate3d" && !/^[-+]?0(?:[a-z%]+)?$/i.test(z))
        || (name === "scale3d" && Number(z) !== 1)) return "non-flat-3d-transform";
      continue;
    }
    if (!SAFE_MANUAL_TRANSFORMS.has(name)) return "rotate-skew-perspective-or-3d-transform";
  }
  return null;
}

function radiusRisk(styles) {
  const shorthand = normalizedStyle(styles, "border-radius", "");
  const values = [
    normalizedStyle(styles, "border-top-left-radius", shorthand || "0px"),
    normalizedStyle(styles, "border-top-right-radius", shorthand || "0px"),
    normalizedStyle(styles, "border-bottom-right-radius", shorthand || "0px"),
    normalizedStyle(styles, "border-bottom-left-radius", shorthand || "0px"),
  ];
  if (values.every((value) => /^[-+]?0(?:px|%)?$/.test(value))) return null;
  if (values.every((value) => value.startsWith("50%"))) return null;
  if (values.every((value) => /^\d+(?:\.\d+)?px$/.test(value)) && new Set(values).size === 1) return null;
  return { code: "complex-border-radius", value: values.join(" | ") };
}

function hasNonZeroBorder(styles) {
  const widthValues = [
    "border-width", "border-left-width", "border-right-width", "border-top-width", "border-bottom-width",
  ].map((property) => normalizedStyle(styles, property, ""));
  return widthValues.some((value) => value && !/^0(?:px|em|rem|%)?$/.test(value));
}

function addCssFinding(findings, seen, finding) {
  const key = [finding.code, finding.nodeUid, finding.property, finding.value].join("|");
  if (seen.has(key)) return;
  seen.add(key);
  findings.push(finding);
}

function analyzeCss(nodes, stylesByNode, compositionRoots) {
  const findings = [];
  const seen = new Set();
  const rootSet = new Set(compositionRoots);
  const rootForNode = (node) => {
    let cursor = node;
    while (cursor && !rootSet.has(cursor)) cursor = cursor.parent;
    return cursor;
  };

  for (const node of nodes) {
    const root = rootForNode(node);
    if (!root) continue;
    const styles = stylesByNode.get(node);
    const isManualVideo = node.tag === "video";
    const base = {
      nodeUid: node.uid,
      element: nodeLabel(node),
      selectorPath: nodeSelectorPath(node, root),
      source: styles?.effective,
    };

    const transform = normalizedStyle(styles, "transform", "none");
    const transformCode = transformRisk(transform);
    if (transformCode && isManualVideo) {
      addCssFinding(findings, seen, {
        ...base,
        code: transformCode,
        severity: "hard-block-layered-manual",
        property: "transform",
        value: transform,
        message: "Manual video drawing only preserves flat translate/scale transforms",
      });
    }

    for (const property of ["filter", "backdrop-filter"]) {
      const value = normalizedStyle(styles, property, "none");
      if (value !== "none" && (isManualVideo || property === "backdrop-filter")) {
        addCssFinding(findings, seen, {
          ...base,
          code: property === "filter" ? "css-filter" : "css-backdrop-filter",
          severity: "hard-block-layered-manual",
          property,
          value,
          message: "Separating HTML bands and video changes filter inputs and pixels",
        });
      }
    }

    const blend = normalizedStyle(styles, "mix-blend-mode", "normal");
    if (blend !== "normal") {
      addCssFinding(findings, seen, {
        ...base,
        code: "mix-blend-mode",
        severity: "hard-block-layered-manual",
        property: "mix-blend-mode",
        value: blend,
        message: "Blend mode requires the original compositing backdrop",
      });
    }

    for (const property of ["mask", "mask-image", "-webkit-mask", "-webkit-mask-image", "clip-path"]) {
      const value = normalizedStyle(styles, property, "none");
      if (value !== "none" && isManualVideo) {
        addCssFinding(findings, seen, {
          ...base,
          code: property.includes("mask") ? "css-mask" : "clip-path",
          severity: "hard-block-layered-manual",
          property,
          value,
          message: "The current manual video compositor does not reproduce this clip/mask",
        });
      }
    }

    if (isManualVideo) {
      const radius = radiusRisk(styles);
      if (radius) {
        addCssFinding(findings, seen, {
          ...base,
          ...radius,
          severity: "hard-block-layered-manual",
          property: "border-radius",
          message: "Manual drawing only supports one uniform pixel radius or a 50% ellipse",
        });
      }
      if (hasNonZeroBorder(styles)) {
        addCssFinding(findings, seen, {
          ...base,
          code: "video-border-not-composited",
          severity: "hard-block-layered-manual",
          property: "border-width",
          value: "non-zero",
          message: "The manual video drawer subtracts borders but does not paint them",
        });
      }
      const shadow = normalizedStyle(styles, "box-shadow", "none");
      if (shadow !== "none") {
        addCssFinding(findings, seen, {
          ...base,
          code: "video-box-shadow",
          severity: "hard-block-layered-manual",
          property: "box-shadow",
          value: shadow,
          message: "The manual video drawer does not paint the element shadow",
        });
      }
      const objectPosition = normalizedStyle(styles, "object-position", "50% 50%");
      if (/(?:px|em|rem|calc\(|var\(|env\()/i.test(objectPosition)) {
        addCssFinding(findings, seen, {
          ...base,
          code: "unsupported-object-position",
          severity: "hard-block-layered-manual",
          property: "object-position",
          value: objectPosition,
          message: "Manual video positioning supports keywords and percentages only",
        });
      }
    }

    const zIndex = normalizedStyle(styles, "z-index", "auto");
    if (node !== root && (zIndex === "auto" || !/^-?\d+$/.test(zIndex))) {
      addCssFinding(findings, seen, {
        ...base,
        code: zIndex === "auto" ? "auto-z-index" : "non-numeric-z-index",
        severity: "manual-order-assumption",
        property: "z-index",
        value: zIndex,
        message: "Layered manual ordering must prove that flat DOM order is equivalent to browser stacking",
      });
    }
  }
  return findings;
}

function stackingReasons(node, styles, isRoot) {
  const reasons = [];
  if (isRoot) reasons.push("composition-root");
  const position = normalizedStyle(styles, "position", "static");
  const zIndex = normalizedStyle(styles, "z-index", "auto");
  if (["fixed", "sticky"].includes(position)) reasons.push(`position:${position}`);
  if (["absolute", "relative", "fixed", "sticky"].includes(position) && zIndex !== "auto") reasons.push("positioned-z-index");
  const opacity = Number(normalizedStyle(styles, "opacity", "1"));
  if (Number.isFinite(opacity) && opacity < 1) reasons.push("opacity");
  if (normalizedStyle(styles, "transform", "none") !== "none") reasons.push("transform");
  if (normalizedStyle(styles, "filter", "none") !== "none") reasons.push("filter");
  if (normalizedStyle(styles, "backdrop-filter", "none") !== "none") reasons.push("backdrop-filter");
  if (normalizedStyle(styles, "mix-blend-mode", "normal") !== "normal") reasons.push("mix-blend-mode");
  if (normalizedStyle(styles, "isolation", "auto") === "isolate") reasons.push("isolation");
  if (normalizedStyle(styles, "perspective", "none") !== "none") reasons.push("perspective");
  const contain = normalizedStyle(styles, "contain", "none");
  if (/\b(?:layout|paint|strict|content)\b/.test(contain)) reasons.push("contain");
  const willChange = normalizedStyle(styles, "will-change", "auto");
  if (/\b(?:transform|opacity|filter|perspective|clip-path|mask)\b/.test(willChange)) reasons.push("will-change");
  return [...new Set(reasons)];
}

function buildStackingInventory(compositionRoots, stylesByNode) {
  const items = [];
  let nestedContextCount = 0;
  for (const root of compositionRoots) {
    const all = [root, ...descendants(root)];
    const contexts = new Set();
    for (const node of all) {
      const styles = stylesByNode.get(node);
      const reasons = stackingReasons(node, styles, node === root);
      if (reasons.length) contexts.add(node);
    }
    for (const node of all) {
      let depth = 0;
      let cursor = node;
      while (cursor && cursor !== root) {
        depth += 1;
        cursor = cursor.parent;
      }
      const isTopLevel = node.parent === root;
      if (node !== root && !isTopLevel && !contexts.has(node)) continue;
      let parentContext = node.parent;
      while (parentContext && !contexts.has(parentContext)) parentContext = parentContext.parent;
      const reasons = stackingReasons(node, stylesByNode.get(node), node === root);
      const scope = node === root ? "root" : isTopLevel ? "top-level" : "nested";
      if (scope === "nested" && reasons.length) nestedContextCount += 1;
      items.push({
        nodeUid: node.uid,
        element: nodeLabel(node),
        selectorPath: nodeSelectorPath(node, root),
        compositionId: attribute(root, "data-composition-id"),
        scope,
        depth,
        zIndex: normalizedStyle(stylesByNode.get(node), "z-index", "auto"),
        position: normalizedStyle(stylesByNode.get(node), "position", "static"),
        createsStackingContext: contexts.has(node),
        stackingReasons: reasons,
        parentStackingContextUid: parentContext?.uid ?? null,
      });
    }
  }
  return { items, nestedContextCount };
}

async function resolveReference(rawValue, baseFile, projectRootReal) {
  const raw = rawValue?.trim() ?? "";
  if (!raw) return { ok: false, category: "empty", code: "empty-reference", raw };
  if (raw.includes("\0")) return { ok: false, category: "invalid", code: "null-byte-reference", raw };
  if (/^data:/i.test(raw)) return { ok: true, category: "data-url", raw, exists: true };
  if (/^blob:/i.test(raw)) return { ok: false, category: "runtime-url", code: "blob-url-runtime-only", raw };
  if (/^https?:/i.test(raw)) return { ok: true, category: "remote-url", raw, url: raw, exists: null };
  if (/^[a-z][a-z0-9+.-]*:/i.test(raw) && !/^file:/i.test(raw)) {
    return { ok: false, category: "unsupported-url", code: "unsupported-url-scheme", raw };
  }

  let absolute;
  try {
    if (/^file:/i.test(raw)) absolute = fileURLToPath(raw);
    else {
      const withoutFragment = raw.split("#", 1)[0].split("?", 1)[0];
      absolute = path.resolve(path.dirname(baseFile), decodeURIComponent(withoutFragment));
    }
  } catch (error) {
    return { ok: false, category: "invalid", code: "invalid-reference-url", raw, message: String(error) };
  }
  const resolved = await resolveContainedPath(projectRootReal, absolute);
  return { ...resolved, category: "local-file", raw };
}

function mediaTimeline(node, globalOffset, windowEnd) {
  const startRaw = attribute(node, "data-start");
  const durationRaw = attribute(node, "data-duration");
  const mediaStartRaw = attribute(node, "data-media-start");
  const rateRaw = attribute(node, "data-playback-rate");
  const localStart = finiteNumber(startRaw, 0);
  const duration = finiteNumber(durationRaw, null);
  const mediaStart = finiteNumber(mediaStartRaw, 0);
  const playbackRate = finiteNumber(rateRaw, 1);
  const valid = localStart != null && mediaStart != null && playbackRate != null && playbackRate > 0
    && (duration == null || duration >= 0);
  const globalStart = valid ? globalOffset + localStart : null;
  const rawEnd = valid && duration != null ? globalStart + duration : null;
  const globalEnd = rawEnd == null ? windowEnd : windowEnd == null ? rawEnd : Math.min(rawEnd, windowEnd);
  return {
    valid,
    localStart,
    duration,
    mediaStart,
    playbackRate,
    globalStart,
    globalEnd,
    trackIndex: finiteNumber(attribute(node, "data-track-index"), 0),
    issues: [
      ...(localStart == null ? ["invalid-data-start"] : []),
      ...(durationRaw != null && duration == null ? ["invalid-data-duration"] : []),
      ...(mediaStart == null ? ["invalid-data-media-start"] : []),
      ...(playbackRate == null || playbackRate <= 0 ? ["invalid-playback-rate"] : []),
      ...(duration == null ? ["duration-requires-media-probe"] : []),
    ],
  };
}

function frameInsideInterval(start, end, fps) {
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) return null;
  const epsilon = Number.EPSILON * Math.max(1, Math.abs(start * fps)) * 32;
  const frame = Math.ceil(start * fps - epsilon);
  return frame / fps <= end + epsilon ? frame : null;
}

function buildSourceConflicts(mediaElements, fps) {
  const byCanonical = new Map();
  for (const media of mediaElements.filter((item) => item.kind === "video" && item.timeline.valid && !item.hidden)) {
    for (const reference of media.activeSourceCandidates) {
      if (!reference.canonicalKey) continue;
      if (!byCanonical.has(reference.canonicalKey)) byCanonical.set(reference.canonicalKey, []);
      byCanonical.get(reference.canonicalKey).push({ media, reference });
    }
  }
  const conflicts = [];
  const reusable = [];
  const laneRequirements = [];
  for (const [canonicalSource, entries] of byCanonical) {
    for (let leftIndex = 0; leftIndex < entries.length; leftIndex += 1) {
      for (let rightIndex = leftIndex + 1; rightIndex < entries.length; rightIndex += 1) {
        const left = entries[leftIndex].media;
        const right = entries[rightIndex].media;
        if (left.nodeUid === right.nodeUid) continue;
        const overlapStart = Math.max(left.timeline.globalStart, right.timeline.globalStart);
        const overlapEnd = Math.min(left.timeline.globalEnd ?? Number.POSITIVE_INFINITY, right.timeline.globalEnd ?? Number.POSITIVE_INFINITY);
        if (!Number.isFinite(overlapEnd) || overlapEnd < overlapStart) continue;
        const firstOutputFrame = frameInsideInterval(overlapStart, overlapEnd, fps);
        if (firstOutputFrame == null) continue;
        const time = firstOutputFrame / fps;
        const leftPts = left.timeline.mediaStart + (time - left.timeline.globalStart) * left.timeline.playbackRate;
        const rightPts = right.timeline.mediaStart + (time - right.timeline.globalStart) * right.timeline.playbackRate;
        const item = {
          canonicalSource,
          leftMediaId: left.id,
          rightMediaId: right.id,
          overlap: { start: overlapStart, end: overlapEnd },
          firstOutputFrame,
          firstOutputTime: time,
          leftRequestedPts: leftPts,
          rightRequestedPts: rightPts,
          ptsDelta: rightPts - leftPts,
          sourceSelectionConditional: left.sourceSelection === "browser-choice" || right.sourceSelection === "browser-choice",
        };
        if (Math.abs(leftPts - rightPts) > 1e-9
          || Math.abs(left.timeline.playbackRate - right.timeline.playbackRate) > 1e-9) {
          conflicts.push({
            ...item,
            code: "same-source-overlap-different-pts",
            requiresDecoderLanes: 2,
            message: "One source may be requested at different presentation times in the same output frame",
          });
        } else {
          reusable.push({ ...item, code: "same-source-overlap-same-pts" });
        }
      }
    }
    const candidateFrames = new Set();
    for (const { media } of entries) {
      if (!Number.isFinite(media.timeline.globalStart) || !Number.isFinite(media.timeline.globalEnd)) continue;
      const first = frameInsideInterval(media.timeline.globalStart, media.timeline.globalEnd, fps);
      const last = Math.floor(media.timeline.globalEnd * fps + Number.EPSILON * Math.max(1, media.timeline.globalEnd * fps) * 32);
      if (first != null) candidateFrames.add(first);
      if (last >= 0) candidateFrames.add(last);
    }
    for (const item of conflicts.filter((entry) => entry.canonicalSource === canonicalSource)) {
      candidateFrames.add(item.firstOutputFrame);
    }
    let maximum = { requiredLanes: 0, evidenceFrame: null, activeRequests: [] };
    for (const frame of [...candidateFrames].sort((left, right) => left - right)) {
      const time = frame / fps;
      const activeRequests = entries
        .filter(({ media }) => time >= media.timeline.globalStart - 1e-12 && time <= media.timeline.globalEnd + 1e-12)
        .map(({ media }) => ({
          mediaId: media.id,
          requestedPts: media.timeline.mediaStart + (time - media.timeline.globalStart) * media.timeline.playbackRate,
        }));
      const uniquePts = new Set(activeRequests.map((item) => item.requestedPts.toPrecision(15)));
      if (uniquePts.size > maximum.requiredLanes) {
        maximum = { requiredLanes: uniquePts.size, evidenceFrame: frame, evidenceTime: time, activeRequests };
      }
    }
    laneRequirements.push({ canonicalSource, ...maximum });
  }
  return { conflicts, reusable, laneRequirements };
}

function analyzeScript(text, source, dynamicItems) {
  dynamicItems.push({
    code: "runtime-script-executes",
    severity: "requires-runtime-inventory",
    source,
    message: "Static HTML cannot prove the final DOM, CSS, media set, or timeline after this script runs",
  });
  if (/(?:createElement\s*\(\s*["'](?:video|audio|source)["']|new\s+Audio\s*\(|\.src\s*=|setAttribute\s*\(\s*["']src["']|innerHTML\s*=)/i.test(text)) {
    dynamicItems.push({
      code: "dynamic-media-mutation",
      severity: "requires-runtime-inventory",
      source,
      message: "The script may add or replace media references at runtime",
    });
  }
  if (/(?:\.style\b|classList\b|setProperty\s*\(|setAttribute\s*\(\s*["']style["']|gsap\.|\.animate\s*\()/i.test(text)) {
    dynamicItems.push({
      code: "dynamic-style-or-animation",
      severity: "requires-runtime-inventory",
      source,
      message: "The script may change stacking or paint properties over time",
    });
  }
  if (/(?:Date\.now\s*\(|performance\.now\s*\(|Math\.random\s*\(|fetch\s*\()/i.test(text)) {
    dynamicItems.push({
      code: "possible-nondeterministic-runtime",
      severity: "hard-render-contract-risk",
      source,
      message: "The script contains a clock, randomness, or network fetch pattern",
    });
  }
}

function dedupeDynamic(items) {
  const result = [];
  const seen = new Set();
  for (const item of items) {
    const key = [item.code, item.source, item.selector, item.condition].join("|");
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(item);
  }
  return result;
}

function hardBlocker(code, message, evidence = null) {
  return { code, message, evidence };
}

function backend(status, hardBlockers, requirements, notes = []) {
  return {
    status,
    autoSelectable: status === "eligible" && hardBlockers.length === 0 && requirements.length === 0,
    hardBlockers,
    requirements,
    notes,
  };
}

function buildBackendEligibility(planParts) {
  const {
    mediaElements,
    references,
    sourceConflicts,
    cssFindings,
    stacking,
    dynamicItems,
    inputBlockers,
    visualNonMediaCount,
  } = planParts;
  const fatalRefs = references.filter((item) => !item.ok || (item.category === "local-file" && item.exists === false));
  const remoteRefs = references.filter((item) => item.category === "remote-url");
  const videos = mediaElements.filter((item) => item.kind === "video");
  const nestedVideos = videos.filter((item) => item.topology !== "top-level-composition-child");
  const ambiguousSources = mediaElements.filter((item) => item.sourceSelection === "browser-choice");
  const cssHard = cssFindings.filter((item) => item.severity === "hard-block-layered-manual");
  const hasRuntimeUnknowns = dynamicItems.some((item) => item.severity === "requires-runtime-inventory");

  const common = [
    ...inputBlockers,
    ...fatalRefs.map((item) => hardBlocker(
      item.code ?? "media-reference-unavailable",
      `Reference is not safe and available: ${item.raw}`,
      item.id,
    )),
    ...remoteRefs.map((item) => hardBlocker(
      "remote-reference-breaks-offline-contract",
      `Remote reference is not deterministic/offline: ${item.raw}`,
      item.id,
    )),
  ];

  const layeredBlockers = [
    ...common,
    ...sourceConflicts.conflicts.map((item) => hardBlocker(
      "decoder-lane-required",
      `${item.leftMediaId} and ${item.rightMediaId} need different PTS from one source in output frame ${item.firstOutputFrame}`,
      item,
    )),
    ...nestedVideos.map((item) => hardBlocker(
      "nested-video-not-supported-by-current-layered-manual",
      `${item.id} is not a direct child of its composition root`,
      item.nodeUid,
    )),
    ...ambiguousSources.map((item) => hardBlocker(
      "browser-source-selection-not-materialized",
      `${item.id} uses multiple <source> candidates; the manual decoder needs one verified selected source`,
      item.nodeUid,
    )),
    ...cssHard.map((item) => hardBlocker(item.code, item.message, item.nodeUid)),
  ];

  const rootContextUids = new Set(stacking.items.filter((item) => item.scope === "root").map((item) => item.nodeUid));
  const escapingNestedContexts = stacking.items.filter((item) => (
    item.scope === "nested"
    && item.createsStackingContext
    && rootContextUids.has(item.parentStackingContextUid)
  ));
  if (videos.length > 0 && escapingNestedContexts.length > 0) {
    layeredBlockers.push(hardBlocker(
      "nested-stacking-context-escapes-html-band",
      "A nested stacking context participates directly in the composition root and may cross an HTML/video band boundary",
      { nodeUids: escapingNestedContexts.map((item) => item.nodeUid) },
    ));
  }

  const layeredRequirements = [];
  if (hasRuntimeUnknowns) layeredRequirements.push("runtime DOM/CSS/media inventory at every representative state");
  if (cssFindings.some((item) => item.severity === "manual-order-assumption")) {
    layeredRequirements.push("prove flat DOM order equals browser stacking order");
  }
  layeredRequirements.push("golden-frame pixel comparison at entrances, cuts, dense motion, and exits");

  const nativeRequirements = ["CanvasDrawElement capability probe", "representative golden-frame comparison"];
  if (videos.length) nativeRequirements.push("prove <video> pixels are captured and not black/stale");
  if (hasRuntimeUnknowns) nativeRequirements.push("runtime DOM/CSS/media inventory");

  const screenshotRequirements = [];
  if (hasRuntimeUnknowns) screenshotRequirements.push("wait for deterministic runtime readiness before capture");

  const ffmpegBlockers = [...common];
  if (visualNonMediaCount > 0) {
    ffmpegBlockers.push(hardBlocker(
      "browser-visuals-present",
      `${visualNonMediaCount} non-media visual elements require browser paint`,
      visualNonMediaCount,
    ));
  }

  const result = {
    "ffmpeg-only": backend(
      ffmpegBlockers.length ? "ineligible" : hasRuntimeUnknowns ? "conditional" : "eligible",
      ffmpegBlockers,
      hasRuntimeUnknowns ? ["runtime proof that scripts do not create browser visuals"] : [],
      ["Fastest path when the composition is only media/audio and FFmpeg can reproduce the layer graph"],
    ),
    "native-tree": backend(
      common.length ? "ineligible" : "conditional",
      common,
      nativeRequirements,
      ["Keeps browser CSS/stacking semantics, but HTML-in-Canvas media capture must be proven on the exact Chrome build"],
    ),
    "layered-manual": backend(
      layeredBlockers.length ? "ineligible" : layeredRequirements.length ? "conditional" : "eligible",
      layeredBlockers,
      layeredBlockers.length ? [] : layeredRequirements,
      ["Manual video draw plus HTML bands; never auto-select while any capability is unproven"],
    ),
    "screenshot-fallback": backend(
      common.length ? "ineligible" : screenshotRequirements.length ? "conditional" : "eligible",
      common,
      screenshotRequirements,
      ["Correctness reference and safe fallback; slower because it reads back browser pixels"],
    ),
  };

  const preferredAfterProbes = result["ffmpeg-only"].status === "eligible"
    ? "ffmpeg-only"
    : result["layered-manual"].status !== "ineligible"
      ? "layered-manual"
      : result["native-tree"].status !== "ineligible"
        ? "native-tree"
        : result["screenshot-fallback"].status !== "ineligible"
          ? "screenshot-fallback"
          : null;
  const safeDefault = result["screenshot-fallback"].status === "eligible" ? "screenshot-fallback" : null;
  return {
    backends: result,
    decision: {
      safeDefault,
      preferredAfterProbes,
      canAutoSelectFastPath: Object.entries(result).some(([name, item]) => name !== "screenshot-fallback" && item.autoSelectable),
      rule: "Only eligible+autoSelectable backends may run without additional proof; conditional is not permission to render",
    },
  };
}

async function loadStylesheets(documentRecord, projectRootReal, references, dynamicItems) {
  const cssSources = [];
  let order = 0;
  const visited = new Set();

  const loadCssText = async (text, sourceName, baseFile) => {
    const parsed = parseCss(text, sourceName, { orderStart: order });
    order = parsed.nextOrder;
    cssSources.push(parsed);
    for (const issue of parsed.issues) {
      dynamicItems.push({ ...issue, severity: "requires-runtime-inventory", message: "CSS could not be fully parsed" });
    }
    for (const imported of parsed.imports) {
      const resolved = await resolveReference(imported.href, baseFile, projectRootReal);
      const reference = {
        id: `ref-${references.length}`,
        ownerNodeUid: null,
        ownerElement: "@import",
        kind: "stylesheet",
        relation: "css-import",
        raw: imported.href,
        ...resolved,
        canonicalKey: resolved.real ?? resolved.absolute ?? resolved.url ?? null,
      };
      references.push(reference);
      if (!resolved.ok || !resolved.exists) continue;
      if (visited.has(resolved.real)) continue;
      visited.add(resolved.real);
      await loadCssText(await fs.readFile(resolved.real, "utf8"), resolved.projectRelative, resolved.real);
    }
  };

  for (const node of documentRecord.nodes) {
    if (node.tag === "style") {
      await loadCssText(node.rawText, `${documentRecord.projectRelative}:inline-style@${node.location.line}`, documentRecord.file);
    }
    if (node.tag === "link" && /(?:^|\s)stylesheet(?:\s|$)/i.test(attribute(node, "rel") ?? "")) {
      const href = attribute(node, "href");
      const resolved = await resolveReference(href, documentRecord.file, projectRootReal);
      const reference = {
        id: `ref-${references.length}`,
        ownerNodeUid: node.uid,
        ownerElement: nodeLabel(node),
        kind: "stylesheet",
        relation: "link-href",
        raw: href,
        ...resolved,
        canonicalKey: resolved.real ?? resolved.absolute ?? resolved.url ?? null,
      };
      references.push(reference);
      if (!resolved.ok || !resolved.exists) continue;
      if (visited.has(resolved.real)) continue;
      visited.add(resolved.real);
      await loadCssText(await fs.readFile(resolved.real, "utf8"), resolved.projectRelative, resolved.real);
    }
  }
  return {
    rules: cssSources.flatMap((item) => item.rules),
    keyframes: cssSources.flatMap((item) => item.keyframes),
  };
}

function activeMediaSources(node, candidateReferences) {
  const direct = candidateReferences.find((item) => item.relation === "element-src");
  if (attribute(node, "data-var-src") != null) {
    return { sourceSelection: "runtime-variable", active: direct ? [direct] : candidateReferences };
  }
  if (direct) return { sourceSelection: "direct-src", active: [direct] };
  const nested = candidateReferences.filter((item) => item.relation === "nested-source-src");
  if (nested.length === 1) return { sourceSelection: "single-source", active: nested };
  if (nested.length > 1) return { sourceSelection: "browser-choice", active: nested };
  return { sourceSelection: "missing", active: [] };
}

function topologicalMediaPosition(node, compositionRoot, mount) {
  if (mount?.hostNodeUid) return "subcomposition-media";
  if (node.parent === compositionRoot) return "top-level-composition-child";
  if (node.parent?.tag === "template" && node.parent.children.includes(compositionRoot)) return "top-level-composition-child";
  return "nested-in-composition";
}

export async function buildRenderPlan({ projectRoot, entry = "index.html", fps = 60 } = {}) {
  if (!projectRoot) throw new Error("projectRoot is required");
  if (!Number.isFinite(Number(fps)) || Number(fps) <= 0 || Number(fps) > 1000) {
    throw new Error(`fps must be a finite number in (0, 1000], got ${fps}`);
  }
  const outputFps = Number(fps);
  const projectRootReal = await fs.realpath(path.resolve(projectRoot));
  const entryCandidate = path.isAbsolute(entry) ? entry : path.resolve(projectRootReal, entry);
  const entryResolved = await resolveContainedPath(projectRootReal, entryCandidate, { mustExist: true });
  if (!entryResolved.ok) throw new Error(entryResolved.message);

  const references = [];
  const documents = [];
  const dynamicItems = [];
  const inputBlockers = [];
  const allNodes = [];
  const allCompositionRoots = [];
  const mediaContexts = [];
  const visitedDocuments = new Map();

  const loadDocument = async (
    file,
    mount = { globalOffset: 0, windowEnd: null, hostNodeUid: null },
    ancestry = [],
  ) => {
    const real = await fs.realpath(file);
    if (ancestry.includes(real)) {
      inputBlockers.push(hardBlocker(
        "subcomposition-cycle",
        `Sub-composition cycle detected: ${[...ancestry, real].map((item) => path.relative(projectRootReal, item)).join(" -> ")}`,
      ));
      return null;
    }
    if (documents.length >= 512) {
      inputBlockers.push(hardBlocker("subcomposition-expansion-limit", "Static sub-composition expansion exceeded 512 mounted documents"));
      return null;
    }
    const visitKey = `${real}|${mount.globalOffset}|${mount.windowEnd}`;
    if (visitedDocuments.has(visitKey)) return visitedDocuments.get(visitKey);
    const source = await fs.readFile(real, "utf8");
    const projectRelative = path.relative(projectRootReal, real).split(path.sep).join("/");
    const parsed = parseHtml(source, projectRelative);
    const record = {
      id: `doc-${documents.length}`,
      file: real,
      projectRelative,
      sha256: sha256(source),
      source,
      nodes: parsed.nodes,
      parseIssues: parsed.issues,
      mount,
    };
    visitedDocuments.set(visitKey, record);
    documents.push(record);
    allNodes.push(...parsed.nodes);
    if (parsed.issues.length) {
      dynamicItems.push(...parsed.issues.map((issue) => ({
        ...issue,
        severity: "requires-runtime-inventory",
        source: projectRelative,
        message: issue.message ?? "HTML could not be fully parsed",
      })));
    }
    for (const base of parsed.nodes.filter((node) => node.tag === "base" && attribute(node, "href") != null)) {
      inputBlockers.push(hardBlocker(
        "html-base-url-not-supported-by-static-path-policy",
        `<base href=${JSON.stringify(attribute(base, "href"))}> changes URL resolution and must be materialized before preflight`,
        base.uid,
      ));
    }

    const roots = parsed.nodes.filter((node) => attribute(node, "data-composition-id") != null);
    const nestedRootSet = new Set(roots.filter((root) => roots.some((candidate) => candidate !== root && descendants(candidate).includes(root))));
    const primaryRoots = roots.filter((root) => !nestedRootSet.has(root));
    if (!primaryRoots.length) {
      inputBlockers.push(hardBlocker("composition-root-missing", `No [data-composition-id] root in ${projectRelative}`));
    }
    allCompositionRoots.push(...primaryRoots);

    for (const root of primaryRoots) {
      const rootDuration = finiteNumber(attribute(root, "data-duration"), null);
      const rootWindowEnd = rootDuration == null
        ? mount.windowEnd
        : mount.windowEnd == null
          ? mount.globalOffset + rootDuration
          : Math.min(mount.windowEnd, mount.globalOffset + rootDuration);
      for (const mediaNode of [root, ...descendants(root)].filter((node) => MEDIA_TAGS.has(node.tag))) {
        mediaContexts.push({ node: mediaNode, root, globalOffset: mount.globalOffset, windowEnd: rootWindowEnd, document: record });
      }
    }

    for (const script of parsed.nodes.filter((node) => node.tag === "script")) {
      const scriptSrc = attribute(script, "src");
      if (scriptSrc) {
        const resolved = await resolveReference(scriptSrc, real, projectRootReal);
        const reference = {
          id: `ref-${references.length}`,
          ownerNodeUid: script.uid,
          ownerElement: nodeLabel(script),
          kind: "script",
          relation: "script-src",
          raw: scriptSrc,
          ...resolved,
          canonicalKey: resolved.real ?? resolved.absolute ?? resolved.url ?? null,
        };
        references.push(reference);
        if (resolved.ok && resolved.exists) analyzeScript(await fs.readFile(resolved.real, "utf8"), resolved.projectRelative, dynamicItems);
        else dynamicItems.push({
          code: "unreadable-runtime-script",
          severity: "requires-runtime-inventory",
          source: scriptSrc,
          message: "External script could not be inspected",
        });
      } else if (script.rawText.trim()) {
        analyzeScript(script.rawText, `${projectRelative}:inline-script@${script.location.line}`, dynamicItems);
      }
    }

    for (const host of parsed.nodes.filter((node) => attribute(node, "data-composition-src") != null)) {
      const raw = attribute(host, "data-composition-src");
      const resolved = await resolveReference(raw, real, projectRootReal);
      const reference = {
        id: `ref-${references.length}`,
        ownerNodeUid: host.uid,
        ownerElement: nodeLabel(host),
        kind: "subcomposition",
        relation: "data-composition-src",
        raw,
        ...resolved,
        canonicalKey: resolved.real ?? resolved.absolute ?? resolved.url ?? null,
      };
      references.push(reference);
      if (!resolved.ok || !resolved.exists || resolved.category !== "local-file") continue;
      const hostStart = finiteNumber(attribute(host, "data-start"), null);
      const hostDuration = finiteNumber(attribute(host, "data-duration"), null);
      if (hostStart == null || hostDuration == null) {
        inputBlockers.push(hardBlocker(
          "subcomposition-host-timing-invalid",
          `Sub-composition host ${nodeLabel(host)} needs numeric data-start and data-duration`,
          host.uid,
        ));
        continue;
      }
      const globalOffset = mount.globalOffset + hostStart;
      const rawWindowEnd = globalOffset + hostDuration;
      const windowEnd = mount.windowEnd == null ? rawWindowEnd : Math.min(mount.windowEnd, rawWindowEnd);
      await loadDocument(resolved.real, { globalOffset, windowEnd, hostNodeUid: host.uid }, [...ancestry, real]);
    }
    return record;
  };

  await loadDocument(entryResolved.real);

  const stylesByNode = new Map();
  const cssKeyframes = [];
  for (const documentRecord of documents) {
    const styles = await loadStylesheets(documentRecord, projectRootReal, references, dynamicItems);
    cssKeyframes.push(...styles.keyframes);
    const documentStyles = collectNodeStyles(documentRecord.nodes, styles.rules, dynamicItems);
    for (const [node, nodeStyles] of documentStyles) stylesByNode.set(node, nodeStyles);
  }

  for (const keyframe of cssKeyframes) {
    const hazardous = keyframe.declarations.filter((item) => MANUAL_RELEVANT_PROPERTIES.has(item.property));
    if (hazardous.length) {
      dynamicItems.push({
        code: "keyframe-paint-or-stacking-change",
        severity: "requires-runtime-inventory",
        source: keyframe.source,
        animationName: keyframe.name,
        properties: [...new Set(hazardous.map((item) => item.property))],
        message: "Runtime sampling must prove the animated property is supported for every affected layer",
      });
    }
  }

  const mediaElements = [];
  for (const context of mediaContexts) {
    const node = context.node;
    const candidateReferences = [];
    const directSrc = attribute(node, "src");
    const sourceNodes = node.children.filter((child) => child.tag === "source" && attribute(child, "src") != null);
    const candidates = [
      ...(directSrc != null ? [{ raw: directSrc, relation: "element-src", sourceNode: node, type: attribute(node, "type") }] : []),
      ...sourceNodes.map((sourceNode) => ({
        raw: attribute(sourceNode, "src"),
        relation: "nested-source-src",
        sourceNode,
        type: attribute(sourceNode, "type"),
      })),
    ];
    for (const candidate of candidates) {
      const resolved = await resolveReference(candidate.raw, context.document.file, projectRootReal);
      const reference = {
        id: `ref-${references.length}`,
        ownerNodeUid: node.uid,
        sourceNodeUid: candidate.sourceNode.uid,
        ownerElement: nodeLabel(node),
        kind: node.tag,
        relation: candidate.relation,
        raw: candidate.raw,
        declaredType: candidate.type,
        ...resolved,
        canonicalKey: resolved.real ?? resolved.absolute ?? resolved.url ?? (resolved.category === "data-url" ? sha256(candidate.raw) : null),
      };
      references.push(reference);
      candidateReferences.push(reference);
    }
    const selection = activeMediaSources(node, candidateReferences);
    if (selection.sourceSelection === "runtime-variable") {
      dynamicItems.push({
        code: "runtime-media-variable",
        severity: "requires-runtime-inventory",
        source: context.document.projectRelative,
        selector: nodeSelectorPath(node, context.root),
        variable: attribute(node, "data-var-src"),
        message: "data-var-src may replace the authored fallback source at render time",
      });
    }
    const timeline = mediaTimeline(node, context.globalOffset, context.windowEnd);
    const id = attribute(node, "id") ?? node.uid;
    mediaElements.push({
      id,
      nodeUid: node.uid,
      element: nodeLabel(node),
      selectorPath: nodeSelectorPath(node, context.root),
      kind: node.tag,
      compositionId: attribute(context.root, "data-composition-id"),
      document: context.document.projectRelative,
      topology: topologicalMediaPosition(node, context.root, context.document.mount),
      muted: node.attrs.has("muted"),
      hidden: node.attrs.has("hidden") || node.attrs.has("data-hidden"),
      timeline,
      sourceSelection: selection.sourceSelection,
      sourceCandidateIds: candidateReferences.map((item) => item.id),
      activeSourceCandidates: selection.active.map((item) => ({
        referenceId: item.id,
        raw: item.raw,
        canonicalKey: item.canonicalKey,
        declaredType: item.declaredType,
      })),
    });
    if (selection.sourceSelection === "missing") {
      inputBlockers.push(hardBlocker("media-source-missing", `${id} has no src or nested <source src>`, node.uid));
    }
    if (!timeline.valid) {
      inputBlockers.push(hardBlocker("media-timing-invalid", `${id} has invalid static timing`, { nodeUid: node.uid, issues: timeline.issues }));
    }
  }

  const cssFindings = analyzeCss(allNodes, stylesByNode, allCompositionRoots);
  const stacking = buildStackingInventory(allCompositionRoots, stylesByNode);
  const sourceConflicts = buildSourceConflicts(mediaElements, outputFps);
  const compositionNodeSet = new Set(allCompositionRoots.flatMap((root) => [root, ...descendants(root)]));
  const visualNonMediaCount = [...compositionNodeSet].filter((node) => (
    node.tag !== "#document"
    && !NON_VISUAL_TAGS.has(node.tag)
    && !MEDIA_TAGS.has(node.tag)
    && !allCompositionRoots.includes(node)
  )).length;
  const dedupedDynamic = dedupeDynamic(dynamicItems);
  const eligibility = buildBackendEligibility({
    mediaElements,
    references,
    sourceConflicts,
    cssFindings,
    stacking,
    dynamicItems: dedupedDynamic,
    inputBlockers,
    visualNonMediaCount,
  });

  const compositionRecords = allCompositionRoots.map((root) => {
    const documentRecord = documents.find((item) => item.nodes.includes(root));
    return {
      nodeUid: root.uid,
      id: attribute(root, "data-composition-id"),
      document: documentRecord?.projectRelative ?? null,
      mount: documentRecord?.mount ?? null,
      width: finiteNumber(attribute(root, "data-width"), null),
      height: finiteNumber(attribute(root, "data-height"), null),
      duration: finiteNumber(attribute(root, "data-duration"), null),
    };
  });

  return {
    $schema: "https://hyperframes.local/schemas/render-plan-0.1.0.json",
    schemaVersion: RENDER_PLAN_SCHEMA_VERSION,
    generatedAt: new Date().toISOString(),
    input: {
      projectRoot: projectRootReal,
      entry: entryResolved.projectRelative,
      entrySha256: documents[0]?.sha256 ?? null,
      fps: outputFps,
      pathPolicy: "entry and every local dependency must remain inside the real project root; symlink escapes are rejected",
    },
    summary: {
      documentCount: documents.length,
      compositionCount: compositionRecords.length,
      referenceCount: references.length,
      videoCount: mediaElements.filter((item) => item.kind === "video").length,
      audioCount: mediaElements.filter((item) => item.kind === "audio").length,
      differentPtsConflictCount: sourceConflicts.conflicts.length,
      cssHardFindingCount: cssFindings.filter((item) => item.severity === "hard-block-layered-manual").length,
      nestedStackingContextCount: stacking.nestedContextCount,
      dynamicItemCount: dedupedDynamic.length,
      visualNonMediaCount,
    },
    documents: documents.map((item) => ({
      id: item.id,
      projectRelative: item.projectRelative,
      sha256: item.sha256,
      mount: item.mount,
      parseIssues: item.parseIssues,
    })),
    compositions: compositionRecords,
    references: references.map((item) => {
      const copy = { ...item };
      delete copy.activeSourceCandidates;
      return copy;
    }),
    mediaElements,
    sourceConcurrency: sourceConflicts,
    stacking,
    cssFindings: cssFindings.map((item) => {
      const copy = { ...item };
      delete copy.source;
      return copy;
    }),
    dynamicItems: dedupedDynamic,
    inputHardBlockers: inputBlockers,
    backendEligibility: eligibility.backends,
    decision: eligibility.decision,
    limitations: [
      "This is a conservative static preflight, not a browser computed-style or pixel oracle",
      "Unsupported selectors, conditional CSS, variables, scripts, and animation require a runtime inventory/probe",
      "Media container PTS, codec support, edit lists, color, alpha, and browser presentation identity remain separate probes",
      "A conditional backend must not be selected automatically",
    ],
  };
}

export async function resolveSafeOutputPath(projectRoot, output) {
  const rootReal = await fs.realpath(path.resolve(projectRoot));
  const candidate = path.isAbsolute(output) ? output : path.resolve(rootReal, output);
  const resolved = await resolveContainedPath(rootReal, candidate);
  if (!resolved.ok) throw new Error(resolved.message);
  return resolved.absolute;
}

export function validateRenderPlanShape(plan) {
  const errors = [];
  if (plan?.schemaVersion !== RENDER_PLAN_SCHEMA_VERSION) errors.push("schemaVersion mismatch");
  if (!plan?.input?.projectRoot || !plan?.input?.entry) errors.push("input projectRoot/entry missing");
  if (!Array.isArray(plan?.references)) errors.push("references must be an array");
  if (!Array.isArray(plan?.mediaElements)) errors.push("mediaElements must be an array");
  if (!Array.isArray(plan?.sourceConcurrency?.conflicts)) errors.push("sourceConcurrency.conflicts must be an array");
  if (!Array.isArray(plan?.sourceConcurrency?.laneRequirements)) errors.push("sourceConcurrency.laneRequirements must be an array");
  for (const name of ["ffmpeg-only", "native-tree", "layered-manual", "screenshot-fallback"]) {
    const candidate = plan?.backendEligibility?.[name];
    if (!candidate) errors.push(`backend ${name} missing`);
    else if (!["eligible", "conditional", "ineligible"].includes(candidate.status)) errors.push(`backend ${name} status invalid`);
  }
  return { ok: errors.length === 0, errors };
}

export function pathToFileHref(file) {
  return pathToFileURL(file).href;
}
