import type { BridgeEnvelope } from "../contracts/envelope.js";
import type {
  BridgeTransport,
  InboundDelivery,
} from "./transport.js";

export type FakeSendBehavior =
  | { kind: "success" }
  | { kind: "error"; error: Error };

interface QueuedFakeDelivery {
  body: unknown;
  brokerMessageId: string;
  deliveryCount: number;
  sessionId?: string;
  settlement?: "completed" | "abandoned" | "dead-lettered";
  deadLetterReason?: string;
}

export class FakeBridgeTransport implements BridgeTransport {
  public readonly sent: BridgeEnvelope[] = [];
  public readonly inbound: QueuedFakeDelivery[] = [];
  public sendBehavior: FakeSendBehavior = { kind: "success" };
  public closed = false;

  public queueInbound(input: {
    body: unknown;
    brokerMessageId: string;
    deliveryCount?: number;
    sessionId?: string;
  }): void {
    this.inbound.push({
      body: input.body,
      brokerMessageId: input.brokerMessageId,
      deliveryCount: input.deliveryCount ?? 1,
      ...(input.sessionId ? { sessionId: input.sessionId } : {}),
    });
  }

  public async send(envelope: BridgeEnvelope): Promise<void> {
    if (this.closed) {
      throw new Error("Fake transport is closed");
    }
    if (this.sendBehavior.kind === "error") {
      throw this.sendBehavior.error;
    }
    this.sent.push(envelope);
  }

  public async receiveAvailable(
    handler: (delivery: InboundDelivery) => Promise<void>,
    options?: {
      maximumMessages?: number;
    },
  ): Promise<number> {
    if (this.closed) {
      throw new Error("Fake transport is closed");
    }
    const limit = options?.maximumMessages ?? 10;
    const available = this.inbound
      .filter((item) => item.settlement === undefined)
      .slice(0, limit);
    for (const item of available) {
      await handler({
        body: item.body,
        brokerMessageId: item.brokerMessageId,
        deliveryCount: item.deliveryCount,
        ...(item.sessionId ? { sessionId: item.sessionId } : {}),
        complete: async () => {
          item.settlement = "completed";
        },
        abandon: async () => {
          item.settlement = "abandoned";
        },
        deadLetter: async (reason) => {
          item.settlement = "dead-lettered";
          item.deadLetterReason = reason;
        },
      });
    }
    return available.length;
  }

  public async close(): Promise<void> {
    this.closed = true;
  }
}
