import { describe, expect, it } from "vitest";

import { createEnvelope } from "../../src/contracts/envelope.js";
import {
  createSessionAcceptWait,
  toServiceBusMessage,
} from "../../src/transport/service-bus-transport.js";

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

describe("Service Bus session polling", () => {
  it("aborts a session accept after the bounded poll interval", async () => {
    const wait = createSessionAcceptWait(undefined, 10);
    try {
      await onceAborted(wait.signal);
      expect(wait.timedOut()).toBe(true);
    } finally {
      wait.dispose();
    }
  });

  it("propagates service shutdown without reporting a poll timeout", async () => {
    const parent = new AbortController();
    const wait = createSessionAcceptWait(parent.signal, 1000);
    try {
      parent.abort();
      await onceAborted(wait.signal);
      expect(wait.timedOut()).toBe(false);
    } finally {
      wait.dispose();
    }
  });

  it("cancels the poll timeout after a session is accepted", async () => {
    const wait = createSessionAcceptWait(undefined, 10);
    try {
      wait.clearTimeout();
      await new Promise((resolve) => setTimeout(resolve, 25));
      expect(wait.signal.aborted).toBe(false);
      expect(wait.timedOut()).toBe(false);
    } finally {
      wait.dispose();
    }
  });
});

async function onceAborted(signal: AbortSignal): Promise<void> {
  if (signal.aborted) {
    return;
  }
  await new Promise<void>((resolve) => {
    signal.addEventListener("abort", () => resolve(), { once: true });
  });
}
