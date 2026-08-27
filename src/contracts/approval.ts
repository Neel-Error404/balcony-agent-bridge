import { z } from "zod";

export const AuthorizationRequestStateSchema = z.enum([
  "pending",
  "approved_once",
  "approved_temporary",
  "denied",
  "revoked",
  "expired",
  "consumed",
]);

export const AuthorizationAuditEventSchema = z.enum([
  "requested",
  "approved_once",
  "approved_temporary",
  "temporary_used",
  "denied",
  "revoked",
  "expired",
  "consumed",
]);

export type AuthorizationRequestState = z.infer<
  typeof AuthorizationRequestStateSchema
>;
export type AuthorizationAuditEvent = z.infer<
  typeof AuthorizationAuditEventSchema
>;
