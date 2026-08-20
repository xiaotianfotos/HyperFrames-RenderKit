#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
chromium_src="${1:-}"

if [[ -z "$chromium_src" ]]; then
  echo "Usage: $0 /path/to/electron-root/src" >&2
  exit 2
fi

if [[ ! -f "$chromium_src/media/gpu/vaapi/vaapi_wrapper.cc" ]]; then
  echo "Not the expected Chromium source root: $chromium_src" >&2
  exit 2
fi

for patch_file in "$repo_root"/patches/*.patch; do
  patch_name="$(basename "$patch_file")"
  if git -C "$chromium_src" apply --reverse --check "$patch_file" >/dev/null 2>&1; then
    echo "already applied: $patch_name"
    continue
  fi

  if ! git -C "$chromium_src" apply --check "$patch_file"; then
    echo "Patch does not apply cleanly: $patch_name" >&2
    echo "Stop here and port it to this Chromium revision; do not force it." >&2
    exit 1
  fi

  git -C "$chromium_src" apply "$patch_file"
  echo "applied: $patch_name"
done
