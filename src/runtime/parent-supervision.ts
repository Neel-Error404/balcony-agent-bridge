export type ParentFailureCode = "RUNTIME_PARENT_LOST" | "RUNTIME_PARENT_UNVERIFIED";

export function serviceParentSupervisionEnabled(value: string | undefined): boolean {
  if (value === undefined || value === "") return false;
  if (value === "service_parent") return true;
  throw new Error("RUNTIME_SUPERVISION_INVALID");
}

export function superviseParent(
  controller: AbortController,
  options: {
    enabled: boolean;
    parentPid?: number;
    pollIntervalMs?: number;
    isParentAlive?: (pid: number) => boolean;
    onFailure?: (code: ParentFailureCode) => void;
  },
): () => void {
  if (!options.enabled || controller.signal.aborted) return () => undefined;
  const parentPid = options.parentPid ?? process.ppid;
  const pollIntervalMs = options.pollIntervalMs ?? 1000;
  if (!Number.isSafeInteger(parentPid) || parentPid <= 0 ||
      !Number.isFinite(pollIntervalMs) || pollIntervalMs <= 0) {
    throw new RangeError("Runtime parent PID and polling interval must be positive.");
  }
  let timer: ReturnType<typeof setInterval> | undefined;
  let failed = false;
  const cleanup = (): void => {
    if (timer) clearInterval(timer);
    controller.signal.removeEventListener("abort", cleanup);
  };
  const fail = (code: ParentFailureCode): void => {
    if (failed) return;
    failed = true;
    cleanup();
    controller.abort();
    options.onFailure?.(code);
  };
  const check = (): void => {
    let alive: boolean;
    try {
      alive = (options.isParentAlive ?? parentAlive)(parentPid);
    } catch {
      fail("RUNTIME_PARENT_UNVERIFIED");
      return;
    }
    if (!alive) fail("RUNTIME_PARENT_LOST");
  };
  check();
  if (!controller.signal.aborted) {
    timer = setInterval(check, pollIntervalMs);
    timer.unref?.();
    controller.signal.addEventListener("abort", cleanup, { once: true });
  }
  return cleanup;
}

function parentAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ESRCH") {
      return false;
    }
    throw error;
  }
}
