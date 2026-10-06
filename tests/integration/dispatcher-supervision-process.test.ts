import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, expect, it } from "vitest";

import { resolveManagedCodexToolchain } from "../../src/onboarding/codex-toolchain.js";
import { BridgeDatabase } from "../../src/storage/database.js";

const repository = path.resolve(import.meta.dirname, "../..");
let root: string;
let databasePath: string;
let environment: NodeJS.ProcessEnv;

beforeEach(() => {
  root = fs.realpathSync.native(fs.mkdtempSync(
    path.join(os.tmpdir(), "dispatcher-supervision-proof-"),
  ));
  databasePath = path.join(root, "bridge.sqlite3");
  const home = path.join(root, "home");
  const project = path.join(root, "project");
  fs.mkdirSync(home);
  fs.mkdirSync(project);
  const registry = path.join(root, "projects.json");
  fs.writeFileSync(registry, JSON.stringify({
    schema_version: "1.0",
    projects: [{ key: "test-project", path: project, peer_readable: true }],
  }));
  const toolchain = resolveManagedCodexToolchain({ packageRoot: repository });
  const hash = (file: string): string =>
    createHash("sha256").update(fs.readFileSync(file)).digest("hex");
  environment = {
    SystemRoot: process.env["SystemRoot"],
    WINDIR: process.env["WINDIR"],
    PATH: process.env["PATH"] ?? process.env["Path"],
    TEMP: root, TMP: root,
    BALCONY_SYSTEM_ID: "SYS-A",
    BALCONY_AUTHORIZED_NODE_IDS: "SYS-B",
    BALCONY_BRIDGE_DB_PATH: databasePath,
    BALCONY_DISPATCHER_PROJECTS_PATH: registry,
    BALCONY_CODEX_EXECUTABLE: toolchain.codexExecutable,
    BALCONY_CODEX_EXECUTABLE_SHA256: hash(toolchain.codexExecutable),
    BALCONY_CODEX_CODE_MODE_HOST_EXECUTABLE: toolchain.codeModeHostExecutable,
    BALCONY_CODEX_CODE_MODE_HOST_SHA256: hash(toolchain.codeModeHostExecutable),
    BALCONY_DISPATCHER_CODEX_HOME: home,
    BALCONY_DISPATCHER_TRUSTED_PATH: process.env["PATH"] ?? process.env["Path"] ?? "",
    BALCONY_DISPATCHER_POLL_INTERVAL_MS: "250",
  };
  new BridgeDatabase(databasePath).close();
});

afterEach(() => {
  expect(path.dirname(root).toLowerCase()).toBe(
    fs.realpathSync.native(os.tmpdir()).toLowerCase(),
  );
  fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

it("the actual dispatcher entrypoint refuses a retained unverified executor failure", () => {
  const database = new BridgeDatabase(databasePath);
  database.recordConsultationCoordinatorHeartbeat(
    "prior-worker", "degraded", "CODEX_TERMINATION_FAILED",
  );
  database.close();
  const result = spawnSync(process.execPath, [
    "--import", "tsx", path.join(repository, "src/dispatcher/index.ts"),
  ], { cwd: repository, env: environment, encoding: "utf8", windowsHide: true, timeout: 10_000 });
  expect(result.error).toBeUndefined();
  expect(result.status).toBe(1);
  expect(result.stdout).toBe("");
  expect(result.stderr).toContain("CODEX_TERMINATION_FAILED");
  const observed = new BridgeDatabase(databasePath, { readOnly: true, requireExisting: true });
  try {
    expect(observed.getStatus().lastConsultationCoordinatorErrorCode).toBe("CODEX_TERMINATION_FAILED");
    expect(observed.getStatus().dispatcherHeartbeatAtUtc).toBeUndefined();
  } finally {
    observed.close();
  }
}, 15_000);

it("the actual idle dispatcher stops when its test-owned supervising parent disappears", async () => {
  const parentFile = path.join(root, "parent.mjs");
  const childRecord = path.join(root, "child.json");
  const childLog = path.join(root, "child.log");
  fs.writeFileSync(parentFile, `
    import fs from "node:fs";
    import {spawn} from "node:child_process";
    const log=fs.openSync(${JSON.stringify(childLog)},"w");
    const child=spawn(process.execPath,[
      "--import","tsx",${JSON.stringify(path.join(repository, "src/dispatcher/index.ts"))}
    ],{cwd:${JSON.stringify(repository)},env:${JSON.stringify({
      ...environment, BALCONY_RUNTIME_SUPERVISION: "service_parent",
    })},stdio:["ignore",log,log],windowsHide:true,detached:true});
    child.unref();
    fs.writeFileSync(${JSON.stringify(childRecord)},JSON.stringify({pid:child.pid,parent:process.pid}));
    setInterval(()=>{},1000);
  `);
  let parent: ChildProcess | undefined;
  let childPid: number | undefined;
  try {
    parent = spawn(process.execPath, [parentFile], { stdio: "ignore", windowsHide: true });
    await waitUntil(() => fs.existsSync(childRecord));
    const record = JSON.parse(fs.readFileSync(childRecord, "utf8")) as { pid: number; parent: number };
    childPid = record.pid;
    expect(record.parent).toBe(parent.pid);
    await waitUntil(() => {
      const database = new BridgeDatabase(databasePath, { readOnly: true, requireExisting: true });
      try { return database.getStatus().dispatcherReportedStatus === "healthy"; }
      finally { database.close(); }
    });
    expect(alive(childPid)).toBe(true);
    expect(parent.kill("SIGKILL")).toBe(true);
    await waitUntil(() => !alive(childPid!));
    const database = new BridgeDatabase(databasePath, { readOnly: true, requireExisting: true });
    try {
      expect(database.getStatus().lastDispatcherErrorCode).toBe("RUNTIME_PARENT_LOST");
      expect(database.getStatus().dispatcherReportedStatus).toBe("degraded");
    } finally { database.close(); }
    expect(fs.readFileSync(childLog, "utf8")).toContain("RUNTIME_PARENT_LOST");
  } finally {
    if (parent?.pid && alive(parent.pid)) parent.kill("SIGKILL");
    if (childPid && alive(childPid)) process.kill(childPid, "SIGKILL");
  }
}, 30_000);

function alive(pid: number): boolean {
  try { process.kill(pid, 0); return true; }
  catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ESRCH") return false;
    throw error;
  }
}

async function waitUntil(condition: () => boolean): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (!condition()) {
    if (Date.now() >= deadline) throw new Error("Dispatcher process proof timed out.");
    await new Promise(resolve => setTimeout(resolve, 25));
  }
}
