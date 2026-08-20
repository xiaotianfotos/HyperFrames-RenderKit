#!/usr/bin/env node

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import {
  compileSegmentExecutionPlan,
  evaluateMovStreamCopyConcat,
} from "./lib.mjs";
import { verifyWholeProjectIdentityManifest } from "../frame_backend_preflight/project_identity.mjs";
import {
  compileUniformScreenshotExecutionPlan,
  issueProjectScopeMediaPolicyProof,
  recomputeUniformScreenshotProjectEvidence,
} from "./uniform_screenshot.mjs";
import { buildExecutionInputs } from "./execution_inputs.mjs";
import { normalizeRenderContext } from "./executor_lib.mjs";

function parseArgs(argv) {
  const [command, ...rest] = argv;
  const options = {};
  for (const token of rest) {
    if (!token.startsWith("--") || !token.includes("=")) throw new Error(`invalid option ${token}`);
    const [key, ...parts] = token.slice(2).split("=");
    options[key] = parts.join("=");
  }
  return { command, options };
}

function required(options, name) {
  if (!options[name]) throw new Error(`--${name}=... is required`);
  return resolve(options[name]);
}

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

function writeJson(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

const { command, options } = parseArgs(process.argv.slice(2));
if (command === "compile") {
  const output = required(options, "output");
  const context = normalizeRenderContext(readJson(required(options, "context")));
  const manifest = readJson(required(options, "project-manifest"));
  const projectManifestVerification = await verifyWholeProjectIdentityManifest({
    manifest,
    projectRoot: context.projectRoot,
  });
  const executionInputs = await buildExecutionInputs({
    renderContext: context,
    projectManifest: manifest,
    projectManifestVerification,
  });
  const plan = compileSegmentExecutionPlan({
    preflightPlan: readJson(required(options, "preflight")),
    expected: readJson(required(options, "expected")),
    executionInputs,
    ...(options.contract ? { outputContract: readJson(resolve(options.contract)) } : {}),
  });
  writeJson(output, plan);
  console.log(JSON.stringify({ output, mode: plan.executionMode, segments: plan.segments.length }));
} else if (command === "check-concat") {
  const output = required(options, "output");
  const decision = evaluateMovStreamCopyConcat({
    executionPlan: readJson(required(options, "plan")),
    observedSegments: readJson(required(options, "observed")),
    mismatchPolicy: options["mismatch-policy"] ?? "hard-fail",
  });
  writeJson(output, decision);
  console.log(JSON.stringify({ output, action: decision.action, executable: decision.executable }));
  if (decision.action === "hard-fail") process.exitCode = 2;
} else if (command === "issue-project-scope-proof") {
  const output = required(options, "output");
  const manifest = readJson(required(options, "project-manifest"));
  const projectRoot = required(options, "project-root");
  const entryPath = required(options, "entry");
  const projectManifestVerification = await verifyWholeProjectIdentityManifest({ manifest, projectRoot });
  const currentEvidence = recomputeUniformScreenshotProjectEvidence({ projectRoot, entryPath });
  const proof = issueProjectScopeMediaPolicyProof({
    projectManifestVerification,
    currentEvidence,
    seedPreflightPlan: options["seed-preflight"] ? readJson(resolve(options["seed-preflight"])) : null,
    projectRoot,
  });
  writeJson(output, proof);
  console.log(JSON.stringify({ output, selectedPolicy: proof.selectedPolicy, reasons: proof.reasons }));
} else if (command === "compile-uniform-screenshot") {
  const output = required(options, "output");
  const manifest = readJson(required(options, "project-manifest"));
  const projectRoot = required(options, "project-root");
  const entryPath = required(options, "entry");
  const projectManifestVerification = await verifyWholeProjectIdentityManifest({ manifest, projectRoot });
  const currentEvidence = recomputeUniformScreenshotProjectEvidence({ projectRoot, entryPath });
  let executionInputs = null;
  let executionInputsError = null;
  try {
    const context = normalizeRenderContext(readJson(required(options, "context")));
    executionInputs = await buildExecutionInputs({
      renderContext: context,
      projectManifest: manifest,
      projectManifestVerification,
    });
  } catch (error) {
    executionInputsError = `execution-inputs-build-failed:${error.message}`;
  }
  const plan = compileUniformScreenshotExecutionPlan({
    target: readJson(required(options, "target")),
    projectManifestVerification,
    currentEvidence,
    projectScopeProof: options["project-scope-proof"] ? readJson(resolve(options["project-scope-proof"])) : null,
    executionInputs,
    executionInputsError,
    ...(options.contract ? { outputContract: readJson(resolve(options.contract)) } : {}),
  });
  writeJson(output, plan);
  console.log(JSON.stringify({ output, mode: plan.executionMode, policy: plan.screenshotMediaPolicy, frames: plan.timeline.frameCount }));
} else {
  throw new Error("usage: cli.mjs compile|compile-uniform-screenshot|issue-project-scope-proof|check-concat --...=...");
}
