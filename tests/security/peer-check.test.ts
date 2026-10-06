import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { SignedPeerLab } from "../helpers/peer-check-lab.js";
import { createPeerAcknowledgement } from "../../src/contracts/peer-check.js";
import { hashPayload } from "../../src/contracts/envelope.js";
import type { MessageAuthWire } from "../../src/security/message-authentication.js";

const fixtures: Array<{ root: string; lab: SignedPeerLab }> = [];
afterEach(async () => {
  for (const { root, lab } of fixtures.splice(0)) {
    await lab.close();
    expect(path.dirname(root)).toBe(os.tmpdir());
    expect(fs.realpathSync.native(root).toLowerCase()).toBe(root.toLowerCase());
    fs.rmSync(root, { recursive: true });
  }
});

it.each(["signature", "network", "revoked-peer", "wrong-node"] as const)(
  "rejects %s at the production signed transport boundary without producing peer proof",
  async (fault) => {
    const { root, lab, a, b } = fixture();
    const check = a.checks.start("node-b", fault);
    await a.worker.runOutboundOnce();
    let receiver = b;
    let target = "node-b";
    if (fault === "signature" || fault === "network") {
      lab.broker.mutateSignedBody("node-b", (body) => ({
        ...(body as MessageAuthWire),
        ...(fault === "signature" ? { signature: "invalid-signature" } : { network_id: "another-network" }),
      }));
    } else if (fault === "revoked-peer") {
      receiver = await lab.reopen("node-b", { "node-a": "revoked" });
    } else {
      receiver = lab.newNode("node-c", ["node-a"], path.join(root, "c.sqlite3"));
      lab.broker.reroute("node-b", "node-c");
      target = "node-c";
    }
    await receiver.worker.runInboundOnce();
    expect(receiver.database.getInboxMessage(check.check_id)).toBeUndefined();
    expect(await receiver.worker.runOutboundOnce()).toBe(0);
    expect(a.checks.status(check.check_id).verified).toBe(false);
    expect(lab.broker.queue(target)[0]).toMatchObject({
      settlement: "dead-lettered", deadLetterReason: "MessageAuthenticationFailed",
    });
  },
);

it("does not turn an authenticated but wrong-nonce reply into proof", async () => {
  const { lab, a, b } = fixture();
  const check = a.checks.start("node-b", "wrong-nonce");
  const challenge = a.database.getOutboxMessage(check.check_id)!.envelope;
  const ack = createPeerAcknowledgement(challenge, "node-b", "peer-lab");
  const payload = { ...ack.payload, body: JSON.stringify({
    ...JSON.parse(ack.payload.body), nonce: "0".repeat(64),
  }) };
  await b.transport.send({ ...ack, payload, payload_sha256: hashPayload(payload) });
  await a.worker.runInboundOnce();
  expect(a.database.getInboxMessage(ack.message_id)?.authenticatedIngress).toBe(true);
  expect(a.checks.status(check.check_id).verified).toBe(false);
  expect(lab.broker.queue("node-a")[0]?.settlement).toBe("completed");
});

it("requires approval on the receiving side, not just enrollment by the initiator", async () => {
  const { root, lab, a } = fixture();
  const c = lab.newNode("node-c", ["node-a"], path.join(root, "c.sqlite3"));
  const check = c.checks.start("node-a", "one-sided-enrollment");
  await c.worker.runOutboundOnce();
  await a.worker.runInboundOnce();
  expect(a.database.getInboxMessage(check.check_id)).toBeUndefined();
  expect(c.checks.status(check.check_id).verified).toBe(false);
  expect(lab.broker.queue("node-a")[0]?.settlement).toBe("dead-lettered");
});

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "bridge-peer-security-"));
  const lab = new SignedPeerLab();
  fixtures.push({ root, lab });
  const a = lab.newNode("node-a", ["node-b"], path.join(root, "a.sqlite3"));
  const b = lab.newNode("node-b", ["node-a"], path.join(root, "b.sqlite3"));
  return { root, lab, a, b };
}
