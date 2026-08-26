#!/usr/bin/env node

import os from "node:os";
import path from "node:path";
import { parseArgs } from "node:util";
import { fileURLToPath } from "node:url";

import {
  assertConfigMatchesProcessIdentity,
  loadConfig,
  loadConfigFile,
} from "../config.js";
import { NodeIdSchema } from "../contracts/envelope.js";
import { generateNodeIdentity } from "../security/node-identity.js";
import { safeErrorCode } from "../security/sanitize-error.js";
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

Examples:
  balcony-agent-bridge demo
  balcony-agent-bridge identity --node-id laptop-a --output-directory C:\\path\\to\\identity
  balcony-agent-bridge setup --node-id laptop-a --authorized-node laptop-b
  balcony-agent-bridge doctor --config C:\\path\\to\\config.json
`;

class CliUsageError extends Error {}

await main();

async function main(): Promise<void> {
  const command = process.argv[2];
  if (command === undefined || command === "help" || command === "--help") {
    process.stdout.write(usage);
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
      default:
        throw new CliUsageError(`Unknown command: ${command}`);
    }
  } catch (error) {
    if (error instanceof CliUsageError || isParseArgsError(error)) {
      process.stderr.write(`${usage}\n`);
      process.exitCode = 2;
      return;
    }
    process.stderr.write(
      `${command} failed (${safeErrorCode(error).toUpperCase()})\n`,
    );
    process.exitCode = 1;
  }
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
