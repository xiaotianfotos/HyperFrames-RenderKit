import { createHash } from "node:crypto";
import {
  createReadStream,
  existsSync,
  lstatSync,
  readFileSync,
  readdirSync,
  realpathSync,
  statSync,
} from "node:fs";
import { dirname, extname, isAbsolute, relative, resolve, sep } from "node:path";
import { canonicalJson } from "./lib.mjs";

export const PROJECT_IDENTITY_KIND = "hyperframes-whole-project-identity-manifest";
export const PROJECT_IDENTITY_SCHEMA_VERSION = 1;
export const PROJECT_IDENTITY_ALGORITHM = Object.freeze({
  name: "hyperframes-whole-project-sha256-v1",
  fileDigest: "sha256-file-bytes",
  aggregateDigest: "sha256-canonical-json",
  pathEncoding: "project-relative-posix-utf8",
  metadata: "path-size-content-and-dependency-reasons;mtime-and-absolute-root-excluded",
  ignoredBasenames: Object.freeze([".DS_Store", "._*"]),
  symlinkPolicy: "reject",
});

const SHA256_PATTERN = /^sha256:[a-f0-9]{64}$/;
const TEXT_REFERENCE_EXTENSIONS = new Set([".html", ".htm", ".css"]);

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function ignoredBasename(name) {
  return name === ".DS_Store" || name.startsWith("._");
}

function portablePath(value) {
  return value.split(sep).join("/");
}

function assertInsideProject(projectRoot, absolutePath, label) {
  const rel = relative(projectRoot, absolutePath);
  if (!rel || rel === ".") return ".";
  if (rel.startsWith("..") || isAbsolute(rel)) throw new Error(`${label} escapes project root: ${absolutePath}`);
  return portablePath(rel);
}

function resolveProjectPath(projectRoot, value, label) {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${label} must be a non-empty path`);
  const absolute = resolve(projectRoot, value);
  assertInsideProject(projectRoot, absolute, label);
  return absolute;
}

function digestFile(path) {
  return new Promise((resolveDigest, rejectDigest) => {
    const hash = createHash("sha256");
    const input = createReadStream(path);
    input.on("data", (chunk) => hash.update(chunk));
    input.once("error", rejectDigest);
    input.once("end", () => resolveDigest(hash.digest("hex")));
  });
}

function enumerateFiles(path, projectRoot) {
  if (!existsSync(path)) throw new Error(`identity input is missing: ${path}`);
  const info = lstatSync(path);
  if (info.isSymbolicLink()) throw new Error(`identity input may not be a symlink: ${path}`);
  if (info.isFile()) return ignoredBasename(path.split(sep).at(-1)) ? [] : [path];
  if (!info.isDirectory()) throw new Error(`identity input is not a regular file or directory: ${path}`);
  const result = [];
  for (const name of readdirSync(path).sort()) {
    if (ignoredBasename(name)) continue;
    const child = resolve(path, name);
    assertInsideProject(projectRoot, child, "identity directory child");
    result.push(...enumerateFiles(child, projectRoot));
  }
  return result;
}

function normalizeReference(raw) {
  const value = String(raw ?? "").trim().replace(/^['"]|['"]$/g, "");
  if (!value || value.startsWith("#") || /^(?:data|blob|https?|javascript|mailto|about):/i.test(value)) return null;
  const withoutSuffix = value.split("#", 1)[0].split("?", 1)[0];
  if (!withoutSuffix) return null;
  try {
    return decodeURIComponent(withoutSuffix);
  } catch {
    throw new Error(`dependency reference is not valid percent-encoded UTF-8: ${raw}`);
  }
}

function referencesInText(sourcePath) {
  if (!TEXT_REFERENCE_EXTENSIONS.has(extname(sourcePath).toLowerCase())) return [];
  const text = readFileSync(sourcePath, "utf8");
  const references = [];
  if (/\.html?$/i.test(sourcePath)) {
    for (const match of text.matchAll(/\b(?:src|href|poster)\s*=\s*(["'])(.*?)\1/gi)) {
      references.push({ value: match[2], reason: `html-${match[0].slice(0, match[0].indexOf("=")).trim().toLowerCase()}` });
    }
    for (const match of text.matchAll(/\bsrcset\s*=\s*(["'])(.*?)\1/gi)) {
      for (const item of match[2].split(",")) references.push({ value: item.trim().split(/\s+/, 1)[0], reason: "html-srcset" });
    }
  }
  for (const match of text.matchAll(/url\(\s*(["']?)(.*?)\1\s*\)/gi)) {
    references.push({ value: match[2], reason: "css-url" });
  }
  for (const match of text.matchAll(/@import\s+(?:url\(\s*)?(["'])(.*?)\1/gi)) {
    references.push({ value: match[2], reason: "css-import" });
  }
  return references;
}

function addReason(reasonMap, path, reason) {
  const reasons = reasonMap.get(path) ?? new Set();
  reasons.add(reason);
  reasonMap.set(path, reasons);
}

function identityCore({ entry, files }) {
  return {
    kind: PROJECT_IDENTITY_KIND,
    schemaVersion: PROJECT_IDENTITY_SCHEMA_VERSION,
    algorithm: PROJECT_IDENTITY_ALGORITHM,
    entry,
    files,
  };
}

export async function buildWholeProjectIdentityManifest({
  projectRoot: rawProjectRoot,
  entry: rawEntry = "index.html",
  include = [],
} = {}) {
  if (typeof rawProjectRoot !== "string" || !rawProjectRoot) throw new Error("projectRoot is required");
  const projectRoot = realpathSync(resolve(rawProjectRoot));
  const entryPath = resolveProjectPath(projectRoot, rawEntry, "entry");
  if (!existsSync(entryPath) || !statSync(entryPath).isFile()) throw new Error(`entry is not a file: ${entryPath}`);
  const entry = assertInsideProject(projectRoot, entryPath, "entry");
  const reasonMap = new Map();
  addReason(reasonMap, entryPath, "entry");

  const required = ["shared", ".media/manifest.jsonl", ...include];
  for (const value of required) {
    const absolute = resolveProjectPath(projectRoot, value, "identity include");
    for (const file of enumerateFiles(absolute, projectRoot)) addReason(reasonMap, file, `include:${portablePath(String(value))}`);
  }

  const pending = [entryPath, ...reasonMap.keys()];
  const scanned = new Set();
  while (pending.length) {
    const sourcePath = pending.shift();
    if (scanned.has(sourcePath)) continue;
    scanned.add(sourcePath);
    for (const reference of referencesInText(sourcePath)) {
      const normalized = normalizeReference(reference.value);
      if (!normalized) continue;
      const target = normalized.startsWith("/")
        ? resolveProjectPath(projectRoot, normalized.slice(1), "root-relative dependency")
        : resolve(dirname(sourcePath), normalized);
      assertInsideProject(projectRoot, target, "discovered dependency");
      if (!existsSync(target)) throw new Error(`discovered dependency is missing: ${portablePath(relative(projectRoot, target))} from ${portablePath(relative(projectRoot, sourcePath))}`);
      for (const file of enumerateFiles(target, projectRoot)) {
        addReason(reasonMap, file, `${reference.reason}:${portablePath(relative(projectRoot, sourcePath))}`);
        if (!scanned.has(file)) pending.push(file);
      }
    }
  }

  const files = [];
  for (const path of [...reasonMap.keys()].sort((left, right) => portablePath(relative(projectRoot, left)).localeCompare(portablePath(relative(projectRoot, right))))) {
    const info = statSync(path);
    files.push({
      path: portablePath(relative(projectRoot, path)),
      sizeBytes: info.size,
      sha256: `sha256:${await digestFile(path)}`,
      reasons: [...reasonMap.get(path)].sort(),
    });
  }
  const core = identityCore({ entry, files });
  return {
    ...core,
    projectIdentity: `sha256:${sha256(canonicalJson(core))}`,
    projectRoot,
    generatedAt: new Date().toISOString(),
  };
}

export async function verifyWholeProjectIdentityManifest({ manifest, projectRoot: rawProjectRoot } = {}) {
  const fail = (reason, details = null) => ({ valid: false, reason, details, projectIdentity: null });
  if (!manifest || typeof manifest !== "object") return fail("project-identity-manifest-missing");
  if (manifest.kind !== PROJECT_IDENTITY_KIND || manifest.schemaVersion !== PROJECT_IDENTITY_SCHEMA_VERSION) {
    return fail("project-identity-manifest-schema-mismatch");
  }
  if (canonicalJson(manifest.algorithm) !== canonicalJson(PROJECT_IDENTITY_ALGORITHM)) {
    return fail("project-identity-algorithm-mismatch");
  }
  if (!SHA256_PATTERN.test(manifest.projectIdentity ?? "")) return fail("project-identity-digest-invalid");
  if (!Array.isArray(manifest.files) || manifest.files.length === 0) return fail("project-identity-files-missing");
  let projectRoot;
  try {
    projectRoot = realpathSync(resolve(rawProjectRoot));
  } catch (error) {
    return fail("project-root-unavailable", String(error.message ?? error));
  }
  const normalizedFiles = [];
  const seen = new Set();
  try {
    for (const item of manifest.files) {
      if (!item || typeof item.path !== "string" || !Number.isSafeInteger(item.sizeBytes) || item.sizeBytes < 0
          || !SHA256_PATTERN.test(item.sha256 ?? "") || !Array.isArray(item.reasons) || item.reasons.length === 0) {
        return fail("project-identity-file-record-invalid", item?.path ?? null);
      }
      const absolute = resolveProjectPath(projectRoot, item.path, "manifest file");
      if (seen.has(absolute)) return fail("project-identity-file-duplicate", item.path);
      seen.add(absolute);
      const info = lstatSync(absolute);
      if (info.isSymbolicLink() || !info.isFile()) return fail("project-identity-file-type-mismatch", item.path);
      if (info.size !== item.sizeBytes) return fail("project-identity-file-size-mismatch", item.path);
      const observed = `sha256:${await digestFile(absolute)}`;
      if (observed !== item.sha256) return fail("project-identity-file-digest-mismatch", item.path);
      normalizedFiles.push({
        path: portablePath(relative(projectRoot, absolute)),
        sizeBytes: item.sizeBytes,
        sha256: item.sha256,
        reasons: [...item.reasons].map(String).sort(),
      });
    }
  } catch (error) {
    return fail("project-identity-file-unavailable", String(error.message ?? error));
  }
  normalizedFiles.sort((left, right) => left.path.localeCompare(right.path));
  if (canonicalJson(normalizedFiles) !== canonicalJson(manifest.files)) return fail("project-identity-file-order-or-normalization-mismatch");
  const core = identityCore({ entry: manifest.entry, files: normalizedFiles });
  const projectIdentity = `sha256:${sha256(canonicalJson(core))}`;
  if (projectIdentity !== manifest.projectIdentity) return fail("project-identity-aggregate-mismatch");
  return {
    valid: true,
    reason: null,
    projectIdentity,
    algorithm: PROJECT_IDENTITY_ALGORITHM.name,
    fileCount: normalizedFiles.length,
    totalBytes: normalizedFiles.reduce((total, item) => total + item.sizeBytes, 0),
  };
}
