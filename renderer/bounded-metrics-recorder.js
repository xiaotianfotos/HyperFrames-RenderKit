(function installHyperframesBoundedMetrics(global) {
  "use strict";

  const KIND = "hyperframes-bounded-frame-metrics";
  const SCHEMA_VERSION = 1;
  const DEFAULT_NUMERIC_FIELDS = Object.freeze([
    "wallMs",
    "timelineSeekMs",
    "mediaSeekMs",
    "paintWaitMs",
    "drawElementImageMs",
    "videoDrawMs",
    "mediaSnapshotMs",
    "overlayCompositeMs",
    "decoderWakePaintMs",
    "videoFrameCreateMs",
    "encodeSubmitMs",
    "queueWaitMs",
    "payloadWaitMs",
  ]);
  const PRIORITY_FIELDS = Object.freeze([
    "frameIndex",
    "timelineFrame",
    "time",
    "partial",
    "failureStage",
    "error",
    "failure",
    "wallMs",
    "waitReason",
    "activeClipIds",
    "mediaTimes",
  ]);
  const RETENTION_PRIORITY = Object.freeze({
    full: 10,
    sample: 20,
    anomaly: 50,
    head: 70,
    tail: 80,
    critical: 100,
  });
  const CRITICAL_ANOMALIES = new Set(["partial", "error", "timeout"]);

  function nonNegativeInteger(value, name) {
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new Error(`${name} must be a non-negative integer, received ${value}`);
    }
    return value;
  }

  function positiveInteger(value, name) {
    if (!Number.isSafeInteger(value) || value < 1) {
      throw new Error(`${name} must be a positive integer, received ${value}`);
    }
    return value;
  }

  function positiveNumber(value, name) {
    if (!Number.isFinite(value) || value <= 0) {
      throw new Error(`${name} must be a positive finite number, received ${value}`);
    }
    return value;
  }

  function truncateString(value, limit) {
    const string = String(value);
    if (string.length <= limit) return string;
    return `${string.slice(0, Math.max(0, limit - 24))}…[${string.length - limit} chars omitted]`;
  }

  function utf8Bytes(string) {
    if (typeof global.TextEncoder === "function") {
      return new global.TextEncoder().encode(string).byteLength;
    }
    // JSON metrics are overwhelmingly ASCII. This fallback remains an upper
    // bound for UTF-16 code units without relying on a browser-only API.
    let bytes = 0;
    for (let index = 0; index < string.length; index += 1) {
      const code = string.charCodeAt(index);
      if (code < 0x80) bytes += 1;
      else if (code < 0x800) bytes += 2;
      else if (code >= 0xd800 && code <= 0xdbff && index + 1 < string.length) {
        bytes += 4;
        index += 1;
      } else bytes += 3;
    }
    return bytes;
  }

  function jsonBytes(value) {
    try {
      return utf8Bytes(JSON.stringify(value));
    } catch (_error) {
      return Number.POSITIVE_INFINITY;
    }
  }

  function boundedClone(value, limits, depth = 0, seen = new WeakSet()) {
    if (value == null || typeof value === "boolean" || typeof value === "number") return value;
    if (typeof value === "string") return truncateString(value, limits.maxStringChars);
    if (typeof value === "bigint") return `${value}n`;
    if (typeof value === "function" || typeof value === "symbol" || typeof value === "undefined") {
      return String(value);
    }
    if (value instanceof Error) {
      return {
        name: truncateString(value.name || "Error", 128),
        message: truncateString(value.message || String(value), limits.maxStringChars),
        stack: value.stack ? truncateString(value.stack, limits.maxStringChars) : null,
      };
    }
    if (depth >= limits.maxDepth) {
      return Array.isArray(value)
        ? `[Array(${value.length}) truncated at depth ${limits.maxDepth}]`
        : `[Object truncated at depth ${limits.maxDepth}]`;
    }
    if (seen.has(value)) return "[Circular]";
    seen.add(value);
    if (Array.isArray(value)) {
      const result = value.slice(0, limits.maxArrayItems)
        .map((item) => boundedClone(item, limits, depth + 1, seen));
      if (value.length > limits.maxArrayItems) {
        result.push({ __truncatedItems: value.length - limits.maxArrayItems });
      }
      return result;
    }
    const result = {};
    const keys = Object.keys(value);
    const ordered = depth === 0
      ? [...PRIORITY_FIELDS.filter((key) => keys.includes(key)), ...keys.filter((key) => !PRIORITY_FIELDS.includes(key))]
      : keys;
    const selected = ordered.slice(0, limits.maxObjectKeys);
    for (const key of selected) {
      result[key] = boundedClone(value[key], limits, depth + 1, seen);
    }
    if (ordered.length > selected.length) result.__truncatedKeys = ordered.length - selected.length;
    return result;
  }

  function emergencyFrameRecord(record, originalEstimatedBytes, limits) {
    const emergency = {
      frameIndex: Number.isSafeInteger(record.frameIndex) ? record.frameIndex : null,
      timelineFrame: Number.isSafeInteger(record.timelineFrame) ? record.timelineFrame : null,
      time: Number.isFinite(record.time) ? record.time : null,
      partial: record.partial === true,
      failureStage: record.failureStage == null
        ? null
        : truncateString(record.failureStage, 256),
      error: record.error == null ? null : truncateString(record.error?.stack || record.error, 1024),
      failure: record.failure == null ? null : truncateString(record.failure?.stack || record.failure, 1024),
      wallMs: Number.isFinite(record.wallMs) ? record.wallMs : null,
      waitReason: record.waitReason == null ? null : truncateString(record.waitReason, 256),
      activeClipCount: Array.isArray(record.activeClipIds) ? record.activeClipIds.length : null,
      mediaTimesCount: Array.isArray(record.mediaTimes) ? record.mediaTimes.length : null,
      __metricsCompacted: "oversize-frame-record",
      __originalEstimatedBytes: Number.isFinite(originalEstimatedBytes) ? originalEstimatedBytes : null,
    };
    if (jsonBytes(emergency) <= limits.maxRecordBytes) return emergency;
    return {
      frameIndex: emergency.frameIndex,
      partial: emergency.partial,
      failureStage: emergency.failureStage,
      error: emergency.error == null ? null : truncateString(emergency.error, 128),
      __metricsCompacted: "minimal-oversize-frame-record",
    };
  }

  function numericAccumulator() {
    return { count: 0, sum: 0, min: Number.POSITIVE_INFINITY, max: Number.NEGATIVE_INFINITY, mean: 0, m2: 0 };
  }

  function addNumeric(accumulator, value) {
    if (!Number.isFinite(value)) return;
    accumulator.count += 1;
    accumulator.sum += value;
    accumulator.min = Math.min(accumulator.min, value);
    accumulator.max = Math.max(accumulator.max, value);
    const delta = value - accumulator.mean;
    accumulator.mean += delta / accumulator.count;
    accumulator.m2 += delta * (value - accumulator.mean);
  }

  function numericSnapshot(accumulator) {
    if (!accumulator.count) return { count: 0, sum: 0, min: null, max: null, mean: null, stddev: null };
    return {
      count: accumulator.count,
      sum: accumulator.sum,
      min: accumulator.min,
      max: accumulator.max,
      mean: accumulator.mean,
      stddev: Math.sqrt(accumulator.m2 / accumulator.count),
    };
  }

  function incrementBoundedCounter(map, rawKey, limit) {
    const key = truncateString(rawKey == null || rawKey === "" ? "<none>" : rawKey, 256);
    if (map.has(key)) {
      map.set(key, map.get(key) + 1);
      return;
    }
    if (map.size < limit) {
      map.set(key, 1);
      return;
    }
    map.set("<other>", (map.get("<other>") ?? 0) + 1);
  }

  function counterSnapshot(map) {
    return Object.fromEntries([...map.entries()].sort((left, right) => left[0].localeCompare(right[0])));
  }

  function detectSignals(record) {
    const signals = { fallback: false, timeout: false, error: false };
    const pending = [{ value: record, depth: 0 }];
    const visited = new WeakSet();
    let budget = 192;
    while (pending.length && budget > 0) {
      budget -= 1;
      const { value, depth } = pending.pop();
      if (value == null) continue;
      if (typeof value === "string") {
        if (/fallback|recovery/i.test(value)) signals.fallback = true;
        if (/timeout|timed out/i.test(value)) signals.timeout = true;
        continue;
      }
      if (value instanceof Error) {
        signals.error = true;
        if (/timeout|timed out/i.test(value.message)) signals.timeout = true;
        continue;
      }
      if (typeof value !== "object" || depth >= 4 || visited.has(value)) continue;
      visited.add(value);
      const values = Array.isArray(value)
        ? value.slice(0, 32).map((item) => ["", item])
        : Object.entries(value).slice(0, 64);
      for (const [key, child] of values) {
        if (/fallback/i.test(key) && child !== false && child != null) signals.fallback = true;
        if (/timeout|timedout/i.test(key) && child !== false && child != null) signals.timeout = true;
        if (/^(error|failure|failureStage)$/i.test(key) && child != null && child !== "") signals.error = true;
        pending.push({ value: child, depth: depth + 1 });
      }
    }
    return signals;
  }

  function createBoundedMetricsRecorder(options = {}) {
    const mode = options.mode ?? "bounded";
    if (!new Set(["bounded", "full"]).has(mode)) {
      throw new Error(`metrics mode must be bounded or full, received ${mode}`);
    }
    const expectedFrames = options.expectedFrames == null
      ? null
      : nonNegativeInteger(options.expectedFrames, "expectedFrames");
    const limits = Object.freeze({
      headFrames: nonNegativeInteger(options.headFrames ?? 8, "headFrames"),
      tailFrames: nonNegativeInteger(options.tailFrames ?? 8, "tailFrames"),
      sampleEvery: positiveInteger(options.sampleEvery ?? 600, "sampleEvery"),
      sampleFrames: nonNegativeInteger(options.sampleFrames ?? 64, "sampleFrames"),
      anomalyFrames: nonNegativeInteger(options.anomalyFrames ?? 48, "anomalyFrames"),
      criticalFrames: nonNegativeInteger(options.criticalFrames ?? 32, "criticalFrames"),
      maxStoredFrames: positiveInteger(options.maxStoredFrames ?? 160, "maxStoredFrames"),
      maxStoredBytes: positiveInteger(options.maxStoredBytes ?? 2 * 1024 * 1024, "maxStoredBytes"),
      maxRecordBytes: positiveInteger(options.maxRecordBytes ?? 64 * 1024, "maxRecordBytes"),
      maxArrayItems: positiveInteger(options.maxArrayItems ?? 16, "maxArrayItems"),
      maxObjectKeys: positiveInteger(options.maxObjectKeys ?? 64, "maxObjectKeys"),
      maxStringChars: positiveInteger(options.maxStringChars ?? 2048, "maxStringChars"),
      maxDepth: positiveInteger(options.maxDepth ?? 4, "maxDepth"),
      categoryKeys: positiveInteger(options.categoryKeys ?? 64, "categoryKeys"),
      slowFrameMs: positiveNumber(options.slowFrameMs ?? 100, "slowFrameMs"),
    });
    if (limits.maxStoredBytes < 512) throw new Error("maxStoredBytes must be at least 512 bytes");
    const projectionLimits = Object.freeze({
      ...limits,
      maxRecordBytes: Math.min(limits.maxRecordBytes, limits.maxStoredBytes),
    });
    const numericFields = [...new Set(options.numericFields ?? DEFAULT_NUMERIC_FIELDS)];
    if (numericFields.some((field) => typeof field !== "string" || !field)) {
      throw new Error("numericFields must contain non-empty strings");
    }
    const projectRecord = typeof options.projectRecord === "function" ? options.projectRecord : (record) => record;
    const isCompleted = typeof options.isCompleted === "function"
      ? options.isCompleted
      : (record) => record.partial !== true;

    let framesObserved = 0;
    let framesCompleted = 0;
    let framesPartial = 0;
    let framesErrored = 0;
    let currentStoredBytes = 0;
    let peakStoredBytes = 0;
    let peakStoredFrames = 0;
    let evictions = 0;
    let oversizeRecordsCompacted = 0;
    const entries = new Map();
    const buckets = {
      head: [],
      tail: [],
      sample: [],
      anomaly: [],
      critical: [],
    };
    const numeric = Object.fromEntries(numericFields.map((field) => [field, numericAccumulator()]));
    const categorical = {
      waitReasons: new Map(),
      failureStages: new Map(),
      mediaTransitions: new Map(),
    };
    const anomalyCounts = { partial: 0, error: 0, fallback: 0, timeout: 0, slow: 0 };

    function project(record) {
      const projected = projectRecord(record);
      let compact = boundedClone(projected, projectionLimits);
      let bytes = jsonBytes(compact);
      if (bytes > projectionLimits.maxRecordBytes) {
        oversizeRecordsCompacted += 1;
        compact = emergencyFrameRecord(record, bytes, projectionLimits);
        bytes = jsonBytes(compact);
      }
      if (!Number.isFinite(bytes) || bytes > limits.maxStoredBytes) {
        compact = {
          frameIndex: Number.isSafeInteger(record.frameIndex) ? record.frameIndex : null,
          partial: record.partial === true,
          error: record.error == null ? null : truncateString(record.error?.message || record.error, 96),
          __metricsCompacted: "hard-byte-cap",
        };
        bytes = jsonBytes(compact);
      }
      return { compact, bytes };
    }

    function ensureEntry(sequence, record, anomalies) {
      let entry = entries.get(sequence);
      if (entry) return entry;
      const { compact, bytes } = project(record);
      entry = {
        sequence,
        record: compact,
        bytes,
        reasons: new Set(),
        anomalies: new Set(anomalies),
      };
      entries.set(sequence, entry);
      currentStoredBytes += bytes;
      return entry;
    }

    function deleteEntry(sequence) {
      const entry = entries.get(sequence);
      if (!entry) return;
      currentStoredBytes -= entry.bytes;
      entries.delete(sequence);
      for (const keys of Object.values(buckets)) {
        const position = keys.indexOf(sequence);
        if (position >= 0) keys.splice(position, 1);
      }
      evictions += 1;
    }

    function removeReason(sequence, reason) {
      const entry = entries.get(sequence);
      if (!entry) return;
      entry.reasons.delete(reason);
      if (!entry.reasons.size) deleteEntry(sequence);
    }

    function addBucket(sequence, record, anomalies, name, limit) {
      if (limit <= 0) return;
      const entry = ensureEntry(sequence, record, anomalies);
      if (!entry.reasons.has(name)) {
        entry.reasons.add(name);
        buckets[name].push(sequence);
      }
      while (buckets[name].length > limit) {
        let expired;
        if (name === "critical") {
          const severity = (candidateSequence) => {
            const candidate = entries.get(candidateSequence);
            if (!candidate) return Number.NEGATIVE_INFINITY;
            let value = 0;
            if (candidate.anomalies.has("timeout")) value += 100;
            if (candidate.anomalies.has("error")) value += 200;
            if (candidate.anomalies.has("partial")) value += 400;
            return value;
          };
          expired = [...buckets[name]].sort((left, right) => (
            severity(left) - severity(right) || left - right
          ))[0];
          buckets[name].splice(buckets[name].indexOf(expired), 1);
        } else {
          expired = buckets[name].shift();
        }
        removeReason(expired, name);
      }
    }

    function entryPriority(entry) {
      let priority = 0;
      for (const reason of entry.reasons) priority = Math.max(priority, RETENTION_PRIORITY[reason] ?? 0);
      if (entry.reasons.has("critical")) {
        if (entry.anomalies.has("timeout")) priority += 10;
        if (entry.anomalies.has("error")) priority += 20;
        if (entry.anomalies.has("partial")) priority += 40;
      }
      return priority;
    }

    function enforceHardLimits(preferredSequence) {
      if (mode === "full") return;
      while (entries.size > limits.maxStoredFrames || currentStoredBytes > limits.maxStoredBytes) {
        const candidates = [...entries.values()].sort((left, right) => (
          entryPriority(left) - entryPriority(right)
          || left.sequence - right.sequence
        ));
        const candidate = candidates.find((entry) => entry.sequence !== preferredSequence)
          ?? candidates[0];
        if (!candidate) break;
        deleteEntry(candidate.sequence);
      }
    }

    function updatePeaks() {
      peakStoredFrames = Math.max(peakStoredFrames, entries.size);
      peakStoredBytes = Math.max(peakStoredBytes, currentStoredBytes);
    }

    function record(frame) {
      if (!frame || typeof frame !== "object" || Array.isArray(frame)) {
        throw new Error("frame metrics record must be an object");
      }
      const sequence = framesObserved;
      framesObserved += 1;
      const completed = Boolean(isCompleted(frame));
      if (completed) framesCompleted += 1;
      if (frame.partial === true) framesPartial += 1;

      for (const field of numericFields) addNumeric(numeric[field], Number(frame[field]));
      if (frame.waitReason != null) {
        for (const reason of String(frame.waitReason).split("+").filter(Boolean)) {
          incrementBoundedCounter(categorical.waitReasons, reason, limits.categoryKeys);
        }
      }
      if (frame.failureStage != null) {
        incrementBoundedCounter(categorical.failureStages, frame.failureStage, limits.categoryKeys);
      }
      if (Array.isArray(frame.mediaTimes)) {
        for (const media of frame.mediaTimes) {
          if (media?.transition != null) {
            incrementBoundedCounter(categorical.mediaTransitions, media.transition, limits.categoryKeys);
          }
        }
      }

      const signals = detectSignals(frame);
      const anomalies = [];
      if (frame.partial === true) anomalies.push("partial");
      if (signals.error) anomalies.push("error");
      if (signals.fallback) anomalies.push("fallback");
      if (signals.timeout) anomalies.push("timeout");
      if (Number.isFinite(frame.wallMs) && frame.wallMs >= limits.slowFrameMs) anomalies.push("slow");
      for (const anomaly of anomalies) anomalyCounts[anomaly] += 1;
      if (signals.error) framesErrored += 1;

      if (mode === "full") {
        const entry = ensureEntry(sequence, frame, anomalies);
        entry.reasons.add("full");
      } else {
        if (sequence < limits.headFrames) {
          addBucket(sequence, frame, anomalies, "head", limits.headFrames);
        } else {
          addBucket(sequence, frame, anomalies, "tail", limits.tailFrames);
        }
        if (sequence >= limits.headFrames && sequence % limits.sampleEvery === 0) {
          addBucket(sequence, frame, anomalies, "sample", limits.sampleFrames);
        }
        if (anomalies.length) {
          const critical = anomalies.some((anomaly) => CRITICAL_ANOMALIES.has(anomaly));
          addBucket(
            sequence,
            frame,
            anomalies,
            critical ? "critical" : "anomaly",
            critical ? limits.criticalFrames : limits.anomalyFrames,
          );
        }
        enforceHardLimits(sequence);
      }
      updatePeaks();
      return Object.freeze({
        sequence,
        completed,
        anomalies: Object.freeze([...anomalies]),
        retained: entries.has(sequence),
      });
    }

    function bucketFrameKeys(name) {
      return buckets[name]
        .filter((sequence) => entries.has(sequence))
        .map((sequence) => {
          const frameIndex = entries.get(sequence).record.frameIndex;
          return Number.isSafeInteger(frameIndex) ? frameIndex : sequence;
        });
    }

    function snapshot({ includeRecords = true } = {}) {
      const records = includeRecords
        ? [...entries.values()]
          .sort((left, right) => left.sequence - right.sequence)
          .map((entry) => ({
            ...entry.record,
            __metricsRetention: {
              sequence: entry.sequence,
              reasons: [...entry.reasons].sort(),
              anomalies: [...entry.anomalies].sort(),
              estimatedBytes: entry.bytes,
            },
          }))
        : [];
      const numericResult = Object.fromEntries(
        numericFields.map((field) => [field, numericSnapshot(numeric[field])]),
      );
      return {
        kind: KIND,
        schemaVersion: SCHEMA_VERSION,
        mode,
        expectedFrames,
        framesObserved,
        framesCompleted,
        framesPartial,
        framesErrored,
        aggregates: {
          numeric: numericResult,
          anomalies: { ...anomalyCounts },
          categorical: {
            waitReasons: counterSnapshot(categorical.waitReasons),
            failureStages: counterSnapshot(categorical.failureStages),
            mediaTransitions: counterSnapshot(categorical.mediaTransitions),
          },
        },
        retention: {
          storedFrames: entries.size,
          droppedFrames: Math.max(0, framesObserved - entries.size),
          evictions,
          peakStoredFrames,
          estimatedStoredRecordBytes: currentStoredBytes,
          estimatedPeakStoredRecordBytes: peakStoredBytes,
          estimatedIpcJsonDoubleCopyBytes: currentStoredBytes * 2,
          estimatedPeakIpcJsonDoubleCopyBytes: peakStoredBytes * 2,
          oversizeRecordsCompacted,
          limits: {
            ...limits,
            unboundedFullMode: mode === "full",
          },
          bucketFrameIndices: {
            head: bucketFrameKeys("head"),
            tail: bucketFrameKeys("tail"),
            sample: bucketFrameKeys("sample"),
            anomaly: bucketFrameKeys("anomaly"),
            critical: bucketFrameKeys("critical"),
          },
        },
        records,
      };
    }

    return Object.freeze({
      record,
      snapshot,
      get framesObserved() { return framesObserved; },
      get framesCompleted() { return framesCompleted; },
      get framesPartial() { return framesPartial; },
      get framesErrored() { return framesErrored; },
    });
  }

  global.HyperframesBoundedMetrics = Object.freeze({
    KIND,
    SCHEMA_VERSION,
    DEFAULT_NUMERIC_FIELDS,
    createBoundedMetricsRecorder,
  });
})(typeof globalThis === "undefined" ? window : globalThis);
