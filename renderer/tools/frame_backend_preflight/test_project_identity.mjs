import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import {
  buildWholeProjectIdentityManifest,
  verifyWholeProjectIdentityManifest,
} from "./project_identity.mjs";

const scratch = mkdtempSync(resolve(tmpdir(), "hf-project-identity-"));
try {
  const makeProject = (root) => {
    mkdirSync(resolve(root, "shared/fonts"), { recursive: true });
    mkdirSync(resolve(root, ".media/video"), { recursive: true });
    mkdirSync(resolve(root, ".render-cache/media-timing"), { recursive: true });
    writeFileSync(resolve(root, "index.html"), '<link rel="stylesheet" href="shared/master.css"><script src="shared/master.js"></script><video src=".media/video/a.mp4"></video>');
    writeFileSync(resolve(root, "shared/master.css"), '@font-face{src:url("fonts/font.woff2")}');
    writeFileSync(resolve(root, "shared/master.js"), "window.ready = true;\n");
    writeFileSync(resolve(root, "shared/fonts/font.woff2"), "font-bytes");
    writeFileSync(resolve(root, ".media/manifest.jsonl"), '{"id":"a","path":".media/video/a.mp4"}\n');
    writeFileSync(resolve(root, ".media/video/a.mp4"), "video-bytes");
    writeFileSync(resolve(root, ".render-cache/media-timing/bundle.json"), '{"timing":1}\n');
    writeFileSync(resolve(root, "shared/.DS_Store"), "ignored");
  };
  const firstRoot = resolve(scratch, "first");
  const secondRoot = resolve(scratch, "second");
  makeProject(firstRoot);
  makeProject(secondRoot);
  const options = { entry: "index.html", include: [".render-cache/media-timing/bundle.json"] };
  const first = await buildWholeProjectIdentityManifest({ projectRoot: firstRoot, ...options });
  const second = await buildWholeProjectIdentityManifest({ projectRoot: secondRoot, ...options });
  assert.equal(first.projectIdentity, second.projectIdentity);
  assert.deepEqual(first.files.map((file) => file.path), [
    ".media/manifest.jsonl",
    ".media/video/a.mp4",
    ".render-cache/media-timing/bundle.json",
    "index.html",
    "shared/fonts/font.woff2",
    "shared/master.css",
    "shared/master.js",
  ]);
  const verified = await verifyWholeProjectIdentityManifest({ manifest: first, projectRoot: firstRoot });
  assert.equal(verified.valid, true);
  assert.equal(verified.fileCount, 7);

  writeFileSync(resolve(firstRoot, ".media/video/a.mp4"), "tampered-video");
  const tampered = await verifyWholeProjectIdentityManifest({ manifest: first, projectRoot: firstRoot });
  assert.equal(tampered.valid, false);
  assert.match(tampered.reason, /file-(?:size|digest)-mismatch/);

  const symlinkRoot = resolve(scratch, "symlink");
  makeProject(symlinkRoot);
  rmSync(resolve(symlinkRoot, "shared/master.js"));
  symlinkSync(resolve(secondRoot, "shared/master.js"), resolve(symlinkRoot, "shared/master.js"));
  await assert.rejects(
    buildWholeProjectIdentityManifest({ projectRoot: symlinkRoot, ...options }),
    /may not be a symlink/,
  );
  console.log("whole-project identity tests passed");
} finally {
  rmSync(scratch, { recursive: true, force: true });
}
