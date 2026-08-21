import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const repositoryRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);
const script = fs
  .readFileSync(
    path.join(repositoryRoot, "scripts/Update-DispatcherService.ps1"),
    "utf8",
  )
  .replace(/\r\n/g, "\n");
const lifecycle = fs
  .readFileSync(
    path.join(repositoryRoot, "scripts/DispatcherServiceLifecycle.psm1"),
    "utf8",
  )
  .replace(/\r\n/g, "\n");

describe("dispatcher existing-service upgrade contract", () => {
  it("requires exact release and two-file Codex bundle pins", () => {
    expect(script).toContain("[string] $ApprovedRevision");
    expect(script).toContain("[string] $CodexExecutableSha256");
    expect(script).toContain("[string] $CodexCodeModeHostExecutableSha256");
    expect(script).toContain("Repository HEAD does not match ApprovedRevision");
    expect(script).toContain("The dispatcher release worktree must be clean");
    expect(script).toContain("codex-code-mode-host.exe");
  });

  it("preserves machine-local state and upgrades only the existing dispatcher", () => {
    expect(script).toContain("Dispatcher service '$serviceName' is not installed");
    expect(script).toContain("The dedicated dispatcher CODEX_HOME must already exist");
    expect(script).toContain("The machine-local project registry must remain outside Git");
    expect(script).toContain("Stop-DispatcherServiceAndWait");
    expect(script).toContain("Start-DispatcherServiceWithRetry");
    expect(lifecycle).toContain("Stop-Service -Name $ServiceName");
    expect(lifecycle).toContain("Start-Service -Name $ServiceName");
    expect(script).not.toContain("BalconyAgentBridge");
    expect(script).not.toContain("Remove-Service");
    expect(script).not.toContain("Uninstall");
  });

  it("validates current registry state separately from the desired release", () => {
    expect(script).toContain("Get-DispatcherRegistryMigrationJson");
    expect(script).toContain("$currentBridgeRepositoryRoot");
    expect(script).toContain("$currentBridgeRevision");
    expect(script).toContain("$desiredRegistryJson");
  });

  it("makes consultation mode and the new release explicit", () => {
    expect(script).toContain('[ValidateSet("consultation")]');
    expect(script).toContain('"__DISPATCHER_MODE__" = $DispatcherMode');
    expect(script).toContain('"__DISPATCHER_ENTRYPOINT__" = $dispatcherEntrypoint');
    expect(lifecycle).toContain("$snapshot.ChildCount -eq 1");
  });
});
