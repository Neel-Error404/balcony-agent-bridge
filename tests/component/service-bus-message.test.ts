import { describe, expect, it } from "vitest";

import { createEnvelope } from "../../src/contracts/envelope.js";
import { toServiceBusMessage } from "../../src/transport/service-bus-transport.js";

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

    const message = toServiceBusMessage(envelope);
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
