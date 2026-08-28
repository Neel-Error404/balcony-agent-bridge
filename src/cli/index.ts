#!/usr/bin/env node

import os from "node:os";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { parseArgs } from "node:util";
import { fileURLToPath } from "node:url";

import {
  assertConfigMatchesProcessIdentity,
  assertSystemIdMatchesProcessIdentity,
  loadConfig,
  loadConfigFile,
} from "../config.js";
import { NodeIdSchema } from "../contracts/envelope.js";
import { AuthorizationRequestStateSchema } from "../contracts/approval.js";
import { ResourceIdSchema } from "../contracts/resource-authorization.js";
import { StateTransitionError } from "../errors.js";
import { generateNodeIdentity } from "../security/node-identity.js";
import { safeErrorCode } from "../security/sanitize-error.js";
import { runPreflight } from "../onboarding/preflight.js";
import {
  exportOnboardingEnrollment,
  generateOnboardingIdentity,
  importPublicEnrollment,
  readOnboardingManifest,
  resumeOnboarding,
  startOnboarding,
  statusOnboarding,
  writeMembershipPolicy,
} from "../onboarding/index.js";
import {
  configureDispatcher,
  configureMcp,
  configureTransport,
  readRuntimeSettings,
} from "../onboarding/runtime-settings.js";
import {
  buildBridgeLaunch,
  buildDispatcherLaunch,
} from "../onboarding/foreground-runtime.js";
import { setupLocalProfile } from "../setup/local-profile.js";
import { BridgeDatabase } from "../storage/database.js";
import { runDoctor } from "./doctor.js";
import { runLocalDemo } from "./local-demo.js";

const usage = `Usage: balcony-agent-bridge <command> [options]

Commands:
  demo      Run a deterministic three-node demo without Azure
  identity  Generate an offline Ed25519 node identity and public enrollment
  setup     Create an idempotent local node profile and SQLite database
  doctor    Diagnose the runtime, profile, database, and optional transport
  status    Print local durable bridge status as JSON
  resource  Register, list, enable, or disable local resources
  grant     Create, list, or revoke per-peer resource grants
  approval  List and decide durable peer resource approval requests
  preflight Check npm-first local prerequisites without installing anything
  onboard   Prepare and verify resumable npm-first onboarding artifacts
  runtime   Run or validate the supported foreground bridge and dispatcher
  help      Show this help message

Common options:
  --config <absolute-path>       Use an explicit local profile

Setup options:
  --node-id <id>                 Stable identifier for this node (required)
  --authorized-node <id>         Authorized peer; repeat for each peer (required)
  --database <absolute-path>     SQLite path (defaults beside the profile)
  --servicebus-namespace <host>  Optional Azure Service Bus namespace
  --subscription <name>          Optional subscription name
  --auth-mode <mode>             managed_identity or client_certificate
  --managed-identity-client-id <uuid>
  --azure-tenant-id <uuid>
  --azure-client-id <uuid>
  --azure-client-certificate-path <absolute-path>

Identity options:
  --node-id <id>                 Stable identifier for this node (required)
  --output-directory <path>      Absolute directory for new identity files

Resource options:
  resource register --resource-id <id> [--config <absolute-path>]
  resource list [--config <absolute-path>]
  resource enable --resource-id <id> [--config <absolute-path>]
  resource disable --resource-id <id> [--config <absolute-path>]

Grant options:
  grant create --peer-id <id> --resource-id <id> [--config <absolute-path>]
  grant list [--peer-id <id>] [--config <absolute-path>]
  grant revoke --peer-id <id> --resource-id <id> [--config <absolute-path>]

Approval options:
  approval list [--state <state>] [--config <absolute-path>]
  approval show --request-id <uuid> [--config <absolute-path>]
  approval approve-once --request-id <uuid> [--config <absolute-path>]
  approval approve-temporary --request-id <uuid> --expires-at-utc <utc> [--config <absolute-path>]
  approval deny --request-id <uuid> [--reason <text>] [--config <absolute-path>]
  approval revoke --request-id <uuid> [--reason <text>] [--config <absolute-path>]
  approval audit [--request-id <uuid>] [--peer-id <id>] [--resource-id <id>] [--config <absolute-path>]

Examples:
  balcony-agent-bridge demo
  $env:BALCONY_SYSTEM_ID="laptop-a"; balcony-agent-bridge identity --node-id laptop-a --output-directory C:\\path\\to\\identity
  $env:BALCONY_SYSTEM_ID="laptop-a"; balcony-agent-bridge setup --node-id laptop-a --authorized-node laptop-b
  balcony-agent-bridge doctor --config C:\\path\\to\\config.json
`;

const commandUsages: Readonly<Record<string, string>> = {
  identity: `Usage: balcony-agent-bridge identity --node-id <id> --output-directory <absolute-path>\n`,
  setup: `Usage: balcony-agent-bridge setup --node-id <id> --authorized-node <id> [--authorized-node <id>...] [options]\n`,
  doctor: `Usage: balcony-agent-bridge doctor [--config <absolute-path>] [--check-transport]\n`,
  status: `Usage: balcony-agent-bridge status [--config <absolute-path>]\n`,
  resource: `Usage: balcony-agent-bridge resource <register|list|enable|disable> [options]\n`,
  grant: `Usage: balcony-agent-bridge grant <create|list|revoke> [options]\n`,
  approval: `Usage: balcony-agent-bridge approval <list|show|approve-once|approve-temporary|deny|revoke|audit> [options]\n`,
  preflight: `Usage: balcony-agent-bridge preflight --root <absolute-path>\n`,
  onboard: `Usage: balcony-agent-bridge onboard <action> [options]

Actions:
  start                  Create or resume a node (--root, --node-id, --network-id, --peer-id)
  status                 Inspect artifacts and runtime state (--root)
  export-enrollment      Write public enrollment only (--root, --output)
  import-peer            Import one expected public peer (--root, --peer-id, --enrollment)
  configure-transport    Create local profile/database (--root, exactly one of --local-only or --servicebus-namespace)
  configure-dispatcher   Pin Codex and one readable project (--root, --project-key, --project-path)
  configure-mcp          Register MCP in the dedicated Codex home (--root)
  verify                 Revalidate the complete local onboarding state (--root)

Run balcony-agent-bridge onboard <action> --help for exact options.
`,
  "onboard:start": `Usage: balcony-agent-bridge onboard start --root <absolute-path> --node-id <id> --network-id <id> --peer-id <id> [--peer-id <id>...]\n`,
  "onboard:status": `Usage: balcony-agent-bridge onboard status --root <absolute-path>\n`,
  "onboard:export-enrollment": `Usage: balcony-agent-bridge onboard export-enrollment --root <absolute-path> --output <absolute-json-path>\n`,
  "onboard:import-peer": `Usage: balcony-agent-bridge onboard import-peer --root <absolute-path> --peer-id <id> --enrollment <absolute-json-path>\n`,
  "onboard:configure-transport": `Usage: balcony-agent-bridge onboard configure-transport --root <absolute-path> (--local-only | --servicebus-namespace <host>) [--topic <name>] [--subscription <name>] [--auth-mode <mode>]\n`,
  "onboard:configure-dispatcher": `Usage: balcony-agent-bridge onboard configure-dispatcher --root <absolute-path> --project-key <key> --project-path <absolute-path> [--codex-executable <absolute-path> --code-mode-host-executable <absolute-path>]\n`,
  "onboard:configure-mcp": `Usage: balcony-agent-bridge onboard configure-mcp --root <absolute-path> [--codex-executable <pinned-absolute-path>]\n`,
  "onboard:verify": `Usage: balcony-agent-bridge onboard verify --root <absolute-path>\n`,
  runtime: `Usage: balcony-agent-bridge runtime <bridge|dispatcher> --root <absolute-path> [--validate]

  bridge       Run the signed Azure transport in the foreground after owner-provisioned topology exists
  dispatcher   Run the read-only Codex dispatcher in the foreground
  --validate   Validate configuration and exit without entering a runtime loop
`,
  "runtime:bridge": `Usage: balcony-agent-bridge runtime bridge --root <absolute-path> [--validate]\n`,
  "runtime:dispatcher": `Usage: balcony-agent-bridge runtime dispatcher --root <absolute-path> [--validate]\n`,
};

class CliUsageError extends Error {}

await main();

async function main(): Promise<void> {
  const command = process.argv[2];
  if (command === undefined || command === "help" || command === "--help") {
    process.stdout.write(usage);
    return;
  }
  if (command === "--version" || command === "-v") {
    process.stdout.write(`${readPackageVersion()}\n`);
    return;
  }
  if (process.argv.at(-1) === "--help") {
    const action = process.argv.length === 5 ? process.argv[3] : undefined;
    const commandUsage = commandUsages[action ? `${command}:${action}` : command];
    if (commandUsage === undefined) {
      process.stderr.write(`${usage}\n`);
      process.exitCode = 2;
      return;
    }
    process.stdout.write(commandUsage);
    return;
  }

  try {
    switch (command) {
      case "demo":
        requireNoArguments(process.argv.slice(3));
        writeJson(await runLocalDemo());
        return;
      case "identity":
        runIdentity(process.argv.slice(3));
        return;
      case "setup":
        runSetup(process.argv.slice(3));
        return;
      case "doctor":
        await runDoctorCommand(process.argv.slice(3));
        return;
      case "status":
        runStatus(process.argv.slice(3));
        return;
      case "resource":
        runResource(process.argv.slice(3));
        return;
      case "grant":
        runGrant(process.argv.slice(3));
        return;
      case "approval":
        runApproval(process.argv.slice(3));
        return;
      case "preflight":
        runPreflightCommand(process.argv.slice(3));
        return;
      case "onboard":
        runOnboard(process.argv.slice(3));
        return;
      case "runtime":
        runForegroundRuntime(process.argv.slice(3));
        return;
      default:
        throw new CliUsageError(`Unknown command: ${command}`);
    }
  } catch (error) {
    if (error instanceof CliUsageError || isParseArgsError(error)) {
      process.stderr.write(`${commandUsages[command] ?? usage}\n`);
      process.exitCode = 2;
      return;
    }
    process.stderr.write(
      `${command} failed (${safeErrorCode(error).toUpperCase()})\n`,
    );
    process.exitCode = 1;
  }
}

function runPreflightCommand(args: readonly string[]): void {
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    strict: true,
    options: { root: { type: "string" } },
  });
  if (positionals.length > 0 || !values.root) {
    throw new CliUsageError("preflight requires --root");
  }
  const report = runPreflight({
    pilotRoot: requireAbsolute(values.root, "--root"),
  });
  writeJson(report);
  process.exitCode = report.ok ? 0 : 1;
}

function runOnboard(args: readonly string[]): void {
  const action = args[0];
  if (!action) throw new CliUsageError("onboard requires an action");
  const { values, positionals } = parseArgs({
    args: args.slice(1),
    allowPositionals: true,
    strict: true,
    options: {
      help: { type: "boolean", short: "h" },
      root: { type: "string" },
      "node-id": { type: "string" },
      "network-id": { type: "string" },
      "peer-id": { type: "string", multiple: true },
      enrollment: { type: "string" },
      output: { type: "string" },
      "servicebus-namespace": { type: "string" },
      topic: { type: "string" },
      subscription: { type: "string" },
      "auth-mode": { type: "string" },
      "local-only": { type: "boolean" },
      "managed-identity-client-id": { type: "string" },
      "azure-tenant-id": { type: "string" },
      "azure-client-id": { type: "string" },
      "azure-client-certificate-path": { type: "string" },
      "project-key": { type: "string" },
      "project-path": { type: "string" },
      "codex-executable": { type: "string" },
      "code-mode-host-executable": { type: "string" },
    },
  });
  if (positionals.length > 0) {
    throw new CliUsageError("onboard does not accept extra positional arguments");
  }
  if (values.help) {
    process.stdout.write(`${commandUsages["onboard"]}Action: ${action}\n`);
    return;
  }
  if (!values.root) throw new CliUsageError("onboard requires --root");
  const root = requireAbsolute(values.root, "--root");
  const manifestPath = path.join(root, "onboarding-manifest.json");

  switch (action) {
    case "start": {
      if (!values["node-id"] || !values["network-id"] || !values["peer-id"]?.length) {
        throw new CliUsageError(
          "onboard start requires --node-id, --network-id, and at least one --peer-id",
        );
      }
      const nodeId = NodeIdSchema.parse(values["node-id"]);
      const peerIds = values["peer-id"].map((value) => NodeIdSchema.parse(value));
      if (new Set(peerIds).size !== peerIds.length) {
        throw new CliUsageError("onboard start peer IDs must be unique");
      }
      peerIds.sort();
      const manifest = startOnboarding({
        root,
        nodeId,
        processIdentity: process.env["BALCONY_SYSTEM_ID"],
        networkId: values["network-id"],
        authorizedNodeIds: peerIds,
      });
      const withIdentity = generateOnboardingIdentity({
        manifestPath: manifest.manifestPath,
      });
      writeJson({
        ok: true,
        status: withIdentity.status,
        node_id: withIdentity.node_id,
        network_id: withIdentity.network_id,
        authorized_node_ids: withIdentity.authorized_node_ids,
        manifest_path: withIdentity.manifestPath,
        enrollment_path: withIdentity.local_enrollment_path,
        key_id: withIdentity.local_enrollment?.key_id,
      });
      return;
    }
    case "status": {
      const report = statusOnboarding(manifestPath);
      const runtime = report.status === "blocked"
        ? undefined
        : readRuntimeSettings(manifestPath);
      writeJson({ ...report, ...(runtime ? { runtime } : {}) });
      process.exitCode = report.status === "blocked" ? 1 : 0;
      return;
    }
    case "export-enrollment": {
      if (!values.output) {
        throw new CliUsageError("export-enrollment requires --output");
      }
      const exported = exportOnboardingEnrollment(
        manifestPath,
        requireAbsolute(values.output, "--output"),
      );
      writeJson({
        ok: true,
        output_path: exported.outputPath,
        node_id: exported.enrollment.node_id,
        key_id: exported.enrollment.key_id,
      });
      return;
    }
    case "import-peer": {
      if (!values.enrollment || values["peer-id"]?.length !== 1) {
        throw new CliUsageError(
          "import-peer requires one --peer-id and --enrollment",
        );
      }
      const updated = importPublicEnrollment({
        manifestPath,
        inputPath: requireAbsolute(values.enrollment, "--enrollment"),
        expectedPeerId: NodeIdSchema.parse(values["peer-id"][0]),
      });
      const allImported = updated.authorized_node_ids.every((peerId) =>
        Boolean(updated.enrollments[peerId])
      );
      if (allImported) writeMembershipPolicy(manifestPath);
      const report = resumeOnboarding(manifestPath);
      writeJson({
        ok: true,
        imported_peer_id: values["peer-id"][0],
        status: report.status,
        membership_ready: Boolean(report.artifacts["membership"]?.present),
      });
      return;
    }
    case "configure-transport": {
      const authMode = values["auth-mode"] ?? "managed_identity";
      if (!isAzureAuthMode(authMode)) {
        throw new CliUsageError("--auth-mode must be managed_identity or client_certificate");
      }
      const settings = configureTransport({
        manifestPath,
        packageRoot: installedPackageRoot(),
        authMode,
        localOnly: values["local-only"] ?? false,
        ...(values.topic ? { topicName: values.topic } : {}),
        ...(values.subscription ? { subscriptionName: values.subscription } : {}),
        ...(values["servicebus-namespace"]
          ? { serviceBusNamespace: values["servicebus-namespace"] }
          : {}),
        ...(values["managed-identity-client-id"]
          ? { managedIdentityClientId: values["managed-identity-client-id"] }
          : {}),
        ...(values["azure-tenant-id"]
          ? { azureTenantId: values["azure-tenant-id"] }
          : {}),
        ...(values["azure-client-id"]
          ? { azureClientId: values["azure-client-id"] }
          : {}),
        ...(values["azure-client-certificate-path"]
          ? { azureClientCertificatePath: values["azure-client-certificate-path"] }
          : {}),
      });
      writeJson({ ok: true, transport: settings.transport });
      return;
    }
    case "configure-dispatcher": {
      if (!values["project-key"] || !values["project-path"]) {
        throw new CliUsageError(
          "configure-dispatcher requires --project-key and --project-path",
        );
      }
      if (
        Boolean(values["codex-executable"]) !==
        Boolean(values["code-mode-host-executable"])
      ) {
        throw new CliUsageError(
          "--codex-executable and --code-mode-host-executable must be supplied together",
        );
      }
      const discovered = values["codex-executable"] &&
          values["code-mode-host-executable"]
        ? undefined
        : discoverCodexBinaries();
      const settings = configureDispatcher({
        manifestPath,
        projectKey: values["project-key"],
        projectPath: requireAbsolute(values["project-path"], "--project-path"),
        codexExecutable: values["codex-executable"]
          ? requireAbsolute(values["codex-executable"], "--codex-executable")
          : discovered!.codexExecutable,
        codeModeHostExecutable: values["code-mode-host-executable"]
          ? requireAbsolute(
              values["code-mode-host-executable"],
              "--code-mode-host-executable",
            )
          : discovered!.codeModeHostExecutable,
      });
      writeJson({ ok: true, dispatcher: settings.dispatcher });
      return;
    }
    case "configure-mcp": {
      const settings = readRuntimeSettings(manifestPath);
      if (!settings.dispatcher) {
        throw new CliUsageError(
          "configure-dispatcher must complete before configure-mcp",
        );
      }
      const codexExecutable = values["codex-executable"]
        ? requireAbsolute(values["codex-executable"], "--codex-executable")
        : settings.dispatcher.codex_executable;
      const updated = configureMcp({
        manifestPath,
        codexExecutable,
        packageRoot: installedPackageRoot(),
      });
      writeJson({ ok: true, mcp: updated.mcp });
      return;
    }
    case "verify": {
      const report = resumeOnboarding(manifestPath);
      const settings = readRuntimeSettings(manifestPath);
      const ok = report.status === "complete" && Boolean(
        settings.transport && settings.dispatcher && settings.mcp,
      );
      writeJson({
        ok,
        status: report.status,
        transport_configured: Boolean(settings.transport),
        dispatcher_configured: Boolean(settings.dispatcher),
        mcp_configured: Boolean(settings.mcp),
        azure_owner_action_required:
          !settings.transport?.servicebus_namespace,
      });
      process.exitCode = ok ? 0 : 1;
      return;
    }
    default:
      throw new CliUsageError(`unknown onboard action: ${action}`);
  }
}

function runForegroundRuntime(args: readonly string[]): void {
  const runtime = args[0];
  if (runtime !== "bridge" && runtime !== "dispatcher") {
    throw new CliUsageError("runtime requires bridge or dispatcher");
  }
  const { values, positionals } = parseArgs({
    args: args.slice(1),
    allowPositionals: true,
    strict: true,
    options: {
      root: { type: "string" },
      validate: { type: "boolean" },
      help: { type: "boolean", short: "h" },
    },
  });
  if (positionals.length > 0) {
    throw new CliUsageError("runtime does not accept extra positional arguments");
  }
  if (values.help) {
    process.stdout.write(`${commandUsages["runtime"]}Runtime: ${runtime}\n`);
    return;
  }
  if (!values.root) throw new CliUsageError("runtime requires --root");
  const root = requireAbsolute(values.root, "--root");
  const manifestPath = path.join(root, "onboarding-manifest.json");
  const manifest = readOnboardingManifest(manifestPath);
  const settings = readRuntimeSettings(manifestPath);
  if (!settings.transport) {
    throw new CliUsageError("configure transport before starting a runtime");
  }
  if (
    runtime === "bridge" &&
    !values.validate &&
    !settings.transport.servicebus_namespace
  ) {
    throw new StateTransitionError(
      "Azure transport metadata is required to start the bridge; infrastructure creation remains an owner action",
    );
  }
  if (runtime === "dispatcher" && !settings.dispatcher) {
    throw new CliUsageError("configure the dispatcher before starting it");
  }
  const launch = runtime === "bridge"
    ? buildBridgeLaunch({
        packageRoot: installedPackageRoot(),
        configPath: settings.transport.profile_path,
        nodeId: manifest.node_id,
        networkId: manifest.network_id,
        membershipPath: manifest.membership_path,
        signingKeyPath: manifest.signing_key_path,
        azure: {
          authMode: settings.transport.auth_mode,
          ...(settings.transport.servicebus_namespace
            ? { serviceBusNamespace: settings.transport.servicebus_namespace }
            : {}),
          topicName: settings.transport.topic_name,
          subscriptionName: settings.transport.subscription_name,
          ...(settings.transport.managed_identity_client_id
            ? { managedIdentityClientId: settings.transport.managed_identity_client_id }
            : {}),
          ...(settings.transport.azure_tenant_id
            ? { tenantId: settings.transport.azure_tenant_id }
            : {}),
          ...(settings.transport.azure_client_id
            ? { clientId: settings.transport.azure_client_id }
            : {}),
          ...(settings.transport.azure_client_certificate_path
            ? { clientCertificatePath: settings.transport.azure_client_certificate_path }
            : {}),
        },
        validateOnly: values.validate ?? false,
      })
    : buildDispatcherLaunch({
        packageRoot: installedPackageRoot(),
        configPath: settings.transport.profile_path,
        nodeId: manifest.node_id,
        projectsConfigPath: settings.dispatcher?.projects_path ?? "",
        codexExecutable: settings.dispatcher?.codex_executable ?? "",
        codexSha256: settings.dispatcher?.codex_sha256 ?? "",
        codeModeHostExecutable:
          settings.dispatcher?.code_mode_host_executable ?? "",
        codeModeHostSha256:
          settings.dispatcher?.code_mode_host_sha256 ?? "",
        codexHome: settings.dispatcher?.codex_home ?? "",
        ...(settings.dispatcher?.trusted_path
          ? { trustedPath: settings.dispatcher.trusted_path }
          : {}),
        validateOnly: values.validate ?? false,
      });
  const child = spawnSync(launch.command, launch.args, {
    cwd: root,
    env: runtimeEnvironment(launch.env, runtime),
    stdio: "inherit",
    windowsHide: true,
  });
  if (child.error || child.status !== 0) {
    throw new StateTransitionError(`${runtime} foreground runtime exited unsuccessfully`);
  }
  if (values.validate) writeJson({ ok: true, runtime });
}

function installedPackageRoot(): string {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
}

function isAzureAuthMode(
  value: string,
): value is "managed_identity" | "client_certificate" {
  return value === "managed_identity" || value === "client_certificate";
}

function discoverCodexBinaries(): {
  codexExecutable: string;
  codeModeHostExecutable: string;
} {
  if (process.platform !== "win32") {
    throw new StateTransitionError(
      "Automatic Codex dispatcher discovery is currently supported only on Windows; pass both executable paths explicitly",
    );
  }
  const npmCli = path.join(
    path.dirname(process.execPath),
    "node_modules",
    "npm",
    "bin",
    "npm-cli.js",
  );
  if (!fs.existsSync(npmCli)) {
    throw new StateTransitionError("Unable to locate npm beside the active Node.js runtime");
  }
  const npmResult = spawnSync(process.execPath, [npmCli, "root", "--global"], {
    encoding: "utf8",
    windowsHide: true,
    timeout: 10_000,
  });
  if (npmResult.error || npmResult.status !== 0) {
    throw new StateTransitionError("Unable to resolve the global npm package root");
  }
  const codexPackage = path.join(
    npmResult.stdout.trim(),
    "@openai",
    "codex",
  );
  let candidates: string[];
  try {
    candidates = fs.readdirSync(codexPackage, {
      recursive: true,
      encoding: "utf8",
    }).filter((entry) => path.basename(entry).toLowerCase() === "codex.exe")
      .map((entry) => path.join(codexPackage, entry))
      .filter((entry) =>
        fs.existsSync(path.join(path.dirname(entry), "codex-code-mode-host.exe"))
      );
  } catch {
    throw new StateTransitionError(
      "Unable to inspect the installed Codex package; rerun preflight or pass executable paths explicitly",
    );
  }
  if (candidates.length !== 1) {
    throw new StateTransitionError(
      "Unable to identify one pinned Codex runtime pair; pass both executable paths explicitly",
    );
  }
  return {
    codexExecutable: candidates[0]!,
    codeModeHostExecutable: path.join(
      path.dirname(candidates[0]!),
      "codex-code-mode-host.exe",
    ),
  };
}

function runtimeEnvironment(
  additions: Readonly<Record<string, string>>,
  runtime: "bridge" | "dispatcher",
): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value === undefined) continue;
    const upper = key.toUpperCase();
    if (
      upper === "BALCONY_SYSTEM_ID" ||
      upper === "BALCONY_LOCAL_CONFIG" ||
      upper.startsWith("BALCONY_MESSAGE_AUTH_") ||
      upper.startsWith("BALCONY_SERVICEBUS_") ||
      upper.startsWith("BALCONY_AZURE_") ||
      upper.startsWith("BALCONY_DISPATCHER_") ||
      upper.startsWith("BALCONY_CODEX_") ||
      upper.includes("TOKEN") ||
      upper.includes("PASSWORD") ||
      upper.includes("CONNECTION_STRING") ||
      upper.includes("CLIENT_SECRET")
    ) continue;
    environment[key] = value;
  }
  Object.assign(environment, additions);
  if (runtime === "dispatcher") {
    for (const key of Object.keys(environment)) {
      const upper = key.toUpperCase();
      if (
        upper.startsWith("AZURE_") ||
        upper.startsWith("BALCONY_AZURE_") ||
        upper.startsWith("BALCONY_SERVICEBUS_") ||
        upper.startsWith("BALCONY_MESSAGE_AUTH_")
      ) delete environment[key];
    }
  }
  return environment;
}

function readPackageVersion(): string {
  const packagePath = path.join(installedPackageRoot(), "package.json");
  const manifest = JSON.parse(fs.readFileSync(packagePath, "utf8")) as {
    version?: unknown;
  };
  if (typeof manifest.version !== "string") {
    throw new CliUsageError("package version is unavailable");
  }
  return manifest.version;
}

function runIdentity(args: readonly string[]): void {
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    strict: true,
    options: {
      "node-id": { type: "string" },
      "output-directory": { type: "string" },
    },
  });
  if (
    positionals.length > 0 ||
    !values["node-id"] ||
    !values["output-directory"]
  ) {
    throw new CliUsageError(
      "identity requires a node ID and an absolute output directory",
    );
  }
  const nodeId = NodeIdSchema.parse(values["node-id"]);
  assertSystemIdMatchesProcessIdentity(nodeId);
  const result = generateNodeIdentity({
    nodeId,
    outputDirectory: requireAbsolute(
      values["output-directory"],
      "--output-directory",
    ),
  });
  writeJson({
    ok: true,
    node_id: nodeId,
    key_id: result.keyId,
    signing_key_path: result.signingKeyPath,
    enrollment_path: result.enrollmentPath,
    enrollment: result.enrollment,
  });
}

function runSetup(args: readonly string[]): void {
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    strict: true,
    options: {
      config: { type: "string" },
      database: { type: "string" },
      "node-id": { type: "string" },
      "authorized-node": { type: "string", multiple: true },
      "servicebus-namespace": { type: "string" },
      subscription: { type: "string" },
      "auth-mode": { type: "string" },
      "managed-identity-client-id": { type: "string" },
      "azure-tenant-id": { type: "string" },
      "azure-client-id": { type: "string" },
      "azure-client-certificate-path": { type: "string" },
    },
  });
  if (positionals.length > 0 || !values["node-id"] || !values["authorized-node"]?.length) {
    throw new CliUsageError("setup requires a node ID and at least one authorized node");
  }
  if (values["auth-mode"] && !["managed_identity", "client_certificate"].includes(values["auth-mode"])) {
    throw new CliUsageError("invalid authentication mode");
  }

  const configPath = values.config
    ? requireAbsolute(values.config, "--config")
    : path.join(defaultDataDirectory(), "config.json");
  const databasePath = values.database
    ? requireAbsolute(values.database, "--database")
    : path.join(path.dirname(configPath), "bridge.sqlite3");
  const nodeId = NodeIdSchema.parse(values["node-id"]);
  assertSystemIdMatchesProcessIdentity(nodeId);
  const authorizedNodeIds = values["authorized-node"].map((value) =>
    NodeIdSchema.parse(value),
  );
  const result = setupLocalProfile({
    configPath,
    databasePath,
    nodeId,
    authorizedNodeIds,
    mcpCommand: process.execPath,
    mcpCommandArgs: [
      path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../mcp/index.js"),
    ],
    ...(values.subscription ? { subscriptionName: values.subscription } : {}),
    ...(values["servicebus-namespace"]
      ? { serviceBusNamespace: values["servicebus-namespace"] }
      : {}),
    ...(values["auth-mode"]
      ? {
          azureAuthMode: values["auth-mode"] as
            | "managed_identity"
            | "client_certificate",
        }
      : {}),
    ...(values["managed-identity-client-id"]
      ? { managedIdentityClientId: values["managed-identity-client-id"] }
      : {}),
    ...(values["azure-tenant-id"]
      ? { azureTenantId: values["azure-tenant-id"] }
      : {}),
    ...(values["azure-client-id"]
      ? { azureClientId: values["azure-client-id"] }
      : {}),
    ...(values["azure-client-certificate-path"]
      ? {
          azureClientCertificatePath:
            values["azure-client-certificate-path"],
        }
      : {}),
  });
  writeJson({
    ok: true,
    created: result.created,
    config_path: result.configPath,
    database_path: result.databasePath,
    mcp_registration: result.mcpRegistration,
  });
}

async function runDoctorCommand(args: readonly string[]): Promise<void> {
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    strict: true,
    options: {
      config: { type: "string" },
      "check-transport": { type: "boolean" },
    },
  });
  if (positionals.length > 0) {
    throw new CliUsageError("doctor does not accept positional arguments");
  }
  const configPath = values.config
    ? requireAbsolute(values.config, "--config")
    : undefined;
  const report = await runDoctor({
    checkTransport: values["check-transport"] ?? false,
    ...(configPath === undefined ? {} : { configPath }),
    loadConfig: configPath
      ? () =>
          assertConfigMatchesProcessIdentity(
            loadConfigFile(configPath),
          )
      : loadConfig,
  });
  writeJson(report);
  process.exitCode = report.exitCode;
}

function runStatus(args: readonly string[]): void {
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    strict: true,
    options: { config: { type: "string" } },
  });
  if (positionals.length > 0) {
    throw new CliUsageError("status does not accept positional arguments");
  }
  const config = values.config
    ? assertConfigMatchesProcessIdentity(
        loadConfigFile(requireAbsolute(values.config, "--config")),
      )
    : loadConfig();
  const database = new BridgeDatabase(config.databasePath);
  try {
    writeJson({
      system_id: config.systemId,
      authorized_node_ids: config.authorizedNodeIds,
      ...database.getStatus(),
    });
  } finally {
    database.close();
  }
}

function runResource(args: readonly string[]): void {
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    strict: true,
    options: {
      config: { type: "string" },
      "resource-id": { type: "string" },
    },
  });
  if (positionals.length !== 1) {
    throw new CliUsageError("resource requires exactly one action");
  }
  const action = positionals[0]!;
  if (!["register", "list", "enable", "disable"].includes(action)) {
    throw new CliUsageError("invalid resource action");
  }
  if (action === "list" && values["resource-id"]) {
    throw new CliUsageError("resource list does not accept --resource-id");
  }
  if (action !== "list" && !values["resource-id"]) {
    throw new CliUsageError(`${action} requires --resource-id`);
  }

  const config = loadCliConfig(values.config);
  const database = new BridgeDatabase(config.databasePath);
  try {
    if (action === "list") {
      writeJson({
        resources: database.listResources().map(formatResource),
      });
      return;
    }
    const resourceId = ResourceIdSchema.parse(values["resource-id"]);
    const resource = action === "register"
      ? database.registerResource(resourceId)
      : database.setResourceEnabled(resourceId, action === "enable");
    writeJson({ ok: true, resource: formatResource(resource) });
  } finally {
    database.close();
  }
}

function runGrant(args: readonly string[]): void {
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    strict: true,
    options: {
      config: { type: "string" },
      "peer-id": { type: "string" },
      "resource-id": { type: "string" },
    },
  });
  if (positionals.length !== 1) {
    throw new CliUsageError("grant requires exactly one action");
  }
  const action = positionals[0]!;
  if (!["create", "list", "revoke"].includes(action)) {
    throw new CliUsageError("invalid grant action");
  }
  if (action === "list" && values["resource-id"]) {
    throw new CliUsageError("grant list does not accept --resource-id");
  }
  if (action !== "list" && (!values["peer-id"] || !values["resource-id"])) {
    throw new CliUsageError(`${action} requires --peer-id and --resource-id`);
  }

  const config = loadCliConfig(values.config);
  const peerId = values["peer-id"]
    ? NodeIdSchema.parse(values["peer-id"])
    : undefined;
  if (peerId && !config.authorizedNodeIds.includes(peerId)) {
    throw new CliUsageError("--peer-id must be an authorized remote node");
  }
  const database = new BridgeDatabase(config.databasePath);
  try {
    if (action === "list") {
      writeJson({
        grants: database.listPeerResourceGrants(peerId).map(formatGrant),
      });
      return;
    }
    const resourceId = ResourceIdSchema.parse(values["resource-id"]);
    const grant = action === "create"
      ? database.grantPeerResource(peerId!, resourceId)
      : database.revokePeerResource(
          peerId!,
          resourceId,
          new Date(),
          config.systemId,
        );
    writeJson({ ok: true, grant: formatGrant(grant) });
  } finally {
    database.close();
  }
}

function runApproval(args: readonly string[]): void {
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    strict: true,
    options: {
      config: { type: "string" },
      "request-id": { type: "string" },
      state: { type: "string" },
      "peer-id": { type: "string" },
      "resource-id": { type: "string" },
      "expires-at-utc": { type: "string" },
      reason: { type: "string" },
    },
  });
  if (positionals.length !== 1) {
    throw new CliUsageError("approval requires exactly one action");
  }
  const action = positionals[0]!;
  const actions = [
    "list",
    "show",
    "approve-once",
    "approve-temporary",
    "deny",
    "revoke",
    "audit",
  ];
  if (!actions.includes(action)) {
    throw new CliUsageError("invalid approval action");
  }
  const requestActions = [
    "show",
    "approve-once",
    "approve-temporary",
    "deny",
    "revoke",
  ];
  if (requestActions.includes(action) && !values["request-id"]) {
    throw new CliUsageError(`${action} requires --request-id`);
  }
  if (action === "approve-temporary" && !values["expires-at-utc"]) {
    throw new CliUsageError(
      "approve-temporary requires --request-id and --expires-at-utc",
    );
  }
  if (action === "list" && (values["peer-id"] || values["resource-id"])) {
    throw new CliUsageError("approval list accepts only --state filters");
  }
  if (action !== "audit" && action !== "list" && values.state) {
    throw new CliUsageError("--state is valid only for approval list");
  }

  const config = loadCliConfig(values.config);
  const database = new BridgeDatabase(config.databasePath);
  try {
    if (action === "list") {
      const state = values.state
        ? AuthorizationRequestStateSchema.parse(values.state)
        : undefined;
      writeJson({
        requests: database
          .listAuthorizationRequests(state ? { state } : {})
          .map(formatApproval),
      });
      return;
    }
    if (action === "audit") {
      const peerId = values["peer-id"]
        ? NodeIdSchema.parse(values["peer-id"])
        : undefined;
      const resourceId = values["resource-id"]
        ? ResourceIdSchema.parse(values["resource-id"])
        : undefined;
      writeJson({
        events: database
          .listAuthorizationAudit({
            ...(values["request-id"]
              ? { requestId: values["request-id"] }
              : {}),
            ...(peerId ? { peerSystemId: peerId } : {}),
            ...(resourceId ? { resourceId } : {}),
          })
          .map(formatApprovalAudit),
      });
      return;
    }

    const requestId = values["request-id"]!;
    if (action === "show") {
      const request = database.getAuthorizationRequest(requestId);
      if (!request) {
        throw new StateTransitionError("Authorization request does not exist");
      }
      writeJson({ request: formatApproval(request) });
      return;
    }
    const approval = action === "approve-once"
      ? database.approveAuthorizationRequestOnce({
          requestId,
          actorId: config.systemId,
        })
      : action === "approve-temporary"
        ? database.approveAuthorizationRequestTemporary({
            requestId,
            actorId: config.systemId,
            expiresAtUtc: values["expires-at-utc"]!,
          })
        : action === "deny"
          ? database.denyAuthorizationRequest({
              requestId,
              actorId: config.systemId,
              ...(values.reason ? { reason: values.reason } : {}),
            })
          : database.revokeAuthorizationRequest({
              requestId,
              actorId: config.systemId,
              ...(values.reason ? { reason: values.reason } : {}),
            });
    writeJson({ ok: true, approval: formatApproval(approval) });
  } finally {
    database.close();
  }
}

function loadCliConfig(configPathValue?: string) {
  const config = configPathValue
    ? loadConfigFile(requireAbsolute(configPathValue, "--config"))
    : loadConfig();
  assertSystemIdMatchesProcessIdentity(config.systemId);
  return config;
}

function formatResource(resource: {
  resourceId: string;
  enabled: boolean;
  createdAtUtc: string;
  updatedAtUtc: string;
}): Record<string, unknown> {
  return {
    resource_id: resource.resourceId,
    enabled: resource.enabled,
    created_at_utc: resource.createdAtUtc,
    updated_at_utc: resource.updatedAtUtc,
  };
}

function formatGrant(grant: {
  peerSystemId: string;
  resourceId: string;
  state: string;
  grantedAtUtc: string;
  revokedAtUtc?: string;
}): Record<string, unknown> {
  return {
    peer_id: grant.peerSystemId,
    resource_id: grant.resourceId,
    state: grant.state,
    granted_at_utc: grant.grantedAtUtc,
    ...(grant.revokedAtUtc ? { revoked_at_utc: grant.revokedAtUtc } : {}),
  };
}

function formatApproval(approval: {
  requestId: string;
  peerSystemId: string;
  resourceId: string;
  state: string;
  requestedAtUtc: string;
  temporaryExpiresAtUtc?: string;
}): Record<string, unknown> {
  return {
    request_id: approval.requestId,
    peer_id: approval.peerSystemId,
    resource_id: approval.resourceId,
    state: approval.state,
    requested_at_utc: approval.requestedAtUtc,
    ...(approval.temporaryExpiresAtUtc
      ? { expires_at_utc: approval.temporaryExpiresAtUtc }
      : {}),
  };
}

function formatApprovalAudit(event: {
  eventId: string;
  requestId: string;
  event: string;
  state: string;
  actorId: string;
  peerSystemId: string;
  resourceId: string;
  occurredAtUtc: string;
  reason?: string;
}): Record<string, unknown> {
  return {
    event_id: event.eventId,
    request_id: event.requestId,
    event: event.event,
    state: event.state,
    actor_id: event.actorId,
    peer_id: event.peerSystemId,
    resource_id: event.resourceId,
    occurred_at_utc: event.occurredAtUtc,
    ...(event.reason ? { reason: event.reason } : {}),
  };
}

function requireAbsolute(value: string, optionName: string): string {
  if (!path.isAbsolute(value)) {
    throw new CliUsageError(`${optionName} must be an absolute path`);
  }
  return path.resolve(value);
}

function defaultDataDirectory(): string {
  if (process.platform === "win32") {
    return path.join(
      process.env["LOCALAPPDATA"] ?? path.join(os.homedir(), "AppData", "Local"),
      "Balcony",
      "AgentBridge",
    );
  }
  return path.join(
    process.env["XDG_CONFIG_HOME"] ?? path.join(os.homedir(), ".config"),
    "balcony-agent-bridge",
  );
}

function requireNoArguments(args: readonly string[]): void {
  if (args.length > 0) {
    throw new CliUsageError("command does not accept arguments");
  }
}

function isParseArgsError(error: unknown): boolean {
  return error instanceof TypeError && "code" in error &&
    typeof error.code === "string" && error.code.startsWith("ERR_PARSE_ARGS");
}

function writeJson(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}
