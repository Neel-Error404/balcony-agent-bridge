import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const script = fileURLToPath(new URL("../../scripts/runtime-bundle.mjs", import.meta.url));
const checkout = path.dirname(path.dirname(script));
const REVISION = "a".repeat(40);
const TREE = "b".repeat(40);
const required = [
  "LICENSE",
  "package.json",
  "package-lock.json",
  "dist/bridge/index.js",
  "dist/dispatcher/index.js",
  "dist/mcp/index.js",
  "service/balcony-agent-bridge.xml.template",
  "service/balcony-agent-dispatcher.xml.template",
  "scripts/runtime-bundle.mjs",
  "runtime/node.exe",
  "runtime/codex.exe",
  "runtime/codex-code-mode-host.exe",
  "node_modules/@openai/codex/package.json",
  "node_modules/@openai/codex-win32-x64/package.json",
];

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "river-runtime-bundle-test-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const bundle = path.join(root, "payload");
  fs.mkdirSync(bundle);
  const packageJson = { name: "balcony-agent-bridge", dependencies: { "@openai/codex": "0.150.1" } };
  const lock = {
    lockfileVersion: 3,
    packages: {
      "": { name: packageJson.name, dependencies: packageJson.dependencies },
      "node_modules/@openai/codex": {
        version: "0.150.1",
        optionalDependencies: { "@openai/codex-win32-x64": "npm:@openai/codex@0.150.1-win32-x64" },
      },
      "node_modules/@openai/codex-win32-x64": {
        name: "@openai/codex", version: "0.150.1-win32-x64", os: ["win32"], cpu: ["x64"],
      },
    },
  };
  const contents = {
    "package.json": JSON.stringify(packageJson),
    "package-lock.json": JSON.stringify(lock),
    "node_modules/@openai/codex/package.json": JSON.stringify({ name: "@openai/codex", version: "0.150.1" }),
    "node_modules/@openai/codex-win32-x64/package.json": JSON.stringify({ name: "@openai/codex", version: "0.150.1-win32-x64" }),
  };
  const files = required.map((relative) => {
    const data = Buffer.from(contents[relative] ?? `fixture: ${relative}\n`);
    const full = path.join(bundle, ...relative.split("/"));
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, data);
    return {
      path: relative,
      length: data.length,
      sha256: createHash("sha256").update(data).digest("hex"),
    };
  });
  const manifest = {
    schema_version: "river-runtime-bundle.v1",
    source_revision: REVISION,
    source_tree: TREE,
    platform: "win32",
    architecture: "x64",
    node_version: "22.14.0",
    codex_version: "0.150.1",
    database_schema_version: 9,
    coordination_versions: ["1.0", "1.1"],
    files,
  };
  fs.writeFileSync(path.join(bundle, "manifest.json"), `${JSON.stringify(manifest)}\n`);
  return { root, bundle, manifest };
}

function cli(...args) {
  return spawnSync(process.execPath, [script, ...args], { encoding: "utf8", windowsHide: true });
}

function success(result) {
  assert.equal(result.status, 0, `stderr: ${result.stderr}`);
}

function failure(result, pattern) {
  assert.notEqual(result.status, 0, `unexpected success: ${result.stdout}`);
  assert.match(result.stderr, pattern);
}

test("verifier checks a complete directory against an exact manifest and revision", (t) => {
  const { bundle } = fixture(t);
  success(cli("verify", "--bundle", bundle, "--revision", REVISION));
  failure(cli("verify", "--bundle", bundle, "--revision", "c".repeat(40)), /revision/i);
  fs.writeFileSync(path.join(bundle, "dist/bridge/index.js"), "tampered");
  failure(cli("verify", "--bundle", bundle, "--revision", REVISION), /length|sha256|digest/i);
});

test("verifier accepts equivalent production dependency maps regardless of JSON key order", (t) => {
  const { bundle, manifest } = fixture(t);
  const rootPackage = JSON.parse(fs.readFileSync(path.join(bundle, "package.json"), "utf8"));
  rootPackage.dependencies = {
    zod: "4.4.3",
    "@openai/codex": "0.150.1",
  };
  const lock = JSON.parse(fs.readFileSync(path.join(bundle, "package-lock.json"), "utf8"));
  lock.packages[""].dependencies = {
    "@openai/codex": "0.150.1",
    zod: "4.4.3",
  };
  lock.packages["node_modules/zod"] = { version: "4.4.3" };
  const changed = {
    "package.json": JSON.stringify(rootPackage),
    "package-lock.json": JSON.stringify(lock),
    "node_modules/zod/package.json": JSON.stringify({ name: "zod", version: "4.4.3" }),
  };
  for (const [relative, data] of Object.entries(changed)) {
    const full = path.join(bundle, ...relative.split("/"));
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, data);
    const entry = manifest.files.find((file) => file.path === relative);
    if (entry) {
      entry.length = Buffer.byteLength(data);
      entry.sha256 = createHash("sha256").update(data).digest("hex");
    } else {
      manifest.files.push({ path: relative, length: Buffer.byteLength(data), sha256: createHash("sha256").update(data).digest("hex") });
    }
  }
  fs.writeFileSync(path.join(bundle, "manifest.json"), `${JSON.stringify(manifest)}\n`);
  success(cli("verify", "--bundle", bundle, "--revision", REVISION));
});

test("verifier rejects missing, extra, traversal, and secret-bearing paths", (t) => {
  const { bundle, manifest } = fixture(t);
  fs.rmSync(path.join(bundle, "runtime/codex.exe"));
  failure(cli("verify", "--bundle", bundle), /missing/i);
  fs.writeFileSync(path.join(bundle, "runtime/codex.exe"), "fixture: runtime/codex.exe\n");
  fs.writeFileSync(path.join(bundle, "auth.json"), "SECRET");
  failure(cli("verify", "--bundle", bundle), /unexpected|forbidden|auth\.json/i);
  fs.rmSync(path.join(bundle, "auth.json"));
  manifest.files[0].path = "../LICENSE";
  fs.writeFileSync(path.join(bundle, "manifest.json"), `${JSON.stringify(manifest)}\n`);
  failure(cli("verify", "--bundle", bundle), /unsafe|path|traversal/i);
});

test("verifier rejects Windows device-name aliases before filesystem lookup", (t) => {
  const { bundle, manifest } = fixture(t);
  manifest.files.find((entry) => entry.path === "dist/bridge/index.js").path = "dist/CON.txt";
  fs.writeFileSync(path.join(bundle, "manifest.json"), `${JSON.stringify(manifest)}\n`);
  failure(cli("verify", "--bundle", bundle), /unsafe|reserved|device name/i);
});

test("verifier rejects symlink/reparse material instead of following it", (t) => {
  const { bundle, root } = fixture(t);
  const target = path.join(root, "secret.txt");
  fs.writeFileSync(target, "SECRET");
  const original = path.join(bundle, "LICENSE");
  fs.rmSync(original);
  try {
    fs.symlinkSync(target, original, "file");
  } catch (error) {
    if (error.code !== "EPERM") throw error;
    fs.writeFileSync(original, "fixture: LICENSE\n");
    const outside = path.join(root, "outside");
    fs.mkdirSync(outside);
    fs.writeFileSync(path.join(outside, "auth.json"), "SECRET");
    try {
      fs.symlinkSync(outside, path.join(bundle, "dist", "rogue"), "junction");
    } catch (junctionError) {
      if (junctionError.code === "EPERM") return t.skip("file symlink and junction creation not permitted");
      throw junctionError;
    }
  }
  failure(cli("verify", "--bundle", bundle), /symlink|reparse|regular/i);
});

test("verifier refuses a bundle reached through a parent junction or symlink", (t) => {
  const { root, bundle } = fixture(t);
  const alias = path.join(root, "alias");
  try {
    fs.symlinkSync(root, alias, process.platform === "win32" ? "junction" : "dir");
  } catch (error) {
    if (error.code === "EPERM") return t.skip("junction creation not permitted");
    throw error;
  }
  failure(cli("verify", "--bundle", path.join(alias, path.basename(bundle))), /symlink|reparse|junction/i);
});

test("verifier rejects a dependency payload not present in the production lock closure", (t) => {
  const { bundle, manifest } = fixture(t);
  const relative = "node_modules/rogue/package.json";
  const data = Buffer.from('{"name":"rogue","version":"1.0.0"}');
  const full = path.join(bundle, ...relative.split("/"));
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, data);
  manifest.files.push({
    path: relative, length: data.length, sha256: createHash("sha256").update(data).digest("hex"),
  });
  fs.writeFileSync(path.join(bundle, "manifest.json"), `${JSON.stringify(manifest)}\n`);
  failure(cli("verify", "--bundle", bundle), /production|lock|dependency|rogue/i);
});

test("verifier allows ordinary package source directories named credentials", (t) => {
  const { bundle, manifest } = fixture(t);
  const relative = "node_modules/@openai/codex/dist/credentials/loader.js";
  const data = Buffer.from("export const credentialLoader = true;\n");
  const full = path.join(bundle, ...relative.split("/"));
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, data);
  manifest.files.push({
    path: relative, length: data.length, sha256: createHash("sha256").update(data).digest("hex"),
  });
  fs.writeFileSync(path.join(bundle, "manifest.json"), `${JSON.stringify(manifest)}\n`);
  success(cli("verify", "--bundle", bundle));
});

test("verifier refuses installed production package identity that differs from lockfile", (t) => {
  const { bundle, manifest } = fixture(t);
  const relative = "node_modules/@openai/codex/package.json";
  const data = Buffer.from(JSON.stringify({ name: "substituted-package", version: "0.150.1" }));
  fs.writeFileSync(path.join(bundle, ...relative.split("/")), data);
  const entry = manifest.files.find((file) => file.path === relative);
  entry.length = data.length;
  entry.sha256 = createHash("sha256").update(data).digest("hex");
  fs.writeFileSync(path.join(bundle, "manifest.json"), `${JSON.stringify(manifest)}\n`);
  failure(cli("verify", "--bundle", bundle), /dependency identity|package identity|name/i);
});

test("archive verifies exact bytes and safely extracts only the approved payload", (t) => {
  const { root, bundle } = fixture(t);
  const archive = path.join(root, "release.rbb");
  const receipt = `${archive}.receipt.json`;
  success(cli("archive", "--bundle", bundle, "--output", archive, "--receipt", receipt));
  const approved = JSON.parse(fs.readFileSync(receipt, "utf8")).archive_sha256;
  success(cli("verify", "--archive", archive, "--receipt", receipt, "--revision", REVISION));
  const extracted = path.join(root, "extracted");
  success(cli("extract", "--archive", archive, "--receipt", receipt, "--sha256", approved, "--output", extracted, "--revision", REVISION));
  success(cli("verify", "--bundle", extracted, "--revision", REVISION));
  assert.deepEqual(fs.readFileSync(path.join(extracted, "runtime/node.exe")), fs.readFileSync(path.join(bundle, "runtime/node.exe")));
  const bytes = fs.readFileSync(archive);
  bytes[bytes.length - 2] ^= 1;
  fs.writeFileSync(archive, bytes);
  failure(cli("verify", "--archive", archive, "--receipt", receipt), /archive|sha256|digest/i);
  failure(cli("extract", "--archive", archive, "--receipt", receipt, "--sha256", approved, "--output", path.join(root, "no-extract")), /archive|sha256|digest/i);
  assert.equal(fs.existsSync(path.join(root, "no-extract")), false);
});

test("archive parser rejects a traversal record even if its receipt is recomputed", (t) => {
  const { root, bundle } = fixture(t);
  const archive = path.join(root, "release.rbb");
  const receipt = `${archive}.receipt.json`;
  success(cli("archive", "--bundle", bundle, "--output", archive, "--receipt", receipt));
  const bytes = fs.readFileSync(archive);
  const original = Buffer.from("dist/bridge/index.js");
  const position = bytes.indexOf(original, bytes.indexOf(original) + 1);
  assert.ok(position > 0);
  Buffer.from("../t/bridge/index.js").copy(bytes, position);
  fs.writeFileSync(archive, bytes);
  const parsed = JSON.parse(fs.readFileSync(receipt, "utf8"));
  parsed.archive_sha256 = createHash("sha256").update(bytes).digest("hex");
  fs.writeFileSync(receipt, JSON.stringify(parsed));
  failure(cli("verify", "--archive", archive, "--receipt", receipt), /unsafe|traversal|path/i);
  const extracted = path.join(root, "extracted");
  failure(cli("extract", "--archive", archive, "--receipt", receipt, "--sha256", parsed.archive_sha256, "--output", extracted), /unsafe|traversal|path/i);
  assert.equal(fs.existsSync(extracted), false);
});

test("trusted external digest rejects jointly changed archive and receipt", (t) => {
  const { root, bundle, manifest } = fixture(t);
  const archive = path.join(root, "release.rbb");
  const receipt = `${archive}.receipt.json`;
  success(cli("archive", "--bundle", bundle, "--output", archive, "--receipt", receipt));
  const originalDigest = JSON.parse(fs.readFileSync(receipt, "utf8")).archive_sha256;
  success(cli("verify", "--archive", archive, "--receipt", receipt, "--sha256", originalDigest));
  // Repackage a different valid payload with a matching new receipt. Internal
  // manifest/receipt checks still pass, but the approved digest must not.
  const changed = Buffer.from("fixture: altered LICENSE\n");
  fs.writeFileSync(path.join(bundle, "LICENSE"), changed);
  const entry = manifest.files.find((file) => file.path === "LICENSE");
  entry.length = changed.length;
  entry.sha256 = createHash("sha256").update(changed).digest("hex");
  fs.writeFileSync(path.join(bundle, "manifest.json"), JSON.stringify(manifest));
  const repacked = path.join(root, "repacked.rbb");
  const repackedReceipt = `${repacked}.receipt.json`;
  success(cli("archive", "--bundle", bundle, "--output", repacked, "--receipt", repackedReceipt));
  success(cli("verify", "--archive", repacked, "--receipt", repackedReceipt));
  failure(cli("verify", "--archive", repacked, "--receipt", repackedReceipt, "--sha256", originalDigest), /sha256|digest/i);
  const output = path.join(root, "no-extract");
  failure(cli("extract", "--archive", repacked, "--receipt", repackedReceipt, "--sha256", originalDigest, "--output", output), /sha256|digest/i);
  assert.equal(fs.existsSync(output), false);
});

test("extract bounds record names again after the verified first pass", (t) => {
  const { root, bundle } = fixture(t);
  const archive = path.join(root, "release.rbb");
  const receipt = `${archive}.receipt.json`;
  success(cli("archive", "--bundle", bundle, "--output", archive, "--receipt", receipt));
  const approved = JSON.parse(fs.readFileSync(receipt, "utf8")).archive_sha256;
  const output = path.join(root, "extracted");
  const hook = path.join(root, "mutate-second-pass.cjs");
  fs.writeFileSync(hook, `
    const fs = require("node:fs");
    const path = require("node:path");
    const mkdir = fs.mkdirSync;
    let changed = false;
    fs.mkdirSync = function(target, ...args) {
      if (!changed && path.resolve(target) === path.resolve(process.env.TEST_EXTRACT_OUTPUT)) {
        changed = true;
        const fd = fs.openSync(process.env.TEST_ARCHIVE, "r+");
        const header = Buffer.alloc(4);
        header.writeUInt32BE(1025);
        fs.writeSync(fd, header, 0, 4, 8);
        fs.closeSync(fd);
      }
      return mkdir.call(this, target, ...args);
    };
  `);
  const result = spawnSync(process.execPath, ["--require", hook, script, "extract",
    "--archive", archive, "--receipt", receipt, "--sha256", approved, "--output", output], {
    encoding: "utf8", windowsHide: true,
    env: { ...process.env, TEST_ARCHIVE: archive, TEST_EXTRACT_OUTPUT: output },
  });
  failure(result, /name length|header.*bound/i);
  assert.equal(fs.existsSync(output), false);
});

test("extract rechecks approved SHA256 after jointly changed archive and receipt", (t) => {
  const { root, bundle } = fixture(t);
  const archive = path.join(root, "release.rbb");
  const receipt = `${archive}.receipt.json`;
  success(cli("archive", "--bundle", bundle, "--output", archive, "--receipt", receipt));
  const approved = JSON.parse(fs.readFileSync(receipt, "utf8")).archive_sha256;
  success(cli("verify", "--archive", archive, "--receipt", receipt, "--sha256", approved));
  const output = path.join(root, "extracted");
  const hook = path.join(root, "mutate-archive-and-receipt.cjs");
  fs.writeFileSync(hook, `
    const fs = require("node:fs");
    const path = require("node:path");
    const { createHash } = require("node:crypto");
    const mkdir = fs.mkdirSync;
    let changed = false;
    fs.mkdirSync = function(target, ...args) {
      if (!changed && path.resolve(target) === path.resolve(process.env.TEST_EXTRACT_OUTPUT)) {
        changed = true;
        const bytes = fs.readFileSync(process.env.TEST_ARCHIVE);
        const manifestOffset = 8 + 12 + Buffer.byteLength("manifest.json");
        const manifestLength = fs.statSync(process.env.TEST_MANIFEST).size;
        const last = manifestOffset + manifestLength - 1;
        if (bytes[last] !== 10) throw new Error("Expected manifest trailing newline");
        bytes[last] = 32; // Same-length valid JSON; all embedded file hashes remain valid.
        fs.writeFileSync(process.env.TEST_ARCHIVE, bytes);
        const receipt = JSON.parse(fs.readFileSync(process.env.TEST_RECEIPT, "utf8"));
        receipt.archive_sha256 = createHash("sha256").update(bytes).digest("hex");
        fs.writeFileSync(process.env.TEST_RECEIPT, JSON.stringify(receipt));
      }
      return mkdir.call(this, target, ...args);
    };
  `);
  const result = spawnSync(process.execPath, ["--require", hook, script, "extract",
    "--archive", archive, "--receipt", receipt, "--sha256", approved, "--output", output], {
    encoding: "utf8", windowsHide: true,
    env: {
      ...process.env, TEST_ARCHIVE: archive, TEST_RECEIPT: receipt,
      TEST_MANIFEST: path.join(bundle, "manifest.json"), TEST_EXTRACT_OUTPUT: output,
    },
  });
  failure(result, /approved external digest/i);
  assert.equal(fs.existsSync(output), false);
});

test("extract refuses to start without an operator-approved SHA256", (t) => {
  const { root, bundle } = fixture(t);
  const archive = path.join(root, "release.rbb");
  const receipt = `${archive}.receipt.json`;
  success(cli("archive", "--bundle", bundle, "--output", archive, "--receipt", receipt));
  const output = path.join(root, "unapproved-extract");
  failure(cli("extract", "--archive", archive, "--receipt", receipt, "--output", output), /--sha256.*required/i);
  assert.equal(fs.existsSync(output), false);
});

test("build refuses an unreviewed or dirty checkout before writing output", (t) => {
  const { root } = fixture(t);
  const output = path.join(root, "not-built");
  const result = cli("build", "--root", root, "--revision", REVISION, "--node", process.execPath, "--output", output);
  failure(result, /git|clean|revision/i);
  assert.equal(fs.existsSync(output), false);
});

test("build copies a locked nested production dependency only once", (t) => {
  const { root } = fixture(t);
  const source = path.join(root, "source");
  const shim = path.join(root, "shim");
  fs.mkdirSync(source);
  fs.mkdirSync(shim);
  const inputs = [
    "LICENSE", "package.json", "package-lock.json",
    "service/balcony-agent-bridge.xml.template",
    "service/balcony-agent-dispatcher.xml.template",
    "scripts/runtime-bundle.mjs",
  ];
  const pkg = { name: "balcony-agent-bridge", dependencies: { "@openai/codex": "0.150.1", parent: "1.0.0" } };
  const lock = {
    lockfileVersion: 3, packages: {
      "": { name: pkg.name, dependencies: pkg.dependencies },
      "node_modules/@openai/codex": {
        version: "0.150.1", optionalDependencies: { "@openai/codex-win32-x64": "0.150.1-win32-x64" },
      },
      "node_modules/@openai/codex-win32-x64": {
        name: "@openai/codex", version: "0.150.1-win32-x64", os: ["win32"], cpu: ["x64"],
      },
      "node_modules/parent": { version: "1.0.0", dependencies: { child: "1.0.0" } },
      "node_modules/parent/node_modules/child": { version: "1.0.0" },
    },
  };
  const contents = {
    "package.json": JSON.stringify(pkg),
    "package-lock.json": JSON.stringify(lock),
    "node_modules/@openai/codex/package.json": JSON.stringify({ name: "@openai/codex", version: "0.150.1" }),
    "node_modules/@openai/codex-win32-x64/package.json": JSON.stringify({ name: "@openai/codex", version: "0.150.1-win32-x64" }),
    "node_modules/parent/package.json": JSON.stringify({ name: "parent", version: "1.0.0" }),
    "node_modules/parent/node_modules/child/package.json": JSON.stringify({ name: "child", version: "1.0.0" }),
  };
  for (const [relative, text] of Object.entries(contents)) {
    const full = path.join(source, ...relative.split("/"));
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, text);
  }
  for (const relative of inputs.filter((item) => !(item in contents))) {
    const full = path.join(source, ...relative.split("/"));
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, `fixture: ${relative}\n`);
  }
  const native = path.join(source, "node_modules/@openai/codex-win32-x64/vendor/x86_64-pc-windows-msvc/bin");
  fs.mkdirSync(native, { recursive: true });
  fs.writeFileSync(path.join(native, "codex.exe"), "fixture binary\n");
  fs.writeFileSync(path.join(native, "codex-code-mode-host.exe"), "fixture companion\n");
  const preload = path.join(shim, "fake-git.cjs");
  fs.writeFileSync(preload, `
    const cp = require("node:child_process");
    const original = cp.spawnSync;
    cp.spawnSync = function(command, args, options) {
      if (command.endsWith("codex.exe") && args[0] === "--version") {
        return { status: 0, stdout: process.env.TEST_CODEX_VERSION, stderr: "" };
      }
      if (command !== "git") return original.apply(this, arguments);
      let text = "";
      if (args.includes("--show-toplevel")) text = process.env.TEST_SOURCE;
      else if (args.includes("HEAD^{tree}")) text = process.env.TEST_TREE;
      else if (args.includes("HEAD")) text = process.env.TEST_REVISION;
      else if (args.includes("ls-files")) text = process.env.TEST_INPUTS.split("|").join("\\0") + "\\0";
      else if (!args.includes("status")) throw new Error("Unexpected fake Git invocation");
      return { status: 0, stdout: options.encoding ? text : Buffer.from(text),
        stderr: options.encoding ? "" : Buffer.alloc(0) };
    };
    require("node:module").syncBuiltinESMExports();
  `);
  const npmStub = path.join(shim, "fake-npm.cjs");
  fs.writeFileSync(npmStub, `
    const fs = require("node:fs"), path = require("node:path");
    for (const name of ["bridge", "dispatcher", "mcp"]) {
      const file = path.join(process.cwd(), "dist", name, "index.js");
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, "fixture build\\n");
    }
  `);
  const env = {
    ...process.env,
    npm_execpath: npmStub, TEST_SOURCE: source, TEST_REVISION: REVISION, TEST_TREE: TREE,
    TEST_INPUTS: inputs.join("|"), TEST_CODEX_VERSION: "codex-cli 0.150.1",
  };
  const planned = spawnSync(process.execPath, ["--require", preload, script, "plan", "--root", source,
    "--revision", REVISION, "--node", process.execPath], {
    encoding: "utf8", windowsHide: true,
    env,
  });
  success(planned);
  assert.equal(JSON.parse(planned.stdout).production_package_count, 4);
  const wrongOutput = path.join(root, "wrong-version");
  const wrongVersion = spawnSync(process.execPath, ["--require", preload, script, "build", "--root", source,
    "--revision", REVISION, "--node", process.execPath, "--output", wrongOutput], {
    encoding: "utf8", windowsHide: true, env: { ...env, TEST_CODEX_VERSION: "codex-cli 0.149.0" },
  });
  failure(wrongVersion, /Codex executable.*0\.150\.1/i);
  assert.equal(fs.existsSync(wrongOutput), false);
  const output = path.join(root, "built");
  const result = spawnSync(process.execPath, ["--require", preload, script, "build", "--root", source,
    "--revision", REVISION, "--node", process.execPath, "--output", output], {
    encoding: "utf8", windowsHide: true, env,
  });
  success(result);
  success(cli("verify", "--bundle", output, "--revision", REVISION));
  const archive = path.join(root, "built.rbb");
  const receipt = `${archive}.receipt.json`;
  success(cli("archive", "--bundle", output, "--output", archive, "--receipt", receipt));
  const digest = JSON.parse(fs.readFileSync(receipt, "utf8")).archive_sha256;
  const extracted = path.join(root, "extracted");
  success(cli("extract", "--archive", archive, "--receipt", receipt,
    "--sha256", digest, "--revision", REVISION, "--output", extracted));
  success(cli("verify", "--bundle", extracted, "--revision", REVISION));
});

test("plan recognizes the exact Windows checkout root despite Git slash spelling", () => {
  const revision = spawnSync("git", ["-C", checkout, "rev-parse", "HEAD"], { encoding: "utf8" }).stdout.trim();
  const gitStatus = spawnSync("git", ["-C", checkout, "status", "--porcelain=v1", "--untracked-files=all"], { encoding: "utf8" }).stdout.trim();
  const result = cli("plan", "--root", checkout, "--revision", revision, "--node", process.execPath);
  if (gitStatus) failure(result, /checkout must be clean/i);
  else assert.doesNotMatch(result.stderr, /Git root must be the exact checkout root/i);
});
