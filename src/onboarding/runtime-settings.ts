import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

import { z } from "zod";

import { BridgeError } from "../errors.js";
import {
  ProjectRegistry,
  ProjectRegistrySchema,
} from "../dispatcher/project-registry.js";
import { setupLocalProfile } from "../setup/local-profile.js";
import { readLocalBridgeProfile } from "../config.js";
import {
  prepareIdentityDirectory,
  readOnboardingManifest,
  recordOnboardingArtifactHash,
  resumeOnboarding,
} from "./index.js";
import { validateNodeIdentityDirectory } from "../security/node-identity.js";

const RUNTIME_SETTINGS_FILE = "runtime-settings.json";
const PROJECTS_FILE = "dispatcher-projects.json";
const MAX_RUNTIME_SETTINGS_BYTES = 1024 * 1024;
const RuntimeArtifactNameSchema = z.enum([
  "runtime_settings",
  "dispatcher_projects",
]);
const RuntimeTransactionSchema = z.object({
  schema_version: z.literal("1.0"),
  artifact: RuntimeArtifactNameSchema,
  previous_sha256: z.string().regex(/^[a-f0-9]{64}$/u).nullable(),
  target_sha256: z.string().regex(/^[a-f0-9]{64}$/u),
}).strict();
type RuntimeArtifactName = z.infer<typeof RuntimeArtifactNameSchema>;

const TransportSchema = z.object({
  configured: z.literal(true),
  profile_path: z.string().min(1),
  database_path: z.string().min(1),
  topic_name: z.string().min(1),
  subscription_name: z.string().min(1),
  servicebus_namespace: z.string().min(1).optional(),
  auth_mode: z.enum(["managed_identity", "client_certificate"]),
  local_only: z.boolean(),
  managed_identity_client_id: z.string().uuid().optional(),
  azure_tenant_id: z.string().uuid().optional(),
  azure_client_id: z.string().uuid().optional(),
  azure_client_certificate_path: z.string().min(1).optional(),
}).strict();

const DispatcherSchema = z.object({
  configured: z.literal(true),
  projects_path: z.string().min(1),
  projects_sha256: z.string().regex(/^[a-f0-9]{64}$/u),
  codex_executable: z.string().min(1),
  codex_sha256: z.string().regex(/^[a-f0-9]{64}$/u),
  code_mode_host_executable: z.string().min(1),
  code_mode_host_sha256: z.string().regex(/^[a-f0-9]{64}$/u),
  codex_home: z.string().min(1),
  trusted_path: z.string().min(1),
}).strict();

const RuntimeSettingsSchema = z.object({
  schema_version: z.literal("1.0"),
  node_id: z.string().min(1),
  network_id: z.string().min(1),
  onboarding_root: z.string().min(1),
  transport: TransportSchema.optional(),
  dispatcher: DispatcherSchema.optional(),
  mcp: z.object({ configured: z.literal(true) }).strict().optional(),
}).strict();

export type RuntimeSettings = z.infer<typeof RuntimeSettingsSchema>;

export class OnboardingRuntimeError extends BridgeError {
  public constructor(
    code:
      | "ONBOARDING_INCOMPLETE"
      | "RUNTIME_SETTINGS_INVALID"
      | "RUNTIME_SETTINGS_CONFLICT"
      | "DISPATCHER_CONFIGURATION_INVALID"
      | "MCP_CONFIGURATION_FAILED",
    message: string,
    options?: ErrorOptions,
  ) {
    super(code, message, options);
    this.name = "OnboardingRuntimeError";
  }
}

export interface ConfigureTransportInput {
  manifestPath: string;
  packageRoot: string;
  topicName?: string;
  subscriptionName?: string;
  serviceBusNamespace?: string;
  authMode: "managed_identity" | "client_certificate";
  localOnly?: boolean;
  managedIdentityClientId?: string;
  azureTenantId?: string;
  azureClientId?: string;
  azureClientCertificatePath?: string;
}

export interface ConfigureDispatcherInput {
  manifestPath: string;
  projectKey: string;
  projectPath: string;
  codexExecutable: string;
  codeModeHostExecutable: string;
}

export interface ConfigureMcpInput {
  manifestPath: string;
  codexExecutable: string;
  packageRoot: string;
  runCodex?: (
    args: readonly string[],
    env: NodeJS.ProcessEnv,
  ) => { status: number | null; stdout: string; stderr: string };
}

export interface DispatcherAuthenticationReadiness {
  codexHome: string;
  authenticated: boolean;
}

export interface VerifyMcpRegistrationInput {
  manifestPath: string;
  packageRoot: string;
  codexExecutable?: string;
  runCodex?: (
    args: readonly string[],
    env: NodeJS.ProcessEnv,
  ) => { status: number | null; stdout: string; stderr: string };
}

export function configureTransport(
  input: ConfigureTransportInput,
): RuntimeSettings & { transport: z.infer<typeof TransportSchema> } {
  const manifest = requireCompleteOnboarding(input.manifestPath);
  const topicName = normalizeTransportName(
    input.topicName ?? "agent-messages",
    "topic name",
  );
  const subscriptionName = normalizeTransportName(
    input.subscriptionName ?? manifest.node_id,
    "subscription name",
  );
  const serviceBusNamespace = input.serviceBusNamespace === undefined
    ? undefined
    : normalizeTransportName(input.serviceBusNamespace, "Service Bus namespace");
  if (Boolean(serviceBusNamespace) === Boolean(input.localOnly)) {
    throw new OnboardingRuntimeError(
      "RUNTIME_SETTINGS_INVALID",
      "Choose exactly one of a Service Bus namespace or explicit local-only evaluation.",
    );
  }
  const mcpEntrypoint = requireRegularFile(
    path.join(requireAbsolute(input.packageRoot), "dist", "mcp", "index.js"),
    "The installed MCP entrypoint is unavailable.",
  );
  const parsedTransport = TransportSchema.safeParse({
    configured: true,
    profile_path: manifest.profile_path,
    database_path: manifest.database_path,
    topic_name: topicName,
    subscription_name: subscriptionName,
    ...(serviceBusNamespace
      ? { servicebus_namespace: serviceBusNamespace }
      : {}),
    auth_mode: input.authMode,
    local_only: input.localOnly ?? false,
    ...(input.managedIdentityClientId
      ? { managed_identity_client_id: input.managedIdentityClientId }
      : {}),
    ...(input.azureTenantId ? { azure_tenant_id: input.azureTenantId } : {}),
    ...(input.azureClientId ? { azure_client_id: input.azureClientId } : {}),
    ...(input.azureClientCertificatePath
      ? {
          azure_client_certificate_path: requireAbsolute(
            input.azureClientCertificatePath,
          ),
        }
      : {}),
  });
  if (!parsedTransport.success) {
    throw new OnboardingRuntimeError(
      "RUNTIME_SETTINGS_INVALID",
      "The transport configuration input is invalid.",
      { cause: parsedTransport.error },
    );
  }
  const requestedTransport = parsedTransport.data;
  const settings = readRuntimeSettings(input.manifestPath);
  if (
    settings.transport &&
    canonicalJson(settings.transport) !== canonicalJson(requestedTransport)
  ) {
    throw new OnboardingRuntimeError(
      "RUNTIME_SETTINGS_CONFLICT",
      "The requested transport contradicts the existing runtime settings.",
    );
  }
  const setup = setupLocalProfile({
    configPath: manifest.profile_path,
    databasePath: manifest.database_path,
    nodeId: manifest.node_id,
    authorizedNodeIds: manifest.authorized_node_ids,
    mcpCommand: process.execPath,
    mcpCommandArgs: [mcpEntrypoint],
    topicName,
    subscriptionName,
    ...(serviceBusNamespace ? { azureAuthMode: input.authMode } : {}),
    ...(serviceBusNamespace
      ? { serviceBusNamespace }
      : {}),
    ...(input.managedIdentityClientId
      ? { managedIdentityClientId: input.managedIdentityClientId }
      : {}),
    ...(input.azureTenantId ? { azureTenantId: input.azureTenantId } : {}),
    ...(input.azureClientId ? { azureClientId: input.azureClientId } : {}),
    ...(input.azureClientCertificatePath
      ? {
          azureClientCertificatePath: requireAbsolute(
            input.azureClientCertificatePath,
          ),
        }
      : {}),
  });
  if (
    setup.configPath !== manifest.profile_path ||
    setup.databasePath !== manifest.database_path
  ) {
    throw new OnboardingRuntimeError(
      "RUNTIME_SETTINGS_INVALID",
      "The generated transport paths do not match the onboarding manifest.",
    );
  }
  recordOnboardingArtifactHash(
    input.manifestPath,
    "profile",
    manifest.profile_path,
  );
  if (settings.transport) {
    return settings as RuntimeSettings & { transport: z.infer<typeof TransportSchema> };
  }
  return updateSettings(input.manifestPath, { transport: requestedTransport });
}

export function configureDispatcher(
  input: ConfigureDispatcherInput,
): RuntimeSettings & { dispatcher: z.infer<typeof DispatcherSchema> } {
  const manifest = requireCompleteOnboarding(input.manifestPath);
  const settings = readRuntimeSettings(input.manifestPath);
  if (!settings.transport) {
    throw new OnboardingRuntimeError(
      "ONBOARDING_INCOMPLETE",
      "Configure the local transport profile before the dispatcher.",
    );
  }
  const projectPath = requireDirectory(input.projectPath);
  const codexExecutable = requireRegularFile(
    input.codexExecutable,
    "The Codex executable is unavailable.",
  );
  const codeModeHostExecutable = requireRegularFile(
    input.codeModeHostExecutable,
    "The Codex code-mode companion is unavailable.",
  );
  if (
    path.dirname(codexExecutable) !== path.dirname(codeModeHostExecutable) ||
    path.basename(codeModeHostExecutable).toLowerCase() !==
      "codex-code-mode-host.exe"
  ) {
    throw new OnboardingRuntimeError(
      "DISPATCHER_CONFIGURATION_INVALID",
      "Codex and codex-code-mode-host.exe must be pinned from the same directory.",
    );
  }
  const projectsPath = path.join(manifest.root, PROJECTS_FILE);
  const parsedProjects = ProjectRegistrySchema.safeParse({
    schema_version: "1.0",
    projects: [{
      key: input.projectKey,
      path: projectPath,
      enabled: true,
      peer_readable: true,
    }],
  });
  if (!parsedProjects.success) {
    throw new OnboardingRuntimeError(
      "DISPATCHER_CONFIGURATION_INVALID",
      "The dispatcher project registry input is invalid.",
      { cause: parsedProjects.error },
    );
  }
  const projects = parsedProjects.data;
  const authentication = prepareDispatcherAuthentication(input.manifestPath);
  if (!authentication.authenticated) {
    throw new OnboardingRuntimeError(
      "DISPATCHER_CONFIGURATION_INVALID",
      "The dedicated Codex home is not authenticated. Authenticate Codex in the dedicated CODEX_HOME with codex login before configuring the dispatcher.",
    );
  }
  const codexHome = authentication.codexHome;
  const dispatcher = DispatcherSchema.parse({
    configured: true,
    projects_path: projectsPath,
    projects_sha256: hashContent(`${JSON.stringify(projects, null, 2)}\n`),
    codex_executable: codexExecutable,
    codex_sha256: hashFile(codexExecutable),
    code_mode_host_executable: codeModeHostExecutable,
    code_mode_host_sha256: hashFile(codeModeHostExecutable),
    codex_home: codexHome,
    trusted_path: path.dirname(codexExecutable),
  });
  if (settings.dispatcher) {
    if (
      canonicalJson(settings.dispatcher) !== canonicalJson(dispatcher) ||
      readExactJson(projectsPath) !== `${JSON.stringify(projects, null, 2)}\n`
    ) {
      throw new OnboardingRuntimeError(
        "RUNTIME_SETTINGS_CONFLICT",
        "The requested dispatcher contradicts the existing runtime settings.",
      );
    }
    return settings as RuntimeSettings & { dispatcher: z.infer<typeof DispatcherSchema> };
  }
  writeArtifactTransaction(
    input.manifestPath,
    "dispatcher_projects",
    projectsPath,
    projects,
    false,
  );
  return updateSettings(input.manifestPath, { dispatcher });
}

/**
 * Creates and reports the protected dispatcher Codex home so an operator can
 * authenticate it explicitly before dispatcher configuration.
 */
export function prepareDispatcherAuthentication(
  manifestPath: string,
): DispatcherAuthenticationReadiness {
  const manifest = requireCompleteOnboarding(manifestPath);
  const codexHome = resolveCodexHome(manifest.root, manifest.node_id);
  try {
    prepareIdentityDirectory(codexHome);
    validateNodeIdentityDirectory(codexHome);
  } catch (error) {
    throw new OnboardingRuntimeError(
      "DISPATCHER_CONFIGURATION_INVALID",
      "The dedicated Codex home could not be secured.",
      { cause: error },
    );
  }
  try {
    validateCodexAuthentication(codexHome);
    return { codexHome, authenticated: true };
  } catch (error) {
    if (error instanceof OnboardingRuntimeError) {
      return { codexHome, authenticated: false };
    }
    throw error;
  }
}

export function configureMcp(
  input: ConfigureMcpInput,
): RuntimeSettings & { mcp: { configured: true } } {
  const manifest = requireCompleteOnboarding(input.manifestPath);
  const settings = readRuntimeSettings(input.manifestPath);
  if (!settings.transport || !settings.dispatcher) {
    throw new OnboardingRuntimeError(
      "ONBOARDING_INCOMPLETE",
      "Configure the local profile and dispatcher before MCP registration.",
    );
  }
  const codexExecutable = requireRegularFile(
    input.codexExecutable,
    "The Codex executable is unavailable.",
  );
  if (
    !sameResolvedPath(codexExecutable, settings.dispatcher.codex_executable) ||
    hashFile(codexExecutable) !== settings.dispatcher.codex_sha256
  ) {
    throw new OnboardingRuntimeError(
      "RUNTIME_SETTINGS_CONFLICT",
      "The Codex executable does not match the pinned dispatcher executable.",
    );
  }
  const codeModeHostExecutable = requireRegularFile(
    settings.dispatcher.code_mode_host_executable,
    "The pinned Codex code-mode companion is unavailable.",
  );
  if (hashFile(codeModeHostExecutable) !== settings.dispatcher.code_mode_host_sha256) {
    throw new OnboardingRuntimeError(
      "RUNTIME_SETTINGS_CONFLICT",
      "The pinned Codex code-mode companion has changed.",
    );
  }
  try {
    validateNodeIdentityDirectory(settings.dispatcher.codex_home);
  } catch (error) {
    throw new OnboardingRuntimeError(
      "RUNTIME_SETTINGS_CONFLICT",
      "The dedicated Codex home no longer satisfies the local security boundary.",
      { cause: error },
    );
  }
  const mcpEntrypoint = requireRegularFile(
    path.join(requireAbsolute(input.packageRoot), "dist", "mcp", "index.js"),
    "The installed MCP entrypoint is unavailable.",
  );
  const addArgs = [
    "mcp",
    "add",
    "balcony-agent-bridge",
    "--env",
    `BALCONY_SYSTEM_ID=${manifest.node_id}`,
    "--",
    process.execPath,
    mcpEntrypoint,
    "--config",
    manifest.profile_path,
  ];
  const codexEnvironment = buildCodexEnvironment(
    settings.dispatcher.codex_home,
  );
  const runCodex = (args: readonly string[]) => input.runCodex
    ? input.runCodex(args, codexEnvironment)
    : spawnSync(codexExecutable, [...args], {
        encoding: "utf8",
        env: codexEnvironment,
        windowsHide: true,
        timeout: 15_000,
      });
  const getArgs = ["mcp", "get", "balcony-agent-bridge", "--json"];
  const existing = runCodex(getArgs);
  if (existing.status === 0) {
    validateMcpRegistration(existing.stdout, manifest, mcpEntrypoint);
    if (settings.mcp) {
      return settings as RuntimeSettings & { mcp: { configured: true } };
    }
    return updateSettings(input.manifestPath, { mcp: { configured: true } });
  }
  if (settings.mcp) {
    throw new OnboardingRuntimeError(
      "RUNTIME_SETTINGS_CONFLICT",
      "The bound Balcony MCP registration is missing from the dedicated Codex home.",
    );
  }
  if (!/no mcp server|not found|not configured/iu.test(existing.stderr)) {
    throw new OnboardingRuntimeError(
      "MCP_CONFIGURATION_FAILED",
      "Codex could not inspect the dedicated MCP registration.",
    );
  }
  const added = runCodex(addArgs);
  if (added.status !== 0) {
    throw new OnboardingRuntimeError(
      "MCP_CONFIGURATION_FAILED",
      "Codex did not accept the Balcony MCP registration.",
    );
  }
  const verified = runCodex(getArgs);
  if (verified.status !== 0) {
    throw new OnboardingRuntimeError(
      "MCP_CONFIGURATION_FAILED",
      "Codex did not persist the Balcony MCP registration.",
    );
  }
  validateMcpRegistration(verified.stdout, manifest, mcpEntrypoint);
  return updateSettings(input.manifestPath, { mcp: { configured: true } });
}

/**
 * Revalidates the persisted dedicated-home MCP registration without mutating
 * Codex or runtime settings. This is intended for `onboard verify`.
 */
export function verifyMcpRegistration(
  input: VerifyMcpRegistrationInput,
): void {
  const manifest = requireCompleteOnboarding(input.manifestPath);
  const settings = readRuntimeSettings(input.manifestPath);
  if (!settings.dispatcher || !settings.mcp) {
    throw new OnboardingRuntimeError(
      "ONBOARDING_INCOMPLETE",
      "Configure the dispatcher and MCP registration before verifying MCP.",
    );
  }
  const configuredCodexExecutable = requireRegularFile(
    input.codexExecutable ?? settings.dispatcher.codex_executable,
    "The Codex executable is unavailable.",
  );
  if (
    !sameResolvedPath(
      configuredCodexExecutable,
      settings.dispatcher.codex_executable,
    ) ||
    hashFile(configuredCodexExecutable) !== settings.dispatcher.codex_sha256
  ) {
    throw new OnboardingRuntimeError(
      "RUNTIME_SETTINGS_CONFLICT",
      "The Codex executable does not match the pinned dispatcher executable.",
    );
  }
  const mcpEntrypoint = requireRegularFile(
    path.join(requireAbsolute(input.packageRoot), "dist", "mcp", "index.js"),
    "The installed MCP entrypoint is unavailable.",
  );
  const codexEnvironment = buildCodexEnvironment(settings.dispatcher.codex_home);
  const result = input.runCodex
    ? input.runCodex(
        ["mcp", "get", "balcony-agent-bridge", "--json"],
        codexEnvironment,
      )
    : spawnSync(
        configuredCodexExecutable,
        ["mcp", "get", "balcony-agent-bridge", "--json"],
        {
          encoding: "utf8",
          env: codexEnvironment,
          windowsHide: true,
          timeout: 15_000,
        },
      );
  if (result.status !== 0) {
    throw new OnboardingRuntimeError(
      "RUNTIME_SETTINGS_CONFLICT",
      "The bound Balcony MCP registration is missing from the dedicated Codex home.",
    );
  }
  validateMcpRegistration(result.stdout, manifest, mcpEntrypoint);
}

function validateMcpRegistration(
  stdout: string,
  manifest: ReturnType<typeof readOnboardingManifest>,
  mcpEntrypoint: string,
): void {
  try {
    const registration = z.object({
      name: z.literal("balcony-agent-bridge"),
      enabled: z.literal(true),
      transport: z.object({
        type: z.literal("stdio"),
        command: z.string().min(1),
        args: z.array(z.string()),
        env: z.record(z.string(), z.string()),
      }).passthrough(),
    }).passthrough().parse(JSON.parse(stdout));
    if (
      !sameResolvedPath(registration.transport.command, process.execPath) ||
      canonicalJson(registration.transport.args) !== canonicalJson([
        mcpEntrypoint,
        "--config",
        manifest.profile_path,
      ]) ||
      canonicalJson(registration.transport.env) !== canonicalJson({
        BALCONY_SYSTEM_ID: manifest.node_id,
      })
    ) {
      throw new Error("MCP registration does not match onboarding state");
    }
  } catch (error) {
    throw new OnboardingRuntimeError(
      "RUNTIME_SETTINGS_CONFLICT",
      "The existing Balcony MCP registration contradicts onboarding state.",
      { cause: error },
    );
  }
}

export function readRuntimeSettings(manifestPath: string): RuntimeSettings {
  let manifest = readOnboardingManifest(manifestPath);
  try {
    validateNodeIdentityDirectory(manifest.identity_directory);
  } catch (error) {
    throw new OnboardingRuntimeError(
      "RUNTIME_SETTINGS_CONFLICT",
      "The node identity directory no longer satisfies the local security boundary.",
      { cause: error },
    );
  }
  const settingsPath = path.join(manifest.root, RUNTIME_SETTINGS_FILE);
  recoverArtifactTransaction(
    manifestPath,
    manifest,
    "dispatcher_projects",
    path.join(manifest.root, PROJECTS_FILE),
  );
  recoverArtifactTransaction(
    manifestPath,
    manifest,
    "runtime_settings",
    settingsPath,
  );
  manifest = readOnboardingManifest(manifestPath);
  const base = {
    schema_version: "1.0" as const,
    node_id: manifest.node_id,
    network_id: manifest.network_id,
    onboarding_root: manifest.root,
  };
  const metadata = fs.lstatSync(settingsPath, { throwIfNoEntry: false });
  if (!metadata) {
    if (manifest.artifact_sha256["runtime_settings"]) {
      throw new OnboardingRuntimeError(
        "RUNTIME_SETTINGS_INVALID",
        "The bound runtime settings artifact is missing.",
      );
    }
    return RuntimeSettingsSchema.parse(base);
  }
  try {
    if (
      !metadata.isFile() ||
      metadata.isSymbolicLink() ||
      metadata.size > MAX_RUNTIME_SETTINGS_BYTES
    ) {
      throw new Error("unsafe runtime settings artifact");
    }
    const content = fs.readFileSync(settingsPath, "utf8");
    if (manifest.artifact_sha256["runtime_settings"] !== hashContent(content)) {
      throw new Error("runtime settings hash mismatch");
    }
    const settings = RuntimeSettingsSchema.parse(JSON.parse(content));
    validateSettingsBindings(settings, manifest);
    return settings;
  } catch (error) {
    if (error instanceof OnboardingRuntimeError) throw error;
    throw new OnboardingRuntimeError(
      "RUNTIME_SETTINGS_INVALID",
      "The local runtime settings are invalid.",
      { cause: error },
    );
  }
}

function requireCompleteOnboarding(manifestPath: string) {
  const status = resumeOnboarding(manifestPath);
  if (status.status !== "complete") {
    throw new OnboardingRuntimeError(
      "ONBOARDING_INCOMPLETE",
      "Identity, peer enrollment, and membership must be complete first.",
    );
  }
  return status.manifest;
}

function updateSettings<T extends Partial<RuntimeSettings>>(
  manifestPath: string,
  change: T,
): RuntimeSettings & T {
  const manifest = readOnboardingManifest(manifestPath);
  const settingsPath = path.join(manifest.root, RUNTIME_SETTINGS_FILE);
  const current = readRuntimeSettings(manifestPath);
  const updated = RuntimeSettingsSchema.parse({ ...current, ...change });
  writeArtifactTransaction(
    manifestPath,
    "runtime_settings",
    settingsPath,
    updated,
    true,
  );
  return updated as RuntimeSettings & T;
}

function writeArtifactTransaction(
  manifestPath: string,
  artifactName: RuntimeArtifactName,
  filePath: string,
  value: unknown,
  replace: boolean,
): void {
  const manifest = readOnboardingManifest(manifestPath);
  validateNodeIdentityDirectory(manifest.identity_directory);
  const content = `${JSON.stringify(value, null, 2)}\n`;
  const transactionPath = runtimeTransactionPath(manifest.identity_directory, artifactName);
  const transaction = RuntimeTransactionSchema.parse({
    schema_version: "1.0",
    artifact: artifactName,
    previous_sha256: manifest.artifact_sha256[artifactName] ?? null,
    target_sha256: hashContent(content),
  });
  writeNewOrExactJson(transactionPath, transaction);
  if (replace) writeExactJson(filePath, value);
  else writeNewOrExactJson(filePath, value);
  recordOnboardingArtifactHash(manifestPath, artifactName, filePath);
  fs.rmSync(transactionPath);
}

function recoverArtifactTransaction(
  manifestPath: string,
  manifest: ReturnType<typeof readOnboardingManifest>,
  artifactName: RuntimeArtifactName,
  filePath: string,
): void {
  const transactionPath = runtimeTransactionPath(
    manifest.identity_directory,
    artifactName,
  );
  const transactionMetadata = fs.lstatSync(transactionPath, {
    throwIfNoEntry: false,
  });
  if (!transactionMetadata) return;
  try {
    validateNodeIdentityDirectory(manifest.identity_directory);
    if (
      !transactionMetadata.isFile() ||
      transactionMetadata.isSymbolicLink() ||
      transactionMetadata.size > MAX_RUNTIME_SETTINGS_BYTES
    ) {
      throw new Error("unsafe runtime transaction artifact");
    }
    const transaction = RuntimeTransactionSchema.parse(
      JSON.parse(fs.readFileSync(transactionPath, "utf8")),
    );
    if (transaction.artifact !== artifactName) {
      throw new Error("runtime transaction artifact mismatch");
    }
    const targetMetadata = fs.lstatSync(filePath, { throwIfNoEntry: false });
    if (!targetMetadata) {
      if (transaction.previous_sha256 !== null) {
        throw new Error("runtime transaction target disappeared");
      }
      fs.rmSync(transactionPath);
      return;
    }
    if (!targetMetadata.isFile() || targetMetadata.isSymbolicLink()) {
      throw new Error("unsafe runtime transaction target");
    }
    const actualHash = hashFile(filePath);
    if (actualHash === transaction.target_sha256) {
      recordOnboardingArtifactHash(manifestPath, artifactName, filePath);
      fs.rmSync(transactionPath);
      return;
    }
    if (
      transaction.previous_sha256 !== null &&
      actualHash === transaction.previous_sha256 &&
      manifest.artifact_sha256[artifactName] === transaction.previous_sha256
    ) {
      fs.rmSync(transactionPath);
      return;
    }
    throw new Error("runtime transaction target hash mismatch");
  } catch (error) {
    if (error instanceof OnboardingRuntimeError) throw error;
    throw new OnboardingRuntimeError(
      "RUNTIME_SETTINGS_CONFLICT",
      "An interrupted runtime-settings update could not be reconciled safely.",
      { cause: error },
    );
  }
}

function runtimeTransactionPath(
  identityDirectory: string,
  artifactName: RuntimeArtifactName,
): string {
  return path.join(identityDirectory, `.${artifactName}.transaction.json`);
}

function writeExactJson(filePath: string, value: unknown): void {
  const content = `${JSON.stringify(value, null, 2)}\n`;
  if (fs.existsSync(filePath)) {
    requireRegularArtifact(filePath);
    const existing = fs.readFileSync(filePath, "utf8");
    if (existing === content) return;
  }
  const temporary = `${filePath}.${process.pid}.tmp`;
  const backup = `${filePath}.${process.pid}.bak`;
  let movedExisting = false;
  try {
    fs.writeFileSync(temporary, content, { encoding: "utf8", flag: "wx", mode: 0o600 });
    if (fs.existsSync(filePath)) {
      fs.renameSync(filePath, backup);
      movedExisting = true;
    }
    fs.renameSync(temporary, filePath);
    if (movedExisting) fs.rmSync(backup, { force: true });
  } catch (error) {
    if (movedExisting && !fs.existsSync(filePath) && fs.existsSync(backup)) {
      try { fs.renameSync(backup, filePath); } catch { /* preserve original */ }
    }
    try { fs.rmSync(temporary, { force: true }); } catch { /* preserve original */ }
    throw new OnboardingRuntimeError(
      "RUNTIME_SETTINGS_CONFLICT",
      "The local runtime settings could not be updated atomically.",
      { cause: error },
    );
  }
}

function writeNewOrExactJson(filePath: string, value: unknown): void {
  const content = `${JSON.stringify(value, null, 2)}\n`;
  const metadata = fs.lstatSync(filePath, { throwIfNoEntry: false });
  if (metadata) {
    requireRegularArtifact(filePath);
    if (fs.readFileSync(filePath, "utf8") === content) return;
    throw new OnboardingRuntimeError(
      "RUNTIME_SETTINGS_CONFLICT",
      "The existing dispatcher project registry contradicts the request.",
    );
  }
  try {
    fs.writeFileSync(filePath, content, {
      encoding: "utf8",
      flag: "wx",
      mode: 0o600,
    });
  } catch (error) {
    throw new OnboardingRuntimeError(
      "RUNTIME_SETTINGS_CONFLICT",
      "The dispatcher project registry could not be created safely.",
      { cause: error },
    );
  }
}

function readExactJson(filePath: string): string {
  requireRegularArtifact(filePath);
  return fs.readFileSync(filePath, "utf8");
}

function requireRegularArtifact(filePath: string): void {
  const metadata = fs.lstatSync(filePath, { throwIfNoEntry: false });
  if (!metadata?.isFile() || metadata.isSymbolicLink()) {
    throw new OnboardingRuntimeError(
      "RUNTIME_SETTINGS_CONFLICT",
      "A runtime artifact is not a regular local file.",
    );
  }
}

function validateSettingsBindings(
  settings: RuntimeSettings,
  manifest: ReturnType<typeof readOnboardingManifest>,
): void {
  if (
    settings.node_id !== manifest.node_id ||
    settings.network_id !== manifest.network_id ||
    !sameResolvedPath(settings.onboarding_root, manifest.root)
  ) {
    throw new Error("runtime settings do not match the onboarding manifest");
  }
  if (
    settings.transport &&
    (!sameResolvedPath(settings.transport.profile_path, manifest.profile_path) ||
      !sameResolvedPath(settings.transport.database_path, manifest.database_path))
  ) {
    throw new Error("transport paths do not match the onboarding manifest");
  }
  if (settings.transport) {
    requireRegularArtifact(settings.transport.profile_path);
    requireRegularArtifact(settings.transport.database_path);
    const profile = readLocalBridgeProfile(settings.transport.profile_path);
    const expectedProfile = {
      nodeId: manifest.node_id,
      authorizedNodeIds: manifest.authorized_node_ids,
      databasePath: manifest.database_path,
      topicName: settings.transport.topic_name,
      subscriptionName: settings.transport.subscription_name,
      ...(settings.transport.servicebus_namespace
        ? { serviceBusNamespace: settings.transport.servicebus_namespace }
        : {}),
      ...(settings.transport.servicebus_namespace
        ? { azureAuthMode: settings.transport.auth_mode }
        : {}),
      ...(settings.transport.managed_identity_client_id
        ? { managedIdentityClientId: settings.transport.managed_identity_client_id }
        : {}),
      ...(settings.transport.azure_tenant_id
        ? { azureTenantId: settings.transport.azure_tenant_id }
        : {}),
      ...(settings.transport.azure_client_id
        ? { azureClientId: settings.transport.azure_client_id }
        : {}),
      ...(settings.transport.azure_client_certificate_path
        ? { azureClientCertificatePath: settings.transport.azure_client_certificate_path }
        : {}),
    };
    if (canonicalJson(profile) !== canonicalJson(expectedProfile)) {
      throw new Error("transport profile does not match runtime settings");
    }
    if (settings.transport.azure_client_certificate_path) {
      requireRegularArtifact(settings.transport.azure_client_certificate_path);
    }
  }
  if (settings.dispatcher) {
    const projectsPath = path.join(manifest.root, PROJECTS_FILE);
    if (!sameResolvedPath(settings.dispatcher.projects_path, projectsPath)) {
      throw new Error("dispatcher registry path does not match onboarding root");
    }
    const projectsMetadata = fs.lstatSync(projectsPath, { throwIfNoEntry: false });
    if (!projectsMetadata?.isFile() || projectsMetadata.isSymbolicLink()) {
      throw new Error("dispatcher registry is unsafe or unavailable");
    }
    const projectsHash = hashFile(projectsPath);
    if (
      projectsHash !== settings.dispatcher.projects_sha256 ||
      projectsHash !== manifest.artifact_sha256["dispatcher_projects"]
    ) {
      throw new Error("dispatcher registry hash mismatch");
    }
    ProjectRegistry.load(projectsPath);
    const codexExecutable = requireRegularFile(
      settings.dispatcher.codex_executable,
      "The pinned Codex executable is unavailable.",
    );
    const codeModeHostExecutable = requireRegularFile(
      settings.dispatcher.code_mode_host_executable,
      "The pinned Codex code-mode companion is unavailable.",
    );
    if (
      hashFile(codexExecutable) !== settings.dispatcher.codex_sha256 ||
      hashFile(codeModeHostExecutable) !== settings.dispatcher.code_mode_host_sha256
    ) {
      throw new OnboardingRuntimeError(
        "RUNTIME_SETTINGS_CONFLICT",
        "A pinned dispatcher executable has changed.",
      );
    }
    if (!sameResolvedPath(
      settings.dispatcher.codex_home,
      resolveCodexHome(manifest.root, manifest.node_id),
    )) {
      throw new Error("Codex home does not match the onboarding boundary");
    }
    try {
      validateNodeIdentityDirectory(settings.dispatcher.codex_home);
      validateCodexAuthentication(settings.dispatcher.codex_home);
    } catch (error) {
      throw new OnboardingRuntimeError(
        "RUNTIME_SETTINGS_CONFLICT",
        "The dedicated Codex home no longer satisfies the local security boundary.",
        { cause: error },
      );
    }
  }
}

function resolveCodexHome(root: string, nodeId: string): string {
  if (process.platform !== "win32") return path.join(root, "codex-home");
  const protectedDataRoot = process.env["ProgramData"] ?? "C:\\ProgramData";
  const rootId = createHash("sha256")
    .update(root.toLowerCase())
    .digest("hex")
    .slice(0, 16);
  return path.join(
    protectedDataRoot,
    "Balcony",
    "AgentBridge",
    "codex-homes",
    `${nodeId}-${rootId}`,
  );
}

function sameResolvedPath(left: string, right: string): boolean {
  const normalize = (value: string) => process.platform === "win32"
    ? path.resolve(value).toLowerCase()
    : path.resolve(value);
  return normalize(left) === normalize(right);
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  return `{${Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`)
    .join(",")}}`;
}

function hashContent(content: string): string {
  return createHash("sha256").update(content, "utf8").digest("hex");
}

function buildCodexEnvironment(codexHome: string): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = { CODEX_HOME: codexHome };
  for (const name of [
    "PATH",
    "Path",
    "PATHEXT",
    "SystemRoot",
    "WINDIR",
    "COMSPEC",
    "TEMP",
    "TMP",
    "TMPDIR",
    "LOCALAPPDATA",
    "PROGRAMDATA",
    "ProgramData",
    "OS",
    "PROCESSOR_ARCHITECTURE",
    "NUMBER_OF_PROCESSORS",
    "LANG",
    "LC_ALL",
  ]) {
    const value = process.env[name];
    if (value !== undefined) environment[name] = value;
  }
  return environment;
}

function normalizeTransportName(value: string, label: string): string {
  const normalized = value.trim();
  if (!normalized) {
    throw new OnboardingRuntimeError(
      "RUNTIME_SETTINGS_INVALID",
      `The ${label} must not be blank.`,
    );
  }
  return normalized;
}

function validateCodexAuthentication(codexHome: string): void {
  const authPath = path.join(codexHome, "auth.json");
  const metadata = fs.lstatSync(authPath, { throwIfNoEntry: false });
  if (!metadata?.isFile() || metadata.isSymbolicLink()) {
    throw new OnboardingRuntimeError(
      "DISPATCHER_CONFIGURATION_INVALID",
      "The dedicated Codex home is not authenticated. Authenticate Codex in the dedicated CODEX_HOME with codex login before configuring the dispatcher.",
    );
  }
  try {
    const auth = z.object({
      auth_mode: z.string().min(1),
      OPENAI_API_KEY: z.string().min(1).nullable().optional(),
      tokens: z.object({
        access_token: z.string().min(1),
        refresh_token: z.string().min(1),
      }).partial().optional(),
    }).passthrough().parse(JSON.parse(fs.readFileSync(authPath, "utf8")));
    if (!auth.OPENAI_API_KEY && !auth.tokens?.access_token) {
      throw new Error("no Codex credential is present");
    }
  } catch (error) {
    throw new OnboardingRuntimeError(
      "DISPATCHER_CONFIGURATION_INVALID",
      "The dedicated Codex home authentication is invalid. Authenticate Codex in the dedicated CODEX_HOME with codex login before configuring the dispatcher.",
      { cause: error },
    );
  }
}

function requireAbsolute(value: string): string {
  if (!path.isAbsolute(value)) {
    throw new OnboardingRuntimeError(
      "RUNTIME_SETTINGS_INVALID",
      "Runtime paths must be absolute.",
    );
  }
  return path.resolve(value);
}

function requireRegularFile(value: string, message: string): string {
  const resolved = requireAbsolute(value);
  const stat = fs.statSync(resolved, { throwIfNoEntry: false });
  if (!stat?.isFile() || fs.lstatSync(resolved).isSymbolicLink()) {
    throw new OnboardingRuntimeError("RUNTIME_SETTINGS_INVALID", message);
  }
  return resolved;
}

function requireDirectory(value: string): string {
  const resolved = requireAbsolute(value);
  if (resolved.startsWith("\\\\") || resolved.startsWith("//")) {
    throw new OnboardingRuntimeError(
      "DISPATCHER_CONFIGURATION_INVALID",
      "The dispatcher project path must be a local filesystem directory.",
    );
  }
  const stat = fs.statSync(resolved, { throwIfNoEntry: false });
  if (!stat?.isDirectory() || fs.lstatSync(resolved).isSymbolicLink()) {
    throw new OnboardingRuntimeError(
      "DISPATCHER_CONFIGURATION_INVALID",
      "The dispatcher project path must be an existing local directory.",
    );
  }
  return fs.realpathSync.native(resolved);
}

function hashFile(filePath: string): string {
  return createHash("sha256").update(fs.readFileSync(filePath)).digest("hex");
}
