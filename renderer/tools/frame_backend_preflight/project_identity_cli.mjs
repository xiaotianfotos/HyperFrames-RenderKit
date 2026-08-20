#!/usr/bin/env node

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import {
  buildWholeProjectIdentityManifest,
  verifyWholeProjectIdentityManifest,
} from "./project_identity.mjs";

function values(argv, name) {
  const result = [];
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === `--${name}`) result.push(argv[index + 1]);
    else if (argv[index].startsWith(`--${name}=`)) result.push(argv[index].slice(name.length + 3));
  }
  return result.filter((value) => value != null);
}

function value(argv, name, fallback = null) {
  return values(argv, name).at(-1) ?? fallback;
}

const argv = process.argv.slice(2);
const mode = argv[0] && !argv[0].startsWith("--") ? argv.shift() : "build";
const projectRoot = value(argv, "project-root");
if (!projectRoot) throw new Error("--project-root is required");

if (mode === "build") {
  const output = value(argv, "output");
  if (!output) throw new Error("--output is required");
  const manifest = await buildWholeProjectIdentityManifest({
    projectRoot,
    entry: value(argv, "entry", "index.html"),
    include: values(argv, "include"),
  });
  const outputPath = resolve(output);
  mkdirSync(dirname(outputPath), { recursive: true });
  writeFileSync(outputPath, `${JSON.stringify(manifest, null, 2)}\n`, { flag: "wx" });
  process.stdout.write(`${JSON.stringify({ output: outputPath, projectIdentity: manifest.projectIdentity, fileCount: manifest.files.length, totalBytes: manifest.files.reduce((sum, file) => sum + file.sizeBytes, 0) })}\n`);
} else if (mode === "verify") {
  const manifestPath = value(argv, "manifest");
  if (!manifestPath) throw new Error("--manifest is required");
  const result = await verifyWholeProjectIdentityManifest({
    manifest: JSON.parse(readFileSync(resolve(manifestPath), "utf8")),
    projectRoot,
  });
  process.stdout.write(`${JSON.stringify(result)}\n`);
  if (!result.valid) process.exitCode = 2;
} else {
  throw new Error(`unknown mode: ${mode}`);
}
