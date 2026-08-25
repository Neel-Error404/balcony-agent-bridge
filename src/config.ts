import fs from "node:fs";
import path from "node:path";

import { z } from "zod";

import { ConfigurationError } from "./errors.js";
import { SystemIdSchema, type SystemId } from "./contracts/envelope.js";

const EnvironmentSchema = z
  .object({
    BALCONY_SYSTEM_ID: SystemIdSchema,
    BALCONY_AUTHORIZED_NODE_IDS: z.string().trim().min(1),
    BALCONY_BRIDGE_DB_PATH: z.string().trim().min(1).optional(),
    BALCONY_SERVICEBUS_NAMESPACE: z
      .string()
      .trim()
      .regex(
        /^[a-z0-9-]+\.servicebus\.windows\.net$/i,
        "must be a fully qualified Azure Service Bus namespace",
      )
      .optional(),
    BALCONY_SERVICEBUS_TOPIC: z.string().trim().min(1).default("agent-messages"),
    BALCONY_SERVICEBUS_SUBSCRIPTION: z.string().trim().min(1).optional(),
    BALCONY_AZURE_AUTH_MODE: z
      .enum(["managed_identity", "client_certificate"])
      .default("managed_identity"),
    BALCONY_MANAGED_IDENTITY_CLIENT_ID: z.string().uuid().optional(),
    BALCONY_AZURE_TENANT_ID: z.string().uuid().optional(),
    BALCONY_AZURE_CLIENT_ID: z.string().uuid().optional(),
    BALCONY_AZURE_CLIENT_CERTIFICATE_PATH: z
      .string()
      .trim()
      .min(1)
      .optional(),
  })
  .passthrough()
  .superRefine((value, context) => {
    if (value.BALCONY_AZURE_AUTH_MODE === "client_certificate") {
      for (const key of [
        "BALCONY_AZURE_TENANT_ID",
        "BALCONY_AZURE_CLIENT_ID",
        "BALCONY_AZURE_CLIENT_CERTIFICATE_PATH",
      ] as const) {
        if (!value[key]) {
          context.addIssue({
            code: "custom",
            path: [key],
            message: "is required for client_certificate authentication",
          });
        }
      }
      if (value.BALCONY_MANAGED_IDENTITY_CLIENT_ID) {
        context.addIssue({
          code: "custom",
          path: ["BALCONY_MANAGED_IDENTITY_CLIENT_ID"],
          message: "is not allowed for client_certificate authentication",
        });
      }
      return;
    }

    for (const key of [
      "BALCONY_AZURE_TENANT_ID",
      "BALCONY_AZURE_CLIENT_ID",
      "BALCONY_AZURE_CLIENT_CERTIFICATE_PATH",
    ] as const) {
      if (value[key]) {
        context.addIssue({
          code: "custom",
          path: [key],
          message: "is not allowed for managed_identity authentication",
        });
      }
    }
  });

export type AzureAuthMode =
  | "managed_identity"
  | "client_certificate";

export interface BridgeConfig {
  systemId: SystemId;
  authorizedNodeIds: readonly SystemId[];
  databasePath: string;
  serviceBusNamespace?: string;
  topicName: string;
  subscriptionName: string;
  azureAuthMode: AzureAuthMode;
  managedIdentityClientId?: string;
  azureTenantId?: string;
  azureClientId?: string;
  azureClientCertificatePath?: string;
}

const MessageAuthenticationRuntimeEnvironmentSchema = z
  .object({
    BALCONY_MESSAGE_AUTH_MODE: z.literal("ed25519"),
    BALCONY_MESSAGE_AUTH_MEMBERSHIP_PATH: z.string().trim().min(1),
    BALCONY_MESSAGE_AUTH_SIGNING_KEY_PATH: z.string().trim().min(1),
  })
  .strict();

export interface MessageAuthenticationRuntimeConfig {
  mode: "ed25519";
  membershipPath: string;
  signingKeyPath: string;
}

const LocalProfileSchema = z
  .object({
    nodeId: SystemIdSchema,
    authorizedNodeIds: z.array(SystemIdSchema).min(1).max(32),
    databasePath: z.string().trim().min(1),
    topicName: z.string().trim().min(1),
    subscriptionName: z.string().trim().min(1),
    serviceBusNamespace: z
      .string()
      .trim()
      .regex(/^[a-z0-9-]+\.servicebus\.windows\.net$/i)
      .optional(),
    azureAuthMode: z.enum(["managed_identity", "client_certificate"]).optional(),
    managedIdentityClientId: z.string().uuid().optional(),
    azureTenantId: z.string().uuid().optional(),
    azureClientId: z.string().uuid().optional(),
    azureClientCertificatePath: z.string().trim().min(1).optional(),
  })
  .superRefine((value, context) => {
    const hasAzureMetadata = Boolean(
      value.serviceBusNamespace ||
        value.azureAuthMode ||
        value.managedIdentityClientId ||
        value.azureTenantId ||
        value.azureClientId ||
        value.azureClientCertificatePath,
    );
    if (!hasAzureMetadata) {
      return;
    }
    if (!value.serviceBusNamespace) {
      context.addIssue({
        code: "custom",
        path: ["serviceBusNamespace"],
        message: "is required when Azure metadata is configured",
      });
      return;
    }
    if (value.azureAuthMode === "client_certificate") {
      for (const key of [
        "azureTenantId",
        "azureClientId",
        "azureClientCertificatePath",
      ] as const) {
        if (!value[key]) {
          context.addIssue({
            code: "custom",
            path: [key],
            message: "is required for client_certificate authentication",
          });
        }
      }
      if (value.managedIdentityClientId) {
        context.addIssue({
          code: "custom",
          path: ["managedIdentityClientId"],
          message: "is not allowed for client_certificate authentication",
        });
      }
      return;
    }
    for (const key of [
      "azureTenantId",
      "azureClientId",
      "azureClientCertificatePath",
    ] as const) {
      if (value[key]) {
        context.addIssue({
          code: "custom",
          path: [key],
          message: "is not allowed for managed_identity authentication",
        });
      }
    }
  })
  .strict();

export type LocalBridgeProfile = z.infer<typeof LocalProfileSchema>;

export function parseLocalBridgeProfile(value: unknown): LocalBridgeProfile {
  const result = LocalProfileSchema.safeParse(value);
  if (!result.success) {
    const detail = result.error.issues
      .map((issue) => `${issue.path.join(".") || "profile"}: ${issue.message}`)
      .join("; ");
    throw new ConfigurationError(`Invalid local bridge profile: ${detail}`);
  }
  if (!path.isAbsolute(result.data.databasePath)) {
    throw new ConfigurationError(
      "Invalid local bridge profile: databasePath must be absolute",
    );
  }
  validateAuthorizedNodeIds(
    result.data.authorizedNodeIds,
    result.data.nodeId,
    "authorizedNodeIds",
  );
  return result.data;
}

const DispatcherEnvironmentSchema = z
  .object({
    BALCONY_DISPATCHER_PROJECTS_PATH: z.string().trim().min(1),
    BALCONY_CODEX_EXECUTABLE: z.string().trim().min(1),
    BALCONY_CODEX_EXECUTABLE_SHA256: z
      .string()
      .trim()
      .regex(/^[a-f0-9]{64}$/i),
    BALCONY_CODEX_CODE_MODE_HOST_EXECUTABLE: z.string().trim().min(1),
    BALCONY_CODEX_CODE_MODE_HOST_SHA256: z
      .string()
      .trim()
      .regex(/^[a-f0-9]{64}$/i),
    BALCONY_DISPATCHER_CODEX_HOME: z.string().trim().min(1),
    BALCONY_DISPATCHER_TRUSTED_PATH: z.string().trim().min(1),
    BALCONY_DISPATCHER_POLL_INTERVAL_MS: z.coerce
      .number()
      .int()
      .min(250)
      .max(60_000)
      .default(2000),
    BALCONY_DISPATCHER_DEFAULT_TIMEOUT_SECONDS: z.coerce
      .number()
      .int()
      .min(30)
      .max(600)
      .default(300),
    BALCONY_DISPATCHER_MAX_OUTPUT_BYTES: z.coerce
      .number()
      .int()
      .min(1024)
      .max(60_000)
      .default(48_000),
    BALCONY_DISPATCHER_NOT_BEFORE_UTC: z
      .string()
      .datetime({ offset: true })
      .optional(),
    BALCONY_DISPATCHER_MODE: z
      .enum(["legacy", "consultation"])
      .default("legacy"),
    BALCONY_CONSULTATION_WORKING_DIRECTORY: z
      .string()
      .trim()
      .min(1)
      .optional(),
    BALCONY_GIT_EXECUTABLE: z.string().trim().min(1).optional(),
    BALCONY_GIT_EXECUTABLE_SHA256: z
      .string()
      .trim()
      .regex(/^[a-f0-9]{64}$/i)
      .optional(),
  })
  .passthrough()
  .superRefine((value, context) => {
    if (value.BALCONY_DISPATCHER_MODE !== "consultation") {
      return;
    }
    for (const key of [
      "BALCONY_CONSULTATION_WORKING_DIRECTORY",
      "BALCONY_GIT_EXECUTABLE",
      "BALCONY_GIT_EXECUTABLE_SHA256",
    ] as const) {
      if (!value[key]) {
        context.addIssue({
          code: "custom",
          path: [key],
          message: "is required in consultation mode",
        });
      }
    }
  });

export interface ReadOnlyDispatcherConfig {
  systemId: SystemId;
  authorizedNodeIds: readonly SystemId[];
  databasePath: string;
  projectsPath: string;
  codexExecutable: string;
  codexExecutableSha256: string;
  codexCodeModeHostExecutable: string;
  codexCodeModeHostSha256: string;
  codexHome: string;
  trustedPath: string;
  pollIntervalMs: number;
  defaultTimeoutSeconds: number;
  maxOutputBytes: number;
  notBeforeUtc?: string;
  mode?: "legacy" | "consultation";
  consultationWorkingDirectory?: string;
  gitExecutable?: string;
  gitExecutableSha256?: string;
}

export function loadConfig(
  environment: NodeJS.ProcessEnv = process.env,
): BridgeConfig {
  const result = EnvironmentSchema.safeParse(environment);
  if (!result.success) {
    const detail = result.error.issues
      .map((issue) => `${issue.path.join(".") || "environment"}: ${issue.message}`)
      .join("; ");
    throw new ConfigurationError(`Invalid bridge configuration: ${detail}`);
  }

  const systemId = result.data.BALCONY_SYSTEM_ID;
  const authorizedNodeIds = parseAuthorizedNodeIds(
    result.data.BALCONY_AUTHORIZED_NODE_IDS,
    systemId,
  );
  const programData =
    environment["ProgramData"] ??
    environment["PROGRAMDATA"] ??
    "C:\\ProgramData";
  const databasePath =
    result.data.BALCONY_BRIDGE_DB_PATH ??
    path.join(
      programData,
      "Balcony",
      "AgentBridge",
      "data",
      "bridge.sqlite3",
    );

  return {
    systemId,
    authorizedNodeIds,
    databasePath,
    topicName: result.data.BALCONY_SERVICEBUS_TOPIC,
    subscriptionName:
      result.data.BALCONY_SERVICEBUS_SUBSCRIPTION ??
      systemId.toLowerCase(),
    azureAuthMode: result.data.BALCONY_AZURE_AUTH_MODE,
    ...(result.data.BALCONY_SERVICEBUS_NAMESPACE
      ? { serviceBusNamespace: result.data.BALCONY_SERVICEBUS_NAMESPACE }
      : {}),
    ...(result.data.BALCONY_MANAGED_IDENTITY_CLIENT_ID
      ? {
          managedIdentityClientId:
            result.data.BALCONY_MANAGED_IDENTITY_CLIENT_ID,
        }
      : {}),
    ...(result.data.BALCONY_AZURE_TENANT_ID
      ? { azureTenantId: result.data.BALCONY_AZURE_TENANT_ID }
      : {}),
    ...(result.data.BALCONY_AZURE_CLIENT_ID
      ? { azureClientId: result.data.BALCONY_AZURE_CLIENT_ID }
      : {}),
    ...(result.data.BALCONY_AZURE_CLIENT_CERTIFICATE_PATH
      ? {
          azureClientCertificatePath:
            result.data.BALCONY_AZURE_CLIENT_CERTIFICATE_PATH,
        }
      : {}),
  };
}

/**
 * Loads signing material required only by the bridge transport worker.
 *
 * Keep this separate from loadConfig so MCP and dispatcher processes never
 * require, inherit, or read the bridge signing-key path.
 */
export function loadMessageAuthenticationRuntimeConfig(
  environment: NodeJS.ProcessEnv,
  bridgeConfig: BridgeConfig,
): MessageAuthenticationRuntimeConfig {
  void bridgeConfig;
  const result = MessageAuthenticationRuntimeEnvironmentSchema.safeParse({
    BALCONY_MESSAGE_AUTH_MODE: environment["BALCONY_MESSAGE_AUTH_MODE"],
    BALCONY_MESSAGE_AUTH_MEMBERSHIP_PATH:
      environment["BALCONY_MESSAGE_AUTH_MEMBERSHIP_PATH"],
    BALCONY_MESSAGE_AUTH_SIGNING_KEY_PATH:
      environment["BALCONY_MESSAGE_AUTH_SIGNING_KEY_PATH"],
  });
  if (!result.success) {
    const detail = result.error.issues
      .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
      .join("; ");
    throw new ConfigurationError(
      `Invalid bridge runtime message authentication configuration: ${detail}`,
    );
  }

  const membershipPath = requireAbsoluteMessageAuthenticationPath(
    result.data.BALCONY_MESSAGE_AUTH_MEMBERSHIP_PATH,
    "BALCONY_MESSAGE_AUTH_MEMBERSHIP_PATH",
  );
  const signingKeyPath = requireAbsoluteMessageAuthenticationPath(
    result.data.BALCONY_MESSAGE_AUTH_SIGNING_KEY_PATH,
    "BALCONY_MESSAGE_AUTH_SIGNING_KEY_PATH",
  );
  const pathsMatch = process.platform === "win32"
    ? membershipPath.toLowerCase() === signingKeyPath.toLowerCase()
    : membershipPath === signingKeyPath;
  if (pathsMatch) {
    throw new ConfigurationError(
      "Invalid bridge runtime message authentication configuration: BALCONY_MESSAGE_AUTH_MEMBERSHIP_PATH and BALCONY_MESSAGE_AUTH_SIGNING_KEY_PATH must be different",
    );
  }

  return {
    mode: result.data.BALCONY_MESSAGE_AUTH_MODE,
    membershipPath,
    signingKeyPath,
  };
}

function requireAbsoluteMessageAuthenticationPath(
  value: string,
  fieldName: string,
): string {
  if (!path.isAbsolute(value)) {
    throw new ConfigurationError(
      `Invalid bridge runtime message authentication configuration: ${fieldName} must be an absolute path`,
    );
  }
  return path.resolve(value);
}

export function readLocalBridgeProfile(configPath: string): LocalBridgeProfile {
  if (!path.isAbsolute(configPath)) {
    throw new ConfigurationError("Local bridge profile path must be absolute");
  }

  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(fs.readFileSync(configPath, "utf8"));
  } catch (error) {
    const reason = error instanceof Error ? error.message : "unknown read error";
    throw new ConfigurationError(
      `Unable to read local bridge profile '${configPath}': ${reason}`,
    );
  }

  return parseLocalBridgeProfile(parsedJson);
}

export function loadConfigFile(configPath: string): BridgeConfig {
  const profile = readLocalBridgeProfile(configPath);

  const authorizedNodeIds = validateAuthorizedNodeIds(
    profile.authorizedNodeIds,
    profile.nodeId,
    "authorizedNodeIds",
  );
  const azureAuthMode = profile.azureAuthMode ?? "managed_identity";
  return {
    systemId: profile.nodeId,
    authorizedNodeIds,
    databasePath: profile.databasePath,
    topicName: profile.topicName,
    subscriptionName: profile.subscriptionName,
    azureAuthMode,
    ...(profile.serviceBusNamespace
      ? { serviceBusNamespace: profile.serviceBusNamespace }
      : {}),
    ...(profile.managedIdentityClientId
      ? { managedIdentityClientId: profile.managedIdentityClientId }
      : {}),
    ...(profile.azureTenantId
      ? { azureTenantId: profile.azureTenantId }
      : {}),
    ...(profile.azureClientId
      ? { azureClientId: profile.azureClientId }
      : {}),
    ...(profile.azureClientCertificatePath
      ? { azureClientCertificatePath: profile.azureClientCertificatePath }
      : {}),
  };
}

export function requireServiceBusNamespace(config: BridgeConfig): string {
  if (!config.serviceBusNamespace) {
    throw new ConfigurationError(
      "BALCONY_SERVICEBUS_NAMESPACE is required by the background bridge service",
    );
  }
  return config.serviceBusNamespace;
}

export function loadReadOnlyDispatcherConfig(
  environment: NodeJS.ProcessEnv = process.env,
): ReadOnlyDispatcherConfig {
  const bridge = loadConfig(environment);
  const result = DispatcherEnvironmentSchema.safeParse(environment);
  if (!result.success) {
    const detail = result.error.issues
      .map((issue) => `${issue.path.join(".") || "environment"}: ${issue.message}`)
      .join("; ");
    throw new ConfigurationError(
      `Invalid read-only dispatcher configuration: ${detail}`,
    );
  }

  return {
    systemId: bridge.systemId,
    authorizedNodeIds: bridge.authorizedNodeIds,
    databasePath: bridge.databasePath,
    projectsPath: path.resolve(result.data.BALCONY_DISPATCHER_PROJECTS_PATH),
    codexExecutable: path.resolve(result.data.BALCONY_CODEX_EXECUTABLE),
    codexExecutableSha256:
      result.data.BALCONY_CODEX_EXECUTABLE_SHA256.toLowerCase(),
    codexCodeModeHostExecutable: path.resolve(
      result.data.BALCONY_CODEX_CODE_MODE_HOST_EXECUTABLE,
    ),
    codexCodeModeHostSha256:
      result.data.BALCONY_CODEX_CODE_MODE_HOST_SHA256.toLowerCase(),
    codexHome: path.resolve(result.data.BALCONY_DISPATCHER_CODEX_HOME),
    trustedPath: result.data.BALCONY_DISPATCHER_TRUSTED_PATH,
    pollIntervalMs: result.data.BALCONY_DISPATCHER_POLL_INTERVAL_MS,
    defaultTimeoutSeconds:
      result.data.BALCONY_DISPATCHER_DEFAULT_TIMEOUT_SECONDS,
    maxOutputBytes: result.data.BALCONY_DISPATCHER_MAX_OUTPUT_BYTES,
    ...(result.data.BALCONY_DISPATCHER_NOT_BEFORE_UTC
      ? {
          notBeforeUtc: new Date(
            result.data.BALCONY_DISPATCHER_NOT_BEFORE_UTC,
          ).toISOString(),
        }
      : {}),
    mode: result.data.BALCONY_DISPATCHER_MODE,
    ...(result.data.BALCONY_CONSULTATION_WORKING_DIRECTORY
      ? {
          consultationWorkingDirectory: path.resolve(
            result.data.BALCONY_CONSULTATION_WORKING_DIRECTORY,
          ),
        }
      : {}),
    ...(result.data.BALCONY_GIT_EXECUTABLE
      ? {
          gitExecutable: path.resolve(
            result.data.BALCONY_GIT_EXECUTABLE,
          ),
        }
      : {}),
    ...(result.data.BALCONY_GIT_EXECUTABLE_SHA256
      ? {
          gitExecutableSha256:
            result.data.BALCONY_GIT_EXECUTABLE_SHA256.toLowerCase(),
        }
      : {}),
  };
}

function parseAuthorizedNodeIds(value: string, systemId: SystemId): SystemId[] {
  const parsed = z
    .array(SystemIdSchema)
    .min(1)
    .max(32)
    .safeParse(value.split(",").map((item) => item.trim()));
  if (!parsed.success) {
    const detail = parsed.error.issues.map((issue) => issue.message).join("; ");
    throw new ConfigurationError(
      `Invalid bridge configuration: BALCONY_AUTHORIZED_NODE_IDS: ${detail}`,
    );
  }
  return validateAuthorizedNodeIds(
    parsed.data,
    systemId,
    "BALCONY_AUTHORIZED_NODE_IDS",
  );
}

function validateAuthorizedNodeIds(
  authorizedNodeIds: SystemId[],
  systemId: SystemId,
  fieldName: string,
): SystemId[] {
  if (new Set(authorizedNodeIds).size !== authorizedNodeIds.length) {
    throw new ConfigurationError(
      `Invalid bridge configuration: ${fieldName}: duplicate node IDs are not allowed`,
    );
  }
  if (authorizedNodeIds.includes(systemId)) {
    throw new ConfigurationError(
      `Invalid bridge configuration: ${fieldName}: the local node ID is not a remote node`,
    );
  }
  return authorizedNodeIds;
}
