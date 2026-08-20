import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parse } from "parse5";
import {
  ProxyTreeTransformError,
  selectorUsesVideoTag,
  transformProxyTreeHtml,
} from "./proxy_tree_transformer.mjs";

const toolsRoot = dirname(fileURLToPath(import.meta.url));
const fixtureRoot = mkdtempSync(resolve(tmpdir(), "hf-proxy-tree-transform-"));

function walk(node, output = []) {
  output.push(node);
  for (const child of node.childNodes ?? []) walk(child, output);
  if (node.content) walk(node.content, output);
  return output;
}

function attr(node, name) {
  return node.attrs?.find((item) => item.name === name)?.value ?? null;
}

function writeFixture(name, html, { css = null, script = null, media = true } = {}) {
  const root = resolve(fixtureRoot, name);
  mkdirSync(root, { recursive: true });
  if (media) writeFileSync(resolve(root, "clip.mov"), "fixture");
  if (css != null) writeFileSync(resolve(root, "style.css"), css);
  if (script != null) writeFileSync(resolve(root, "page.js"), script);
  const entryPath = resolve(root, "index.html");
  writeFileSync(entryPath, html);
  return entryPath;
}

function intrinsicDimensions(entryPath, source = "clip.mov", width = 320, height = 180) {
  return new Map([[
    pathToFileURL(resolve(dirname(entryPath), source)).href,
    { width, height },
  ]]);
}

function transformFixture(entryPath, {
  source = "clip.mov",
  width = 320,
  height = 180,
} = {}) {
  return transformProxyTreeHtml({
    entryPath,
    intrinsicDimensionsBySource: intrinsicDimensions(entryPath, source, width, height),
  });
}

function expectBlocker(entryPath, code) {
  assert.throws(
    () => transformFixture(entryPath),
    (error) => error instanceof ProxyTreeTransformError
      && error.blocker === true
      && error.code === code,
  );
}

try {
  assert.equal(selectorUsesVideoTag("video"), true);
  assert.equal(selectorUsesVideoTag(".shell > video.hero:hover"), true);
  assert.equal(selectorUsesVideoTag(":is(canvas, video)"), true);
  assert.equal(selectorUsesVideoTag("#video"), false);
  assert.equal(selectorUsesVideoTag(".video-card[data-kind=video]"), false);

  const successfulEntry = writeFixture("success", `<!doctype html>
<html><head>
  <link rel="stylesheet" href="style.css">
  <style>#hero { object-fit: cover } .video-card[data-kind="video"], .video-card[src], #hero[muted] { opacity: .8 }</style>
</head><body>
  <main data-composition-id="proxy-fixture">
    <video id="hero" class="clip video-card" style="width:320px;height:180px" data-start="1" data-duration="2" data-track-index="4" data-kind="video" aria-label="hero" width="320" height="180" src="clip.mov" muted playsinline preload="auto"></video>
  </main>
  <script>window.__proxySeenByPage = true; gsap?.to?.(".video-card[src]", { opacity: 1 });</script>
</body></html>`, {
    css: "#hero, .video-card { transform: rotate(1deg) }",
  });
  const successful = transformProxyTreeHtml({ entryPath: successfulEntry });
  const nodes = walk(parse(successful.html));
  const proxy = nodes.find((node) => attr(node, "data-hf-video-proxy") === "");
  assert.ok(proxy, "video must become a statically parsed proxy canvas");
  assert.equal(proxy.tagName, "canvas");
  assert.equal(attr(proxy, "id"), "hero");
  assert.equal(attr(proxy, "class"), "clip video-card");
  assert.equal(attr(proxy, "style"), "width:320px;height:180px");
  assert.equal(attr(proxy, "data-start"), "1");
  assert.equal(attr(proxy, "data-duration"), "2");
  assert.equal(attr(proxy, "data-track-index"), "4");
  assert.equal(attr(proxy, "data-kind"), "video");
  assert.equal(attr(proxy, "aria-label"), "hero");
  assert.equal(attr(proxy, "width"), "320");
  assert.equal(attr(proxy, "height"), "180");
  assert.equal(attr(proxy, "src"), "clip.mov");
  assert.equal(attr(proxy, "muted"), "");
  assert.equal(attr(proxy, "data-hf-video-src"), "clip.mov");
  assert.equal(attr(proxy, "data-hf-video-source-kind"), "src");
  assert.equal(successful.report.proxyCount, 1);
  assert.equal(successful.report.baseUrl, pathToFileURL(successfulEntry).href);
  const injectedBase = nodes.find((node) => attr(node, "data-hf-proxy-base") === "");
  assert.ok(injectedBase, "transformed entries must declare the original entry as their explicit base URL");
  assert.equal(attr(injectedBase, "href"), pathToFileURL(successfulEntry).href);
  assert.equal(successful.report.proxies[0].sourceUrl.endsWith("/clip.mov"), true);
  assert.equal(nodes.some((node) => node.tagName === "video"), false);
  assert.ok(successful.html.indexOf("data-hf-video-proxy") < successful.html.indexOf("__proxySeenByPage"));
  const detachedBase = pathToFileURL(resolve(fixtureRoot, "detached/runtime-entry.html")).href;
  assert.throws(
    () => transformProxyTreeHtml({ entryPath: successfulEntry, baseUrl: detachedBase }),
    (error) => error instanceof ProxyTreeTransformError && error.code === "HF_PROXY_BASE_URL_MISMATCH",
  );

  const nestedSourceEntry = writeFixture("nested-source", `<!doctype html><html><head><style>.clip:has(> source) { opacity:.9 }</style></head><body>
    <div data-composition-id="nested"><video id="nested" class="clip"><source src="clip.mov" type="video/quicktime"></video></div>
    <script>window.__timelines = { main: { seek() {} } };</script>
  </body></html>`);
  const nestedSource = transformFixture(nestedSourceEntry);
  assert.match(nestedSource.html, /data-hf-video-source-kind="source"/);
  assert.match(nestedSource.html, /data-hf-video-type="video\/quicktime"/);
  assert.match(nestedSource.html, /width="320"/);
  assert.match(nestedSource.html, /height="180"/);
  assert.match(nestedSource.html, /data-hf-video-source-width="320"/);
  assert.match(nestedSource.html, /data-hf-video-source-height="180"/);
  assert.match(nestedSource.html, /<source\b[^>]*src="clip\.mov"/);

  const naturalSizeEntry = writeFixture("natural-size", `<!doctype html><html><body>
    <main data-composition-id="natural"><video id="natural" class="clip" src="clip.mov"></video></main>
    <script>window.__timelines = { main: { seek() {} } };</script>
  </body></html>`);
  assert.throws(
    () => transformProxyTreeHtml({ entryPath: naturalSizeEntry }),
    (error) => error instanceof ProxyTreeTransformError
      && error.code === "HF_PROXY_INTRINSIC_SIZE_UNPROVEN",
  );
  const naturalSize = transformFixture(naturalSizeEntry, { width: 640, height: 360 });
  const naturalProxy = walk(parse(naturalSize.html)).find((node) => attr(node, "data-hf-video-proxy") === "");
  assert.equal(attr(naturalProxy, "width"), "640");
  assert.equal(attr(naturalProxy, "height"), "360");
  assert.equal(naturalSize.report.proxies[0].intrinsicSize.policy, "verified-source-intrinsic-dimensions");

  const widthOnlyEntry = writeFixture("width-only", `<!doctype html><html><body>
    <main data-composition-id="width-only"><video class="clip" width="400" src="clip.mov"></video></main>
    <script>window.__timelines = { main: { seek() {} } };</script>
  </body></html>`);
  const widthOnly = transformFixture(widthOnlyEntry, { width: 640, height: 360 });
  const widthOnlyProxy = walk(parse(widthOnly.html)).find((node) => attr(node, "data-hf-video-proxy") === "");
  assert.equal(attr(widthOnlyProxy, "width"), "400");
  assert.equal(attr(widthOnlyProxy, "height"), "225");
  assert.equal(widthOnly.report.proxies[0].intrinsicSize.policy, "derived-height-from-verified-source-ratio");

  assert.throws(
    () => transformProxyTreeHtml({
      entryPath: naturalSizeEntry,
      intrinsicDimensionsBySource: intrinsicDimensions(naturalSizeEntry, "clip.mov", 0, 360),
    }),
    (error) => error instanceof ProxyTreeTransformError
      && error.code === "HF_PROXY_INVALID_SOURCE_DIMENSIONS",
  );

  expectBlocker(writeFixture("css-inline-tag", `<!doctype html><style>.frame > video { opacity: 1 }</style><main data-composition-id="x"><video class="clip" src="clip.mov"></video></main>`), "HF_PROXY_VIDEO_TAG_SELECTOR");
  expectBlocker(writeFixture("css-external-tag", `<!doctype html><link rel="stylesheet" href="style.css"><main data-composition-id="x"><video class="clip" src="clip.mov"></video></main>`, { css: ":has(> video) { color:red }" }), "HF_PROXY_VIDEO_TAG_SELECTOR");
  expectBlocker(writeFixture("css-scope-tag", `<!doctype html><style>@scope (video) { .clip { opacity:1 } }</style><main data-composition-id="x"><video class="clip" src="clip.mov"></video></main>`), "HF_PROXY_VIDEO_TAG_SELECTOR");
  expectBlocker(writeFixture("css-media-pseudo", `<!doctype html><style>.clip:playing { opacity:1 }</style><main data-composition-id="x"><video class="clip" src="clip.mov"></video></main>`), "HF_PROXY_VIDEO_TAG_SELECTOR");
  expectBlocker(writeFixture("css-escaped-tag", `<!doctype html><style>v\\69 deo { opacity:1 }</style><main data-composition-id="x"><video class="clip" src="clip.mov"></video></main>`), "HF_PROXY_ESCAPED_CSS_SELECTOR");
  expectBlocker(writeFixture("css-body-direct-root", `<!doctype html><style>body > [data-composition-id] { background:red }</style><main data-composition-id="x"><video class="clip" src="clip.mov"></video></main>`), "HF_PROXY_REPARENT_SELECTOR_UNSUPPORTED");
  expectBlocker(writeFixture("css-root-sibling", `<!doctype html><style>#before + [data-composition-id] { background:red }</style><div id="before"></div><main data-composition-id="x"><video class="clip" src="clip.mov"></video></main>`), "HF_PROXY_REPARENT_SELECTOR_UNSUPPORTED");
  expectBlocker(writeFixture("css-import", `<!doctype html><style>@import "other.css";</style><main data-composition-id="x"><video class="clip" src="clip.mov"></video></main>`), "HF_PROXY_CSS_IMPORT_UNAUDITED");
  expectBlocker(writeFixture("js-selector", `<!doctype html><main data-composition-id="x"><video class="clip" src="clip.mov"></video></main><script>document.querySelector("video").play()</script>`), "HF_PROXY_VIDEO_SCRIPT_SELECTOR");
  expectBlocker(writeFixture("js-gsap-selector", `<!doctype html><main data-composition-id="x"><video class="clip" src="clip.mov"></video></main><script>gsap.to("main > video", {opacity:1})</script>`), "HF_PROXY_VIDEO_SCRIPT_SELECTOR");
  expectBlocker(writeFixture("js-gsap-timeline-selector", `<!doctype html><main data-composition-id="x"><video class="clip" src="clip.mov"></video></main><script>const tl=gsap.timeline(); tl.to("video", {opacity:1})</script>`), "HF_PROXY_VIDEO_SCRIPT_SELECTOR");
  expectBlocker(writeFixture("js-gsap-late-timeline-selector", `<!doctype html><main data-composition-id="x"><video class="clip" src="clip.mov"></video></main><script>let tl; tl=gsap.timeline(); tl.to("video", {opacity:1})</script>`), "HF_PROXY_VIDEO_SCRIPT_SELECTOR");
  expectBlocker(writeFixture("js-gsap-utils-selector", `<!doctype html><main data-composition-id="x"><video class="clip" src="clip.mov"></video></main><script>gsap.utils.toArray("video")</script>`), "HF_PROXY_VIDEO_SCRIPT_SELECTOR");
  expectBlocker(writeFixture("js-selector-alias", `<!doctype html><main data-composition-id="x"><video class="clip" src="clip.mov"></video></main><script>const tag="video"; document.querySelector(tag)</script>`), "HF_PROXY_VIDEO_SCRIPT_SELECTOR");
  expectBlocker(writeFixture("js-computed-selector", `<!doctype html><main data-composition-id="x"><video class="clip" src="clip.mov"></video></main><script>document["querySelector"]("video")</script>`), "HF_PROXY_VIDEO_SCRIPT_SELECTOR");
  expectBlocker(writeFixture("js-dynamic-selector", `<!doctype html><main data-composition-id="x"><video class="clip" src="clip.mov"></video></main><script>document.querySelector(makeSelector())</script>`), "HF_PROXY_DYNAMIC_SELECTOR_UNAUDITED");
  expectBlocker(writeFixture("js-template-selector", `<!doctype html><main data-composition-id="x"><video class="clip" src="clip.mov"></video></main><script>document.querySelector(\`${"${tag}"}\`)</script>`), "HF_PROXY_DYNAMIC_SELECTOR_UNAUDITED");
  expectBlocker(writeFixture("js-create", `<!doctype html><main data-composition-id="x"><video class="clip" src="clip.mov"></video></main><script>document.createElement("video")</script>`), "HF_PROXY_VIDEO_SCRIPT_TAG_API");
  expectBlocker(writeFixture("js-type", `<!doctype html><main data-composition-id="x"><video class="clip" src="clip.mov"></video></main><script>value instanceof HTMLVideoElement</script>`), "HF_PROXY_VIDEO_SCRIPT_API");
  expectBlocker(writeFixture("js-id-api", `<!doctype html><main data-composition-id="x"><video id="hero" class="clip" src="clip.mov"></video></main><script>const hero = document.getElementById("hero"); hero.currentTime = 2</script>`), "HF_PROXY_VIDEO_SCRIPT_API");
  expectBlocker(writeFixture("js-id-optional-api", `<!doctype html><main data-composition-id="x"><video id="hero" class="clip" src="clip.mov"></video></main><script>const hero = document.getElementById("hero"); hero?.play()</script>`), "HF_PROXY_VIDEO_SCRIPT_API");
  expectBlocker(writeFixture("js-global-id-api", `<!doctype html><main data-composition-id="x"><video id="hero" class="clip" src="clip.mov"></video></main><script>hero.play()</script>`), "HF_PROXY_VIDEO_SCRIPT_API");
  expectBlocker(writeFixture("js-computed-id-api", `<!doctype html><main data-composition-id="x"><video id="hero" class="clip" src="clip.mov"></video></main><script>hero["play"]()</script>`), "HF_PROXY_VIDEO_SCRIPT_API");
  expectBlocker(writeFixture("js-direct-id-identity", `<!doctype html><main data-composition-id="x"><video id="hero" class="clip" src="clip.mov"></video></main><script>window.kind=document.getElementById("hero").tagName</script>`), "HF_PROXY_VIDEO_SCRIPT_IDENTITY");
  expectBlocker(writeFixture("js-class-api", `<!doctype html><main data-composition-id="x"><video class="clip" src="clip.mov"></video></main><script>const selected = document.querySelector(".clip"); selected.pause()</script>`), "HF_PROXY_VIDEO_SCRIPT_API");
  expectBlocker(writeFixture("js-selected-alias-api", `<!doctype html><main data-composition-id="x"><video class="clip" src="clip.mov"></video></main><script>const selected = document.querySelector(".clip"); const alias=selected; alias.pause()</script>`), "HF_PROXY_VIDEO_SCRIPT_API");
  expectBlocker(writeFixture("js-media-event", `<!doctype html><main data-composition-id="x"><video class="clip" src="clip.mov"></video></main><script>const selected = document.querySelector(".clip"); selected.addEventListener("timeupdate", ready)</script>`), "HF_PROXY_VIDEO_SCRIPT_API");
  expectBlocker(writeFixture("js-media-attribute", `<!doctype html><main data-composition-id="x"><video class="clip" src="clip.mov"></video></main><script>const selected = document.querySelector(".clip"); selected.getAttribute("src")</script>`), "HF_PROXY_VIDEO_SCRIPT_API");
  expectBlocker(writeFixture("js-cssom", `<!doctype html><main data-composition-id="x"><video class="clip" src="clip.mov"></video></main><script>document.styleSheets[0].insertRule("video{opacity:0}")</script>`), "HF_PROXY_DYNAMIC_CODE_UNAUDITED");
  expectBlocker(writeFixture("js-existing-style-text", `<!doctype html><style id="dynamic-style"></style><main data-composition-id="x"><video class="clip" src="clip.mov"></video></main><script>document.getElementById("dynamic-style").textContent="video{opacity:0}"</script>`), "HF_PROXY_DYNAMIC_CODE_UNAUDITED");
  expectBlocker(writeFixture("js-existing-style-alias", `<!doctype html><style id="dynamicStyle"></style><main data-composition-id="x"><video class="clip" src="clip.mov"></video></main><script>const styleNode=document.getElementById("dynamicStyle");const alias=styleNode;alias.textContent="video{opacity:0}"</script>`), "HF_PROXY_DYNAMIC_CODE_UNAUDITED");
  expectBlocker(writeFixture("body-inline-event", `<!doctype html><body onload="document.getElementById('hero').play()"><main data-composition-id="x"><video id="hero" class="clip" src="clip.mov"></video></main></body>`), "HF_PROXY_INLINE_HANDLER_UNAUDITED");
  expectBlocker(writeFixture("js-remote", `<!doctype html><main data-composition-id="x"><video class="clip" src="clip.mov"></video></main><script src="https://example.invalid/page.js"></script>`), "HF_PROXY_NONLOCAL_REFERENCE");
  expectBlocker(writeFixture("js-module", `<!doctype html><main data-composition-id="x"><video class="clip" src="clip.mov"></video></main><script type="module">window.x = 1</script>`), "HF_PROXY_MODULE_SCRIPT_UNAUDITED");
  expectBlocker(writeFixture("mixed-source", `<!doctype html><main data-composition-id="x"><video class="clip" src="clip.mov"><source src="clip.mov"></video></main>`), "HF_PROXY_AMBIGUOUS_VIDEO_SOURCE");
  expectBlocker(writeFixture("missing-source", `<!doctype html><main data-composition-id="x"><video class="clip"></video></main>`), "HF_PROXY_AMBIGUOUS_VIDEO_SOURCE");
  expectBlocker(writeFixture("conditional-source", `<!doctype html><main data-composition-id="x"><video class="clip"><source src="clip.mov" media="(min-width: 1px)"></video></main>`), "HF_PROXY_CONDITIONAL_VIDEO_SOURCE");
  expectBlocker(writeFixture("missing-file", `<!doctype html><main data-composition-id="x"><video class="clip" src="missing.mov"></video></main>`, { media: false }), "HF_PROXY_MISSING_REFERENCE");
  expectBlocker(writeFixture("base-url", `<!doctype html><base href="./"><main data-composition-id="x"><video class="clip" src="clip.mov"></video></main>`), "HF_PROXY_BASE_URL_UNSUPPORTED");
  expectBlocker(writeFixture("nested-video", `<!doctype html><main data-composition-id="x"><section><video class="clip" src="clip.mov"></video></section></main>`), "HF_PROXY_VIDEO_DOM_UNSUPPORTED");
  expectBlocker(writeFixture("not-clip", `<!doctype html><main data-composition-id="x"><video src="clip.mov"></video></main>`), "HF_PROXY_VIDEO_DOM_UNSUPPORTED");
  expectBlocker(writeFixture("inline-event", `<!doctype html><main data-composition-id="x"><video class="clip" src="clip.mov" onloadeddata="ready()"></video></main>`), "HF_PROXY_INLINE_HANDLER_UNAUDITED");
  expectBlocker(writeFixture("native-controls", `<!doctype html><main data-composition-id="x"><video class="clip" src="clip.mov" controls></video></main>`), "HF_PROXY_VIDEO_CONTROLS_UNSUPPORTED");

  console.log("proxy_tree_transformer: ok");
} finally {
  rmSync(fixtureRoot, { recursive: true, force: true });
}
