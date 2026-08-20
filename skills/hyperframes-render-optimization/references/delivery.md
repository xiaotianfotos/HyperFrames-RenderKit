# HyperFrames delivery helper

For AI-driven work, use `./bin/hf-render check|plan|run [PROJECT]` as the
top-level entry. It auto-discovers the production config and turns the checks in
this document into file/line/time-specific Agent tasks. See
[agent-cli.md](agent-cli.md). The lower-level commands below remain the renderer
and verification primitives.

Use `scripts/delivery.mjs` for the short production workflow after the render backend has been proven on the target machine.

## Commands

```bash
node scripts/motion_contract.mjs freeze /path/to/project --entry=index.html \
  --approval-note="Native authoring preview approved on YYYY-MM-DD"
node scripts/motion_contract.mjs check /path/to/project
node scripts/delivery.mjs check /path/to/project --entry=index.html
node scripts/delivery.mjs plan --config=/path/to/delivery-config.json
node scripts/delivery.mjs render --config=/path/to/delivery-config.json --output=/path/to/new-output.mov
node scripts/delivery.mjs verify /path/to/output.mov --frames=<FRAME_COUNT> --fps=60 --width=3840 --height=2160
node scripts/delivery.mjs preview /path/to/output.mov --host=0.0.0.0 --port=8765
```

The preview server does not transcode. If the verified deliverable uses
browser-incompatible PCM audio, make a review MP4 by copying the already
verified H.264 stream and encoding only the audio to AAC. Re-run packet-count
and duration verification on that MP4. Treat any accelerated preview transcode
as a separate backend: test an interval containing the actual file tail and
reject nonzero exits, missing delayed frames, or duration mismatches. In
particular, an FFmpeg VAAPI path can appear fast and playable while failing to
flush its final reordered frames on some driver/runtime combinations.

`check` is a conservative, fail-closed static scan. Run it before any production render. It reports features that are unsupported or unproven in a manual layered compositor and exits 2 when blockers remain. It does not replace representative visual review. Prefer adapting the renderer or routing the affected interval through a faithful/proven backend. Rewrite authoring only when the result is semantically equivalent and it passes the pre-rewrite motion contract plus a dynamic A/B comparison.

`motion_contract.mjs` is a separate authoring-fidelity gate. Freeze it only after the user approves the native/Studio preview and before renderer-specific changes. Never refresh it merely to legitimize a rasterized or simplified workaround. Its static motion counters catch common flattening regressions, but they do not replace consecutive-frame comparison against native Chromium.

The scan covers CSS declarations plus equivalent JavaScript/GSAP camelCase properties such as `clipPath`, `maskImage`, `backdropFilter`, and 3D transform keys. It also finds SVG `<filter>`, `<mask>`, and `<clipPath>` markup, negative stacking contexts, and runtime `opacity`/`autoAlpha` animation. These were added because stylesheet-only scans can pass an animation whose runtime object properties still disappear under CanvasDrawElement capture. A production exact plan containing `canvas-draw-dynamic-opacity` must explicitly select `--partialOpacityPolicy=promote-dynamic` and review representative transition frames, or use faithful screenshot capture. `canvas-draw-low-partial-opacity` is a blocker: promotion would turn a target in `0 < alpha <= 0.1` into fully opaque pixels, so rewrite the effect with alpha-bearing color/asset pixels or select faithful screenshot. `canvas-draw-explicit-partial-opacity` records the same fidelity risk for other non-binary targets and requires active-frame review.

Always scan the actual render entry. `render`/`plan` automatically use
`config.entry` in automatic mode, including framework-compiled HTML such as
`index.compiled.html`; `check` accepts the same path through `--entry`. Scanning an
authoring source while rendering a different compiled document is invalid.
The closure follows quoted or unquoted local HTML/CSS/module references, literal
dynamic imports, CommonJS `require`, and `importScripts`. Computed dependencies and
remote runtime/style URLs are compatibility risks; a dependency symlink resolving
outside the project root is rejected instead of silently omitted.

`plan` performs the same scan and toolchain hash verification as `render`, then
prints the selected route and exact invocation without starting Electron or
creating an output directory. With automatic fallback enabled, unresolved blocker
or review findings select faithful screenshot before rendering. Set
`treatReviewAsRisk: false` only for a frozen profile whose review findings have
already been approved through a stronger project/backend gate.

Use `acknowledgedRuleIds` only to record reviewed findings, and copy the scan's `projectScanSha256` into `acknowledgedProjectScanSha256`. The helper refuses the acknowledgement after any reachable HTML/CSS/JS dependency changes. Acknowledgement never lowers severity, changes routing, or makes layered capture eligible. Legacy `approvedRuleIds` / `approvedProjectScanSha256` are accepted with the same acknowledgement-only semantics.

`verify` deliberately uses H.264 packet count. Use it only for the fixed output contract in which the encoder produces one packet for every displayed output frame. It is a fast delivery check, not a decoded-pixel proof.

## Render configuration

```json
{
  "kind": "hyperframes-delivery-config",
  "schemaVersion": 1,
  "runtime": "/absolute/path/to/electron",
  "main": "/absolute/path/to/full-canvas-main.mjs",
  "hyperframesRuntime": "/absolute/path/to/hyperframe.runtime.iife.js",
  "runtimeArgs": ["--no-sandbox", "--ozone-platform=wayland"],
  "environment": {
    "XDG_RUNTIME_DIR": "/run/user/1000",
    "WAYLAND_DISPLAY": "wayland-0"
  },
  "projectRoot": "/absolute/path/to/project",
  "entry": "index.html",
  "authoringMotionContract": ".hyperframes/authoring-motion-contract.json",
  "output": "/absolute/path/to/output.mov",
  "ffprobe": "/usr/bin/ffprobe",
  "acknowledgedRuleIds": [],
  "acknowledgedProjectScanSha256": null,
  "requiredFileSha256": {
    "/absolute/path/to/electron": "64-hex-sha256",
    "/absolute/path/to/full-canvas-main.mjs": "64-hex-sha256",
    "/absolute/path/to/hyperframe.runtime.iife.js": "64-hex-sha256",
    "/absolute/path/to/project/.hyperframes/authoring-motion-contract.json": "64-hex-sha256"
  },
  "automaticFallback": {
    "enabled": true,
    "allowWholeProjectScreenshotFallback": false,
    "approvedExactProjectScanSha256": "64-hex scan identity after representative visual approval",
    "treatReviewAsRisk": true,
    "onCompatibilityRisk": "faithful-screenshot",
    "onCanonicalCacheRequired": "faithful-screenshot",
    "screenshotRender": {
      "mediaTimingPlan": ".render-cache/media-timing/media-timing-bundle.json",
      "mediaTimingPlanVerify": "sha256",
      "extraArgs": [
        "--screenshotMediaPolicy=faithful",
        "--mediaSeekBiasFrames=0",
        "--screenshotCaptureTimeoutMs=10000",
        "--paintTimeoutMs=500",
        "--seekTimeoutMs=10000"
      ]
    }
  },
  "render": {
    "width": 3840,
    "height": 2160,
    "fps": 60,
    "frames": 36000,
    "startFrame": 0,
    "bitrate": 40000000,
    "compositeMode": "layered",
    "outputBackend": "webcodecs",
    "mediaDecoderBackend": "production-webcodecs",
    "mediaTimingPlan": ".render-cache/media-timing/media-timing-bundle.json",
    "mediaTimingPlanVerify": "sha256",
    "canonicalMediaRoute": ".render-cache/canonical-media/canonical-media-route.json",
    "canonicalMediaRouteVerify": "sha256",
    "extraArgs": [
      "--mediaDecoderLanesTotal=12",
      "--mediaDecoderLanesPerSource=2",
      "--queueLimit=8",
      "--paintTimeoutMs=500",
      "--seekTimeoutMs=10000"
    ]
  }
}
```

Keep this configuration beside the project or in a separately controlled operations directory. Do not store private keys, credentials, or mutable temporary paths in it.

`requiredFileSha256` is optional, but recommended for a delivery profile. The helper
streams and verifies the Electron binary plus critical renderer/runtime files before
launching. This adds seconds rather than another render, and prevents an approved
profile from silently running with a different toolchain.

For automatic routing, `requiredFileSha256` is mandatory and must at least freeze
the configured Electron runtime, main process, HyperFrames runtime (when set),
timing plan, canonical media route, and `authoringMotionContract`. The motion
contract is mandatory in automatic mode and is checked before route selection.
The exact route additionally
requires `approvedExactProjectScanSha256` to equal the current scan. A clean scan
without this project-level approval selects faithful screenshot; it never promotes
an unfamiliar project directly to the fast backend.

Set `hyperframesRuntime` whenever the entry contains `data-composition-src` or
`data-composition-file`. The renderer injects it before frame setup and fails unless
every nested host expands and exposes its child timeline. The field must be an
absolute local path and its SHA-256 must be frozen for automatic routing. Omitting
it is allowed only for a self-contained entry with no nested HyperFrames
compositions.

## Automatic route contract

Automatic fallback is schema-v1 opt-in for backward compatibility, but it is
mandatory for every newly issued routine production profile. A legacy config
without it may reproduce old evidence; do not present that config as one-click
delivery. The helper accepts only the tuple shown above for the safety route:

- native `screenshot` composition and output backend;
- `html-video` media with the verified timing plan;
- `playback-step`, zero media seek bias, and `faithful` media policy;
- no canonical source remapping inherited from the exact decoder route.

`allowWholeProjectScreenshotFallback` is an explicit cost approval, not a quality
switch. Keep it false until a representative screenshot benchmark has been measured,
the projected full duration has been reported, and the user accepts that ETA. With
it false, planning fails instead of silently turning a minutes-scale exact render
into an hours-scale screenshot render.

For a fast-pipeline optimization task, selection of whole-project screenshot is a diagnostic stop, not a successful optimized plan. Run same-interval exact and faithful benchmarks, identify semantic failures, and continue with renderer repair or a preflighted interval backend plan. Do not relabel the faithful safety ETA as the optimized renderer's ETA.

The selection rules are:

1. Before route selection, the frozen authoring motion contract must pass. Missing
   motion-bearing files, reduced tween/timeline/update structure, vanished animated
   property classes, or new raster references inside an approved motion file are
   hard failures; they do not select another renderer and do not refresh the baseline.
2. An exact-eligible compatibility scan starts `production-exact` only when it has zero blocker findings and its
   project scan identity and frozen runtime/main identities match the approved
   profile.
3. A clean but unapproved project, an unresolved blocker, or, by default, review finding starts
   `faithful-screenshot` without attempting the fast route.
4. Freeze every local module reachable from all JavaScript roots listed in
   `requiredFileSha256`, not just the top-level main file. `delivery.mjs` rejects
   an automatic route when any reachable local module is absent from the map.
5. Exact preflight exit 2 means canonical media is required. If the frozen profile
   already points at accepted content-addressed caches, rebuild the profile during
   onboarding. During a routine render, the helper automatically runs the faithful
   screenshot contract instead of guessing media frames.
6. Exit 1, signals, encoder/protocol/resource failures, and exit 2 after any output
   appeared are hard failures. Screenshot is not used to hide them.
7. Every attempt and the final selection are recorded in the JSON result.

Rule acknowledgement is deliberately absent from these routing rules. It is audit metadata, not a safety override. If a blocker is intentionally retained, define and verify a different interval backend; do not mark the rule acknowledged and send it through `drawElementImage`.

Automatic renders also create an exclusive sidecar beside the movie:
`OUTPUT.delivery-route.jsonl` (or the same-directory `routeEvidence` path from the
config). It records the pre-render selection, each attempt/exit code, any exact to
screenshot transition, and fast verification. `plan` reports the intended path but
does not create it. An existing sidecar is never overwritten, so a failed or older
run cannot be silently confused with the next delivery.

The helper deliberately does not launch a long cache conversion inside a warm
delivery command. Canonical conversion belongs to first-project onboarding and
must produce a new verified timing bundle/source route before the approved profile
is frozen. This keeps normal delivery bounded while still guaranteeing that an
unproven direct media path becomes either a verified cache on the next profile or
the faithful screenshot safety route now.

Run the routing regression with:

```bash
node scripts/test_motion_contract.mjs
node scripts/test_delivery.mjs
```
