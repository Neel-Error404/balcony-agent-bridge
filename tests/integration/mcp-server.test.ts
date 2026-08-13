import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { AgentBridgeService } from "../../src/application/agent-bridge-service.js";
import type { BridgeConfig } from "../../src/config.js";
import { createMcpServer } from "../../src/mcp/server.js";
import { BridgeDatabase } from "../../src/storage/database.js";

describe("MCP server", () => {
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
      name: "balcony-agent-bridge-test-client",
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

  it("advertises the bounded bridge tool surface", async () => {
    const tools = await client.listTools();
    expect(tools.tools.map((tool) => tool.name).sort()).toEqual(
      [
        "agent_bridge_claim",
        "agent_bridge_complete",
        "agent_bridge_fail",
        "agent_bridge_list_inbox",
        "agent_bridge_read",
        "agent_bridge_renew_claim",
        "agent_bridge_reply",
        "agent_bridge_send",
        "agent_bridge_status",
      ].sort(),
    );
  });

  it("durably enqueues through MCP and reports local status", async () => {
    const send = await client.callTool({
      name: "agent_bridge_send",
      arguments: {
        idempotency_key: "mcp-send-1",
        kind: "task_request",
        stream_id: "mcp-test",
        payload: {
          subject: "Review MCP",
          body: "Run the integration test.",
          evidence: [],
        },
      },
    });
    expect(send.isError).not.toBe(true);

    const status = await client.callTool({
      name: "agent_bridge_status",
      arguments: {},
    });
    expect(status.isError).not.toBe(true);
    expect(database.getStatus().outbox.pending).toBe(1);
  });

  it("returns an actionable tool error for unsafe payloads", async () => {
    const response = await client.callTool({
      name: "agent_bridge_send",
      arguments: {
        idempotency_key: "unsafe-mcp",
        kind: "message",
        stream_id: "mcp-test",
        payload: {
          subject: "Unsafe",
          body: "-----BEGIN PRIVATE KEY-----",
          evidence: [],
        },
      },
    });
    expect(response.isError).toBe(true);
    expect(JSON.stringify(response.content)).toContain("forbidden");
    expect(database.getStatus().outbox.pending).toBe(0);
  });

  it("does not expose free-form state-transition identifiers", async () => {
    const privateMessageId = "12345678-1234-4234-9234-123456789abc";
    const response = await client.callTool({
      name: "agent_bridge_read",
      arguments: { message_id: privateMessageId },
    });

    expect(response.isError).toBe(true);
    expect(JSON.stringify(response.content)).toContain(
      "STATE_TRANSITION_ERROR",
    );
    expect(JSON.stringify(response.content)).not.toContain(privateMessageId);
  });

  it("returns only a normalized heartbeat error code in status", async () => {
    database.recordBridgeHeartbeat(
      "test-instance",
      "degraded",
      "https://private-host/sensitive",
    );

    const status = await client.callTool({
      name: "agent_bridge_status",
      arguments: {},
    });

    expect(status.isError).not.toBe(true);
    expect(JSON.stringify(status.content)).toContain(
      "UNKNOWN_TRANSPORT_ERROR",
    );
    expect(JSON.stringify(status.content)).not.toContain("private-host");
  });
});
