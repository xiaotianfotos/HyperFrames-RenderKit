#!/usr/bin/env node
import assert from "node:assert/strict";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const [
  failedDirectPath,
  failedScreenshotPath,
  completedProductionPath,
  completedScreenshotAPath,
  completedScreenshotBPath,
  determinismReportPath,
  colorReportPath,
] = process.argv.slice(2);
if (!failedDirectPath || !failedScreenshotPath) {
  console.error(
    "Usage: test_compare_metrics.mjs failed-direct.metrics.json failed-screenshot.metrics.json "
    + "[completed-production.metrics.json completed-screenshot-a.metrics.json "
    + "completed-screenshot-b.metrics.json determinism-report.json color-report.json]",
  );
  process.exit(2);
}
const optionalEvidencePaths = [
  completedProductionPath,
  completedScreenshotAPath,
  completedScreenshotBPath,
  determinismReportPath,
  colorReportPath,
];
if (optionalEvidencePaths.some(Boolean) && !optionalEvidencePaths.every(Boolean)) {
  console.error("Provide either all five completed/external evidence paths or none of them");
  process.exit(2);
}
await Promise.all(
  [failedDirectPath, failedScreenshotPath, ...optionalEvidencePaths.filter(Boolean)]
    .map((path) => access(path)),
);

const script = join(dirname(fileURLToPath(import.meta.url)), "compare_metrics.mjs");
const temporaryDirectory = await mkdtemp(join(tmpdir(), "hf-compare-metrics-"));

function run(argumentsList) {
  const result = spawnSync(process.execPath, [script, ...argumentsList], {
    encoding: "utf8",
    maxBuffer: 8 * 1024 * 1024,
  });
  if (result.error) throw result.error;
  return {
    status: result.status,
    output: `${result.stdout ?? ""}\n${result.stderr ?? ""}`,
  };
}

async function writeFixture(name, value) {
  const path = join(temporaryDirectory, `${name}.metrics.json`);
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`);
  return path;
}

function successfulFixture() {
  const renderIdentity = {
    project: "a".repeat(64),
    entry: "b".repeat(64),
    assets: "c".repeat(64),
    timingBundle: "d".repeat(64),
  };
  const allocator = {
    metrics: { allocationFailures: 0 },
    limits: {
      maxTotalLanes: 4,
      maxLanesPerSource: 2,
      readyFramesMax: 4,
      decodeQueueMax: 4,
    },
  };
  const sourceMetric = {
    schemaVersion: "1.0.0",
    sourceIdentity: "e".repeat(64),
    validationFailures: 0,
    activeCursors: 0,
    pendingCleanup: 0,
  };
  const laneMetric = {
    schemaVersion: "1.0.0",
    sourceIdentity: "e".repeat(64),
    configured: true,
    readyFrameCount: 0,
    exactPtsFailures: 0,
    unexpectedOutputs: 0,
    duplicateOutputs: 0,
  };
  function runtimeSnapshot({ outputFrames, activeSources, activeLanes, acquired, closed, sourceMetrics, laneMetrics }) {
    return {
      schemaVersion: "1.0.0",
      exactPtsPass: true,
      validationPass: true,
      cacheRequiredSources: 0,
      canonicalCacheDecisions: 0,
      acquireFailures: 0,
      fallbackFrames: 0,
      protocolErrors: 0,
      outputFrames,
      activeSources,
      activeLanes,
      frameOpen: false,
      allocator: structuredClone(allocator),
      frameBudget: {
        maximumFrames: 24,
        outstandingFrames: acquired - closed,
        acquiredFrames: acquired,
        closedFrames: closed,
      },
      sourceMetrics: structuredClone(sourceMetrics),
      laneMetrics: structuredClone(laneMetrics),
    };
  }
  const brokerZero = {
    schemaVersion: "1.0.0",
    canonicalCacheRequired: 0,
    activeSources: 0,
    activeCursors: 0,
    pendingBegins: 0,
    activeReads: 0,
    protocolErrors: 0,
    byteBudget: {
      maximumBytes: 32 * 1024 * 1024,
      reservations: 1,
      releases: 1,
      currentBytes: 0,
      activeLeases: 0,
      waitingReservations: 0,
    },
  };
  return {
    runId: "strict-success-fixture",
    renderIdentity: structuredClone(renderIdentity),
    config: {
      output: "/tmp/strict-success-fixture.mov",
      width: 320,
      height: 180,
      fps: 60,
      startFrame: 0,
      frames: 1,
      duration: 1 / 60,
      bitrate: 2_000_000,
      bitrateMode: "variable",
      outputBackend: "webcodecs",
      compositeMode: "layered",
      mediaDecoderBackend: "production-webcodecs",
      mediaTargetMode: "timing-plan",
      mediaFrameMode: "video",
      mixProjectAudio: true,
      audioCodec: "pcm_s24le",
      audioSampleRate: 48_000,
    },
    failure: null,
    failureKind: null,
    failureExitCode: 0,
    processWallMs: 110,
    renderer: {
      frames: 1,
      framesCompleted: 1,
      wallMs: 100,
      pendingPayloadBytes: 0,
      frameMetrics: {
        aggregates: { anomalies: { fallback: 0 } },
      },
      support: {
        outputBackend: "webcodecs",
        mediaDecoderBackend: "production-webcodecs",
        productionDecoder: {
          active: true,
          initial: {
            schemaVersion: "1.0.0",
            exactPts: true,
            exactPtsPass: true,
            validationPass: true,
            htmlVideoFallback: false,
            openDecisions: [{
              sourceIdentity: "e".repeat(64),
              decision: "direct-h264-avc1",
            }],
            runtime: runtimeSnapshot({
              outputFrames: 0,
              activeSources: 1,
              activeLanes: 0,
              acquired: 0,
              closed: 0,
              sourceMetrics: [sourceMetric],
              laneMetrics: [],
            }),
          },
          final: {
            beforeDispose: runtimeSnapshot({
              outputFrames: 1,
              activeSources: 1,
              activeLanes: 1,
              acquired: 1,
              closed: 0,
              sourceMetrics: [sourceMetric],
              laneMetrics: [laneMetric],
            }),
            afterDispose: runtimeSnapshot({
              outputFrames: 1,
              activeSources: 0,
              activeLanes: 0,
              acquired: 1,
              closed: 1,
              sourceMetrics: [],
              laneMetrics: [],
            }),
            brokerAfterRendererDispose: structuredClone(brokerZero),
          },
        },
      },
    },
    productionDecoder: {
      route: {
        backend: "production-webcodecs",
        decision: "direct-h264-avc1",
        renderStarted: true,
        sources: [{
          sourceIdentity: "e".repeat(64),
          decision: "direct-h264-avc1",
          summary: {
            codec: "avc",
            sampleEntry: "avc1.640028",
          },
        }],
      },
      brokerAfterDispose: structuredClone(brokerZero),
    },
    memoryWatchdog: {
      peakAggregateRssBytes: 100_000_000,
      minimumAvailableBytes: 1_000_000_000,
      samplesObserved: 2,
      latest: {
        rssBreachCount: 0,
        availableBreachCount: 0,
      },
      violation: null,
    },
    probe: {
      streams: [
        {
          codec_type: "video",
          codec_name: "h264",
          width: 320,
          height: 180,
          pix_fmt: "yuv420p",
          r_frame_rate: "60/1",
          avg_frame_rate: "60/1",
          start_time: "0.000000",
          duration: "0.016667",
          nb_read_frames: "1",
          color_range: "tv",
          color_space: "bt709",
          color_transfer: "bt709",
          color_primaries: "bt709",
        },
        {
          codec_type: "audio",
          codec_name: "pcm_s24le",
          sample_rate: "48000",
          channels: 2,
          channel_layout: "stereo",
          start_time: "0.000000",
          duration: "0.016667",
        },
      ],
      format: { duration: "0.016667" },
    },
    decodedAudio: {
      frameCount: 1,
      samplesPerChannel: 800,
    },
    colorValidation: {
      renderIdentity: structuredClone(renderIdentity),
      pixelPass: true,
      contractPass: true,
    },
    outputCommit: {
      schemaVersion: "1.0.0",
      runId: "strict-success-fixture",
      finalOutput: "/tmp/strict-success-fixture.mov",
      stagingOutput: "/tmp/.strict-success-fixture.mov.hf-partial-strict-success-fixture.mov",
      renderIdentity: structuredClone(renderIdentity),
      committed: true,
      partialRemoved: false,
    },
  };
}

function successfulScreenshotFixture() {
  const fixture = successfulFixture();
  fixture.runId = "strict-screenshot-success-fixture";
  Object.assign(fixture.config, {
    output: "/tmp/strict-screenshot-success-fixture.mov",
    outputBackend: "screenshot",
    compositeMode: "screenshot",
    mediaDecoderBackend: "html-video",
    mediaTargetMode: "timing-plan",
    mediaFrameMode: "video",
    mediaSeekBiasFrames: 0,
    mediaOvershootToleranceFrames: 1 / 3,
    mediaAdvanceMode: "playback-step",
    screenshotEncoder: "videotoolbox",
    screenshotMediaPolicy: "faithful",
    screenshotMediaPolicyRequested: "faithful",
    screenshotMediaRequestGate: true,
    screenshotEntryTransform: {
      kind: "hyperframes-screenshot-entry-audit",
      domMutations: 0,
    },
  });
  fixture.renderer.support = {
    outputBackend: "screenshot",
    mediaDecoderBackend: "html-video",
    screenshotCapture: {
      sequential: true,
      authoredDomMutations: 0,
      mediaPolicy: "faithful",
      mediaRequestGate: true,
      entryTransform: {
        kind: "hyperframes-screenshot-entry-audit",
        domMutations: 0,
      },
    },
  };
  delete fixture.productionDecoder;
  fixture.screenshotSequence = {
    expectedFrames: 1,
    capturedFrames: 1,
    frameHashSequence: {
      framesObserved: 1,
      sequenceSha256: "9".repeat(64),
    },
    mediaGate: {
      requestedPolicy: "faithful",
      policy: "faithful",
      finalActiveUrls: 0,
      finalActiveLeases: 0,
    },
  };
  Object.assign(fixture.outputCommit, {
    runId: fixture.runId,
    finalOutput: fixture.config.output,
    stagingOutput: "/tmp/.strict-screenshot-success-fixture.mov.hf-partial-strict-screenshot-success-fixture.mov",
  });
  return fixture;
}

function pathSegments(path) {
  return String(path).match(/[^.[\]]+/g) ?? [];
}

function parentAtPath(value, path) {
  const segments = pathSegments(path);
  const key = segments.pop();
  let parent = value;
  for (const segment of segments) parent = parent[segment];
  return { parent, key };
}

function setAtPath(value, path, replacement) {
  const { parent, key } = parentAtPath(value, path);
  parent[key] = replacement;
}

function deleteAtPath(value, path) {
  const { parent, key } = parentAtPath(value, path);
  delete parent[key];
}

async function assertRejected(name, mutate, expectedFragment) {
  return assertRejectedFrom(successfulFixture, name, mutate, expectedFragment);
}

async function assertRejectedFrom(factory, name, mutate, expectedFragment) {
  const fixture = factory();
  mutate(fixture);
  const candidate = await writeFixture(name, fixture);
  const result = run(["--strict", candidate, candidate]);
  assert.equal(result.status, 1, `${name} should fail closed\n${result.output}`);
  const expected = expectedFragment instanceof RegExp
    ? expectedFragment
    : new RegExp(expectedFragment, "i");
  assert.match(result.output, expected, `${name} should explain its rejection`);
}

try {
  const acceptedA = await writeFixture("accepted-a", successfulFixture());
  const acceptedBValue = successfulFixture();
  acceptedBValue.runId = "strict-success-fixture-second-run";
  acceptedBValue.outputCommit.runId = acceptedBValue.runId;
  acceptedBValue.outputCommit.stagingOutput = "/tmp/.strict-success-fixture.mov.hf-partial-strict-success-fixture-second-run.mov";
  acceptedBValue.processWallMs = 100;
  acceptedBValue.renderer.wallMs = 90;
  const acceptedB = await writeFixture("accepted-b", acceptedBValue);
  const accepted = run(["--strict", acceptedA, acceptedB]);
  assert.equal(accepted.status, 0, `complete fixtures should pass strict comparison\n${accepted.output}`);
  assert.match(accepted.output, /accepted/);
  assert.match(accepted.output, /1\.111x/);

  const acceptedScreenshotA = await writeFixture("accepted-screenshot-a", successfulScreenshotFixture());
  const acceptedScreenshotB = await writeFixture("accepted-screenshot-b", successfulScreenshotFixture());
  const acceptedScreenshot = run(["--strict", acceptedScreenshotA, acceptedScreenshotB]);
  assert.equal(acceptedScreenshot.status, 0,
    `faithful screenshot fixtures should pass strict comparison\n${acceptedScreenshot.output}`);
  assert.match(acceptedScreenshot.output, /faithful-screenshot/);

  const failedDirect = run(["--strict", failedDirectPath, failedDirectPath]);
  assert.equal(failedDirect.status, 1, `actual failed direct metric must be rejected\n${failedDirect.output}`);
  assert.match(failedDirect.output, /failed/);
  assert.match(failedDirect.output, /\?\/3/,
    "missing completion evidence must not be rewritten as 3/3");

  const failedScreenshot = run(["--strict", failedScreenshotPath, failedScreenshotPath]);
  assert.equal(failedScreenshot.status, 1, `actual failed screenshot metric must be rejected\n${failedScreenshot.output}`);
  assert.match(failedScreenshot.output, /failed/);
  assert.match(failedScreenshot.output, /0\/1/,
    "explicit zero captured frames must remain 0/1");

  if (optionalEvidencePaths.every(Boolean)) {
    const completedProduction = run([
      "--strict", completedProductionPath, completedProductionPath,
    ]);
    assert.equal(completedProduction.status, 1,
      "completed production metrics must remain unverified until their external pixel gate is bound");
    assert.match(completedProduction.output, /61\/61/);
    assert.match(completedProduction.output, /exact_pts_err.*0|│ '0'\s+│ '0'\s+│ 'tags-only'/s);
    assert.match(completedProduction.output, /pixel\/color gate evidence is missing/);

    const completedScreenshot = run([
      "--strict", completedScreenshotAPath, completedScreenshotBPath,
    ]);
    assert.equal(completedScreenshot.status, 1,
      "legacy screenshot metrics must remain unverified until derived identity and color evidence are bound");
    assert.match(completedScreenshot.output, /61\/61/);
    assert.match(completedScreenshot.output, /renderIdentity\.project/);
    assert.match(completedScreenshot.output, /pixel\/color gate evidence is missing/);

    const determinismReport = JSON.parse(await readFile(determinismReportPath, "utf8"));
    assert.equal(determinismReport.ok, true);
    assert.equal(determinismReport.checks.every((check) => check.pass === true), true);
    const colorReport = JSON.parse(await readFile(colorReportPath, "utf8"));
    assert.equal(colorReport.pass, true);
    const positiveColor = colorReport.variants?.find((variant) => variant.id === "positive-bt709-limited");
    assert.equal(positiveColor?.colorPass, true);
    assert.equal(positiveColor?.contractPass, true);
    assert.equal(positiveColor?.expectationMet, true);

    const selfContainedProduction = JSON.parse(await readFile(completedProductionPath, "utf8"));
    selfContainedProduction.colorValidation = {
      renderIdentity: structuredClone(selfContainedProduction.renderIdentity),
      pixelPass: true,
      contractPass: true,
    };
    const selfContainedPath = await writeFixture("real-61f-with-explicit-pixel-gate", selfContainedProduction);
    const selfContainedResult = run(["--strict", selfContainedPath, selfContainedPath]);
    assert.equal(selfContainedResult.status, 1,
      `legacy real 61f metrics must remain unverified without v1 strict lifecycle/commit evidence\n${selfContainedResult.output}`);
    assert.match(selfContainedResult.output, /initial\.schemaVersion missing/);
    assert.match(selfContainedResult.output, /outputCommit\.schemaVersion missing/);

    const realMutations = [
      ["real-61f-1080p", (metric) => {
        const stream = metric.probe.streams.find((candidate) => candidate.codec_type === "video");
        stream.width = 1920;
        stream.height = 1080;
      }, /probed width 1920, expected 3840/],
      ["real-61f-30fps", (metric) => {
        const stream = metric.probe.streams.find((candidate) => candidate.codec_type === "video");
        stream.r_frame_rate = "30/1";
        stream.avg_frame_rate = "30/1";
      }, /probed r_frame_rate 30\/1, expected 60/],
      ["real-61f-start-one", (metric) => {
        const stream = metric.probe.streams.find((candidate) => candidate.codec_type === "video");
        stream.start_time = "1.000000";
      }, /probed video start_time 1.000000, expected 0/],
      ["real-61f-duration-two", (metric) => {
        const stream = metric.probe.streams.find((candidate) => candidate.codec_type === "video");
        stream.duration = "2.033333";
        metric.probe.format.duration = "2.033333";
      }, /probed video duration 2.033333/],
      ["real-61f-software-fallback", (metric) => {
        metric.productionDecoder.route.decision = "software-fallback";
      }, /production route decision software-fallback is not allowed/],
    ];
    for (const [name, mutate, expected] of realMutations) {
      const metric = structuredClone(selfContainedProduction);
      mutate(metric);
      const path = await writeFixture(name, metric);
      const result = run(["--strict", path, path]);
      assert.equal(result.status, 1, `${name} must fail closed\n${result.output}`);
      assert.match(result.output, expected);
    }
    console.log(
      "completed 61f main metrics are intact; strict correctly requires identity-bound color evidence "
      + "and the versioned lifecycle/atomic-commit schema before bundle-level GO",
    );
  }

  await assertRejected("missing-completed", (fixture) => {
    delete fixture.renderer.framesCompleted;
    delete fixture.probe.streams[0].nb_read_frames;
  }, "completed frame evidence is missing");
  await assertRejected("missing-fallback", (fixture) => {
    delete fixture.renderer.frameMetrics.aggregates.anomalies.fallback;
  }, "fallback count is missing");
  await assertRejected("missing-exact-pts", (fixture) => {
    delete fixture.renderer.support.productionDecoder.final.beforeDispose.laneMetrics[0].exactPtsFailures;
  }, "exactPtsFailures counter is missing");
  await assertRejected("missing-resource-zero", (fixture) => {
    delete fixture.productionDecoder.brokerAfterDispose.byteBudget.activeLeases;
  }, "broker.activeLeases is missing");
  await assertRejected("missing-probe", (fixture) => {
    delete fixture.probe;
  }, "final output probe is missing");
  await assertRejected("probe-resolution-mismatch", (fixture) => {
    fixture.probe.streams[0].width = 1920;
    fixture.probe.streams[0].height = 1080;
  }, "probed width 1920, expected 320");
  await assertRejected("probe-fps-mismatch", (fixture) => {
    fixture.probe.streams[0].r_frame_rate = "30/1";
    fixture.probe.streams[0].avg_frame_rate = "30/1";
  }, "probed r_frame_rate 30/1, expected 60");
  await assertRejected("probe-nonzero-start", (fixture) => {
    fixture.probe.streams[0].start_time = "1.000000";
  }, "probed video start_time 1.000000, expected 0");
  await assertRejected("probe-duration-mismatch", (fixture) => {
    fixture.probe.streams[0].duration = "2.033333";
    fixture.probe.format.duration = "2.033333";
  }, "probed video duration 2.033333");
  await assertRejected("probe-codec-mismatch", (fixture) => {
    fixture.probe.streams[0].codec_name = "hevc";
  }, "probed video codec hevc, allowed h264");
  await assertRejected("probe-pixel-format-mismatch", (fixture) => {
    fixture.probe.streams[0].pix_fmt = "yuv420p10le";
  }, "probed pixel format yuv420p10le, allowed yuv420p");
  await assertRejected("probe-color-mismatch", (fixture) => {
    fixture.probe.streams[0].color_primaries = "bt2020";
  }, "probed color_primaries bt2020, expected bt709");
  await assertRejected("software-fallback-route", (fixture) => {
    fixture.productionDecoder.route.decision = "software-fallback";
  }, "production route decision software-fallback is not allowed");
  await assertRejected("renderer-backend-mismatch", (fixture) => {
    fixture.renderer.support.outputBackend = "screenshot";
  }, "renderer outputBackend screenshot differs from config webcodecs");
  await assertRejected("tags-without-pixel-gate", (fixture) => {
    delete fixture.colorValidation;
  }, "pixel/color gate evidence is missing");
  await assertRejected("pixel-pass-contract-fail", (fixture) => {
    fixture.colorValidation.contractPass = false;
  }, "decoded color contract gate failed");
  await assertRejected("conflicting-pixel-booleans", (fixture) => {
    fixture.colorValidation.pixelsPass = false;
  }, "decoded pixel/color gate failed");
  await assertRejected("second-pixel-source-fails", (fixture) => {
    fixture.colorValidation.evidenceIdentity = "6".repeat(64);
    fixture.colorEvidence = {
      renderIdentity: structuredClone(fixture.renderIdentity),
      evidenceIdentity: "6".repeat(64),
      pixelPass: false,
      contractPass: true,
    };
  }, "decoded pixel/color gate failed");
  await assertRejected("pixel-evidence-identity-conflict", (fixture) => {
    fixture.colorValidation.evidenceIdentity = "6".repeat(64);
    fixture.colorEvidence = {
      renderIdentity: structuredClone(fixture.renderIdentity),
      evidenceIdentity: "7".repeat(64),
      pixelPass: true,
      contractPass: true,
    };
  }, "pixel/color evidence identities conflict");
  await assertRejected("missing-no-audio-contract", (fixture) => {
    fixture.config.mixProjectAudio = false;
    fixture.probe.streams = fixture.probe.streams.filter((stream) => stream.codec_type !== "audio");
    delete fixture.decodedAudio;
  }, "no-audio contract requires decodedAudio: null");
  await assertRejected("no-audio-stream-conflict", (fixture) => {
    fixture.config.mixProjectAudio = false;
    fixture.decodedAudio = null;
  }, "no-audio contract produced 1 audio stream");
  await assertRejected("multiple-audio-streams", (fixture) => {
    fixture.probe.streams.push(structuredClone(fixture.probe.streams[1]));
  }, "PCM contract requires exactly one audio stream, found 2");
  await assertRejected("mono-audio", (fixture) => {
    fixture.probe.streams[1].channels = 1;
    fixture.probe.streams[1].channel_layout = "mono";
  }, "probed audio channels 1, required 2");
  await assertRejected("surround-audio", (fixture) => {
    fixture.probe.streams[1].channels = 8;
    fixture.probe.streams[1].channel_layout = "7.1";
  }, "probed audio channels 8, required 2");
  await assertRejected("missing-audio-layout", (fixture) => {
    delete fixture.probe.streams[1].channel_layout;
  }, "probed audio channel_layout missing, required stereo");
  await assertRejected("nonzero-audio-start", (fixture) => {
    fixture.probe.streams[1].start_time = "3.000000";
  }, "probed audio start_time 3.000000");
  await assertRejected("wrong-audio-duration", (fixture) => {
    fixture.probe.streams[1].duration = "99.000000";
  }, "probed audio duration 99.000000");
  await assertRejected("wrong-audio-codec", (fixture) => {
    fixture.probe.streams[1].codec_name = "aac";
  }, "probed audio codec aac, required pcm_s24le");
  await assertRejected("missing-decoded-audio-frame-count", (fixture) => {
    delete fixture.decodedAudio.frameCount;
  }, "decoded audio frameCount is missing");
  await assertRejected("non-integral-audio-without-policy", (fixture) => {
    fixture.config.fps = "30000/1001";
    fixture.probe.streams[0].avg_frame_rate = "30000/1001";
    fixture.decodedAudio.samplesPerChannel = 1602;
  }, "non-integral audio schedule lacks");
  await assertRejected("not-atomically-committed", (fixture) => {
    fixture.outputCommit.committed = false;
  }, "not atomically committed");
  await assertRejected("failure-with-zero-exit", (fixture) => {
    fixture.failure = "synthetic render failure";
    fixture.failureKind = "render-failure";
  }, "render reported failure");

  const productionAntiEvidenceMutations = [
    ["production-exact-pts-false", "renderer.support.productionDecoder.initial.exactPts", false, /exactPts is false/],
    ["production-html-video-fallback", "renderer.support.productionDecoder.initial.htmlVideoFallback", true, /htmlVideoFallback is true/],
    ["production-cache-required-source", "renderer.support.productionDecoder.initial.runtime.cacheRequiredSources", 1, /cacheRequiredSources is 1/],
    ["production-canonical-cache-decision", "renderer.support.productionDecoder.initial.runtime.canonicalCacheDecisions", 1, /canonicalCacheDecisions is 1/],
    ["production-acquire-failure", "renderer.support.productionDecoder.initial.runtime.acquireFailures", 1, /acquireFailures is 1/],
    ["production-validation-failure", "renderer.support.productionDecoder.initial.runtime.sourceMetrics.0.validationFailures", 1, /validationFailures is 1/],
    ["production-allocation-failure", "renderer.support.productionDecoder.initial.runtime.allocator.metrics.allocationFailures", 1, /allocationFailures is 1/],
    ["production-canonical-required", "productionDecoder.brokerAfterDispose.canonicalCacheRequired", 1, /canonicalCacheRequired is 1/],
  ];
  for (const [name, path, replacement, expected] of productionAntiEvidenceMutations) {
    await assertRejected(name, (fixture) => setAtPath(fixture, path, replacement), expected);
  }
  await assertRejected("production-open-decision-cache-required", (fixture) => {
    fixture.renderer.support.productionDecoder.initial.openDecisions[0].decision = "CACHE_REQUIRED_HEVC";
  }, /CACHE_REQUIRED_HEVC/);
  await assertRejected("production-open-decision-identity-drift", (fixture) => {
    fixture.renderer.support.productionDecoder.initial.openDecisions[0].sourceIdentity = "f".repeat(64);
  }, /does not match an approved route source identity/);
  await assertRejected("production-source-metric-identity-drift", (fixture) => {
    fixture.renderer.support.productionDecoder.final.beforeDispose.sourceMetrics[0].sourceIdentity = "f".repeat(64);
  }, /does not match an approved route source identity/);
  await assertRejected("production-source-cache-decision", (fixture) => {
    fixture.productionDecoder.route.sources[0].decision = "CACHE_REQUIRED_HEVC";
  }, /CACHE_REQUIRED_HEVC/);
  await assertRejected("production-explicit-failure-stage", (fixture) => {
    fixture.renderer.support.productionDecoder.failureStages = { acquire: 1 };
  }, /failureStages contains explicit error\/failure evidence/);

  const colorBooleanMutations = [
    ["color-root-pass-false", (fixture) => { fixture.colorValidation.pass = false; }, /colorValidation\.pass/],
    ["color-color-pass-false", (fixture) => { fixture.colorValidation.colorPass = false; }, /colorValidation\.colorPass/],
    ["color-expectation-false", (fixture) => { fixture.colorValidation.expectationMet = false; }, /expectationMet/],
    ["color-contract-nested-false", (fixture) => { fixture.colorValidation.contract = { pass: false }; }, /contract\.pass/],
    ["color-pixel-nested-false", (fixture) => { fixture.colorValidation.pixel = { pass: false }; }, /pixel\.pass/],
    ["color-schema-array-pass-false", (fixture) => {
      fixture.colorValidation.checks = [{ kind: "decoded-pixel-gate", pass: false }];
    }, /checks\[0\]\.pass/],
  ];
  for (const [name, mutate, expected] of colorBooleanMutations) {
    await assertRejected(name, mutate, expected);
  }
  await assertRejected("color-second-source-root-pass-false", (fixture) => {
    fixture.colorValidation.evidenceIdentity = "6".repeat(64);
    fixture.colorEvidence = { evidenceIdentity: "6".repeat(64), pass: false };
    fixture.colorEvidence.renderIdentity = structuredClone(fixture.renderIdentity);
  }, /colorEvidence\.pass/);
  await assertRejected("color-output-second-source-pass-false", (fixture) => {
    fixture.colorValidation.evidenceIdentity = "6".repeat(64);
    fixture.outputValidation = {
      color: {
        renderIdentity: structuredClone(fixture.renderIdentity),
        evidenceIdentity: "6".repeat(64),
        pass: false,
      },
    };
  }, /outputValidation\.color\.pass/);
  await assertRejected("color-null-evidence-identity", (fixture) => {
    fixture.colorValidation.evidenceIdentity = null;
  }, /identity is empty or non-canonical/);
  await assertRejected("color-empty-evidence-identity", (fixture) => {
    fixture.colorValidation.evidenceIdentity = "";
  }, /identity is empty or non-canonical/);
  await assertRejected("color-second-source-null-identity", (fixture) => {
    fixture.colorValidation.evidenceIdentity = "6".repeat(64);
    fixture.colorEvidence = { evidenceIdentity: null, pass: true };
    fixture.colorEvidence.renderIdentity = structuredClone(fixture.renderIdentity);
  }, /identity is empty or non-canonical/);

  const unrelatedColorPass = successfulFixture();
  unrelatedColorPass.colorValidation.performance = { pass: false };
  const unrelatedColorPassPath = await writeFixture("color-unrelated-pass-is-not-a-gate", unrelatedColorPass);
  const unrelatedColorPassResult = run(["--strict", unrelatedColorPassPath, unrelatedColorPassPath]);
  assert.equal(unrelatedColorPassResult.status, 0,
    `an unrelated nested pass must not be mistaken for color evidence\n${unrelatedColorPassResult.output}`);

  const screenshotMutations = [
    ["screenshot-missing-media-policy", (fixture) => { delete fixture.config.screenshotMediaPolicy; }, /media policy missing/],
    ["screenshot-unapproved-media-policy", (fixture) => { fixture.config.screenshotMediaPolicy = "nearest-frame"; }, /not faithful or bounded-static/],
    ["screenshot-config-request-gate-false", (fixture) => { fixture.config.screenshotMediaRequestGate = false; }, /mediaRequestGate=true/],
    ["screenshot-capture-request-gate-false", (fixture) => { fixture.renderer.support.screenshotCapture.mediaRequestGate = false; }, /mediaRequestGate=true/],
    ["screenshot-nearest-frame-target", (fixture) => { fixture.config.mediaTargetMode = "nearest-frame"; }, /expected timing-plan/],
    ["screenshot-nonzero-seek-bias", (fixture) => { fixture.config.mediaSeekBiasFrames = 1; }, /mediaSeekBiasFrames 1/],
    ["screenshot-config-dom-mutation", (fixture) => { fixture.config.screenshotEntryTransform.domMutations = 1; }, /config entry-transform domMutations is 1/],
    ["screenshot-capture-dom-mutation", (fixture) => { fixture.renderer.support.screenshotCapture.entryTransform.domMutations = 1; }, /capture entry-transform domMutations is 1/],
    ["screenshot-authored-dom-mutation", (fixture) => { fixture.renderer.support.screenshotCapture.authoredDomMutations = 1; }, /authoredDomMutations is 1/],
    ["screenshot-missing-expected-frames", (fixture) => { delete fixture.screenshotSequence.expectedFrames; }, /expectedFrames missing/],
    ["screenshot-missing-captured-frames", (fixture) => { delete fixture.screenshotSequence.capturedFrames; }, /capturedFrames missing/],
    ["screenshot-hash-frame-count-drift", (fixture) => { fixture.screenshotSequence.frameHashSequence.framesObserved = 0; }, /framesObserved 0/],
    ["screenshot-missing-sequence-hash", (fixture) => { delete fixture.screenshotSequence.frameHashSequence.sequenceSha256; }, /sequenceSha256 is missing/],
    ["screenshot-media-gate-policy-drift", (fixture) => { fixture.screenshotSequence.mediaGate.policy = "bounded-static"; }, /mediaGate policy differs/],
    ["screenshot-nonsequential", (fixture) => { fixture.renderer.support.screenshotCapture.sequential = false; }, /sequential=true/],
    ["screenshot-explicit-nearest-frame", (fixture) => { fixture.renderer.support.screenshotCapture.nearestFrameSelections = 1; }, /nearest-frame path/],
  ];
  for (const [name, mutate, expected] of screenshotMutations) {
    await assertRejectedFrom(successfulScreenshotFixture, name, mutate, expected);
  }

  const deletionProperties = [
    [successfulFixture, "production-delete-route", "productionDecoder.route", /route proof is missing/],
    [successfulFixture, "production-delete-route-source-identity", "productionDecoder.route.sources.0.sourceIdentity", /identity is missing or invalid/],
    [successfulFixture, "production-delete-probe-frame-count", "probe.streams.0.nb_read_frames", /nb_read_frames is missing/],
    [successfulFixture, "production-delete-lane-counter", "renderer.support.productionDecoder.final.beforeDispose.laneMetrics.0.unexpectedOutputs", /unexpectedOutputs counter is missing/],
    [successfulFixture, "production-delete-render-identity", "renderIdentity.assets", /renderIdentity\.assets/],
    [successfulFixture, "production-delete-atomic-proof", "outputCommit.committed", /atomically committed/],
    [successfulScreenshotFixture, "screenshot-delete-config-transform", "config.screenshotEntryTransform", /config entry-transform/],
    [successfulScreenshotFixture, "screenshot-delete-capture-transform", "renderer.support.screenshotCapture.entryTransform", /capture entry-transform/],
    [successfulScreenshotFixture, "screenshot-delete-media-gate", "screenshotSequence.mediaGate", /mediaGate proof is missing/],
    [successfulScreenshotFixture, "screenshot-delete-hash-sequence", "screenshotSequence.frameHashSequence", /frameHashSequence proof is missing/],
  ];
  for (const [factory, name, path, expected] of deletionProperties) {
    await assertRejectedFrom(factory, name, (fixture) => deleteAtPath(fixture, path), expected);
  }
  console.log(
    `systematic anti-evidence mutations passed: ${productionAntiEvidenceMutations.length
      + colorBooleanMutations.length + screenshotMutations.length + deletionProperties.length + 10}`,
  );

  const v4SchemaMutations = [
    [successfulFixture, "v4-initial-schema-missing", (fixture) => {
      delete fixture.renderer.support.productionDecoder.initial.schemaVersion;
    }, /initial\.schemaVersion missing/],
    [successfulFixture, "v4-initial-exact-pass-false", (fixture) => {
      fixture.renderer.support.productionDecoder.initial.exactPtsPass = false;
    }, /initial\.exactPtsPass is false/],
    [successfulFixture, "v4-initial-validation-pass-missing", (fixture) => {
      delete fixture.renderer.support.productionDecoder.initial.validationPass;
    }, /initial\.validationPass is missing/],
    [successfulFixture, "v4-html-fallback-wrong-type", (fixture) => {
      fixture.renderer.support.productionDecoder.initial.htmlVideoFallback = "false";
    }, /htmlVideoFallback.*not boolean|htmlVideoFallback must be boolean/],
    [successfulFixture, "v4-cache-required-wrong-type", (fixture) => {
      fixture.renderer.support.productionDecoder.initial.cacheRequired = 0;
    }, /cacheRequired must be boolean/],
    [successfulFixture, "v4-runtime-exact-pass-false", (fixture) => {
      fixture.renderer.support.productionDecoder.initial.runtime.exactPtsPass = false;
    }, /runtime\.exactPtsPass/],
    [successfulFixture, "v4-runtime-validation-pass-false", (fixture) => {
      fixture.renderer.support.productionDecoder.initial.runtime.validationPass = false;
    }, /runtime\.validationPass/],
    [successfulFixture, "v4-runtime-cache-counter-missing", (fixture) => {
      delete fixture.renderer.support.productionDecoder.initial.runtime.cacheRequiredSources;
    }, /cacheRequiredSources is missing/],
    [successfulFixture, "v4-runtime-cache-counter-string", (fixture) => {
      fixture.renderer.support.productionDecoder.initial.runtime.canonicalCacheDecisions = "0";
    }, /canonicalCacheDecisions.*number 0|canonicalCacheDecisions is missing or invalid/],
    [successfulFixture, "v4-runtime-protocol-error", (fixture) => {
      fixture.renderer.support.productionDecoder.initial.runtime.protocolErrors = 1;
    }, /protocolErrors/],
    [successfulFixture, "v4-runtime-source-metrics-missing", (fixture) => {
      delete fixture.renderer.support.productionDecoder.initial.runtime.sourceMetrics;
    }, /sourceMetrics is missing/],
    [successfulFixture, "v4-source-schema-wrong", (fixture) => {
      fixture.renderer.support.productionDecoder.initial.runtime.sourceMetrics[0].schemaVersion = "2.0.0";
    }, /sourceMetrics\[0\]\.schemaVersion/],
    [successfulFixture, "v4-source-active-cursor-type", (fixture) => {
      fixture.renderer.support.productionDecoder.initial.runtime.sourceMetrics[0].activeCursors = "0";
    }, /activeCursors is missing or invalid/],
    [successfulFixture, "v4-before-lanes-missing", (fixture) => {
      delete fixture.renderer.support.productionDecoder.final.beforeDispose.laneMetrics;
    }, /laneMetrics is missing/],
    [successfulFixture, "v4-lane-configured-false", (fixture) => {
      fixture.renderer.support.productionDecoder.final.beforeDispose.laneMetrics[0].configured = false;
    }, /configured is false/],
    [successfulFixture, "v4-lane-ready-type", (fixture) => {
      fixture.renderer.support.productionDecoder.final.beforeDispose.laneMetrics[0].readyFrameCount = "0";
    }, /readyFrameCount is missing or invalid/],
    [successfulFixture, "v4-before-schema-missing", (fixture) => {
      delete fixture.renderer.support.productionDecoder.final.beforeDispose.schemaVersion;
    }, /beforeDispose\.schemaVersion missing/],
    [successfulFixture, "v4-before-output-count-drift", (fixture) => {
      fixture.renderer.support.productionDecoder.final.beforeDispose.outputFrames = 0;
    }, /outputFrames is 0, expected 1/],
    [successfulFixture, "v4-before-budget-missing", (fixture) => {
      delete fixture.renderer.support.productionDecoder.final.beforeDispose.frameBudget;
    }, /frameBudget is missing/],
    [successfulFixture, "v4-before-budget-maximum-zero", (fixture) => {
      fixture.renderer.support.productionDecoder.final.beforeDispose.frameBudget.maximumFrames = 0;
    }, /maximumFrames must be positive/],
    [successfulFixture, "v4-before-budget-relation", (fixture) => {
      fixture.renderer.support.productionDecoder.final.beforeDispose.frameBudget.closedFrames = 1;
    }, /acquired-closed does not equal outstandingFrames/],
    [successfulFixture, "v4-allocator-missing", (fixture) => {
      delete fixture.renderer.support.productionDecoder.final.beforeDispose.allocator;
    }, /allocator metrics\/limits evidence is missing/],
    [successfulFixture, "v4-allocator-limit-zero", (fixture) => {
      fixture.renderer.support.productionDecoder.final.beforeDispose.allocator.limits.maxTotalLanes = 0;
    }, /maxTotalLanes must be positive/],
    [successfulFixture, "v4-after-exact-pass-missing", (fixture) => {
      delete fixture.renderer.support.productionDecoder.final.afterDispose.exactPtsPass;
    }, /afterDispose\.exactPtsPass is missing/],
    [successfulFixture, "v4-after-active-source-leak", (fixture) => {
      fixture.renderer.support.productionDecoder.final.afterDispose.activeSources = 1;
    }, /activeSources is 1, expected 0/],
    [successfulFixture, "v4-after-frame-open", (fixture) => {
      fixture.renderer.support.productionDecoder.final.afterDispose.frameOpen = true;
    }, /frameOpen is true/],
    [successfulFixture, "v4-after-outstanding-frame", (fixture) => {
      const budget = fixture.renderer.support.productionDecoder.final.afterDispose.frameBudget;
      budget.outstandingFrames = 1;
      budget.acquiredFrames = 2;
    }, /outstandingFrames is 1, expected 0/],
    [successfulFixture, "v4-broker-schema-wrong", (fixture) => {
      fixture.renderer.support.productionDecoder.final.brokerAfterRendererDispose.schemaVersion = "2.0.0";
    }, /brokerAfterRendererDispose\.schemaVersion/],
    [successfulFixture, "v4-broker-protocol-error", (fixture) => {
      fixture.renderer.support.productionDecoder.final.brokerAfterRendererDispose.protocolErrors = 1;
    }, /brokerAfterRendererDispose\.protocolErrors/],
    [successfulFixture, "v4-broker-maximum-missing", (fixture) => {
      delete fixture.renderer.support.productionDecoder.final.brokerAfterRendererDispose.byteBudget.maximumBytes;
    }, /maximumBytes is missing/],
    [successfulFixture, "v4-broker-release-drift", (fixture) => {
      fixture.renderer.support.productionDecoder.final.brokerAfterRendererDispose.byteBudget.releases = 0;
    }, /reservations 1 differ from releases 0/],
    [successfulFixture, "v4-main-broker-byte-leak", (fixture) => {
      fixture.productionDecoder.brokerAfterDispose.byteBudget.currentBytes = 1;
    }, /currentBytes/],
    [successfulFixture, "v4-production-generic-pass-false", (fixture) => {
      fixture.renderer.support.productionDecoder.final.validation = { pass: false };
    }, /validation\.pass must be boolean true/],
    [successfulFixture, "v4-production-emergency-route", (fixture) => {
      fixture.renderer.support.productionDecoder.final.emergencyRoute = "emergency-software";
    }, /fallback\/emergency|forbidden route evidence/],
    [successfulFixture, "v4-watchdog-peak-missing", (fixture) => {
      delete fixture.memoryWatchdog.peakAggregateRssBytes;
    }, /peakAggregateRssBytes is missing/],
    [successfulFixture, "v4-watchdog-minimum-string", (fixture) => {
      fixture.memoryWatchdog.minimumAvailableBytes = "1000000000";
    }, /minimum available bytes is missing, invalid, or contradictory/],
    [successfulFixture, "v4-watchdog-final-error", (fixture) => {
      fixture.memoryWatchdog.finalError = "sampler failed";
    }, /watchdog error\/failure evidence/],
    [successfulFixture, "v4-final-error", (fixture) => {
      fixture.finalError = "late validation error";
    }, /finalError contains explicit final error/],
    [successfulFixture, "v4-renderer-frame-error", (fixture) => {
      fixture.renderer.frameMetrics.framesErrored = 1;
    }, /framesErrored contains explicit error\/failure evidence/],
    [successfulFixture, "v4-top-support-production-pass-false", (fixture) => {
      fixture.support = { productionDecoder: { validation: { pass: false } } };
    }, /support\.productionDecoder\.validation\.pass/],
    [successfulFixture, "v4-color-direct-pixel-missing", (fixture) => {
      delete fixture.colorValidation.pixelPass;
    }, /colorValidation\.pixelPass must be explicitly/],
    [successfulFixture, "v4-color-binding-missing", (fixture) => {
      delete fixture.colorValidation.renderIdentity;
    }, /not bound to the main renderIdentity/],
    [successfulFixture, "v4-color-binding-foreign", (fixture) => {
      fixture.colorValidation.renderIdentity.entry = "f".repeat(64);
    }, /binding differs from the main renderIdentity/],
    [successfulFixture, "v4-color-scalar-identity-not-main-digest", (fixture) => {
      fixture.colorValidation.evidenceIdentity = "6".repeat(64);
    }, /not bound to the main renderIdentity digest/],
    [successfulFixture, "v4-atomic-schema-missing", (fixture) => {
      delete fixture.outputCommit.schemaVersion;
    }, /outputCommit\.schemaVersion missing/],
    [successfulFixture, "v4-atomic-runid-drift", (fixture) => {
      fixture.outputCommit.runId = "other-run";
    }, /outputCommit\.runId differs/],
    [successfulFixture, "v4-atomic-final-drift", (fixture) => {
      fixture.outputCommit.finalOutput = "/tmp/other.mov";
    }, /finalOutput differs/],
    [successfulFixture, "v4-atomic-staging-foreign-dir", (fixture) => {
      fixture.outputCommit.stagingOutput = "/var/tmp/.strict.mov.hf-partial-strict-success-fixture.mov";
    }, /share a destination filesystem directory/],
    [successfulFixture, "v4-atomic-render-identity-missing", (fixture) => {
      delete fixture.outputCommit.renderIdentity;
    }, /outputCommit\.renderIdentity is missing/],
    [successfulScreenshotFixture, "v4-screenshot-explicit-error", (fixture) => {
      fixture.renderer.support.screenshotCapture.captureErrors = 1;
    }, /captureErrors contains explicit error\/failure evidence/],
    [successfulScreenshotFixture, "v4-screenshot-explicit-pass-false", (fixture) => {
      fixture.renderer.support.screenshotCapture.validation = { pass: false };
    }, /validation\.pass must be boolean true/],
    [successfulScreenshotFixture, "v4-screenshot-emergency", (fixture) => {
      fixture.screenshotSequence.emergencyRoute = "emergency-capture";
    }, /fallback\/emergency|forbidden route evidence/],
    [successfulScreenshotFixture, "v4-screenshot-resource-leak", (fixture) => {
      fixture.screenshotSequence.mediaGate.finalActiveUrls = 1;
    }, /finalActiveUrls/],
    [successfulScreenshotFixture, "v4-top-support-screenshot-error", (fixture) => {
      fixture.support = { screenshotCapture: { captureError: "failed" } };
    }, /support\.screenshotCapture\.captureError/],
  ];
  for (const [factory, name, mutate, expected] of v4SchemaMutations) {
    await assertRejectedFrom(factory, name, mutate, expected);
  }

  const screenshotHashBaseline = successfulScreenshotFixture();
  const screenshotHashCandidate = successfulScreenshotFixture();
  screenshotHashCandidate.screenshotSequence.frameHashSequence.sequenceSha256 = "8".repeat(64);
  const screenshotHashBaselinePath = await writeFixture("v4-screenshot-hash-baseline", screenshotHashBaseline);
  const screenshotHashCandidatePath = await writeFixture("v4-screenshot-hash-candidate", screenshotHashCandidate);
  const screenshotHashComparison = run(["--strict", screenshotHashBaselinePath, screenshotHashCandidatePath]);
  assert.equal(screenshotHashComparison.status, 1,
    `different screenshot sequence hashes must reject comparison\n${screenshotHashComparison.output}`);
  assert.match(screenshotHashComparison.output, /verified route contract differs from baseline/);
  assert.match(screenshotHashComparison.output, /speedup not reported/);
  console.log(`v4 versioned-schema and recursive anti-evidence mutations passed: ${v4SchemaMutations.length + 1}`);

  const v5ControlStateMutations = [
    [successfulFixture, "v5-lane-schema-missing", (fixture) => {
      delete fixture.renderer.support.productionDecoder.final.beforeDispose.laneMetrics[0].schemaVersion;
    }, /laneMetrics\[0\]\.schemaVersion missing/],
    [successfulFixture, "v5-lane-schema-number", (fixture) => {
      fixture.renderer.support.productionDecoder.final.beforeDispose.laneMetrics[0].schemaVersion = 1;
    }, /laneMetrics\[0\]\.schemaVersion 1/],
    [successfulFixture, "v5-open-decision-source-missing", (fixture) => {
      delete fixture.renderer.support.productionDecoder.initial.openDecisions[0].sourceIdentity;
    }, /openDecisions\[0\]\.sourceIdentity is missing/],
    [successfulFixture, "v5-production-health-error", (fixture) => {
      fixture.renderer.support.productionDecoder.health = { status: "error" };
    }, /health\.status.*(?:forbidden control state|unknown or forbidden)/],
    [successfulFixture, "v5-production-health-fallback", (fixture) => {
      fixture.renderer.support.productionDecoder.health = { status: "fallback" };
    }, /health\.status.*(?:forbidden control state|unknown or forbidden)/],
    [successfulFixture, "v5-production-health-canonical-cache", (fixture) => {
      fixture.renderer.support.productionDecoder.health = { status: "canonical-cache" };
    }, /health\.status.*(?:forbidden control state|unknown or forbidden)/],
    [successfulFixture, "v5-watchdog-sampler-error", (fixture) => {
      fixture.memoryWatchdog.sampler = { status: "error" };
    }, /memoryWatchdog\.sampler\.status/],
    [successfulFixture, "v5-production-state-failure", (fixture) => {
      fixture.renderer.support.productionDecoder.health = { state: "failure" };
    }, /health\.state/],
    [successfulFixture, "v5-production-result-emergency", (fixture) => {
      fixture.renderer.support.productionDecoder.health = { result: "emergency" };
    }, /health\.result/],
    [successfulFixture, "v5-production-mode-cache-required", (fixture) => {
      fixture.renderer.support.productionDecoder.health = { mode: "cache-required" };
    }, /health\.mode/],
    [successfulFixture, "v5-production-status-unknown", (fixture) => {
      fixture.renderer.support.productionDecoder.health = { status: "degraded" };
    }, /unknown or forbidden status value degraded/],
    [successfulScreenshotFixture, "v5-screenshot-health-fallback", (fixture) => {
      fixture.renderer.support.screenshotCapture.health = { status: "fallback" };
    }, /screenshotCapture\.health\.status/],
    [successfulFixture, "v5-watchdog-state-canonical-cache", (fixture) => {
      fixture.memoryWatchdog.sampler = { state: "canonical-cache" };
    }, /memoryWatchdog\.sampler\.state/],
  ];
  for (const [factory, name, mutate, expected] of v5ControlStateMutations) {
    await assertRejectedFrom(factory, name, mutate, expected);
  }

  const normalPerformanceState = successfulFixture();
  normalPerformanceState.renderer.support.productionDecoder.performance = {
    status: "measuring",
    state: "sampling",
    mode: "profiling",
    result: 42,
  };
  normalPerformanceState.memoryWatchdog.sampler = { status: "healthy", state: "running" };
  const normalPerformancePath = await writeFixture("v5-normal-performance-state", normalPerformanceState);
  const normalPerformanceResult = run(["--strict", normalPerformancePath, normalPerformancePath]);
  assert.equal(normalPerformanceResult.status, 0,
    `normal performance fields must not be mistaken for control failure states\n${normalPerformanceResult.output}`);
  console.log(`v5 versioned-lane/open-decision/control-state mutations passed: ${v5ControlStateMutations.length}`);

  const v6StrictNumberAndAdjacentMutations = [
    ["v6-watchdog-samples-string", (fixture) => {
      fixture.memoryWatchdog.samplesObserved = "2";
    }, /memoryWatchdog\.samplesObserved is missing or invalid/],
    ["v6-watchdog-rss-breach-string", (fixture) => {
      fixture.memoryWatchdog.latest.rssBreachCount = "0";
    }, /memoryWatchdog\.latest\.rssBreachCount.*expected 0/],
    ["v6-watchdog-available-breach-string", (fixture) => {
      fixture.memoryWatchdog.latest.availableBreachCount = "0";
    }, /memoryWatchdog\.latest\.availableBreachCount.*expected 0/],
    ["v6-watchdog-samples-fractional", (fixture) => {
      fixture.memoryWatchdog.samplesObserved = 1.5;
    }, /memoryWatchdog\.samplesObserved is missing or invalid/],
    ["v6-watchdog-peak-fractional", (fixture) => {
      fixture.memoryWatchdog.peakAggregateRssBytes = 100_000_000.5;
    }, /peakAggregateRssBytes is missing or invalid/],
    ["v6-watchdog-minimum-negative", (fixture) => {
      fixture.memoryWatchdog.minimumAvailableBytes = -1;
    }, /minimum available bytes is missing, invalid, or contradictory/],
    ["v6-requested-frame-count-string", (fixture) => {
      fixture.config.frames = "1";
    }, /requested frame evidence is invalid config\.frames/],
    ["v6-fallback-count-string", (fixture) => {
      fixture.renderer.frameMetrics.aggregates.anomalies.fallback = "0";
    }, /fallback count is invalid/],
    ["v6-decoded-sample-count-string", (fixture) => {
      fixture.decodedAudio.samplesPerChannel = "800";
    }, /decoded samplesPerChannel is missing or invalid/],
    ["v6-control-decision-outside-performance", (fixture) => {
      fixture.renderer.support.productionDecoder.health = { decision: "benchmark-candidate-a" };
    }, /health\.decision has unknown or forbidden decision value/],
    ["v6-control-pass-outside-performance", (fixture) => {
      fixture.renderer.frameMetrics.validation = { pass: false };
    }, /frameMetrics\.validation\.pass must be boolean true/],
    ["v6-required-fallback-still-gated", (fixture) => {
      fixture.renderer.frameMetrics.aggregates.anomalies.fallback = 1;
    }, /1 unplanned fallback frame/],
  ];
  for (const [name, mutate, expected] of v6StrictNumberAndAdjacentMutations) {
    await assertRejected(name, mutate, expected);
  }

  const v6PerformanceEvidence = [
    ["v6-performance-decision", (fixture) => {
      fixture.renderer.support.productionDecoder.performance = {
        decision: "benchmark-candidate-a",
      };
    }],
    ["v6-performance-pass", (fixture) => {
      fixture.renderer.frameMetrics.performance = { pass: false };
    }],
    ["v6-performance-error-budget", (fixture) => {
      fixture.renderer.frameMetrics.performance = { errorBudgetRemainingMs: 500 };
    }],
  ];
  for (const [name, mutate] of v6PerformanceEvidence) {
    const fixture = successfulFixture();
    mutate(fixture);
    const path = await writeFixture(name, fixture);
    const result = run(["--strict", path, path]);
    assert.equal(result.status, 0,
      `${name} is non-control performance evidence and must remain accepted\n${result.output}`);
  }
  console.log(
    `v6 strict-number/control-scope regressions passed: `
      + `${v6StrictNumberAndAdjacentMutations.length} rejected, ${v6PerformanceEvidence.length} accepted`,
  );

  const routeAValue = successfulFixture();
  const routeBValue = successfulFixture();
  routeBValue.productionDecoder.route.sources[0].sourceIdentity = "f".repeat(64);
  const routeA = await writeFixture("route-contract-a", routeAValue);
  const routeB = await writeFixture("route-contract-b", routeBValue);
  const routeComparison = run(["--strict", routeA, routeB]);
  assert.equal(routeComparison.status, 1,
    `different verified routes must not be speed-compared\n${routeComparison.output}`);
  assert.match(routeComparison.output, /verified route contract differs from baseline/);

  for (const [key, replacement] of [
    ["project", "4".repeat(64)],
    ["entry", "1".repeat(64)],
    ["assets", "2".repeat(64)],
    ["timingBundle", "3".repeat(64)],
  ]) {
    const identityAValue = successfulFixture();
    const identityBValue = successfulFixture();
    identityBValue.renderIdentity[key] = replacement;
    const identityA = await writeFixture(`identity-${key}-a`, identityAValue);
    const identityB = await writeFixture(`identity-${key}-b`, identityBValue);
    const identityComparison = run(["--strict", identityA, identityB]);
    assert.equal(identityComparison.status, 1,
      `${key} identity drift must reject comparison\n${identityComparison.output}`);
    assert.match(identityComparison.output, /render identity differs from baseline/);
    assert.match(identityComparison.output, /speedup not reported/);
  }

  const duplicatePixelEvidence = successfulFixture();
  duplicatePixelEvidence.colorEvidence = {
    renderIdentity: structuredClone(duplicatePixelEvidence.renderIdentity),
    pixelPass: true,
    contractPass: true,
  };
  const duplicatePixelPath = await writeFixture("duplicate-pixel-evidence-agrees", duplicatePixelEvidence);
  const duplicatePixelResult = run(["--strict", duplicatePixelPath, duplicatePixelPath]);
  assert.equal(duplicatePixelResult.status, 0,
    `consistent duplicate pixel evidence should remain valid\n${duplicatePixelResult.output}`);

  const unknownFixture = successfulFixture();
  delete unknownFixture.renderer.frameMetrics.aggregates.anomalies.fallback;
  const unknownPath = await writeFixture("diagnostic-unknown", unknownFixture);
  const diagnostic = run([unknownPath, unknownPath]);
  assert.equal(diagnostic.status, 0);
  assert.match(diagnostic.output, /unverified/);
  assert.match(diagnostic.output, /unknown/);

  const doctorProject = join(temporaryDirectory, "absolute-doctor-project");
  await mkdir(join(doctorProject, "results"), { recursive: true });
  await writeFile(
    join(doctorProject, "visible.mjs"),
    "export const ROOT_SCAN_VISIBLE = 'capturePage';\n",
  );
  await writeFile(
    join(doctorProject, "results", "ignored.mjs"),
    "export const RESULT_SCAN_MUST_NOT_APPEAR = 'capturePage';\n",
  );
  const doctor = spawnSync("bash", [join(dirname(script), "render_doctor.sh"), doctorProject], {
    encoding: "utf8",
    maxBuffer: 8 * 1024 * 1024,
  });
  if (doctor.error) throw doctor.error;
  const doctorOutput = `${doctor.stdout ?? ""}\n${doctor.stderr ?? ""}`;
  assert.equal(doctor.status, 0, `render_doctor absolute-root regression failed\n${doctorOutput}`);
  assert.match(doctorOutput, /ROOT_SCAN_VISIBLE/);
  assert.doesNotMatch(doctorOutput, /RESULT_SCAN_MUST_NOT_APPEAR/,
    "render_doctor must exclude results even when project_root is absolute");

  console.log("compare_metrics strict fail-closed regression tests passed");
} finally {
  await rm(temporaryDirectory, { recursive: true, force: true });
}
