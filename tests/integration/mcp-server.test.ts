import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { AgentBridgeService } from "../../src/application/agent-bridge-service.js";
import type { BridgeConfig } from "../../src/config.js";
import { createEnvelope } from "../../src/contracts/envelope.js";
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
        "agent_bridge_ask_agent",
        "agent_bridge_claim",
        "agent_bridge_complete",
        "agent_bridge_continue_agent",
        "agent_bridge_fail",
        "agent_bridge_get_result",
        "agent_bridge_get_thread",
        "agent_bridge_list_inbox",
        "agent_bridge_read",
        "agent_bridge_renew_claim",
        "agent_bridge_reply",
        "agent_bridge_send",
        "agent_bridge_status",
      ].sort(),
    );
  });

  it("creates an idempotent coordination task and returns its linked result", async () => {
    const askArguments = {
      idempotency_key: "mcp-coordinate-1",
      project_id: "voiceai",
      subject: "Inspect VoiceAI",
      request: "Report the current repository state without modifying it.",
      intent: "inspect",
      timeout_seconds: 120,
    };
    const first = toolOutput(
      await client.callTool({
        name: "agent_bridge_ask_agent",
        arguments: askArguments,
      }),
    ) as {
      task_id: string;
      conversation_id: string;
      status: string;
      duplicate: boolean;
    };
    const duplicate = toolOutput(
      await client.callTool({
        name: "agent_bridge_ask_agent",
        arguments: askArguments,
      }),
    ) as {
      task_id: string;
      conversation_id: string;
      duplicate: boolean;
    };

    expect(first.status).toBe("queued");
    expect(first.duplicate).toBe(false);
    expect(duplicate).toMatchObject({
      task_id: first.task_id,
      conversation_id: first.conversation_id,
      duplicate: true,
    });

    const waiting = toolOutput(
      await client.callTool({
        name: "agent_bridge_get_result",
        arguments: { task_id: first.task_id },
      }),
    ) as { status: string };
    expect(waiting.status).toBe("queued");

    const result = createEnvelope({
      idempotencyKey: "mcp-coordinate-result-1",
      originSystem: "SYS-B",
      targetSystem: "SYS-A",
      kind: "task_result",
      streamId: "agent-coordination",
      conversationId: first.conversation_id,
      causationId: first.task_id,
      sequenceNumber: 1,
      payload: {
        subject: "VoiceAI inspection complete",
        body: "The approved checks pass.",
        project: "voiceai",
        evidence: [],
        coordination_result: {
          protocol_version: "1.0",
          request_message_id: first.task_id,
          outcome: "completed",
        },
      },
      expiresAtUtc: "2026-08-20T12:00:00.000Z",
      now: new Date("2026-08-13T12:00:00.000Z"),
    });
    database.persistIncoming(result, 1);

    const completed = toolOutput(
      await client.callTool({
        name: "agent_bridge_get_result",
        arguments: { task_id: first.task_id },
      }),
    ) as {
      status: string;
      result_message_id: string;
      result: { body: string };
    };
    expect(completed).toMatchObject({
      status: "completed",
      result_message_id: result.message_id,
      result: { body: "The approved checks pass." },
    });

    const followUp = toolOutput(
      await client.callTool({
        name: "agent_bridge_continue_agent",
        arguments: {
          idempotency_key: "mcp-coordinate-follow-up-1",
          previous_result_message_id: result.message_id,
          subject: "Clarify evidence",
          request: "Which checks support the answer?",
          timeout_seconds: 120,
        },
      }),
    ) as {
      task_id: string;
      conversation_id: string;
      sequence_number: number;
    };
    expect(followUp).toMatchObject({
      conversation_id: first.conversation_id,
      sequence_number: 2,
    });

    const thread = toolOutput(
      await client.callTool({
        name: "agent_bridge_get_thread",
        arguments: {
          conversation_id: first.conversation_id,
          limit: 20,
        },
      }),
    ) as { count: number; items: Array<{ message_id: string }> };
    expect(thread.count).toBe(3);
    expect(thread.items.map((item) => item.message_id)).toContain(
      followUp.task_id,
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

  it("executes the complete inbox lifecycle through native MCP tools", async () => {
    const retryMessage = incomingEnvelope("mcp-lifecycle-retry");
    database.persistIncoming(retryMessage, 1);

    const list = toolOutput(
      await client.callTool({
        name: "agent_bridge_list_inbox",
        arguments: { limit: 10, states: ["available"] },
      }),
    ) as { items: Array<{ message_id: string; state: string }> };
    expect(list.items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          message_id: retryMessage.message_id,
          state: "available",
        }),
      ]),
    );

    const read = toolOutput(
      await client.callTool({
        name: "agent_bridge_read",
        arguments: { message_id: retryMessage.message_id },
      }),
    ) as {
      envelope: {
        message_id: string;
        payload: { subject: string };
      };
      state: string;
    };
    expect(read.envelope.message_id).toBe(retryMessage.message_id);
    expect(read.envelope.payload.subject).toBe("MCP lifecycle");
    expect(read.state).toBe("available");

    const firstClaim = await claimMessage(retryMessage.message_id);
    const renewed = toolOutput(
      await client.callTool({
        name: "agent_bridge_renew_claim",
        arguments: {
          message_id: retryMessage.message_id,
          consumer_id: "mcp-consumer",
          claim_token: firstClaim.claim_token,
          lease_seconds: 120,
        },
      }),
    ) as { message_id: string; claim_until_utc: string };
    expect(renewed.message_id).toBe(retryMessage.message_id);
    expect(Date.parse(renewed.claim_until_utc)).toBeGreaterThan(Date.now());

    const retried = toolOutput(
      await client.callTool({
        name: "agent_bridge_fail",
        arguments: {
          message_id: retryMessage.message_id,
          consumer_id: "mcp-consumer",
          claim_token: firstClaim.claim_token,
          action: "retry",
          reason: "Synthetic retry verification.",
        },
      }),
    ) as { message_id: string; state: string };
    expect(retried).toEqual({
      message_id: retryMessage.message_id,
      state: "available",
    });

    const secondClaim = await claimMessage(retryMessage.message_id);
    const reply = toolOutput(
      await client.callTool({
        name: "agent_bridge_reply",
        arguments: {
          original_message_id: retryMessage.message_id,
          idempotency_key: "mcp-lifecycle-reply",
          kind: "task_result",
          payload: {
            subject: "MCP lifecycle reply",
            body: "The native MCP lifecycle completed.",
            evidence: [],
          },
        },
      }),
    ) as { accepted: boolean; state: string };
    expect(reply.accepted).toBe(true);
    expect(reply.state).toBe("pending");

    const completed = toolOutput(
      await client.callTool({
        name: "agent_bridge_complete",
        arguments: {
          message_id: retryMessage.message_id,
          consumer_id: "mcp-consumer",
          claim_token: secondClaim.claim_token,
        },
      }),
    ) as { message_id: string; state: string };
    expect(completed.state).toBe("processed");

    const completedAgain = toolOutput(
      await client.callTool({
        name: "agent_bridge_complete",
        arguments: {
          message_id: retryMessage.message_id,
          consumer_id: "mcp-consumer",
          claim_token: secondClaim.claim_token,
        },
      }),
    ) as { state: string };
    expect(completedAgain.state).toBe("processed");

    const rejectMessage = incomingEnvelope("mcp-lifecycle-reject");
    database.persistIncoming(rejectMessage, 1);
    const rejectedClaim = await claimMessage(rejectMessage.message_id);
    const rejected = toolOutput(
      await client.callTool({
        name: "agent_bridge_fail",
        arguments: {
          message_id: rejectMessage.message_id,
          consumer_id: "mcp-consumer",
          claim_token: rejectedClaim.claim_token,
          action: "reject",
          reason: "Synthetic rejection verification.",
        },
      }),
    ) as { state: string };
    expect(rejected.state).toBe("rejected");
    expect(database.getStatus().inbox).toMatchObject({
      processed: 1,
      rejected: 1,
    });
    expect(database.getStatus().outbox.pending).toBe(1);

    async function claimMessage(messageId: string): Promise<{
      claim_token: string;
    }> {
      const claim = toolOutput(
        await client.callTool({
          name: "agent_bridge_claim",
          arguments: {
            consumer_id: "mcp-consumer",
            limit: 1,
            lease_seconds: 60,
          },
        }),
      ) as {
        count: number;
        items: Array<{
          envelope: { message_id: string };
          claim_token: string;
        }>;
      };
      expect(claim.count).toBe(1);
      expect(claim.items[0]?.envelope.message_id).toBe(messageId);
      return claim.items[0]!;
    }
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

function incomingEnvelope(idempotencyKey: string) {
  return createEnvelope({
    idempotencyKey,
    originSystem: "SYS-B",
    targetSystem: "SYS-A",
    kind: "task_request",
    streamId: "mcp-lifecycle",
    payload: {
      subject: "MCP lifecycle",
      body: "Exercise the native coding-agent tool boundary.",
      evidence: [],
    },
    expiresAtUtc: "2026-08-20T12:00:00.000Z",
    now: new Date("2026-08-13T12:00:00.000Z"),
  });
}

function toolOutput(response: unknown): Record<string, unknown> {
  const result = response as {
    isError?: boolean;
    structuredContent?: Record<string, unknown>;
  };
  expect(result.isError).not.toBe(true);
  expect(result.structuredContent).toBeDefined();
  return result.structuredContent!;
}
