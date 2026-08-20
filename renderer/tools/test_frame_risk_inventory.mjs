#!/usr/bin/env node

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { runInNewContext } from "node:vm";

const rendererRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const sandbox = {};
runInNewContext(readFileSync(resolve(rendererRoot, "frame-backend-plan-runtime.js"), "utf8"), sandbox);
runInNewContext(readFileSync(resolve(rendererRoot, "frame-risk-inventory-runtime.js"), "utf8"), sandbox);
const planRuntime = sandbox.HyperframesFrameBackendPlan;
const runtime = sandbox.HyperframesFrameRiskInventory;
const plain = (value) => JSON.parse(JSON.stringify(value));

function element(tag, { id = "", parent = null, rect = [0, 0, 20, 20], text = "" } = {}) {
  const node = {
    localName: tag,
    id,
    parentElement: parent,
    children: [],
    childNodes: text ? [{ nodeType: 3, textContent: text }] : [],
    rect: {
      left: rect[0],
      top: rect[1],
      width: rect[2],
      height: rect[3],
      right: rect[0] + rect[2],
      bottom: rect[1] + rect[3],
    },
  };
  if (parent) parent.children.push(node);
  return node;
}

function composedParent(node) {
  if (node.assignedSlot) return { parent: node.assignedSlot, crossesShadow: false };
  if (node.parentElement) return { parent: node.parentElement, crossesShadow: false };
  const treeRoot = node.getRootNode?.();
  return treeRoot?.host
    ? { parent: treeRoot.host, crossesShadow: true }
    : { parent: null, crossesShadow: false };
}

function composedContains(root, candidate) {
  const seen = new Set();
  let cursor = candidate;
  while (cursor && !seen.has(cursor)) {
    if (cursor === root) return true;
    seen.add(cursor);
    cursor = composedParent(cursor).parent;
  }
  return false;
}

const root = element("main", { id: "composition", rect: [0, 0, 100, 100] });
const glass = element("div", { id: "glass", parent: root, rect: [10, 10, 40, 40] });
const hidden = element("div", { id: "hidden", parent: root, rect: [0, 0, 30, 30] });
const hiddenChild = element("span", { id: "hidden-child", parent: hidden, rect: [0, 0, 20, 20] });
const frame = element("iframe", { id: "remote", parent: root, rect: [60, 10, 20, 20] });
const styles = new Map();
const base = {
  display: "block",
  visibility: "visible",
  opacity: "1",
  "content-visibility": "visible",
  "background-color": "rgba(0, 0, 0, 0)",
  "background-image": "none",
  "box-shadow": "none",
  "text-shadow": "none",
  "border-width": "0px",
  "border-style": "none",
  "outline-width": "0px",
  "outline-style": "none",
};
for (const node of [root, glass, hidden, hiddenChild, frame]) styles.set(node, { ...base });
styles.set(glass, { ...base, "backdrop-filter": "blur(10px)", filter: "brightness(1.1)" });
styles.set(hidden, { ...base, opacity: "0" });
styles.set(hiddenChild, { ...base, "mix-blend-mode": "multiply" });
const pseudo = new Map([[glass, {
  "::before": { ...base, content: "\"\"", "clip-path": "circle(50%)" },
  "::after": { ...base, content: "none", mask: "url(mask.svg)" },
}]]);
const nodes = [root, glass, hidden, hiddenChild, frame];
const adapters = {
  listElements: () => nodes,
  contains: (candidate) => composedContains(root, candidate),
  getComposedParent: composedParent,
  readStyle: (node) => styles.get(node),
  readPseudoStyle: (node, name) => pseudo.get(node)?.[name] ?? { ...base, content: "none" },
  getRect: (node) => node.rect,
  isRootConnected: () => true,
  hasRenderableText: (node) => node.childNodes.some((item) => item.nodeType === 3 && item.textContent.trim()),
  hasOpaqueShadowContent: () => false,
};

const expectedRisks = [
  { id: "#glass", feature: "browser-paint-active" },
  { id: "#glass", feature: "backdrop-filter" },
  { id: "#glass", feature: "filter" },
  { id: "#glass::before", feature: "pseudo-element-paint" },
  { id: "#glass::before", feature: "clip-path" },
  { id: "#remote", feature: "browser-paint-active" },
  { id: "#remote", feature: "embedded-browser-surface" },
];
const inventory = runtime.createFrameRiskInventory(root, { adapters, expectedRisks });
const snapshot = inventory.collectFrameRisks({ timelineFrame: 12 });
assert.deepEqual(plain(snapshot.summary.activeFeatures), [
  "backdrop-filter",
  "browser-paint-active",
  "clip-path",
  "embedded-browser-surface",
  "filter",
  "pseudo-element-paint",
]);
assert.equal(snapshot.risks.some((item) => item.id === "#hidden-child"), false);
assert.equal(snapshot.risks.find((item) => item.feature === "clip-path").id, "#glass::before");
assert.equal(snapshot.risks.find((item) => item.feature === "clip-path").unknown, true);
assert.equal(snapshot.risks.find((item) => item.feature === "clip-path").evidence.pseudoGeometryUnknown, true);
assert.equal(snapshot.risks.find((item) => item.feature === "embedded-browser-surface").id, "#remote");
assert.equal(snapshot.requiresBrowserPaint, true);

assert.deepEqual(plain(runtime.classifyStyleFeatures({
  transform: "matrix3d(1,0,0,0,0,1,0,0,0,0,1,0,0,0,0,1)",
  "mix-blend-mode": "screen",
  "background-blend-mode": "multiply",
}).map((item) => item.feature)), ["mix-blend-mode", "background-blend-mode", "3d-transform"]);

// Production has no implicit trust: absent manifest entries make active risks oracle-only.
const noManifest = runtime.createFrameRiskInventory(root, { adapters }).collectFrameRisks({ timelineFrame: 0 });
assert.equal(noManifest.risks.filter((item) => !item.blocker).every((item) => item.unknown), true);
const auditDiscovery = runtime.createFrameRiskInventory(root, { adapters, mode: "audit" }).collectFrameRisks({ timelineFrame: 0 });
assert.equal(auditDiscovery.risks.some((item) => item.unknown && item.evidence.pseudo === null), false);

// Counterexample: an expected node acquiring a new feature is still unknown as a node+feature pair.
const pairManifest = runtime.createFrameRiskInventory(root, {
  adapters,
  expectedRisks: [{ id: "#glass", feature: "backdrop-filter" }],
}).collectFrameRisks({ timelineFrame: 0 });
assert.equal(pairManifest.risks.find((item) => item.feature === "backdrop-filter").unknown, false);
const unexpectedFilter = pairManifest.risks.find((item) => item.feature === "filter");
assert.equal(unexpectedFilter.unknown, true);
assert.equal(unexpectedFilter.evidence.unexpectedNodeFeaturePair, true);

// Ordinary text is browser paint even with an empty special-risk list.
const textRoot = element("main", { id: "text-root", rect: [0, 0, 100, 100] });
const paragraph = element("p", { id: "copy", parent: textRoot, rect: [0, 0, 80, 20], text: "ordinary DOM text" });
const textStyles = new Map([[textRoot, { ...base }], [paragraph, { ...base }]]);
const textAdapters = {
  ...adapters,
  listElements: () => [textRoot, paragraph],
  contains: (node) => composedContains(textRoot, node),
  readStyle: (node) => textStyles.get(node),
  getRect: (node) => node.rect,
};
const textSnapshot = runtime.createFrameRiskInventory(textRoot, {
  adapters: textAdapters,
  expectedRisks: [{ id: "#copy", feature: "browser-paint-active" }],
}).collectFrameRisks({ timelineFrame: 0 });
assert.equal(textSnapshot.risks.every((item) => item.feature === "browser-paint-active"), true);
const textContentRisk = textSnapshot.risks.find((item) => item.evidence.property === "text-content");
assert.equal(textContentRisk.evidence.value, "ordinary DOM text");
assert.equal(textSnapshot.risks.some((item) => item.evidence.property === "paint-style"), true);
assert.equal(textSnapshot.risks.some((item) => item.evidence.property === "paint-order"), true);
assert.equal(textSnapshot.requiresBrowserPaint, true);
assert.equal(textSnapshot.summary.browserPaintEvidenceCount, 1);

// A zero-sized/off-root host still exposes an overflowing pseudo-element conservatively.
const pseudoRoot = element("main", { id: "pseudo-root", rect: [0, 0, 100, 100] });
const zeroHost = element("div", { id: "zero-host", parent: pseudoRoot, rect: [150, 150, 0, 0] });
const pseudoStyles = new Map([[pseudoRoot, { ...base }], [zeroHost, { ...base, filter: "blur(8px)" }]]);
const pseudoAdapters = {
  ...adapters,
  listElements: () => [pseudoRoot, zeroHost],
  contains: (node) => composedContains(pseudoRoot, node),
  readStyle: (node) => pseudoStyles.get(node),
  readPseudoStyle: (node, name) => node === zeroHost && name === "::before"
    ? { ...base, content: "\"overflow\"", "clip-path": "circle(50%)" }
    : { ...base, content: "none" },
  getRect: (node) => node.rect,
};
const pseudoOverflow = runtime.createFrameRiskInventory(pseudoRoot, {
  adapters: pseudoAdapters,
  expectedRisks: [],
}).collectFrameRisks({ timelineFrame: 0 });
assert.equal(pseudoOverflow.risks.some((item) => item.id === "#zero-host::before" && item.feature === "pseudo-element-paint"), true);
assert.equal(pseudoOverflow.risks.some((item) => item.id === "#zero-host" && item.feature === "filter"), true);
assert.equal(pseudoOverflow.risks.every((item) => item.unknown), true);
assert.equal(pseudoOverflow.requiresBrowserPaint, true);

// Open shadow roots are traversable and selectors retain their host boundary; opaque roots use the oracle.
const shadowRoot = element("main", { id: "shadow-root", rect: [0, 0, 100, 100] });
const openHost = element("x-card", { id: "open-host", parent: shadowRoot, rect: [0, 0, 50, 50] });
const shadowGlass = element("div", { id: "shadow-glass", rect: [5, 5, 20, 20] });
const fakeShadowTree = { host: openHost, mode: "open", children: [shadowGlass] };
openHost.shadowRoot = fakeShadowTree;
shadowGlass.getRootNode = () => fakeShadowTree;
const closedHost = element("x-closed", { id: "closed-host", parent: shadowRoot, rect: [50, 0, 40, 40] });
const shadowStyles = new Map([
  [shadowRoot, { ...base }],
  [openHost, { ...base }],
  [shadowGlass, { ...base, filter: "blur(2px)" }],
  [closedHost, { ...base }],
]);
const shadowNodes = [shadowRoot, openHost, shadowGlass, closedHost];
const shadowAdapters = {
  ...adapters,
  listElements: () => shadowNodes,
  contains: (node) => composedContains(shadowRoot, node),
  getComposedParent: composedParent,
  readStyle: (node) => shadowStyles.get(node),
  readPseudoStyle: () => ({ ...base, content: "none" }),
  getRect: (node) => node.rect,
  hasOpaqueShadowContent: (node) => node === closedHost,
};
const shadowSnapshot = runtime.createFrameRiskInventory(shadowRoot, {
  adapters: shadowAdapters,
  expectedRisks: [
    { id: "#open-host >>> #shadow-glass", feature: "browser-paint-active" },
    { id: "#open-host >>> #shadow-glass", feature: "filter" },
  ],
}).collectFrameRisks({ timelineFrame: 0 });
assert.equal(shadowSnapshot.risks.some((item) => item.id === "#open-host >>> #shadow-glass" && item.unknown === false), true);
const opaqueShadow = shadowSnapshot.risks.find((item) => item.feature === "opaque-shadow-content");
assert.equal(opaqueShadow.id, "#closed-host");
assert.equal(opaqueShadow.unknown, true);
assert.equal(opaqueShadow.evidence.uninspectable, true);

// Duplicate IDs cannot collapse two distinct risk nodes into the same signature.
const duplicateRoot = element("main", { id: "duplicate-root", rect: [0, 0, 100, 100] });
const duplicateA = element("div", { id: "dup", parent: duplicateRoot, rect: [0, 0, 20, 20] });
const duplicateB = element("div", { id: "dup", parent: duplicateRoot, rect: [30, 0, 20, 20] });
const duplicateStyles = new Map([
  [duplicateRoot, { ...base }],
  [duplicateA, { ...base, filter: "blur(1px)" }],
  [duplicateB, { ...base, filter: "blur(1px)" }],
]);
const duplicateAdapters = {
  ...adapters,
  listElements: () => [duplicateRoot, duplicateA, duplicateB],
  contains: (node) => composedContains(duplicateRoot, node),
  readStyle: (node) => duplicateStyles.get(node),
  readPseudoStyle: () => ({ ...base, content: "none" }),
  getRect: (node) => node.rect,
};
const duplicateSnapshot = runtime.createFrameRiskInventory(duplicateRoot, {
  adapters: duplicateAdapters,
  mode: "audit",
}).collectFrameRisks({ timelineFrame: 0 });
const duplicateIds = duplicateSnapshot.risks.filter((item) => item.feature === "filter").map((item) => item.id);
assert.equal(new Set(duplicateIds).size, 2);
assert.equal(duplicateSnapshot.risks.filter((item) => item.feature === "filter").every((item) => item.evidence.duplicateId), true);

// Invalid composition roots become hard blockers rather than empty, apparently safe inventories.
const detachedAdapters = { ...adapters, isRootConnected: () => false };
const invalidRootSnapshot = runtime.createFrameRiskInventory(root, { adapters: detachedAdapters }).collectFrameRisks({ timelineFrame: 0 });
assert.equal(invalidRootSnapshot.risks[0].feature, "invalid-composition-root");
assert.equal(invalidRootSnapshot.risks[0].blocker, true);
assert.equal(invalidRootSnapshot.inventoryState, "invalid-root");

// The default adapter reads computed style from the root document's realm, not the installer realm.
let realmStyleReads = 0;
const realmRoot = element("main", { id: "realm-root", rect: [0, 0, 20, 20] });
realmRoot.isConnected = true;
realmRoot.getBoundingClientRect = () => realmRoot.rect;
realmRoot.ownerDocument = {
  defaultView: {
    getComputedStyle: (_node, pseudoName) => {
      realmStyleReads += 1;
      return pseudoName ? { ...base, content: "none" } : { ...base };
    },
  },
};
runtime.createFrameRiskInventory(realmRoot, { expectedRisks: [] }).collectFrameRisks({ timelineFrame: 0 });
assert.ok(realmStyleReads >= 3);

assert.throws(() => runtime.createFrameRiskInventory(root, { adapters, opacityThreshold: 1 }), /opacityThreshold/);
assert.throws(() => runtime.createFrameRiskInventory(root, {
  adapters,
  inventoryStrategy: "candidates",
  candidateElements: [glass],
}), /MutationObserver-backed/);

// A deterministic production prepass selects fast ranges only for an exact profile+signature proof.
let activeFrame = 0;
const changingStyles = new Map(styles);
const changingAdapters = {
  ...adapters,
  readPseudoStyle: () => ({ ...base, content: "none" }),
  readStyle: (node) => {
    if (node === glass) {
      return activeFrame >= 1 && activeFrame < 3
        ? { ...base, "backdrop-filter": "blur(10px)" }
        : { ...base, "backdrop-filter": "none" };
    }
    return changingStyles.get(node);
  },
};
const changingExpectedRisks = [
  { id: "#glass", feature: "browser-paint-active" },
  { id: "#glass", feature: "backdrop-filter" },
  { id: "#remote", feature: "browser-paint-active" },
  { id: "#remote", feature: "embedded-browser-surface" },
];
const frameZeroSnapshot = runtime.createFrameRiskInventory(root, {
  adapters: changingAdapters,
  expectedRisks: changingExpectedRisks,
}).collectFrameRisks({ timelineFrame: 0 });
const identities = {
  projectIdentity: "project-sha",
  renderPlanIdentity: "render-plan-sha",
  machineProfileIdentity: "machine-sha",
  styleOverrideProfileHash: "style-sha",
};
const proxyGate = "proxy-gate-sha";
const proxyProof = {
  ...identities,
  gateProfileHash: proxyGate,
  requiresBrowserPaint: frameZeroSnapshot.requiresBrowserPaint,
  riskSignature: planRuntime.createRiskSignature(frameZeroSnapshot.risks),
};
let checkpointCount = 0;
const prepassPlan = await runtime.runFrameBackendPrepass({
  root,
  startFrame: 0,
  frameCount: 4,
  fpsNumerator: 60,
  backends: [
    { name: "proxy-tree", eligible: true, gateProfileHash: proxyGate, provenRiskSignatures: [proxyProof] },
    { name: "screenshot", eligible: true, oracle: true },
  ],
  inventoryOptions: { adapters: changingAdapters, expectedRisks: changingExpectedRisks },
  seekFrame: async ({ timelineFrame }) => { activeFrame = timelineFrame; },
  settleFrame: async () => {},
  checkpointEvery: 2,
  onCheckpoint: async () => { checkpointCount += 1; },
  ...identities,
});
assert.deepEqual(plain(prepassPlan.ranges.map((item) => [item.startFrame, item.endFrameExclusive, item.backend])), [
  [0, 1, "proxy-tree"],
  [1, 3, "screenshot"],
  [3, 4, "proxy-tree"],
]);
assert.deepEqual(plain(prepassPlan.prepassSummary.framesByActiveFeature), {
  "backdrop-filter": 2,
  "browser-paint-active": 4,
  "embedded-browser-surface": 4,
});
assert.deepEqual(plain(prepassPlan.determinism), { state: "passed", passes: 2 });
assert.equal(prepassPlan.validationState, "pending");
assert.equal(prepassPlan.renderable, false);
assert.equal(checkpointCount, 4);

// Production throws on blockers; audit mode may return the bounded non-executable diagnosis.
await assert.rejects(() => runtime.runFrameBackendPrepass({
  root,
  frameCount: 1,
  fpsNumerator: 60,
  backends: [{ name: "screenshot", eligible: true, oracle: true }],
  inventoryOptions: { adapters: detachedAdapters },
  seekFrame: async () => {},
  settleFrame: async () => {},
}), (error) => error.code === "FRAME_BACKEND_PLAN_BLOCKED"
  && error.plan.renderable === false
  && error.plan.ranges[0].backend === "fail");

const auditBlocked = await runtime.runFrameBackendPrepass({
  root,
  frameCount: 1,
  fpsNumerator: 60,
  backends: [{ name: "screenshot", eligible: true, oracle: true }],
  inventoryOptions: { adapters: detachedAdapters },
  seekFrame: async () => {},
  mode: "audit",
  retainRanges: true,
});
assert.equal(auditBlocked.summary.blockerFrames, 1);
assert.equal(auditBlocked.ranges[0].backend, "fail");
assert.equal(auditBlocked.renderable, false);

// Replay divergence is a hard production failure, never a warning.
let nondeterministicPass = 0;
const nondeterministicAdapters = {
  ...changingAdapters,
  readStyle: (node) => node === glass
    ? { ...base, filter: nondeterministicPass === 0 ? "blur(1px)" : "blur(2px)" }
    : changingStyles.get(node),
};
await assert.rejects(() => runtime.runFrameBackendPrepass({
  root,
  frameCount: 1,
  fpsNumerator: 60,
  backends: [{ name: "screenshot", eligible: true, oracle: true }],
  inventoryOptions: {
    adapters: nondeterministicAdapters,
    expectedRisks: [
      { id: "#glass", feature: "browser-paint-active" },
      { id: "#glass", feature: "filter" },
      { id: "#remote", feature: "browser-paint-active" },
      { id: "#remote", feature: "embedded-browser-surface" },
    ],
  },
  seekFrame: async ({ passIndex }) => { nondeterministicPass = passIndex; },
  settleFrame: async () => {},
}), (error) => error.code === "FRAME_BACKEND_PLAN_NONDETERMINISTIC"
  && error.plan.validationState === "failed"
  && error.plan.renderable === false);

const abortController = new AbortController();
abortController.abort();
await assert.rejects(() => runtime.runFrameBackendPrepass({
  root,
  frameCount: 1,
  fpsNumerator: 60,
  backends: [{ name: "screenshot", eligible: true, oracle: true }],
  inventoryOptions: { adapters, expectedRisks },
  seekFrame: async () => {},
  settleFrame: async () => {},
  signal: abortController.signal,
}), (error) => error.name === "AbortError");

console.log("frame risk inventory tests passed");
