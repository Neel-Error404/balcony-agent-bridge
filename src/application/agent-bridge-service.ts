import {
  MESSAGE_KINDS,
  createEnvelope,
  type MessageKind,
  type MessagePayload,
} from "../contracts/envelope.js";
import type { BridgeConfig } from "../config.js";
import { StateTransitionError } from "../errors.js";
import {
  BridgeDatabase,
  type AcknowledgeOutcome,
  type InboxState,
} from "../storage/database.js";

export interface SendMessageInput {
  idempotencyKey: string;
  kind: MessageKind;
  streamId: string;
  payload: MessagePayload;
  conversationId?: string;
  correlationId?: string;
  causationId?: string;
  sequenceNumber?: number;
  expiresAtUtc?: string;
}

export interface ClaimInboxInput {
  consumerId: string;
  limit: number;
  leaseSeconds: number;
  kinds?: MessageKind[];
}

export class AgentBridgeService {
  public constructor(
    private readonly config: BridgeConfig,
    private readonly database: BridgeDatabase,
  ) {}

  public send(input: SendMessageInput) {
    const expiresAtUtc =
      input.expiresAtUtc ??
      new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();
    const envelope = createEnvelope({
      idempotencyKey: input.idempotencyKey,
      originSystem: this.config.systemId,
      targetSystem: this.config.peerSystemId,
      kind: input.kind,
      streamId: input.streamId,
      payload: input.payload,
      ...(input.conversationId
        ? { conversationId: input.conversationId }
        : {}),
      ...(input.correlationId
        ? { correlationId: input.correlationId }
        : {}),
      ...(input.causationId ? { causationId: input.causationId } : {}),
      ...(input.sequenceNumber !== undefined
        ? { sequenceNumber: input.sequenceNumber }
        : {}),
      expiresAtUtc,
    });
    const result = this.database.enqueueEnvelope(envelope);
    return {
      accepted: true,
      duplicate: result.duplicate,
      message_id: result.messageId,
      state: result.state,
      queued_at_utc: envelope.created_at_utc,
    };
  }

  public listInbox(
    limit: number,
    states?: InboxState[],
  ): Array<Record<string, unknown>> {
    return this.database.listInbox(limit, states).map((item) => ({
      message_id: item.envelope.message_id,
      conversation_id: item.envelope.conversation_id,
      origin_system: item.envelope.origin_system,
      kind: item.envelope.kind,
      subject: item.envelope.payload.subject,
      stream_id: item.envelope.stream_id,
      created_at_utc: item.envelope.created_at_utc,
      state: item.state,
      ...(item.claimOwner ? { claim_owner: item.claimOwner } : {}),
      ...(item.claimUntilUtc
        ? { claim_until_utc: item.claimUntilUtc }
        : {}),
    }));
  }

  public readMessage(messageId: string): Record<string, unknown> {
    const item = this.database.getInboxMessage(messageId);
    if (!item) {
      throw new StateTransitionError(
        `Inbox message '${messageId}' does not exist`,
      );
    }
    return {
      envelope: item.envelope,
      state: item.state,
      ...(item.claimOwner ? { claim_owner: item.claimOwner } : {}),
      ...(item.claimUntilUtc
        ? { claim_until_utc: item.claimUntilUtc }
        : {}),
    };
  }

  public claim(input: ClaimInboxInput): Record<string, unknown> {
    const items = this.database.claimInbox(
      input.consumerId,
      input.limit,
      input.leaseSeconds,
      input.kinds,
    );
    return {
      count: items.length,
      items: items.map((item) => ({
        envelope: item.envelope,
        claim_token: item.claimToken,
        claim_until_utc: item.claimUntilUtc,
      })),
    };
  }

  public renewClaim(
    messageId: string,
    consumerId: string,
    claimToken: string,
    leaseSeconds: number,
  ): Record<string, unknown> {
    return {
      message_id: messageId,
      claim_until_utc: this.database.renewClaim(
        messageId,
        consumerId,
        claimToken,
        leaseSeconds,
      ),
    };
  }

  public acknowledge(
    messageId: string,
    consumerId: string,
    claimToken: string,
    outcome: AcknowledgeOutcome,
    reason?: string,
  ): Record<string, unknown> {
    return {
      message_id: messageId,
      state: this.database.acknowledge(
        messageId,
        consumerId,
        claimToken,
        outcome,
        reason,
      ),
    };
  }

  public reply(
    originalMessageId: string,
    idempotencyKey: string,
    kind: MessageKind,
    payload: MessagePayload,
  ) {
    const original = this.database.getInboxMessage(originalMessageId);
    if (!original) {
      throw new StateTransitionError(
        `Cannot reply because inbox message '${originalMessageId}' does not exist`,
      );
    }
    if (original.envelope.origin_system !== this.config.peerSystemId) {
      throw new StateTransitionError(
        `Cannot reply to message '${originalMessageId}' because its origin is not the configured peer`,
      );
    }

    return this.send({
      idempotencyKey,
      kind,
      streamId: original.envelope.stream_id,
      conversationId: original.envelope.conversation_id,
      causationId: original.envelope.message_id,
      payload,
      ...(original.envelope.correlation_id
        ? { correlationId: original.envelope.correlation_id }
        : {}),
    });
  }

  public status(): Record<string, unknown> {
    return {
      system_id: this.config.systemId,
      peer_system_id: this.config.peerSystemId,
      allowed_message_kinds: MESSAGE_KINDS,
      ...this.database.getStatus(),
    };
  }
}
