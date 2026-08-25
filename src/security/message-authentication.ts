import {
  createHash,
  createPrivateKey,
  createPublicKey,
  sign,
  verify,
  type KeyObject,
} from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { z } from "zod";

import {
  BridgeEnvelopeSchema,
  SystemIdSchema,
  type BridgeEnvelope,
  type SystemId,
} from "../contracts/envelope.js";

const AUTH_PROTOCOL = "balcony-agent-bridge-message-auth";
const AUTH_VERSION = "1.0";
const MAX_FILE_BYTES = 1024 * 1024;
const MAX_PRIVATE_KEY_BYTES = 64 * 1024;
const MAX_WIRE_LIFETIME_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_FUTURE_ISSUE_MS = 5 * 60 * 1000;

const NetworkIdSchema = z
  .string()
  .trim()
  .min(1)
  .max(50)
  .regex(/^[a-z][a-z0-9-]*$/, "must be a bounded lowercase network identifier");

const KeyIdSchema = z
  .string()
  .regex(/^ed25519:[A-Za-z0-9_-]{43}$/, "must be a derived Ed25519 key ID");

const MembershipKeySchema = z
  .object({
    key_id: KeyIdSchema,
    spki_der_base64url: z.string().min(1).max(1024).regex(/^[A-Za-z0-9_-]+$/),
    status: z.enum(["active", "revoked"]),
    not_before_utc: z.string().datetime({ offset: true }).optional(),
    not_after_utc: z.string().datetime({ offset: true }).optional(),
  })
  .strict();

const MembershipPeerSchema = z
  .object({
    node_id: SystemIdSchema,
    keys: z.array(MembershipKeySchema).min(1).max(4),
  })
  .strict();

const MembershipSchema = z
  .object({
    schema_version: z.literal("1.0"),
    network_id: NetworkIdSchema,
    peers: z.array(MembershipPeerSchema).max(32),
  })
  .strict();

const WireSchema = z
  .object({
    protocol: z.literal(AUTH_PROTOCOL),
    auth_version: z.literal(AUTH_VERSION),
    network_id: NetworkIdSchema,
    key_id: KeyIdSchema,
    issued_at_utc: z.string().datetime({ offset: true }),
    expires_at_utc: z.string().datetime({ offset: true }),
    envelope: BridgeEnvelopeSchema,
    signature: z.string().min(1).max(256).regex(/^[A-Za-z0-9_-]+$/),
  })
  .strict();

type Membership = z.infer<typeof MembershipSchema>;
type MembershipKey = z.infer<typeof MembershipKeySchema>;

export type MessageAuthWire = z.infer<typeof WireSchema>;

export interface MessageAuthenticatorOptions {
  localNodeId: SystemId;
  authorizedNodeIds: readonly SystemId[];
  membershipPath: string;
  signingKeyPath: string;
}

export type MessageAuthenticationErrorCode =
  | "MESSAGE_AUTH_CONFIGURATION"
  | "MESSAGE_AUTH_INVALID"
  | "MESSAGE_AUTH_UNAUTHORIZED"
  | "MESSAGE_AUTH_EXPIRED"
  | "MESSAGE_AUTH_SIGNATURE";

export class MessageAuthenticationError extends Error {
  public constructor(public readonly code: MessageAuthenticationErrorCode) {
    super("Message authentication rejected.");
    this.name = "MessageAuthenticationError";
  }
}

export class MessageAuthenticator {
  private readonly peerKeys: ReadonlyMap<SystemId, readonly VerifiedMembershipKey[]>;

  public constructor(
    private readonly localNodeId: SystemId,
    private readonly membership: Membership,
    private readonly signingKey: KeyObject,
    private readonly signingKeyId: string,
  ) {
    this.peerKeys = buildPeerKeyIndex(membership);
  }

  public sign(envelopeValue: unknown, now = new Date()): MessageAuthWire {
    try {
      const envelope = BridgeEnvelopeSchema.parse(envelopeValue);
      if (envelope.origin_system !== this.localNodeId) {
        throw authenticationError("MESSAGE_AUTH_UNAUTHORIZED");
      }
      if (!hasActiveKey(this.peerKeys.get(envelope.target_system), now)) {
        throw authenticationError("MESSAGE_AUTH_UNAUTHORIZED");
      }

      const unsigned = {
        protocol: AUTH_PROTOCOL,
        auth_version: AUTH_VERSION,
        network_id: this.membership.network_id,
        key_id: this.signingKeyId,
        issued_at_utc: now.toISOString(),
        expires_at_utc: boundedExpiry(envelope, now),
        envelope,
      };
      const signature = sign(null, signingBytes(unsigned), this.signingKey).toString(
        "base64url",
      );
      return WireSchema.parse({ ...unsigned, signature });
    } catch (error) {
      if (error instanceof MessageAuthenticationError) {
        throw error;
      }
      throw authenticationError("MESSAGE_AUTH_INVALID");
    }
  }

  public verify(value: unknown, now = new Date()): BridgeEnvelope {
    try {
      const wire = WireSchema.parse(value);
      if (wire.network_id !== this.membership.network_id) {
        throw authenticationError("MESSAGE_AUTH_UNAUTHORIZED");
      }
      validateWireLifetime(wire, now);
      if (wire.envelope.target_system !== this.localNodeId) {
        throw authenticationError("MESSAGE_AUTH_UNAUTHORIZED");
      }
      const peerKeys = this.peerKeys.get(wire.envelope.origin_system);
      const membershipKey = peerKeys?.find(
        (candidate) => candidate.keyId === wire.key_id,
      );
      if (
        !membershipKey ||
        !isActive(membershipKey, now) ||
        !isWithinValidityWindow(
          membershipKey,
          new Date(Date.parse(wire.issued_at_utc)),
        )
      ) {
        throw authenticationError("MESSAGE_AUTH_UNAUTHORIZED");
      }
      const signed = {
        protocol: wire.protocol,
        auth_version: wire.auth_version,
        network_id: wire.network_id,
        key_id: wire.key_id,
        issued_at_utc: wire.issued_at_utc,
        expires_at_utc: wire.expires_at_utc,
        envelope: wire.envelope,
      };
      const signature = Buffer.from(wire.signature, "base64url");
      if (!verify(null, signingBytes(signed), membershipKey.publicKey, signature)) {
        throw authenticationError("MESSAGE_AUTH_SIGNATURE");
      }
      return wire.envelope;
    } catch (error) {
      if (error instanceof MessageAuthenticationError) {
        throw error;
      }
      throw authenticationError("MESSAGE_AUTH_INVALID");
    }
  }
}

interface VerifiedMembershipKey {
  keyId: string;
  publicKey: KeyObject;
  status: "active" | "revoked";
  notBeforeUtc?: string;
  notAfterUtc?: string;
}

export function loadMessageAuthenticator(
  options: MessageAuthenticatorOptions,
): MessageAuthenticator {
  try {
    const localNodeId = SystemIdSchema.parse(options.localNodeId);
    const authorizedNodeIds = validateAuthorizedNodeIds(
      options.authorizedNodeIds,
      localNodeId,
    );
    assertDistinctAuthenticationFiles(
      options.membershipPath,
      options.signingKeyPath,
    );
    const membership = loadMembership(options.membershipPath, authorizedNodeIds);
    const signingKey = loadSigningKey(options.signingKeyPath);
    const signingKeyId = deriveKeyId(exportSpkiDer(createPublicKey(signingKey)));
    return new MessageAuthenticator(localNodeId, membership, signingKey, signingKeyId);
  } catch (error) {
    if (error instanceof MessageAuthenticationError) {
      throw error;
    }
    throw authenticationError("MESSAGE_AUTH_CONFIGURATION");
  }
}

export const createMessageAuthenticator = loadMessageAuthenticator;

function loadMembership(
  membershipPath: string,
  authorizedNodeIds: readonly SystemId[],
): Membership {
  const membership = MembershipSchema.parse(
    JSON.parse(readRegularFile(membershipPath, MAX_FILE_BYTES).toString("utf8")),
  );
  const peerIds = membership.peers.map((peer) => peer.node_id);
  if (
    new Set(peerIds).size !== peerIds.length ||
    peerIds.length !== authorizedNodeIds.length ||
    peerIds.some((nodeId) => !authorizedNodeIds.includes(nodeId))
  ) {
    throw authenticationError("MESSAGE_AUTH_CONFIGURATION");
  }
  const globalKeyIds = new Set<string>();
  const globalPublicKeys = new Set<string>();
  for (const peer of membership.peers) {
    const keyIds = new Set<string>();
    for (const key of peer.keys) {
      if (
        keyIds.has(key.key_id) ||
        globalKeyIds.has(key.key_id) ||
        globalPublicKeys.has(key.spki_der_base64url)
      ) {
        throw authenticationError("MESSAGE_AUTH_CONFIGURATION");
      }
      keyIds.add(key.key_id);
      globalKeyIds.add(key.key_id);
      globalPublicKeys.add(key.spki_der_base64url);
      validateMembershipKey(key);
    }
  }
  return membership;
}

function validateMembershipKey(key: MembershipKey): void {
  const publicKey = createPublicKey({
    key: Buffer.from(key.spki_der_base64url, "base64url"),
    format: "der",
    type: "spki",
  });
  if (
    publicKey.asymmetricKeyType !== "ed25519" ||
    deriveKeyId(exportSpkiDer(publicKey)) !== key.key_id
  ) {
    throw authenticationError("MESSAGE_AUTH_CONFIGURATION");
  }
  if (
    key.not_before_utc &&
    key.not_after_utc &&
    Date.parse(key.not_after_utc) <= Date.parse(key.not_before_utc)
  ) {
    throw authenticationError("MESSAGE_AUTH_CONFIGURATION");
  }
}

function buildPeerKeyIndex(
  membership: Membership,
): ReadonlyMap<SystemId, readonly VerifiedMembershipKey[]> {
  return new Map(
    membership.peers.map((peer) => [
      peer.node_id,
      peer.keys.map((key) => ({
        keyId: key.key_id,
        publicKey: createPublicKey({
          key: Buffer.from(key.spki_der_base64url, "base64url"),
          format: "der",
          type: "spki",
        }),
        status: key.status,
        ...(key.not_before_utc ? { notBeforeUtc: key.not_before_utc } : {}),
        ...(key.not_after_utc ? { notAfterUtc: key.not_after_utc } : {}),
      })),
    ]),
  );
}

function loadSigningKey(signingKeyPath: string): KeyObject {
  const privateKey = createPrivateKey({
    key: readRegularFile(signingKeyPath, MAX_PRIVATE_KEY_BYTES).toString("utf8"),
    format: "pem",
    type: "pkcs8",
  });
  if (privateKey.asymmetricKeyType !== "ed25519") {
    throw authenticationError("MESSAGE_AUTH_CONFIGURATION");
  }
  return privateKey;
}

function validateAuthorizedNodeIds(
  values: readonly SystemId[],
  localNodeId: SystemId,
): SystemId[] {
  const authorizedNodeIds = values.map((value) => SystemIdSchema.parse(value));
  if (
    authorizedNodeIds.length === 0 ||
    authorizedNodeIds.length > 32 ||
    new Set(authorizedNodeIds).size !== authorizedNodeIds.length ||
    authorizedNodeIds.includes(localNodeId)
  ) {
    throw authenticationError("MESSAGE_AUTH_CONFIGURATION");
  }
  return authorizedNodeIds;
}

function readRegularFile(filePath: string, maximumBytes: number): Buffer {
  if (!path.isAbsolute(filePath)) {
    throw authenticationError("MESSAGE_AUTH_CONFIGURATION");
  }
  const metadata = fs.lstatSync(filePath);
  if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size > maximumBytes) {
    throw authenticationError("MESSAGE_AUTH_CONFIGURATION");
  }
  return fs.readFileSync(filePath);
}

function boundedExpiry(envelope: BridgeEnvelope, now: Date): string {
  const maximum = now.getTime() + MAX_WIRE_LIFETIME_MS;
  const envelopeExpiry = envelope.expires_at_utc
    ? Date.parse(envelope.expires_at_utc)
    : maximum;
  const expiry = Math.min(maximum, envelopeExpiry);
  if (!Number.isFinite(expiry) || expiry <= now.getTime()) {
    throw authenticationError("MESSAGE_AUTH_EXPIRED");
  }
  return new Date(expiry).toISOString();
}

function validateWireLifetime(wire: MessageAuthWire, now: Date): void {
  const issuedAt = Date.parse(wire.issued_at_utc);
  const expiresAt = Date.parse(wire.expires_at_utc);
  const envelopeExpiry = wire.envelope.expires_at_utc
    ? Date.parse(wire.envelope.expires_at_utc)
    : undefined;
  if (
    !Number.isFinite(issuedAt) ||
    !Number.isFinite(expiresAt) ||
    issuedAt > now.getTime() + MAX_FUTURE_ISSUE_MS ||
    expiresAt <= issuedAt ||
    expiresAt - issuedAt > MAX_WIRE_LIFETIME_MS ||
    expiresAt <= now.getTime() ||
    (envelopeExpiry !== undefined && expiresAt > envelopeExpiry)
  ) {
    throw authenticationError("MESSAGE_AUTH_EXPIRED");
  }
}

function assertDistinctAuthenticationFiles(
  membershipPath: string,
  signingKeyPath: string,
): void {
  if (
    !path.isAbsolute(membershipPath) ||
    !path.isAbsolute(signingKeyPath) ||
    path.resolve(membershipPath) === path.resolve(signingKeyPath)
  ) {
    throw authenticationError("MESSAGE_AUTH_CONFIGURATION");
  }
  const membershipMetadata = fs.lstatSync(membershipPath);
  const signingKeyMetadata = fs.lstatSync(signingKeyPath);
  if (
    membershipMetadata.isSymbolicLink() ||
    signingKeyMetadata.isSymbolicLink() ||
    (membershipMetadata.dev === signingKeyMetadata.dev &&
      membershipMetadata.ino === signingKeyMetadata.ino)
  ) {
    throw authenticationError("MESSAGE_AUTH_CONFIGURATION");
  }
}

function hasActiveKey(
  keys: readonly VerifiedMembershipKey[] | undefined,
  now: Date,
): boolean {
  return keys?.some((key) => isActive(key, now)) ?? false;
}

function isActive(key: VerifiedMembershipKey, now: Date): boolean {
  return key.status === "active" && isWithinValidityWindow(key, now);
}

function isWithinValidityWindow(key: VerifiedMembershipKey, at: Date): boolean {
  return (
    (!key.notBeforeUtc || Date.parse(key.notBeforeUtc) <= at.getTime()) &&
    (!key.notAfterUtc || Date.parse(key.notAfterUtc) > at.getTime())
  );
}

function exportSpkiDer(key: KeyObject): Buffer {
  return key.export({ format: "der", type: "spki" }) as Buffer;
}

function deriveKeyId(spkiDer: Buffer): string {
  return `ed25519:${createHash("sha256").update(spkiDer).digest("base64url")}`;
}

function signingBytes(value: Record<string, unknown>): Buffer {
  return Buffer.from(
    `${AUTH_PROTOCOL}:v${AUTH_VERSION}:` + canonicalJson(value),
    "utf8",
  );
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalJson(item)).join(",")}]`;
  }
  return `{${Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
    .map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`)
    .join(",")}}`;
}

function authenticationError(
  code: MessageAuthenticationErrorCode,
): MessageAuthenticationError {
  return new MessageAuthenticationError(code);
}
