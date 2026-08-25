import { describe, expect, it } from "vitest";

import {
  BridgeEnvelopeSchema,
  NodeIdSchema,
  createEnvelope,
  hashPayload,
} from "../../src/contracts/envelope.js";

const payload = {
  subject: "Review bridge architecture",
  body: "Please review the repository changes and return test evidence.",
  project: "balcony-agent-bridge",
  evidence: [
    {
      kind: "repository_path" as const,
      value: "docs/architecture.md",
    },
  ],
};

describe("bridge envelope", () => {
  it("accepts bounded generic node identifiers while preserving legacy IDs", () => {
    expect(NodeIdSchema.parse("SYS-A")).toBe("SYS-A");
    expect(NodeIdSchema.parse("review-node-03")).toBe("review-node-03");
    expect(() => NodeIdSchema.parse("-invalid")).toThrow();
    expect(() => NodeIdSchema.parse("Review-Node")).toThrow();
    expect(() => NodeIdSchema.parse("node with spaces")).toThrow();
    expect(() => NodeIdSchema.parse(`n${"a".repeat(50)}`)).toThrow();
  });

  it("routes an envelope between arbitrary distinct nodes", () => {
    const envelope = createEnvelope({
      idempotencyKey: "generic-node-route",
      originSystem: "review-node-01",
      targetSystem: "review-node-03",
      kind: "message",
      streamId: "phase-2",
      payload,
    });

    expect(envelope.origin_system).toBe("review-node-01");
    expect(envelope.target_system).toBe("review-node-03");
  });

  it("creates a valid secret-safe envelope", () => {
    const envelope = createEnvelope({
      idempotencyKey: "architecture-review-1",
      originSystem: "SYS-A",
      targetSystem: "SYS-B",
      kind: "task_request",
      streamId: "bridge-build",
      payload,
      now: new Date("2026-08-13T12:00:00.000Z"),
    });

    expect(BridgeEnvelopeSchema.parse(envelope)).toEqual(envelope);
    expect(envelope.payload_sha256).toBe(hashPayload(envelope.payload));
    expect(envelope.origin_system).toBe("SYS-A");
    expect(envelope.target_system).toBe("SYS-B");
  });

  it("accepts a durable bridge-message evidence reference", () => {
    const envelope = createEnvelope({
      idempotencyKey: "bridge-evidence-reference",
      originSystem: "SYS-A",
      targetSystem: "SYS-B",
      kind: "task_result",
      streamId: "agent-coordination",
      causationId: "22222222-2222-4222-8222-222222222222",
      payload: {
        subject: "Peer evidence",
        body: "The peer result supports this answer.",
        evidence: [
          {
            kind: "bridge_message",
            value: "11111111-1111-4111-8111-111111111111",
          },
        ],
        coordination_result: {
          protocol_version: "1.0",
          request_message_id: "22222222-2222-4222-8222-222222222222",
          outcome: "completed",
        },
      },
    });

    expect(envelope.payload.evidence).toEqual([
      {
        kind: "bridge_message",
        value: "11111111-1111-4111-8111-111111111111",
      },
    ]);
  });

  it("rejects a bridge-message reference that is not a message UUID", () => {
    expect(() =>
      createEnvelope({
        idempotencyKey: "invalid-bridge-evidence-reference",
        originSystem: "SYS-A",
        targetSystem: "SYS-B",
        kind: "task_result",
        streamId: "agent-coordination",
        causationId: "22222222-2222-4222-8222-222222222222",
        payload: {
          subject: "Invalid peer evidence",
          body: "This result has an invalid peer reference.",
          evidence: [{ kind: "bridge_message", value: "not-a-message-id" }],
          coordination_result: {
            protocol_version: "1.0",
            request_message_id: "22222222-2222-4222-8222-222222222222",
            outcome: "completed",
          },
        },
      }),
    ).toThrow(/message UUID/);
  });

  it("rejects messages addressed to the origin system", () => {
    expect(() =>
      createEnvelope({
        idempotencyKey: "self-send",
        originSystem: "SYS-A",
        targetSystem: "SYS-A",
        kind: "message",
        streamId: "invalid",
        payload,
      }),
    ).toThrow(/must be different/);
  });

  it("rejects a payload hash mismatch", () => {
    const envelope = createEnvelope({
      idempotencyKey: "hash-check",
      originSystem: "SYS-A",
      targetSystem: "SYS-B",
      kind: "message",
      streamId: "hash-check",
      payload,
    });

    expect(() =>
      BridgeEnvelopeSchema.parse({
        ...envelope,
        payload: {
          ...envelope.payload,
          body: "Changed after hashing",
        },
      }),
    ).toThrow(/does not match/);
  });

  it("rejects credential material", () => {
    expect(() =>
      createEnvelope({
        idempotencyKey: "unsafe",
        originSystem: "SYS-A",
        targetSystem: "SYS-B",
        kind: "message",
        streamId: "unsafe",
        payload: {
          subject: "Unsafe",
          body: [
            "Endpoint=sb://example/;SharedAccessKeyName=owner;",
            "SharedAccessKey=value",
          ].join(""),
          evidence: [],
        },
      }),
    ).toThrow(/forbidden Azure Service Bus connection string/);
  });

  it("accepts only the read-only Codex dispatch contract", () => {
    const envelope = createEnvelope({
      idempotencyKey: "read-only-dispatch",
      originSystem: "SYS-A",
      targetSystem: "SYS-B",
      kind: "task_request",
      streamId: "read-only-dispatch",
      payload: {
        subject: "Inspect project",
        body: "Report the current branch and test status.",
        project: "voiceai",
        evidence: [],
        dispatch: {
          executor: "codex_cli",
          access: "read_only",
          timeout_seconds: 120,
          evidence_mode: "pinned_git",
        },
      },
    });

    expect(envelope.payload.dispatch).toEqual({
      executor: "codex_cli",
      access: "read_only",
      timeout_seconds: 120,
      evidence_mode: "pinned_git",
    });

    expect(() =>
      createEnvelope({
        idempotencyKey: "write-dispatch",
        originSystem: "SYS-A",
        targetSystem: "SYS-B",
        kind: "task_request",
        streamId: "read-only-dispatch",
        payload: {
          subject: "Modify project",
          body: "Edit the implementation.",
          project: "voiceai",
          evidence: [],
          dispatch: {
            executor: "codex_cli",
            access: "workspace_write" as "read_only",
          },
        },
      }),
    ).toThrow();
  });

  it("validates versioned coordination requests and linked results", () => {
    const request = createEnvelope({
      idempotencyKey: "coordination-request",
      originSystem: "SYS-A",
      targetSystem: "SYS-B",
      kind: "task_request",
      streamId: "agent-coordination",
      payload: {
        subject: "Inspect VoiceAI",
        body: "Report the current repository state.",
        project: "voiceai-platform",
        evidence: [],
        dispatch: {
          executor: "codex_cli",
          access: "read_only",
          timeout_seconds: 120,
        },
        coordination_request: {
          protocol_version: "1.0",
          intent: "inspect",
          access_mode: "read_only",
        },
      },
    });

    const result = createEnvelope({
      idempotencyKey: "coordination-result",
      originSystem: "SYS-B",
      targetSystem: "SYS-A",
      kind: "task_result",
      streamId: "agent-coordination",
      conversationId: request.conversation_id,
      causationId: request.message_id,
      payload: {
        subject: "VoiceAI inspection complete",
        body: "The repository is available.",
        evidence: [],
        coordination_result: {
          protocol_version: "1.0",
          request_message_id: request.message_id,
          outcome: "completed",
        },
      },
    });

    expect(result.payload.coordination_result?.outcome).toBe("completed");
    expect(() =>
      BridgeEnvelopeSchema.parse({
        ...result,
        causation_id: "11111111-1111-4111-8111-111111111111",
      }),
    ).toThrow(/must match causation_id/);

    expect(() =>
      createEnvelope({
        idempotencyKey: "coordination-result-without-contract",
        originSystem: "SYS-B",
        targetSystem: "SYS-A",
        kind: "task_result",
        streamId: "agent-coordination",
        conversationId: request.conversation_id,
        causationId: request.message_id,
        payload: {
          subject: "Unversioned result",
          body: "This must not satisfy the coordination API.",
          evidence: [],
        },
      }),
    ).toThrow(/requires coordination_result/);

    expect(() =>
      createEnvelope({
        idempotencyKey: "coordination-request-wrong-stream",
        originSystem: "SYS-A",
        targetSystem: "SYS-B",
        kind: "task_request",
        streamId: "ordinary-tasks",
        payload: request.payload,
      }),
    ).toThrow(/requires the agent-coordination stream/);
  });
});
