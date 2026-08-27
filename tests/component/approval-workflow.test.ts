import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";

import { createEnvelope, type BridgeEnvelope } from "../../src/contracts/envelope.js";
import { BridgeDatabase } from "../../src/storage/database.js";

type ApprovalState =
  | "pending"
  | "approved_once"
  | "approved_temporary"
  | "denied"
  | "revoked"
  | "expired"
  | "consumed";

interface AuthorizationRequest {
  requestId: string;
  requestFingerprint: string;
  peerSystemId: "SYS-A" | "SYS-B";
  resourceId: string;
  state: ApprovalState;
  requestedAtUtc: string;
  temporaryExpiresAtUtc?: string;
  reason?: string;
}

interface AuthorizationAuditEvent {
  eventId: string;
  requestId: string;
  event: string;
  actorId: string;
  occurredAtUtc: string;
  peerSystemId: "SYS-A" | "SYS-B";
  resourceId: string;
  reason?: string;
}

interface ApprovalWorkflowDatabase {
  authorizeClaimedResourceAccess(input: {
    requestMessageId: string;
    consumerId: string;
    claimToken: string;
    resourceId: string;
    actorId: string;
    now?: Date;
  }):
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
  listAuthorizationRequests(input?: {
    state?: ApprovalState;
    now?: Date;
  }): AuthorizationRequest[];
  getAuthorizationRequest(
    requestId: string,
    now?: Date,
  ): AuthorizationRequest | undefined;
  approveAuthorizationRequestOnce(input: {
    requestId: string;
    actorId: string;
    now?: Date;
  }): AuthorizationRequest;
  approveAuthorizationRequestTemporary(input: {
    requestId: string;
    actorId: string;
    expiresAtUtc: string;
    now?: Date;
  }): AuthorizationRequest;
  denyAuthorizationRequest(input: {
    requestId: string;
    actorId: string;
    reason?: string;
    now?: Date;
  }): AuthorizationRequest;
  revokeAuthorizationRequest(input: {
    requestId: string;
    actorId: string;
    reason?: string;
    now?: Date;
  }): AuthorizationRequest;
  listAuthorizationAudit(input?: {
    requestId?: string;
    peerSystemId?: string;
    resourceId?: string;
  }): AuthorizationAuditEvent[];
}

const start = new Date("2026-08-27T12:00:00.000Z");
const openDatabases: BridgeDatabase[] = [];

describe("BridgeDatabase approval workflow", () => {
  const temporaryDirectories: string[] = [];

  afterEach(() => {
    for (const database of openDatabases.splice(0)) {
      database.close();
    }
    for (const directory of temporaryDirectories.splice(0)) {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  it("parks one pending request and rejects a new-message retry without duplicating approval state", () => {
    const database = openDatabase(":memory:");
    database.registerResource("voiceai", start);

    const original = claimRequest(database, request("same-operation"));
    const first = approvals(database).authorizeClaimedResourceAccess(
      accessInput(original),
    );
    expect(first).toEqual({
      status: "approval_pending",
      approvalRequestId: original.envelope.message_id,
    });
    expect(database.getInboxMessage(original.envelope.message_id)?.state).toBe(
      "quarantined",
    );

    const retry = claimRequest(database, request("same-operation"));
    expect(
      approvals(database).authorizeClaimedResourceAccess(accessInput(retry)),
    ).toEqual({
      status: "duplicate",
      approvalRequestId: original.envelope.message_id,
    });
    expect(approvals(database).listAuthorizationRequests()).toHaveLength(1);
  });

  it("creates no approval row for unauthenticated, unknown, disabled, or persistently authorized claims", () => {
    const database = openDatabase(":memory:");
    database.registerResource("voiceai", start);
    database.registerResource("disabled", start);
    database.setResourceEnabled("disabled", false, start);
    database.grantPeerResource("SYS-A", "voiceai", start);

    const cases = [
      claimRequest(database, request("unauthenticated"), false),
      claimRequest(database, request("unknown", "unknown")),
      claimRequest(database, request("disabled", "disabled")),
      claimRequest(database, request("persistent")),
    ];
    const decisions = cases.map((claim) =>
      approvals(database).authorizeClaimedResourceAccess(accessInput(claim)),
    );

    expect(decisions).toEqual([
      { status: "denied" },
      { status: "denied" },
      { status: "denied" },
      { status: "authorized", basis: "persistent_grant" },
    ]);
    expect(approvals(database).listAuthorizationRequests()).toEqual([]);
  });

  it("consumes approve-once atomically and rejects every later ordinary-dispatch retry", () => {
    const database = openDatabase(":memory:");
    database.registerResource("voiceai", start);
    const original = claimRequest(database, request("approve-once"));
    approvals(database).authorizeClaimedResourceAccess(accessInput(original));

    expect(
      approvals(database).approveAuthorizationRequestOnce({
        requestId: original.envelope.message_id,
        actorId: "SYS-B",
        now: start,
      }),
    ).toMatchObject({ state: "approved_once" });

    const approvedClaim = claimExisting(database, original.envelope.message_id);
    expect(
      approvals(database).authorizeClaimedResourceAccess(
        accessInput(approvedClaim, new Date("2026-08-27T12:00:01.000Z")),
      ),
    ).toEqual({
      status: "authorized",
      basis: "approve_once",
      approvalRequestId: original.envelope.message_id,
    });
    database.acknowledge(
      original.envelope.message_id,
      approvedClaim.consumerId,
      approvedClaim.claimToken,
      "retry",
      undefined,
      new Date("2026-08-27T12:00:02.000Z"),
    );

    const recoveryClaim = claimExisting(
      database,
      original.envelope.message_id,
      new Date("2026-08-27T12:00:03.000Z"),
    );
    expect(
      approvals(database).authorizeClaimedResourceAccess(
        accessInput(recoveryClaim, new Date("2026-08-27T12:00:03.000Z")),
      ),
    ).toEqual({
      status: "denied",
      approvalRequestId: original.envelope.message_id,
    });

    const replay = claimRequest(database, request("approve-once"));
    expect(
      approvals(database).authorizeClaimedResourceAccess(accessInput(replay)),
    ).toEqual({
      status: "duplicate",
      approvalRequestId: original.envelope.message_id,
    });
  });

  it("applies temporary access before strict UTC expiry and fails closed after expiry or revoke", () => {
    const database = openDatabase(":memory:");
    database.registerResource("voiceai", start);
    const source = claimRequest(database, request("temporary-source"));
    approvals(database).authorizeClaimedResourceAccess(accessInput(source));
    approvals(database).approveAuthorizationRequestTemporary({
      requestId: source.envelope.message_id,
      actorId: "SYS-B",
      expiresAtUtc: "2026-08-27T12:05:00.000Z",
      now: start,
    });

    const beforeExpiry = claimRequest(
      database,
      request("temporary-use"),
      true,
      new Date("2026-08-27T12:04:59.999Z"),
    );
    expect(
      approvals(database).authorizeClaimedResourceAccess(
        accessInput(beforeExpiry, new Date("2026-08-27T12:04:59.999Z")),
      ),
    ).toEqual({
      status: "authorized",
      basis: "temporary_approval",
      approvalRequestId: source.envelope.message_id,
    });
    expect(
      approvals(database)
        .listAuthorizationAudit({ requestId: source.envelope.message_id })
        .map((event) => event.event),
    ).toEqual(["requested", "approved_temporary", "temporary_used"]);

    const atExpiry = claimRequest(
      database,
      request("after-expiry"),
      true,
      new Date("2026-08-27T12:05:00.000Z"),
    );
    expect(
      approvals(database).authorizeClaimedResourceAccess(
        accessInput(atExpiry, new Date("2026-08-27T12:05:00.000Z")),
      ),
    ).toMatchObject({ status: "approval_pending" });

    const secondDatabase = openDatabase(":memory:");
    secondDatabase.registerResource("voiceai", start);
    const revokedSource = claimRequest(
      secondDatabase,
      request("revoked-source"),
    );
    approvals(secondDatabase).authorizeClaimedResourceAccess(
      accessInput(revokedSource),
    );
    approvals(secondDatabase).approveAuthorizationRequestTemporary({
      requestId: revokedSource.envelope.message_id,
      actorId: "SYS-B",
      expiresAtUtc: "2026-08-27T12:05:00.000Z",
      now: start,
    });
    approvals(secondDatabase).revokeAuthorizationRequest({
      requestId: revokedSource.envelope.message_id,
      actorId: "SYS-B",
      reason: "operator-revoked",
      now: new Date("2026-08-27T12:04:00.000Z"),
    });
    const afterRevoke = claimRequest(
      secondDatabase,
      request("after-revoke"),
      true,
      new Date("2026-08-27T12:04:01.000Z"),
    );
    expect(
      approvals(secondDatabase).authorizeClaimedResourceAccess(
        accessInput(afterRevoke, new Date("2026-08-27T12:04:01.000Z")),
      ),
    ).toMatchObject({ status: "approval_pending" });

    const grantDatabase = openDatabase(":memory:");
    grantDatabase.registerResource("voiceai", start);
    const grantSource = claimRequest(grantDatabase, request("grant-source"));
    approvals(grantDatabase).authorizeClaimedResourceAccess(
      accessInput(grantSource),
    );
    approvals(grantDatabase).approveAuthorizationRequestTemporary({
      requestId: grantSource.envelope.message_id,
      actorId: "SYS-B",
      expiresAtUtc: "2026-08-27T12:05:00.000Z",
      now: start,
    });
    grantDatabase.grantPeerResource("SYS-A", "voiceai", start);
    grantDatabase.revokePeerResource(
      "SYS-A",
      "voiceai",
      new Date("2026-08-27T12:04:00.000Z"),
      "SYS-B",
    );
    const afterPersistentRevoke = claimRequest(
      grantDatabase,
      request("after-persistent-revoke"),
      true,
      new Date("2026-08-27T12:04:01.000Z"),
    );
    expect(
      approvals(grantDatabase).authorizeClaimedResourceAccess(
        accessInput(
          afterPersistentRevoke,
          new Date("2026-08-27T12:04:01.000Z"),
        ),
      ),
    ).toMatchObject({ status: "approval_pending" });
  });

  it("persists denial across restart and enforces append-only metadata-only audit records", () => {
    const directory = fs.mkdtempSync(
      path.join(os.tmpdir(), "balcony-approval-workflow-"),
    );
    temporaryDirectories.push(directory);
    const databasePath = path.join(directory, "bridge.sqlite3");
    let database = openDatabase(databasePath);
    database.registerResource("voiceai", start);
    const deniedClaim = claimRequest(database, request("denied"));
    approvals(database).authorizeClaimedResourceAccess(accessInput(deniedClaim));
    approvals(database).denyAuthorizationRequest({
      requestId: deniedClaim.envelope.message_id,
      actorId: "SYS-B",
      reason: "policy-denied",
      now: start,
    });

    const beforeReopenAudit = approvals(database).listAuthorizationAudit({
      requestId: deniedClaim.envelope.message_id,
    });
    expect(beforeReopenAudit.map((event) => event.event)).toEqual([
      "requested",
      "denied",
    ]);
    expect(JSON.stringify(beforeReopenAudit)).not.toMatch(
      /body|payload|path|credential|claim_token/i,
    );

    database.close();
    openDatabases.splice(openDatabases.indexOf(database), 1);
    database = openDatabase(databasePath);
    expect(
      approvals(database).getAuthorizationRequest(
        deniedClaim.envelope.message_id,
      ),
    ).toMatchObject({ state: "denied", reason: "policy-denied" });

    database.close();
    openDatabases.splice(openDatabases.indexOf(database), 1);
    const raw = new Database(databasePath);
    expect(() =>
      raw.prepare(
        "UPDATE authorization_audit SET reason = 'changed' WHERE request_id = ?",
      ).run(deniedClaim.envelope.message_id),
    ).toThrow(/append-only/i);
    expect(() =>
      raw.prepare("DELETE FROM authorization_audit WHERE request_id = ?").run(
        deniedClaim.envelope.message_id,
      ),
    ).toThrow(/append-only/i);
    raw.close();
  });
});

function openDatabase(databasePath: string): BridgeDatabase {
  const database = new BridgeDatabase(databasePath);
  openDatabases.push(database);
  return database;
}

function approvals(database: BridgeDatabase): ApprovalWorkflowDatabase {
  return database as unknown as ApprovalWorkflowDatabase;
}

function request(idempotencyKey: string, resourceId = "voiceai"): BridgeEnvelope {
  return createEnvelope({
    idempotencyKey,
    originSystem: "SYS-A",
    targetSystem: "SYS-B",
    kind: "task_request",
    streamId: "approval-workflow",
    now: start,
    payload: {
      subject: "Inspect resource",
      body: "Sensitive request body must never enter approval metadata.",
      project: resourceId,
      evidence: [],
      dispatch: {
        executor: "codex_cli",
        access: "read_only",
        timeout_seconds: 120,
      },
    },
  });
}

function claimRequest(
  database: BridgeDatabase,
  envelope: BridgeEnvelope,
  authenticatedIngress = true,
  now = start,
) {
  database.persistIncoming(envelope, 1, now, authenticatedIngress);
  const claim = database.claimReadOnlyDispatchInbox(
    `dispatcher-${envelope.message_id}`,
    100,
    720,
    now,
  ).find((candidate) => candidate.envelope.message_id === envelope.message_id);
  expect(claim).toBeDefined();
  return {
    envelope,
    consumerId: `dispatcher-${envelope.message_id}`,
    claimToken: claim!.claimToken,
  };
}

function claimExisting(
  database: BridgeDatabase,
  requestMessageId: string,
  now = start,
) {
  const consumerId = `dispatcher-recovery-${requestMessageId}`;
  const claim = database.claimReadOnlyDispatchInbox(
    consumerId,
    10,
    720,
    now,
  ).find((candidate) => candidate.envelope.message_id === requestMessageId);
  expect(claim).toBeDefined();
  return {
    envelope: claim!.envelope,
    consumerId,
    claimToken: claim!.claimToken,
  };
}

function accessInput(
  claim: {
    envelope: BridgeEnvelope;
    consumerId: string;
    claimToken: string;
  },
  now = start,
) {
  return {
    requestMessageId: claim.envelope.message_id,
    consumerId: claim.consumerId,
    claimToken: claim.claimToken,
    resourceId: claim.envelope.payload.project!,
    actorId: "SYS-B",
    now,
  };
}
