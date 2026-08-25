import fs from "node:fs";
import path from "node:path";

import {
  parseLocalBridgeProfile,
  readLocalBridgeProfile,
  type LocalBridgeProfile,
} from "../config.js";
import { type SystemId } from "../contracts/envelope.js";
import { ConfigurationError } from "../errors.js";
import { BridgeDatabase } from "../storage/database.js";

export interface SetupLocalProfileInput {
  configPath: string;
  nodeId: SystemId;
  authorizedNodeIds: SystemId[];
  databasePath: string;
  topicName?: string;
  subscriptionName?: string;
  serviceBusNamespace?: string;
  azureAuthMode?: "managed_identity" | "client_certificate";
  managedIdentityClientId?: string;
  azureTenantId?: string;
  azureClientId?: string;
  azureClientCertificatePath?: string;
  mcpCommand?: string;
  mcpCommandArgs?: readonly string[];
}

export interface SetupLocalProfileResult {
  created: boolean;
  configPath: string;
  databasePath: string;
  mcpRegistration: string;
}

export function setupLocalProfile(
  input: SetupLocalProfileInput,
): SetupLocalProfileResult {
  const configPath = requireAbsolutePath(input.configPath, "configPath");
  const databasePath = requireAbsolutePath(
    input.databasePath,
    "databasePath",
  );
  if (configPath === databasePath) {
    throw new ConfigurationError(
      "Invalid local bridge setup: configPath and databasePath must be different",
    );
  }
  const profile = parseLocalBridgeProfile({
    nodeId: input.nodeId,
    authorizedNodeIds: input.authorizedNodeIds,
    databasePath,
    topicName: input.topicName ?? "agent-messages",
    subscriptionName: input.subscriptionName ?? input.nodeId.toLowerCase(),
    ...(input.serviceBusNamespace
      ? { serviceBusNamespace: input.serviceBusNamespace }
      : {}),
    ...(input.azureAuthMode ? { azureAuthMode: input.azureAuthMode } : {}),
    ...(input.managedIdentityClientId
      ? { managedIdentityClientId: input.managedIdentityClientId }
      : {}),
    ...(input.azureTenantId ? { azureTenantId: input.azureTenantId } : {}),
    ...(input.azureClientId ? { azureClientId: input.azureClientId } : {}),
    ...(input.azureClientCertificatePath
      ? { azureClientCertificatePath: input.azureClientCertificatePath }
      : {}),
  });
  const mcpRegistration = renderMcpRegistration(
    configPath,
    input.mcpCommand,
    input.mcpCommandArgs,
  );
  validateLocalCertificatePath(profile);

  const profileExists = fs.existsSync(configPath);
  const databaseExists = fs.existsSync(databasePath);
  if (profileExists) {
    const existing = readLocalBridgeProfile(configPath);
    if (!profilesEqual(existing, profile)) {
      throw new ConfigurationError(
        "Existing local bridge profile does not match the requested setup",
      );
    }
    if (!databaseExists) {
      throw new ConfigurationError(
        "Existing local bridge profile has no database at its configured path",
      );
    }
    initializeDatabase(databasePath);
    return {
      created: false,
      configPath,
      databasePath,
      mcpRegistration,
    };
  }
  if (databaseExists) {
    throw new ConfigurationError(
      "Local bridge database already exists; refusing to create an unpaired profile",
    );
  }

  try {
    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    fs.mkdirSync(path.dirname(databasePath), { recursive: true });
  } catch (error) {
    throw new ConfigurationError(
      `Unable to prepare local bridge paths: ${
        error instanceof Error ? error.message : "unknown filesystem error"
      }`,
    );
  }

  let databaseReservedByThisSetup = false;
  try {
    const databaseHandle = fs.openSync(databasePath, "wx", 0o600);
    fs.closeSync(databaseHandle);
    databaseReservedByThisSetup = true;
    initializeDatabase(databasePath);
    fs.writeFileSync(configPath, `${JSON.stringify(profile, null, 2)}\n`, {
      encoding: "utf8",
      flag: "wx",
      mode: 0o600,
    });
  } catch (error) {
    const cleanupFailure = databaseReservedByThisSetup
      ? removeNewDatabaseFiles(databasePath)
      : undefined;
    throw new ConfigurationError(
      `Unable to initialize local bridge setup: ${
        error instanceof Error ? error.message : "unknown write error"
      }${cleanupFailure ? `; cleanup failed: ${cleanupFailure}` : ""}`,
    );
  }

  return {
    created: true,
    configPath,
    databasePath,
    mcpRegistration,
  };
}

function initializeDatabase(databasePath: string): void {
  const database = new BridgeDatabase(databasePath);
  database.close();
}

function removeNewDatabaseFiles(databasePath: string): string | undefined {
  for (const candidate of [databasePath, `${databasePath}-wal`, `${databasePath}-shm`]) {
    try {
      fs.rmSync(candidate, { force: true });
    } catch (error) {
      return error instanceof Error ? error.message : "unknown cleanup error";
    }
  }
  return undefined;
}

function requireAbsolutePath(value: string, fieldName: string): string {
  if (!path.isAbsolute(value)) {
    throw new ConfigurationError(
      `Invalid local bridge setup: ${fieldName} must be absolute`,
    );
  }
  return path.resolve(value);
}

function validateLocalCertificatePath(profile: LocalBridgeProfile): void {
  if (profile.azureAuthMode !== "client_certificate") {
    return;
  }
  const certificatePath = profile.azureClientCertificatePath!;
  let isFile = false;
  try {
    isFile = path.isAbsolute(certificatePath) && fs.statSync(certificatePath).isFile();
  } catch {
    isFile = false;
  }
  if (!isFile) {
    throw new ConfigurationError(
      "Invalid local bridge setup: azureClientCertificatePath must be an existing absolute file",
    );
  }
}

function profilesEqual(
  left: LocalBridgeProfile,
  right: LocalBridgeProfile,
): boolean {
  return (
    left.nodeId === right.nodeId &&
    left.databasePath === right.databasePath &&
    left.topicName === right.topicName &&
    left.subscriptionName === right.subscriptionName &&
    left.serviceBusNamespace === right.serviceBusNamespace &&
    left.azureAuthMode === right.azureAuthMode &&
    left.managedIdentityClientId === right.managedIdentityClientId &&
    left.azureTenantId === right.azureTenantId &&
    left.azureClientId === right.azureClientId &&
    left.azureClientCertificatePath === right.azureClientCertificatePath &&
    left.authorizedNodeIds.length === right.authorizedNodeIds.length &&
    left.authorizedNodeIds.every((nodeId, index) => nodeId === right.authorizedNodeIds[index])
  );
}

function renderMcpRegistration(
  configPath: string,
  command = "balcony-agent-bridge-mcp",
  commandArgs: readonly string[] = [],
): string {
  return [
    "[mcp_servers.balcony-agent-bridge]",
    `command = ${JSON.stringify(command)}`,
    `args = ${JSON.stringify([...commandArgs, "--config", configPath])}`,
    "",
  ].join("\n");
}
