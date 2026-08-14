import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { acquireBridgeProcessLock } from "../../src/bridge/process-lock.js";

describe("bridge process lock", () => {
  let temporaryDirectory: string | undefined;

  afterEach(() => {
    if (temporaryDirectory) {
      fs.rmSync(temporaryDirectory, { recursive: true, force: true });
      temporaryDirectory = undefined;
    }
  });

  it("rejects a second live worker for the same system", () => {
    const rootDirectory = fs.mkdtempSync(
      path.join(os.tmpdir(), "balcony-bridge-lock-"),
    );
    temporaryDirectory = rootDirectory;
    const first = acquireBridgeProcessLock("SYS-A", {
      rootDirectory,
      processId: 101,
      token: "first-owner",
      isProcessAlive: (processId) => processId === 101,
    });

    expect(() =>
      acquireBridgeProcessLock("SYS-A", {
        rootDirectory,
        processId: 202,
        token: "second-owner",
        isProcessAlive: (processId) => processId === 101,
      }),
    ).toThrow("already running");

    first.release();
  });

  it("reclaims a stale worker lock", () => {
    const rootDirectory = fs.mkdtempSync(
      path.join(os.tmpdir(), "balcony-bridge-lock-"),
    );
    temporaryDirectory = rootDirectory;
    const stale = acquireBridgeProcessLock("SYS-A", {
      rootDirectory,
      processId: 303,
      token: "stale-owner",
      isProcessAlive: () => false,
    });
    expect(fs.existsSync(stale.path)).toBe(true);

    const replacement = acquireBridgeProcessLock("SYS-A", {
      rootDirectory,
      processId: 404,
      token: "replacement-owner",
      isProcessAlive: () => false,
    });

    expect(JSON.parse(fs.readFileSync(replacement.path, "utf8"))).toMatchObject({
      process_id: 404,
      token: "replacement-owner",
    });
    replacement.release();
    expect(fs.existsSync(replacement.path)).toBe(false);
  });

  it("allows a new worker after the owner releases the lock", () => {
    const rootDirectory = fs.mkdtempSync(
      path.join(os.tmpdir(), "balcony-bridge-lock-"),
    );
    temporaryDirectory = rootDirectory;
    const first = acquireBridgeProcessLock("SYS-B", {
      rootDirectory,
      processId: 505,
      token: "first-owner",
      isProcessAlive: () => true,
    });
    first.release();

    const second = acquireBridgeProcessLock("SYS-B", {
      rootDirectory,
      processId: 606,
      token: "second-owner",
      isProcessAlive: () => true,
    });
    expect(fs.existsSync(second.path)).toBe(true);
    second.release();
  });
});
