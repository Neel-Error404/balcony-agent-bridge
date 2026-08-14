import { z } from "zod";

export const COORDINATION_PROTOCOL_VERSION = "1.0" as const;

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

export const CoordinationRequestSchema = z
  .object({
    protocol_version: z.literal(COORDINATION_PROTOCOL_VERSION),
    intent: CoordinationIntentSchema,
    access_mode: z.literal("read_only"),
  })
  .strict();

export const CoordinationResultSchema = z
  .object({
    protocol_version: z.literal(COORDINATION_PROTOCOL_VERSION),
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
