import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { BridgeDatabase } from "../../src/storage/database.js";
import { PeerCheckService } from "../../src/bridge/peer-check.js";
import { createPeerAcknowledgement } from "../../src/contracts/peer-check.js";
import { hashPayload } from "../../src/contracts/envelope.js";
import { BridgeWorker } from "../../src/bridge/worker.js";
import { FakeBridgeTransport } from "../../src/transport/fake-transport.js";
import { randomUUID } from "node:crypto";

const directories: string[] = [];
const databases: BridgeDatabase[] = [];
afterEach(() => {
  for (const db of databases.splice(0)) db.close();
  for (const directory of directories.splice(0)) {
    expect(path.dirname(directory)).toBe(os.tmpdir());
    expect(fs.realpathSync.native(directory).toLowerCase()).toBe(directory.toLowerCase());
    fs.rmSync(directory, { recursive: true });
  }
});
const at = new Date("2026-09-28T12:00:00.000Z");
const config = { systemId: "node-a", authorizedNodeIds: ["node-b"] };

describe("durable peer checks", () => {
  it("rejects unapproved peers and conflicting idempotency reuse", () => {
    const db = new BridgeDatabase(":memory:");
    databases.push(db);
    const service = new PeerCheckService(config, db, "peer-test");
    expect(() => service.start("node-c", "unapproved", 60, at)).toThrow(/enroll/);
    service.start("node-b", "same-key", 60, at);
    expect(() => service.start("node-b", "same-key", 61, at)).toThrow(/different diagnostic/);
    expect(() => new PeerCheckService(config, db, "other-net").start("node-b", "same-key", 60, at))
      .toThrow(/network/);
  });

  it("does not trust unauthenticated or wrong-nonce acknowledgements, and does not let one hide a valid reply", () => {
    const db = new BridgeDatabase(":memory:");
    databases.push(db);
    const service = new PeerCheckService(config, db, "peer-test");
    const check = service.start("node-b", "auth-boundary", 60, at);
    const challenge = db.getOutboxMessage(check.check_id)!.envelope;
    const ack = createPeerAcknowledgement(challenge, "node-b", "peer-test", at);
    db.persistIncoming(ack, 1, at, false);
    expect(service.status(check.check_id, at).verified).toBe(false);
    const payload = { ...ack.payload, body: JSON.stringify({
      ...JSON.parse(ack.payload.body), nonce: "0".repeat(64),
    }) };
    for (let i = 0; i < 32; i++) {
      db.persistIncoming({ ...ack, message_id: randomUUID(), payload, payload_sha256: hashPayload(payload) }, 1, at, true);
    }
    expect(service.status(check.check_id, at).verified).toBe(false);
    db.persistIncoming({ ...ack, message_id: randomUUID() }, 1, new Date(at.getTime() + 1), true);
    expect(service.status(check.check_id, at).verified).toBe(true);
  });

  it("ignores unauthenticated challenges and rejects expired or malformed authenticated challenges without replying", () => {
    const a = new BridgeDatabase(":memory:");
    const b = new BridgeDatabase(":memory:");
    databases.push(a, b);
    const sender = new PeerCheckService(config, a, "peer-test");
    const receiver = new PeerCheckService({ systemId: "node-b", authorizedNodeIds: ["node-a"] }, b, "peer-test");
    const first = sender.start("node-b", "untrusted", 60, at);
    b.persistIncoming(a.getOutboxMessage(first.check_id)!.envelope, 1, at, false);
    expect(receiver.respondPending(at)).toBe(0);
    const second = sender.start("node-b", "expired", 1, at);
    b.persistIncoming(a.getOutboxMessage(second.check_id)!.envelope, 1, at, true);
    const third = sender.start("node-b", "malformed", 60, at);
    const malformed = a.getOutboxMessage(third.check_id)!.envelope;
    const payload = { ...malformed.payload, body: "{not-json" };
    b.persistIncoming({ ...malformed, payload, payload_sha256: hashPayload(payload) }, 1, at, true);
    expect(receiver.respondPending(new Date(at.getTime() + 1000))).toBe(2);
    expect(b.getInboxMessage(second.check_id)?.state).toBe("rejected");
    expect(b.getInboxMessage(third.check_id)?.state).toBe("rejected");
    expect(b.getOutboxByIdempotency("node-a", `peer-ack:${second.check_id}`)).toBeUndefined();
    expect(b.getOutboxByIdempotency("node-a", `peer-ack:${third.check_id}`)).toBeUndefined();
  });

  it("uses the normal outbound worker cycle to answer a durable challenge", async () => {
    const a = new BridgeDatabase(":memory:");
    const b = new BridgeDatabase(":memory:");
    databases.push(a, b);
    const now = new Date();
    const check = new PeerCheckService(config, a, "peer-test").start("node-b", "worker", 60, now);
    b.persistIncoming(a.getOutboxMessage(check.check_id)!.envelope, 1, now, true);
    const peerConfig = { systemId: "node-b", authorizedNodeIds: ["node-a"],
      databasePath: ":memory:", topicName: "test", subscriptionName: "node-b",
      azureAuthMode: "managed_identity" as const };
    const responder = new PeerCheckService(peerConfig, b, "peer-test");
    const worker = new BridgeWorker(peerConfig, b, new FakeBridgeTransport(), responder);
    expect(await worker.runOutboundOnce(now)).toBe(1);
    expect(b.getOutboxByIdempotency("node-a", `peer-ack:${check.check_id}`)?.state).toBe("sent");
  });

  it("opens status read-only without creating or migrating a missing database", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "bridge-peer-service-"));
    directories.push(root);
    const missing = path.join(root, "missing", "a.sqlite3");
    expect(() => {
      const unexpected = new BridgeDatabase(missing, { readOnly: true });
      unexpected.close();
    }).toThrow();
    expect(fs.existsSync(path.dirname(missing))).toBe(false);
    const file = path.join(root, "a.sqlite3");
    const writer = new BridgeDatabase(file);
    const check = new PeerCheckService(config, writer, "peer-test").start("node-b", "read-only", 60, at);
    writer.close();
    const before = fs.readFileSync(file);
    const reader = new BridgeDatabase(file, { readOnly: true });
    expect(new PeerCheckService(config, reader, "peer-test").status(check.check_id, at).status).toBe("queued");
    expect(() => new PeerCheckService(config, reader, "peer-test").start("node-b", "forbidden-write", 60, at)).toThrow();
    reader.close();
    expect(fs.readFileSync(file)).toEqual(before);
  });

  it("reserves authenticated control messages and verifies only the matching persisted acknowledgement", () => {
    const a = new BridgeDatabase(":memory:");
    const b = new BridgeDatabase(":memory:");
    databases.push(a, b);
    const sender = new PeerCheckService(config, a, "peer-test");
    const receiver = new PeerCheckService({ systemId: "node-b", authorizedNodeIds: ["node-a"] }, b, "peer-test");
    const check = sender.start("node-b", "roundtrip", 60, at);
    const challenge = a.getOutboxMessage(check.check_id)!.envelope;
    b.persistIncoming(challenge, 1, at, true);
    expect(b.claimInbox("ordinary-agent", 10, 30, undefined, at)).toEqual([]);
    expect(receiver.respondPending(at)).toBe(1);
    expect(b.getInboxMessage(check.check_id)?.state).toBe("processed");
    expect(receiver.respondPending(at)).toBe(0);
    const ack = b.getOutboxByIdempotency("node-a", `peer-ack:${check.check_id}`)!.envelope;
    expect(sender.status(check.check_id, at).verified).toBe(false);
    a.persistIncoming(ack, 1, at, true);
    expect(sender.status(check.check_id, at)).toMatchObject({
      status: "verified", verified: true, communication_ready: false,
    });
    expect(a.claimInbox("ordinary-agent", 10, 30, undefined, at)).toEqual([]);
    expect(sender.status(check.check_id, new Date(at.getTime() + 60_000)).verified).toBe(false);
  });

  it("queues a bounded diagnostic and resumes the same nonce after a database reopen", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "bridge-peer-service-"));
    directories.push(root);
    const file = path.join(root, "a.sqlite3");
    const first = new BridgeDatabase(file);
    const service = new PeerCheckService(config, first, "peer-test");
    const started = service.start("node-b", "first-check", 60, at);
    expect(started).toMatchObject({ status: "queued", verified: false, peer_id: "node-b" });
    const original = first.getOutboxMessage(started.check_id)!.envelope;
    first.close();
    const reopened = new BridgeDatabase(file);
    databases.push(reopened);
    const resumed = new PeerCheckService(config, reopened, "peer-test");
    expect(resumed.start("node-b", "first-check", 60, new Date(at.getTime() + 1000)).check_id)
      .toBe(started.check_id);
    expect(reopened.getOutboxMessage(started.check_id)!.envelope).toEqual(original);
    expect(resumed.status(started.check_id, new Date(at.getTime() + 60_000)))
      .toMatchObject({ status: "expired", verified: false });
  });
});
