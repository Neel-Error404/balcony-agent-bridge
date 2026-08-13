import path from "node:path";

import { z } from "zod";

import { ConfigurationError } from "./errors.js";
import { SystemIdSchema, type SystemId } from "./contracts/envelope.js";

const EnvironmentSchema = z
  .object({
    BALCONY_SYSTEM_ID: SystemIdSchema,
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
  .passthrough();

export type AzureAuthMode =
  | "managed_identity"
  | "client_certificate";

export interface BridgeConfig {
  systemId: SystemId;
  peerSystemId: SystemId;
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
  const peerSystemId = peerFor(systemId);
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
    peerSystemId,
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

export function requireServiceBusNamespace(config: BridgeConfig): string {
  if (!config.serviceBusNamespace) {
    throw new ConfigurationError(
      "BALCONY_SERVICEBUS_NAMESPACE is required by the background bridge service",
    );
  }
  return config.serviceBusNamespace;
}

function peerFor(systemId: SystemId): SystemId {
  return systemId === "SYS-A" ? "SYS-B" : "SYS-A";
}
