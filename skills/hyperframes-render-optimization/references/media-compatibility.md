# HyperFrames media and browser compatibility

Classify every new input before rendering. Choose exactly one result: direct exact, canonical cache, faithful Chromium, or unsupported. Never discover an unsupported feature only after a long render.

## Video routing

Use direct exact decoding only for a proven profile such as MP4 H.264 `avc1`, CFR, zero/non-negative origin, complete presentation PTS, valid RAPs, bounded reorder depth, 8-bit SDR BT.709, known rotation/SAR, and no unsupported alpha.

Use a canonical cache for:

- `avc3`, HEVC, Main10/HDR, VP9, AV1, or WebM not already proven;
- VFR, missing grid frames, discontinuous PTS, negative/nonzero origins, or edit lists;
- rotation, SAR/DAR, crop side data, interlacing, or unclear color metadata;
- animated image formats that need deterministic frame-duration/disposal mapping;
- packet layouts that do not independently prove one displayed frame per indexed unit.

The cache recipe must define output fps/timebase, zero origin, codec/sample entry, GOP/RAP policy, SDR/HDR conversion, rotation, alpha, audio handling, and original-PTS-to-cache-frame mapping. Validate complete output PTS and content identity before remapping clips.

Do not normalize a valid lower-rate source merely because the delivery rate is
higher. For example, keep a genuine 24 fps source at 24 fps inside a 60 fps
composition when it passes the direct contract; select/repeat source frames from
the verified presentation PTS. Do not speed it up, synthesize interpolation, or
rewrite it to 60 fps unless the editorial contract explicitly asks for that
conversion. Include at least one mixed-rate interval in representative validation.

Use faithful Chromium or reject for DRM, MSE, MediaStream, `srcObject`, unstable `blob:` URLs, remote authenticated resources, dynamic source replacement, and authored scripts that depend on media network/lifecycle state.

For concurrent media:

- share the verified decoded frame only for the same source and selected PTS;
- allocate another bounded lane when the same source needs a different PTS in one output frame;
- calculate the bounded input lead and decoded-ready retention from the indexed H.264 presentation reorder depth. Require at least `reorderDepth + 2` for both; if either exceeds the approved runtime limit, route the source through the canonical cache before mux;
- avoid preloading every authored video at navigation;
- define hold-last, transparent, or fail at the tail;
- never accept `currentTime` alone as displayed-frame proof in an exact backend.

## Image and vector routing

| Input | Check before fast path |
|---|---|
| PNG | alpha/premultiply, ICC, dimensions and GPU texture limit |
| JPEG | EXIF rotation, ICC, CMYK/4:4:4 and decoded dimensions |
| WebP/AVIF | target Electron decode support, alpha and color behavior |
| SVG | external assets, fonts, filters, masks, blend, SMIL and CSS dependencies |
| GIF/APNG/animated WebP | frame durations, loop count and disposal semantics |
| Lottie/dotLottie | seek-safe adapter, renderer identity, fonts and expressions |

Convert unknown still formats to a content-addressed PNG or another explicitly approved input. Complex SVG/Lottie semantics belong in faithful Chromium until representative golden frames prove a faster path.

## CSS and DOM routing

Simple text, backgrounds, borders, explicit dimensions, 2D transforms, normal overflow and proven seek-safe GSAP/WAAPI are fast-path candidates.

Default to faithful Chromium when the output depends on:

- `filter`, `backdrop-filter`, mask, complex `clip-path`, `mix-blend-mode`, perspective/3D transform, or subtle stacking contexts;
- fixed/sticky layout, reparent-sensitive selectors, pseudo-elements outside host bounds, or filter paint outside the border box;
- iframe, custom elements, shadow DOM, CSS paint worklets, dynamic CSSOM, runtime script injection, Worker/WASM, or `eval`;
- selectors or scripts observing video `src`, `currentSrc`, `preload`, `readyState`, error/network state, or lifecycle events;
- a page whose animations depend on wall-clock playback rather than direct timeline seek.

Scan both syntax forms. A composition can express the same risky paint operation in a stylesheet (`clip-path`, `mask-image`, `filter`, `perspective`) or in JavaScript/GSAP (`clipPath`, `maskImage`, `filter`, `transformPerspective`, `rotationX`, `rotationY`). Inline SVG filters, masks, and clip paths are separate paint risks and must also be inventoried. Treat negative `z-index` as a captured-stacking-context blocker until the exact host/root relationship has golden proof.

Acknowledging a finding means only “reviewed.” It does not establish pixel equivalence and must not remove a blocker from route selection.

A clean static scan is not pixel proof. Bind approvals to exact project content, Electron/Chrome build, GPU path and representative frames.

## Fonts and text

- Bind web/variable/local font files and fallback order to render identity.
- Wait for font loading and fail closed instead of silently substituting a system font.
- Probe CJK, Emoji, ligatures, vertical text, outline/shadow and long layout.
- Treat FreeType/Skia/Chrome changes as output-contract changes when typography is important.

## Canvas and GPU graphics

Canvas 2D, Three.js, WebGL and WebGPU must be driven by a deterministic seekable time input. Bind shaders, textures, GPU/driver and browser version. Use faithful Chromium or a project-specific golden when readback, floating-point rendering, antialiasing or device limits can differ.

## Audio routing

- Prefer 48 kHz stereo PCM for sample-exact delivery. At 60 fps, require 800 samples per frame.
- Use a rational sample boundary schedule for 44.1 kHz or fractional fps.
- Decode AAC/MP3 delay and priming before claiming exact boundaries.
- Bind track selection, channel layout, downmix, volume, fades, loops, playback rate and clip cuts.
- Separate video-frame selection from embedded audio-track selection.

## New-input onboarding

1. Freeze local content identity and close remote dependencies.
2. Scan media presentation timing, color, geometry, alpha and audio.
3. Scan page/font/CSS/DOM dependencies.
4. Choose direct, cache, faithful, or unsupported before mux starts.
5. Test first frame, the first activation/cut of every distinct media profile (including B-frame and mixed-rate sources), representative motion/effect and tail.
6. Human-review the representative output and record approval identity.
7. Reuse the approved cache and plan on later renders; do not repeat expensive onboarding when identities match.

Report cold onboarding time separately from warm one-click render time. A fast renderer is not useful if mandatory checks make every repeated output approach the faithful-path cost.
