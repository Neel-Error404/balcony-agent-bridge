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
});
