const MIB = 1024 * 1024;
const GIB = 1024 * MIB;

function finiteInteger(value, name, minimum = 0) {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < minimum) {
    throw new Error(`${name} must be a safe integer >= ${minimum}; got ${value}`);
  }
  return number;
}

export function deriveRenderMemoryWatchdogPolicy(options = {}) {
  const totalMemoryBytes = finiteInteger(options.totalMemoryBytes, "totalMemoryBytes", 512 * MIB);
  const intervalMs = finiteInteger(options.intervalMs ?? 1_000, "intervalMs", 100);
  const consecutiveBreaches = finiteInteger(options.consecutiveBreaches ?? 3, "consecutiveBreaches", 1);
  const automaticMinAvailableBytes = Math.min(
    4 * GIB,
    Math.max(1 * GIB, Math.floor(totalMemoryBytes * 0.08)),
  );
  const minAvailableBytes = finiteInteger(
    options.minAvailableBytes ?? automaticMinAvailableBytes,
    "minAvailableBytes",
    256 * MIB,
  );
  if (minAvailableBytes >= totalMemoryBytes) {
    throw new Error(`minAvailableBytes ${minAvailableBytes} must be below total memory ${totalMemoryBytes}`);
  }
  const automaticMaxAggregateRssBytes = Math.min(
    16 * GIB,
    Math.max(2 * GIB, Math.floor(totalMemoryBytes * 0.5)),
    totalMemoryBytes - minAvailableBytes,
  );
  const maxAggregateRssBytes = finiteInteger(
    options.maxAggregateRssBytes ?? automaticMaxAggregateRssBytes,
    "maxAggregateRssBytes",
    512 * MIB,
  );
  if (maxAggregateRssBytes > totalMemoryBytes - minAvailableBytes) {
    throw new Error(
      `maxAggregateRssBytes ${maxAggregateRssBytes} leaves less than the required `
      + `${minAvailableBytes} bytes available`,
    );
  }
  return {
    kind: "hyperframes-render-memory-watchdog-policy",
    schemaVersion: 1,
    totalMemoryBytes,
    intervalMs,
    consecutiveBreaches,
    minAvailableBytes,
    maxAggregateRssBytes,
    automatic: {
      minAvailableBytes: automaticMinAvailableBytes,
      maxAggregateRssBytes: automaticMaxAggregateRssBytes,
    },
    contract: [
      "Electron process working sets and known external child RSS are sampled; this is not a GPU-driver allocation meter",
      "a limit must be breached in consecutive samples before the render is aborted",
      "capture boundaries are sampled in addition to the periodic timer",
    ],
  };
}

function normalizeProcessMetrics(appMetrics = []) {
  return appMetrics.map((metric) => {
    const workingSetKb = Number(metric?.memory?.workingSetSize);
    if (!Number.isFinite(workingSetKb) || workingSetKb < 0) {
      throw new Error(`Electron app metric has invalid workingSetSize: ${workingSetKb}`);
    }
    return {
      pid: Number(metric.pid),
      type: String(metric.type ?? "Unknown"),
      rssBytes: Math.round(workingSetKb * 1024),
    };
  });
}

export function createRenderMemoryWatchdogRecorder(policy) {
  if (policy?.kind !== "hyperframes-render-memory-watchdog-policy") {
    throw new Error("A derived render memory watchdog policy is required");
  }
  let samplesObserved = 0;
  let rssBreachCount = 0;
  let availableBreachCount = 0;
  let peakAggregateRssBytes = 0;
  let minAvailableBytes = Number.POSITIVE_INFINITY;
  const peakRssByType = new Map();
  const retained = [];
  let latest = null;
  let violation = null;

  function record(sample) {
    const processes = normalizeProcessMetrics(sample.appMetrics);
    const externalRssBytes = finiteInteger(sample.externalRssBytes ?? 0, "externalRssBytes", 0);
    const availableMemoryBytes = finiteInteger(sample.availableMemoryBytes, "availableMemoryBytes", 0);
    const electronRssBytes = processes.reduce((sum, item) => sum + item.rssBytes, 0);
    const aggregateRssBytes = electronRssBytes + externalRssBytes;
    samplesObserved += 1;
    peakAggregateRssBytes = Math.max(peakAggregateRssBytes, aggregateRssBytes);
    minAvailableBytes = Math.min(minAvailableBytes, availableMemoryBytes);
    for (const item of processes) {
      peakRssByType.set(item.type, Math.max(peakRssByType.get(item.type) ?? 0, item.rssBytes));
    }
    rssBreachCount = aggregateRssBytes > policy.maxAggregateRssBytes ? rssBreachCount + 1 : 0;
    availableBreachCount = availableMemoryBytes < policy.minAvailableBytes ? availableBreachCount + 1 : 0;
    latest = {
      index: samplesObserved - 1,
      stage: String(sample.stage ?? "periodic"),
      elapsedMs: Number(sample.elapsedMs ?? 0),
      availableMemoryBytes,
      electronRssBytes,
      externalRssBytes,
      aggregateRssBytes,
      processCount: processes.length,
      rssBreachCount,
      availableBreachCount,
    };
    if (retained.length < 8) retained.push(latest);
    else {
      retained.push(latest);
      if (retained.length > 24) retained.splice(8, 1);
    }
    if (!violation && rssBreachCount >= policy.consecutiveBreaches) {
      violation = {
        code: "HF_RENDER_MEMORY_RSS_LIMIT",
        message: `aggregate render RSS ${aggregateRssBytes} exceeded ${policy.maxAggregateRssBytes} `
          + `for ${rssBreachCount} consecutive samples`,
        sample: latest,
      };
    }
    if (!violation && availableBreachCount >= policy.consecutiveBreaches) {
      violation = {
        code: "HF_RENDER_MEMORY_AVAILABLE_LIMIT",
        message: `available system memory ${availableMemoryBytes} fell below ${policy.minAvailableBytes} `
          + `for ${availableBreachCount} consecutive samples`,
        sample: latest,
      };
    }
    return { sample: latest, violation };
  }

  function snapshot() {
    return {
      policy,
      samplesObserved,
      peakAggregateRssBytes,
      minAvailableBytes: Number.isFinite(minAvailableBytes) ? minAvailableBytes : null,
      peakRssByType: Object.fromEntries([...peakRssByType].sort(([left], [right]) => left.localeCompare(right))),
      latest,
      violation,
      retainedSamples: retained,
    };
  }

  return { record, snapshot };
}
