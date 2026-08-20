# Custom Electron build and runtime environment

Use this reference to reproduce the Electron 43.3.0 / Chromium 150 Linux x86_64 runtime used by HyperFrames-RenderKit. Treat the repository's `VERSION.lock`, GN args, stable patches, and environment checker as one build identity.

## Separate build and render hosts

The build host needs fast storage, network and memory. The render host needs the target GPU, display stack and encoder. Do not require one machine to do both.

The reference build environment is Debian 12 x86_64 with Node 22, Python 3.11, and Git 2.39. The reference render environment is Ubuntu 24.04 x86_64 with Node 22, FFmpeg 6.1, Intel VAAPI/iHD, and Wayland. Treat these as evidence, not a promise that other versions are equivalent.

## Storage and resources

- Put source, download cache and `out/` on a data disk, never `/tmp`, `/var/tmp` or a small system volume.
- Reserve 80–100 GiB free. The observed tree was about 56.7 GiB and `out/Vaapi` about 7.05 GiB.
- Use at least 32 GiB RAM for builds; prefer 64 GiB or more.
- Start at 8–10 jobs on 32 GiB, 12–16 on 64 GiB, or logical threads minus two on 128 GiB+.
- Use a separate output/result directory with enough space for canonical caches and multi-gigabyte PCM MOVs.

## Bootstrap

Install Electron build-tools and record the environment:

```bash
npm install -g @electron/build-tools
e --help
node --version
npm --version
python3 --version
git --version
npm list -g --depth=0
```

Create a profile on the data disk:

```bash
export HF_ELECTRON_BUILD_ROOT=/data/electron-vaapi-build/source
e init electron43-vaapi \
  --root="$HF_ELECTRON_BUILD_ROOT" \
  --import testing \
  --out Vaapi \
  --remote-build none
e use electron43-vaapi
e sync
```

Install Chromium's Linux dependencies from the synchronized source tree when required:

```bash
cd "$HF_ELECTRON_BUILD_ROOT/src"
sudo ./build/install-build-deps.sh
```

Do not replace source-tree GN/Ninja with unrelated system versions.

## Freeze the revision

```bash
cd "$HF_ELECTRON_BUILD_ROOT/src"
git -C electron fetch --tags
git -C electron checkout v43.3.0
e sync
```

Expected identities for this release:

```text
Electron 43.3.0:        1aa21d231aeaf5634880a6e60187256e9f2fd4f9
Chromium 150.0.7871.212: ee4b5d6b2c0326a73198c84cad4e5b08cf460365
```

After every sync, verify the top-level revisions, patch state, generated GN args, and packaged runtime SHA. A top-level revision alone does not prove every dependency identity.

## Use one patch route

The public build helper applies `patches/*.patch` in lexical order. This release has one production patch route. Never stack unrelated local patches on it. If the tree is ambiguous, create a clean profile instead of repeatedly applying and reversing patches.

## Build and package

Install the checked GN args at `out/Vaapi/args.gn`, run source-tree GN, then source-tree Ninja for `electron_dist_zip`. The repository helper normally performs:

```bash
./scripts/build.sh "$HF_ELECTRON_BUILD_ROOT/src" 22
```

Archive:

- complete dist bundle and a SHA-256 manifest;
- Electron/Chromium/DEPS identities;
- patch SHA and patch state;
- `args.gn`;
- build host OS/tool versions;
- build log and output size.

An executable SHA is not the full runtime identity.

## Deploy without replacing known-good Electron

Unpack each dist into a new identity directory. Point the renderer explicitly at that binary. Never overwrite the system Electron, npm Electron, or the previously accepted runtime.

Record runtime identity together with Ozone/Wayland/ANGLE/features, FFmpeg/FFprobe, GPU driver, project, timing bundle, canonical caches and output contract. Validate a one-frame smoke and representative interval before changing the production pointer.

For Intel VAAPI, require `vainfo` to report H.264 EncSlice and verify actual Chromium `VAVEA`/Mojo encoder evidence. `VideoEncoder.isConfigSupported()` alone does not prove hardware encoding.

## Recovery and diagnosis

- Re-run sync after a network interruption; do not compile a half-synchronized tree.
- After any sync, re-check patch state. Apply only `not-applied`; stop on `diverged`.
- On OOM or swap thrashing, lower Ninja jobs before changing system safety settings.
- If behavior differs, first compare runtime/dist, GN args, patch, feature flags, GPU driver, FFmpeg, project and timing/cache identities.
- Keep source/build/output away from system temporary directories and broad cleanup targets.

Do not call a build production-ready until one-frame, representative, resource cleanup, color, audio, frame-count and human playback gates pass on the actual render host.
