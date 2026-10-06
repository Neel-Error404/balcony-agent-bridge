import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";

import { afterEach, beforeEach, expect, it, vi } from "vitest";

const processBoundary = vi.hoisted(() => ({
  spawn: vi.fn(),
  spawnSync: vi.fn(),
}));
vi.mock("node:child_process", () => processBoundary);

import { LocalCodexExecutor } from "../../src/dispatcher/codex-executor.js";

let root: string;
let executor: LocalCodexExecutor;
let child: EventEmitter & {
  stdin: PassThrough;
  stdout: PassThrough;
  stderr: PassThrough;
  kill: ReturnType<typeof vi.fn>;
};

beforeEach(() => {
  vi.useFakeTimers();
  root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-shutdown-boundary-"));
  const executable = path.join(root, "codex.exe");
  const host = path.join(root, "codex-code-mode-host.exe");
  fs.writeFileSync(executable, "test-only executable boundary");
  fs.writeFileSync(host, "test-only companion boundary");
  const hash = (file: string): string =>
    createHash("sha256").update(fs.readFileSync(file)).digest("hex");
  executor = new LocalCodexExecutor(
    executable, root, hash(executable), host, hash(host), "", {},
  );
  child = Object.assign(new EventEmitter(), {
    stdin: new PassThrough(),
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    kill: vi.fn(() => false),
  });
  processBoundary.spawn.mockReset().mockReturnValue(child);
  processBoundary.spawnSync.mockReset();
});

afterEach(() => {
  vi.useRealTimers();
  child.stdin.destroy();
  child.stdout.destroy();
  child.stderr.destroy();
  fs.rmSync(root, { recursive: true, force: true });
});

it("fails within the termination bound when cancellation never produces process close", async () => {
  const controller = new AbortController();
  const run = executor.execute({
    projectPath: root, prompt: "Read-only test.", timeoutSeconds: 30,
    maxOutputBytes: 1000, abortSignal: controller.signal,
  });
  let outcome: unknown = "pending";
  void run.then(
    () => { outcome = "success"; },
    error => { outcome = error; },
  );
  controller.abort();
  await vi.advanceTimersByTimeAsync(5000);
  expect(outcome).toMatchObject({ code: "CODEX_TERMINATION_FAILED" });
  expect(vi.getTimerCount()).toBe(0);
  child.emit("close", 0, null);
  await Promise.resolve();
  expect(outcome).toMatchObject({ code: "CODEX_TERMINATION_FAILED" });
});

it("keeps verified cancellation classification when the process closes before the deadline", async () => {
  child.kill.mockReturnValue(true);
  const controller = new AbortController();
  const run = executor.execute({
    projectPath: root, prompt: "Verified close test.", timeoutSeconds: 30,
    maxOutputBytes: 1000, abortSignal: controller.signal,
  });
  const rejected = expect(run).rejects.toMatchObject({ code: "CODEX_ABORTED" });
  controller.abort();
  child.emit("close", null, "SIGKILL");
  await rejected;
  expect(vi.getTimerCount()).toBe(0);
});

it("does not misclassify a failed kill error as launch failure without process close", async () => {
  const controller = new AbortController();
  const run = executor.execute({
    projectPath: root, prompt: "Kill error test.", timeoutSeconds: 30,
    maxOutputBytes: 1000, abortSignal: controller.signal,
  });
  const rejected = expect(run).rejects.toMatchObject({ code: "CODEX_TERMINATION_FAILED" });
  controller.abort();
  child.emit("error", new Error("Synthetic kill failure."));
  await rejected;
  expect(vi.getTimerCount()).toBe(0);
});

it("bounds the Windows tree-termination helper instead of blocking supervision indefinitely", async () => {
  Object.assign(child, { pid: 123456 });
  processBoundary.spawnSync.mockReturnValue({ status: 1 });
  const controller = new AbortController();
  const run = executor.execute({
    projectPath: root, prompt: "Test helper bound.", timeoutSeconds: 30,
    maxOutputBytes: 1000, abortSignal: controller.signal,
  });
  void run.catch(() => undefined);
  controller.abort();
  expect(processBoundary.spawnSync).toHaveBeenCalledWith(
    expect.any(String),
    ["/PID", "123456", "/T", "/F"],
    expect.objectContaining({ timeout: 2000, killSignal: "SIGKILL" }),
  );
});
