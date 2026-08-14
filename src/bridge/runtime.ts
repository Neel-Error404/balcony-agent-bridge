import { safeErrorCode } from "../security/sanitize-error.js";
import type { BridgeTransport } from "../transport/transport.js";

export interface BridgeRuntimeWorker {
  runOutboundOnce(): Promise<number>;
  runInboundOnce(abortSignal?: AbortSignal): Promise<number>;
  recordHeartbeat(
    status: "healthy" | "degraded",
    lastError?: string,
  ): void;
}

export interface BridgeLoopOptions {
  outboundIntervalMs: number;
  retryDelayMs: number;
  heartbeatIntervalMs: number;
}

const DEFAULT_LOOP_OPTIONS: BridgeLoopOptions = {
  outboundIntervalMs: 1000,
  retryDelayMs: 2000,
  heartbeatIntervalMs: 15 * 60 * 1000,
};

export async function runBridgeLoops(
  worker: BridgeRuntimeWorker,
  controller: AbortController,
  options: BridgeLoopOptions = DEFAULT_LOOP_OPTIONS,
): Promise<void> {
  worker.recordHeartbeat("healthy");
  const outbound = runOutboundLoop(worker, controller.signal, options);
  const inbound = runInboundLoop(worker, controller.signal, options);
  await Promise.race([
    Promise.all([outbound, inbound]),
    waitForAbort(controller.signal),
  ]);
}

async function runOutboundLoop(
  worker: BridgeRuntimeWorker,
  signal: AbortSignal,
  options: BridgeLoopOptions,
): Promise<void> {
  let lastHeartbeat = Date.now();
  while (!signal.aborted) {
    try {
      await worker.runOutboundOnce();
      if (Date.now() - lastHeartbeat >= options.heartbeatIntervalMs) {
        worker.recordHeartbeat("healthy");
        lastHeartbeat = Date.now();
      }
    } catch (error) {
      const code = safeErrorCode(error);
      worker.recordHeartbeat("degraded", code);
      console.error(`Bridge outbound cycle failed (${code})`);
      await sleep(options.retryDelayMs, signal);
      continue;
    }
    await sleep(options.outboundIntervalMs, signal);
  }
}

async function runInboundLoop(
  worker: BridgeRuntimeWorker,
  signal: AbortSignal,
  options: BridgeLoopOptions,
): Promise<void> {
  while (!signal.aborted) {
    try {
      await worker.runInboundOnce(signal);
    } catch (error) {
      const code = safeErrorCode(error);
      worker.recordHeartbeat("degraded", code);
      console.error(`Bridge inbound cycle failed (${code})`);
      await sleep(options.retryDelayMs, signal);
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

async function sleep(
  milliseconds: number,
  signal: AbortSignal,
): Promise<void> {
  await new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, milliseconds);
    signal.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        resolve();
      },
      { once: true },
    );
  });
}

async function waitForAbort(signal: AbortSignal): Promise<void> {
  if (signal.aborted) {
    return;
  }
  await new Promise<void>((resolve) => {
    signal.addEventListener("abort", () => resolve(), { once: true });
  });
}
