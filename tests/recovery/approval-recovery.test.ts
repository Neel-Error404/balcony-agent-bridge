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

  it("rejects both the consumed original and a different-message approve-once replay after restart", () => {
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
        status: "denied",
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
});

function temporaryDirectory(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "balcony-approval-recovery-"));
}

function request(idempotencyKey: string): BridgeEnvelope {
  return createEnvelope({
    idempotencyKey,
    originSystem: "SYS-A",
    targetSystem: "SYS-B",
    kind: "task_request",
    streamId: "approval-recovery",
    now: start,
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
