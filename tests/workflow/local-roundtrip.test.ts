import { afterEach, describe, expect, it } from "vitest";

import { BridgeWorker } from "../../src/bridge/worker.js";
import { createEnvelope } from "../../src/contracts/envelope.js";
import type { BridgeConfig } from "../../src/config.js";
import { BridgeDatabase } from "../../src/storage/database.js";
import { FakeBridgeTransport } from "../../src/transport/fake-transport.js";

describe("local two-system workflow", () => {
  const databases: BridgeDatabase[] = [];

  afterEach(() => {
    for (const database of databases) {
      database.close();
    }
    databases.length = 0;
  });

  it("moves one durable message from SYS-A outbox to SYS-B inbox", async () => {
    const sysADatabase = createDatabase();
    const sysBDatabase = createDatabase();
    const sysATransport = new FakeBridgeTransport();
    const sysBTransport = new FakeBridgeTransport();
    const sysAWorker = new BridgeWorker(
      config("SYS-A"),
      sysADatabase,
      sysATransport,
    );
    const sysBWorker = new BridgeWorker(
      config("SYS-B"),
      sysBDatabase,
      sysBTransport,
    );
    const message = createEnvelope({
      idempotencyKey: "roundtrip-a-to-b",
      originSystem: "SYS-A",
      targetSystem: "SYS-B",
      kind: "task_request",
      streamId: "roundtrip",
      payload: {
        subject: "Review",
        body: "Confirm receipt.",
        evidence: [],
      },
      expiresAtUtc: "2026-08-20T12:00:00.000Z",
      now: new Date("2026-08-13T12:00:00.000Z"),
    });
    sysADatabase.enqueueEnvelope(message);

    await sysAWorker.runOutboundOnce(
      new Date("2026-08-13T12:00:00.000Z"),
    );
    sysBTransport.queueInbound({
      body: sysATransport.sent[0],
      brokerMessageId: message.message_id,
      sessionId: message.conversation_id,
    });
    await sysBWorker.runInboundOnce();

    expect(sysADatabase.getStatus().outbox.sent).toBe(1);
    expect(sysBDatabase.getStatus().inbox.available).toBe(1);
    expect(
      sysBDatabase.getInboxMessage(message.message_id)?.envelope.payload
        .subject,
    ).toBe("Review");
  });

  function createDatabase(): BridgeDatabase {
    const database = new BridgeDatabase(":memory:");
    databases.push(database);
    return database;
  }
});

function config(systemId: "SYS-A" | "SYS-B"): BridgeConfig {
  return {
    systemId,
    peerSystemId: systemId === "SYS-A" ? "SYS-B" : "SYS-A",
    databasePath: ":memory:",
    topicName: "agent-messages",
    subscriptionName: systemId.toLowerCase(),
    azureAuthMode: "managed_identity",
  };
}
