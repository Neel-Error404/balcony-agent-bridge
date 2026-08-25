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
      authorizedNodeIds: ["SYS-B", "node-c"],
      databasePath: ":memory:",
      topicName: "agent-messages",
      subscriptionName: "sys-a",
      azureAuthMode: "managed_identity",
    };
    service = new AgentBridgeService(config, database);
  });

  afterEach(() => database.close());

  it("uses an explicit authorized target from trusted local configuration", () => {
    const result = service.send({
      idempotencyKey: "send-1",
      targetNodeId: "node-c",
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
    expect(database.getOutboxMessage(result.message_id)?.envelope.target_system).toBe(
      "node-c",
    );
  });

  it("rejects an unknown target before persisting it", () => {
    expect(() =>
      service.send({
        idempotencyKey: "unknown-target",
        targetNodeId: "node-d",
        kind: "message",
        streamId: "service-test",
        payload: {
          subject: "Hello",
          body: "This route is not authorized.",
          evidence: [],
        },
      }),
    ).toThrow(/not authorized/);
    expect(database.getStatus().outbox.pending).toBe(0);
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
      targetNodeId: "SYS-B",
      projectId: "voiceai-platform",
      subject: "Inspect VoiceAI",
      request: "Report the repository state without modifying it.",
      intent: "inspect",
      timeoutSeconds: 120,
      evidenceMode: "pinned_git",
    }) as {
      task_id: string;
      conversation_id: string;
      status: string;
    };
    const duplicate = service.askAgent({
      idempotencyKey: "ask-agent-1",
      targetNodeId: "SYS-B",
      projectId: "voiceai-platform",
      subject: "Inspect VoiceAI",
      request: "Report the repository state without modifying it.",
      intent: "inspect",
      timeoutSeconds: 120,
      evidenceMode: "pinned_git",
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
    expect(
      database.getOutboxMessage(first.task_id)?.envelope.payload
        .dispatch,
    ).toMatchObject({
      evidence_mode: "pinned_git",
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

  it("rejects starting a new task inside an existing conversation", () => {
    const conversationId = "33333333-3333-4333-8333-333333333333";
    service.send({
      idempotencyKey: "existing-conversation",
      targetNodeId: "SYS-B",
      kind: "message",
      streamId: "manual",
      conversationId,
      payload: {
        subject: "Existing turn",
        body: "This conversation already exists.",
        evidence: [],
      },
    });

    expect(() =>
      service.askAgent({
        idempotencyKey: "invalid-new-turn",
        targetNodeId: "SYS-B",
        projectId: "voiceai-platform",
        subject: "Do not fork",
        request: "This must use the continuation operation instead.",
        intent: "question",
        timeoutSeconds: 120,
        conversationId,
      }),
    ).toThrow("cannot reuse an existing conversation");
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
