import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";

import { createEnvelope, type BridgeEnvelope } from "../../src/contracts/envelope.js";
import { BridgeDatabase } from "../../src/storage/database.js";

const start = new Date("2026-08-27T12:00:00.000Z");

describe("approval migration and multi-connection safety", () => {
  it("migrates a v8 database additively, preserving resources, grants, and inbox while starting approval state empty", () => {
    const root = temporaryDirectory();
    const databasePath = path.join(root, "bridge.sqlite3");
    const message = request("v8-preserved-inbox");
    createVersionEightFixture(databasePath, message);

    const migrated = new BridgeDatabase(databasePath);
    try {
      expect(migrated.listResources()).toMatchObject([{ resourceId: "voiceai", enabled: true }]);
      expect(migrated.listPeerResourceGrants("SYS-A")).toMatchObject([{ peerSystemId: "SYS-A", resourceId: "voiceai", state: "active" }]);
      expect(migrated.getInboxMessage(message.message_id)).toMatchObject({ envelope: message, state: "available", authenticatedIngress: true });
      expect(migrated.listAuthorizationRequests()).toEqual([]);
      expect(migrated.listAuthorizationAudit()).toEqual([]);
    } finally {
      migrated.close();
    }

    const inspected = new Database(databasePath, { readonly: true });
    try {
      expect(inspected.prepare("SELECT COUNT(*) AS count FROM schema_migrations WHERE version = 9").get()).toEqual({ count: 1 });
    } finally {
      inspected.close();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("leaves one durable winner when separate file-backed connections race to decide a pending request", () => {
    const root = temporaryDirectory();
    const databasePath = path.join(root, "bridge.sqlite3");
    const first = new BridgeDatabase(databasePath);
    const second = new BridgeDatabase(databasePath);
    try {
      first.registerResource("voiceai", start);
      const claim = claimRequest(first, request("decision-race"));
      authorize(first, claim);

      const approved = first.approveAuthorizationRequestOnce({
        requestId: claim.envelope.message_id,
        actorId: "SYS-B",
        now: start,
      });
      expect(approved).toMatchObject({ state: "approved_once" });
      expect(() => second.denyAuthorizationRequest({
        requestId: claim.envelope.message_id,
        actorId: "SYS-B",
        now: new Date("2026-08-27T12:00:00.001Z"),
      })).toThrow(/pending|changed concurrently/i);

      expect(second.getAuthorizationRequest(claim.envelope.message_id)).toMatchObject({ state: "approved_once" });
      expect(second.listAuthorizationAudit({ requestId: claim.envelope.message_id }).map((event) => event.event)).toEqual([
        "requested",
        "approved_once",
      ]);
    } finally {
      second.close();
      first.close();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});

function createVersionEightFixture(databasePath: string, message: BridgeEnvelope): void {
  const current = new BridgeDatabase(databasePath);
  try {
    current.registerResource("voiceai", start);
    current.grantPeerResource("SYS-A", "voiceai", start);
    current.persistIncoming(message, 1, start, true);
  } finally {
    current.close();
  }
  const raw = new Database(databasePath);
  try {
    raw.exec(`
      DROP TABLE authorization_audit;
      DROP TABLE authorization_requests;
      DELETE FROM schema_migrations WHERE version = 9;
    `);
  } finally {
    raw.close();
  }
}

function temporaryDirectory(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "balcony-approval-integration-"));
}

function request(idempotencyKey: string): BridgeEnvelope {
  return createEnvelope({
    idempotencyKey,
    originSystem: "SYS-A",
    targetSystem: "SYS-B",
    kind: "task_request",
    streamId: "approval-integration",
    now: start,
    payload: {
      subject: "Durable approval request",
      body: "This body must never appear in authorization state.",
      project: "voiceai",
      evidence: [],
      dispatch: { executor: "codex_cli", access: "read_only" },
    },
  });
}

function claimRequest(database: BridgeDatabase, envelope: BridgeEnvelope) {
  database.persistIncoming(envelope, 1, start, true);
  const consumerId = `integration-${envelope.message_id}`;
  const claim = database.claimReadOnlyDispatchInbox(consumerId, 1, 720, start)[0];
  expect(claim).toBeDefined();
  return { envelope, consumerId, claimToken: claim!.claimToken };
}

function authorize(
  database: BridgeDatabase,
  claim: { envelope: BridgeEnvelope; consumerId: string; claimToken: string },
) {
  return database.authorizeClaimedResourceAccess({
    requestMessageId: claim.envelope.message_id,
    consumerId: claim.consumerId,
    claimToken: claim.claimToken,
    resourceId: "voiceai",
    actorId: "SYS-B",
    now: start,
  });
}
