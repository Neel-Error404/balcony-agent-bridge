import { createHash, generateKeyPairSync, type KeyObject } from "node:crypto";
import path from "node:path";

import type {
  ServiceBusMessage,
  ServiceBusReceivedMessage,
  ServiceBusSessionReceiver,
} from "@azure/service-bus";

import type { BridgeConfig } from "../../src/config.js";
import { SystemIdSchema, type SystemId } from "../../src/contracts/envelope.js";
import { MessageAuthenticator } from "../../src/security/message-authentication.js";
import { BridgeDatabase } from "../../src/storage/database.js";
import { PeerCheckService } from "../../src/bridge/peer-check.js";
import { BridgeWorker } from "../../src/bridge/worker.js";
import {
  ServiceBusBridgeTransport,
  type ServiceBusClientAdapter,
  type ServiceBusClientFactory,
} from "../../src/transport/service-bus-transport.js";

type KeyStatus = "active" | "revoked";
type Settlement = "available" | "locked" | "completed" | "dead-lettered";

interface Identity {
  privateKey: KeyObject;
  spkiDer: Buffer;
  keyId: string;
}

interface NodeDefinition {
  config: BridgeConfig;
  peerStatuses: Partial<Record<SystemId, KeyStatus>>;
}

interface QueuedMessage {
  wire: ServiceBusMessage;
  sequenceNumber: number;
  deliveryCount: number;
  settlement: Settlement;
  lock?: symbol;
  deadLetterReason?: string;
  deadLetterDescription?: string;
}

export interface SignedPeerNode {
  config: BridgeConfig;
  database: BridgeDatabase;
  authenticator: MessageAuthenticator;
  transport: ServiceBusBridgeTransport;
  checks: PeerCheckService;
  worker: BridgeWorker;
}

/** In-process SDK boundary; transport signing and verification remain production code. */
export class SignedPeerLab {
  public readonly broker = new PeerLabBroker();
  private readonly identities = new Map<SystemId, Identity>();
  private readonly definitions = new Map<SystemId, NodeDefinition>();
  private readonly nodes = new Map<SystemId, SignedPeerNode>();

  public newNode(
    id: SystemId,
    authorizedNodeIds: readonly SystemId[],
    databasePath: string,
    peerStatuses: Partial<Record<SystemId, KeyStatus>> = {},
  ): SignedPeerNode {
    SystemIdSchema.parse(id);
    if (!path.isAbsolute(databasePath) || databasePath === ":memory:") {
      throw new Error("Peer lab requires an absolute file-backed database path");
    }
    if (
      this.definitions.has(id) ||
      authorizedNodeIds.length === 0 ||
      new Set(authorizedNodeIds).size !== authorizedNodeIds.length ||
      authorizedNodeIds.includes(id)
    ) {
      throw new Error(`Invalid or duplicate peer lab node '${id}'`);
    }
    for (const peerId of authorizedNodeIds) {
      SystemIdSchema.parse(peerId);
      this.identity(peerId);
    }
    this.identity(id);
    const config: BridgeConfig = {
      systemId: id,
      authorizedNodeIds: [...authorizedNodeIds],
      databasePath,
      topicName: "agent-messages",
      subscriptionName: id,
      azureAuthMode: "managed_identity",
    };
    this.definitions.set(id, { config, peerStatuses: { ...peerStatuses } });
    try {
      return this.open(id);
    } catch (error) {
      this.definitions.delete(id);
      throw error;
    }
  }

  /** Changing peer membership takes effect only on a fresh authenticator. */
  public async reopen(
    id: SystemId,
    peerStatuses?: Partial<Record<SystemId, KeyStatus>>,
  ): Promise<SignedPeerNode> {
    const definition = this.definition(id);
    const current = this.nodes.get(id);
    if (current) {
      await current.transport.close();
      current.database.close();
      this.nodes.delete(id);
    }
    if (peerStatuses) {
      definition.peerStatuses = { ...definition.peerStatuses, ...peerStatuses };
    }
    return this.open(id);
  }

  public async close(): Promise<void> {
    for (const [id, node] of this.nodes) {
      try {
        await node.transport.close();
      } finally {
        node.database.close();
        this.nodes.delete(id);
      }
    }
    // Caller owns the supplied database paths. No files are deleted.
  }

  private open(id: SystemId): SignedPeerNode {
    const { config, peerStatuses } = this.definition(id);
    const identity = this.identity(id);
    const membership = {
      schema_version: "1.0" as const,
      network_id: "peer-lab",
      peers: config.authorizedNodeIds.map((peerId) => {
        const peer = this.identity(peerId);
        return {
          node_id: peerId,
          keys: [{
            key_id: peer.keyId,
            spki_der_base64url: peer.spkiDer.toString("base64url"),
            status: peerStatuses[peerId] ?? "active",
          }],
        };
      }),
    };
    const authenticator = new MessageAuthenticator(
      id,
      membership,
      identity.privateKey,
      identity.keyId,
    );
    const database = new BridgeDatabase(config.databasePath);
    try {
      const transport = new ServiceBusBridgeTransport(
        config,
        authenticator,
        undefined,
        this.broker.factory(id),
      );
      const checks = new PeerCheckService(config, database, authenticator.networkId);
      const worker = new BridgeWorker(config, database, transport, checks);
      const node = { config, database, authenticator, transport, checks, worker };
      this.nodes.set(id, node);
      return node;
    } catch (error) {
      database.close();
      throw error;
    }
  }

  private definition(id: SystemId): NodeDefinition {
    const definition = this.definitions.get(id);
    if (!definition) throw new Error(`Unknown peer lab node '${id}'`);
    return definition;
  }

  private identity(id: SystemId): Identity {
    let identity = this.identities.get(id);
    if (!identity) {
      const pair = generateKeyPairSync("ed25519");
      const spkiDer = pair.publicKey.export({ format: "der", type: "spki" }) as Buffer;
      identity = {
        privateKey: pair.privateKey,
        spkiDer,
        keyId: `ed25519:${createHash("sha256").update(spkiDer).digest("base64url")}`,
      };
      this.identities.set(id, identity);
    }
    return identity;
  }
}

/** Only the Azure SDK adapter is simulated; queues outlive node restarts. */
export class PeerLabBroker {
  private readonly queues = new Map<SystemId, QueuedMessage[]>();
  private sequence = 0;
  private sendFailure = false;
  private completeFailure = false;
  private receiverCloseFailure = false;

  public failNextSend(): void { this.sendFailure = true; }
  public failNextComplete(): void { this.completeFailure = true; }
  public failNextReceiverClose(): void { this.receiverCloseFailure = true; }

  public queue(target: SystemId): ReadonlyArray<{
    wire: ServiceBusMessage;
    deliveryCount: number;
    settlement: Settlement;
    deadLetterReason?: string;
    deadLetterDescription?: string;
  }> {
    return this.entries(target).map(({ wire, deliveryCount, settlement, deadLetterReason, deadLetterDescription }) => ({
      wire: clone(wire),
      deliveryCount,
      settlement,
      ...(deadLetterReason ? { deadLetterReason } : {}),
      ...(deadLetterDescription ? { deadLetterDescription } : {}),
    }));
  }

  public duplicate(target: SystemId, index = 0): void {
    const source = this.pending(target, index);
    this.entries(target).push(this.copy(source.wire));
  }

  public reverseQueue(target: SystemId): void {
    this.entries(target).reverse();
  }

  public mutateSignedBody(
    target: SystemId,
    mutate: (body: unknown) => unknown,
    index = 0,
  ): void {
    const message = this.pending(target, index);
    message.wire.body = clone(mutate(clone(message.wire.body)));
  }

  /** Move the unchanged signed wire and broker metadata to another subscription. */
  public reroute(target: SystemId, wrongTarget: SystemId, index = 0): void {
    const message = this.pending(target, index);
    this.entries(target).splice(this.entries(target).indexOf(message), 1);
    this.entries(wrongTarget).push(message);
  }

  public factory(nodeId: SystemId): ServiceBusClientFactory {
    return (_role) => ({
      createSender: () => ({
        sendMessages: async (wire: ServiceBusMessage) => {
          if (this.sendFailure) {
            this.sendFailure = false;
            throw new Error("Peer lab injected send failure");
          }
          const target = wire.applicationProperties?.["bridgeTarget"];
          if (typeof target !== "string") {
            throw new Error("Peer lab send requires bridgeTarget metadata");
          }
          this.entries(target).push(this.copy(wire));
        },
        close: async () => undefined,
      }),
      acceptNextSession: async (_topic: string, subscription: string) => {
        if (subscription !== nodeId) {
          throw new Error(`Peer lab subscription '${subscription}' is not '${nodeId}'`);
        }
        return this.receiver(nodeId);
      },
      close: async () => undefined,
    }) as unknown as ServiceBusClientAdapter;
  }

  private receiver(nodeId: SystemId): ServiceBusSessionReceiver {
    const lock = Symbol("peer-lab-receiver");
    const session = this.entries(nodeId).find((item) => item.settlement === "available")
      ?.wire.sessionId;
    const settle = (message: ServiceBusReceivedMessage): QueuedMessage => {
      const item = this.entries(nodeId).find(
        (candidate) =>
          String(candidate.sequenceNumber) === message.sequenceNumber?.toString(),
      );
      if (!item || item.lock !== lock || item.settlement !== "locked") {
        throw new Error("Peer lab settlement requires a locked delivery");
      }
      return item;
    };
    return {
      receiveMessages: async (maximum: number) => {
        const items = this.entries(nodeId)
          .filter((item) =>
            item.settlement === "available" && item.wire.sessionId === session)
          .slice(0, maximum);
        return items.map((item) => {
          item.settlement = "locked";
          item.lock = lock;
          item.deliveryCount += 1;
          return {
            ...clone(item.wire),
            sequenceNumber: item.sequenceNumber,
            deliveryCount: item.deliveryCount,
          } as unknown as ServiceBusReceivedMessage;
        });
      },
      completeMessage: async (message: ServiceBusReceivedMessage) => {
        const item = settle(message);
        if (this.completeFailure) {
          this.completeFailure = false;
          throw new Error("Peer lab injected completion failure");
        }
        item.settlement = "completed";
        delete item.lock;
      },
      abandonMessage: async (message: ServiceBusReceivedMessage) => {
        const item = settle(message);
        item.settlement = "available";
        delete item.lock;
      },
      deadLetterMessage: async (
        message: ServiceBusReceivedMessage,
        options: {
          deadLetterReason?: string;
          deadLetterErrorDescription?: string;
        },
      ) => {
        const item = settle(message);
        item.settlement = "dead-lettered";
        if (options.deadLetterReason) item.deadLetterReason = options.deadLetterReason;
        if (options.deadLetterErrorDescription) {
          item.deadLetterDescription = options.deadLetterErrorDescription;
        }
        delete item.lock;
      },
      close: async () => {
        for (const item of this.entries(nodeId)) {
          if (item.lock === lock) {
            item.settlement = "available";
            delete item.lock;
          }
        }
        if (this.receiverCloseFailure) {
          this.receiverCloseFailure = false;
          throw new Error("Peer lab injected receiver close failure");
        }
      },
    } as unknown as ServiceBusSessionReceiver;
  }

  private copy(wire: ServiceBusMessage): QueuedMessage {
    return {
      wire: clone(wire),
      sequenceNumber: ++this.sequence,
      deliveryCount: 0,
      settlement: "available",
    };
  }

  private pending(target: SystemId, index: number): QueuedMessage {
    const item = this.entries(target).filter((entry) => entry.settlement === "available")[index];
    if (!item) throw new Error(`No pending peer lab message at ${target}[${index}]`);
    return item;
  }

  private entries(target: SystemId): QueuedMessage[] {
    let queue = this.queues.get(target);
    if (!queue) {
      queue = [];
      this.queues.set(target, queue);
    }
    return queue;
  }
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}
