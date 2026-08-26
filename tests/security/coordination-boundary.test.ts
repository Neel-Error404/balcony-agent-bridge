import fs from "node:fs";
import path from "node:path";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { AgentBridgeService } from "../../src/application/agent-bridge-service.js";
import type { BridgeConfig } from "../../src/config.js";
import { createEnvelope } from "../../src/contracts/envelope.js";
import { createMcpServer } from "../../src/mcp/server.js";
import { BridgeDatabase } from "../../src/storage/database.js";

describe("coordination security boundary", () => {
  let database: BridgeDatabase;
  let client: Client;
  let closeServer: () => Promise<void>;

  beforeEach(async () => {
    database = new BridgeDatabase(":memory:");
    const config: BridgeConfig = {
      systemId: "SYS-A",
      authorizedNodeIds: ["SYS-B", "node-c"],
      databasePath: ":memory:",
      topicName: "agent-messages",
      subscriptionName: "sys-a",
      azureAuthMode: "managed_identity",
    };
    const server = createMcpServer(new AgentBridgeService(config, database));
    client = new Client({
      name: "coordination-security-test-client",
      version: "0.1.0",
    });
    const [clientTransport, serverTransport] =
      InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    closeServer = async () => server.close();
  });

  afterEach(async () => {
    await client.close();
    await closeServer();
    database.close();
  });

  it("rejects secret-bearing high-level requests before persistence", async () => {
    const response = await client.callTool({
      name: "agent_bridge_ask_agent",
      arguments: {
        idempotency_key: "unsafe-coordination-request",
        target_node_id: "SYS-B",
        project_id: "voiceai",
        subject: "Unsafe inspection",
        request: ["Inspect this: -----BEGIN ", "PRIVATE KEY-----"].join(""),
      },
    });

    expect(response.isError).toBe(true);
    expect(JSON.stringify(response.content)).toContain("forbidden");
    expect(database.getStatus().outbox.pending).toBe(0);
  });

  it("redacts unknown task identifiers from high-level result errors", async () => {
    const privateTaskId = "12345678-1234-4234-9234-123456789abc";
    const response = await client.callTool({
      name: "agent_bridge_get_result",
      arguments: { task_id: privateTaskId },
    });

    expect(response.isError).toBe(true);
    expect(JSON.stringify(response.content)).toContain(
      "STATE_TRANSITION_ERROR",
    );
    expect(JSON.stringify(response.content)).not.toContain(privateTaskId);
  });

  it("ignores a wrong-node result without hiding the requested node's result", async () => {
    const ask = (
      await client.callTool({
        name: "agent_bridge_ask_agent",
        arguments: {
          idempotency_key: "wrong-authorized-result-route",
          target_node_id: "SYS-B",
          project_id: "voiceai",
          subject: "Inspect VoiceAI",
          request: "Report current state.",
        },
      })
    ).structuredContent as { task_id: string; conversation_id: string };
    const wrongNodeReply = createEnvelope({
      idempotencyKey: "wrong-authorized-result",
      originSystem: "node-c",
      targetSystem: "SYS-A",
      kind: "task_result",
      streamId: "agent-coordination",
      conversationId: ask.conversation_id,
      causationId: ask.task_id,
      payload: {
        subject: "Unexpected result",
        body: "This result came from the wrong authorized node.",
        project: "voiceai",
        evidence: [],
        coordination_result: {
          protocol_version: "1.0",
          request_message_id: ask.task_id,
          outcome: "completed",
        },
      },
    });
    database.persistIncoming(wrongNodeReply, 1, new Date(), true);

    const waiting = await client.callTool({
      name: "agent_bridge_get_result",
      arguments: { task_id: ask.task_id },
    });

    expect(waiting.isError).not.toBe(true);
    expect(waiting.structuredContent).toMatchObject({ status: "queued" });

    const expectedReply = createEnvelope({
      idempotencyKey: "expected-authorized-result",
      originSystem: "SYS-B",
      targetSystem: "SYS-A",
      kind: "task_result",
      streamId: "agent-coordination",
      conversationId: ask.conversation_id,
      causationId: ask.task_id,
      payload: {
        subject: "Expected result",
        body: "This result came from the requested node.",
        project: "voiceai",
        evidence: [],
        coordination_result: {
          protocol_version: "1.0",
          request_message_id: ask.task_id,
          outcome: "completed",
        },
      },
    });
    database.persistIncoming(expectedReply, 1, new Date(), true);

    const completed = await client.callTool({
      name: "agent_bridge_get_result",
      arguments: { task_id: ask.task_id },
    });

    expect(completed.isError).not.toBe(true);
    expect(completed.structuredContent).toMatchObject({
      status: "completed",
      result_message_id: expectedReply.message_id,
    });
  });

  it("rejects a follow-up when the peer changes the thread project", async () => {
    const askResponse = await client.callTool({
      name: "agent_bridge_ask_agent",
      arguments: {
        idempotency_key: "project-boundary-request",
        target_node_id: "SYS-B",
        project_id: "voiceai",
        subject: "Inspect VoiceAI",
        request: "Report current state.",
      },
    });
    const ask = askResponse.structuredContent as {
      task_id: string;
      conversation_id: string;
    };
    const mismatchedResult = createEnvelope({
      idempotencyKey: "project-boundary-result",
      originSystem: "SYS-B",
      targetSystem: "SYS-A",
      kind: "task_result",
      streamId: "agent-coordination",
      conversationId: ask.conversation_id,
      causationId: ask.task_id,
      sequenceNumber: 1,
      payload: {
        subject: "Mismatched result",
        body: "This result changed projects.",
        project: "trading",
        evidence: [],
        coordination_result: {
          protocol_version: "1.0",
          request_message_id: ask.task_id,
          outcome: "completed",
        },
      },
    });
    database.persistIncoming(mismatchedResult, 1, new Date(), true);

    const response = await client.callTool({
      name: "agent_bridge_continue_agent",
      arguments: {
        idempotency_key: "project-boundary-follow-up",
        previous_result_message_id: mismatchedResult.message_id,
        subject: "Continue",
        request: "Continue the discussion.",
      },
    });

    expect(response.isError).toBe(true);
    expect(database.getStatus().outbox.pending).toBe(1);
  });
});

describe("dispatcher activation boundary", () => {
  it("keeps automatic dispatch out of MCP and bridge process startup", () => {
    const repositoryRoot = path.resolve(import.meta.dirname, "../..");
    const mcpEntry = fs.readFileSync(
      path.join(repositoryRoot, "src", "mcp", "index.ts"),
      "utf8",
    );
    const bridgeEntry = fs.readFileSync(
      path.join(repositoryRoot, "src", "bridge", "index.ts"),
      "utf8",
    );
    const packageJson = JSON.parse(
      fs.readFileSync(path.join(repositoryRoot, "package.json"), "utf8"),
    ) as { scripts: Record<string, string> };

    expect(mcpEntry).not.toMatch(/dispatcher/u);
    expect(bridgeEntry).not.toMatch(/dispatcher/u);
    expect(packageJson.scripts["start:mcp"]).not.toContain("dispatcher");
    expect(packageJson.scripts["start:bridge"]).not.toContain("dispatcher");
    expect(packageJson.scripts["start:dispatcher"]).toBe(
      "node dist/dispatcher/index.js",
    );
  });
});
