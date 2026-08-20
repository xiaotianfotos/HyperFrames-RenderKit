import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { performance } from "node:perf_hooks";

const args = Object.fromEntries(process.argv.slice(2).filter((arg) => arg.startsWith("--")).map((arg) => {
  const split = arg.indexOf("=");
  return split === -1 ? [arg.slice(2), "true"] : [arg.slice(2, split), arg.slice(split + 1)];
}));
const rootPid = Number(args.pid);
const output = args.output;
const intervalMs = Number(args.interval ?? 100);

if (!Number.isInteger(rootPid) || rootPid <= 1 || !output) {
  throw new Error("Usage: node monitor_process_tree.mjs --pid=PID --output=file.json [--interval=100]");
}
if (!Number.isFinite(intervalMs) || intervalMs < 25) throw new Error(`Invalid interval: ${intervalMs}`);

const startedAt = performance.now();
const startedAtIso = new Date().toISOString();
let samples = 0;
let peakTreeRssKiB = 0;
let peakProcessCount = 0;
let lastTreeRssKiB = 0;
let lastProcessCount = 0;
let rootSeen = false;

function records() {
  const result = [];
  for (const entry of readdirSync("/proc")) {
    if (!/^\d+$/.test(entry)) continue;
    try {
      const status = readFileSync(`/proc/${entry}/status`, "utf8");
      result.push({
        pid: Number(entry),
        parent: Number(status.match(/^PPid:\s+(\d+)/m)?.[1] ?? -1),
        rssKiB: Number(status.match(/^VmRSS:\s+(\d+)\s+kB/m)?.[1] ?? 0),
      });
    } catch {
      // A process may exit between listing /proc and reading its status.
    }
  }
  return result;
}

function snapshot(final = false) {
  const processRecords = records();
  if (processRecords.some((record) => record.pid === rootPid)) rootSeen = true;
  const descendants = new Set([rootPid]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const record of processRecords) {
      if (!descendants.has(record.pid) && descendants.has(record.parent)) {
        descendants.add(record.pid);
        changed = true;
      }
    }
  }
  const live = processRecords.filter((record) => descendants.has(record.pid));
  lastTreeRssKiB = live.reduce((sum, record) => sum + record.rssKiB, 0);
  lastProcessCount = live.length;
  peakTreeRssKiB = Math.max(peakTreeRssKiB, lastTreeRssKiB);
  peakProcessCount = Math.max(peakProcessCount, lastProcessCount);
  samples += 1;

  const metrics = {
    rootPid,
    intervalMs,
    startedAt: startedAtIso,
    elapsedMs: performance.now() - startedAt,
    samples,
    rootSeen,
    running: !final && live.length > 0,
    lastTreeRssKiB,
    lastProcessCount,
    peakTreeRssKiB,
    peakProcessCount,
    updatedAt: new Date().toISOString(),
  };
  writeFileSync(output, `${JSON.stringify(metrics, null, 2)}\n`);
  return live.length > 0;
}

if (!snapshot()) process.exit(1);
const timer = setInterval(() => {
  const running = snapshot();
  if (running) return;
  clearInterval(timer);
  snapshot(true);
}, intervalMs);
