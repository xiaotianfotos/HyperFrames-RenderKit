#!/usr/bin/env node
import { createHash } from "node:crypto";
import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { basename, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";
import process from "node:process";

const ROOT = resolve(import.meta.dirname, "../..");
const DEFAULT_MANIFEST = resolve(ROOT, "fixtures/color-contract/manifest.json");
const DEFAULT_FIXTURE = resolve(ROOT, "fixtures/color-contract/srgb-color-chart.html");

function parseArgs(argv) {
  return Object.fromEntries(argv.slice(2).filter((arg) => arg.startsWith("--")).map((arg) => {
    const [key, ...rest] = arg.slice(2).split("=");
    return [key, rest.join("=") || "true"];
  }));
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd ?? ROOT,
    encoding: options.binary ? null : "utf8",
    maxBuffer: options.maxBuffer ?? 64 * 1024 * 1024,
    stdio: options.stdio ?? (options.binary ? ["ignore", "pipe", "pipe"] : "pipe"),
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    const stderr = Buffer.isBuffer(result.stderr) ? result.stderr.toString("utf8") : result.stderr;
    throw new Error(`${command} failed (${result.status}): ${String(stderr).slice(-6000)}`);
  }
  return result.stdout;
}

function hexToRgb(hex) {
  const value = Number.parseInt(hex.slice(1), 16);
  return [(value >> 16) & 255, (value >> 8) & 255, value & 255];
}

function rgbToLab(rgb) {
  const linear = rgb.map((value) => {
    const c = value / 255;
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  const x = (linear[0] * 0.4124564 + linear[1] * 0.3575761 + linear[2] * 0.1804375) / 0.95047;
  const y = linear[0] * 0.2126729 + linear[1] * 0.7151522 + linear[2] * 0.072175;
  const z = (linear[0] * 0.0193339 + linear[1] * 0.1191920 + linear[2] * 0.9503041) / 1.08883;
  const f = (v) => v > 216 / 24389 ? Math.cbrt(v) : (24389 / 27 * v + 16) / 116;
  return [116 * f(y) - 16, 500 * (f(x) - f(y)), 200 * (f(y) - f(z))];
}

function deltaE76(a, b) {
  const labA = rgbToLab(a);
  const labB = rgbToLab(b);
  return Math.hypot(labA[0] - labB[0], labA[1] - labB[1], labA[2] - labB[2]);
}

function decodeRgb(path, width, height) {
  const bytes = run("ffmpeg", [
    "-v", "error", "-i", path, "-map", "0:v:0", "-frames:v", "1",
    "-f", "rawvideo", "-pix_fmt", "rgb24", "pipe:1",
  ], { binary: true, maxBuffer: width * height * 3 + 1024 * 1024 });
  const expected = width * height * 3;
  if (bytes.length !== expected) throw new Error(`Decoded ${bytes.length} RGB bytes from ${path}; expected ${expected}`);
  return bytes;
}

function patchMean(rgb, frameWidth, rect) {
  const sum = [0, 0, 0];
  let count = 0;
  for (let y = rect.y; y < rect.y + rect.height; y += 1) {
    for (let x = rect.x; x < rect.x + rect.width; x += 1) {
      const offset = (y * frameWidth + x) * 3;
      sum[0] += rgb[offset];
      sum[1] += rgb[offset + 1];
      sum[2] += rgb[offset + 2];
      count += 1;
    }
  }
  return sum.map((value) => value / count);
}

function summarizeFrame(reference, candidate, manifest) {
  const patches = manifest.patches.map((patch) => {
    const css = hexToRgb(patch.hex);
    const source = patchMean(reference, manifest.width, patch.rect);
    const output = patchMean(candidate, manifest.width, patch.rect);
    const channelError = output.map((value, index) => Math.abs(value - source[index]));
    const browserChannelError = source.map((value, index) => Math.abs(value - css[index]));
    const neutralChromaDrift = patch.group === "neutral"
      ? Math.max(Math.abs(output[0] - output[1]), Math.abs(output[0] - output[2]), Math.abs(output[1] - output[2]))
      : null;
    return {
      id: patch.id,
      group: patch.group,
      expectedCssRgb: css,
      sourceRgb: source.map((v) => Number(v.toFixed(4))),
      outputRgb: output.map((v) => Number(v.toFixed(4))),
      browserMaxChannelError: Number(Math.max(...browserChannelError).toFixed(4)),
      maxChannelError: Number(Math.max(...channelError).toFixed(4)),
      deltaE76: Number(deltaE76(source, output).toFixed(4)),
      neutralChromaDrift: neutralChromaDrift == null ? null : Number(neutralChromaDrift.toFixed(4)),
    };
  });
  const max = (values) => Math.max(...values);
  const mean = (values) => values.reduce((sum, value) => sum + value, 0) / values.length;
  const neutral = patches.filter((patch) => patch.group === "neutral");
  const summary = {
    patchCount: patches.length,
    browserMaxChannelError: Number(max(patches.map((patch) => patch.browserMaxChannelError)).toFixed(4)),
    maxPatchDeltaE76: Number(max(patches.map((patch) => patch.deltaE76)).toFixed(4)),
    meanPatchDeltaE76: Number(mean(patches.map((patch) => patch.deltaE76)).toFixed(4)),
    maxChannelError: Number(max(patches.map((patch) => patch.maxChannelError)).toFixed(4)),
    neutralMaxChromaDrift: Number(max(neutral.map((patch) => patch.neutralChromaDrift)).toFixed(4)),
  };
  const t = manifest.thresholds;
  const failures = [];
  if (summary.browserMaxChannelError > t.browserPatchMaxChannelError) failures.push("browser fixture pixels do not match CSS sRGB codes");
  if (summary.maxPatchDeltaE76 > t.positiveMaxPatchDeltaE76) failures.push("maximum patch DeltaE76 exceeds threshold");
  if (summary.meanPatchDeltaE76 > t.positiveMeanPatchDeltaE76) failures.push("mean patch DeltaE76 exceeds threshold");
  if (summary.maxChannelError > t.positiveMaxChannelError) failures.push("maximum RGB channel error exceeds threshold");
  if (summary.neutralMaxChromaDrift > t.positiveNeutralMaxChromaDrift) failures.push("neutral chroma drift exceeds threshold");
  return { pass: failures.length === 0, failures, summary, patches };
}

function encoderArgs(encoder, bitrate, fps, vaapiDevice) {
  const common = [
    "-profile:v", "high", "-b:v", String(bitrate), "-g", String(Math.max(1, Math.round(fps * 2))),
    "-color_range", "tv", "-colorspace", "bt709", "-color_primaries", "bt709", "-color_trc", "bt709",
  ];
  if (encoder === "vaapi") {
    return {
      prefix: ["-vaapi_device", vaapiDevice],
      codec: ["-vf", "__FILTER__,format=nv12,hwupload", "-c:v", "h264_vaapi", ...common],
    };
  }
  if (encoder === "videotoolbox") {
    return { prefix: [], codec: ["-vf", "__FILTER__,format=nv12", "-c:v", "h264_videotoolbox", ...common] };
  }
  return {
    prefix: [],
    codec: ["-vf", "__FILTER__,format=yuv420p", "-c:v", "libx264", "-preset", "medium", ...common],
  };
}

function encodeOne({ source, output, filter, encoder, bitrate, fps, vaapiDevice }) {
  const selected = encoderArgs(encoder, bitrate, fps, vaapiDevice);
  const codec = selected.codec.map((arg) => arg === "__FILTER__" ? filter : arg.replace("__FILTER__", filter));
  run("ffmpeg", [
    "-hide_banner", "-y", ...selected.prefix,
    "-loop", "1", "-framerate", String(fps), "-i", source,
    "-frames:v", "1", ...codec, "-an", "-movflags", "+faststart", output,
  ]);
}

function probeMov(path) {
  return JSON.parse(run("ffprobe", [
    "-v", "error", "-count_frames", "-show_entries",
    "stream=index,codec_type,codec_name,pix_fmt,width,height,r_frame_rate,avg_frame_rate,nb_read_frames,color_range,color_space,color_transfer,color_primaries",
    "-of", "json", path,
  ]));
}

function structuralFailures(probe, manifest) {
  const stream = probe.streams?.find((candidate) => candidate.codec_type === "video");
  if (!stream) return ["missing video stream"];
  const expected = {
    codec_name: "h264", pix_fmt: "yuv420p", width: manifest.width, height: manifest.height,
    r_frame_rate: `${manifest.fps}/1`, nb_read_frames: "1", color_range: "tv",
    color_space: "bt709", color_transfer: "bt709", color_primaries: "bt709",
  };
  return Object.entries(expected)
    .filter(([key, value]) => String(stream[key]) !== String(value))
    .map(([key, value]) => `${key}=${stream[key] ?? "missing"}; expected ${value}`);
}

function sha256(path) {
  return readFile(path).then((bytes) => createHash("sha256").update(bytes).digest("hex"));
}

const args = parseArgs(process.argv);
const manifestPath = resolve(args.manifest ?? DEFAULT_MANIFEST);
const fixturePath = resolve(args.fixture ?? DEFAULT_FIXTURE);
const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
const encoder = args.encoder ?? (process.platform === "linux" ? "vaapi" : process.platform === "darwin" ? "videotoolbox" : "libx264");
if (!new Set(["vaapi", "videotoolbox", "libx264"]).has(encoder)) throw new Error(`Unsupported encoder ${encoder}`);
const bitrate = Number(args.bitrate ?? 40_000_000);
const metadataPolicy = args.metadataPolicy ?? "current";
if (!new Set(["current", "explicit-frame"]).has(metadataPolicy)) {
  throw new Error(`Unsupported metadata policy ${metadataPolicy}`);
}
const runId = args.runId ?? `${new Date().toISOString().replaceAll(":", "-").replace(/\.\d{3}Z$/, "Z")}-${encoder}`;
const outputDir = resolve(args.outputDir ?? resolve(ROOT, "results/color-contract", runId));
const electron = resolve(args.electron ?? resolve(ROOT, "node_modules/.bin/electron"));
const vaapiDevice = args.vaapiDevice ?? "/dev/dri/renderD128";
const captureBackend = args.captureBackend ?? "electron";
await mkdir(outputDir, { recursive: true });

const source = resolve(outputDir, "browser-srgb-source.png");
if (args.sourcePng) {
  await copyFile(resolve(args.sourcePng), source);
} else if (captureBackend === "chromium") {
  const chromium = resolve(args.chromium ?? (
    process.platform === "darwin"
      ? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
      : "/usr/bin/google-chrome"
  ));
  run(chromium, [
    "--headless=new", "--hide-scrollbars", "--force-color-profile=srgb", "--force-device-scale-factor=1",
    `--window-size=${manifest.width},${manifest.height}`, `--screenshot=${source}`, pathToFileURL(fixturePath).href,
  ]);
} else if (captureBackend === "electron") {
  const electronFlags = process.platform === "linux"
    ? [
      "--no-sandbox",
      ...(process.env.WAYLAND_DISPLAY ? ["--ozone-platform=wayland", "--disable-vulkan"] : []),
    ]
    : [];
  run(electron, [
    ...electronFlags,
    resolve(import.meta.dirname, "electron_capture.mjs"),
    `--fixture=${fixturePath}`, `--output=${source}`, `--width=${manifest.width}`, `--height=${manifest.height}`,
  ]);
} else {
  throw new Error(`Unsupported capture backend ${captureBackend}`);
}

const variants = [
  {
    id: "positive-bt709-limited",
    expectedColorPass: true,
    filter: "scale=iw:ih:in_range=pc:out_range=tv:out_color_matrix=bt709:flags=lanczos+accurate_rnd",
  },
  {
    id: "negative-wrong-matrix",
    expectedColorPass: false,
    filter: "scale=iw:ih:in_range=pc:out_range=tv:out_color_matrix=bt601:flags=lanczos+accurate_rnd,setparams=range=limited:color_primaries=bt709:color_trc=bt709:colorspace=bt709",
  },
  {
    id: "negative-double-range-expansion",
    expectedColorPass: false,
    filter: "lutrgb=r='clip((val-16)*255/219,0,255)':g='clip((val-16)*255/219,0,255)':b='clip((val-16)*255/219,0,255)',scale=iw:ih:in_range=pc:out_range=tv:out_color_matrix=bt709:flags=lanczos+accurate_rnd",
  },
];

const reference = decodeRgb(source, manifest.width, manifest.height);
const variantReports = [];
for (const variant of variants) {
  const mov = resolve(outputDir, `${variant.id}.mov`);
  const decoded = resolve(outputDir, `${variant.id}.png`);
  const filter = metadataPolicy === "explicit-frame"
    ? `${variant.filter},setparams=range=limited:color_primaries=bt709:color_trc=bt709:colorspace=bt709`
    : variant.filter;
  encodeOne({ source, output: mov, filter, encoder, bitrate, fps: manifest.fps, vaapiDevice });
  run("ffmpeg", ["-hide_banner", "-y", "-i", mov, "-frames:v", "1", decoded]);
  const measured = summarizeFrame(reference, decodeRgb(mov, manifest.width, manifest.height), manifest);
  const probe = probeMov(mov);
  const structure = structuralFailures(probe, manifest);
  const contractPass = measured.pass && structure.length === 0;
  const expectationMet = variant.id === "positive-bt709-limited"
    ? contractPass === variant.expectedColorPass
    : measured.pass === variant.expectedColorPass;
  variantReports.push({
    id: variant.id,
    expectedColorPass: variant.expectedColorPass,
    colorPass: measured.pass,
    contractPass,
    expectationMet,
    filter,
    files: { mov: basename(mov), decodedPng: basename(decoded) },
    structuralFailures: structure,
    probe,
    color: measured,
  });
}

const report = {
  schemaVersion: 1,
  gate: "browser-srgb-to-bt709-limited-h264-mov",
  createdAt: new Date().toISOString(),
  pass: variantReports.every((variant) => variant.expectationMet),
  encoder,
  captureBackend: args.sourcePng ? "provided-png" : captureBackend,
  metadataPolicy,
  bitrate,
  manifest: { path: manifestPath, sha256: await sha256(manifestPath) },
  fixture: { path: fixturePath, sha256: await sha256(fixturePath) },
  source: { path: source, sha256: await sha256(source) },
  thresholds: manifest.thresholds,
  variants: variantReports,
};
const reportPath = resolve(outputDir, "report.json");
await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`);

const positive = variantReports[0];
console.log(JSON.stringify({
  pass: report.pass,
  report: reportPath,
  encoder,
  positive: positive.color.summary,
  negativeExpectations: variantReports.slice(1).map(({ id, expectationMet, colorPass, color }) => ({ id, expectationMet, colorPass, summary: color.summary })),
}, null, 2));
if (!report.pass) process.exitCode = 1;
