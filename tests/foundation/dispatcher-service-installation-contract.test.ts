import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const repositoryRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);
const read = (relativePath: string): string =>
  fs
    .readFileSync(path.join(repositoryRoot, relativePath), "utf8")
    .replace(/\r\n/g, "\n");

const installer = read("scripts/Install-DispatcherService.ps1");
const activator = read("scripts/Enable-DispatcherAutomaticStartup.ps1");
const safetyCheck = read("scripts/Test-DispatcherRuntimeSafety.ps1");
const template = read("service/balcony-agent-dispatcher.xml.template");

describe("dispatcher Windows service installation contract", () => {
  it("installs disabled-by-default under LocalService with a unique service SID", () => {
    expect(template).toContain("<startmode>Manual</startmode>");
    expect(installer).toContain(
      '$serviceAccount = "NT AUTHORITY\\LocalService"',
    );
    expect(installer).toContain(
      '$serviceSidAccount = "NT SERVICE\\$serviceName"',
    );
    expect(installer).toContain(
      "Set-Service -Name $serviceName -StartupType Manual",
    );
    expect(installer).not.toContain("LocalSystem");
    expect(installer).not.toContain("Start-Service");
  });

  it("uses the documented LocalService command after enabling the service SID", () => {
    expect(installer).toContain("sc.exe sidtype $serviceName unrestricted");
    expect(installer).toContain("& cmd.exe /d /s /c $accountCommand");
    expect(installer.indexOf("sc.exe sidtype")).toBeLessThan(
      installer.indexOf("& cmd.exe /d /s /c $accountCommand"),
    );
  });

  it("pins the release and executable identities before installation", () => {
    expect(installer).toContain("Repository HEAD does not match ApprovedRevision");
    expect(installer).toContain("The dispatcher release worktree must be clean");
    expect(installer).toContain("Get-FileHash -Algorithm SHA256");
    expect(installer).toContain("[string] $WinSwExecutableSha256");
    expect(installer).toContain("schema_version 1.2");
    expect(installer).toContain("exactly one enabled project");
    expect(installer).toContain(
      "Initial unattended activation is limited to balcony-agent-bridge",
    );
    expect(installer).toContain(
      "The enabled project path must equal the approved release checkout",
    );
    expect(installer).toContain(
      "The machine-local project registry must remain outside Git",
    );
    expect(installer).toContain(
      "The installed Codex executable failed post-copy verification",
    );
    expect(installer).toContain("[string] $CodexCodeModeHostExecutable");
    expect(installer).toContain("[string] $CodexCodeModeHostExecutableSha256");
    expect(installer).toContain(
      "The installed Codex code-mode host failed post-copy verification",
    );
    expect(installer).toContain(
      'Join-Path $binaryDirectory "codex-code-mode-host.exe"',
    );
    expect(template).toContain("BALCONY_CODEX_CODE_MODE_HOST_EXECUTABLE");
    expect(template).toContain("BALCONY_CODEX_CODE_MODE_HOST_SHA256");
  });

  it("grants the service SID execute access to the complete Codex bundle", () => {
    expect(installer).toContain(
      "Codex and its code-mode host must come from the same package directory",
    );
    expect(installer).toContain(
      "Add-FileSystemAccessRule -Path $installedCodexExecutable",
    );
    expect(installer).toContain(
      "Add-FileSystemAccessRule -Path $installedCodexCodeModeHost",
    );
    expect(installer).toContain("-Rights ReadAndExecute");
  });

  it("keeps Azure credentials out of the dispatcher process", () => {
    expect(template).not.toContain("SERVICEBUS");
    expect(template).not.toContain("AZURE_");
    expect(template).not.toContain("TOKEN");
    expect(template).not.toContain("PASSWORD");
    expect(template).toContain('value="__DISPATCHER_MODE__"');
    expect(installer).toContain('[ValidateSet("legacy", "consultation")]');
    expect(installer).toContain('[string] $DispatcherMode = "legacy"');
    expect(installer).toContain("[datetimeoffset] $NotBeforeUtc");
    expect(template).toContain("BALCONY_DISPATCHER_NOT_BEFORE_UTC");
  });

  it("separates installation from owner-approved automatic activation", () => {
    expect(activator).toContain("[switch] $OwnerApproved");
    expect(activator).toContain("start= delayed-auto");
    expect(activator).toContain("must pass live acceptance and be running first");
    expect(safetyCheck).toContain("AUTOMATIC_STARTUP_NOT_ENABLED");
    expect(safetyCheck).toContain("UNEXPECTED_SERVICE_LOGON_ACCOUNT");
    expect(safetyCheck).toContain("SERVICE_SID_NOT_UNRESTRICTED");
  });
});
