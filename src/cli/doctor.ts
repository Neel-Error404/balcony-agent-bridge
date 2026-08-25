import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import Database from "better-sqlite3";
import { ServiceBusClient } from "@azure/service-bus";

import { loadConfig, requireServiceBusNamespace, type BridgeConfig } from "../config.js";
import { CURRENT_SCHEMA_VERSION } from "../storage/database.js";
import { createServiceBusCredential } from "../transport/service-bus-transport.js";

const REQUIRED_TABLES = [
  "schema_migrations",
  "outbox",
  "inbox",
  "delivery_attempts",
  "runtime_state",
  "consultation_runs",
] as const;
const REQUIRED_INDEXES = [
  "idx_outbox_dispatch",
  "idx_inbox_claim",
  "idx_inbox_causation",
] as const;
const REQUIRED_COLUMNS: Readonly<Record<(typeof REQUIRED_TABLES)[number], readonly string[]>> = {
  schema_migrations: ["version", "applied_at_utc"],
  outbox: [
    "message_id",
    "idempotency_key",
    "target_system",
    "kind",
    "stream_id",
    "payload_sha256",
    "envelope_json",
    "state",
    "attempt_count",
    "next_attempt_at_utc",
    "lease_owner",
    "lease_until_utc",
    "created_at_utc",
    "expires_at_utc",
    "sent_at_utc",
    "last_error_code",
    "last_error",
  ],
  inbox: [
    "message_id",
    "origin_system",
    "kind",
    "stream_id",
    "causation_id",
    "payload_sha256",
    "envelope_json",
    "state",
    "claim_owner",
    "claim_token_hash",
    "claim_until_utc",
    "attempt_count",
    "first_received_at_utc",
    "last_received_at_utc",
    "broker_delivery_count",
    "processed_at_utc",
    "last_error",
    "result_message_id",
    "result_idempotency_key",
    "result_payload_sha256",
    "authenticated_ingress",
  ],
  delivery_attempts: [
    "attempt_id",
    "direction",
    "message_id",
    "attempt_number",
    "started_at_utc",
    "finished_at_utc",
    "outcome",
    "error_code",
    "error_detail",
  ],
  runtime_state: [
    "component",
    "instance_id",
    "status",
    "heartbeat_at_utc",
    "last_error",
  ],
  consultation_runs: [
    "request_message_id",
    "state",
    "version",
    "run_json",
    "created_at_utc",
    "updated_at_utc",
  ],
};
const TRANSPORT_TIMEOUT_MS = 10_000;

export type DoctorCheckStatus = "pass" | "fail" | "skipped";

export interface DoctorCheck {
  name:
    | "runtime_build"
    | "configuration"
    | "identity_configuration"
    | "database"
    | "transport_send_link";
  status: DoctorCheckStatus;
  code?: string;
  authorized_node_count?: number;
  transport_configured?: boolean;
}

export interface DoctorReport {
  ok: boolean;
  exitCode: 0 | 1;
  checks: readonly DoctorCheck[];
}

export type DoctorTransportProbe = (
  config: BridgeConfig,
  signal: AbortSignal,
) => Promise<void>;

export interface DoctorOptions {
  checkTransport?: boolean;
  loadConfig?: () => BridgeConfig;
  nodeVersion?: string;
  runtimeFiles?: readonly string[];
  transportProbe?: DoctorTransportProbe;
}

export async function runDoctor(
  options: DoctorOptions = {},
): Promise<DoctorReport> {
  const checks: DoctorCheck[] = [
    inspectRuntime(options.nodeVersion ?? process.version, options.runtimeFiles),
  ];
  const configResult = inspectConfiguration(options.loadConfig ?? loadConfig);
  checks.push(configResult.check);

  if (!configResult.config) {
    checks.push({
      name: "identity_configuration",
      status: "skipped",
      code: "CONFIGURATION_UNAVAILABLE",
    });
    checks.push({
      name: "database",
      status: "skipped",
      code: "CONFIGURATION_UNAVAILABLE",
    });
    checks.push({
      name: "transport_send_link",
      status: "skipped",
      code: options.checkTransport ? "CONFIGURATION_UNAVAILABLE" : "NOT_REQUESTED",
    });
    return toReport(checks);
  }

  const identityCheck = inspectIdentity(configResult.config);
  checks.push(identityCheck);
  checks.push(inspectDatabase(configResult.config.databasePath));
  checks.push(identityCheck.status === "fail" && options.checkTransport
    ? {
        name: "transport_send_link",
        status: "skipped",
        code: "IDENTITY_CONFIGURATION_UNAVAILABLE",
      }
    : await inspectTransport(
        configResult.config,
        options.checkTransport ?? false,
        options.transportProbe ?? probeTransportSenderLink,
      ));
  return toReport(checks);
}

function inspectIdentity(config: BridgeConfig): DoctorCheck {
  if (!config.serviceBusNamespace) {
    return {
      name: "identity_configuration",
      status: "skipped",
      code: "LOCAL_ONLY",
    };
  }
  if (config.azureAuthMode === "managed_identity") {
    return { name: "identity_configuration", status: "pass" };
  }
  if (
    !config.azureTenantId ||
    !config.azureClientId ||
    !config.azureClientCertificatePath ||
    !path.isAbsolute(config.azureClientCertificatePath)
  ) {
    return {
      name: "identity_configuration",
      status: "fail",
      code: "IDENTITY_CONFIGURATION_INVALID",
    };
  }
  try {
    if (!fs.statSync(config.azureClientCertificatePath).isFile()) {
      throw new Error("certificate path is not a file");
    }
  } catch {
    return {
      name: "identity_configuration",
      status: "fail",
      code: "IDENTITY_CERTIFICATE_UNAVAILABLE",
    };
  }
  return { name: "identity_configuration", status: "pass" };
}

function inspectRuntime(
  nodeVersion: string,
  runtimeFiles: readonly string[] | undefined,
): DoctorCheck {
  const major = Number.parseInt(nodeVersion.replace(/^v/u, "").split(".")[0] ?? "", 10);
  const files = runtimeFiles ?? defaultRuntimeFiles();
  if (major < 22 || !Number.isFinite(major) || files.some((file) => !fs.existsSync(file))) {
    return { name: "runtime_build", status: "fail", code: "PACKAGE_RUNTIME_UNSUPPORTED" };
  }
  return { name: "runtime_build", status: "pass" };
}

function defaultRuntimeFiles(): readonly string[] {
  const modulePath = fileURLToPath(import.meta.url);
  const extension = path.extname(modulePath);
  const runtimeRoot = path.resolve(path.dirname(modulePath), "..");
  return [
    modulePath,
    path.join(runtimeRoot, "cli", `index${extension}`),
    path.join(runtimeRoot, "bridge", `index${extension}`),
    path.join(runtimeRoot, "mcp", `index${extension}`),
    path.join(runtimeRoot, "dispatcher", `index${extension}`),
  ];
}

function inspectConfiguration(load: () => BridgeConfig): {
  check: DoctorCheck;
  config?: BridgeConfig;
} {
  try {
    const config = load();
    return {
      config,
      check: {
        name: "configuration",
        status: "pass",
        authorized_node_count: config.authorizedNodeIds.length,
        transport_configured: Boolean(config.serviceBusNamespace),
      },
    };
  } catch {
    return {
      check: { name: "configuration", status: "fail", code: "CONFIGURATION_ERROR" },
    };
  }
}

function inspectDatabase(databasePath: string): DoctorCheck {
  let database: Database.Database | undefined;
  try {
    database = new Database(databasePath, { readonly: true, fileMustExist: true });
    const quickCheck = database
      .prepare("PRAGMA quick_check")
      .all() as Array<{ quick_check: string }>;
    if (quickCheck.length !== 1 || quickCheck[0]?.quick_check !== "ok") {
      return { name: "database", status: "fail", code: "DATABASE_INTEGRITY_FAILED" };
    }

    const tables = sqliteObjects(database, "table");
    const indexes = sqliteObjects(database, "index");
    const hasSchema = REQUIRED_TABLES.every((name) => tables.has(name)) &&
      REQUIRED_INDEXES.every((name) => indexes.has(name)) &&
      REQUIRED_TABLES.every((name) =>
        hasRequiredColumns(database!, name, REQUIRED_COLUMNS[name]),
      );
    const migration = database
      .prepare(
        "SELECT COUNT(*) AS count, MAX(version) AS maximum FROM schema_migrations WHERE version <= ?",
      )
      .get(CURRENT_SCHEMA_VERSION) as { count: number; maximum: number | null };
    const maximum = database
      .prepare("SELECT MAX(version) AS version FROM schema_migrations")
      .get() as { version: number | null };
    if (
      !hasSchema ||
      migration.count !== CURRENT_SCHEMA_VERSION ||
      migration.maximum !== CURRENT_SCHEMA_VERSION ||
      maximum.version !== CURRENT_SCHEMA_VERSION
    ) {
      return { name: "database", status: "fail", code: "DATABASE_SCHEMA_UNSUPPORTED" };
    }
    return { name: "database", status: "pass" };
  } catch (error) {
    const code = error instanceof Error && /no such file|unable to open database file/iu.test(error.message)
      ? "DATABASE_MISSING"
      : "DATABASE_UNAVAILABLE";
    return { name: "database", status: "fail", code };
  } finally {
    database?.close();
  }
}

function hasRequiredColumns(
  database: Database.Database,
  table: (typeof REQUIRED_TABLES)[number],
  requiredColumns: readonly string[],
): boolean {
  const rows = database
    .prepare(`PRAGMA table_info("${table}")`)
    .all() as Array<{ name: string }>;
  const columns = new Set(rows.map((row) => row.name));
  return requiredColumns.every((column) => columns.has(column));
}

function sqliteObjects(database: Database.Database, type: "table" | "index"): Set<string> {
  const rows = database
    .prepare("SELECT name FROM sqlite_master WHERE type = ?")
    .all(type) as Array<{ name: string }>;
  return new Set(rows.map((row) => row.name));
}

async function inspectTransport(
  config: BridgeConfig,
  requested: boolean,
  probe: DoctorTransportProbe,
): Promise<DoctorCheck> {
  if (!requested) {
    return { name: "transport_send_link", status: "skipped", code: "NOT_REQUESTED" };
  }
  if (!config.serviceBusNamespace) {
    return {
      name: "transport_send_link",
      status: "fail",
      code: "TRANSPORT_CONFIGURATION_MISSING",
    };
  }

  const signal = AbortSignal.timeout(TRANSPORT_TIMEOUT_MS);
  try {
    await probe(config, signal);
    return { name: "transport_send_link", status: "pass" };
  } catch {
    return {
      name: "transport_send_link",
      status: "fail",
      code: signal.aborted ? "TRANSPORT_TIMEOUT" : "TRANSPORT_UNREACHABLE",
    };
  }
}

async function probeTransportSenderLink(
  config: BridgeConfig,
  signal: AbortSignal,
): Promise<void> {
  const namespace = requireServiceBusNamespace(config);
  if (config.azureAuthMode === "client_certificate") {
    if (!config.azureClientCertificatePath || !fs.statSync(config.azureClientCertificatePath).isFile()) {
      throw new Error("Client certificate is unavailable");
    }
  }
  const credential = createServiceBusCredential(config);
  const client = new ServiceBusClient(namespace, credential, {
    retryOptions: { maxRetries: 0, timeoutInMs: TRANSPORT_TIMEOUT_MS },
  });
  const sender = client.createSender(config.topicName, {
    identifier: "balcony-agent-bridge-doctor",
  });
  try {
    await sender.createMessageBatch({ abortSignal: signal });
  } finally {
    await Promise.allSettled([sender.close(), client.close()]);
  }
}

function toReport(checks: readonly DoctorCheck[]): DoctorReport {
  const ok = checks.every((check) => check.status !== "fail");
  return { ok, exitCode: ok ? 0 : 1, checks };
}
