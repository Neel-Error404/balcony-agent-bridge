import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { BridgeWorker } from "../../src/bridge/worker.js";
import { createEnvelope } from "../../src/contracts/envelope.js";
import type { BridgeConfig } from "../../src/config.js";
import { BridgeDatabase } from "../../src/storage/database.js";
import { FakeBridgeTransport } from "../../src/transport/fake-transport.js";

describe("BridgeWorker", () => {
  let database: BridgeDatabase;
  let transport: FakeBridgeTransport;
  let worker: BridgeWorker;

  beforeEach(() => {
    database = new BridgeDatabase(":memory:");
    transport = new FakeBridgeTransport();
    const config: BridgeConfig = {
      systemId: "SYS-A",
      peerSystemId: "SYS-B",
      databasePath: ":memory:",
      topicName: "agent-messages",
      subscriptionName: "sys-a",
      azureAuthMode: "managed_identity",
    };
    worker = new BridgeWorker(config, database, transport);
  });

  afterEach(() => database.close());

  it("marks an outbox message sent only after transport success", async () => {
    const outgoing = envelope("SYS-A", "SYS-B", "outbound");
    database.enqueueEnvelope(outgoing);

    expect(
      await worker.runOutboundOnce(new Date("2026-08-13T12:00:00.000Z")),
    ).toBe(1);
    expect(transport.sent).toHaveLength(1);
    expect(database.getStatus().outbox.sent).toBe(1);
  });

  it("returns transient send failures to pending", async () => {
    const outgoing = envelope("SYS-A", "SYS-B", "retry");
    database.enqueueEnvelope(outgoing);
    transport.sendBehavior = {
      kind: "error",
      error: Object.assign(new Error("Service busy"), {
        code: "ServiceBusy",
      }),
    };

    expect(
      await worker.runOutboundOnce(new Date("2026-08-13T12:00:00.000Z")),
    ).toBe(1);
    expect(database.getStatus().outbox.pending).toBe(1);
    expect(database.getStatus().outbox.quarantined).toBe(0);
  });

  it("quarantines permanent authorization failures", async () => {
    const outgoing = envelope("SYS-A", "SYS-B", "denied");
    database.enqueueEnvelope(outgoing);
    transport.sendBehavior = {
      kind: "error",
      error: Object.assign(new Error("Access denied"), {
        code: "UnauthorizedAccess",
      }),
    };

    await worker.runOutboundOnce(new Date("2026-08-13T12:00:00.000Z"));
    expect(database.getStatus().outbox.quarantined).toBe(1);
  });

  it("persists inbound messages before completing delivery", async () => {
    const incoming = envelope("SYS-B", "SYS-A", "inbound");
    transport.queueInbound({
      body: incoming,
      brokerMessageId: incoming.message_id,
      sessionId: incoming.conversation_id,
    });

    expect(await worker.runInboundOnce()).toBe(1);
    expect(database.getStatus().inbox.available).toBe(1);
    expect(transport.inbound[0]!.settlement).toBe("completed");
  });

  it("completes identical broker redelivery without duplicating inbox state", async () => {
    const incoming = envelope("SYS-B", "SYS-A", "duplicate");
    database.persistIncoming(incoming, 1);
    transport.queueInbound({
      body: incoming,
      brokerMessageId: incoming.message_id,
      deliveryCount: 2,
      sessionId: incoming.conversation_id,
    });

    await worker.runInboundOnce();
    expect(database.getStatus().inbox.available).toBe(1);
    expect(transport.inbound[0]!.settlement).toBe("completed");
  });

  it("dead-letters invalid and wrongly routed messages", async () => {
    const wrongTarget = envelope("SYS-A", "SYS-B", "wrong-target");
    transport.queueInbound({
      body: wrongTarget,
      brokerMessageId: wrongTarget.message_id,
      sessionId: wrongTarget.conversation_id,
    });
    transport.queueInbound({
      body: { invalid: true },
      brokerMessageId: "invalid-message",
    });

    await worker.runInboundOnce();
    expect(transport.inbound[0]!.settlement).toBe("dead-lettered");
    expect(transport.inbound[0]!.deadLetterReason).toBe("WrongTargetSystem");
    expect(transport.inbound[1]!.settlement).toBe("dead-lettered");
    expect(transport.inbound[1]!.deadLetterReason).toBe(
      "EnvelopeValidationFailed",
    );
  });
});

function envelope(
  originSystem: "SYS-A" | "SYS-B",
  targetSystem: "SYS-A" | "SYS-B",
  idempotencyKey: string,
) {
  return createEnvelope({
    idempotencyKey,
    originSystem,
    targetSystem,
    kind: "task_request",
    streamId: "worker-tests",
    payload: {
      subject: "Worker test",
      body: "Synthetic test message",
      evidence: [],
    },
    expiresAtUtc: "2026-08-20T12:00:00.000Z",
    now: new Date("2026-08-13T12:00:00.000Z"),
  });
}
