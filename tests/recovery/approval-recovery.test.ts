import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { createEnvelope, type BridgeEnvelope } from "../../src/contracts/envelope.js";
import { BridgeDatabase } from "../../src/storage/database.js";

const start = new Date("2026-08-27T12:00:00.000Z");

describe("approval workflow recovery", () => {
  it("preserves a pending request and its later decision across file-backed restarts", () => {
    const root = temporaryDirectory();
    const databasePath = path.join(root, "bridge.sqlite3");
    const original = new BridgeDatabase(databasePath);
    try {
      original.registerResource("voiceai", start);
      const claim = claimRequest(original, request("restart-pending"));
      expect(authorize(original, claim)).toMatchObject({
        status: "approval_pending",
        approvalRequestId: claim.envelope.message_id,
      });
    } finally {
      original.close();
    }

    const afterPendingRestart = new BridgeDatabase(databasePath);
    try {
      const requestId = afterPendingRestart.listAuthorizationRequests()[0]!.requestId;
      expect(afterPendingRestart.getAuthorizationRequest(requestId)).toMatchObject({
        state: "pending",
        resourceId: "voiceai",
      });
      expect(afterPendingRestart.listAuthorizationAudit({ requestId }).map((event) => event.event)).toEqual(["requested"]);
      afterPendingRestart.approveAuthorizationRequestTemporary({
        requestId,
        actorId: "SYS-B",
        expiresAtUtc: "2026-08-27T12:05:00.000Z",
        now: start,
      });
    } finally {
      afterPendingRestart.close();
    }

    const afterDecisionRestart = new BridgeDatabase(databasePath);
    try {
      const [approval] = afterDecisionRestart.listAuthorizationRequests({
        now: new Date("2026-08-27T12:01:00.000Z"),
      });
      expect(approval).toMatchObject({
        state: "approved_temporary",
        temporaryExpiresAtUtc: "2026-08-27T12:05:00.000Z",
      });
      expect(afterDecisionRestart.listAuthorizationAudit({ requestId: approval!.requestId }).map((event) => event.event)).toEqual([
        "requested",
        "approved_temporary",
      ]);
    } finally {
      afterDecisionRestart.close();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("expires temporary approval at the strict UTC boundary after reopen without relying on timers", () => {
    const root = temporaryDirectory();
    const databasePath = path.join(root, "bridge.sqlite3");
    const original = new BridgeDatabase(databasePath);
    let requestId: string;
    try {
      original.registerResource("voiceai", start);
      const source = claimRequest(original, request("temporary-restart-source"));
      authorize(original, source);
      requestId = source.envelope.message_id;
      original.approveAuthorizationRequestTemporary({
        requestId,
        actorId: "SYS-B",
        expiresAtUtc: "2026-08-27T12:05:00.000Z",
        now: start,
      });
    } finally {
      original.close();
    }

    const reopened = new BridgeDatabase(databasePath);
    try {
      const atExpiry = claimRequest(
        reopened,
        request("temporary-restart-use"),
        new Date("2026-08-27T12:05:00.000Z"),
      );
      expect(authorize(reopened, atExpiry, new Date("2026-08-27T12:05:00.000Z"))).toMatchObject({
        status: "approval_pending",
      });
      expect(reopened.getAuthorizationRequest(requestId!, new Date("2026-08-27T12:05:00.000Z"))).toMatchObject({ state: "expired" });
      expect(reopened.listAuthorizationAudit({ requestId: requestId! }).map((event) => event.event)).toEqual([
        "requested",
        "approved_temporary",
        "expired",
      ]);
    } finally {
      reopened.close();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("recovers the exact consumed original after restart but rejects a different-message approve-once replay", () => {
    const root = temporaryDirectory();
    const databasePath = path.join(root, "bridge.sqlite3");
    const original = new BridgeDatabase(databasePath);
    const envelope = request("approve-once-restart");
    try {
      original.registerResource("voiceai", start);
      const initialClaim = claimRequest(original, envelope);
      authorize(original, initialClaim);
      original.approveAuthorizationRequestOnce({
        requestId: envelope.message_id,
        actorId: "SYS-B",
        now: start,
      });
    } finally {
      original.close();
    }

    const reopened = new BridgeDatabase(databasePath);
    try {
      const useClaim = claimExisting(reopened, envelope.message_id, new Date("2026-08-27T12:00:01.000Z"));
      expect(authorize(reopened, useClaim, new Date("2026-08-27T12:00:01.000Z"))).toEqual({
        status: "authorized",
        basis: "approve_once",
        approvalRequestId: envelope.message_id,
      });
      reopened.acknowledge(envelope.message_id, useClaim.consumerId, useClaim.claimToken, "retry", undefined, new Date("2026-08-27T12:00:02.000Z"));

      const recoveryClaim = claimExisting(reopened, envelope.message_id, new Date("2026-08-27T12:00:03.000Z"));
      expect(authorize(reopened, recoveryClaim, new Date("2026-08-27T12:00:03.000Z"))).toEqual({
        status: "authorized",
        basis: "same_request_recovery",
        approvalRequestId: envelope.message_id,
      });

      const replay = claimRequest(reopened, request("approve-once-restart"), new Date("2026-08-27T12:00:04.000Z"));
      expect(authorize(reopened, replay, new Date("2026-08-27T12:00:04.000Z"))).toEqual({
        status: "duplicate",
        approvalRequestId: envelope.message_id,
      });
    } finally {
      reopened.close();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("fails closed when the consumed reservation is revoked or the resource is disabled", () => {
    const database = new BridgeDatabase(":memory:");
    try {
      database.registerResource("voiceai", start);
      const envelope = request("revoke-consumed");
      const initialClaim = claimRequest(database, envelope);
      authorize(database, initialClaim);
      database.approveAuthorizationRequestOnce({
        requestId: envelope.message_id,
        actorId: "SYS-B",
        now: start,
      });
      const useClaim = claimExisting(database, envelope.message_id, new Date("2026-08-27T12:00:01.000Z"));
      expect(authorize(database, useClaim, new Date("2026-08-27T12:00:01.000Z"))).toMatchObject({
        status: "authorized",
        basis: "approve_once",
      });
      database.acknowledge(envelope.message_id, useClaim.consumerId, useClaim.claimToken, "retry", undefined, new Date("2026-08-27T12:00:02.000Z"));
      database.revokeAuthorizationRequest({
        requestId: envelope.message_id,
        actorId: "SYS-B",
        reason: "operator-revoked",
        now: new Date("2026-08-27T12:00:03.000Z"),
      });
      database.grantPeerResource("SYS-A", "voiceai", new Date("2026-08-27T12:00:03.500Z"));
      const revokedClaim = claimExisting(database, envelope.message_id, new Date("2026-08-27T12:00:04.000Z"));
      expect(authorize(database, revokedClaim, new Date("2026-08-27T12:00:04.000Z"))).toMatchObject({
        status: "denied",
        approvalRequestId: envelope.message_id,
      });
      database.setResourceEnabled("voiceai", false, new Date("2026-08-27T12:00:05.000Z"));
      expect(authorize(database, revokedClaim, new Date("2026-08-27T12:00:05.000Z"))).toMatchObject({
        status: "denied",
      });
    } finally {
      database.close();
    }
  });

  it("does not consume an approve-once decision for an already expired request", () => {
    const database = new BridgeDatabase(":memory:");
    try {
      database.registerResource("voiceai", start);
      const envelope = request("expired-approve-once", "2026-08-27T12:00:05.000Z");
      const initialClaim = claimRequest(database, envelope);
      authorize(database, initialClaim);
      database.approveAuthorizationRequestOnce({
        requestId: envelope.message_id,
        actorId: "SYS-B",
        now: start,
      });
      const useClaim = claimExisting(database, envelope.message_id, new Date("2026-08-27T12:00:01.000Z"));
      expect(authorize(database, useClaim, new Date("2026-08-27T12:00:05.000Z"))).toMatchObject({
        status: "denied",
        approvalRequestId: envelope.message_id,
      });
      expect(database.getAuthorizationRequest(envelope.message_id)?.state).toBe("approved_once");
    } finally {
      database.close();
    }
  });

  it.each(["persistent", "temporary"] as const)(
    "denies a %s grant when a claim was acquired before request expiry but authorization runs at expiry",
    (basis) => {
      const database = new BridgeDatabase(":memory:");
      try {
        database.registerResource("voiceai", start);
        if (basis === "persistent") {
          database.grantPeerResource("SYS-A", "voiceai", start);
        } else {
          const source = claimRequest(database, request("temporary-expiry-source"));
          authorize(database, source);
          database.approveAuthorizationRequestTemporary({
            requestId: source.envelope.message_id,
            actorId: "SYS-B",
            expiresAtUtc: "2026-08-27T12:01:00.000Z",
            now: start,
          });
        }
        const envelope = request(`${basis}-claim-before-expiry`, "2026-08-27T12:00:05.000Z");
        const claim = claimRequest(database, envelope, new Date("2026-08-27T12:00:01.000Z"));
        expect(authorize(database, claim, new Date("2026-08-27T12:00:05.000Z"))).toMatchObject({
          status: "denied",
        });
        expect(database.getAuthorizationRequest(envelope.message_id)).toBeUndefined();
      } finally {
        database.close();
      }
    },
  );

  it("only settles a persisted exact-request result after expiry instead of starting a new worker", () => {
    const database = new BridgeDatabase(":memory:");
    try {
      database.registerResource("voiceai", start);
      const envelope = request("result-after-expiry", "2026-08-27T12:00:05.000Z");
      const initialClaim = claimRequest(database, envelope);
      authorize(database, initialClaim);
      database.approveAuthorizationRequestOnce({
        requestId: envelope.message_id,
        actorId: "SYS-B",
        now: start,
      });
      const useClaim = claimExisting(database, envelope.message_id, new Date("2026-08-27T12:00:01.000Z"));
      expect(authorize(database, useClaim, new Date("2026-08-27T12:00:01.000Z"))).toMatchObject({
        status: "authorized",
        basis: "approve_once",
      });
      database.acknowledge(envelope.message_id, useClaim.consumerId, useClaim.claimToken, "retry", undefined, new Date("2026-08-27T12:00:02.000Z"));
      const recoveryClaim = claimExisting(database, envelope.message_id, new Date("2026-08-27T12:00:03.000Z"));
      const reply = createEnvelope({
        idempotencyKey: `read-only-result:${envelope.message_id}`,
        originSystem: "SYS-B",
        targetSystem: "SYS-A",
        kind: "task_result",
        streamId: envelope.stream_id,
        conversationId: envelope.conversation_id,
        causationId: envelope.message_id,
        now: new Date("2026-08-27T12:00:03.000Z"),
        payload: {
          subject: "Already completed",
          body: "Stored authoritative answer.",
          project: "voiceai",
          evidence: [],
        },
      });
      database.enqueueEnvelope(reply);
      expect(authorize(database, recoveryClaim, new Date("2026-08-27T12:00:05.000Z"))).toMatchObject({
        status: "authorized",
        basis: "same_request_recovery",
      });
      expect(database.settleInboxWithReply({
        messageId: envelope.message_id,
        consumerId: recoveryClaim.consumerId,
        claimToken: recoveryClaim.claimToken,
        outcome: "processed",
        replyEnvelope: reply,
        now: new Date("2026-08-27T12:00:05.000Z"),
      })).toMatchObject({
        inboxState: "processed",
        reply: { duplicate: true, messageId: reply.message_id },
      });
    } finally {
      database.close();
    }
  });
});

function temporaryDirectory(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "balcony-approval-recovery-"));
}

function request(idempotencyKey: string, expiresAtUtc?: string): BridgeEnvelope {
  return createEnvelope({
    idempotencyKey,
    originSystem: "SYS-A",
    targetSystem: "SYS-B",
    kind: "task_request",
    streamId: "approval-recovery",
    now: start,
    ...(expiresAtUtc ? { expiresAtUtc } : {}),
    payload: {
      subject: "Restart-safe resource request",
      body: "Approval metadata must not retain this body.",
      project: "voiceai",
      evidence: [],
      dispatch: { executor: "codex_cli", access: "read_only" },
    },
  });
}

function claimRequest(database: BridgeDatabase, envelope: BridgeEnvelope, now = start) {
  database.persistIncoming(envelope, 1, now, true);
  return claimExisting(database, envelope.message_id, now);
}

function claimExisting(database: BridgeDatabase, messageId: string, now = start) {
  const consumerId = `recovery-${messageId}`;
  const claim = database.claimReadOnlyDispatchInbox(consumerId, 10, 720, now)
    .find((candidate) => candidate.envelope.message_id === messageId);
  expect(claim).toBeDefined();
  return { envelope: claim!.envelope, consumerId, claimToken: claim!.claimToken };
}

function authorize(
  database: BridgeDatabase,
  claim: { envelope: BridgeEnvelope; consumerId: string; claimToken: string },
  now = start,
) {
  return database.authorizeClaimedResourceAccess({
    requestMessageId: claim.envelope.message_id,
    consumerId: claim.consumerId,
    claimToken: claim.claimToken,
    resourceId: "voiceai",
    actorId: "SYS-B",
    now,
  });
}
