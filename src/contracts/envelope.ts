import { createHash, randomUUID } from "node:crypto";

import { z } from "zod";

import { assertSecretSafe } from "../security/payload-policy.js";
import {
  CoordinationRequestSchema,
  CoordinationResultSchema,
} from "./coordination.js";
import { ConsultationContextSchema } from "./consultation.js";

export const SYSTEM_IDS = ["SYS-A", "SYS-B"] as const;
export const MESSAGE_KINDS = [
  "message",
  "task_request",
  "task_result",
  "status",
  "acknowledgement",
  "heartbeat",
] as const;

export const SystemIdSchema = z.enum(SYSTEM_IDS);
export const MessageKindSchema = z.enum(MESSAGE_KINDS);

export type SystemId = z.infer<typeof SystemIdSchema>;
export type MessageKind = z.infer<typeof MessageKindSchema>;

export const EvidenceReferenceSchema = z
  .object({
    kind: z.enum(["repository_path", "git_commit", "obsidian_note", "test_run"]),
    value: z.string().trim().min(1).max(1024),
  })
  .strict();

export const ReadOnlyDispatchSchema = z
  .object({
    executor: z.literal("codex_cli"),
    access: z.literal("read_only"),
    timeout_seconds: z.number().int().min(30).max(600).optional(),
    evidence_mode: z.literal("pinned_git").optional(),
  })
  .strict();

export const MessagePayloadSchema = z
  .object({
    subject: z.string().trim().min(1).max(200),
    body: z.string().max(65_536),
    project: z.string().trim().min(1).max(120).optional(),
    repository: z.string().trim().min(1).max(260).optional(),
    task_reference: z.string().trim().min(1).max(260).optional(),
    evidence: z.array(EvidenceReferenceSchema).max(20).default([]),
    dispatch: ReadOnlyDispatchSchema.optional(),
    coordination_request: CoordinationRequestSchema.optional(),
    coordination_result: CoordinationResultSchema.optional(),
    consultation_context: ConsultationContextSchema.optional(),
  })
  .strict();

export type MessagePayload = z.infer<typeof MessagePayloadSchema>;

const EnvelopeCoreSchema = z
  .object({
    schema_version: z.literal("1.0"),
    message_id: z.string().uuid(),
    idempotency_key: z.string().trim().min(1).max(128),
    origin_system: SystemIdSchema,
    target_system: SystemIdSchema,
    kind: MessageKindSchema,
    conversation_id: z.string().uuid(),
    correlation_id: z.string().uuid().optional(),
    causation_id: z.string().uuid().optional(),
    stream_id: z.string().trim().min(1).max(128),
    sequence_number: z.number().int().nonnegative().optional(),
    created_at_utc: z.string().datetime({ offset: true }),
    expires_at_utc: z.string().datetime({ offset: true }).optional(),
    payload: MessagePayloadSchema,
    payload_sha256: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .strict();

export type BridgeEnvelope = z.infer<typeof EnvelopeCoreSchema>;

export const BridgeEnvelopeSchema = EnvelopeCoreSchema.superRefine(
  (value, context) => {
    if (value.origin_system === value.target_system) {
      context.addIssue({
        code: "custom",
        message: "origin_system and target_system must be different",
        path: ["target_system"],
      });
    }

    if (value.expires_at_utc) {
      const createdAt = Date.parse(value.created_at_utc);
      const expiresAt = Date.parse(value.expires_at_utc);
      if (expiresAt <= createdAt) {
        context.addIssue({
          code: "custom",
          message: "expires_at_utc must be later than created_at_utc",
          path: ["expires_at_utc"],
        });
      }
    }

    if (value.payload.coordination_request) {
      if (value.kind !== "task_request") {
        context.addIssue({
          code: "custom",
          message:
            "coordination_request is allowed only on task_request messages",
          path: ["payload", "coordination_request"],
        });
      }
      if (
        value.payload.dispatch?.executor !== "codex_cli" ||
        value.payload.dispatch.access !== "read_only"
      ) {
        context.addIssue({
          code: "custom",
          message:
            "coordination_request requires an eligible read-only dispatcher",
          path: ["payload", "dispatch"],
        });
      }
      if (value.stream_id !== "agent-coordination") {
        context.addIssue({
          code: "custom",
          message:
            "coordination_request requires the agent-coordination stream",
          path: ["stream_id"],
        });
      }
    }

    if (value.payload.coordination_result) {
      if (value.kind !== "task_result") {
        context.addIssue({
          code: "custom",
          message:
            "coordination_result is allowed only on task_result messages",
          path: ["payload", "coordination_result"],
        });
      }
      if (
        value.causation_id !==
        value.payload.coordination_result.request_message_id
      ) {
        context.addIssue({
          code: "custom",
          message:
            "coordination_result request_message_id must match causation_id",
          path: ["payload", "coordination_result", "request_message_id"],
        });
      }
      if (value.stream_id !== "agent-coordination") {
        context.addIssue({
          code: "custom",
          message:
            "coordination_result requires the agent-coordination stream",
          path: ["stream_id"],
        });
      }
    }

    if (value.payload.consultation_context) {
      const consultation = value.payload.consultation_context;
      if (!value.payload.coordination_request) {
        context.addIssue({
          code: "custom",
          message:
            "consultation_context requires coordination_request",
          path: ["payload", "consultation_context"],
        });
      }
      if (value.correlation_id !== consultation.root_request_id) {
        context.addIssue({
          code: "custom",
          message:
            "consultation_context root_request_id must match correlation_id",
          path: [
            "payload",
            "consultation_context",
            "root_request_id",
          ],
        });
      }
      if (
        value.causation_id !== consultation.parent_request_id
      ) {
        context.addIssue({
          code: "custom",
          message:
            "consultation_context parent_request_id must match causation_id",
          path: [
            "payload",
            "consultation_context",
            "parent_request_id",
          ],
        });
      }
    }

    if (value.stream_id === "agent-coordination") {
      if (value.kind === "task_request" && !value.payload.coordination_request) {
        context.addIssue({
          code: "custom",
          message:
            "agent-coordination task_request requires coordination_request",
          path: ["payload", "coordination_request"],
        });
      } else if (
        value.kind === "task_result" &&
        !value.payload.coordination_result
      ) {
        context.addIssue({
          code: "custom",
          message:
            "agent-coordination task_result requires coordination_result",
          path: ["payload", "coordination_result"],
        });
      } else if (value.kind !== "task_request" && value.kind !== "task_result") {
        context.addIssue({
          code: "custom",
          message:
            "agent-coordination stream accepts only task_request or task_result",
          path: ["kind"],
        });
      }
    }

    const expectedHash = hashPayload(value.payload);
    if (value.payload_sha256 !== expectedHash) {
      context.addIssue({
        code: "custom",
        message: "payload_sha256 does not match the canonical payload",
        path: ["payload_sha256"],
      });
    }

    try {
      assertSecretSafe(value.payload);
    } catch (error) {
      context.addIssue({
        code: "custom",
        message: error instanceof Error ? error.message : "Payload is not secret-safe",
        path: ["payload"],
      });
    }
  },
);

export interface CreateEnvelopeInput {
  idempotencyKey: string;
  originSystem: SystemId;
  targetSystem: SystemId;
  kind: MessageKind;
  conversationId?: string;
  correlationId?: string;
  causationId?: string;
  streamId: string;
  sequenceNumber?: number;
  expiresAtUtc?: string;
  payload: MessagePayload;
  now?: Date;
}

export function createEnvelope(input: CreateEnvelopeInput): BridgeEnvelope {
  const payload = MessagePayloadSchema.parse(input.payload);
  const now = input.now ?? new Date();
  const candidate = {
    schema_version: "1.0" as const,
    message_id: randomUUID(),
    idempotency_key: input.idempotencyKey,
    origin_system: input.originSystem,
    target_system: input.targetSystem,
    kind: input.kind,
    conversation_id: input.conversationId ?? randomUUID(),
    stream_id: input.streamId,
    created_at_utc: now.toISOString(),
    payload,
    payload_sha256: hashPayload(payload),
    ...(input.correlationId ? { correlation_id: input.correlationId } : {}),
    ...(input.causationId ? { causation_id: input.causationId } : {}),
    ...(input.sequenceNumber !== undefined
      ? { sequence_number: input.sequenceNumber }
      : {}),
    ...(input.expiresAtUtc ? { expires_at_utc: input.expiresAtUtc } : {}),
  };

  return BridgeEnvelopeSchema.parse(candidate);
}

export function parseEnvelope(value: unknown): BridgeEnvelope {
  return BridgeEnvelopeSchema.parse(value);
}

export function hashPayload(payload: MessagePayload): string {
  return createHash("sha256")
    .update(canonicalJson(payload), "utf8")
    .digest("hex");
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }

  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalJson(item)).join(",")}]`;
  }

  const entries = Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(
      ([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`,
    );
  return `{${entries.join(",")}}`;
}
