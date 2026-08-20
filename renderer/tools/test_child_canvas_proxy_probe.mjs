import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  DEFAULT_CHILD_CANVAS_THRESHOLDS,
  buildProxyReplacementPlan,
  classifyDirectVideoControl,
  compareBitmaps,
  evaluateBitmapMetric,
  evaluateChildCanvasGate,
  makeAmplifiedDifference,
  metricPasses,
} from "./child_canvas_proxy_probe_lib.mjs";

const width = 16;
const height = 12;
const toolsRoot = path.dirname(fileURLToPath(import.meta.url));

function bitmapOf(bitmapWidth, bitmapHeight, fill) {
  const output = Buffer.alloc(bitmapWidth * bitmapHeight * 4);
  for (let y = 0; y < bitmapHeight; y += 1) {
    for (let x = 0; x < bitmapWidth; x += 1) {
      const offset = (y * bitmapWidth + x) * 4;
      const value = typeof fill === "function" ? fill(x, y) : fill;
      output[offset] = value[0];
      output[offset + 1] = value[1];
      output[offset + 2] = value[2];
      output[offset + 3] = value[3] ?? 255;
    }
  }
  return output;
}

function bitmap(fill) {
  return bitmapOf(width, height, fill);
}

const reference = bitmap((x, y) => [30 + x * 8, 40 + y * 10, 160 - x * 4, 255]);
const identical = Buffer.from(reference);
const identicalMetric = compareBitmaps(reference, identical, width, height);
assert.equal(identicalMetric.meanAbsoluteError, 0);
assert.equal(identicalMetric.badPixelFraction, 0);
assert.ok(Math.abs(identicalMetric.lumaSsim - 1) < 1e-12);
assert.ok(identicalMetric.localAnalysis);
assert.equal(identicalMetric.localAnalysis.aggregate.tileCount, 1);
assert.equal(evaluateBitmapMetric(identicalMetric, DEFAULT_CHILD_CANVAS_THRESHOLDS.full).pass, true);

const localized = Buffer.from(reference);
for (let y = 4; y < 7; y += 1) {
  for (let x = 5; x < 8; x += 1) {
    const offset = (y * width + x) * 4;
    localized[offset] = Math.min(255, localized[offset] + 12);
  }
}
const localizedMetric = compareBitmaps(reference, localized, width, height, {
  region: { name: "feature", x: 4, y: 3, width: 6, height: 6 },
});
assert.equal(localizedMetric.region.name, "feature");
assert.ok(localizedMetric.meanAbsoluteError > 0);
assert.equal(metricPasses(localizedMetric, {
  maximumMeanAbsoluteError: 10,
  maximumBadPixelFraction: 0.2,
  minimumLumaSsim: 0.9,
}), true);

// Synthetic regression for the v2 backdrop failure: a narrow, coherent rectangle
// is small enough for the old whole-frame metrics to pass, but is visibly wrong in
// the tiles that overlap it. This fixture needs no PNG decoder or external package.
const regressionWidth = 1024;
const regressionHeight = 256;
const regressionReference = bitmapOf(regressionWidth, regressionHeight, (x, y) => [
  10 + Math.floor((220 * x) / (regressionWidth - 1)),
  10 + Math.floor((220 * y) / (regressionHeight - 1)),
  10 + ((x * 7 + y * 3) % 221),
  255,
]);
const localizedArtifact = Buffer.from(regressionReference);
const artifactRegion = { x: 512, y: 32, width: 32, height: 192 };
for (let y = artifactRegion.y; y < artifactRegion.y + artifactRegion.height; y += 1) {
  for (let x = artifactRegion.x; x < artifactRegion.x + artifactRegion.width; x += 1) {
    const offset = (y * regressionWidth + x) * 4;
    localizedArtifact[offset] += 24;
    localizedArtifact[offset + 1] += 24;
    localizedArtifact[offset + 2] += 24;
  }
}
const artifactMetric = compareBitmaps(
  regressionReference,
  localizedArtifact,
  regressionWidth,
  regressionHeight,
);
assert.ok(
  artifactMetric.meanAbsoluteError <= DEFAULT_CHILD_CANVAS_THRESHOLDS.full.maximumMeanAbsoluteError,
  "old whole-frame MAE would pass",
);
assert.ok(
  artifactMetric.badPixelFraction <= DEFAULT_CHILD_CANVAS_THRESHOLDS.full.maximumBadPixelFraction,
  "old whole-frame bad-pixel ratio would pass",
);
assert.ok(
  artifactMetric.lumaSsim >= DEFAULT_CHILD_CANVAS_THRESHOLDS.full.minimumLumaSsim,
  "old whole-frame covariance SSIM would pass",
);
const artifactEvaluation = evaluateBitmapMetric(
  artifactMetric,
  DEFAULT_CHILD_CANVAS_THRESHOLDS.full,
);
assert.equal(artifactEvaluation.rawPass, true);
assert.equal(artifactEvaluation.localPass, false);
assert.equal(artifactEvaluation.pass, false);
assert.ok(artifactEvaluation.failures.some((failure) => failure.scope === "local"));
const worstArtifactTile = artifactMetric.localAnalysis.aggregate
  .worstTiles.badBlockFraction[0];
assert.ok(worstArtifactTile.badBlockFraction > 0.3);
assert.ok(worstArtifactTile.region.x < artifactRegion.x + artifactRegion.width);
assert.ok(worstArtifactTile.region.x + worstArtifactTile.region.width > artifactRegion.x);
assert.match(JSON.stringify(artifactMetric), /"worstTiles"/);

const mildGlobalShift = Buffer.from(regressionReference);
for (let offset = 0; offset < mildGlobalShift.length; offset += 4) {
  mildGlobalShift[offset] += 3;
  mildGlobalShift[offset + 1] += 3;
  mildGlobalShift[offset + 2] += 3;
}
const mildGlobalMetric = compareBitmaps(
  regressionReference,
  mildGlobalShift,
  regressionWidth,
  regressionHeight,
);
const mildGlobalEvaluation = evaluateBitmapMetric(
  mildGlobalMetric,
  DEFAULT_CHILD_CANVAS_THRESHOLDS.full,
);
assert.equal(mildGlobalEvaluation.pass, true, "a mild coherent color shift remains accepted");
assert.equal(mildGlobalEvaluation.localPass, true);

const antialiasDifference = Buffer.from(regressionReference);
for (let x = 0; x < regressionWidth; x += 1) {
  const y = (x * 3) % regressionHeight;
  const offset = (y * regressionWidth + x) * 4;
  antialiasDifference[offset] += 20;
  antialiasDifference[offset + 1] += 20;
  antialiasDifference[offset + 2] += 20;
}
const antialiasMetric = compareBitmaps(
  regressionReference,
  antialiasDifference,
  regressionWidth,
  regressionHeight,
);
assert.equal(
  evaluateBitmapMetric(antialiasMetric, DEFAULT_CHILD_CANVAS_THRESHOLDS.full).pass,
  true,
  "sparse one-pixel antialiasing differences must not trigger the local gate",
);

const black = bitmap([0, 0, 0, 255]);
const blackMetric = compareBitmaps(reference, black, width, height);
assert.ok(blackMetric.meanAbsoluteError > 50);
assert.ok(blackMetric.badPixelFraction > 0.9);

const support = {
  drawElementImage: true,
  requestPaint: true,
  cssTransform: true,
  cssBorderRadius: true,
  cssFilter: true,
  cssBackdropFilter: true,
};
const passingGate = evaluateChildCanvasGate({
  fullMetric: identicalMetric,
  featureMetrics: [identicalMetric, localizedMetric],
  support,
});
assert.equal(passingGate.pass, true);
assert.equal(passingGate.fullEvaluation.localPass, true);

const localizedArtifactGate = evaluateChildCanvasGate({
  fullMetric: artifactMetric,
  featureMetrics: [identicalMetric],
  support,
});
assert.equal(localizedArtifactGate.pass, false);
assert.equal(localizedArtifactGate.fullPass, false);
assert.ok(localizedArtifactGate.fullEvaluation.failures.some((failure) => failure.scope === "local"));

const artifactFeatureMetric = compareBitmaps(
  regressionReference,
  localizedArtifact,
  regressionWidth,
  regressionHeight,
  { region: { name: "backdrop", x: 480, y: 0, width: 128, height: 256 } },
);
const localizedFeatureGate = evaluateChildCanvasGate({
  fullMetric: mildGlobalMetric,
  featureMetrics: [artifactFeatureMetric],
  support,
});
assert.equal(localizedFeatureGate.fullPass, true);
assert.equal(localizedFeatureGate.pass, false);
assert.equal(localizedFeatureGate.featureResults[0].name, "backdrop");
assert.ok(localizedFeatureGate.featureResults[0].evaluation.failures.some(
  (failure) => failure.scope === "local",
));

const metricWithoutLocalAnalysis = compareBitmaps(reference, identical, width, height, {
  localAnalysis: false,
});
const missingLocalEvaluation = evaluateBitmapMetric(
  metricWithoutLocalAnalysis,
  DEFAULT_CHILD_CANVAS_THRESHOLDS.full,
);
assert.equal(missingLocalEvaluation.rawPass, true);
assert.equal(missingLocalEvaluation.localPass, false);
assert.ok(missingLocalEvaluation.failures.some(
  (failure) => failure.check === "localAnalysisAvailable",
));

const missingBackdrop = evaluateChildCanvasGate({
  fullMetric: identicalMetric,
  featureMetrics: [identicalMetric],
  support: { ...support, cssBackdropFilter: false },
});
assert.equal(missingBackdrop.pass, false);
assert.equal(missingBackdrop.supportChecks.cssBackdropFilter, false);

const failedPixels = evaluateChildCanvasGate({
  fullMetric: blackMetric,
  featureMetrics: [blackMetric],
  support,
});
assert.equal(failedPixels.pass, false);

const directBlack = classifyDirectVideoControl(blackMetric);
assert.equal(directBlack.classification, "black-or-missing-video-pixels");
assert.equal(directBlack.equivalent, false);
const directEquivalent = classifyDirectVideoControl(identicalMetric);
assert.equal(directEquivalent.classification, "captured-equivalent");

const difference = makeAmplifiedDifference(reference, localized, width, height, 4);
assert.equal(difference.byteLength, width * height * 4);
assert.equal(difference[3], 255);

const replacement = buildProxyReplacementPlan({
  videoDescriptor: {
    source: "media/clip.mp4",
    attributes: {
      id: "clip",
      class: "clip pip",
      src: "media/clip.mp4",
      "data-start": "2",
      "data-duration": "5",
    },
  },
  childCanvasGate: passingGate,
});
assert.equal(replacement.eligible, true);
assert.deepEqual(replacement.preservedAttributes, ["id", "class", "data-start", "data-duration"]);
assert.ok(replacement.steps.some((step) => step.includes("drawElementImage")));
assert.equal(buildProxyReplacementPlan({ childCanvasGate: failedPixels }).eligible, false);

assert.throws(
  () => compareBitmaps(Buffer.alloc(4), Buffer.alloc(4), width, height),
  /expected/,
);
assert.throws(
  () => compareBitmaps(reference, identical, width, height, { region: { name: "outside", x: 99, y: 99, width: 2, height: 2 } }),
  /outside/,
);

const pageHtml = await fs.readFile(path.join(toolsRoot, "child_canvas_proxy_probe.html"), "utf8");
const pageScript = await fs.readFile(path.join(toolsRoot, "child_canvas_proxy_probe_page.js"), "utf8");
const mainScript = await fs.readFile(path.join(toolsRoot, "child_canvas_proxy_probe.mjs"), "utf8");
assert.match(pageHtml, /<canvas id="capture-canvas"[^>]*layoutsubtree/);
for (const cssCapability of ["transform:", "border-radius:", "filter:", "backdrop-filter:", "z-index:"]) {
  assert.ok(pageHtml.includes(cssCapability), `fixture must exercise ${cssCapability}`);
}
assert.match(pageScript, /captureContext\.drawElementImage\(targetRoot, 0, 0\)/);
assert.match(pageScript, /source\.captureStream\(30\)/);
assert.match(pageScript, /window\.childCanvasProxyProbe/);
assert.match(pageScript, /raf-timeout/);
assert.match(pageScript, /Canvas fallback child did not receive/);
assert.match(mainScript, /withTimeout\([\s\S]*capturePage/);
assert.match(mainScript, /global-watchdog/);
assert.match(mainScript, /show: args\.show !== "false"/);
assert.match(mainScript, /persistResult\(emergencyResult\)/);
assert.match(mainScript, /status: "running"/);
assert.match(mainScript, /capture-timeout-ms/);
assert.match(mainScript, /step-timeout-ms/);
assert.match(mainScript, /total-timeout-ms/);
assert.match(mainScript, /status: "child-gate-complete-control-pending"/);
assert.match(mainScript, /classification: "control-unavailable"/);
assert.match(mainScript, /preserveChildGateWithUnavailableControl\(latestChildGateResult/);
assert.doesNotMatch(mainScript, /classifyDirectVideoControl\(directVideo\.fullMetric[\s\S]{0,120}const replacementPlan/);
const childCheckpointIndex = mainScript.indexOf("await checkpointChildGate(childGateResult)");
const directVideoCaptureIndex = mainScript.indexOf('captureCase(window, "direct-video")');
assert.ok(childCheckpointIndex >= 0, "child gate must be checkpointed");
assert.ok(directVideoCaptureIndex > childCheckpointIndex, "optional direct-video control must run after child gate checkpoint");

console.log("child_canvas_proxy_probe: ok");
