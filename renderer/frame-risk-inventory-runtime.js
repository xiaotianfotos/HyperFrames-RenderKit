(function installHyperframesFrameRiskInventory(global) {
  "use strict";

  const KIND = "hyperframes-frame-risk-inventory";
  const SCHEMA_VERSION = 2;
  const MODES = Object.freeze(["production", "audit"]);
  const EMPTY_VALUES = new Set(["", "none", "normal", "auto", "initial", "unset"]);
  const REPLACED_PAINT_TAGS = new Set([
    "audio", "button", "canvas", "embed", "hr", "iframe", "img", "input", "meter", "object", "picture",
    "progress", "select", "svg", "textarea", "video", "webview",
  ]);
  const SVG_PAINT_TAGS = new Set([
    "circle", "ellipse", "foreignobject", "image", "line", "path", "polygon", "polyline", "rect", "text", "use",
  ]);
  const OUTSET_PAINT_PROPERTIES = new Set(["box-shadow", "css-effects", "outline", "text-shadow"]);

  function strictMode(value) {
    const normalized = value ?? "production";
    if (!MODES.includes(normalized)) {
      throw new Error(`mode must be one of ${MODES.join(", ")}, received ${normalized}`);
    }
    return normalized;
  }

  function finite(value, name, fallback = null) {
    if (value == null && fallback !== null) return fallback;
    const parsed = Number(value);
    if (!Number.isFinite(parsed)) throw new Error(`${name} must be finite, received ${value}`);
    return Object.is(parsed, -0) ? 0 : parsed;
  }

  function numericOption(value, name, fallback, { minimum = -Infinity, maximum = Infinity, maximumExclusive = false } = {}) {
    const parsed = value == null ? fallback : finite(value, name);
    if (parsed < minimum || (maximumExclusive ? parsed >= maximum : parsed > maximum)) {
      const upper = maximumExclusive ? `< ${maximum}` : `<= ${maximum}`;
      throw new Error(`${name} must be >= ${minimum} and ${upper}, received ${value}`);
    }
    return parsed;
  }

  function integer(value, name, { minimum = 0 } = {}) {
    if (!Number.isSafeInteger(value) || value < minimum) {
      throw new Error(`${name} must be an integer >= ${minimum}, received ${value}`);
    }
    return value;
  }

  function styleValue(style, cssName, jsName = null) {
    const fromMethod = typeof style?.getPropertyValue === "function"
      ? style.getPropertyValue(cssName)
      : null;
    const value = fromMethod || style?.[jsName ?? cssName] || style?.[cssName] || "";
    return String(value).trim();
  }

  function nonEmptyEffect(value, empty = EMPTY_VALUES) {
    const normalized = String(value ?? "").trim().toLowerCase();
    return !empty.has(normalized);
  }

  function compareCanonicalText(left, right) {
    return left < right ? -1 : left > right ? 1 : 0;
  }

  function classifyStyleFeatures(style) {
    const features = [];
    const add = (feature, property, value) => {
      if (nonEmptyEffect(value)) features.push({ feature, property, value: String(value).trim() });
    };

    const backdrop = styleValue(style, "backdrop-filter", "backdropFilter")
      || styleValue(style, "-webkit-backdrop-filter", "webkitBackdropFilter");
    add("backdrop-filter", "backdrop-filter", backdrop);
    add("filter", "filter", styleValue(style, "filter"));

    const blend = styleValue(style, "mix-blend-mode", "mixBlendMode");
    if (blend && blend.toLowerCase() !== "normal") {
      features.push({ feature: "mix-blend-mode", property: "mix-blend-mode", value: blend });
    }
    const backgroundBlend = styleValue(style, "background-blend-mode", "backgroundBlendMode");
    if (backgroundBlend && backgroundBlend.toLowerCase() !== "normal") {
      features.push({ feature: "background-blend-mode", property: "background-blend-mode", value: backgroundBlend });
    }

    const mask = styleValue(style, "mask", "mask")
      || styleValue(style, "mask-image", "maskImage")
      || styleValue(style, "-webkit-mask", "webkitMask")
      || styleValue(style, "-webkit-mask-image", "webkitMaskImage");
    add("mask", "mask", mask);
    add("clip-path", "clip-path", styleValue(style, "clip-path", "clipPath"));

    const perspective = styleValue(style, "perspective");
    const transformStyle = styleValue(style, "transform-style", "transformStyle").toLowerCase();
    const transform = styleValue(style, "transform");
    if (nonEmptyEffect(perspective)
      || transformStyle === "preserve-3d"
      || /(?:matrix3d|perspective|rotate[xyz]|translatez|scalez)\s*\(/i.test(transform)) {
      features.push({
        feature: "3d-transform",
        property: nonEmptyEffect(perspective) ? "perspective" : "transform",
        value: nonEmptyEffect(perspective) ? perspective : (transform || transformStyle),
      });
    }
    return features;
  }

  function rawRectIsFinite(raw) {
    if (!raw || typeof raw !== "object") return false;
    const left = Number(raw.left ?? raw.x);
    const top = Number(raw.top ?? raw.y);
    const width = Number(raw.width ?? Number(raw.right) - left);
    const height = Number(raw.height ?? Number(raw.bottom) - top);
    const right = Number(raw.right ?? left + width);
    const bottom = Number(raw.bottom ?? top + height);
    const tolerance = 1e-6;
    return [left, top, right, bottom, width, height].every(Number.isFinite)
      && width >= 0
      && height >= 0
      && right >= left
      && bottom >= top
      && Math.abs((right - left) - width) <= tolerance
      && Math.abs((bottom - top) - height) <= tolerance;
  }

  function rectShape(raw) {
    if (!rawRectIsFinite(raw)) throw new Error("element rectangle is missing, non-finite, or negative");
    const left = Number(raw.left ?? raw.x);
    const top = Number(raw.top ?? raw.y);
    const width = Number(raw.width ?? Number(raw.right) - left);
    const height = Number(raw.height ?? Number(raw.bottom) - top);
    return Object.freeze({
      left: Object.is(left, -0) ? 0 : left,
      top: Object.is(top, -0) ? 0 : top,
      right: Object.is(Number(raw.right ?? left + width), -0) ? 0 : Number(raw.right ?? left + width),
      bottom: Object.is(Number(raw.bottom ?? top + height), -0) ? 0 : Number(raw.bottom ?? top + height),
      width: Object.is(width, -0) ? 0 : width,
      height: Object.is(height, -0) ? 0 : height,
    });
  }

  function intersectionArea(left, right) {
    const width = Math.max(0, Math.min(left.right, right.right) - Math.max(left.left, right.left));
    const height = Math.max(0, Math.min(left.bottom, right.bottom) - Math.max(left.top, right.top));
    return width * height;
  }

  function cssEscape(value) {
    if (global.CSS?.escape) return global.CSS.escape(String(value));
    return String(value).replace(/[^a-zA-Z0-9_-]/g, (char) => `\\${char.codePointAt(0).toString(16)} `);
  }

  function elementTag(element) {
    return String(element?.localName ?? element?.tagName ?? "node").toLowerCase();
  }

  function defaultComposedParent(element) {
    if (element?.assignedSlot) return { parent: element.assignedSlot, crossesShadow: false };
    if (element?.parentElement) return { parent: element.parentElement, crossesShadow: false };
    const treeRoot = typeof element?.getRootNode === "function" ? element.getRootNode() : null;
    if (treeRoot?.host) return { parent: treeRoot.host, crossesShadow: true };
    return { parent: null, crossesShadow: false };
  }

  function composedContains(root, element, getComposedParent = defaultComposedParent) {
    const seen = new Set();
    let cursor = element;
    while (cursor && !seen.has(cursor)) {
      if (cursor === root) return true;
      seen.add(cursor);
      cursor = getComposedParent(cursor)?.parent ?? null;
    }
    return false;
  }

  function deepOpenShadowElements(root) {
    const result = [];
    const stack = [root];
    const seen = new Set();
    while (stack.length) {
      const element = stack.pop();
      if (!element || seen.has(element)) continue;
      seen.add(element);
      result.push(element);
      const assigned = elementTag(element) === "slot" && typeof element.assignedElements === "function"
        ? element.assignedElements({ flatten: true })
        : [];
      const lightChildren = [...(element.children ?? [])];
      const shadowChildren = element.shadowRoot?.mode !== "closed"
        ? [...(element.shadowRoot?.children ?? [])]
        : [];
      for (const child of [...lightChildren, ...shadowChildren, ...assigned].reverse()) stack.push(child);
    }
    return result;
  }

  function defaultAdapters(root) {
    const view = root?.ownerDocument?.defaultView ?? global;
    const getComposedParent = (element) => defaultComposedParent(element);
    return {
      listElements: () => deepOpenShadowElements(root),
      contains: (element) => composedContains(root, element, getComposedParent),
      getComposedParent,
      readStyle: (element) => view.getComputedStyle(element),
      readPseudoStyle: (element, pseudo) => view.getComputedStyle(element, pseudo),
      getRect: (element) => element.getBoundingClientRect(),
      getPseudoRect: null,
      isRootConnected: () => root.isConnected !== false,
      hasRenderableText: (element) => [...(element.childNodes ?? [])]
        .some((node) => node?.nodeType === 3 && String(node.textContent ?? "").trim() !== ""),
      hasOpaqueShadowContent: (element) => elementTag(element).includes("-") && !element.shadowRoot,
    };
  }

  function idCounts(elements) {
    const counts = new Map();
    for (const element of elements) {
      const id = String(element?.id ?? "").trim();
      if (id) counts.set(id, (counts.get(id) ?? 0) + 1);
    }
    return counts;
  }

  function selectorSegment(element, counts) {
    const id = String(element?.id ?? "").trim();
    if (id && counts.get(id) === 1) return `#${cssEscape(id)}`;
    const tag = elementTag(element);
    const treeRoot = !element?.parentElement && typeof element?.getRootNode === "function"
      ? element.getRootNode()
      : null;
    const siblingSource = element?.parentElement?.children ?? treeRoot?.children ?? [];
    const siblings = [...siblingSource].filter((item) => elementTag(item) === tag);
    if (siblings.length <= 1) return tag;
    return `${tag}:nth-of-type(${Math.max(1, siblings.indexOf(element) + 1)})`;
  }

  function selectorPath(element, root, adapters, counts) {
    const nodes = [];
    const separators = [];
    const seen = new Set();
    let cursor = element;
    while (cursor && !seen.has(cursor)) {
      seen.add(cursor);
      nodes.push(cursor);
      if (cursor === root) break;
      const relation = adapters.getComposedParent(cursor) ?? { parent: null, crossesShadow: false };
      separators.push(relation.crossesShadow ? " >>> " : " > ");
      cursor = relation.parent;
    }
    nodes.reverse();
    separators.reverse();
    if (!nodes.length) return ":unknown-node";
    let startIndex = 0;
    const firstShadowBoundary = separators.indexOf(" >>> ");
    if (firstShadowBoundary < 0) {
      for (let index = nodes.length - 1; index >= 0; index -= 1) {
        const id = String(nodes[index]?.id ?? "").trim();
        if (id && counts.get(id) === 1) {
          startIndex = index;
          break;
        }
      }
    } else {
      for (let index = firstShadowBoundary; index >= 0; index -= 1) {
        const id = String(nodes[index]?.id ?? "").trim();
        if (id && counts.get(id) === 1) {
          startIndex = index;
          break;
        }
      }
    }
    let result = selectorSegment(nodes[startIndex], counts);
    for (let index = startIndex + 1; index < nodes.length; index += 1) {
      result += separators[index - 1] + selectorSegment(nodes[index], counts);
    }
    return result;
  }

  function pseudoHasBox(style) {
    const content = styleValue(style, "content").toLowerCase();
    if (!content || content === "none" || content === "normal") return false;
    if (styleValue(style, "display").toLowerCase() === "none") return false;
    const visibility = styleValue(style, "visibility").toLowerCase();
    return visibility !== "hidden" && visibility !== "collapse";
  }

  function transparentColor(value) {
    const normalized = String(value ?? "").replace(/\s+/g, "").toLowerCase();
    return normalized === "" || normalized === "transparent" || /^rgba\([^)]*,0(?:\.0+)?\)$/.test(normalized);
  }

  function positiveCssLengthList(value) {
    return String(value ?? "").split(/\s+/).some((item) => Number.parseFloat(item) > 0);
  }

  function directTextContent(element) {
    return [...(element?.childNodes ?? [])]
      .filter((node) => node?.nodeType === 3)
      .map((node) => String(node.textContent ?? ""))
      .join("");
  }

  function browserPaintEntries(element, style, adapters, styleFeatures) {
    const entries = [];
    const add = (property, value) => entries.push({ property, value: String(value) });
    const tag = elementTag(element);
    if (REPLACED_PAINT_TAGS.has(tag)) {
      const source = String(element?.currentSrc ?? element?.src ?? "").trim();
      const backingSize = tag === "canvas" ? `:${Number(element?.width) || 0}x${Number(element?.height) || 0}` : "";
      const controlState = new Set(["input", "select", "textarea"]).has(tag)
        ? `:${String(element?.type ?? "")}:${String(element?.value ?? "")}:${element?.checked === true}:${Number(element?.selectedIndex) || 0}`
        : "";
      add("replaced-surface", `${tag}${backingSize}${controlState}${source ? `:${source}` : ""}`);
    }
    if (SVG_PAINT_TAGS.has(tag)) add("svg-element", tag);
    if (styleFeatures.length) {
      add("css-effects", styleFeatures
        .map((item) => `${item.property}=${item.value}`)
        .sort()
        .join(";"));
    }
    if (adapters.hasRenderableText?.(element) === true) add("text-content", directTextContent(element));
    const backgroundColor = styleValue(style, "background-color", "backgroundColor");
    if (!transparentColor(backgroundColor)) add("background-color", backgroundColor);
    const backgroundImage = styleValue(style, "background-image", "backgroundImage");
    if (nonEmptyEffect(backgroundImage)) add("background-image", backgroundImage);
    const boxShadow = styleValue(style, "box-shadow", "boxShadow");
    if (nonEmptyEffect(boxShadow)) add("box-shadow", boxShadow);
    const textShadow = styleValue(style, "text-shadow", "textShadow");
    if (nonEmptyEffect(textShadow)) add("text-shadow", textShadow);
    const borderWidth = styleValue(style, "border-width", "borderWidth");
    const borderStyle = styleValue(style, "border-style", "borderStyle");
    if (positiveCssLengthList(styleValue(style, "border-width", "borderWidth"))
      && borderStyle.toLowerCase() !== "none") {
      add("border", `${borderWidth}|${borderStyle}|${styleValue(style, "border-color", "borderColor")}`);
    }
    const outlineWidth = styleValue(style, "outline-width", "outlineWidth");
    const outlineStyle = styleValue(style, "outline-style", "outlineStyle");
    if (positiveCssLengthList(outlineWidth) && outlineStyle.toLowerCase() !== "none") {
      add("outline", `${outlineWidth}|${outlineStyle}|${styleValue(style, "outline-color", "outlineColor")}`);
    }
    if (entries.length) {
      add("paint-style", JSON.stringify({
        borderRadius: styleValue(style, "border-radius", "borderRadius"),
        color: styleValue(style, "color"),
        font: styleValue(style, "font"),
        imageRendering: styleValue(style, "image-rendering", "imageRendering"),
        isolation: styleValue(style, "isolation"),
        objectFit: styleValue(style, "object-fit", "objectFit"),
        objectPosition: styleValue(style, "object-position", "objectPosition"),
        overflow: styleValue(style, "overflow"),
        position: styleValue(style, "position"),
        transform: styleValue(style, "transform"),
        transformOrigin: styleValue(style, "transform-origin", "transformOrigin"),
        zIndex: styleValue(style, "z-index", "zIndex"),
      }));
    }
    return entries.sort((left, right) => compareCanonicalText(JSON.stringify(left), JSON.stringify(right)));
  }

  function composedPaintOrder(element, root, adapters) {
    const order = [];
    const seen = new Set();
    let cursor = element;
    while (cursor && cursor !== root && !seen.has(cursor)) {
      seen.add(cursor);
      const relation = adapters.getComposedParent(cursor) ?? { parent: null };
      if (!relation.parent) break;
      let siblings;
      if (cursor.assignedSlot && typeof cursor.assignedSlot.assignedElements === "function") {
        siblings = cursor.assignedSlot.assignedElements({ flatten: true });
      } else if (!cursor.parentElement && typeof cursor.getRootNode === "function" && cursor.getRootNode()?.host) {
        siblings = [...(cursor.getRootNode()?.children ?? [])];
      } else {
        siblings = [...(relation.parent.children ?? [])];
      }
      order.push(Math.max(0, siblings.indexOf(cursor)));
      cursor = relation.parent;
    }
    return order.reverse().join(".");
  }

  function expectedPairKey(id, feature) {
    return JSON.stringify([id, feature]);
  }

  function createFrameRiskInventory(root, options = {}) {
    if (!root) throw new Error("composition root is required");
    const inventoryMode = strictMode(options.mode);
    const adapters = { ...defaultAdapters(root), ...(options.adapters ?? {}) };
    if (typeof adapters.listElements !== "function"
      || typeof adapters.contains !== "function"
      || typeof adapters.getComposedParent !== "function"
      || typeof adapters.readStyle !== "function"
      || typeof adapters.readPseudoStyle !== "function"
      || typeof adapters.getRect !== "function") {
      throw new Error("inventory adapters are incomplete");
    }
    const opacityThreshold = numericOption(options.opacityThreshold, "opacityThreshold", 1 / 255, {
      minimum: 0,
      maximum: 1,
      maximumExclusive: true,
    });
    const minimumIntersectionArea = numericOption(options.minimumIntersectionArea, "minimumIntersectionArea", 0.25, {
      minimum: 0,
      maximum: Number.MAX_VALUE,
    });
    const embeddedTags = new Set(options.embeddedTags ?? ["iframe", "embed", "object", "webview"]);
    const trustedOpaqueShadowHostIds = new Set(options.trustedOpaqueShadowHostIds ?? []);
    const expectedRisks = options.expectedRisks == null ? null : options.expectedRisks;
    if (expectedRisks != null && !Array.isArray(expectedRisks)) throw new Error("expectedRisks must be an array");
    const expectedPairs = expectedRisks == null ? null : new Set();
    const expectedIds = expectedRisks == null ? null : new Set();
    const expectedFeatures = expectedRisks == null ? null : new Set();
    for (const [index, risk] of (expectedRisks ?? []).entries()) {
      const id = String(risk?.id ?? "").trim();
      const feature = String(risk?.feature ?? "").trim();
      if (!id || !feature) throw new Error(`expectedRisks[${index}] requires non-empty id and feature`);
      expectedPairs.add(expectedPairKey(id, feature));
      expectedIds.add(id);
      expectedFeatures.add(feature);
    }
    const unknownRiskPolicy = options.unknownRiskPolicy === "fallback" ? "oracle" : (options.unknownRiskPolicy ?? "oracle");
    if (!new Set(["oracle", "block"]).has(unknownRiskPolicy)) {
      throw new Error("unknownRiskPolicy must be oracle or block");
    }
    const inventoryStrategy = options.inventoryStrategy ?? "full-scan";
    if (!new Set(["full-scan", "candidates"]).has(inventoryStrategy)) {
      throw new Error("inventoryStrategy must be full-scan or candidates");
    }
    if (inventoryStrategy === "candidates") {
      if (typeof options.candidateElements !== "function" && !Array.isArray(options.candidateElements)) {
        throw new Error("candidateElements is required for candidates inventoryStrategy");
      }
      if (inventoryMode === "production" && typeof options.takeMutationCandidates !== "function") {
        throw new Error("production candidates inventoryStrategy requires takeMutationCandidates (MutationObserver-backed)");
      }
    }
    const legacyManifestWarning = options.expectedRiskIds != null || options.expectedRiskFeatures != null;
    const trackedCandidateElements = new Set([root]);
    if (Array.isArray(options.candidateElements)) {
      for (const element of options.candidateElements) trackedCandidateElements.add(element);
    }
    let disconnected = false;

    function enumerateElements() {
      if (disconnected) throw new Error("frame risk inventory is disconnected");
      let candidates;
      if (inventoryStrategy === "full-scan") {
        candidates = adapters.listElements();
      } else {
        const declared = typeof options.candidateElements === "function"
          ? options.candidateElements()
          : options.candidateElements;
        const mutated = typeof options.takeMutationCandidates === "function"
          ? options.takeMutationCandidates()
          : [];
        for (const element of [...(declared ?? []), ...(mutated ?? [])]) {
          if (element) trackedCandidateElements.add(element);
        }
        candidates = [...trackedCandidateElements].filter((element) => element === root || adapters.contains(element));
      }
      const unique = [];
      const seen = new Set();
      for (const element of candidates ?? []) {
        if (!element || seen.has(element)) continue;
        seen.add(element);
        unique.push(element);
      }
      if (!seen.has(root)) unique.unshift(root);
      return unique;
    }

    function collectFrameRisks({ timelineFrame = null } = {}) {
      if (timelineFrame != null) integer(timelineFrame, "timelineFrame");
      const risks = [];
      const seen = new Set();
      const warnings = [];
      if (legacyManifestWarning) {
        warnings.push("expectedRiskIds/expectedRiskFeatures are ignored; use exact expectedRisks node+feature pairs");
      }
      let visibleElementCount = 0;
      let inspectedElementCount = 0;
      let browserPaintEvidenceCount = 0;
      let rootRect;

      function syntheticRisk(feature, property, value, { blocker = false, unknown = false, evidence = {} } = {}) {
        const fallbackRect = rootRect ?? { left: 0, top: 0, right: 0, bottom: 0, width: 0, height: 0 };
        risks.push({
          id: ":composition-root",
          feature,
          active: true,
          blocker,
          unknown,
          unknownReasons: unknown ? ["uninspectable"] : [],
          evidence: {
            timelineFrame,
            selector: ":composition-root",
            pseudo: null,
            tag: elementTag(root),
            property,
            value,
            cumulativeOpacity: 1,
            rect: fallbackRect,
            intersectionArea: 0,
            dynamicRiskNode: unknown,
            unknownFeature: unknown,
            ...evidence,
          },
        });
      }

      let elements;
      try {
        if (adapters.isRootConnected?.() === false || !adapters.contains(root)) {
          syntheticRisk("invalid-composition-root", "isConnected", "false", { blocker: true });
          return finishSnapshot("invalid-root");
        }
        const rawRootRect = adapters.getRect(root);
        if (!rawRectIsFinite(rawRootRect)) {
          syntheticRisk("invalid-composition-root", "boundingClientRect", "non-finite", { blocker: true });
          return finishSnapshot("invalid-root");
        }
        rootRect = rectShape(rawRootRect);
        if (rootRect.width <= 0 || rootRect.height <= 0) {
          syntheticRisk("invalid-composition-root", "boundingClientRect", "empty", { blocker: true });
          return finishSnapshot("invalid-root");
        }
        elements = enumerateElements();
      } catch (error) {
        syntheticRisk("inventory-inspection-failed", "enumeration", String(error?.message ?? error), {
          blocker: true,
          evidence: { inspectionError: true },
        });
        return finishSnapshot("inspection-failed");
      }

      const counts = idCounts(elements);
      const styleCache = new Map();
      const structuralCache = new Map();
      const stateInProgress = new Set();

      function readStyle(element) {
        if (styleCache.has(element)) return styleCache.get(element);
        const style = adapters.readStyle(element);
        if (!style) throw new Error(`computed style unavailable for ${elementTag(element)}`);
        styleCache.set(element, style);
        return style;
      }

      function structuralVisibility(element) {
        if (structuralCache.has(element)) return structuralCache.get(element);
        if (stateInProgress.has(element)) {
          const cycle = {
            visible: false,
            reason: "composed-parent-cycle",
            inspectionError: new Error("composed parent cycle"),
            inspectionErrorElement: element,
          };
          structuralCache.set(element, cycle);
          return cycle;
        }
        stateInProgress.add(element);
        let result;
        try {
          const style = readStyle(element);
          const display = styleValue(style, "display").toLowerCase();
          const visibility = styleValue(style, "visibility").toLowerCase();
          const contentVisibility = styleValue(style, "content-visibility", "contentVisibility").toLowerCase();
          if (display === "none") result = { visible: false, reason: "display-none" };
          else if (visibility === "hidden" || visibility === "collapse") result = { visible: false, reason: "visibility-hidden" };
          else if (contentVisibility === "hidden") result = { visible: false, reason: "content-visibility-hidden" };
          else {
            const ownOpacity = Math.max(0, Math.min(1, finite(styleValue(style, "opacity") || 1, "computed opacity")));
            if (element === root) {
              result = ownOpacity <= opacityThreshold
                ? { visible: false, reason: "opacity", cumulativeOpacity: ownOpacity }
                : { visible: true, cumulativeOpacity: ownOpacity };
            } else {
              const relation = adapters.getComposedParent(element) ?? { parent: null };
              const parentState = relation.parent ? structuralVisibility(relation.parent) : { visible: false, reason: "outside-root" };
              const cumulativeOpacity = (parentState.cumulativeOpacity ?? 1) * ownOpacity;
              result = !parentState.visible
                ? { ...parentState, cumulativeOpacity }
                : cumulativeOpacity <= opacityThreshold
                  ? {
                    visible: false,
                    reason: "opacity",
                    cumulativeOpacity,
                    inspectionError: parentState.inspectionError,
                    inspectionErrorElement: parentState.inspectionErrorElement,
                  }
                  : {
                    visible: true,
                    cumulativeOpacity,
                    inspectionError: parentState.inspectionError,
                    inspectionErrorElement: parentState.inspectionErrorElement,
                  };
            }
          }
        } catch (error) {
          result = {
            visible: true,
            cumulativeOpacity: 1,
            reason: "style-inspection-failed",
            inspectionError: error,
            inspectionErrorElement: element,
          };
        }
        stateInProgress.delete(element);
        structuralCache.set(element, result);
        return result;
      }

      function geometryState(element, structural) {
        try {
          const rect = rectShape(adapters.getRect(element));
          const area = intersectionArea(rect, rootRect);
          return {
            ...structural,
            visible: structural.visible
              && rect.width > 0
              && rect.height > 0
              && area >= minimumIntersectionArea,
            reason: structural.visible && (rect.width <= 0 || rect.height <= 0 || area < minimumIntersectionArea)
              ? "outside-paint-rect"
              : structural.reason,
            rect,
            intersectionArea: area,
          };
        } catch (error) {
          return {
            ...structural,
            visible: structural.visible,
            reason: "rect-inspection-failed",
            inspectionError: error,
            rect: rootRect,
            intersectionArea: rootRect.width * rootRect.height,
          };
        }
      }

      function riskUnknownState(id, feature, forceUninspectable = false) {
        if (forceUninspectable) {
          return {
            unknown: true,
            unknownReasons: ["uninspectable"],
            dynamicRiskNode: true,
            unknownFeature: true,
            unexpectedNodeFeaturePair: true,
          };
        }
        if (expectedPairs == null) {
          const strictUnknown = inventoryMode === "production";
          return {
            unknown: strictUnknown,
            unknownReasons: strictUnknown ? ["unknown-node", "unknown-feature"] : [],
            dynamicRiskNode: strictUnknown,
            unknownFeature: strictUnknown,
            unexpectedNodeFeaturePair: strictUnknown,
          };
        }
        const dynamicRiskNode = !expectedIds.has(id);
        const unknownFeature = !expectedFeatures.has(feature);
        const unexpectedNodeFeaturePair = !expectedPairs.has(expectedPairKey(id, feature));
        const reasons = [];
        if (dynamicRiskNode) reasons.push("unknown-node");
        if (unknownFeature) reasons.push("unknown-feature");
        if (unexpectedNodeFeaturePair) reasons.push("unexpected-node-feature-pair");
        return {
          unknown: reasons.length > 0,
          unknownReasons: reasons,
          dynamicRiskNode,
          unknownFeature,
          unexpectedNodeFeaturePair,
        };
      }

      function add(element, feature, property, value, state, {
        pseudo = null,
        blocker = false,
        forceUninspectable = false,
        pseudoGeometryUnknown = false,
      } = {}) {
        const baseId = selectorPath(element, root, adapters, counts);
        const id = pseudo ? `${baseId}${pseudo}` : baseId;
        const duplicateKey = JSON.stringify([feature, id, property, value]);
        if (seen.has(duplicateKey)) return;
        seen.add(duplicateKey);
        const unknownState = riskUnknownState(id, feature, forceUninspectable);
        risks.push({
          id,
          feature,
          active: true,
          blocker: blocker || (unknownState.unknown && unknownRiskPolicy === "block"),
          unknown: unknownState.unknown,
          unknownReasons: unknownState.unknownReasons,
          evidence: {
            timelineFrame,
            selector: baseId,
            pseudo,
            tag: elementTag(element),
            property,
            value: String(value),
            cumulativeOpacity: state.cumulativeOpacity ?? 1,
            rect: state.rect ?? rootRect,
            intersectionArea: state.intersectionArea ?? 0,
            pseudoGeometryUnknown,
            dynamicRiskNode: unknownState.dynamicRiskNode,
            unknownFeature: unknownState.unknownFeature,
            unexpectedNodeFeaturePair: unknownState.unexpectedNodeFeaturePair,
            uninspectable: forceUninspectable,
            duplicateId: String(element?.id ?? "").trim() !== "" && counts.get(String(element.id).trim()) > 1,
          },
        });
      }

      function finishSnapshot(inventoryState = "complete") {
        risks.sort((left, right) => compareCanonicalText(JSON.stringify([
          left.feature,
          left.id,
          left.evidence?.property,
          left.evidence?.value,
        ]), JSON.stringify([
          right.feature,
          right.id,
          right.evidence?.property,
          right.evidence?.value,
        ])));
        return {
          kind: KIND,
          schemaVersion: SCHEMA_VERSION,
          mode: inventoryMode,
          timelineFrame,
          inventoryState,
          requiresBrowserPaint: browserPaintEvidenceCount > 0,
          risks,
          warnings,
          summary: {
            strategy: inventoryStrategy,
            inspectedElementCount,
            visibleElementCount,
            browserPaintEvidenceCount,
            activeRiskCount: risks.length,
            unknownRiskCount: risks.filter((item) => item.unknown).length,
            blockerRiskCount: risks.filter((item) => item.blocker).length,
            activeFeatures: [...new Set(risks.map((item) => item.feature))].sort(),
          },
        };
      }

      for (const element of elements) {
        inspectedElementCount += 1;
        const structural = structuralVisibility(element);
        if (!structural.visible) {
          if (structural.inspectionError) {
            add(element, "uninspectable-composed-ancestry", "visibility", String(structural.inspectionError.message ?? structural.inspectionError), {
              ...structural,
              rect: rootRect,
              intersectionArea: 0,
            }, { forceUninspectable: true });
            browserPaintEvidenceCount += 1;
          }
          continue;
        }
        const state = geometryState(element, structural);
        if (state.inspectionError) {
          add(element, "uninspectable-layout-state", state.reason ?? "inspection", String(state.inspectionError.message ?? state.inspectionError), state, {
            forceUninspectable: true,
          });
          browserPaintEvidenceCount += 1;
        }
        let style;
        try {
          style = readStyle(element);
        } catch (error) {
          add(element, "uninspectable-computed-style", "getComputedStyle", String(error?.message ?? error), state, {
            forceUninspectable: true,
          });
          browserPaintEvidenceCount += 1;
          continue;
        }

        const styleFeatures = classifyStyleFeatures(style);
        const paintEntries = browserPaintEntries(element, style, adapters, styleFeatures);
        if (state.visible) {
          visibleElementCount += 1;
          if (paintEntries.length) {
            browserPaintEvidenceCount += 1;
            paintEntries.push({ property: "paint-order", value: composedPaintOrder(element, root, adapters) });
            for (const entry of paintEntries) {
              add(element, "browser-paint-active", entry.property, entry.value, state);
            }
          }
          for (const item of styleFeatures) add(element, item.feature, item.property, item.value, state);

          const tag = elementTag(element);
          if (embeddedTags.has(tag)) add(element, "embedded-browser-surface", tag, tag, state);
          if (tag === "video" && (element.mediaKeys || element.webkitKeys)) {
            add(element, "protected-content", "mediaKeys", "attached", state, { blocker: true });
          }
          const opaqueShadowId = selectorPath(element, root, adapters, counts);
          if (adapters.hasOpaqueShadowContent?.(element) === true && !trustedOpaqueShadowHostIds.has(opaqueShadowId)) {
            add(element, "opaque-shadow-content", "shadowRoot", "uninspectable", state, {
              forceUninspectable: true,
            });
            browserPaintEvidenceCount += 1;
          }
        } else if (state.reason === "outside-paint-rect") {
          // CSS filters, shadows, outlines, and 3D effects can paint beyond the host's layout rect.
          const overflowEntries = paintEntries.filter((entry) => OUTSET_PAINT_PROPERTIES.has(entry.property));
          if (overflowEntries.length || styleFeatures.length) {
            browserPaintEvidenceCount += 1;
            for (const entry of overflowEntries) {
              add(element, "browser-paint-active", entry.property, entry.value, state, {
                forceUninspectable: true,
              });
            }
            for (const item of styleFeatures) {
              add(element, item.feature, item.property, item.value, state, {
                forceUninspectable: true,
              });
            }
          }
        }

        // A zero-sized or off-root host may still paint an overflowing pseudo-element or filter.
        for (const pseudo of ["::before", "::after"]) {
          let pseudoStyle;
          try {
            pseudoStyle = adapters.readPseudoStyle(element, pseudo);
          } catch (error) {
            add(element, "uninspectable-pseudo-element", "getComputedStyle", String(error?.message ?? error), state, {
              pseudo,
              forceUninspectable: true,
              pseudoGeometryUnknown: true,
            });
            browserPaintEvidenceCount += 1;
            continue;
          }
          if (!pseudoStyle || !pseudoHasBox(pseudoStyle)) continue;
          const pseudoOpacity = Math.max(0, Math.min(1, finite(styleValue(pseudoStyle, "opacity") || 1, "pseudo opacity")));
          const cumulativeOpacity = (state.cumulativeOpacity ?? 1) * pseudoOpacity;
          if (cumulativeOpacity <= opacityThreshold) continue;
          let pseudoRect = null;
          try {
            pseudoRect = typeof adapters.getPseudoRect === "function"
              ? rectShape(adapters.getPseudoRect(element, pseudo))
              : null;
          } catch {
            pseudoRect = null;
          }
          const pseudoState = pseudoRect
            ? {
              ...state,
              visible: intersectionArea(pseudoRect, rootRect) >= minimumIntersectionArea,
              cumulativeOpacity,
              rect: pseudoRect,
              intersectionArea: intersectionArea(pseudoRect, rootRect),
            }
            : {
              ...state,
              visible: true,
              cumulativeOpacity,
              rect: state.rect ?? rootRect,
              intersectionArea: state.intersectionArea ?? 0,
            };
          const geometryUnknown = pseudoRect == null;
          browserPaintEvidenceCount += 1;
          add(element, "pseudo-element-paint", "content", styleValue(pseudoStyle, "content"), pseudoState, {
            pseudo,
            forceUninspectable: geometryUnknown,
            pseudoGeometryUnknown: geometryUnknown,
          });
          for (const item of classifyStyleFeatures(pseudoStyle)) {
            add(element, item.feature, item.property, item.value, pseudoState, {
              pseudo,
              forceUninspectable: geometryUnknown,
              pseudoGeometryUnknown: geometryUnknown,
            });
          }
        }
      }

      return finishSnapshot("complete");
    }

    function disconnect() {
      disconnected = true;
      trackedCandidateElements.clear();
      options.disconnectMutationObserver?.();
    }

    return Object.freeze({ collectFrameRisks, disconnect });
  }

  function abortIfNeeded(signal) {
    if (!signal?.aborted) return;
    const error = new Error("frame backend prepass aborted");
    error.name = "AbortError";
    throw error;
  }

  function prepassError(code, message, plan = null) {
    const error = new Error(message);
    error.code = code;
    if (plan) Object.defineProperty(error, "plan", { value: plan, enumerable: false });
    return error;
  }

  async function runFrameBackendPrepass({
    root,
    frameCount,
    startFrame = 0,
    fpsNumerator,
    fpsDenominator = 1,
    backends,
    order,
    seekFrame,
    settleFrame = null,
    seekFrameGuaranteesSettled = false,
    afterFrame = null,
    inventoryOptions = {},
    mode: requestedMode = "production",
    determinismPasses = requestedMode === "production" ? 2 : 1,
    blockerPolicy = requestedMode === "production" ? "throw" : "return",
    signal = null,
    checkpointEvery = 600,
    onCheckpoint = null,
    projectIdentity = null,
    renderPlanIdentity = null,
    machineProfileIdentity = null,
    styleOverrideProfileHash = null,
    retainRanges,
    maxRetainedRanges,
    maxRetainedBlockerRanges,
    onRange,
  }) {
    const prepassMode = strictMode(requestedMode);
    if (typeof seekFrame !== "function") throw new Error("seekFrame callback is required");
    if (settleFrame != null && typeof settleFrame !== "function") throw new Error("settleFrame must be a function");
    if (afterFrame != null && typeof afterFrame !== "function") throw new Error("afterFrame must be a function");
    if (onCheckpoint != null && typeof onCheckpoint !== "function") throw new Error("onCheckpoint must be a function");
    integer(determinismPasses, "determinismPasses", { minimum: 1 });
    integer(checkpointEvery, "checkpointEvery", { minimum: 1 });
    if (!new Set(["throw", "return"]).has(blockerPolicy)) throw new Error("blockerPolicy must be throw or return");
    if (prepassMode === "production" && !settleFrame && seekFrameGuaranteesSettled !== true) {
      throw new Error("production prepass requires settleFrame or seekFrameGuaranteesSettled=true");
    }
    if (prepassMode === "production" && determinismPasses < 2) {
      throw new Error("production prepass requires at least two determinism passes");
    }
    if (inventoryOptions.mode != null && inventoryOptions.mode !== prepassMode) {
      throw new Error("inventoryOptions.mode must match prepass mode");
    }
    const planRuntime = global.HyperframesFrameBackendPlan;
    if (!planRuntime?.createFrameBackendPlanBuilder || !planRuntime?.createRiskSignature) {
      throw new Error("HyperframesFrameBackendPlan schemaVersion 2 must be installed before the risk inventory runtime");
    }
    const builder = planRuntime.createFrameBackendPlanBuilder({
      frameCount,
      startFrame,
      fpsNumerator,
      fpsDenominator,
      backends,
      order,
      mode: prepassMode,
      projectIdentity,
      renderPlanIdentity,
      machineProfileIdentity,
      styleOverrideProfileHash,
      ...(retainRanges === undefined ? {} : { retainRanges }),
      ...(maxRetainedRanges === undefined ? {} : { maxRetainedRanges }),
      ...(maxRetainedBlockerRanges === undefined ? {} : { maxRetainedBlockerRanges }),
      ...(onRange === undefined ? {} : { onRange }),
    });
    const inventory = createFrameRiskInventory(root, { ...inventoryOptions, mode: prepassMode });
    const featuresByFrame = new Map();
    let maxVisibleElements = 0;
    let maxActiveRisks = 0;
    let maxBrowserPaintEvidence = 0;

    async function seekAndCollect(offset, passIndex) {
      abortIfNeeded(signal);
      const timelineFrame = startFrame + offset;
      const timeSeconds = timelineFrame * fpsDenominator / fpsNumerator;
      await seekFrame({ timelineFrame, timeSeconds, offset, passIndex });
      abortIfNeeded(signal);
      if (settleFrame) await settleFrame({ timelineFrame, timeSeconds, offset, passIndex });
      abortIfNeeded(signal);
      const snapshot = inventory.collectFrameRisks({ timelineFrame });
      if (afterFrame) await afterFrame({ timelineFrame, timeSeconds, offset, passIndex, snapshot });
      return { timelineFrame, timeSeconds, snapshot };
    }

    let plan;
    try {
      for (let offset = 0; offset < frameCount; offset += 1) {
        const { timelineFrame, snapshot } = await seekAndCollect(offset, 0);
        builder.addFrame({
          timelineFrame,
          risks: snapshot.risks,
          requiresBrowserPaint: snapshot.requiresBrowserPaint,
          inventoryState: snapshot.inventoryState,
        });
        maxVisibleElements = Math.max(maxVisibleElements, snapshot.summary.visibleElementCount);
        maxActiveRisks = Math.max(maxActiveRisks, snapshot.summary.activeRiskCount);
        maxBrowserPaintEvidence = Math.max(maxBrowserPaintEvidence, snapshot.summary.browserPaintEvidenceCount);
        for (const feature of snapshot.summary.activeFeatures) {
          featuresByFrame.set(feature, (featuresByFrame.get(feature) ?? 0) + 1);
        }
        if (onCheckpoint && ((offset + 1) % checkpointEvery === 0 || offset + 1 === frameCount)) {
          await onCheckpoint({ passIndex: 0, ...builder.checkpoint() });
        }
      }
      plan = builder.finish();
      plan.prepassSummary = {
        maxVisibleElements,
        maxActiveRisks,
        maxBrowserPaintEvidence,
        framesByActiveFeature: Object.fromEntries([...featuresByFrame.entries()].sort(([left], [right]) => compareCanonicalText(left, right))),
      };

      if (prepassMode === "production" && plan.summary.rangesTruncated) {
        throw prepassError(
          "FRAME_BACKEND_PLAN_RANGE_LIMIT",
          `frame backend plan produced ${plan.summary.rangeCount} ranges, exceeding retained limit ${plan.summary.retainedRangeCount}`,
          plan,
        );
      }
      if (plan.summary.blockerFrames > 0 && blockerPolicy === "throw") {
        throw prepassError(
          "FRAME_BACKEND_PLAN_BLOCKED",
          `frame backend prepass found ${plan.summary.blockerFrames} non-executable frames`,
          plan,
        );
      }

      if (determinismPasses > 1) {
        if (!plan.summary.rangesRetained || plan.summary.rangesTruncated) {
          throw prepassError("FRAME_BACKEND_PLAN_DETERMINISM_UNAVAILABLE", "determinism replay requires complete retained ranges", plan);
        }
        for (let passIndex = 1; passIndex < determinismPasses; passIndex += 1) {
          let rangeIndex = 0;
          for (let offset = 0; offset < frameCount; offset += 1) {
            const { timelineFrame, snapshot } = await seekAndCollect(offset, passIndex);
            while (plan.ranges[rangeIndex]?.endFrameExclusive <= timelineFrame) rangeIndex += 1;
            const expected = plan.ranges[rangeIndex];
            const actualSignature = planRuntime.createRiskSignature(snapshot.risks);
            const matches = expected
              && expected.startFrame <= timelineFrame
              && expected.endFrameExclusive > timelineFrame
              && expected.requiresBrowserPaint === snapshot.requiresBrowserPaint
              && expected.inventoryState === snapshot.inventoryState
              && JSON.stringify(expected.riskSignature) === JSON.stringify(actualSignature);
            if (!matches) {
              plan.determinism = {
                state: "failed",
                passIndex,
                timelineFrame,
                expected: expected ? {
                  requiresBrowserPaint: expected.requiresBrowserPaint,
                  inventoryState: expected.inventoryState,
                  riskSignature: expected.riskSignature,
                } : null,
                actual: {
                  requiresBrowserPaint: snapshot.requiresBrowserPaint,
                  inventoryState: snapshot.inventoryState,
                  riskSignature: actualSignature,
                },
              };
              plan.validationState = "failed";
              if (prepassMode === "production" || blockerPolicy === "throw") {
                throw prepassError(
                  "FRAME_BACKEND_PLAN_NONDETERMINISTIC",
                  `prepass replay diverged at frame ${timelineFrame} on pass ${passIndex + 1}`,
                  plan,
                );
              }
              return plan;
            }
            if (onCheckpoint && ((offset + 1) % checkpointEvery === 0 || offset + 1 === frameCount)) {
              await onCheckpoint({
                kind: `${KIND}-replay-checkpoint`,
                schemaVersion: SCHEMA_VERSION,
                passIndex,
                processedFrames: offset + 1,
                frameCount,
                nextFrame: timelineFrame + 1,
              });
            }
          }
        }
        plan.determinism = { state: "passed", passes: determinismPasses };
      } else {
        plan.determinism = { state: "unverified", passes: 1 };
      }
      return plan;
    } finally {
      inventory.disconnect();
    }
  }

  global.HyperframesFrameRiskInventory = Object.freeze({
    KIND,
    SCHEMA_VERSION,
    MODES,
    classifyStyleFeatures,
    createFrameRiskInventory,
    runFrameBackendPrepass,
  });
})(typeof globalThis === "undefined" ? window : globalThis);
