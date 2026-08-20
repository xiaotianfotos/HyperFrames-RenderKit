import assert from "node:assert/strict";
import {
  evaluateMediaTimeDomainProbe,
  inferBrowserTimelineMapping,
  nearestPresentationFrame,
  presentationFrameAtOrBefore,
  seekInteriorSeconds,
} from "./media_time_domain_probe_lib.mjs";

function plan(ptsSeconds, overrides = {}) {
  const lastDelta = ptsSeconds.length > 1 ? ptsSeconds.at(-1) - ptsSeconds.at(-2) : 1 / 30;
  return {
    stream: { timeBaseSeconds: 1 / 90000, startTimeSeconds: ptsSeconds[0], hasBFrames: 2 },
    presentation: {
      ptsSeconds,
      firstPtsSeconds: ptsSeconds[0],
      lastPtsSeconds: ptsSeconds.at(-1),
      lastFrameDurationSeconds: lastDelta,
      displayEndSeconds: ptsSeconds.at(-1) + lastDelta,
    },
    ...overrides,
  };
}

{
  const pts = [0, 1 / 30, 2 / 30];
  const interior = seekInteriorSeconds({
    ptsSeconds: pts,
    frameIndex: 1,
    timeBaseSeconds: 1 / 15360,
    displayEndSeconds: 0.1,
  });
  assert.equal(interior.safe, true);
  assert.ok(interior.sourceTargetSeconds > pts[1] && interior.sourceTargetSeconds < pts[2]);

  const clippedTail = seekInteriorSeconds({
    ptsSeconds: [3.9, 3.933333333333333, 3.966666666666667],
    frameIndex: 2,
    timeBaseSeconds: 1 / 15360,
    displayEndSeconds: 4,
    browserEndSourceSeconds: 3.966667,
  });
  assert.equal(clippedTail.safe, false);
}

function observation(kind, mediaTime, requestedTime = null, presentedFrames = 1) {
  return {
    kind,
    label: `${kind}-${mediaTime}`,
    mediaTime,
    requestedTime,
    currentTime: requestedTime ?? mediaTime,
    presentedFrames,
    presentedFramesDelta: 1,
  };
}

{
  const pts = [0, 1 / 30, 2 / 30];
  assert.equal(presentationFrameAtOrBefore(pts, 0.05).frameIndex, 1);
  assert.equal(nearestPresentationFrame(pts, 0.065).frameIndex, 2);
}

// Non-zero ffprobe PTS mapped onto a zero-based HTML media timeline.
{
  const sourcePlan = plan([2, 2.04, 2.08, 2.16]);
  const observations = [
    observation("seek", 0, 0, 10),
    observation("seek", 0.04, 0.07, 11),
    observation("seek", 0.08, 0.10, 12),
    observation("sequential", 0.16, null, 14),
    observation("tail", 0.16, 0.19, 15),
  ];
  const result = inferBrowserTimelineMapping({
    plan: sourcePlan,
    browser: { seekable: [{ start: 0, end: 0.20 }] },
    observations,
  });
  assert.equal(result.selectedPasses, true);
  assert.ok(Math.abs(result.selected.offsetSeconds - 2) < 1e-9);
}

// VFR missing-frame region: target 0.10 must continue showing PTS 0.08,
// never jump to the next displayed frame at 0.16.
{
  const sourcePlan = plan([0, 0.04, 0.08, 0.16, 0.20]);
  const browser = { rvfcSupported: true, seekable: [{ start: 0, end: 0.24 }] };
  const observations = [
    observation("seek", 0.08, 0.10, 4),
    observation("seek", 0.16, 0.17, 5),
    observation("sequential", 0.04, null, 6),
    observation("sequential", 0.08, null, 7),
    observation("tail", 0.20, 0.23, 8),
  ];
  const evaluation = evaluateMediaTimeDomainProbe({ plan: sourcePlan, browser, observations });
  assert.equal(evaluation.pass, true);

  const overshot = observations.map((row) => ({ ...row }));
  overshot[0].mediaTime = 0.16;
  const failure = evaluateMediaTimeDomainProbe({ plan: sourcePlan, browser, observations: overshot });
  assert.equal(failure.pass, false);
  assert.equal(failure.gates.find((item) => item.id === "seek-no-overshoot").pass, false);
}

// presentedFrames gaps are observable evidence, not a reason to trust the
// callback blindly. The scheduler still validates mediaTime against target PTS.
{
  const sourcePlan = plan([0, 0.04, 0.08, 0.12]);
  const browser = { rvfcSupported: true, seekable: [{ start: 0, end: 0.16 }] };
  const observations = [
    observation("seek", 0, 0, 1),
    observation("sequential", 0.04, null, 2),
    { ...observation("sequential", 0.12, null, 4), presentedFramesDelta: 2 },
    observation("tail", 0.12, 0.15, 5),
  ];
  const evaluation = evaluateMediaTimeDomainProbe({ plan: sourcePlan, browser, observations });
  assert.equal(evaluation.callbackSkips, 1);
  assert.equal(evaluation.gates.find((item) => item.id === "presented-frames-observable").pass, true);
}

console.log("media time-domain probe tests passed");
