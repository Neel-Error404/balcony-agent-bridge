import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { SignedPeerLab } from "../helpers/peer-check-lab.js";

const fixtures: Array<{ root: string; lab: SignedPeerLab }> = [];
afterEach(async () => {
  for (const { root, lab } of fixtures.splice(0)) {
    await lab.close();
    expect(path.dirname(root)).toBe(os.tmpdir());
    expect(fs.realpathSync.native(root).toLowerCase()).toBe(root.toLowerCase());
    fs.rmSync(root, { recursive: true });
  }
});

it("verifies separately initiated signed roundtrips in both directions after file-backed node reopen", async () => {
  const { lab, a, b } = fixture();
  const first = a.checks.start("node-b", "a-to-b");
  const second = b.checks.start("node-a", "b-to-a");
  await a.worker.runOutboundOnce();
  await b.worker.runOutboundOnce();
  expect(a.checks.status(first.check_id)).toMatchObject({ status: "waiting", verified: false });
  expect(b.checks.status(second.check_id)).toMatchObject({ status: "waiting", verified: false });
  await a.worker.runInboundOnce();
  await b.worker.runInboundOnce();
  // Persisted requests survive service/database reopen before producing replies.
  const reopenedA = await lab.reopen("node-a");
  const reopenedB = await lab.reopen("node-b");
  await reopenedA.worker.runOutboundOnce();
  await reopenedB.worker.runOutboundOnce();
  await reopenedA.worker.runInboundOnce();
  await reopenedB.worker.runInboundOnce();
  // The result is also recoverable from reopened local state.
  const finalA = await lab.reopen("node-a");
  const finalB = await lab.reopen("node-b");
  for (const [node, check] of [[finalA, first], [finalB, second]] as const) {
    expect(node.checks.status(check.check_id)).toMatchObject({
      status: "verified", verified: true, proof_scope: "signed_peer_roundtrip",
      communication_ready: false,
    });
  }
  for (const target of ["node-a", "node-b"]) {
    expect(lab.broker.queue(target)).toHaveLength(2);
    expect(lab.broker.queue(target).every((item) => item.settlement === "completed")).toBe(true);
    expect(lab.broker.queue(target)[0]?.wire.body).toMatchObject({
      protocol: "balcony-agent-bridge-message-auth", network_id: "peer-lab",
    });
  }
});

it("keeps an offline receiver pending and tolerates duplicates and reordered independent checks", async () => {
  const { lab, a, b } = fixture();
  const first = a.checks.start("node-b", "first");
  const second = a.checks.start("node-b", "second");
  await a.worker.runOutboundOnce();
  expect(a.checks.status(first.check_id).verified).toBe(false);
  lab.broker.duplicate("node-b");
  lab.broker.reverseQueue("node-b");
  // The fake SDK preserves one-session-per-receive semantics.
  await b.worker.runInboundOnce();
  await b.worker.runInboundOnce();
  await b.worker.runOutboundOnce();
  expect(lab.broker.queue("node-a")).toHaveLength(2); // Not three replies.
  lab.broker.reverseQueue("node-a");
  await a.worker.runInboundOnce();
  await a.worker.runInboundOnce();
  expect(a.checks.status(first.check_id).verified).toBe(true);
  expect(a.checks.status(second.check_id).verified).toBe(true);
});

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "bridge-peer-workflow-"));
  const lab = new SignedPeerLab();
  fixtures.push({ root, lab });
  const a = lab.newNode("node-a", ["node-b"], path.join(root, "a.sqlite3"));
  const b = lab.newNode("node-b", ["node-a"], path.join(root, "b.sqlite3"));
  return { lab, a, b };
}
