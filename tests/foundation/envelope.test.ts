import { describe, expect, it } from "vitest";

import {
  BridgeEnvelopeSchema,
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
          body: "Endpoint=sb://example/;SharedAccessKeyName=owner;SharedAccessKey=value",
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
