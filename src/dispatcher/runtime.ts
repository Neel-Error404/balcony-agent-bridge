import { abortableSleep } from "../runtime/abortable-sleep.js";
import { CodexExecutionError } from "../errors.js";
import { safeErrorCode } from "../security/sanitize-error.js";
import type { BridgeDatabase } from "../storage/database.js";

export interface ForegroundDispatcher {
  runOnce(now?: Date, abortSignal?: AbortSignal): Promise<number>;
  recordHeartbeat(status: "healthy" | "degraded", lastErrorCode?: string): void;
}

export function assertDispatcherTerminationVerified(database: BridgeDatabase): void {
  const status = database.getStatus();
  if (status.lastDispatcherErrorCode === "CODEX_TERMINATION_FAILED" ||
      status.lastConsultationCoordinatorErrorCode === "CODEX_TERMINATION_FAILED") {
    throw new CodexExecutionError(
      "CODEX_TERMINATION_FAILED",
      "A previous Codex worker has unverified termination; verify process quiescence before clearing its runtime failure.",
    );
  }
}

export async function runDispatcher(
  dispatcher: ForegroundDispatcher,
  controller: AbortController,
  pollIntervalMs: number,
  database: BridgeDatabase,
): Promise<void> {
  if (controller.signal.aborted) return;
  assertDispatcherTerminationVerified(database);
  dispatcher.recordHeartbeat("healthy");
  let lastHeartbeat = Date.now();
  while (!controller.signal.aborted) {
    try {
      const processed = await dispatcher.runOnce(new Date(), controller.signal);
      if (controller.signal.aborted) break;
      if (processed > 0 || Date.now() - lastHeartbeat >= 5 * 60 * 1000) {
        dispatcher.recordHeartbeat("healthy");
        lastHeartbeat = Date.now();
      }
      if (processed === 0) await abortableSleep(pollIntervalMs, controller.signal);
    } catch (error) {
      if (error instanceof CodexExecutionError &&
          error.code === "CODEX_TERMINATION_FAILED") {
        dispatcher.recordHeartbeat("degraded", error.code);
        controller.abort();
        throw error;
      }
      if (controller.signal.aborted) break;
      const code = safeErrorCode(error);
      dispatcher.recordHeartbeat("degraded", code);
      console.error(`Read-only dispatcher cycle failed (${code})`);
      await abortableSleep(Math.max(2000, pollIntervalMs), controller.signal);
    }
  }
}
