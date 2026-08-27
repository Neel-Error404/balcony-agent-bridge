import { z } from "zod";

export const ResourceIdSchema = z
  .string()
  .trim()
  .min(1)
  .max(120)
  .regex(
    /^[a-z0-9][a-z0-9._-]*$/i,
    "must contain only letters, numbers, dots, underscores, and hyphens",
  )
  .transform((value) => value.toLowerCase());

export const ResourceStateSchema = z.enum(["enabled", "disabled"]);
export const PeerResourceGrantStateSchema = z.enum(["active", "revoked"]);

export type ResourceState = z.infer<typeof ResourceStateSchema>;
export type PeerResourceGrantState = z.infer<
  typeof PeerResourceGrantStateSchema
>;
