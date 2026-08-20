#!/usr/bin/env bash
set -euo pipefail

mode="build"
target=""

usage() {
  echo "Usage: $0 [--build|--runtime] /absolute/path/on-data-disk" >&2
}

while (($# > 0)); do
  case "$1" in
    --build) mode="build" ;;
    --runtime) mode="runtime" ;;
    -h|--help) usage; exit 0 ;;
    *)
      if [[ -n "$target" ]]; then
        usage
        exit 2
      fi
      target="$1"
      ;;
  esac
  shift
done

if [[ -z "$target" || "$target" != /* ]]; then
  usage
  exit 2
fi

errors=0
warnings=0

fail() {
  echo "ERROR: $*" >&2
  errors=$((errors + 1))
}

warn() {
  echo "WARN:  $*" >&2
  warnings=$((warnings + 1))
}

pass() {
  echo "OK:    $*"
}

if [[ "$(uname -s)" != "Linux" ]]; then
  fail "the verified build/runtime target is Linux x86_64"
fi
if [[ "$(uname -m)" != "x86_64" ]]; then
  fail "the verified target architecture is x86_64"
fi

case "$target" in
  /|/tmp|/tmp/*|/var/tmp|/var/tmp/*)
    fail "do not place the Electron tree or render workspace on the system temporary filesystem: $target"
    ;;
esac

probe_path="$target"
while [[ ! -e "$probe_path" && "$probe_path" != "/" ]]; do
  probe_path="$(dirname "$probe_path")"
done

disk_kib="$(df -Pk "$probe_path" | awk 'NR==2 {print $4}')"
disk_gib=$((disk_kib / 1024 / 1024))
if [[ "$mode" == "build" ]]; then
  if ((disk_gib < 80)); then
    fail "build volume has ${disk_gib}GiB free; reserve at least 80GiB"
  else
    pass "build volume has ${disk_gib}GiB free"
  fi
else
  if ((disk_gib < 100)); then
    warn "runtime volume has ${disk_gib}GiB free; long 4K intermediates/caches may need more"
  else
    pass "runtime volume has ${disk_gib}GiB free"
  fi
fi

if [[ -r /proc/meminfo ]]; then
  mem_kib="$(awk '/^MemTotal:/ {print $2}' /proc/meminfo)"
  mem_gib=$((mem_kib / 1024 / 1024))
  if [[ "$mode" == "build" && "$mem_gib" -lt 31 ]]; then
    fail "build host has ${mem_gib}GiB RAM; 32GiB is the minimum and 64GiB+ is recommended"
  elif [[ "$mode" == "runtime" && "$mem_gib" -lt 16 ]]; then
    fail "runtime host has ${mem_gib}GiB RAM; use at least 16GiB and prefer 32GiB"
  else
    pass "memory total is about ${mem_gib}GiB"
  fi
fi

required=(git python3 node npm)
if [[ "$mode" == "runtime" ]]; then
  required+=(ffmpeg ffprobe)
fi

for command_name in "${required[@]}"; do
  if command -v "$command_name" >/dev/null 2>&1; then
    pass "$command_name=$(command -v "$command_name")"
  else
    fail "missing command: $command_name"
  fi
done

if [[ "$mode" == "build" ]]; then
  if command -v e >/dev/null 2>&1; then
    pass "e=$(command -v e)"
  elif [[ -f "$target/source/.gclient" && -d "$target/source/src" ]]; then
    warn "Electron build-tools command 'e' is unavailable, but an existing synchronized source tree was found; install build-tools before recreating or syncing the profile"
  else
    fail "missing Electron build-tools command 'e' and no existing source/.gclient tree was found"
  fi
fi

if [[ "$mode" == "runtime" ]]; then
  if command -v vainfo >/dev/null 2>&1; then
    if vainfo 2>&1 | grep -q 'VAProfileH264High.*VAEntrypointEncSlice'; then
      pass "VAAPI exposes H.264 encode"
    else
      fail "VAAPI does not report H.264 EncSlice support"
    fi
  else
    fail "missing vainfo; install libva-utils and verify the actual hardware encoder"
  fi

  if [[ -z "${WAYLAND_DISPLAY:-}" && -z "${DISPLAY:-}" ]]; then
    warn "neither WAYLAND_DISPLAY nor DISPLAY is set; run this check inside the render session"
  else
    pass "display session is available"
  fi
fi

printf 'Summary: mode=%s errors=%d warnings=%d target=%s\n' "$mode" "$errors" "$warnings" "$target"
if ((errors > 0)); then
  exit 1
fi
