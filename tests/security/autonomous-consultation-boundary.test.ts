import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import type { BridgeConfig } from "../../src/config.js";
import { consultationRequestFingerprint } from "../../src/contracts/consultation.js";
import { createEnvelope } from "../../src/contracts/envelope.js";
import { AutonomousConsultationCoordinator } from "../../src/coordination/autonomous-consultation-coordinator.js";
import type {
  CodexExecutionInput,
  CodexExecutionResult,
  CodexExecutor,
} from "../../src/dispatcher/codex-executor.js";
import { ProjectRegistry } from "../../src/dispatcher/project-registry.js";
import { ProjectEvidenceProvider } from "../../src/evidence/project-evidence-provider.js";
import { BridgeDatabase } from "../../src/storage/database.js";

describe("autonomous consultation safety controls", () => {
  const harnesses: Harness[] = [];

  afterEach(() => {
    for (const harness of harnesses) {
      harness.database.close();
      fs.rmSync(harness.root, { recursive: true, force: true });
    }
    harnesses.length = 0;
  });

  it("stops a consultation after its durable timeout", async () => {
    const harness = createHarness({ runTimeoutSeconds: 30 });
    const request = incomingRequest();
    harness.database.persistIncoming(request, 1, now(0), true);

    await harness.coordinator.runOnce(now(31));

    expect(
      harness.database.getConsultationRun(request.message_id),
    ).toMatchObject({
      state: "failed",
      error_code: "CONSULTATION_TIMED_OUT",
    });
    expect(harness.database.getInboxMessage(request.message_id)?.state).toBe(
      "rejected",
    );
    expect(harness.executor.inputs).toHaveLength(0);
  });

  it("claims an expired consultation request to settle its timeout", async () => {
    const harness = createHarness({ runTimeoutSeconds: 30 });
    const request = createEnvelope({
      idempotencyKey: "expired-consultation",
      originSystem: "SYS-A",
      targetSystem: "SYS-B",
      kind: "task_request",
      streamId: "agent-coordination",
      expiresAtUtc: now(30).toISOString(),
      payload: {
        project: "balcony-agent-bridge",
        subject: "Expired consultation",
        body: "Return a bounded answer.",
        evidence: [],
        dispatch: {
          executor: "codex_cli",
          access: "read_only",
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
    harness.database.persistIncoming(request, 1, now(0), true);

    expect(await harness.coordinator.runOnce(now(31))).toBe(1);
    expect(harness.database.getInboxMessage(request.message_id)?.state).toBe(
      "rejected",
    );
    expect(
      harness.database.getConsultationRun(request.message_id),
    ).toMatchObject({
      state: "failed",
      error_code: "CONSULTATION_TIMED_OUT",
    });
  });

  it("stops before sending a peer request at the depth limit", async () => {
    const harness = createHarness({ maxDepth: 2 });
    const request = incomingRequest({
      depth: 2,
      maxDepth: 2,
      rootRequestId: "11111111-1111-4111-8111-111111111111",
      parentRequestId: "22222222-2222-4222-8222-222222222222",
    });
    harness.database.persistIncoming(request, 1, now(0), true);
    harness.executor.outputs.push(peerNeed());

    await harness.coordinator.runOnce(now(1));
    await harness.coordinator.runOnce(now(2));

    expect(
      harness.database.getConsultationRun(request.message_id),
    ).toMatchObject({
      state: "failed",
      error_code: "CONSULTATION_DEPTH_LIMIT",
    });
    expect(harness.database.getStatus().outbox.pending).toBe(1);
    const failure = harness.database.getOutboxByIdempotency(
      "SYS-A",
      `consultation-failure:${request.message_id}`,
    );
    expect(failure).toBeDefined();
  });

  it("detects a peer-request cycle before enqueueing it", async () => {
    const harness = createHarness();
    const request = incomingRequest();
    harness.database.persistIncoming(request, 1, now(0), true);
    harness.executor.outputs.push(
      result({
        outcome: "needs_information",
        reason: "Ask the peer the same question.",
        peer_request: {
          subject: request.payload.subject,
          request: request.payload.body,
          intent: "inspect",
        },
        evidence_paths: [],
      }),
    );

    await harness.coordinator.runOnce(now(1));
    await harness.coordinator.runOnce(now(2));

    expect(
      harness.database.getConsultationRun(request.message_id),
    ).toMatchObject({
      state: "failed",
      error_code: "CONSULTATION_CYCLE_DETECTED",
    });
    expect(harness.database.getStatus().outbox.pending).toBe(1);
  });

  it("stops instead of executing beyond the round limit", async () => {
    const harness = createHarness({ maxRounds: 1 });
    const request = incomingRequest();
    harness.database.persistIncoming(request, 1, now(0), true);
    harness.executor.outputs.push(
      result({
        outcome: "needs_information",
        reason: "README required.",
        requested_evidence: ["README.md"],
        evidence_paths: [],
      }),
    );

    await harness.coordinator.runOnce(now(1));
    await harness.coordinator.runOnce(now(2));
    await harness.coordinator.runOnce(now(3));

    expect(
      harness.database.getConsultationRun(request.message_id),
    ).toMatchObject({
      state: "failed",
      round_count: 1,
      error_code: "CONSULTATION_ROUND_LIMIT",
    });
    expect(harness.executor.inputs).toHaveLength(1);
  });

  it("rejects a claim lease shorter than the bounded child execution window", () => {
    expect(() => createHarness({ claimLeaseSeconds: 60 })).toThrow(
      /claim lease|720/i,
    );
  });

  it("ignores a peer result outside the correlated nested conversation", async () => {
    const harness = createHarness();
    const request = incomingRequest();
    harness.database.persistIncoming(request, 1, now(0), true);
    harness.executor.outputs.push(peerNeed());

    await harness.coordinator.runOnce(now(1));
    await harness.coordinator.runOnce(now(2));
    const run = harness.database.getConsultationRun(request.message_id)!;
    const nested = harness.database.getOutboxMessage(run.nested_task_id!)!;
    const wrongConversationResult = createEnvelope({
      idempotencyKey: "wrong-conversation-result",
      originSystem: "SYS-A",
      targetSystem: "SYS-B",
      kind: "task_result",
      streamId: "agent-coordination",
      conversationId: "44444444-4444-4444-8444-444444444444",
      causationId: run.nested_task_id!,
      correlationId: request.message_id,
      payload: {
        project: "balcony-agent-bridge",
        subject: "Mismatched peer result",
        body: "This result belongs to a different conversation.",
        evidence: [],
        coordination_result: {
          protocol_version: "1.0",
          request_message_id: run.nested_task_id!,
          outcome: "completed",
        },
      },
      now: now(3),
    });
    expect(wrongConversationResult.conversation_id).not.toBe(
      nested.envelope.conversation_id,
    );
    harness.database.persistIncoming(
      wrongConversationResult,
      1,
      now(3),
      true,
    );

    await harness.coordinator.runOnce(now(8));

    expect(
      harness.database.getConsultationRun(request.message_id),
    ).toMatchObject({
      state: "waiting_peer",
      nested_task_id: run.nested_task_id,
    });
  });

  it("settles an unallowlisted project request instead of stranding its claim", async () => {
    const harness = createHarness();
    const request = createEnvelope({
      idempotencyKey: "unknown-consultation-project",
      originSystem: "SYS-A",
      targetSystem: "SYS-B",
      kind: "task_request",
      streamId: "agent-coordination",
      payload: {
        project: "not-allowlisted",
        subject: "Inspect unknown project",
        body: "Return a bounded answer.",
        evidence: [],
        dispatch: {
          executor: "codex_cli",
          access: "read_only",
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
    harness.database.persistIncoming(request, 1, now(0), true);

    expect(await harness.coordinator.runOnce(now(1))).toBe(1);
    expect(harness.database.getInboxMessage(request.message_id)?.state).toBe(
      "rejected",
    );
    expect(
      harness.database.getConsultationRun(request.message_id),
    ).toBeUndefined();
    expect(
      harness.database.getOutboxByIdempotency(
        "SYS-A",
        `consultation-failure:${request.message_id}`,
      ),
    ).toBeDefined();
  });

  function createHarness(
    overrides: Partial<{
      maxRounds: number;
      maxDepth: number;
      runTimeoutSeconds: number;
      claimLeaseSeconds: number;
    }> = {},
  ): Harness {
    const root = fs.mkdtempSync(
      path.join(os.tmpdir(), "balcony-consultation-security-"),
    );
    const projectPath = path.join(root, "project");
    const neutralPath = path.join(root, "neutral");
    const databasePath = path.join(root, "bridge.sqlite3");
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
    const database = new BridgeDatabase(databasePath);
    database.registerResource("balcony-agent-bridge");
    database.grantPeerResource("SYS-A", "balcony-agent-bridge");
    const executor = new SecurityExecutor();
    let coordinator: AutonomousConsultationCoordinator;
    try {
      coordinator = new AutonomousConsultationCoordinator(
        bridgeConfig(databasePath),
        database,
        ProjectRegistry.load(registryPath),
        executor,
        new ProjectEvidenceProvider(),
        neutralPath,
        {
          maxRounds: overrides.maxRounds ?? 4,
          maxDepth: overrides.maxDepth ?? 2,
          runTimeoutSeconds: overrides.runTimeoutSeconds ?? 900,
          claimLeaseSeconds: overrides.claimLeaseSeconds ?? 720,
          maxOutputBytes: 48_000,
        },
      );
    } catch (error) {
      database.close();
      fs.rmSync(root, { recursive: true, force: true });
      throw error;
    }
    const harness = { root, database, executor, coordinator };
    harnesses.push(harness);
    return harness;
  }
});

interface Harness {
  root: string;
  database: BridgeDatabase;
  executor: SecurityExecutor;
  coordinator: AutonomousConsultationCoordinator;
}

class SecurityExecutor implements CodexExecutor {
  public readonly inputs: CodexExecutionInput[] = [];
  public readonly outputs: CodexExecutionResult[] = [];

  public async execute(
    input: CodexExecutionInput,
  ): Promise<CodexExecutionResult> {
    this.inputs.push(input);
    const output = this.outputs.shift();
    if (!output) {
      throw new Error("No queued security output");
    }
    return output;
  }
}

function incomingRequest(
  nested?: {
    depth: number;
    maxDepth: number;
    rootRequestId: string;
    parentRequestId: string;
  },
) {
  const project = "balcony-agent-bridge";
  const subject = "Inspect bounded coordination";
  const body = "Report bounded coordination behavior.";
  const fingerprint = consultationRequestFingerprint({
    project,
    subject,
    request: body,
  });
  return createEnvelope({
    idempotencyKey: nested
      ? `nested-${nested.depth}`
      : "security-consultation",
    originSystem: "SYS-A",
    targetSystem: "SYS-B",
    kind: "task_request",
    streamId: "agent-coordination",
    ...(nested
      ? {
          correlationId: nested.rootRequestId,
          causationId: nested.parentRequestId,
        }
      : {}),
    payload: {
      project,
      subject,
      body,
      evidence: [],
      dispatch: {
        executor: "codex_cli",
        access: "read_only",
        evidence_mode: "pinned_git",
      },
      coordination_request: {
        protocol_version: "1.0",
        intent: "inspect",
        access_mode: "read_only",
      },
      ...(nested
        ? {
            consultation_context: {
              protocol_version: "1.0" as const,
              root_request_id: nested.rootRequestId,
              parent_request_id: nested.parentRequestId,
              depth: nested.depth,
              max_depth: nested.maxDepth,
              ancestry_fingerprints: [fingerprint],
            },
          }
        : {}),
    },
    now: now(0),
  });
}

function peerNeed(): CodexExecutionResult {
  return result({
    outcome: "needs_information",
    reason: "Peer observation required.",
    peer_request: {
      subject: "Inspect peer runtime",
      request: "Report the peer runtime state.",
      intent: "inspect",
    },
    evidence_paths: [],
  });
}

function result(value: Record<string, unknown>): CodexExecutionResult {
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
