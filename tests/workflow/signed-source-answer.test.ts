import { randomBytes } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, expect, it } from "vitest";

import { AgentBridgeService } from "../../src/application/agent-bridge-service.js";
import type { ReadOnlyDispatcherConfig } from "../../src/config.js";
import type { CodexExecutionInput, CodexExecutor } from "../../src/dispatcher/codex-executor.js";
import { ReadOnlyDispatcher } from "../../src/dispatcher/dispatcher.js";
import { ProjectRegistry } from "../../src/dispatcher/project-registry.js";
import { SignedPeerLab, type SignedPeerNode } from "../helpers/peer-check-lab.js";

type Side = "SYS-A" | "SYS-B";
const PROJECT = "public-source";
const SOURCE = "answer.txt";
const fixtures: Array<{ root: string; lab: SignedPeerLab }> = [];

afterEach(async () => {
  for (const { root, lab } of fixtures.splice(0)) {
    await lab.close();
    expect(path.dirname(root)).toBe(os.tmpdir());
    expect(fs.realpathSync.native(root).toLowerCase()).toBe(root.toLowerCase());
    fs.rmSync(root, { recursive: true });
  }
});

it("returns 100 fresh signed source-file answers across both nodes, recovering ten exchanges without duplicate execution", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "bridge-signed-source-"));
  const lab = new SignedPeerLab();
  fixtures.push({ root, lab });
  const projects = {
    "SYS-A": path.join(root, "public-a"),
    "SYS-B": path.join(root, "public-b"),
  };
  const registries = {
    "SYS-A": path.join(root, "projects-a.json"),
    "SYS-B": path.join(root, "projects-b.json"),
  };
  const executors: Record<Side, FileReadingExecutor> = {
    "SYS-A": new FileReadingExecutor(projects["SYS-A"]),
    "SYS-B": new FileReadingExecutor(projects["SYS-B"]),
  };
  for (const side of ["SYS-A", "SYS-B"] as const) {
    fs.mkdirSync(projects[side]);
    fs.writeFileSync(registries[side], JSON.stringify({
      schema_version: "1.0",
      projects: [{ key: PROJECT, path: projects[side], peer_readable: true }],
    }));
  }
  const nodes: Record<Side, SignedPeerNode> = {
    "SYS-A": lab.newNode("SYS-A", ["SYS-B"], path.join(root, "a.sqlite3")),
    "SYS-B": lab.newNode("SYS-B", ["SYS-A"], path.join(root, "b.sqlite3")),
  };
  for (const [side, peer] of [["SYS-A", "SYS-B"], ["SYS-B", "SYS-A"]] as const) {
    nodes[side].database.registerResource(PROJECT);
    nodes[side].database.grantPeerResource(peer, PROJECT);
  }

  const answers = new Set<string>();
  let recovered = 0;
  let admitted = 0;
  for (let pair = 0; pair < 50; pair++) {
    for (const [callerId, recipientId] of [["SYS-A", "SYS-B"], ["SYS-B", "SYS-A"]] as const) {
      const sequence = admitted++;
      const source = path.join(projects[recipientId], SOURCE);
      fs.writeFileSync(source, `stale-${randomBytes(16).toString("hex")}`);
      const request = service(nodes[callerId]).askAgent({
        idempotencyKey: `signed-source-${sequence}-${callerId}`,
        targetNodeId: recipientId,
        projectId: PROJECT,
        subject: "Read an allowed public source file",
        request: `Read ${SOURCE} in the allowed project and report its current value.`,
        intent: "inspect",
        timeoutSeconds: 120,
      });
      expect(request.duplicate).toBe(false);
      expect(await nodes[callerId].worker.runOutboundOnce()).toBe(1);
      // Replayed signed broker deliveries must persist and execute only once.
      lab.broker.duplicate(recipientId);
      expect(await nodes[recipientId].worker.runInboundOnce()).toBe(2);
      expect(nodes[recipientId].database.getInboxMessage(request.task_id)).toMatchObject({
        authenticatedIngress: true,
      });

      const recoveryCase = pair % 10 === 0;
      if (recoveryCase) {
        nodes[recipientId] = await lab.reopen(recipientId);
        recovered++;
      }
      const fresh = randomBytes(24).toString("hex");
      expect(answers.has(fresh)).toBe(false);
      answers.add(fresh);
      fs.writeFileSync(source, fresh);
      const before = executors[recipientId].readValues.length;
      const dispatcher = new ReadOnlyDispatcher(
        dispatcherConfig(nodes[recipientId], registries[recipientId]),
        nodes[recipientId].database,
        ProjectRegistry.load(registries[recipientId]),
        executors[recipientId],
      );
      expect(await dispatcher.runOnce()).toBe(1);
      expect(await dispatcher.runOnce()).toBe(0);
      expect(executors[recipientId].readValues).toHaveLength(before + 1);
      expect(executors[recipientId].readValues.at(-1)).toBe(fresh);
      expect(await nodes[recipientId].worker.runOutboundOnce()).toBe(1);
      lab.broker.duplicate(callerId);
      if (recoveryCase) nodes[callerId] = await lab.reopen(callerId);
      expect(await nodes[callerId].worker.runInboundOnce()).toBe(2);
      if (recoveryCase) nodes[callerId] = await lab.reopen(callerId);

      const result = service(nodes[callerId]).getAgentResult(request.task_id);
      expect(result).toMatchObject({
        task_id: request.task_id,
        conversation_id: request.conversation_id,
        status: "completed",
        result: {
          project: PROJECT,
          body: `marker=${fresh}`,
          coordination_result: {
            request_message_id: request.task_id,
            outcome: "completed",
          },
        },
      });
      expect(typeof result.result_message_id).toBe("string");
      const received = nodes[callerId].database.getInboxMessage(result.result_message_id!);
      expect(received).toMatchObject({
        authenticatedIngress: true,
        envelope: {
          message_id: result.result_message_id,
          kind: "task_result",
          origin_system: recipientId,
          target_system: callerId,
          conversation_id: request.conversation_id,
          causation_id: request.task_id,
        },
      });
      expect(service(nodes[callerId]).getAgentThread(request.conversation_id, 10)).toMatchObject({
        count: 2,
      });
    }
  }
  expect(admitted).toBe(100);
  expect(recovered).toBe(10);
  expect(answers.size).toBe(100);
  expect(executors["SYS-A"].readValues).toHaveLength(50);
  expect(executors["SYS-B"].readValues).toHaveLength(50);

  for (const [callerId, recipientId] of [["SYS-A", "SYS-B"], ["SYS-B", "SYS-A"]] as const) {
    const before = executors[recipientId].readValues.length;
    const denied = service(nodes[callerId]).askAgent({
      idempotencyKey: `signed-source-denied-${callerId}`,
      targetNodeId: recipientId,
      projectId: "not-registered",
      subject: "Disallowed source",
      request: `Read ${SOURCE} from an unregistered project.`,
      intent: "inspect",
      timeoutSeconds: 120,
    });
    expect(await nodes[callerId].worker.runOutboundOnce()).toBe(1);
    expect(await nodes[recipientId].worker.runInboundOnce()).toBe(1);
    expect(await new ReadOnlyDispatcher(
      dispatcherConfig(nodes[recipientId], registries[recipientId]),
      nodes[recipientId].database,
      ProjectRegistry.load(registries[recipientId]),
      executors[recipientId],
    ).runOnce()).toBe(1);
    expect(executors[recipientId].readValues).toHaveLength(before);
    expect(await nodes[recipientId].worker.runOutboundOnce()).toBe(1);
    expect(await nodes[callerId].worker.runInboundOnce()).toBe(1);
    expect(service(nodes[callerId]).getAgentResult(denied.task_id)).toMatchObject({
      status: "rejected",
      result: { coordination_result: { request_message_id: denied.task_id, outcome: "rejected" } },
    });
  }
}, 120_000);

class FileReadingExecutor implements CodexExecutor {
  public readonly readValues: string[] = [];

  public constructor(private readonly allowedProject: string) {}

  public async execute(input: CodexExecutionInput): Promise<{ output: string }> {
    expect(input.projectPath).toBe(fs.realpathSync.native(this.allowedProject));
    expect(input.prompt).toContain(SOURCE);
    const value = fs.readFileSync(path.join(input.projectPath, SOURCE), "utf8");
    this.readValues.push(value);
    return { output: `marker=${value}` };
  }
}

function service(node: SignedPeerNode): AgentBridgeService {
  return new AgentBridgeService(node.config, node.database);
}

function dispatcherConfig(node: SignedPeerNode, projectsPath: string): ReadOnlyDispatcherConfig {
  return {
    ...node.config,
    projectsPath,
    codexExecutable: "unused-in-signed-source-fixture",
    codexExecutableSha256: "a".repeat(64),
    codexCodeModeHostExecutable: "unused-in-signed-source-fixture",
    codexCodeModeHostSha256: "b".repeat(64),
    codexHome: "unused-in-signed-source-fixture",
    trustedPath: "unused-in-signed-source-fixture",
    pollIntervalMs: 1000,
    defaultTimeoutSeconds: 300,
    maxOutputBytes: 48_000,
  };
}
