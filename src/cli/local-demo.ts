import { AgentBridgeService } from "../application/agent-bridge-service.js";
import { BridgeWorker } from "../bridge/worker.js";
import type { BridgeConfig } from "../config.js";
import { BridgeDatabase } from "../storage/database.js";
import { FakeBridgeTransport } from "../transport/fake-transport.js";

export interface LocalDemoResult {
  demo: "local-fake-transport";
  azure_used: false;
  nodes: ["demo-a", "demo-b", "demo-c"];
  direct_route: {
    from: "demo-a";
    to: "demo-c";
  };
  wrong_target: {
    node: "demo-b";
    reason: "WrongTargetSystem";
  };
  duplicate_delivery: {
    node: "demo-c";
    inbox_available: 1;
  };
  reply_route: {
    from: "demo-c";
    to: "demo-a";
  };
  result: "passed";
}

export async function runLocalDemo(): Promise<LocalDemoResult> {
  const nodeADatabase = new BridgeDatabase(":memory:");
  const nodeBDatabase = new BridgeDatabase(":memory:");
  const nodeCDatabase = new BridgeDatabase(":memory:");
  const nodeATransport = new FakeBridgeTransport();
  const nodeBTransport = new FakeBridgeTransport();
  const nodeCTransport = new FakeBridgeTransport();

  try {
    const nodeAConfig = demoConfig("demo-a", ["demo-b", "demo-c"]);
    const nodeBConfig = demoConfig("demo-b", ["demo-a", "demo-c"]);
    const nodeCConfig = demoConfig("demo-c", ["demo-a", "demo-b"]);
    const nodeAService = new AgentBridgeService(nodeAConfig, nodeADatabase);
    const nodeCService = new AgentBridgeService(nodeCConfig, nodeCDatabase);
    const nodeAWorker = new BridgeWorker(
      nodeAConfig,
      nodeADatabase,
      nodeATransport,
    );
    const nodeBWorker = new BridgeWorker(
      nodeBConfig,
      nodeBDatabase,
      nodeBTransport,
    );
    const nodeCWorker = new BridgeWorker(
      nodeCConfig,
      nodeCDatabase,
      nodeCTransport,
    );

    const sent = nodeAService.send({
      idempotencyKey: "local-demo-a-to-c",
      targetNodeId: "demo-c",
      kind: "message",
      streamId: "local-demo",
      payload: {
        subject: "Local demo request",
        body: "Demonstrate isolated fake-transport delivery.",
        evidence: [],
      },
      expiresAtUtc: "2099-01-01T00:00:00.000Z",
    });
    await nodeAWorker.runOutboundOnce();
    const request = nodeATransport.sent[0];
    if (!request) {
      throw new Error("Local demo did not produce an outbound request");
    }

    nodeBTransport.queueInbound({
      body: request,
      brokerMessageId: request.message_id,
      sessionId: request.conversation_id,
    });
    nodeCTransport.queueInbound({
      body: request,
      brokerMessageId: request.message_id,
      sessionId: request.conversation_id,
    });
    nodeCTransport.queueInbound({
      body: request,
      brokerMessageId: request.message_id,
      deliveryCount: 2,
      sessionId: request.conversation_id,
    });

    await nodeBWorker.runInboundOnce();
    await nodeCWorker.runInboundOnce();
    if (nodeBTransport.inbound[0]?.deadLetterReason !== "WrongTargetSystem") {
      throw new Error("Local demo did not reject the wrong target");
    }
    if (nodeCDatabase.getStatus().inbox.available !== 1) {
      throw new Error("Local demo did not deduplicate the target delivery");
    }

    nodeCService.reply(sent.message_id, "local-demo-c-reply", "message", {
      subject: "Local demo reply",
      body: "The target node received the local demo request.",
      evidence: [],
    });
    await nodeCWorker.runOutboundOnce();
    const reply = nodeCTransport.sent[0];
    if (!reply) {
      throw new Error("Local demo did not produce a reply");
    }
    if (reply.target_system !== "demo-a") {
      throw new Error("Local demo reply did not preserve the causal target");
    }
    nodeATransport.queueInbound({
      body: reply,
      brokerMessageId: reply.message_id,
      sessionId: reply.conversation_id,
    });
    await nodeAWorker.runInboundOnce();
    if (nodeADatabase.getStatus().inbox.available !== 1) {
      throw new Error("Local demo did not deliver the reply");
    }

    return {
      demo: "local-fake-transport",
      azure_used: false,
      nodes: ["demo-a", "demo-b", "demo-c"],
      direct_route: {
        from: "demo-a",
        to: "demo-c",
      },
      wrong_target: {
        node: "demo-b",
        reason: "WrongTargetSystem",
      },
      duplicate_delivery: {
        node: "demo-c",
        inbox_available: 1,
      },
      reply_route: {
        from: "demo-c",
        to: "demo-a",
      },
      result: "passed",
    };
  } finally {
    await Promise.all([
      nodeATransport.close(),
      nodeBTransport.close(),
      nodeCTransport.close(),
    ]);
    nodeADatabase.close();
    nodeBDatabase.close();
    nodeCDatabase.close();
  }
}

function demoConfig(
  systemId: "demo-a" | "demo-b" | "demo-c",
  authorizedNodeIds: string[],
): BridgeConfig {
  return {
    systemId,
    authorizedNodeIds,
    databasePath: ":memory:",
    topicName: "agent-messages",
    subscriptionName: systemId,
    azureAuthMode: "managed_identity",
  };
}
