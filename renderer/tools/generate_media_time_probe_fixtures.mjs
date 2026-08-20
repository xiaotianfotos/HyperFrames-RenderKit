#!/usr/bin/env node

import { spawn } from "node:child_process";
import { mkdir } from "node:fs/promises";
import { resolve, join } from "node:path";

const output = resolve(process.argv[2] ?? "results/media-time-domain/fixtures");
const ffmpeg = process.env.FFMPEG ?? "ffmpeg";

function run(args) {
  return new Promise((resolveRun, rejectRun) => {
    const child = spawn(ffmpeg, args, { stdio: ["ignore", "inherit", "inherit"] });
    child.once("error", rejectRun);
    child.once("close", (code) => {
      if (code === 0) resolveRun();
      else rejectRun(new Error(`${ffmpeg} exited ${code}`));
    });
  });
}

const commonInput = ["-f", "lavfi", "-i", "testsrc2=size=640x360:rate=30:duration=2"];
const commonEncode = [
  "-c:v", "libx264", "-preset", "ultrafast", "-g", "30", "-bf", "3", "-pix_fmt", "yuv420p",
];

await mkdir(output, { recursive: true });
const cfr = join(output, "cfr-bframes.mp4");
const vfr = join(output, "vfr-missing-bframes.mp4");
const nonzero = join(output, "nonzero-origin-hostile.mp4");
const editList = join(output, "negative-origin-edit-list-trim.mp4");

await run(["-hide_banner", "-loglevel", "error", "-y", ...commonInput, ...commonEncode, cfr]);
await run([
  "-hide_banner", "-loglevel", "error", "-y", ...commonInput,
  "-vf", "select='not(eq(n,10)+eq(n,11)+eq(n,35))'", "-fps_mode", "vfr",
  ...commonEncode, vfr,
]);
await run([
  "-hide_banner", "-loglevel", "error", "-y", ...commonInput,
  "-vf", "setpts=PTS+2/TB", "-fps_mode", "passthrough",
  ...commonEncode, "-avoid_negative_ts", "disabled", nonzero,
]);
await run([
  "-hide_banner", "-loglevel", "error", "-y",
  "-ss", "0.2", "-i", cfr, "-t", "1.5", "-c", "copy",
  "-avoid_negative_ts", "disabled", editList,
]);

console.log(JSON.stringify({ output, fixtures: { cfr, vfr, nonzero, editList } }, null, 2));
