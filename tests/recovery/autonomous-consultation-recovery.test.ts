import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import type { BridgeConfig } from "../../src/config.js";
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

describe("autonomous consultation recovery", () => {
  const databases: BridgeDatabase[] = [];
  const directories: string[] = [];

  afterEach(() => {
    for (const database of databases) {
      database.close();
    }
    for (const directory of directories) {
      fs.rmSync(directory, { recursive: true, force: true });
    }
    databases.length = 0;
    directories.length = 0;
  });

  it("resumes a parked evidence request after the coordinator restarts", async () => {
    const root = fs.mkdtempSync(
      path.join(os.tmpdir(), "balcony-consultation-restart-"),
    );
    directories.push(root);
    const projectPath = path.join(root, "project");
    const neutralPath = path.join(root, "neutral");
    const databasePath = path.join(root, "bridge.sqlite3");
    fs.mkdirSync(projectPath);
    fs.mkdirSync(neutralPath);
    fs.writeFileSync(path.join(projectPath, "README.md"), "Bridge docs.\n");
    const registry = createRegistry(root, projectPath);
    const request = incomingRequest();

    let database = openDatabase(databasePath);
    database.registerResource("balcony-agent-bridge");
    database.grantPeerResource("SYS-A", "balcony-agent-bridge");
    database.persistIncoming(request, 1, now(0), true);
    const firstExecutor = new RestartExecutor([
      result({
        outcome: "needs_information",
        reason: "README required.",
        requested_evidence: ["README.md"],
        evidence_paths: [],
      }),
    ]);
    await createCoordinator(
      database,
      databasePath,
      registry,
      neutralPath,
      firstExecutor,
    ).runOnce(now(1));
    expect(database.getConsultationRun(request.message_id)?.state).toBe(
      "needs_information",
    );

    database.close();
    databases.splice(databases.indexOf(database), 1);
    database = openDatabase(databasePath);
    const resumedExecutor = new RestartExecutor([
      result({
        outcome: "completed",
        answer: "The README identifies the bridge.",
        evidence_paths: ["README.md"],
      }),
    ]);
    const resumed = createCoordinator(
      database,
      databasePath,
      registry,
      neutralPath,
      resumedExecutor,
      8,
    );

    await resumed.runOnce(now(2));
    expect(database.getConsultationRun(request.message_id)).toMatchObject({
      state: "pending_child",
      evidence: {
        items: [{ path: "README.md" }],
      },
    });
    expect(resumedExecutor.inputs).toHaveLength(0);

    await resumed.runOnce(now(3));
    expect(database.getConsultationRun(request.message_id)).toMatchObject({
      state: "completed",
      final_answer: "The README identifies the bridge.",
    });
    expect(database.getInboxMessage(request.message_id)?.state).toBe(
      "processed",
    );
  });

  function openDatabase(databasePath: string): BridgeDatabase {
    const database = new BridgeDatabase(databasePath);
    databases.push(database);
    return database;
  }
});

class RestartExecutor implements CodexExecutor {
  public readonly inputs: CodexExecutionInput[] = [];

  public constructor(private readonly outputs: CodexExecutionResult[]) {}

  public async execute(
    input: CodexExecutionInput,
  ): Promise<CodexExecutionResult> {
    this.inputs.push(input);
    const output = this.outputs.shift();
    if (!output) {
      throw new Error("No queued restart output");
    }
    return output;
  }
}

function createCoordinator(
  database: BridgeDatabase,
  databasePath: string,
  registry: ProjectRegistry,
  neutralPath: string,
  executor: CodexExecutor,
  maxRounds = 4,
): AutonomousConsultationCoordinator {
  return new AutonomousConsultationCoordinator(
    bridgeConfig(databasePath),
    database,
    registry,
    executor,
    new ProjectEvidenceProvider(),
    neutralPath,
    {
      maxRounds,
      maxDepth: 2,
      runTimeoutSeconds: 900,
      claimLeaseSeconds: 720,
      maxOutputBytes: 48_000,
    },
  );
}

function createRegistry(
  root: string,
  projectPath: string,
): ProjectRegistry {
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
  return ProjectRegistry.load(registryPath);
}

function incomingRequest() {
  return createEnvelope({
    idempotencyKey: "restart-consultation",
    originSystem: "SYS-A",
    targetSystem: "SYS-B",
    kind: "task_request",
    streamId: "agent-coordination",
    payload: {
      project: "balcony-agent-bridge",
      subject: "Inspect restart behavior",
      body: "Use evidence to report restart behavior.",
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
