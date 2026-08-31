import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { ZodError, z } from "zod";

import { AgentBridgeService } from "../application/agent-bridge-service.js";
import { CoordinationIntentSchema } from "../contracts/coordination.js";
import {
  MESSAGE_KINDS,
  MessageKindSchema,
  MessagePayloadSchema,
  SystemIdSchema,
} from "../contracts/envelope.js";
import { BridgeError } from "../errors.js";
import {
  safeBridgeErrorMessage,
  safeErrorCode,
} from "../security/sanitize-error.js";

const MessageKindArraySchema = z.array(MessageKindSchema).max(
  MESSAGE_KINDS.length,
);

export function createMcpServer(service: AgentBridgeService): McpServer {
  const server = new McpServer({
    name: "balcony-agent-bridge-mcp-server",
    version: "0.3.0",
  });

  server.registerTool(
    "agent_bridge_send",
    {
      title: "Send Agent Bridge Message",
      description:
        "Durably enqueue a secret-safe message for an explicitly authorized target node. Success means the local outbox accepted it, not that the target has processed it.",
      inputSchema: {
        idempotency_key: z.string().trim().min(1).max(128),
        target_node_id: SystemIdSchema,
        kind: MessageKindSchema,
        stream_id: z.string().trim().min(1).max(128),
        payload: MessagePayloadSchema,
        conversation_id: z.string().uuid().optional(),
        correlation_id: z.string().uuid().optional(),
        causation_id: z.string().uuid().optional(),
        sequence_number: z.number().int().nonnegative().optional(),
        expires_at_utc: z.string().datetime({ offset: true }).optional(),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async (input) =>
      toolResult(() =>
        service.send({
          idempotencyKey: input.idempotency_key,
          targetNodeId: input.target_node_id,
          kind: input.kind,
          streamId: input.stream_id,
          payload: input.payload,
          ...(input.conversation_id
            ? { conversationId: input.conversation_id }
            : {}),
          ...(input.correlation_id
            ? { correlationId: input.correlation_id }
            : {}),
          ...(input.causation_id
            ? { causationId: input.causation_id }
            : {}),
          ...(input.sequence_number !== undefined
            ? { sequenceNumber: input.sequence_number }
            : {}),
          ...(input.expires_at_utc
            ? { expiresAtUtc: input.expires_at_utc }
            : {}),
        }),
      ),
  );

  server.registerTool(
    "agent_bridge_ask_agent",
    {
      title: "Ask Peer Project Agent",
      description:
        "Create a durable, read-only project question for an explicitly authorized target node. Returns a task ID immediately; use agent_bridge_get_result to observe delivery and retrieve the eventual answer.",
      inputSchema: {
        idempotency_key: z.string().trim().min(1).max(128),
        target_node_id: SystemIdSchema,
        project_id: z.string().trim().min(1).max(120),
        subject: z.string().trim().min(1).max(200),
        request: z.string().trim().min(1).max(12_000),
        intent: CoordinationIntentSchema.default("question"),
        timeout_seconds: z.number().int().min(30).max(600).default(300),
        evidence_mode: z.literal("pinned_git").optional(),
        conversation_id: z.string().uuid().optional(),
        expires_at_utc: z.string().datetime({ offset: true }).optional(),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async (input) =>
      toolResult(() =>
        service.askAgent({
          idempotencyKey: input.idempotency_key,
          targetNodeId: input.target_node_id,
          projectId: input.project_id,
          subject: input.subject,
          request: input.request,
          intent: input.intent,
          timeoutSeconds: input.timeout_seconds,
          ...(input.evidence_mode
            ? { evidenceMode: input.evidence_mode }
            : {}),
          ...(input.conversation_id
            ? { conversationId: input.conversation_id }
            : {}),
          ...(input.expires_at_utc
            ? { expiresAtUtc: input.expires_at_utc }
            : {}),
        }),
      ),
  );

  server.registerTool(
    "agent_bridge_get_result",
    {
      title: "Get Peer Agent Result",
      description:
        "Return the local delivery state and, when available, the result for a task created by agent_bridge_ask_agent.",
      inputSchema: {
        task_id: z.string().uuid(),
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ task_id }) =>
      toolResult(() => service.getAgentResult(task_id)),
  );

  server.registerTool(
    "agent_bridge_continue_agent",
    {
      title: "Continue Peer Agent Discussion",
      description:
        "Create the next bounded read-only turn after a completed peer result. The bridge preserves the project, conversation, causation, and sequence chain.",
      inputSchema: {
        idempotency_key: z.string().trim().min(1).max(128),
        previous_result_message_id: z.string().uuid(),
        subject: z.string().trim().min(1).max(200),
        request: z.string().trim().min(1).max(12_000),
        intent: CoordinationIntentSchema.default("question"),
        timeout_seconds: z.number().int().min(30).max(600).default(300),
        expires_at_utc: z.string().datetime({ offset: true }).optional(),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async (input) =>
      toolResult(() =>
        service.continueAgent({
          idempotencyKey: input.idempotency_key,
          previousResultMessageId: input.previous_result_message_id,
          subject: input.subject,
          request: input.request,
          intent: input.intent,
          timeoutSeconds: input.timeout_seconds,
          ...(input.expires_at_utc
            ? { expiresAtUtc: input.expires_at_utc }
            : {}),
        }),
      ),
  );

  server.registerTool(
    "agent_bridge_get_thread",
    {
      title: "Get Peer Agent Discussion",
      description:
        "Return a bounded ordered view of a local coordination conversation created by this system.",
      inputSchema: {
        conversation_id: z.string().uuid(),
        limit: z.number().int().min(1).max(100).default(20),
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ conversation_id, limit }) =>
      toolResult(() => service.getAgentThread(conversation_id, limit)),
  );

  server.registerTool(
    "agent_bridge_list_inbox",
    {
      title: "List Agent Bridge Inbox",
      description:
        "List bounded inbox metadata without claiming messages or returning message bodies.",
      inputSchema: {
        limit: z.number().int().min(1).max(100).default(20),
        states: z
          .array(
            z.enum([
              "available",
              "claimed",
              "processed",
              "rejected",
              "quarantined",
            ]),
          )
          .max(5)
          .optional(),
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ limit, states }) =>
      toolResult(() => ({
        items: service.listInbox(limit, states),
      })),
  );

  server.registerTool(
    "agent_bridge_read",
    {
      title: "Read Agent Bridge Message",
      description:
        "Read one local inbox message by message ID without claiming it.",
      inputSchema: {
        message_id: z.string().uuid(),
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ message_id }) =>
      toolResult(() => service.readMessage(message_id)),
  );

  server.registerTool(
    "agent_bridge_claim",
    {
      title: "Claim Agent Bridge Work",
      description:
        "Atomically claim locally persisted inbox messages for bounded processing. Returns claim tokens required for renewal or settlement.",
      inputSchema: {
        consumer_id: z.string().trim().min(1).max(128),
        limit: z.number().int().min(1).max(20).default(1),
        lease_seconds: z.number().int().min(15).max(900).default(300),
        kinds: MessageKindArraySchema.optional(),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    async ({ consumer_id, limit, lease_seconds, kinds }) =>
      toolResult(() =>
        service.claim({
          consumerId: consumer_id,
          limit,
          leaseSeconds: lease_seconds,
          ...(kinds ? { kinds } : {}),
        }),
      ),
  );

  server.registerTool(
    "agent_bridge_renew_claim",
    {
      title: "Renew Agent Bridge Claim",
      description:
        "Renew a valid unexpired local inbox claim using its opaque claim token.",
      inputSchema: {
        message_id: z.string().uuid(),
        consumer_id: z.string().trim().min(1).max(128),
        claim_token: z.string().min(20).max(256),
        lease_seconds: z.number().int().min(15).max(900).default(300),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    async ({ message_id, consumer_id, claim_token, lease_seconds }) =>
      toolResult(() =>
        service.renewClaim(
          message_id,
          consumer_id,
          claim_token,
          lease_seconds,
        ),
      ),
  );

  server.registerTool(
    "agent_bridge_complete",
    {
      title: "Complete Agent Bridge Work",
      description:
        "Mark a claimed inbox message processed. Repeating the same terminal completion is idempotent.",
      inputSchema: {
        message_id: z.string().uuid(),
        consumer_id: z.string().trim().min(1).max(128),
        claim_token: z.string().min(20).max(256),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ message_id, consumer_id, claim_token }) =>
      toolResult(() =>
        service.acknowledge(
          message_id,
          consumer_id,
          claim_token,
          "processed",
        ),
      ),
  );

  server.registerTool(
    "agent_bridge_fail",
    {
      title: "Fail Or Retry Agent Bridge Work",
      description:
        "Return a claimed message to the available inbox or reject it terminally with an explicit reason.",
      inputSchema: {
        message_id: z.string().uuid(),
        consumer_id: z.string().trim().min(1).max(128),
        claim_token: z.string().min(20).max(256),
        action: z.enum(["retry", "reject"]),
        reason: z.string().trim().min(1).max(2000),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    async ({ message_id, consumer_id, claim_token, action, reason }) =>
      toolResult(() =>
        service.acknowledge(
          message_id,
          consumer_id,
          claim_token,
          action === "retry" ? "retry" : "rejected",
          reason,
        ),
      ),
  );

  server.registerTool(
    "agent_bridge_reply",
    {
      title: "Reply Through Agent Bridge",
      description:
        "Durably enqueue a reply that preserves the original conversation and causation identifiers.",
      inputSchema: {
        original_message_id: z.string().uuid(),
        idempotency_key: z.string().trim().min(1).max(128),
        kind: MessageKindSchema.default("message"),
        payload: MessagePayloadSchema,
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async ({ original_message_id, idempotency_key, kind, payload }) =>
      toolResult(() =>
        service.reply(
          original_message_id,
          idempotency_key,
          kind,
          payload,
        ),
      ),
  );

  server.registerTool(
    "agent_bridge_status",
    {
      title: "Get Agent Bridge Status",
      description:
        "Return bounded local queue counts and background bridge heartbeat state without exposing credentials or raw endpoints.",
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async () => toolResult(() => service.status()),
  );

  return server;
}

async function toolResult(
  operation: () => Record<string, unknown>,
): Promise<{
  isError?: boolean;
  content: Array<{ type: "text"; text: string }>;
  structuredContent?: Record<string, unknown>;
}> {
  try {
    const output = operation();
    return {
      content: [{ type: "text", text: JSON.stringify(output) }],
      structuredContent: output,
    };
  } catch (error) {
    if (error instanceof BridgeError) {
      const output = {
        error: {
          code: error.code,
          message: safeBridgeErrorMessage(error.code),
        },
      };
      return {
        isError: true,
        content: [{ type: "text", text: JSON.stringify(output) }],
        structuredContent: output,
      };
    }
    if (error instanceof ZodError) {
      const output = {
        error: {
          code: "VALIDATION_ERROR",
          message: error.issues
            .map((issue) => issue.message)
            .join("; "),
        },
      };
      return {
        isError: true,
        content: [{ type: "text", text: JSON.stringify(output) }],
        structuredContent: output,
      };
    }

    console.error(
      `Unexpected MCP tool failure (${safeErrorCode(error)})`,
    );
    const output = {
      error: {
        code: "INTERNAL_ERROR",
        message:
          "The bridge encountered an unexpected local error. Inspect the bridge stderr log.",
      },
    };
    return {
      isError: true,
      content: [{ type: "text", text: JSON.stringify(output) }],
      structuredContent: output,
    };
  }
}
