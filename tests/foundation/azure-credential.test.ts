import {
  ClientCertificateCredential,
  ManagedIdentityCredential,
} from "@azure/identity";
import { describe, expect, it } from "vitest";

import type { BridgeConfig } from "../../src/config.js";
import { createServiceBusCredential } from "../../src/transport/service-bus-transport.js";

describe("Azure credential selection", () => {
  it("selects system-assigned or configured user-assigned identity", () => {
    expect(
      createServiceBusCredential(config("managed_identity")),
    ).toBeInstanceOf(ManagedIdentityCredential);

    const credential = createServiceBusCredential({
      ...config("managed_identity"),
      managedIdentityClientId:
        "11111111-1111-4111-8111-111111111111",
    });

    expect(credential).toBeInstanceOf(ManagedIdentityCredential);
  });

  it("requires and selects the configured client certificate", () => {
    expect(() =>
      createServiceBusCredential(config("client_certificate")),
    ).toThrow(/BALCONY_AZURE_TENANT_ID/);

    const credential = createServiceBusCredential({
      ...config("client_certificate"),
      azureTenantId: "11111111-1111-4111-8111-111111111111",
      azureClientId: "22222222-2222-4222-8222-222222222222",
      azureClientCertificatePath: "C:\\private\\sys-a.pem",
    });

    expect(credential).toBeInstanceOf(ClientCertificateCredential);
  });
});

function config(
  azureAuthMode: BridgeConfig["azureAuthMode"],
): BridgeConfig {
  return {
    systemId: "SYS-A",
    authorizedNodeIds: ["SYS-B"],
    databasePath: ":memory:",
    serviceBusNamespace:
      "approved-namespace.servicebus.windows.net",
    topicName: "agent-messages",
    subscriptionName: "sys-a",
    azureAuthMode,
  };
}
