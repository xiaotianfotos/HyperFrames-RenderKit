import {
  CACHE_DECISION,
  DIRECT_DECISION,
  createProductionDecoderRuntime,
  serializeProductionDecoderError,
} from "./browser.mjs";

function invariant(condition, message, details = {}) {
  if (!condition) throw Object.assign(new Error(message), { code: "INTEGRATION_ASSERTION_FAILED", details });
}

async function rgbaSha256(context, width, height) {
  const rgba = context.getImageData(0, 0, width, height).data;
  const digest = await crypto.subtle.digest("SHA-256", rgba);
  return [...new Uint8Array(digest)].map((value) => value.toString(16).padStart(2, "0")).join("");
}

async function run() {
  invariant(typeof VideoDecoder === "function", "VideoDecoder is unavailable in this Electron renderer");
  invariant(typeof EncodedVideoChunk === "function", "EncodedVideoChunk is unavailable in this Electron renderer");
  const config = await window.productionDecoderIntegration.config();
  const runtime = createProductionDecoderRuntime({
    bridge: window.hyperframesDecoder,
    limits: config.runtimeLimits,
  });
  const startedAt = performance.now();
  const opened = await runtime.openSource({
    sourceIdentity: config.sourceIdentity,
    sourceToken: config.sourceToken,
  });
  if (opened.decision === CACHE_DECISION) {
    await runtime.dispose();
    return {
      schemaVersion: "1.0.0",
      status: CACHE_DECISION,
      decision: opened,
      brokerMetrics: await window.hyperframesDecoder.decoderStats(),
    };
  }
  invariant(opened.decision === DIRECT_DECISION, "Unexpected decoder open decision", { opened });
  const width = opened.summary.track.displayWidth;
  const height = opened.summary.track.displayHeight;
  const canvas = document.getElementById("frame");
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext("2d", { alpha: false, willReadFrequently: true });
  invariant(context != null, "2D canvas context is unavailable");
  const hashByOrdinal = new Map();
  const repeatedHashEvidence = [];
  let repeatedHashChecks = 0;

  for (let outputFrame = 0; outputFrame < config.requests.length; outputFrame += 1) {
    const request = config.requests[outputFrame];
    runtime.beginOutputFrame(outputFrame);
    try {
      const lease = await runtime.acquireFrame({
        sourceIdentity: config.sourceIdentity,
        ptsUs: request.ptsUs,
        clipKey: "primary",
      });
      invariant(lease.frame.timestamp === request.ptsUs, "Exact VideoFrame PTS mismatch", {
        outputFrame,
        expectedPtsUs: request.ptsUs,
        actualPtsUs: lease.frame.timestamp,
      });
      context.drawImage(lease.frame, 0, 0, width, height);
      const hash = await rgbaSha256(context, width, height);
      const previousHash = hashByOrdinal.get(request.ordinal);
      if (previousHash != null) {
        invariant(previousHash === hash, "Repeated exact PTS produced different canvas pixels", {
          ordinal: request.ordinal,
          previousHash,
          hash,
        });
        repeatedHashChecks += 1;
        repeatedHashEvidence.push({ ordinal: request.ordinal, sha256: hash });
      } else {
        hashByOrdinal.set(request.ordinal, hash);
      }
    } finally {
      await runtime.endOutputFrame();
    }
  }

  const tripleFrameIndex = config.requests.length;
  runtime.beginOutputFrame(tripleFrameIndex);
  let triple;
  try {
    const [first, middle, repeated] = await Promise.all([
      runtime.acquireFrame({
        sourceIdentity: config.sourceIdentity,
        ptsUs: config.triple[0].ptsUs,
        clipKey: "triple-a",
      }),
      runtime.acquireFrame({
        sourceIdentity: config.sourceIdentity,
        ptsUs: config.triple[1].ptsUs,
        clipKey: "triple-b",
      }),
      runtime.acquireFrame({
        sourceIdentity: config.sourceIdentity,
        ptsUs: config.triple[2].ptsUs,
        clipKey: "triple-c",
      }),
    ]);
    invariant(first.frame === repeated.frame && first.leaseId === repeated.leaseId,
      "Same source/PTS did not share one runtime-owned VideoFrame");
    invariant(first.laneId !== middle.laneId,
      "Different same-source PTS values did not use independent decoder lanes");
    invariant(first.frame.timestamp === config.triple[0].ptsUs
      && middle.frame.timestamp === config.triple[1].ptsUs
      && repeated.frame.timestamp === config.triple[2].ptsUs,
    "Triple-lane exact PTS mismatch");
    triple = {
      ordinals: config.triple.map((request) => request.ordinal),
      sharedLease: true,
      independentMiddleLane: true,
      firstLaneId: first.laneId,
      middleLaneId: middle.laneId,
    };
  } finally {
    await runtime.endOutputFrame();
  }

  const runtimeMetricsBeforeDispose = runtime.snapshot();
  await runtime.dispose();
  const frameBudgetAfterDispose = runtime.frameBudget.snapshot();
  const brokerMetrics = await window.hyperframesDecoder.decoderStats();
  invariant(frameBudgetAfterDispose.outstandingFrames === 0,
    "VideoFrame budget did not return to zero", { frameBudgetAfterDispose });
  invariant(brokerMetrics.activeSources === 0
    && brokerMetrics.activeCursors === 0
    && brokerMetrics.byteBudget.currentBytes === 0
    && brokerMetrics.byteBudget.activeLeases === 0,
  "Main-process demux resources did not return to zero", { brokerMetrics });
  invariant(repeatedHashChecks >= 2, "Request plan did not prove repeated exact-frame pixel identity", {
    repeatedHashChecks,
  });
  const representativeHashes = Object.fromEntries(
    [0, 12, 19, 20, 70, 75]
      .filter((ordinal) => hashByOrdinal.has(ordinal))
      .map((ordinal) => [String(ordinal), hashByOrdinal.get(ordinal)]),
  );
  return {
    schemaVersion: "1.0.0",
    status: "pass",
    sourceSummary: opened.summary,
    requestCount: config.requests.length,
    exactPtsMatches: config.requests.length + 3,
    nearestOrToleranceAccepted: 0,
    htmlVideoFallbacks: 0,
    repeatedHashChecks,
    repeatedHashEvidence,
    representativeHashes,
    triple,
    runtimeMetricsBeforeDispose,
    frameBudgetAfterDispose,
    brokerMetrics,
    wallMs: performance.now() - startedAt,
  };
}

try {
  window.productionDecoderIntegration.reportResult(await run());
} catch (error) {
  window.productionDecoderIntegration.reportError(serializeProductionDecoderError(error));
}
