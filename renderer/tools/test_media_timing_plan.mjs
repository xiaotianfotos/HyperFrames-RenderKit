#!/usr/bin/env node

import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import {
  auditPacketPtsFastPath,
  buildTimingPlan,
  createTimingPlanQuery,
  expandPresentationPts,
  frameAtOrBefore,
  frameAtOrBeforeTicks,
  precedingKeyframe,
  presentationPtsFromFrames,
  presentationPtsFromPackets,
  samePresentationFrame,
  scanMediaTiming,
  verifyTimingPlanSource,
} from "./media_timing_plan_lib.mjs";

const execFileAsync = promisify(execFile);

async function ffmpeg(args) {
  await execFileAsync("ffmpeg", ["-v", "error", "-y", ...args], {
    encoding: "utf8",
    maxBuffer: 32 * 1024 * 1024,
  });
}

async function frameHashes(source) {
  const { stdout } = await execFileAsync("ffmpeg", [
    "-v", "error", "-i", source,
    "-map", "0:v:0", "-f", "framehash", "-hash", "SHA256", "-",
  ], { encoding: "utf8", maxBuffer: 32 * 1024 * 1024 });
  return stdout.split(/\r?\n/)
    .filter((line) => line && !line.startsWith("#"))
    .map((line) => {
      const columns = line.split(",").map((column) => column.trim());
      return { pts: Number(columns[2]), hash: columns[5] };
    });
}

async function main() {
  const fixtureRoot = await mkdtemp(join(tmpdir(), "media-timing-plan-test-"));
  try {
    const cfr = join(fixtureRoot, "cfr-bframes.mp4");
    const vfr = join(fixtureRoot, "vfr-missing.mkv");
    const nonzero = join(fixtureRoot, "nonzero-origin.mp4");
    const vp9 = join(fixtureRoot, "vp9-superframe-risk.webm");
    const fakeFfprobe = join(fixtureRoot, "fake-ffprobe.mjs");
    const packetMissing = join(fixtureRoot, "packet-missing-pts.mp4");
    const decodedMissing = join(fixtureRoot, "decoded-missing-pts.mp4");

    await writeFile(fakeFfprobe, [
      "#!/usr/bin/env node",
      "const args = process.argv.slice(2);",
      "const source = args.at(-1) ?? '';",
      "const hardFail = source.includes('decoded-missing-pts');",
      "if (args.includes('-version')) {",
      "  console.log('ffprobe fake-scanner-test');",
      "} else if (args.includes('-show_streams')) {",
      "  console.log(JSON.stringify({",
      "    streams: [{",
      "      index: 0, codec_type: 'video', codec_name: 'h264', codec_tag_string: 'avc1',",
      "      profile: 'High', width: 16, height: 16, pix_fmt: 'yuv420p', field_order: 'progressive',",
      "      time_base: '1/1000', r_frame_rate: '5/1', avg_frame_rate: '5/1',",
      "      start_pts: 0, start_time: '0.000000', duration_ts: 400, duration: '0.400000',",
      "      has_b_frames: 0, nb_frames: '2', nb_read_packets: '2', extradata_size: 45,",
      "      disposition: { attached_pic: 0, multilayer: 0 },",
      "    }],",
      "    format: { format_name: 'mov,mp4,m4a,3gp,3g2,mj2' },",
      "  }));",
      "} else if (args.includes('-show_packets')) {",
      "  console.log('stream_index=0|duration=200|size=10|flags=K__');",
      "  console.log('stream_index=0|pts=200|duration=200|size=10|flags=___');",
      "} else if (args.includes('-show_frames')) {",
      "  console.log('media_type=video|stream_index=0|key_frame=1|pts=0|best_effort_timestamp=0|pict_type=I|pkt_duration=200');",
      "  console.log(hardFail",
      "    ? 'media_type=video|stream_index=0|key_frame=0|pts=N/A|best_effort_timestamp=N/A|pict_type=P|pkt_duration=200'",
      "    : 'media_type=video|stream_index=0|key_frame=0|pts=200|best_effort_timestamp=200|pict_type=P|pkt_duration=200');",
      "} else {",
      "  console.log('{}');",
      "}",
    ].join("\n"));
    await chmod(fakeFfprobe, 0o755);
    await writeFile(packetMissing, "packet validation fallback fixture");
    await writeFile(decodedMissing, "decoded timestamp hard-fail fixture");

    await ffmpeg([
      "-f", "lavfi", "-i", "testsrc2=size=96x64:rate=5:duration=1.2",
      "-c:v", "libx264", "-bf", "2", "-g", "5", "-pix_fmt", "yuv420p",
      "-video_track_timescale", "1000", cfr,
    ]);
    await ffmpeg([
      "-f", "lavfi", "-i", "testsrc2=size=96x64:rate=10:duration=0.6",
      "-vf", "select=not(eq(n\\,2)+eq(n\\,5))",
      "-fps_mode", "vfr", "-c:v", "ffv1", vfr,
    ]);
    await ffmpeg([
      "-f", "lavfi", "-i", "testsrc2=size=96x64:rate=5:duration=1",
      "-vf", "setpts=PTS+2/TB",
      "-c:v", "libx264", "-bf", "2", "-g", "5", "-pix_fmt", "yuv420p",
      "-video_track_timescale", "1000", nonzero,
    ]);
    await ffmpeg([
      "-f", "lavfi", "-i", "testsrc2=size=96x64:rate=6:duration=0.5",
      "-c:v", "libvpx-vp9", "-deadline", "realtime", "-cpu-used", "8",
      "-g", "6", "-pix_fmt", "yuv420p", vp9,
    ]);

    const [cfrPlan, vfrPlan, nonzeroPlan, vp9Plan] = await Promise.all([
      scanMediaTiming(cfr),
      scanMediaTiming(vfr),
      scanMediaTiming(nonzero),
      scanMediaTiming(vp9),
    ]);

    assert.equal(cfrPlan.presentation.classification, "cfr-integer-grid");
    assert.equal(cfrPlan.presentation.pts.kind, "linear");
    assert.deepEqual(expandPresentationPts(cfrPlan), [0, 200, 400, 600, 800, 1000]);
    assert.ok(cfrPlan.stream.hasBFrames > 0);
    assert.equal(cfrPlan.stream.decodeOrderReordered, true);
    assert.equal(cfrPlan.probe.timestampSource, "packet-pts-iso-bmff-access-unit-verified");
    assert.equal(cfrPlan.probe.timestampAudit.packetMetadataEligible, true);
    assert.equal(cfrPlan.probe.timestampAudit.selectedPath, "packet-pts");
    assert.deepEqual(cfrPlan.probe.timestampAudit.rejectionReasons, []);
    assert.equal(cfrPlan.presentation.lastFrameDurationTicks, 200);
    assert.equal(cfrPlan.presentation.displayEndTicks, 1200);
    assert.equal(cfrPlan.stream.codec, "h264");
    assert.equal(cfrPlan.stream.nominalFrameRate, "5/1");
    assert.equal(cfrPlan.stream.timeBase, "1/1000");
    assert.equal(cfrPlan.stream.timestampPolicy.startsWith("presentation PTS"), true);
    assert.equal(frameAtOrBefore(cfrPlan, 0.399).frameIndex, 1);
    assert.equal(frameAtOrBefore(cfrPlan, 0.4).frameIndex, 2);
    assert.equal(frameAtOrBefore(cfrPlan, 9).frameIndex, 5);
    assert.equal(frameAtOrBefore(cfrPlan, 1.199).pastDisplayEnd, false);
    assert.equal(frameAtOrBefore(cfrPlan, 1.2).pastDisplayEnd, true);
    assert.equal(frameAtOrBefore(cfrPlan, -0.001), null);
    assert.equal(precedingKeyframe(cfrPlan, 4), 0);

    assert.equal(vfrPlan.presentation.classification, "vfr-or-discontinuous");
    assert.equal(vfrPlan.presentation.pts.kind, "delta");
    assert.deepEqual(expandPresentationPts(vfrPlan), [0, 100, 300, 400]);
    const inGapA = frameAtOrBefore(vfrPlan, 0.2);
    const inGapB = frameAtOrBefore(vfrPlan, 0.299);
    const afterGap = frameAtOrBefore(vfrPlan, 0.3);
    assert.equal(inGapA.frameIndex, 1);
    assert.equal(inGapB.frameIndex, 1);
    assert.equal(afterGap.frameIndex, 2);
    assert.equal(inGapA.lookup, "vfr-binary-search");
    assert.equal(samePresentationFrame(inGapA, inGapB), true);
    assert.equal(samePresentationFrame(inGapB, afterGap), false);
    const compiledVfr = createTimingPlanQuery(vfrPlan);
    assert.equal(compiledVfr.atOrBefore(0.299).frameIndex, 1);
    assert.equal(compiledVfr.sameFrame(compiledVfr.atOrBefore(0.2), compiledVfr.atOrBefore(0.299)), true);

    assert.equal(nonzeroPlan.timeline.nonZeroOrigin, true);
    assert.equal(nonzeroPlan.timeline.presentationOriginTicks, 2000);
    assert.equal(nonzeroPlan.stream.startTimeSeconds, 2);
    assert.equal(nonzeroPlan.timeline.editList.detected, true);
    assert.equal(frameAtOrBefore(nonzeroPlan, 0, { timeline: "media-relative" }).ptsTicks, 2000);
    assert.equal(frameAtOrBefore(nonzeroPlan, 0.2, { timeline: "media-relative" }).ptsTicks, 2200);
    assert.equal(frameAtOrBefore(nonzeroPlan, 2.2, { timeline: "stream-absolute" }).ptsTicks, 2200);
    assert.equal(frameAtOrBeforeTicks(nonzeroPlan, 1999, { timeline: "stream-absolute" }), null);

    // VP9 and AV1 packets are never treated as presentation frames. A real
    // VP9 fixture must go through show_frames even if its packet/frame counts
    // happen to agree.
    assert.equal(vp9Plan.stream.codec, "vp9");
    assert.match(vp9Plan.probe.timestampSource, /^decoded-frame-pts-fallback:/);
    assert.equal(vp9Plan.probe.timestampAudit.packetMetadataEligible, false);
    assert.equal(vp9Plan.probe.timestampAudit.selectedPath, "decoded-frame-pts");
    assert.equal(
      vp9Plan.probe.timestampAudit.rejectionReasons.some((reason) => reason.includes("codec vp9")),
      true,
    );

    const auditedStream = {
      index: 0,
      codec_type: "video",
      codec_name: "h264",
      codec_tag_string: "avc1",
      field_order: "progressive",
      extradata_size: 45,
      start_pts: "0",
      start_time: "0",
      nb_frames: "6",
      nb_read_packets: "6",
      disposition: { attached_pic: 0, multilayer: 0 },
    };
    const auditedProbe = {
      streams: [auditedStream],
      format: { format_name: "mov,mp4,m4a,3gp,3g2,mj2" },
    };
    assert.equal(auditPacketPtsFastPath(auditedProbe).eligible, true);
    assert.equal(auditPacketPtsFastPath({
      ...auditedProbe,
      streams: [{ ...auditedStream, disposition: { attached_pic: 0 } }],
    }).eligible, true, "older ffprobe may omit a zero-valued multilayer disposition");
    assert.equal(auditPacketPtsFastPath({
      ...auditedProbe,
      streams: [{ ...auditedStream, codec_name: "hevc", codec_tag_string: "hvc1" }],
    }).eligible, true);
    for (const [codec_name, codec_tag_string] of [["vp9", "vp09"], ["av1", "av01"]]) {
      const audit = auditPacketPtsFastPath({
        ...auditedProbe,
        streams: [{ ...auditedStream, codec_name, codec_tag_string }],
      });
      assert.equal(audit.eligible, false);
      assert.equal(audit.reasons.some((reason) => reason.includes(`codec ${codec_name}`)), true);
    }
    assert.equal(auditPacketPtsFastPath({
      ...auditedProbe,
      format: { format_name: "mpegts" },
    }).eligible, false);

    // The fast packet path must select the same presentation timestamp set as
    // a decoded-frame scan on a B-frame source.
    const [packetProbe, frameProbe] = await Promise.all([
      execFileAsync("ffprobe", [
        "-v", "error", "-select_streams", "v:0", "-show_packets",
        "-show_entries", "packet=pts", "-of", "json", cfr,
      ], { encoding: "utf8" }),
      execFileAsync("ffprobe", [
        "-v", "error", "-select_streams", "v:0", "-show_frames",
        "-show_entries", "frame=best_effort_timestamp", "-of", "json", cfr,
      ], { encoding: "utf8" }),
    ]);
    const packetPts = JSON.parse(packetProbe.stdout).packets.map((packet) => Number(packet.pts)).sort((a, b) => a - b);
    const decodedPts = JSON.parse(frameProbe.stdout).frames
      .map((frame) => Number(frame.best_effort_timestamp));
    assert.deepEqual(packetPts, decodedPts);

    const ptsFallbackPlan = buildTimingPlan({
      sourcePath: "/synthetic/pts-fallback.mp4",
      sourceStat: { size: 2, mtimeNs: "2" },
      sourceSha256: "1".repeat(64),
      ffprobeVersion: "synthetic",
      probe: {
        streams: [{
          index: 0, codec_type: "video", codec_name: "h264", width: 10, height: 10,
          time_base: "1/1000", r_frame_rate: "5/1", avg_frame_rate: "5/1",
          start_pts: "0", start_time: "0", duration_ts: "400", has_b_frames: 0,
        }],
        frames: [
          { stream_index: 0, best_effort_timestamp: "N/A", pts: "0", key_frame: 1 },
          { stream_index: 0, best_effort_timestamp: "N/A", pts: "200", key_frame: 0 },
        ],
      },
    });
    assert.deepEqual(expandPresentationPts(ptsFallbackPlan), [0, 200]);
    assert.throws(() => buildTimingPlan({
      sourcePath: "/synthetic/missing-pts.mp4",
      sourceStat: { size: 3, mtimeNs: "3" },
      sourceSha256: "2".repeat(64),
      ffprobeVersion: "synthetic",
      probe: {
        streams: [{
          index: 0, codec_type: "video", codec_name: "h264", width: 10, height: 10,
          time_base: "1/1000", r_frame_rate: "5/1", avg_frame_rate: "5/1",
          start_pts: "0", start_time: "0", duration_ts: "400", has_b_frames: 0,
        }],
        frames: [
          { stream_index: 0, best_effort_timestamp: "N/A", pts: "N/A", key_frame: 1 },
          { stream_index: 0, best_effort_timestamp: "200", pts: "200", key_frame: 0 },
        ],
      },
    }), /has no presentation PTS/);
    assert.throws(() => presentationPtsFromPackets([
      { stream_index: 0, pts: "0", duration: "100", flags: "K__" },
      { stream_index: 0, pts: "N/A", duration: "100", flags: "___" },
    ], 0), /has no presentation PTS/);
    assert.throws(() => presentationPtsFromPackets([
      { stream_index: 0, pts: "0", duration: "100", flags: "K__" },
      { stream_index: 0, pts: "0", duration: "100", flags: "___" },
    ], 0), /share presentation PTS/);
    const multiPacketSimulation = presentationPtsFromPackets([
      { stream_index: 0, pts: "0", duration: "100", flags: "K__" },
      { stream_index: 0, pts: "50", duration: "50", flags: "___" },
      { stream_index: 0, pts: "100", duration: "100", flags: "___" },
    ], 0);
    assert.equal(multiPacketSimulation.length, 3);
    assert.notEqual(multiPacketSimulation.length, 2, "packet rows cannot pass a declared two-frame count gate");
    assert.throws(() => presentationPtsFromFrames([
      { media_type: "video", stream_index: 0, best_effort_timestamp: "0", key_frame: 1 },
      { media_type: "video", stream_index: 0, best_effort_timestamp: "N/A", pts: "N/A", key_frame: 0 },
    ], 0), /Decoded frame 1 has no presentation PTS/);

    // A metadata-eligible AVC source with a missing packet PTS must not use
    // packet timing. The scanner retries via show_frames, records the reason,
    // and only succeeds when every decoded display frame has a PTS.
    const packetFallbackPlan = await scanMediaTiming(packetMissing, { ffprobePath: fakeFfprobe });
    assert.equal(packetFallbackPlan.probe.timestampAudit.packetMetadataEligible, true);
    assert.equal(packetFallbackPlan.probe.timestampAudit.selectedPath, "decoded-frame-pts");
    assert.match(packetFallbackPlan.probe.timestampAudit.packetValidationError, /has no presentation PTS/);
    assert.deepEqual(expandPresentationPts(packetFallbackPlan), [0, 200]);
    await assert.rejects(
      scanMediaTiming(decodedMissing, { ffprobePath: fakeFfprobe }),
      /Decoded frame 1 has no presentation PTS/,
    );

    // Pixel identities are obtained through an independent full decode. The
    // selected presentation ordinal must point at exactly that decoded frame,
    // including across the missing-PTS gap and the non-zero-origin edit list.
    for (const [plan, source, selections] of [
      [cfrPlan, cfr, [[0.4, 2], [0.8, 4]]],
      [vfrPlan, vfr, [[0.299, 1], [0.3, 2]]],
      [nonzeroPlan, nonzero, [[0, 0], [0.4, 2]]],
    ]) {
      const hashes = await frameHashes(source);
      assert.equal(hashes.length, plan.presentation.frameCount);
      assert.equal(new Set(hashes.map((entry) => entry.hash)).size, hashes.length);
      for (const [target, expectedIndex] of selections) {
        const selected = frameAtOrBefore(plan, target);
        assert.equal(selected.frameIndex, expectedIndex);
        assert.equal(hashes[selected.frameIndex].hash, hashes[expectedIndex].hash);
      }
    }

    const statValid = await verifyTimingPlanSource(cfrPlan, cfr, { mode: "stat" });
    const hashValid = await verifyTimingPlanSource(cfrPlan, cfr, { mode: "hash" });
    assert.equal(statValid.valid, true);
    assert.equal(hashValid.valid, true);

    const originalVfrBytes = await readFile(vfr);
    const changedVfrBytes = Buffer.from(originalVfrBytes);
    changedVfrBytes[changedVfrBytes.length - 1] ^= 1;
    await writeFile(vfr, changedVfrBytes);
    const sameSizeStatInvalid = await verifyTimingPlanSource(vfrPlan, vfr, { mode: "stat" });
    const sameSizeHashInvalid = await verifyTimingPlanSource(vfrPlan, vfr, { mode: "hash" });
    assert.equal(sameSizeStatInvalid.valid, false);
    assert.equal(sameSizeStatInvalid.reason, "mtime");
    assert.equal(sameSizeHashInvalid.valid, false);
    assert.equal(sameSizeHashInvalid.reason, "sha256");

    await writeFile(cfr, Buffer.concat([await readFile(cfr), Buffer.from([0])]));
    const invalidated = await verifyTimingPlanSource(cfrPlan, cfr, { mode: "stat" });
    assert.equal(invalidated.valid, false);
    assert.equal(invalidated.reason, "size");

    const rawVfrPtsBytes = Buffer.byteLength(JSON.stringify(expandPresentationPts(vfrPlan)));
    const encodedVfrPtsBytes = Buffer.byteLength(JSON.stringify(vfrPlan.presentation.pts));
    assert.ok(encodedVfrPtsBytes <= rawVfrPtsBytes + 128);

    const scaleFrameCount = 36_000;
    const syntheticPlan = (ptsTicks) => buildTimingPlan({
      sourcePath: "/synthetic/video.mp4",
      sourceStat: { size: 1, mtimeNs: "1" },
      sourceSha256: "0".repeat(64),
      ffprobeVersion: "synthetic",
      probe: {
        streams: [{
          index: 0,
          codec_type: "video",
          codec_name: "h264",
          profile: "High",
          width: 3840,
          height: 2160,
          pix_fmt: "yuv420p",
          time_base: "1/15360",
          r_frame_rate: "60/1",
          avg_frame_rate: "60/1",
          start_pts: "0",
          start_time: "0",
          has_b_frames: 2,
        }],
        frames: ptsTicks.map((pts, index) => ({
          media_type: "video",
          stream_index: 0,
          best_effort_timestamp: String(pts),
          key_frame: index % 60 === 0 ? 1 : 0,
          pict_type: index % 3 === 0 ? "P" : "B",
        })),
      },
    });
    const cfrPts = Array.from({ length: scaleFrameCount }, (_, index) => index * 256);
    const sparseVfrPts = [0];
    const alternatingVfrPts = [0];
    for (let index = 1; index < scaleFrameCount; index += 1) {
      sparseVfrPts.push(sparseVfrPts.at(-1) + (index % 2000 === 0 ? 512 : 256));
      alternatingVfrPts.push(alternatingVfrPts.at(-1) + (index % 2 === 0 ? 257 : 256));
    }
    const scaleCfrPlan = syntheticPlan(cfrPts);
    const scaleSparsePlan = syntheticPlan(sparseVfrPts);
    const scaleAlternatingPlan = syntheticPlan(alternatingVfrPts);
    assert.equal(scaleCfrPlan.presentation.pts.kind, "linear");
    assert.equal(scaleSparsePlan.presentation.pts.kind, "delta-rle");
    assert.equal(scaleAlternatingPlan.presentation.pts.kind, "delta");

    const compiledCfr = createTimingPlanQuery(cfrPlan);
    const queryIterations = 100_000;
    const queryStarted = process.hrtime.bigint();
    let checksum = 0;
    for (let index = 0; index < queryIterations; index += 1) {
      checksum += compiledCfr.atOrBeforeTicks(index % 1200).frameIndex;
    }
    const queryNanoseconds = Number(process.hrtime.bigint() - queryStarted);
    assert.ok(checksum > 0);

    console.log(JSON.stringify({
      passed: true,
      fixtures: {
        cfr: {
          frames: cfrPlan.presentation.frameCount,
          ptsEncoding: cfrPlan.presentation.pts.kind,
          manifestBytes: Buffer.byteLength(JSON.stringify(cfrPlan)),
          hasBFrames: cfrPlan.stream.hasBFrames,
        },
        vfrMissing: {
          frames: vfrPlan.presentation.frameCount,
          pts: expandPresentationPts(vfrPlan),
          ptsEncoding: vfrPlan.presentation.pts.kind,
          deltas: vfrPlan.presentation.pts.deltas,
          manifestBytes: Buffer.byteLength(JSON.stringify(vfrPlan)),
        },
        nonzeroOrigin: {
          originTicks: nonzeroPlan.timeline.presentationOriginTicks,
          editListDetected: nonzeroPlan.timeline.editList.detected,
          manifestBytes: Buffer.byteLength(JSON.stringify(nonzeroPlan)),
        },
        vp9Fallback: {
          frames: vp9Plan.presentation.frameCount,
          timestampSource: vp9Plan.probe.timestampSource,
        },
      },
      queryBenchmark: {
        iterations: queryIterations,
        nanosecondsPerQuery: Math.round(queryNanoseconds / queryIterations),
      },
      scaleSimulation: {
        frames: scaleFrameCount,
        cfrManifestBytes: Buffer.byteLength(JSON.stringify(scaleCfrPlan)),
        sparseVfrManifestBytes: Buffer.byteLength(JSON.stringify(scaleSparsePlan)),
        sparseVfrRuns: scaleSparsePlan.presentation.pts.deltaRuns.length,
        alternatingVfrManifestBytes: Buffer.byteLength(JSON.stringify(scaleAlternatingPlan)),
        alternatingVfrDeltas: scaleAlternatingPlan.presentation.pts.deltas.length,
      },
    }, null, 2));
  } finally {
    await rm(fixtureRoot, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error.stack ?? error.message);
  process.exitCode = 1;
});
