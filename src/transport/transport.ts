import type { BridgeEnvelope } from "../contracts/envelope.js";

export interface InboundDelivery {
  body: unknown;
  brokerMessageId: string;
  deliveryCount: number;
  sessionId?: string;
  complete(): Promise<void>;
  abandon(): Promise<void>;
  deadLetter(reason: string, description: string): Promise<void>;
}

export interface BridgeTransport {
  send(envelope: BridgeEnvelope): Promise<void>;
  receiveAvailable(
    handler: (delivery: InboundDelivery) => Promise<void>,
    options?: {
      maximumMessages?: number;
      maximumWaitTimeMs?: number;
      abortSignal?: AbortSignal;
    },
  ): Promise<number>;
  close(): Promise<void>;
}
