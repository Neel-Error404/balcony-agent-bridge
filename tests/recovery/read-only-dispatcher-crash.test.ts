import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";

import { AgentBridgeService } from "../../src/application/agent-bridge-service.js";
import type {
  BridgeConfig,
  ReadOnlyDispatcherConfig,
} from "../../src/config.js";
import { createEnvelope } from "../../src/contracts/envelope.js";
import type {
  CodexExecutionInput,
  CodexExecutor,
} from "../../src/dispatcher/codex-executor.js";
import { ReadOnlyDispatcher } from "../../src/dispatcher/dispatcher.js";
import { ProjectRegistry } from "../../src/dispatcher/project-registry.js";
import { BridgeDatabase } from "../../src/storage/database.js";

describe("read-only dispatcher crash recovery", () => {
  let database: BridgeDatabase | undefined;
  let temporaryDirectory: string | undefined;

  afterEach(() => {
    database?.close();
    if (temporaryDirectory) {
      fs.rmSync(temporaryDirectory, { recursive: true, force: true });
    }
    database = undefined;
    temporaryDirectory = undefined;
  });

  it("reuses the deterministic reply after a crash before claim completion", async () => {
    temporaryDirectory = fs.mkdtempSync(
      path.join(os.tmpdir(), "balcony-dispatcher-recovery-"),
    );
    const databasePath = path.join(temporaryDirectory, "bridge.sqlite3");
    const projectPath = path.join(temporaryDirectory, "project");
    const registryPath = path.join(temporaryDirectory, "projects.json");
    fs.mkdirSync(projectPath);
    fs.writeFileSync(
      registryPath,
      JSON.stringify({
        schema_version: "1.0",
        projects: [
          {
            key: "voiceai",
            path: projectPath,
            peer_readable: true,
          },
        ],
      }),
    );
    database = new BridgeDatabase(databasePath);
    database.registerResource("voiceai");
    database.grantPeerResource("SYS-A", "voiceai");
    const original = incomingEnvelope();
    const start = new Date();
    database.persistIncoming(original, 1, start, true);
    const deadClaim = database.claimReadOnlyDispatchInbox(
      "dead-dispatcher",
      1,
      30,
      start,
    )[0]!;

    const service = new AgentBridgeService(
      bridgeConfig(databasePath),
      database,
    );
    service.reply(
      original.message_id,
      `read-only-result:${original.message_id}`,
      "task_result",
      {
        subject: "Read-only task completed: Inspect project",
        body: "Original authoritative answer.",
        project: "voiceai",
        evidence: [],
      },
    );
    expect(database.getStatus().outbox.pending).toBe(1);

    const executor = new RecoveryCodexExecutor();
    const dispatcher = new ReadOnlyDispatcher(
      dispatcherConfig(databasePath, registryPath),
      database,
      ProjectRegistry.load(registryPath),
      executor,
    );
    expect(
      await dispatcher.runOnce(
        new Date(start.getTime() + 31_000),
      ),
    ).toBe(1);

    expect(executor.inputs).toHaveLength(1);
    expect(database.getStatus().outbox.pending).toBe(1);
    expect(database.getStatus().inbox.processed).toBe(1);
    const authoritative = database.leaseOutbox(
      "recovery-verifier",
      1,
      60,
    )[0]!;
    expect(authoritative.envelope.payload.body).toBe(
      "Original authoritative answer.",
    );
    expect(() =>
      database!.acknowledge(
        original.message_id,
        "dead-dispatcher",
        deadClaim.claimToken,
        "rejected",
      ),
    ).toThrow(/invalid, expired, or already settled/);
  });

  it("prevents a stale dispatcher from publishing after another consumer reclaims", () => {
    temporaryDirectory = fs.mkdtempSync(
      path.join(os.tmpdir(), "balcony-dispatcher-fencing-"),
    );
    const databasePath = path.join(temporaryDirectory, "bridge.sqlite3");
    database = new BridgeDatabase(databasePath);
    const original = incomingEnvelope();
    const start = new Date();
    database.persistIncoming(original, 1, start, true);
    const stale = database.claimReadOnlyDispatchInbox(
      "stale-dispatcher",
      1,
      30,
      start,
    )[0]!;
    const current = database.claimReadOnlyDispatchInbox(
      "current-dispatcher",
      1,
      720,
      new Date(start.getTime() + 31_000),
    )[0]!;
    const service = new AgentBridgeService(
      bridgeConfig(databasePath),
      database,
    );

    expect(() =>
      service.settleWithReply({
        originalMessageId: original.message_id,
        consumerId: "stale-dispatcher",
        claimToken: stale.claimToken,
        outcome: "processed",
        idempotencyKey: `read-only-result:${original.message_id}`,
        kind: "task_result",
        payload: {
          subject: "Read-only task completed: Inspect project",
          body: "Stale answer.",
          project: "voiceai",
          evidence: [],
        },
      }),
    ).toThrow(/invalid or expired/);
    expect(database.getStatus().outbox.pending).toBe(0);

    const completed = service.settleWithReply({
      originalMessageId: original.message_id,
      consumerId: "current-dispatcher",
      claimToken: current.claimToken,
      outcome: "processed",
      idempotencyKey: `read-only-result:${original.message_id}`,
      kind: "task_result",
      payload: {
        subject: "Read-only task completed: Inspect project",
        body: "Current answer.",
        project: "voiceai",
        evidence: [],
      },
    });
    expect(completed).toMatchObject({
      state: "processed",
      reply_state: "pending",
      duplicate: false,
    });
    expect(database.getStatus().outbox.pending).toBe(1);
  });

  it("rechecks a revoked resource grant when an expired claim is recovered", async () => {
    temporaryDirectory = fs.mkdtempSync(
      path.join(os.tmpdir(), "balcony-dispatcher-revocation-"),
    );
    const databasePath = path.join(temporaryDirectory, "bridge.sqlite3");
    const projectPath = path.join(temporaryDirectory, "project");
    const registryPath = path.join(temporaryDirectory, "projects.json");
    fs.mkdirSync(projectPath);
    fs.writeFileSync(
      registryPath,
      JSON.stringify({
        schema_version: "1.0",
        projects: [
          {
            key: "voiceai",
            path: projectPath,
            peer_readable: true,
          },
        ],
      }),
    );
    database = new BridgeDatabase(databasePath);
    database.registerResource("voiceai");
    database.grantPeerResource("SYS-A", "voiceai");
    const original = incomingEnvelope();
    const start = new Date();
    database.persistIncoming(original, 1, start, true);
    database.claimReadOnlyDispatchInbox(
      "dead-dispatcher",
      1,
      30,
      start,
    );
    database.revokePeerResource("SYS-A", "voiceai");

    const executor = new RecoveryCodexExecutor();
    const dispatcher = new ReadOnlyDispatcher(
      dispatcherConfig(databasePath, registryPath),
      database,
      ProjectRegistry.load(registryPath),
      executor,
    );
    expect(
      await dispatcher.runOnce(new Date(start.getTime() + 31_000)),
    ).toBe(1);
    expect(executor.inputs).toHaveLength(0);
    expect(database.getStatus().inbox.rejected).toBe(1);
    expect(database.getStatus().outbox.pending).toBe(1);
  });

  it("rejects with a fresh failure result when the prior result is quarantined", async () => {
    temporaryDirectory = fs.mkdtempSync(
      path.join(os.tmpdir(), "balcony-dispatcher-quarantine-"),
    );
    const databasePath = path.join(temporaryDirectory, "bridge.sqlite3");
    const projectPath = path.join(temporaryDirectory, "project");
    const registryPath = path.join(temporaryDirectory, "projects.json");
    fs.mkdirSync(projectPath);
    fs.writeFileSync(
      registryPath,
      JSON.stringify({
        schema_version: "1.0",
        projects: [
          {
            key: "voiceai",
            path: projectPath,
            peer_readable: true,
          },
        ],
      }),
    );
    database = new BridgeDatabase(databasePath);
    database.registerResource("voiceai");
    database.grantPeerResource("SYS-A", "voiceai");
    const original = incomingEnvelope();
    database.persistIncoming(original, 1, new Date(), true);
    const service = new AgentBridgeService(
      bridgeConfig(databasePath),
      database,
    );
    service.reply(
      original.message_id,
      `read-only-result:${original.message_id}`,
      "task_result",
      {
        subject: "Read-only task completed: Inspect project",
        body: "Prior result that cannot be delivered.",
        project: "voiceai",
        evidence: [],
      },
    );
    const leased = database.leaseOutbox(
      "quarantine-test",
      1,
      60,
    )[0]!;
    database.quarantineOutbox(
      leased.envelope.message_id,
      "quarantine-test",
      "UnauthorizedAccess",
    );

    const dispatcher = new ReadOnlyDispatcher(
      dispatcherConfig(databasePath, registryPath),
      database,
      ProjectRegistry.load(registryPath),
      new RecoveryCodexExecutor(),
    );
    expect(await dispatcher.runOnce()).toBe(1);

    expect(database.getStatus().inbox.rejected).toBe(1);
    expect(database.getStatus().outbox).toMatchObject({
      pending: 1,
      quarantined: 1,
    });
    const failure = database.leaseOutbox(
      "failure-verifier",
      1,
      60,
    )[0]!;
    expect(failure.envelope.idempotency_key).toBe(
      `read-only-failure:${original.message_id}`,
    );
    expect(failure.envelope.payload.body).toContain(
      "no longer deliverable",
    );
  });

  it("preserves a null processed timestamp for terminal rejection", () => {
    temporaryDirectory = fs.mkdtempSync(
      path.join(os.tmpdir(), "balcony-dispatcher-rejection-"),
    );
    const databasePath = path.join(temporaryDirectory, "bridge.sqlite3");
    database = new BridgeDatabase(databasePath);
    const original = incomingEnvelope();
    database.persistIncoming(original, 1);
    const claim = database.claimReadOnlyDispatchInbox(
      "rejecting-dispatcher",
      1,
      60,
    )[0]!;
    const service = new AgentBridgeService(
      bridgeConfig(databasePath),
      database,
    );

    service.settleWithReply({
      originalMessageId: original.message_id,
      consumerId: "rejecting-dispatcher",
      claimToken: claim.claimToken,
      outcome: "rejected",
      idempotencyKey: `read-only-result:${original.message_id}`,
      kind: "task_result",
      payload: {
        subject: "Read-only task failed: Inspect project",
        body: "The project is not approved.",
        project: "voiceai",
        evidence: [],
      },
      reason: "DISPATCH_REJECTED",
    });
    database.close();
    database = undefined;

    const raw = new Database(databasePath, { readonly: true });
    try {
      const row = raw
        .prepare(
          "SELECT state, processed_at_utc FROM inbox WHERE message_id = ?",
        )
        .get(original.message_id) as {
        state: string;
        processed_at_utc: string | null;
      };
      expect(row).toEqual({
        state: "rejected",
        processed_at_utc: null,
      });
    } finally {
      raw.close();
    }
  });
});

class RecoveryCodexExecutor implements CodexExecutor {
  public readonly inputs: CodexExecutionInput[] = [];

  public async execute(input: CodexExecutionInput) {
    this.inputs.push(input);
    return { output: "Recovered read-only answer." };
  }
}

function incomingEnvelope() {
  return createEnvelope({
    idempotencyKey: "dispatcher-crash-request",
    originSystem: "SYS-A",
    targetSystem: "SYS-B",
    kind: "task_request",
    streamId: "dispatcher-recovery",
    payload: {
      subject: "Inspect project",
      body: "Return a read-only answer.",
      project: "voiceai",
      evidence: [],
      dispatch: {
        executor: "codex_cli",
        access: "read_only",
      },
    },
  });
}

function bridgeConfig(databasePath: string): BridgeConfig {
  return {
    systemId: "SYS-B",
    authorizedNodeIds: ["SYS-A"],
    databasePath,
    topicName: "agent-messages",
    subscriptionName: "sys-b",
    azureAuthMode: "managed_identity",
  };
}

function dispatcherConfig(
  databasePath: string,
  projectsPath: string,
): ReadOnlyDispatcherConfig {
  return {
    systemId: "SYS-B",
    authorizedNodeIds: ["SYS-A"],
    databasePath,
    projectsPath,
    codexExecutable: "unused-in-recovery-test",
    codexExecutableSha256: "a".repeat(64),
    codexCodeModeHostExecutable: "unused-in-recovery-test",
    codexCodeModeHostSha256: "b".repeat(64),
    codexHome: "unused-in-recovery-test",
    trustedPath: "unused-in-recovery-test",
    pollIntervalMs: 1000,
    defaultTimeoutSeconds: 300,
    maxOutputBytes: 48_000,
  };
}
