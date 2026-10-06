import { randomUUID } from "node:crypto";

import type { BridgeConfig } from "../config.js";
import { parseEnvelope } from "../contracts/envelope.js";
import type { BridgeDatabase } from "../storage/database.js";
import type {
  BridgeTransport,
  InboundDelivery,
} from "../transport/transport.js";
import { safeErrorCode } from "../security/sanitize-error.js";
import type { PeerCheckService } from "./peer-check.js";

const PERMANENT_TRANSPORT_CODES = new Set([
  "UnauthorizedAccess",
  "MessagingEntityNotFound",
  "InvalidOperation",
]);

export class BridgeWorker {
  public readonly instanceId = randomUUID();
  private outboundCycleOutcome:
    | { kind: "idle" }
    | { kind: "sent" }
    | { kind: "failed"; errorCode: string } = { kind: "idle" };

  public constructor(
    private readonly config: BridgeConfig,
    private readonly database: BridgeDatabase,
    private readonly transport: BridgeTransport,
    private readonly peerChecks?: PeerCheckService,
  ) {}

  public getOutboundCycleOutcome():
    | { kind: "idle" }
    | { kind: "sent" }
    | { kind: "failed"; errorCode: string } {
    return this.outboundCycleOutcome;
  }

  public async runOutboundOnce(
    now = new Date(),
    abortSignal?: AbortSignal,
  ): Promise<number> {
    this.outboundCycleOutcome = { kind: "idle" };
    if (abortSignal?.aborted) {
      return 0;
    }
    this.peerChecks?.respondPending(now);
    if (abortSignal?.aborted) {
      return 0;
    }
    const leased = this.database.leaseOutbox(
      this.instanceId,
      10,
      60,
      now,
    );
    let sent = false;
    let failureCode: string | undefined;
    for (const item of leased) {
      if (abortSignal?.aborted) {
        break;
      }
      const startedAtUtc = new Date().toISOString();
      if (!this.config.authorizedNodeIds.includes(item.envelope.target_system)) {
        failureCode ??= "UnauthorizedTargetNode";
        this.database.quarantineOutbox(
          item.envelope.message_id,
          this.instanceId,
          "UnauthorizedTargetNode",
        );
        this.database.recordDeliveryAttempt({
          direction: "outbound",
          messageId: item.envelope.message_id,
          attemptNumber: item.attemptNumber,
          startedAtUtc,
          finishedAtUtc: new Date().toISOString(),
          outcome: "quarantined",
          errorCode: "UnauthorizedTargetNode",
        });
        continue;
      }
      try {
        await this.transport.send(item.envelope);
        if (abortSignal?.aborted) {
          break;
        }
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
        sent = true;
      } catch (error) {
        if (abortSignal?.aborted) {
          break;
        }
        const code = safeErrorCode(error);
        failureCode ??= code;
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
    this.outboundCycleOutcome = failureCode
      ? { kind: "failed", errorCode: failureCode }
      : sent
        ? { kind: "sent" }
        : { kind: "idle" };
    return leased.length;
  }

  public async runInboundOnce(
    abortSignal?: AbortSignal,
  ): Promise<number> {
    if (abortSignal?.aborted) {
      return 0;
    }
    return this.transport.receiveAvailable(
      async (delivery) => this.processInboundDelivery(delivery, abortSignal),
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
    abortSignal?: AbortSignal,
  ): Promise<void> {
    if (abortSignal?.aborted) {
      return;
    }
    const startedAtUtc = new Date().toISOString();
    let envelope;
    try {
      envelope = parseEnvelope(delivery.body);
    } catch {
      await this.deadLetterInvalidEnvelope(delivery, startedAtUtc, abortSignal);
      return;
    }

    if (abortSignal?.aborted) {
      return;
    }
    if (envelope.target_system !== this.config.systemId) {
      await delivery.deadLetter(
        "WrongTargetSystem",
        "Message target does not match this bridge",
      );
      if (abortSignal?.aborted) {
        return;
      }
      this.recordInboundAttempt(
        delivery,
        envelope.message_id,
        startedAtUtc,
        "dead-lettered",
        "WrongTargetSystem",
      );
      return;
    }
    if (!this.config.authorizedNodeIds.includes(envelope.origin_system)) {
      await delivery.deadLetter(
        "UnauthorizedOriginNode",
        "Message origin is not authorized by this bridge",
      );
      if (abortSignal?.aborted) {
        return;
      }
      this.recordInboundAttempt(
        delivery,
        envelope.message_id,
        startedAtUtc,
        "dead-lettered",
        "UnauthorizedOriginNode",
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
      if (abortSignal?.aborted) {
        return;
      }
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
        new Date(),
        true,
      );
    } catch (error) {
      if (abortSignal?.aborted) {
        return;
      }
      try {
        await delivery.abandon();
      } catch (settlementError) {
        console.error(
          `Inbound abandon failed (${safeErrorCode(settlementError)})`,
        );
      }
      if (abortSignal?.aborted) {
        return;
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

    if (abortSignal?.aborted) {
      return;
    }
    if (persisted.status === "collision") {
      await delivery.deadLetter(
        "MessageIdentityCollision",
        "A different payload already uses this message identifier",
      );
      if (abortSignal?.aborted) {
        return;
      }
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
      if (abortSignal?.aborted) {
        return;
      }
      this.recordInboundAttempt(
        delivery,
        envelope.message_id,
        startedAtUtc,
        persisted.status,
      );
    } catch (error) {
      if (abortSignal?.aborted) {
        return;
      }
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
    abortSignal?: AbortSignal,
  ): Promise<void> {
    if (abortSignal?.aborted) {
      return;
    }
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
    if (abortSignal?.aborted) {
      return;
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
