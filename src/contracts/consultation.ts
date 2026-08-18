import { createHash } from "node:crypto";

import { z } from "zod";

import {
  EvidenceBundleSchema,
  EvidenceRelativePathSchema,
  PeerInformationRequestSchema,
} from "./evidence.js";

export const CONSULTATION_PROTOCOL_VERSION = "1.0" as const;

const FingerprintSchema = z.string().regex(/^[a-f0-9]{64}$/u);

export const ConsultationContextSchema = z
  .object({
    protocol_version: z.literal(CONSULTATION_PROTOCOL_VERSION),
    root_request_id: z.string().uuid(),
    parent_request_id: z.string().uuid().optional(),
    depth: z.number().int().min(0).max(4),
    max_depth: z.number().int().min(1).max(4),
    ancestry_fingerprints: z.array(FingerprintSchema).max(8),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.depth > value.max_depth) {
      context.addIssue({
        code: "custom",
        message: "Consultation depth cannot exceed max_depth.",
        path: ["depth"],
      });
    }
    if (value.depth > 0 && !value.parent_request_id) {
      context.addIssue({
        code: "custom",
        message: "Nested consultation depth requires parent_request_id.",
        path: ["parent_request_id"],
      });
    }
    if (
      new Set(value.ancestry_fingerprints).size !==
      value.ancestry_fingerprints.length
    ) {
      context.addIssue({
        code: "custom",
        message: "Consultation ancestry fingerprints must be unique.",
        path: ["ancestry_fingerprints"],
      });
    }
  });

export const ConsultationRunStateSchema = z.enum([
  "pending_child",
  "needs_information",
  "waiting_peer",
  "completed",
  "failed",
]);

export const ConsultationRunSchema = z
  .object({
    schema_version: z.literal(CONSULTATION_PROTOCOL_VERSION),
    request_message_id: z.string().uuid(),
    conversation_id: z.string().uuid(),
    root_request_id: z.string().uuid(),
    project: z.string().trim().min(1).max(120),
    state: ConsultationRunStateSchema,
    round_count: z.number().int().min(0).max(16),
    depth: z.number().int().min(0).max(4),
    max_rounds: z.number().int().min(1).max(16),
    max_depth: z.number().int().min(1).max(4),
    ancestry_fingerprints: z.array(FingerprintSchema).min(1).max(8),
    deadline_at_utc: z.string().datetime({ offset: true }),
    evidence: EvidenceBundleSchema,
    requested_evidence: z
      .array(EvidenceRelativePathSchema)
      .max(16)
      .optional(),
    peer_request: PeerInformationRequestSchema.optional(),
    nested_task_id: z.string().uuid().optional(),
    next_attempt_at_utc: z.string().datetime({ offset: true }).optional(),
    error_code: z.string().trim().min(1).max(120).optional(),
    final_answer: z.string().trim().min(1).max(48_000).optional(),
    version: z.number().int().nonnegative(),
    created_at_utc: z.string().datetime({ offset: true }),
    updated_at_utc: z.string().datetime({ offset: true }),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.depth > value.max_depth) {
      context.addIssue({
        code: "custom",
        message: "Consultation run depth cannot exceed max_depth.",
        path: ["depth"],
      });
    }
    if (value.round_count > value.max_rounds) {
      context.addIssue({
        code: "custom",
        message: "Consultation round_count cannot exceed max_rounds.",
        path: ["round_count"],
      });
    }
    if (value.evidence.project !== value.project) {
      context.addIssue({
        code: "custom",
        message: "Consultation evidence project must match the run project.",
        path: ["evidence", "project"],
      });
    }
    if (
      value.state === "needs_information" &&
      !value.requested_evidence?.length &&
      !value.peer_request
    ) {
      context.addIssue({
        code: "custom",
        message:
          "needs_information requires requested_evidence or peer_request.",
        path: ["state"],
      });
    }
    if (value.state === "waiting_peer" && !value.peer_request) {
      context.addIssue({
        code: "custom",
        message: "waiting_peer requires peer_request.",
        path: ["peer_request"],
      });
    }
    if (value.state === "completed" && !value.final_answer) {
      context.addIssue({
        code: "custom",
        message: "completed consultation run requires final_answer.",
        path: ["final_answer"],
      });
    }
    if (value.state === "failed" && !value.error_code) {
      context.addIssue({
        code: "custom",
        message: "failed consultation run requires error_code.",
        path: ["error_code"],
      });
    }
  });

export interface ConsultationRequestFingerprintInput {
  project: string;
  subject: string;
  request: string;
}

export function consultationRequestFingerprint(
  input: ConsultationRequestFingerprintInput,
): string {
  const canonical = [
    normalizeFingerprintPart(input.project),
    normalizeFingerprintPart(input.subject),
    normalizeFingerprintPart(input.request),
  ].join("\n");
  return createHash("sha256").update(canonical, "utf8").digest("hex");
}

function normalizeFingerprintPart(value: string): string {
  return value.trim().replace(/\s+/gu, " ").toLowerCase();
}

export type ConsultationContext = z.infer<
  typeof ConsultationContextSchema
>;
export type ConsultationRun = z.infer<typeof ConsultationRunSchema>;
export type ConsultationRunState = z.infer<
  typeof ConsultationRunStateSchema
>;
