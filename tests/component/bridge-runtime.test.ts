import { describe, expect, it } from "vitest";

import {
  closeTransportWithin,
  runBridgeLoops,
  type BridgeRuntimeWorker,
} from "../../src/bridge/runtime.js";

describe("bridge runtime lanes", () => {
  it("continues outbound work while the inbound session accept is idle", async () => {
    let outboundCycles = 0;
    let inboundCycles = 0;
    const heartbeats: string[] = [];
    const worker: BridgeRuntimeWorker = {
      runOutboundOnce: async () => {
        outboundCycles += 1;
        return 0;
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
      heartbeatIntervalMs: 1000,
    });

    await waitUntil(() => outboundCycles >= 3, 250);
    controller.abort();
    await runtime;

    expect(inboundCycles).toBe(1);
    expect(outboundCycles).toBeGreaterThanOrEqual(3);
    expect(heartbeats[0]).toBe("healthy");
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
