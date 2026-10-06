import { z } from "zod";

export const COORDINATION_PROTOCOL_VERSION = "1.1" as const;

export const DelegationPolicySchema = z.discriminatedUnion("mode", [
  z.object({ mode: z.literal("none") }).strict(),
  z.object({
    mode: z.literal("bounded"),
    max_depth: z.number().int().min(1).max(4),
  }).strict(),
]);
export type DelegationPolicy = z.infer<typeof DelegationPolicySchema>;

export const CoordinationIntentSchema = z.enum([
  "inspect",
  "question",
  "review",
]);

export const CoordinationOutcomeSchema = z.enum([
  "completed",
  "rejected",
  "failed",
]);

const LegacyCoordinationRequestSchema = z.object({
    protocol_version: z.literal("1.0"),
    intent: CoordinationIntentSchema,
    access_mode: z.literal("read_only"),
  }).strict();

export const CoordinationRequestSchema = z.discriminatedUnion("protocol_version", [
  LegacyCoordinationRequestSchema,
  z.object({
    protocol_version: z.literal(COORDINATION_PROTOCOL_VERSION),
    intent: CoordinationIntentSchema,
    access_mode: z.literal("read_only"),
    delegation: DelegationPolicySchema,
  }).strict(),
]);

export const CoordinationResultSchema = z
  .object({
    protocol_version: z.enum(["1.0", COORDINATION_PROTOCOL_VERSION]),
    request_message_id: z.string().uuid(),
    outcome: CoordinationOutcomeSchema,
  })
  .strict();

export type CoordinationIntent = z.infer<
  typeof CoordinationIntentSchema
>;
export type CoordinationOutcome = z.infer<
  typeof CoordinationOutcomeSchema
>;
