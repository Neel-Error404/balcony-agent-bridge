import { safeErrorCode } from "../security/sanitize-error.js";
import { abortableSleep } from "../runtime/abortable-sleep.js";
import type { BridgeTransport } from "../transport/transport.js";

export interface BridgeRuntimeWorker {
  runOutboundOnce(now?: Date, abortSignal?: AbortSignal): Promise<number>;
  runInboundOnce(abortSignal?: AbortSignal): Promise<number>;
  getOutboundCycleOutcome?():
    | { kind: "idle" }
    | { kind: "sent" }
    | { kind: "failed"; errorCode: string };
  recordHeartbeat(
    status: "healthy" | "degraded",
    lastError?: string,
  ): void;
}

export interface BridgeLoopOptions {
  outboundIntervalMs: number;
  retryDelayMs: number;
  heartbeatIntervalMs: number;
  shutdownTimeoutMs?: number;
}

const DEFAULT_LOOP_OPTIONS: BridgeLoopOptions = {
  outboundIntervalMs: 1000,
  retryDelayMs: 2000,
  heartbeatIntervalMs: 15 * 60 * 1000,
};

type BridgeLane = "outbound" | "inbound";
type LaneOutcome = { healthy: boolean; error?: string };

export async function runBridgeLoops(
  worker: BridgeRuntimeWorker,
  controller: AbortController,
  options: BridgeLoopOptions = DEFAULT_LOOP_OPTIONS,
): Promise<boolean> {
  if (controller.signal.aborted) return true;
  const outcomes: Record<BridgeLane, LaneOutcome> = {
    outbound: { healthy: false },
    inbound: { healthy: false },
  };
  const recordAggregate = (): void => {
    const error = outcomes.inbound.error ?? outcomes.outbound.error;
    if (!outcomes.inbound.healthy || !outcomes.outbound.healthy) {
      worker.recordHeartbeat("degraded", error);
    } else {
      worker.recordHeartbeat("healthy");
    }
  };
  const recordOutcome = (lane: BridgeLane, error?: string): void => {
    const previous = outcomes[lane];
    outcomes[lane] = error
      ? { healthy: false, error }
      : { healthy: true };
    if (error || !previous.healthy) {
      recordAggregate();
    }
  };
  recordAggregate();
  const outbound = runOutboundLoop(
    worker, controller.signal, options, recordOutcome, recordAggregate,
  );
  const inbound = runInboundLoop(
    worker, controller.signal, options, recordOutcome,
  );
  const lanes = Promise.all([outbound, inbound]);
  const stopped = await Promise.race([
    lanes.then(() => true),
    waitForAbort(controller.signal).then(() => false),
  ]);
  if (stopped) return true;
  return settleWithin(lanes, options.shutdownTimeoutMs ?? 5000);
}

async function runOutboundLoop(
  worker: BridgeRuntimeWorker,
  signal: AbortSignal,
  options: BridgeLoopOptions,
  recordOutcome: (lane: BridgeLane, error?: string) => void,
  recordAggregate: () => void,
): Promise<void> {
  let lastHeartbeat = Date.now();
  while (!signal.aborted) {
    try {
      await worker.runOutboundOnce(undefined, signal);
      if (signal.aborted) break;
      const outcome = worker.getOutboundCycleOutcome?.();
      if (outcome?.kind === "sent") {
        recordOutcome("outbound");
      } else if (outcome?.kind === "failed") {
        recordOutcome("outbound", outcome.errorCode);
      }
      if (Date.now() - lastHeartbeat >= options.heartbeatIntervalMs) {
        recordAggregate();
        lastHeartbeat = Date.now();
      }
    } catch (error) {
      if (signal.aborted) break;
      const code = safeErrorCode(error);
      recordOutcome("outbound", code);
      console.error(`Bridge outbound cycle failed (${code})`);
      await abortableSleep(options.retryDelayMs, signal);
      continue;
    }
    await abortableSleep(options.outboundIntervalMs, signal);
  }
}

async function runInboundLoop(
  worker: BridgeRuntimeWorker,
  signal: AbortSignal,
  options: BridgeLoopOptions,
  recordOutcome: (lane: BridgeLane, error?: string) => void,
): Promise<void> {
  while (!signal.aborted) {
    try {
      await worker.runInboundOnce(signal);
      if (signal.aborted) break;
      recordOutcome("inbound");
    } catch (error) {
      if (signal.aborted) break;
      const code = safeErrorCode(error);
      recordOutcome("inbound", code);
      console.error(`Bridge inbound cycle failed (${code})`);
      await abortableSleep(options.retryDelayMs, signal);
    }
  }
}

export async function closeTransportWithin(
  transport: Pick<BridgeTransport, "close">,
  deadlineMs: number,
): Promise<boolean> {
  if (!Number.isFinite(deadlineMs) || deadlineMs <= 0) {
    throw new RangeError("deadlineMs must be a positive finite number");
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      transport.close().then(
        () => true,
        () => false,
      ),
      new Promise<boolean>((resolve) => {
        timer = setTimeout(() => resolve(false), deadlineMs);
        timer.unref?.();
      }),
    ]);
  } finally {
    if (timer) {
      clearTimeout(timer);
    }
  }
}

async function waitForAbort(signal: AbortSignal): Promise<void> {
  if (signal.aborted) {
    return;
  }
  await new Promise<void>((resolve) => {
    signal.addEventListener("abort", () => resolve(), { once: true });
  });
}

async function settleWithin(work: Promise<unknown>, deadlineMs: number): Promise<boolean> {
  if (!Number.isFinite(deadlineMs) || deadlineMs <= 0) {
    throw new RangeError("Shutdown deadline must be positive.");
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      work.then(() => true),
      new Promise<boolean>(resolve => { timer = setTimeout(() => resolve(false), deadlineMs); }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
