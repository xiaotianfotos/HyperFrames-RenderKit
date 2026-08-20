#!/usr/bin/env node

import { createReadStream, statSync } from "node:fs";
import { createServer } from "node:http";
import { basename, resolve } from "node:path";

const [fileArg, host = "127.0.0.1", portArg = "8765"] = process.argv.slice(2);
if (!fileArg) {
  throw new Error("Usage: serve_video_preview.mjs <video.mov> [host] [port]");
}

const filePath = resolve(fileArg);
const fileName = basename(filePath);
const fileSize = statSync(filePath).size;
const port = Number(portArg);
if (!Number.isSafeInteger(port) || port < 1 || port > 65535) {
  throw new Error(`Invalid port: ${portArg}`);
}

const commonHeaders = {
  "Accept-Ranges": "bytes",
  "Cache-Control": "no-store",
  "Content-Type": "video/quicktime",
};

function sendVideo(request, response) {
  const range = request.headers.range;
  if (!range) {
    response.writeHead(200, { ...commonHeaders, "Content-Length": fileSize });
    if (request.method === "HEAD") response.end();
    else createReadStream(filePath).pipe(response);
    return;
  }

  const match = /^bytes=(\d*)-(\d*)$/.exec(range);
  if (!match) {
    response.writeHead(416, { "Content-Range": `bytes */${fileSize}` });
    response.end();
    return;
  }
  const start = match[1] ? Number(match[1]) : 0;
  const end = match[2] ? Number(match[2]) : fileSize - 1;
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end)
      || start < 0 || end < start || start >= fileSize) {
    response.writeHead(416, { "Content-Range": `bytes */${fileSize}` });
    response.end();
    return;
  }
  const boundedEnd = Math.min(end, fileSize - 1);
  response.writeHead(206, {
    ...commonHeaders,
    "Content-Length": boundedEnd - start + 1,
    "Content-Range": `bytes ${start}-${boundedEnd}/${fileSize}`,
  });
  if (request.method === "HEAD") response.end();
  else createReadStream(filePath, { start, end: boundedEnd }).pipe(response);
}

const server = createServer((request, response) => {
  if (request.url === "/" || request.url === "/index.html") {
    const videoUrl = `/video/${encodeURIComponent(fileName)}`;
    const html = `<!doctype html><meta charset="utf-8"><title>${fileName}</title><style>html,body{margin:0;background:#111;color:#eee;font:14px system-ui}main{max-width:1200px;margin:auto;padding:16px}video{width:100%;max-height:calc(100vh - 80px);background:#000}</style><main><video controls autoplay src="${videoUrl}"></video><p>${fileName}</p></main>`;
    response.writeHead(200, {
      "Cache-Control": "no-store",
      "Content-Length": Buffer.byteLength(html),
      "Content-Type": "text/html; charset=utf-8",
    });
    response.end(html);
    return;
  }
  if (request.url === `/video/${encodeURIComponent(fileName)}`
      && (request.method === "GET" || request.method === "HEAD")) {
    sendVideo(request, response);
    return;
  }
  response.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
  response.end("Not found\n");
});

server.listen(port, host, () => {
  process.stdout.write(`HyperFrames preview: http://${host}:${port}/\n`);
});
