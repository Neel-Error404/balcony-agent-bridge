import fs from "node:fs";
import path from "node:path";

import { ConfigurationError } from "../errors.js";

export interface ForegroundLaunch {
  command: string;
  args: string[];
  env: Record<string, string>;
}

interface BridgeLaunchInput {
  packageRoot: string;
  configPath: string;
  nodeId: string;
  networkId: string;
  membershipPath: string;
  signingKeyPath: string;
  azure: {
    serviceBusNamespace?: string;
    topicName?: string;
    subscriptionName?: string;
    authMode: "managed_identity" | "client_certificate";
    managedIdentityClientId?: string;
    tenantId?: string;
    clientId?: string;
    clientCertificatePath?: string;
  };
  validateOnly?: boolean;
}

interface DispatcherLaunchInput {
  packageRoot: string;
  configPath: string;
  nodeId: string;
  projectsConfigPath: string;
  codexExecutable: string;
  codexSha256: string;
  codeModeHostExecutable: string;
  codeModeHostSha256: string;
  codexHome: string;
  trustedPath?: string;
  validateOnly?: boolean;
}

export function validateForegroundEntrypoints(packageRoot: string): {
  bridge: string;
  dispatcher: string;
} {
  const resolvedPackageRoot = fs.realpathSync.native(packageRoot);
  const bridge = path.join(resolvedPackageRoot, "dist", "bridge", "index.js");
  const dispatcher = path.join(resolvedPackageRoot, "dist", "dispatcher", "index.js");
  for (const [name, entrypoint] of Object.entries({ bridge, dispatcher })) {
    const metadata = fs.lstatSync(entrypoint, { throwIfNoEntry: false });
    const resolvedEntrypoint = metadata?.isFile() && !metadata.isSymbolicLink()
      ? fs.realpathSync.native(entrypoint)
      : undefined;
    if (
      !resolvedEntrypoint ||
      !isContainedPath(resolvedPackageRoot, resolvedEntrypoint)
    ) {
      throw new ConfigurationError(
        `Installed package is missing the ${name} foreground entrypoint`,
      );
    }
  }
  return { bridge, dispatcher };
}

function isContainedPath(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === "" || (
    relative !== ".." &&
    !relative.startsWith(`..${path.sep}`) &&
    !path.isAbsolute(relative)
  );
}

export function buildBridgeLaunch(input: BridgeLaunchInput): ForegroundLaunch {
  const { bridge } = validateForegroundEntrypoints(input.packageRoot);
  const env: Record<string, string> = {
    BALCONY_SYSTEM_ID: input.nodeId,
    BALCONY_LOCAL_CONFIG: path.resolve(input.configPath),
    BALCONY_MESSAGE_AUTH_MODE: "ed25519",
    BALCONY_MESSAGE_AUTH_MEMBERSHIP_PATH: path.resolve(input.membershipPath),
    BALCONY_MESSAGE_AUTH_SIGNING_KEY_PATH: path.resolve(input.signingKeyPath),
    BALCONY_MESSAGE_AUTH_NETWORK_ID: input.networkId,
    BALCONY_AZURE_AUTH_MODE: input.azure.authMode,
  };
  addOptional(env, "BALCONY_SERVICEBUS_NAMESPACE", input.azure.serviceBusNamespace);
  addOptional(env, "BALCONY_SERVICEBUS_TOPIC", input.azure.topicName);
  addOptional(env, "BALCONY_SERVICEBUS_SUBSCRIPTION", input.azure.subscriptionName);
  addOptional(
    env,
    "BALCONY_MANAGED_IDENTITY_CLIENT_ID",
    input.azure.managedIdentityClientId,
  );
  addOptional(env, "BALCONY_AZURE_TENANT_ID", input.azure.tenantId);
  addOptional(env, "BALCONY_AZURE_CLIENT_ID", input.azure.clientId);
  addOptional(
    env,
    "BALCONY_AZURE_CLIENT_CERTIFICATE_PATH",
    input.azure.clientCertificatePath,
  );

  return {
    command: process.execPath,
    args: [
      bridge,
      "--config",
      path.resolve(input.configPath),
      ...(input.validateOnly ? ["--validate-message-authentication"] : []),
    ],
    env,
  };
}

export function buildDispatcherLaunch(
  input: DispatcherLaunchInput,
): ForegroundLaunch {
  const { dispatcher } = validateForegroundEntrypoints(input.packageRoot);
  return {
    command: process.execPath,
    args: [
      dispatcher,
      "--config",
      path.resolve(input.configPath),
      ...(input.validateOnly ? ["--validate-config"] : []),
    ],
    env: {
      BALCONY_SYSTEM_ID: input.nodeId,
      BALCONY_LOCAL_CONFIG: path.resolve(input.configPath),
      BALCONY_DISPATCHER_PROJECTS_PATH: path.resolve(input.projectsConfigPath),
      BALCONY_CODEX_EXECUTABLE: path.resolve(input.codexExecutable),
      BALCONY_CODEX_EXECUTABLE_SHA256: input.codexSha256.toLowerCase(),
      BALCONY_CODEX_CODE_MODE_HOST_EXECUTABLE: path.resolve(
        input.codeModeHostExecutable,
      ),
      BALCONY_CODEX_CODE_MODE_HOST_SHA256:
        input.codeModeHostSha256.toLowerCase(),
      BALCONY_DISPATCHER_CODEX_HOME: path.resolve(input.codexHome),
      BALCONY_DISPATCHER_TRUSTED_PATH: input.trustedPath ?? path.dirname(
        input.codexExecutable,
      ),
    },
  };
}

function addOptional(
  environment: Record<string, string>,
  name: string,
  value: string | undefined,
): void {
  if (value !== undefined) {
    environment[name] = value;
  }
}
