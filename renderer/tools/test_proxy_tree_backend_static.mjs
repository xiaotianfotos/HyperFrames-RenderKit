import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const toolsRoot = dirname(fileURLToPath(import.meta.url));
const rendererRoot = resolve(toolsRoot, "..");
const main = readFileSync(resolve(rendererRoot, "full-canvas-main.mjs"), "utf8");
const renderer = readFileSync(resolve(rendererRoot, "full-canvas-renderer.js"), "utf8");

assert.match(main, /import \{ transformProxyTreeHtml \} from "\.\/tools\/proxy_tree_transformer\.mjs"/);
assert.match(main, /--compositeMode=proxy-tree requires --mediaTargetMode=timing-plan/);
assert.match(main, /\["layered", "proxy-tree"\]\.includes\(config\.compositeMode\)/);
assert.match(main, /loadedMediaTimingBundle\.entries/);
assert.match(main, /intrinsicDimensionsBySource/);
assert.match(main, /auditProxyTreeDisplayDimensions/);
assert.match(main, /sample_aspect_ratio,display_aspect_ratio/);
assert.match(main, /does not yet support non-square sample aspect ratio/);
assert.match(main, /does not yet support rotated display metadata/);
assert.match(main, /await prepareProxyTreeEntry\(\)/);
assert.match(main, /writeFileSync\(tempEntry, transformed\.html, \{ encoding: "utf8", flag: "wx" \}\)/);
assert.match(main, /unlinkSync\(path\)/);
assert.match(main, /process\.once\("exit", cleanupProxyTreeEntry\)/);
const prepareIndex = main.indexOf("prepareProxyTreeEntry();");
const loadIndex = main.indexOf("await window.loadFile(loadEntry)");
assert.ok(prepareIndex >= 0 && loadIndex > prepareIndex, "proxy transform must complete before page load/scripts");
assert.doesNotMatch(main, /window\.loadFile\(entry\)/, "proxy-tree must load the generated entry, not the source entry");

assert.match(renderer, /function isVideoProxyElement\(element\)/);
assert.match(renderer, /element\.hasAttribute\("data-hf-video-proxy"\)/);
assert.match(renderer, /const useManualMediaBackend = !nativeScreenshot[\s\S]*?compositeMode === "layered" \|\| compositeMode === "proxy-tree"/);
assert.match(renderer, /const useDecoderDeck = useManualMediaBackend && !productionDecoderEnabled/);
assert.match(renderer, /if \(useManualMediaBackend\) \{[\s\S]*?clip\.element\.removeAttribute\("src"\)/);
assert.match(renderer, /PRODUCTION_HTMLVIDEO_FALLBACK_FORBIDDEN/);
assert.match(renderer, /drawVideoIntoProxyCanvas\(clip, preparedFrameSources\.get\(clip\)\)/);
assert.match(renderer, /proxy-tree early transform left .* live <video>/);
assert.match(renderer, /proxyTreeTransform\?\.proxyCount !== staticVideoProxies\.length/);
assert.match(renderer, /proxy-tree source descriptor changed before renderer startup/);
assert.match(renderer, /proxy-tree intrinsic source descriptor changed before renderer startup/);
assert.match(renderer, /root\.querySelectorAll\("video,canvas\[data-hf-video-proxy\]"\)/);
assert.match(renderer, /if \(!preparedFrameSources\.has\(clip\)\)/);
assert.match(renderer, /drawVideoIntoProxyCanvas\(clip, preparedFrameSources\.get\(clip\)\)/);
assert.match(renderer, /proxyContext\.clearRect\(0, 0, size\.width, size\.height\)/);
for (const fit of ["contain", "cover", "scale-down", "none", "fill"]) {
  assert.ok(renderer.includes(`\"${fit}\"`), `proxy renderer must define object-fit=${fit}`);
}
assert.match(renderer, /captureContract: compositeMode === "proxy-tree"/);
assert.match(renderer, /const preserveAuthoredBackground = compositeMode === "proxy-tree"/);
assert.match(renderer, /if \(!preserveAuthoredBackground\) \{[\s\S]*?root\.style\.setProperty\("background"/);
assert.match(renderer, /rootBackgroundImage: getComputedStyle\(root\)\.backgroundImage/);
assert.match(renderer, /HF_PROXY_ANCESTOR_BACKGROUND_UNSUPPORTED/);

const proxyTreeBranchStart = renderer.indexOf('} else if (compositeMode === "proxy-tree") {');
const legacyProxyBranchStart = renderer.indexOf('} else if (compositeMode === "proxy") {', proxyTreeBranchStart);
assert.ok(proxyTreeBranchStart >= 0 && legacyProxyBranchStart > proxyTreeBranchStart);
const proxyTreeBranch = renderer.slice(proxyTreeBranchStart, legacyProxyBranchStart);
assert.doesNotMatch(proxyTreeBranch, /drawElementImage/, "proxy child updates must not capture partial bands");
const finalRootCapture = renderer.indexOf('if (compositeMode !== "layered") {', legacyProxyBranchStart);
assert.ok(finalRootCapture > legacyProxyBranchStart, "non-layered backends need one final whole-root capture");
const finalCaptureBlock = renderer.slice(finalRootCapture, renderer.indexOf("if (diagnostics)", finalRootCapture));
assert.equal((finalCaptureBlock.match(/context\.drawElementImage\(root, 0, 0\)/g) ?? []).length, 1);
assert.match(finalCaptureBlock, /layerBandCount = 1/);

const deckResetLoop = renderer.match(/for \(const clip of videos\) \{[\s\S]*?clip\.element\.load\(\);[\s\S]*?\n    \}/)?.[0];
assert.ok(deckResetLoop, "decoder deck setup loop must exist");
assert.match(deckResetLoop, /if \(!\(clip\.element instanceof HTMLVideoElement\)\) continue/);

console.log("proxy_tree_backend_static: ok");
