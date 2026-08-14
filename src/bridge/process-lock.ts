import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";

import type { SystemId } from "../contracts/envelope.js";
import { ConfigurationError } from "../errors.js";

interface LockRecord {
  process_id: number;
  token: string;
  acquired_at_utc: string;
}

export interface BridgeProcessLock {
  readonly path: string;
  release(): void;
}

export interface BridgeProcessLockOptions {
  rootDirectory?: string;
  processId?: number;
  isProcessAlive?: (processId: number) => boolean;
  now?: () => Date;
  token?: string;
}

export function acquireBridgeProcessLock(
  systemId: SystemId,
  options: BridgeProcessLockOptions = {},
): BridgeProcessLock {
  const rootDirectory =
    options.rootDirectory ?? defaultBridgeRuntimeDirectory();
  const processId = options.processId ?? process.pid;
  const isProcessAlive = options.isProcessAlive ?? defaultProcessAlive;
  const token = options.token ?? randomUUID();
  const now = options.now ?? (() => new Date());
  const lockPath = path.join(
    rootDirectory,
    `${systemId.toLowerCase()}.bridge-worker.lock`,
  );

  fs.mkdirSync(rootDirectory, { recursive: true });
  const record: LockRecord = {
    process_id: processId,
    token,
    acquired_at_utc: now().toISOString(),
  };

  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const descriptor = fs.openSync(lockPath, "wx", 0o600);
      try {
        fs.writeFileSync(descriptor, JSON.stringify(record), "utf8");
      } finally {
        fs.closeSync(descriptor);
      }
      return {
        path: lockPath,
        release: () => releaseOwnedLock(lockPath, token),
      };
    } catch (error) {
      if (!isAlreadyExists(error)) {
        throw error;
      }
      const existing = readLockRecord(lockPath);
      if (isProcessAlive(existing.process_id)) {
        throw new ConfigurationError(
          `A bridge worker is already running for ${systemId}`,
        );
      }
      fs.unlinkSync(lockPath);
    }
  }

  throw new ConfigurationError(
    `Could not acquire the bridge worker lock for ${systemId}`,
  );
}

function defaultBridgeRuntimeDirectory(): string {
  const programData =
    process.env["ProgramData"] ??
    process.env["PROGRAMDATA"] ??
    (process.platform === "win32"
      ? "C:\\ProgramData"
      : path.join(os.tmpdir(), "program-data"));
  return path.join(programData, "Balcony", "AgentBridge", "runtime");
}

function readLockRecord(lockPath: string): LockRecord {
  try {
    const candidate = JSON.parse(fs.readFileSync(lockPath, "utf8")) as Partial<LockRecord>;
    if (
      !Number.isSafeInteger(candidate.process_id) ||
      (candidate.process_id ?? 0) <= 0 ||
      typeof candidate.token !== "string" ||
      candidate.token.length === 0 ||
      typeof candidate.acquired_at_utc !== "string"
    ) {
      throw new Error("invalid lock record");
    }
    return candidate as LockRecord;
  } catch (error) {
    throw new ConfigurationError(
      `The bridge worker lock is unreadable: ${path.basename(lockPath)}`,
    );
  }
}

function releaseOwnedLock(lockPath: string, token: string): void {
  if (!fs.existsSync(lockPath)) {
    return;
  }
  const existing = readLockRecord(lockPath);
  if (existing.token === token) {
    fs.unlinkSync(lockPath);
  }
}

function defaultProcessAlive(processId: number): boolean {
  try {
    process.kill(processId, 0);
    return true;
  } catch (error) {
    return !(
      error &&
      typeof error === "object" &&
      "code" in error &&
      error.code === "ESRCH"
    );
  }
}

function isAlreadyExists(error: unknown): boolean {
  return Boolean(
    error &&
      typeof error === "object" &&
      "code" in error &&
      error.code === "EEXIST",
  );
}
