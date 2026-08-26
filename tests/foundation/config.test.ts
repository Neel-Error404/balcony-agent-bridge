import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  assertConfigMatchesProcessIdentity,
  loadConfig,
  loadMessageAuthenticationRuntimeConfig,
  loadReadOnlyDispatcherConfig,
  requireServiceBusNamespace,
} from "../../src/config.js";

describe("bridge configuration", () => {
  it("loads a generic local node and an explicit bounded authorization list", () => {
    const config = loadConfig({
      BALCONY_SYSTEM_ID: "review-node-01",
      BALCONY_AUTHORIZED_NODE_IDS: "review-node-02,review-node-03",
    });

    expect(config.systemId).toBe("review-node-01");
    expect(config.authorizedNodeIds).toEqual([
      "review-node-02",
      "review-node-03",
    ]);
    expect(config).not.toHaveProperty("peerSystemId");
  });

  it("fails closed without explicit authorized remote nodes", () => {
    expect(() =>
      loadConfig({
        BALCONY_SYSTEM_ID: "SYS-A",
      }),
    ).toThrow(/BALCONY_AUTHORIZED_NODE_IDS/);
  });

  it("rejects duplicate, self, and invalid authorized node IDs", () => {
    for (const authorized of [
      "SYS-B,SYS-B",
      "SYS-A,SYS-B",
      "node with spaces",
    ]) {
      expect(() =>
        loadConfig({
          BALCONY_SYSTEM_ID: "SYS-A",
          BALCONY_AUTHORIZED_NODE_IDS: authorized,
        }),
      ).toThrow(/BALCONY_AUTHORIZED_NODE_IDS/);
    }
  });

  it("loads the authorized peer and subscription from explicit configuration", () => {
    const config = loadConfig({
      BALCONY_SYSTEM_ID: "SYS-A",
      BALCONY_AUTHORIZED_NODE_IDS: "SYS-B",
      ProgramData: "D:\\ProgramData",
    });

    expect(config.systemId).toBe("SYS-A");
    expect(config.authorizedNodeIds).toEqual(["SYS-B"]);
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
      BALCONY_AUTHORIZED_NODE_IDS: "SYS-A",
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
        BALCONY_AUTHORIZED_NODE_IDS: "SYS-B",
        BALCONY_SERVICEBUS_NAMESPACE: "short-namespace-name",
      }),
    ).toThrow(/fully qualified Azure Service Bus namespace/);

    const config = loadConfig({
      BALCONY_SYSTEM_ID: "SYS-A",
      BALCONY_AUTHORIZED_NODE_IDS: "SYS-B",
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
      BALCONY_AUTHORIZED_NODE_IDS: "SYS-B",
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

  it("binds explicit local profiles to the process-scoped identity", () => {
    const config = loadConfig({
      BALCONY_SYSTEM_ID: "node-a",
      BALCONY_AUTHORIZED_NODE_IDS: "node-b",
    });

    expect(
      assertConfigMatchesProcessIdentity(config, {
        BALCONY_SYSTEM_ID: "node-a",
      }),
    ).toBe(config);
    expect(assertConfigMatchesProcessIdentity(config, {})).toBe(config);
    for (const processIdentity of ["node-b", "invalid identity"]) {
      expect(() =>
        assertConfigMatchesProcessIdentity(config, {
          BALCONY_SYSTEM_ID: processIdentity,
        }),
      ).toThrow(/profile identity does not match process identity/i);
    }
  });

  it("rejects mixed or incomplete Azure identity environment fields", () => {
    expect(() =>
      loadConfig({
        BALCONY_SYSTEM_ID: "SYS-A",
        BALCONY_AUTHORIZED_NODE_IDS: "SYS-B",
        BALCONY_AZURE_AUTH_MODE: "managed_identity",
        BALCONY_AZURE_TENANT_ID:
          "11111111-1111-4111-8111-111111111111",
      }),
    ).toThrow(/not allowed for managed_identity/);

    expect(() =>
      loadConfig({
        BALCONY_SYSTEM_ID: "SYS-A",
        BALCONY_AUTHORIZED_NODE_IDS: "SYS-B",
        BALCONY_AZURE_AUTH_MODE: "client_certificate",
        BALCONY_AZURE_TENANT_ID:
          "11111111-1111-4111-8111-111111111111",
      }),
    ).toThrow(/required for client_certificate/);

    expect(() =>
      loadConfig({
        BALCONY_SYSTEM_ID: "SYS-A",
        BALCONY_AUTHORIZED_NODE_IDS: "SYS-B",
        BALCONY_AZURE_AUTH_MODE: "client_certificate",
        BALCONY_AZURE_TENANT_ID:
          "11111111-1111-4111-8111-111111111111",
        BALCONY_AZURE_CLIENT_ID:
          "22222222-2222-4222-8222-222222222222",
        BALCONY_AZURE_CLIENT_CERTIFICATE_PATH: "C:\\approved\\node.pem",
        BALCONY_MANAGED_IDENTITY_CLIENT_ID:
          "33333333-3333-4333-8333-333333333333",
      }),
    ).toThrow(/not allowed for client_certificate/);
  });

  it("loads an explicit read-only dispatcher configuration", () => {
    const config = loadReadOnlyDispatcherConfig({
      BALCONY_SYSTEM_ID: "SYS-A",
      BALCONY_AUTHORIZED_NODE_IDS: "SYS-B",
      BALCONY_BRIDGE_DB_PATH: "D:\\bridge.sqlite3",
      BALCONY_DISPATCHER_PROJECTS_PATH:
        "D:\\local\\dispatcher-projects.json",
      BALCONY_CODEX_EXECUTABLE: "D:\\tools\\codex.ps1",
      BALCONY_CODEX_EXECUTABLE_SHA256: "a".repeat(64),
      BALCONY_CODEX_CODE_MODE_HOST_EXECUTABLE:
        "D:\\tools\\codex-code-mode-host.exe",
      BALCONY_CODEX_CODE_MODE_HOST_SHA256: "b".repeat(64),
      BALCONY_DISPATCHER_CODEX_HOME: "D:\\local\\codex-home",
      BALCONY_DISPATCHER_TRUSTED_PATH: "C:\\trusted-node",
      BALCONY_DISPATCHER_POLL_INTERVAL_MS: "1500",
      BALCONY_DISPATCHER_DEFAULT_TIMEOUT_SECONDS: "120",
      BALCONY_DISPATCHER_MAX_OUTPUT_BYTES: "32000",
      BALCONY_DISPATCHER_NOT_BEFORE_UTC: "2026-08-19T07:00:00+00:00",
    });

    expect(config.systemId).toBe("SYS-A");
    expect(config.authorizedNodeIds).toEqual(["SYS-B"]);
    expect(config.pollIntervalMs).toBe(1500);
    expect(config.defaultTimeoutSeconds).toBe(120);
    expect(config.maxOutputBytes).toBe(32000);
    expect(config.codexExecutableSha256).toBe("a".repeat(64));
    expect(config.codexCodeModeHostExecutable).toBe(
      path.resolve("D:\\tools\\codex-code-mode-host.exe"),
    );
    expect(config.codexCodeModeHostSha256).toBe("b".repeat(64));
    expect(config.trustedPath).toBe("C:\\trusted-node");
    expect(config.notBeforeUtc).toBe("2026-08-19T07:00:00.000Z");
  });

  it("rejects an invalid dispatcher activation cutoff", () => {
    expect(() =>
      loadReadOnlyDispatcherConfig({
        BALCONY_SYSTEM_ID: "SYS-A",
        BALCONY_AUTHORIZED_NODE_IDS: "SYS-B",
        BALCONY_DISPATCHER_PROJECTS_PATH:
          "D:\\local\\dispatcher-projects.json",
        BALCONY_CODEX_EXECUTABLE: "D:\\tools\\codex.exe",
        BALCONY_CODEX_EXECUTABLE_SHA256: "a".repeat(64),
        BALCONY_CODEX_CODE_MODE_HOST_EXECUTABLE:
          "D:\\tools\\codex-code-mode-host.exe",
        BALCONY_CODEX_CODE_MODE_HOST_SHA256: "b".repeat(64),
        BALCONY_DISPATCHER_CODEX_HOME: "D:\\local\\codex-home",
        BALCONY_DISPATCHER_TRUSTED_PATH: "C:\\trusted-node",
        BALCONY_DISPATCHER_NOT_BEFORE_UTC: "not-a-timestamp",
      }),
    ).toThrow(/BALCONY_DISPATCHER_NOT_BEFORE_UTC/);
  });

  it("fails closed when dispatcher execution paths are not declared", () => {
    expect(() =>
      loadReadOnlyDispatcherConfig({
        BALCONY_SYSTEM_ID: "SYS-A",
        BALCONY_AUTHORIZED_NODE_IDS: "SYS-B",
      }),
    ).toThrow(/BALCONY_DISPATCHER_PROJECTS_PATH/);
  });

  it("loads explicit consultation-mode executable and containment settings", () => {
    const config = loadReadOnlyDispatcherConfig({
      BALCONY_SYSTEM_ID: "SYS-B",
      BALCONY_AUTHORIZED_NODE_IDS: "SYS-A",
      BALCONY_BRIDGE_DB_PATH: "E:\\bridge.sqlite3",
      BALCONY_DISPATCHER_PROJECTS_PATH:
        "E:\\local\\dispatcher-projects.json",
      BALCONY_CODEX_EXECUTABLE: "E:\\tools\\codex.exe",
      BALCONY_CODEX_EXECUTABLE_SHA256: "a".repeat(64),
      BALCONY_CODEX_CODE_MODE_HOST_EXECUTABLE:
        "E:\\tools\\codex-code-mode-host.exe",
      BALCONY_CODEX_CODE_MODE_HOST_SHA256: "b".repeat(64),
      BALCONY_DISPATCHER_CODEX_HOME: "E:\\local\\codex-home",
      BALCONY_DISPATCHER_TRUSTED_PATH: "C:\\trusted-node",
      BALCONY_DISPATCHER_MODE: "consultation",
      BALCONY_CONSULTATION_WORKING_DIRECTORY:
        "E:\\local\\evidence-only",
      BALCONY_GIT_EXECUTABLE: "C:\\tools\\git.exe",
      BALCONY_GIT_EXECUTABLE_SHA256: "c".repeat(64),
    });

    expect(config).toMatchObject({
      mode: "consultation",
      consultationWorkingDirectory:
        path.resolve("E:\\local\\evidence-only"),
      gitExecutable: path.resolve("C:\\tools\\git.exe"),
      gitExecutableSha256: "c".repeat(64),
    });
  });

  it("fails closed when consultation mode lacks its pinned Git controls", () => {
    expect(() =>
      loadReadOnlyDispatcherConfig({
        BALCONY_SYSTEM_ID: "SYS-B",
        BALCONY_AUTHORIZED_NODE_IDS: "SYS-A",
        BALCONY_DISPATCHER_PROJECTS_PATH:
          "E:\\local\\dispatcher-projects.json",
        BALCONY_CODEX_EXECUTABLE: "E:\\tools\\codex.exe",
        BALCONY_CODEX_EXECUTABLE_SHA256: "a".repeat(64),
        BALCONY_CODEX_CODE_MODE_HOST_EXECUTABLE:
          "E:\\tools\\codex-code-mode-host.exe",
        BALCONY_CODEX_CODE_MODE_HOST_SHA256: "b".repeat(64),
        BALCONY_DISPATCHER_CODEX_HOME: "E:\\local\\codex-home",
        BALCONY_DISPATCHER_TRUSTED_PATH: "C:\\trusted-node",
        BALCONY_DISPATCHER_MODE: "consultation",
      }),
    ).toThrow(
      /BALCONY_CONSULTATION_WORKING_DIRECTORY|BALCONY_GIT_EXECUTABLE/,
    );
  });

  it("fails closed when the Codex companion executable is not declared", () => {
    expect(() =>
      loadReadOnlyDispatcherConfig({
        BALCONY_SYSTEM_ID: "SYS-A",
        BALCONY_AUTHORIZED_NODE_IDS: "SYS-B",
        BALCONY_DISPATCHER_PROJECTS_PATH:
          "D:\\local\\dispatcher-projects.json",
        BALCONY_CODEX_EXECUTABLE: "D:\\tools\\codex.exe",
        BALCONY_CODEX_EXECUTABLE_SHA256: "a".repeat(64),
        BALCONY_DISPATCHER_CODEX_HOME: "D:\\local\\codex-home",
        BALCONY_DISPATCHER_TRUSTED_PATH: "C:\\trusted-node",
      }),
    ).toThrow(/BALCONY_CODEX_CODE_MODE_HOST_EXECUTABLE/);
  });
});

describe("bridge runtime message authentication configuration", () => {
  const bridgeConfig = loadConfig({
    BALCONY_SYSTEM_ID: "node-a",
    BALCONY_AUTHORIZED_NODE_IDS: "node-b",
  });

  it("loads explicit Ed25519 membership and signing-key paths for the bridge runtime", () => {
    const authentication = loadMessageAuthenticationRuntimeConfig(
      {
        BALCONY_MESSAGE_AUTH_MODE: "ed25519",
        BALCONY_MESSAGE_AUTH_MEMBERSHIP_PATH: "D:\\bridge\\auth\\membership.json",
        BALCONY_MESSAGE_AUTH_SIGNING_KEY_PATH: "D:\\bridge\\auth\\node-a.pem",
      },
      bridgeConfig,
    );

    expect(authentication).toEqual({
      mode: "ed25519",
      membershipPath: path.resolve("D:\\bridge\\auth\\membership.json"),
      signingKeyPath: path.resolve("D:\\bridge\\auth\\node-a.pem"),
    });
  });

  it("fails closed for missing, incomplete, disabled, relative, and identical authentication settings", () => {
    const valid = {
      BALCONY_MESSAGE_AUTH_MODE: "ed25519",
      BALCONY_MESSAGE_AUTH_MEMBERSHIP_PATH: "D:\\bridge\\auth\\membership.json",
      BALCONY_MESSAGE_AUTH_SIGNING_KEY_PATH: "D:\\bridge\\auth\\node-a.pem",
    };

    for (const environment of [
      {},
      { BALCONY_MESSAGE_AUTH_MODE: "ed25519" },
      {
        ...valid,
        BALCONY_MESSAGE_AUTH_MODE: "disabled",
      },
      {
        ...valid,
        BALCONY_MESSAGE_AUTH_MEMBERSHIP_PATH: "relative-membership.json",
      },
      {
        ...valid,
        BALCONY_MESSAGE_AUTH_SIGNING_KEY_PATH: "relative-signing-key.pem",
      },
      {
        ...valid,
        BALCONY_MESSAGE_AUTH_SIGNING_KEY_PATH:
          "D:\\bridge\\auth\\membership.json",
      },
    ]) {
      expect(() =>
        loadMessageAuthenticationRuntimeConfig(environment, bridgeConfig),
      ).toThrow(/message authentication|BALCONY_MESSAGE_AUTH/i);
    }
  });

  it("does not make MCP or dispatcher configuration require bridge signing settings", () => {
    expect(() =>
      loadConfig({
        BALCONY_SYSTEM_ID: "node-a",
        BALCONY_AUTHORIZED_NODE_IDS: "node-b",
      }),
    ).not.toThrow();

    expect(() =>
      loadReadOnlyDispatcherConfig({
        BALCONY_SYSTEM_ID: "node-a",
        BALCONY_AUTHORIZED_NODE_IDS: "node-b",
        BALCONY_DISPATCHER_PROJECTS_PATH: "D:\\local\\dispatcher-projects.json",
        BALCONY_CODEX_EXECUTABLE: "D:\\tools\\codex.exe",
        BALCONY_CODEX_EXECUTABLE_SHA256: "a".repeat(64),
        BALCONY_CODEX_CODE_MODE_HOST_EXECUTABLE:
          "D:\\tools\\codex-code-mode-host.exe",
        BALCONY_CODEX_CODE_MODE_HOST_SHA256: "b".repeat(64),
        BALCONY_DISPATCHER_CODEX_HOME: "D:\\local\\codex-home",
        BALCONY_DISPATCHER_TRUSTED_PATH: "C:\\trusted-node",
      }),
    ).not.toThrow();
  });
});
