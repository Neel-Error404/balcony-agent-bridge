import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";

import { createEnvelope, type BridgeEnvelope } from "../../src/contracts/envelope.js";
import { BridgeDatabase } from "../../src/storage/database.js";

describe("generic node database migration", () => {
  it("preserves queued legacy rows and removes the closed node constraints", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "bridge-node-migration-"));
    const databasePath = path.join(root, "bridge.sqlite3");
    const outgoing = envelope("legacy-outgoing", "SYS-A", "SYS-B");
    const incoming = envelope("legacy-incoming", "SYS-B", "SYS-A");
    createLegacyVersionFourDatabase(databasePath, outgoing, incoming);

    const migrated = new BridgeDatabase(databasePath);
    try {
      expect(migrated.getOutboxMessage(outgoing.message_id)?.envelope).toEqual(
        outgoing,
      );
      expect(migrated.getInboxMessage(incoming.message_id)?.envelope).toEqual(
        incoming,
      );
      expect(
        migrated.leaseOutbox(
          "migration-worker",
          1,
          30,
          new Date("2026-08-26T00:00:00.000Z"),
        ),
      ).toHaveLength(1);
      expect(
        migrated.claimInbox(
          "migration-consumer",
          1,
          30,
          undefined,
          new Date("2026-08-26T00:00:00.000Z"),
        ),
      ).toHaveLength(1);

      migrated.enqueueEnvelope(
        envelope("generic-outgoing", "review-node-01", "review-node-03"),
      );
    } finally {
      migrated.close();
    }

    const inspected = new Database(databasePath, { readonly: true });
    try {
      const tableSql = inspected
        .prepare(
          "SELECT name, sql FROM sqlite_master WHERE type = 'table' AND name IN ('inbox', 'outbox') ORDER BY name",
        )
        .all() as Array<{ name: string; sql: string }>;
      expect(tableSql).toHaveLength(2);
      expect(tableSql.map((row) => row.sql).join("\n")).not.toContain(
        "SYS-A",
      );

      const migration = inspected
        .prepare("SELECT COUNT(*) AS count FROM schema_migrations WHERE version = 5")
        .get() as { count: number };
      expect(migration.count).toBe(1);

      const indexes = inspected
        .prepare(
          "SELECT name FROM sqlite_master WHERE type = 'index' AND name LIKE 'idx_%'",
        )
        .all() as Array<{ name: string }>;
      expect(indexes.map((row) => row.name)).toEqual(
        expect.arrayContaining([
          "idx_outbox_dispatch",
          "idx_inbox_claim",
          "idx_inbox_causation",
        ]),
      );
    } finally {
      inspected.close();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});

function envelope(
  idempotencyKey: string,
  originSystem: string,
  targetSystem: string,
): BridgeEnvelope {
  return createEnvelope({
    idempotencyKey,
    originSystem,
    targetSystem,
    kind: "message",
    streamId: "migration-test",
    payload: {
      subject: "Migration preservation",
      body: "Preserve this durable row.",
      evidence: [],
    },
    now: new Date("2026-08-25T00:00:00.000Z"),
  });
}

function createLegacyVersionFourDatabase(
  databasePath: string,
  outgoing: BridgeEnvelope,
  incoming: BridgeEnvelope,
): void {
  const database = new Database(databasePath);
  try {
    database.exec(`
      CREATE TABLE schema_migrations (
        version INTEGER PRIMARY KEY,
        applied_at_utc TEXT NOT NULL
      );
      INSERT INTO schema_migrations (version, applied_at_utc)
      VALUES
        (1, '2026-08-25T00:00:00.000Z'),
        (2, '2026-08-25T00:00:00.000Z'),
        (3, '2026-08-25T00:00:00.000Z'),
        (4, '2026-08-25T00:00:00.000Z');

      CREATE TABLE outbox (
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
      CREATE INDEX idx_outbox_dispatch
        ON outbox (state, next_attempt_at_utc, created_at_utc);

      CREATE TABLE inbox (
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
      CREATE INDEX idx_inbox_claim
        ON inbox (state, kind, first_received_at_utc);
      CREATE INDEX idx_inbox_causation
        ON inbox (causation_id, first_received_at_utc);
    `);

    database
      .prepare(
        `INSERT INTO outbox (
          message_id, idempotency_key, target_system, kind, stream_id,
          payload_sha256, envelope_json, state, attempt_count,
          next_attempt_at_utc, created_at_utc
        ) VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', 0, ?, ?)`,
      )
      .run(
        outgoing.message_id,
        outgoing.idempotency_key,
        outgoing.target_system,
        outgoing.kind,
        outgoing.stream_id,
        outgoing.payload_sha256,
        JSON.stringify(outgoing),
        outgoing.created_at_utc,
        outgoing.created_at_utc,
      );
    database
      .prepare(
        `INSERT INTO inbox (
          message_id, origin_system, kind, stream_id, causation_id,
          payload_sha256, envelope_json, state, attempt_count,
          first_received_at_utc, last_received_at_utc, broker_delivery_count
        ) VALUES (?, ?, ?, ?, ?, ?, ?, 'available', 0, ?, ?, 1)`,
      )
      .run(
        incoming.message_id,
        incoming.origin_system,
        incoming.kind,
        incoming.stream_id,
        incoming.causation_id ?? null,
        incoming.payload_sha256,
        JSON.stringify(incoming),
        incoming.created_at_utc,
        incoming.created_at_utc,
      );
  } finally {
    database.close();
  }
}
