# HyperFrames-RenderKit

HyperFrames-RenderKit is an experimental Linux rendering toolkit for deterministic HyperFrames video delivery. It combines a pinned Electron/Chromium build, static compatibility checks, exact media decoding, faithful Chromium capture, interval routing, hardware-assisted H.264 encoding, and final-file verification.

This is an independent project, not an official HyperFrames distribution. The fast renderer supports a verified subset of browser, CSS, media, and animation semantics. Unsupported effects must use an explicitly planned faithful Chromium interval or stop before rendering; the toolkit never treats a visually weaker fallback as success.

## Repository layout

```text
bin/hf-render                         Agent-friendly check, plan, and render CLI
build/args.gn                         Pinned Electron/Chromium build arguments
patches/                              Chromium/Electron source patches
renderer/                             Renderer runtime, preflight tools, tests, and fixtures
scripts/                              Build and repository safety helpers
skills/hyperframes-render-optimization/  Codex skill and operational references
VERSION.lock                          Pinned upstream revisions
```

All user-facing documentation lives in this README. Detailed operational knowledge for AI agents lives under `skills/` so it can be loaded only when relevant.

## Requirements

Runtime:

- Linux x86_64
- Node.js 22 or later and npm
- FFmpeg and FFprobe
- a Chromium-compatible display session
- for the accelerated Linux path, Intel VAAPI with H.264 encode support and the iHD driver

Source build:

- Electron Build Tools (`npm install -g @electron/build-tools`)
- Git, Python 3, GN, and Ninja from the synchronized Electron source tree
- at least 80 GiB free disk space and 32 GiB RAM; more memory is recommended

Check a host before use:

```bash
./scripts/check-build-env.sh --build /absolute/path/to/build-volume
./scripts/check-build-env.sh --runtime /absolute/path/to/render-workspace
```

## Build the custom Electron runtime

The pinned revisions are Electron 43.3.0 and Chromium 150.0.7871.212. Keep the source checkout outside this repository.

```bash
npm install -g @electron/build-tools

export HF_ELECTRON_ROOT=/data/electron-renderkit/source

e init electron43-renderkit \
  --root="$HF_ELECTRON_ROOT" \
  --import testing \
  --out Vaapi \
  --remote-build none

e use electron43-renderkit
e sync

cd "$HF_ELECTRON_ROOT/src"
git -C electron fetch --tags
git -C electron checkout v43.3.0
e sync

cd /path/to/HyperFrames-RenderKit
./scripts/check-tree.sh "$HF_ELECTRON_ROOT/src"
./scripts/apply-patches.sh "$HF_ELECTRON_ROOT/src"
./scripts/check-tree.sh "$HF_ELECTRON_ROOT/src"
./scripts/build.sh "$HF_ELECTRON_ROOT/src" 16
```

The packaged runtime is written to:

```text
$HF_ELECTRON_ROOT/src/out/Vaapi/dist.zip
```

`apply-patches.sh` is idempotent and stops when the pinned source no longer matches. The public build has one production patch route in `patches/`; do not force it onto another Chromium revision or stack unrelated local changes on top.

## Install the renderer

```bash
cd renderer
npm ci
```

Keep the custom Electron distribution in its own directory. Do not overwrite a system Electron or a project's npm-installed Electron. Point each delivery configuration at the exact runtime binary and freeze its identity.

## Check and render a HyperFrames project

`hf-render` is the preferred entry for both humans and AI agents:

```bash
# Read-only diagnosis; omitting the verb also means "check".
./bin/hf-render check /path/to/hyperframes-project

# Build and validate the interval/backend plan without rendering.
./bin/hf-render plan /path/to/hyperframes-project

# Run the same fail-closed checks, then render only if every blocker passes.
./bin/hf-render run /path/to/hyperframes-project
```

Configuration discovery order:

1. `--config FILE`
2. `.hyperframes/delivery.json`
3. `render-config.production.json`
4. `render-config.final-4k60.json`
5. one unambiguous `render-config.final*.json`

Reports are written to `.hyperframes/render-agent/latest.json` and `latest.md` inside the target project unless `--report DIR` is supplied. Exit code `0` means ready or rendered, `2` means a diagnosed production blocker, and `1` means the CLI itself failed.

The delivery config, backend selection rules, output verification, and Agent repair loop are documented in the bundled skill references:

- `skills/hyperframes-render-optimization/references/agent-cli.md`
- `skills/hyperframes-render-optimization/references/delivery.md`
- `skills/hyperframes-render-optimization/references/pipeline.md`

## Install the Codex skill

Copy or symlink the skill into the Codex skills directory:

```bash
mkdir -p "${CODEX_HOME:-$HOME/.codex}/skills"
ln -s /path/to/HyperFrames-RenderKit/skills/hyperframes-render-optimization \
  "${CODEX_HOME:-$HOME/.codex}/skills/hyperframes-render-optimization"
```

The skill teaches an Agent to freeze authoring intent, scan CSS and media risks, select exact or faithful intervals, benchmark representative motion, and verify the final movie without deleting or flattening animation.

## Tests

Run the deterministic Node.js suites from `renderer/`:

```bash
cd renderer
npm run test:backend-segment-executor
npm run test:proxy-tree
npm run test:validate-final-mov
npm run test:golden-manifest-builder
```

Hardware and Electron integration tests require the target display session, custom runtime, codecs, and fixtures. Run representative exact-versus-faithful clips before a full delivery whenever the runtime, project identity, CSS risk profile, media profile, or output contract changes.

## Rendering contract and limitations

- Freeze the approved native HyperFrames motion structure before renderer-specific adaptation.
- Treat a clean static scan as eligibility evidence, not proof of visual or temporal equivalence.
- Compare consecutive frames through animation entrance, midpoint, settled state, and exit.
- Use exact WebCodecs only for verified media timing and color profiles.
- Route unsupported browser composition semantics through explicitly planned faithful Chromium intervals.
- Preserve rational frame timing, audio sample boundaries, color metadata, resource budgets, and atomic output publication.
- Reject gaps, overlaps, unplanned fallback, missing frames, silent audio loss, and runtime backend guessing.
- Do not delete tweens, bake motion into static images, or refresh an approval baseline merely to make a fast path pass.

The custom runtime has been developed and tested for Linux Intel VAAPI H.264. NVIDIA, AMD, other codecs, HDR, alpha-video delivery, and arbitrary web applications require separate validation.

## Repository safety

Before publishing or packaging the source tree, run:

```bash
node scripts/check-public-safety.mjs --worktree-only
```

The scanner checks tracked files for credentials, private network addresses, personal absolute paths, sensitive local configuration, and a missing project license. Generated video, build output, caches, logs, credentials, and local environment files are ignored by Git.

## Third-party software

- [Mediabunny](https://github.com/Vanilagy/mediabunny) is installed from npm under MPL-2.0; its source is not vendored here.
- Electron and Chromium source are not vendored. Their upstream licenses and notices apply to builds produced from the pinned revisions.

This repository does not yet grant a project-level license. Select and add a license before public release.

## Upstream references

- [HyperFrames](https://github.com/heygen-com/hyperframes)
- [Electron Linux build instructions](https://www.electronjs.org/docs/latest/development/build-instructions-linux)
- [Electron GN build instructions](https://www.electronjs.org/docs/latest/development/build-instructions-gn)
- [Electron Build Tools](https://github.com/electron/build-tools)
- [Chromium VA-API documentation](https://chromium.googlesource.com/chromium/src/+/HEAD/docs/gpu/vaapi.md)
