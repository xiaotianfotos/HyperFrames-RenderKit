#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";

const args = new Set(process.argv.slice(2));
const jsonOutput = args.has("--json");
const worktreeOnly = args.has("--worktree-only");
const issues = [];

function git(parameters, { allowFailure = false } = {}) {
  const result = spawnSync("git", parameters, { encoding: "utf8" });
  if (result.status !== 0 && !allowFailure) {
    throw new Error(`git ${parameters.join(" ")} failed: ${result.stderr.trim()}`);
  }
  return result.stdout ?? "";
}

function add(code, message, evidence = {}) {
  issues.push({ code, message, ...evidence });
}

function isPrivateIpv4(value) {
  const octets = value.split(".").map(Number);
  return octets.length === 4 && octets.every((item) => Number.isInteger(item) && item >= 0 && item <= 255)
    && (octets[0] === 10
      || (octets[0] === 172 && octets[1] >= 16 && octets[1] <= 31)
      || (octets[0] === 192 && octets[1] === 168));
}

const secretPatterns = [
  ["private-key", /-----BEGIN (?:[A-Z ]+ )?PRIVATE KEY-----/g],
  ["aws-access-key", /\bAKIA[0-9A-Z]{16}\b/g],
  ["google-api-key", /\bAIza[0-9A-Za-z_-]{30,}\b/g],
  ["openai-style-key", /\bsk-[A-Za-z0-9_-]{20,}\b/g],
  ["github-token", /\b(?:github_pat_[A-Za-z0-9_]{20,}|gh[pousr]_[A-Za-z0-9]{20,})\b/g],
  ["slack-token", /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g],
];
const privateIpPattern = /\b(?:\d{1,3}\.){3}\d{1,3}\b/g;
const localPathPatterns = [
  /\/home\/(?!render(?:\/|\b)|user(?:\/|\b))[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._~+@%:/=-]+)*/g,
  /\/Users\/(?!user(?:\/|\b))[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._~+@%:/=-]+)*/g,
  /\/(?:vol\d+|fs\/\d+)(?:\/[A-Za-z0-9._~+@%:/=-]+)*/g,
];
const sensitivePathPattern = /(^|\/)(?:\.env(?:\..+)?|\.npmrc|\.netrc|id_(?:rsa|ed25519)|credentials[^/]*\.json|service-account[^/]*\.json|[^/]+\.(?:pem|key|p12|pfx|jks|kdbx))$/i;

for (const path of git(["ls-files", "-z"]).split("\0").filter(Boolean)) {
  // A privacy cleanup may intentionally delete a tracked file before the
  // cleanup commit exists. Audit the candidate working tree, not Git's stale
  // index entry for that deletion.
  if (!existsSync(path)) continue;
  if (sensitivePathPattern.test(path)) add("PUBLIC-SENSITIVE-FILE", "sensitive-looking file is tracked", { path });
  const bytes = readFileSync(path);
  if (bytes.includes(0) || bytes.length > 5 * 1024 * 1024) continue;
  const text = bytes.toString("utf8");
  const lines = text.split(/\r?\n/);
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    for (const [kind, pattern] of secretPatterns) {
      pattern.lastIndex = 0;
      if (pattern.test(line)) add("PUBLIC-SECRET", `possible ${kind}`, { path, line: index + 1 });
    }
    for (const candidate of line.match(privateIpPattern) ?? []) {
      if (isPrivateIpv4(candidate)) add("PUBLIC-PRIVATE-IP", "private network address is tracked", { path, line: index + 1 });
    }
    for (const pattern of localPathPatterns) {
      pattern.lastIndex = 0;
      if (pattern.test(line)) add("PUBLIC-LOCAL-PATH", "user- or machine-specific absolute path is tracked", { path, line: index + 1 });
    }
  }
}

if (!["LICENSE", "LICENSE.md", "LICENSE.txt"].some(existsSync)) {
  add("PUBLIC-LICENSE-MISSING", "no repository license has been selected");
}

if (!worktreeOnly) {
  const authors = new Set(git(["log", "--all", "--format=%ae"], { allowFailure: true }).split(/\r?\n/).filter(Boolean));
  const publicHistoryEmails = [...authors].filter((email) => (
    !/@users\.noreply\.github\.com$/i.test(email) && !/@example\.(?:com|org|invalid)$/i.test(email)
  ));
  if (publicHistoryEmails.length) {
    add("PUBLIC-HISTORY-EMAIL", "Git history contains non-noreply author emails", { identityCount: publicHistoryEmails.length });
  }
  const privateRemoteNames = new Set();
  for (const line of git(["remote", "-v"], { allowFailure: true }).split(/\r?\n/).filter(Boolean)) {
    const privateAddress = (line.match(privateIpPattern) ?? []).some(isPrivateIpv4);
    if (privateAddress) privateRemoteNames.add(line.split(/\s+/, 1)[0]);
  }
  for (const remote of privateRemoteNames) {
    add("PUBLIC-PRIVATE-REMOTE", "Git remote points to a private network address", { remote });
  }
}

const report = {
  kind: "hyperframes-public-safety-report",
  schemaVersion: 1,
  ready: issues.length === 0,
  issueCount: issues.length,
  issues,
};

if (jsonOutput) console.log(JSON.stringify(report, null, 2));
else if (issues.length === 0) console.log("public-safety: ready");
else {
  console.error(`public-safety: ${issues.length} blocking issue(s)`);
  for (const issue of issues) {
    const location = issue.path ? ` ${issue.path}${issue.line ? `:${issue.line}` : ""}` : "";
    console.error(`- ${issue.code}${location}: ${issue.message}`);
  }
}
process.exitCode = issues.length === 0 ? 0 : 2;
