import fs from "node:fs";
import path from "node:path";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { AgentBridgeService } from "../../src/application/agent-bridge-service.js";
import type { BridgeConfig } from "../../src/config.js";
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
      peerSystemId: "SYS-B",
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
        project_id: "voiceai",
        subject: "Unsafe inspection",
        request: "Inspect this: -----BEGIN PRIVATE KEY-----",
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
