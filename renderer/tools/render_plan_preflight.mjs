#!/usr/bin/env node

import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { buildRenderPlan, resolveSafeOutputPath, validateRenderPlanShape } from "./render_plan_preflight_lib.mjs";

function usage() {
  return `Usage:
  node tools/render_plan_preflight.mjs --project-root=<dir> [--entry=index.html] [--fps=60]
       [--output=.render-cache/render-plan.json] [--compact] [--fail-without-safe-backend]

The command performs a conservative static preflight. A "conditional" backend is not safe to
auto-select; its listed runtime probes must pass first. Local inputs and output must stay inside
the real project root (including through symlinks).`;
}

function parseArgs(argv) {
  const result = {
    projectRoot: null,
    entry: "index.html",
    fps: 60,
    output: null,
    pretty: true,
    failWithoutSafeBackend: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--help" || arg === "-h") return { help: true };
    if (arg === "--compact") {
      result.pretty = false;
      continue;
    }
    if (arg === "--fail-without-safe-backend") {
      result.failWithoutSafeBackend = true;
      continue;
    }
    const match = arg.match(/^--([^=]+)(?:=(.*))?$/);
    if (!match) throw new Error(`Unknown positional argument: ${arg}`);
    const key = match[1];
    let value = match[2];
    if (value == null) {
      value = argv[index + 1];
      if (value == null || value.startsWith("--")) throw new Error(`Missing value for --${key}`);
      index += 1;
    }
    if (key === "project-root" || key === "projectRoot") result.projectRoot = value;
    else if (key === "entry") result.entry = value;
    else if (key === "fps") result.fps = Number(value);
    else if (key === "output") result.output = value;
    else throw new Error(`Unknown option: --${key}`);
  }
  if (!result.projectRoot) throw new Error("--project-root is required");
  return result;
}

async function main() {
  let options;
  try {
    options = parseArgs(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`${error.message}\n\n${usage()}\n`);
    process.exitCode = 64;
    return;
  }
  if (options.help) {
    process.stdout.write(`${usage()}\n`);
    return;
  }

  const plan = await buildRenderPlan(options);
  const validation = validateRenderPlanShape(plan);
  if (!validation.ok) throw new Error(`Internal RenderPlan shape error: ${validation.errors.join("; ")}`);
  const json = `${JSON.stringify(plan, null, options.pretty ? 2 : 0)}\n`;
  if (options.output) {
    const output = await resolveSafeOutputPath(options.projectRoot, options.output);
    await fs.mkdir(path.dirname(output), { recursive: true });
    const temporary = `${output}.tmp-${process.pid}`;
    await fs.writeFile(temporary, json, { flag: "wx" });
    await fs.rename(temporary, output);
    process.stderr.write(`RenderPlan written to ${output}\n`);
  } else {
    process.stdout.write(json);
  }

  if (options.failWithoutSafeBackend) {
    const safe = Object.values(plan.backendEligibility).some((backend) => backend.autoSelectable);
    if (!safe) process.exitCode = 2;
  }
}

main().catch((error) => {
  process.stderr.write(`${error?.stack ?? error}\n`);
  process.exitCode = 1;
});
