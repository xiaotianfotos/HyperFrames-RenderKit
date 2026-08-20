#!/usr/bin/env electron

import { app, BrowserWindow } from "electron";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  expandPresentationPts,
  scanMediaTiming,
  ticksToSeconds,
  validateTimingPlan,
  verifyTimingPlanSource,
} from "./media_timing_plan_lib.mjs";
import { evaluateMediaTimeDomainProbe } from "./media_time_domain_probe_lib.mjs";

const toolRoot = dirname(fileURLToPath(import.meta.url));

function parseArgs(argv) {
  const parsed = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (!arg.startsWith("--")) continue;
    const equals = arg.indexOf("=");
    if (equals >= 0) parsed[arg.slice(2, equals)] = arg.slice(equals + 1);
    else if (argv[index + 1] && !argv[index + 1].startsWith("--")) parsed[arg.slice(2)] = argv[++index];
    else parsed[arg.slice(2)] = "true";
  }
  return parsed;
}

function usage() {
  console.log(`Usage:
  <electron> tools/media_time_domain_probe.mjs --source <video> [--plan <timing-plan.json>] --output <report.json>

Options:
  --sequential 18       Number of normal-playback rVFC samples
  --timeout 8000        Timeout per metadata/seek/frame operation in ms
  --show                Show the probe window
  --hash                Verify a supplied timing plan by SHA-256 instead of stat

The probe never changes the source and never imports the full renderer.`);
}

function makePlanForBrowser(plan) {
  const ptsTicks = expandPresentationPts(plan);
  const ptsSeconds = ptsTicks.map((ticks) => ticksToSeconds(ticks, plan.stream.timeBase));
  const timeBaseParts = plan.stream.timeBase.split("/").map(Number);
  return {
    sourceIdentity: plan.source.identity,
    stream: {
      timeBase: plan.stream.timeBase,
      timeBaseSeconds: timeBaseParts[0] / timeBaseParts[1],
      startTimeSeconds: plan.stream.startTimeSeconds,
      hasBFrames: plan.stream.hasBFrames,
    },
    timeline: plan.timeline,
    presentation: {
      frameCount: plan.presentation.frameCount,
      ptsSeconds,
      firstPtsSeconds: plan.presentation.firstPtsSeconds,
      lastPtsSeconds: plan.presentation.lastPtsSeconds,
      lastFrameDurationSeconds: plan.presentation.lastFrameDurationSeconds,
      displayEndSeconds: plan.presentation.displayEndSeconds,
      classification: plan.presentation.classification,
    },
  };
}

function buildRelativeSeekTargets(plan) {
  const pts = plan.presentation.ptsSeconds;
  const first = pts[0];
  const last = pts.at(-1);
  const relative = [];
  const add = (value, label, seekPolicy = null) => {
    if (!Number.isFinite(value) || value < 0) return;
    if (!relative.some((row) => Math.abs(row.relativeSeconds - value) < 1e-7)) {
      relative.push({ relativeSeconds: value, label, seekPolicy });
    }
  };
  add(0, "first-frame", "boundary-diagnostic");
  for (const fraction of [0.1, 0.35, 0.65, 0.9]) {
    const target = first + (last - first) * fraction;
    add(target - first, `fraction-${fraction}`);
  }
  let largestGap = null;
  for (let index = 1; index < pts.length; index += 1) {
    const delta = pts[index] - pts[index - 1];
    if (!largestGap || delta > largestGap.delta) {
      largestGap = { index, delta, left: pts[index - 1], right: pts[index] };
    }
  }
  if (largestGap && largestGap.delta > 0) {
    add((largestGap.left + largestGap.delta * 0.5) - first, "largest-gap-midpoint");
    add((largestGap.right - Math.min(largestGap.delta / 8, 0.001)) - first, "before-gap-right-frame");
  }
  add(Math.max(0, last - first), "last-frame-start", "boundary-diagnostic");
  const tailInside = Math.max(0, plan.presentation.displayEndSeconds - first
    - Math.max(plan.stream.timeBaseSeconds, plan.presentation.lastFrameDurationSeconds / 4));
  add(tailInside, "inside-last-frame-tail");
  return relative;
}

async function runInBrowser(window, config) {
  // The function is stringified and executed in the isolated page. Keep it
  // self-contained: it deliberately has no access to Electron or Node APIs.
  async function browserProbe(input) {
    const video = document.getElementById("probe-video");
    const errors = [];
    const observations = [];
    let lastPresentedFrames = null;
    const timeoutMs = input.timeoutMs;

    const withTimeout = (promise, label) => new Promise((resolvePromise, rejectPromise) => {
      const timer = setTimeout(() => rejectPromise(new Error(`${label} timed out after ${timeoutMs}ms`)), timeoutMs);
      promise.then((value) => {
        clearTimeout(timer);
        resolvePromise(value);
      }, (error) => {
        clearTimeout(timer);
        rejectPromise(error);
      });
    });
    const event = (name) => withTimeout(new Promise((resolveEvent, rejectEvent) => {
      const onEvent = () => { cleanup(); resolveEvent(); };
      const onError = () => { cleanup(); rejectEvent(new Error(video.error?.message || `video ${name} error`)); };
      const cleanup = () => {
        video.removeEventListener(name, onEvent);
        video.removeEventListener("error", onError);
      };
      video.addEventListener(name, onEvent, { once: true });
      video.addEventListener("error", onError, { once: true });
    }), name);
    const callback = (kind, label, requestedTime = null, seekPolicy = null) => withTimeout(new Promise((resolveFrame) => {
      video.requestVideoFrameCallback((now, metadata) => {
        const row = {
          kind,
          label,
          requestedTime,
          seekPolicy,
          callbackNow: now,
          currentTime: video.currentTime,
          mediaTime: metadata.mediaTime,
          presentedFrames: metadata.presentedFrames,
          presentedFramesDelta: lastPresentedFrames == null ? null : metadata.presentedFrames - lastPresentedFrames,
          presentationTime: metadata.presentationTime,
          expectedDisplayTime: metadata.expectedDisplayTime,
          processingDuration: metadata.processingDuration ?? null,
          readyState: video.readyState,
          seeking: video.seeking,
          ended: video.ended,
        };
        lastPresentedFrames = metadata.presentedFrames;
        observations.push(row);
        resolveFrame(row);
      });
    }), `rVFC ${label}`);
    const seekWithCallback = async (target, kind, label, seekPolicy = null) => {
      const clamped = Math.min(Math.max(target, 0), Math.max(0, video.duration - 1e-7));
      video.pause();
      const framePromise = callback(kind, label, clamped, seekPolicy);
      const seekPromise = Math.abs(video.currentTime - clamped) < 1e-7
        ? Promise.resolve()
        : event("seeked");
      video.currentTime = clamped;
      await seekPromise;
      return framePromise;
    };
    const primeOppositeFrame = async (target, label, seekableStart, seekableEnd) => {
      const span = seekableEnd - seekableStart;
      if (!(span > 0.05)) return;
      const midpoint = seekableStart + span / 2;
      const primeTarget = target >= midpoint
        ? seekableStart + Math.min(0.001, span / 20)
        : seekableEnd - Math.min(0.01, span / 20);
      await seekWithCallback(primeTarget, "prime", `prime-${label}`);
    };

    const rvfcSupported = typeof video.requestVideoFrameCallback === "function";
    if (!rvfcSupported) return { browser: { rvfcSupported }, observations, errors: ["rVFC unavailable"] };
    video.muted = true;
    video.preload = "auto";
    video.src = input.sourceUrl;
    try {
      await event("loadedmetadata");
      if (video.readyState < HTMLMediaElement.HAVE_CURRENT_DATA) await event("loadeddata");
      // Consume the initial presentation so a later callback cannot be
      // mistaken for the result of the first explicit seek.
      const bootstrap = callback("bootstrap", "initial-presentation");
      await video.play();
      await bootstrap;
      video.pause();

      const seekable = Array.from({ length: video.seekable.length }, (_, index) => ({
        start: video.seekable.start(index),
        end: video.seekable.end(index),
      }));
      const seekableStart = seekable[0]?.start ?? 0;
      const seekableEnd = seekable.at(-1)?.end ?? video.duration;
      // seekable.start() can be zero even when an edit list contains an empty
      // leading segment and the first video frame starts later. Discover the
      // first actually presentable media position before translating relative
      // plan targets into the browser's currentTime domain.
      let originObservation;
      try {
        originObservation = await seekWithCallback(seekableStart, "origin", "effective-media-start");
      } catch (error) {
        errors.push(error.message);
      }
      const effectiveMediaStart = Number.isFinite(originObservation?.currentTime)
        ? originObservation.currentTime
        : seekableStart;
      const ordinary = input.relativeSeekTargets.filter((target) => !target.label.includes("tail"));
      // Alternate distant positions to force a newly presented frame for
      // every explicit seek, including repeated-frame VFR regions.
      const order = [];
      let left = 0;
      let right = ordinary.length - 1;
      while (left <= right) {
        order.push(ordinary[left++]);
        if (left <= right) order.push(ordinary[right--]);
      }
      for (const target of order) {
        const requested = Math.min(seekableEnd - 1e-7, effectiveMediaStart + target.relativeSeconds);
        try {
          await primeOppositeFrame(requested, target.label, effectiveMediaStart, seekableEnd);
          await seekWithCallback(requested, "seek", target.label, target.seekPolicy ?? null);
        } catch (error) {
          errors.push(error.message);
        }
      }

      // Normal playback can legitimately increment presentedFrames by more
      // than one. Recording the delta makes skipped callbacks observable.
      try {
        await primeOppositeFrame(effectiveMediaStart + 0.001, "sequential-start", effectiveMediaStart, seekableEnd);
        await seekWithCallback(Math.min(seekableEnd - 1e-7, effectiveMediaStart + 0.001), "setup", "sequential-start");
        await video.play();
        for (let index = 0; index < input.sequentialCount; index += 1) {
          await callback("sequential", `sequential-${index}`);
        }
        video.pause();
      } catch (error) {
        video.pause();
        errors.push(error.message);
      }

      for (const target of input.relativeSeekTargets.filter((row) => row.label.includes("tail")
        || row.label === "last-frame-start")) {
        const requested = Math.min(seekableEnd - 1e-7, effectiveMediaStart + target.relativeSeconds);
        try {
          await primeOppositeFrame(requested, target.label, effectiveMediaStart, seekableEnd);
          await seekWithCallback(requested, "tail", target.label, target.seekPolicy ?? null);
        } catch (error) {
          errors.push(error.message);
        }
      }

      return {
        browser: {
          rvfcSupported,
          userAgent: navigator.userAgent,
          duration: video.duration,
          seekable,
          effectiveMediaStart,
          videoWidth: video.videoWidth,
          videoHeight: video.videoHeight,
          readyState: video.readyState,
        },
        observations,
        errors,
      };
    } catch (error) {
      errors.push(error.message);
      return {
        browser: {
          rvfcSupported,
          userAgent: navigator.userAgent,
          duration: Number.isFinite(video.duration) ? video.duration : null,
          seekable: [],
        },
        observations,
        errors,
      };
    }
  }

  return window.webContents.executeJavaScript(`(${browserProbe.toString()})(${JSON.stringify(config)})`, true);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help === "true" || !args.source) {
    usage();
    await app.whenReady();
    app.quit();
    return;
  }
  const source = resolve(args.source);
  const output = resolve(args.output ?? `${source}.browser-time-domain.json`);
  let plan;
  if (args.plan) {
    plan = validateTimingPlan(JSON.parse(await readFile(resolve(args.plan), "utf8")));
    const verified = await verifyTimingPlanSource(plan, source, { mode: args.hash === "true" ? "hash" : "stat" });
    if (!verified.valid) throw new Error(`Timing plan does not match source (${verified.reason})`);
  } else {
    plan = await scanMediaTiming(source, { ffprobePath: args.ffprobe ?? "ffprobe" });
  }
  const browserPlan = makePlanForBrowser(plan);
  const config = {
    sourceUrl: pathToFileURL(source).href,
    timeoutMs: Number(args.timeout ?? 8000),
    sequentialCount: Number(args.sequential ?? 18),
    relativeSeekTargets: buildRelativeSeekTargets(browserPlan),
  };

  app.commandLine.appendSwitch("autoplay-policy", "no-user-gesture-required");
  app.commandLine.appendSwitch("disable-background-timer-throttling");
  app.commandLine.appendSwitch("disable-renderer-backgrounding");
  app.commandLine.appendSwitch("disable-backgrounding-occluded-windows");
  await app.whenReady();
  const window = new BrowserWindow({
    width: 720,
    height: 440,
    show: args.show === "true",
    webPreferences: { contextIsolation: true, nodeIntegration: false, backgroundThrottling: false },
  });
  await window.loadFile(resolve(toolRoot, "media_time_domain_probe.html"));
  const raw = await runInBrowser(window, config);
  const evaluation = evaluateMediaTimeDomainProbe({ plan: browserPlan, ...raw });
  const report = {
    kind: "hyperframes-browser-media-time-domain-probe",
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    runtime: {
      electron: process.versions.electron,
      chrome: process.versions.chrome,
      node: process.versions.node,
      platform: process.platform,
      arch: process.arch,
    },
    source: { path: source, identity: plan.source.identity },
    plan: browserPlan,
    ...raw,
    evaluation,
  };
  await mkdir(dirname(output), { recursive: true });
  await writeFile(output, `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify({ output, pass: evaluation.pass, gates: evaluation.gates }, null, 2));
  window.destroy();
  app.exit(evaluation.pass ? 0 : 2);
}

main().catch(async (error) => {
  console.error(error.stack ?? error.message);
  try { await app.whenReady(); } catch {}
  app.exit(1);
});
