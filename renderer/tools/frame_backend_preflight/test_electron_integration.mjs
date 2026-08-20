#!/usr/bin/env node

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { cp, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  buildScreenshotAuditEvidence,
  rendererRoot,
  sha256,
  verifyExecutionProof,
} from "./lib.mjs";
import { transformScreenshotHtml } from "../screenshot_entry_transformer.mjs";

const moduleRoot = dirname(fileURLToPath(import.meta.url));
const electron = resolve(process.env.ELECTRON_BINARY ?? resolve(rendererRoot, "node_modules/.bin/electron"));

function run(command, args, { timeoutMs = 90_000 } = {}) {
  return new Promise((resolveRun, rejectRun) => {
    const env = { ...process.env };
    delete env.ELECTRON_RUN_AS_NODE;
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"], env });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    const timeout = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
      setTimeout(() => child.kill("SIGKILL"), 2_000).unref();
    }, timeoutMs);
    child.once("error", rejectRun);
    child.once("close", (code, signal) => {
      clearTimeout(timeout);
      resolveRun({ code, signal, stdout, stderr, timedOut });
    });
  });
}

async function invoke(projectRoot, outputName, extra = []) {
  const output = resolve(projectRoot, outputName);
  const result = await run(electron, [
    "--no-sandbox",
    moduleRoot,
    `--project-root=${projectRoot}`,
    "--entry=index.html",
    "--width=320",
    "--height=180",
    "--fps=60",
    "--frames=4",
    "--checkpoint-every=4",
    "--max-golden-frames=64",
    `--output=${outputName}`,
    ...extra,
  ]);
  const plan = JSON.parse(await readFile(output, "utf8"));
  return { run: result, plan };
}

function verifyPlanProof(plan, projectRoot) {
  const entryPath = resolve(projectRoot, "index.html");
  const report = transformScreenshotHtml({ entryPath, projectRoot }).report;
  const audit = buildScreenshotAuditEvidence({
    report,
    projectRoot,
    entrySha256: sha256(readFileSync(entryPath)),
  });
  return verifyExecutionProof(plan, {
    projectIdentity: plan.projectIdentity,
    renderPlanIdentity: plan.renderPlanIdentity,
    machineProfileIdentity: plan.machineProfileIdentity,
    styleOverrideProfileHash: plan.styleOverrideProfileHash,
    auditSignature: audit.auditSignature,
  });
}

const temporaryRoot = await mkdtemp(resolve(tmpdir(), "hf-backend-preflight-"));
try {
  const safeRoot = resolve(temporaryRoot, "safe");
  await cp(resolve(moduleRoot, "fixtures/safe"), safeRoot, { recursive: true });
  const good = await invoke(safeRoot, "good.json", [
    "--candidate-entry=candidate.html",
    "--project-identity=sha256:1111111111111111111111111111111111111111111111111111111111111111",
    "--gate-profile-hash=sha256:2222222222222222222222222222222222222222222222222222222222222222",
  ]);
  assert.equal(good.run.timedOut, false, good.run.stderr);
  assert.equal(good.run.code, 0, `${good.run.stdout}\n${good.run.stderr}`);
  assert.equal(good.plan.executable, true);
  assert.equal(good.plan.validationState, "passed");
  assert.ok((good.plan.summary.framesByBackend["proxy-tree"] ?? 0) > 0);
  assert.equal(good.plan.preflight.staticGate.passed, true);
  assert.ok(good.plan.preflight.validationEvidence.comparisons.every((item) => item.passed));
  const goodProof = verifyPlanProof(good.plan, safeRoot);
  assert.equal(goodProof.valid, true);
  assert.equal(goodProof.screenshotMediaPolicy, "bounded-static");
  assert.match(good.plan.proof.proofSignature, /^sha256:[a-f0-9]{64}$/);
  assert.equal(verifyExecutionProof(good.plan, {
    projectIdentity: good.plan.projectIdentity,
    renderPlanIdentity: good.plan.renderPlanIdentity,
    machineProfileIdentity: good.plan.machineProfileIdentity,
    styleOverrideProfileHash: good.plan.styleOverrideProfileHash,
    auditSignature: "sha256:wrong-audit",
  }).valid, false);

  const bad = await invoke(safeRoot, "bad.json", [
    "--candidate-entry=candidate-bad.html",
    "--project-identity=sha256:1111111111111111111111111111111111111111111111111111111111111111",
    "--gate-profile-hash=sha256:2222222222222222222222222222222222222222222222222222222222222222",
  ]);
  assert.equal(bad.run.code, 0, `${bad.run.stdout}\n${bad.run.stderr}`);
  assert.equal(bad.plan.executable, true);
  assert.equal(bad.plan.summary.framesByBackend["proxy-tree"] ?? 0, 0);
  assert.equal(bad.plan.summary.framesByBackend.screenshot, 4);
  assert.ok(bad.plan.preflight.validationEvidence.comparisons.some((item) => !item.passed));

  const dynamicRoot = resolve(temporaryRoot, "dynamic-selector");
  await cp(resolve(moduleRoot, "fixtures/dynamic-selector"), dynamicRoot, { recursive: true });
  const dynamic = await invoke(dynamicRoot, "dynamic.json");
  assert.equal(dynamic.run.code, 0, `${dynamic.run.stdout}\n${dynamic.run.stderr}`);
  assert.equal(dynamic.plan.executable, true);
  assert.equal(dynamic.plan.summary.blockerFrames, 0);
  assert.equal(dynamic.plan.ranges.length, 1);
  assert.equal(dynamic.plan.ranges[0].backend, "screenshot");
  assert.equal(dynamic.plan.preflight.oracleOnlyReason, "HF_PROXY_DYNAMIC_SELECTOR_UNAUDITED");
  assert.equal(dynamic.plan.ranges[0].rejectedBackends[0].detail, "HF_PROXY_DYNAMIC_SELECTOR_UNAUDITED");
  const dynamicProof = verifyPlanProof(dynamic.plan, dynamicRoot);
  assert.equal(dynamicProof.valid, true);
  assert.equal(dynamicProof.screenshotMediaPolicy, "faithful");
  console.log("frame backend preflight Electron integration tests passed");
} finally {
  await rm(temporaryRoot, { recursive: true, force: true });
}
