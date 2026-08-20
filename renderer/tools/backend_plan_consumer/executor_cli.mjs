#!/usr/bin/env node

import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { executeSegmentPlan } from "./executor_lib.mjs";

function parseArgs(argv) {
  const result = {};
  for (const token of argv) {
    if (!token.startsWith("--") || !token.includes("=")) throw new Error(`invalid argument ${token}`);
    const [key, ...value] = token.slice(2).split("=");
    result[key] = value.join("=");
  }
  return result;
}

function required(args, key) {
  if (!args[key]) throw new Error(`--${key}=... is required`);
  return resolve(args[key]);
}

function boolean(value) {
  if (value == null) return false;
  if (["true", "1", "yes"].includes(String(value).toLowerCase())) return true;
  if (["false", "0", "no"].includes(String(value).toLowerCase())) return false;
  throw new Error(`invalid boolean ${value}`);
}

const args = parseArgs(process.argv.slice(2));
const reportPath = args.report ? resolve(args.report) : null;
const result = await executeSegmentPlan({
  executionPlan: JSON.parse(readFileSync(required(args, "plan"), "utf8")),
  renderContext: JSON.parse(readFileSync(required(args, "context"), "utf8")),
  runRoot: required(args, "run-root"),
  finalOutput: required(args, "output"),
  dryRun: boolean(args["dry-run"]),
  mismatchPolicy: args["mismatch-policy"] ?? "hard-fail",
});
if (reportPath) writeFileSync(reportPath, `${JSON.stringify(result, null, 2)}\n`, { flag: "wx" });
console.log(JSON.stringify(result, null, 2));
