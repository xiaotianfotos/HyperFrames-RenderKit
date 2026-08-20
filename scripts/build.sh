#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# shellcheck disable=SC1091
source "$repo_root/VERSION.lock"

chromium_src="${1:-}"
requested_jobs="${2:-}"

if [[ -z "$chromium_src" ]]; then
  echo "Usage: $0 /path/to/electron-root/src [jobs]" >&2
  exit 2
fi

gn_bin="$chromium_src/buildtools/linux64/gn"
ninja_bin="$chromium_src/third_party/depot_tools/ninja"
if [[ ! -x "$ninja_bin" ]]; then
  ninja_bin="$chromium_src/third_party/ninja/ninja"
fi

if [[ ! -x "$gn_bin" || ! -x "$ninja_bin" ]]; then
  echo "GN or Ninja was not found in the Electron source tree." >&2
  echo "Run e sync first, then retry." >&2
  exit 2
fi

# Electron/Node generation helpers invoke `gn` by name while Ninja is
# running. Keep the source-tree tool first so the build never depends on an
# unrelated system GN installation.
export PATH="$(dirname "$gn_bin"):$(dirname "$ninja_bin"):$PATH"

if [[ -n "$requested_jobs" ]]; then
  jobs="$requested_jobs"
else
  cpu_count="$(nproc)"
  if (( cpu_count > 4 )); then
    jobs="$((cpu_count - 2))"
  else
    jobs="$cpu_count"
  fi
fi

out_path="$chromium_src/out/$OUT_DIR"
mkdir -p "$out_path"
install -m 0644 "$repo_root/build/args.gn" "$out_path/args.gn"

echo "Generating out/$OUT_DIR with the tested GN args..."
(cd "$chromium_src" && "$gn_bin" gen "out/$OUT_DIR")

echo "Building electron_dist_zip with -j$jobs..."
(cd "$chromium_src" && "$ninja_bin" -C "out/$OUT_DIR" -j"$jobs" electron_dist_zip)

dist_zip="$out_path/dist.zip"
if [[ ! -f "$dist_zip" ]]; then
  echo "Build completed but dist.zip was not found: $dist_zip" >&2
  exit 1
fi

echo "Built: $dist_zip"
du -h "$dist_zip"
