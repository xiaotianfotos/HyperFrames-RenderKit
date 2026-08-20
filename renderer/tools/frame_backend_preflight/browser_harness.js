(function installHyperframesBackendPreflightHarness(global) {
  "use strict";

  const wait = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));
  const nextPaint = () => new Promise((resolve) => requestAnimationFrame(() => resolve()));
  let pendingAdapterWaits = [];

  function finite(value, name) {
    const parsed = Number(value);
    if (!Number.isFinite(parsed)) throw new Error(`${name} must be finite`);
    return parsed;
  }

  function rootElement() {
    const roots = [...document.querySelectorAll("[data-composition-id]")];
    if (roots.length !== 1) throw new Error(`expected exactly one composition root; found ${roots.length}`);
    return roots[0];
  }

  function activeTimeline(root, timelineKey) {
    const timelines = global.__timelines ?? {};
    return timelines[timelineKey]
      ?? timelines.main
      ?? timelines[root.dataset.compositionId]
      ?? Object.values(timelines)[0]
      ?? null;
  }

  function setClipLifecycle(root, timeSeconds) {
    for (const clip of root.querySelectorAll(":scope > .clip")) {
      const start = Number(clip.dataset.start || 0);
      const duration = clip.dataset.duration == null || clip.dataset.duration === ""
        ? Number.POSITIVE_INFINITY
        : Number(clip.dataset.duration);
      const active = timeSeconds >= start && timeSeconds < start + duration;
      clip.style.visibility = active ? "visible" : "hidden";
    }
  }

  async function waitForReady({ width, height, timelineKey, readyTimeoutMs = 30_000 }) {
    await document.fonts?.ready;
    const startedAt = performance.now();
    while (true) {
      const root = document.querySelector("[data-composition-id]");
      const timeline = root ? activeTimeline(root, timelineKey) : null;
      const declaresAdapter = typeof global.__hyperframesBackendPreflightHooks?.seek === "function";
      if (root && (timeline || declaresAdapter || root.dataset.duration)) break;
      if (performance.now() - startedAt > readyTimeoutMs) {
        throw new Error("composition root/timeline did not initialize before timeout");
      }
      await wait(20);
    }
    const root = rootElement();
    const rect = root.getBoundingClientRect();
    const tolerance = 0.05;
    if (Math.abs(rect.left) > tolerance || Math.abs(rect.top) > tolerance
        || Math.abs(rect.width - width) > tolerance || Math.abs(rect.height - height) > tolerance) {
      throw new Error(
        `composition root must exactly fill the capture viewport; got `
        + `${rect.left},${rect.top} ${rect.width}x${rect.height}, expected 0,0 ${width}x${height}`,
      );
    }
    await Promise.all([...document.images].map((image) => image.complete
      ? image.decode?.().catch(() => {})
      : new Promise((resolve) => image.addEventListener("load", resolve, { once: true }))));
    await nextPaint();
    await nextPaint();
    return {
      compositionId: root.dataset.compositionId,
      width: rect.width,
      height: rect.height,
      timelineAvailable: activeTimeline(root, timelineKey) !== null,
    };
  }

  async function seekFrame(context, config) {
    const root = rootElement();
    const timeSeconds = finite(context.timeSeconds, "timeSeconds");
    setClipLifecycle(root, timeSeconds);
    const timeline = activeTimeline(root, config.timelineKey);
    if (typeof timeline?.seek === "function") timeline.seek(timeSeconds, false);
    else if (typeof timeline?.time === "function") timeline.time(timeSeconds, false);
    else if (timeline != null) throw new Error("timeline does not expose seek() or time()");

    pendingAdapterWaits = [];
    const waitUntil = (promise) => pendingAdapterWaits.push(Promise.resolve(promise));
    global.__hfThreeTime = timeSeconds;
    global.__hfTypegpuTime = timeSeconds;
    global.dispatchEvent(new CustomEvent("hf-seek", { detail: { time: timeSeconds, waitUntil } }));
    await global.__hyperframesBackendPreflightHooks?.seek?.({ ...context, waitUntil });
  }

  async function settleFrame(context, config) {
    await Promise.all(pendingAdapterWaits);
    await global.__hyperframesBackendPreflightHooks?.settle?.(context);
    await document.fonts?.ready;
    await nextPaint();
    await nextPaint();
    await wait(0);
    await nextPaint();
    if (config.settleDelayMs > 0) await wait(config.settleDelayMs);
  }

  function basePrepassConfig(config) {
    return {
      root: rootElement(),
      frameCount: config.frameCount,
      startFrame: config.startFrame,
      fpsNumerator: config.fpsNumerator,
      fpsDenominator: config.fpsDenominator,
      backends: [{ name: "screenshot", eligible: true, oracle: true }],
      order: ["screenshot"],
      seekFrame: (context) => seekFrame(context, config),
      settleFrame: (context) => settleFrame(context, config),
      blockerPolicy: "return",
      checkpointEvery: config.checkpointEvery,
      onCheckpoint: (checkpoint) => {
        console.log(`HF_BACKEND_PREFLIGHT_CHECKPOINT ${JSON.stringify(checkpoint)}`);
      },
    };
  }

  async function discover(config) {
    await waitForReady(config);
    const pairs = new Map();
    let manifestOverflow = false;
    const result = await global.HyperframesFrameRiskInventory.runFrameBackendPrepass({
      ...basePrepassConfig(config),
      mode: "audit",
      determinismPasses: 1,
      retainRanges: false,
      inventoryOptions: { mode: "audit", unknownRiskPolicy: "oracle" },
      afterFrame: ({ snapshot }) => {
        for (const risk of snapshot.risks) {
          const key = JSON.stringify([risk.id, risk.feature]);
          if (!pairs.has(key)) {
            if (pairs.size >= config.maxManifestEntries) manifestOverflow = true;
            else pairs.set(key, { id: risk.id, feature: risk.feature });
          }
        }
      },
    });
    if (manifestOverflow) {
      throw new Error(`risk manifest exceeded bounded limit ${config.maxManifestEntries}`);
    }
    return {
      expectedRisks: [...pairs.values()].sort((left, right) => (
        left.id.localeCompare(right.id) || left.feature.localeCompare(right.feature)
      )),
      auditSummary: result.prepassSummary,
    };
  }

  async function production(config, expectedRisks) {
    await waitForReady(config);
    try {
      const plan = await global.HyperframesFrameRiskInventory.runFrameBackendPrepass({
        ...basePrepassConfig(config),
        mode: "production",
        determinismPasses: 2,
        projectIdentity: config.projectIdentity,
        renderPlanIdentity: config.renderPlanIdentity,
        machineProfileIdentity: config.machineProfileIdentity,
        styleOverrideProfileHash: config.styleOverrideProfileHash,
        retainRanges: true,
        maxRetainedRanges: config.maxRetainedRanges,
        maxRetainedBlockerRanges: config.maxRetainedBlockerRanges,
        inventoryOptions: {
          mode: "production",
          expectedRisks,
          unknownRiskPolicy: "oracle",
          inventoryStrategy: "full-scan",
        },
      });
      return { ok: true, plan };
    } catch (error) {
      return {
        ok: false,
        code: error?.code ?? "FRAME_BACKEND_PREFLIGHT_FAILED",
        message: String(error?.message ?? error),
        stack: error?.stack ?? null,
        plan: error?.plan ?? null,
      };
    }
  }

  async function seekAndSettle(context, config) {
    await seekFrame(context, config);
    await settleFrame(context, config);
    return { timelineFrame: context.timelineFrame, timeSeconds: context.timeSeconds };
  }

  function candidateContract() {
    const contract = global.__hyperframesBackendPreflightCandidate;
    return contract && typeof contract === "object" ? JSON.parse(JSON.stringify(contract)) : null;
  }

  global.HyperframesBackendPreflightHarness = Object.freeze({
    waitForReady,
    discover,
    production,
    seekAndSettle,
    candidateContract,
  });
})(typeof globalThis === "undefined" ? window : globalThis);
