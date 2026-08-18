import { createHash, randomBytes, randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import Database from "better-sqlite3";

import {
  parseEnvelope,
  type BridgeEnvelope,
  type MessageKind,
  type SystemId,
} from "../contracts/envelope.js";
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
import { normalizeErrorCode } from "../security/sanitize-error.js";

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
}

export interface EnqueueResult {
  messageId: string;
  state: OutboxState;
  duplicate: boolean;
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
}

export interface InboxListItem {
  envelope: BridgeEnvelope;
  state: InboxState;
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

export interface BridgeStatus {
  outbox: Record<OutboxState, number>;
  inbox: Record<InboxState, number>;
  consultation: Record<ConsultationRunState, number>;
  oldestPendingCreatedAtUtc?: string;
  bridgeHeartbeatAtUtc?: string;
  bridgeRuntimeStatus?: string;
  lastTransportErrorCode?: string;
  dispatcherHeartbeatAtUtc?: string;
  dispatcherRuntimeStatus?: string;
  lastDispatcherErrorCode?: string;
  consultationCoordinatorHeartbeatAtUtc?: string;
  consultationCoordinatorRuntimeStatus?: string;
  lastConsultationCoordinatorErrorCode?: string;
}

export class BridgeDatabase {
  private readonly database: Database.Database;

  public constructor(databasePath: string) {
    if (databasePath !== ":memory:") {
      fs.mkdirSync(path.dirname(databasePath), { recursive: true });
    }

    this.database = new Database(databasePath);
    this.database.pragma("journal_mode = WAL");
    this.database.pragma("foreign_keys = ON");
    this.database.pragma("synchronous = FULL");
    this.database.pragma("busy_timeout = 5000");
    this.migrate();
  }

  public getInboxMessage(messageId: string): InboxListItem | undefined {
    const row = this.database
      .prepare(
        `SELECT message_id, envelope_json, payload_sha256, state,
                claim_owner, claim_token_hash, claim_until_utc
         FROM inbox WHERE message_id = ?`,
      )
      .get(messageId) as InboxRow | undefined;
    if (!row) {
      return undefined;
    }
    return {
      envelope: parseEnvelope(JSON.parse(row.envelope_json)),
      state: row.state,
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
         WHERE json_extract(envelope_json, '$.conversation_id') = ?`,
      )
      .all(conversationId) as Array<{
      envelope_json: string;
      state: InboxState;
    }>;
    return [
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
    ]
      .sort((left, right) => {
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
      })
      .slice(-limit);
  }

  public findInboxReplyTo(
    requestMessageId: string,
  ): InboxListItem | undefined {
    const row = this.database
      .prepare(
        `SELECT message_id, envelope_json, payload_sha256, state,
                claim_owner, claim_token_hash, claim_until_utc
         FROM inbox
         WHERE causation_id = ? AND kind = 'task_result'
         ORDER BY first_received_at_utc, message_id
         LIMIT 1`,
      )
      .get(requestMessageId) as InboxRow | undefined;
    if (!row) {
      return undefined;
    }
    return {
      envelope: parseEnvelope(JSON.parse(row.envelope_json)),
      state: row.state,
      ...(row.claim_owner ? { claimOwner: row.claim_owner } : {}),
      ...(row.claim_until_utc ? { claimUntilUtc: row.claim_until_utc } : {}),
    };
  }

  public close(): void {
    this.database.close();
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

  public enqueueEnvelope(envelopeValue: unknown): EnqueueResult {
    const envelope = parseEnvelope(envelopeValue);
    const transaction = this.database.transaction(() =>
      this.enqueueEnvelopeRow(envelope),
    );
    return transaction();
  }

  private enqueueEnvelopeRow(
    envelope: BridgeEnvelope,
  ): EnqueueResult {
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
      if (!sameIdempotentOperation(prior, envelope)) {
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
  ): PersistIncomingResult {
    const envelope = parseEnvelope(envelopeValue);
    const nowUtc = now.toISOString();

    const transaction = this.database.transaction((): PersistIncomingResult => {
      const existing = this.database
        .prepare(
          `SELECT message_id, envelope_json, payload_sha256, state,
                  claim_owner, claim_token_hash, claim_until_utc
           FROM inbox WHERE message_id = ?`,
        )
        .get(envelope.message_id) as InboxRow | undefined;

      if (existing) {
        if (existing.payload_sha256 !== envelope.payload_sha256) {
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
              "Message identity collision: payload hash changed",
              envelope.message_id,
            );
          return { status: "collision", messageId: envelope.message_id };
        }

        this.database
          .prepare(
            `UPDATE inbox
             SET last_received_at_utc = ?,
                 broker_delivery_count = MAX(broker_delivery_count, ?)
             WHERE message_id = ?`,
          )
          .run(nowUtc, brokerDeliveryCount, envelope.message_id);
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
            broker_delivery_count
          ) VALUES (?, ?, ?, ?, ?, ?, ?, 'available', 0, ?, ?, ?)`,
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
                claim_owner, claim_token_hash, claim_until_utc
         FROM inbox
         WHERE state IN (${placeholders})
         ORDER BY first_received_at_utc, message_id
         LIMIT ?`,
      )
      .all(...states, limit) as InboxRow[];

    return rows.map((row) => ({
      envelope: parseEnvelope(JSON.parse(row.envelope_json)),
      state: row.state,
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
  ): ClaimedInboxMessage[] {
    return this.claimInboxWhere(
      consumerId,
      limit,
      leaseSeconds,
      `AND kind = 'task_request'
       AND json_extract(envelope_json, '$.payload.dispatch.executor') = 'codex_cli'
       AND json_extract(envelope_json, '$.payload.dispatch.access') = 'read_only'
       AND json_extract(envelope_json, '$.payload.dispatch.evidence_mode') IS NULL`,
      [],
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
                  claim_owner, claim_token_hash, claim_until_utc
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

  public getStatus(): BridgeStatus {
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

    return {
      outbox,
      inbox,
      consultation,
      ...(oldest.created_at_utc
        ? { oldestPendingCreatedAtUtc: oldest.created_at_utc }
        : {}),
      ...(runtime
        ? {
            bridgeHeartbeatAtUtc: runtime.heartbeat_at_utc,
            bridgeRuntimeStatus: runtime.status,
            ...(runtime.last_error
              ? { lastTransportErrorCode: runtime.last_error }
              : {}),
          }
        : {}),
      ...(dispatcherRuntime
        ? {
            dispatcherHeartbeatAtUtc:
              dispatcherRuntime.heartbeat_at_utc,
            dispatcherRuntimeStatus: dispatcherRuntime.status,
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
): boolean {
  return (
    left.target_system === right.target_system &&
    left.kind === right.kind &&
    left.stream_id === right.stream_id &&
    left.payload_sha256 === right.payload_sha256
  );
}

function hashToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
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
