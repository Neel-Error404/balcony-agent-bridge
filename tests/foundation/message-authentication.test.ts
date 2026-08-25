import { createHash, generateKeyPairSync } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  MessageAuthenticationError,
  loadMessageAuthenticator,
  type MessageAuthWire,
} from "../../src/security/message-authentication.js";
import { createEnvelope } from "../../src/contracts/envelope.js";

const NOW = new Date("2026-08-25T12:00:00.000Z");
const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

describe("message authentication", () => {
  it("signs and verifies a valid Ed25519 wire wrapper", () => {
    const a = createNode("node-a", ["node-b"]);
    const b = createNode("node-b", ["node-a"]);
    writeMembership(a, [peer("node-b", b.publicKeyDer)]);
    writeMembership(b, [peer("node-a", a.publicKeyDer)]);

    const signed = a.authenticator().sign(envelope("node-a", "node-b"), NOW);

    expect(b.authenticator().verify(signed, NOW)).toEqual(signed.envelope);
    expect(signed).toMatchObject({
      protocol: "balcony-agent-bridge-message-auth",
      auth_version: "1.0",
      network_id: "bridge-net",
      key_id: keyId(a.publicKeyDer),
    });
  });

  it("accepts an exact valid replay identically within its wire lifetime", () => {
    const a = createNode("node-a", ["node-b"]);
    const b = createNode("node-b", ["node-a"]);
    writeMembership(a, [peer("node-b", b.publicKeyDer)]);
    writeMembership(b, [peer("node-a", a.publicKeyDer)]);
    const signed = a.authenticator().sign(envelope("node-a", "node-b"), NOW);
    const verifier = b.authenticator();

    expect(verifier.verify(signed, NOW)).toEqual(signed.envelope);
    expect(verifier.verify(signed, NOW)).toEqual(signed.envelope);
  });

  it("rejects a wire expiry later than the envelope expiry before signature verification", () => {
    const a = createNode("node-a", ["node-b"]);
    const b = createNode("node-b", ["node-a"]);
    writeMembership(a, [peer("node-b", b.publicKeyDer)]);
    writeMembership(b, [peer("node-a", a.publicKeyDer)]);
    const signed = a.authenticator().sign(envelope("node-a", "node-b"), NOW);
    const invalidExpiry = structuredClone(signed);
    invalidExpiry.envelope.expires_at_utc = "2026-08-26T12:00:00.000Z";

    expectAuthenticationErrorCode(
      () => b.authenticator().verify(invalidExpiry, NOW),
      "MESSAGE_AUTH_EXPIRED",
    );
  });

  it("rejects payload and target tampering", () => {
    const a = createNode("node-a", ["node-b"]);
    const b = createNode("node-b", ["node-a"]);
    const c = createNode("node-c", ["node-a"]);
    writeMembership(a, [peer("node-b", b.publicKeyDer)]);
    writeMembership(b, [peer("node-a", a.publicKeyDer)]);
    writeMembership(c, [peer("node-a", a.publicKeyDer)]);
    const signed = a.authenticator().sign(envelope("node-a", "node-b"), NOW);

    const changedPayload = structuredClone(signed);
    changedPayload.envelope.payload.body = "Changed after signing";
    const changedTarget = structuredClone(signed);
    changedTarget.envelope.target_system = "node-c";

    expectAuthenticationFailure(() => b.authenticator().verify(changedPayload, NOW));
    expectAuthenticationFailure(() => c.authenticator().verify(changedTarget, NOW));
  });

  it("rejects a valid signer spoofing a different origin", () => {
    const a = createNode("node-a", ["node-b"]);
    const c = createNode("node-c", ["node-b"]);
    const b = createNode("node-b", ["node-a", "node-c"]);
    writeMembership(a, [peer("node-b", b.publicKeyDer)]);
    writeMembership(c, [peer("node-b", b.publicKeyDer)]);
    writeMembership(b, [
      peer("node-a", a.publicKeyDer),
      peer("node-c", c.publicKeyDer),
    ]);

    const signedByA = a.authenticator().sign(envelope("node-a", "node-b"), NOW);
    const spoofed = {
      ...signedByA,
      envelope: { ...signedByA.envelope, origin_system: "node-c" },
    };

    expectAuthenticationFailure(() => b.authenticator().verify(spoofed, NOW));
  });

  it("rejects unknown, revoked, and expired membership keys", () => {
    const a = createNode("node-a", ["node-b"]);
    const b = createNode("node-b", ["node-a"]);
    const unknown = createNode("node-c", ["node-a"]);
    writeMembership(a, [peer("node-b", b.publicKeyDer)]);
    const signed = a.authenticator().sign(envelope("node-a", "node-b"), NOW);

    writeMembership(b, [peer("node-a", unknown.publicKeyDer)]);
    expectAuthenticationFailure(() => b.authenticator().verify(signed, NOW));

    writeMembership(b, [peer("node-a", a.publicKeyDer, { status: "revoked" })]);
    expectAuthenticationFailure(() => b.authenticator().verify(signed, NOW));

    writeMembership(b, [
      peer("node-a", a.publicKeyDer, {
        not_after_utc: "2026-08-25T11:59:59.000Z",
      }),
    ]);
    expectAuthenticationFailure(() => b.authenticator().verify(signed, NOW));
  });

  it("rejects unsigned and malformed wrappers without echoing message bodies", () => {
    const a = createNode("node-a", ["node-b"]);
    const b = createNode("node-b", ["node-a"]);
    writeMembership(a, [peer("node-b", b.publicKeyDer)]);
    writeMembership(b, [peer("node-a", a.publicKeyDer)]);
    const body = "private task body must never be echoed";
    const signed = a.authenticator().sign(envelope("node-a", "node-b", body), NOW);

    expectAuthenticationFailure(() => b.authenticator().verify(signed.envelope, NOW), body);
    expectAuthenticationFailure(() => b.authenticator().verify({ protocol: "bad" }, NOW), body);
  });

  it("rejects cross-network, expired, and future wrappers", () => {
    const a = createNode("node-a", ["node-b"]);
    const b = createNode("node-b", ["node-a"]);
    writeMembership(a, [peer("node-b", b.publicKeyDer)], "bridge-net");
    writeMembership(b, [peer("node-a", a.publicKeyDer)], "other-net");
    const signed = a.authenticator().sign(envelope("node-a", "node-b"), NOW);

    expectAuthenticationFailure(() => b.authenticator().verify(signed, NOW));

    writeMembership(b, [peer("node-a", a.publicKeyDer)], "bridge-net");
    expectAuthenticationFailure(() =>
      b.authenticator().verify(signed, new Date("2026-09-02T12:00:00.000Z")),
    );
    const futureSigned = a.authenticator().sign(
      envelope("node-a", "node-b"),
      new Date("2026-08-25T12:06:00.000Z"),
    );
    expectAuthenticationFailure(() => b.authenticator().verify(futureSigned, NOW));
  });

  it("accepts either active key during a bounded peer key rotation", () => {
    const aOld = createNode("node-a", ["node-b"]);
    const aNew = createNode("node-a", ["node-b"]);
    const b = createNode("node-b", ["node-a"]);
    writeMembership(aOld, [peer("node-b", b.publicKeyDer)]);
    writeMembership(aNew, [peer("node-b", b.publicKeyDer)]);
    writeMembership(b, [
      peerWithKeys("node-a", [aOld.publicKeyDer, aNew.publicKeyDer]),
    ]);

    const oldSigned = aOld.authenticator().sign(envelope("node-a", "node-b"), NOW);
    const newSigned = aNew.authenticator().sign(envelope("node-a", "node-b"), NOW);

    expect(b.authenticator().verify(oldSigned, NOW)).toEqual(oldSigned.envelope);
    expect(b.authenticator().verify(newSigned, NOW)).toEqual(newSigned.envelope);
  });

  it("rejects membership documents whose peers do not exactly match authorized nodes", () => {
    const a = createNode("node-a", ["node-b"]);
    writeMembership(a, [peer("node-c", a.publicKeyDer)]);

    expectAuthenticationFailure(() => a.authenticator());
  });

  it("rejects a derived public key reused by different peer nodes", () => {
    const a = createNode("node-a", ["node-b"]);
    const b = createNode("node-b", ["node-a", "node-c"]);
    writeMembership(b, [
      peer("node-a", a.publicKeyDer),
      peer("node-c", a.publicKeyDer),
    ]);

    expectAuthenticationErrorCode(
      () => b.authenticator(),
      "MESSAGE_AUTH_CONFIGURATION",
    );
  });

  it("rejects a valid signature issued before its peer key activation window", () => {
    const a = createNode("node-a", ["node-b"]);
    const b = createNode("node-b", ["node-a"]);
    writeMembership(a, [peer("node-b", b.publicKeyDer)]);
    const signed = a.authenticator().sign(envelope("node-a", "node-b"), NOW);
    writeMembership(b, [
      peer("node-a", a.publicKeyDer, {
        not_before_utc: "2026-08-25T12:01:00.000Z",
      }),
    ]);

    expectAuthenticationErrorCode(
      () =>
        b.authenticator().verify(
          signed,
          new Date("2026-08-25T12:02:00.000Z"),
        ),
      "MESSAGE_AUTH_UNAUTHORIZED",
    );
  });

  it("rejects membership and signing paths that resolve to the same file", () => {
    const a = createNode("node-a", ["node-b"]);
    const b = createNode("node-b", ["node-a"]);
    writeMembership(a, [peer("node-b", b.publicKeyDer)]);

    expectAuthenticationErrorCode(
      () =>
        loadMessageAuthenticator({
          localNodeId: "node-a",
          authorizedNodeIds: ["node-b"],
          membershipPath: a.membershipPath,
          signingKeyPath: a.membershipPath,
        }),
      "MESSAGE_AUTH_CONFIGURATION",
    );
  });

  it("rejects signing to a peer without an active policy key", () => {
    const a = createNode("node-a", ["node-b"]);
    const b = createNode("node-b", ["node-a"]);
    writeMembership(a, [peer("node-b", b.publicKeyDer, { status: "revoked" })]);

    expectAuthenticationFailure(() => a.authenticator().sign(envelope("node-a", "node-b"), NOW));
  });
});

function createNode(nodeId: string, authorizedNodeIds: string[]) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "bridge-message-auth-"));
  temporaryDirectories.push(directory);
  const pair = generateKeyPairSync("ed25519");
  const signingKeyPath = path.join(directory, "signing-key.pem");
  const membershipPath = path.join(directory, "membership.json");
  fs.writeFileSync(
    signingKeyPath,
    pair.privateKey.export({ format: "pem", type: "pkcs8" }),
    { mode: 0o600 },
  );
  return {
    nodeId,
    authorizedNodeIds,
    membershipPath,
    signingKeyPath,
    publicKeyDer: pair.publicKey.export({ format: "der", type: "spki" }) as Buffer,
    authenticator: () =>
      loadMessageAuthenticator({
        localNodeId: nodeId,
        authorizedNodeIds,
        membershipPath,
        signingKeyPath,
      }),
  };
}

function writeMembership(
  node: ReturnType<typeof createNode>,
  peers: Array<Record<string, unknown>>,
  networkId = "bridge-net",
): void {
  fs.writeFileSync(
    node.membershipPath,
    `${JSON.stringify({ schema_version: "1.0", network_id: networkId, peers })}\n`,
    { mode: 0o600 },
  );
}

function peer(
  nodeId: string,
  publicKeyDer: Buffer,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    node_id: nodeId,
    keys: [
      {
        key_id: keyId(publicKeyDer),
        spki_der_base64url: publicKeyDer.toString("base64url"),
        status: "active",
        ...overrides,
      },
    ],
  };
}

function peerWithKeys(nodeId: string, publicKeys: Buffer[]): Record<string, unknown> {
  return {
    node_id: nodeId,
    keys: publicKeys.map((publicKeyDer) => ({
      key_id: keyId(publicKeyDer),
      spki_der_base64url: publicKeyDer.toString("base64url"),
      status: "active",
    })),
  };
}

function keyId(publicKeyDer: Buffer): string {
  return `ed25519:${createHash("sha256").update(publicKeyDer).digest("base64url")}`;
}

function envelope(originSystem: string, targetSystem: string, body = "Signed body") {
  return createEnvelope({
    idempotencyKey: `${originSystem}-${targetSystem}-${body}`,
    originSystem,
    targetSystem,
    kind: "message",
    streamId: "message-authentication-test",
    payload: { subject: "Authentication test", body, evidence: [] },
    now: NOW,
    expiresAtUtc: "2026-09-01T12:00:00.000Z",
  });
}

function expectAuthenticationFailure(operation: () => unknown, secret?: string): void {
  try {
    operation();
    throw new Error("Expected message authentication to fail");
  } catch (error) {
    expect(error).toBeInstanceOf(MessageAuthenticationError);
    const message = error instanceof Error ? error.message : String(error);
    if (secret) {
      expect(message).not.toContain(secret);
    }
  }
}

function expectAuthenticationErrorCode(
  operation: () => unknown,
  code: MessageAuthenticationError["code"],
): void {
  try {
    operation();
    throw new Error("Expected message authentication to fail");
  } catch (error) {
    expect(error).toBeInstanceOf(MessageAuthenticationError);
    expect((error as MessageAuthenticationError).code).toBe(code);
  }
}
