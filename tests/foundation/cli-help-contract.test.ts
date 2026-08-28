import path from "node:path";
import { spawnSync } from "node:child_process";

import { describe, expect, it } from "vitest";

const repositoryRoot = path.resolve(import.meta.dirname, "../..");
const tsxCli = path.join(repositoryRoot, "node_modules", "tsx", "dist", "cli.mjs");
const cliSource = path.join(repositoryRoot, "src", "cli", "index.ts");

function runCli(args: readonly string[]) {
  return spawnSync(process.execPath, [tsxCli, cliSource, ...args], {
    cwd: repositoryRoot,
    encoding: "utf8",
    windowsHide: true,
    env: { ...process.env, BALCONY_SYSTEM_ID: "pilot-a" },
  });
}

describe("CLI discovery contract", () => {
  it("prints the exact package version", () => {
    const result = runCli(["--version"]);

    expect(result.status).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout.trim()).toBe("0.3.0");
  }, 15_000);

  it.each([
    "identity",
    "setup",
    "doctor",
    "status",
    "resource",
    "grant",
    "approval",
    "preflight",
    "onboard",
    "runtime",
  ])("provides scoped help for %s", (command) => {
    const result = runCli([command, "--help"]);

    expect(result.status).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout).toContain(`Usage: balcony-agent-bridge ${command}`);
  }, 15_000);

  it.each([
    ["onboard", "start", "--network-id"],
    ["onboard", "import-peer", "--enrollment"],
    ["onboard", "configure-transport", "--local-only"],
    ["onboard", "configure-dispatcher", "--project-path"],
    ["onboard", "configure-mcp", "--codex-executable"],
    ["onboard", "verify", "--root"],
    ["runtime", "bridge", "--validate"],
    ["runtime", "dispatcher", "--validate"],
  ])("provides action-specific help for %s %s", (command, action, option) => {
    const result = runCli([command, action, "--help"]);

    expect(result.status).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout).toContain(
      `Usage: balcony-agent-bridge ${command} ${action}`,
    );
    expect(result.stdout).toContain(option);
  }, 15_000);

  it("keeps usage failures distinct from help", () => {
    const result = runCli(["identity"]);

    expect(result.status).toBe(2);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("Usage: balcony-agent-bridge identity");
  }, 15_000);

  it("rejects a partial explicit Codex executable pair", () => {
    const result = runCli([
      "onboard",
      "configure-dispatcher",
      "--root",
      path.join(repositoryRoot, "missing-pilot-root"),
      "--project-key",
      "pilot-project",
      "--project-path",
      repositoryRoot,
      "--codex-executable",
      path.join(repositoryRoot, "codex.exe"),
    ]);

    expect(result.status).toBe(2);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("Usage: balcony-agent-bridge onboard");
  }, 15_000);
});
