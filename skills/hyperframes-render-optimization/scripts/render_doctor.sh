#!/usr/bin/env bash
set -u

project_root="${1:-.}"
if [ ! -d "$project_root" ]; then
  printf 'Project root is not a directory: %s\n' "$project_root" >&2
  exit 2
fi
project_root="$(cd "$project_root" && pwd -P)"
if [ "$#" -gt 0 ]; then shift; fi
media_inputs=("$@")

section() {
  printf '\n[%s]\n' "$1"
}

run_if_present() {
  local command_name="$1"
  shift
  if command -v "$command_name" >/dev/null 2>&1; then
    "$command_name" "$@" 2>&1 || true
  else
    printf '%s: not found\n' "$command_name"
  fi
}

section "System"
uname -a 2>/dev/null || true
if command -v sysctl >/dev/null 2>&1; then
  sysctl -n machdep.cpu.brand_string 2>/dev/null || true
  sysctl -n hw.memsize 2>/dev/null || true
fi
if command -v lscpu >/dev/null 2>&1; then
  lscpu | sed -n '1,28p'
fi

section "HyperFrames and browser runtime"
hyperframes_cli="$project_root/node_modules/.bin/hyperframes"
if [ -x "$hyperframes_cli" ]; then
  "$hyperframes_cli" --version 2>/dev/null || true
  printf 'HyperFrames doctor (read-only; unsupported versions may reject this command):\n'
  "$hyperframes_cli" doctor --json 2>&1 | sed -n '1,160p' || true
elif [ -f "$project_root/package.json" ]; then
  grep -n '"hyperframes"' "$project_root/package.json" | head -10 || true
  printf '%s\n' 'No project-local HyperFrames CLI. Avoid network installation during diagnosis unless authorized.'
else
  printf '%s\n' 'No package.json or project-local HyperFrames CLI found.'
fi
run_if_present node --version
for browser in google-chrome-stable google-chrome chrome chromium chromium-browser electron; do
  if command -v "$browser" >/dev/null 2>&1; then
    "$browser" --version 2>/dev/null || true
  fi
done
if [ -x "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" ]; then
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" --version 2>/dev/null || true
fi

section "FFmpeg capabilities"
if command -v ffmpeg >/dev/null 2>&1; then
  ffmpeg -version 2>/dev/null | sed -n '1,3p'
  printf 'Video encoders:\n'
  ffmpeg -hide_banner -encoders 2>/dev/null \
    | grep -E '(^| )((libx264|libx265)|h264_(vaapi|nvenc|videotoolbox)|hevc_(vaapi|nvenc|videotoolbox))' || true
  printf 'Hardware/composite filters:\n'
  ffmpeg -hide_banner -filters 2>/dev/null \
    | grep -E 'overlay(_vaapi|_cuda)?|scale_(vaapi|cuda)|zscale|hwupload|hwdownload|setparams' || true
else
  printf '%s\n' 'ffmpeg: not found'
fi
run_if_present ffprobe -version | sed -n '1,2p'

section "GPU"
run_if_present nvidia-smi --query-gpu=name,driver_version,memory.total,power.limit,pstate \
  --format=csv,noheader
run_if_present vainfo
run_if_present system_profiler SPDisplaysDataType

section "Memory and destination capacity"
if [ -r /proc/meminfo ]; then
  grep -E '^(MemTotal|MemAvailable|SwapTotal|SwapFree):' /proc/meminfo
else
  run_if_present vm_stat
fi
df -h "$project_root" 2>/dev/null || true

section "Project"
printf 'Root: %s\n' "$project_root"
if [ -f "$project_root/index.html" ]; then
  grep -nE 'data-(width|height|duration)|__timelines|registerComposition' \
    "$project_root/index.html" | head -60 || true
fi
if command -v rg >/dev/null 2>&1; then
  printf 'Capture-risk indicators (review; not automatic failures):\n'
  (
    cd "$project_root" || exit 2
    rg -n --glob '*.{html,css,js,mjs,cjs,ts,tsx}' \
      --glob '!**/node_modules/**' --glob '!**/.render-cache/**' --glob '!**/results/**' \
      --glob '!**/output/**' --glob '!**/dist/**' --glob '!**/build/**' --glob '!**/backups/**' \
      --glob '!**/*.min.js' \
      'backdrop-filter|mix-blend-mode|foreignObject|clip-path|mask(-image)?|filter:|perspective|skew[XY]?\(|content-visibility|iframe|data-hidden|<video|<audio' \
      . | head -160 || true
  )
  printf 'Render-path indicators:\n'
  (
    cd "$project_root" || exit 2
    rg -n --glob '*.{html,js,mjs,cjs,ts,tsx,json}' \
      --glob '!**/node_modules/**' --glob '!**/.render-cache/**' --glob '!**/results/**' \
      --glob '!**/output/**' --glob '!**/dist/**' --glob '!**/build/**' --glob '!**/*.min.js' \
      'mediaDecoderBackend|production-webcodecs|drawElementImage|CanvasDrawElement|capturePage|VideoDecoder|VideoEncoder|canonical.cache|timing.bundle|pcm_s24le|h264_metadata|setparams=range' \
      . | head -160 || true
  )
else
  printf '%s\n' 'rg: not found; project feature scan skipped'
fi

if [ "${#media_inputs[@]}" -gt 0 ]; then
  for source_video in "${media_inputs[@]}"; do
    section "Media: $source_video"
    if [ ! -f "$source_video" ]; then
      printf 'Not a file: %s\n' "$source_video"
      continue
    fi
    ls -lh "$source_video" 2>/dev/null || true
    if command -v ffprobe >/dev/null 2>&1; then
      ffprobe -v error -count_frames -select_streams v:0 \
        -show_entries 'format=format_name,duration,size,bit_rate,start_time:stream=index,codec_type,codec_name,codec_tag_string,profile,level,pix_fmt,width,height,sample_aspect_ratio,field_order,color_range,color_space,color_transfer,color_primaries,chroma_location,r_frame_rate,avg_frame_rate,time_base,start_pts,start_time,duration_ts,nb_frames,nb_read_frames,has_b_frames' \
        -of json "$source_video" 2>&1 || true
      printf 'Audio streams:\n'
      ffprobe -v error -select_streams a \
        -show_entries 'stream=index,codec_name,sample_rate,channels,channel_layout,time_base,start_time,duration_ts,duration' \
        -of json "$source_video" 2>&1 || true
    else
      printf '%s\n' 'ffprobe: not found'
    fi
  done
fi

section "Required next gates"
printf '%s\n' \
  '1. Freeze RenderPlan and frame-exact backend intervals before rendering.' \
  '2. Run the selected backend self-probe and a one-frame final MOV/audio/color/cleanup smoke.' \
  '3. Benchmark sparse, dense MG, cut, alpha/text, decoder-sharing, and tail intervals twice.' \
  '4. Compare candidate frames with faithful screenshot goldens; API success is not pixel proof.' \
  '5. Require exact frames/samples/color, zero resource leaks, bounded evidence, and atomic commit.'
