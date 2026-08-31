import { spawnSync } from "node:child_process";
import { createHash, generateKeyPairSync } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const repositoryRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const installCheck = process.argv.includes("--install");
const cleanCache = process.argv.includes("--clean-cache");
const requirePreflight = process.argv.includes("--require-preflight");
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
if (requirePreflight && !installCheck) {
  throw new Error("--require-preflight requires --install");
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
    !file.startsWith("docs/") &&
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
  const temporaryDirectory = fs.realpathSync.native(
    fs.mkdtempSync(
      path.join(os.tmpdir(), "balcony-agent-bridge-package-"),
    ),
  );
  let identityDirectory;
  const onboardingIdentityDirectories = [];
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
    if (!help.stdout.includes("approval  List and decide durable peer resource approval requests")) {
      throw new Error("Packaged CLI help did not contain the approval workflow surface");
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
    const nodeAEnvironment = {
      ...process.env,
      BALCONY_SYSTEM_ID: "node-a",
    };
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
      { env: nodeAEnvironment },
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
      { env: nodeAEnvironment },
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
      { env: nodeAEnvironment },
    );
    requireExit(repeatedSetup, 0, "packaged CLI idempotent setup");
    if (JSON.parse(repeatedSetup.stdout).created !== false) {
      throw new Error("Packaged CLI setup was not idempotent");
    }

    const registeredResource = runInstalledCli(
      cliBin,
      [
        "resource",
        "register",
        "--config",
        profilePath,
        "--resource-id",
        "package-resource",
      ],
      consumerDirectory,
      { env: nodeAEnvironment },
    );
    requireExit(registeredResource, 0, "packaged CLI resource registration");
    const registeredResourcePayload = JSON.parse(registeredResource.stdout);
    if (
      registeredResourcePayload.resource?.resource_id !== "package-resource" ||
      registeredResourcePayload.resource?.enabled !== true
    ) {
      throw new Error("Packaged CLI did not register the expected resource");
    }

    const createdGrant = runInstalledCli(
      cliBin,
      [
        "grant",
        "create",
        "--config",
        profilePath,
        "--peer-id",
        "node-b",
        "--resource-id",
        "package-resource",
      ],
      consumerDirectory,
      { env: nodeAEnvironment },
    );
    requireExit(createdGrant, 0, "packaged CLI grant creation");
    if (JSON.parse(createdGrant.stdout).grant?.state !== "active") {
      throw new Error("Packaged CLI did not create an active resource grant");
    }

    const listedGrants = runInstalledCli(
      cliBin,
      ["grant", "list", "--config", profilePath, "--peer-id", "node-b"],
      consumerDirectory,
      { env: nodeAEnvironment },
    );
    requireExit(listedGrants, 0, "packaged CLI grant listing");
    if (JSON.parse(listedGrants.stdout).grants?.length !== 1) {
      throw new Error("Packaged CLI did not list the expected resource grant");
    }

    const revokedGrant = runInstalledCli(
      cliBin,
      [
        "grant",
        "revoke",
        "--config",
        profilePath,
        "--peer-id",
        "node-b",
        "--resource-id",
        "package-resource",
      ],
      consumerDirectory,
      { env: nodeAEnvironment },
    );
    requireExit(revokedGrant, 0, "packaged CLI grant revocation");
    if (JSON.parse(revokedGrant.stdout).grant?.state !== "revoked") {
      throw new Error("Packaged CLI did not persist resource grant revocation");
    }

    const approvalRequestId = seedPackagedApprovalRequest({
      packageRoot,
      databasePath,
      consumerDirectory,
    });
    const pendingApprovals = runInstalledCli(
      cliBin,
      [
        "approval",
        "list",
        "--config",
        profilePath,
        "--state",
        "pending",
      ],
      consumerDirectory,
      { env: nodeAEnvironment },
    );
    requireExit(pendingApprovals, 0, "packaged CLI approval listing");
    const pendingApprovalPayload = JSON.parse(pendingApprovals.stdout);
    if (
      pendingApprovalPayload.requests?.length !== 1 ||
      pendingApprovalPayload.requests[0]?.request_id !== approvalRequestId ||
      pendingApprovalPayload.requests[0]?.state !== "pending"
    ) {
      throw new Error("Packaged CLI did not list the expected pending approval");
    }

    const approvedOnce = runInstalledCli(
      cliBin,
      [
        "approval",
        "approve-once",
        "--config",
        profilePath,
        "--request-id",
        approvalRequestId,
      ],
      consumerDirectory,
      { env: nodeAEnvironment },
    );
    requireExit(approvedOnce, 0, "packaged CLI approve-once decision");
    if (JSON.parse(approvedOnce.stdout).approval?.state !== "approved_once") {
      throw new Error("Packaged CLI did not persist approve-once state");
    }

    const approvalAudit = runInstalledCli(
      cliBin,
      [
        "approval",
        "audit",
        "--config",
        profilePath,
        "--request-id",
        approvalRequestId,
      ],
      consumerDirectory,
      { env: nodeAEnvironment },
    );
    requireExit(approvalAudit, 0, "packaged CLI approval audit");
    const auditEvents = JSON.parse(approvalAudit.stdout).events;
    if (
      !Array.isArray(auditEvents) ||
      auditEvents.map((event) => event.state).join(",") !==
        "pending,approved_once"
    ) {
      throw new Error("Packaged CLI approval audit was incomplete");
    }

    const defaultDataRoot = path.join(temporaryDirectory, "default-data-root");
    const defaultEnvironment = {
      ...process.env,
      BALCONY_SYSTEM_ID: "default-node",
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
    verifyInstalledOnboarding({
      cliBin,
      consumerDirectory,
      temporaryDirectory,
      onboardingIdentityDirectories,
      requirePreflight,
    });
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
    for (const directory of onboardingIdentityDirectories) {
      fs.rmSync(directory, {
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

function seedPackagedApprovalRequest({
  packageRoot,
  databasePath,
  consumerDirectory,
}) {
  const databaseModule = pathToFileURL(
    path.join(packageRoot, "dist", "storage", "database.js"),
  ).href;
  const envelopeModule = pathToFileURL(
    path.join(packageRoot, "dist", "contracts", "envelope.js"),
  ).href;
  const script = `
    import { BridgeDatabase } from ${JSON.stringify(databaseModule)};
    import { createEnvelope } from ${JSON.stringify(envelopeModule)};
    const database = new BridgeDatabase(process.env.BALCONY_TEST_DATABASE_PATH);
    try {
      const envelope = createEnvelope({
        idempotencyKey: "package-approval-request",
        originSystem: "node-b",
        targetSystem: "node-a",
        kind: "task_request",
        streamId: "package-approval",
        payload: {
          subject: "Package approval smoke",
          body: "Package smoke request body",
          project: "package-resource",
          evidence: [],
          dispatch: { executor: "codex_cli", access: "read_only" }
        }
      });
      database.persistIncoming(envelope, 1, new Date(), true);
      const consumerId = "package-approval-seed";
      const claim = database.claimReadOnlyDispatchInbox(consumerId, 1, 720)[0];
      if (!claim) throw new Error("Packaged approval request was not claimable");
      const decision = database.authorizeClaimedResourceAccess({
        requestMessageId: envelope.message_id,
        consumerId,
        claimToken: claim.claimToken,
        resourceId: "package-resource",
        actorId: "node-a"
      });
      if (decision.status !== "approval_pending") {
        throw new Error("Packaged approval request did not become pending");
      }
      process.stdout.write(envelope.message_id);
    } finally {
      database.close();
    }
  `;
  const seeded = spawnSync(
    process.execPath,
    ["--input-type=module", "--eval", script],
    {
      cwd: consumerDirectory,
      encoding: "utf8",
      windowsHide: true,
      env: {
        ...process.env,
        BALCONY_TEST_DATABASE_PATH: databasePath,
      },
    },
  );
  requireExit(seeded, 0, "packaged approval request seed");
  const requestId = seeded.stdout.trim();
  if (!/^[0-9a-f-]{36}$/iu.test(requestId)) {
    throw new Error("Packaged approval seed returned an invalid request identifier");
  }
  return requestId;
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
  const packagedSet = new Set(packagedFiles);
  const missingLinks = [];
  const markdownFiles = packagedFiles.filter((file) => file.endsWith(".md"));
  for (const markdownFile of markdownFiles) {
    const source = fs.readFileSync(path.join(repositoryRoot, markdownFile), "utf8");
    const markdownLinks = [...source.matchAll(/\[[^\]]+\]\((?!https?:\/\/|mailto:|#)([^)]+)\)/giu)]
      .map((match) => match[1]);
    const inlineDocumentReferences = [...source.matchAll(/(?:\.\/)?docs\/[a-z0-9._/-]+\.md/giu)]
      .map((match) => match[0]);
    for (const rawLink of new Set([...markdownLinks, ...inlineDocumentReferences])) {
      const linkWithoutAnchor = normalize(rawLink.split("#", 1)[0].split("?", 1)[0]);
      const resolvedLink = linkWithoutAnchor.startsWith("docs/")
        ? linkWithoutAnchor
        : normalize(path.posix.normalize(path.posix.join(path.posix.dirname(markdownFile), linkWithoutAnchor)));
      if (!packagedSet.has(resolvedLink)) {
        missingLinks.push(`${markdownFile} -> ${resolvedLink}`);
      }
    }
  }
  if (missingLinks.length > 0) {
    throw new Error(
      `Packaged markdown links to files outside the package: ${missingLinks.join(", ")}`,
    );
  }
}

function verifyInstalledOnboarding({
  cliBin,
  consumerDirectory,
  temporaryDirectory,
  onboardingIdentityDirectories,
  requirePreflight,
}) {
  const onboardingRoot = path.join(temporaryDirectory, "npm-first-onboarding");
  fs.mkdirSync(onboardingRoot);
  const preflight = runInstalledCli(
    cliBin,
    ["preflight", "--root", onboardingRoot],
    consumerDirectory,
  );
  if (![0, 1].includes(preflight.status)) {
    requireExit(preflight, 0, "packaged onboarding preflight");
  }
  const preflightReport = JSON.parse(preflight.stdout);
  const expectedChecks = [
    "node_version",
    "npm_version",
    "powershell_version",
    "git",
    "codex",
    "npm_global_bin_on_path",
    "clock",
    "pilot_root_writable",
    "bridge_artifact",
    "dispatcher_artifact",
  ];
  if (
    typeof preflightReport.ok !== "boolean" ||
    !Array.isArray(preflightReport.checks) ||
    expectedChecks.some((name) =>
      !preflightReport.checks.some((check) => check.id === name)
    )
  ) {
    throw new Error("Packaged onboarding preflight report is incomplete");
  }
  if (requirePreflight && (preflight.status !== 0 || preflightReport.ok !== true)) {
    throw new Error("Release-environment onboarding preflight did not pass");
  }

  const roots = {
    "package-a": path.join(onboardingRoot, "package-a"),
    "package-b": path.join(onboardingRoot, "package-b"),
  };
  const enrollments = {
    "package-a": path.join(onboardingRoot, "package-a-public.json"),
    "package-b": path.join(onboardingRoot, "package-b-public.json"),
  };
  for (const [nodeId, peerId] of [
    ["package-a", "package-b"],
    ["package-b", "package-a"],
  ]) {
    const environment = { ...process.env, BALCONY_SYSTEM_ID: nodeId };
    const start = runInstalledCli(
      cliBin,
      [
        "onboard",
        "start",
        "--root",
        roots[nodeId],
        "--node-id",
        nodeId,
        "--network-id",
        "package-verification",
        "--peer-id",
        peerId,
      ],
      consumerDirectory,
      { env: environment },
    );
    requireExit(start, 0, `packaged onboarding start ${nodeId}`);
    const manifestPath = JSON.parse(start.stdout).manifest_path;
    const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
    onboardingIdentityDirectories.push(manifest.identity_directory);
    const exported = runInstalledCli(
      cliBin,
      [
        "onboard",
        "export-enrollment",
        "--root",
        roots[nodeId],
        "--output",
        enrollments[nodeId],
      ],
      consumerDirectory,
      { env: environment },
    );
    requireExit(exported, 0, `packaged enrollment export ${nodeId}`);
  }

  for (const [nodeId, peerId] of [
    ["package-a", "package-b"],
    ["package-b", "package-a"],
  ]) {
    const root = roots[nodeId];
    const environment = { ...process.env, BALCONY_SYSTEM_ID: nodeId };
    requireExit(runInstalledCli(
      cliBin,
      [
        "onboard",
        "import-peer",
        "--root",
        root,
        "--peer-id",
        peerId,
        "--enrollment",
        enrollments[peerId],
      ],
      consumerDirectory,
      { env: environment },
    ), 0, `packaged peer import ${nodeId}`);
    requireExit(runInstalledCli(
      cliBin,
      ["onboard", "configure-transport", "--root", root, "--local-only"],
      consumerDirectory,
      { env: environment },
    ), 0, `packaged local transport configuration ${nodeId}`);
    requireExit(runInstalledCli(
      cliBin,
      ["runtime", "bridge", "--root", root, "--validate"],
      consumerDirectory,
      { env: environment },
    ), 0, `packaged bridge validation ${nodeId}`);
    if (!requirePreflight) {
      continue;
    }
    let dispatcherConfiguration = runInstalledCli(
      cliBin,
      [
        "onboard",
        "configure-dispatcher",
        "--root",
        root,
        "--project-key",
        "package-consumer",
        "--project-path",
        consumerDirectory,
      ],
      consumerDirectory,
      { env: environment },
    );
    requireExit(
      dispatcherConfiguration,
      1,
      `packaged dispatcher authentication preparation ${nodeId}`,
    );
    const authentication = JSON.parse(dispatcherConfiguration.stdout);
    if (
      authentication.ok !== false ||
      authentication.authentication_required !== true ||
      typeof authentication.codex_home !== "string"
    ) {
      throw new Error(
        `Packaged dispatcher did not surface dedicated-home authentication for ${nodeId}`,
      );
    }
    const codexHome = authentication.codex_home;
    onboardingIdentityDirectories.push(codexHome);
    fs.writeFileSync(
      path.join(codexHome, "auth.json"),
      `${JSON.stringify({
        auth_mode: "chatgpt",
        tokens: { access_token: "package-verification-placeholder" },
      })}\n`,
      { encoding: "utf8", flag: "wx", mode: 0o600 },
    );
    dispatcherConfiguration = runInstalledCli(
      cliBin,
      [
        "onboard",
        "configure-dispatcher",
        "--root",
        root,
        "--project-key",
        "package-consumer",
        "--project-path",
        consumerDirectory,
      ],
      consumerDirectory,
      { env: environment },
    );
    requireExit(
      dispatcherConfiguration,
      0,
      `packaged dispatcher configuration ${nodeId}`,
    );
    if (JSON.parse(dispatcherConfiguration.stdout).dispatcher.codex_home !== codexHome) {
      throw new Error(`Packaged dispatcher changed its dedicated Codex home for ${nodeId}`);
    }
    requireExit(runInstalledCli(
      cliBin,
      ["onboard", "configure-mcp", "--root", root],
      consumerDirectory,
      { env: environment },
    ), 0, `packaged MCP registration ${nodeId}`);
    requireExit(runInstalledCli(
      cliBin,
      ["runtime", "dispatcher", "--root", root, "--validate"],
      consumerDirectory,
      { env: environment },
    ), 0, `packaged dispatcher validation ${nodeId}`);
    const verified = runInstalledCli(
      cliBin,
      ["onboard", "verify", "--root", root],
      consumerDirectory,
      { env: environment },
    );
    requireExit(verified, 0, `packaged onboarding verification ${nodeId}`);
    if (JSON.parse(verified.stdout).ok !== true) {
      throw new Error(`Packaged onboarding did not verify ${nodeId}`);
    }
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
