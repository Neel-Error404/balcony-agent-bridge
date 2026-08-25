import { createHash, generateKeyPairSync } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import type {
  ServiceBusMessage,
  ServiceBusReceivedMessage,
} from "@azure/service-bus";
import { afterEach, describe, expect, it } from "vitest";

import type { BridgeConfig } from "../../src/config.js";
import { createEnvelope, type BridgeEnvelope } from "../../src/contracts/envelope.js";
import {
  loadMessageAuthenticator,
  type MessageAuthWire,
  type MessageAuthenticator,
} from "../../src/security/message-authentication.js";
import {
  MESSAGE_AUTHENTICATION_DEAD_LETTER_DESCRIPTION,
  MESSAGE_AUTHENTICATION_DEAD_LETTER_REASON,
  ServiceBusBridgeTransport,
  type ServiceBusClientAdapter,
  type ServiceBusClientFactory,
} from "../../src/transport/service-bus-transport.js";

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

describe("Service Bus message-authentication boundary", () => {
  it("signs outbound envelopes and forwards only the verified raw envelope", async () => {
    const pair = createPair();
    const envelope = createTestEnvelope();
    const signed = pair.sender.sign(envelope);
    const outboundHarness = receiveHarness([]);
    const outboundTransport = new ServiceBusBridgeTransport(
      bridgeConfig("node-a", ["node-b"]),
      pair.sender,
      undefined,
      outboundHarness.factory,
    );
    const inboundHarness = receiveHarness([brokerMessage(signed)]);
    const inboundTransport = new ServiceBusBridgeTransport(
      bridgeConfig(),
      pair.receiver,
      undefined,
      inboundHarness.factory,
    );
    const received: unknown[] = [];

    await outboundTransport.send(envelope);
    await inboundTransport.receiveAvailable(async (delivery) => {
      received.push(delivery.body);
      await delivery.complete();
    });

    expect(outboundHarness.sent[0]?.body).toMatchObject({
      protocol: "balcony-agent-bridge-message-auth",
      auth_version: "1.0",
      network_id: "servicebus-test",
      envelope,
    });
    expect(received).toEqual([envelope]);
    expect(inboundHarness.completed).toHaveLength(1);
    expect(inboundHarness.deadLetters).toHaveLength(0);
    await Promise.all([outboundTransport.close(), inboundTransport.close()]);
  });

  it("dead-letters unsigned, unknown, revoked, expired, bad-signature, and metadata-mismatched messages before forwarding", async () => {
    const pair = createPair();
    const envelope = createTestEnvelope("private task body must never be logged");
    const signed = pair.sender.sign(envelope);
    const expired = pair.sender.sign(
      createTestEnvelope("expired body"),
      new Date(Date.now() - 8 * 24 * 60 * 60 * 1000),
    );
    const unknown = {
      ...signed,
      key_id: `ed25519:${"z".repeat(43)}`,
    };
    const badSignature = { ...signed, signature: "invalid-signature" };
    const revokedReceiver = createPair({ status: "revoked" }).receiver;
    const cases: Array<{
      body: unknown;
      authenticator: MessageAuthenticator;
      metadata?: BrokerMessageOverrides;
    }> = [
      { body: envelope, authenticator: pair.receiver },
      { body: { protocol: "not-a-wire-message" }, authenticator: pair.receiver },
      { body: unknown, authenticator: pair.receiver },
      { body: signed, authenticator: revokedReceiver },
      { body: expired, authenticator: pair.receiver },
      { body: badSignature, authenticator: pair.receiver },
      {
        body: signed,
        authenticator: pair.receiver,
        metadata: { messageId: "unexpected-message-id" },
      },
      {
        body: signed,
        authenticator: pair.receiver,
        metadata: { sessionId: "11111111-1111-4111-8111-111111111111" },
      },
      {
        body: signed,
        authenticator: pair.receiver,
        metadata: { withoutCorrelationId: true },
      },
      {
        body: signed,
        authenticator: pair.receiver,
        metadata: { subject: "status" },
      },
      {
        body: signed,
        authenticator: pair.receiver,
        metadata: {
          applicationProperties: {
            bridgeTarget: "node-a",
            schemaVersion: "1.0",
            streamId: envelope.stream_id,
          },
        },
      },
      {
        body: signed,
        authenticator: pair.receiver,
        metadata: {
          applicationProperties: {
            bridgeTarget: envelope.target_system,
            schemaVersion: "unexpected-schema-version",
            streamId: envelope.stream_id,
          },
        },
      },
      {
        body: signed,
        authenticator: pair.receiver,
        metadata: {
          applicationProperties: {
            bridgeTarget: envelope.target_system,
            schemaVersion: envelope.schema_version,
            streamId: "unexpected-stream",
          },
        },
      },
    ];

    for (const testCase of cases) {
      const message = brokerMessage(testCase.body, testCase.metadata);
      const harness = receiveHarness([message]);
      const transport = new ServiceBusBridgeTransport(
        bridgeConfig(),
        testCase.authenticator,
        undefined,
        harness.factory,
      );
      let forwarded = false;

      await transport.receiveAvailable(async () => {
        forwarded = true;
      });

      expect(forwarded).toBe(false);
      expect(harness.completed).toHaveLength(0);
      expect(harness.deadLetters).toEqual([
        {
          reason: MESSAGE_AUTHENTICATION_DEAD_LETTER_REASON,
          description: MESSAGE_AUTHENTICATION_DEAD_LETTER_DESCRIPTION,
        },
      ]);
      expect(JSON.stringify(harness.deadLetters)).not.toContain(
        "private task body must never be logged",
      );
      await transport.close();
    }
  });
});

function createPair(revokedKey: Record<string, unknown> = {}) {
  const sender = createNode("node-a", ["node-b"]);
  const receiver = createNode("node-b", ["node-a"]);
  writeMembership(sender, [peer("node-b", receiver.publicKeyDer)]);
  writeMembership(receiver, [peer("node-a", sender.publicKeyDer, revokedKey)]);
  return { sender: sender.authenticator(), receiver: receiver.authenticator() };
}

function createNode(nodeId: string, authorizedNodeIds: string[]) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "bridge-servicebus-auth-"));
  temporaryDirectories.push(directory);
  const pair = generateKeyPairSync("ed25519");
  const signingKeyPath = path.join(directory, "signing-key.pem");
  const membershipPath = path.join(directory, "membership.json");
  fs.writeFileSync(
    signingKeyPath,
    pair.privateKey.export({ format: "pem", type: "pkcs8" }),
    { mode: 0o600 },
  );
  return {
    publicKeyDer: pair.publicKey.export({ format: "der", type: "spki" }) as Buffer,
    authenticator: () =>
      loadMessageAuthenticator({
        localNodeId: nodeId,
        authorizedNodeIds,
        membershipPath,
        signingKeyPath,
      }),
    writeMembership: (peers: Array<Record<string, unknown>>) =>
      fs.writeFileSync(
        membershipPath,
        `${JSON.stringify({ schema_version: "1.0", network_id: "servicebus-test", peers })}\n`,
        { mode: 0o600 },
      ),
  };
}

function writeMembership(
  node: ReturnType<typeof createNode>,
  peers: Array<Record<string, unknown>>,
): void {
  node.writeMembership(peers);
}

function peer(
  nodeId: string,
  publicKeyDer: Buffer,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    node_id: nodeId,
    keys: [
      {
        key_id: `ed25519:${createHash("sha256").update(publicKeyDer).digest("base64url")}`,
        spki_der_base64url: publicKeyDer.toString("base64url"),
        status: "active",
        ...overrides,
      },
    ],
  };
}

function createTestEnvelope(body = "authenticated service bus message"): BridgeEnvelope {
  const now = new Date();
  return createEnvelope({
    idempotencyKey: `servicebus-auth-${now.getTime()}-${body}`,
    originSystem: "node-a",
    targetSystem: "node-b",
    kind: "message",
    streamId: "servicebus-authentication-test",
    correlationId: "11111111-1111-4111-8111-111111111112",
    payload: { subject: "Authenticate", body, evidence: [] },
    now,
    expiresAtUtc: new Date(now.getTime() + 24 * 60 * 60 * 1000).toISOString(),
  });
}

function bridgeConfig(
  systemId = "node-b",
  authorizedNodeIds = ["node-a"],
): BridgeConfig {
  return {
    systemId,
    authorizedNodeIds,
    databasePath: ":memory:",
    topicName: "agent-messages",
    subscriptionName: "node-b",
    azureAuthMode: "managed_identity",
  };
}

function brokerMessage(
  body: unknown,
  overrides: BrokerMessageOverrides = {},
): ServiceBusReceivedMessage {
  const envelope = isWire(body) ? body.envelope : body as BridgeEnvelope;
  const { withoutCorrelationId, ...messageOverrides } = overrides;
  const message = {
    body,
    messageId: envelope.message_id,
    sessionId: envelope.conversation_id,
    correlationId: envelope.correlation_id,
    subject: envelope.kind,
    applicationProperties: {
      bridgeTarget: envelope.target_system,
      schemaVersion: envelope.schema_version,
      streamId: envelope.stream_id,
    },
    deliveryCount: 1,
    sequenceNumber: 1,
    ...messageOverrides,
  } as Record<string, unknown>;
  if (withoutCorrelationId) {
    delete message["correlationId"];
  }
  return message as unknown as ServiceBusReceivedMessage;
}

interface BrokerMessageOverrides extends Partial<ServiceBusReceivedMessage> {
  withoutCorrelationId?: boolean;
}

function isWire(value: unknown): value is MessageAuthWire {
  return Boolean(value && typeof value === "object" && "envelope" in value);
}

function receiveHarness(messages: ServiceBusReceivedMessage[]) {
  const sent: ServiceBusMessage[] = [];
  const completed: ServiceBusReceivedMessage[] = [];
  const deadLetters: Array<{ reason: string; description: string }> = [];
  const receiver = {
    receiveMessages: async () => messages,
    completeMessage: async (message: ServiceBusReceivedMessage) => {
      completed.push(message);
    },
    abandonMessage: async () => undefined,
    deadLetterMessage: async (
      _message: ServiceBusReceivedMessage,
      options: { deadLetterReason?: string; deadLetterErrorDescription?: string },
    ) => {
      deadLetters.push({
        reason: options.deadLetterReason ?? "",
        description: options.deadLetterErrorDescription ?? "",
      });
    },
    close: async () => undefined,
  };
  const factory: ServiceBusClientFactory = (role) => {
    const adapter = role === "sender"
      ? {
          createSender: () => ({
            sendMessages: async (message: ServiceBusMessage) => sent.push(message),
            close: async () => undefined,
          }),
          acceptNextSession: async () => receiver,
          close: async () => undefined,
        }
      : {
          createSender: () => ({
            sendMessages: async () => undefined,
            close: async () => undefined,
          }),
          acceptNextSession: async () => receiver,
          close: async () => undefined,
        };
    return adapter as unknown as ServiceBusClientAdapter;
  };
  return { factory, sent, completed, deadLetters };
}
