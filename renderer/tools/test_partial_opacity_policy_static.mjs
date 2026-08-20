import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const rendererRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const main = readFileSync(resolve(rendererRoot, "full-canvas-main.mjs"), "utf8");
const renderer = readFileSync(resolve(rendererRoot, "full-canvas-renderer.js"), "utf8");

assert.match(main, /partialOpacityPolicy: args\.partialOpacityPolicy \?\? "preserve"/);
assert.match(main, /\["preserve", "promote-dynamic"\]\.includes\(config\.partialOpacityPolicy\)/);
assert.match(renderer, /function promoteDynamicPartialOpacity\(items\)/);
assert.match(renderer, /inlineOpacity === ""/);
assert.match(renderer, /opacity <= 0\.001 \|\| opacity >= 0\.999/);
assert.match(renderer, /element\.style\.opacity = "1"/);
assert.match(renderer, /finally \{\s*for \(const \[element, opacity\] of opacityRestorations\) element\.style\.opacity = opacity;/);
assert.match(renderer, /context\.save\(\);[\s\S]*?finally \{\s*context\.restore\(\);/);
assert.match(renderer, /promotedDynamicOpacityElements: framePromotedDynamicOpacityElements/);
assert.match(renderer, /framesWithPromotedDynamicOpacity/);

console.log("partial_opacity_policy_static: ok");
