import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { BridgeWorker } from "../../src/bridge/worker.js";
import { createEnvelope } from "../../src/contracts/envelope.js";
import type { BridgeConfig } from "../../src/config.js";
import { BridgeDatabase } from "../../src/storage/database.js";
import { FakeBridgeTransport } from "../../src/transport/fake-transport.js";

describe("BridgeWorker", () => {
  let database: BridgeDatabase;
  let transport: FakeBridgeTransport;
  let worker: BridgeWorker;

  beforeEach(() => {
    database = new BridgeDatabase(":memory:");
    transport = new FakeBridgeTransport();
    const config: BridgeConfig = {
      systemId: "SYS-A",
      authorizedNodeIds: ["SYS-B", "node-c"],
      databasePath: ":memory:",
      topicName: "agent-messages",
      subscriptionName: "sys-a",
      azureAuthMode: "managed_identity",
    };
    worker = new BridgeWorker(config, database, transport);
  });

  afterEach(() => database.close());

  it("marks an outbox message sent only after transport success", async () => {
    const outgoing = envelope("SYS-A", "SYS-B", "outbound");
    database.enqueueEnvelope(outgoing);

    expect(
      await worker.runOutboundOnce(new Date("2026-08-13T12:00:00.000Z")),
    ).toBe(1);
    expect(transport.sent).toHaveLength(1);
    expect(database.getStatus().outbox.sent).toBe(1);
    expect(worker.getOutboundCycleOutcome()).toEqual({ kind: "sent" });
  });

  it("does not lease, receive, or mutate queued work when already aborted", async () => {
    const outgoing = envelope("SYS-A", "SYS-B", "pre-aborted-outbound");
    const incoming = envelope("SYS-B", "SYS-A", "pre-aborted-inbound");
    database.enqueueEnvelope(outgoing);
    transport.queueInbound({
      body: incoming,
      brokerMessageId: incoming.message_id,
      sessionId: incoming.conversation_id,
    });
    const lease = vi.spyOn(database, "leaseOutbox");
    const receive = vi.spyOn(transport, "receiveAvailable");
    const signal = AbortSignal.abort();

    expect(
      await worker.runOutboundOnce(new Date("2026-08-13T12:00:00.000Z"), signal),
    ).toBe(0);
    expect(await worker.runInboundOnce(signal)).toBe(0);
    expect(lease).not.toHaveBeenCalled();
    expect(receive).not.toHaveBeenCalled();
    expect(database.getStatus().outbox.pending).toBe(1);
    expect(database.getStatus().inbox.available).toBe(0);
    expect(transport.inbound[0]!.settlement).toBeUndefined();
    expect(worker.getOutboundCycleOutcome()).toEqual({ kind: "idle" });
  });

  it("leaves a send in flight leased and does not start later sends after abort", async () => {
    const first = envelope("SYS-A", "SYS-B", "abort-during-send-first");
    const second = envelope("SYS-A", "SYS-B", "abort-during-send-second");
    database.enqueueEnvelope(first);
    database.enqueueEnvelope(second);
    const controller = new AbortController();
    let resolveSend!: () => void;
    let signalSendStarted!: () => void;
    const sendStarted = new Promise<void>((resolve) => {
      signalSendStarted = resolve;
    });
    const sendBlocked = new Promise<void>((resolve) => {
      resolveSend = resolve;
    });
    const send = vi.spyOn(transport, "send").mockImplementationOnce(async (item) => {
      transport.sent.push(item);
      signalSendStarted();
      await sendBlocked;
    });
    const markSent = vi.spyOn(database, "markOutboxSent");
    const release = vi.spyOn(database, "releaseOutboxLease");
    const quarantine = vi.spyOn(database, "quarantineOutbox");
    const attempt = vi.spyOn(database, "recordDeliveryAttempt");

    const cycle = worker.runOutboundOnce(
      new Date("2026-08-13T12:00:00.000Z"),
      controller.signal,
    );
    await sendStarted;
    controller.abort();
    resolveSend();

    expect(await cycle).toBe(2);
    expect(send).toHaveBeenCalledTimes(1);
    expect(markSent).not.toHaveBeenCalled();
    expect(release).not.toHaveBeenCalled();
    expect(quarantine).not.toHaveBeenCalled();
    expect(attempt).not.toHaveBeenCalled();
    expect(database.getOutboxMessage(first.message_id)?.state).toBe("leased");
    expect(database.getOutboxMessage(second.message_id)?.state).toBe("leased");
    expect(worker.getOutboundCycleOutcome()).toEqual({ kind: "idle" });

    expect(
      await worker.runOutboundOnce(new Date("2026-08-13T12:01:01.000Z")),
    ).toBe(2);
    expect(database.getStatus().outbox.sent).toBe(2);
  });

  it("does not classify a rejected send as a retry after abort", async () => {
    const outgoing = envelope("SYS-A", "SYS-B", "abort-rejected-send");
    database.enqueueEnvelope(outgoing);
    const controller = new AbortController();
    let rejectSend!: (error: Error) => void;
    let signalSendStarted!: () => void;
    const sendStarted = new Promise<void>((resolve) => {
      signalSendStarted = resolve;
    });
    const sendBlocked = new Promise<void>((_resolve, reject) => {
      rejectSend = reject;
    });
    vi.spyOn(transport, "send").mockImplementation(async () => {
      signalSendStarted();
      await sendBlocked;
    });
    const release = vi.spyOn(database, "releaseOutboxLease");
    const attempt = vi.spyOn(database, "recordDeliveryAttempt");

    const cycle = worker.runOutboundOnce(
      new Date("2026-08-13T12:00:00.000Z"),
      controller.signal,
    );
    await sendStarted;
    controller.abort();
    rejectSend(Object.assign(new Error("Service busy"), { code: "ServiceBusy" }));

    expect(await cycle).toBe(1);
    expect(database.getOutboxMessage(outgoing.message_id)?.state).toBe("leased");
    expect(release).not.toHaveBeenCalled();
    expect(attempt).not.toHaveBeenCalled();
    expect(worker.getOutboundCycleOutcome()).toEqual({ kind: "idle" });
  });

  it("stops a leased batch before the next send when shutdown follows a completed item", async () => {
    const first = envelope("SYS-A", "SYS-B", "abort-between-sends-first");
    const second = envelope("SYS-A", "SYS-B", "abort-between-sends-second");
    database.enqueueEnvelope(first);
    database.enqueueEnvelope(second);
    const controller = new AbortController();
    const send = vi.spyOn(transport, "send");
    const attempt = database.recordDeliveryAttempt.bind(database);
    vi.spyOn(database, "recordDeliveryAttempt").mockImplementation((input) => {
      attempt(input);
      controller.abort();
    });

    expect(
      await worker.runOutboundOnce(
        new Date("2026-08-13T12:00:00.000Z"),
        controller.signal,
      ),
    ).toBe(2);
    expect(send).toHaveBeenCalledTimes(1);
    expect(database.getOutboxMessage(transport.sent[0]!.message_id)?.state).toBe(
      "sent",
    );
    expect(database.getStatus().outbox.leased).toBe(1);
    expect(worker.getOutboundCycleOutcome()).toEqual({ kind: "sent" });
  });

  it("returns transient send failures to pending", async () => {
    const outgoing = envelope("SYS-A", "SYS-B", "retry");
    database.enqueueEnvelope(outgoing);
    transport.sendBehavior = {
      kind: "error",
      error: Object.assign(new Error("Service busy"), {
        code: "ServiceBusy",
      }),
    };

    expect(
      await worker.runOutboundOnce(new Date("2026-08-13T12:00:00.000Z")),
    ).toBe(1);
    expect(database.getStatus().outbox.pending).toBe(1);
    expect(database.getStatus().outbox.quarantined).toBe(0);
    expect(worker.getOutboundCycleOutcome()).toEqual({
      kind: "failed",
      errorCode: "ServiceBusy",
    });
    await worker.runOutboundOnce(new Date("2026-08-13T12:00:01.000Z"));
    expect(worker.getOutboundCycleOutcome()).toEqual({ kind: "idle" });
  });

  it("quarantines permanent authorization failures", async () => {
    const outgoing = envelope("SYS-A", "SYS-B", "denied");
    database.enqueueEnvelope(outgoing);
    transport.sendBehavior = {
      kind: "error",
      error: Object.assign(new Error("Access denied"), {
        code: "UnauthorizedAccess",
      }),
    };

    await worker.runOutboundOnce(new Date("2026-08-13T12:00:00.000Z"));
    expect(database.getStatus().outbox.quarantined).toBe(1);
    expect(worker.getOutboundCycleOutcome()).toEqual({
      kind: "failed",
      errorCode: "UnauthorizedAccess",
    });
  });

  it("quarantines queued work whose target is no longer authorized", async () => {
    const outgoing = envelope("SYS-A", "node-d", "removed-node");
    database.enqueueEnvelope(outgoing);

    await worker.runOutboundOnce(new Date("2026-08-13T12:00:00.000Z"));

    expect(transport.sent).toHaveLength(0);
    expect(database.getStatus().outbox.quarantined).toBe(1);
    expect(worker.getOutboundCycleOutcome()).toEqual({
      kind: "failed",
      errorCode: "UnauthorizedTargetNode",
    });
  });

  it("reports a mixed send batch as failed even when another message was sent", async () => {
    database.enqueueEnvelope(envelope("SYS-A", "SYS-B", "first-fails"));
    database.enqueueEnvelope(envelope("SYS-A", "SYS-B", "second-succeeds"));
    vi.spyOn(transport, "send").mockRejectedValueOnce(
      Object.assign(new Error("Service busy"), { code: "ServiceBusy" }),
    );

    expect(
      await worker.runOutboundOnce(new Date("2026-08-13T12:00:00.000Z")),
    ).toBe(2);
    expect(transport.sent).toHaveLength(1);
    expect(worker.getOutboundCycleOutcome()).toEqual({
      kind: "failed",
      errorCode: "ServiceBusy",
    });
  });

  it("persists inbound messages before completing delivery", async () => {
    const incoming = envelope("SYS-B", "SYS-A", "inbound");
    transport.queueInbound({
      body: incoming,
      brokerMessageId: incoming.message_id,
      sessionId: incoming.conversation_id,
    });

    expect(await worker.runInboundOnce()).toBe(1);
    expect(database.getStatus().inbox.available).toBe(1);
    expect(transport.inbound[0]!.settlement).toBe("completed");
  });

  it("does not settle or write attempts after inbound abort and ignores later deliveries", async () => {
    const first = envelope("SYS-B", "SYS-A", "abort-inbound-first");
    const second = envelope("SYS-B", "SYS-A", "abort-inbound-second");
    transport.queueInbound({
      body: first,
      brokerMessageId: first.message_id,
      sessionId: first.conversation_id,
    });
    transport.queueInbound({
      body: second,
      brokerMessageId: second.message_id,
      sessionId: second.conversation_id,
    });
    const controller = new AbortController();
    const persist = database.persistIncoming.bind(database);
    vi.spyOn(database, "persistIncoming").mockImplementation((...args) => {
      const result = persist(...args);
      controller.abort();
      return result;
    });
    const attempt = vi.spyOn(database, "recordDeliveryAttempt");

    expect(await worker.runInboundOnce(controller.signal)).toBe(2);
    expect(database.getStatus().inbox.available).toBe(1);
    expect(database.getInboxMessage(first.message_id)).toBeDefined();
    expect(database.getInboxMessage(second.message_id)).toBeUndefined();
    expect(transport.inbound[0]!.settlement).toBeUndefined();
    expect(transport.inbound[1]!.settlement).toBeUndefined();
    expect(attempt).not.toHaveBeenCalled();
  });

  it("does not record an inbound attempt when abort happens during broker completion", async () => {
    const incoming = envelope("SYS-B", "SYS-A", "abort-inbound-completion");
    transport.queueInbound({
      body: incoming,
      brokerMessageId: incoming.message_id,
      sessionId: incoming.conversation_id,
    });
    const controller = new AbortController();
    let resolveCompletion!: () => void;
    let signalCompletionStarted!: () => void;
    const completionStarted = new Promise<void>((resolve) => {
      signalCompletionStarted = resolve;
    });
    const completionBlocked = new Promise<void>((resolve) => {
      resolveCompletion = resolve;
    });
    const receive = transport.receiveAvailable.bind(transport);
    vi.spyOn(transport, "receiveAvailable").mockImplementation((handler, options) =>
      receive(
        (delivery) =>
          handler({
            ...delivery,
            complete: async () => {
              signalCompletionStarted();
              await completionBlocked;
              await delivery.complete();
            },
          }),
        options,
      ),
    );
    const attempt = vi.spyOn(database, "recordDeliveryAttempt");

    const cycle = worker.runInboundOnce(controller.signal);
    await completionStarted;
    controller.abort();
    resolveCompletion();

    expect(await cycle).toBe(1);
    expect(database.getStatus().inbox.available).toBe(1);
    expect(transport.inbound[0]!.settlement).toBe("completed");
    expect(attempt).not.toHaveBeenCalled();
  });

  it("completes identical broker redelivery without duplicating inbox state", async () => {
    const incoming = envelope("SYS-B", "SYS-A", "duplicate");
    database.persistIncoming(incoming, 1);
    transport.queueInbound({
      body: incoming,
      brokerMessageId: incoming.message_id,
      deliveryCount: 2,
      sessionId: incoming.conversation_id,
    });

    await worker.runInboundOnce();
    expect(database.getStatus().inbox.available).toBe(1);
    expect(transport.inbound[0]!.settlement).toBe("completed");
  });

  it("dead-letters invalid and wrongly routed messages", async () => {
    const wrongTarget = envelope("SYS-A", "SYS-B", "wrong-target");
    transport.queueInbound({
      body: wrongTarget,
      brokerMessageId: wrongTarget.message_id,
      sessionId: wrongTarget.conversation_id,
    });
    transport.queueInbound({
      body: { invalid: true },
      brokerMessageId: "invalid-message",
    });

    await worker.runInboundOnce();
    expect(transport.inbound[0]!.settlement).toBe("dead-lettered");
    expect(transport.inbound[0]!.deadLetterReason).toBe("WrongTargetSystem");
    expect(transport.inbound[1]!.settlement).toBe("dead-lettered");
    expect(transport.inbound[1]!.deadLetterReason).toBe(
      "EnvelopeValidationFailed",
    );
  });

  it("dead-letters a message from an unknown origin before persistence", async () => {
    const unknownOrigin = envelope("node-d", "SYS-A", "unknown-origin");
    transport.queueInbound({
      body: unknownOrigin,
      brokerMessageId: unknownOrigin.message_id,
      sessionId: unknownOrigin.conversation_id,
    });

    await worker.runInboundOnce();

    expect(transport.inbound[0]!.settlement).toBe("dead-lettered");
    expect(transport.inbound[0]!.deadLetterReason).toBe(
      "UnauthorizedOriginNode",
    );
    expect(database.getStatus().inbox.available).toBe(0);
  });
});

function envelope(
  originSystem: string,
  targetSystem: string,
  idempotencyKey: string,
) {
  return createEnvelope({
    idempotencyKey,
    originSystem,
    targetSystem,
    kind: "task_request",
    streamId: "worker-tests",
    payload: {
      subject: "Worker test",
      body: "Synthetic test message",
      evidence: [],
    },
    expiresAtUtc: "2026-08-20T12:00:00.000Z",
    now: new Date("2026-08-13T12:00:00.000Z"),
  });
}
