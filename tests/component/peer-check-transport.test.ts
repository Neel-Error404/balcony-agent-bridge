import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { expect, it } from "vitest";

import { createEnvelope, parseEnvelope } from "../../src/contracts/envelope.js";
import { SignedPeerLab } from "../helpers/peer-check-lab.js";

it("releases the receive-cycle latch when the SDK receiver close rejects", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "bridge-peer-close-"));
  const lab = new SignedPeerLab();
  try {
    const sender = lab.newNode(
      "node-a",
      ["node-b"],
      path.join(root, "node-a.sqlite3"),
    );
    const receiver = lab.newNode(
      "node-b",
      ["node-a"],
      path.join(root, "node-b.sqlite3"),
    );
    const envelope = createEnvelope({
      idempotencyKey: "close-error-receive-cycle",
      originSystem: "node-a",
      targetSystem: "node-b",
      kind: "message",
      streamId: "peer-close-regression",
      payload: { subject: "Close failure", body: "Signed delivery", evidence: [] },
    });

    await sender.transport.send(envelope);
    lab.broker.failNextReceiverClose();
    const received: string[] = [];
    await expect(
      receiver.transport.receiveAvailable(async (delivery) => {
        received.push(parseEnvelope(delivery.body).message_id);
        await delivery.complete();
      }),
    ).rejects.toThrow("Peer lab injected receiver close failure");

    expect(received).toEqual([envelope.message_id]);
    expect(lab.broker.queue("node-b")[0]?.settlement).toBe("completed");
    await expect(
      receiver.transport.receiveAvailable(async () => {
        throw new Error("No second delivery expected");
      }),
    ).resolves.toBe(0);
  } finally {
    await lab.close();
    const resolved = path.resolve(root);
    if (
      path.dirname(resolved) !== path.resolve(os.tmpdir()) ||
      !path.basename(resolved).startsWith("bridge-peer-close-")
    ) {
      throw new Error("Refusing to remove an unexpected peer lab directory");
    }
    fs.rmSync(resolved, { recursive: true, force: true });
  }
});
