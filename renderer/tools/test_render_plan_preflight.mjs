import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildRenderPlan, resolveSafeOutputPath, validateRenderPlanShape } from "./render_plan_preflight_lib.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const fixtures = path.join(here, "render-plan-fixtures");

const complex = await buildRenderPlan({
  projectRoot: path.join(fixtures, "complex"),
  entry: "index.html",
  fps: 60,
});
assert.equal(validateRenderPlanShape(complex).ok, true);
assert.equal(complex.summary.documentCount, 2);
assert.equal(complex.summary.videoCount, 4);
assert.equal(complex.summary.audioCount, 0);
assert.equal(complex.references.filter((item) => item.relation === "nested-source-src").length, 2);
assert.equal(complex.mediaElements.find((item) => item.id === "browser-choice").sourceSelection, "browser-choice");
const directConflict = complex.sourceConcurrency.conflicts.find((item) => item.leftMediaId === "plate-a" && item.rightMediaId === "plate-b");
assert.ok(directConflict);
assert.equal(directConflict.firstOutputFrame, 120);
assert.equal(directConflict.leftRequestedPts, 2);
assert.equal(directConflict.rightRequestedPts, 10);
assert.equal(complex.sourceConcurrency.laneRequirements.find((item) => item.canonicalSource.endsWith("/media/shared.mp4")).requiredLanes, 3);
assert.equal(complex.mediaElements.find((item) => item.id === "sub-video").topology, "subcomposition-media");
for (const code of ["rotate-skew-perspective-or-3d-transform", "css-filter", "mix-blend-mode", "complex-border-radius", "clip-path"]) {
  assert.ok(complex.cssFindings.some((item) => item.code === code), `missing CSS finding ${code}`);
}
assert.ok(complex.stacking.items.some((item) => item.scope === "nested" && item.createsStackingContext));
assert.equal(complex.backendEligibility["layered-manual"].status, "ineligible");
assert.equal(complex.backendEligibility["native-tree"].status, "conditional");
assert.equal(complex.backendEligibility["screenshot-fallback"].status, "conditional");
assert.equal(complex.backendEligibility["layered-manual"].autoSelectable, false);
assert.ok(complex.dynamicItems.some((item) => item.code === "dynamic-style-or-animation"));

const safe = await buildRenderPlan({
  projectRoot: path.join(fixtures, "safe"),
  entry: "index.html",
  fps: 60,
});
assert.equal(validateRenderPlanShape(safe).ok, true);
assert.equal(safe.inputHardBlockers.length, 0);
assert.equal(safe.sourceConcurrency.conflicts.length, 0);
assert.equal(safe.cssFindings.filter((item) => item.severity === "hard-block-layered-manual").length, 0);
assert.equal(safe.backendEligibility["layered-manual"].status, "conditional");
assert.ok(safe.backendEligibility["layered-manual"].requirements.includes("golden-frame pixel comparison at entrances, cuts, dense motion, and exits"));

const unsafe = await buildRenderPlan({
  projectRoot: path.join(fixtures, "unsafe"),
  entry: "index.html",
  fps: 60,
});
const escapeReference = unsafe.references.find((item) => item.raw === "../../outside.mp4");
assert.equal(escapeReference.ok, false);
assert.equal(escapeReference.code, "path-outside-project");
const encodedEscapeReference = unsafe.references.find((item) => item.raw === "../../outside-encoded.mp4");
assert.equal(encodedEscapeReference.ok, false);
assert.equal(encodedEscapeReference.code, "path-outside-project");
assert.equal(unsafe.backendEligibility["screenshot-fallback"].status, "ineligible");

await assert.rejects(
  buildRenderPlan({ projectRoot: path.join(fixtures, "safe"), entry: "../complex/index.html", fps: 60 }),
  /escapes the project root/,
);
await assert.rejects(
  resolveSafeOutputPath(path.join(fixtures, "safe"), "../render-plan-escape.json"),
  /escapes the project root/,
);

console.log("render_plan_preflight: ok");
