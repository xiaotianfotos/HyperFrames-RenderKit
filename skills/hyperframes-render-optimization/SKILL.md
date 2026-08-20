---
name: hyperframes-render-optimization
description: Diagnose, benchmark, design, build, and optimize deterministic HyperFrames rendering, especially 4K/60 fps projects with HTML/CSS motion graphics, mixed media, transparent overlays, CanvasDrawElement/HTML in Canvas, WebCodecs, custom Electron, and direct MOV output. Use when a render is slow, loses animation or overlays, falls back to screenshots, underuses CPU/GPU, mishandles media PTS, transparency, color, audio, memory, or final-file integrity; when classifying new media/CSS risks; when reproducing the Electron build/runtime environment; when choosing between exact WebCodecs, canonical media caches, faithful Chromium screenshots, or split plate/overlay paths; or when comparing render performance and quality across machines.
---

# HyperFrames Render Optimization

Optimize the final, verified movie rather than one capture or encoder stage. Build a fail-closed plan before rendering; never let a frame silently choose a cheaper backend at runtime.

This fast path is experimental and supports a proven authoring subset, not arbitrary browser output. Preserve the approved HyperFrames composition as the semantic oracle. Never flatten MG into stage images, remove or replace tweens, or otherwise weaken authoring merely to make the exact route eligible unless the user explicitly approves that editorial change.

## Start safely

1. Read the installed `hyperframes` skill completely before changing a composition or renderer.
2. Read applicable `AGENTS.md` files.
3. Preserve original compositions and unrelated changes. Put probes, caches, metrics, and outputs in explicit result directories.
4. Before renderer-specific adaptation, have the user approve the native/Studio authoring preview and freeze its motion structure with `node scripts/motion_contract.mjs freeze <project-root> --entry=<entry> --approval-note="<what was approved>"`. Do not capture or replace this baseline after a renderer workaround unless the editorial change itself was approved.
5. Run `npx hyperframes check` before and after composition changes. Do not treat it as a visual or media-timing test.
6. Run `scripts/render_doctor.sh <project-root> [media ...]` for a read-only environment, project-risk, and media-profile scan.
7. Before any production render, run `node scripts/motion_contract.mjs check <project-root>` and `node scripts/delivery.mjs check <project-root> --entry=<actual-render-entry>`. Treat either exit code 2 as a hard pre-render stop. Adapt the renderer or select a faithful/proven interval backend; make only truly equivalent authoring rewrites and prove them with dynamic A/B evidence.

For Codex or another AI agent, prefer the combined repository entry:

```bash
./bin/hf-render check /path/to/project
./bin/hf-render run /path/to/project
```

It writes a structured JSON report and a Markdown repair task, and starts the
renderer only when every blocking gate passes. Read
[references/agent-cli.md](references/agent-cli.md) for the issue schema, config
discovery, exit codes, and Agent repair loop.

Read [references/authoring-fidelity.md](references/authoring-fidelity.md) before onboarding a project or changing authoring for compatibility. Read [references/pipeline.md](references/pipeline.md) when selecting or implementing a frame backend. Read [references/media-compatibility.md](references/media-compatibility.md) whenever a project introduces a new media, font, CSS, DOM, graphics, or audio type. Read [references/build-environment.md](references/build-environment.md) when compiling, restoring, deploying, or changing the custom Electron runtime. Read [references/validation.md](references/validation.md) before benchmarking, comparing machines, or accepting a final movie.

## Use the short delivery workflow

After representative segments have proven one backend on the target machine, use the delivery helper for routine work:

```bash
node scripts/motion_contract.mjs check /path/to/project
node scripts/delivery.mjs check /path/to/project
node scripts/delivery.mjs plan --config=/path/to/delivery-config.json
node scripts/delivery.mjs render --config=/path/to/delivery-config.json
node scripts/delivery.mjs verify /path/to/output.mov --frames=<FRAME_COUNT> --fps=60 --width=3840 --height=2160
node scripts/delivery.mjs preview /path/to/output.mov --host=0.0.0.0 --port=8765
```

For browser review, prefer serving the verified movie directly when its audio
codec is browser-compatible. When a MOV contains H.264 video plus PCM audio,
create an MP4 preview by stream-copying video and transcoding audio only:
`ffmpeg -i final.mov -map 0:v:0 -map 0:a:0 -c:v copy -c:a aac -b:a 192k
-movflags +faststart preview.mp4`. Verify the preview's video packet count and
duration before serving it. Do not assume a host's standalone FFmpeg VAAPI
scale/encode path flushes delayed frames correctly: representative interval
tests must include the exact tail and match the expected video packet count.
If it drops tail frames or exits nonzero, reject that preview path instead of
publishing a visually plausible but incomplete transcode.

Keep this workflow inexpensive: static compatibility scan, one render, fast H.264 packet-count verification, then human playback review. Do not make full 4K software decode, a second complete render, or exhaustive golden comparison mandatory for every delivery after the exact project/backend profile is approved. Use those deeper gates when the project identity, Electron/Chrome build, output contract, or compatibility findings change.

Define a faithful screenshot fallback contract for every new routine production
config, but leave `allowWholeProjectScreenshotFallback` false unless a measured
representative benchmark gives an acceptable full-job ETA and the user explicitly
accepts it. A missing approval is a hard planning failure, never a silent multi-hour
route change. Keep configs without the contract only to reproduce historical
evidence; do not use them as delivery templates. An exact decoder preflight exit 2
may select an explicitly approved screenshot route only when no output was created.
Exit 1, protocol/resource failures, and any failure after output creation remain hard
failures; they never trigger an automatic quality downgrade.

When the user's objective is to optimize or validate the fast pipeline, a whole-project faithful-screenshot ETA is diagnostic evidence, not completion of the optimization task. Benchmark exact and faithful on the same dynamic intervals, identify the exact failure boundary, and repair the renderer or build a preflighted interval plan. Do not present the slow safety backend as the inevitable optimized render merely because it preserves authoring.

Read [references/delivery.md](references/delivery.md) for the render config. Treat scan findings as conservative evidence: blockers select faithful Chromium screenshot or stop for approval; a clean scan does not prove pixel equivalence, temporal fidelity, or retention of authored motion.

`acknowledgedRuleIds` records that a finding was reviewed; it never converts an unsupported feature into a safe layered-render feature. The legacy name `approvedRuleIds` has the same acknowledgement-only behavior. Do not use either field to bypass blockers. Static preflight covers stylesheet declarations, GSAP/JavaScript camelCase properties, negative stacking, and SVG filter/mask/clip-path markup.

Static preflight also flags GSAP/style `opacity` and GSAP `autoAlpha` mutation. Chrome 150 CanvasDrawElement
can silently omit descendants at runtime opacity values between zero and one. Exact
routes with that finding must explicitly select
`--partialOpacityPolicy=promote-dynamic`, inspect transition midpoint frames, and
retain the promotion counters in render metrics; otherwise select faithful
screenshot capture. Promotion is not alpha-equivalent: an authored target in
`0 < alpha <= 0.1` is a blocker because a subtle flash or glow can become a solid
frame. Remove the element-alpha animation, encode alpha in its color/asset pixels,
or use faithful screenshot capture. Treat other explicit partial-alpha targets as
review findings and inspect frames where the target is active.

## Freeze the render contract

Record these before changing code:

- project/entry/assets/timing identities;
- width, height, rational fps, start frame, and exact output frame count;
- final container, codec, pixel format, bitrate/quality, and whether intermediates are allowed;
- audio sample rate, channel layout, codec, mixing policy, and exact sample boundary rule;
- SDR/HDR, range, primaries, transfer, matrix, chroma location, and alpha semantics;
- required browser semantics such as masks, filters, stacking contexts, video/DOM interleaving, and authored backgrounds;
- memory, decoder-lane, packet-byte, encoder-queue, and IPC budgets;
- quality oracle, representative intervals, accepted fallbacks, and atomic-output policy.

For a HyperFrames entry containing `data-composition-src` or
`data-composition-file`, also freeze the exact HyperFrames browser runtime. Pass it
as the delivery config's absolute `hyperframesRuntime`, hash it in
`requiredFileSha256`, and require every host to expand to `data-hf-inner-root` with
its child timeline present before frame 0. A fast render of only the talking-head or
B-roll plate is a failure even if the file encodes successfully.

Freeze the renderer's complete local static module dependency closure, not only
the top-level Electron main file. The delivery helper treats every JavaScript
entry in `requiredFileSha256` as a closure root and verifies that every relative
`import`/`export from`/literal dynamic import reachable from those roots has its
own hash; a changed or newly introduced renderer/decoder module must invalidate
the approved toolchain identity before launch.

Also freeze `authoringMotionContract` from the approved native authoring preview and include that file in `requiredFileSha256`. The contract fails when approved motion-bearing files disappear, tween/timeline/update counts fall, animated property classes vanish, or new raster references appear inside an approved motion file. It is a regression tripwire, not a visual oracle: a passing contract still requires a consecutive-frame comparison against native Chromium.

Use `frames = ceil(duration * fps)` only when the composition contract defines duration as complete frame intervals. Prefer an explicit start frame and frame count over repeated floating-point seconds.

## Build two plans before rendering

Create a **RenderPlan** for the whole job and a **FrameBackendPlan** for every frame or contiguous interval.

The RenderPlan must bind the render identity, final-output contract, verified timing/source maps, media routing decisions, audio/color policy, bounded resources, metrics policy, and acceptance gates.

The FrameBackendPlan must assign exactly one preflighted backend to every output interval, for example:

- `production-webcodecs-exact`;
- `faithful-screenshot`;
- `canvas-draw-element-proven`;
- `split-plate-overlay-proven`.

Reject gaps, overlaps, unverified backend changes, and runtime guessing. A canonical-cache decision must stop before the renderer or muxer starts, produce a structured route decision, and restart only after the cache, timing bundle, and source map are verified. Protocol, exact-PTS, pixel, resource, or mux failures are hard failures.

## Select the backend by semantics

Do not assert one universal capture path.

- Choose **production exact WebCodecs** when media can be manually drawn into the final canvas and every selected source passes the direct/canonical timing and color contract.
- Choose **faithful Chromium screenshot** when native browser composition is the correctness oracle or CSS/video semantics cannot yet be reproduced manually. Treat it as the slower final safety backend, not a failure.
- Choose **CanvasDrawElement/HTML in Canvas** only after the exact Chrome/GPU path matches golden frames. API success alone is insufficient.
- Choose **split plate + transparent overlay** only when DOM stacking, clipping, masks, filters, and transforms prove the opaque plate can be separated without changing pixels.

An opaque video does not automatically belong outside browser capture; a composition whose semantics depend on browser stacking may correctly use the faithful screenshot backend.

Keep screenshot capture identity separate from encoder identity: native Chromium capture may feed VideoToolbox on macOS, VAAPI on a supported Linux/Intel host, NVENC on a supported NVIDIA host, or another explicitly verified encoder.

## Preflight media before mux

Allow direct exact decoding only for an explicitly validated profile such as MP4 H.264 `avc1`, CFR, non-negative zero-origin presentation timing, valid random-access points, bounded B-frame reorder depth, and the required SDR/color profile.

Route HEVC, 10-bit-to-8-bit conversion, VFR/discontinuous PTS, edit-list/nonzero-origin output, `avc3`, unsupported alpha/HDR/rotation, PTS microsecond collisions, excessive reorder depth, and unknown/mismatched color through a canonical cache. Make the conversion policy explicit and verify the cache before remapping it.

For exact decoding:

- derive integer microsecond PTS from timing ticks with one documented rational rule;
- compare the complete presentation PTS+duration index with the demux index, not only count/first/last;
- start seeks from a verified RAP and retain enough frames for B-frame reordering;
- derive the decoder input-lead and decoded-ready retention budgets from each source's measured reorder depth. Allow at least `maximumPresentationReorderDepth + 2` submitted pictures before requiring output and retain at least the same number of ready frames; fail preflight or canonicalize when either bounded budget is smaller. A larger input lead with the old smaller ready queue can discard the next exact PTS after a cut;
- share one runtime-owned frame for the same source/PTS in one output frame and use separate lanes for distinct PTS;
- forbid nearest-frame tolerance and HTMLVideo fallback inside the exact backend.

## Preserve final-output invariants

- Keep packet batches, decoder lanes, VideoFrames, encoder queues, IPC writes, stderr, hashes, and metrics bounded. Couple global demux bytes and cursor capacity to the maximum active lanes.
- End every output-frame lease in `finally`. Dispose renderer resources and main-process brokers on success, failure, and renderer death. Require sources, lanes, cursors, outstanding frames, bytes, and leases to return to zero.
- Mix audio on integer sample boundaries. At 48 kHz/60 fps, require exactly 800 samples per video frame; for other rates, define and test a rational boundary schedule.
- Preserve BT.709 limited-range metadata in both pixels and signaling. Validate range, primaries, transfer, matrix, pixel format, and chroma location at input and output.
- Write MOV/MP4 and metrics to run-unique staging paths. Probe and validate the staging movie, then atomically rename it. Never publish a partial movie as success.
- Retain bounded failure evidence even when no movie is committed.

## Benchmark in gates

Use the same render identity, interval, Chrome/Electron build, codec, bitrate, color/audio policy, and final container for comparisons.

1. **Capability gate:** run the doctor and backend-specific self-probes.
2. **One-frame smoke:** prove startup, mux, color, audio, and cleanup.
3. **Representative segments:** include sparse overlay, dense MG/text, every distinct media profile's first activation/cut, transparency/soft edges, simultaneous source reuse, distinct PTS lanes, and the tail. A long render must not be the first time a B-frame source's initial GOP is decoded.
4. **Double run:** run each candidate twice. Separate cold/warm measurements and investigate hash or route drift before trusting speed.
5. **Golden comparison:** compare raw pixel hashes where deterministic, then decoded RGBA/perceptual evidence at selected frames. Keep the faithful screenshot path as the reference unless another oracle is approved.
6. **Complete render:** accept only after the exact frame/audio/color/resource/atomic-output gates pass across the full timeline.

Compare compatible metrics with:

```bash
node scripts/compare_metrics.mjs baseline.metrics.json candidate.metrics.json
node scripts/compare_metrics.mjs --strict baseline.metrics.json candidate.metrics.json
```

Do not average incompatible render identities or hide cold-start time inside per-frame throughput.

For nested HyperFrames projects, select at least one frame where a child composition
is visibly active. For each CSS/DOM risk class found by the scan, compare a frame
where that feature is actually painted; a black, transparent, inactive, or
talking-head-only frame proves nothing. Include mixed-rate media, especially 24 fps
sources in 60 fps output, and verify source PTS are repeated according to timing
rather than retimed or interpolated.

For every motion-bearing representative interval, compare a sequence covering the state before entrance, active transition, settled state, and exit. A single golden frame, contact sheet, layer-presence check, or small push-zoom cannot prove that authored motion survived. Record motion onset/exit frames and verify that the exact path changes on the same frames as the native authoring oracle. If the fast path needs rasterized stages or fewer authored tweens to pass, reject it for that interval unless the user explicitly approves the editorial downgrade.

## Interpret bottlenecks from phase evidence

- High seek/decode time: inspect media routing, source reuse, RAP restarts, VFR/cache policy, and decoder-context limits.
- High layout/paint/capture time with low aggregate CPU/GPU: the browser stage is serialized; more encoder hardware will not fix it.
- High PNG/readback time: prefer a proven GPU canvas/WebCodecs path or capture fewer planned intervals.
- Low encoder utilization: the encoder is starved upstream.
- Growing memory: frames, packet leases, IPC payloads, or filter queues are not bounded or released.
- A stall around cuts: inspect exact PTS, last-frame hold policy, decoder lane allocation, pipe backpressure, and child-process exit propagation.

Change thread affinity, power limits, queue sizes, or hardware backends only after a controlled measurement identifies that limiter.

## Accept and report

Require all applicable gates:

- expected route/backend for every interval and zero unplanned fallback;
- exact width, height, fps, video frames, duration, audio stream, and decoded samples;
- BT.709/HDR/alpha policy satisfied in pixels and metadata;
- approved golden frames, cuts, edges, last frame, and end card;
- exact-PTS failures, unexpected/duplicate decoder output, and protocol errors equal zero;
- all bounded resources return to zero;
- staging validated and final file atomically committed;
- bounded metrics include render identity, phase totals, peak memory, backend/hardware evidence, route decisions, and failure evidence.

Report wall time and renderer time separately, cold and warm runs separately, quality evidence alongside speedup, and any remaining canonical-cache or browser-semantic boundary explicitly.
