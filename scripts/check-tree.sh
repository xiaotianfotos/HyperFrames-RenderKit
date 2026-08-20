#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# shellcheck disable=SC1091
source "$repo_root/VERSION.lock"

chromium_src="${1:-}"
if [[ -z "$chromium_src" ]]; then
  echo "Usage: $0 /path/to/electron-root/src" >&2
  exit 2
fi

if [[ ! -d "$chromium_src/.git" || ! -d "$chromium_src/electron/.git" ]]; then
  echo "Not an Electron source tree: $chromium_src" >&2
  exit 2
fi

actual_chromium="$(git -C "$chromium_src" rev-parse HEAD)"
actual_electron="$(git -C "$chromium_src/electron" rev-parse HEAD)"

printf 'Chromium expected: %s\n' "$CHROMIUM_COMMIT"
printf 'Chromium actual:   %s\n' "$actual_chromium"
printf 'Electron expected: %s (%s)\n' "$ELECTRON_COMMIT" "$ELECTRON_TAG"
printf 'Electron actual:   %s\n' "$actual_electron"

status=0
if [[ "$actual_chromium" != "$CHROMIUM_COMMIT" ]]; then
  echo "ERROR: Chromium revision does not match VERSION.lock." >&2
  status=1
fi
if [[ "$actual_electron" != "$ELECTRON_COMMIT" ]]; then
  echo "ERROR: Electron revision does not match VERSION.lock." >&2
  status=1
fi

for patch_file in "$repo_root"/patches/*.patch; do
  patch_name="$(basename "$patch_file")"
  if git -C "$chromium_src" apply --reverse --check "$patch_file" >/dev/null 2>&1; then
    patch_state="applied"
  elif git -C "$chromium_src" apply --check "$patch_file" >/dev/null 2>&1; then
    patch_state="not-applied"
  else
    patch_state="diverged"
    status=1
  fi
  printf '%-44s %s\n' "$patch_name" "$patch_state"
done

declare -A expected_paths=()
for patch_file in "$repo_root"/patches/*.patch; do
  while IFS= read -r changed_path; do
    [[ -n "$changed_path" ]] && expected_paths["$changed_path"]=1
  done < <(sed -n 's#^diff --git a/\([^ ]*\) b/.*#\1#p' "$patch_file")
done

while IFS= read -r changed_path; do
  [[ -z "$changed_path" ]] && continue
  if [[ -z "${expected_paths[$changed_path]+present}" ]]; then
    echo "ERROR: unexpected source modification outside the production patch: $changed_path" >&2
    status=1
  fi
done < <(git -C "$chromium_src" diff --name-only --ignore-submodules=all)

exit "$status"
