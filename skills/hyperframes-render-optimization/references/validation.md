# HyperFrames render validation and benchmark protocol

## Contents

1. Evidence hierarchy
2. Comparable run identity
3. Representative segments
4. Double-run protocol
5. Golden-frame protocol
6. Complete-output acceptance
7. Metrics and resource evidence
8. Reporting template

## Evidence hierarchy

Use progressively stronger evidence:

1. static capability/configuration check;
2. real one-frame startup/cleanup smoke;
3. representative segment render;
4. decoded frame hashes or pixel samples;
5. perceptual comparison against an approved oracle;
6. complete movie/audio probe;
7. second identical run proving stable route, hashes, and resource cleanup.

An API feature flag, encoder name, hardware preference, successful process exit, or absence of logged fallback is not sufficient by itself.

Static authoring-motion contracts and compatibility scans are guardrails, not visual proof. A single golden frame, contact sheet, layer-presence probe, black-frame scan, or freeze detector can all pass after authored motion has been replaced by static stages. Motion fidelity requires a consecutive-frame oracle comparison.

## Comparable run identity

Record a stable identity for:

- project and entry;
- selected assets/content hashes;
- timing bundle and canonical source map;
- output frame interval and rational fps;
- browser/Electron/Chromium build and GPU backend;
- semantic capture/render backend, decoder route, and the separately selected final encoder;
- dimensions, video codec/quality, audio codec/sample policy, and color policy.

Do not compute a speedup when identities or output contracts differ. File names and modification times are not render identities.

Compare the complete required identity tuple (`project`, `entry`, `assets`, and `timingBundle`) plus the normalized verified route. A matching project digest alone cannot make two runs comparable.

Measure separately:

- external process wall time;
- renderer wall time;
- startup/preflight/finalization, plus the first activation of every distinct media profile so B-frame first-GOP stalls are caught before a long render;
- per-phase seek, decode, paint, capture, composite, encode submit, queue wait, and payload wait;
- peak aggregate RSS and minimum available memory.

## Representative segments

Choose frame-exact intervals from the actual project:

| Segment | Required stress |
|---|---|
| Sparse | no/low overlay; reveals fixed startup and blank-frame behavior |
| Dense MG | text, SVG, transforms, shadows, nested DOM, high paint cost |
| Media cut | frames immediately before and after each selected source/time jump |
| Alpha/color | soft edges, translucent saturated shapes, anti-aliased text |
| Decoder sharing | same source and same PTS used by multiple layers |
| Decoder lanes | same source at distinct PTS in one output frame |
| Tail | final decodable frame, authored hold, end card, and last audio sample |

Include known capture-risk features discovered by `render_doctor.sh`. Use the same representative frame list for every machine/backend.

## Double-run protocol

For every candidate that reaches segment testing:

1. Run once from a documented cold state.
2. Run again without changing project, plan, browser, or output contract.
3. Keep both metrics and outputs.
4. Compare route decisions, render identity, frame/audio counts, decoded frame evidence, color, and cleanup before comparing speed.
5. Report cold and warm wall time separately.

Investigate nondeterminism when a deterministic path changes output hashes, selected route, frame count, exact-PTS results, or resource totals. Compression bytes may legitimately differ for some encoders; in that case compare decoded RGBA and perceptual evidence rather than accepting unexplained MOV hash drift.

## Golden-frame protocol

Use the faithful Chromium screenshot backend as the default visual oracle unless the project approves another source.

At each golden frame retain, within bounded limits:

- output frame index and selected media PTS/source identity;
- raw-pixel hash when available;
- PNG or decoded RGBA hash;
- small diagnostic pixel samples;
- optional difference image, SSIM, PSNR, or another approved perceptual score;
- backend, browser, GPU renderer, and color metadata.

Compare more than opaque center pixels. Include text edges, shadows, transparent pixels, rounded corners, video/DOM boundaries, and backgrounds.

Use exact byte/MOV equality only as a stronger bonus when the encoder/mux path is deterministic. A matching MOV hash implies matching bytes; a differing MOV hash does not by itself prove different decoded pixels.

## Motion-sequence protocol

For every representative animated composition, compare the native Chromium authoring oracle and candidate backend across a consecutive sequence containing:

- the last unchanged frame before entrance;
- multiple transition frames, including partial-opacity/transform midpoints;
- the settled state;
- multiple exit frames and the first clean frame after exit.

Verify the same onset and exit frame numbers, direction, duration/easing shape, layer order, transparency, clipping, and base-plate restoration. Detect one-frame flashes by comparing every consecutive frame in the interval, not sparse thumbnails. Retain a bounded sequence digest and perceptual-difference summary. If a candidate needs fewer authored tweens, staged screenshots, or an unrelated push zoom to look active, reject the route unless the user explicitly approves that editorial downgrade.

## Complete-output acceptance

Probe the staging movie before commit.

### Video

- codec and expected sample entry/profile;
- exact display width/height, including coded-surface crop behavior;
- pixel format;
- rational frame rate;
- exact decoded/read frame count;
- start time and duration consistent with complete output intervals;
- range, primaries, transfer, matrix, and other required color fields.

### Audio

- expected stream presence, codec, sample rate, channels/layout;
- start time and duration;
- exact decoded samples per channel;
- expected silence/clip mapping at beginning, cuts, and tail when relevant.

Audit editorial sync separately from stream presence. Build Overlay and SFX cues from
the same word-level alignment source, then inspect every entrance, emphasis, number,
label, cut, and exit at normal speed and frame-step around the trigger. A cue should
appear or sound when the corresponding spoken word or visible action occurs, not at
the start of a broad sentence. If many cues share a consistent offset or drift,
re-transcribe/re-align the final narration master before hand-adjusting dozens of
events. Confirm the rendered master stays audible across the full timeline; checking
that an audio stream merely exists does not catch a mid-program dropout.

For 48 kHz/60 fps, require `samples = frames * 800`. For other rates, validate the RenderPlan's rational sample-boundary schedule.

### Visual

- approved golden frames;
- all media cuts;
- dense MG and transparency probes;
- final frame/end card;
- no unexpected blank/black video or missing layer;
- no unplanned fallback.

### Atomicity

- staging output exists only while incomplete;
- final path appears only after all gates pass;
- failure never overwrites a prior valid movie/metrics file;
- failure metrics and route decision remain available and bounded;
- no abandoned partial movie remains.

## Metrics and resource evidence

Retain compact aggregates and bounded samples instead of per-frame/per-packet growth.

Recommended fields:

```text
runId, renderIdentity, createdAt
failure, failureKind, failureExitCode
RenderPlan/FrameBackendPlan identities or summaries
route decision and cache-required reason code
renderer frames requested/completed and wall time
phase totals and bounded slow/anomaly frames
exact PTS failures, duplicate/unexpected decoder outputs, RAP restarts
fallback counts and bounded error histogram
frame/lane/cursor/packet/byte budgets and peaks
before/after-dispose resource snapshots
memory watchdog peak RSS/minimum available/violation
bounded mux stderr head/tail/total/truncated
probe and decoded-audio acceptance
golden/hash sequence evidence
staging/commit/partial cleanup result
```

After renderer and main cleanup require:

```text
active sources = 0
active lanes = 0
frame scope open = false
outstanding VideoFrames = 0
acquired frames = closed frames
active cursors = 0
pending demux operations = 0
current demux bytes = 0
active packet leases = 0
pending IPC payload bytes = 0
```

Hardware evidence must name the actual decoder/encoder path from logs, trace, or platform telemetry. `prefer-hardware`, an available encoder, or GPU presence is only intent/capability evidence.

For screenshot output, identify `faithful Chromium screenshot` as the semantic capture backend and record the actual host encoder separately. Typical selections differ by machine (for example VideoToolbox on macOS versus VAAPI on a supported Linux/Intel host); a prose contract that always says VAAPI is not trustworthy evidence.

`scripts/compare_metrics.mjs --strict` is intentionally fail-closed. It accepts a run only when metrics explicitly contain: null final failure/failure-kind plus exit 0; a final video probe whose width, height, `r_frame_rate`, `avg_frame_rate`, zero start, explicit `nb_read_frames`, frame-derived duration, H.264 codec, yuv420p pixel format, and BT.709 fields match the frozen output contract; atomic commit; an explicit zero fallback count; applicable production exact-PTS counters (or the explicit screenshot/`html-video` non-applicable contract); backend-specific resource-zero snapshots; BT.709 tags plus a decoded pixel/color gate; and decoded sample-exact audio evidence or `mixProjectAudio: false`, no audio stream, and `decodedAudio: null`. Missing evidence is `unknown`, never zero or pass. A non-integral audio clock additionally needs an explicit expected sample count and boundary policy.

For PCM output, require exactly one `pcm_s24le` stream, the configured sample rate, stereo/two channels, zero start within one sample, frame-derived duration, a positive decoded-audio frame count, and the exact samples per channel. For no-audio output, require exactly zero audio streams and explicit `decodedAudio: null`; do not infer silence from a missing probe.

Collect every explicit pixel, color, expectation, and color-contract boolean inside the known color-evidence schemas instead of accepting the first one found. Any false or malformed value fails the gate; an unrelated performance/report `pass` field is not color proof. `colorValidation.pixelPass` and `colorValidation.contractPass` must both be explicitly true. Every active color/pixel evidence source must carry the complete canonical `renderIdentity` tuple and match the main metrics identity; evidence sources merely agreeing with one another is insufficient. If a scalar evidence/report/artifact identity is present, bind it to the SHA-256 of the canonical complete render-identity tuple rather than using an unrelated report ID. Null, empty, foreign, contradictory, or anonymous evidence is a hard failure.

Accept only pre-approved route/backend tuples. For the exact path, require renderer and config agreement plus `webcodecs` output, `production-webcodecs`, manual layered/proxy composition, timing-plan targeting, and a rendered `direct-h264-avc1` route whose sources prove AVC/`avc1`. Require the documented production evidence schema version on initial runtime, before-dispose, after-dispose, broker-after-renderer-dispose, every source metric, and every lane metric. Each open decision needs a canonical source identity belonging to the approved route. Each applicable snapshot must explicitly prove exact-PTS/validation pass, zero cache-required/acquire/fallback/protocol counters, typed source/lane metrics, internally consistent bounded frame budgets, and final resource zero. Recursively audit the known production-decoder evidence subtrees as a second line of defense: any explicit error/failure, false pass, HTMLVideo/fallback/emergency/cache route, foreign source identity, or final resource leak is a hard failure. Treat `status`, `state`, `result`, `mode`, and `decision` as control fields only inside known control/health evidence contexts; accept documented healthy/direct values and reject error/failure/fallback/emergency/cache states or unknown control values. Generic correctness recursion deliberately excludes `performance`, `benchmark`, `timing`, `telemetry`, and `aggregates` subtrees. Evidence in those namespaces needs its own versioned correctness contract; a performance `decision`, `pass`, or error-budget number is not route or render-failure evidence. Required fallback and route fields remain explicitly gated outside that recursion. A missing field is not equivalent to zero.

For faithful screenshot, require `screenshot` + `html-video`, sequential native capture, `faithful` or audited `bounded-static` media policy, an active media-request gate, timing-plan/playback-step selection, zero seek bias, zero authored/entry-transform DOM mutations, explicit expected/captured/hash-observed frame counts, an ordered sequence digest, matching media-gate policy, and an explicitly selected host encoder. Recursively reject any explicit error/failure, false pass, fallback/emergency/nearest-frame route, or final resource leak in the known screenshot evidence. Include `sequenceSha256` in the normalized comparable route: different screenshot sequences must reject the comparison and suppress speedup even when every run is individually valid.

Require a sampled memory watchdog with finite non-negative peak aggregate RSS and minimum available bytes, at least one observation, null violation, zero breach counters, no explicit final error, and no nested sampler/control status indicating error, fallback, emergency, or cache routing. Every required internal counter, byte peak, and byte minimum must be a real JSON number, finite, a safe integer, and inside its documented range; numeric strings and implicit `Number()` coercion are invalid even when they spell `"0"`. Require a versioned atomic commit record bound to metrics `runId`, complete `renderIdentity`, absolute final MOV path, and a distinct same-directory run-unique staging path; validate before accepting `committed: true`.

Do not silently merge an adjacent determinism or color-chart report into main metrics. If those gates live in separate files, report the split result as **main-chain gates complete; bundle-level GO pending identity-bound external evidence**. Bind report kind/schema, artifact identities, fixture/manifest hashes, and pass details through a versioned acceptance manifest before claiming one strict GO.

## Reporting template

Report:

```text
Outcome: accepted / canonical-cache-required / failed
Render identity and exact interval:
Backend plan and route decisions:
Machine/browser/GPU/encoder/decoder evidence:
Cold run: external wall, renderer wall, peak memory
Warm run: external wall, renderer wall, peak memory
Quality: hashes/goldens/perceptual/color/audio
Integrity: frames, samples, resource-zero, atomic commit
Speedup: only against compatible accepted baseline
Remaining boundaries or excluded features:
Artifacts: movie, metrics, route, logs, comparison report
```
