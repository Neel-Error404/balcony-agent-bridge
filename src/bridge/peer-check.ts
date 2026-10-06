import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { BridgeConfig } from "../config.js";
import type { BridgeEnvelope } from "../contracts/envelope.js";
import {
  assertFreshPeerCheck, createPeerChallenge, parsePeerCheck,
  createPeerAcknowledgement, isPeerAcknowledgementFor,
} from "../contracts/peer-check.js";
import { BridgeError, IdempotencyConflictError } from "../errors.js";
import type { BridgeDatabase } from "../storage/database.js";

export interface PeerCheckReport {
  check_id: string;
  peer_id: string;
  status: "queued" | "waiting" | "verified" | "expired" | "failed";
  verified: boolean;
  expires_at_utc: string;
  proof_scope: "signed_peer_roundtrip";
  communication_ready: false;
}

/** A bounded diagnostic, never a resource grant or overall readiness certificate. */
export class PeerCheckService {
  private readonly consumerId = `peer-check:${randomUUID()}`;
  public constructor(
    private readonly config: Pick<BridgeConfig, "systemId" | "authorizedNodeIds">,
    private readonly database: BridgeDatabase,
    private readonly networkId: string,
  ) {}

  public start(peerId: string, idempotencyKey: string, timeoutSeconds = 60, now = new Date()): PeerCheckReport {
    this.assertPeer(peerId);
    const key = z.string().trim().min(1).max(128).parse(idempotencyKey);
    z.number().int().min(1).max(300).parse(timeoutSeconds);
    const existing = this.database.getOutboxByIdempotency(peerId, key);
    if (existing) {
      this.assertSameOperation(existing.envelope, timeoutSeconds);
      return this.status(existing.envelope.message_id, now);
    }
    const challenge = createPeerChallenge({
      originSystem: this.config.systemId, targetSystem: peerId,
      networkId: this.networkId, idempotencyKey: key, timeoutSeconds, now,
    });
    try {
      this.database.enqueueEnvelope(challenge);
    } catch (error) {
      if (!(error instanceof IdempotencyConflictError)) throw error;
      // Concurrent retries generate different nonces. Resume only the same
      // logical operation that won the existing outbox uniqueness constraint.
      const winner = this.database.getOutboxByIdempotency(peerId, key);
      if (!winner) throw error;
      this.assertSameOperation(winner.envelope, timeoutSeconds);
      return this.status(winner.envelope.message_id, now);
    }
    return this.status(challenge.message_id, now);
  }

  public status(checkId: string, now = new Date()): PeerCheckReport {
    z.string().uuid().parse(checkId);
    const item = this.database.getOutboxMessage(checkId);
    if (!item) throw new BridgeError("PEER_CHECK_NOT_FOUND", "No diagnostic exists for this check ID.");
    this.assertChallenge(item.envelope);
    const expired = Date.parse(item.envelope.expires_at_utc!) <= now.getTime();
    if (!expired) assertFreshPeerCheck(item.envelope, now);
    let status: PeerCheckReport["status"] = expired || item.state === "expired"
      ? "expired" : item.state === "quarantined" ? "failed"
        : item.state === "sent" ? "waiting" : "queued";
    if (status !== "expired" && status !== "failed") {
      for (const ack of this.database.findPeerAcknowledgements(item.envelope)) {
        if (isPeerAcknowledgementFor(item.envelope, ack, this.networkId, now)) {
          status = "verified";
          break;
        }
      }
    }
    return {
      check_id: checkId, peer_id: item.envelope.target_system, status,
      verified: status === "verified", expires_at_utc: item.envelope.expires_at_utc!,
      proof_scope: "signed_peer_roundtrip", communication_ready: false,
    };
  }

  public respondPending(now = new Date()): number {
    const claims = this.database.claimPeerChallenges(this.consumerId, now);
    for (const claim of claims) {
      let reply: BridgeEnvelope;
      try {
        this.assertPeer(claim.envelope.origin_system);
        if (!claim.authenticatedIngress) {
          throw new BridgeError("PEER_CHECK_UNAUTHENTICATED", "Authenticated ingress is required.");
        }
        reply = createPeerAcknowledgement(claim.envelope, this.config.systemId, this.networkId, now);
      } catch (error) {
        if (!(error instanceof TypeError || error instanceof RangeError ||
              error instanceof z.ZodError || error instanceof BridgeError)) throw error;
        this.database.acknowledge(claim.envelope.message_id, this.consumerId,
          claim.claimToken, "rejected", "PeerCheckRejected", now);
        continue;
      }
      // No broker call before durable settlement: replay/restart reuses this
      // outbox acknowledgement rather than manufacturing another response.
      this.database.settleInboxWithReply({
        messageId: claim.envelope.message_id, consumerId: this.consumerId,
        claimToken: claim.claimToken, outcome: "processed", replyEnvelope: reply, now,
      });
    }
    return claims.length;
  }

  private assertPeer(peerId: string): void {
    if (peerId === this.config.systemId || !this.config.authorizedNodeIds.includes(peerId)) {
      throw new BridgeError("PEER_CHECK_UNAUTHORIZED", "Explicitly enroll and approve this peer before checking it.");
    }
  }

  private assertChallenge(envelope: BridgeEnvelope): void {
    this.assertPeer(envelope.target_system);
    if (envelope.origin_system !== this.config.systemId ||
        parsePeerCheck(envelope, this.networkId).type !== "challenge") {
      throw new BridgeError("PEER_CHECK_CONFLICT", "The stored operation is not this node's peer diagnostic.");
    }
  }

  private assertSameOperation(envelope: BridgeEnvelope, timeoutSeconds: number): void {
    this.assertChallenge(envelope);
    if (Date.parse(envelope.expires_at_utc!) - Date.parse(envelope.created_at_utc) !== timeoutSeconds * 1000) {
      throw new BridgeError("PEER_CHECK_CONFLICT", "This key belongs to a different diagnostic. Use a new idempotency key.");
    }
  }
}
