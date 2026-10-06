import { describe, expect, it } from "vitest";

import {
  BridgeEnvelopeSchema,
  createEnvelope,
  hashPayload,
  type BridgeEnvelope,
} from "../../src/contracts/envelope.js";
import {
  PEER_CHECK_STREAM,
  assertFreshPeerCheck,
  createPeerAcknowledgement,
  createPeerChallenge,
  isPeerAcknowledgementFor,
  parsePeerCheck,
} from "../../src/contracts/peer-check.js";

const NOW = new Date("2026-09-28T12:00:00.000Z");
const newChallenge = () =>
  createPeerChallenge({
    originSystem: "SYS-A",
    targetSystem: "SYS-B",
    networkId: "test-network",
    idempotencyKey: "peer-check-1",
    now: NOW,
  });
const replaceBody = (envelope: BridgeEnvelope, body: unknown): BridgeEnvelope => {
  const payload = { ...envelope.payload, body: JSON.stringify(body) };
  return { ...envelope, payload, payload_sha256: hashPayload(payload) };
};

describe("peer-check protocol", () => {
  it("creates an envelope 1.0 challenge with an unpredictable nonce and a 60-second deadline", () => {
    const input = {
      originSystem: "SYS-A",
      targetSystem: "SYS-B",
      networkId: "test-network",
      idempotencyKey: "peer-check-1",
      now: NOW,
    };
    const challenge = createPeerChallenge(input);
    const second = createPeerChallenge(input);

    expect(BridgeEnvelopeSchema.parse(challenge)).toEqual(challenge);
    expect(challenge.stream_id).toBe(PEER_CHECK_STREAM);
    expect(challenge.kind).toBe("heartbeat");
    expect(challenge.created_at_utc).toBe(NOW.toISOString());
    expect(challenge.expires_at_utc).toBe("2026-09-28T12:01:00.000Z");
    expect(challenge.payload).toEqual({
      subject: "Peer check challenge",
      body: expect.any(String),
      evidence: [],
    });
    const body = JSON.parse(challenge.payload.body) as Record<string, unknown>;
    expect(body).toEqual({
      protocol: "balcony-agent-bridge-peer-check",
      version: "1.0",
      type: "challenge",
      network_id: "test-network",
      nonce: expect.stringMatching(/^[a-f0-9]{64}$/),
    });
    expect((JSON.parse(second.payload.body) as Record<string, unknown>)["nonce"]).not.toBe(
      body["nonce"],
    );
  });

  it("accepts only integer challenge timeouts from 1 through 300 seconds", () => {
    for (const seconds of [1, 300]) {
      const challenge = createPeerChallenge({
        originSystem: "SYS-A",
        targetSystem: "SYS-B",
        networkId: "test-network",
        idempotencyKey: `timeout-${seconds}`,
        timeoutSeconds: seconds,
        now: NOW,
      });
      expect(Date.parse(challenge.expires_at_utc!) - NOW.getTime()).toBe(
        seconds * 1000,
      );
    }
    for (const seconds of [0, -1, 301, 0.5, Number.NaN, Infinity]) {
      expect(() =>
        createPeerChallenge({
          originSystem: "SYS-A",
          targetSystem: "SYS-B",
          networkId: "test-network",
          idempotencyKey: "invalid-timeout",
          timeoutSeconds: seconds,
          now: NOW,
        }),
      ).toThrow(/timeoutSeconds/);
    }
  });

  it("parses a strict, versioned challenge bound to its expected network and kind", () => {
    const challenge = newChallenge();
    const body = parsePeerCheck(challenge, "test-network");
    expect(body.type).toBe("challenge");
    expect(body.nonce).toMatch(/^[a-f0-9]{64}$/);
    expect(() => parsePeerCheck(challenge, "other-network")).toThrow(/network/);
    expect(() =>
      parsePeerCheck(
        replaceBody(challenge, { ...body, version: "2.0" }),
        "test-network",
      ),
    ).toThrow(/body/);
    expect(() =>
      parsePeerCheck(
        replaceBody(challenge, { ...body, nonce: "short" }),
        "test-network",
      ),
    ).toThrow(/body/);
    expect(() =>
      parsePeerCheck(
        replaceBody(challenge, { ...body, arbitrary_task: "run" }),
        "test-network",
      ),
    ).toThrow(/body/);
    expect(() =>
      parsePeerCheck(
        { ...challenge, kind: "acknowledgement" },
        "test-network",
      ),
    ).toThrow(/kind/);
  });

  it("acknowledges only its addressed, fresh challenge with reverse route and shared deadline", () => {
    const challenge = newChallenge();
    const ack = createPeerAcknowledgement(
      challenge,
      "SYS-B",
      "test-network",
      new Date(NOW.getTime() + 500),
    );
    expect(BridgeEnvelopeSchema.parse(ack)).toEqual(ack);
    expect(ack.kind).toBe("acknowledgement");
    expect(ack.origin_system).toBe("SYS-B");
    expect(ack.target_system).toBe("SYS-A");
    expect(ack.conversation_id).toBe(challenge.conversation_id);
    expect(ack.causation_id).toBe(challenge.message_id);
    expect(ack.idempotency_key).toBe(`peer-ack:${challenge.message_id}`);
    expect(ack.expires_at_utc).toBe(challenge.expires_at_utc);
    expect(parsePeerCheck(ack, "test-network")).toEqual({
      protocol: "balcony-agent-bridge-peer-check",
      version: "1.0",
      type: "acknowledgement",
      network_id: "test-network",
      nonce: parsePeerCheck(challenge, "test-network").nonce,
      request_message_id: challenge.message_id,
    });
    expect(() =>
      createPeerAcknowledgement(challenge, "SYS-A", "test-network", NOW),
    ).toThrow(/target/);
    expect(() =>
      createPeerAcknowledgement(challenge, "SYS-B", "other-network", NOW),
    ).toThrow(/network/);
    expect(() =>
      createPeerAcknowledgement(
        challenge,
        "SYS-B",
        "test-network",
        new Date(NOW.getTime() + 60_000),
      ),
    ).toThrow(/expired/);
  });

  it("acknowledges a maximum-lifetime challenge when receiver clock trails by 20 seconds", () => {
    const challenge = createPeerChallenge({
      originSystem: "SYS-A",
      targetSystem: "SYS-B",
      networkId: "test-network",
      idempotencyKey: "skewed-max-timeout",
      timeoutSeconds: 300,
      now: NOW,
    });
    const receiverNow = new Date(NOW.getTime() - 20_000);
    const ack = createPeerAcknowledgement(
      challenge,
      "SYS-B",
      "test-network",
      receiverNow,
    );

    expect(ack.created_at_utc).toBe(challenge.created_at_utc);
    expect(ack.expires_at_utc).toBe(challenge.expires_at_utc);
    expect(parsePeerCheck(ack, "test-network").type).toBe("acknowledgement");
    expect(isPeerAcknowledgementFor(challenge, ack, "test-network", receiverNow)).toBe(
      true,
    );
  });

  it("matches only the original fresh challenge and its exact response binding", () => {
    const challenge = newChallenge();
    const ack = createPeerAcknowledgement(challenge, "SYS-B", "test-network", NOW);
    expect(isPeerAcknowledgementFor(challenge, ack, "test-network", NOW)).toBe(true);
    expect(
      isPeerAcknowledgementFor(
        challenge,
        { ...ack, expires_at_utc: "2026-09-28T17:31:00.000+05:30" },
        "test-network",
        NOW,
      ),
    ).toBe(true);
    const ackBody = parsePeerCheck(ack, "test-network");
    expect(ackBody.type).toBe("acknowledgement");
    if (ackBody.type !== "acknowledgement") return;
    const unrelated = newChallenge();
    const otherId = "11111111-1111-4111-8111-111111111111";
    const altered: BridgeEnvelope[] = [
      { ...ack, origin_system: "SYS-A", target_system: "SYS-B" },
      { ...ack, conversation_id: otherId },
      { ...ack, causation_id: otherId },
      { ...ack, expires_at_utc: "2026-09-28T12:01:01.000Z" },
      replaceBody(ack, { ...ackBody, nonce: "0".repeat(64) }),
      replaceBody(ack, { ...ackBody, request_message_id: otherId }),
    ];
    for (const invalid of altered) {
      expect(isPeerAcknowledgementFor(challenge, invalid, "test-network", NOW)).toBe(false);
    }
    expect(isPeerAcknowledgementFor(unrelated, ack, "test-network", NOW)).toBe(false);
    expect(isPeerAcknowledgementFor(challenge, ack, "other-network", NOW)).toBe(false);
    expect(
      isPeerAcknowledgementFor(
        challenge,
        ack,
        "test-network",
        new Date(NOW.getTime() + 60_000),
      ),
    ).toBe(false);
    expect(() =>
      assertFreshPeerCheck(challenge, new Date(NOW.getTime() - 30_001)),
    ).toThrow(/future/);
    expect(() =>
      assertFreshPeerCheck(challenge, new Date(NOW.getTime() - 30_000)),
    ).not.toThrow();
    expect(() =>
      parsePeerCheck({ ...challenge, expires_at_utc: undefined } as BridgeEnvelope, "test-network"),
    ).toThrow();
    expect(() =>
      parsePeerCheck(
        { ...challenge, expires_at_utc: "2026-09-28T12:05:00.001Z" },
        "test-network",
      ),
    ).toThrow(/lifetime/);
  });

  it("requires the same bounded network identifier as authenticated transport", () => {
    for (const networkId of ["", "Uppercase", "with spaces", "x".repeat(51), "network "]) {
      expect(() =>
        createPeerChallenge({
          originSystem: "SYS-A",
          targetSystem: "SYS-B",
          networkId,
          idempotencyKey: "bad-network",
          now: NOW,
        }),
      ).toThrow(/networkId/);
    }
    const body = parsePeerCheck(newChallenge(), "test-network");
    expect(() =>
      parsePeerCheck(
        replaceBody(newChallenge(), { ...body, network_id: "Uppercase" }),
        "Uppercase",
      ),
    ).toThrow(/body/);
  });

  it("reserves the peer-check stream for heartbeat and acknowledgement without task or dispatch fields", () => {
    const base = {
      originSystem: "SYS-A",
      targetSystem: "SYS-B",
      idempotencyKey: "reserved-stream",
      streamId: PEER_CHECK_STREAM,
      expiresAtUtc: "2026-09-28T12:01:00.000Z",
      now: NOW,
    };
    expect(() =>
      createEnvelope({
        ...base,
        kind: "task_request",
        payload: { subject: "Task", body: "Do work", evidence: [] },
      }),
    ).toThrow(/agent-peer-check/);
    expect(() =>
      createEnvelope({
        ...base,
        kind: "heartbeat",
        payload: {
          subject: "Task-disguised heartbeat",
          body: "{}",
          task_reference: "task-1",
          dispatch: { executor: "codex_cli", access: "read_only" },
          evidence: [],
        },
      }),
    ).toThrow(/agent-peer-check/);
  });
});
