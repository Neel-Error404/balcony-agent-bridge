import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { createEnvelope } from "../../src/contracts/envelope.js";
import { BridgeDatabase } from "../../src/storage/database.js";

describe("outbox multi-connection idempotency", () => {
  it("returns one durable row when separate connections enqueue the same operation", () => {
    const temporaryDirectory = fs.mkdtempSync(
      path.join(os.tmpdir(), "balcony-outbox-connections-"),
    );
    const databasePath = path.join(
      temporaryDirectory,
      "bridge.sqlite3",
    );
    const firstDatabase = new BridgeDatabase(databasePath);
    const secondDatabase = new BridgeDatabase(databasePath);
    try {
      const first = firstDatabase.enqueueEnvelope(
        envelope("shared-operation"),
      );
      const second = secondDatabase.enqueueEnvelope(
        envelope("shared-operation"),
      );

      expect(first.duplicate).toBe(false);
      expect(second).toEqual({
        messageId: first.messageId,
        state: "pending",
        duplicate: true,
      });
      expect(firstDatabase.getStatus().outbox.pending).toBe(1);
      expect(secondDatabase.getStatus().outbox.pending).toBe(1);
    } finally {
      secondDatabase.close();
      firstDatabase.close();
      fs.rmSync(temporaryDirectory, {
        recursive: true,
        force: true,
      });
    }
  });
});

function envelope(idempotencyKey: string) {
  return createEnvelope({
    idempotencyKey,
    originSystem: "SYS-A",
    targetSystem: "SYS-B",
    kind: "task_result",
    streamId: "multi-connection",
    payload: {
      subject: "Result",
      body: "Same deterministic result.",
      evidence: [],
    },
  });
}
