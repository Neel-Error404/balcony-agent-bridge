import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { AgentBridgeService } from "../../src/application/agent-bridge-service.js";
import { BridgeWorker } from "../../src/bridge/worker.js";
import type { BridgeConfig } from "../../src/config.js";
import {
  AutonomousConsultationCoordinator,
  type ConsultationEvidenceProvider,
} from "../../src/coordination/autonomous-consultation-coordinator.js";
import type {
  CodexExecutionInput,
  CodexExecutionResult,
  CodexExecutor,
} from "../../src/dispatcher/codex-executor.js";
import { ProjectRegistry } from "../../src/dispatcher/project-registry.js";
import { BridgeDatabase } from "../../src/storage/database.js";
import { FakeBridgeTransport } from "../../src/transport/fake-transport.js";

describe("autonomous consultation round trip", () => {
  const databases: BridgeDatabase[] = [];
  const temporaryDirectories: string[] = [];

  afterEach(() => {
    for (const database of databases) {
      database.close();
    }
    for (const directory of temporaryDirectories) {
      fs.rmSync(directory, { recursive: true, force: true });
    }
    databases.length = 0;
    temporaryDirectories.length = 0;
  });

  it("asks the peer, resumes with its evidence, and returns one correlated answer", async () => {
    const root = fs.mkdtempSync(
      path.join(os.tmpdir(), "balcony-autonomous-roundtrip-"),
    );
    temporaryDirectories.push(root);
    const projectPath = path.join(root, "project");
    const sysANeutral = path.join(root, "sys-a-neutral");
    const sysBNeutral = path.join(root, "sys-b-neutral");
    fs.mkdirSync(projectPath);
    fs.mkdirSync(sysANeutral);
    fs.mkdirSync(sysBNeutral);
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

    const sysADatabase = openDatabase(path.join(root, "sys-a.sqlite3"));
    const sysBDatabase = openDatabase(path.join(root, "sys-b.sqlite3"));
    const sysAConfig = bridgeConfig("SYS-A", path.join(root, "sys-a.sqlite3"));
    const sysBConfig = bridgeConfig("SYS-B", path.join(root, "sys-b.sqlite3"));
    const sysAService = new AgentBridgeService(sysAConfig, sysADatabase);
    const sysATransport = new FakeBridgeTransport();
    const sysBTransport = new FakeBridgeTransport();
    const sysAWorker = new BridgeWorker(
      sysAConfig,
      sysADatabase,
      sysATransport,
    );
    const sysBWorker = new BridgeWorker(
      sysBConfig,
      sysBDatabase,
      sysBTransport,
    );
    const base = new Date();
    const request = sysAService.askAgent({
      idempotencyKey: "workflow-autonomous-consultation",
      targetNodeId: "SYS-B",
      projectId: "balcony-agent-bridge",
      subject: "Reconcile both bridge runtimes",
      request: "Ask the peer for its runtime state and return one answer.",
      intent: "review",
      timeoutSeconds: 120,
      evidenceMode: "pinned_git",
      expiresAtUtc: at(base, 120).toISOString(),
    });

    await sysAWorker.runOutboundOnce();
    await deliver(sysATransport.sent[0]!, sysBTransport, sysBWorker);

    const registry = ProjectRegistry.load(registryPath);
    const sysBExecutor = new SysBConsultingExecutor();
    const sysBCoordinator = coordinator(
      sysBConfig,
      sysBDatabase,
      registry,
      sysBExecutor,
      sysBNeutral,
    );
    const sysACoordinator = coordinator(
      sysAConfig,
      sysADatabase,
      registry,
      new SysAAnsweringExecutor(),
      sysANeutral,
    );

    expect(await sysBCoordinator.runOnce(at(base, 1))).toBe(1);
    expect(await sysBCoordinator.runOnce(at(base, 2))).toBe(1);
    await sysBWorker.runOutboundOnce(at(base, 2));
    const nestedRequest = sysBTransport.sent[0]!;
    expect(nestedRequest).toMatchObject({
      kind: "task_request",
      causation_id: request.task_id,
      correlation_id: request.task_id,
      payload: {
        project: "balcony-agent-bridge",
        consultation_context: {
          root_request_id: request.task_id,
          parent_request_id: request.task_id,
          depth: 1,
        },
      },
    });
    await deliver(nestedRequest, sysATransport, sysAWorker);

    expect(await sysACoordinator.runOnce(at(base, 3))).toBe(1);
    await sysAWorker.runOutboundOnce(at(base, 3));
    const nestedResult = sysATransport.sent[1]!;
    expect(nestedResult).toMatchObject({
      kind: "task_result",
      causation_id: nestedRequest.message_id,
      correlation_id: request.task_id,
      payload: {
        body: "SYS-A reports its canonical bridge runtime is healthy.",
      },
    });
    await deliver(nestedResult, sysBTransport, sysBWorker);

    expect(await sysBCoordinator.runOnce(at(base, 8))).toBe(1);
    expect(await sysBCoordinator.runOnce(at(base, 9))).toBe(1);
    expect(sysBExecutor.inputs).toHaveLength(2);
    expect(sysBExecutor.inputs[1]?.prompt).toContain(
      "SYS-A reports its canonical bridge runtime is healthy.",
    );
    await sysBWorker.runOutboundOnce(at(base, 9));
    const finalResult = sysBTransport.sent[1]!;
    expect(finalResult).toMatchObject({
      kind: "task_result",
      causation_id: request.task_id,
      conversation_id: request.conversation_id,
      payload: {
        body: "SYS-B reconciled both runtimes from the peer response.",
        evidence: [
          {
            kind: "bridge_message",
            value: nestedResult.message_id,
          },
        ],
        coordination_result: {
          request_message_id: request.task_id,
          outcome: "completed",
        },
      },
    });
    await deliver(finalResult, sysATransport, sysAWorker);
    expect(sysAService.getAgentResult(request.task_id as string)).toMatchObject({
      status: "completed",
      result_message_id: finalResult.message_id,
      result: {
        body: "SYS-B reconciled both runtimes from the peer response.",
      },
    });
  });

  function openDatabase(databasePath: string): BridgeDatabase {
    const database = new BridgeDatabase(databasePath);
    databases.push(database);
    return database;
  }
});

class SysAAnsweringExecutor implements CodexExecutor {
  public async execute(): Promise<CodexExecutionResult> {
    return childResult({
      outcome: "completed",
      answer: "SYS-A reports its canonical bridge runtime is healthy.",
      evidence_paths: [],
    });
  }
}

class SysBConsultingExecutor implements CodexExecutor {
  public readonly inputs: CodexExecutionInput[] = [];

  public async execute(
    input: CodexExecutionInput,
  ): Promise<CodexExecutionResult> {
    this.inputs.push(input);
    if (this.inputs.length === 1) {
      return childResult({
        outcome: "needs_information",
        reason: "SYS-A owns its current runtime observation.",
        peer_request: {
          subject: "Inspect SYS-A bridge runtime",
          request: "Report whether the canonical SYS-A runtime is healthy.",
          intent: "inspect",
        },
        evidence_paths: [],
      });
    }
    const evidencePath = input.prompt.match(
      /\.bridge\/peer-results\/[a-f0-9-]{36}\.txt/u,
    )?.[0];
    if (!evidencePath) {
      throw new Error("The peer evidence path was not supplied to SYS-B.");
    }
    return childResult({
      outcome: "completed",
      answer: "SYS-B reconciled both runtimes from the peer response.",
      evidence_paths: [evidencePath],
    });
  }
}

class NoLocalEvidenceProvider implements ConsultationEvidenceProvider {
  public collect(): never {
    throw new Error("The workflow did not authorize local evidence collection.");
  }
}

function coordinator(
  config: BridgeConfig,
  database: BridgeDatabase,
  registry: ProjectRegistry,
  executor: CodexExecutor,
  neutralDirectory: string,
): AutonomousConsultationCoordinator {
  return new AutonomousConsultationCoordinator(
    config,
    database,
    registry,
    executor,
    new NoLocalEvidenceProvider(),
    neutralDirectory,
    {
      maxRounds: 4,
      maxDepth: 2,
      runTimeoutSeconds: 900,
      claimLeaseSeconds: 720,
      maxOutputBytes: 48_000,
      peerPollIntervalSeconds: 5,
    },
  );
}

async function deliver(
  envelope: NonNullable<FakeBridgeTransport["sent"][number]>,
  destination: FakeBridgeTransport,
  worker: BridgeWorker,
): Promise<void> {
  destination.queueInbound({
    body: envelope,
    brokerMessageId: envelope.message_id,
    sessionId: envelope.conversation_id,
  });
  await worker.runInboundOnce();
}

function bridgeConfig(
  systemId: "SYS-A" | "SYS-B",
  databasePath: string,
): BridgeConfig {
  return {
    systemId,
    authorizedNodeIds: [systemId === "SYS-A" ? "SYS-B" : "SYS-A"],
    databasePath,
    topicName: "agent-messages",
    subscriptionName: systemId.toLowerCase(),
    azureAuthMode: "managed_identity",
  };
}

function childResult(value: Record<string, unknown>): CodexExecutionResult {
  return {
    output: JSON.stringify({ schema_version: "1.0", ...value }),
  };
}

function at(base: Date, seconds: number): Date {
  return new Date(base.getTime() + seconds * 1000);
}
