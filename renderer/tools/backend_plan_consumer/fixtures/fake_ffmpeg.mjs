#!/usr/bin/env node

import { copyFileSync, readFileSync, writeFileSync } from "node:fs";

const args = process.argv.slice(2);
const listPath = args[args.indexOf("-i") + 1];
const output = args.at(-1);
const sources = readFileSync(listPath, "utf8").trim().split(/\r?\n/).map((line) => {
  const quoted = line.replace(/^file\s+'/, "").replace(/'$/, "");
  return quoted.replaceAll("'\\''", "'");
});
const fixtures = sources.map((source) => JSON.parse(readFileSync(`${source}.fake-probe.json`, "utf8")));
copyFileSync(sources[0], output);
writeFileSync(`${output}.fake-probe.json`, `${JSON.stringify({
  frames: fixtures.reduce((sum, fixture) => sum + fixture.frames, 0),
  colorTransfer: fixtures[0].colorTransfer,
})}\n`);
