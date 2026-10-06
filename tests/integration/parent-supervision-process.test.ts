import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, type ChildProcess } from "node:child_process";
import { pathToFileURL } from "node:url";

import { expect, it } from "vitest";

it("a disposable orphaned runtime detects parent loss and releases only its owned lock", async () => {
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "bridge-parent-proof-")));
  const repository = path.resolve(import.meta.dirname, "../..");
  const ready = path.join(root, "ready.json");
  const stopped = path.join(root, "stopped.json");
  const errors = path.join(root, "child-error.log");
  const supervisorUrl = pathToFileURL(path.join(repository, "src/runtime/parent-supervision.ts")).href;
  const lockUrl = pathToFileURL(path.join(repository, "src/bridge/process-lock.ts")).href;
  const childFile = path.join(root, "child.mjs");
  const parentFile = path.join(root, "parent.mjs");
  fs.writeFileSync(childFile, `
    import fs from "node:fs";
    import { superviseParent } from ${JSON.stringify(supervisorUrl)};
    import { acquireBridgeProcessLock } from ${JSON.stringify(lockUrl)};
    const controller = new AbortController();
    const lock = acquireBridgeProcessLock("parent-proof", {rootDirectory:${JSON.stringify(root)}});
    const keepAlive = setInterval(() => {}, 1000);
    let failure;
    const done = new Promise(resolve => controller.signal.addEventListener("abort", resolve, {once:true}));
    const stop = superviseParent(controller, {
      enabled:true, pollIntervalMs:25,
      onFailure: code => { failure=code; process.exitCode=1; }
    });
    fs.writeFileSync(${JSON.stringify(ready)}, JSON.stringify({pid:process.pid,parentPid:process.ppid,lock:lock.path}));
    await done;
    stop(); clearInterval(keepAlive); lock.release();
    fs.writeFileSync(${JSON.stringify(stopped)}, JSON.stringify({failure,exitCode:process.exitCode,lockReleased:!fs.existsSync(lock.path)}));
  `);
  const loader = pathToFileURL(path.join(repository, "node_modules/tsx/dist/loader.mjs")).href;
  fs.writeFileSync(parentFile, `
    import {spawn} from "node:child_process";
    import fs from "node:fs";
    const log=fs.openSync(${JSON.stringify(errors)},"w");
    const child=spawn(process.execPath, ["--import",${JSON.stringify(loader)},${JSON.stringify(childFile)}], {
      stdio:["ignore",log,log],windowsHide:true,detached:true
    });
    child.unref();
    setInterval(() => {},1000);
  `);
  let parent: ChildProcess | undefined;
  let childPid: number | undefined;
  try {
    parent = spawn(process.execPath, [parentFile], { stdio: "ignore", windowsHide: true });
    await waitUntil(() => fs.existsSync(ready), 10_000);
    const record = JSON.parse(fs.readFileSync(ready, "utf8")) as {
      pid: number; parentPid: number; lock: string;
    };
    childPid = record.pid;
    expect(record.parentPid).toBe(parent.pid);
    expect(fs.existsSync(record.lock)).toBe(true);
    // Kill only this test-created parent; the mechanism must stop its child.
    expect(parent.kill("SIGKILL")).toBe(true);
    try {
      await waitUntil(() => fs.existsSync(stopped), 10_000);
    } catch (error) {
      throw new Error(
        `Supervision stop missing: childAlive=${alive(childPid)}, parentAlive=${alive(parent.pid!)}; ` +
        `diagnostic=${fs.existsSync(errors) ? fs.readFileSync(errors, "utf8") : "none"}`,
        { cause: error },
      );
    }
    expect(JSON.parse(fs.readFileSync(stopped, "utf8"))).toEqual({
      failure: "RUNTIME_PARENT_LOST", exitCode: 1, lockReleased: true,
    });
    await waitUntil(() => !alive(childPid!), 10_000);
  } finally {
    if (parent?.pid && alive(parent.pid)) parent.kill("SIGKILL");
    if (childPid && alive(childPid)) process.kill(childPid, "SIGKILL");
    // Resolved target is the single test-owned directory, never a production path.
    expect(path.dirname(root).toLowerCase()).toBe(fs.realpathSync.native(os.tmpdir()).toLowerCase());
    fs.rmSync(root, { recursive: true, force: true });
  }
}, 30_000);

function alive(pid: number): boolean {
  try { process.kill(pid, 0); return true; }
  catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ESRCH") return false;
    throw error;
  }
}

async function waitUntil(condition: () => boolean, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() >= deadline) throw new Error("Disposable supervision process did not reach the expected state.");
    await new Promise(resolve => setTimeout(resolve, 25));
  }
}
