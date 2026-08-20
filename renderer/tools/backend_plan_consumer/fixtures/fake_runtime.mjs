#!/usr/bin/env node

import { createHash } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import {
  createFrameSignatureHeader,
  createFrameSignatureWriter,
  FRAME_SIGNATURE_GRID_HEIGHT,
  FRAME_SIGNATURE_GRID_WIDTH,
} from "../../frame_signature_sidecar.mjs";

const args = Object.fromEntries(process.argv.slice(3).filter((item) => item.startsWith("--")).map((item) => {
  const split = item.indexOf("=");
  return [item.slice(2, split), item.slice(split + 1)];
}));
const normalizedEnvironment = Object.fromEntries(
  Object.entries(process.env).map(([key, value]) => [key, String(value)]).sort(([left], [right]) => left.localeCompare(right)),
);
const observedEnvironmentSha256 = `sha256:${createHash("sha256").update(JSON.stringify(normalizedEnvironment)).digest("hex")}`;
if (args.spawnEnvironmentSha256 !== observedEnvironmentSha256) {
  process.stderr.write(`${JSON.stringify({ expected: args.spawnEnvironmentSha256, observed: observedEnvironmentSha256, environment: normalizedEnvironment })}\n`);
  process.exit(28);
}
if (String(process.env.FAKE_FAIL_START_FRAME ?? "") === args.startFrame) process.exit(23);
if (process.env.FAKE_EXPECT_TOOL_PATHS === "1") {
  if (!args.ffmpegPath || !args.ffprobePath || !args.ffmpegPath.startsWith("/") || !args.ffprobePath.startsWith("/")) {
    process.exit(26);
  }
}
if (process.env.FAKE_VERIFY_RUNTIME_TEMP === "1") {
  if (!args.runtimeTempDir || !existsSync(args.runtimeTempDir)
      || resolve(args.runtimeTempDir).startsWith(`${resolve(args.projectRoot)}/`)) {
    process.exit(27);
  }
  writeFileSync(resolve(args.runtimeTempDir, "fake-runtime-writable"), "ok\n");
}
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
const renderIdentity = {
  project: "11".repeat(32),
  entry: createHash("sha256").update(readFileSync(args.entry)).digest("hex"),
  assets: "22".repeat(32),
  timingBundle: createHash("sha256").update(readFileSync(args.mediaTimingPlan)).digest("hex"),
  canonicalMediaRoute: "33".repeat(32),
  decoderMappings: "44".repeat(32),
};
let frameSignatureSidecar = null;
if (args.compositeMode === "screenshot") {
  const finalPath = `${args.output}.frame-signatures.bin`;
  const stagingPath = `${finalPath}.fake-partial`;
  const writer = createFrameSignatureWriter({
    stagingPath,
    finalPath,
    header: createFrameSignatureHeader({
      runId: `fake-${args.startFrame}`,
      renderIdentity,
      width: Number(args.width),
      height: Number(args.height),
      fps: Number(args.fps),
      frames: Number(args.frames),
      startFrame: Number(args.startFrame),
      startSeconds: Number(args.startFrame) / Number(args.fps),
    }),
  });
  const signature = Buffer.alloc(FRAME_SIGNATURE_GRID_WIDTH * FRAME_SIGNATURE_GRID_HEIGHT * 3);
  for (let frame = 0; frame < Number(args.frames); frame += 1) await writer.write(frame, signature);
  frameSignatureSidecar = { ...await writer.finalize(), committed: true };
  writer.commit();
}
writeFileSync(`${args.output}.metrics.json`, `${JSON.stringify({
  runId: `fake-${args.startFrame}`,
  failure: null,
  renderIdentity,
  screenshotSequence: frameSignatureSidecar ? { frameSignatureSidecar } : undefined,
  config: {
    frames: Number(args.frames),
    startFrame: Number(args.startFrame),
    projectRoot: args.projectRoot,
    entry: args.entry,
    mediaTimingPlanPath: args.mediaTimingPlan,
    ffmpegPath: args.ffmpegPath,
    ffprobePath: args.ffprobePath,
    runtimeTempDir: args.runtimeTempDir,
    spawnEnvironmentSha256: args.spawnEnvironmentSha256,
    observedProcessEnvironmentSha256: observedEnvironmentSha256,
  },
  outputCommit: { committed: true },
})}\n`);
