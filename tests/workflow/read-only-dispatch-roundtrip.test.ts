import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { AgentBridgeService } from "../../src/application/agent-bridge-service.js";
import { BridgeWorker } from "../../src/bridge/worker.js";
import type {
  BridgeConfig,
  ReadOnlyDispatcherConfig,
} from "../../src/config.js";
import type {
  CodexExecutionInput,
  CodexExecutor,
} from "../../src/dispatcher/codex-executor.js";
import { ReadOnlyDispatcher } from "../../src/dispatcher/dispatcher.js";
import { ProjectRegistry } from "../../src/dispatcher/project-registry.js";
import { BridgeDatabase } from "../../src/storage/database.js";
import { FakeBridgeTransport } from "../../src/transport/fake-transport.js";

describe("read-only dispatch round trip", () => {
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

  it("returns an automatic read-only result to the requesting system", async () => {
    const root = fs.mkdtempSync(
      path.join(os.tmpdir(), "balcony-dispatch-workflow-"),
    );
    temporaryDirectories.push(root);
    const projectPath = path.join(root, "voiceai");
    fs.mkdirSync(projectPath);
    const registryPath = path.join(root, "projects.json");
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

    const sysADatabase = createDatabase(path.join(root, "sys-a.sqlite3"));
    const sysBDatabase = createDatabase(path.join(root, "sys-b.sqlite3"));
    const sysATransport = new FakeBridgeTransport();
    const sysBTransport = new FakeBridgeTransport();
    const sysAConfig = bridgeConfig("SYS-A", path.join(root, "sys-a.sqlite3"));
    const sysBConfig = bridgeConfig("SYS-B", path.join(root, "sys-b.sqlite3"));
    const sysAService = new AgentBridgeService(sysAConfig, sysADatabase);
    const request = sysAService.askAgent({
      idempotencyKey: "workflow-read-only-request",
      targetNodeId: "SYS-B",
      projectId: "voiceai",
      subject: "Inspect VoiceAI",
      request: "Report the repository state without modifying it.",
      intent: "inspect",
      timeoutSeconds: 120,
    });

    const sysAWorker = new BridgeWorker(
      sysAConfig,
      sysADatabase,
      sysATransport,
    );
    await sysAWorker.runOutboundOnce();
    const requestEnvelope = sysATransport.sent[0]!;
    sysBTransport.queueInbound({
      body: requestEnvelope,
      brokerMessageId: request.task_id as string,
      sessionId: requestEnvelope.conversation_id,
    });
    const sysBWorker = new BridgeWorker(
      sysBConfig,
      sysBDatabase,
      sysBTransport,
    );
    await sysBWorker.runInboundOnce();

    const executor = new WorkflowCodexExecutor();
    const dispatcher = new ReadOnlyDispatcher(
      dispatcherConfig(path.join(root, "sys-b.sqlite3"), registryPath),
      sysBDatabase,
      ProjectRegistry.load(registryPath),
      executor,
    );
    expect(await dispatcher.runOnce()).toBe(1);
    expect(executor.inputs).toHaveLength(1);

    await sysBWorker.runOutboundOnce();
    const resultEnvelope = sysBTransport.sent[0]!;
    sysATransport.queueInbound({
      body: resultEnvelope,
      brokerMessageId: resultEnvelope.message_id,
      sessionId: resultEnvelope.conversation_id,
    });
    await sysAWorker.runInboundOnce();

    const result = sysADatabase.getInboxMessage(
      resultEnvelope.message_id,
    )?.envelope;
    expect(result).toMatchObject({
      kind: "task_result",
      origin_system: "SYS-B",
      target_system: "SYS-A",
      causation_id: request.task_id,
      payload: {
        project: "voiceai",
        body: "VoiceAI is present, clean, and its approved tests pass.",
        coordination_result: {
          protocol_version: "1.0",
          request_message_id: request.task_id,
          outcome: "completed",
        },
      },
    });
    expect(sysAService.getAgentResult(request.task_id as string)).toMatchObject({
      task_id: request.task_id,
      conversation_id: request.conversation_id,
      status: "completed",
      result_message_id: resultEnvelope.message_id,
      result: {
        body: "VoiceAI is present, clean, and its approved tests pass.",
      },
    });
    expect(sysBDatabase.getStatus().inbox.processed).toBe(1);
    expect(sysADatabase.getStatus().inbox.available).toBe(1);

    const followUp = sysAService.continueAgent({
      idempotencyKey: "workflow-read-only-follow-up",
      previousResultMessageId: resultEnvelope.message_id,
      subject: "Clarify VoiceAI evidence",
      request: "Which evidence supports that conclusion?",
      intent: "question",
      timeoutSeconds: 120,
    });
    const duplicateFollowUp = sysAService.continueAgent({
      idempotencyKey: "workflow-read-only-follow-up",
      previousResultMessageId: resultEnvelope.message_id,
      subject: "Clarify VoiceAI evidence",
      request: "Which evidence supports that conclusion?",
      intent: "question",
      timeoutSeconds: 120,
    });
    expect(duplicateFollowUp).toMatchObject({
      task_id: followUp.task_id,
      conversation_id: followUp.conversation_id,
      duplicate: true,
      sequence_number: 2,
    });
    await sysAWorker.runOutboundOnce();
    const followUpEnvelope = sysATransport.sent[1]!;
    sysBTransport.queueInbound({
      body: followUpEnvelope,
      brokerMessageId: followUp.task_id as string,
      sessionId: followUpEnvelope.conversation_id,
    });
    await sysBWorker.runInboundOnce();
    expect(await dispatcher.runOnce()).toBe(1);
    expect(executor.inputs).toHaveLength(2);
    expect(executor.inputs[1]?.prompt).toContain("Prior discussion:");
    expect(executor.inputs[1]?.prompt).toContain(
      "VoiceAI is present, clean, and its approved tests pass.",
    );
    expect(executor.inputs[1]?.prompt).toContain(
      "Which evidence supports that conclusion?",
    );

    await sysBWorker.runOutboundOnce();
    const followUpResultEnvelope = sysBTransport.sent[1]!;
    sysATransport.queueInbound({
      body: followUpResultEnvelope,
      brokerMessageId: followUpResultEnvelope.message_id,
      sessionId: followUpResultEnvelope.conversation_id,
    });
    await sysAWorker.runInboundOnce();

    expect([
      requestEnvelope.sequence_number,
      resultEnvelope.sequence_number,
      followUpEnvelope.sequence_number,
      followUpResultEnvelope.sequence_number,
    ]).toEqual([0, 1, 2, 3]);
    expect(followUpEnvelope).toMatchObject({
      conversation_id: request.conversation_id,
      causation_id: resultEnvelope.message_id,
      payload: { project: "voiceai" },
    });
    expect(followUpResultEnvelope).toMatchObject({
      conversation_id: request.conversation_id,
      causation_id: followUp.task_id,
      payload: {
        coordination_result: {
          request_message_id: followUp.task_id,
          outcome: "completed",
        },
      },
    });
    expect(
      sysAService.getAgentThread(request.conversation_id as string, 20),
    ).toMatchObject({
      conversation_id: request.conversation_id,
      count: 4,
    });
    expect(
      sysAService.continueAgent({
        idempotencyKey: "workflow-read-only-follow-up",
        previousResultMessageId: resultEnvelope.message_id,
        subject: "Clarify VoiceAI evidence",
        request: "Which evidence supports that conclusion?",
        intent: "question",
        timeoutSeconds: 120,
      }),
    ).toMatchObject({
      task_id: followUp.task_id,
      duplicate: true,
      sequence_number: 2,
    });
  });

  function createDatabase(databasePath: string): BridgeDatabase {
    const database = new BridgeDatabase(databasePath);
    databases.push(database);
    return database;
  }
});

class WorkflowCodexExecutor implements CodexExecutor {
  public readonly inputs: CodexExecutionInput[] = [];

  public async execute(input: CodexExecutionInput) {
    this.inputs.push(input);
    return {
      output: "VoiceAI is present, clean, and its approved tests pass.",
    };
  }
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

function dispatcherConfig(
  databasePath: string,
  projectsPath: string,
): ReadOnlyDispatcherConfig {
  return {
    systemId: "SYS-B",
    authorizedNodeIds: ["SYS-A"],
    databasePath,
    projectsPath,
    codexExecutable: "unused-in-workflow-test",
    codexExecutableSha256: "a".repeat(64),
    codexCodeModeHostExecutable: "unused-in-workflow-test",
    codexCodeModeHostSha256: "b".repeat(64),
    codexHome: "unused-in-workflow-test",
    trustedPath: "unused-in-workflow-test",
    pollIntervalMs: 1000,
    defaultTimeoutSeconds: 300,
    maxOutputBytes: 48_000,
  };
}
