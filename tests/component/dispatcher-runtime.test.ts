import { expect, it } from "vitest";

import { CodexExecutionError } from "../../src/errors.js";
import { assertDispatcherTerminationVerified, runDispatcher } from "../../src/dispatcher/runtime.js";
import { BridgeDatabase } from "../../src/storage/database.js";

it("stops the runtime and preserves a durable termination gate instead of polling again", async () => {
  const database = new BridgeDatabase(":memory:");
  const controller = new AbortController();
  let executions = 0;
  const stopTest = setTimeout(() => controller.abort(), 200);
  const worker = {
    async runOnce(): Promise<number> {
      executions++;
      throw new CodexExecutionError("CODEX_TERMINATION_FAILED", "Synthetic unclosed worker.");
    },
    recordHeartbeat(status: "healthy" | "degraded", error?: string): void {
      database.recordDispatcherHeartbeat("test-runtime", status, error);
    },
  };
  try {
    await expect(runDispatcher(worker, controller, 1, database)).rejects.toMatchObject({
      code: "CODEX_TERMINATION_FAILED",
    });
    expect(executions).toBe(1);
    expect(database.getStatus().lastDispatcherErrorCode).toBe("CODEX_TERMINATION_FAILED");
    await expect(runDispatcher(worker, new AbortController(), 1, database)).rejects.toMatchObject({
      code: "CODEX_TERMINATION_FAILED",
    });
    expect(executions).toBe(1);
  } finally {
    clearTimeout(stopTest);
    controller.abort();
    database.close();
  }
});

it("checks a prior consultation termination failure before another runtime can overwrite its heartbeat", () => {
  const database = new BridgeDatabase(":memory:");
  try {
    database.recordConsultationCoordinatorHeartbeat(
      "previous-consultation", "degraded", "CODEX_TERMINATION_FAILED",
    );
    expect(() => assertDispatcherTerminationVerified(database)).toThrow(/quiescence/);
    expect(database.getStatus().lastConsultationCoordinatorErrorCode).toBe("CODEX_TERMINATION_FAILED");
  } finally {
    database.close();
  }
});
