import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { BridgeConfig } from "../../src/config.js";
import { createEnvelope } from "../../src/contracts/envelope.js";
import type {
  CodexExecutionInput,
  CodexExecutionResult,
  CodexExecutor,
} from "../../src/dispatcher/codex-executor.js";
import { ProjectRegistry } from "../../src/dispatcher/project-registry.js";
import { ProjectEvidenceProvider } from "../../src/evidence/project-evidence-provider.js";
import type { EvidenceCollectionInput } from "../../src/evidence/project-evidence-provider.js";
import type { EvidenceBundle } from "../../src/contracts/evidence.js";
import {
  AutonomousConsultationCoordinator,
  type ConsultationEvidenceProvider,
} from "../../src/coordination/autonomous-consultation-coordinator.js";
import { BridgeDatabase } from "../../src/storage/database.js";

describe("AutonomousConsultationCoordinator", () => {
  let root: string;
  let projectPath: string;
  let neutralPath: string;
  let registry: ProjectRegistry;
  let database: BridgeDatabase;
  let executor: QueuedCodexExecutor;
  let coordinator: AutonomousConsultationCoordinator;

  beforeEach(() => {
    root = fs.mkdtempSync(
      path.join(os.tmpdir(), "balcony-consultation-coordinator-"),
    );
    projectPath = path.join(root, "project");
    neutralPath = path.join(root, "neutral");
    fs.mkdirSync(projectPath);
    fs.mkdirSync(neutralPath);
    fs.writeFileSync(path.join(projectPath, "README.md"), "Bridge docs.\n");
    const registryPath = path.join(root, "projects.json");
    fs.writeFileSync(
      registryPath,
      JSON.stringify({
        schema_version: "1.0",
        projects: [
          {
            key: "balcony-agent-bridge",
            path: projectPath,
            peer_readable: true,
          },
        ],
      }),
    );
    registry = ProjectRegistry.load(registryPath);
    database = new BridgeDatabase(path.join(root, "bridge.sqlite3"));
    database.registerResource("balcony-agent-bridge");
    database.grantPeerResource("SYS-A", "balcony-agent-bridge");
    executor = new QueuedCodexExecutor();
    coordinator = createCoordinator();
  });

  afterEach(() => {
    database.close();
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("parks local evidence needs durably and resumes to completion", async () => {
    const request = incomingRequest();
    database.persistIncoming(request, 1, now(0), true);
    executor.outputs.push(
      childResult({
        outcome: "needs_information",
        reason: "The README is required.",
        requested_evidence: ["README.md"],
        evidence_paths: [],
      }),
      childResult({
        outcome: "completed",
        answer: "The supplied README identifies the bridge.",
        evidence_paths: ["README.md"],
      }),
    );

    expect(await coordinator.runOnce(now(1))).toBe(1);
    expect(database.getConsultationRun(request.message_id)).toMatchObject({
      state: "needs_information",
      round_count: 1,
      requested_evidence: ["README.md"],
    });
    expect(database.getInboxMessage(request.message_id)?.state).toBe(
      "available",
    );

    expect(await coordinator.runOnce(now(2))).toBe(1);
    expect(database.getConsultationRun(request.message_id)).toMatchObject({
      state: "pending_child",
      evidence: {
        items: [
          {
            path: "README.md",
            source: "local_project",
          },
        ],
      },
    });
    expect(executor.inputs).toHaveLength(1);

    expect(await coordinator.runOnce(now(3))).toBe(1);
    expect(database.getConsultationRun(request.message_id)).toMatchObject({
      state: "completed",
      round_count: 2,
      final_answer: "The supplied README identifies the bridge.",
      final_evidence_paths: ["README.md"],
    });
    expect(database.getInboxMessage(request.message_id)?.state).toBe(
      "processed",
    );
    expect(executor.inputs).toHaveLength(2);
    expect(executor.inputs[1]).toMatchObject({
      projectPath: fs.realpathSync.native(neutralPath),
      executionBoundary: "evidence_only",
    });
    expect(executor.inputs[1]?.prompt).toContain("Bridge docs.");
    expect(executor.inputs[1]?.prompt).not.toContain(projectPath);

    const reply = database.getOutboxByIdempotency(
      "SYS-A",
      `consultation-result:${request.message_id}`,
    );
    expect(reply?.envelope.payload).toMatchObject({
      body: "The supplied README identifies the bridge.",
      evidence: [
        {
          kind: "repository_path",
          value: "README.md",
        },
      ],
      coordination_result: {
        request_message_id: request.message_id,
        outcome: "completed",
      },
    });
  });

  it("creates a correlated nested peer request and resumes from its result", async () => {
    const request = incomingRequest();
    database.persistIncoming(request, 1, now(0), true);
    executor.outputs.push(
      childResult({
        outcome: "needs_information",
        reason: "The peer owns the runtime observation.",
        peer_request: {
          subject: "Inspect peer bridge runtime",
          request: "Report whether the canonical worker is healthy.",
          intent: "inspect",
        },
        evidence_paths: [],
      }),
      childResult({
        outcome: "completed",
        answer: "The peer reports a healthy canonical worker.",
        evidence_paths: [],
      }),
    );

    await coordinator.runOnce(now(1));
    expect(database.getConsultationRun(request.message_id)).toMatchObject({
      state: "waiting_peer",
      round_count: 1,
    });

    await coordinator.runOnce(now(2));
    const waiting = database.getConsultationRun(request.message_id)!;
    expect(waiting).toMatchObject({
      state: "waiting_peer",
      nested_task_id: expect.any(String),
    });
    const nested = database.getOutboxMessage(waiting.nested_task_id!);
    const nestedTaskId = waiting.nested_task_id!;
    expect(nested?.envelope).toMatchObject({
      kind: "task_request",
      stream_id: "agent-coordination",
      correlation_id: request.message_id,
      causation_id: request.message_id,
      payload: {
        project: "balcony-agent-bridge",
        consultation_context: {
          root_request_id: request.message_id,
          parent_request_id: request.message_id,
          depth: 1,
          max_depth: 2,
        },
      },
    });
    expect(await coordinator.runOnce(now(3))).toBe(0);

    const {
      nested_task_id: _lostNestedTaskId,
      next_attempt_at_utc: _lostNextAttempt,
      ...crashWindow
    } = waiting;
    database.saveConsultationRun(
      crashWindow,
      waiting.version,
      now(4),
    );
    await coordinator.runOnce(now(8));
    const replayed = database.getConsultationRun(request.message_id)!;
    expect(replayed.nested_task_id).toBe(nestedTaskId);
    expect(database.getStatus().outbox.pending).toBe(1);

    const peerResult = createEnvelope({
      idempotencyKey: "peer-runtime-result",
      originSystem: "SYS-A",
      targetSystem: "SYS-B",
      kind: "task_result",
      streamId: "agent-coordination",
      conversationId: nested!.envelope.conversation_id,
      causationId: nestedTaskId,
      correlationId: request.message_id,
      sequenceNumber: 1,
      payload: {
        project: "balcony-agent-bridge",
        subject: "Peer bridge runtime",
        body: "The canonical worker heartbeat is healthy.",
        evidence: [],
        coordination_result: {
          protocol_version: "1.0",
          request_message_id: nestedTaskId,
          outcome: "completed",
        },
      },
      now: now(9),
    });
    database.persistIncoming(peerResult, 1, now(9), true);

    await coordinator.runOnce(now(14));
    expect(database.getConsultationRun(request.message_id)).toMatchObject({
      state: "pending_child",
      evidence: {
        items: [
          {
            source: "peer_result",
            source_message_id: peerResult.message_id,
            content: "The canonical worker heartbeat is healthy.",
          },
        ],
      },
    });

    await coordinator.runOnce(now(15));
    expect(database.getConsultationRun(request.message_id)).toMatchObject({
      state: "completed",
      round_count: 2,
    });
    expect(executor.inputs[1]?.prompt).toContain(
      "The canonical worker heartbeat is healthy.",
    );
    expect(executor.inputs[1]?.prompt).toContain(
      '"source":"peer_result"',
    );
  });

  it("preserves pinned Git snapshot metadata when evidence is merged", async () => {
    const request = incomingRequest();
    database.persistIncoming(request, 1, now(0), true);
    executor.outputs.push(
      childResult({
        outcome: "needs_information",
        reason: "The README is required.",
        requested_evidence: ["README.md"],
        evidence_paths: [],
      }),
      childResult({
        outcome: "completed",
        answer: "Pinned bridge evidence is verified.",
        evidence_paths: ["README.md"],
      }),
    );
    const pinnedCoordinator = createCoordinator(
      new PinnedEvidenceProvider(),
    );

    await pinnedCoordinator.runOnce(now(1));
    await pinnedCoordinator.runOnce(now(2));
    await pinnedCoordinator.runOnce(now(3));

    expect(database.getConsultationRun(request.message_id)).toMatchObject({
      state: "completed",
      final_evidence_paths: ["README.md"],
      evidence: {
        git_snapshot: {
          revision: "a".repeat(40),
          worktree_state: "clean",
        },
        items: [
          {
            source: "pinned_git",
            git_commit: "a".repeat(40),
          },
        ],
      },
    });
    const reply = database.getOutboxByIdempotency(
      "SYS-A",
      `consultation-result:${request.message_id}`,
    );
    expect(reply?.envelope.payload.evidence).toEqual([
      { kind: "repository_path", value: "README.md" },
      { kind: "git_commit", value: "a".repeat(40) },
    ]);
  });

  it("cannot settle with a claim that expired during child execution", async () => {
    const request = incomingRequest();
    const start = now(1);
    let current = start;
    database.persistIncoming(request, 1, now(0), true);
    const expiringExecutor = new ClockAdvancingExecutor(() => {
      current = new Date(start.getTime() + 721_000);
    });
    const expiringCoordinator = createCoordinator(
      new ProjectEvidenceProvider(),
      expiringExecutor,
      () => current,
    );

    await expect(
      expiringCoordinator.runOnce(start),
    ).rejects.toThrow(/invalid or expired/);
    expect(database.getInboxMessage(request.message_id)?.state).toBe(
      "claimed",
    );
    expect(database.getStatus().outbox.pending).toBe(0);

    const recoveredCoordinator = createCoordinator(
      new ProjectEvidenceProvider(),
      new QueuedCodexExecutor(),
      () => current,
    );
    expect(
      await recoveredCoordinator.runOnce(
        new Date(current.getTime() + 1000),
      ),
    ).toBe(1);
    expect(database.getInboxMessage(request.message_id)?.state).toBe(
      "processed",
    );
    expect(database.getStatus().outbox.pending).toBe(1);
  });

  function createCoordinator(
    evidenceProvider: ConsultationEvidenceProvider =
      new ProjectEvidenceProvider(),
    codexExecutor: CodexExecutor = executor,
    clock?: () => Date,
  ): AutonomousConsultationCoordinator {
    return new AutonomousConsultationCoordinator(
      bridgeConfig(path.join(root, "bridge.sqlite3")),
      database,
      registry,
      codexExecutor,
      evidenceProvider,
      neutralPath,
      {
        maxRounds: 4,
        maxDepth: 2,
        runTimeoutSeconds: 900,
        claimLeaseSeconds: 720,
        maxOutputBytes: 48_000,
      },
      clock,
    );
  }
});

class QueuedCodexExecutor implements CodexExecutor {
  public readonly inputs: CodexExecutionInput[] = [];
  public readonly outputs: CodexExecutionResult[] = [];

  public async execute(
    input: CodexExecutionInput,
  ): Promise<CodexExecutionResult> {
    this.inputs.push(input);
    const output = this.outputs.shift();
    if (!output) {
      throw new Error("No queued Codex output");
    }
    return output;
  }
}

class ClockAdvancingExecutor implements CodexExecutor {
  public constructor(private readonly advanceClock: () => void) {}

  public async execute(): Promise<CodexExecutionResult> {
    this.advanceClock();
    return childResult({
      outcome: "completed",
      answer: "Bounded answer.",
      evidence_paths: [],
    });
  }
}

class PinnedEvidenceProvider {
  public collect(input: EvidenceCollectionInput): EvidenceBundle {
    const content = "Pinned bridge docs.\n";
    const bytes = Buffer.from(content, "utf8");
    return {
      schema_version: "1.0",
      project: input.project,
      generated_at_utc: (input.now ?? new Date()).toISOString(),
      total_bytes: bytes.byteLength,
      git_snapshot: {
        revision: "a".repeat(40),
        branch: "main",
        worktree_state: "clean",
        commit_time_utc: "2026-08-17T12:00:00.000Z",
      },
      items: [
        {
          path: "README.md",
          source: "pinned_git",
          git_commit: "a".repeat(40),
          git_blob_oid: "b".repeat(40),
          content,
          sha256: createHash("sha256").update(bytes).digest("hex"),
          byte_length: bytes.byteLength,
          modified_at_utc: "2026-08-17T12:00:00.000Z",
        },
      ],
    };
  }
}

function incomingRequest() {
  return createEnvelope({
    idempotencyKey: "consultation-request",
    originSystem: "SYS-A",
    targetSystem: "SYS-B",
    kind: "task_request",
    streamId: "agent-coordination",
    conversationId: "33333333-3333-4333-8333-333333333333",
    sequenceNumber: 0,
    payload: {
      project: "balcony-agent-bridge",
      subject: "Inspect the bridge",
      body: "Use bounded evidence to report the bridge state.",
      evidence: [],
      dispatch: {
        executor: "codex_cli",
        access: "read_only",
        timeout_seconds: 120,
        evidence_mode: "pinned_git",
      },
      coordination_request: {
        protocol_version: "1.0",
        intent: "inspect",
        access_mode: "read_only",
      },
    },
    now: now(0),
  });
}

function childResult(
  value: Record<string, unknown>,
): CodexExecutionResult {
  return {
    output: JSON.stringify({
      schema_version: "1.0",
      ...value,
    }),
  };
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

function now(seconds: number): Date {
  return new Date(
    Date.parse("2026-08-17T12:00:00.000Z") + seconds * 1000,
  );
}
