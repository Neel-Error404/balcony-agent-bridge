import { randomBytes } from "node:crypto";

import { z } from "zod";

import {
  BridgeEnvelopeSchema,
  createEnvelope,
  type BridgeEnvelope,
  type SystemId,
} from "./envelope.js";

export const PEER_CHECK_STREAM = "agent-peer-check";
const PROTOCOL = "balcony-agent-bridge-peer-check";
const NetworkIdSchema = z
  .string()
  .min(1)
  .max(50)
  .regex(/^[a-z][a-z0-9-]*$/);

const CommonBodySchema = {
  protocol: z.literal(PROTOCOL),
  version: z.literal("1.0"),
  network_id: NetworkIdSchema,
  nonce: z.string().regex(/^[a-f0-9]{64}$/),
};
const PeerCheckBodySchema = z.discriminatedUnion("type", [
  z.object({ ...CommonBodySchema, type: z.literal("challenge") }).strict(),
  z.object({
    ...CommonBodySchema,
    type: z.literal("acknowledgement"),
    request_message_id: z.string().uuid(),
  }).strict(),
]);
export type PeerCheckBody = z.infer<typeof PeerCheckBodySchema>;

export interface CreatePeerChallengeInput {
  originSystem: SystemId;
  targetSystem: SystemId;
  networkId: string;
  idempotencyKey: string;
  timeoutSeconds?: number;
  now?: Date;
}

export function createPeerChallenge(
  input: CreatePeerChallengeInput,
): BridgeEnvelope {
  const timeoutSeconds = input.timeoutSeconds ?? 60;
  if (
    !Number.isInteger(timeoutSeconds) ||
    timeoutSeconds < 1 ||
    timeoutSeconds > 300
  ) {
    throw new RangeError("timeoutSeconds must be an integer from 1 through 300");
  }
  if (!NetworkIdSchema.safeParse(input.networkId).success) {
    throw new TypeError("networkId must be a bounded lowercase network identifier");
  }
  const now = input.now ?? new Date();
  const deadline = new Date(now.getTime() + timeoutSeconds * 1000);
  return createEnvelope({
    originSystem: input.originSystem,
    targetSystem: input.targetSystem,
    idempotencyKey: input.idempotencyKey,
    kind: "heartbeat",
    streamId: PEER_CHECK_STREAM,
    expiresAtUtc: deadline.toISOString(),
    now,
    payload: {
      subject: "Peer check challenge",
      body: JSON.stringify({
        protocol: PROTOCOL,
        version: "1.0",
        type: "challenge",
        network_id: input.networkId,
        nonce: randomBytes(32).toString("hex"),
      }),
      evidence: [],
    },
  });
}

export function parsePeerCheck(
  envelope: BridgeEnvelope,
  networkId: string,
): PeerCheckBody {
  if (!BridgeEnvelopeSchema.safeParse(envelope).success) {
    throw new TypeError("Invalid peer-check envelope schema or payload hash");
  }
  if (envelope.stream_id !== PEER_CHECK_STREAM) {
    throw new TypeError("Peer check requires the agent-peer-check stream");
  }
  let rawBody: unknown;
  try {
    rawBody = JSON.parse(envelope.payload.body);
  } catch {
    throw new TypeError("Invalid peer-check body JSON");
  }
  const parsed = PeerCheckBodySchema.safeParse(rawBody);
  if (!parsed.success) {
    throw new TypeError("Invalid peer-check body protocol, version, type, or shape");
  }
  const body = parsed.data;
  if (body.network_id !== networkId) {
    throw new TypeError("Peer-check network_id does not match expected network");
  }
  if (
    (body.type === "challenge" && envelope.kind !== "heartbeat") ||
    (body.type === "acknowledgement" && envelope.kind !== "acknowledgement")
  ) {
    throw new TypeError("Peer-check body type does not match envelope kind");
  }
  if (
    body.type === "acknowledgement" &&
    body.request_message_id !== envelope.causation_id
  ) {
    throw new TypeError("Peer-check request_message_id must match causation_id");
  }
  if (!envelope.expires_at_utc) {
    throw new TypeError("Peer-check envelope requires expires_at_utc");
  }
  const lifetime =
    Date.parse(envelope.expires_at_utc) - Date.parse(envelope.created_at_utc);
  if (lifetime <= 0 || lifetime > 300_000) {
    throw new RangeError("Peer-check envelope lifetime must be 1 through 300 seconds");
  }
  return body;
}

export function assertFreshPeerCheck(
  envelope: BridgeEnvelope,
  now: Date = new Date(),
): void {
  if (!Number.isFinite(now.getTime())) {
    throw new RangeError("Peer-check now must be a valid date");
  }
  if (!envelope.expires_at_utc) {
    throw new TypeError("Peer-check envelope requires expires_at_utc");
  }
  const created = Date.parse(envelope.created_at_utc);
  const expires = Date.parse(envelope.expires_at_utc);
  if (!Number.isFinite(created) || !Number.isFinite(expires)) {
    throw new TypeError("Peer-check envelope timestamps must be valid");
  }
  if (created > now.getTime() + 30_000) {
    throw new RangeError("Peer-check envelope created more than 30 seconds in the future");
  }
  if (expires <= now.getTime()) {
    throw new RangeError("Peer-check envelope expired");
  }
}

export function createPeerAcknowledgement(
  challenge: BridgeEnvelope,
  localNodeId: SystemId,
  networkId: string,
  now: Date = new Date(),
): BridgeEnvelope {
  const body = parsePeerCheck(challenge, networkId);
  if (body.type !== "challenge") {
    throw new TypeError("Peer acknowledgement requires a challenge");
  }
  if (challenge.target_system !== localNodeId) {
    throw new TypeError("Peer challenge target must match localNodeId");
  }
  assertFreshPeerCheck(challenge, now);
  // A receiver's clock may trail the sender by up to the accepted 30 seconds.
  // Never let that skew extend the acknowledgement's 300-second lifetime.
  const acknowledgementTime = new Date(
    Math.max(now.getTime(), Date.parse(challenge.created_at_utc)),
  );
  return createEnvelope({
    originSystem: localNodeId,
    targetSystem: challenge.origin_system,
    idempotencyKey: `peer-ack:${challenge.message_id}`,
    kind: "acknowledgement",
    streamId: PEER_CHECK_STREAM,
    conversationId: challenge.conversation_id,
    causationId: challenge.message_id,
    expiresAtUtc: challenge.expires_at_utc!,
    now: acknowledgementTime,
    payload: {
      subject: "Peer check acknowledgement",
      body: JSON.stringify({
        protocol: PROTOCOL,
        version: "1.0",
        type: "acknowledgement",
        network_id: networkId,
        nonce: body.nonce,
        request_message_id: challenge.message_id,
      }),
      evidence: [],
    },
  });
}

/**
 * Return false for an invalid or unrelated response; this proves only a fresh
 * challenge/acknowledgement binding, not peer readiness or delivery guarantees.
 */
export function isPeerAcknowledgementFor(
  challenge: BridgeEnvelope,
  acknowledgement: BridgeEnvelope,
  networkId: string,
  now: Date = new Date(),
): boolean {
  try {
    const requestBody = parsePeerCheck(challenge, networkId);
    const responseBody = parsePeerCheck(acknowledgement, networkId);
    assertFreshPeerCheck(challenge, now);
    assertFreshPeerCheck(acknowledgement, now);
    return (
      requestBody.type === "challenge" &&
      responseBody.type === "acknowledgement" &&
      acknowledgement.origin_system === challenge.target_system &&
      acknowledgement.target_system === challenge.origin_system &&
      acknowledgement.conversation_id === challenge.conversation_id &&
      acknowledgement.causation_id === challenge.message_id &&
      acknowledgement.idempotency_key === `peer-ack:${challenge.message_id}` &&
      Date.parse(acknowledgement.expires_at_utc!) ===
        Date.parse(challenge.expires_at_utc!) &&
      responseBody.nonce === requestBody.nonce &&
      responseBody.request_message_id === challenge.message_id
    );
  } catch (error) {
    if (error instanceof TypeError || error instanceof RangeError) {
      return false;
    }
    throw error;
  }
}
