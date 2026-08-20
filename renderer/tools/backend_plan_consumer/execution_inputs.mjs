import { createHash } from "node:crypto";
import {
  chmodSync,
  constants,
  copyFileSync,
  createReadStream,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readlinkSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
} from "node:fs";
import { builtinModules } from "node:module";
import {
  basename,
  dirname,
  extname,
  isAbsolute,
  relative,
  resolve,
  sep,
} from "node:path";
import { canonicalJson, sha256 } from "../frame_backend_preflight/lib.mjs";
import { verifyWholeProjectIdentityManifest } from "../frame_backend_preflight/project_identity.mjs";

export const EXECUTION_INPUTS_KIND = "hyperframes-segment-execution-inputs";
export const EXECUTION_INPUTS_SCHEMA_VERSION = 2;

const SHA256_PATTERN = /^sha256:[a-f0-9]{64}$/;
const { COPYFILE_EXCL, COPYFILE_FICLONE_FORCE } = constants;
const BUILTINS = new Set(["electron", ...builtinModules, ...builtinModules.map((name) => `node:${name}`)]);
const COPY_FALLBACK_CODES = new Set(["ENOSYS", "ENOTSUP", "EOPNOTSUPP", "EXDEV", "EINVAL"]);
const SOURCE_EXTENSIONS = ["", ".mjs", ".js", ".cjs", ".json"];
export const INHERITED_ENVIRONMENT_ALLOWLIST = Object.freeze([
  "DBUS_SESSION_BUS_ADDRESS",
  "DISPLAY",
  "DYLD_LIBRARY_PATH",
  "ELECTRON_ENABLE_LOGGING",
  "ELECTRON_OZONE_PLATFORM_HINT",
  "HOME",
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
  "LD_LIBRARY_PATH",
  "LIBVA_DRIVER_NAME",
  "LIBVA_DRIVERS_PATH",
  "LOGNAME",
  "MESA_LOADER_DRIVER_OVERRIDE",
  "PATH",
  "PIPEWIRE_REMOTE",
  "PULSE_SERVER",
  "SHELL",
  "TEMP",
  "TMP",
  "TMPDIR",
  "TZ",
  "USER",
  "VDPAU_DRIVER",
  "WAYLAND_DISPLAY",
  "XDG_RUNTIME_DIR",
  "XDG_SESSION_TYPE",
  "__GLX_VENDOR_LIBRARY_NAME",
  "__CF_USER_TEXT_ENCODING",
].sort());

function portablePath(value) {
  return value.split(sep).join("/");
}

function normalizeRecord(record = {}) {
  return Object.fromEntries(Object.entries(record).sort(([left], [right]) => left.localeCompare(right)));
}

function buildEnvironmentContract(explicitEnvironment = {}) {
  const explicit = normalizeRecord(Object.fromEntries(
    Object.entries(explicitEnvironment).map(([key, value]) => [String(key), String(value)]),
  ));
  const inherited = {};
  for (const key of INHERITED_ENVIRONMENT_ALLOWLIST) {
    if (Object.prototype.hasOwnProperty.call(explicit, key)) continue;
    if (process.env[key] != null) inherited[key] = String(process.env[key]);
  }
  const values = normalizeRecord({ ...inherited, ...explicit });
  return {
    mode: "signed-explicit-plus-whitelisted-inheritance",
    inheritedAllowlist: [...INHERITED_ENVIRONMENT_ALLOWLIST],
    explicit,
    inherited: normalizeRecord(inherited),
    values,
    valuesSha256: `sha256:${sha256(JSON.stringify(values))}`,
  };
}

function digestFile(path) {
  return new Promise((resolveDigest, rejectDigest) => {
    const hash = createHash("sha256");
    const input = createReadStream(path);
    input.on("data", (chunk) => hash.update(chunk));
    input.once("error", rejectDigest);
    input.once("end", () => resolveDigest(`sha256:${hash.digest("hex")}`));
  });
}

function requireRegularFile(path, label, { followSymlink = false } = {}) {
  const requested = resolve(path);
  if (!existsSync(requested)) throw new Error(`${label} is missing: ${requested}`);
  const linkInfo = lstatSync(requested);
  if (linkInfo.isSymbolicLink() && !followSymlink) throw new Error(`${label} may not be a symlink: ${requested}`);
  const resolvedPath = followSymlink ? realpathSync(requested) : requested;
  const info = statSync(resolvedPath);
  if (!info.isFile()) throw new Error(`${label} is not a regular file: ${resolvedPath}`);
  return { requestedPath: requested, resolvedPath, sizeBytes: info.size };
}

async function fileIdentity(path, label, options = {}) {
  const record = requireRegularFile(path, label, options);
  return { ...record, sha256: await digestFile(record.resolvedPath) };
}

function insideRelative(projectRoot, path, label) {
  const absolute = realpathSync(resolve(path));
  const rel = relative(projectRoot, absolute);
  if (!rel || rel === ".") throw new Error(`${label} must be a file inside projectRoot`);
  if (rel.startsWith("..") || isAbsolute(rel)) throw new Error(`${label} escapes projectRoot: ${absolute}`);
  return portablePath(rel);
}

function manifestRecord(manifest, relativePath, label) {
  const record = manifest.files.find((item) => item.path === relativePath);
  if (!record) throw new Error(`${label} is not covered by the whole-project manifest: ${relativePath}`);
  return {
    path: record.path,
    sizeBytes: record.sizeBytes,
    sha256: record.sha256,
  };
}

function executableSearchPath(command, environment) {
  if (command.includes("/")) return resolve(command);
  const pathValue = environment.PATH ?? "";
  for (const directory of pathValue.split(":").filter(Boolean)) {
    const candidate = resolve(directory, command);
    if (existsSync(candidate) && statSync(candidate).isFile()) return candidate;
  }
  throw new Error(`executable is not available on PATH: ${command}`);
}

async function executableIdentity(command, environment, label) {
  const requested = String(command);
  const searchedPath = executableSearchPath(requested, environment);
  const identity = await fileIdentity(searchedPath, label, { followSymlink: true });
  return {
    requested,
    searchedPath,
    resolvedPath: identity.resolvedPath,
    sizeBytes: identity.sizeBytes,
    sha256: identity.sha256,
  };
}

function sourceSpecifiers(source) {
  const result = new Set();
  const staticPattern = /^\s*(?:import|export)\s+(?:[^;]*?\sfrom\s*)?["']([^"']+)["']/gm;
  const dynamicPattern = /\bimport\(\s*["']([^"']+)["']\s*\)/g;
  for (const match of source.matchAll(staticPattern)) result.add(match[1]);
  for (const match of source.matchAll(dynamicPattern)) result.add(match[1]);
  return [...result].sort();
}

function literalSiblingDependencies(source, sourcePath) {
  const result = [];
  const pattern = /resolve\(\s*rendererRoot\s*,\s*["']([^"']+)["']\s*\)/g;
  for (const match of source.matchAll(pattern)) {
    const path = resolve(dirname(sourcePath), match[1]);
    if (existsSync(path) && statSync(path).isFile() && new Set([".mjs", ".js", ".cjs", ".json"]).has(extname(path))) {
      result.push(path);
    }
  }
  return result;
}

function resolveLocalModule(sourcePath, specifier) {
  const base = specifier.startsWith("/") ? specifier : resolve(dirname(sourcePath), specifier);
  for (const extension of SOURCE_EXTENSIONS) {
    const candidate = `${base}${extension}`;
    if (existsSync(candidate) && statSync(candidate).isFile()) return resolve(candidate);
  }
  for (const extension of [".mjs", ".js", ".cjs", ".json"]) {
    const candidate = resolve(base, `index${extension}`);
    if (existsSync(candidate) && statSync(candidate).isFile()) return candidate;
  }
  throw new Error(`static toolchain import is missing: ${specifier} from ${sourcePath}`);
}

function packageName(specifier) {
  if (specifier.startsWith("@")) return specifier.split("/").slice(0, 2).join("/");
  return specifier.split("/", 1)[0];
}

function locatePackageRoot(name, startPath) {
  let cursor = dirname(startPath);
  while (true) {
    const candidate = resolve(cursor, "node_modules", name);
    if (existsSync(resolve(candidate, "package.json"))) return realpathSync(candidate);
    const parent = dirname(cursor);
    if (parent === cursor) break;
    cursor = parent;
  }
  throw new Error(`toolchain package is unavailable: ${name} imported from ${startPath}`);
}

function enumeratePackageFiles(root, path = root) {
  const result = [];
  for (const name of readdirSync(path).sort()) {
    if (name === ".DS_Store" || name === "node_modules") continue;
    const child = resolve(path, name);
    const info = lstatSync(child);
    if (info.isSymbolicLink()) {
      throw new Error(`toolchain package contains a symlink: ${portablePath(relative(root, child))}`);
    }
    if (info.isDirectory()) result.push(...enumeratePackageFiles(root, child));
    else if (info.isFile()) result.push(child);
  }
  return result;
}

async function packageIdentity(name, root) {
  const files = [];
  for (const path of enumeratePackageFiles(root)) {
    const info = statSync(path);
    files.push({
      path: portablePath(relative(root, path)),
      sizeBytes: info.size,
      sha256: await digestFile(path),
    });
  }
  const aggregate = { name, files };
  return {
    name,
    rootPath: root,
    packageJsonSha256: (await digestFile(resolve(root, "package.json"))),
    fileCount: files.length,
    totalBytes: files.reduce((sum, item) => sum + item.sizeBytes, 0),
    aggregateSha256: `sha256:${sha256(aggregate)}`,
  };
}

async function collectMainToolchain(mainScript) {
  const pending = [resolve(mainScript)];
  const sources = new Map();
  const bareImports = new Map();
  while (pending.length) {
    const path = pending.shift();
    if (sources.has(path)) continue;
    const file = requireRegularFile(path, "main toolchain source");
    const source = readFileSync(file.resolvedPath, "utf8");
    sources.set(path, source);
    for (const specifier of sourceSpecifiers(source)) {
      if (BUILTINS.has(specifier) || specifier.startsWith("node:")) continue;
      if (specifier.startsWith(".") || specifier.startsWith("/")) {
        pending.push(resolveLocalModule(path, specifier));
      } else {
        const name = packageName(specifier);
        if (!bareImports.has(name)) bareImports.set(name, path);
      }
    }
    for (const sibling of literalSiblingDependencies(source, path)) pending.push(sibling);
  }
  const files = [];
  for (const path of [...sources.keys()].sort()) {
    const info = statSync(path);
    files.push({
      path,
      sizeBytes: info.size,
      sha256: await digestFile(path),
      role: path === resolve(mainScript) ? "main-script" : "static-or-literal-runtime-dependency",
    });
  }
  const packages = [];
  const queuedPackages = [...bareImports.entries()];
  const seenPackages = new Set();
  while (queuedPackages.length) {
    const [name, importer] = queuedPackages.shift();
    if (seenPackages.has(name)) continue;
    const root = locatePackageRoot(name, importer);
    seenPackages.add(name);
    packages.push(await packageIdentity(name, root));
    const packageJson = JSON.parse(readFileSync(resolve(root, "package.json"), "utf8"));
    const dependencies = {
      ...(packageJson.dependencies ?? {}),
      ...(packageJson.optionalDependencies ?? {}),
    };
    for (const dependency of Object.keys(dependencies).sort()) queuedPackages.push([dependency, resolve(root, "package.json")]);
  }
  packages.sort((left, right) => left.name.localeCompare(right.name));
  return { files, packages };
}

function enumerateRuntimeFiles(root, cursor = root) {
  const result = [];
  for (const name of readdirSync(cursor).sort()) {
    const path = resolve(cursor, name);
    const info = lstatSync(path);
    if (info.isSymbolicLink()) {
      const target = readlinkSync(path);
      const targetPath = resolve(dirname(path), target);
      const targetRelative = relative(root, targetPath);
      if (isAbsolute(target) || targetRelative.startsWith("..") || isAbsolute(targetRelative)) {
        throw new Error(`Electron runtime bundle symlink escapes the bound root: ${path} -> ${target}`);
      }
      result.push({ path, kind: "symlink", target });
    } else if (info.isDirectory()) result.push(...enumerateRuntimeFiles(root, path));
    else if (info.isFile()) result.push({ path, kind: "file" });
  }
  return result;
}

function electronRuntimeRoot(runtimePath) {
  const resolvedPath = resolve(runtimePath);
  const parts = resolvedPath.split(sep);
  const contentsIndex = parts.findIndex((part, index) => (
    part === "Contents" && index > 0 && parts[index - 1].endsWith(".app")
  ));
  if (contentsIndex >= 0) {
    const prefix = resolvedPath.startsWith(sep) ? sep : "";
    return {
      rootPath: `${prefix}${parts.slice(resolvedPath.startsWith(sep) ? 1 : 0, contentsIndex + 1).join(sep)}`,
      layout: "macos-app-contents",
    };
  }
  return { rootPath: dirname(resolvedPath), layout: "distribution-root" };
}

async function electronRuntimeBundle(runtimeIdentity) {
  const { rootPath, layout } = electronRuntimeRoot(runtimeIdentity.resolvedPath);
  if (layout !== "macos-app-contents"
      && !basename(runtimeIdentity.resolvedPath).toLowerCase().includes("electron")) return null;
  const files = [];
  for (const record of enumerateRuntimeFiles(rootPath)) {
    if (record.kind === "symlink") {
      files.push({
        path: portablePath(relative(rootPath, record.path)),
        kind: "symlink",
        target: record.target,
      });
    } else {
      const info = statSync(record.path);
      files.push({
        path: portablePath(relative(rootPath, record.path)),
        kind: "file",
        sizeBytes: info.size,
        sha256: await digestFile(record.path),
      });
    }
  }
  return {
    rootPath,
    layout,
    fileCount: files.length,
    regularFileCount: files.filter((item) => item.kind === "file").length,
    symlinkCount: files.filter((item) => item.kind === "symlink").length,
    totalBytes: files.reduce((sum, item) => sum + (item.sizeBytes ?? 0), 0),
    aggregateSha256: `sha256:${sha256(files)}`,
  };
}

function expectedRendererIdentity(entryRecord, timingPath) {
  let bundle = null;
  try {
    bundle = JSON.parse(readFileSync(timingPath, "utf8"));
  } catch {
    // The renderer will reject malformed production bundles. Keeping a null
    // asset identity still lets small executor fixtures exercise the contract.
  }
  const entryHex = entryRecord.sha256.slice("sha256:".length);
  const bundleEntryHex = bundle?.project?.entryFingerprint?.sha256;
  if (typeof bundleEntryHex === "string" && bundleEntryHex !== entryHex) {
    throw new Error("media timing bundle entry fingerprint does not match the signed entry");
  }
  const assets = Array.isArray(bundle?.entries)
    ? createHash("sha256").update(JSON.stringify(bundle.entries.map((item) => ({
      source: item.source,
      sourceIdentity: item.plan?.source?.identity,
      roles: item.roles,
      mapsFrom: item.mapsFrom,
    })).sort((left, right) => String(left.source).localeCompare(String(right.source))))).digest("hex")
    : null;
  return {
    entry: entryHex,
    timingBundle: createHash("sha256").update(readFileSync(timingPath)).digest("hex"),
    assets,
  };
}

export function verifyExecutionInputsDescriptor(descriptor) {
  const fail = (reason) => ({ valid: false, reason });
  if (descriptor?.kind !== EXECUTION_INPUTS_KIND || descriptor?.schemaVersion !== EXECUTION_INPUTS_SCHEMA_VERSION) {
    return fail("execution-inputs-schema-mismatch");
  }
  const { inputsIdentity, ...core } = descriptor;
  if (!SHA256_PATTERN.test(inputsIdentity ?? "")) return fail("execution-inputs-identity-missing");
  if (inputsIdentity !== `sha256:${sha256(core)}`) return fail("execution-inputs-identity-mismatch");
  if (!SHA256_PATTERN.test(descriptor.projectIdentity ?? "")) return fail("execution-inputs-project-identity-invalid");
  if (!descriptor.project?.entry?.path || !descriptor.project?.mediaTimingPlan?.path) {
    return fail("execution-inputs-project-files-missing");
  }
  if (!descriptor.tools?.mainScript || !descriptor.tools?.runtimeCommand
      || !descriptor.tools?.ffmpeg || !descriptor.tools?.ffprobe) {
    return fail("execution-inputs-tools-missing");
  }
  if (!Array.isArray(descriptor.runtimePrefixArgs) || !descriptor.commonRenderArgs
      || !descriptor.environment || typeof descriptor.cwd !== "string") {
    return fail("execution-inputs-context-missing");
  }
  const environmentContract = descriptor.environmentContract;
  if (environmentContract?.mode !== "signed-explicit-plus-whitelisted-inheritance"
      || canonicalJson(environmentContract.inheritedAllowlist) !== canonicalJson(INHERITED_ENVIRONMENT_ALLOWLIST)
      || !environmentContract.explicit || !environmentContract.inherited || !environmentContract.values
      || environmentContract.valuesSha256 !== `sha256:${sha256(JSON.stringify(normalizeRecord(environmentContract.values)))}`
      || canonicalJson(environmentContract.values) !== canonicalJson({
        ...environmentContract.inherited,
        ...environmentContract.explicit,
      })
      || canonicalJson(descriptor.environment) !== canonicalJson(environmentContract.explicit)) {
    return fail("execution-inputs-environment-contract-invalid");
  }
  return { valid: true, reason: null, inputsIdentity };
}

export async function buildExecutionInputs({
  renderContext: context,
  projectManifest: manifest,
  projectManifestVerification = null,
} = {}) {
  if (!context || typeof context !== "object") throw new Error("normalized renderContext is required");
  if (!manifest || !Array.isArray(manifest.files)) throw new Error("whole-project manifest is required");
  const projectRoot = realpathSync(resolve(context.projectRoot));
  const verified = projectManifestVerification
    ?? await verifyWholeProjectIdentityManifest({ manifest, projectRoot });
  if (verified.valid !== true) throw new Error(`project identity verification failed: ${verified.reason}`);
  const entryRelative = insideRelative(projectRoot, context.entry, "entry");
  const timingRelative = insideRelative(projectRoot, context.mediaTimingPlan, "mediaTimingPlan");
  if (manifest.entry !== entryRelative) throw new Error("renderContext.entry does not match manifest.entry");
  const entryRecord = manifestRecord(manifest, entryRelative, "entry");
  const timingRecord = manifestRecord(manifest, timingRelative, "mediaTimingPlan");
  const projectFile = (path, label) => {
    if (!path) return null;
    const relativePath = insideRelative(projectRoot, path, label);
    return manifestRecord(manifest, relativePath, label);
  };
  const environmentContract = buildEnvironmentContract(context.environment ?? {});
  const environment = environmentContract.explicit;
  const effectiveEnvironment = environmentContract.values;
  const mainScript = await fileIdentity(context.mainScript, "mainScript");
  const runtimeCommand = await executableIdentity(context.runtimeCommand, effectiveEnvironment, "runtimeCommand");
  const ffmpeg = await executableIdentity(context.ffmpeg, effectiveEnvironment, "ffmpeg");
  const ffprobe = await executableIdentity(context.ffprobe, effectiveEnvironment, "ffprobe");
  const mainToolchain = await collectMainToolchain(context.mainScript);
  const runtimeBundle = await electronRuntimeBundle(runtimeCommand);
  const core = {
    kind: EXECUTION_INPUTS_KIND,
    schemaVersion: EXECUTION_INPUTS_SCHEMA_VERSION,
    projectIdentity: verified.projectIdentity,
    project: {
      entry: entryRecord,
      mediaTimingPlan: timingRecord,
      mediaSourceMap: projectFile(context.mediaSourceMap, "mediaSourceMap"),
      canonicalMediaRoute: projectFile(context.canonicalMediaRoute, "canonicalMediaRoute"),
      audioReference: projectFile(context.audioReference, "audioReference"),
    },
    expectedRendererIdentity: expectedRendererIdentity(entryRecord, context.mediaTimingPlan),
    tools: {
      mainScript,
      runtimeCommand,
      runtimeBundle,
      ffmpeg,
      ffprobe,
      mainToolchain,
    },
    runtimePrefixArgs: [...(context.runtimePrefixArgs ?? [])].map(String),
    commonRenderArgs: normalizeRecord(context.commonRenderArgs ?? {}),
    mixProjectAudio: context.mixProjectAudio === true,
    environment,
    environmentContract,
    cwd: resolve(context.cwd),
  };
  return { ...core, inputsIdentity: `sha256:${sha256(core)}` };
}

export async function verifyExecutionInputs({
  descriptor,
  renderContext,
  projectManifest,
  projectManifestVerification,
} = {}) {
  const shape = verifyExecutionInputsDescriptor(descriptor);
  if (!shape.valid) return shape;
  let observed;
  try {
    observed = await buildExecutionInputs({
      renderContext,
      projectManifest,
      projectManifestVerification,
    });
  } catch (error) {
    return { valid: false, reason: `execution-inputs-rebuild-failed:${error.message}` };
  }
  if (canonicalJson(observed) !== canonicalJson(descriptor)) {
    const fields = [
      "project", "expectedRendererIdentity", "tools", "runtimePrefixArgs",
      "commonRenderArgs", "mixProjectAudio", "environment", "environmentContract", "cwd",
    ];
    const changed = fields.filter((field) => canonicalJson(observed[field]) !== canonicalJson(descriptor[field]));
    return { valid: false, reason: `execution-inputs-context-mismatch:${changed.join(",") || "unknown"}`, observed };
  }
  return { valid: true, reason: null, inputsIdentity: descriptor.inputsIdentity };
}

function copySnapshotFile(source, destination) {
  mkdirSync(dirname(destination), { recursive: true });
  try {
    copyFileSync(source, destination, COPYFILE_FICLONE_FORCE | COPYFILE_EXCL);
    return "reflink";
  } catch (error) {
    if (!COPY_FALLBACK_CODES.has(error?.code)) throw error;
    rmSync(destination, { force: true });
    copyFileSync(source, destination, COPYFILE_EXCL);
    return "copy-file-range-or-copy";
  }
}

function makeSnapshotReadOnly(root, manifest) {
  const directories = new Set([root]);
  for (const item of manifest.files) {
    const path = resolve(root, item.path);
    chmodSync(path, 0o444);
    let cursor = dirname(path);
    while (cursor.startsWith(`${root}${sep}`)) {
      directories.add(cursor);
      cursor = dirname(cursor);
    }
  }
  for (const path of [...directories].sort((left, right) => right.length - left.length)) chmodSync(path, 0o555);
}

export async function materializeProjectSnapshot({
  manifest,
  sourceProjectRoot: rawSourceRoot,
  snapshotRoot: rawSnapshotRoot,
} = {}) {
  const sourceProjectRoot = realpathSync(resolve(rawSourceRoot));
  const snapshotRoot = resolve(rawSnapshotRoot);
  const snapshotRelative = relative(sourceProjectRoot, snapshotRoot);
  if (!snapshotRelative.startsWith("..") && !isAbsolute(snapshotRelative)) {
    throw new Error("input snapshot must be outside the source project root");
  }
  if (existsSync(snapshotRoot)) throw new Error(`input snapshot already exists: ${snapshotRoot}`);
  mkdirSync(snapshotRoot, { recursive: false });
  const copyModes = { reflink: 0, "copy-file-range-or-copy": 0 };
  try {
    for (const item of manifest.files) {
      const source = resolve(sourceProjectRoot, item.path);
      const sourceRelative = portablePath(relative(sourceProjectRoot, source));
      if (sourceRelative !== item.path || sourceRelative.startsWith("..")) {
        throw new Error(`snapshot manifest path is not normalized: ${item.path}`);
      }
      const destination = resolve(snapshotRoot, item.path);
      const mode = copySnapshotFile(source, destination);
      copyModes[mode] += 1;
    }
    const verification = await verifyWholeProjectIdentityManifest({ manifest, projectRoot: snapshotRoot });
    if (!verification.valid) throw new Error(`input snapshot verification failed: ${verification.reason}`);
    makeSnapshotReadOnly(snapshotRoot, manifest);
    return {
      kind: "hyperframes-project-input-snapshot",
      schemaVersion: 1,
      path: snapshotRoot,
      projectIdentity: verification.projectIdentity,
      fileCount: verification.fileCount,
      totalBytes: verification.totalBytes,
      copyModes,
      permissions: "manifest-files-0444-directories-0555",
      verified: true,
    };
  } catch (error) {
    throw new Error(`project snapshot materialization failed: ${error.message}`);
  }
}

export function redirectContextToProjectSnapshot({ context, descriptor, snapshotRoot } = {}) {
  const redirect = (record, current) => record ? resolve(snapshotRoot, record.path) : current;
  return {
    ...context,
    projectRoot: resolve(snapshotRoot),
    entry: redirect(descriptor.project.entry, context.entry),
    mediaTimingPlan: redirect(descriptor.project.mediaTimingPlan, context.mediaTimingPlan),
    mediaSourceMap: redirect(descriptor.project.mediaSourceMap, context.mediaSourceMap),
    canonicalMediaRoute: redirect(descriptor.project.canonicalMediaRoute, context.canonicalMediaRoute),
    audioReference: redirect(descriptor.project.audioReference, context.audioReference),
  };
}
