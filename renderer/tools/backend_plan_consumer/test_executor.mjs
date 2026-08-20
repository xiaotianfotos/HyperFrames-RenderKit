#!/usr/bin/env node

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, copyFileSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { sha256 } from "../frame_backend_preflight/lib.mjs";
import { buildWholeProjectIdentityManifest, verifyWholeProjectIdentityManifest } from "../frame_backend_preflight/project_identity.mjs";
import { DEFAULT_MOV_CONTRACT } from "./lib.mjs";
import { buildExecutionInputs, verifyExecutionInputs } from "./execution_inputs.mjs";
import {
  buildSegmentRenderInvocation,
  executeSegmentPlan,
  normalizeRenderContext,
  probeSegmentMov,
  runLoggedCommand,
} from "./executor_lib.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const fixtureDir = resolve(here, "fixtures");
const fakeFfprobe = resolve(fixtureDir, "fake_ffprobe.mjs");
const fakeFfmpeg = resolve(fixtureDir, "fake_ffmpeg.mjs");
chmodSync(fakeFfprobe, 0o755);
chmodSync(fakeFfmpeg, 0o755);

function unlockDirectories(path) {
  if (!existsSync(path) || !lstatSync(path).isDirectory()) return;
  chmodSync(path, 0o755);
  for (const name of readdirSync(path)) unlockDirectories(resolve(path, name));
}

function tamperSnapshotFile(runRoot, relativePath, content) {
  const path = resolve(runRoot, "input-snapshot", relativePath);
  chmodSync(path, 0o644);
  writeFileSync(path, content);
}

function signedExecutionPlan({
  projectIdentity = `sha256:${"3".repeat(64)}`,
  screenshotMediaPolicy = "faithful",
  executionInputs = null,
} = {}) {
  const segments = [
    { segmentId: "segment-0000", order: 0, startFrame: 0, endFrameExclusive: 2, frameCount: 2, backend: "proxy-tree", sourceRangeIndexes: [0], screenshotMediaPolicy: null, outputContract: DEFAULT_MOV_CONTRACT },
    { segmentId: "segment-0001", order: 1, startFrame: 2, endFrameExclusive: 4, frameCount: 2, backend: "screenshot", sourceRangeIndexes: [1], screenshotMediaPolicy, outputContract: DEFAULT_MOV_CONTRACT },
    { segmentId: "segment-0002", order: 2, startFrame: 4, endFrameExclusive: 6, frameCount: 2, backend: "proxy-tree", sourceRangeIndexes: [2], screenshotMediaPolicy: null, outputContract: DEFAULT_MOV_CONTRACT },
  ];
  const core = {
    kind: "hyperframes-backend-segment-execution-plan", schemaVersion: 1, executable: true,
    executionMode: "verified", fallbackReason: null, sourceProofValid: true,
    sourceProofSignature: `sha256:${"1".repeat(64)}`, sourceBackendPlanSignature: `sha256:${"2".repeat(64)}`,
    executionInputs,
    identities: { projectIdentity, renderPlanIdentity: `sha256:${"4".repeat(64)}`, machineProfileIdentity: `sha256:${"5".repeat(64)}`, styleOverrideProfileHash: null, auditSignature: `sha256:${"6".repeat(64)}` },
    timeline: { startFrame: 0, frameCount: 6, fps: { numerator: 60, denominator: 1 } },
    screenshotMediaPolicy, downgradedProxyRangeIndexes: [], segments,
    concat: { mode: "stream-copy-after-observation-gate", streamCopyEligible: false, segmentOrder: segments.map((segment) => segment.segmentId), outputContract: DEFAULT_MOV_CONTRACT },
  };
  return { ...core, executionPlanSignature: `sha256:${sha256(core)}` };
}

const scratch = mkdtempSync(resolve(tmpdir(), "hf-segment-executor-test-"));
try {
  const projectRoot = resolve(scratch, "project");
  const signedFfprobe = resolve(scratch, "signed-ffprobe");
  const signedFfmpeg = resolve(scratch, "signed-ffmpeg");
  copyFileSync(fakeFfprobe, signedFfprobe);
  copyFileSync(fakeFfmpeg, signedFfmpeg);
  chmodSync(signedFfprobe, 0o755);
  chmodSync(signedFfmpeg, 0o755);
  const mainScript = resolve(scratch, "full-canvas-main.mjs");
  const mainHelper = resolve(scratch, "main-helper.mjs");
  const entry = resolve(projectRoot, "index.html");
  const alternateEntry = resolve(projectRoot, "alternate.html");
  const timing = resolve(projectRoot, "timing.json");
  const alternateTiming = resolve(projectRoot, "timing-alt.json");
  const sourceMap = resolve(projectRoot, "sources.json");
  mkdirSync(resolve(projectRoot, "shared"), { recursive: true });
  mkdirSync(resolve(projectRoot, ".media"), { recursive: true });
  writeFileSync(mainScript, 'import "./main-helper.mjs";\n');
  writeFileSync(mainHelper, "export const helper = true;\n");
  writeFileSync(entry, "<main>signed entry</main>\n");
  writeFileSync(alternateEntry, "<main>alternate entry</main>\n");
  writeFileSync(timing, '{"relativeSource":"media.bin"}\n');
  writeFileSync(alternateTiming, '{"relativeSource":"alternate-media.bin"}\n');
  writeFileSync(sourceMap, "{}\n");
  writeFileSync(resolve(projectRoot, "media.bin"), "media\n");
  writeFileSync(resolve(projectRoot, "alternate-media.bin"), "alternate media\n");
  writeFileSync(resolve(projectRoot, "shared/master.js"), "window.ready = true;\n");
  writeFileSync(resolve(projectRoot, ".media/manifest.jsonl"), "\n");
  const identityManifest = await buildWholeProjectIdentityManifest({
    projectRoot,
    include: ["timing.json", "timing-alt.json", "sources.json", "media.bin", "alternate-media.bin", "alternate.html"],
  });
  const identityManifestPath = resolve(scratch, "project-identity.json");
  writeFileSync(identityManifestPath, `${JSON.stringify(identityManifest, null, 2)}\n`);
  const context = {
    runtimeCommand: process.execPath,
    runtimePrefixArgs: [resolve(fixtureDir, "fake_runtime.mjs")],
    mainScript,
    projectRoot,
    entry,
    mediaTimingPlan: timing,
    mediaSourceMap: sourceMap,
    projectIdentityManifest: identityManifestPath,
    ffprobe: signedFfprobe,
    ffmpeg: signedFfmpeg,
    mixProjectAudio: true,
    environment: {
      FAKE_VERIFY_SNAPSHOT_TIMING: "1",
      FAKE_TRY_WRITE_ENTRY: "1",
      FAKE_EXPECT_TOOL_PATHS: "1",
      FAKE_VERIFY_RUNTIME_TEMP: "1",
    },
  };
  const manifestVerification = await verifyWholeProjectIdentityManifest({ manifest: identityManifest, projectRoot });
  const executionInputs = await buildExecutionInputs({
    renderContext: normalizeRenderContext(context),
    projectManifest: identityManifest,
    projectManifestVerification: manifestVerification,
  });
  const signedFfmpegResolved = executionInputs.tools.ffmpeg.resolvedPath;
  const signedFfprobeResolved = executionInputs.tools.ffprobe.resolvedPath;
  const plan = signedExecutionPlan({
    projectIdentity: identityManifest.projectIdentity,
    executionInputs,
  });
  const proxyInvocation = buildSegmentRenderInvocation({ executionPlan: plan, segment: plan.segments[0], renderContext: context, outputPath: resolve(scratch, "proxy.mov") });
  assert.deepEqual(proxyInvocation.args, [
    resolve(fixtureDir, "fake_runtime.mjs"),
    mainScript,
    "--audioCodec=pcm_s24le",
    "--audioSampleRate=48000",
    "--compositeMode=proxy-tree",
    "--directMux=true",
    `--entry=${entry}`,
    `--ffmpegPath=${signedFfmpegResolved}`,
    `--ffprobePath=${signedFfprobeResolved}`,
    "--fps=60",
    "--frames=2",
    "--height=2160",
    "--mediaAdvanceMode=playback-step",
    "--mediaDecoderBackend=production-webcodecs",
    `--mediaDecoderRouteDecision=${resolve(scratch, "proxy.mov.media-route.json")}`,
    "--mediaFrameMode=video",
    "--mediaSeekBiasFrames=0",
    `--mediaSourceMap=${sourceMap}`,
    "--mediaTargetMode=timing-plan",
    `--mediaTimingPlan=${timing}`,
    "--mixProjectAudio=true",
    `--output=${resolve(scratch, "proxy.mov")}`,
    "--outputBackend=webcodecs",
    `--projectRoot=${projectRoot}`,
    `--runtimeTempDir=${resolve(scratch, "proxy.mov.runtime")}`,
    `--spawnEnvironmentSha256=${executionInputs.environmentContract.valuesSha256}`,
    "--startFrame=0",
    "--width=3840",
  ]);
  const screenshotInvocation = buildSegmentRenderInvocation({ executionPlan: plan, segment: plan.segments[1], renderContext: context, outputPath: resolve(scratch, "screenshot.mov") });
  assert.deepEqual(screenshotInvocation.args, [
    resolve(fixtureDir, "fake_runtime.mjs"),
    mainScript,
    "--audioCodec=pcm_s24le",
    "--audioSampleRate=48000",
    "--compositeMode=screenshot",
    "--directMux=true",
    `--entry=${entry}`,
    `--ffmpegPath=${signedFfmpegResolved}`,
    `--ffprobePath=${signedFfprobeResolved}`,
    "--fps=60",
    "--frames=2",
    "--height=2160",
    "--mediaAdvanceMode=playback-step",
    "--mediaDecoderBackend=html-video",
    "--mediaFrameMode=video",
    "--mediaSeekBiasFrames=0",
    "--mediaTargetMode=timing-plan",
    `--mediaTimingPlan=${timing}`,
    "--mixProjectAudio=true",
    `--output=${resolve(scratch, "screenshot.mov")}`,
    "--outputBackend=webcodecs",
    `--projectRoot=${projectRoot}`,
    `--runtimeTempDir=${resolve(scratch, "screenshot.mov.runtime")}`,
    "--screenshotMediaPolicy=faithful",
    `--spawnEnvironmentSha256=${executionInputs.environmentContract.valuesSha256}`,
    "--startFrame=2",
    "--width=3840",
  ]);
  assert.deepEqual(proxyInvocation.env, executionInputs.environmentContract.values);
  process.env.HF_UNSIGNED_ENV_ATTACK = "must-not-leak";
  const noLeakInvocation = buildSegmentRenderInvocation({ executionPlan: plan, segment: plan.segments[0], renderContext: context, outputPath: resolve(scratch, "no-leak.mov") });
  assert.equal(noLeakInvocation.env.HF_UNSIGNED_ENV_ATTACK, undefined);
  delete process.env.HF_UNSIGNED_ENV_ATTACK;

  const dryRoot = resolve(scratch, "dry-run");
  const dry = await executeSegmentPlan({ executionPlan: plan, renderContext: context, runRoot: dryRoot, finalOutput: resolve(scratch, "dry.mov"), dryRun: true });
  assert.equal(dry.segmentInvocations.length, 3);
  assert.equal(dry.projectIdentityVerification.required, true);
  assert.equal(dry.projectIdentityVerification.executionInputsVerified, true);
  assert.equal(dry.inputSnapshot.dryRunCreated, false);
  assert.equal(existsSync(dryRoot), false);

  const planPath = resolve(scratch, "execution-plan.json");
  const contextPath = resolve(scratch, "render-context.json");
  const cliDryRoot = resolve(scratch, "dry-cli-run");
  writeFileSync(planPath, `${JSON.stringify(plan)}\n`);
  writeFileSync(contextPath, `${JSON.stringify(context)}\n`);
  const cliDry = JSON.parse(execFileSync(process.execPath, [
    resolve(here, "executor_cli.mjs"),
    `--plan=${planPath}`,
    `--context=${contextPath}`,
    `--run-root=${cliDryRoot}`,
    `--output=${resolve(scratch, "dry-cli.mov")}`,
    "--dry-run=true",
  ], { encoding: "utf8" }));
  assert.equal(cliDry.kind, "hyperframes-segment-executor-dry-run");
  assert.deepEqual(
    cliDry.segmentInvocations.map((invocation) => invocation.args.filter((arg) => (
      arg.startsWith("--compositeMode=")
      || arg.startsWith("--outputBackend=")
      || arg.startsWith("--mediaDecoderBackend=")
      || arg.startsWith("--screenshotMediaPolicy=")
      || arg.startsWith("--startFrame=")
      || arg.startsWith("--frames=")
    ))),
    [
      ["--compositeMode=proxy-tree", "--frames=2", "--mediaDecoderBackend=production-webcodecs", "--outputBackend=webcodecs", "--startFrame=0"],
      ["--compositeMode=screenshot", "--frames=2", "--mediaDecoderBackend=html-video", "--outputBackend=webcodecs", "--screenshotMediaPolicy=faithful", "--startFrame=2"],
      ["--compositeMode=proxy-tree", "--frames=2", "--mediaDecoderBackend=production-webcodecs", "--outputBackend=webcodecs", "--startFrame=4"],
    ],
  );
  assert.equal(existsSync(cliDryRoot), false);

  const finalOutput = resolve(scratch, "final.mov");
  const completion = await executeSegmentPlan({ executionPlan: plan, renderContext: context, runRoot: resolve(scratch, "run"), finalOutput });
  assert.equal(completion.finalObserved.video.frameCount, 6);
  assert.equal(completion.finalObserved.audio.sampleCount, 4_800);
  assert.equal(completion.finalObserved.file, finalOutput);
  assert.equal(completion.usedUniformScreenshotFallback, false);
  assert.equal(completion.segments[0].frameSignatureSidecar, null);
  assert.equal(completion.segments[1].frameSignatureSidecar.frames, 2);
  assert.match(completion.segments[1].frameSignatureSidecar.sha256, /^sha256:[a-f0-9]{64}$/);
  assert.equal(completion.segments[1].frameSignatureSidecar.header.source.startFrame, 2);
  assert.equal(completion.segments[2].frameSignatureSidecar, null);
  assert.equal(existsSync(finalOutput), true);
  const publishedMetrics = JSON.parse(readFileSync(`${finalOutput}.metrics.json`, "utf8"));
  assert.equal(publishedMetrics.outputCommit.committed, true);
  assert.equal(publishedMetrics.finalObserved.file, finalOutput);
  assert.equal(completion.inputSnapshot.projectIdentity, identityManifest.projectIdentity);
  assert.equal(statSync(resolve(completion.inputSnapshot.path, "index.html")).mode & 0o222, 0);
  assert.equal(completion.commands.filter((record) => record.phase === "verify-before-segment-execution-inputs").length, 3);
  assert.equal(completion.commands.filter((record) => record.phase === "verify-after-segment-execution-inputs").length, 3);
  assert.ok(completion.commands.some((record) => record.phase === "verify-before-finalization-inputs"));
  assert.ok(completion.commands.some((record) => record.phase === "verify-before-concat-inputs"));
  assert.ok(completion.commands.some((record) => record.phase === "verify-after-concat-inputs"));
  assert.ok(completion.commands.some((record) => record.phase === "verify-before-atomic-publication-inputs"));
  assert.ok(completion.commands.some((record) => record.phase === "verify-before-atomic-publication-frame-signatures"));
  const completionPhases = completion.commands.map((record) => record.phase);
  assert.ok(completionPhases.indexOf("verify-before-concat-inputs") < completionPhases.indexOf("concat-stream-copy"));
  assert.ok(completionPhases.indexOf("verify-after-concat-inputs") > completionPhases.indexOf("concat-stream-copy"));

  let missingSidecarRemoved = false;
  await assert.rejects(
    executeSegmentPlan({
      executionPlan: plan,
      renderContext: context,
      runRoot: resolve(scratch, "missing-sidecar-run"),
      finalOutput: resolve(scratch, "missing-sidecar.mov"),
      commandRunner: async (invocation) => {
        const result = await runLoggedCommand(invocation);
        if (!missingSidecarRemoved && invocation.args.includes("--compositeMode=screenshot")) {
          rmSync(`${invocation.outputPath}.frame-signatures.bin`, { force: true });
          missingSidecarRemoved = true;
        }
        return result;
      },
    }),
    /frame-signature sidecar is missing/,
  );
  assert.equal(missingSidecarRemoved, true);
  assert.equal(existsSync(resolve(scratch, "missing-sidecar.mov")), false);

  const prePublicationSidecarRun = resolve(scratch, "pre-publication-sidecar-tamper-run");
  let prePublicationSidecarTampered = false;
  await assert.rejects(
    executeSegmentPlan({
      executionPlan: plan,
      renderContext: context,
      runRoot: prePublicationSidecarRun,
      finalOutput: resolve(scratch, "pre-publication-sidecar-tamper.mov"),
      probeAdapter: async (options) => {
        const observed = await probeSegmentMov(options);
        if (options.segment.segmentId === "final" && !prePublicationSidecarTampered) {
          const path = resolve(prePublicationSidecarRun, "segments/segment-0001-screenshot.mov.frame-signatures.bin");
          const bytes = readFileSync(path);
          bytes[bytes.length - 1] ^= 0xff;
          writeFileSync(path, bytes);
          prePublicationSidecarTampered = true;
        }
        return observed;
      },
    }),
    /frame-signature sidecar changed before publication/,
  );
  assert.equal(prePublicationSidecarTampered, true);
  assert.equal(existsSync(resolve(scratch, "pre-publication-sidecar-tamper.mov")), false);

  await assert.rejects(
    executeSegmentPlan({
      executionPlan: plan,
      renderContext: context,
      runRoot: resolve(scratch, "run-fail"),
      finalOutput: resolve(scratch, "failure.mov"),
      commandRunner: (invocation) => (
        invocation.args.includes("--startFrame=2")
          ? Promise.reject(new Error("simulated runtime exited 23"))
          : runLoggedCommand(invocation)
      ),
    }),
    /exited 23/,
  );
  assert.equal(existsSync(resolve(scratch, "run-fail/segments/segment-0002-proxy-tree.mov")), false);
  assert.equal(existsSync(resolve(scratch, "failure.mov")), false);

  const fallbackOutput = resolve(scratch, "fallback.mov");
  const fallback = await executeSegmentPlan({
    executionPlan: plan,
    renderContext: context,
    runRoot: resolve(scratch, "run-fallback"),
    finalOutput: fallbackOutput,
    mismatchPolicy: "uniform-screenshot",
    probeAdapter: async (options) => {
      const observed = await probeSegmentMov(options);
      return options.segment.startFrame === 2
        ? { ...observed, video: { ...observed.video, colorTransfer: "smpte2084" } }
        : observed;
    },
  });
  assert.equal(fallback.usedUniformScreenshotFallback, true);
  assert.equal(fallback.segments.length, 1);
  assert.equal(fallback.segments[0].backend, "screenshot");
  assert.equal(fallback.finalObserved.video.frameCount, 6);

  const inheritedPath = process.env.PATH;
  process.env.PATH = `${inheritedPath ?? ""}:/unsigned-path-mutation`;
  await assert.rejects(
    executeSegmentPlan({
      executionPlan: plan,
      renderContext: context,
      runRoot: resolve(scratch, "environment-tampered-dry"),
      finalOutput: resolve(scratch, "environment-tampered.mov"),
      dryRun: true,
    }),
    /execution input verification failed.*environmentContract/,
  );
  if (inheritedPath == null) delete process.env.PATH;
  else process.env.PATH = inheritedPath;

  let postSegmentToolTampered = false;
  await assert.rejects(
    executeSegmentPlan({
      executionPlan: plan,
      renderContext: context,
      runRoot: resolve(scratch, "post-segment-tool-tamper-run"),
      finalOutput: resolve(scratch, "post-segment-tool-tamper.mov"),
      commandRunner: async (invocation) => {
        const result = await runLoggedCommand(invocation);
        if (!postSegmentToolTampered) {
          writeFileSync(signedFfprobe, "tampered after segment\n");
          postSegmentToolTampered = true;
        }
        return result;
      },
    }),
    /execution inputs changed during verify-after-segment-execution-inputs/,
  );
  assert.equal(existsSync(resolve(scratch, "post-segment-tool-tamper.mov")), false);
  copyFileSync(fakeFfprobe, signedFfprobe);
  chmodSync(signedFfprobe, 0o755);

  const postSegmentSnapshotRun = resolve(scratch, "post-segment-snapshot-tamper-run");
  let postSegmentSnapshotTampered = false;
  await assert.rejects(
    executeSegmentPlan({
      executionPlan: plan,
      renderContext: context,
      runRoot: postSegmentSnapshotRun,
      finalOutput: resolve(scratch, "post-segment-snapshot-tamper.mov"),
      commandRunner: async (invocation) => {
        const result = await runLoggedCommand(invocation);
        if (!postSegmentSnapshotTampered && invocation.args.some((arg) => arg === "--startFrame=0")) {
          tamperSnapshotFile(postSegmentSnapshotRun, "index.html", "<main>tampered after runtime completion</main>\n");
          postSegmentSnapshotTampered = true;
        }
        return result;
      },
    }),
    /execution inputs changed during verify-after-segment-execution-inputs.*snapshot-project:/,
  );
  assert.equal(postSegmentSnapshotTampered, true);
  assert.equal(existsSync(resolve(scratch, "post-segment-snapshot-tamper.mov")), false);
  assert.equal(existsSync(resolve(scratch, "post-segment-snapshot-tamper.mov.metrics.json")), false);

  const postConcatSnapshotRun = resolve(scratch, "post-concat-snapshot-tamper-run");
  let postConcatSnapshotTampered = false;
  await assert.rejects(
    executeSegmentPlan({
      executionPlan: plan,
      renderContext: context,
      runRoot: postConcatSnapshotRun,
      finalOutput: resolve(scratch, "post-concat-snapshot-tamper.mov"),
      commandRunner: async (invocation) => {
        const result = await runLoggedCommand(invocation);
        if (!postConcatSnapshotTampered
            && invocation.args.some((arg, index) => arg === "-f" && invocation.args[index + 1] === "concat")) {
          tamperSnapshotFile(postConcatSnapshotRun, "index.html", "<main>tampered after concat completion</main>\n");
          postConcatSnapshotTampered = true;
        }
        return result;
      },
    }),
    /execution inputs changed during verify-after-concat-inputs.*snapshot-project:/,
  );
  assert.equal(postConcatSnapshotTampered, true);
  assert.equal(existsSync(resolve(scratch, "post-concat-snapshot-tamper.mov")), false);
  assert.equal(existsSync(resolve(scratch, "post-concat-snapshot-tamper.mov.metrics.json")), false);

  const prePublicationSnapshotRun = resolve(scratch, "pre-publication-snapshot-tamper-run");
  let prePublicationSnapshotTampered = false;
  await assert.rejects(
    executeSegmentPlan({
      executionPlan: plan,
      renderContext: context,
      runRoot: prePublicationSnapshotRun,
      finalOutput: resolve(scratch, "pre-publication-snapshot-tamper.mov"),
      probeAdapter: async (options) => {
        const observed = await probeSegmentMov(options);
        if (options.segment.segmentId === "final" && !prePublicationSnapshotTampered) {
          tamperSnapshotFile(prePublicationSnapshotRun, "index.html", "<main>tampered before publication</main>\n");
          prePublicationSnapshotTampered = true;
        }
        return observed;
      },
    }),
    /execution inputs changed during verify-before-atomic-publication-inputs.*snapshot-project:/,
  );
  assert.equal(prePublicationSnapshotTampered, true);
  assert.equal(existsSync(resolve(scratch, "pre-publication-snapshot-tamper.mov")), false);
  assert.equal(existsSync(resolve(scratch, "pre-publication-snapshot-tamper.mov.metrics.json")), false);

  let prePublicationToolTampered = false;
  await assert.rejects(
    executeSegmentPlan({
      executionPlan: plan,
      renderContext: context,
      runRoot: resolve(scratch, "pre-publication-tool-tamper-run"),
      finalOutput: resolve(scratch, "pre-publication-tool-tamper.mov"),
      probeAdapter: async (options) => {
        const observed = await probeSegmentMov(options);
        if (options.segment.segmentId === "final" && !prePublicationToolTampered) {
          writeFileSync(mainHelper, "export const helper = 'tampered before publication';\n");
          prePublicationToolTampered = true;
        }
        return observed;
      },
    }),
    /execution inputs changed during verify-before-atomic-publication-inputs/,
  );
  assert.equal(existsSync(resolve(scratch, "pre-publication-tool-tamper.mov")), false);
  writeFileSync(mainHelper, "export const helper = true;\n");

  const appContents = resolve(scratch, "Synthetic Electron.app/Contents");
  const appRuntime = resolve(appContents, "MacOS/Electron");
  const frameworkVersion = resolve(appContents, "Frameworks/Electron Framework.framework/Versions/A");
  mkdirSync(resolve(appContents, "MacOS"), { recursive: true });
  mkdirSync(resolve(appContents, "Resources"), { recursive: true });
  mkdirSync(frameworkVersion, { recursive: true });
  writeFileSync(appRuntime, "#!/bin/sh\nexit 0\n");
  chmodSync(appRuntime, 0o755);
  writeFileSync(resolve(appContents, "Resources/electron.icns"), "resource-v1\n");
  writeFileSync(resolve(frameworkVersion, "Electron Framework"), "framework-v1\n");
  symlinkSync("A", resolve(appContents, "Frameworks/Electron Framework.framework/Versions/Current"));
  const appContext = normalizeRenderContext({ ...context, runtimeCommand: appRuntime, runtimePrefixArgs: [] });
  const appInputs = await buildExecutionInputs({
    renderContext: appContext,
    projectManifest: identityManifest,
    projectManifestVerification: manifestVerification,
  });
  assert.equal(appInputs.tools.runtimeBundle.rootPath, realpathSync(appContents));
  assert.equal(appInputs.tools.runtimeBundle.layout, "macos-app-contents");
  assert.equal(appInputs.tools.runtimeBundle.regularFileCount, 3);
  assert.equal(appInputs.tools.runtimeBundle.symlinkCount, 1);
  writeFileSync(resolve(appContents, "Resources/electron.icns"), "resource-v2\n");
  const appTamper = await verifyExecutionInputs({
    descriptor: appInputs,
    renderContext: appContext,
    projectManifest: identityManifest,
    projectManifestVerification: manifestVerification,
  });
  assert.equal(appTamper.valid, false);
  assert.match(appTamper.reason, /execution-inputs-context-mismatch:tools/);

  for (const [label, changedContext, pattern] of [
    ["wrong-entry", { ...context, entry: alternateEntry }, /execution input verification failed/],
    ["swapped-timing", { ...context, mediaTimingPlan: alternateTiming }, /execution input verification failed/],
    ["runtime", { ...context, runtimeCommand: fakeFfmpeg }, /execution input verification failed/],
    ["common-args", { ...context, commonRenderArgs: { bitrate: 10_000_000 } }, /execution input verification failed/],
    ["environment", { ...context, environment: { ...context.environment, UNSIGNED_ENV: "1" } }, /execution input verification failed/],
  ]) {
    await assert.rejects(
      executeSegmentPlan({
        executionPlan: plan,
        renderContext: changedContext,
        runRoot: resolve(scratch, `${label}-dry`),
        finalOutput: resolve(scratch, `${label}.mov`),
        dryRun: true,
      }),
      pattern,
    );
  }

  writeFileSync(mainScript, "changed main\n");
  await assert.rejects(
    executeSegmentPlan({
      executionPlan: plan,
      renderContext: context,
      runRoot: resolve(scratch, "main-tampered-dry"),
      finalOutput: resolve(scratch, "main-tampered.mov"),
      dryRun: true,
    }),
    /execution input verification failed/,
  );
  writeFileSync(mainScript, 'import "./main-helper.mjs";\n');

  writeFileSync(mainHelper, "export const helper = false;\n");
  await assert.rejects(
    executeSegmentPlan({
      executionPlan: plan,
      renderContext: context,
      runRoot: resolve(scratch, "toolchain-tampered-dry"),
      finalOutput: resolve(scratch, "toolchain-tampered.mov"),
      dryRun: true,
    }),
    /execution input verification failed/,
  );
  writeFileSync(mainHelper, "export const helper = true;\n");

  const unsignedInputsPlan = signedExecutionPlan({ projectIdentity: identityManifest.projectIdentity });
  await assert.rejects(
    executeSegmentPlan({
      executionPlan: unsignedInputsPlan,
      renderContext: context,
      runRoot: resolve(scratch, "missing-inputs-dry"),
      finalOutput: resolve(scratch, "missing-inputs.mov"),
      dryRun: true,
    }),
    /signed execution inputs are required/,
  );

  writeFileSync(resolve(projectRoot, "shared/master.js"), "window.ready = false;\n");
  await assert.rejects(
    executeSegmentPlan({
      executionPlan: plan,
      renderContext: context,
      runRoot: resolve(scratch, "project-tampered-dry"),
      finalOutput: resolve(scratch, "project-tampered.mov"),
      dryRun: true,
    }),
    /project identity verification failed/,
  );
  writeFileSync(resolve(projectRoot, "shared/master.js"), "window.ready = true;\n");

  let originalProjectMutatedAfterSnapshot = false;
  const isolatedOutput = resolve(scratch, "isolated.mov");
  const isolated = await executeSegmentPlan({
    executionPlan: plan,
    renderContext: context,
    runRoot: resolve(scratch, "run-isolated"),
    finalOutput: isolatedOutput,
    commandRunner: async (invocation) => {
      if (!originalProjectMutatedAfterSnapshot) {
        writeFileSync(entry, "<main>changed after verification</main>\n");
        originalProjectMutatedAfterSnapshot = true;
      }
      return runLoggedCommand(invocation);
    },
  });
  assert.equal(originalProjectMutatedAfterSnapshot, true);
  assert.equal(readFileSync(resolve(isolated.inputSnapshot.path, "index.html"), "utf8"), "<main>signed entry</main>\n");
  assert.equal(readFileSync(entry, "utf8"), "<main>changed after verification</main>\n");
  console.log("backend segment executor tests passed");
} finally {
  unlockDirectories(scratch);
  rmSync(scratch, { recursive: true, force: true });
}
