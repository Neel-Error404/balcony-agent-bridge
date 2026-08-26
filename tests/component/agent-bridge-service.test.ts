import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

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

  afterEach(() => {
    vi.restoreAllMocks();
    database.close();
  });

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
    database.persistIncoming(reply, 1, new Date(), true);

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

  it("retries an explicit coordination conversation idempotently", () => {
    const conversationId = "29f54bc7-36bb-49cc-aa6a-a5bbb8165afd";
    const input = {
      idempotencyKey: "explicit-conversation-retry",
      targetNodeId: "SYS-B" as const,
      projectId: "voiceai-platform",
      subject: "Inspect VoiceAI",
      request: "Report the repository state without modifying it.",
      intent: "inspect" as const,
      timeoutSeconds: 120,
      conversationId,
    };

    const first = service.askAgent(input) as {
      task_id: string;
      duplicate: boolean;
      conversation_id: string;
    };
    const duplicate = service.askAgent(input) as {
      task_id: string;
      duplicate: boolean;
      conversation_id: string;
    };

    expect(first).toMatchObject({ duplicate: false, conversation_id: conversationId });
    expect(duplicate).toMatchObject({
      task_id: first.task_id,
      duplicate: true,
      conversation_id: conversationId,
    });
  });

  it("rejects changing the explicit conversation on an idempotent retry", () => {
    const input = {
      idempotencyKey: "explicit-conversation-conflict",
      targetNodeId: "SYS-B" as const,
      projectId: "voiceai-platform",
      subject: "Inspect VoiceAI",
      request: "Report status.",
      intent: "inspect" as const,
      timeoutSeconds: 120,
    };
    service.askAgent({
      ...input,
      conversationId: "437bbf51-98eb-4722-86a9-3a6fdab61b59",
    });

    expect(() =>
      service.askAgent({
        ...input,
        conversationId: "9d5fd575-20c4-45cd-a597-2f95fc14f7e1",
      }),
    ).toThrow("already associated with different message content");
  });

  it("keeps an authorized third node outside another peer's conversation", () => {
    const request = service.askAgent({
      idempotencyKey: "isolated-thread-request",
      targetNodeId: "SYS-B",
      projectId: "voiceai-platform",
      subject: "Inspect VoiceAI",
      request: "Report status.",
      intent: "inspect",
      timeoutSeconds: 120,
    }) as { task_id: string; conversation_id: string };
    const result = createEnvelope({
      idempotencyKey: "isolated-thread-result",
      originSystem: "SYS-B",
      targetSystem: "SYS-A",
      kind: "task_result",
      streamId: "agent-coordination",
      conversationId: request.conversation_id,
      causationId: request.task_id,
      sequenceNumber: 1,
      payload: {
        subject: "Inspection complete",
        body: "Expected peer result.",
        project: "voiceai-platform",
        evidence: [],
        coordination_result: {
          protocol_version: "1.0",
          request_message_id: request.task_id,
          outcome: "completed",
        },
      },
    });
    database.persistIncoming(result, 1, new Date(), true);
    const legacyUnsigned = createEnvelope({
      idempotencyKey: "legacy-unsigned-thread-entry",
      originSystem: "SYS-B",
      targetSystem: "SYS-A",
      kind: "task_result",
      streamId: "agent-coordination",
      conversationId: request.conversation_id,
      causationId: request.task_id,
      sequenceNumber: 99,
      payload: {
        subject: "Unsigned legacy result",
        body: "This must not influence the authenticated thread.",
        project: "voiceai-platform",
        evidence: [],
        coordination_result: {
          protocol_version: "1.0",
          request_message_id: request.task_id,
          outcome: "completed",
        },
      },
    });
    database.persistIncoming(legacyUnsigned, 1);
    const injected = createEnvelope({
      idempotencyKey: "third-node-injection",
      originSystem: "node-c",
      targetSystem: "SYS-A",
      kind: "task_result",
      streamId: "agent-coordination",
      conversationId: request.conversation_id,
      causationId: request.task_id,
      sequenceNumber: 99,
      payload: {
        subject: "Injected turn",
        body: "This must not enter the SYS-A/SYS-B thread.",
        project: "another-project",
        evidence: [],
        coordination_result: {
          protocol_version: "1.0",
          request_message_id: request.task_id,
          outcome: "completed",
        },
      },
    });
    database.persistIncoming(injected, 1);
    for (let index = 0; index < 100; index += 1) {
      database.persistIncoming(
        createEnvelope({
          idempotencyKey: `third-node-flood-${index}`,
          originSystem: "node-c",
          targetSystem: "SYS-A",
          kind: "message",
          streamId: "unrelated",
          conversationId: request.conversation_id,
          sequenceNumber: 100 + index,
          payload: {
            subject: "Unrelated traffic",
            body: `Third-node message ${index}`,
            evidence: [],
          },
        }),
        1,
      );
    }

    const followUp = service.continueAgent({
      previousResultMessageId: result.message_id,
      idempotencyKey: "isolated-thread-follow-up",
      subject: "Continue",
      request: "Continue the review.",
      intent: "question",
      timeoutSeconds: 120,
    }) as { sequence_number: number };
    const thread = service.getAgentThread(request.conversation_id, 20) as {
      count: number;
      items: Array<{ message_id: string; body: string }>;
    };

    expect(followUp.sequence_number).toBe(2);
    expect(thread.items.map((item) => item.message_id)).not.toContain(
      injected.message_id,
    );
    expect(thread.items.map((item) => item.message_id)).not.toContain(
      legacyUnsigned.message_id,
    );
    expect(thread.items.map((item) => item.body)).not.toContain(
      "This must not enter the SYS-A/SYS-B thread.",
    );
  });

  it("rejects unauthenticated results as completion or continuation authority", () => {
    const request = service.askAgent({
      idempotencyKey: "quarantined-result-request",
      targetNodeId: "SYS-B",
      projectId: "voiceai-platform",
      subject: "Inspect VoiceAI",
      request: "Report status.",
      intent: "inspect",
      timeoutSeconds: 120,
    }) as { task_id: string; conversation_id: string };
    const result = createEnvelope({
      idempotencyKey: "quarantined-result",
      originSystem: "SYS-B",
      targetSystem: "SYS-A",
      kind: "task_result",
      streamId: "agent-coordination",
      conversationId: request.conversation_id,
      causationId: request.task_id,
      payload: {
        subject: "Legacy result",
        body: "This row must not authorize a continuation.",
        project: "voiceai-platform",
        evidence: [],
        coordination_result: {
          protocol_version: "1.0",
          request_message_id: request.task_id,
          outcome: "completed",
        },
      },
    });
    database.persistIncoming(result, 1);

    expect(service.getAgentResult(request.task_id)).toMatchObject({
      task_id: request.task_id,
      conversation_id: request.conversation_id,
      status: "queued",
      delivery_state: "pending",
    });
    expect(service.getAgentResult(request.task_id)).not.toHaveProperty(
      "result_message_id",
    );

    expect(() =>
      service.continueAgent({
        previousResultMessageId: result.message_id,
        idempotencyKey: "must-not-continue-unsigned",
        subject: "Continue",
        request: "Continue from unsigned legacy work.",
        intent: "question",
        timeoutSeconds: 120,
      }),
    ).toThrow("not a completed peer coordination result");
    expect(database.getStatus().outbox.pending).toBe(1);
  });

  it("rejects a quarantined result as a continuation authority", () => {
    const request = service.askAgent({
      idempotencyKey: "quarantined-result-request",
      targetNodeId: "SYS-B",
      projectId: "voiceai-platform",
      subject: "Inspect VoiceAI",
      request: "Report status.",
      intent: "inspect",
      timeoutSeconds: 120,
    }) as { task_id: string; conversation_id: string };
    const result = createEnvelope({
      idempotencyKey: "quarantined-result",
      originSystem: "SYS-B",
      targetSystem: "SYS-A",
      kind: "task_result",
      streamId: "agent-coordination",
      conversationId: request.conversation_id,
      causationId: request.task_id,
      payload: {
        subject: "Legacy result",
        body: "This row must not authorize a continuation.",
        project: "voiceai-platform",
        evidence: [],
        coordination_result: {
          protocol_version: "1.0",
          request_message_id: request.task_id,
          outcome: "completed",
        },
      },
    });
    database.persistIncoming(result, 1);
    const stored = database.getInboxMessage(result.message_id)!;
    vi.spyOn(database, "getInboxMessage").mockReturnValue({
      ...stored,
      state: "quarantined",
    });

    expect(() =>
      service.continueAgent({
        previousResultMessageId: result.message_id,
        idempotencyKey: "must-not-continue",
        subject: "Continue",
        request: "Continue from legacy work.",
        intent: "question",
        timeoutSeconds: 120,
      }),
    ).toThrow("not a completed peer coordination result");
    expect(database.getStatus().outbox.pending).toBe(1);
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
