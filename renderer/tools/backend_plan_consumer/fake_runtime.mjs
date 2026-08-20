#!/usr/bin/env node

import { createHash } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

const args = Object.fromEntries(process.argv.slice(3).filter((item) => item.startsWith("--")).map((item) => {
  const split = item.indexOf("=");
  return [item.slice(2, split), item.slice(split + 1)];
}));
if (String(process.env.FAKE_FAIL_START_FRAME ?? "") === args.startFrame) process.exit(23);
if (process.env.FAKE_VERIFY_SNAPSHOT_TIMING === "1") {
  const timing = JSON.parse(readFileSync(args.mediaTimingPlan, "utf8"));
  if (!timing.relativeSource || !existsSync(resolve(args.projectRoot, timing.relativeSource))) process.exit(24);
}
if (process.env.FAKE_TRY_WRITE_ENTRY === "1") {
  try {
    appendFileSync(args.entry, "tamper");
    process.exit(25);
  } catch (error) {
    if (!new Set(["EACCES", "EPERM", "EROFS"]).has(error?.code)) throw error;
  }
}
mkdirSync(dirname(args.output), { recursive: true });
writeFileSync(args.output, `fake mov ${args.startFrame} ${args.frames}\n`);
const mismatch = String(process.env.FAKE_COLOR_MISMATCH_START_FRAME ?? "") === args.startFrame;
writeFileSync(`${args.output}.fake-probe.json`, `${JSON.stringify({
  frames: Number(args.frames),
  colorTransfer: mismatch ? "smpte2084" : "bt709",
})}\n`);
writeFileSync(`${args.output}.metrics.json`, `${JSON.stringify({
  runId: `fake-${args.startFrame}`,
  failure: null,
  renderIdentity: {
    entry: createHash("sha256").update(readFileSync(args.entry)).digest("hex"),
    timingBundle: createHash("sha256").update(readFileSync(args.mediaTimingPlan)).digest("hex"),
    assets: null,
  },
  config: {
    frames: Number(args.frames),
    startFrame: Number(args.startFrame),
    projectRoot: args.projectRoot,
    entry: args.entry,
    mediaTimingPlanPath: args.mediaTimingPlan,
  },
  outputCommit: { committed: true },
})}\n`);
