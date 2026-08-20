import { spawn } from "node:child_process";
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { performance } from "node:perf_hooks";

const separator = process.argv.indexOf("--");
const outputArg = process.argv.find((arg) => arg.startsWith("--output="));
if (!outputArg || separator < 0 || separator === process.argv.length - 1) {
  throw new Error("Usage: node run_with_tree_memory.mjs --output=file.json -- command [args...]");
}

const output = outputArg.slice("--output=".length);
const [command, ...commandArgs] = process.argv.slice(separator + 1);
const startedAt = performance.now();
const child = spawn(command, commandArgs, { stdio: "inherit" });

let peakTreeRssKiB = 0;
let peakProcessCount = 0;
let samples = 0;

function sampleProcessTree() {
  if (!child.pid) return;
  const records = [];
  for (const entry of readdirSync("/proc")) {
    if (!/^\d+$/.test(entry)) continue;
    try {
      const status = readFileSync(`/proc/${entry}/status`, "utf8");
      const parent = Number(status.match(/^PPid:\s+(\d+)/m)?.[1] ?? -1);
      const rssKiB = Number(status.match(/^VmRSS:\s+(\d+)\s+kB/m)?.[1] ?? 0);
      records.push({ pid: Number(entry), parent, rssKiB });
    } catch {
      // The process may exit between listing /proc and reading its status.
    }
  }

  const descendants = new Set([child.pid]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const record of records) {
      if (!descendants.has(record.pid) && descendants.has(record.parent)) {
        descendants.add(record.pid);
        changed = true;
      }
    }
  }

  const treeRssKiB = records
    .filter((record) => descendants.has(record.pid))
    .reduce((total, record) => total + record.rssKiB, 0);
  peakTreeRssKiB = Math.max(peakTreeRssKiB, treeRssKiB);
  peakProcessCount = Math.max(peakProcessCount, descendants.size);
  samples += 1;
}

const timer = setInterval(sampleProcessTree, 25);
sampleProcessTree();

child.once("error", (error) => {
  clearInterval(timer);
  throw error;
});

child.once("close", (code, signal) => {
  sampleProcessTree();
  clearInterval(timer);
  const metrics = {
    command,
    commandArgs,
    elapsedMs: performance.now() - startedAt,
    exitCode: code,
    signal,
    peakTreeRssKiB,
    peakProcessCount,
    samples,
  };
  writeFileSync(output, `${JSON.stringify(metrics, null, 2)}\n`);
  process.exitCode = code ?? 1;
});
