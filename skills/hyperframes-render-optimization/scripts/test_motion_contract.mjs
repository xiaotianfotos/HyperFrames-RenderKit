#!/usr/bin/env node

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { captureMotionContract, verifyMotionContract } from "./motion_contract.mjs";

const root = mkdtempSync(join(tmpdir(), "hf-motion-contract-test-"));
try {
  mkdirSync(join(root, "compositions"));
  writeFileSync(join(root, "index.html"), "<!doctype html><main data-composition-src=\"compositions/mg.html\"></main>\n");
  const composition = join(root, "compositions", "mg.html");
  writeFileSync(composition, `<!doctype html><script>
const tl = gsap.timeline();
tl.fromTo(title, {opacity: 0}, {opacity: 1});
tl.to(title, {x: 100});
window.__timelines["mg"] = tl;
</script>\n`);
  const contractPath = join(root, "motion-contract.json");
  const contract = captureMotionContract(root, {
    entry: "index.html",
    approvalNote: "Approved native authoring preview before renderer onboarding",
  });
  writeFileSync(contractPath, `${JSON.stringify(contract, null, 2)}\n`);
  const clean = verifyMotionContract(root, contractPath);
  assert.equal(clean.passed, true);
  assert.equal(clean.baselineTotals.tweenCalls, 2);

  writeFileSync(composition, `<!doctype html><img src="baked-stage-01.png"><script>
const tl = gsap.timeline();
tl.to(document.body, {scale: 1.01});
window.__timelines["mg"] = tl;
</script>\n`);
  const regressed = verifyMotionContract(root, contractPath);
  assert.equal(regressed.passed, false);
  assert(regressed.errors.some((error) => error.includes("tweenCalls regressed")));
  assert(regressed.errors.some((error) => error.includes("new raster references")));
  assert(regressed.errors.some((error) => error.includes("animated properties disappeared")));
  console.log("motion contract tests passed");
} finally {
  rmSync(root, { recursive: true, force: true });
}
