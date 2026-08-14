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

  it("creates idempotent coordination tasks and returns their result", () => {
    const first = service.askAgent({
      idempotencyKey: "ask-agent-1",
      projectId: "voiceai-platform",
      subject: "Inspect VoiceAI",
      request: "Report the repository state without modifying it.",
      intent: "inspect",
      timeoutSeconds: 120,
    }) as {
      task_id: string;
      conversation_id: string;
      status: string;
    };
    const duplicate = service.askAgent({
      idempotencyKey: "ask-agent-1",
      projectId: "voiceai-platform",
      subject: "Inspect VoiceAI",
      request: "Report the repository state without modifying it.",
      intent: "inspect",
      timeoutSeconds: 120,
    }) as {
      task_id: string;
      conversation_id: string;
      duplicate: boolean;
    };

    expect(first.status).toBe("queued");
    expect(duplicate).toMatchObject({
      task_id: first.task_id,
      conversation_id: first.conversation_id,
      duplicate: true,
    });

    const reply = createEnvelope({
      idempotencyKey: "ask-agent-1-result",
      originSystem: "SYS-B",
      targetSystem: "SYS-A",
      kind: "task_result",
      streamId: "agent-coordination",
      conversationId: first.conversation_id,
      causationId: first.task_id,
      payload: {
        subject: "VoiceAI inspection complete",
        body: "The repository is available and clean.",
        evidence: [],
        coordination_result: {
          protocol_version: "1.0",
          request_message_id: first.task_id,
          outcome: "completed",
        },
      },
    });
    database.persistIncoming(reply, 1);

    expect(service.getAgentResult(first.task_id)).toMatchObject({
      task_id: first.task_id,
      conversation_id: first.conversation_id,
      status: "completed",
      result_message_id: reply.message_id,
      result: {
        body: "The repository is available and clean.",
      },
    });
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
