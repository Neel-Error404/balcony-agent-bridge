import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import Database from "better-sqlite3";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { BridgeConfig } from "../../src/config.js";
import { runDoctor } from "../../src/cli/doctor.js";
import { BridgeDatabase } from "../../src/storage/database.js";

const temporaryDirectories: string[] = [];
const validMessageAuthenticationProbe = (): void => undefined;

describe("bridge doctor", () => {
  afterEach(() => {
    for (const directory of temporaryDirectories.splice(0)) {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  it("reports a healthy readonly local runtime without leaking local identifiers", async () => {
    const databasePath = createHealthyDatabase();
    const report = await runDoctor({
      loadConfig: () => config(databasePath),
      messageAuthenticationProbe: validMessageAuthenticationProbe,
      nodeVersion: "v22.0.0",
      runtimeFiles: [databasePath],
    });

    expect(report).toEqual({
      ok: true,
      exitCode: 0,
      checks: [
        { name: "runtime_build", status: "pass" },
        {
          name: "configuration",
          status: "pass",
          authorized_node_count: 1,
          transport_configured: false,
        },
        {
          name: "identity_configuration",
          status: "skipped",
          code: "LOCAL_ONLY",
        },
        { name: "message_authentication", status: "pass" },
        { name: "database", status: "pass" },
        { name: "transport_send_link", status: "skipped", code: "NOT_REQUESTED" },
      ],
    });
    expect(JSON.stringify(report)).not.toContain(databasePath);
    expect(JSON.stringify(report)).not.toContain("local-node");
  });

  it("fails safely when the existing database does not have the signed-ingress migration", async () => {
    const databasePath = createHealthyDatabase({ includeSignedIngressMigration: false });
    const report = await runDoctor({
      loadConfig: () => config(databasePath),
      messageAuthenticationProbe: validMessageAuthenticationProbe,
      nodeVersion: "v22.0.0",
      runtimeFiles: [databasePath],
    });

    expect(report.ok).toBe(false);
    expect(report.exitCode).toBe(1);
    expect(report.checks).toContainEqual({
      name: "database",
      status: "fail",
      code: "DATABASE_SCHEMA_UNSUPPORTED",
    });
    expect(JSON.stringify(report)).not.toContain(databasePath);
  });

  it("rejects a current migration marker on an incomplete schema", async () => {
    const databasePath = createIncompleteDatabase();
    const report = await runDoctor({
      loadConfig: () => config(databasePath),
      messageAuthenticationProbe: validMessageAuthenticationProbe,
      nodeVersion: "v22.0.0",
      runtimeFiles: [databasePath],
    });

    expect(report.checks).toContainEqual({
      name: "database",
      status: "fail",
      code: "DATABASE_SCHEMA_UNSUPPORTED",
    });
  });

  it("rejects a current schema without the outbox idempotency constraint", async () => {
    const databasePath = createDatabaseWithoutOutboxUniqueness();
    const report = await runDoctor({
      loadConfig: () => config(databasePath),
      messageAuthenticationProbe: validMessageAuthenticationProbe,
      nodeVersion: "v22.0.0",
      runtimeFiles: [databasePath],
    });

    expect(report.checks).toContainEqual({
      name: "database",
      status: "fail",
      code: "DATABASE_SCHEMA_UNSUPPORTED",
    });
  });

  it("rejects a database created by a newer runtime", async () => {
    const databasePath = createHealthyDatabase();
    const database = new Database(databasePath);
    try {
      database
        .prepare(
          "INSERT INTO schema_migrations (version, applied_at_utc) VALUES (9, ?)",
        )
        .run("2026-08-25T00:00:00.000Z");
    } finally {
      database.close();
    }

    const report = await runDoctor({
      loadConfig: () => config(databasePath),
      messageAuthenticationProbe: validMessageAuthenticationProbe,
      nodeVersion: "v22.0.0",
      runtimeFiles: [databasePath],
    });

    expect(report.checks).toContainEqual({
      name: "database",
      status: "fail",
      code: "DATABASE_SCHEMA_UNSUPPORTED",
    });
  });

  it("checks every packaged runtime entrypoint by default", async () => {
    const databasePath = createHealthyDatabase();
    const checkedPaths: string[] = [];
    const originalExistsSync = fs.existsSync;
    const existsSync = vi.spyOn(fs, "existsSync").mockImplementation((file) => {
      const candidate = String(file);
      checkedPaths.push(candidate);
      return candidate.endsWith(path.join("dispatcher", "index.ts"))
        ? false
        : originalExistsSync(file);
    });
    try {
      const report = await runDoctor({
        loadConfig: () => config(databasePath),
        messageAuthenticationProbe: validMessageAuthenticationProbe,
        nodeVersion: "v22.0.0",
      });

      expect(report.checks).toContainEqual({
        name: "runtime_build",
        status: "fail",
        code: "PACKAGE_RUNTIME_UNSUPPORTED",
      });
      for (const entrypoint of ["cli", "bridge", "mcp", "dispatcher"]) {
        expect(checkedPaths).toContainEqual(
          expect.stringContaining(path.join(entrypoint, "index.ts")),
        );
      }
    } finally {
      existsSync.mockRestore();
    }
  });

  it("fails requested transport checks without configuration and does not invoke a probe", async () => {
    const databasePath = createHealthyDatabase();
    let probeCalls = 0;
    const report = await runDoctor({
      checkTransport: true,
      loadConfig: () => config(databasePath),
      messageAuthenticationProbe: validMessageAuthenticationProbe,
      nodeVersion: "v22.0.0",
      runtimeFiles: [databasePath],
      transportProbe: async () => {
        probeCalls += 1;
      },
    });

    expect(report.ok).toBe(false);
    expect(report.exitCode).toBe(1);
    expect(probeCalls).toBe(0);
    expect(report.checks).toContainEqual({
      name: "transport_send_link",
      status: "fail",
      code: "TRANSPORT_CONFIGURATION_MISSING",
    });
  });

  it("uses the injected transport probe and returns only a stable failure code", async () => {
    const databasePath = createHealthyDatabase();
    let receivedSignal: AbortSignal | undefined;
    const report = await runDoctor({
      checkTransport: true,
      loadConfig: () => config(databasePath, "configured.servicebus.windows.net"),
      messageAuthenticationProbe: validMessageAuthenticationProbe,
      nodeVersion: "v22.0.0",
      runtimeFiles: [databasePath],
      transportProbe: async (_config, signal) => {
        receivedSignal = signal;
        throw new Error("Bearer private-token at C:\\private\\certificate.pem");
      },
    });

    expect(receivedSignal).toBeDefined();
    expect(report.ok).toBe(false);
    expect(report.checks).toContainEqual({
      name: "transport_send_link",
      status: "fail",
      code: "TRANSPORT_UNREACHABLE",
    });
    expect(JSON.stringify(report)).not.toContain("private-token");
    expect(JSON.stringify(report)).not.toContain("certificate.pem");
  });

  it("reports a missing configured certificate without contacting Azure", async () => {
    const databasePath = createHealthyDatabase();
    let probeCalls = 0;
    const report = await runDoctor({
      checkTransport: true,
      loadConfig: () => ({
        ...config(databasePath),
        serviceBusNamespace: "configured.servicebus.windows.net",
        azureAuthMode: "client_certificate",
        azureTenantId: "11111111-1111-4111-8111-111111111111",
        azureClientId: "22222222-2222-4222-8222-222222222222",
        azureClientCertificatePath: path.join(
          path.dirname(databasePath),
          "missing.pem",
        ),
      }),
      messageAuthenticationProbe: validMessageAuthenticationProbe,
      nodeVersion: "v22.0.0",
      runtimeFiles: [databasePath],
      transportProbe: async () => {
        probeCalls += 1;
      },
    });

    expect(report.ok).toBe(false);
    expect(probeCalls).toBe(0);
    expect(report.checks).toContainEqual({
      name: "identity_configuration",
      status: "fail",
      code: "IDENTITY_CERTIFICATE_UNAVAILABLE",
    });
    expect(report.checks).toContainEqual({
      name: "transport_send_link",
      status: "skipped",
      code: "RUNTIME_CONFIGURATION_UNAVAILABLE",
    });
  });

  it("fails safely when mandatory message authentication is unavailable", async () => {
    const databasePath = createHealthyDatabase();
    let transportProbeCalls = 0;
    const report = await runDoctor({
      checkTransport: true,
      loadConfig: () => config(
        databasePath,
        "configured.servicebus.windows.net",
      ),
      messageAuthenticationProbe: () => {
        throw new Error("private membership path and signing key detail");
      },
      nodeVersion: "v22.0.0",
      runtimeFiles: [databasePath],
      transportProbe: async () => {
        transportProbeCalls += 1;
      },
    });

    expect(report.ok).toBe(false);
    expect(report.exitCode).toBe(1);
    expect(transportProbeCalls).toBe(0);
    expect(report.checks).toContainEqual({
      name: "message_authentication",
      status: "fail",
      code: "MESSAGE_AUTHENTICATION_INVALID",
    });
    expect(report.checks).toContainEqual({
      name: "transport_send_link",
      status: "skipped",
      code: "RUNTIME_CONFIGURATION_UNAVAILABLE",
    });
    expect(JSON.stringify(report)).not.toContain("membership path");
    expect(JSON.stringify(report)).not.toContain("signing key");
  });
});

function config(databasePath: string, serviceBusNamespace?: string): BridgeConfig {
  return {
    systemId: "local-node",
    authorizedNodeIds: ["remote-node"],
    databasePath,
    ...(serviceBusNamespace ? { serviceBusNamespace } : {}),
    topicName: "agent-messages",
    subscriptionName: "local-node",
    azureAuthMode: "managed_identity",
    ...(serviceBusNamespace
      ? { managedIdentityClientId: "11111111-1111-4111-8111-111111111111" }
      : {}),
  };
}

function createHealthyDatabase(
  options: { includeSignedIngressMigration?: boolean } = {},
): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "bridge-doctor-"));
  temporaryDirectories.push(root);
  const databasePath = path.join(root, "bridge.sqlite3");
  const bridgeDatabase = new BridgeDatabase(databasePath);
  bridgeDatabase.close();
  if (options.includeSignedIngressMigration === false) {
    const database = new Database(databasePath);
    try {
      database.prepare("DELETE FROM schema_migrations WHERE version = 6").run();
    } finally {
      database.close();
    }
  }
  return databasePath;
}

function createIncompleteDatabase(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "bridge-doctor-incomplete-"));
  temporaryDirectories.push(root);
  const databasePath = path.join(root, "bridge.sqlite3");
  const database = new Database(databasePath);
  try {
    database.exec(`
      CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, applied_at_utc TEXT NOT NULL);
      INSERT INTO schema_migrations (version, applied_at_utc) VALUES (1, '2026-08-25T00:00:00.000Z');
      INSERT INTO schema_migrations (version, applied_at_utc) VALUES (5, '2026-08-25T00:00:00.000Z');
      INSERT INTO schema_migrations (version, applied_at_utc) VALUES (6, '2026-08-25T00:00:00.000Z');
      INSERT INTO schema_migrations (version, applied_at_utc) VALUES (7, '2026-08-25T00:00:00.000Z');
      CREATE TABLE outbox (message_id TEXT PRIMARY KEY);
      CREATE TABLE inbox (message_id TEXT PRIMARY KEY);
      CREATE TABLE delivery_attempts (attempt_id TEXT PRIMARY KEY);
      CREATE TABLE runtime_state (component TEXT PRIMARY KEY);
      CREATE TABLE consultation_runs (request_message_id TEXT PRIMARY KEY);
      CREATE INDEX idx_outbox_dispatch ON outbox (message_id);
      CREATE INDEX idx_inbox_claim ON inbox (message_id);
      CREATE INDEX idx_inbox_causation ON inbox (message_id);
    `);
  } finally {
    database.close();
  }
  return databasePath;
}

function createDatabaseWithoutOutboxUniqueness(): string {
  const databasePath = createHealthyDatabase();
  const database = new Database(databasePath);
  try {
    database.exec(`
      DROP INDEX idx_outbox_dispatch;
      ALTER TABLE outbox RENAME TO outbox_with_uniqueness;
      CREATE TABLE outbox (
        message_id TEXT PRIMARY KEY,
        idempotency_key TEXT NOT NULL,
        target_system TEXT NOT NULL,
        kind TEXT NOT NULL,
        stream_id TEXT NOT NULL,
        payload_sha256 TEXT NOT NULL,
        envelope_json TEXT NOT NULL,
        state TEXT NOT NULL,
        attempt_count INTEGER NOT NULL DEFAULT 0,
        next_attempt_at_utc TEXT NOT NULL,
        lease_owner TEXT,
        lease_until_utc TEXT,
        created_at_utc TEXT NOT NULL,
        expires_at_utc TEXT,
        sent_at_utc TEXT,
        last_error_code TEXT,
        last_error TEXT
      );
      DROP TABLE outbox_with_uniqueness;
      CREATE INDEX idx_outbox_dispatch
        ON outbox (state, next_attempt_at_utc, created_at_utc);
    `);
  } finally {
    database.close();
  }
  return databasePath;
}
