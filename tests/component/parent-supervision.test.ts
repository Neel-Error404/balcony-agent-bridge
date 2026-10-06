import { getEventListeners } from "node:events";
import { describe, expect, it, vi } from "vitest";

import { serviceParentSupervisionEnabled, superviseParent } from "../../src/runtime/parent-supervision.js";

describe("parent-supervised runtime lifecycle", () => {
  it("aborts when its service parent disappears without touching any other process", async () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    let alive = true;
    const report = vi.fn();
    const stop = superviseParent(controller, {
      enabled: true, parentPid: 101, pollIntervalMs: 10,
      isParentAlive: () => alive, onFailure: report,
    });
    expect(controller.signal.aborted).toBe(false);
    alive = false;
    await vi.advanceTimersByTimeAsync(10);
    expect(controller.signal.aborted).toBe(true);
    expect(report).toHaveBeenCalledExactlyOnceWith("RUNTIME_PARENT_LOST");
    expect(vi.getTimerCount()).toBe(0);
    stop();
    vi.useRealTimers();
  });

  it("fails closed if parent status cannot be observed", () => {
    const controller = new AbortController();
    const report = vi.fn();
    superviseParent(controller, {
      enabled: true, parentPid: 102,
      isParentAlive: () => { throw new Error("private diagnostic"); },
      onFailure: report,
    });
    expect(controller.signal.aborted).toBe(true);
    expect(report).toHaveBeenCalledExactlyOnceWith("RUNTIME_PARENT_UNVERIFIED");
  });

  it("does not monitor foreground operation and releases resources on normal shutdown", () => {
    vi.useFakeTimers();
    const foreground = new AbortController();
    const probe = vi.fn(() => false);
    superviseParent(foreground, { enabled: false, isParentAlive: probe });
    expect(probe).not.toHaveBeenCalled();
    expect(foreground.signal.aborted).toBe(false);
    const service = new AbortController();
    superviseParent(service, { enabled: true, parentPid: 103, isParentAlive: () => true });
    service.abort();
    expect(vi.getTimerCount()).toBe(0);
    expect(getEventListeners(service.signal, "abort")).toHaveLength(0);
    vi.useRealTimers();
  });

  it("rejects unknown supervision modes rather than silently disabling protection", () => {
    expect(serviceParentSupervisionEnabled(undefined)).toBe(false);
    expect(serviceParentSupervisionEnabled("service_parent")).toBe(true);
    expect(() => serviceParentSupervisionEnabled("parent")).toThrow("RUNTIME_SUPERVISION_INVALID");
  });

  it("reports parent failure once even when repeated checks could occur", async () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    const report = vi.fn();
    superviseParent(controller, {
      enabled: true, parentPid: 104, pollIntervalMs: 10,
      isParentAlive: () => false, onFailure: report,
    });
    await vi.advanceTimersByTimeAsync(100);
    expect(report).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
    vi.useRealTimers();
  });
});
