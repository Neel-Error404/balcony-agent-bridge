import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  createEnvelope,
  hashPayload,
} from "../../src/contracts/envelope.js";
import { BridgeDatabase } from "../../src/storage/database.js";

describe("BridgeDatabase", () => {
  let database: BridgeDatabase;

  beforeEach(() => {
    database = new BridgeDatabase(":memory:");
  });

  afterEach(() => {
    database.close();
  });

  it("enqueues idempotently and rejects conflicting reuse", () => {
    const original = envelope("same-key", "Original body");
    const duplicate = envelope("same-key", "Original body");
    const conflicting = envelope("same-key", "Different body");

    const first = database.enqueueEnvelope(original);
    const second = database.enqueueEnvelope(duplicate);

    expect(first.duplicate).toBe(false);
    expect(second).toEqual({
      messageId: first.messageId,
      state: "pending",
      duplicate: true,
    });
    expect(() => database.enqueueEnvelope(conflicting)).toThrow(
      /IDEMPOTENCY_CONFLICT|different message content/,
    );
  });

  it("leases, releases, reclaims, and settles outbox messages", () => {
    const message = envelope("lease-key", "Lease me");
    database.enqueueEnvelope(message);
    const start = new Date("2026-08-13T12:00:00.000Z");

    const firstLease = database.leaseOutbox("worker-1", 1, 30, start);
    expect(firstLease).toHaveLength(1);
    expect(database.leaseOutbox("worker-2", 1, 30, start)).toHaveLength(0);

    database.releaseOutboxLease(
      message.message_id,
      "worker-1",
      new Date("2026-08-13T12:00:10.000Z"),
      "TEMPORARY",
    );
    expect(
      database.leaseOutbox(
        "worker-2",
        1,
        30,
        new Date("2026-08-13T12:00:09.000Z"),
      ),
    ).toHaveLength(0);

    const secondLease = database.leaseOutbox(
      "worker-2",
      1,
      30,
      new Date("2026-08-13T12:00:10.000Z"),
    );
    expect(secondLease).toHaveLength(1);
    database.markOutboxSent(
      message.message_id,
      "worker-2",
      new Date("2026-08-13T12:00:11.000Z"),
    );
    expect(database.getStatus().outbox.sent).toBe(1);
  });

  it("persists inbound messages idempotently and quarantines collisions", () => {
    const original = envelope("incoming", "Expected");
    expect(database.persistIncoming(original, 1).status).toBe("inserted");
    expect(database.persistIncoming(original, 2).status).toBe("duplicate");

    const changedPayload = { ...original.payload, body: "Changed" };
    const collision = {
      ...original,
      payload: changedPayload,
      payload_sha256: hashPayload(changedPayload),
    };
    expect(database.persistIncoming(collision, 3).status).toBe("collision");
    expect(database.getStatus().inbox.quarantined).toBe(1);
  });

  it("claims, renews, retries, and completes inbox messages atomically", () => {
    const message = envelope("claim", "Claim me");
    const start = new Date("2026-08-13T12:00:00.000Z");
    database.persistIncoming(message, 1, start);

    const claims = database.claimInbox("agent-1", 1, 30, undefined, start);
    expect(claims).toHaveLength(1);
    expect(database.claimInbox("agent-2", 1, 30, undefined, start)).toHaveLength(
      0,
    );

    const claim = claims[0]!;
    const renewedUntil = database.renewClaim(
      message.message_id,
      "agent-1",
      claim.claimToken,
      60,
      new Date("2026-08-13T12:00:10.000Z"),
    );
    expect(renewedUntil).toBe("2026-08-13T12:01:10.000Z");

    expect(
      database.acknowledge(
        message.message_id,
        "agent-1",
        claim.claimToken,
        "retry",
        "Needs another pass",
        new Date("2026-08-13T12:00:20.000Z"),
      ),
    ).toBe("available");

    const nextClaim = database.claimInbox(
      "agent-2",
      1,
      30,
      undefined,
      new Date("2026-08-13T12:00:21.000Z"),
    )[0]!;
    expect(
      database.acknowledge(
        message.message_id,
        "agent-2",
        nextClaim.claimToken,
        "processed",
        undefined,
        new Date("2026-08-13T12:00:22.000Z"),
      ),
    ).toBe("processed");
    expect(database.getStatus().inbox.processed).toBe(1);
  });

  it("reclaims an expired inbox claim after a consumer crash", () => {
    const message = envelope("crash", "Recover me");
    const start = new Date("2026-08-13T12:00:00.000Z");
    database.persistIncoming(message, 1, start);
    database.claimInbox("crashed-agent", 1, 15, undefined, start);

    const recovered = database.claimInbox(
      "recovery-agent",
      1,
      30,
      undefined,
      new Date("2026-08-13T12:00:16.000Z"),
    );
    expect(recovered).toHaveLength(1);
    expect(recovered[0]!.envelope.message_id).toBe(message.message_id);
  });

  it("applies kind filters to messages without expiration timestamps", () => {
    const task = envelope("task-kind", "Task");
    const status = createEnvelope({
      idempotencyKey: "status-kind",
      originSystem: "SYS-A",
      targetSystem: "SYS-B",
      kind: "status",
      streamId: "database-tests",
      payload: {
        subject: "Status",
        body: "Ready",
        evidence: [],
      },
      now: new Date("2026-08-13T12:00:00.000Z"),
    });
    database.persistIncoming(task, 1);
    database.persistIncoming(status, 1);

    const claimed = database.claimInbox(
      "status-agent",
      10,
      30,
      ["status"],
      new Date("2026-08-13T12:00:01.000Z"),
    );
    expect(claimed).toHaveLength(1);
    expect(claimed[0]!.envelope.kind).toBe("status");
  });

  it("routes legacy and pinned consultations to different claimers", () => {
    const legacy = coordinationEnvelope(
      "legacy-routing",
      undefined,
    );
    const consultation = coordinationEnvelope(
      "consultation-routing",
      "pinned_git",
    );
    database.persistIncoming(legacy, 1);
    database.persistIncoming(consultation, 1);

    const legacyClaims = database.claimReadOnlyDispatchInbox(
      "legacy-dispatcher",
      10,
      60,
    );
    const consultationClaims =
      database.claimAutonomousConsultationInbox(
        "consultation-dispatcher",
        10,
        720,
      );

    expect(legacyClaims.map((item) => item.envelope.message_id)).toEqual([
      legacy.message_id,
    ]);
    expect(
      consultationClaims.map((item) => item.envelope.message_id),
    ).toEqual([consultation.message_id]);
  });
});

function envelope(idempotencyKey: string, body: string) {
  return createEnvelope({
    idempotencyKey,
    originSystem: "SYS-A",
    targetSystem: "SYS-B",
    kind: "task_request",
    streamId: "database-tests",
    payload: {
      subject: "Database test",
      body,
      evidence: [],
    },
    now: new Date("2026-08-13T12:00:00.000Z"),
  });
}

function coordinationEnvelope(
  idempotencyKey: string,
  evidenceMode: "pinned_git" | undefined,
) {
  return createEnvelope({
    idempotencyKey,
    originSystem: "SYS-A",
    targetSystem: "SYS-B",
    kind: "task_request",
    streamId: "agent-coordination",
    payload: {
      subject: "Coordination routing",
      body: "Route this request.",
      project: "bridge",
      evidence: [],
      dispatch: {
        executor: "codex_cli",
        access: "read_only",
        ...(evidenceMode
          ? { evidence_mode: evidenceMode }
          : {}),
      },
      coordination_request: {
        protocol_version: "1.0",
        intent: "inspect",
        access_mode: "read_only",
      },
    },
  });
}
