import { afterEach, describe, expect, it } from "vitest";

import { AgentBridgeService } from "../../src/application/agent-bridge-service.js";
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

  it("isolates a direct route across three nodes and returns the reply", async () => {
    const nodeADatabase = createDatabase();
    const nodeBDatabase = createDatabase();
    const nodeCDatabase = createDatabase();
    const nodeATransport = new FakeBridgeTransport();
    const nodeBTransport = new FakeBridgeTransport();
    const nodeCTransport = new FakeBridgeTransport();
    const nodeAConfig = config("node-a", ["node-b", "node-c"]);
    const nodeBConfig = config("node-b", ["node-a", "node-c"]);
    const nodeCConfig = config("node-c", ["node-a", "node-b"]);
    const nodeAService = new AgentBridgeService(nodeAConfig, nodeADatabase);
    const nodeCService = new AgentBridgeService(nodeCConfig, nodeCDatabase);
    const nodeAWorker = new BridgeWorker(
      nodeAConfig,
      nodeADatabase,
      nodeATransport,
    );
    const nodeBWorker = new BridgeWorker(
      nodeBConfig,
      nodeBDatabase,
      nodeBTransport,
    );
    const nodeCWorker = new BridgeWorker(
      nodeCConfig,
      nodeCDatabase,
      nodeCTransport,
    );

    const sent = nodeAService.send({
      idempotencyKey: "node-a-to-node-c",
      targetNodeId: "node-c",
      kind: "message",
      streamId: "three-node-roundtrip",
      payload: {
        subject: "Direct route",
        body: "Only node C should persist this message.",
        evidence: [],
      },
    });
    await nodeAWorker.runOutboundOnce();
    const envelope = nodeATransport.sent[0]!;

    for (const transport of [nodeBTransport, nodeCTransport]) {
      transport.queueInbound({
        body: envelope,
        brokerMessageId: envelope.message_id,
        sessionId: envelope.conversation_id,
      });
    }
    nodeCTransport.queueInbound({
      body: envelope,
      brokerMessageId: envelope.message_id,
      deliveryCount: 2,
      sessionId: envelope.conversation_id,
    });

    await nodeBWorker.runInboundOnce();
    await nodeCWorker.runInboundOnce();

    expect(nodeBTransport.inbound[0]?.deadLetterReason).toBe("WrongTargetSystem");
    expect(nodeBDatabase.getStatus().inbox.available).toBe(0);
    expect(nodeCDatabase.getStatus().inbox.available).toBe(1);
    expect(nodeCTransport.inbound.map((item) => item.settlement)).toEqual([
      "completed",
      "completed",
    ]);

    nodeCService.reply(sent.message_id, "node-c-reply", "message", {
      subject: "Reply",
      body: "Node C received the direct message.",
      evidence: [],
    });
    await nodeCWorker.runOutboundOnce();
    const reply = nodeCTransport.sent[0]!;
    expect(reply.target_system).toBe("node-a");
    nodeATransport.queueInbound({
      body: reply,
      brokerMessageId: reply.message_id,
      sessionId: reply.conversation_id,
    });
    await nodeAWorker.runInboundOnce();
    expect(nodeADatabase.getStatus().inbox.available).toBe(1);
  });

  function createDatabase(): BridgeDatabase {
    const database = new BridgeDatabase(":memory:");
    databases.push(database);
    return database;
  }
});

function config(
  systemId: string,
  authorizedNodeIds = [systemId === "SYS-A" ? "SYS-B" : "SYS-A"],
): BridgeConfig {
  return {
    systemId,
    authorizedNodeIds,
    databasePath: ":memory:",
    topicName: "agent-messages",
    subscriptionName: systemId.toLowerCase(),
    azureAuthMode: "managed_identity",
  };
}
