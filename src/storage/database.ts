import { createHash, randomBytes, randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import Database from "better-sqlite3";

import {
  SystemIdSchema,
  parseEnvelope,
  type BridgeEnvelope,
  type MessageKind,
  type SystemId,
} from "../contracts/envelope.js";
import {
  PeerResourceGrantStateSchema,
  ResourceIdSchema,
  type PeerResourceGrantState,
} from "../contracts/resource-authorization.js";
import {
  ConsultationRunSchema,
  type ConsultationRun,
  type ConsultationRunState,
} from "../contracts/consultation.js";
import {
  DispatchResultUnavailableError,
  IdempotencyConflictError,
  StateTransitionError,
} from "../errors.js";
import {
  AuthorizationAuditEventSchema,
  AuthorizationRequestStateSchema,
  type AuthorizationAuditEvent as AuthorizationAuditEventName,
  type AuthorizationRequestState,
} from "../contracts/approval.js";
import { normalizeErrorCode, safeErrorCode } from "../security/sanitize-error.js";

export type OutboxState =
  | "pending"
  | "leased"
  | "sent"
  | "quarantined"
  | "expired";
export type InboxState =
  | "available"
  | "claimed"
  | "processed"
  | "rejected"
  | "quarantined";

export const CURRENT_SCHEMA_VERSION = 9;

interface OutboxRow {
  message_id: string;
  envelope_json: string;
  state: OutboxState;
  attempt_count: number;
  lease_owner: string | null;
  lease_until_utc: string | null;
}

interface InboxRow {
  message_id: string;
  envelope_json: string;
  payload_sha256: string;
  state: InboxState;
  claim_owner: string | null;
  claim_token_hash: string | null;
  claim_until_utc: string | null;
  authenticated_ingress?: number;
}

interface AuthorizationRequestRow {
  request_id: string;
  request_identity: string;
  request_fingerprint: string;
  peer_system_id: string;
  resource_id: string;
  state: AuthorizationRequestState;
  requested_at_utc: string;
  decided_at_utc: string | null;
  decided_by: string | null;
  temporary_expires_at_utc: string | null;
  consumed_at_utc: string | null;
  reason: string | null;
  updated_at_utc: string;
}

interface AuthorizationAuditRow {
  event_id: string;
  request_id: string;
  event: AuthorizationAuditEventName;
  state: AuthorizationRequestState;
  actor_id: string;
  peer_system_id: string;
  resource_id: string;
  occurred_at_utc: string;
  reason: string | null;
}

export interface EnqueueResult {
  messageId: string;
  state: OutboxState;
  duplicate: boolean;
}

interface IdempotencyComparisonOptions {
  matchConversationId?: boolean;
  matchExpiresAtUtc?: boolean;
}

export interface LeasedOutboxMessage {
  envelope: BridgeEnvelope;
  leaseOwner: string;
  leaseUntilUtc: string;
  attemptNumber: number;
}

export interface PersistIncomingResult {
  status: "inserted" | "duplicate" | "collision";
  messageId: string;
}

export interface SettleInboxWithReplyResult {
  inboxState: "processed" | "rejected";
  reply: EnqueueResult;
}

export interface ClaimedInboxMessage {
  envelope: BridgeEnvelope;
  claimToken: string;
  claimUntilUtc: string;
  authenticatedIngress: boolean;
}

export interface RegisteredResource {
  resourceId: string;
  enabled: boolean;
  createdAtUtc: string;
  updatedAtUtc: string;
}

export interface PeerResourceGrant {
  peerSystemId: SystemId;
  resourceId: string;
  state: PeerResourceGrantState;
  grantedAtUtc: string;
  revokedAtUtc?: string;
}

export interface AuthorizationRequest {
  requestId: string;
  requestFingerprint: string;
  peerSystemId: SystemId;
  resourceId: string;
  state: AuthorizationRequestState;
  requestedAtUtc: string;
  temporaryExpiresAtUtc?: string;
  reason?: string;
}

export interface AuthorizationAuditRecord {
  eventId: string;
  requestId: string;
  event: AuthorizationAuditEventName;
  state: AuthorizationRequestState;
  actorId: SystemId;
  peerSystemId: SystemId;
  resourceId: string;
  occurredAtUtc: string;
  reason?: string;
}

export type ResourceAccessDecision =
  | {
      status: "authorized";
      basis:
        | "persistent_grant"
        | "temporary_approval"
        | "approve_once"
        | "same_request_recovery";
      approvalRequestId?: string;
    }
  | {
      status: "approval_pending" | "duplicate" | "denied";
      approvalRequestId?: string;
    };

export interface InboxListItem {
  envelope: BridgeEnvelope;
  state: InboxState;
  authenticatedIngress: boolean;
  claimOwner?: string;
  claimUntilUtc?: string;
}

export interface OutboxListItem {
  envelope: BridgeEnvelope;
  state: OutboxState;
}

export interface ConversationListItem {
  envelope: BridgeEnvelope;
  direction: "inbound" | "outbound";
  state: InboxState | OutboxState;
}

export interface EnsureConsultationRunResult {
  run: ConsultationRun;
  created: boolean;
}

export type AcknowledgeOutcome = "processed" | "rejected" | "retry";

export type EffectiveRuntimeStatus = "healthy" | "degraded" | "stale";

const BRIDGE_STALE_AFTER_MS = 30 * 60 * 1000;
const DISPATCHER_STALE_AFTER_MS = 10 * 60 * 1000;
const SQLITE_BUSY_TIMEOUT_MS = 5_000;

export interface BridgeStatus {
  outbox: Record<OutboxState, number>;
  inbox: Record<InboxState, number>;
  consultation: Record<ConsultationRunState, number>;
  consultationEvidence: {
    runsWithEvidence: number;
    items: number;
    totalBytes: number;
  };
  oldestPendingCreatedAtUtc?: string;
  bridgeHeartbeatAtUtc?: string;
  bridgeHeartbeatAgeSeconds?: number;
  bridgeRuntimeStatus?: EffectiveRuntimeStatus;
  bridgeReportedStatus?: string;
  lastTransportErrorCode?: string;
  dispatcherHeartbeatAtUtc?: string;
  dispatcherHeartbeatAgeSeconds?: number;
  dispatcherRuntimeStatus?: EffectiveRuntimeStatus;
  dispatcherReportedStatus?: string;
  lastDispatcherErrorCode?: string;
  consultationCoordinatorHeartbeatAtUtc?: string;
  consultationCoordinatorHeartbeatAgeSeconds?: number;
  consultationCoordinatorRuntimeStatus?: EffectiveRuntimeStatus;
  consultationCoordinatorReportedStatus?: string;
  lastConsultationCoordinatorErrorCode?: string;
}

export class BridgeDatabase {
  private readonly database: Database.Database;

  public constructor(databasePath: string) {
    if (databasePath !== ":memory:") {
      fs.mkdirSync(path.dirname(databasePath), { recursive: true });
    }

    this.database = new Database(databasePath);
    try {
      this.assertSupportedSchemaVersion();
      this.database.pragma(`busy_timeout = ${SQLITE_BUSY_TIMEOUT_MS}`);
      if (databasePath !== ":memory:") {
        this.ensureWalMode();
      }
      this.database.pragma("foreign_keys = ON");
      this.database.pragma("synchronous = FULL");
      this.migrate();
    } catch (error) {
      this.database.close();
      throw error;
    }
  }

  private ensureWalMode(): void {
    const deadline = Date.now() + SQLITE_BUSY_TIMEOUT_MS;
    let retryDelayMs = 5;

    while (true) {
      let journalMode: unknown;
      try {
        journalMode = this.database.pragma("journal_mode = WAL", {
          simple: true,
        });
      } catch (error) {
        const remainingMs = deadline - Date.now();
        const isBusy = safeErrorCode(error) === "SQLITE_BUSY";
        if (!isBusy || remainingMs <= 0) {
          const context = isBusy
            ? `Timed out after ${SQLITE_BUSY_TIMEOUT_MS}ms enabling SQLite WAL mode; another process may be holding the database lock`
            : "Failed to enable SQLite WAL mode";
          if (error instanceof Error) {
            error.message = `${context}: ${error.message}`;
            throw error;
          }
          throw new StateTransitionError(`${context}: ${String(error)}`);
        }

        Atomics.wait(
          new Int32Array(new SharedArrayBuffer(4)),
          0,
          0,
          Math.min(retryDelayMs, remainingMs),
        );
        retryDelayMs = Math.min(retryDelayMs * 2, 50);
        continue;
      }

      if (journalMode !== "wal") {
        throw new StateTransitionError(
          `Failed to enable SQLite WAL mode: SQLite reported journal mode '${String(journalMode)}'`,
        );
      }
      return;
    }
  }

  public getInboxMessage(messageId: string): InboxListItem | undefined {
    const row = this.database
      .prepare(
        `SELECT message_id, envelope_json, payload_sha256, state,
                claim_owner, claim_token_hash, claim_until_utc,
                authenticated_ingress
         FROM inbox WHERE message_id = ?`,
      )
      .get(messageId) as InboxRow | undefined;
    if (!row) {
      return undefined;
    }
    return {
      envelope: parseEnvelope(JSON.parse(row.envelope_json)),
      state: row.state,
      authenticatedIngress: row.authenticated_ingress === 1,
      ...(row.claim_owner ? { claimOwner: row.claim_owner } : {}),
      ...(row.claim_until_utc ? { claimUntilUtc: row.claim_until_utc } : {}),
    };
  }

  public getOutboxMessage(messageId: string): OutboxListItem | undefined {
    const row = this.database
      .prepare(
        `SELECT envelope_json, state
         FROM outbox WHERE message_id = ?`,
      )
      .get(messageId) as
      | Pick<OutboxRow, "envelope_json" | "state">
      | undefined;
    if (!row) {
      return undefined;
    }
    return {
      envelope: parseEnvelope(JSON.parse(row.envelope_json)),
      state: row.state,
    };
  }

  public getOutboxByIdempotency(
    targetSystem: SystemId,
    idempotencyKey: string,
  ): OutboxListItem | undefined {
    const row = this.database
      .prepare(
        `SELECT envelope_json, state
         FROM outbox
         WHERE target_system = ? AND idempotency_key = ?`,
      )
      .get(targetSystem, idempotencyKey) as
      | Pick<OutboxRow, "envelope_json" | "state">
      | undefined;
    if (!row) {
      return undefined;
    }
    return {
      envelope: parseEnvelope(JSON.parse(row.envelope_json)),
      state: row.state,
    };
  }

  public listConversation(
    conversationId: string,
    limit = 20,
    route?: readonly [SystemId, SystemId],
  ): ConversationListItem[] {
    assertPositiveInteger(limit, "limit");
    if (limit > 100) {
      throw new RangeError("limit must not exceed 100");
    }
    const outbound = this.database
      .prepare(
        `SELECT envelope_json, state
         FROM outbox
         WHERE json_extract(envelope_json, '$.conversation_id') = ?`,
      )
      .all(conversationId) as Array<{
      envelope_json: string;
      state: OutboxState;
    }>;
    const inbound = this.database
      .prepare(
        `SELECT envelope_json, state
         FROM inbox
         WHERE json_extract(envelope_json, '$.conversation_id') = ?
           AND authenticated_ingress = 1`,
      )
      .all(conversationId) as Array<{
      envelope_json: string;
      state: InboxState;
    }>;
    const items = [
      ...outbound.map((row) => ({
        envelope: parseEnvelope(JSON.parse(row.envelope_json)),
        direction: "outbound" as const,
        state: row.state,
      })),
      ...inbound.map((row) => ({
        envelope: parseEnvelope(JSON.parse(row.envelope_json)),
        direction: "inbound" as const,
        state: row.state,
      })),
    ].sort((left, right) => {
        const leftSequence =
          left.envelope.sequence_number ?? Number.MAX_SAFE_INTEGER;
        const rightSequence =
          right.envelope.sequence_number ?? Number.MAX_SAFE_INTEGER;
        return (
          leftSequence - rightSequence ||
          left.envelope.created_at_utc.localeCompare(
            right.envelope.created_at_utc,
          ) ||
          left.envelope.message_id.localeCompare(right.envelope.message_id)
        );
      });
    return items
      .filter(
        (item) =>
          !route ||
          sameConversationRoute(item.envelope, route[0], route[1]),
      )
      .slice(-limit);
  }

  public findInitialCoordinationRequest(
    conversationId: string,
    originSystem: SystemId,
  ): ConversationListItem | undefined {
    const row = this.database
      .prepare(
        `SELECT envelope_json, state
         FROM outbox
         WHERE json_extract(envelope_json, '$.conversation_id') = ?
           AND json_extract(envelope_json, '$.origin_system') = ?
           AND kind = 'task_request'
           AND stream_id = 'agent-coordination'
           AND json_extract(envelope_json, '$.payload.coordination_request') IS NOT NULL
         ORDER BY COALESCE(
                    json_extract(envelope_json, '$.sequence_number'),
                    9223372036854775807
                  ),
                  created_at_utc,
                  message_id
         LIMIT 1`,
      )
      .get(conversationId, originSystem) as
      | { envelope_json: string; state: OutboxState }
      | undefined;
    return row
      ? {
          envelope: parseEnvelope(JSON.parse(row.envelope_json)),
          direction: "outbound",
          state: row.state,
        }
      : undefined;
  }

  public findInboxReplyTo(
    requestMessageId: string,
    expectedOriginSystem: SystemId,
    expectedTargetSystem: SystemId,
    expectedConversationId: string,
  ): InboxListItem | undefined {
    const row = this.database
      .prepare(
        `SELECT message_id, envelope_json, payload_sha256, state,
                claim_owner, claim_token_hash, claim_until_utc,
                authenticated_ingress
         FROM inbox
         WHERE causation_id = ?
           AND kind = 'task_result'
           AND authenticated_ingress = 1
           AND origin_system = ?
           AND json_extract(envelope_json, '$.target_system') = ?
           AND json_extract(envelope_json, '$.conversation_id') = ?
         ORDER BY first_received_at_utc, message_id
         LIMIT 1`,
      )
      .get(
        requestMessageId,
        expectedOriginSystem,
        expectedTargetSystem,
        expectedConversationId,
      ) as InboxRow | undefined;
    if (!row) {
      return undefined;
    }
    return {
      envelope: parseEnvelope(JSON.parse(row.envelope_json)),
      state: row.state,
      authenticatedIngress: row.authenticated_ingress === 1,
      ...(row.claim_owner ? { claimOwner: row.claim_owner } : {}),
      ...(row.claim_until_utc ? { claimUntilUtc: row.claim_until_utc } : {}),
    };
  }

  public close(): void {
    this.database.close();
  }

  public registerResource(
    resourceIdValue: string,
    now = new Date(),
  ): RegisteredResource & { created: boolean } {
    const resourceId = ResourceIdSchema.parse(resourceIdValue);
    const nowUtc = now.toISOString();
    const result = this.database
      .prepare(
        `INSERT OR IGNORE INTO resources (
           resource_id, enabled, created_at_utc, updated_at_utc
         ) VALUES (?, 1, ?, ?)`,
      )
      .run(resourceId, nowUtc, nowUtc);
    const resource = this.getResource(resourceId);
    if (!resource) {
      throw new StateTransitionError(
        `Resource '${resourceId}' could not be registered`,
      );
    }
    return { ...resource, created: result.changes === 1 };
  }

  public listResources(): RegisteredResource[] {
    const rows = this.database
      .prepare(
        `SELECT resource_id, enabled, created_at_utc, updated_at_utc
         FROM resources
         ORDER BY resource_id`,
      )
      .all() as Array<{
      resource_id: string;
      enabled: number;
      created_at_utc: string;
      updated_at_utc: string;
    }>;
    return rows.map((row) => ({
      resourceId: row.resource_id,
      enabled: row.enabled === 1,
      createdAtUtc: row.created_at_utc,
      updatedAtUtc: row.updated_at_utc,
    }));
  }

  public setResourceEnabled(
    resourceIdValue: string,
    enabled: boolean,
    now = new Date(),
  ): RegisteredResource {
    const resourceId = ResourceIdSchema.parse(resourceIdValue);
    const result = this.database
      .prepare(
        `UPDATE resources
         SET enabled = ?, updated_at_utc = ?
         WHERE resource_id = ?`,
      )
      .run(enabled ? 1 : 0, now.toISOString(), resourceId);
    if (result.changes !== 1) {
      throw new StateTransitionError(
        `Resource '${resourceId}' does not exist`,
      );
    }
    return this.getResource(resourceId)!;
  }

  public grantPeerResource(
    peerSystemIdValue: string,
    resourceIdValue: string,
    now = new Date(),
  ): PeerResourceGrant {
    const peerSystemId = SystemIdSchema.parse(peerSystemIdValue);
    const resourceId = ResourceIdSchema.parse(resourceIdValue);
    if (!this.getResource(resourceId)) {
      throw new StateTransitionError(
        `Resource '${resourceId}' does not exist`,
      );
    }
    const nowUtc = now.toISOString();
    const transaction = this.database.transaction(() => {
      const existing = this.getPeerResourceGrant(peerSystemId, resourceId);
      if (!existing) {
        this.database
          .prepare(
            `INSERT INTO peer_resource_grants (
               peer_system_id, resource_id, state, granted_at_utc, revoked_at_utc
             ) VALUES (?, ?, 'active', ?, NULL)`,
          )
          .run(peerSystemId, resourceId, nowUtc);
      } else if (existing.state === "revoked") {
        this.database
          .prepare(
            `UPDATE peer_resource_grants
             SET state = 'active', granted_at_utc = ?, revoked_at_utc = NULL
             WHERE peer_system_id = ? AND resource_id = ?`,
          )
          .run(nowUtc, peerSystemId, resourceId);
      }
      return this.getPeerResourceGrant(peerSystemId, resourceId)!;
    });
    return transaction.immediate();
  }

  public listPeerResourceGrants(
    peerSystemIdValue?: string,
  ): PeerResourceGrant[] {
    const peerSystemId = peerSystemIdValue === undefined
      ? undefined
      : SystemIdSchema.parse(peerSystemIdValue);
    const rows = this.database
      .prepare(
        `SELECT peer_system_id, resource_id, state, granted_at_utc, revoked_at_utc
         FROM peer_resource_grants
         ${peerSystemId === undefined ? "" : "WHERE peer_system_id = ?"}
         ORDER BY peer_system_id, resource_id`,
      )
      .all(...(peerSystemId === undefined ? [] : [peerSystemId])) as Array<{
      peer_system_id: string;
      resource_id: string;
      state: PeerResourceGrantState;
      granted_at_utc: string;
      revoked_at_utc: string | null;
    }>;
    return rows.map((row) => ({
      peerSystemId: SystemIdSchema.parse(row.peer_system_id),
      resourceId: ResourceIdSchema.parse(row.resource_id),
      state: PeerResourceGrantStateSchema.parse(row.state),
      grantedAtUtc: row.granted_at_utc,
      ...(row.revoked_at_utc ? { revokedAtUtc: row.revoked_at_utc } : {}),
    }));
  }

  public revokePeerResource(
    peerSystemIdValue: string,
    resourceIdValue: string,
    now = new Date(),
    actorIdValue = "local-operator",
  ): PeerResourceGrant {
    const peerSystemId = SystemIdSchema.parse(peerSystemIdValue);
    const resourceId = ResourceIdSchema.parse(resourceIdValue);
    const actorId = SystemIdSchema.parse(actorIdValue);
    const nowUtc = now.toISOString();
    const transaction = this.database.transaction(() => {
      const existing = this.getPeerResourceGrant(peerSystemId, resourceId);
      if (!existing) {
        throw new StateTransitionError(
          `Grant for peer '${peerSystemId}' and resource '${resourceId}' does not exist`,
        );
      }
      if (existing.state === "active") {
        this.database
          .prepare(
            `UPDATE peer_resource_grants
             SET state = 'revoked', revoked_at_utc = ?
             WHERE peer_system_id = ? AND resource_id = ?`,
          )
          .run(nowUtc, peerSystemId, resourceId);
      }

      const temporaryApprovals = this.database
        .prepare(
          `SELECT request_id, request_identity, request_fingerprint,
                  peer_system_id, resource_id, state, requested_at_utc,
                  decided_at_utc, decided_by, temporary_expires_at_utc,
                  consumed_at_utc, reason, updated_at_utc
           FROM authorization_requests
           WHERE peer_system_id = ? AND resource_id = ?
             AND state = 'approved_temporary'`,
        )
        .all(peerSystemId, resourceId) as AuthorizationRequestRow[];
      for (const approval of temporaryApprovals) {
        const updated = this.database
          .prepare(
            `UPDATE authorization_requests
             SET state = 'revoked', decided_at_utc = ?, decided_by = ?,
                 reason = 'persistent-grant-revoked', updated_at_utc = ?
             WHERE request_id = ? AND state = 'approved_temporary'`,
          )
          .run(nowUtc, actorId, nowUtc, approval.request_id);
        if (updated.changes !== 1) {
          throw new StateTransitionError(
            "Temporary authorization changed concurrently",
          );
        }
        this.insertAuthorizationAudit({
          requestId: approval.request_id,
          event: "revoked",
          state: "revoked",
          actorId,
          peerSystemId,
          resourceId,
          occurredAtUtc: nowUtc,
          reason: "persistent-grant-revoked",
        });
      }
      return this.getPeerResourceGrant(peerSystemId, resourceId)!;
    });
    return transaction.immediate();
  }

  public isPeerAuthorizedForResource(
    peerSystemIdValue: string,
    resourceIdValue: string,
  ): boolean {
    const peerSystemId = SystemIdSchema.safeParse(peerSystemIdValue);
    const resourceId = ResourceIdSchema.safeParse(resourceIdValue);
    if (!peerSystemId.success || !resourceId.success) {
      return false;
    }
    return Boolean(
      this.database
        .prepare(
          `SELECT 1
           FROM peer_resource_grants AS grant_record
           INNER JOIN resources AS resource
             ON resource.resource_id = grant_record.resource_id
           WHERE grant_record.peer_system_id = ?
             AND grant_record.resource_id = ?
             AND grant_record.state = 'active'
             AND grant_record.revoked_at_utc IS NULL
             AND resource.enabled = 1`,
        )
        .get(peerSystemId.data, resourceId.data),
    );
  }

  public authorizeClaimedResourceAccess(input: {
    requestMessageId: string;
    consumerId: string;
    claimToken: string;
    resourceId: string;
    actorId: string;
    now?: Date;
  }): ResourceAccessDecision {
    assertNonEmpty(input.requestMessageId, "requestMessageId");
    assertNonEmpty(input.consumerId, "consumerId");
    assertNonEmpty(input.claimToken, "claimToken");
    const resourceIdResult = ResourceIdSchema.safeParse(input.resourceId);
    const actorId = SystemIdSchema.parse(input.actorId);
    const now = input.now ?? new Date();
    const nowUtc = now.toISOString();

    const transaction = this.database.transaction((): ResourceAccessDecision => {
      this.expireAuthorizationRequests(now);
      const row = this.database
        .prepare(
          `SELECT message_id, envelope_json, payload_sha256, state,
                  claim_owner, claim_token_hash, claim_until_utc,
                  authenticated_ingress
           FROM inbox
           WHERE message_id = ?`,
        )
        .get(input.requestMessageId) as InboxRow | undefined;
      if (
        !row ||
        row.state !== "claimed" ||
        row.claim_owner !== input.consumerId ||
        row.claim_token_hash !== hashToken(input.claimToken) ||
        !row.claim_until_utc ||
        row.claim_until_utc <= nowUtc
      ) {
        throw new StateTransitionError(
          `Claim for inbox message '${input.requestMessageId}' is invalid or expired`,
        );
      }

      const envelope = parseEnvelope(JSON.parse(row.envelope_json));
      if (
        row.authenticated_ingress !== 1 ||
        !resourceIdResult.success
      ) {
        return { status: "denied" };
      }
      const resourceId = resourceIdResult.data;
      if (envelope.payload.project !== resourceId) {
        return { status: "denied" };
      }
      const peerSystemId = SystemIdSchema.safeParse(envelope.origin_system);
      if (!peerSystemId.success) {
        return { status: "denied" };
      }
      const resource = this.getResource(resourceId);
      if (!resource?.enabled) {
        return { status: "denied" };
      }
      if (this.isPeerAuthorizedForResource(peerSystemId.data, resourceId)) {
        return { status: "authorized", basis: "persistent_grant" };
      }

      const temporary = this.database
        .prepare(
          `SELECT request_id
           FROM authorization_requests
           WHERE peer_system_id = ?
             AND resource_id = ?
             AND state = 'approved_temporary'
             AND temporary_expires_at_utc > ?
           ORDER BY temporary_expires_at_utc DESC, request_id
           LIMIT 1`,
        )
        .get(peerSystemId.data, resourceId, nowUtc) as
        | { request_id: string }
        | undefined;
      if (temporary) {
        this.insertAuthorizationAudit({
          requestId: temporary.request_id,
          event: "temporary_used",
          state: "approved_temporary",
          actorId,
          peerSystemId: peerSystemId.data,
          resourceId,
          occurredAtUtc: nowUtc,
        });
        return {
          status: "authorized",
          basis: "temporary_approval",
          approvalRequestId: temporary.request_id,
        };
      }

      const requestIdentity = hashAuthorizationValue([
        peerSystemId.data,
        resourceId,
        envelope.kind,
        envelope.stream_id,
        envelope.idempotency_key,
      ]);
      const requestFingerprint = hashAuthorizationValue([
        requestIdentity,
        row.payload_sha256,
      ]);
      const existing = this.getAuthorizationRequestRowByIdentity(requestIdentity);
      if (existing && existing.request_id !== input.requestMessageId) {
        return {
          status: "duplicate",
          approvalRequestId: existing.request_id,
        };
      }
      if (existing) {
        if (existing.request_fingerprint !== requestFingerprint) {
          return {
            status: "duplicate",
            approvalRequestId: existing.request_id,
          };
        }
        switch (existing.state) {
          case "pending":
            this.parkClaimForApproval(input, nowUtc);
            return {
              status: "approval_pending",
              approvalRequestId: existing.request_id,
            };
          case "approved_once":
            this.database
              .prepare(
                `UPDATE authorization_requests
                 SET state = 'consumed', consumed_at_utc = ?, updated_at_utc = ?
                 WHERE request_id = ? AND state = 'approved_once'`,
              )
              .run(nowUtc, nowUtc, existing.request_id);
            this.insertAuthorizationAudit({
              requestId: existing.request_id,
              event: "consumed",
              state: "consumed",
              actorId,
              peerSystemId: peerSystemId.data,
              resourceId,
              occurredAtUtc: nowUtc,
            });
            return {
              status: "authorized",
              basis: "approve_once",
              approvalRequestId: existing.request_id,
            };
          case "consumed":
            return this.database
              .prepare(
                `SELECT 1 FROM consultation_runs
                 WHERE request_message_id = ?`,
              )
              .get(existing.request_id)
              ? {
                  status: "authorized",
                  basis: "same_request_recovery",
                  approvalRequestId: existing.request_id,
                }
              : {
                  status: "denied",
                  approvalRequestId: existing.request_id,
                };
          case "approved_temporary":
            return existing.temporary_expires_at_utc &&
              existing.temporary_expires_at_utc > nowUtc
              ? {
                  status: "authorized",
                  basis: "temporary_approval",
                  approvalRequestId: existing.request_id,
                }
              : { status: "denied", approvalRequestId: existing.request_id };
          case "denied":
          case "revoked":
          case "expired":
            return { status: "denied", approvalRequestId: existing.request_id };
        }
      }

      this.database
        .prepare(
          `INSERT INTO authorization_requests (
             request_id, request_identity, request_fingerprint,
             peer_system_id, resource_id, state, requested_at_utc,
             decided_at_utc, decided_by, temporary_expires_at_utc,
             consumed_at_utc, reason, updated_at_utc
           ) VALUES (?, ?, ?, ?, ?, 'pending', ?, NULL, NULL, NULL, NULL, NULL, ?)`,
        )
        .run(
          input.requestMessageId,
          requestIdentity,
          requestFingerprint,
          peerSystemId.data,
          resourceId,
          nowUtc,
          nowUtc,
        );
      this.insertAuthorizationAudit({
        requestId: input.requestMessageId,
        event: "requested",
        state: "pending",
        actorId,
        peerSystemId: peerSystemId.data,
        resourceId,
        occurredAtUtc: nowUtc,
      });
      this.parkClaimForApproval(input, nowUtc);
      return {
        status: "approval_pending",
        approvalRequestId: input.requestMessageId,
      };
    });
    return transaction.immediate();
  }

  public listAuthorizationRequests(input: {
    state?: AuthorizationRequestState;
    now?: Date;
  } = {}): AuthorizationRequest[] {
    const now = input.now ?? new Date();
    this.expireAuthorizationRequests(now);
    const state = input.state === undefined
      ? undefined
      : AuthorizationRequestStateSchema.parse(input.state);
    const rows = this.database
      .prepare(
        `SELECT request_id, request_identity, request_fingerprint,
                peer_system_id, resource_id, state, requested_at_utc,
                decided_at_utc, decided_by, temporary_expires_at_utc,
                consumed_at_utc, reason, updated_at_utc
         FROM authorization_requests
         ${state === undefined ? "" : "WHERE state = ?"}
         ORDER BY requested_at_utc, request_id`,
      )
      .all(...(state === undefined ? [] : [state])) as AuthorizationRequestRow[];
    return rows.map((row) => this.mapAuthorizationRequest(row));
  }

  public getAuthorizationRequest(
    requestId: string,
    now = new Date(),
  ): AuthorizationRequest | undefined {
    assertNonEmpty(requestId, "requestId");
    this.expireAuthorizationRequests(now);
    const row = this.getAuthorizationRequestRow(requestId);
    return row ? this.mapAuthorizationRequest(row) : undefined;
  }

  public approveAuthorizationRequestOnce(input: {
    requestId: string;
    actorId: string;
    now?: Date;
  }): AuthorizationRequest {
    return this.decideAuthorizationRequest({
      ...input,
      state: "approved_once",
      event: "approved_once",
    });
  }

  public approveAuthorizationRequestTemporary(input: {
    requestId: string;
    actorId: string;
    expiresAtUtc: string;
    now?: Date;
  }): AuthorizationRequest {
    const now = input.now ?? new Date();
    const expiresAt = parseUtcInstant(input.expiresAtUtc, "expiresAtUtc");
    if (expiresAt.getTime() <= now.getTime()) {
      throw new StateTransitionError(
        "Temporary approval expiry must be later than the decision time",
      );
    }
    return this.decideAuthorizationRequest({
      requestId: input.requestId,
      actorId: input.actorId,
      now,
      state: "approved_temporary",
      event: "approved_temporary",
      temporaryExpiresAtUtc: expiresAt.toISOString(),
    });
  }

  public denyAuthorizationRequest(input: {
    requestId: string;
    actorId: string;
    reason?: string;
    now?: Date;
  }): AuthorizationRequest {
    const reason = parseAuthorizationReason(input.reason);
    return this.decideAuthorizationRequest({
      requestId: input.requestId,
      actorId: input.actorId,
      ...(input.now ? { now: input.now } : {}),
      state: "denied",
      event: "denied",
      ...(reason ? { reason } : {}),
    });
  }

  public revokeAuthorizationRequest(input: {
    requestId: string;
    actorId: string;
    reason?: string;
    now?: Date;
  }): AuthorizationRequest {
    assertNonEmpty(input.requestId, "requestId");
    const actorId = SystemIdSchema.parse(input.actorId);
    const now = input.now ?? new Date();
    const nowUtc = now.toISOString();
    const reason = parseAuthorizationReason(input.reason);
    const transaction = this.database.transaction(() => {
      this.expireAuthorizationRequests(now);
      const row = this.getAuthorizationRequestRow(input.requestId);
      if (!row) {
        throw new StateTransitionError("Authorization request does not exist");
      }
      if (row.state === "revoked") {
        return this.mapAuthorizationRequest(row);
      }
      if (row.state !== "approved_once" && row.state !== "approved_temporary") {
        throw new StateTransitionError(
          "Only an active approval can be revoked",
        );
      }
      const result = this.database
        .prepare(
          `UPDATE authorization_requests
           SET state = 'revoked', decided_at_utc = ?, decided_by = ?,
               reason = ?, updated_at_utc = ?
           WHERE request_id = ? AND state = ?`,
        )
        .run(nowUtc, actorId, reason ?? null, nowUtc, input.requestId, row.state);
      if (result.changes !== 1) {
        throw new StateTransitionError("Authorization request changed concurrently");
      }
      this.insertAuthorizationAudit({
        requestId: row.request_id,
        event: "revoked",
        state: "revoked",
        actorId,
        peerSystemId: SystemIdSchema.parse(row.peer_system_id),
        resourceId: ResourceIdSchema.parse(row.resource_id),
        occurredAtUtc: nowUtc,
        ...(reason ? { reason } : {}),
      });
      this.requeueAuthorizationRequest(row.request_id);
      return this.mapAuthorizationRequest(
        this.getAuthorizationRequestRow(row.request_id)!,
      );
    });
    return transaction.immediate();
  }

  public listAuthorizationAudit(input: {
    requestId?: string;
    peerSystemId?: string;
    resourceId?: string;
  } = {}): AuthorizationAuditRecord[] {
    const filters: string[] = [];
    const parameters: string[] = [];
    if (input.requestId !== undefined) {
      assertNonEmpty(input.requestId, "requestId");
      filters.push("request_id = ?");
      parameters.push(input.requestId);
    }
    if (input.peerSystemId !== undefined) {
      filters.push("peer_system_id = ?");
      parameters.push(SystemIdSchema.parse(input.peerSystemId));
    }
    if (input.resourceId !== undefined) {
      filters.push("resource_id = ?");
      parameters.push(ResourceIdSchema.parse(input.resourceId));
    }
    const rows = this.database
      .prepare(
        `SELECT event_id, request_id, event, state, actor_id,
                peer_system_id, resource_id, occurred_at_utc, reason
         FROM authorization_audit
         ${filters.length === 0 ? "" : `WHERE ${filters.join(" AND ")}`}
         ORDER BY occurred_at_utc, rowid`,
      )
      .all(...parameters) as AuthorizationAuditRow[];
    return rows.map((row) => ({
      eventId: row.event_id,
      requestId: row.request_id,
      event: AuthorizationAuditEventSchema.parse(row.event),
      state: AuthorizationRequestStateSchema.parse(row.state),
      actorId: SystemIdSchema.parse(row.actor_id),
      peerSystemId: SystemIdSchema.parse(row.peer_system_id),
      resourceId: ResourceIdSchema.parse(row.resource_id),
      occurredAtUtc: row.occurred_at_utc,
      ...(row.reason ? { reason: row.reason } : {}),
    }));
  }

  private decideAuthorizationRequest(input: {
    requestId: string;
    actorId: string;
    state: "approved_once" | "approved_temporary" | "denied";
    event: "approved_once" | "approved_temporary" | "denied";
    temporaryExpiresAtUtc?: string;
    reason?: string;
    now?: Date;
  }): AuthorizationRequest {
    assertNonEmpty(input.requestId, "requestId");
    const actorId = SystemIdSchema.parse(input.actorId);
    const now = input.now ?? new Date();
    const nowUtc = now.toISOString();
    const transaction = this.database.transaction(() => {
      this.expireAuthorizationRequests(now);
      const row = this.getAuthorizationRequestRow(input.requestId);
      if (!row) {
        throw new StateTransitionError("Authorization request does not exist");
      }
      if (row.state === input.state) {
        return this.mapAuthorizationRequest(row);
      }
      if (row.state !== "pending") {
        throw new StateTransitionError(
          "Only a pending authorization request can be decided",
        );
      }
      const resource = this.getResource(row.resource_id);
      if (!resource?.enabled) {
        throw new StateTransitionError(
          "Authorization request resource is unavailable",
        );
      }
      if (
        input.state !== "denied" &&
        this.isPeerAuthorizedForResource(row.peer_system_id, row.resource_id)
      ) {
        throw new StateTransitionError(
          "Authorization request already has a persistent grant",
        );
      }
      const result = this.database
        .prepare(
          `UPDATE authorization_requests
           SET state = ?, decided_at_utc = ?, decided_by = ?,
               temporary_expires_at_utc = ?, reason = ?, updated_at_utc = ?
           WHERE request_id = ? AND state = 'pending'`,
        )
        .run(
          input.state,
          nowUtc,
          actorId,
          input.temporaryExpiresAtUtc ?? null,
          input.reason ?? null,
          nowUtc,
          row.request_id,
        );
      if (result.changes !== 1) {
        throw new StateTransitionError("Authorization request changed concurrently");
      }
      this.insertAuthorizationAudit({
        requestId: row.request_id,
        event: input.event,
        state: input.state,
        actorId,
        peerSystemId: SystemIdSchema.parse(row.peer_system_id),
        resourceId: ResourceIdSchema.parse(row.resource_id),
        occurredAtUtc: nowUtc,
        ...(input.reason ? { reason: input.reason } : {}),
      });
      this.requeueAuthorizationRequest(row.request_id);
      return this.mapAuthorizationRequest(
        this.getAuthorizationRequestRow(row.request_id)!,
      );
    });
    return transaction.immediate();
  }

  private expireAuthorizationRequests(now: Date): void {
    const nowUtc = now.toISOString();
    const expire = (): void => {
      const rows = this.database
        .prepare(
          `SELECT request_id, request_identity, request_fingerprint,
                  peer_system_id, resource_id, state, requested_at_utc,
                  decided_at_utc, decided_by, temporary_expires_at_utc,
                  consumed_at_utc, reason, updated_at_utc
           FROM authorization_requests
           WHERE state = 'approved_temporary'
             AND temporary_expires_at_utc <= ?
           ORDER BY request_id`,
        )
        .all(nowUtc) as AuthorizationRequestRow[];
      for (const row of rows) {
        const result = this.database
          .prepare(
            `UPDATE authorization_requests
             SET state = 'expired', updated_at_utc = ?
             WHERE request_id = ?
               AND state = 'approved_temporary'
               AND temporary_expires_at_utc <= ?`,
          )
          .run(nowUtc, row.request_id, nowUtc);
        if (result.changes !== 1) {
          continue;
        }
        this.insertAuthorizationAudit({
          requestId: row.request_id,
          event: "expired",
          state: "expired",
          actorId: SystemIdSchema.parse(row.decided_by ?? row.peer_system_id),
          peerSystemId: SystemIdSchema.parse(row.peer_system_id),
          resourceId: ResourceIdSchema.parse(row.resource_id),
          occurredAtUtc: nowUtc,
        });
      }
    };
    if (this.database.inTransaction) {
      expire();
    } else {
      this.database.transaction(expire).immediate();
    }
  }

  private parkClaimForApproval(
    input: {
      requestMessageId: string;
      consumerId: string;
      claimToken: string;
    },
    nowUtc: string,
  ): void {
    const result = this.database
      .prepare(
        `UPDATE inbox
         SET state = 'quarantined', claim_owner = NULL,
             claim_token_hash = NULL, claim_until_utc = NULL,
             last_error = 'Authorization approval pending'
         WHERE message_id = ? AND state = 'claimed'
           AND claim_owner = ? AND claim_token_hash = ?
           AND claim_until_utc > ?`,
      )
      .run(
        input.requestMessageId,
        input.consumerId,
        hashToken(input.claimToken),
        nowUtc,
      );
    if (result.changes !== 1) {
      throw new StateTransitionError(
        `Claim for inbox message '${input.requestMessageId}' is invalid or expired`,
      );
    }
  }

  private requeueAuthorizationRequest(requestId: string): void {
    this.database
      .prepare(
        `UPDATE inbox
         SET state = 'available', claim_owner = NULL,
             claim_token_hash = NULL, claim_until_utc = NULL,
             last_error = NULL
         WHERE message_id = ? AND state = 'quarantined'`,
      )
      .run(requestId);
  }

  private getAuthorizationRequestRow(
    requestId: string,
  ): AuthorizationRequestRow | undefined {
    return this.database
      .prepare(
        `SELECT request_id, request_identity, request_fingerprint,
                peer_system_id, resource_id, state, requested_at_utc,
                decided_at_utc, decided_by, temporary_expires_at_utc,
                consumed_at_utc, reason, updated_at_utc
         FROM authorization_requests WHERE request_id = ?`,
      )
      .get(requestId) as AuthorizationRequestRow | undefined;
  }

  private getAuthorizationRequestRowByIdentity(
    requestIdentity: string,
  ): AuthorizationRequestRow | undefined {
    return this.database
      .prepare(
        `SELECT request_id, request_identity, request_fingerprint,
                peer_system_id, resource_id, state, requested_at_utc,
                decided_at_utc, decided_by, temporary_expires_at_utc,
                consumed_at_utc, reason, updated_at_utc
         FROM authorization_requests WHERE request_identity = ?`,
      )
      .get(requestIdentity) as AuthorizationRequestRow | undefined;
  }

  private mapAuthorizationRequest(row: AuthorizationRequestRow): AuthorizationRequest {
    return {
      requestId: row.request_id,
      requestFingerprint: row.request_fingerprint,
      peerSystemId: SystemIdSchema.parse(row.peer_system_id),
      resourceId: ResourceIdSchema.parse(row.resource_id),
      state: AuthorizationRequestStateSchema.parse(row.state),
      requestedAtUtc: row.requested_at_utc,
      ...(row.temporary_expires_at_utc
        ? { temporaryExpiresAtUtc: row.temporary_expires_at_utc }
        : {}),
      ...(row.reason ? { reason: row.reason } : {}),
    };
  }

  private insertAuthorizationAudit(input: {
    requestId: string;
    event: AuthorizationAuditEventName;
    state: AuthorizationRequestState;
    actorId: SystemId;
    peerSystemId: SystemId;
    resourceId: string;
    occurredAtUtc: string;
    reason?: string;
  }): void {
    this.database
      .prepare(
        `INSERT INTO authorization_audit (
           event_id, request_id, event, state, actor_id,
           peer_system_id, resource_id, occurred_at_utc, reason
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        randomUUID(),
        input.requestId,
        input.event,
        input.state,
        input.actorId,
        input.peerSystemId,
        input.resourceId,
        input.occurredAtUtc,
        input.reason ?? null,
      );
  }

  private getResource(resourceId: string): RegisteredResource | undefined {
    const row = this.database
      .prepare(
        `SELECT resource_id, enabled, created_at_utc, updated_at_utc
         FROM resources WHERE resource_id = ?`,
      )
      .get(resourceId) as {
      resource_id: string;
      enabled: number;
      created_at_utc: string;
      updated_at_utc: string;
    } | undefined;
    return row
      ? {
          resourceId: row.resource_id,
          enabled: row.enabled === 1,
          createdAtUtc: row.created_at_utc,
          updatedAtUtc: row.updated_at_utc,
        }
      : undefined;
  }

  private getPeerResourceGrant(
    peerSystemId: SystemId,
    resourceId: string,
  ): PeerResourceGrant | undefined {
    const row = this.database
      .prepare(
        `SELECT peer_system_id, resource_id, state, granted_at_utc, revoked_at_utc
         FROM peer_resource_grants
         WHERE peer_system_id = ? AND resource_id = ?`,
      )
      .get(peerSystemId, resourceId) as {
      peer_system_id: string;
      resource_id: string;
      state: PeerResourceGrantState;
      granted_at_utc: string;
      revoked_at_utc: string | null;
    } | undefined;
    return row
      ? {
          peerSystemId: SystemIdSchema.parse(row.peer_system_id),
          resourceId: ResourceIdSchema.parse(row.resource_id),
          state: PeerResourceGrantStateSchema.parse(row.state),
          grantedAtUtc: row.granted_at_utc,
          ...(row.revoked_at_utc ? { revokedAtUtc: row.revoked_at_utc } : {}),
        }
      : undefined;
  }

  public getConsultationRun(
    requestMessageId: string,
  ): ConsultationRun | undefined {
    const row = this.database
      .prepare(
        `SELECT run_json
         FROM consultation_runs
         WHERE request_message_id = ?`,
      )
      .get(requestMessageId) as { run_json: string } | undefined;
    return row
      ? ConsultationRunSchema.parse(JSON.parse(row.run_json))
      : undefined;
  }

  public ensureConsultationRun(
    value: ConsultationRun,
  ): EnsureConsultationRunResult {
    const run = ConsultationRunSchema.parse(value);
    if (run.version !== 0) {
      throw new StateTransitionError(
        "A new consultation run must begin at version 0",
      );
    }
    const insert = this.database
      .prepare(
        `INSERT OR IGNORE INTO consultation_runs (
          request_message_id,
          state,
          version,
          run_json,
          created_at_utc,
          updated_at_utc
        ) VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(
        run.request_message_id,
        run.state,
        run.version,
        JSON.stringify(run),
        run.created_at_utc,
        run.updated_at_utc,
      );
    if (insert.changes === 1) {
      return { run, created: true };
    }

    const existing = this.getConsultationRun(run.request_message_id);
    if (!existing) {
      throw new StateTransitionError(
        `Consultation run '${run.request_message_id}' collided with an unreadable row`,
      );
    }
    if (!sameConsultationIdentity(existing, run)) {
      throw new StateTransitionError(
        `Consultation run '${run.request_message_id}' already exists with different identity`,
      );
    }
    return { run: existing, created: false };
  }

  public saveConsultationRun(
    value: ConsultationRun,
    expectedVersion: number,
    now = new Date(),
  ): ConsultationRun {
    const candidate = ConsultationRunSchema.parse(value);
    if (candidate.version !== expectedVersion) {
      throw new StateTransitionError(
        "Consultation run version does not match the expected version",
      );
    }
    const updated = ConsultationRunSchema.parse({
      ...candidate,
      version: expectedVersion + 1,
      updated_at_utc: now.toISOString(),
    });
    const result = this.database
      .prepare(
        `UPDATE consultation_runs
         SET state = ?,
             version = ?,
             run_json = ?,
             updated_at_utc = ?
         WHERE request_message_id = ?
           AND version = ?`,
      )
      .run(
        updated.state,
        updated.version,
        JSON.stringify(updated),
        updated.updated_at_utc,
        updated.request_message_id,
        expectedVersion,
      );
    if (result.changes !== 1) {
      throw new StateTransitionError(
        `Consultation run '${updated.request_message_id}' has a stale version`,
      );
    }
    return updated;
  }

  public enqueueEnvelope(
    envelopeValue: unknown,
    comparison: IdempotencyComparisonOptions = {},
  ): EnqueueResult {
    const envelope = parseEnvelope(envelopeValue);
    const transaction = this.database.transaction(() =>
      this.enqueueEnvelopeRow(envelope, comparison),
    );
    return transaction.immediate();
  }

  private enqueueEnvelopeRow(
    envelope: BridgeEnvelope,
    comparison: IdempotencyComparisonOptions = {},
  ): EnqueueResult {
    if (
      envelope.kind === "task_request" &&
      envelope.stream_id === "agent-coordination" &&
      envelope.sequence_number === 0 &&
      envelope.payload.coordination_request
    ) {
      const existingRoot = this.database
        .prepare(
          `SELECT target_system, idempotency_key
           FROM outbox
           WHERE json_extract(envelope_json, '$.conversation_id') = ?
             AND kind = 'task_request'
             AND stream_id = 'agent-coordination'
             AND json_extract(envelope_json, '$.sequence_number') = 0
             AND json_extract(envelope_json, '$.payload.coordination_request') IS NOT NULL
           LIMIT 1`,
        )
        .get(envelope.conversation_id) as
        | { target_system: string; idempotency_key: string }
        | undefined;
      if (
        existingRoot &&
        (existingRoot.target_system !== envelope.target_system ||
          existingRoot.idempotency_key !== envelope.idempotency_key)
      ) {
        throw new StateTransitionError(
          "A coordination conversation already has a different root request",
        );
      }
    }
    const insert = this.database
      .prepare(
        `INSERT OR IGNORE INTO outbox (
          message_id,
          idempotency_key,
          target_system,
          kind,
          stream_id,
          payload_sha256,
          envelope_json,
          state,
          attempt_count,
          next_attempt_at_utc,
          created_at_utc,
          expires_at_utc
        ) VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', 0, ?, ?, ?)`,
      )
      .run(
        envelope.message_id,
        envelope.idempotency_key,
        envelope.target_system,
        envelope.kind,
        envelope.stream_id,
        envelope.payload_sha256,
        JSON.stringify(envelope),
        envelope.created_at_utc,
        envelope.created_at_utc,
        envelope.expires_at_utc ?? null,
      );
    if (insert.changes === 1) {
      return {
        messageId: envelope.message_id,
        state: "pending",
        duplicate: false,
      };
    }

    const existing = this.getOutboxOperation(
      envelope.target_system,
      envelope.idempotency_key,
    );

    if (existing) {
      const prior = existing.envelope;
      if (!sameIdempotentOperation(prior, envelope, comparison)) {
        throw new IdempotencyConflictError(envelope.idempotency_key);
      }
      return {
        messageId: prior.message_id,
        state: existing.state,
        duplicate: true,
      };
    }

    throw new StateTransitionError(
      `Outbox message '${envelope.message_id}' collided with an unrelated existing row`,
    );
  }

  private getOutboxOperation(
    targetSystem: string,
    idempotencyKey: string,
  ):
    | {
        envelope: BridgeEnvelope;
        state: OutboxState;
      }
    | undefined {
    const row = this.database
      .prepare(
        `SELECT envelope_json, state
         FROM outbox
         WHERE target_system = ? AND idempotency_key = ?`,
      )
      .get(targetSystem, idempotencyKey) as
      | Pick<OutboxRow, "envelope_json" | "state">
      | undefined;
    if (!row) {
      return undefined;
    }
    return {
      envelope: parseEnvelope(JSON.parse(row.envelope_json)),
      state: row.state,
    };
  }

  public settleInboxWithReply(input: {
    messageId: string;
    consumerId: string;
    claimToken: string;
    outcome: "processed" | "rejected";
    replyEnvelope: unknown;
    reason?: string;
    now?: Date;
  }): SettleInboxWithReplyResult {
    const reply = parseEnvelope(input.replyEnvelope);
    const now = input.now ?? new Date();
    const nowUtc = now.toISOString();
    const transaction = this.database.transaction(
      (): SettleInboxWithReplyResult => {
        const existing = this.database
          .prepare(
            `SELECT state, claim_owner, claim_token_hash, claim_until_utc,
                    result_message_id, result_idempotency_key,
                    result_payload_sha256
             FROM inbox WHERE message_id = ?`,
          )
          .get(input.messageId) as
          | {
              state: InboxState;
              claim_owner: string | null;
              claim_token_hash: string | null;
              claim_until_utc: string | null;
              result_message_id: string | null;
              result_idempotency_key: string | null;
              result_payload_sha256: string | null;
            }
          | undefined;
        if (!existing) {
          throw new StateTransitionError(
            `Inbox message '${input.messageId}' does not exist`,
          );
        }

        if (existing.state === input.outcome) {
          if (
            existing.result_message_id &&
            existing.result_idempotency_key === reply.idempotency_key
          ) {
            const authoritative = this.getOutboxOperation(
              reply.target_system,
              reply.idempotency_key,
            );
            if (
              !authoritative ||
              authoritative.envelope.message_id !==
                existing.result_message_id ||
              authoritative.envelope.payload_sha256 !==
                existing.result_payload_sha256
            ) {
              throw new StateTransitionError(
                `Inbox message '${input.messageId}' has inconsistent result metadata`,
              );
            }
            return {
              inboxState: input.outcome,
              reply: {
                messageId: authoritative.envelope.message_id,
                state: authoritative.state,
                duplicate: true,
              },
            };
          }
          throw new StateTransitionError(
            `Inbox message '${input.messageId}' was already settled with a different result`,
          );
        }

        if (
          existing.state !== "claimed" ||
          existing.claim_owner !== input.consumerId ||
          existing.claim_token_hash !== hashToken(input.claimToken) ||
          !existing.claim_until_utc ||
          existing.claim_until_utc <= nowUtc
        ) {
          throw new StateTransitionError(
            `Claim for inbox message '${input.messageId}' is invalid or expired`,
          );
        }

        let authoritativeReply = reply;
        let enqueued: EnqueueResult;
        try {
          enqueued = this.enqueueEnvelopeRow(reply);
        } catch (error) {
          if (!(error instanceof IdempotencyConflictError)) {
            throw error;
          }
          const existingReply = this.getOutboxOperation(
            reply.target_system,
            reply.idempotency_key,
          );
          if (
            !existingReply ||
            existingReply.envelope.kind !== reply.kind ||
            existingReply.envelope.conversation_id !==
              reply.conversation_id ||
            existingReply.envelope.causation_id !== input.messageId
          ) {
            throw error;
          }
          if (
            existingReply.state === "quarantined" ||
            existingReply.state === "expired"
          ) {
            throw new DispatchResultUnavailableError(
              "The existing deterministic result is not deliverable.",
            );
          }
          authoritativeReply = existingReply.envelope;
          enqueued = {
            messageId: authoritativeReply.message_id,
            state: existingReply.state,
            duplicate: true,
          };
        }
        const update = this.database
          .prepare(
            `UPDATE inbox
             SET state = ?,
                 claim_owner = NULL,
                 claim_token_hash = NULL,
                 claim_until_utc = NULL,
                 processed_at_utc = CASE
                   WHEN ? = 'processed' THEN ?
                   ELSE processed_at_utc
                 END,
                 last_error = ?,
                 result_message_id = ?,
                 result_idempotency_key = ?,
                 result_payload_sha256 = ?
             WHERE message_id = ?
               AND state = 'claimed'
               AND claim_owner = ?
               AND claim_token_hash = ?
               AND claim_until_utc > ?`,
          )
          .run(
            input.outcome,
            input.outcome,
            nowUtc,
            input.reason ? truncate(input.reason, 2000) : null,
            enqueued.messageId,
            authoritativeReply.idempotency_key,
            authoritativeReply.payload_sha256,
            input.messageId,
            input.consumerId,
            hashToken(input.claimToken),
            nowUtc,
          );
        if (update.changes !== 1) {
          throw new StateTransitionError(
            `Claim for inbox message '${input.messageId}' was lost before result settlement`,
          );
        }

        return {
          inboxState: input.outcome,
          reply: enqueued,
        };
      },
    );
    return transaction();
  }

  public leaseOutbox(
    leaseOwner: string,
    limit: number,
    leaseSeconds: number,
    now = new Date(),
  ): LeasedOutboxMessage[] {
    assertPositiveInteger(limit, "limit");
    assertPositiveInteger(leaseSeconds, "leaseSeconds");
    const nowUtc = now.toISOString();
    const leaseUntilUtc = addSeconds(now, leaseSeconds).toISOString();

    const transaction = this.database.transaction(() => {
      this.database
        .prepare(
          `UPDATE outbox
           SET state = 'pending', lease_owner = NULL, lease_until_utc = NULL
           WHERE state = 'leased' AND lease_until_utc <= ?`,
        )
        .run(nowUtc);
      this.database
        .prepare(
          `UPDATE outbox
           SET state = 'expired', lease_owner = NULL, lease_until_utc = NULL
           WHERE state IN ('pending', 'leased')
             AND expires_at_utc IS NOT NULL
             AND expires_at_utc <= ?`,
        )
        .run(nowUtc);

      const rows = this.database
        .prepare(
          `SELECT message_id, envelope_json, state, lease_owner, lease_until_utc
                  , attempt_count
           FROM outbox
           WHERE state = 'pending'
             AND next_attempt_at_utc <= ?
           ORDER BY created_at_utc, message_id
           LIMIT ?`,
        )
        .all(nowUtc, limit) as OutboxRow[];

      const leased: LeasedOutboxMessage[] = [];
      const update = this.database.prepare(
        `UPDATE outbox
         SET state = 'leased', lease_owner = ?, lease_until_utc = ?
         WHERE message_id = ? AND state = 'pending'`,
      );
      for (const row of rows) {
        const result = update.run(leaseOwner, leaseUntilUtc, row.message_id);
        if (result.changes !== 1) {
          throw new StateTransitionError(
            `Outbox message '${row.message_id}' could not be leased`,
          );
        }
        leased.push({
          envelope: parseEnvelope(JSON.parse(row.envelope_json)),
          leaseOwner,
          leaseUntilUtc,
          attemptNumber: row.attempt_count + 1,
        });
      }
      return leased;
    });

    return transaction();
  }

  public markOutboxSent(
    messageId: string,
    leaseOwner: string,
    now = new Date(),
  ): void {
    const result = this.database
      .prepare(
        `UPDATE outbox
         SET state = 'sent',
             sent_at_utc = ?,
             lease_owner = NULL,
             lease_until_utc = NULL,
             last_error_code = NULL,
             last_error = NULL
         WHERE message_id = ? AND state = 'leased' AND lease_owner = ?`,
      )
      .run(now.toISOString(), messageId, leaseOwner);
    if (result.changes !== 1) {
      throw new StateTransitionError(
        `Outbox message '${messageId}' is not leased by '${leaseOwner}'`,
      );
    }
  }

  public releaseOutboxLease(
    messageId: string,
    leaseOwner: string,
    retryAt: Date,
    errorCode: string,
  ): void {
    const safeCode = normalizeErrorCode(errorCode);
    const result = this.database
      .prepare(
        `UPDATE outbox
         SET state = 'pending',
             attempt_count = attempt_count + 1,
             next_attempt_at_utc = ?,
             lease_owner = NULL,
             lease_until_utc = NULL,
             last_error_code = ?,
             last_error = ?
         WHERE message_id = ? AND state = 'leased' AND lease_owner = ?`,
      )
      .run(
        retryAt.toISOString(),
        safeCode,
        safeCode,
        messageId,
        leaseOwner,
      );
    if (result.changes !== 1) {
      throw new StateTransitionError(
        `Outbox message '${messageId}' is not leased by '${leaseOwner}'`,
      );
    }
  }

  public quarantineOutbox(
    messageId: string,
    leaseOwner: string,
    errorCode: string,
  ): void {
    const safeCode = normalizeErrorCode(errorCode);
    const result = this.database
      .prepare(
        `UPDATE outbox
         SET state = 'quarantined',
             attempt_count = attempt_count + 1,
             lease_owner = NULL,
             lease_until_utc = NULL,
             last_error_code = ?,
             last_error = ?
         WHERE message_id = ? AND state = 'leased' AND lease_owner = ?`,
      )
      .run(
        safeCode,
        safeCode,
        messageId,
        leaseOwner,
      );
    if (result.changes !== 1) {
      throw new StateTransitionError(
        `Outbox message '${messageId}' is not leased by '${leaseOwner}'`,
      );
    }
  }

  public persistIncoming(
    envelopeValue: unknown,
    brokerDeliveryCount: number,
    now = new Date(),
    authenticatedIngress = false,
  ): PersistIncomingResult {
    const envelope = parseEnvelope(envelopeValue);
    const nowUtc = now.toISOString();

    const transaction = this.database.transaction((): PersistIncomingResult => {
      const existing = this.database
        .prepare(
          `SELECT message_id, envelope_json, payload_sha256, state,
                  claim_owner, claim_token_hash, claim_until_utc,
                  authenticated_ingress
           FROM inbox WHERE message_id = ?`,
        )
        .get(envelope.message_id) as InboxRow | undefined;

      if (existing) {
        const existingEnvelope = parseEnvelope(
          JSON.parse(existing.envelope_json) as unknown,
        );
        const sameOrigin =
          existingEnvelope.origin_system === envelope.origin_system;
        const collisionReason = !sameInboundMessage(
          existingEnvelope,
          envelope,
        )
          ? !sameOrigin
            ? "Message identity collision: origin system changed"
            : existing.payload_sha256 !== envelope.payload_sha256
              ? "Message identity collision: payload hash changed"
              : "Message identity collision: signed envelope metadata changed"
          : undefined;
        if (collisionReason && sameOrigin) {
          this.database
            .prepare(
              `UPDATE inbox
               SET state = 'quarantined',
                   last_received_at_utc = ?,
                   broker_delivery_count = ?,
                   last_error = ?
               WHERE message_id = ?`,
            )
            .run(
              nowUtc,
              brokerDeliveryCount,
              collisionReason,
              envelope.message_id,
            );
          return { status: "collision", messageId: envelope.message_id };
        }
        if (collisionReason) {
          // The caller dead-letters this conflicting delivery. Do not let one
          // authenticated peer quarantine another peer's accepted message by
          // copying its public identifier.
          return { status: "collision", messageId: envelope.message_id };
        }

        this.database
          .prepare(
            `UPDATE inbox
             SET last_received_at_utc = ?,
                  broker_delivery_count = MAX(broker_delivery_count, ?),
                  authenticated_ingress = MAX(authenticated_ingress, ?)
              WHERE message_id = ?`,
          )
          .run(
            nowUtc,
            brokerDeliveryCount,
            authenticatedIngress ? 1 : 0,
            envelope.message_id,
          );
        return { status: "duplicate", messageId: envelope.message_id };
      }

      this.database
        .prepare(
          `INSERT INTO inbox (
            message_id,
            origin_system,
            kind,
            stream_id,
            causation_id,
            payload_sha256,
            envelope_json,
            state,
            attempt_count,
            first_received_at_utc,
            last_received_at_utc,
            broker_delivery_count,
            authenticated_ingress
          ) VALUES (?, ?, ?, ?, ?, ?, ?, 'available', 0, ?, ?, ?, ?)`,
        )
        .run(
          envelope.message_id,
          envelope.origin_system,
          envelope.kind,
          envelope.stream_id,
          envelope.causation_id ?? null,
          envelope.payload_sha256,
          JSON.stringify(envelope),
          nowUtc,
          nowUtc,
          brokerDeliveryCount,
          authenticatedIngress ? 1 : 0,
        );
      return { status: "inserted", messageId: envelope.message_id };
    });

    return transaction();
  }

  public listInbox(
    limit: number,
    states: InboxState[] = ["available", "claimed"],
  ): InboxListItem[] {
    assertPositiveInteger(limit, "limit");
    if (states.length === 0) {
      return [];
    }

    const placeholders = states.map(() => "?").join(", ");
    const rows = this.database
      .prepare(
        `SELECT message_id, envelope_json, payload_sha256, state,
                claim_owner, claim_token_hash, claim_until_utc,
                authenticated_ingress
         FROM inbox
         WHERE state IN (${placeholders})
         ORDER BY first_received_at_utc, message_id
         LIMIT ?`,
      )
      .all(...states, limit) as InboxRow[];

    return rows.map((row) => ({
      envelope: parseEnvelope(JSON.parse(row.envelope_json)),
      state: row.state,
      authenticatedIngress: row.authenticated_ingress === 1,
      ...(row.claim_owner ? { claimOwner: row.claim_owner } : {}),
      ...(row.claim_until_utc ? { claimUntilUtc: row.claim_until_utc } : {}),
    }));
  }

  public claimInbox(
    consumerId: string,
    limit: number,
    leaseSeconds: number,
    kinds?: MessageKind[],
    now = new Date(),
  ): ClaimedInboxMessage[] {
    const kindFilter =
      kinds && kinds.length > 0
        ? `AND kind IN (${kinds.map(() => "?").join(", ")})`
        : "";
    return this.claimInboxWhere(
      consumerId,
      limit,
      leaseSeconds,
      kindFilter,
      kinds ?? [],
      now,
    );
  }

  public claimReadOnlyDispatchInbox(
    consumerId: string,
    limit: number,
    leaseSeconds: number,
    now = new Date(),
    notBeforeUtc?: string,
  ): ClaimedInboxMessage[] {
    const notBeforeFilter = notBeforeUtc
      ? `AND julianday(
           json_extract(envelope_json, '$.created_at_utc')
         ) >= julianday(?)`
      : "";
    return this.claimInboxWhere(
      consumerId,
      limit,
      leaseSeconds,
      `AND kind = 'task_request'
       AND json_extract(envelope_json, '$.payload.dispatch.executor') = 'codex_cli'
       AND json_extract(envelope_json, '$.payload.dispatch.access') = 'read_only'
       AND json_extract(envelope_json, '$.payload.dispatch.evidence_mode') IS NULL
       ${notBeforeFilter}`,
      notBeforeUtc ? [notBeforeUtc] : [],
      now,
    );
  }

  private claimInboxWhere(
    consumerId: string,
    limit: number,
    leaseSeconds: number,
    additionalFilter: string,
    additionalParameters: readonly string[],
    now: Date,
    includeExpired = false,
  ): ClaimedInboxMessage[] {
    assertNonEmpty(consumerId, "consumerId");
    assertPositiveInteger(limit, "limit");
    assertPositiveInteger(leaseSeconds, "leaseSeconds");
    const nowUtc = now.toISOString();
    const claimUntilUtc = addSeconds(now, leaseSeconds).toISOString();

    const transaction = this.database.transaction(() => {
      this.database
        .prepare(
          `UPDATE inbox
           SET state = 'available',
               claim_owner = NULL,
               claim_token_hash = NULL,
               claim_until_utc = NULL
           WHERE state = 'claimed' AND claim_until_utc <= ?`,
        )
        .run(nowUtc);

      const parameters: Array<string | number> = [
        ...(includeExpired ? [] : [nowUtc]),
        ...additionalParameters,
        limit,
      ];
      const expirationFilter = includeExpired
        ? ""
        : `AND (
               json_extract(envelope_json, '$.expires_at_utc') IS NULL
               OR json_extract(envelope_json, '$.expires_at_utc') > ?
             )`;
      const rows = this.database
        .prepare(
          `SELECT message_id, envelope_json, payload_sha256, state,
                  claim_owner, claim_token_hash, claim_until_utc,
                  authenticated_ingress
           FROM inbox
           WHERE state = 'available'
             ${expirationFilter}
             ${additionalFilter}
           ORDER BY first_received_at_utc, message_id
           LIMIT ?`,
        )
        .all(...parameters) as InboxRow[];

      const claimed: ClaimedInboxMessage[] = [];
      const update = this.database.prepare(
        `UPDATE inbox
         SET state = 'claimed',
             claim_owner = ?,
             claim_token_hash = ?,
             claim_until_utc = ?,
             attempt_count = attempt_count + 1
         WHERE message_id = ? AND state = 'available'`,
      );
      for (const row of rows) {
        const claimToken = randomBytes(32).toString("base64url");
        const result = update.run(
          consumerId,
          hashToken(claimToken),
          claimUntilUtc,
          row.message_id,
        );
        if (result.changes !== 1) {
          throw new StateTransitionError(
            `Inbox message '${row.message_id}' could not be claimed`,
          );
        }
        claimed.push({
          envelope: parseEnvelope(JSON.parse(row.envelope_json)),
          claimToken,
          claimUntilUtc,
          authenticatedIngress: row.authenticated_ingress === 1,
        });
      }
      return claimed;
    });

    return transaction();
  }

  public renewClaim(
    messageId: string,
    consumerId: string,
    claimToken: string,
    leaseSeconds: number,
    now = new Date(),
  ): string {
    assertPositiveInteger(leaseSeconds, "leaseSeconds");
    const claimUntilUtc = addSeconds(now, leaseSeconds).toISOString();
    const result = this.database
      .prepare(
        `UPDATE inbox
         SET claim_until_utc = ?
         WHERE message_id = ?
           AND state = 'claimed'
           AND claim_owner = ?
           AND claim_token_hash = ?
           AND claim_until_utc > ?`,
      )
      .run(
        claimUntilUtc,
        messageId,
        consumerId,
        hashToken(claimToken),
        now.toISOString(),
      );
    if (result.changes !== 1) {
      throw new StateTransitionError(
        `Claim for inbox message '${messageId}' is invalid or expired`,
      );
    }
    return claimUntilUtc;
  }

  public acknowledge(
    messageId: string,
    consumerId: string,
    claimToken: string,
    outcome: AcknowledgeOutcome,
    reason?: string,
    now = new Date(),
  ): InboxState {
    const targetState: InboxState =
      outcome === "processed"
        ? "processed"
        : outcome === "rejected"
          ? "rejected"
          : "available";
    const existing = this.database
      .prepare(
        `SELECT message_id, envelope_json, payload_sha256, state,
                claim_owner, claim_token_hash, claim_until_utc
         FROM inbox WHERE message_id = ?`,
      )
      .get(messageId) as InboxRow | undefined;

    if (!existing) {
      throw new StateTransitionError(
        `Inbox message '${messageId}' does not exist`,
      );
    }
    if (existing.state === targetState && targetState !== "available") {
      return targetState;
    }

    const result = this.database
      .prepare(
        `UPDATE inbox
         SET state = ?,
             claim_owner = NULL,
             claim_token_hash = NULL,
             claim_until_utc = NULL,
             processed_at_utc = CASE WHEN ? = 'processed' THEN ? ELSE processed_at_utc END,
             last_error = ?
         WHERE message_id = ?
           AND state = 'claimed'
           AND claim_owner = ?
           AND claim_token_hash = ?
           AND claim_until_utc > ?`,
      )
      .run(
        targetState,
        targetState,
        now.toISOString(),
        reason ? truncate(reason, 2000) : null,
        messageId,
        consumerId,
        hashToken(claimToken),
        now.toISOString(),
      );
    if (result.changes !== 1) {
      throw new StateTransitionError(
        `Claim for inbox message '${messageId}' is invalid, expired, or already settled differently`,
      );
    }
    return targetState;
  }

  public recordBridgeHeartbeat(
    instanceId: string,
    status: string,
    lastErrorCode?: string,
    now = new Date(),
  ): void {
    this.recordRuntimeHeartbeat(
      "bridge",
      instanceId,
      status,
      lastErrorCode,
      now,
    );
  }

  public recordDispatcherHeartbeat(
    instanceId: string,
    status: string,
    lastErrorCode?: string,
    now = new Date(),
  ): void {
    this.recordRuntimeHeartbeat(
      "dispatcher",
      instanceId,
      status,
      lastErrorCode,
      now,
    );
  }

  public recordConsultationCoordinatorHeartbeat(
    instanceId: string,
    status: string,
    lastErrorCode?: string,
    now = new Date(),
  ): void {
    this.recordRuntimeHeartbeat(
      "consultation_coordinator",
      instanceId,
      status,
      lastErrorCode,
      now,
    );
  }

  private recordRuntimeHeartbeat(
    component:
      | "bridge"
      | "dispatcher"
      | "consultation_coordinator",
    instanceId: string,
    status: string,
    lastErrorCode: string | undefined,
    now: Date,
  ): void {
    const safeCode = lastErrorCode
      ? normalizeErrorCode(lastErrorCode)
      : null;
    this.database
      .prepare(
        `INSERT INTO runtime_state (
          component, instance_id, status, heartbeat_at_utc, last_error
        ) VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(component) DO UPDATE SET
          instance_id = excluded.instance_id,
          status = excluded.status,
          heartbeat_at_utc = excluded.heartbeat_at_utc,
          last_error = excluded.last_error`,
      )
      .run(component, instanceId, status, now.toISOString(), safeCode);
  }

  public getStatus(now = new Date()): BridgeStatus {
    const outbox = countByState<OutboxState>(
      this.database,
      "outbox",
      ["pending", "leased", "sent", "quarantined", "expired"],
    );
    const inbox = countByState<InboxState>(
      this.database,
      "inbox",
      ["available", "claimed", "processed", "rejected", "quarantined"],
    );
    const consultation = countByState<ConsultationRunState>(
      this.database,
      "consultation_runs",
      [
        "pending_child",
        "needs_information",
        "waiting_peer",
        "completed",
        "failed",
      ],
    );
    const consultationEvidence = this.database
      .prepare(
        `SELECT
           COALESCE(SUM(
             CASE
               WHEN json_array_length(
                 json_extract(run_json, '$.evidence.items')
               ) > 0 THEN 1 ELSE 0
             END
           ), 0) AS runs_with_evidence,
           COALESCE(SUM(
             json_array_length(json_extract(run_json, '$.evidence.items'))
           ), 0) AS items,
           COALESCE(SUM(
             CAST(json_extract(run_json, '$.evidence.total_bytes') AS INTEGER)
           ), 0) AS total_bytes
         FROM consultation_runs`,
      )
      .get() as {
      runs_with_evidence: number;
      items: number;
      total_bytes: number;
    };
    const oldest = this.database
      .prepare(
        `SELECT MIN(created_at_utc) AS created_at_utc
         FROM outbox WHERE state IN ('pending', 'leased')`,
      )
      .get() as { created_at_utc: string | null };
    const runtime = this.database
      .prepare(
        `SELECT status, heartbeat_at_utc, last_error
         FROM runtime_state WHERE component = 'bridge'`,
      )
      .get() as
      | {
          status: string;
          heartbeat_at_utc: string;
          last_error: string | null;
        }
      | undefined;
    const dispatcherRuntime = this.database
      .prepare(
        `SELECT status, heartbeat_at_utc, last_error
         FROM runtime_state WHERE component = 'dispatcher'`,
      )
      .get() as
      | {
          status: string;
          heartbeat_at_utc: string;
          last_error: string | null;
      }
      | undefined;
    const consultationRuntime = this.database
      .prepare(
        `SELECT status, heartbeat_at_utc, last_error
         FROM runtime_state
         WHERE component = 'consultation_coordinator'`,
      )
      .get() as
      | {
          status: string;
          heartbeat_at_utc: string;
          last_error: string | null;
        }
      | undefined;

    const bridgeHealth = runtime
      ? effectiveRuntimeStatus(runtime, now, BRIDGE_STALE_AFTER_MS)
      : undefined;
    const dispatcherHealth = dispatcherRuntime
      ? effectiveRuntimeStatus(
          dispatcherRuntime,
          now,
          DISPATCHER_STALE_AFTER_MS,
        )
      : undefined;
    const consultationHealth = consultationRuntime
      ? effectiveRuntimeStatus(
          consultationRuntime,
          now,
          DISPATCHER_STALE_AFTER_MS,
        )
      : undefined;

    return {
      outbox,
      inbox,
      consultation,
      consultationEvidence: {
        runsWithEvidence: consultationEvidence.runs_with_evidence,
        items: consultationEvidence.items,
        totalBytes: consultationEvidence.total_bytes,
      },
      ...(oldest.created_at_utc
        ? { oldestPendingCreatedAtUtc: oldest.created_at_utc }
        : {}),
      ...(runtime
        ? {
            bridgeHeartbeatAtUtc: runtime.heartbeat_at_utc,
            bridgeHeartbeatAgeSeconds: bridgeHealth!.ageSeconds,
            bridgeRuntimeStatus: bridgeHealth!.status,
            bridgeReportedStatus: runtime.status,
            ...(runtime.last_error
              ? { lastTransportErrorCode: runtime.last_error }
              : {}),
          }
        : {}),
      ...(dispatcherRuntime
        ? {
            dispatcherHeartbeatAtUtc:
              dispatcherRuntime.heartbeat_at_utc,
            dispatcherHeartbeatAgeSeconds:
              dispatcherHealth!.ageSeconds,
            dispatcherRuntimeStatus: dispatcherHealth!.status,
            dispatcherReportedStatus: dispatcherRuntime.status,
            ...(dispatcherRuntime.last_error
              ? {
                  lastDispatcherErrorCode:
                    dispatcherRuntime.last_error,
                }
              : {}),
          }
        : {}),
      ...(consultationRuntime
        ? {
            consultationCoordinatorHeartbeatAtUtc:
              consultationRuntime.heartbeat_at_utc,
            consultationCoordinatorRuntimeStatus:
              consultationHealth!.status,
            consultationCoordinatorHeartbeatAgeSeconds:
              consultationHealth!.ageSeconds,
            consultationCoordinatorReportedStatus:
              consultationRuntime.status,
            ...(consultationRuntime.last_error
              ? {
                  lastConsultationCoordinatorErrorCode:
                    consultationRuntime.last_error,
                }
              : {}),
          }
        : {}),
    };
  }

  public recordDeliveryAttempt(input: {
    direction: "inbound" | "outbound";
    messageId: string;
    attemptNumber: number;
    startedAtUtc: string;
    finishedAtUtc: string;
    outcome: string;
    errorCode?: string;
  }): void {
    const safeCode = input.errorCode
      ? normalizeErrorCode(input.errorCode)
      : null;
    this.database
      .prepare(
        `INSERT INTO delivery_attempts (
          attempt_id,
          direction,
          message_id,
          attempt_number,
          started_at_utc,
          finished_at_utc,
          outcome,
          error_code,
          error_detail
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        randomUUID(),
        input.direction,
        input.messageId,
        input.attemptNumber,
        input.startedAtUtc,
        input.finishedAtUtc,
        input.outcome,
        safeCode,
        null,
      );
  }

  private migrate(): void {
    this.database.exec(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version INTEGER PRIMARY KEY,
        applied_at_utc TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS outbox (
        message_id TEXT PRIMARY KEY,
        idempotency_key TEXT NOT NULL,
        target_system TEXT NOT NULL CHECK (target_system IN ('SYS-A', 'SYS-B')),
        kind TEXT NOT NULL,
        stream_id TEXT NOT NULL,
        payload_sha256 TEXT NOT NULL,
        envelope_json TEXT NOT NULL,
        state TEXT NOT NULL CHECK (
          state IN ('pending', 'leased', 'sent', 'quarantined', 'expired')
        ),
        attempt_count INTEGER NOT NULL DEFAULT 0,
        next_attempt_at_utc TEXT NOT NULL,
        lease_owner TEXT,
        lease_until_utc TEXT,
        created_at_utc TEXT NOT NULL,
        expires_at_utc TEXT,
        sent_at_utc TEXT,
        last_error_code TEXT,
        last_error TEXT,
        UNIQUE (target_system, idempotency_key)
      );

      CREATE INDEX IF NOT EXISTS idx_outbox_dispatch
        ON outbox (state, next_attempt_at_utc, created_at_utc);

      CREATE TABLE IF NOT EXISTS inbox (
        message_id TEXT PRIMARY KEY,
        origin_system TEXT NOT NULL CHECK (origin_system IN ('SYS-A', 'SYS-B')),
        kind TEXT NOT NULL,
        stream_id TEXT NOT NULL,
        causation_id TEXT,
        payload_sha256 TEXT NOT NULL,
        envelope_json TEXT NOT NULL,
        state TEXT NOT NULL CHECK (
          state IN ('available', 'claimed', 'processed', 'rejected', 'quarantined')
        ),
        claim_owner TEXT,
        claim_token_hash TEXT,
        claim_until_utc TEXT,
        attempt_count INTEGER NOT NULL DEFAULT 0,
        first_received_at_utc TEXT NOT NULL,
        last_received_at_utc TEXT NOT NULL,
        broker_delivery_count INTEGER NOT NULL DEFAULT 0,
        processed_at_utc TEXT,
        last_error TEXT,
        result_message_id TEXT,
        result_idempotency_key TEXT,
        result_payload_sha256 TEXT
      );

      CREATE INDEX IF NOT EXISTS idx_inbox_claim
        ON inbox (state, kind, first_received_at_utc);

      CREATE TABLE IF NOT EXISTS delivery_attempts (
        attempt_id TEXT PRIMARY KEY,
        direction TEXT NOT NULL CHECK (direction IN ('inbound', 'outbound')),
        message_id TEXT NOT NULL,
        attempt_number INTEGER NOT NULL,
        started_at_utc TEXT NOT NULL,
        finished_at_utc TEXT NOT NULL,
        outcome TEXT NOT NULL,
        error_code TEXT,
        error_detail TEXT
      );

      CREATE INDEX IF NOT EXISTS idx_delivery_attempt_message
        ON delivery_attempts (message_id, started_at_utc);

      CREATE TABLE IF NOT EXISTS runtime_state (
        component TEXT PRIMARY KEY,
        instance_id TEXT NOT NULL,
        status TEXT NOT NULL,
        heartbeat_at_utc TEXT NOT NULL,
        last_error TEXT
      );

      CREATE TABLE IF NOT EXISTS consultation_runs (
        request_message_id TEXT PRIMARY KEY,
        state TEXT NOT NULL CHECK (
          state IN (
            'pending_child',
            'needs_information',
            'waiting_peer',
            'completed',
            'failed'
          )
        ),
        version INTEGER NOT NULL,
        run_json TEXT NOT NULL,
        created_at_utc TEXT NOT NULL,
        updated_at_utc TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_consultation_runs_state
        ON consultation_runs (state, updated_at_utc);

      INSERT OR IGNORE INTO schema_migrations (version, applied_at_utc)
      VALUES (1, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));
    `);
    const migration = this.database.transaction(() => {
      this.ensureColumn("inbox", "result_message_id", "TEXT");
      this.ensureColumn("inbox", "result_idempotency_key", "TEXT");
      this.ensureColumn("inbox", "result_payload_sha256", "TEXT");
      this.database
        .prepare(
          `INSERT OR IGNORE INTO schema_migrations (version, applied_at_utc)
           VALUES (2, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))`,
        )
        .run();
    });
    migration.immediate();

    const coordinationMigration = this.database.transaction(() => {
      this.ensureColumn("inbox", "causation_id", "TEXT");
      const rows = this.database
        .prepare(
          `SELECT message_id, envelope_json
           FROM inbox WHERE causation_id IS NULL`,
        )
        .all() as Array<Pick<InboxRow, "message_id" | "envelope_json">>;
      const update = this.database.prepare(
        `UPDATE inbox SET causation_id = ? WHERE message_id = ?`,
      );
      for (const row of rows) {
        const envelope = parseEnvelope(JSON.parse(row.envelope_json));
        if (envelope.causation_id) {
          update.run(envelope.causation_id, row.message_id);
        }
      }
      this.database.exec(`
        CREATE INDEX IF NOT EXISTS idx_inbox_causation
          ON inbox (causation_id, first_received_at_utc);
      `);
      this.database
        .prepare(
          `INSERT OR IGNORE INTO schema_migrations (version, applied_at_utc)
           VALUES (3, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))`,
        )
        .run();
    });
    coordinationMigration.immediate();

    this.database
      .prepare(
        `INSERT OR IGNORE INTO schema_migrations (version, applied_at_utc)
         VALUES (4, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))`,
      )
      .run();

    const genericNodeMigration = this.database.transaction(() => {
      const alreadyApplied = this.database
        .prepare("SELECT 1 FROM schema_migrations WHERE version = 5")
        .get();
      if (alreadyApplied) {
        return;
      }
        this.database.exec(`
          DROP TABLE IF EXISTS outbox_v5;
          DROP TABLE IF EXISTS inbox_v5;

          CREATE TABLE outbox_v5 (
            message_id TEXT PRIMARY KEY,
            idempotency_key TEXT NOT NULL,
            target_system TEXT NOT NULL,
            kind TEXT NOT NULL,
            stream_id TEXT NOT NULL,
            payload_sha256 TEXT NOT NULL,
            envelope_json TEXT NOT NULL,
            state TEXT NOT NULL CHECK (
              state IN ('pending', 'leased', 'sent', 'quarantined', 'expired')
            ),
            attempt_count INTEGER NOT NULL DEFAULT 0,
            next_attempt_at_utc TEXT NOT NULL,
            lease_owner TEXT,
            lease_until_utc TEXT,
            created_at_utc TEXT NOT NULL,
            expires_at_utc TEXT,
            sent_at_utc TEXT,
            last_error_code TEXT,
            last_error TEXT,
            UNIQUE (target_system, idempotency_key)
          );

          INSERT INTO outbox_v5 (
            message_id,
            idempotency_key,
            target_system,
            kind,
            stream_id,
            payload_sha256,
            envelope_json,
            state,
            attempt_count,
            next_attempt_at_utc,
            lease_owner,
            lease_until_utc,
            created_at_utc,
            expires_at_utc,
            sent_at_utc,
            last_error_code,
            last_error
          )
          SELECT
            message_id,
            idempotency_key,
            target_system,
            kind,
            stream_id,
            payload_sha256,
            envelope_json,
            state,
            attempt_count,
            next_attempt_at_utc,
            lease_owner,
            lease_until_utc,
            created_at_utc,
            expires_at_utc,
            sent_at_utc,
            last_error_code,
            last_error
          FROM outbox;

          CREATE TABLE inbox_v5 (
            message_id TEXT PRIMARY KEY,
            origin_system TEXT NOT NULL,
            kind TEXT NOT NULL,
            stream_id TEXT NOT NULL,
            causation_id TEXT,
            payload_sha256 TEXT NOT NULL,
            envelope_json TEXT NOT NULL,
            state TEXT NOT NULL CHECK (
              state IN ('available', 'claimed', 'processed', 'rejected', 'quarantined')
            ),
            claim_owner TEXT,
            claim_token_hash TEXT,
            claim_until_utc TEXT,
            attempt_count INTEGER NOT NULL DEFAULT 0,
            first_received_at_utc TEXT NOT NULL,
            last_received_at_utc TEXT NOT NULL,
            broker_delivery_count INTEGER NOT NULL DEFAULT 0,
            processed_at_utc TEXT,
            last_error TEXT,
            result_message_id TEXT,
            result_idempotency_key TEXT,
            result_payload_sha256 TEXT
          );

          INSERT INTO inbox_v5 (
            message_id,
            origin_system,
            kind,
            stream_id,
            causation_id,
            payload_sha256,
            envelope_json,
            state,
            claim_owner,
            claim_token_hash,
            claim_until_utc,
            attempt_count,
            first_received_at_utc,
            last_received_at_utc,
            broker_delivery_count,
            processed_at_utc,
            last_error,
            result_message_id,
            result_idempotency_key,
            result_payload_sha256
          )
          SELECT
            message_id,
            origin_system,
            kind,
            stream_id,
            causation_id,
            payload_sha256,
            envelope_json,
            state,
            claim_owner,
            claim_token_hash,
            claim_until_utc,
            attempt_count,
            first_received_at_utc,
            last_received_at_utc,
            broker_delivery_count,
            processed_at_utc,
            last_error,
            result_message_id,
            result_idempotency_key,
            result_payload_sha256
          FROM inbox;

          DROP TABLE outbox;
          ALTER TABLE outbox_v5 RENAME TO outbox;
          CREATE INDEX idx_outbox_dispatch
            ON outbox (state, next_attempt_at_utc, created_at_utc);

          DROP TABLE inbox;
          ALTER TABLE inbox_v5 RENAME TO inbox;
          CREATE INDEX idx_inbox_claim
            ON inbox (state, kind, first_received_at_utc);
          CREATE INDEX idx_inbox_causation
            ON inbox (causation_id, first_received_at_utc);

          INSERT INTO schema_migrations (version, applied_at_utc)
          VALUES (5, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));
        `);
    });
    genericNodeMigration.immediate();

    const signedIngressMigration = this.database.transaction(() => {
      const alreadyApplied = this.database
        .prepare("SELECT 1 FROM schema_migrations WHERE version = 6")
        .get();
      if (alreadyApplied) {
        return;
      }
      this.database
        .prepare(
          `UPDATE inbox
           SET state = 'quarantined',
               claim_owner = NULL,
               claim_token_hash = NULL,
               claim_until_utc = NULL,
               last_error = ?
           WHERE state IN ('available', 'claimed')`,
        )
        .run("Pending inbox quarantined during signed-message migration");
      this.database
        .prepare(
          `INSERT INTO schema_migrations (version, applied_at_utc)
           VALUES (6, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))`,
        )
        .run();
    });
    signedIngressMigration.immediate();

    const ingressProvenanceMigration = this.database.transaction(() => {
      const alreadyApplied = this.database
        .prepare("SELECT 1 FROM schema_migrations WHERE version = 7")
        .get();
      if (alreadyApplied) {
        return;
      }
      this.database.exec(`
        ALTER TABLE inbox
          ADD COLUMN authenticated_ingress INTEGER NOT NULL DEFAULT 0
          CHECK (authenticated_ingress IN (0, 1));

        INSERT INTO schema_migrations (version, applied_at_utc)
        VALUES (7, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));
      `);
    });
    ingressProvenanceMigration.immediate();

    const resourceAuthorizationMigration = this.database.transaction(() => {
      const alreadyApplied = this.database
        .prepare("SELECT 1 FROM schema_migrations WHERE version = 8")
        .get();
      if (alreadyApplied) {
        return;
      }
      this.database.exec(`
        CREATE TABLE resources (
          resource_id TEXT PRIMARY KEY,
          enabled INTEGER NOT NULL DEFAULT 1
            CHECK (enabled IN (0, 1)),
          created_at_utc TEXT NOT NULL,
          updated_at_utc TEXT NOT NULL,
          CHECK (resource_id = lower(resource_id))
        );

        CREATE TABLE peer_resource_grants (
          peer_system_id TEXT NOT NULL,
          resource_id TEXT NOT NULL,
          state TEXT NOT NULL CHECK (state IN ('active', 'revoked')),
          granted_at_utc TEXT NOT NULL,
          revoked_at_utc TEXT,
          PRIMARY KEY (peer_system_id, resource_id),
          FOREIGN KEY (resource_id) REFERENCES resources(resource_id)
            ON UPDATE CASCADE ON DELETE RESTRICT,
          CHECK (
            (state = 'active' AND revoked_at_utc IS NULL) OR
            (state = 'revoked' AND revoked_at_utc IS NOT NULL)
          )
        );

        CREATE INDEX idx_peer_resource_grants_resource
          ON peer_resource_grants (resource_id, state, peer_system_id);

        INSERT INTO schema_migrations (version, applied_at_utc)
        VALUES (8, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));
      `);
    });
    resourceAuthorizationMigration.immediate();

    const approvalWorkflowMigration = this.database.transaction(() => {
      const alreadyApplied = this.database
        .prepare("SELECT 1 FROM schema_migrations WHERE version = 9")
        .get();
      if (alreadyApplied) {
        return;
      }
      this.database.exec(`
        CREATE TABLE authorization_requests (
          request_id TEXT PRIMARY KEY,
          request_identity TEXT NOT NULL UNIQUE,
          request_fingerprint TEXT NOT NULL,
          peer_system_id TEXT NOT NULL,
          resource_id TEXT NOT NULL,
          state TEXT NOT NULL CHECK (state IN (
            'pending', 'approved_once', 'approved_temporary',
            'denied', 'revoked', 'expired', 'consumed'
          )),
          requested_at_utc TEXT NOT NULL,
          decided_at_utc TEXT,
          decided_by TEXT,
          temporary_expires_at_utc TEXT,
          consumed_at_utc TEXT,
          reason TEXT,
          updated_at_utc TEXT NOT NULL,
          FOREIGN KEY (request_id) REFERENCES inbox(message_id)
            ON UPDATE RESTRICT ON DELETE RESTRICT,
          FOREIGN KEY (resource_id) REFERENCES resources(resource_id)
            ON UPDATE CASCADE ON DELETE RESTRICT,
          CHECK (
            (state = 'pending' AND decided_at_utc IS NULL AND decided_by IS NULL) OR
            (state <> 'pending' AND decided_at_utc IS NOT NULL AND decided_by IS NOT NULL)
          ),
          CHECK (
            (state = 'approved_temporary' AND temporary_expires_at_utc IS NOT NULL) OR
            (state <> 'approved_temporary')
          ),
          CHECK (
            (state = 'consumed' AND consumed_at_utc IS NOT NULL) OR
            (state <> 'consumed')
          )
        );

        CREATE INDEX idx_authorization_requests_pair_state
          ON authorization_requests (
            peer_system_id, resource_id, state, temporary_expires_at_utc
          );
        CREATE INDEX idx_authorization_requests_state_time
          ON authorization_requests (state, requested_at_utc, request_id);

        CREATE TABLE authorization_audit (
          event_id TEXT PRIMARY KEY,
          request_id TEXT NOT NULL,
          event TEXT NOT NULL CHECK (event IN (
            'requested', 'approved_once', 'approved_temporary', 'temporary_used',
            'denied', 'revoked', 'expired', 'consumed'
          )),
          state TEXT NOT NULL CHECK (state IN (
            'pending', 'approved_once', 'approved_temporary',
            'denied', 'revoked', 'expired', 'consumed'
          )),
          actor_id TEXT NOT NULL,
          peer_system_id TEXT NOT NULL,
          resource_id TEXT NOT NULL,
          occurred_at_utc TEXT NOT NULL,
          reason TEXT,
          FOREIGN KEY (request_id) REFERENCES authorization_requests(request_id)
            ON UPDATE RESTRICT ON DELETE RESTRICT,
          FOREIGN KEY (resource_id) REFERENCES resources(resource_id)
            ON UPDATE CASCADE ON DELETE RESTRICT
        );

        CREATE INDEX idx_authorization_audit_request_time
          ON authorization_audit (request_id, occurred_at_utc, event_id);
        CREATE INDEX idx_authorization_audit_pair_time
          ON authorization_audit (
            peer_system_id, resource_id, occurred_at_utc, event_id
          );

        CREATE TRIGGER authorization_audit_append_only_update
        BEFORE UPDATE ON authorization_audit
        BEGIN
          SELECT RAISE(ABORT, 'authorization audit is append-only');
        END;

        CREATE TRIGGER authorization_audit_append_only_delete
        BEFORE DELETE ON authorization_audit
        BEGIN
          SELECT RAISE(ABORT, 'authorization audit is append-only');
        END;

        INSERT INTO schema_migrations (version, applied_at_utc)
        VALUES (9, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));
      `);
    });
    approvalWorkflowMigration.immediate();
  }

  private assertSupportedSchemaVersion(): void {
    const migrationTableExists = this.database
      .prepare(
        "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'schema_migrations'",
      )
      .get();
    if (!migrationTableExists) {
      return;
    }
    const row = this.database
      .prepare("SELECT MAX(version) AS version FROM schema_migrations")
      .get() as { version: number | null };
    if (row.version !== null && row.version > CURRENT_SCHEMA_VERSION) {
      throw new StateTransitionError(
        `Database schema version ${row.version} is newer than supported version ${CURRENT_SCHEMA_VERSION}`,
      );
    }
  }

  public claimAutonomousConsultationInbox(
    consumerId: string,
    limit: number,
    leaseSeconds: number,
    now = new Date(),
  ): ClaimedInboxMessage[] {
    return this.claimInboxWhere(
      consumerId,
      limit,
      leaseSeconds,
      `AND kind = 'task_request'
       AND stream_id = 'agent-coordination'
       AND json_extract(envelope_json, '$.payload.coordination_request.protocol_version') = '1.0'
       AND json_extract(envelope_json, '$.payload.dispatch.executor') = 'codex_cli'
       AND json_extract(envelope_json, '$.payload.dispatch.access') = 'read_only'
       AND json_extract(envelope_json, '$.payload.dispatch.evidence_mode') = 'pinned_git'
       AND COALESCE(
         (
           SELECT json_extract(run_json, '$.next_attempt_at_utc')
           FROM consultation_runs
           WHERE request_message_id = inbox.message_id
         ),
         ''
       ) <= ?`,
      [now.toISOString()],
      now,
      true,
    );
  }

  private ensureColumn(
    table: "inbox",
    column: string,
    declaration: string,
  ): void {
    const columns = this.database
      .prepare(`PRAGMA table_info(${table})`)
      .all() as Array<{ name: string }>;
    if (columns.some((existing) => existing.name === column)) {
      return;
    }
    this.database.exec(
      `ALTER TABLE ${table} ADD COLUMN ${column} ${declaration}`,
    );
  }
}

function sameConsultationIdentity(
  left: ConsultationRun,
  right: ConsultationRun,
): boolean {
  return (
    left.request_message_id === right.request_message_id &&
    left.conversation_id === right.conversation_id &&
    left.root_request_id === right.root_request_id &&
    left.project === right.project &&
    left.depth === right.depth
  );
}

function sameIdempotentOperation(
  left: BridgeEnvelope,
  right: BridgeEnvelope,
  comparison: IdempotencyComparisonOptions,
): boolean {
  return (
    left.target_system === right.target_system &&
    left.kind === right.kind &&
    left.stream_id === right.stream_id &&
    left.payload_sha256 === right.payload_sha256 &&
    left.correlation_id === right.correlation_id &&
    left.causation_id === right.causation_id &&
    left.sequence_number === right.sequence_number &&
    (!comparison.matchConversationId ||
      left.conversation_id === right.conversation_id) &&
    (!comparison.matchExpiresAtUtc ||
      left.expires_at_utc === right.expires_at_utc)
  );
}

function sameInboundMessage(
  left: BridgeEnvelope,
  right: BridgeEnvelope,
): boolean {
  return (
    left.schema_version === right.schema_version &&
    left.message_id === right.message_id &&
    left.idempotency_key === right.idempotency_key &&
    left.origin_system === right.origin_system &&
    left.target_system === right.target_system &&
    left.kind === right.kind &&
    left.conversation_id === right.conversation_id &&
    left.correlation_id === right.correlation_id &&
    left.causation_id === right.causation_id &&
    left.stream_id === right.stream_id &&
    left.sequence_number === right.sequence_number &&
    left.created_at_utc === right.created_at_utc &&
    left.expires_at_utc === right.expires_at_utc &&
    left.payload_sha256 === right.payload_sha256
  );
}

function sameConversationRoute(
  envelope: BridgeEnvelope,
  first: SystemId,
  second: SystemId,
): boolean {
  return (
    (envelope.origin_system === first && envelope.target_system === second) ||
    (envelope.origin_system === second && envelope.target_system === first)
  );
}

function hashToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

function hashAuthorizationValue(parts: readonly string[]): string {
  const hash = createHash("sha256");
  for (const part of parts) {
    hash.update(part, "utf8");
    hash.update("\0", "utf8");
  }
  return hash.digest("hex");
}

function parseUtcInstant(value: string, name: string): Date {
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString() !== value) {
    throw new StateTransitionError(`${name} must be a canonical UTC timestamp`);
  }
  return parsed;
}

function parseAuthorizationReason(value?: string): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  const normalized = value.trim();
  if (normalized.length === 0 || normalized.length > 200) {
    throw new StateTransitionError(
      "Authorization reason must contain between 1 and 200 characters",
    );
  }
  if (/\r|\n/.test(normalized)) {
    throw new StateTransitionError(
      "Authorization reason must be a single line",
    );
  }
  return normalized;
}

function addSeconds(date: Date, seconds: number): Date {
  return new Date(date.getTime() + seconds * 1000);
}

function assertPositiveInteger(value: number, name: string): void {
  if (!Number.isInteger(value) || value <= 0) {
    throw new RangeError(`${name} must be a positive integer`);
  }
}

function assertNonEmpty(value: string, name: string): void {
  if (!value.trim()) {
    throw new RangeError(`${name} must not be empty`);
  }
}

function truncate(value: string, maximumLength: number): string {
  return value.length <= maximumLength
    ? value
    : `${value.slice(0, maximumLength - 3)}...`;
}

function countByState<T extends string>(
  database: Database.Database,
  table: "outbox" | "inbox" | "consultation_runs",
  states: readonly T[],
): Record<T, number> {
  const counts = Object.fromEntries(states.map((state) => [state, 0])) as Record<
    T,
    number
  >;
  const rows = database
    .prepare(`SELECT state, COUNT(*) AS count FROM ${table} GROUP BY state`)
    .all() as Array<{ state: T; count: number }>;
  for (const row of rows) {
    counts[row.state] = row.count;
  }
  return counts;
}

function effectiveRuntimeStatus(
  runtime: { status: string; heartbeat_at_utc: string },
  now: Date,
  staleAfterMs: number,
): { status: EffectiveRuntimeStatus; ageSeconds: number } {
  const heartbeatAt = Date.parse(runtime.heartbeat_at_utc);
  if (!Number.isFinite(heartbeatAt)) {
    return { status: "stale", ageSeconds: 0 };
  }
  const ageMs = Math.max(0, now.getTime() - heartbeatAt);
  return {
    status:
      ageMs > staleAfterMs
        ? "stale"
        : runtime.status === "healthy"
          ? "healthy"
          : "degraded",
    ageSeconds: Math.floor(ageMs / 1000),
  };
}
