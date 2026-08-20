#!/usr/bin/env node

import { spawn } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
import { mkdir, readFile } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { rendererRoot } from "./lib.mjs";

const moduleRoot = dirname(fileURLToPath(import.meta.url));

function usage() {
  return `Usage:
  node tools/frame_backend_preflight/cli.mjs \\
    --project-root=/absolute/project --entry=index.html --fps=60 \\
    [--frames=3600] [--candidate-entry=.render-cache/proxy-preview.html] \\
    [--project-identity=sha256:...] [--gate-profile-hash=sha256:...] \\
    [--output=.render-cache/frame-backend-plan.json]

Production is fail-closed. Without a strong caller-supplied project identity and a declared
candidate preview contract, the command still emits an executable all-screenshot plan. A fast
proxy-tree range is emitted only after two deterministic inventory passes and screenshot-oracle
golden-frame comparison on this exact machine.`;
}

function option(argv, names) {
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    for (const name of names) {
      if (argument === `--${name}`) return argv[index + 1] ?? null;
      if (argument.startsWith(`--${name}=`)) return argument.slice(name.length + 3);
    }
  }
  return null;
}

function run(command, args, env) {
  return new Promise((resolveRun, rejectRun) => {
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"], env });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
      process.stderr.write(chunk);
    });
    child.once("error", rejectRun);
    child.once("close", (code, signal) => resolveRun({ code, signal, stdout, stderr }));
  });
}

const argv = process.argv.slice(2);
if (argv.includes("--help") || argv.includes("-h")) {
  process.stdout.write(`${usage()}\n`);
  process.exit(0);
}
const projectRootRaw = option(argv, ["project-root", "projectRoot"]);
if (!projectRootRaw) {
  process.stderr.write(`--project-root is required\n\n${usage()}\n`);
  process.exit(64);
}
const projectRoot = realpathSync(resolve(projectRootRaw));
const resultsRootRaw = option(argv, ["results-root", "resultsRoot"]);
const resultsRootCandidate = resolve(resultsRootRaw ?? projectRoot);
await mkdir(resultsRootCandidate, { recursive: true });
const resultsRoot = realpathSync(resultsRootCandidate);
const electron = resolve(
  option(argv, ["electron"])
  ?? process.env.ELECTRON_BINARY
  ?? resolve(rendererRoot, "node_modules/.bin/electron"),
);
if (!existsSync(electron)) throw new Error(`Electron binary does not exist: ${electron}`);
const requestedOutput = option(argv, ["output"]);
const output = resolve(resultsRoot, requestedOutput ?? "frame-backend-plan.json");
const outputRelative = relative(resultsRoot, output);
if (outputRelative.startsWith("..") || isAbsolute(outputRelative)) throw new Error("output must remain inside results root");
await mkdir(dirname(output), { recursive: true });

const forwarded = argv.filter((argument, index) => {
  if (argument === "--electron") return false;
  if (index > 0 && argv[index - 1] === "--electron") return false;
  return !argument.startsWith("--electron=");
});
if (!requestedOutput) forwarded.push(`--output=${outputRelative}`);
const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;
const platformArgs = process.platform === "linux"
  && Boolean(env.WAYLAND_DISPLAY)
  && !env.DISPLAY
  ? ["--ozone-platform=wayland", "--disable-vulkan"]
  : [];
const runResult = await run(electron, [
  "--no-sandbox",
  ...platformArgs,
  moduleRoot,
  ...forwarded,
], env);

let result;
try {
  result = JSON.parse(await readFile(output, "utf8"));
} catch (error) {
  process.stderr.write(`Preflight did not produce readable JSON: ${error.message}\n${runResult.stdout}\n`);
  process.exit(runResult.code ?? 1);
}
process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
if (runResult.code === 1) process.exit(1);
process.exit(result.executable === true ? 0 : 2);
