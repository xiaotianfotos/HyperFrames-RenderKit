# HyperFrames deterministic render pipeline

## Contents

1. Planning objects
2. Backend decision tree
3. Production exact WebCodecs
4. Canonical media caches
5. Faithful screenshot backend
6. CanvasDrawElement and split overlay
7. Audio, color, and final mux
8. Bounded resources and failure handling

## Planning objects

Build plans before starting a render. Names may differ between implementations, but preserve the contracts.

```text
RenderPlan
  identity: project + entry + assets + timing bundle digests
  output: dimensions + fps + frame interval + container/codec/quality
  audio: sample rate + channels + codec + sample-boundary policy
  color: input/direct gate + working space + output signaling
  sources: verified timing entries + canonical source mappings
  intervals: FrameBackendPlan[]
  resources: frame/lane/demux/IPC/encoder/memory limits
  evidence: representative frames + golden oracle + metrics retention
  commit: staging path + validation + atomic rename

FrameBackendPlan
  startFrame, frameCount
  backend
  selected source identities and timing-plan identities
  preflight decision and reason
  capture/decode/composite policy
  allowed fallback: normally none
```

Require intervals to cover the requested output exactly once. Include the plan and render identities in success and failure metrics so two outputs can be compared without trusting filenames.

## Backend decision tree

1. Determine whether the frame requires native Chromium rendering semantics.
   - If CSS/video interleaving, masks, filters, embedded content, or unaudited stacking semantics are essential, select faithful screenshot.
2. Otherwise determine whether the composition can be reconstructed in one canvas.
   - If yes, preflight exact WebCodecs sources.
3. If any source is not direct-safe, stop and request a canonical cache.
   - Build, verify, remap, regenerate timing data, and preflight again.
4. Consider CanvasDrawElement or a split plate/overlay only after golden probes prove them on the target Chrome/GPU.

Do not transition between these backends because one frame timed out. A new route requires a new preflighted plan.

## Production exact WebCodecs

Use a main-process broker and a browser-safe renderer runtime.

### Bootstrap nested HyperFrames compositions

An authored HyperFrames index may contain only host nodes such as
`data-composition-src`; the visible child DOM and child GSAP timelines do not exist
until the HyperFrames browser runtime expands them. Before renderer setup:

1. inventory every nested host and preserve its start, duration, track, and
   composition identity;
2. inject the frozen local HyperFrames runtime;
3. wait for the player duration, one `data-hf-inner-root` per host, and every child
   timeline;
4. restore timing attributes removed during runtime expansion when the exact
   renderer needs them for its static clip plan;
5. fail if any host, inner root, or timeline is missing.

Drive time through the HyperFrames player (or an equivalently proven adapter), not
only `window.__timelines.main`: the main timeline can be empty while the player owns
host activation and child seeking. Include the HyperFrames runtime hash in the
render identity. A successful movie containing only base video is not a valid smoke
test.

```text
verified timing/source map -> main-only opaque token allow-list
media file -> compact demux index held in main
renderer exact PTS request -> target/RAP summary + bounded packet pages
packet pages -> VideoDecoder -> exact VideoFrame
VideoFrame + DOM/canvas layers -> final canvas
final canvas -> WebCodecs H.264 -> bounded Annex-B pipe
Annex-B + sample-exact audio -> FFmpeg stream-copy -> staging MOV
```

Do not expose filesystem paths or arbitrary IPC channels to renderer code. Do not transfer a full packet manifest. Keep only compact summaries and paged packets in IPC.

### Direct-source gate

Require all properties used by the implementation, including:

- audited MP4/ISO-BMFF structure;
- H.264/AVC with `avc1` and a decoder configuration record;
- CFR presentation index, zero origin, safe integer timestamps, and no microsecond collisions;
- verified key/RAP access units and bounded maximum reorder depth;
- expected dimensions, sample aspect ratio, rotation, alpha, and HDR state;
- explicit pixel format, range, primaries, transfer, matrix, and chroma location.

Treat missing color metadata as unknown, not BT.709 by assumption.

### Exact timing proof

Use one integer conversion for timing-plan ticks and demux packet timestamps. A typical non-negative rule is:

```text
pts_us = floor(pts_ticks * time_base_numerator * 1_000_000 / time_base_denominator)
```

Hash every presentation PTS and duration in order, for example as unsigned 8-byte big-endian values. Compare count plus the complete digest during preflight. A middle-frame or final-duration mismatch must route to `CACHE_REQUIRED_TIMING_INDEX` before mux.

### Lane and frame ownership

- Share one frame promise/VideoFrame for the same content identity and PTS in one output frame.
- Allocate separate lanes when one source needs distinct PTS values simultaneously.
- Begin and end the output-frame scope exactly once.
- Keep decoded frames runtime-owned; a draw consumer must not close them.
- Close frames, cursors, packet leases, sources, and lanes during asynchronous dispose.
- Preserve the original render failure if cleanup also fails.

RAP restarts, B-frame output reordering, overshoot, duplicate output, and unexpected output must be measurable. Exact output accepts only `VideoFrame.timestamp === requested_pts_us`. Preflight must also prove that both the bounded decoder input lead and decoded-ready retention are at least `maximumPresentationReorderDepth + 2`; otherwise return a canonical-cache decision before starting the renderer or muxer. A fixed lead of four is insufficient for valid AVC whose measured reorder depth is three because an implementation may retain one additional picture before its first output. Raising the lead without raising ready-frame retention is also unsafe: asynchronous outputs can evict the next requested exact PTS.

## Canonical media caches

Canonical caching is a pre-render route, not an in-render fallback. Common route reasons include:

```text
CACHE_REQUIRED_HEVC
CACHE_REQUIRED_CODEC
CACHE_REQUIRED_VFR
CACHE_REQUIRED_NONZERO_ORIGIN
CACHE_REQUIRED_AVC3
CACHE_REQUIRED_BIT_DEPTH
CACHE_REQUIRED_COLOR_PROFILE
CACHE_REQUIRED_PTS_MICROSECOND_COLLISION
CACHE_REQUIRED_REORDER_DEPTH
CACHE_REQUIRED_TIMING_INDEX
```

`avc1` is the allowed direct H.264 sample entry. Use `CACHE_REQUIRED_AVC3` (or a more general non-`avc1` sample-entry reason) for an `avc3`/unsupported entry; never describe an `avc1` source as cache-required merely because it is `avc1`.

Define the conversion recipe explicitly: target container/codec/sample entry, fps/timebase/origin, dimensions/SAR/rotation, pixel format, range/color metadata, HDR/alpha policy, and any 10-to-8-bit/dither policy.

After conversion:

1. Verify structure, frame count, PTS/duration, random access, color, and decoded pixel samples.
2. Create a new content identity.
3. Add the cache to the verified timing bundle.
4. Map authored source URL to canonical cache URL through a verified source map.
5. Repeat direct-source preflight.

Never let the runtime lower bit depth, normalize VFR, or switch identities while frames are being rendered.

## Faithful screenshot backend

Use native Chromium composition when it is the approved semantic oracle or when manual reconstruction is unproven.

- Preserve authored HTML and backgrounds.
- Gate media requests so only the source needed for the current frame is active.
- Seek using the verified timing plan; define tail hold/transparent/fail behavior.
- Wait for the selected paint contract, then capture sequentially.
- Retain bounded raw-pixel and PNG hashes with ordered sequence evidence.
- Stream captured frames to the encoder; never retain a full 4K sequence.
- Record the semantic capture backend separately from the final encoder. The capture identity is faithful native Chromium screenshot; the encoder is host-specific, such as VideoToolbox on macOS, VAAPI on a supported Linux/Intel host, NVENC on a supported NVIDIA host, or an explicitly planned software encoder. Never hardcode VAAPI into the screenshot contract.

Screenshot is a valid, slower final backend. Do not label it as a quality fallback when the plan selected it before rendering.

## CanvasDrawElement and split overlay

CanvasDrawElement can rasterize DOM into canvas but does not make DOM layout parallel or guarantee external video textures. It may omit video, unsupported CSS, or nested transformed content without throwing.

Chrome 150 has a further observed failure mode: descendants whose opacity is set
at runtime to a value strictly between zero and one can disappear from
`drawElementImage()` while remaining present and correctly laid out in the DOM.
The delivery scan reports GSAP/style `opacity` and GSAP `autoAlpha` mutation as
`canvas-draw-dynamic-opacity`. For an exact CanvasDrawElement route, either prove a
faithful screenshot backend for the affected intervals or explicitly use
`--partialOpacityPolicy=promote-dynamic` and review entrance, midpoint, and exit
frames. The promotion policy temporarily captures those nodes at opacity one,
restores authored inline styles in `finally`, and records promoted element/frame
counts in metrics. It is a compatibility policy, not proof of alpha-equivalent
pixels. In particular, a subtle full-frame flash authored at five percent opacity
becomes a solid frame after promotion. The static scan therefore blocks explicit
runtime targets in `0 < alpha <= 0.1` as `canvas-draw-low-partial-opacity` and
reports all other explicit partial targets as
`canvas-draw-explicit-partial-opacity`. Rewrite alpha-critical effects with
alpha-bearing color or asset pixels, or route their intervals through faithful
screenshot capture.

Probe the exact Chrome, ANGLE backend, GPU, and composition features. Compare entrances, midpoints, exits, cuts, text/soft edges, transparent states, and nested transforms against screenshot goldens.

If an active draw is blank, compare a faithful screenshot with a known blank frame. A blank screenshot may prove an intentional transparent animation state; a nonblank screenshot proves the candidate lost content. This guard detects whole-frame loss, not partial element loss.

On a higher-resolution delivery viewport, verify how the target Chrome build treats
an authored-root scale. `drawElementImage()` may ignore the root CSS transform even
while `getBoundingClientRect()` reports scaled video geometry. When that exact build
shows this behavior, keep media geometry in output coordinates and apply the
authored-to-output scale to the destination canvas only around the captured HTML
draw. Prove the result against a native screenshot at delivery resolution; do not
assume a 1080p match implies a 4K match.

Use split plate/overlay only if every required stacking relationship can be preserved. If video must sit between DOM layers, manually draw the prepared VideoFrame and capture proven HTML bands around it. Reproduce object-fit/position, clipping, radius, opacity, transforms, and order; require goldens for filters, blends, masks, and complex stacking contexts.

## Audio, color, and final mux

### Sample-exact audio

Represent clip start, media offset, duration, render offset, delay, and total length in integer samples. For 48 kHz at 60 fps:

```text
samples_per_frame = 48000 / 60 = 800
output_samples = output_frames * 800
```

For fps/sample-rate pairs that do not divide evenly, specify one rational boundary rule and use it for every clip and final verification. Decode the staging output and verify samples per channel, not only container duration.

Keep authored gain semantics explicit. Use `amix normalize=0` when authored volumes are absolute. Add limiting only after a whole-program peak test justifies its latency and gain changes.

### Color

Validate color as a pipeline contract, not only a container tag:

- input direct gate: pixel format, range, primaries, transfer, matrix, chroma;
- conversion/canvas working-space policy;
- encoder bitstream signaling, including H.264 VUI where required;
- MOV/MP4 color metadata;
- decoded output pixel/color probes.

For SDR BT.709, require limited/tv range and BT.709 matrix, transfer, and primaries. When FFmpeg filters or hardware upload drop metadata, set parameters explicitly before upload and verify the resulting stream.

### Atomic final movie

Write encoded video/audio into a run-unique staging movie in the destination filesystem. After mux exit:

1. probe codec, dimensions, fps, frame count, duration, pixel/color metadata, and audio;
2. decode and verify exact audio samples;
3. complete configured pixel/perceptual gates;
4. write bounded metrics;
5. atomically rename staging movie and metrics.

On failure, remove unpublished partial movies and retain uniquely named failure metrics plus route evidence.

## Bounded resources and failure handling

Bound independently:

- VideoFrames retained per lane and globally;
- total and per-source decoder lanes;
- packet count and bytes per batch;
- global unacknowledged demux bytes;
- open cursors and packet metadata caches;
- encoder queue and renderer-to-main pending writes/bytes;
- FFmpeg stderr head/tail, frame metrics, hashes, and error samples;
- process memory and available-memory thresholds.

At saturation, global demux bytes must cover the maximum simultaneously reserved lane batches, and cursor capacity must cover active lanes. Reject unsafe configurations synchronously instead of waiting for a semaphore deadlock.

Propagate browser failure, IPC failure, pipe close/error, encoder failure, mux exit, memory violation, and cleanup failure to one structured final result. Distinguish:

- exit 0: validated and atomically committed;
- exit 2: preflight canonical-cache route, renderer/mux not started;
- exit 1: protocol, exact PTS, pixel, audio, color, resource, encoder, mux, or validation failure.
