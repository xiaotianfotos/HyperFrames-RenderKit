#!/usr/bin/env node

import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { parse } from "parse5";
import { transformScreenshotHtml } from "./screenshot_entry_transformer.mjs";

const root = mkdtempSync(resolve(tmpdir(), "hf-screenshot-transform-"));
try {
  const entryPath = resolve(root, "index.html");
  const authored = `<!doctype html><html><body>
    <video id="a" class="clip" src="a.mp4" muted></video>
    <video id="b" preload="metadata"><source src="b.mp4"></video>
    <script>const literal = '<video id="not-dom">';</script>
  </body></html>`;
  writeFileSync(entryPath, authored);
  const result = transformScreenshotHtml({ entryPath });
  assert.equal(result.report.videoCount, 2);
  assert.equal(result.report.domMutations, 0);
  assert.equal(result.report.boundedStatic.eligible, true);
  assert.equal(result.html, authored);
  assert.deepEqual(result.report.videos.map((video) => video.authoredPreload), [null, "metadata"]);
  const parsed = parse(result.html);
  const videos = [];
  const walk = (node) => {
    if (node.tagName === "video") videos.push(node);
    for (const child of node.childNodes ?? []) walk(child);
    if (node.content) walk(node.content);
  };
  walk(parsed);
  assert.equal(videos.length, 2);
  assert.equal(videos[0].attrs.find((item) => item.name === "preload"), undefined);
  assert.equal(videos[1].attrs.find((item) => item.name === "preload")?.value, "metadata");
  assert.match(result.html, /const literal = '<video id="not-dom">'/);

  const unsafePath = resolve(root, "unsafe.html");
  writeFileSync(unsafePath, `<!doctype html><video id="v" src="a.mp4"></video>
    <script>document.getElementById('v').currentTime = 2;</script>`);
  const unsafe = transformScreenshotHtml({ entryPath: unsafePath, projectRoot: root });
  assert.equal(unsafe.report.boundedStatic.eligible, false);
  assert.ok(unsafe.report.boundedStatic.blockers.some((item) => item.code === "HF_SCREENSHOT_TARGETED_MEDIA_STATE_OR_LIFECYCLE"));
  console.log("screenshot entry transformer tests: ok");
} finally {
  rmSync(root, { recursive: true, force: true });
}
