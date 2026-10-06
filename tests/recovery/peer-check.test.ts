import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { SignedPeerLab } from "../helpers/peer-check-lab.js";

const fixtures: Array<{ root: string; lab: SignedPeerLab }> = [];
afterEach(async () => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  for (const { root, lab } of fixtures.splice(0)) {
    await lab.close();
    expect(path.dirname(root)).toBe(os.tmpdir());
    expect(fs.realpathSync.native(root).toLowerCase()).toBe(root.toLowerCase());
    fs.rmSync(root, { recursive: true });
  }
});

it("recovers send failures and accepted-but-unsettled deliveries without generating a second reply", async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date());
  const diagnosticLog = vi.spyOn(console, "error").mockImplementation(() => {});
  const { lab, a, b } = fixture();
  const check = a.checks.start("node-b", "interruption", 120);
  lab.broker.failNextSend();
  await a.worker.runOutboundOnce();
  expect(a.checks.status(check.check_id).status).toBe("queued");
  expect(lab.broker.queue("node-b")).toHaveLength(0);
  const resumedA = await lab.reopen("node-a");
  vi.setSystemTime(new Date(Date.now() + 3000));
  await resumedA.worker.runOutboundOnce();
  lab.broker.failNextComplete();
  await b.worker.runInboundOnce();
  expect(b.database.getInboxMessage(check.check_id)?.state).toBe("available");
  expect(lab.broker.queue("node-b")[0]?.settlement).toBe("available");
  const resumedB = await lab.reopen("node-b");
  await resumedB.worker.runInboundOnce(); // Same signed delivery, persisted duplicate.
  lab.broker.failNextSend();
  await resumedB.worker.runOutboundOnce(); // Reply atomically persisted, send failed.
  const finalB = await lab.reopen("node-b");
  vi.setSystemTime(new Date(Date.now() + 3000));
  await finalB.worker.runOutboundOnce();
  expect(lab.broker.queue("node-a")).toHaveLength(1);
  lab.broker.failNextComplete();
  await resumedA.worker.runInboundOnce();
  const finalA = await lab.reopen("node-a");
  await finalA.worker.runInboundOnce();
  expect(finalA.checks.status(check.check_id).verified).toBe(true);
  expect(finalB.database.getInboxMessage(check.check_id)?.state).toBe("processed");
  expect(diagnosticLog.mock.calls.flat().join(" ")).toContain("completion was not confirmed");
});

it("recovers an abandoned responder claim after its lease, within the original deadline", async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date());
  const { lab, a, b } = fixture();
  const check = a.checks.start("node-b", "claim-recovery", 120);
  await a.worker.runOutboundOnce();
  await b.worker.runInboundOnce();
  expect(b.database.claimPeerChallenges("interrupted-consumer")).toHaveLength(1);
  const resumedB = await lab.reopen("node-b");
  expect(await resumedB.worker.runOutboundOnce()).toBe(0);
  vi.setSystemTime(new Date(Date.now() + 31_000));
  expect(await resumedB.worker.runOutboundOnce()).toBe(1);
  await a.worker.runInboundOnce();
  expect(a.checks.status(check.check_id).verified).toBe(true);
  expect(lab.broker.queue("node-a")).toHaveLength(1);
});

it("expires an offline probe and requires a new key rather than renewing the old nonce", async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date());
  const { lab, a, b } = fixture();
  const check = a.checks.start("node-b", "expired", 1);
  await a.worker.runOutboundOnce();
  vi.setSystemTime(new Date(Date.now() + 1000));
  await b.worker.runInboundOnce();
  expect(lab.broker.queue("node-b")[0]?.settlement).toBe("dead-lettered");
  const resumed = await lab.reopen("node-a");
  expect(resumed.checks.start("node-b", "expired", 1)).toMatchObject({
    check_id: check.check_id, status: "expired", verified: false,
  });
  const fresh = resumed.checks.start("node-b", "fresh", 60);
  expect(fresh.check_id).not.toBe(check.check_id);
  expect(fresh.status).toBe("queued");
});

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "bridge-peer-recovery-"));
  const lab = new SignedPeerLab();
  fixtures.push({ root, lab });
  const a = lab.newNode("node-a", ["node-b"], path.join(root, "a.sqlite3"));
  const b = lab.newNode("node-b", ["node-a"], path.join(root, "b.sqlite3"));
  return { lab, a, b };
}
