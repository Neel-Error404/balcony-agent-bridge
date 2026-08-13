import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { AgentBridgeService } from "../../src/application/agent-bridge-service.js";
import { createEnvelope } from "../../src/contracts/envelope.js";
import type { BridgeConfig } from "../../src/config.js";
import { BridgeDatabase } from "../../src/storage/database.js";

describe("AgentBridgeService", () => {
  let database: BridgeDatabase;
  let service: AgentBridgeService;

  beforeEach(() => {
    database = new BridgeDatabase(":memory:");
    const config: BridgeConfig = {
      systemId: "SYS-A",
      peerSystemId: "SYS-B",
      databasePath: ":memory:",
      topicName: "agent-messages",
      subscriptionName: "sys-a",
      azureAuthMode: "managed_identity",
    };
    service = new AgentBridgeService(config, database);
  });

  afterEach(() => database.close());

  it("derives origin and target from trusted local configuration", () => {
    const result = service.send({
      idempotencyKey: "send-1",
      kind: "message",
      streamId: "service-test",
      payload: {
        subject: "Hello",
        body: "SYS-A to SYS-B",
        evidence: [],
      },
    });

    expect(result.accepted).toBe(true);
    expect(database.getStatus().outbox.pending).toBe(1);
  });

  it("lists metadata without returning message bodies", () => {
    database.persistIncoming(incomingEnvelope(), 1);

    const list = service.listInbox(10);
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({
      origin_system: "SYS-B",
      kind: "task_request",
      subject: "Review",
    });
    expect(list[0]).not.toHaveProperty("body");
    expect(list[0]).not.toHaveProperty("payload");
  });

  it("preserves conversation and causation when replying", () => {
    const original = incomingEnvelope();
    database.persistIncoming(original, 1);

    const result = service.reply(
      original.message_id,
      "reply-1",
      "task_result",
      {
        subject: "Review complete",
        body: "All checks passed.",
        evidence: [],
      },
    );

    expect(result.accepted).toBe(true);
    expect(database.getStatus().outbox.pending).toBe(1);
  });
});

function incomingEnvelope() {
  return createEnvelope({
    idempotencyKey: "incoming-service",
    originSystem: "SYS-B",
    targetSystem: "SYS-A",
    kind: "task_request",
    streamId: "service-test",
    conversationId: "11111111-1111-4111-8111-111111111111",
    payload: {
      subject: "Review",
      body: "Please review.",
      evidence: [],
    },
  });
}
