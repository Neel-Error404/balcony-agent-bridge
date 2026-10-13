#!/usr/bin/env node
// Offline, exact-revision, Windows x64 runtime bundle. The receipt is deliberately
// outside the archive: neither the archive nor the manifest hashes itself.
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SCHEMA = "river-runtime-bundle.v1";
const RECEIPT_SCHEMA = "river-runtime-receipt.v1";
const MAGIC = Buffer.from("RIVERB1\n", "ascii");
const COPY_SIZE = 1024 * 1024;
const SCRIPT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const REQUIRED = [
  "LICENSE", "package.json", "package-lock.json",
  "dist/bridge/index.js", "dist/dispatcher/index.js", "dist/mcp/index.js",
  "service/balcony-agent-bridge.xml.template",
  "service/balcony-agent-dispatcher.xml.template",
  "scripts/runtime-bundle.mjs",
  "runtime/node.exe", "runtime/codex.exe", "runtime/codex-code-mode-host.exe",
];
const SECRET_COMPONENT = /^(?:\.git|\.ssh|\.npmrc|\.env(?:\..*)?|auth\.json|credentials(?:\.(?:json|toml|ini|ya?ml))?|config\.toml|settings\.json|id_(?:rsa|ed25519)|.*\.(?:pfx|p12|key|pem|sqlite3?|db|log|bak))$/i;
const SECRET_DIRECTORY = /^(?:\.git|\.ssh|\.env(?:\..*)?)$/i;
const WINDOWS_DEVICE = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i;

try {
  const [command, ...args] = process.argv.slice(2);
  const options = parseOptions(args);
  let result;
  switch (command) {
    case "plan": result = plan(options); break;
    case "build": result = build(options); break;
    case "verify": result = verifyCommand(options); break;
    case "archive": result = archiveCommand(options); break;
    case "extract": result = extractCommand(options); break;
    default: throw new Error("Expected plan, build, verify, archive, or extract");
  }
  process.stdout.write(`${JSON.stringify(result)}\n`);
} catch (error) {
  process.stderr.write(`Runtime bundle error: ${error.message}\n`);
  process.exitCode = 1;
}

function parseOptions(args) {
  const allowed = new Set(["root", "revision", "node", "output", "bundle", "archive", "receipt", "sha256"]);
  const options = {};
  for (let i = 0; i < args.length; i += 2) {
    const flag = args[i];
    if (!flag?.startsWith("--") || !allowed.has(flag.slice(2)) || !args[i + 1] || args[i + 1].startsWith("--")) {
      throw new Error(`Invalid or missing option: ${flag ?? "<none>"}`);
    }
    const key = flag.slice(2);
    if (key in options) throw new Error(`Duplicate option: ${flag}`);
    options[key] = args[i + 1];
  }
  return options;
}

function requireOption(options, name) {
  if (!options[name]) throw new Error(`--${name} is required`);
  return path.resolve(options[name]);
}

function expectedRevision(value) {
  if (!/^[a-f0-9]{40}$/.test(value ?? "")) throw new Error("--revision must be a 40-character lowercase Git SHA");
  return value;
}

function git(root, args) {
  const result = spawnSync("git", ["-C", root, ...args], { encoding: "utf8", windowsHide: true, maxBuffer: 16 * 1024 * 1024 });
  if (result.error || result.status !== 0) throw new Error(`Git ${args[0]} failed: ${result.error?.message ?? result.stderr.trim()}`);
  return result.stdout.trim();
}

function cleanCommit(root, revision) {
  const realRoot = requireDirectory(root);
  if (path.resolve(git(realRoot, ["rev-parse", "--show-toplevel"])).toLowerCase() !== realRoot.toLowerCase()) {
    throw new Error("Git root must be the exact checkout root");
  }
  const head = git(realRoot, ["rev-parse", "HEAD"]);
  if (head !== expectedRevision(revision)) throw new Error("Git HEAD differs from the approved revision");
  if (git(realRoot, ["status", "--porcelain=v1", "--untracked-files=all"])) {
    throw new Error("Git checkout must be clean, including untracked files");
  }
  const tree = git(realRoot, ["rev-parse", "HEAD^{tree}"]);
  if (!/^[a-f0-9]{40}$/.test(tree)) throw new Error("Git tree is invalid");
  return { root: realRoot, revision: head, tree };
}

function plan(options) {
  const source = cleanCommit(path.resolve(options.root ?? SCRIPT_ROOT), options.revision);
  const node = requireNode(options.node);
  const tracked = trackedPaths(source.root);
  const dependencies = productionPackages(source.root);
  return {
    source_revision: source.revision, source_tree: source.tree,
    platform: "win32", architecture: "x64", node_version: "22.14.0",
    codex_version: "0.150.1", node_executable: node,
    tracked_runtime_inputs: tracked.filter(isRuntimeInput),
    production_package_count: dependencies.length,
    output: options.output ? path.resolve(options.output) : null,
  };
}

function build(options) {
  const root = path.resolve(options.root ?? SCRIPT_ROOT);
  const source = cleanCommit(root, options.revision);
  const node = requireNode(options.node);
  const output = requireOption(options, "output");
  if (isWithin(output, root) || isWithin(root, output)) throw new Error("Output must be outside the Git checkout");
  requireNonexistent(output);
  const tracked = trackedPaths(root);
  const inputs = tracked.filter(isRuntimeInput);
  for (const required of REQUIRED.filter((entry) => !entry.startsWith("dist/") && !entry.startsWith("runtime/"))) {
    if (!inputs.includes(required)) throw new Error(`Required runtime input is not Git-tracked: ${required}`);
  }
  const dependencies = productionPackages(root);
  const codexNative = path.join(root, "node_modules", "@openai", "codex-win32-x64", "vendor", "x86_64-pc-windows-msvc", "bin");
  const binaries = [
    [node, "runtime/node.exe"],
    [path.join(codexNative, "codex.exe"), "runtime/codex.exe"],
    [path.join(codexNative, "codex-code-mode-host.exe"), "runtime/codex-code-mode-host.exe"],
  ];
  for (const [sourceFile] of binaries) requireFile(sourceFile);
  const codexVersion = spawnSync(binaries[1][0], ["--version"], {
    encoding: "utf8", windowsHide: true, timeout: 10_000,
  });
  if (codexVersion.error || codexVersion.status !== 0 ||
    codexVersion.stdout.trim() !== "codex-cli 0.150.1") {
    throw new Error("Codex executable must report pinned version 0.150.1");
  }
  const npm = process.env.npm_execpath;
  if (!npm || !path.isAbsolute(npm)) throw new Error("npm_execpath is required; run build through npm exec or npm run");
  const buildResult = spawnSync(node, [npm, "run", "build"], { cwd: root, encoding: "utf8", windowsHide: true, maxBuffer: 8 * 1024 * 1024 });
  if (buildResult.error || buildResult.status !== 0) throw new Error(`Production build failed: ${buildResult.error?.message ?? buildResult.stderr.trim()}`);
  cleanCommit(root, source.revision);
  const dist = listFiles(path.join(root, "dist"), "dist");
  for (const required of REQUIRED.filter((entry) => entry.startsWith("dist/"))) {
    if (!dist.includes(required)) throw new Error(`Production build missing ${required}`);
  }
  const all = new Map();
  for (const relative of inputs) all.set(relative, path.join(root, ...relative.split("/")));
  for (const relative of dist) all.set(relative, path.join(root, ...relative.split("/")));
  for (const packagePath of dependencies) {
    const full = path.join(root, ...packagePath.split("/"));
    for (const relative of listFiles(full, packagePath, true)) {
      if (all.has(relative)) throw new Error(`Duplicate runtime path: ${relative}`);
      all.set(relative, path.join(root, ...relative.split("/")));
    }
  }
  for (const [full, relative] of binaries) all.set(relative, full);
  // Create no partial output until all inputs have passed the allowlist and reparse checks.
  for (const [relative, full] of all) {
    safeRelative(relative);
    requireFile(full);
  }
  fs.mkdirSync(output);
  try {
    const files = [];
    for (const [relative, full] of [...all].sort(([a], [b]) => a.localeCompare(b, "en"))) {
      const destination = path.join(output, ...relative.split("/"));
      fs.mkdirSync(path.dirname(destination), { recursive: true });
      fs.copyFileSync(full, destination, fs.constants.COPYFILE_EXCL);
      files.push(describeFile(destination, relative));
    }
    const manifest = fixedManifest(source, files);
    fs.writeFileSync(path.join(output, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, { flag: "wx" });
    verifyDirectory(output, source.revision);
    return { bundle: output, source_revision: source.revision, source_tree: source.tree, files: files.length };
  } catch (error) {
    fs.rmSync(output, { recursive: true, force: true });
    throw error;
  }
}

function trackedPaths(root) {
  const result = spawnSync("git", ["-C", root, "ls-files", "-z", "--cached"], { windowsHide: true, maxBuffer: 16 * 1024 * 1024 });
  if (result.error || result.status !== 0) throw new Error("Git tracked-file enumeration failed");
  return result.stdout.toString("utf8").split("\0").filter(Boolean).map((value) => {
    validatePortablePath(value);
    return value;
  });
}

function isRuntimeInput(relative) {
  return relative === "LICENSE" || relative === "NOTICE" ||
    relative === "package.json" || relative === "package-lock.json" ||
    relative.startsWith("service/") && relative.endsWith(".template") ||
    relative.startsWith("scripts/") && /\.(?:ps1|psm1)$/i.test(relative) ||
    relative === "scripts/runtime-bundle.mjs";
}

function productionPackages(root) {
  const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
  const lock = JSON.parse(fs.readFileSync(path.join(root, "package-lock.json"), "utf8"));
  const closure = productionLockClosure(pkg, lock);
  for (const key of closure) {
    const local = path.join(root, ...key.split("/"));
    const installed = JSON.parse(fs.readFileSync(path.join(local, "package.json"), "utf8"));
    validateInstalledPackage(key, installed, lock.packages[key]);
    requireDirectory(local);
  }
  return closure;
}

function productionLockClosure(pkg, lock) {
  if (lock.lockfileVersion !== 3 || lock.packages?.[""]?.name !== pkg.name ||
    JSON.stringify(Object.entries(lock.packages[""].dependencies ?? {}).sort(([a], [b]) => a.localeCompare(b))) !==
    JSON.stringify(Object.entries(pkg.dependencies ?? {}).sort(([a], [b]) => a.localeCompare(b)))) {
    throw new Error("Production lockfile root does not match package.json");
  }
  if (pkg.dependencies?.["@openai/codex"] !== "0.150.1") throw new Error("Managed Codex must be pinned at 0.150.1");
  const found = new Set();
  const pending = Object.keys(pkg.dependencies ?? {}).map((name) => ["", name]);
  while (pending.length) {
    const [parent, name] = pending.pop();
    const key = resolveLockPackage(lock.packages, parent, name);
    if (!key) throw new Error(`Production dependency is absent from the lockfile: ${parent} -> ${name}`);
    if (found.has(key)) continue;
    const entry = lock.packages[key];
    if (!isCurrentPlatform(entry)) throw new Error(`Required production dependency is for another platform: ${key}`);
    found.add(key);
    for (const next of Object.keys(entry.dependencies ?? {})) pending.push([key, next]);
    for (const next of Object.keys(entry.optionalDependencies ?? {})) {
      const target = resolveLockPackage(lock.packages, key, next);
      if (target && isCurrentPlatform(lock.packages[target])) pending.push([key, next]);
    }
  }
  const native = "node_modules/@openai/codex-win32-x64";
  if (!found.has(native) || lock.packages[native].version !== "0.150.1-win32-x64") {
    throw new Error("Exact Windows x64 managed Codex native package is missing");
  }
  return [...found].sort();
}

function validateInstalledPackage(key, installed, locked) {
  const name = locked.name ?? key.slice(key.lastIndexOf("node_modules/") + "node_modules/".length);
  if (installed.name !== name || installed.version !== locked.version) {
    throw new Error(`Installed production dependency identity differs from lockfile: ${key}`);
  }
}

function resolveLockPackage(packages, parent, name) {
  let prefix = parent;
  while (true) {
    const candidate = `${prefix ? `${prefix}/` : ""}node_modules/${name}`;
    if (packages[candidate]) return candidate;
    const index = prefix.lastIndexOf("/node_modules/");
    if (index < 0) return prefix ? packages[`node_modules/${name}`] && `node_modules/${name}` : undefined;
    prefix = prefix.slice(0, index);
  }
}

function isCurrentPlatform(entry) {
  const accepts = (value, current) => !value || value.includes(current) && !value.includes(`!${current}`);
  return accepts(entry.os, "win32") && accepts(entry.cpu, "x64");
}

function requireNode(value) {
  // Version managers commonly expose node.exe through a directory junction.
  // Resolve that operator-selected input once; payload/output paths still reject links.
  const node = fs.realpathSync.native(requireOption({ node: value }, "node"));
  requireFile(node);
  if (process.platform !== "win32" || process.arch !== "x64") throw new Error("Build requires Windows x64 host");
  if (path.basename(node).toLowerCase() !== "node.exe") throw new Error("Pinned Node input must be node.exe");
  const version = spawnSync(node, ["--version"], { encoding: "utf8", windowsHide: true });
  if (version.error || version.status !== 0 || version.stdout.trim() !== "v22.14.0") {
    throw new Error("Pinned Node input must report v22.14.0");
  }
  return node;
}

function fixedManifest(source, files) {
  return {
    schema_version: SCHEMA, source_revision: source.revision, source_tree: source.tree,
    platform: "win32", architecture: "x64", node_version: "22.14.0",
    codex_version: "0.150.1", database_schema_version: 9,
    coordination_versions: ["1.0", "1.1"], files,
  };
}

function verifyCommand(options) {
  if (Boolean(options.bundle) === Boolean(options.archive)) throw new Error("Specify exactly one of --bundle or --archive");
  if (options.bundle && options.sha256) throw new Error("--sha256 is only valid with --archive");
  const revision = options.revision && expectedRevision(options.revision);
  const manifest = options.bundle
    ? verifyDirectory(requireOption(options, "bundle"), revision)
    : verifyArchive(requireOption(options, "archive"), requireOption(options, "receipt"), revision, options.sha256);
  return { verified: true, source_revision: manifest.source_revision, source_tree: manifest.source_tree, files: manifest.files.length };
}

function readManifest(bytes, revision) {
  const manifest = JSON.parse(bytes.toString("utf8"));
  if (!manifest || Object.keys(manifest).sort().join() !==
    ["schema_version", "source_revision", "source_tree", "platform", "architecture",
      "node_version", "codex_version", "database_schema_version", "coordination_versions", "files"].sort().join()) {
    throw new Error("Runtime manifest schema has missing or unexpected fields");
  }
  if (manifest.schema_version !== SCHEMA || !/^[a-f0-9]{40}$/.test(manifest.source_revision) ||
    !/^[a-f0-9]{40}$/.test(manifest.source_tree) || manifest.platform !== "win32" ||
    manifest.architecture !== "x64" || manifest.node_version !== "22.14.0" ||
    manifest.codex_version !== "0.150.1" || manifest.database_schema_version !== 9 ||
    JSON.stringify(manifest.coordination_versions) !== '["1.0","1.1"]' ||
    !Array.isArray(manifest.files) || !manifest.files.length) {
    throw new Error("Runtime manifest has an unsupported or invalid contract");
  }
  if (revision && manifest.source_revision !== revision) throw new Error("Runtime manifest revision differs from approved revision");
  const seen = new Set(["manifest.json"]);
  for (const entry of manifest.files) {
    if (!entry || Object.keys(entry).sort().join() !== "length,path,sha256" ||
      !Number.isSafeInteger(entry.length) || entry.length < 0 || !/^[a-f0-9]{64}$/.test(entry.sha256)) {
      throw new Error("Runtime manifest file metadata is invalid");
    }
    safeRelative(entry.path);
    const insensitive = entry.path.toLowerCase();
    if (seen.has(insensitive)) throw new Error(`Runtime manifest has duplicate path: ${entry.path}`);
    seen.add(insensitive);
  }
  for (const required of REQUIRED) if (!seen.has(required.toLowerCase())) throw new Error(`Runtime manifest missing required file: ${required}`);
  if (!manifest.files.some((entry) => entry.path.startsWith("node_modules/"))) {
    throw new Error("Runtime manifest missing production dependencies");
  }
  return manifest;
}

function verifyDirectory(bundle, revision) {
  requireDirectory(bundle);
  const manifestPath = path.join(bundle, "manifest.json");
  const manifest = readManifest(fs.readFileSync(requireFile(manifestPath)), revision);
  const actual = listFiles(bundle, "");
  const expected = ["manifest.json", ...manifest.files.map((entry) => entry.path)];
  const expectedSet = new Set(expected.map((entry) => entry.toLowerCase()));
  for (const file of actual) if (!expectedSet.has(file.toLowerCase())) throw new Error(`Unexpected bundle payload: ${file}`);
  const actualSet = new Set(actual.map((entry) => entry.toLowerCase()));
  for (const file of expected) if (!actualSet.has(file.toLowerCase())) throw new Error(`Missing bundle payload: ${file}`);
  for (const entry of manifest.files) {
    const full = path.join(bundle, ...entry.path.split("/"));
    const actualFile = describeFile(full, entry.path);
    if (actualFile.length !== entry.length || actualFile.sha256 !== entry.sha256) {
      throw new Error(`Bundle length or SHA256 mismatch: ${entry.path}`);
    }
  }
  validatePayloadDependencies(manifest, (relative) =>
    fs.readFileSync(path.join(bundle, ...relative.split("/"))));
  return manifest;
}

function validatePortablePath(relative, directory = false) {
  const parts = typeof relative === "string" ? relative.split("/") : [];
  if (typeof relative !== "string" || relative.length > 1024 ||
    !/^[A-Za-z0-9@._+/-]+$/.test(relative) || relative.startsWith("/") ||
    relative.includes("\\") || relative.includes("//") ||
    parts.some((part, index) => !part || part === "." || part === ".." ||
      part.endsWith(".") || WINDOWS_DEVICE.test(part) ||
      (index === parts.length - 1 && !directory ? SECRET_COMPONENT : SECRET_DIRECTORY).test(part))) {
    throw new Error(`Unsafe or secret-bearing bundle path: ${relative}`);
  }
  return relative;
}

function safeRelative(relative, directory = false) {
  validatePortablePath(relative, directory);
  if (directory) {
    if (["dist", "node_modules", "service", "scripts", "runtime"].includes(relative) ||
      ["dist/", "node_modules/", "service/", "scripts/", "runtime/"].some((prefix) => relative.startsWith(prefix))) {
      return relative;
    }
    throw new Error(`Forbidden bundle directory: ${relative}`);
  }
  if (!(relative === "manifest.json" || REQUIRED.includes(relative) ||
    relative.startsWith("dist/") || relative.startsWith("node_modules/") ||
    relative.startsWith("service/") && relative.endsWith(".template") ||
    relative.startsWith("scripts/") && /\.(?:ps1|psm1)$/i.test(relative) ||
    relative === "NOTICE")) {
    throw new Error(`Forbidden bundle path: ${relative}`);
  }
  if (relative.startsWith("node_modules/") && relative.split("/").length < 3) throw new Error(`Unsafe package path: ${relative}`);
  return relative;
}

function validatePayloadDependencies(manifest, read) {
  const packagePaths = manifest.files.map((entry) => entry.path);
  const pkg = JSON.parse(read("package.json").toString("utf8"));
  const lock = JSON.parse(read("package-lock.json").toString("utf8"));
  const closure = productionLockClosure(pkg, lock);
  const required = new Set(closure);
  for (const key of closure) {
    const packageJson = `${key}/package.json`;
    if (!packagePaths.includes(packageJson)) throw new Error(`Missing locked production dependency: ${packageJson}`);
    const installed = JSON.parse(read(packageJson).toString("utf8"));
    validateInstalledPackage(key, installed, lock.packages[key]);
  }
  for (const relative of packagePaths.filter((entry) => entry.startsWith("node_modules/"))) {
    if (![...required].some((key) => relative.startsWith(`${key}/`))) {
      throw new Error(`Unexpected production dependency outside lockfile: ${relative}`);
    }
  }
}

function requireNonexistent(full) {
  if (fs.existsSync(full) || isLink(full)) throw new Error(`Output already exists: ${full}`);
  let ancestor = path.dirname(full);
  while (!fs.existsSync(ancestor)) {
    const next = path.dirname(ancestor);
    if (next === ancestor) throw new Error("Output has no existing parent");
    ancestor = next;
  }
  requireDirectory(ancestor);
}

function isLink(full) {
  try { return fs.lstatSync(full).isSymbolicLink(); } catch (error) {
    if (error.code === "ENOENT") return false;
    throw error;
  }
}

function requireDirectory(full) {
  rejectLinkedAncestors(full);
  const stat = fs.lstatSync(full);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error(`Directory is a reparse/symlink or not a directory: ${full}`);
  return fs.realpathSync.native(full);
}

function requireFile(full) {
  rejectLinkedAncestors(full);
  const stat = fs.lstatSync(full);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`File is a reparse/symlink or not a regular file: ${full}`);
  return full;
}

function rejectLinkedAncestors(full) {
  for (let parent = path.dirname(path.resolve(full)); parent !== path.dirname(parent); parent = path.dirname(parent)) {
    if (fs.lstatSync(parent).isSymbolicLink()) throw new Error(`Parent directory is a reparse/symlink: ${parent}`);
  }
}

function listFiles(directory, prefix, omitNestedPackages = false) {
  requireDirectory(directory);
  const found = [];
  for (const child of fs.readdirSync(directory, { withFileTypes: true })) {
    if (omitNestedPackages && child.isDirectory() && child.name === "node_modules") continue;
    const relative = prefix ? `${prefix}/${child.name}` : child.name;
    safeRelative(relative, child.isDirectory());
    const full = path.join(directory, child.name);
    if (child.isSymbolicLink()) throw new Error(`Symlink/reparse point is forbidden: ${relative}`);
    if (child.isDirectory()) found.push(...listFiles(full, relative, omitNestedPackages));
    else if (child.isFile()) { requireFile(full); found.push(relative); }
    else throw new Error(`Non-regular bundle item: ${relative}`);
  }
  return found;
}

function describeFile(full, relative) {
  requireFile(full);
  const hash = createHash("sha256");
  const fd = fs.openSync(full, "r");
  const buffer = Buffer.allocUnsafe(COPY_SIZE);
  let length = 0;
  try {
    while (true) {
      const read = fs.readSync(fd, buffer, 0, buffer.length, null);
      if (!read) break;
      hash.update(buffer.subarray(0, read));
      length += read;
    }
  } finally { fs.closeSync(fd); }
  return { path: relative, length, sha256: hash.digest("hex") };
}

function isWithin(candidate, root) {
  const relative = path.relative(root, candidate);
  return relative === "" || relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

function archiveCommand(options) {
  const bundle = requireOption(options, "bundle");
  const output = requireOption(options, "output");
  const receipt = requireOption(options, "receipt");
  if (isWithin(output, bundle) || isWithin(receipt, bundle) || output === receipt) throw new Error("Archive and receipt must be separate from the payload");
  requireNonexistent(output);
  requireNonexistent(receipt);
  const manifest = verifyDirectory(bundle, options.revision && expectedRevision(options.revision));
  const fd = fs.openSync(output, "wx");
  try {
    writeAll(fd, MAGIC);
    for (const relative of ["manifest.json", ...manifest.files.map((entry) => entry.path)]) {
      const full = path.join(bundle, ...relative.split("/"));
      const stat = fs.statSync(requireFile(full));
      const name = Buffer.from(relative, "utf8");
      const header = Buffer.alloc(12);
      header.writeUInt32BE(name.length);
      header.writeBigUInt64BE(BigInt(stat.size), 4);
      writeAll(fd, header);
      writeAll(fd, name);
      copyBytes(fs.openSync(full, "r"), fd, stat.size, true);
    }
    writeAll(fd, Buffer.alloc(12));
    fs.fsyncSync(fd);
  } catch (error) {
    fs.closeSync(fd);
    fs.rmSync(output, { force: true });
    throw error;
  }
  fs.closeSync(fd);
  try {
    const archiveFile = describeFile(output, "archive");
    const receiptData = {
      schema_version: RECEIPT_SCHEMA, source_revision: manifest.source_revision,
      source_tree: manifest.source_tree, archive_length: archiveFile.length,
      archive_sha256: archiveFile.sha256,
    };
    fs.writeFileSync(receipt, `${JSON.stringify(receiptData, null, 2)}\n`, { flag: "wx" });
    verifyArchive(output, receipt, manifest.source_revision);
    return { archive: output, receipt, ...receiptData };
  } catch (error) {
    fs.rmSync(output, { force: true });
    fs.rmSync(receipt, { force: true });
    throw error;
  }
}

function copyBytes(sourceFd, targetFd, length, closeSource = false) {
  const buffer = Buffer.allocUnsafe(COPY_SIZE);
  let remaining = length;
  try {
    while (remaining > 0) {
      const read = fs.readSync(sourceFd, buffer, 0, Math.min(buffer.length, remaining), null);
      if (!read) throw new Error("Archive payload is truncated");
      if (targetFd !== undefined) writeAll(targetFd, buffer.subarray(0, read));
      remaining -= read;
    }
  } finally { if (closeSource) fs.closeSync(sourceFd); }
}

function writeAll(fd, bytes) {
  let written = 0;
  while (written < bytes.length) {
    const count = fs.writeSync(fd, bytes, written, bytes.length - written);
    if (!count) throw new Error("Archive write made no progress");
    written += count;
  }
}

function verifyArchive(archive, receiptPath, revision, expectedSha256) {
  requireFile(archive);
  requireFile(receiptPath);
  if (expectedSha256 && !/^[a-f0-9]{64}$/.test(expectedSha256)) {
    throw new Error("--sha256 must be a 64-character lowercase approved digest");
  }
  const receipt = JSON.parse(fs.readFileSync(receiptPath, "utf8"));
  if (!receipt || Object.keys(receipt).sort().join() !==
    ["schema_version", "source_revision", "source_tree", "archive_length", "archive_sha256"].sort().join() ||
    receipt.schema_version !== RECEIPT_SCHEMA || !/^[a-f0-9]{64}$/.test(receipt.archive_sha256) ||
    !Number.isSafeInteger(receipt.archive_length) || receipt.archive_length < MAGIC.length) {
    throw new Error("Archive receipt is invalid");
  }
  const digest = describeFile(archive, "archive");
  if (expectedSha256 && digest.sha256 !== expectedSha256) {
    throw new Error("Archive SHA256 differs from the approved external digest");
  }
  if (digest.length !== receipt.archive_length || digest.sha256 !== receipt.archive_sha256) {
    throw new Error("Archive SHA256 or length differs from the external receipt");
  }
  const fd = fs.openSync(archive, "r");
  let offset = 0;
  const read = (length) => {
    const bytes = Buffer.alloc(length);
    if (fs.readSync(fd, bytes, 0, length, offset) !== length) throw new Error("Archive is truncated");
    offset += length;
    return bytes;
  };
  const entries = [];
  const dependencyData = new Map();
  let manifest;
  try {
    if (!read(MAGIC.length).equals(MAGIC)) throw new Error("Archive magic is invalid");
    while (true) {
      const header = read(12);
      const nameLength = header.readUInt32BE();
      const lengthBig = header.readBigUInt64BE(4);
      if (!nameLength && !lengthBig) break;
      if (!nameLength || nameLength > 1024 || lengthBig > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error("Archive entry header is invalid");
      const relative = read(nameLength).toString("utf8");
      safeRelative(relative);
      const length = Number(lengthBig);
      if (offset + length > digest.length) throw new Error("Archive entry exceeds archive size");
      if (!manifest) {
        if (relative !== "manifest.json" || length > 16 * 1024 * 1024) throw new Error("Archive must start with a bounded manifest");
        manifest = readManifest(read(length), revision);
        if (receipt.source_revision !== manifest.source_revision || receipt.source_tree !== manifest.source_tree) {
          throw new Error("Archive receipt differs from manifest revision or tree");
        }
      } else {
        const expected = manifest.files[entries.length];
        if (!expected || expected.path !== relative || expected.length !== length) throw new Error(`Unexpected, missing, or reordered archive payload: ${relative}`);
        const hash = createHash("sha256");
        const buffer = Buffer.allocUnsafe(COPY_SIZE);
        let remaining = length;
        while (remaining > 0) {
          const count = Math.min(buffer.length, remaining);
          if (fs.readSync(fd, buffer, 0, count, offset) !== count) throw new Error("Archive payload is truncated");
          offset += count;
          hash.update(buffer.subarray(0, count));
          remaining -= count;
        }
        if (hash.digest("hex") !== expected.sha256) throw new Error(`Archive SHA256 mismatch: ${relative}`);
        if (relative === "package.json" || relative === "package-lock.json" ||
          relative.startsWith("node_modules/") && relative.endsWith("/package.json")) {
          if (length > 16 * 1024 * 1024) throw new Error(`Dependency metadata exceeds bound: ${relative}`);
          const metadata = Buffer.alloc(length);
          if (fs.readSync(fd, metadata, 0, length, offset - length) !== length) {
            throw new Error("Archive dependency metadata is truncated");
          }
          dependencyData.set(relative, metadata);
        }
        entries.push(relative);
      }
    }
    if (!manifest || entries.length !== manifest.files.length || offset !== digest.length) {
      throw new Error("Archive has missing or extra payload");
    }
    validatePayloadDependencies(manifest, (relative) => {
      const data = dependencyData.get(relative);
      if (!data) throw new Error(`Archive missing production metadata: ${relative}`);
      return data;
    });
    return manifest;
  } finally { fs.closeSync(fd); }
}

function extractCommand(options) {
  if (!options.sha256) throw new Error("--sha256 is required for extraction");
  const archive = requireOption(options, "archive");
  const receipt = requireOption(options, "receipt");
  const output = requireOption(options, "output");
  requireNonexistent(output);
  const manifest = verifyArchive(archive, receipt, options.revision && expectedRevision(options.revision), options.sha256);
  // The first pass verifies *every* byte before anything is extracted.
  fs.mkdirSync(output);
  const fd = fs.openSync(archive, "r");
  let offset = MAGIC.length;
  try {
    for (const relative of ["manifest.json", ...manifest.files.map((entry) => entry.path)]) {
      const header = Buffer.alloc(12);
      if (fs.readSync(fd, header, 0, header.length, offset) !== header.length) throw new Error("Archive changed during extraction");
      offset += header.length;
      const nameLength = header.readUInt32BE();
      if (nameLength > 1024 || nameLength !== Buffer.byteLength(relative)) {
        throw new Error("Archive entry name length changed or exceeds bound during extraction");
      }
      const size = Number(header.readBigUInt64BE(4));
      const expectedSize = manifest.files.find((entry) => entry.path === relative)?.length;
      if (!Number.isSafeInteger(size) || size < 0 ||
        (relative === "manifest.json" ? size > 16 * 1024 * 1024 : size !== expectedSize)) {
        throw new Error("Archive entry size changed during extraction");
      }
      const name = Buffer.alloc(nameLength);
      if (fs.readSync(fd, name, 0, name.length, offset) !== name.length || name.toString("utf8") !== relative) {
        throw new Error("Archive changed during extraction");
      }
      offset += name.length;
      const destination = path.join(output, ...relative.split("/"));
      fs.mkdirSync(path.dirname(destination), { recursive: true });
      const target = fs.openSync(destination, "wx");
      try {
        const buffer = Buffer.allocUnsafe(COPY_SIZE);
        let remaining = size;
        while (remaining > 0) {
          const count = Math.min(buffer.length, remaining);
          if (fs.readSync(fd, buffer, 0, count, offset) !== count) throw new Error("Archive changed during extraction");
          writeAll(target, buffer.subarray(0, count));
          remaining -= count;
          offset += count;
        }
      } finally { fs.closeSync(target); }
    }
    verifyDirectory(output, manifest.source_revision);
    verifyArchive(archive, receipt, manifest.source_revision, options.sha256);
    return { extracted: output, source_revision: manifest.source_revision, files: manifest.files.length };
  } catch (error) {
    fs.rmSync(output, { recursive: true, force: true });
    throw error;
  } finally { fs.closeSync(fd); }
}
