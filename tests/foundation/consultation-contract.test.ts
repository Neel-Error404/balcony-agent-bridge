import { describe, expect, it } from "vitest";

import {
  ConsultationContextSchema,
  consultationRequestFingerprint,
} from "../../src/contracts/consultation.js";
import { ChildTurnResultSchema } from "../../src/contracts/evidence.js";
import { createEnvelope } from "../../src/contracts/envelope.js";

describe("autonomous consultation contracts", () => {
  it("accepts bounded depth and ancestry on protocol 1.0 envelopes", () => {
    const fingerprint = consultationRequestFingerprint({
      project: "balcony-agent-bridge",
      subject: "Inspect recovery",
      request: "Report the restart-safe behavior.",
    });

    expect(
      ConsultationContextSchema.parse({
        protocol_version: "1.0",
        root_request_id: "11111111-1111-4111-8111-111111111111",
        parent_request_id: "22222222-2222-4222-8222-222222222222",
        depth: 1,
        max_depth: 2,
        ancestry_fingerprints: [fingerprint],
      }),
    ).toMatchObject({
      depth: 1,
      max_depth: 2,
      ancestry_fingerprints: [fingerprint],
    });
  });

  it("carries consultation context inside an existing protocol 1.0 envelope", () => {
    const fingerprint = consultationRequestFingerprint({
      project: "balcony-agent-bridge",
      subject: "Inspect recovery",
      request: "Report the restart-safe behavior.",
    });
    const envelope = createEnvelope({
      idempotencyKey: "nested-consultation",
      originSystem: "SYS-B",
      targetSystem: "SYS-A",
      kind: "task_request",
      streamId: "agent-coordination",
      causationId: "22222222-2222-4222-8222-222222222222",
      correlationId: "11111111-1111-4111-8111-111111111111",
      payload: {
        project: "balcony-agent-bridge",
        subject: "Inspect recovery",
        body: "Report the restart-safe behavior.",
        evidence: [],
        dispatch: {
          executor: "codex_cli",
          access: "read_only",
        },
        coordination_request: {
          protocol_version: "1.0",
          intent: "inspect",
          access_mode: "read_only",
        },
        consultation_context: {
          protocol_version: "1.0",
          root_request_id: "11111111-1111-4111-8111-111111111111",
          parent_request_id: "22222222-2222-4222-8222-222222222222",
          depth: 1,
          max_depth: 2,
          ancestry_fingerprints: [fingerprint],
        },
      },
    });

    expect(envelope.schema_version).toBe("1.0");
    expect(envelope.payload.consultation_context).toMatchObject({
      root_request_id: envelope.correlation_id,
      parent_request_id: envelope.causation_id,
      depth: 1,
    });
  });

  it("rejects a consultation context beyond its depth boundary", () => {
    expect(() =>
      ConsultationContextSchema.parse({
        protocol_version: "1.0",
        root_request_id: "11111111-1111-4111-8111-111111111111",
        depth: 3,
        max_depth: 2,
        ancestry_fingerprints: [],
      }),
    ).toThrow(/depth/);
  });

  it("creates the same request fingerprint for equivalent whitespace and case", () => {
    expect(
      consultationRequestFingerprint({
        project: "Balcony-Agent-Bridge",
        subject: " Inspect   Recovery ",
        request: "Report restart-safe behavior.",
      }),
    ).toBe(
      consultationRequestFingerprint({
        project: "balcony-agent-bridge",
        subject: "inspect recovery",
        request: "report restart-safe behavior.",
      }),
    );
  });

  it("accepts a bounded peer information request from a child turn", () => {
    expect(
      ChildTurnResultSchema.parse({
        schema_version: "1.0",
        outcome: "needs_information",
        reason: "The peer owns the requested runtime observation.",
        peer_request: {
          subject: "Inspect peer runtime",
          request: "Return the current bridge worker state.",
          intent: "inspect",
        },
        evidence_paths: [],
      }),
    ).toMatchObject({
      outcome: "needs_information",
      peer_request: {
        intent: "inspect",
      },
    });
  });

  it("rejects needs_information without a local or peer request", () => {
    expect(() =>
      ChildTurnResultSchema.parse({
        schema_version: "1.0",
        outcome: "needs_information",
        reason: "More information is required.",
        evidence_paths: [],
      }),
    ).toThrow(/requested_evidence|peer_request/);
  });
});
