import { describe, expect, it, vi } from "vitest";

import { abortableSleep } from "../../src/runtime/abortable-sleep.js";

describe("abortable sleep", () => {
  it("returns immediately without registering a listener for an already-aborted signal", async () => {
    vi.useFakeTimers();
    try {
      const controller = new AbortController();
      controller.abort();
      const addListener = vi.spyOn(controller.signal, "addEventListener");
      await expect(abortableSleep(60_000, controller.signal)).resolves.toBeUndefined();
      expect(addListener).not.toHaveBeenCalled();
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("removes the listener when a timeout completes or an abort cancels it", async () => {
    vi.useFakeTimers();
    try {
      const timed = new AbortController();
      const timedRemove = vi.spyOn(timed.signal, "removeEventListener");
      const timeout = abortableSleep(25, timed.signal);
      await vi.advanceTimersByTimeAsync(25);
      await timeout;
      expect(timedRemove).toHaveBeenCalledWith("abort", expect.any(Function));
      expect(vi.getTimerCount()).toBe(0);

      const aborted = new AbortController();
      const abortRemove = vi.spyOn(aborted.signal, "removeEventListener");
      const waiting = abortableSleep(60_000, aborted.signal);
      aborted.abort();
      await waiting;
      expect(abortRemove).toHaveBeenCalledWith("abort", expect.any(Function));
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });
});
