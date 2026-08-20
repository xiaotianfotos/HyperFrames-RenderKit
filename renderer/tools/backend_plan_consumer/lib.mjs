import { canonicalJson, sha256, verifyExecutionProof } from "../frame_backend_preflight/lib.mjs";
import { verifyExecutionInputsDescriptor } from "./execution_inputs.mjs";

export const EXECUTION_PLAN_KIND = "hyperframes-backend-segment-execution-plan";
export const EXECUTION_PLAN_SCHEMA_VERSION = 1;
export const CONCAT_DECISION_KIND = "hyperframes-mov-stream-copy-decision";
export const CONCAT_DECISION_SCHEMA_VERSION = 1;

const SHA256_PATTERN = /^sha256:[a-f0-9]{64}$/;
const ALLOWED_BACKENDS = new Set(["proxy-tree", "layered-exact", "screenshot"]);

export const DEFAULT_MOV_CONTRACT = Object.freeze({
  kind: "hyperframes-mov-stream-copy-contract",
  schemaVersion: 1,
  container: "mov",
  video: Object.freeze({
    codec: "h264",
    codecTag: "avc1",
    width: 3840,
    height: 2160,
    pixelFormat: "yuv420p",
    fps: Object.freeze({ numerator: 60, denominator: 1 }),
    nominalFps: Object.freeze({ numerator: 60, denominator: 1 }),
    timeBasePolicy: "identical-frame-integral",
    sampleAspectRatioPolicy: "square-or-unspecified",
    colorRange: "tv",
    colorSpace: "bt709",
    colorPrimaries: "bt709",
    colorTransfer: "bt709",
    chromaLocation: "left",
    scan: "progressive",
    closedGop: true,
    startsWithIdr: true,
    openGop: false,
  }),
  audio: Object.freeze({
    codec: "pcm_s24le",
    codecTag: "in24",
    sampleFormat: "s32",
    bitsPerRawSample: 24,
    sampleRate: 48_000,
    channels: 2,
    channelLayout: "stereo",
    timeBase: Object.freeze({ numerator: 1, denominator: 48_000 }),
  }),
});

function integer(value, name, { minimum = 0 } = {}) {
  if (!Number.isSafeInteger(value) || value < minimum) {
    throw new Error(`${name} must be an integer >= ${minimum}`);
  }
  return value;
}

function ratio(value, name) {
  if (!value || typeof value !== "object") throw new Error(`${name} must be an object`);
  return {
    numerator: integer(value.numerator, `${name}.numerator`, { minimum: 1 }),
    denominator: integer(value.denominator, `${name}.denominator`, { minimum: 1 }),
  };
}

function asciiIdentity(value, name, { nullable = false } = {}) {
  if (value == null && nullable) return null;
  if (typeof value !== "string" || value.length === 0 || value.length > 512 || /[^\x20-\x7e]/.test(value)) {
    throw new Error(`${name} must be a non-empty printable ASCII string`);
  }
  return value;
}

function digestIdentity(value, name, { nullable = false } = {}) {
  const normalized = asciiIdentity(value, name, { nullable });
  if (normalized == null) return null;
  if (!SHA256_PATTERN.test(normalized)) throw new Error(`${name} must be a sha256 digest identity`);
  return normalized;
}

function normalizeExpected(expected) {
  if (!expected || typeof expected !== "object") throw new Error("expected execution identity is required");
  return {
    // Upstream schema v2 deliberately treats these as opaque, caller-trusted
    // identities. For example, a quality-safe oracle proof without a supplied
    // whole-project digest uses `entry-sha256:<digest>` as projectIdentity.
    projectIdentity: asciiIdentity(expected.projectIdentity, "expected.projectIdentity"),
    renderPlanIdentity: asciiIdentity(expected.renderPlanIdentity, "expected.renderPlanIdentity"),
    machineProfileIdentity: asciiIdentity(expected.machineProfileIdentity, "expected.machineProfileIdentity"),
    styleOverrideProfileHash: asciiIdentity(expected.styleOverrideProfileHash, "expected.styleOverrideProfileHash", { nullable: true }),
    auditSignature: digestIdentity(expected.auditSignature, "expected.auditSignature"),
    startFrame: integer(expected.startFrame, "expected.startFrame"),
    frameCount: integer(expected.frameCount, "expected.frameCount", { minimum: 1 }),
    fps: ratio(expected.fps, "expected.fps"),
  };
}

function deepClone(value) {
  return JSON.parse(JSON.stringify(value));
}

function equal(left, right) {
  return canonicalJson(left) === canonicalJson(right);
}

function normalizeMovContract(raw = DEFAULT_MOV_CONTRACT) {
  const contract = deepClone(raw);
  if (contract?.kind !== DEFAULT_MOV_CONTRACT.kind || contract?.schemaVersion !== 1) {
    throw new Error("unsupported MOV stream-copy contract schema");
  }
  if (!equal(contract, DEFAULT_MOV_CONTRACT)) {
    throw new Error("only the canonical H.264/PCM 4K60 BT.709 MOV contract is supported");
  }
  return contract;
}

function safeProxyRange(range) {
  if (range?.backend !== "proxy-tree") return false;
  if (range.executable !== true || range.decisionBasis !== "exact-signature-proof") return false;
  if (!SHA256_PATTERN.test(range.gateProfileHash ?? "")) return false;
  if (range.inventoryState !== "complete" || !Array.isArray(range.riskSignature)) return false;
  return range.riskSignature.every((atom) => (
    atom
    && atom.classification === "known"
    && atom.blocker !== true
    && atom.pseudoGeometryUnknown !== true
    && atom.property != null
    && atom.value != null
    && atom.rect != null
    && atom.intersectionArea != null
    && atom.cumulativeOpacity != null
    && Array.isArray(atom.blockedBackends)
    && !atom.blockedBackends.includes("proxy-tree")
  ));
}

function validateSignedRanges(plan, expected) {
  if (!Array.isArray(plan?.ranges) || plan.ranges.length === 0) {
    return { valid: false, reason: "signed-ranges-missing" };
  }
  const expectedEnd = expected.startFrame + expected.frameCount;
  let nextFrame = expected.startFrame;
  const normalized = [];
  for (let index = 0; index < plan.ranges.length; index += 1) {
    const range = plan.ranges[index];
    if (!Number.isSafeInteger(range?.startFrame)
      || !Number.isSafeInteger(range?.endFrameExclusive)
      || range.startFrame !== nextFrame
      || range.endFrameExclusive <= range.startFrame
      || range.endFrameExclusive > expectedEnd) {
      return { valid: false, reason: `signed-range-coverage-invalid:${index}` };
    }
    if (!ALLOWED_BACKENDS.has(range.backend)) {
      return { valid: false, reason: `signed-range-backend-invalid:${index}` };
    }
    if (range.executable !== true) {
      return { valid: false, reason: `signed-range-not-executable:${index}` };
    }
    normalized.push({ ...range, sourceRangeIndex: index });
    nextFrame = range.endFrameExclusive;
  }
  if (nextFrame !== expectedEnd) return { valid: false, reason: "signed-range-coverage-incomplete" };
  return { valid: true, ranges: normalized };
}

function makeSegment({ index, startFrame, endFrameExclusive, backend, sourceRangeIndexes, screenshotMediaPolicy, contract }) {
  return {
    segmentId: `segment-${String(index).padStart(4, "0")}`,
    order: index,
    startFrame,
    endFrameExclusive,
    frameCount: endFrameExclusive - startFrame,
    backend,
    sourceRangeIndexes,
    screenshotMediaPolicy: backend === "screenshot" ? screenshotMediaPolicy : null,
    outputContract: contract,
  };
}

function mergeRanges(ranges, { screenshotMediaPolicy, contract }) {
  const segments = [];
  for (const range of ranges) {
    const backend = range.backend === "proxy-tree" && safeProxyRange(range)
      ? "proxy-tree"
      : "screenshot";
    const previous = segments.at(-1);
    if (previous?.backend === backend && previous.endFrameExclusive === range.startFrame) {
      previous.endFrameExclusive = range.endFrameExclusive;
      previous.frameCount += range.endFrameExclusive - range.startFrame;
      previous.sourceRangeIndexes.push(range.sourceRangeIndex);
      continue;
    }
    segments.push(makeSegment({
      index: segments.length,
      startFrame: range.startFrame,
      endFrameExclusive: range.endFrameExclusive,
      backend,
      sourceRangeIndexes: [range.sourceRangeIndex],
      screenshotMediaPolicy,
      contract,
    }));
  }
  return segments;
}

function signExecutionPlan(core) {
  return { ...core, executionPlanSignature: `sha256:${sha256(core)}` };
}

function fallbackPlan({ expected, contract, reason, sourceProofSignature = null, executionInputs = null }) {
  const segment = makeSegment({
    index: 0,
    startFrame: expected.startFrame,
    endFrameExclusive: expected.startFrame + expected.frameCount,
    backend: "screenshot",
    sourceRangeIndexes: [],
    screenshotMediaPolicy: "faithful",
    contract,
  });
  return signExecutionPlan({
    kind: EXECUTION_PLAN_KIND,
    schemaVersion: EXECUTION_PLAN_SCHEMA_VERSION,
    executable: true,
    executionMode: "oracle-fallback",
    fallbackReason: reason,
    sourceProofValid: false,
    sourceProofSignature,
    executionInputs,
    identities: {
      projectIdentity: expected.projectIdentity,
      renderPlanIdentity: expected.renderPlanIdentity,
      machineProfileIdentity: expected.machineProfileIdentity,
      styleOverrideProfileHash: expected.styleOverrideProfileHash,
      auditSignature: expected.auditSignature,
    },
    timeline: {
      startFrame: expected.startFrame,
      frameCount: expected.frameCount,
      fps: expected.fps,
    },
    screenshotMediaPolicy: "faithful",
    segments: [segment],
    concat: {
      mode: "single-segment",
      streamCopyEligible: false,
      segmentOrder: [segment.segmentId],
      outputContract: contract,
    },
  });
}

export function compileSegmentExecutionPlan({
  preflightPlan,
  expected: rawExpected,
  outputContract: rawOutputContract = DEFAULT_MOV_CONTRACT,
  executionInputs = null,
} = {}) {
  const expected = normalizeExpected(rawExpected);
  const contract = normalizeMovContract(rawOutputContract);
  const verified = verifyExecutionProof(preflightPlan, expected);
  const sourceProofSignature = SHA256_PATTERN.test(preflightPlan?.proof?.proofSignature ?? "")
    ? preflightPlan.proof.proofSignature
    : null;
  if (!verified.valid) {
    return fallbackPlan({ expected, contract, reason: verified.reason, sourceProofSignature, executionInputs });
  }
  if (preflightPlan.startFrame !== expected.startFrame
    || preflightPlan.frameCount !== expected.frameCount
    || !equal(preflightPlan.fps, expected.fps)) {
    return fallbackPlan({ expected, contract, reason: "signed-plan-timeline-mismatch", sourceProofSignature, executionInputs });
  }
  const rangeValidation = validateSignedRanges(preflightPlan, expected);
  if (!rangeValidation.valid) {
    return fallbackPlan({ expected, contract, reason: rangeValidation.reason, sourceProofSignature, executionInputs });
  }
  const segments = mergeRanges(rangeValidation.ranges, {
    screenshotMediaPolicy: verified.screenshotMediaPolicy,
    contract,
  });
  const downgradedProxyRangeIndexes = rangeValidation.ranges
    .filter((range) => range.backend === "proxy-tree" && !safeProxyRange(range))
    .map((range) => range.sourceRangeIndex);
  const core = {
    kind: EXECUTION_PLAN_KIND,
    schemaVersion: EXECUTION_PLAN_SCHEMA_VERSION,
    executable: true,
    executionMode: downgradedProxyRangeIndexes.length ? "verified-with-oracle-downgrade" : "verified",
    fallbackReason: null,
    sourceProofValid: true,
    sourceProofSignature: verified.proofSignature,
    sourceBackendPlanSignature: verified.backendPlanSignature,
    executionInputs,
    identities: {
      projectIdentity: expected.projectIdentity,
      renderPlanIdentity: expected.renderPlanIdentity,
      machineProfileIdentity: expected.machineProfileIdentity,
      styleOverrideProfileHash: expected.styleOverrideProfileHash,
      auditSignature: expected.auditSignature,
    },
    timeline: {
      startFrame: expected.startFrame,
      frameCount: expected.frameCount,
      fps: expected.fps,
    },
    screenshotMediaPolicy: verified.screenshotMediaPolicy,
    downgradedProxyRangeIndexes,
    segments,
    concat: {
      mode: segments.length === 1 ? "single-segment" : "stream-copy-after-observation-gate",
      streamCopyEligible: false,
      segmentOrder: segments.map((segment) => segment.segmentId),
      outputContract: contract,
    },
  };
  return signExecutionPlan(core);
}

export function verifyExecutionSegmentPlan(plan) {
  if (plan?.kind !== EXECUTION_PLAN_KIND || plan?.schemaVersion !== EXECUTION_PLAN_SCHEMA_VERSION) {
    return { valid: false, reason: "execution-plan-schema-mismatch" };
  }
  const { executionPlanSignature, ...core } = plan;
  if (!SHA256_PATTERN.test(executionPlanSignature ?? "")) {
    return { valid: false, reason: "execution-plan-signature-missing" };
  }
  if (executionPlanSignature !== `sha256:${sha256(core)}`) {
    return { valid: false, reason: "execution-plan-signature-mismatch" };
  }
  if (plan.executable !== true || !Array.isArray(plan.segments) || plan.segments.length === 0) {
    return { valid: false, reason: "execution-plan-not-executable" };
  }
  try {
    if (plan.executionInputs != null) {
      const inputCheck = verifyExecutionInputsDescriptor(plan.executionInputs);
      if (!inputCheck.valid) return { valid: false, reason: inputCheck.reason };
      if (plan.executionInputs.projectIdentity !== plan.identities?.projectIdentity) {
        return { valid: false, reason: "execution-inputs-project-identity-mismatch" };
      }
    }
    normalizeMovContract(plan.concat?.outputContract);
    const timeline = {
      startFrame: integer(plan.timeline?.startFrame, "plan.timeline.startFrame"),
      frameCount: integer(plan.timeline?.frameCount, "plan.timeline.frameCount", { minimum: 1 }),
      fps: ratio(plan.timeline?.fps, "plan.timeline.fps"),
    };
    if (!equal(timeline.fps, DEFAULT_MOV_CONTRACT.video.fps)) {
      return { valid: false, reason: "execution-plan-fps-contract-mismatch" };
    }
    let nextFrame = timeline.startFrame;
    for (let index = 0; index < plan.segments.length; index += 1) {
      const segment = plan.segments[index];
      if (segment?.segmentId !== `segment-${String(index).padStart(4, "0")}` || segment.order !== index) {
        return { valid: false, reason: `execution-segment-order-invalid:${index}` };
      }
      if (!ALLOWED_BACKENDS.has(segment.backend)
        || segment.startFrame !== nextFrame
        || !Number.isSafeInteger(segment.endFrameExclusive)
        || segment.endFrameExclusive <= segment.startFrame
        || segment.frameCount !== segment.endFrameExclusive - segment.startFrame
        || !equal(segment.outputContract, plan.concat.outputContract)) {
        return { valid: false, reason: `execution-segment-contract-invalid:${index}` };
      }
      if (segment.backend === "screenshot"
        && !new Set(["faithful", "bounded-static"]).has(segment.screenshotMediaPolicy)) {
        return { valid: false, reason: `execution-segment-screenshot-policy-invalid:${index}` };
      }
      if (segment.backend !== "screenshot" && segment.screenshotMediaPolicy !== null) {
        return { valid: false, reason: `execution-segment-exact-policy-invalid:${index}` };
      }
      nextFrame = segment.endFrameExclusive;
    }
    if (nextFrame !== timeline.startFrame + timeline.frameCount) {
      return { valid: false, reason: "execution-segment-coverage-incomplete" };
    }
    if (!equal(plan.concat?.segmentOrder, plan.segments.map((segment) => segment.segmentId))) {
      return { valid: false, reason: "execution-concat-order-mismatch" };
    }
  } catch (error) {
    return { valid: false, reason: `execution-plan-structure-invalid:${error.message}` };
  }
  return { valid: true };
}

function valueAt(object, path) {
  return path.split(".").reduce((value, key) => value?.[key], object);
}

const STATIC_CONTRACT_PATHS = Object.freeze([
  "container",
  "video.codec", "video.codecTag", "video.width", "video.height", "video.pixelFormat",
  "video.fps", "video.nominalFps", "video.timeBasePolicy", "video.sampleAspectRatioPolicy", "video.colorRange",
  "video.colorSpace", "video.colorPrimaries", "video.colorTransfer", "video.chromaLocation",
  "video.scan", "video.closedGop", "video.startsWithIdr", "video.openGop",
  "audio.codec", "audio.codecTag", "audio.sampleFormat", "audio.bitsPerRawSample",
  "audio.sampleRate", "audio.channels", "audio.channelLayout", "audio.timeBase",
]);

function validateObservedSegment(segment, observed, expectedContract) {
  const reasons = [];
  if (observed?.segmentId !== segment.segmentId) reasons.push("segment-id-mismatch");
  for (const path of STATIC_CONTRACT_PATHS) {
    if (!equal(valueAt(observed, path), valueAt(expectedContract, path))) reasons.push(`contract-mismatch:${path}`);
  }
  if (observed?.video?.sampleAspectRatio != null && observed.video.sampleAspectRatio !== "1:1") {
    reasons.push("video-sample-aspect-ratio-not-square");
  }
  if (!SHA256_PATTERN.test(observed?.video?.codecExtradataSha256 ?? "")) {
    reasons.push("video-codec-extradata-missing");
  }
  if (observed?.video?.frameCount !== segment.frameCount) reasons.push("video-frame-count-mismatch");
  const observedTimeBase = observed?.video?.timeBase;
  const validTimeBase = Number.isSafeInteger(observedTimeBase?.numerator)
    && observedTimeBase.numerator > 0
    && Number.isSafeInteger(observedTimeBase?.denominator)
    && observedTimeBase.denominator > 0;
  if (!validTimeBase) reasons.push("video-timebase-invalid");
  const ticksPerFrameNumerator = validTimeBase
    ? observedTimeBase.denominator * expectedContract.video.fps.denominator
    : 0;
  const ticksPerFrameDenominator = validTimeBase
    ? observedTimeBase.numerator * expectedContract.video.fps.numerator
    : 1;
  if (validTimeBase && ticksPerFrameNumerator % ticksPerFrameDenominator !== 0) {
    reasons.push("video-timebase-not-frame-integral");
  }
  const expectedVideoTicks = segment.frameCount * (ticksPerFrameNumerator / ticksPerFrameDenominator);
  if (observed?.video?.startTimeTicks !== 0) reasons.push("video-start-time-not-zero");
  if (observed?.video?.durationTicks !== expectedVideoTicks) reasons.push("video-duration-mismatch");
  const samplesPerFrameNumerator = expectedContract.audio.sampleRate * expectedContract.video.fps.denominator;
  const samplesPerFrameDenominator = expectedContract.video.fps.numerator;
  if (samplesPerFrameNumerator % samplesPerFrameDenominator !== 0) reasons.push("audio-samples-per-frame-not-integral");
  const expectedSamples = segment.frameCount * (samplesPerFrameNumerator / samplesPerFrameDenominator);
  if (observed?.audio?.startSample !== 0) reasons.push("audio-start-sample-not-zero");
  if (observed?.audio?.sampleCount !== expectedSamples) reasons.push("audio-sample-count-mismatch");
  return reasons;
}

export function validateObservedMovContract({ segment, observed, outputContract = DEFAULT_MOV_CONTRACT } = {}) {
  const contract = normalizeMovContract(outputContract);
  if (!segment || !Number.isSafeInteger(segment.frameCount) || segment.frameCount < 1) {
    throw new Error("segment with a positive integer frameCount is required");
  }
  return validateObservedSegment(segment, observed, contract);
}

function signConcatDecision(core) {
  return { ...core, decisionSignature: `sha256:${sha256(core)}` };
}

export function evaluateMovStreamCopyConcat({
  executionPlan,
  observedSegments,
  mismatchPolicy = "hard-fail",
} = {}) {
  const verifiedPlan = verifyExecutionSegmentPlan(executionPlan);
  if (!verifiedPlan.valid) throw new Error(`cannot evaluate concat: ${verifiedPlan.reason}`);
  if (!new Set(["hard-fail", "uniform-screenshot"]).has(mismatchPolicy)) {
    throw new Error("mismatchPolicy must be hard-fail or uniform-screenshot");
  }
  if (!Array.isArray(observedSegments)) throw new Error("observedSegments must be an array");
  const observedById = new Map();
  for (const observed of observedSegments) {
    if (typeof observed?.segmentId !== "string" || observedById.has(observed.segmentId)) {
      throw new Error("observedSegments must have unique segmentId values");
    }
    observedById.set(observed.segmentId, observed);
  }
  const expectedContract = executionPlan.concat.outputContract;
  const failures = [];
  const extradata = new Set();
  const videoTimeBases = new Set();
  for (const segment of executionPlan.segments) {
    const observed = observedById.get(segment.segmentId);
    if (!observed) {
      failures.push({ segmentId: segment.segmentId, reasons: ["segment-observation-missing"] });
      continue;
    }
    const reasons = validateObservedSegment(segment, observed, expectedContract);
    if (SHA256_PATTERN.test(observed?.video?.codecExtradataSha256 ?? "")) {
      extradata.add(observed.video.codecExtradataSha256);
    }
    if (observed?.video?.timeBase) videoTimeBases.add(canonicalJson(observed.video.timeBase));
    if (reasons.length) failures.push({ segmentId: segment.segmentId, reasons });
  }
  for (const observedId of observedById.keys()) {
    if (!executionPlan.segments.some((segment) => segment.segmentId === observedId)) {
      failures.push({ segmentId: observedId, reasons: ["unexpected-segment-observation"] });
    }
  }
  if (extradata.size > 1) failures.push({ segmentId: null, reasons: ["video-codec-extradata-mismatch"] });
  if (videoTimeBases.size > 1) failures.push({ segmentId: null, reasons: ["video-timebase-mismatch"] });
  if (failures.length === 0) {
    return signConcatDecision({
      kind: CONCAT_DECISION_KIND,
      schemaVersion: CONCAT_DECISION_SCHEMA_VERSION,
      executable: true,
      action: executionPlan.segments.length === 1 ? "publish-single-segment" : "concat-stream-copy",
      executionPlanSignature: executionPlan.executionPlanSignature,
      segmentOrder: executionPlan.segments.map((segment) => segment.segmentId),
      outputContract: expectedContract,
      failures: [],
      replacementExecutionPlan: null,
    });
  }
  const hardFail = mismatchPolicy === "hard-fail";
  const replacementExecutionPlan = hardFail ? null : fallbackPlan({
    expected: {
      ...executionPlan.identities,
      ...executionPlan.timeline,
    },
    contract: expectedContract,
    reason: "segment-output-contract-mismatch",
    sourceProofSignature: executionPlan.sourceProofSignature,
    executionInputs: executionPlan.executionInputs ?? null,
  });
  return signConcatDecision({
    kind: CONCAT_DECISION_KIND,
    schemaVersion: CONCAT_DECISION_SCHEMA_VERSION,
    executable: false,
    action: hardFail ? "hard-fail" : "rerender-uniform-screenshot",
    executionPlanSignature: executionPlan.executionPlanSignature,
    segmentOrder: executionPlan.segments.map((segment) => segment.segmentId),
    outputContract: expectedContract,
    failures,
    replacementExecutionPlan,
  });
}
