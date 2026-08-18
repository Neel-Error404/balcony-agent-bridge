import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  loadConfig,
  loadReadOnlyDispatcherConfig,
  requireServiceBusNamespace,
} from "../../src/config.js";

describe("bridge configuration", () => {
  it("derives the peer and subscription from the declared system", () => {
    const config = loadConfig({
      BALCONY_SYSTEM_ID: "SYS-A",
      ProgramData: "D:\\ProgramData",
    });

    expect(config.systemId).toBe("SYS-A");
    expect(config.peerSystemId).toBe("SYS-B");
    expect(config.subscriptionName).toBe("sys-a");
    expect(config.databasePath).toContain("Balcony");
    expect(config.azureAuthMode).toBe("managed_identity");
  });

  it("fails explicitly without a declared system", () => {
    expect(() => loadConfig({})).toThrow(/BALCONY_SYSTEM_ID/);
  });

  it("requires the Service Bus namespace only for transport use", () => {
    const config = loadConfig({
      BALCONY_SYSTEM_ID: "SYS-B",
      BALCONY_BRIDGE_DB_PATH: "D:\\bridge.sqlite3",
    });

    expect(() => requireServiceBusNamespace(config)).toThrow(
      /BALCONY_SERVICEBUS_NAMESPACE/,
    );
  });

  it("requires a fully qualified Service Bus namespace", () => {
    expect(() =>
      loadConfig({
        BALCONY_SYSTEM_ID: "SYS-A",
        BALCONY_SERVICEBUS_NAMESPACE: "short-namespace-name",
      }),
    ).toThrow(/fully qualified Azure Service Bus namespace/);

    const config = loadConfig({
      BALCONY_SYSTEM_ID: "SYS-A",
      BALCONY_SERVICEBUS_NAMESPACE:
        "approved-namespace.servicebus.windows.net",
    });

    expect(config.serviceBusNamespace).toBe(
      "approved-namespace.servicebus.windows.net",
    );
  });

  it("loads an explicit client-certificate authentication mode", () => {
    const config = loadConfig({
      BALCONY_SYSTEM_ID: "SYS-A",
      BALCONY_AZURE_AUTH_MODE: "client_certificate",
      BALCONY_AZURE_TENANT_ID:
        "11111111-1111-4111-8111-111111111111",
      BALCONY_AZURE_CLIENT_ID:
        "22222222-2222-4222-8222-222222222222",
      BALCONY_AZURE_CLIENT_CERTIFICATE_PATH:
        "C:\\ProgramData\\Balcony\\AgentBridge\\credentials\\sys-a.pem",
    });

    expect(config.azureAuthMode).toBe("client_certificate");
    expect(config.azureTenantId).toBe(
      "11111111-1111-4111-8111-111111111111",
    );
    expect(config.azureClientId).toBe(
      "22222222-2222-4222-8222-222222222222",
    );
    expect(config.azureClientCertificatePath).toContain("sys-a.pem");
  });

  it("loads an explicit read-only dispatcher configuration", () => {
    const config = loadReadOnlyDispatcherConfig({
      BALCONY_SYSTEM_ID: "SYS-A",
      BALCONY_BRIDGE_DB_PATH: "D:\\bridge.sqlite3",
      BALCONY_DISPATCHER_PROJECTS_PATH:
        "D:\\local\\dispatcher-projects.json",
      BALCONY_CODEX_EXECUTABLE: "D:\\tools\\codex.ps1",
      BALCONY_CODEX_EXECUTABLE_SHA256: "a".repeat(64),
      BALCONY_DISPATCHER_CODEX_HOME: "D:\\local\\codex-home",
      BALCONY_DISPATCHER_TRUSTED_PATH: "C:\\trusted-node",
      BALCONY_DISPATCHER_POLL_INTERVAL_MS: "1500",
      BALCONY_DISPATCHER_DEFAULT_TIMEOUT_SECONDS: "120",
      BALCONY_DISPATCHER_MAX_OUTPUT_BYTES: "32000",
    });

    expect(config.systemId).toBe("SYS-A");
    expect(config.peerSystemId).toBe("SYS-B");
    expect(config.pollIntervalMs).toBe(1500);
    expect(config.defaultTimeoutSeconds).toBe(120);
    expect(config.maxOutputBytes).toBe(32000);
    expect(config.codexExecutableSha256).toBe("a".repeat(64));
    expect(config.trustedPath).toBe("C:\\trusted-node");
  });

  it("fails closed when dispatcher execution paths are not declared", () => {
    expect(() =>
      loadReadOnlyDispatcherConfig({
        BALCONY_SYSTEM_ID: "SYS-A",
      }),
    ).toThrow(/BALCONY_DISPATCHER_PROJECTS_PATH/);
  });

  it("loads explicit consultation-mode executable and containment settings", () => {
    const config = loadReadOnlyDispatcherConfig({
      BALCONY_SYSTEM_ID: "SYS-B",
      BALCONY_BRIDGE_DB_PATH: "E:\\bridge.sqlite3",
      BALCONY_DISPATCHER_PROJECTS_PATH:
        "E:\\local\\dispatcher-projects.json",
      BALCONY_CODEX_EXECUTABLE: "E:\\tools\\codex.exe",
      BALCONY_CODEX_EXECUTABLE_SHA256: "a".repeat(64),
      BALCONY_DISPATCHER_CODEX_HOME: "E:\\local\\codex-home",
      BALCONY_DISPATCHER_TRUSTED_PATH: "C:\\trusted-node",
      BALCONY_DISPATCHER_MODE: "consultation",
      BALCONY_CONSULTATION_WORKING_DIRECTORY:
        "E:\\local\\evidence-only",
      BALCONY_GIT_EXECUTABLE: "C:\\tools\\git.exe",
      BALCONY_GIT_EXECUTABLE_SHA256: "b".repeat(64),
    });

    expect(config).toMatchObject({
      mode: "consultation",
      consultationWorkingDirectory:
        path.resolve("E:\\local\\evidence-only"),
      gitExecutable: path.resolve("C:\\tools\\git.exe"),
      gitExecutableSha256: "b".repeat(64),
    });
  });

  it("fails closed when consultation mode lacks its pinned Git controls", () => {
    expect(() =>
      loadReadOnlyDispatcherConfig({
        BALCONY_SYSTEM_ID: "SYS-B",
        BALCONY_DISPATCHER_PROJECTS_PATH:
          "E:\\local\\dispatcher-projects.json",
        BALCONY_CODEX_EXECUTABLE: "E:\\tools\\codex.exe",
        BALCONY_CODEX_EXECUTABLE_SHA256: "a".repeat(64),
        BALCONY_DISPATCHER_CODEX_HOME: "E:\\local\\codex-home",
        BALCONY_DISPATCHER_TRUSTED_PATH: "C:\\trusted-node",
        BALCONY_DISPATCHER_MODE: "consultation",
      }),
    ).toThrow(
      /BALCONY_CONSULTATION_WORKING_DIRECTORY|BALCONY_GIT_EXECUTABLE/,
    );
  });
});
