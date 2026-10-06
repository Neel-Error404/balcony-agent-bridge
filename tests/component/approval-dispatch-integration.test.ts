import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { AgentBridgeService } from "../../src/application/agent-bridge-service.js";
import type { BridgeConfig, ReadOnlyDispatcherConfig } from "../../src/config.js";
import { createEnvelope, type BridgeEnvelope } from "../../src/contracts/envelope.js";
import type {
  CodexExecutionInput,
  CodexExecutionResult,
  CodexExecutor,
} from "../../src/dispatcher/codex-executor.js";
import { ReadOnlyDispatcher } from "../../src/dispatcher/dispatcher.js";
import { ProjectRegistry } from "../../src/dispatcher/project-registry.js";
import { AutonomousConsultationCoordinator } from "../../src/coordination/autonomous-consultation-coordinator.js";
import { BridgeDatabase } from "../../src/storage/database.js";

const resourceId = "voiceai";

describe.each(["dispatcher", "coordinator"] as const)(
  "%s approval boundary",
  (kind) => {
    const roots: string[] = [];
    const databases: BridgeDatabase[] = [];

    afterEach(() => {
      vi.restoreAllMocks();
      for (const database of databases.splice(0)) {
        database.close();
      }
      for (const root of roots.splice(0)) {
        fs.rmSync(root, { recursive: true, force: true });
      }
    });

    it("parks one authenticated enabled but ungranted request before registry, history, or executor exposure, then approve-once requeues it", async () => {
      const fixture = createFixture(kind, roots, databases);
      const request = requestFor(kind);
      fixture.database.persistIncoming(request, 1, at(0), true);
      const registryGet = vi.spyOn(fixture.registry, "get");
      const history = vi.spyOn(fixture.database, "listConversation");

      await fixture.run(at(1));

      expect(fixture.database.listAuthorizationRequests()).toEqual([
        expect.objectContaining({
          requestId: request.message_id,
          peerSystemId: "SYS-A",
          resourceId,
          state: "pending",
        }),
      ]);
      expect(fixture.database.getInboxMessage(request.message_id)?.state).toBe(
        "quarantined",
      );
      expect(registryGet).not.toHaveBeenCalled();
      expect(history).not.toHaveBeenCalled();
      expect(fixture.executor.inputs).toEqual([]);

      fixture.database.approveAuthorizationRequestOnce({
        requestId: request.message_id,
        actorId: "SYS-B",
        now: at(2),
      });

      await fixture.run(at(3));

      expect(fixture.executor.inputs).toHaveLength(1);
      expect(fixture.database.getInboxMessage(request.message_id)?.state).toBe(
        "processed",
      );
      expect(
        fixture.database.getAuthorizationRequest(request.message_id, at(3)),
      ).toMatchObject({ state: "consumed" });
    });

    if (kind === "dispatcher") it("reuses a persisted authoritative reply without starting the worker again", async () => {
      const fixture = createFixture(kind, roots, databases);
      const request = requestFor(kind);
      fixture.database.persistIncoming(request, 1, at(0), true);
      await fixture.run(at(1));
      fixture.database.approveAuthorizationRequestOnce({
        requestId: request.message_id,
        actorId: "SYS-B",
        now: at(2),
      });
      const service = new AgentBridgeService(bridgeConfig(), fixture.database);
      service.reply(
        request.message_id,
        `read-only-result:${request.message_id}`,
        "task_result",
        {
          subject: "Read-only task completed: Inspect resource",
          body: "Original authoritative answer.",
          project: resourceId,
          evidence: [],
        },
      );

      await fixture.run(at(3));
      expect(fixture.executor.inputs).toHaveLength(0);
      expect(fixture.database.getInboxMessage(request.message_id)?.state).toBe("processed");
      expect(fixture.database.getStatus().outbox.pending).toBe(1);
      expect(fixture.database.getOutboxByIdempotency(
        "SYS-A",
        `read-only-result:${request.message_id}`,
      )?.envelope.payload.body).toBe("Original authoritative answer.");
    });

    if (kind === "dispatcher") it("settles a persisted rejected reply without rerunning the worker or reconstructing its payload", async () => {
      const fixture = createFixture(kind, roots, databases);
      const request = requestFor(kind);
      fixture.database.persistIncoming(request, 1, at(0), true);
      await fixture.run(at(1));
      fixture.database.approveAuthorizationRequestOnce({
        requestId: request.message_id,
        actorId: "SYS-B",
        now: at(2),
      });
      const storedPayload = {
        subject: "Original rejected subject",
        body: "Original authoritative rejection.",
        evidence: [{ kind: "git_commit" as const, value: "a".repeat(40) }],
      };
      new AgentBridgeService(bridgeConfig(), fixture.database).reply(
        request.message_id,
        `read-only-result:${request.message_id}`,
        "task_result",
        storedPayload,
      );
      const stored = fixture.database.getOutboxByIdempotency(
        "SYS-A",
        `read-only-result:${request.message_id}`,
      )!.envelope;
      const settlement = vi.spyOn(fixture.database, "settleInboxWithReply");

      await fixture.run(at(3));
      expect(fixture.executor.inputs).toHaveLength(0);
      expect(fixture.database.getInboxMessage(request.message_id)?.state).toBe("rejected");
      expect(fixture.database.getStatus().outbox.pending).toBe(1);
      expect(settlement).toHaveBeenCalledWith(expect.objectContaining({
        outcome: "rejected",
        replyEnvelope: stored,
      }));
      expect(fixture.database.getOutboxByIdempotency(
        "SYS-A",
        `read-only-result:${request.message_id}`,
      )?.envelope.payload).toMatchObject(storedPayload);
    });

    if (kind === "dispatcher") it("does not start an executor when expiry passes after authorization but before execution", async () => {
      vi.useFakeTimers({ toFake: ["Date"] });
      try {
        const base = new Date();
        const fixture = createFixture(kind, roots, databases);
        const request = requestFor(
          kind,
          resourceId,
          new Date(base.getTime() + 5_000).toISOString(),
        );
        fixture.database.persistIncoming(request, 1, base, true);
        await fixture.run(new Date(base.getTime() + 1_000));
        fixture.database.approveAuthorizationRequestOnce({
          requestId: request.message_id,
          actorId: "SYS-B",
          now: new Date(base.getTime() + 2_000),
        });
        vi.setSystemTime(new Date(base.getTime() + 3_000));
        const authorize = fixture.database.authorizeClaimedResourceAccess.bind(fixture.database);
        vi.spyOn(fixture.database, "authorizeClaimedResourceAccess").mockImplementation((input) => {
          const decision = authorize(input);
          vi.setSystemTime(new Date(base.getTime() + 6_000));
          return decision;
        });

        await fixture.run(new Date(base.getTime() + 3_000));
        expect(fixture.executor.inputs).toHaveLength(0);
        expect(fixture.database.getInboxMessage(request.message_id)?.state).toBe("rejected");
      } finally {
        vi.useRealTimers();
      }
    });

    if (kind === "coordinator") it("settles a completed consultation after an expired lease and deadline without restarting its child", async () => {
      const fixture = createFixture(kind, roots, databases);
      const request = requestFor(kind, resourceId, at(850).toISOString());
      fixture.database.persistIncoming(request, 1, at(0), true);
      await fixture.run(at(1));
      fixture.database.approveAuthorizationRequestOnce({
        requestId: request.message_id,
        actorId: "SYS-B",
        now: at(2),
      });
      vi.spyOn(fixture.database, "settleInboxWithReply").mockImplementationOnce(() => {
        throw new Error("simulated crash after completed run");
      });
      await expect(fixture.run(at(3))).rejects.toThrow("simulated crash");
      expect(fixture.database.getConsultationRun(request.message_id)?.state).toBe("completed");
      expect(fixture.executor.inputs).toHaveLength(1);

      await fixture.run(at(950));
      expect(fixture.executor.inputs).toHaveLength(1);
      expect(fixture.database.getConsultationRun(request.message_id)?.state).toBe("completed");
      expect(fixture.database.getInboxMessage(request.message_id)?.state).toBe("processed");
    });

    if (kind === "coordinator") it.each([
      "persistent grant revoked",
      "temporary approval revoked",
      "temporary approval expired",
    ] as const)(
      "does not release a completed consultation after request expiry when its %s",
      async (authority) => {
        const fixture = createFixture(kind, roots, databases);
        const request = requestFor(kind, resourceId, at(850).toISOString());
        fixture.database.persistIncoming(request, 1, at(0), true);
        if (authority === "persistent grant revoked") {
          fixture.database.grantPeerResource("SYS-A", resourceId, at(0));
        } else {
          await fixture.run(at(1));
          fixture.database.approveAuthorizationRequestTemporary({
            requestId: request.message_id,
            actorId: "SYS-B",
            expiresAtUtc: at(authority === "temporary approval expired" ? 500 : 1000).toISOString(),
            now: at(2),
          });
        }
        vi.spyOn(fixture.database, "settleInboxWithReply").mockImplementationOnce(() => {
          throw new Error("simulated crash before terminal settlement");
        });
        await expect(fixture.run(at(3))).rejects.toThrow("simulated crash");
        expect(fixture.database.getConsultationRun(request.message_id)?.state).toBe("completed");
        if (authority === "persistent grant revoked") {
          fixture.database.revokePeerResource("SYS-A", resourceId, at(10), "SYS-B");
        } else if (authority === "temporary approval revoked") {
          fixture.database.revokeAuthorizationRequest({
            requestId: request.message_id,
            actorId: "SYS-B",
            now: at(10),
          });
        }

        await fixture.run(at(950));
        expect(fixture.executor.inputs).toHaveLength(1);
        expect(fixture.database.getOutboxByIdempotency(
          "SYS-A",
          `consultation-result:${request.message_id}`,
        )).toBeUndefined();
        expect(fixture.database.getInboxMessage(request.message_id)?.state).toBe("rejected");
      },
    );

    it.each([
      ["unknown resource", "unlisted-project", true, "enabled"],
      ["malformed resource", "not valid!", true, "enabled"],
      ["disabled resource", resourceId, true, "disabled"],
      ["unauthenticated request", resourceId, false, "enabled"],
    ] as const)(
      "rejects a %s without an approval row or resource disclosure",
      async (_label, project, authenticatedIngress, resourceState) => {
        const fixture = createFixture(kind, roots, databases, {
          resourceState,
        });
        const request = requestFor(kind, project);
        fixture.database.persistIncoming(
          request,
          1,
          at(0),
          authenticatedIngress,
        );

        await fixture.run(at(1));

        expect(fixture.database.listAuthorizationRequests()).toEqual([]);
        expect(fixture.executor.inputs).toEqual([]);
        expect(fixture.database.getInboxMessage(request.message_id)?.state).toBe(
          "rejected",
        );
        const reply = fixture.database.leaseOutbox("assertion", 1, 60, at(2))[0];
        expect(reply?.envelope.kind).toBe("task_result");
        expect(reply?.envelope.payload.body).not.toContain(project);
        expect(reply?.envelope.payload.project).toBeUndefined();
        expect(JSON.stringify(reply?.envelope.payload)).not.toContain(project);
      },
    );
  },
);

function createFixture(
  kind: "dispatcher" | "coordinator",
  roots: string[],
  databases: BridgeDatabase[],
  options: { resourceState?: "enabled" | "disabled" } = {},
): Fixture {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "balcony-approval-boundary-"));
  roots.push(root);
  const projectPath = path.join(root, "project");
  const neutralPath = path.join(root, "neutral");
  fs.mkdirSync(projectPath);
  fs.mkdirSync(neutralPath);
  const registryPath = path.join(root, "projects.json");
  fs.writeFileSync(
    registryPath,
    JSON.stringify({
      schema_version: "1.0",
      projects: [{ key: resourceId, path: projectPath, peer_readable: true }],
    }),
  );
  const registry = ProjectRegistry.load(registryPath);
  const database = new BridgeDatabase(":memory:");
  databases.push(database);
  database.registerResource(resourceId, at(0));
  if (options.resourceState === "disabled") {
    database.setResourceEnabled(resourceId, false, at(0));
  }
  const executor = new RecordingExecutor(kind);
  const worker = kind === "dispatcher"
    ? new ReadOnlyDispatcher(dispatcherConfig(registryPath), database, registry, executor)
    : new AutonomousConsultationCoordinator(
        bridgeConfig(),
        database,
        registry,
        executor,
        { collect: () => emptyEvidence() },
        neutralPath,
        {
          maxRounds: 4,
          maxDepth: 2,
          runTimeoutSeconds: 900,
          claimLeaseSeconds: 720,
          maxOutputBytes: 48_000,
        },
      );
  return {
    database,
    registry,
    executor,
    run: (now) => worker.runOnce(now),
  };
}

function requestFor(
  kind: "dispatcher" | "coordinator",
  project = resourceId,
  expiresAtUtc?: string,
): BridgeEnvelope {
  return createEnvelope({
    idempotencyKey: `${kind}-${project}`,
    originSystem: "SYS-A",
    targetSystem: "SYS-B",
    kind: "task_request",
    streamId: kind === "dispatcher" ? "approval-dispatch" : "agent-coordination",
    conversationId: "f1111111-1111-4111-8111-111111111111",
    sequenceNumber: 0,
    ...(expiresAtUtc ? { expiresAtUtc } : {}),
    payload: {
      project,
      subject: "Inspect resource",
      body: "PRIVATE_REQUEST_BODY",
      evidence: [],
      dispatch: {
        executor: "codex_cli",
        access: "read_only",
        timeout_seconds: 120,
        ...(kind === "coordinator" ? { evidence_mode: "pinned_git" as const } : {}),
      },
      ...(kind === "coordinator"
        ? {
            coordination_request: {
              protocol_version: "1.0" as const,
              intent: "inspect" as const,
              access_mode: "read_only" as const,
            },
          }
        : {}),
    },
    now: at(0),
  });
}

class RecordingExecutor implements CodexExecutor {
  public readonly inputs: CodexExecutionInput[] = [];

  public constructor(private readonly kind: "dispatcher" | "coordinator") {}

  public async execute(input: CodexExecutionInput): Promise<CodexExecutionResult> {
    this.inputs.push(input);
    return this.kind === "dispatcher"
      ? { output: "Safe completed answer." }
      : {
          output: JSON.stringify({
            schema_version: "1.0",
            outcome: "completed",
            answer: "Safe completed answer.",
            evidence_paths: [],
          }),
        };
  }
}

interface Fixture {
  database: BridgeDatabase;
  registry: ProjectRegistry;
  executor: RecordingExecutor;
  run(now: Date): Promise<number>;
}

function dispatcherConfig(projectsPath: string): ReadOnlyDispatcherConfig {
  return {
    systemId: "SYS-B",
    authorizedNodeIds: ["SYS-A"],
    databasePath: ":memory:",
    projectsPath,
    codexExecutable: "unused",
    codexExecutableSha256: "a".repeat(64),
    codexCodeModeHostExecutable: "unused",
    codexCodeModeHostSha256: "b".repeat(64),
    codexHome: "unused",
    trustedPath: "unused",
    pollIntervalMs: 1000,
    defaultTimeoutSeconds: 300,
    maxOutputBytes: 48_000,
  };
}

function bridgeConfig(): BridgeConfig {
  return {
    systemId: "SYS-B",
    authorizedNodeIds: ["SYS-A"],
    databasePath: ":memory:",
    topicName: "agent-messages",
    subscriptionName: "sys-b",
    azureAuthMode: "managed_identity",
  };
}

function emptyEvidence() {
  return {
    schema_version: "1.0" as const,
    project: resourceId,
    generated_at_utc: at(0).toISOString(),
    total_bytes: 0,
    items: [],
  };
}

function at(seconds: number): Date {
  return new Date(Date.now() + seconds * 1000);
}
