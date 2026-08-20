#!/usr/bin/env node

import assert from "node:assert/strict";
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  discoverConfig,
  inspectProject,
  parseHyperframesJson,
} from "./agent_cli.mjs";

const wrapped = `browser probe {not-json}\n${JSON.stringify({ ok: true, lint: { findings: [] } })}\nlate stderr {also-not-json}`;
assert.equal(parseHyperframesJson(wrapped)?.ok, true);

const root = mkdtempSync(join(tmpdir(), "hf-agent-cli-"));
mkdirSync(join(root, "compositions"));
writeFileSync(join(root, "index.html"), `<!doctype html>
<style>.hero { filter: blur(8px); }</style>
<div class="hero">demo</div>
`);
writeFileSync(join(root, "package.json"), `${JSON.stringify({ scripts: { check: "hyperframes check" } }, null, 2)}\n`);
writeFileSync(join(root, "render-config.final-4k60.json"), "{}\n");
assert.equal(discoverConfig(root), join(root, "render-config.final-4k60.json"));

const fakeCheck = {
  ok: false,
  lint: {
    findings: [{
      code: "missing_timeline",
      severity: "error",
      message: "Timeline is missing",
      fixHint: "Register a paused timeline.",
      sourceFile: join(root, "index.html"),
      selector: ".hero",
    }],
  },
  runtime: { findings: [] },
  layout: {
    findings: [{
      code: "container_overflow",
      severity: "info",
      message: "Element overflows",
      fixHint: "Fix the offset-parent coordinates.",
      sourceFile: "index.html",
      selector: ".hero",
      time: 1.25,
      rect: { left: -20, top: 0, width: 100, height: 100 },
      overflow: { left: 20 },
    }],
  },
  motion: { findings: [] },
  contrast: { findings: [] },
};
const reportDirectory = join(root, "reports");
const report = await inspectProject({
  command: "check",
  projectRoot: root,
  configPath: join(root, "missing-config.json"),
  reportDirectory,
  hyperframesRunner: async () => ({
    code: 1,
    signal: null,
    stdout: `probe\n${JSON.stringify(fakeCheck)}\n`,
    stderr: "late diagnostic {not-json}",
  }),
});

assert.equal(report.status, "blocked");
assert.ok(report.issues.some((issue) => issue.code === "HF-CONFIG-NOT-FOUND"));
assert.ok(report.issues.some((issue) => issue.code === "HF-COMPAT-CSS-FILTER-COMPOSITING"));
assert.ok(report.issues.some((issue) => issue.code === "HF-HYPERFRAMES-MISSING-TIMELINE"));
assert.ok(report.issues.some((issue) => issue.code === "HF-LAYOUT-CONTAINER-OVERFLOW"));
for (const issue of report.issues) {
  assert.ok(issue.id.startsWith(`${issue.code}:`));
  assert.ok(issue.agent.goal.length > 0);
  assert.ok(issue.agent.steps.length > 0);
  assert.ok(issue.agent.constraints.length > 0);
  assert.ok(issue.agent.verify.length > 0);
}
assert.ok(existsSync(join(reportDirectory, "latest.json")));
assert.ok(existsSync(join(reportDirectory, "latest.md")));

console.log("agent_cli tests passed");
