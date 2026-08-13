import { describe, expect, it } from "vitest";

import {
  loadConfig,
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
});
