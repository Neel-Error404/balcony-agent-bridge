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

  it("rejects a second coordination root for the same conversation", () => {
    const temporaryDirectory = fs.mkdtempSync(
      path.join(os.tmpdir(), "balcony-outbox-connections-"),
    );
    const databasePath = path.join(temporaryDirectory, "bridge.sqlite3");
    const firstDatabase = new BridgeDatabase(databasePath);
    const secondDatabase = new BridgeDatabase(databasePath);
    const conversationId = "10c04d17-b130-41ba-9b59-c3b088f9ab48";
    try {
      firstDatabase.enqueueEnvelope(
        coordinationRoot("first-root", conversationId),
        { matchConversationId: true },
      );

      expect(() =>
        secondDatabase.enqueueEnvelope(
          coordinationRoot("second-root", conversationId),
          { matchConversationId: true },
        ),
      ).toThrow("already has a different root request");
      expect(firstDatabase.getStatus().outbox.pending).toBe(1);
    } finally {
      secondDatabase.close();
      firstDatabase.close();
      fs.rmSync(temporaryDirectory, { recursive: true, force: true });
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

function coordinationRoot(idempotencyKey: string, conversationId: string) {
  return createEnvelope({
    idempotencyKey,
    originSystem: "SYS-A",
    targetSystem: "SYS-B",
    kind: "task_request",
    conversationId,
    streamId: "agent-coordination",
    sequenceNumber: 0,
    payload: {
      subject: "Inspect",
      body: "Inspect the project.",
      project: "voiceai",
      evidence: [],
      dispatch: {
        executor: "codex_cli",
        access: "read_only",
        timeout_seconds: 120,
      },
      coordination_request: {
        protocol_version: "1.0",
        intent: "inspect",
        access_mode: "read_only",
      },
    },
  });
}
