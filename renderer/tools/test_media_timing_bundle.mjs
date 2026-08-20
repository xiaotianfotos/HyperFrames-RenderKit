#!/usr/bin/env node

import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import {
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  utimes,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import {
  assertBrowserCurrentTimeCompatible,
  buildMediaTimingBundle,
  findStaticVideoSources,
  loadAndVerifyMediaTimingBundle,
  validateMediaTimingBundle,
} from "./media_timing_bundle_lib.mjs";
import { buildTimingPlan } from "./media_timing_plan_lib.mjs";

const execFileAsync = promisify(execFile);

async function main() {
  const projectRoot = await mkdtemp(join(tmpdir(), "media-timing-bundle-test-"));
  try {
    const mediaRoot = resolve(projectRoot, "media");
    const cacheRoot = resolve(projectRoot, ".render-cache");
    await mkdir(mediaRoot, { recursive: true });
    await mkdir(cacheRoot, { recursive: true });
    const seed = resolve(mediaRoot, "seed.mp4");
    await execFileAsync("ffmpeg", [
      "-v", "error", "-y", "-f", "lavfi", "-i", "testsrc2=size=64x36:rate=6:duration=0.5",
      "-c:v", "libx264", "-bf", "2", "-g", "12", "-pix_fmt", "yuv420p",
      "-video_track_timescale", "6000", seed,
    ]);
    const names = Array.from({ length: 11 }, (_unused, index) => `video_${String(index + 2).padStart(3, "0")}.mp4`);
    for (const name of names) await copyFile(seed, resolve(mediaRoot, name));
    const unused = resolve(mediaRoot, "video_001-unused.mp4");
    await copyFile(seed, unused);
    const decoderCache = resolve(cacheRoot, "mapped-cache.mp4");
    await copyFile(seed, decoderCache);
    const entryPath = resolve(projectRoot, "index.html");
    await writeFile(entryPath, [
      "<!doctype html>",
      ...names.slice(0, 10).map((name) => `<video src="media/${name}"></video>`),
      `<video><source src="media/${names[10]}" type="video/mp4"></video>`,
    ].join("\n"));

    const discovered = findStaticVideoSources({ projectRoot, entryPath });
    assert.equal(discovered.length, 11);
    assert.equal(discovered.some((entry) => entry.absolutePath === unused), false);
    const bundle = await buildMediaTimingBundle({
      projectRoot,
      entryPath,
      extraSources: [{
        absolutePath: decoderCache,
        role: "decoder-cache",
        mapsFrom: `media/${names[0]}`,
      }],
    });
    assert.equal(bundle.entries.filter((entry) => entry.roles.includes("composition")).length, 11);
    assert.equal(bundle.entries.filter((entry) => entry.roles.includes("decoder-cache")).length, 1);
    assert.equal(bundle.entries.every((entry) => (
      entry.plan.probe.timestampSource === "packet-pts-iso-bmff-access-unit-verified"
    )), true);
    assert.equal(bundle.entries.every((entry) => (
      entry.plan.probe.timestampAudit.packetMetadataEligible
      && entry.plan.probe.timestampAudit.selectedPath === "packet-pts"
    )), true);
    assert.equal(bundle.build.reusedSourceCount, 0);
    assert.equal(bundle.build.scannedSourceCount, 12);
    assert.throws(
      () => validateMediaTimingBundle({ ...bundle, schemaVersion: 1 }),
      /Unsupported timing bundle schema/,
      "packet-count-only v1 bundles must be rebuilt instead of silently reused",
    );
    assert.equal(bundle.entries.every((entry) => entry.plan.presentation.displayEndTicks > entry.plan.presentation.lastPtsTicks), true);
    const manifestPath = resolve(cacheRoot, "media-timing-bundle.json");
    await writeFile(manifestPath, `${JSON.stringify(bundle)}\n`);

    const reusedBundle = await buildMediaTimingBundle({
      projectRoot,
      entryPath,
      extraSources: [{
        absolutePath: decoderCache,
        role: "decoder-cache",
        mapsFrom: `media/${names[0]}`,
      }],
      reuseEntries: bundle.entries,
    });
    assert.equal(reusedBundle.build.reusedSourceCount, 12);
    assert.equal(reusedBundle.build.scannedSourceCount, 0);
    assert.deepEqual(
      reusedBundle.entries.map((entry) => [entry.source, entry.planSha256]),
      bundle.entries.map((entry) => [entry.source, entry.planSha256]),
    );

    const statLoaded = await loadAndVerifyMediaTimingBundle({
      manifestPath,
      projectRoot,
      entryPath,
      verifyMode: "stat",
      requiredDecoderMappings: [{
        source: `media/${names[0]}`,
        cache: ".render-cache/mapped-cache.mp4",
      }],
    });
    assert.equal(statLoaded.entries.length, 12);
    await assert.rejects(loadAndVerifyMediaTimingBundle({
      manifestPath,
      projectRoot,
      entryPath,
      verifyMode: "stat",
      requiredDecoderMappings: [{
        source: `media/${names[1]}`,
        cache: ".render-cache/mapped-cache.mp4",
      }],
    }), /not recorded as a cache mapped from/);

    const copiedSource = resolve(mediaRoot, names[0]);
    const future = new Date(Date.now() + 10_000);
    await utimes(copiedSource, future, future);
    await assert.rejects(loadAndVerifyMediaTimingBundle({
      manifestPath,
      projectRoot,
      entryPath,
      verifyMode: "stat",
    }), /failed stat verification/);
    await loadAndVerifyMediaTimingBundle({
      manifestPath,
      projectRoot,
      entryPath,
      verifyMode: "sha256",
    });

    const originalEntry = await readFile(entryPath, "utf8");
    await writeFile(entryPath, originalEntry.replace(`media/${names[10]}`, "media/video_999.mp4"));
    await assert.rejects(loadAndVerifyMediaTimingBundle({
      manifestPath,
      projectRoot,
      entryPath,
      verifyMode: "sha256",
    }), /entry HTML|source set changed/);
    await writeFile(entryPath, originalEntry);

    const changedSeed = resolve(mediaRoot, "changed-seed.mp4");
    await execFileAsync("ffmpeg", [
      "-v", "error", "-y", "-f", "lavfi", "-i", "color=c=red:size=64x36:rate=6:duration=0.5",
      "-c:v", "libx264", "-bf", "2", "-g", "12", "-pix_fmt", "yuv420p",
      "-video_track_timescale", "6000", changedSeed,
    ]);
    await copyFile(changedSeed, resolve(mediaRoot, names[1]));
    const partiallyReusedBundle = await buildMediaTimingBundle({
      projectRoot,
      entryPath,
      extraSources: [{
        absolutePath: decoderCache,
        role: "decoder-cache",
        mapsFrom: `media/${names[0]}`,
      }],
      reuseEntries: bundle.entries,
    });
    assert.equal(partiallyReusedBundle.build.reusedSourceCount, 11);
    assert.equal(partiallyReusedBundle.build.scannedSourceCount, 1);
    assert.deepEqual(partiallyReusedBundle.build.scannedSources, [`media/${names[1]}`]);

    const nonzeroPlan = buildTimingPlan({
      sourcePath: "/synthetic/nonzero.mp4",
      sourceStat: { size: 1, mtimeNs: "1" },
      sourceSha256: "a".repeat(64),
      ffprobeVersion: "synthetic",
      probe: {
        streams: [{
          index: 0, codec_type: "video", codec_name: "h264", width: 64, height: 36,
          time_base: "1/1000", r_frame_rate: "5/1", avg_frame_rate: "5/1",
          start_pts: "2000", start_time: "2", duration_ts: "2400", has_b_frames: 2,
        }],
        frames: [
          { stream_index: 0, best_effort_timestamp: "2000", key_frame: 1 },
          { stream_index: 0, best_effort_timestamp: "2200", key_frame: 0 },
        ],
      },
    });
    assert.throws(
      () => assertBrowserCurrentTimeCompatible(nonzeroPlan),
      /cannot use browser currentTime/,
    );

    console.log("media timing bundle tests passed");
  } finally {
    await rm(projectRoot, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error.stack ?? error.message);
  process.exitCode = 1;
});
