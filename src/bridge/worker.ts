import { randomUUID } from "node:crypto";

import type { BridgeConfig } from "../config.js";
import { parseEnvelope } from "../contracts/envelope.js";
import type { BridgeDatabase } from "../storage/database.js";
import type {
  BridgeTransport,
  InboundDelivery,
} from "../transport/transport.js";
import { safeErrorCode } from "../security/sanitize-error.js";

const PERMANENT_TRANSPORT_CODES = new Set([
  "UnauthorizedAccess",
  "MessagingEntityNotFound",
  "InvalidOperation",
]);

export class BridgeWorker {
  public readonly instanceId = randomUUID();

  public constructor(
    private readonly config: BridgeConfig,
    private readonly database: BridgeDatabase,
    private readonly transport: BridgeTransport,
  ) {}

  public async runOutboundOnce(now = new Date()): Promise<number> {
    const leased = this.database.leaseOutbox(
      this.instanceId,
      10,
      60,
      now,
    );
    for (const item of leased) {
      const startedAtUtc = new Date().toISOString();
      try {
        await this.transport.send(item.envelope);
        const finishedAtUtc = new Date().toISOString();
        this.database.markOutboxSent(
          item.envelope.message_id,
          this.instanceId,
          new Date(finishedAtUtc),
        );
        this.database.recordDeliveryAttempt({
          direction: "outbound",
          messageId: item.envelope.message_id,
          attemptNumber: item.attemptNumber,
          startedAtUtc,
          finishedAtUtc,
          outcome: "sent",
        });
      } catch (error) {
        const code = safeErrorCode(error);
        const finishedAtUtc = new Date().toISOString();
        if (PERMANENT_TRANSPORT_CODES.has(code)) {
          this.database.quarantineOutbox(
            item.envelope.message_id,
            this.instanceId,
            code,
          );
        } else {
          this.database.releaseOutboxLease(
            item.envelope.message_id,
            this.instanceId,
            new Date(
              Date.now() + retryDelayMilliseconds(item.attemptNumber),
            ),
            code,
          );
        }
        this.database.recordDeliveryAttempt({
          direction: "outbound",
          messageId: item.envelope.message_id,
          attemptNumber: item.attemptNumber,
          startedAtUtc,
          finishedAtUtc,
          outcome: PERMANENT_TRANSPORT_CODES.has(code)
            ? "quarantined"
            : "retry",
          errorCode: code,
        });
      }
    }
    return leased.length;
  }

  public async runInboundOnce(
    abortSignal?: AbortSignal,
  ): Promise<number> {
    return this.transport.receiveAvailable(
      async (delivery) => this.processInboundDelivery(delivery),
      {
        maximumMessages: 10,
        maximumWaitTimeMs: 5000,
        ...(abortSignal ? { abortSignal } : {}),
      },
    );
  }

  public recordHeartbeat(
    status: "healthy" | "degraded",
    lastError?: string,
  ): void {
    this.database.recordBridgeHeartbeat(
      this.instanceId,
      status,
      lastError,
    );
  }

  private async processInboundDelivery(
    delivery: InboundDelivery,
  ): Promise<void> {
    const startedAtUtc = new Date().toISOString();
    let envelope;
    try {
      envelope = parseEnvelope(delivery.body);
    } catch {
      await this.deadLetterInvalidEnvelope(delivery, startedAtUtc);
      return;
    }

    if (envelope.target_system !== this.config.systemId) {
      await delivery.deadLetter(
        "WrongTargetSystem",
        "Message target does not match this bridge",
      );
      this.recordInboundAttempt(
        delivery,
        envelope.message_id,
        startedAtUtc,
        "dead-lettered",
        "WrongTargetSystem",
      );
      return;
    }
    if (
      delivery.sessionId &&
      delivery.sessionId !== envelope.conversation_id
    ) {
      await delivery.deadLetter(
        "SessionMismatch",
        "Broker session does not match conversation identifier",
      );
      this.recordInboundAttempt(
        delivery,
        envelope.message_id,
        startedAtUtc,
        "dead-lettered",
        "SessionMismatch",
      );
      return;
    }

    let persisted;
    try {
      persisted = this.database.persistIncoming(
        envelope,
        delivery.deliveryCount,
      );
    } catch (error) {
      try {
        await delivery.abandon();
      } catch (settlementError) {
        console.error(
          `Inbound abandon failed (${safeErrorCode(settlementError)})`,
        );
      }
      this.recordInboundAttempt(
        delivery,
        envelope.message_id,
        startedAtUtc,
        "retry",
        safeErrorCode(error),
      );
      return;
    }

    if (persisted.status === "collision") {
      await delivery.deadLetter(
        "MessageIdentityCollision",
        "A different payload already uses this message identifier",
      );
      this.recordInboundAttempt(
        delivery,
        envelope.message_id,
        startedAtUtc,
        "dead-lettered",
        "MessageIdentityCollision",
      );
      return;
    }

    try {
      await delivery.complete();
      this.recordInboundAttempt(
        delivery,
        envelope.message_id,
        startedAtUtc,
        persisted.status,
      );
    } catch (error) {
      this.recordInboundAttempt(
        delivery,
        envelope.message_id,
        startedAtUtc,
        "settlement-uncertain",
        safeErrorCode(error),
      );
      console.error(
        `Inbound completion was not confirmed (${safeErrorCode(error)})`,
      );
    }
  }

  private async deadLetterInvalidEnvelope(
    delivery: InboundDelivery,
    startedAtUtc: string,
  ): Promise<void> {
    try {
      await delivery.deadLetter(
        "EnvelopeValidationFailed",
        "Message did not satisfy the bridge envelope contract",
      );
    } catch (settlementError) {
      console.error(
        `Invalid-envelope settlement failed (${safeErrorCode(settlementError)})`,
      );
    }
    this.recordInboundAttempt(
      delivery,
      delivery.brokerMessageId,
      startedAtUtc,
      "dead-lettered",
      "EnvelopeValidationFailed",
    );
  }

  private recordInboundAttempt(
    delivery: InboundDelivery,
    messageId: string,
    startedAtUtc: string,
    outcome: string,
    errorCode?: string,
  ): void {
    this.database.recordDeliveryAttempt({
      direction: "inbound",
      messageId,
      attemptNumber: Math.max(1, delivery.deliveryCount),
      startedAtUtc,
      finishedAtUtc: new Date().toISOString(),
      outcome,
      ...(errorCode ? { errorCode } : {}),
    });
  }
}

function retryDelayMilliseconds(attempt: number): number {
  return Math.min(5 * 60 * 1000, 1000 * 2 ** Math.min(attempt, 8));
}
