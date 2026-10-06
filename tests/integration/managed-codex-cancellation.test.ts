import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { expect, it } from "vitest";

import { LocalCodexExecutor } from "../../src/dispatcher/codex-executor.js";
import { resolveManagedCodexToolchain } from "../../src/onboarding/codex-toolchain.js";

it("cancels real managed Codex initialization with an isolated unauthenticated home", async () => {
  const root = fs.realpathSync.native(fs.mkdtempSync(
    path.join(os.tmpdir(), "managed-codex-cancellation-"),
  ));
  const home = path.join(root, "home");
  const project = path.join(root, "project");
  fs.mkdirSync(home);
  fs.mkdirSync(project);
  const toolchain = resolveManagedCodexToolchain({
    packageRoot: path.resolve(import.meta.dirname, "../.."),
  });
  const hash = (file: string): string =>
    createHash("sha256").update(fs.readFileSync(file)).digest("hex");
  const executor = new LocalCodexExecutor(
    toolchain.codexExecutable, home, hash(toolchain.codexExecutable),
    toolchain.codeModeHostExecutable, hash(toolchain.codeModeHostExecutable),
    process.env["PATH"] ?? process.env["Path"] ?? "",
    process.env,
  );
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    // Native spawn occurs synchronously inside execute. Cancel initialization
    // immediately; no auth/config is copied and no model response is expected.
    const run = executor.execute({
      projectPath: project, executionBoundary: "evidence_only",
      prompt: "Cancellation qualification only; no project or network work.",
      timeoutSeconds: 30, maxOutputBytes: 1000, abortSignal: controller.signal,
    });
    timer = setTimeout(() => controller.abort(), 5);
    await expect(run).rejects.toMatchObject({ code: "CODEX_ABORTED" });
    expect(fs.existsSync(path.join(home, "auth.json"))).toBe(false);
    expect(fs.existsSync(path.join(home, "config.toml"))).toBe(false);
  } finally {
    if (timer) clearTimeout(timer);
    controller.abort();
    expect(path.dirname(root).toLowerCase()).toBe(
      fs.realpathSync.native(os.tmpdir()).toLowerCase(),
    );
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
}, 15_000);
