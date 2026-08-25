import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";

import type { BridgeConfig } from "../../src/config.js";
import { runDoctor } from "../../src/cli/doctor.js";

const temporaryDirectories: string[] = [];

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
        { name: "database", status: "pass" },
        { name: "transport_send_link", status: "skipped", code: "NOT_REQUESTED" },
      ],
    });
    expect(JSON.stringify(report)).not.toContain(databasePath);
    expect(JSON.stringify(report)).not.toContain("local-node");
  });

  it("fails safely when the existing database does not have schema migration five", async () => {
    const databasePath = createHealthyDatabase({ includeMigrationFive: false });
    const report = await runDoctor({
      loadConfig: () => config(databasePath),
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

  it("fails requested transport checks without configuration and does not invoke a probe", async () => {
    const databasePath = createHealthyDatabase();
    let probeCalls = 0;
    const report = await runDoctor({
      checkTransport: true,
      loadConfig: () => config(databasePath),
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
      code: "IDENTITY_CONFIGURATION_UNAVAILABLE",
    });
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

function createHealthyDatabase(options: { includeMigrationFive?: boolean } = {}): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "bridge-doctor-"));
  temporaryDirectories.push(root);
  const databasePath = path.join(root, "bridge.sqlite3");
  const database = new Database(databasePath);
  try {
    database.exec(`
      CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, applied_at_utc TEXT NOT NULL);
      INSERT INTO schema_migrations (version, applied_at_utc) VALUES (1, '2026-08-25T00:00:00.000Z');
      ${options.includeMigrationFive === false ? "" : "INSERT INTO schema_migrations (version, applied_at_utc) VALUES (5, '2026-08-25T00:00:00.000Z');"}
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
