import {
  MESSAGE_KINDS,
  createEnvelope,
  type MessageKind,
  type MessagePayload,
} from "../contracts/envelope.js";
import {
  COORDINATION_PROTOCOL_VERSION,
  type CoordinationIntent,
} from "../contracts/coordination.js";
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
  now?: Date;
}

export interface ClaimInboxInput {
  consumerId: string;
  limit: number;
  leaseSeconds: number;
  kinds?: MessageKind[];
}

export interface AskAgentInput {
  idempotencyKey: string;
  projectId: string;
  subject: string;
  request: string;
  intent: CoordinationIntent;
  timeoutSeconds: number;
  conversationId?: string;
  expiresAtUtc?: string;
  evidenceMode?: "pinned_git";
}

export interface ContinueAgentInput {
  idempotencyKey: string;
  previousResultMessageId: string;
  subject: string;
  request: string;
  intent: CoordinationIntent;
  timeoutSeconds: number;
  expiresAtUtc?: string;
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
      ...(input.now ? { now: input.now } : {}),
    });
    const result = this.database.enqueueEnvelope(envelope);
    const authoritative = this.database.getOutboxMessage(result.messageId);
    if (!authoritative) {
      throw new StateTransitionError(
        `Accepted outbox message '${result.messageId}' could not be read back`,
      );
    }
    return {
      accepted: true,
      duplicate: result.duplicate,
      message_id: result.messageId,
      state: result.state,
      conversation_id: authoritative.envelope.conversation_id,
      queued_at_utc: authoritative.envelope.created_at_utc,
    };
  }

  public askAgent(input: AskAgentInput) {
    if (
      input.conversationId &&
      this.database.listConversation(input.conversationId, 1).length > 0
    ) {
      throw new StateTransitionError(
        "A new coordination request cannot reuse an existing conversation",
      );
    }
    const request = this.send({
      idempotencyKey: input.idempotencyKey,
      kind: "task_request",
      streamId: "agent-coordination",
      payload: {
        subject: input.subject,
        body: input.request,
        project: input.projectId,
        evidence: [],
        dispatch: {
          executor: "codex_cli",
          access: "read_only",
          timeout_seconds: input.timeoutSeconds,
          ...(input.evidenceMode
            ? { evidence_mode: input.evidenceMode }
            : {}),
        },
        coordination_request: {
          protocol_version: COORDINATION_PROTOCOL_VERSION,
          intent: input.intent,
          access_mode: "read_only",
        },
      },
      sequenceNumber: 0,
      ...(input.conversationId
        ? { conversationId: input.conversationId }
        : {}),
      ...(input.expiresAtUtc ? { expiresAtUtc: input.expiresAtUtc } : {}),
    });
    return {
      accepted: request.accepted,
      duplicate: request.duplicate,
      task_id: request.message_id,
      conversation_id: request.conversation_id,
      status: request.state === "sent" ? "waiting" : "queued",
      delivery_state: request.state,
      queued_at_utc: request.queued_at_utc,
    };
  }

  public continueAgent(input: ContinueAgentInput) {
    const previous = this.database.getInboxMessage(
      input.previousResultMessageId,
    );
    const resultMetadata =
      previous?.envelope.payload.coordination_result;
    if (
      !previous ||
      previous.envelope.kind !== "task_result" ||
      previous.envelope.origin_system !== this.config.peerSystemId ||
      !resultMetadata ||
      resultMetadata.outcome !== "completed"
    ) {
      throw new StateTransitionError(
        "The previous result is not a completed peer coordination result",
      );
    }
    const priorRequest = this.database.getOutboxMessage(
      resultMetadata.request_message_id,
    );
    const projectId = priorRequest?.envelope.payload.project;
    if (
      !priorRequest ||
      priorRequest.envelope.kind !== "task_request" ||
      !priorRequest.envelope.payload.coordination_request ||
      priorRequest.envelope.conversation_id !==
        previous.envelope.conversation_id ||
      !projectId
    ) {
      throw new StateTransitionError(
        "The previous result is not linked to a local coordination request",
      );
    }
    const thread = this.database.listConversation(
      previous.envelope.conversation_id,
      100,
    );
    const existingFollowUp = this.database.getOutboxByIdempotency(
      this.config.peerSystemId,
      input.idempotencyKey,
    );
    const latest = thread.at(-1)?.envelope;
    if (
      !existingFollowUp &&
      latest?.message_id !== previous.envelope.message_id
    ) {
      throw new StateTransitionError(
        "The coordination thread already contains a newer turn",
      );
    }
    for (const item of thread) {
      if (
        (item.envelope.payload.coordination_request ||
          item.envelope.payload.coordination_result) &&
        item.envelope.payload.project &&
        item.envelope.payload.project !== projectId
      ) {
        throw new StateTransitionError(
          "The coordination thread contains more than one project",
        );
      }
    }
    const nextSequence =
      existingFollowUp?.envelope.sequence_number ??
      Math.max(
        -1,
        ...thread.map((item) => item.envelope.sequence_number ?? -1),
      ) +
        1;
    const followUp = this.send({
      idempotencyKey: input.idempotencyKey,
      kind: "task_request",
      streamId: "agent-coordination",
      conversationId: previous.envelope.conversation_id,
      causationId: previous.envelope.message_id,
      sequenceNumber: nextSequence,
      payload: {
        subject: input.subject,
        body: input.request,
        project: projectId,
        evidence: [],
        dispatch: {
          executor: "codex_cli",
          access: "read_only",
          timeout_seconds: input.timeoutSeconds,
          ...(priorRequest.envelope.payload.dispatch
            ?.evidence_mode
            ? {
                evidence_mode:
                  priorRequest.envelope.payload.dispatch
                    .evidence_mode,
              }
            : {}),
        },
        coordination_request: {
          protocol_version: COORDINATION_PROTOCOL_VERSION,
          intent: input.intent,
          access_mode: "read_only",
        },
      },
      ...(input.expiresAtUtc ? { expiresAtUtc: input.expiresAtUtc } : {}),
    });
    return {
      accepted: followUp.accepted,
      duplicate: followUp.duplicate,
      task_id: followUp.message_id,
      conversation_id: followUp.conversation_id,
      previous_result_message_id: previous.envelope.message_id,
      status: followUp.state === "sent" ? "waiting" : "queued",
      delivery_state: followUp.state,
      sequence_number: nextSequence,
      queued_at_utc: followUp.queued_at_utc,
    };
  }

  public getAgentThread(
    conversationId: string,
    limit: number,
  ): Record<string, unknown> {
    const completeThread = this.database.listConversation(
      conversationId,
      100,
    );
    const ownsThread = completeThread.some(
      (item) =>
        item.direction === "outbound" &&
        item.envelope.kind === "task_request" &&
        item.envelope.stream_id === "agent-coordination" &&
        Boolean(item.envelope.payload.coordination_request),
    );
    if (!ownsThread) {
      throw new StateTransitionError(
        `Coordination thread '${conversationId}' does not exist`,
      );
    }
    const items = completeThread.slice(-limit);
    return {
      conversation_id: conversationId,
      count: items.length,
      items: items.map((item) => ({
        message_id: item.envelope.message_id,
        direction: item.direction,
        state: item.state,
        origin_system: item.envelope.origin_system,
        target_system: item.envelope.target_system,
        kind: item.envelope.kind,
        sequence_number: item.envelope.sequence_number,
        causation_id: item.envelope.causation_id,
        subject: item.envelope.payload.subject,
        body: item.envelope.payload.body,
        project: item.envelope.payload.project,
        coordination_outcome:
          item.envelope.payload.coordination_result?.outcome,
        created_at_utc: item.envelope.created_at_utc,
      })),
    };
  }

  public getAgentResult(taskId: string) {
    const request = this.database.getOutboxMessage(taskId);
    if (
      !request ||
      request.envelope.kind !== "task_request" ||
      !request.envelope.payload.coordination_request
    ) {
      throw new StateTransitionError(
        `Coordination task '${taskId}' does not exist`,
      );
    }

    const reply = this.database.findInboxReplyTo(taskId);
    if (reply) {
      const metadata = reply.envelope.payload.coordination_result;
      const outcome =
        reply.state === "quarantined"
          ? "failed"
          : (metadata?.outcome ?? "completed");
      return {
        task_id: taskId,
        conversation_id: request.envelope.conversation_id,
        status: outcome,
        delivery_state: request.state,
        result_message_id: reply.envelope.message_id,
        result_state: reply.state,
        result: reply.envelope.payload,
      };
    }

    const status =
      request.state === "sent"
        ? "waiting"
        : request.state === "quarantined" || request.state === "expired"
          ? "failed"
          : "queued";
    return {
      task_id: taskId,
      conversation_id: request.envelope.conversation_id,
      status,
      delivery_state: request.state,
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
    const envelope = this.createReplyEnvelope(
      originalMessageId,
      idempotencyKey,
      kind,
      payload,
    );
    const result = this.database.enqueueEnvelope(envelope);
    return {
      accepted: true,
      duplicate: result.duplicate,
      message_id: result.messageId,
      state: result.state,
      queued_at_utc: envelope.created_at_utc,
    };
  }

  public settleWithReply(input: {
    originalMessageId: string;
    consumerId: string;
    claimToken: string;
    outcome: "processed" | "rejected";
    idempotencyKey: string;
    kind: MessageKind;
    payload: MessagePayload;
    reason?: string;
    now?: Date;
  }): Record<string, unknown> {
    const envelope = this.createReplyEnvelope(
      input.originalMessageId,
      input.idempotencyKey,
      input.kind,
      input.payload,
      input.now,
    );
    const result = this.database.settleInboxWithReply({
      messageId: input.originalMessageId,
      consumerId: input.consumerId,
      claimToken: input.claimToken,
      outcome: input.outcome,
      replyEnvelope: envelope,
      ...(input.reason ? { reason: input.reason } : {}),
      ...(input.now ? { now: input.now } : {}),
    });
    return {
      message_id: input.originalMessageId,
      state: result.inboxState,
      reply_message_id: result.reply.messageId,
      reply_state: result.reply.state,
      duplicate: result.reply.duplicate,
    };
  }

  private createReplyEnvelope(
    originalMessageId: string,
    idempotencyKey: string,
    kind: MessageKind,
    payload: MessagePayload,
    now = new Date(),
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

    return createEnvelope({
      idempotencyKey,
      originSystem: this.config.systemId,
      targetSystem: this.config.peerSystemId,
      kind: kind,
      streamId: original.envelope.stream_id,
      conversationId: original.envelope.conversation_id,
      causationId: original.envelope.message_id,
      sequenceNumber: (original.envelope.sequence_number ?? 0) + 1,
      payload,
      ...(original.envelope.correlation_id
        ? { correlationId: original.envelope.correlation_id }
        : {}),
      expiresAtUtc: new Date(
        now.getTime() + 7 * 24 * 60 * 60 * 1000,
      ).toISOString(),
      now,
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
