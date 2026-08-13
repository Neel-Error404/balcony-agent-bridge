import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createEnvelope } from "../../src/contracts/envelope.js";
import { BridgeDatabase } from "../../src/storage/database.js";

describe("crash recovery windows", () => {
  let database: BridgeDatabase;

  beforeEach(() => {
    database = new BridgeDatabase(":memory:");
  });

  afterEach(() => database.close());

  it("reclaims an outbox lease after the worker disappears", () => {
    const message = envelope("outbox-crash");
    database.enqueueEnvelope(message);
    const start = new Date("2026-08-13T12:00:00.000Z");

    expect(database.leaseOutbox("dead-worker", 1, 30, start)).toHaveLength(1);
    const recovered = database.leaseOutbox(
      "replacement-worker",
      1,
      30,
      new Date("2026-08-13T12:00:31.000Z"),
    );
    expect(recovered).toHaveLength(1);
    expect(recovered[0]!.attemptNumber).toBe(1);
  });

  it("deduplicates redelivery after inbox commit and before broker completion", () => {
    const message = envelope("inbound-crash");
    expect(database.persistIncoming(message, 1).status).toBe("inserted");
    expect(database.persistIncoming(message, 2).status).toBe("duplicate");
    expect(database.getStatus().inbox.available).toBe(1);
  });

  it("rejects a stale claim after another consumer reclaims expired work", () => {
    const message = envelope("claim-crash");
    const start = new Date("2026-08-13T12:00:00.000Z");
    database.persistIncoming(message, 1, start);
    const stale = database.claimInbox("dead-agent", 1, 15, undefined, start)[0]!;
    const current = database.claimInbox(
      "replacement-agent",
      1,
      30,
      undefined,
      new Date("2026-08-13T12:00:16.000Z"),
    )[0]!;

    expect(() =>
      database.acknowledge(
        message.message_id,
        "dead-agent",
        stale.claimToken,
        "processed",
        undefined,
        new Date("2026-08-13T12:00:17.000Z"),
      ),
    ).toThrow(/invalid, expired/);
    expect(
      database.acknowledge(
        message.message_id,
        "replacement-agent",
        current.claimToken,
        "processed",
        undefined,
        new Date("2026-08-13T12:00:18.000Z"),
      ),
    ).toBe("processed");
  });
});

function envelope(idempotencyKey: string) {
  return createEnvelope({
    idempotencyKey,
    originSystem: "SYS-A",
    targetSystem: "SYS-B",
    kind: "task_request",
    streamId: "recovery-tests",
    payload: {
      subject: "Recovery",
      body: "Synthetic recovery message.",
      evidence: [],
    },
    now: new Date("2026-08-13T12:00:00.000Z"),
    expiresAtUtc: "2026-08-20T12:00:00.000Z",
  });
}
