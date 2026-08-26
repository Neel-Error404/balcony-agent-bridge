import { describe, expect, it } from "vitest";

import {
  createEnvelope,
  type BridgeEnvelope,
} from "../../src/contracts/envelope.js";
import {
  type MessageAuthWire,
  MessageAuthenticator,
} from "../../src/security/message-authentication.js";
import {
  ServiceBusBridgeTransport,
  type ServiceBusClientAdapter,
  type ServiceBusClientFactory,
  toServiceBusMessage,
} from "../../src/transport/service-bus-transport.js";
import type { BridgeConfig } from "../../src/config.js";

describe("Service Bus message mapping", () => {
  it("uses stable IDs, sessions, routing properties, and bounded TTL", () => {
    const envelope = createEnvelope({
      idempotencyKey: "service-bus-map",
      originSystem: "SYS-A",
      targetSystem: "SYS-B",
      kind: "task_request",
      streamId: "mapping",
      conversationId: "11111111-1111-4111-8111-111111111111",
      correlationId: "22222222-2222-4222-8222-222222222222",
      payload: {
        subject: "Map",
        body: "Map this envelope.",
        evidence: [],
      },
      now: new Date("2026-08-13T12:00:00.000Z"),
      expiresAtUtc: "2026-08-20T12:00:00.000Z",
    });

    const authenticated = authenticatedEnvelope(envelope);
    const message = toServiceBusMessage(envelope, authenticated);
    expect(message.body).toEqual(authenticated);
    expect(message.messageId).toBe(envelope.message_id);
    expect(message.sessionId).toBe(envelope.conversation_id);
    expect(message.correlationId).toBe(envelope.correlation_id);
    expect(message.applicationProperties).toMatchObject({
      bridgeTarget: "SYS-B",
      schemaVersion: "1.0",
      streamId: "mapping",
    });
    expect(message.timeToLive).toBe(7 * 24 * 60 * 60 * 1000);
  });
});

describe("Service Bus transport lanes", () => {
  it("keeps outbound delivery independent from a stalled session accept", async () => {
    const harness = clientHarness();
    const transport = new ServiceBusBridgeTransport(
      bridgeConfig(),
      testAuthenticator(),
      undefined,
      harness.factory,
    );
    const envelope = createEnvelope({
      idempotencyKey: "independent-outbound",
      originSystem: "SYS-A",
      targetSystem: "SYS-B",
      kind: "message",
      streamId: "transport-test",
      payload: {
        subject: "Outbound remains live",
        body: "The receive client must not starve the sender.",
        evidence: [],
      },
    });

    const controller = new AbortController();
    const receive = transport.receiveAvailable(async () => undefined, {
      abortSignal: controller.signal,
    });
    await new Promise((resolve) => setImmediate(resolve));
    await transport.send(envelope);

    expect(harness.acceptStarted()).toBe(true);
    expect(harness.sentMessageCount()).toBe(1);
    controller.abort();
    await expect(receive).resolves.toBe(0);
    await transport.close();
    expect(harness.roles).toEqual(["sender", "receiver"]);
  });

  it("rejects overlapping receives on the same session client", async () => {
    const harness = clientHarness();
    const transport = new ServiceBusBridgeTransport(
      bridgeConfig(),
      testAuthenticator(),
      undefined,
      harness.factory,
    );
    const controller = new AbortController();
    const first = transport.receiveAvailable(async () => undefined, {
      abortSignal: controller.signal,
    });

    await expect(
      transport.receiveAvailable(async () => undefined),
    ).rejects.toThrow("already in progress");

    controller.abort();
    await expect(first).resolves.toBe(0);
    await transport.close();
  });
});

function bridgeConfig(): BridgeConfig {
  return {
    systemId: "SYS-A",
    authorizedNodeIds: ["SYS-B"],
    databasePath: ":memory:",
    topicName: "agent-messages",
    subscriptionName: "sys-a",
    azureAuthMode: "managed_identity",
  };
}

function testAuthenticator(): MessageAuthenticator {
  return {
    sign: (envelopeValue: unknown) =>
      authenticatedEnvelope(envelopeValue as BridgeEnvelope),
    verify: (value: unknown) => {
      const wire = value as MessageAuthWire;
      if (!wire || wire.protocol !== "balcony-agent-bridge-message-auth") {
        throw new Error("Message authentication rejected.");
      }
      return wire.envelope;
    },
  } as MessageAuthenticator;
}

function authenticatedEnvelope(envelope: BridgeEnvelope): MessageAuthWire {
  return {
    protocol: "balcony-agent-bridge-message-auth",
    auth_version: "1.0",
    network_id: "component-test-network",
    key_id: `ed25519:${"a".repeat(43)}`,
    issued_at_utc: envelope.created_at_utc,
    expires_at_utc:
      envelope.expires_at_utc ?? "2099-01-01T00:00:00.000Z",
    envelope,
    signature: "component-test-signature",
  };
}

function clientHarness() {
  const roles: Array<"sender" | "receiver"> = [];
  let sentMessages = 0;
  let didStartAccept = false;

  const factory: ServiceBusClientFactory = (role) => {
    roles.push(role);
    let rejectAccept: ((error: Error) => void) | undefined;
    const adapter = {
      createSender: () => ({
        sendMessages: async () => {
          sentMessages += 1;
        },
        close: async () => undefined,
      }),
      acceptNextSession: (
        _topic: string,
        _subscription: string,
        options?: { abortSignal?: AbortSignal },
      ) =>
        new Promise((_resolve, reject) => {
          didStartAccept = true;
          rejectAccept = reject;
          options?.abortSignal?.addEventListener(
            "abort",
            () => reject(new Error("aborted")),
            { once: true },
          );
        }),
      close: async () => {
        rejectAccept?.(new Error("closed"));
      },
    };
    return adapter as unknown as ServiceBusClientAdapter;
  };

  return {
    factory,
    roles,
    acceptStarted: () => didStartAccept,
    sentMessageCount: () => sentMessages,
  };
}
