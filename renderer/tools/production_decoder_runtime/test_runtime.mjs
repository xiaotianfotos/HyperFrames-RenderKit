#!/usr/bin/env node

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  DirectH264SourceService,
  GlobalDemuxByteBudget,
  ProductionDecoderError,
  buildCompactH264Index,
  createProductionDecoderMainBridge,
  createProductionDemuxBroker,
  validateDemuxConcurrencyBudget,
  validateDirectH264Codec,
} from "./main.mjs";
import {
  CACHE_DECISION,
  DIRECT_DECISION,
  createProductionDecoderRuntime,
  openRemoteDecoderSource,
} from "./browser.mjs";

const directory = path.dirname(fileURLToPath(import.meta.url));
const rendererRoot = path.resolve(directory, "../..");
const fixturePath = path.resolve(
  rendererRoot,
  "results/deterministic-decoder-poc/fixture/h264-bframes-120.mp4",
);

async function testByteBudget() {
  const budget = new GlobalDemuxByteBudget(8, 1_000);
  const first = await budget.acquire(8, { name: "first" });
  let secondSettled = false;
  const secondPromise = budget.acquire(4, { name: "second" }).then((lease) => {
    secondSettled = true;
    return lease;
  });
  await Promise.resolve();
  assert.equal(secondSettled, false);
  assert.equal(budget.snapshot().waitingReservations, 1);
  assert.equal(budget.release(first), true);
  const second = await secondPromise;
  assert.equal(secondSettled, true);
  assert.equal(budget.snapshot().currentBytes, 4);
  assert.equal(budget.release(second), true);
  assert.equal(budget.snapshot().currentBytes, 0);
  budget.close();
}

function testDemuxConcurrencyBudgetGate() {
  const saturated = validateDemuxConcurrencyBudget({
    maxTotalLanes: 4,
    maximumBatchBytes: 8 * 1024 * 1024,
    maximumGlobalDemuxBytes: 32 * 1024 * 1024,
    maximumOpenCursors: 4,
  });
  assert.equal(saturated.requiredGlobalDemuxBytes, 32 * 1024 * 1024);
  assert.throws(
    () => validateDemuxConcurrencyBudget({
      maxTotalLanes: 4,
      maximumBatchBytes: 8 * 1024 * 1024,
      maximumGlobalDemuxBytes: 32 * 1024 * 1024 - 1,
      maximumOpenCursors: 4,
    }),
    (error) => error?.code === "DEMUX_GLOBAL_BUDGET_UNSAFE"
      && error?.details?.requiredGlobalDemuxBytes === 32 * 1024 * 1024,
  );
  assert.throws(
    () => validateDemuxConcurrencyBudget({
      maxTotalLanes: 4,
      maximumBatchBytes: 8 * 1024 * 1024,
      maximumGlobalDemuxBytes: 32 * 1024 * 1024,
      maximumOpenCursors: 3,
    }),
    (error) => error?.code === "DEMUX_CURSOR_BUDGET_UNSAFE",
  );
}

async function testCacheClassifiers() {
  assert.throws(
    () => validateDirectH264Codec("hevc", {
      codec: "hvc1.1.6.L93.B0",
      description: new Uint8Array([1]),
    }),
    (error) => error?.code === "CACHE_REQUIRED_HEVC",
  );
  assert.throws(
    () => validateDirectH264Codec("avc", {
      codec: "avc3.64001f",
      description: new Uint8Array([1]),
    }),
    (error) => error?.code === "CACHE_REQUIRED_AVC1",
  );

  const rows = [
    { sequenceNumber: 0, microsecondTimestamp: 0, microsecondDuration: 1_000, timestamp: 0, byteLength: 2 },
    { sequenceNumber: 1, microsecondTimestamp: 1_000, microsecondDuration: 1_000, timestamp: 0.001, byteLength: 2 },
    { sequenceNumber: 2, microsecondTimestamp: 3_000, microsecondDuration: 2_000, timestamp: 0.003, byteLength: 2 },
  ];
  const fakeSink = {
    async *packets() { yield* rows; },
    async getFirstKeyPacket() { return { sequenceNumber: 0 }; },
    async getNextKeyPacket() { return null; },
  };
  await assert.rejects(
    buildCompactH264Index(fakeSink, {
      codec: "avc1.64001f",
      description: new Uint8Array([1, 2, 3]),
    }),
    (error) => error?.code === "CACHE_REQUIRED_VFR",
  );
}

async function testBrokerReturnsCacheDecision() {
  const originalOpen = DirectH264SourceService.open;
  const broker = createProductionDemuxBroker();
  try {
    DirectH264SourceService.open = async () => {
      throw new ProductionDecoderError(
        "CACHE_REQUIRED_HEVC",
        "HEVC must be normalized before direct decode",
        { codec: "hevc" },
      );
    };
    const result = await broker.openSource({
      filePath: fixturePath,
      sourceIdentity: "sha256:synthetic-hevc-decision",
    });
    assert.equal(result.decision, CACHE_DECISION);
    assert.equal(result.reason.code, "CACHE_REQUIRED_HEVC");
    assert.equal(result.canonicalContract.sampleEntry, "avc1");
    assert.equal(broker.snapshot().activeSources, 0);
  } finally {
    DirectH264SourceService.open = originalOpen;
    await broker.dispose();
  }
}

async function testBrowserEntryIsNodeFree() {
  for (const fileName of ["browser.mjs", "contract.mjs", "decoder_lane.mjs", "remote_source.mjs", "runtime.mjs"]) {
    const source = await readFile(path.resolve(directory, fileName), "utf8");
    assert.doesNotMatch(source, /from\s+["']node:/);
    assert.doesNotMatch(source, /from\s+["']mediabunny["']/);
  }
}

async function testRealFileBroker() {
  const sourceIdentity = "sha256:production-runtime-real-fixture";
  const broker = createProductionDemuxBroker({
    maximumBatchPackets: 4,
    maximumBatchBytes: 1024 * 1024,
    maximumGlobalDemuxBytes: 2 * 1024 * 1024,
    maximumOpenCursors: 4,
  });
  const mainBridge = createProductionDecoderMainBridge({
    broker,
    async resolveSource(request) {
      assert.equal(request.sourceToken, "fixture-token");
      return { filePath: fixturePath, sourceIdentity: request.sourceIdentity };
    },
  });
  // Electron invokes structured clone in both directions. Keep the unit test
  // honest even though this bridge runs in one Node process.
  const bridge = Object.fromEntries(Object.entries(mainBridge).map(([name, method]) => [
    name,
    async (request) => structuredClone(await method(request == null ? request : structuredClone(request))),
  ]));
  const opened = await openRemoteDecoderSource(bridge, {
    sourceIdentity,
    sourceToken: "fixture-token",
  }, {
    readyFramesMax: 4,
    batchSize: 4,
  });
  assert.equal(opened.decision, DIRECT_DECISION);
  assert.equal(opened.info.summary.presentationFrameCount, 120);
  assert.equal(opened.info.summary.maximumPresentationReorderDepth, 3);
  assert.equal("manifest" in opened.info, false);
  assert.equal("packetsInDecodeOrder" in opened.info, false);
  const openResponseBytes = Buffer.byteLength(JSON.stringify(opened.info));
  assert.equal(openResponseBytes < 5_000, true);

  const source = opened.source;
  const target30 = await source.resolveTarget(500_000);
  const target90 = await source.resolveTarget(1_500_000);
  assert.equal(target30.presentationFrameIndex, 30);
  assert.equal(target90.presentationFrameIndex, 90);
  const cursor30 = await source.verifiedRapCursor(target30.ptsUs);
  const cursor90 = await source.verifiedRapCursor(target90.ptsUs);
  assert.notEqual(cursor30, cursor90);
  assert.equal(broker.snapshot().activeCursors, 2);
  assert.equal(broker.snapshot().byteBudget.activeLeases, 2);
  await source.releaseCursor(cursor30);
  await source.releaseCursor(cursor90);
  assert.equal(broker.snapshot().activeCursors, 0);
  assert.equal(broker.snapshot().byteBudget.currentBytes, 0);

  let packet = await source.verifiedRapCursor(1_250_000);
  let packetCount = 0;
  while (packet) {
    packetCount += 1;
    packet = await source.nextPacket(packet);
  }
  // Target frame 75 seeks to the verified GOP beginning at frame 60.
  assert.equal(packetCount, 60);
  assert.equal(source.snapshot().activeCursors, 0);
  assert.equal(source.snapshot().peakBufferedPackets <= 4 * 4, true);
  assert.equal(source.snapshot().peakBufferedBytes <= 2 * 1024 * 1024, true);
  assert.equal(broker.snapshot().byteBudget.currentBytes, 0);
  assert.equal(broker.snapshot().byteBudget.activeLeases, 0);

  await source.dispose();
  const final = broker.snapshot();
  assert.equal(final.activeSources, 0);
  assert.equal(final.activeCursors, 0);
  assert.equal(final.byteBudget.currentBytes, 0);
  await broker.dispose();
  return {
    openResponseBytes,
    presentationFrames: opened.info.summary.presentationFrameCount,
    maximumPresentationReorderDepth: opened.info.summary.maximumPresentationReorderDepth,
    packetsFromRap60ToEof: packetCount,
  };
}

function makeFakeRendererBridge() {
  const sourceHandle = "10000000-0000-4000-8000-000000000001";
  const sourceIdentity = "sha256:fake-runtime-source";
  const indexDigest = "a".repeat(64);
  const presentationTimingDigest = "b".repeat(64);
  const packets = Array.from({ length: 600 }, (_, index) => ({
    decodeOrdinal: index,
    sequenceNumber: index,
    presentationFrameIndex: index,
    ptsUs: index * 1_000,
    durationUs: 1_000,
    type: "key",
    byteLength: 2,
    data: new Uint8Array([index, 0xa5]),
  }));
  const cursors = new Map();
  const leases = new Set();
  let serial = 1;
  let sourceClosed = false;
  const token = (kind, value) => `${kind}${String(value).padStart(7, "0")}-0000-4000-8000-000000000001`;

  function envelope() { return { sourceHandle, sourceIdentity, indexDigest }; }
  function target(ptsUs) {
    const ordinal = ptsUs / 1_000;
    assert.equal(Number.isInteger(ordinal) && ordinal >= 0 && ordinal < packets.length, true);
    return {
      presentationFrameIndex: ordinal,
      ptsUs,
      durationUs: 1_000,
      packetDecodeOrdinal: ordinal,
    };
  }
  function response(state, first) {
    const batchPackets = packets.slice(state.next, Math.min(state.next + 2, packets.length));
    state.next += batchPackets.length;
    const batchLeaseId = token("b", serial++);
    leases.add(batchLeaseId);
    state.batchLeaseId = batchLeaseId;
    return {
      schemaVersion: "1.0.0",
      ...envelope(),
      token: state.token,
      batchLeaseId,
      batchBytes: batchPackets.reduce((sum, packet) => sum + packet.byteLength, 0),
      packets: batchPackets,
      eof: state.next === packets.length,
      target: first ? target(state.targetPtsUs) : undefined,
      rap: first ? { ...packets[state.start], data: undefined } : undefined,
      activeCursors: cursors.size,
    };
  }

  return {
    sourceIdentity,
    state: { cursors, leases, get sourceClosed() { return sourceClosed; } },
    async decoderOpenSource(request) {
      assert.equal(request.sourceIdentity, sourceIdentity);
      return {
        schemaVersion: "1.0.0",
        decision: DIRECT_DECISION,
        sourceHandle,
        sourceIdentity,
        decoderConfig: {
          codec: "avc1.64001f",
          codedWidth: 16,
          codedHeight: 16,
          description: new Uint8Array([1, 2, 3]),
        },
        summary: {
          codec: "avc",
          sampleEntry: "avc1.64001f",
          timing: { kind: "cfr-zero-origin" },
          indexDigest,
          presentationTimingDigest,
          maximumPresentationReorderDepth: 0,
          track: { codedWidth: 16, codedHeight: 16 },
        },
        limits: {
          maximumBatchPackets: 2,
          maximumBatchBytes: 1024,
          maximumOpenCursors: 4,
          maximumGlobalDemuxBytes: 4096,
        },
      };
    },
    async decoderResolveTarget(request) {
      return { ...envelope(), target: target(request.ptsUs) };
    },
    async decoderBeginCursor(request) {
      const start = request.ptsUs / 1_000;
      const cursorToken = token("c", serial++);
      const state = { token: cursorToken, start, next: start, targetPtsUs: request.ptsUs, batchLeaseId: null };
      cursors.set(cursorToken, state);
      return response(state, true);
    },
    async decoderNextBatch(request) {
      const state = cursors.get(request.token);
      assert.ok(state);
      assert.equal(state.batchLeaseId, null);
      return response(state, false);
    },
    async decoderAckBatch(request) {
      const state = cursors.get(request.token);
      assert.ok(state);
      assert.equal(state.batchLeaseId, request.batchLeaseId);
      assert.equal(leases.delete(request.batchLeaseId), true);
      state.batchLeaseId = null;
      if (state.next === packets.length) cursors.delete(state.token);
      return true;
    },
    async decoderReleaseCursor(request) {
      const state = cursors.get(request.token);
      if (!state) return false;
      if (state.batchLeaseId) leases.delete(state.batchLeaseId);
      cursors.delete(request.token);
      return true;
    },
    async decoderCloseSource() {
      for (const state of cursors.values()) {
        if (state.batchLeaseId) leases.delete(state.batchLeaseId);
      }
      cursors.clear();
      sourceClosed = true;
      return true;
    },
    async decoderStats() {
      return { activeCursors: cursors.size, activeLeases: leases.size };
    },
  };
}

async function testRendererRuntimeSharingAndLanes() {
  const bridge = makeFakeRendererBridge();
  let closedFrames = 0;
  class FakeFrame {
    constructor(timestamp) { this.timestamp = timestamp; this.closed = false; }
    close() {
      assert.equal(this.closed, false);
      this.closed = true;
      closedFrames += 1;
    }
  }
  class FakeVideoDecoder {
    constructor(callbacks) {
      this.callbacks = callbacks;
      this.state = "unconfigured";
      this.decodeQueueSize = 0;
      this.listeners = new Set();
      this.pending = new Set();
    }
    configure() { this.state = "configured"; }
    reset() { this.decodeQueueSize = 0; }
    decode(chunk) {
      this.decodeQueueSize += 1;
      const pending = Promise.resolve().then(() => {
        this.decodeQueueSize -= 1;
        this.callbacks.output(new FakeFrame(chunk.timestamp));
        for (const listener of this.listeners) listener();
        this.listeners.clear();
      });
      this.pending.add(pending);
      pending.finally(() => this.pending.delete(pending));
    }
    addEventListener(_name, listener) { this.listeners.add(listener); }
    async flush() { await Promise.all([...this.pending]); }
    close() { this.state = "closed"; }
  }
  const runtime = createProductionDecoderRuntime({
    bridge,
    limits: {
      maxTotalLanes: 4,
      maxLanesPerSource: 2,
      readyFramesMax: 2,
      idleUnloadFrames: 10,
      batchSize: 2,
    },
    videoDecoderFactory: (callbacks) => new FakeVideoDecoder(callbacks),
    encodedChunkFactory: (init) => ({ ...init }),
  });
  const opened = await runtime.openSource({
    sourceIdentity: bridge.sourceIdentity,
    sourceToken: "approved-fake-source",
  });
  assert.equal(opened.decision, DIRECT_DECISION);

  runtime.beginOutputFrame(0);
  const main = await runtime.acquireFrame({
    sourceIdentity: bridge.sourceIdentity,
    ptsUs: 0,
    clipKey: "main",
  });
  const pipSame = await runtime.acquireFrame({
    sourceIdentity: bridge.sourceIdentity,
    ptsUs: 0,
    clipKey: "pip-same",
  });
  const pipDifferent = await runtime.acquireFrame({
    sourceIdentity: bridge.sourceIdentity,
    ptsUs: 2_000,
    clipKey: "pip-different",
  });
  assert.equal(main.frame, pipSame.frame);
  assert.equal(main.leaseId, pipSame.leaseId);
  assert.equal(pipSame.shared, true);
  assert.notEqual(main.laneId, pipDifferent.laneId);
  assert.equal(pipDifferent.frame.timestamp, 2_000);
  await runtime.endOutputFrame();

  runtime.beginOutputFrame(1);
  const nextMain = await runtime.acquireFrame({
    sourceIdentity: bridge.sourceIdentity,
    ptsUs: 1_000,
    clipKey: "main",
  });
  assert.equal(nextMain.laneId, main.laneId);
  assert.equal(nextMain.frame.timestamp, 1_000);
  await runtime.endOutputFrame();

  for (let frameIndex = 2; frameIndex < 600; frameIndex += 1) {
    runtime.beginOutputFrame(frameIndex);
    const lease = await runtime.acquireFrame({
      sourceIdentity: bridge.sourceIdentity,
      ptsUs: frameIndex * 1_000,
      clipKey: "main",
    });
    assert.equal(lease.frame.timestamp, frameIndex * 1_000);
    assert.equal(lease.laneId, main.laneId);
    await runtime.endOutputFrame();
  }

  const beforeDispose = runtime.snapshot();
  assert.equal(beforeDispose.activeLanes, 1);
  assert.equal(beforeDispose.outputFrames, 600);
  assert.equal(beforeDispose.frameAcquisitions, 602);
  assert.equal(beforeDispose.sharedFrameAcquisitions, 1);
  assert.equal(beforeDispose.allocator.metrics.peakActiveLanes, 2);
  assert.equal(beforeDispose.sourceMetrics[0].targetCacheEntries <= 512, true);
  assert.equal(beforeDispose.sourceMetrics[0].packetMetadataEntries <= 256, true);
  assert.equal(beforeDispose.laneMetrics.every((metrics) => !Array.isArray(metrics.transitions)), true);
  await runtime.dispose();
  assert.equal(bridge.state.cursors.size, 0);
  assert.equal(bridge.state.leases.size, 0);
  assert.equal(bridge.state.sourceClosed, true);
  assert.equal(runtime.frameBudget.outstandingFrames, 0);
  assert.ok(closedFrames >= 2);
  return {
    outputFrames: beforeDispose.outputFrames,
    frameAcquisitions: beforeDispose.frameAcquisitions,
    sharedFrameAcquisitions: beforeDispose.sharedFrameAcquisitions,
    peakActiveLanes: beforeDispose.allocator.metrics.peakActiveLanes,
    targetCacheEntries: beforeDispose.sourceMetrics[0].targetCacheEntries,
    packetMetadataEntries: beforeDispose.sourceMetrics[0].packetMetadataEntries,
  };
}

async function testCorruptBatchFailsClosedAndCleansUp() {
  const bridge = makeFakeRendererBridge();
  const originalBegin = bridge.decoderBeginCursor.bind(bridge);
  bridge.decoderBeginCursor = async (request) => {
    const batch = await originalBegin(request);
    batch.packets = batch.packets.map((packet, index) => (
      index === 0 ? { ...packet, decodeOrdinal: packet.decodeOrdinal + 1 } : packet
    ));
    return batch;
  };
  const opened = await openRemoteDecoderSource(bridge, {
    sourceIdentity: bridge.sourceIdentity,
    sourceToken: "approved-fake-source",
  }, {
    readyFramesMax: 2,
    maxLanesPerSource: 2,
    maximumPacketMetadataEntries: 32,
    maximumTargetCacheEntries: 32,
    batchSize: 2,
  });
  assert.equal(opened.decision, DIRECT_DECISION);
  await assert.rejects(
    opened.source.verifiedRapCursor(0),
    (error) => error?.code === "REMOTE_DECODE_SEQUENCE_DISCONTINUITY",
  );
  assert.equal(bridge.state.cursors.size, 0);
  assert.equal(bridge.state.leases.size, 0);
  await opened.source.dispose();
}

await testByteBudget();
testDemuxConcurrencyBudgetGate();
await testCacheClassifiers();
await testBrokerReturnsCacheDecision();
await testBrowserEntryIsNodeFree();
const realFileResult = await testRealFileBroker();
const rendererResult = await testRendererRuntimeSharingAndLanes();
await testCorruptBatchFailsClosedAndCleansUp();

console.log(JSON.stringify({
  test: "production_decoder_runtime",
  directDecision: DIRECT_DECISION,
  fallbackDecision: CACHE_DECISION,
  fullManifestIpc: false,
  boundedGlobalDemuxBytes: true,
  samePtsShared: true,
  differentPtsUseIndependentLanes: true,
  asyncCleanup: true,
  realFileResult,
  rendererResult,
  pass: true,
}));
