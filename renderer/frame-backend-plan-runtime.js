(function installHyperframesFrameBackendPlan(global) {
  "use strict";

  const KIND = "hyperframes-frame-backend-plan";
  const SCHEMA_VERSION = 2;
  const MODES = Object.freeze(["production", "audit"]);
  const DEFAULT_ORDER = Object.freeze([
    "ffmpeg-only",
    "proxy-tree",
    "layered-manual",
    "screenshot",
  ]);
  const DEFAULT_MAX_RETAINED_RANGES = 4096;
  const DEFAULT_MAX_RETAINED_BLOCKER_RANGES = 128;

  function integer(value, name, { minimum = 0 } = {}) {
    if (!Number.isSafeInteger(value) || value < minimum) {
      throw new Error(`${name} must be an integer >= ${minimum}, received ${value}`);
    }
    return value;
  }

  function finiteNumber(value, name) {
    const parsed = Number(value);
    if (!Number.isFinite(parsed)) throw new Error(`${name} must be finite, received ${value}`);
    return Object.is(parsed, -0) ? 0 : parsed;
  }

  function key(value, name, { nullable = false } = {}) {
    if (value == null && nullable) return null;
    const normalized = String(value ?? "").trim();
    if (!normalized) throw new Error(`${name} must be a non-empty string`);
    if (/[^\x20-\x7e]/.test(normalized)) throw new Error(`${name} must not contain control or non-ASCII characters`);
    if (normalized.length > 512) throw new Error(`${name} must be <= 512 characters`);
    return normalized;
  }

  function identity(value, name) {
    return value == null ? null : key(value, name, { nullable: true });
  }

  function mode(value) {
    const normalized = value ?? "production";
    if (!MODES.includes(normalized)) {
      throw new Error(`mode must be one of ${MODES.join(", ")}, received ${normalized}`);
    }
    return normalized;
  }

  function rectSignature(raw) {
    if (raw == null) return null;
    const left = finiteNumber(raw.left ?? raw.x, "risk.evidence.rect.left");
    const top = finiteNumber(raw.top ?? raw.y, "risk.evidence.rect.top");
    const width = finiteNumber(raw.width ?? Number(raw.right) - left, "risk.evidence.rect.width");
    const height = finiteNumber(raw.height ?? Number(raw.bottom) - top, "risk.evidence.rect.height");
    if (width < 0 || height < 0) throw new Error("risk.evidence.rect dimensions must not be negative");
    const right = finiteNumber(raw.right ?? left + width, "risk.evidence.rect.right");
    const bottom = finiteNumber(raw.bottom ?? top + height, "risk.evidence.rect.bottom");
    if (right < left || bottom < top
      || Math.abs((right - left) - width) > 1e-6
      || Math.abs((bottom - top) - height) > 1e-6) {
      throw new Error("risk.evidence.rect edges and dimensions are inconsistent");
    }
    return Object.freeze({
      left,
      top,
      right,
      bottom,
      width,
      height,
    });
  }

  function riskClassification(raw, evidence) {
    const reasons = new Set(Array.isArray(raw?.unknownReasons) ? raw.unknownReasons.map(String) : []);
    if (raw?.unknown === true) reasons.add("unknown");
    if (evidence?.dynamicRiskNode === true) reasons.add("unknown-node");
    if (evidence?.unknownFeature === true) reasons.add("unknown-feature");
    if (evidence?.uninspectable === true) reasons.add("uninspectable");
    return Object.freeze([...reasons].sort());
  }

  function normalizedStringList(value, name) {
    if (value == null) return Object.freeze([]);
    if (!Array.isArray(value)) throw new Error(`${name} must be an array`);
    const normalized = value.map((item, index) => key(item, `${name}[${index}]`));
    if (new Set(normalized).size !== normalized.length) throw new Error(`${name} must not contain duplicates`);
    return Object.freeze(normalized.sort(compareCanonicalText));
  }

  function normalizeRisk(raw) {
    const evidence = raw?.evidence && typeof raw.evidence === "object" ? raw.evidence : {};
    const propertyValue = evidence.property ?? raw?.property;
    const computedValue = evidence.value ?? raw?.value;
    const property = propertyValue == null ? null : String(propertyValue).trim();
    const value = computedValue == null ? null : String(computedValue).trim();
    const rect = rectSignature(evidence.rect ?? raw?.rect ?? null);
    const cumulativeOpacity = evidence.cumulativeOpacity == null
      ? null
      : finiteNumber(evidence.cumulativeOpacity, "risk.evidence.cumulativeOpacity");
    const intersectionArea = evidence.intersectionArea == null
      ? null
      : finiteNumber(evidence.intersectionArea, "risk.evidence.intersectionArea");
    const unknownReasons = riskClassification(raw, evidence);
    const blockedBackends = normalizedStringList(raw?.blockedBackends, "risk.blockedBackends");
    return Object.freeze({
      id: key(raw?.id, "risk.id"),
      feature: key(raw?.feature, "risk.feature"),
      active: raw?.active !== false,
      blocker: raw?.blocker === true,
      blockedBackends,
      unknown: unknownReasons.length > 0,
      unknownReasons,
      signatureComplete: property !== null
        && value !== null
        && rect !== null
        && cumulativeOpacity !== null
        && intersectionArea !== null,
      evidence: Object.freeze({
        ...evidence,
        property,
        value,
        rect,
        cumulativeOpacity,
        intersectionArea,
        pseudoGeometryUnknown: evidence.pseudoGeometryUnknown === true,
      }),
    });
  }

  function riskAtom(risk) {
    const evidence = risk.evidence;
    let classification = "known";
    if (risk.unknownReasons.includes("uninspectable")) classification = "uninspectable";
    else if (risk.unknownReasons.includes("unknown-node") && risk.unknownReasons.includes("unknown-feature")) {
      classification = "unknown-node-and-feature";
    } else if (risk.unknownReasons.includes("unknown-node")) classification = "unknown-node";
    else if (risk.unknownReasons.includes("unknown-feature")) classification = "unknown-feature";
    else if (risk.unknown) classification = "unknown";
    return Object.freeze({
      feature: risk.feature,
      id: risk.id,
      property: evidence.property,
      value: evidence.value,
      rect: evidence.rect,
      intersectionArea: evidence.intersectionArea,
      cumulativeOpacity: evidence.cumulativeOpacity,
      pseudoGeometryUnknown: evidence.pseudoGeometryUnknown,
      classification,
      blocker: risk.blocker,
      blockedBackends: risk.blockedBackends,
    });
  }

  function canonicalJson(value) {
    if (value === null || typeof value !== "object") return JSON.stringify(value);
    if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
    const entries = Object.keys(value)
      .sort()
      .map((item) => `${JSON.stringify(item)}:${canonicalJson(value[item])}`);
    return `{${entries.join(",")}}`;
  }

  function compareCanonicalText(left, right) {
    return left < right ? -1 : left > right ? 1 : 0;
  }

  function createRiskSignature(rawRisks = []) {
    if (!Array.isArray(rawRisks)) throw new Error("risks must be an array");
    const atomsByKey = new Map();
    for (const rawRisk of rawRisks) {
      const risk = rawRisk?.evidence?.rect !== undefined && rawRisk?.signatureComplete !== undefined
        ? rawRisk
        : normalizeRisk(rawRisk);
      if (!risk.active) continue;
      const atom = riskAtom(risk);
      atomsByKey.set(canonicalJson(atom), atom);
    }
    return Object.freeze([...atomsByKey.entries()]
      .sort(([left], [right]) => compareCanonicalText(left, right))
      .map(([, atom]) => atom));
  }

  function normalizeProofAtom(raw, name) {
    if (!raw || typeof raw !== "object") throw new Error(`${name} must be an object`);
    const rect = raw.rect == null ? null : rectSignature(raw.rect);
    return Object.freeze({
      feature: key(raw.feature, `${name}.feature`),
      id: key(raw.id, `${name}.id`),
      property: raw.property == null ? null : String(raw.property).trim(),
      value: raw.value == null ? null : String(raw.value).trim(),
      rect,
      intersectionArea: raw.intersectionArea == null
        ? null
        : finiteNumber(raw.intersectionArea, `${name}.intersectionArea`),
      cumulativeOpacity: raw.cumulativeOpacity == null
        ? null
        : finiteNumber(raw.cumulativeOpacity, `${name}.cumulativeOpacity`),
      pseudoGeometryUnknown: raw.pseudoGeometryUnknown === true,
      classification: raw.classification == null ? "known" : key(raw.classification, `${name}.classification`),
      blocker: raw.blocker === true,
      blockedBackends: normalizedStringList(raw.blockedBackends, `${name}.blockedBackends`),
    });
  }

  function normalizeProofSignature(raw, name) {
    if (!Array.isArray(raw)) throw new Error(`${name} must be an array`);
    const atomsByKey = new Map();
    raw.forEach((atom, index) => {
      const normalized = normalizeProofAtom(atom, `${name}[${index}]`);
      atomsByKey.set(canonicalJson(normalized), normalized);
    });
    return Object.freeze([...atomsByKey.entries()]
      .sort(([left], [right]) => compareCanonicalText(left, right))
      .map(([, atom]) => atom));
  }

  function proofKey({
    projectIdentity,
    renderPlanIdentity,
    machineProfileIdentity,
    gateProfileHash,
    styleOverrideProfileHash,
    requiresBrowserPaint,
    riskSignature,
  }) {
    return canonicalJson({
      projectIdentity,
      renderPlanIdentity,
      machineProfileIdentity,
      gateProfileHash,
      styleOverrideProfileHash,
      requiresBrowserPaint,
      riskSignature,
    });
  }

  function normalizeProof(raw, backendName, index) {
    if (!raw || typeof raw !== "object") {
      throw new Error(`${backendName}.provenRiskSignatures[${index}] must be an object`);
    }
    if (typeof raw.requiresBrowserPaint !== "boolean") {
      throw new Error(`${backendName}.provenRiskSignatures[${index}].requiresBrowserPaint must be boolean`);
    }
    const normalized = {
      projectIdentity: identity(raw.projectIdentity, `${backendName}.proof.projectIdentity`),
      renderPlanIdentity: identity(raw.renderPlanIdentity, `${backendName}.proof.renderPlanIdentity`),
      machineProfileIdentity: identity(raw.machineProfileIdentity, `${backendName}.proof.machineProfileIdentity`),
      gateProfileHash: identity(raw.gateProfileHash, `${backendName}.proof.gateProfileHash`),
      styleOverrideProfileHash: identity(raw.styleOverrideProfileHash, `${backendName}.proof.styleOverrideProfileHash`),
      requiresBrowserPaint: raw.requiresBrowserPaint,
      riskSignature: normalizeProofSignature(raw.riskSignature ?? [], `${backendName}.proof.riskSignature`),
    };
    return Object.freeze({ ...normalized, key: proofKey(normalized) });
  }

  function normalizeBackend(raw, index) {
    const name = key(raw?.name, `backends[${index}].name`);
    const oracle = raw?.oracle === true || name === "screenshot";
    const gateProfileHash = identity(raw?.gateProfileHash, `${name}.gateProfileHash`);
    if (raw?.eligible === true && !oracle && gateProfileHash == null) {
      throw new Error(`${name}.gateProfileHash is required for an eligible non-oracle backend`);
    }
    const proofs = (raw?.provenRiskSignatures ?? []).map((item, proofIndex) => normalizeProof(item, name, proofIndex));
    return Object.freeze({
      name,
      eligible: raw?.eligible === true,
      oracle,
      supportsBrowserPaint: name === "ffmpeg-only" ? false : raw?.supportsBrowserPaint !== false,
      gateProfileHash,
      ineligibleReason: identity(raw?.ineligibleReason, `${name}.ineligibleReason`),
      proofKeys: new Set(proofs.map((item) => item.key)),
      hasLegacyFeaturePolicy: raw?.allowsUnknown !== undefined || raw?.supportedFeatures !== undefined,
    });
  }

  function profileComplete(context, backend) {
    return context.projectIdentity !== null
      && context.renderPlanIdentity !== null
      && context.machineProfileIdentity !== null
      && backend.gateProfileHash !== null;
  }

  function backendDecision(backend, risks, context) {
    if (!backend.eligible) {
      return { accepted: false, reason: "backend-ineligible", detail: backend.ineligibleReason };
    }
    if (risks.some((risk) => risk.blocker)) return { accepted: false, reason: "hard-blocker" };
    const backendBlocker = risks.find((risk) => risk.blockedBackends.includes(backend.name));
    if (backendBlocker) {
      return {
        accepted: false,
        reason: "backend-specific-blocker",
        detail: backendBlocker.evidence?.code ?? backendBlocker.feature,
      };
    }
    if (context.requiresBrowserPaint && !backend.supportsBrowserPaint) {
      return { accepted: false, reason: "browser-paint-unsupported" };
    }
    if (backend.oracle) return { accepted: true, reason: "oracle" };
    if (context.inventoryState !== "complete") return { accepted: false, reason: "inventory-incomplete" };
    if (risks.some((risk) => risk.unknown)) return { accepted: false, reason: "unknown-risk" };
    if (risks.some((risk) => !risk.signatureComplete)) {
      return { accepted: false, reason: "incomplete-risk-signature" };
    }
    if (!profileComplete(context, backend)) return { accepted: false, reason: "profile-incomplete" };
    const exactKey = proofKey({
      projectIdentity: context.projectIdentity,
      renderPlanIdentity: context.renderPlanIdentity,
      machineProfileIdentity: context.machineProfileIdentity,
      gateProfileHash: backend.gateProfileHash,
      styleOverrideProfileHash: context.styleOverrideProfileHash,
      requiresBrowserPaint: context.requiresBrowserPaint,
      riskSignature: context.riskSignature,
    });
    if (!backend.proofKeys.has(exactKey)) return { accepted: false, reason: "exact-signature-unproven" };
    return { accepted: true, reason: "exact-signature-proof" };
  }

  function chooseBackend(risks, backendByName, order, context) {
    const rejections = [];
    for (const name of order) {
      const backend = backendByName.get(name);
      const decision = backendDecision(backend, risks, context);
      if (decision.accepted) return { backend, reason: decision.reason, rejections };
      rejections.push(Object.freeze({ backend: name, reason: decision.reason, detail: decision.detail ?? null }));
    }
    return { backend: null, reason: "no-eligible-backend", rejections };
  }

  function boundaryGoldenFrames(startFrame, endFrameExclusive, firstFrame, totalEndFrame) {
    const candidates = [
      startFrame - 1,
      startFrame,
      startFrame + 1,
      endFrameExclusive - 2,
      endFrameExclusive - 1,
      endFrameExclusive,
    ];
    return [...new Set(candidates.filter((frame) => frame >= firstFrame && frame < totalEndFrame))]
      .sort((left, right) => left - right);
  }

  function normalizeOrder(rawOrder, backendByName) {
    let normalized;
    if (rawOrder == null) {
      normalized = [
        ...DEFAULT_ORDER.filter((name) => backendByName.has(name)),
        ...[...backendByName.keys()].filter((name) => !DEFAULT_ORDER.includes(name)).sort(),
      ];
    } else {
      if (!Array.isArray(rawOrder) || rawOrder.length === 0) throw new Error("order must be a non-empty array");
      normalized = rawOrder.map((item, index) => key(item, `order[${index}]`));
      if (new Set(normalized).size !== normalized.length) throw new Error("order must not contain duplicates");
      for (const name of normalized) {
        if (!backendByName.has(name)) throw new Error(`order references unknown backend ${name}`);
      }
      const missing = [...backendByName.keys()].filter((name) => !normalized.includes(name));
      if (missing.length) throw new Error(`order must include every configured backend; missing ${missing.join(", ")}`);
    }
    return Object.freeze(normalized);
  }

  function createFrameBackendPlanBuilder({
    frameCount,
    startFrame = 0,
    fpsNumerator,
    fpsDenominator = 1,
    backends,
    order = null,
    mode: requestedMode = "production",
    projectIdentity = null,
    renderPlanIdentity = null,
    machineProfileIdentity = null,
    styleOverrideProfileHash = null,
    retainRanges = requestedMode !== "audit",
    maxRetainedRanges = DEFAULT_MAX_RETAINED_RANGES,
    maxRetainedBlockerRanges = DEFAULT_MAX_RETAINED_BLOCKER_RANGES,
    onRange = null,
  }) {
    integer(frameCount, "frameCount", { minimum: 1 });
    integer(startFrame, "startFrame");
    integer(fpsNumerator, "fpsNumerator", { minimum: 1 });
    integer(fpsDenominator, "fpsDenominator", { minimum: 1 });
    integer(maxRetainedRanges, "maxRetainedRanges", { minimum: 1 });
    integer(maxRetainedBlockerRanges, "maxRetainedBlockerRanges", { minimum: 1 });
    const normalizedMode = mode(requestedMode);
    if (!Array.isArray(backends) || !backends.length) throw new Error("backends must be a non-empty array");
    if (onRange != null && typeof onRange !== "function") throw new Error("onRange must be a function");

    const normalizedProjectIdentity = identity(projectIdentity, "projectIdentity");
    const normalizedRenderPlanIdentity = identity(renderPlanIdentity, "renderPlanIdentity");
    const normalizedMachineProfileIdentity = identity(machineProfileIdentity, "machineProfileIdentity");
    const normalizedStyleOverrideProfileHash = identity(styleOverrideProfileHash, "styleOverrideProfileHash");
    const normalizedBackends = backends.map(normalizeBackend);
    const backendByName = new Map();
    for (const backend of normalizedBackends) {
      if (backendByName.has(backend.name)) throw new Error(`duplicate backend name ${backend.name}`);
      backendByName.set(backend.name, backend);
    }
    const normalizedOrder = normalizeOrder(order, backendByName);
    const totalEndFrame = startFrame + frameCount;
    const ranges = [];
    const blockers = [];
    const framesByBackend = new Map();
    const warnings = [];
    if (normalizedBackends.some((backend) => backend.hasLegacyFeaturePolicy)) {
      warnings.push("supportedFeatures/allowsUnknown are ignored; non-oracle backends require exact provenRiskSignatures");
    }
    let nextOffset = 0;
    let finished = false;
    let openRange = null;
    let openBlocker = null;
    let rangeCount = 0;
    let blockerFrames = 0;
    let blockerRangeCount = 0;
    let rangesTruncated = false;
    let blockersTruncated = false;

    function finalizeBlocker() {
      if (!openBlocker) return;
      blockerRangeCount += 1;
      const finalizedBlocker = { ...openBlocker };
      delete finalizedBlocker.blockerKey;
      if (blockers.length < maxRetainedBlockerRanges) blockers.push(finalizedBlocker);
      else blockersTruncated = true;
      openBlocker = null;
    }

    function recordBlocker(timelineFrame, riskSignature, reason, rejections) {
      blockerFrames += 1;
      const blockerKey = canonicalJson({ riskSignature, reason, rejections });
      if (openBlocker?.blockerKey === blockerKey && openBlocker.endFrameExclusive === timelineFrame) {
        openBlocker.endFrameExclusive += 1;
        return;
      }
      finalizeBlocker();
      openBlocker = {
        blockerKey,
        startFrame: timelineFrame,
        endFrameExclusive: timelineFrame + 1,
        reason,
        rejections,
        riskSignature,
        executable: false,
      };
    }

    function finalizeRange() {
      if (!openRange) return;
      openRange.goldenFrames = Object.freeze(boundaryGoldenFrames(
        openRange.startFrame,
        openRange.endFrameExclusive,
        startFrame,
        totalEndFrame,
      ));
      delete openRange.rangeKey;
      rangeCount += 1;
      const emitted = Object.freeze({ ...openRange, riskSignature: openRange.riskSignature });
      if (onRange) onRange(emitted);
      if (retainRanges && ranges.length < maxRetainedRanges) ranges.push(openRange);
      else if (retainRanges) rangesTruncated = true;
      openRange = null;
    }

    function addFrame(raw = {}) {
      if (finished) throw new Error("frame backend plan builder is already finished");
      if (nextOffset >= frameCount) throw new Error(`received more than ${frameCount} frames`);
      const timelineFrame = raw.timelineFrame == null
        ? startFrame + nextOffset
        : integer(raw.timelineFrame, `frames[${nextOffset}].timelineFrame`);
      const expectedFrame = startFrame + nextOffset;
      if (timelineFrame !== expectedFrame) {
        throw new Error(`frames[${nextOffset}] timelineFrame ${timelineFrame} != expected ${expectedFrame}`);
      }
      if (raw.risks != null && !Array.isArray(raw.risks)) throw new Error(`frames[${nextOffset}].risks must be an array`);

      const inventoryState = raw.inventoryState === "complete" && Array.isArray(raw.risks)
        ? "complete"
        : "incomplete";
      const risks = (raw.risks ?? []).map(normalizeRisk).filter((risk) => risk.active);
      for (const risk of risks) {
        for (const backendName of risk.blockedBackends) {
          if (!backendByName.has(backendName)) {
            throw new Error(`risk ${risk.id} blocks unknown backend ${backendName}`);
          }
        }
      }
      if (inventoryState !== "complete") {
        risks.push(normalizeRisk({
          id: ":frame-inventory",
          feature: "unknown-frame-inventory",
          unknown: true,
          evidence: {
            property: "inventoryState",
            value: String(raw.inventoryState ?? "missing"),
            rect: { left: 0, top: 0, right: 0, bottom: 0, width: 0, height: 0 },
            intersectionArea: 0,
            cumulativeOpacity: 1,
          },
        }));
      }
      const requiresBrowserPaint = raw.requiresBrowserPaint !== false || risks.length > 0;
      const riskSignature = createRiskSignature(risks);
      const context = {
        projectIdentity: normalizedProjectIdentity,
        renderPlanIdentity: normalizedRenderPlanIdentity,
        machineProfileIdentity: normalizedMachineProfileIdentity,
        styleOverrideProfileHash: normalizedStyleOverrideProfileHash,
        requiresBrowserPaint,
        inventoryState,
        riskSignature,
      };
      const selection = chooseBackend(risks, backendByName, normalizedOrder, context);
      const decision = Object.freeze({
        timelineFrame,
        backend: selection.backend?.name ?? "fail",
        executable: false,
        decisionBasis: selection.reason,
        gateProfileHash: selection.backend?.gateProfileHash ?? null,
        styleOverrideProfileHash: normalizedStyleOverrideProfileHash,
        requiresBrowserPaint,
        inventoryState,
        riskSignature,
        rejections: Object.freeze(selection.rejections),
      });

      if (!selection.backend) {
        recordBlocker(timelineFrame, riskSignature, selection.reason, decision.rejections);
      } else {
        finalizeBlocker();
      }
      framesByBackend.set(decision.backend, (framesByBackend.get(decision.backend) ?? 0) + 1);
      const rangeKey = canonicalJson({
        backend: decision.backend,
        gateProfileHash: decision.gateProfileHash,
        styleOverrideProfileHash: decision.styleOverrideProfileHash,
        requiresBrowserPaint,
        inventoryState,
        decisionBasis: decision.decisionBasis,
        riskSignature,
        rejections: decision.rejections,
      });
      if (openRange?.rangeKey === rangeKey && openRange.endFrameExclusive === timelineFrame) {
        openRange.endFrameExclusive += 1;
      } else {
        finalizeRange();
        openRange = {
          rangeKey,
          startFrame: timelineFrame,
          endFrameExclusive: timelineFrame + 1,
          backend: decision.backend,
          executable: false,
          decisionBasis: decision.decisionBasis,
          gateProfileHash: decision.gateProfileHash,
          styleOverrideProfileHash: decision.styleOverrideProfileHash,
          requiresBrowserPaint,
          inventoryState,
          riskSignature,
          rejectedBackends: decision.rejections,
        };
      }
      nextOffset += 1;
      return decision;
    }

    function checkpoint() {
      return Object.freeze({
        kind: `${KIND}-checkpoint`,
        schemaVersion: SCHEMA_VERSION,
        mode: normalizedMode,
        startFrame,
        nextFrame: startFrame + nextOffset,
        processedFrames: nextOffset,
        frameCount,
        closedRangeCount: rangeCount,
        hasOpenRange: openRange !== null,
        blockerFrames,
        retainedRangeCount: ranges.length,
        retainedBlockerRangeCount: blockers.length,
        rangesTruncated,
        blockersTruncated,
      });
    }

    function finish() {
      if (finished) throw new Error("frame backend plan builder is already finished");
      if (nextOffset !== frameCount) {
        throw new Error(`received ${nextOffset} frames, expected exactly ${frameCount}`);
      }
      finished = true;
      finalizeRange();
      finalizeBlocker();
      const plan = {
        kind: KIND,
        schemaVersion: SCHEMA_VERSION,
        mode: normalizedMode,
        projectIdentity: normalizedProjectIdentity,
        renderPlanIdentity: normalizedRenderPlanIdentity,
        machineProfileIdentity: normalizedMachineProfileIdentity,
        styleOverrideProfileHash: normalizedStyleOverrideProfileHash,
        startFrame,
        frameCount,
        fps: { numerator: fpsNumerator, denominator: fpsDenominator },
        backendOrder: normalizedOrder,
        oracleBackendNames: normalizedBackends.filter((backend) => backend.oracle).map((backend) => backend.name),
        validationState: "pending",
        renderable: false,
        executable: false,
        ranges,
        blockers,
        warnings,
        summary: {
          rangeCount,
          retainedRangeCount: ranges.length,
          rangesRetained: retainRanges,
          rangesTruncated,
          blockerFrames,
          blockerRangeCount,
          retainedBlockerRangeCount: blockers.length,
          blockersTruncated,
          framesByBackend: Object.fromEntries([...framesByBackend.entries()].sort(([left], [right]) => compareCanonicalText(left, right))),
        },
      };
      return plan;
    }

    return Object.freeze({ addFrame, checkpoint, finish });
  }

  function compileFrameBackendPlan({
    frameCount,
    startFrame = 0,
    fpsNumerator,
    fpsDenominator = 1,
    frames,
    backends,
    order = null,
    mode: requestedMode = "production",
    projectIdentity = null,
    renderPlanIdentity = null,
    machineProfileIdentity = null,
    styleOverrideProfileHash = null,
    retainRanges,
    maxRetainedRanges,
    maxRetainedBlockerRanges,
    onRange,
  }) {
    if (!Array.isArray(frames) || frames.length !== frameCount) {
      throw new Error(`frames must contain exactly ${frameCount} entries`);
    }
    const builder = createFrameBackendPlanBuilder({
      frameCount,
      startFrame,
      fpsNumerator,
      fpsDenominator,
      backends,
      order,
      mode: requestedMode,
      projectIdentity,
      renderPlanIdentity,
      machineProfileIdentity,
      styleOverrideProfileHash,
      ...(retainRanges === undefined ? {} : { retainRanges }),
      ...(maxRetainedRanges === undefined ? {} : { maxRetainedRanges }),
      ...(maxRetainedBlockerRanges === undefined ? {} : { maxRetainedBlockerRanges }),
      ...(onRange === undefined ? {} : { onRange }),
    });
    for (const frame of frames) builder.addFrame(frame);
    return builder.finish();
  }

  function finalizeWithOracleValidation(plan, {
    passed,
    oracleBackendName,
    machineProfileIdentity,
    validatedGoldenFrames,
    validationIdentity,
  } = {}) {
    if (plan?.kind !== KIND || plan?.schemaVersion !== SCHEMA_VERSION) {
      throw new Error(`expected ${KIND} schemaVersion ${SCHEMA_VERSION}`);
    }
    if (plan.validationState !== "pending") throw new Error("only a pending plan can be finalized");
    if (!Array.isArray(validatedGoldenFrames)) throw new Error("validatedGoldenFrames must be an array");
    const normalizedValidationIdentity = identity(validationIdentity, "validationIdentity");
    const normalizedMachineIdentity = identity(machineProfileIdentity, "validation.machineProfileIdentity");
    const goldenFrameSet = new Set(validatedGoldenFrames.map((frame, index) => integer(frame, `validatedGoldenFrames[${index}]`)));
    const requiredGoldenFrames = [...new Set(plan.ranges.flatMap((range) => range.goldenFrames))].sort((left, right) => left - right);
    const reasons = [];
    if (passed !== true) reasons.push("oracle-validation-failed");
    if (!plan.oracleBackendNames.includes(oracleBackendName)) reasons.push("oracle-backend-not-declared");
    if (normalizedMachineIdentity !== plan.machineProfileIdentity) reasons.push("machine-profile-mismatch");
    if (normalizedValidationIdentity == null) reasons.push("validation-identity-missing");
    if (plan.projectIdentity == null || plan.renderPlanIdentity == null || plan.machineProfileIdentity == null) {
      reasons.push("plan-identities-incomplete");
    }
    if (plan.mode !== "production") reasons.push("audit-plan-is-never-executable");
    if (plan.summary.blockerFrames > 0) reasons.push("plan-has-blockers");
    if (!plan.summary.rangesRetained || plan.summary.rangesTruncated) reasons.push("range-artifact-incomplete");
    if (plan.determinism?.state !== "passed") reasons.push("determinism-not-proven");
    const missingGoldenFrames = requiredGoldenFrames.filter((frame) => !goldenFrameSet.has(frame));
    if (missingGoldenFrames.length) reasons.push("golden-frame-coverage-incomplete");
    const renderable = reasons.length === 0;
    return {
      ...plan,
      validationState: renderable ? "passed" : "failed",
      renderable,
      executable: renderable,
      ranges: plan.ranges.map((range) => ({ ...range, executable: renderable && range.backend !== "fail" })),
      validation: {
        validationIdentity: normalizedValidationIdentity,
        oracleBackendName: oracleBackendName ?? null,
        machineProfileIdentity: normalizedMachineIdentity,
        requiredGoldenFrames,
        validatedGoldenFrames: [...goldenFrameSet].sort((left, right) => left - right),
        missingGoldenFrames,
        reasons,
      },
    };
  }

  global.HyperframesFrameBackendPlan = Object.freeze({
    KIND,
    SCHEMA_VERSION,
    MODES,
    DEFAULT_ORDER,
    DEFAULT_MAX_RETAINED_RANGES,
    createRiskSignature,
    createFrameBackendPlanBuilder,
    compileFrameBackendPlan,
    finalizeWithOracleValidation,
  });
})(typeof globalThis === "undefined" ? window : globalThis);
