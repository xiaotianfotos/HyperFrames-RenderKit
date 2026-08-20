#!/usr/bin/env node

import { existsSync, readFileSync } from "node:fs";

const args = process.argv.slice(2);
const file = args.at(-1);
const fixture = existsSync(`${file}.fake-probe.json`)
  ? JSON.parse(readFileSync(`${file}.fake-probe.json`, "utf8"))
  : (() => {
    const match = readFileSync(file, "utf8").match(/^fake mov \d+ (\d+)/);
    if (!match) throw new Error(`missing fake probe sidecar for ${file}`);
    return { frames: Number(match[1]), colorTransfer: "bt709" };
  })();
if (args.includes("-show_packets")) {
  console.log(JSON.stringify({ packets: [{ flags: "K_" }] }));
} else if (args.includes("-show_frames") && args.includes("v:0")) {
  console.log(JSON.stringify({ frames: [{ key_frame: 1, pict_type: "I" }] }));
} else if (args.includes("-show_frames") && args.includes("a:0")) {
  console.log(String(fixture.frames * 800));
} else {
  console.log(JSON.stringify({
    format: { format_name: "mov,mp4,m4a,3gp,3g2,mj2" },
    streams: [
      {
        index: 0, codec_type: "video", codec_name: "h264", codec_tag_string: "avc1",
        width: 3840, height: 2160, pix_fmt: "yuv420p", r_frame_rate: "60/1", avg_frame_rate: "60/1",
        time_base: "1/15360", start_pts: 0, duration_ts: fixture.frames * 256,
        nb_read_frames: String(fixture.frames), sample_aspect_ratio: "1:1", color_range: "tv",
        color_space: "bt709", color_transfer: fixture.colorTransfer, color_primaries: "bt709",
        chroma_location: "left", field_order: "progressive", extradata: "000000016764001f",
      },
      {
        index: 1, codec_type: "audio", codec_name: "pcm_s24le", codec_tag_string: "in24",
        sample_fmt: "s32", bits_per_sample: 24, bits_per_raw_sample: 24,
        sample_rate: "48000", channels: 2, channel_layout: "stereo", time_base: "1/48000", start_pts: 0,
      },
    ],
  }));
}
