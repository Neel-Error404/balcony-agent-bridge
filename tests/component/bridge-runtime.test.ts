import { describe, expect, it, vi } from "vitest";

import type { BridgeConfig } from "../../src/config.js";
import { createEnvelope } from "../../src/contracts/envelope.js";
import {
  closeTransportWithin,
  runBridgeLoops,
  type BridgeRuntimeWorker,
} from "../../src/bridge/runtime.js";
import { BridgeWorker } from "../../src/bridge/worker.js";
import { BridgeDatabase } from "../../src/storage/database.js";
import { FakeBridgeTransport } from "../../src/transport/fake-transport.js";

describe("bridge runtime lanes", () => {
  it("does not overwrite supervision failure or start work when already aborted", async () => {
    const controller = new AbortController();
    controller.abort();
    const worker: BridgeRuntimeWorker = {
      runOutboundOnce: vi.fn(async () => 0),
      runInboundOnce: vi.fn(async () => 0),
      recordHeartbeat: vi.fn(),
    };
    await runBridgeLoops(worker, controller);
    expect(worker.recordHeartbeat).not.toHaveBeenCalled();
    expect(worker.runOutboundOnce).not.toHaveBeenCalled();
    expect(worker.runInboundOnce).not.toHaveBeenCalled();
  });

  it("keeps parent-loss diagnosis when a pending lane rejects after abort", async () => {
    const controller = new AbortController();
    let rejectInbound: (error: Error) => void = () => undefined;
    const heartbeats: Array<{ status: string; error?: string }> = [];
    const worker: BridgeRuntimeWorker = {
      runOutboundOnce: async () => 0,
      runInboundOnce: async () => new Promise<number>((_resolve, reject) => {
        rejectInbound = reject;
      }),
      recordHeartbeat: (status, error) => heartbeats.push(error ? { status, error } : { status }),
    };
    const runtime = runBridgeLoops(worker, controller);
    await Promise.resolve();
    controller.abort();
    worker.recordHeartbeat("degraded", "RUNTIME_PARENT_LOST");
    rejectInbound(new Error("Secondary shutdown error"));
    await runtime;
    await Promise.resolve();
    expect(heartbeats.at(-1)).toEqual({ status: "degraded", error: "RUNTIME_PARENT_LOST" });
  });

  it("retains ownership until an in-flight lane finishes after abort", async () => {
    const controller = new AbortController();
    let completeSend = (): void => undefined;
    let finished = false;
    const worker: BridgeRuntimeWorker = {
      runOutboundOnce: async () => new Promise<number>(resolve => {
        completeSend = () => { finished = true; resolve(1); };
      }),
      runInboundOnce: async () => 0,
      recordHeartbeat: () => undefined,
    };
    const runtime = runBridgeLoops(worker, controller, {
      outboundIntervalMs: 1, retryDelayMs: 1, heartbeatIntervalMs: 1000, shutdownTimeoutMs: 20,
    });
    controller.abort();
    let returned = false;
    void runtime.then(() => { returned = true; });
    await new Promise(resolve => setTimeout(resolve, 10));
    expect(returned).toBe(false);
    completeSend();
    expect(await runtime).toBe(true);
    expect(finished).toBe(true);
  });

  it("reports unquiesced shutdown rather than successful lock-release readiness", async () => {
    const controller = new AbortController();
    const worker: BridgeRuntimeWorker = {
      runOutboundOnce: async () => new Promise<number>(() => undefined),
      runInboundOnce: async () => new Promise<number>(() => undefined),
      recordHeartbeat: () => undefined,
    };
    const runtime = runBridgeLoops(worker, controller, {
      outboundIntervalMs: 1, retryDelayMs: 1, heartbeatIntervalMs: 1000,
      shutdownTimeoutMs: 10,
    });
    controller.abort();
    expect(await runtime).toBe(false);
  });
  it("continues outbound work without claiming healthy until the inbound lane completes", async () => {
    let outboundCycles = 0;
    let inboundCycles = 0;
    const heartbeats: string[] = [];
    const worker: BridgeRuntimeWorker = {
      runOutboundOnce: async () => {
        outboundCycles += 1;
        return 1;
      },
      runInboundOnce: async () => {
        inboundCycles += 1;
        return new Promise<number>(() => undefined);
      },
      recordHeartbeat: (status) => {
        heartbeats.push(status);
      },
    };
    const controller = new AbortController();
    const runtime = runBridgeLoops(worker, controller, {
      outboundIntervalMs: 5,
      retryDelayMs: 5,
      heartbeatIntervalMs: 1, shutdownTimeoutMs: 20,
    });

    await waitUntil(() => outboundCycles >= 3, 250);
    controller.abort();
    await runtime;

    expect(inboundCycles).toBe(1);
    expect(outboundCycles).toBeGreaterThanOrEqual(3);
    expect(heartbeats[0]).toBe("degraded");
    expect(heartbeats).not.toContain("healthy");
  });

  it("does not infer send success from a legacy worker's processed count", async () => {
    const heartbeats: string[] = [];
    let outboundCycles = 0;
    let inboundCycles = 0;
    const worker: BridgeRuntimeWorker = {
      runOutboundOnce: async () => {
        outboundCycles += 1;
        return 1;
      },
      runInboundOnce: async () => {
        inboundCycles += 1;
        return inboundCycles === 1
          ? 0
          : new Promise<number>(() => undefined);
      },
      recordHeartbeat: (status) => {
        heartbeats.push(status);
      },
    };
    const controller = new AbortController();
    const runtime = runBridgeLoops(worker, controller, {
      outboundIntervalMs: 1,
      retryDelayMs: 1,
      heartbeatIntervalMs: 1, shutdownTimeoutMs: 20,
    });
    try {
      await waitUntil(() => outboundCycles >= 4 && inboundCycles >= 2, 1000);
      expect(heartbeats).not.toContain("healthy");
    } finally {
      controller.abort();
      await runtime;
    }
  });

  it("keeps an inbound failure degraded through outbound successes until a receive cycle recovers", async () => {
    const heartbeats: Array<{ status: string; error?: string }> = [];
    let outboundCycles = 0;
    let inboundCycles = 0;
    let recoverInbound: (() => void) | undefined;
    const recoveredCycle = new Promise<number>((resolve) => {
      recoverInbound = () => resolve(0);
    });
    const worker: BridgeRuntimeWorker = {
      runOutboundOnce: async () => {
        outboundCycles += 1;
        return 1;
      },
      runInboundOnce: async () => {
        inboundCycles += 1;
        if (inboundCycles === 1) {
          throw new Error("receive failed");
        }
        if (inboundCycles === 2) {
          return recoveredCycle;
        }
        return new Promise<number>(() => undefined);
      },
      getOutboundCycleOutcome: () => ({ kind: "sent" }),
      recordHeartbeat: (status, error) => {
        heartbeats.push(error ? { status, error } : { status });
      },
    };
    const controller = new AbortController();
    const runtime = runBridgeLoops(worker, controller, {
      outboundIntervalMs: 1,
      retryDelayMs: 1,
      heartbeatIntervalMs: 1, shutdownTimeoutMs: 20,
    });
    try {
      await waitUntil(() => inboundCycles === 2 && outboundCycles >= 5, 1000);
      expect(heartbeats.at(-1)).toEqual({ status: "degraded", error: "Error" });
      recoverInbound?.();
      await waitUntil(() => heartbeats.at(-1)?.status === "healthy", 1000);
      expect(inboundCycles).toBeGreaterThanOrEqual(2);
    } finally {
      controller.abort();
      await runtime;
    }
  });

  it("keeps an outbound failure degraded while inbound completes until a send cycle recovers", async () => {
    const heartbeats: Array<{ status: string; error?: string }> = [];
    let outboundCycles = 0;
    let inboundCycles = 0;
    let recoverOutbound: (() => void) | undefined;
    const recoveredCycle = new Promise<number>((resolve) => {
      recoverOutbound = () => resolve(0);
    });
    const worker: BridgeRuntimeWorker = {
      runOutboundOnce: async () => {
        outboundCycles += 1;
        if (outboundCycles === 1) {
          throw new Error("send failed");
        }
        if (outboundCycles === 2) {
          return recoveredCycle;
        }
        return 1;
      },
      runInboundOnce: async () => {
        inboundCycles += 1;
        return inboundCycles === 1
          ? 0
          : new Promise<number>(() => undefined);
      },
      getOutboundCycleOutcome: () => ({ kind: "sent" }),
      recordHeartbeat: (status, error) => {
        heartbeats.push(error ? { status, error } : { status });
      },
    };
    const controller = new AbortController();
    const runtime = runBridgeLoops(worker, controller, {
      outboundIntervalMs: 1,
      retryDelayMs: 1,
      heartbeatIntervalMs: 1, shutdownTimeoutMs: 20,
    });
    try {
      await waitUntil(() => outboundCycles === 2 && inboundCycles >= 2, 1000);
      expect(heartbeats.at(-1)).toEqual({ status: "degraded", error: "Error" });
      recoverOutbound?.();
      await waitUntil(() => heartbeats.at(-1)?.status === "healthy", 1000);
    } finally {
      controller.abort();
      await runtime;
    }
  });

  it("does not accumulate abort listeners through repeated outbound sleeps", async () => {
    const controller = new AbortController();
    const addListener = vi.spyOn(controller.signal, "addEventListener");
    const removeListener = vi.spyOn(controller.signal, "removeEventListener");
    let outboundCycles = 0;
    const worker: BridgeRuntimeWorker = {
      runOutboundOnce: async () => {
        outboundCycles += 1;
        return 0;
      },
      runInboundOnce: async () => new Promise<number>(() => undefined),
      recordHeartbeat: () => undefined,
    };
    const runtime = runBridgeLoops(worker, controller, {
      outboundIntervalMs: 1,
      retryDelayMs: 1,
      heartbeatIntervalMs: 1000, shutdownTimeoutMs: 20,
    });
    try {
      await waitUntil(() => outboundCycles >= 25, 1000);
      const added = addListener.mock.calls.filter(([event]) => event === "abort").length;
      const removed = removeListener.mock.calls.filter(([event]) => event === "abort").length;
      // One listener belongs to the shutdown race, and one may belong to
      // the currently pending outbound sleep.
      expect(added - removed).toBeLessThanOrEqual(2);
    } finally {
      controller.abort();
      await runtime;
      addListener.mockRestore();
      removeListener.mockRestore();
    }
  });

  it("keeps a caught transport send failure degraded through idle cycles until an actual send succeeds", async () => {
    const database = new BridgeDatabase(":memory:");
    const transport = new FakeBridgeTransport();
    const config: BridgeConfig = {
      systemId: "SYS-A",
      authorizedNodeIds: ["SYS-B"],
      databasePath: ":memory:",
      topicName: "agent-messages",
      subscriptionName: "sys-a",
      azureAuthMode: "managed_identity",
    };
    const worker = new BridgeWorker(config, database, transport);
    const outbound = vi.spyOn(worker, "runOutboundOnce");
    const heartbeat = vi.spyOn(worker, "recordHeartbeat");
    let inboundCycles = 0;
    vi.spyOn(transport, "receiveAvailable").mockImplementation(async () => {
      inboundCycles += 1;
      return inboundCycles === 1
        ? 0
        : new Promise<number>(() => undefined);
    });
    const send = vi.spyOn(transport, "send");
    const enqueue = (key: string): void => {
      const now = new Date();
      database.enqueueEnvelope(createEnvelope({
        idempotencyKey: key,
        originSystem: "SYS-A",
        targetSystem: "SYS-B",
        kind: "task_request",
        streamId: "scheduler-test",
        payload: {
          subject: "Runtime health",
          body: "Synthetic outbound message",
          evidence: [],
        },
        expiresAtUtc: new Date(now.getTime() + 60_000).toISOString(),
        now,
      }));
    };
    enqueue("failed-send");
    transport.sendBehavior = {
      kind: "error",
      error: Object.assign(new Error("Service busy"), { code: "ServiceBusy" }),
    };
    const controller = new AbortController();
    const runtime = runBridgeLoops(worker, controller, {
      outboundIntervalMs: 1,
      retryDelayMs: 1,
      heartbeatIntervalMs: 1, shutdownTimeoutMs: 20,
    });
    try {
      await waitUntil(
        () => send.mock.calls.length >= 1 &&
          outbound.mock.calls.length >= 5 &&
          inboundCycles >= 2 &&
          database.getStatus().outbox.pending === 1,
        1000,
      );
      expect(heartbeat.mock.calls.at(-1)).toEqual(["degraded", "ServiceBusy"]);

      transport.sendBehavior = { kind: "success" };
      enqueue("successful-send");
      await waitUntil(() => transport.sent.length >= 1 &&
        heartbeat.mock.calls.at(-1)?.[0] === "healthy", 1000);
    } finally {
      controller.abort();
      await runtime;
      database.close();
    }
  });

  it("does not treat a real worker's empty outbox polls as sender readiness", async () => {
    const database = new BridgeDatabase(":memory:");
    const transport = new FakeBridgeTransport();
    const worker = new BridgeWorker({
      systemId: "SYS-A",
      authorizedNodeIds: ["SYS-B"],
      databasePath: ":memory:",
      topicName: "agent-messages",
      subscriptionName: "sys-a",
      azureAuthMode: "managed_identity",
    }, database, transport);
    const outbound = vi.spyOn(worker, "runOutboundOnce");
    const heartbeat = vi.spyOn(worker, "recordHeartbeat");
    let inboundCycles = 0;
    vi.spyOn(transport, "receiveAvailable").mockImplementation(async () => {
      inboundCycles += 1;
      return inboundCycles === 1
        ? 0
        : new Promise<number>(() => undefined);
    });
    const controller = new AbortController();
    const runtime = runBridgeLoops(worker, controller, {
      outboundIntervalMs: 1,
      retryDelayMs: 1,
      heartbeatIntervalMs: 1, shutdownTimeoutMs: 20,
    });
    try {
      await waitUntil(() => outbound.mock.calls.length >= 5 && inboundCycles >= 2, 1000);
      expect(heartbeat.mock.calls.at(-1)?.[0]).toBe("degraded");
      expect(heartbeat.mock.calls.some(([status]) => status === "healthy")).toBe(false);
    } finally {
      controller.abort();
      await runtime;
      database.close();
    }
  });

  it("bounds shutdown when the SDK close promise never settles", async () => {
    await expect(
      closeTransportWithin(
        { close: async () => new Promise<void>(() => undefined) },
        10,
      ),
    ).resolves.toBe(false);
    await expect(
      closeTransportWithin({ close: async () => undefined }, 100),
    ).resolves.toBe(true);
  });
});

async function waitUntil(
  condition: () => boolean,
  deadlineMs: number,
): Promise<void> {
  const deadline = Date.now() + deadlineMs;
  while (!condition()) {
    if (Date.now() >= deadline) {
      throw new Error("Timed out waiting for the bridge runtime condition");
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}
