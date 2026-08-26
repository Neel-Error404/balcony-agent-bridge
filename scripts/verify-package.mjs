import { spawnSync } from "node:child_process";
import { createHash, generateKeyPairSync } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const installCheck = process.argv.includes("--install");
const cleanCache = process.argv.includes("--clean-cache");
const npmCli = process.env.npm_execpath;
const prepareIdentityDirectoryScript = String.raw`
$ErrorActionPreference = "Stop"
$directory = $env:BALCONY_TEST_IDENTITY_DIRECTORY
New-Item -ItemType Directory -Force -Path $directory | Out-Null
$currentSid = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
$grants = @(
  "*$($currentSid):(OI)(CI)F",
  "*S-1-5-18:(OI)(CI)F",
  "*S-1-5-32-544:(OI)(CI)F"
)
& icacls.exe $directory /inheritance:r /grant:r $grants | Out-Null
if ($LASTEXITCODE -ne 0) {
  throw "Unable to restrict package-verification identity directory."
}
`;

if (cleanCache && !installCheck) {
  throw new Error("--clean-cache requires --install");
}

if (!npmCli) {
  throw new Error(
    "npm_execpath is unavailable; run this verifier through npm run verify:package or npm run smoke:package",
  );
}

const dryRun = runNpm(
  ["pack", "--dry-run", "--json"],
  repositoryRoot,
);
const manifest = parsePackResult(dryRun.stdout);
const npmVersion = runNpm(["--version"], repositoryRoot).stdout.trim();
const packagedFiles = manifest.files.map((entry) => normalize(entry.path));

const requiredFiles = [
  "LICENSE",
  "README.md",
  "SECURITY.md",
  "config/codex-mcp.example.toml",
  "config/dispatcher-projects.example.json",
  "package.json",
  "dist/bridge/index.js",
  "dist/cli/index.js",
  "dist/dispatcher/index.js",
  "dist/mcp/index.js",
];
for (const requiredFile of requiredFiles) {
  if (!packagedFiles.includes(requiredFile)) {
    throw new Error(`Package is missing required file: ${requiredFile}`);
  }
}

const allowedRootFiles = new Set([
  "LICENSE",
  "NOTICE",
  "README.md",
  "SECURITY.md",
  "config/codex-mcp.example.toml",
  "config/dispatcher-projects.example.json",
  "package.json",
]);
const unexpectedFiles = packagedFiles.filter(
  (file) =>
    !file.startsWith("dist/") &&
    !allowedRootFiles.has(file),
);
if (unexpectedFiles.length > 0) {
  throw new Error(
    `Package contains files outside the release allowlist: ${unexpectedFiles.join(", ")}`,
  );
}

const forbiddenPrefixes = [
  ".env",
  "AGENTS.md",
  "docs/",
  "infra/",
  "scripts/",
  "service/",
  "src/",
  "tests/",
];
const forbiddenFiles = packagedFiles.filter((file) =>
  forbiddenPrefixes.some(
    (prefix) => file === prefix || file.startsWith(prefix),
  ),
);
if (forbiddenFiles.length > 0) {
  throw new Error(
    `Package contains private or development-only files: ${forbiddenFiles.join(", ")}`,
  );
}

verifyPackagedReadmeLinks(packagedFiles);

const result = {
  platform: process.platform,
  architecture: process.arch,
  node_version: process.version,
  npm_version: npmVersion,
  package_filename: manifest.filename,
  package_shasum: manifest.shasum,
  package_integrity: manifest.integrity,
  package_file_count: packagedFiles.length,
  package_size_bytes: manifest.size,
  unpacked_size_bytes: manifest.unpackedSize,
  install_smoke: "not-run",
  consumer_environment: "not-run",
  dependency_tree: "not-run",
  package_command: "not-run",
};

if (installCheck) {
  const installedManifest = runInstallSmoke(cleanCache);
  assertSamePackageManifest(manifest, installedManifest);
  result.package_filename = installedManifest.filename;
  result.package_shasum = installedManifest.shasum;
  result.package_integrity = installedManifest.integrity;
  result.install_smoke = cleanCache ? "isolated-cache-network" : "offline-cache";
  result.consumer_environment = "disposable-empty-npm-project";
  result.dependency_tree = "valid";
  result.package_command = "npm-exec-offline";
}

process.stdout.write(`${JSON.stringify(result)}\n`);

function runInstallSmoke(useCleanCache) {
  const temporaryDirectory = fs.mkdtempSync(
    path.join(os.tmpdir(), "balcony-agent-bridge-package-"),
  );
  let identityDirectory;
  try {
    const packed = runNpm(
      [
        "pack",
        "--json",
        "--ignore-scripts",
        "--pack-destination",
        temporaryDirectory,
      ],
      repositoryRoot,
    );
    const packedManifest = parsePackResult(packed.stdout);
    const tarballName = packedManifest.filename;
    const tarballPath = path.join(temporaryDirectory, tarballName);
    const consumerDirectory = path.join(temporaryDirectory, "consumer");
    fs.mkdirSync(consumerDirectory);
    fs.writeFileSync(
      path.join(consumerDirectory, "package.json"),
      `${JSON.stringify({
        name: "balcony-agent-bridge-consumer",
        version: "0.0.0",
        private: true,
      }, null, 2)}\n`,
      "utf8",
    );

    const installArguments = ["install"];
    if (useCleanCache) {
      installArguments.push("--cache", path.join(temporaryDirectory, "npm-cache"));
    } else {
      installArguments.push("--offline");
    }
    installArguments.push(
      "--no-audit",
      "--no-fund",
      tarballPath,
    );
    runNpm(installArguments, consumerDirectory);
    runNpm(["ls", "--all", "--omit=dev"], consumerDirectory);

    const packageRoot = path.join(
      consumerDirectory,
      "node_modules",
      "balcony-agent-bridge",
    );
    const cliPath = path.join(packageRoot, "dist", "cli", "index.js");
    requirePath(cliPath);
    const binDirectory = path.join(consumerDirectory, "node_modules", ".bin");
    const cliBin = path.join(
      binDirectory,
      process.platform === "win32"
        ? "balcony-agent-bridge.cmd"
        : "balcony-agent-bridge",
    );
    const mcpBin = path.join(
      binDirectory,
      process.platform === "win32"
        ? "balcony-agent-bridge-mcp.cmd"
        : "balcony-agent-bridge-mcp",
    );
    requirePath(cliBin);
    requirePath(mcpBin);

    const directHelp = spawnSync(process.execPath, [cliPath, "--help"], {
      cwd: consumerDirectory,
      encoding: "utf8",
      windowsHide: true,
    });
    requireExit(directHelp, 0, "packaged CLI JavaScript help");

    const help = runInstalledCli(cliBin, ["--help"], consumerDirectory);
    requireExit(help, 0, "packaged CLI help");
    if (!help.stdout.includes("Usage: balcony-agent-bridge <command>")) {
      throw new Error("Packaged CLI help did not contain the public command usage");
    }
    const packageCommandHelp = runNpm(
      ["exec", "--offline", "--", "balcony-agent-bridge", "--help"],
      consumerDirectory,
    );
    if (!packageCommandHelp.stdout.includes("Usage: balcony-agent-bridge <command>")) {
      throw new Error("npm exec did not resolve the installed local CLI");
    }

    identityDirectory = createPackageIdentityDirectory();
    prepareIdentityDirectory(identityDirectory);
    const identity = runInstalledCli(
      cliBin,
      [
        "identity",
        "--node-id",
        "node-a",
        "--output-directory",
        identityDirectory,
      ],
      consumerDirectory,
    );
    requireExit(identity, 0, "packaged CLI identity generation");
    const identityPayload = JSON.parse(identity.stdout);
    requirePath(identityPayload.signing_key_path);
    requirePath(identityPayload.enrollment_path);
    if (
      !String(identityPayload.key_id).startsWith("ed25519:") ||
      identity.stdout.includes("PRIVATE KEY")
    ) {
      throw new Error("Packaged CLI identity output was not public-safe");
    }
    const membershipPath = path.join(identityDirectory, "membership.json");
    fs.writeFileSync(
      membershipPath,
      `${JSON.stringify({
        schema_version: "1.0",
        network_id: "package-verification",
        peers: [
          packagePeerEnrollment("node-b"),
          packagePeerEnrollment("node-c"),
        ],
      })}\n`,
      { encoding: "utf8", mode: 0o600, flag: "wx" },
    );

    const profilePath = path.join(temporaryDirectory, "profile", "config.json");
    const databasePath = path.join(
      temporaryDirectory,
      "profile",
      "bridge.sqlite3",
    );
    const setup = runInstalledCli(
      cliBin,
      [
        "setup",
        "--config",
        profilePath,
        "--database",
        databasePath,
        "--node-id",
        "node-a",
        "--authorized-node",
        "node-b",
        "--authorized-node",
        "node-c",
      ],
      consumerDirectory,
    );
    requireExit(setup, 0, "packaged CLI setup");
    const setupPayload = JSON.parse(setup.stdout);
    if (setupPayload.created !== true || !setupPayload.mcp_registration) {
      throw new Error("Packaged CLI setup did not create the expected profile");
    }
    verifyGeneratedMcpRegistration(
      setupPayload.mcp_registration,
      temporaryDirectory,
    );

    const repeatedSetup = runInstalledCli(
      cliBin,
      [
        "setup",
        "--config",
        profilePath,
        "--database",
        databasePath,
        "--node-id",
        "node-a",
        "--authorized-node",
        "node-b",
        "--authorized-node",
        "node-c",
      ],
      consumerDirectory,
    );
    requireExit(repeatedSetup, 0, "packaged CLI idempotent setup");
    if (JSON.parse(repeatedSetup.stdout).created !== false) {
      throw new Error("Packaged CLI setup was not idempotent");
    }

    const defaultDataRoot = path.join(temporaryDirectory, "default-data-root");
    const defaultEnvironment = {
      ...process.env,
      ...(process.platform === "win32"
        ? { LOCALAPPDATA: defaultDataRoot }
        : { XDG_CONFIG_HOME: defaultDataRoot }),
    };
    const defaultSetup = runInstalledCli(
      cliBin,
      [
        "setup",
        "--node-id",
        "default-node",
        "--authorized-node",
        "node-b",
      ],
      consumerDirectory,
      { env: defaultEnvironment },
    );
    requireExit(defaultSetup, 0, "packaged CLI default-path setup");
    const defaultSetupPayload = JSON.parse(defaultSetup.stdout);
    if (
      defaultSetupPayload.created !== true ||
      !path.resolve(defaultSetupPayload.config_path).startsWith(
        path.resolve(defaultDataRoot),
      )
    ) {
      throw new Error("Packaged CLI default-path setup escaped its isolated root");
    }

    const doctor = runInstalledCli(
      cliBin,
      ["doctor", "--config", profilePath],
      consumerDirectory,
      {
        env: {
          ...process.env,
          BALCONY_SYSTEM_ID: "node-a",
          BALCONY_MESSAGE_AUTH_MODE: "ed25519",
          BALCONY_MESSAGE_AUTH_MEMBERSHIP_PATH: membershipPath,
          BALCONY_MESSAGE_AUTH_SIGNING_KEY_PATH:
            identityPayload.signing_key_path,
        },
      },
    );
    requireExit(doctor, 0, "packaged CLI doctor");
    if (JSON.parse(doctor.stdout).ok !== true) {
      throw new Error("Packaged CLI doctor did not report a healthy profile");
    }

    const demo = runInstalledCli(cliBin, ["demo"], consumerDirectory);
    requireExit(demo, 0, "packaged CLI demo");
    const demoPayload = JSON.parse(demo.stdout);
    if (demoPayload.result !== "passed" || demoPayload.azure_used !== false) {
      throw new Error("Packaged CLI demo did not complete locally");
    }

    const profileStatus = runInstalledCli(
      cliBin,
      ["status", "--config", profilePath],
      consumerDirectory,
      {
        env: {
          ...process.env,
          BALCONY_SYSTEM_ID: "node-a",
        },
      },
    );
    requireExit(profileStatus, 0, "packaged CLI profile status");
    if (JSON.parse(profileStatus.stdout).system_id !== "node-a") {
      throw new Error("Packaged CLI status did not load the setup profile");
    }

    const status = runInstalledCli(cliBin, ["status"], consumerDirectory, {
      env: {
        ...process.env,
        BALCONY_SYSTEM_ID: "SYS-A",
        BALCONY_AUTHORIZED_NODE_IDS: "SYS-B,node-c",
        BALCONY_BRIDGE_DB_PATH: path.join(
          temporaryDirectory,
          "status.sqlite3",
        ),
      },
    });
    requireExit(status, 0, "packaged CLI status");
    const statusPayload = JSON.parse(status.stdout);
    if (statusPayload.system_id !== "SYS-A") {
      throw new Error("Packaged CLI status returned an unexpected system identifier");
    }

    const invalid = runInstalledCli(
      cliBin,
      ["not-a-command"],
      consumerDirectory,
    );
    requireExit(invalid, 2, "packaged CLI invalid-command check");
    return packedManifest;
  } finally {
    if (identityDirectory) {
      fs.rmSync(identityDirectory, {
        recursive: true,
        force: true,
        maxRetries: 5,
        retryDelay: 100,
      });
    }
    fs.rmSync(temporaryDirectory, {
      recursive: true,
      force: true,
      maxRetries: 5,
      retryDelay: 100,
    });
  }
}

function packagePeerEnrollment(nodeId) {
  const pair = generateKeyPairSync("ed25519");
  const spkiDer = pair.publicKey.export({ format: "der", type: "spki" });
  return {
    node_id: nodeId,
    keys: [
      {
        key_id: `ed25519:${createHash("sha256").update(spkiDer).digest("base64url")}`,
        spki_der_base64url: spkiDer.toString("base64url"),
        status: "active",
      },
    ],
  };
}

function createPackageIdentityDirectory() {
  const parent = process.platform === "win32" ? process.env.ProgramData : os.tmpdir();
  if (!parent || !path.isAbsolute(parent)) {
    throw new Error("A secure package-verification identity parent is unavailable");
  }
  return fs.mkdtempSync(path.join(parent, "balcony-agent-bridge-identity-"));
}

function assertSamePackageManifest(expected, actual) {
  for (const field of ["filename", "shasum", "integrity", "size", "unpackedSize"]) {
    if (expected[field] !== actual[field]) {
      throw new Error(`Installed tarball differs from dry-run manifest: ${field}`);
    }
  }
  const expectedFiles = expected.files.map((entry) => normalize(entry.path)).sort();
  const actualFiles = actual.files.map((entry) => normalize(entry.path)).sort();
  if (JSON.stringify(expectedFiles) !== JSON.stringify(actualFiles)) {
    throw new Error("Installed tarball file list differs from dry-run manifest");
  }
}

function verifyGeneratedMcpRegistration(registration, temporaryDirectory) {
  const commandMatch = registration.match(/^command = (.+)$/mu);
  const argsMatch = registration.match(/^args = (.+)$/mu);
  const systemIdMatch = registration.match(
    /^env = \{ BALCONY_SYSTEM_ID = (.+) \}$/mu,
  );
  if (!commandMatch || !argsMatch || !systemIdMatch) {
    throw new Error("Generated MCP registration is incomplete");
  }
  const command = JSON.parse(commandMatch[1]);
  const args = JSON.parse(argsMatch[1]);
  const systemId = JSON.parse(systemIdMatch[1]);
  const neutralDirectory = path.join(temporaryDirectory, "neutral-cwd");
  fs.mkdirSync(neutralDirectory);
  const input = [
    JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "package-registration-smoke", version: "0.1.0" },
      },
    }),
    JSON.stringify({
      jsonrpc: "2.0",
      method: "notifications/initialized",
      params: {},
    }),
    JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} }),
    JSON.stringify({
      jsonrpc: "2.0",
      id: 3,
      method: "tools/call",
      params: { name: "agent_bridge_status", arguments: {} },
    }),
    "",
  ].join("\n");
  const result = spawnSync(command, args, {
    cwd: neutralDirectory,
    encoding: "utf8",
    input,
    windowsHide: true,
    timeout: 10_000,
    env: {
      ...process.env,
      BALCONY_SYSTEM_ID: systemId,
    },
  });
  requireExit(result, 0, "generated MCP registration");
  if (
    !result.stdout.includes('"id":1') ||
    !result.stdout.includes('"id":2') ||
    !result.stdout.includes('"id":3')
  ) {
    throw new Error("Generated MCP registration did not complete an MCP status call");
  }
}

function runInstalledCli(binPath, args, cwd, options = {}) {
  if (process.platform === "win32") {
    return spawnSync(binPath, args, {
      cwd,
      encoding: "utf8",
      shell: true,
      windowsHide: true,
      ...options,
    });
  }
  return spawnSync(binPath, args, {
    cwd,
    encoding: "utf8",
    ...options,
  });
}

function prepareIdentityDirectory(directory) {
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  if (process.platform !== "win32") {
    return;
  }
  const systemRoot = process.env.SystemRoot;
  if (!systemRoot || !path.isAbsolute(systemRoot)) {
    throw new Error("Windows SystemRoot is unavailable for package verification");
  }
  const powershellPath = path.join(
    systemRoot,
    "System32",
    "WindowsPowerShell",
    "v1.0",
    "powershell.exe",
  );
  const result = spawnSync(
    powershellPath,
    [
      "-NoLogo",
      "-NoProfile",
      "-NonInteractive",
      "-EncodedCommand",
      Buffer.from(prepareIdentityDirectoryScript, "utf16le").toString("base64"),
    ],
    {
      encoding: "utf8",
      env: { ...process.env, BALCONY_TEST_IDENTITY_DIRECTORY: directory },
      windowsHide: true,
    },
  );
  requireExit(result, 0, "restricted identity-directory preparation");
}

function verifyPackagedReadmeLinks(packagedFiles) {
  const readme = fs.readFileSync(path.join(repositoryRoot, "README.md"), "utf8");
  const relativeLinks = [...readme.matchAll(/\[[^\]]+\]\((?!https?:\/\/|#)([^)]+)\)/giu)]
    .map((match) => normalize(match[1]));
  const missingLinks = relativeLinks.filter(
    (link) => !packagedFiles.includes(link.replace(/^\.\//u, "")),
  );
  if (missingLinks.length > 0) {
    throw new Error(
      `Packaged README links to files outside the package: ${missingLinks.join(", ")}`,
    );
  }
}

function runNpm(args, cwd) {
  const result = spawnSync(process.execPath, [npmCli, ...args], {
    cwd,
    encoding: "utf8",
    windowsHide: true,
  });
  requireExit(result, 0, `npm ${args.join(" ")}`);
  return result;
}

function requireExit(result, expectedCode, description) {
  if (result.error) {
    throw new Error(`${description} failed to start: ${result.error.message}`);
  }
  if (result.status !== expectedCode) {
    throw new Error(
      `${description} exited ${String(result.status)}; stderr: ${result.stderr.trim()}`,
    );
  }
}

function requirePath(targetPath) {
  if (!fs.existsSync(targetPath)) {
    throw new Error(`Installed package is missing: ${targetPath}`);
  }
}

function parsePackResult(output) {
  const parsed = JSON.parse(output);
  if (!Array.isArray(parsed) || parsed.length !== 1) {
    throw new Error("npm pack returned an unexpected manifest");
  }
  return parsed[0];
}

function normalize(filePath) {
  return filePath.replaceAll("\\", "/");
}
