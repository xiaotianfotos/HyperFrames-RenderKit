import { app } from "electron";
import { appendFileSync } from "node:fs";

app.commandLine.appendSwitch("no-sandbox");
app.commandLine.appendSwitch("disable-setuid-sandbox");
app.commandLine.appendSwitch("ignore-gpu-blocklist");
app.commandLine.appendSwitch("enable-gpu-rasterization");
app.commandLine.appendSwitch("enable-zero-copy");
app.commandLine.appendSwitch("enable-native-gpu-memory-buffers");
app.commandLine.appendSwitch("force-color-profile", "srgb");
app.commandLine.appendSwitch("force-device-scale-factor", "1");
app.commandLine.appendSwitch("use-gl", "angle");
app.commandLine.appendSwitch("use-angle", "gl");
app.commandLine.appendSwitch("disable-software-rasterizer");
app.commandLine.appendSwitch("disable-background-timer-throttling");
app.commandLine.appendSwitch("disable-renderer-backgrounding");
app.commandLine.appendSwitch("disable-backgrounding-occluded-windows");
app.commandLine.appendSwitch("disable-frame-rate-limit");
app.commandLine.appendSwitch("disable-gpu-vsync");
app.commandLine.appendSwitch("enable-features", [
  "CanvasDrawElement",
  "AcceleratedVideoDecoder",
  "AcceleratedVideoDecodeLinuxGL",
  "AcceleratedVideoDecodeLinuxZeroCopyGL",
  "AcceleratedVideoEncoder",
  "UseMultiPlaneFormatForHardwareVideo",
].join(","));
app.commandLine.appendSwitch("remote-debugging-port", "9239");
app.commandLine.appendSwitch("enable-logging", "stderr");

const outputArgument = process.argv.find((value) => value.startsWith("--output="));
const output = outputArgument?.slice("--output=".length);

if (!output) {
  throw new Error("Missing --output=/absolute/path");
}

appendFileSync(output, `${JSON.stringify({ stage: "module-loaded", argv: process.argv })}\n`);
app.whenReady().then(() => {
  appendFileSync(output, `${JSON.stringify({ stage: "app-ready" })}\n`);
  app.exit(0);
}, (error) => {
  appendFileSync(output, `${JSON.stringify({ stage: "app-ready-failed", error: String(error) })}\n`);
  app.exit(1);
});
