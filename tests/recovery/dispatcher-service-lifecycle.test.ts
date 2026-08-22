import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const repositoryRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);
const modulePath = path.join(
  repositoryRoot,
  "scripts/DispatcherServiceLifecycle.psm1",
);
const updaterPath = path.join(
  repositoryRoot,
  "scripts/Update-DispatcherService.ps1",
);

function runPowerShell(source: string, executable = "powershell.exe") {
  const encoded = Buffer.from(source, "utf16le").toString("base64");
  const childEnvironment = { ...process.env };
  if (executable.toLowerCase() === "powershell.exe") {
    childEnvironment["PSModulePath"] = [
      path.join(
        process.env["SystemRoot"] ?? "C:\\Windows",
        "System32/WindowsPowerShell/v1.0/Modules",
      ),
      path.join(
        process.env["ProgramFiles"] ?? "C:\\Program Files",
        "WindowsPowerShell/Modules",
      ),
    ].join(";");
  }
  return spawnSync(
    executable,
    ["-NoProfile", "-NonInteractive", "-EncodedCommand", encoded],
    { cwd: repositoryRoot, encoding: "utf8", env: childEnvironment },
  );
}

describe("dispatcher service lifecycle recovery", () => {
  it("routes updater service control through the tested lifecycle module", () => {
    expect(fs.existsSync(modulePath)).toBe(true);
    const updater = fs.readFileSync(updaterPath, "utf8");

    expect(updater).toContain("DispatcherServiceLifecycle.psm1");
    expect(updater).toContain("Stop-DispatcherServiceAndWait");
    expect(updater).toContain("Start-DispatcherServiceWithRetry");
    expect(updater).not.toMatch(/^\s*Start-Service\b/gmu);
    expect(updater).not.toMatch(/^\s*Stop-Service\b/gmu);
  });

  it("snapshots a stopped service with an empty child collection", () => {
    const result = runPowerShell(`
      $ErrorActionPreference = "Stop"
      function global:Get-CimInstance {
        param(
          [Parameter(Position = 0)] [string] $ClassName,
          [string] $Filter
        )
        if ($ClassName -eq "Win32_Service") {
          return [pscustomobject]@{
            State = "Stopped"
            StartMode = "Manual"
            ProcessId = 0
          }
        }
        throw "Unexpected CIM query"
      }
      try {
        Import-Module -Force "${modulePath.replaceAll("\\", "\\\\")}"
        $adapter = New-DispatcherServiceAdapter
        $snapshot = Get-DispatcherServiceSnapshot -ServiceName "TestDispatcher" -Adapter $adapter
        [pscustomobject]@{
          state = $snapshot.State
          processId = $snapshot.ProcessId
          childCount = $snapshot.ChildCount
          childProcessIds = @($snapshot.ChildProcessIds)
        } | ConvertTo-Json -Compress
      }
      finally {
        Remove-Item Function:\\global:Get-CimInstance -ErrorAction SilentlyContinue
      }
    `);

    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout.trim())).toEqual({
      state: "Stopped",
      processId: 0,
      childCount: 0,
      childProcessIds: [],
    });
  });

  it("waits for the stopped wrapper and its child to exit", () => {
    const result = runPowerShell(`
      $ErrorActionPreference = "Stop"
      Import-Module -Force "${modulePath.replaceAll("\\", "\\\\")}"
      $global:snapshotCall = 0
      $global:processCall = 0
      $global:stopCall = 0
      $adapter = @{
        GetSnapshot = {
          param($ServiceName)
          $global:snapshotCall++
          if ($global:snapshotCall -eq 1) {
            return [pscustomobject]@{ State = "Running"; StartMode = "Manual"; ProcessId = 10; ChildProcessIds = @(11); ChildCount = 1 }
          }
          return [pscustomobject]@{ State = "Stopped"; StartMode = "Manual"; ProcessId = 0; ChildProcessIds = @(); ChildCount = 0 }
        }
        ProcessExists = {
          param($ProcessId)
          $global:processCall++
          return $global:processCall -le 1
        }
        Stop = { param($ServiceName) $global:stopCall++ }
        Start = { param($ServiceName) throw "unexpected start" }
        Sleep = { param($Milliseconds) }
      }
      $snapshot = Stop-DispatcherServiceAndWait -ServiceName "TestDispatcher" -Adapter $adapter -TimeoutSeconds 2 -PollIntervalMs 100
      [pscustomobject]@{
        state = $snapshot.State
        stopCalls = $global:stopCall
        processChecks = $global:processCall
      } | ConvertTo-Json -Compress
    `);

    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout.trim())).toEqual({
      state: "Stopped",
      stopCalls: 1,
      processChecks: 3,
    });
  });

  it("retries a transient start failure and requires exactly one child", () => {
    const result = runPowerShell(`
      $ErrorActionPreference = "Stop"
      Import-Module -Force "${modulePath.replaceAll("\\", "\\\\")}"
      $global:startCall = 0
      $global:stopCall = 0
      $adapter = @{
        GetSnapshot = {
          param($ServiceName)
          if ($global:startCall -ge 2) {
            return [pscustomobject]@{ State = "Running"; StartMode = "Manual"; ProcessId = 20; ChildProcessIds = @(21); ChildCount = 1 }
          }
          return [pscustomobject]@{ State = "Stopped"; StartMode = "Manual"; ProcessId = 0; ChildProcessIds = @(); ChildCount = 0 }
        }
        ProcessExists = { param($ProcessId) return $false }
        Stop = { param($ServiceName) $global:stopCall++ }
        Start = {
          param($ServiceName)
          $global:startCall++
          if ($global:startCall -eq 1) {
            throw [ComponentModel.Win32Exception]::new(1061, "SECRET_MARKER")
          }
        }
        Sleep = { param($Milliseconds) }
      }
      $snapshot = Start-DispatcherServiceWithRetry -ServiceName "TestDispatcher" -Adapter $adapter -MaxAttempts 3 -HealthTimeoutSeconds 2 -PollIntervalMs 100 -RetryDelayMs 1
      [pscustomobject]@{
        state = $snapshot.State
        childCount = $snapshot.ChildCount
        startCalls = $global:startCall
      } | ConvertTo-Json -Compress
    `);

    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout.trim())).toEqual({
      state: "Running",
      childCount: 1,
      startCalls: 2,
    });
    expect(result.stdout).not.toContain("SECRET_MARKER");
    expect(result.stderr).not.toContain("SECRET_MARKER");
  });

  it("formats failures without including exception messages", () => {
    const result = runPowerShell(`
      $ErrorActionPreference = "Stop"
      Import-Module -Force "${modulePath.replaceAll("\\", "\\\\")}"
      try {
        throw [ComponentModel.Win32Exception]::new(1061, "SECRET_MARKER")
      }
      catch {
        $snapshot = [pscustomobject]@{ State = "Stopped"; StartMode = "Manual"; ProcessId = 0; ChildProcessIds = @(); ChildCount = 0 }
        Format-DispatcherServiceFailure -Stage "forward-start" -ErrorRecord $_ -Snapshot $snapshot
      }
    `);

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain("stage=forward-start");
    expect(result.stdout).toContain("nativeCode=1061");
    expect(result.stdout).toContain("serviceState=Stopped");
    expect(result.stdout).not.toContain("SECRET_MARKER");
  });

  it("fails closed after the bounded start attempts are exhausted", () => {
    const result = runPowerShell(`
      $ErrorActionPreference = "Stop"
      Import-Module -Force "${modulePath.replaceAll("\\", "\\\\")}"
      $global:startCall = 0
      $adapter = @{
        GetSnapshot = { param($ServiceName) [pscustomobject]@{ State = "Stopped"; StartMode = "Manual"; ProcessId = 0; ChildProcessIds = @(); ChildCount = 0 } }
        ProcessExists = { param($ProcessId) return $false }
        Stop = { param($ServiceName) }
        Start = { param($ServiceName) $global:startCall++; throw [ComponentModel.Win32Exception]::new(1061, "SECRET_MARKER") }
        Sleep = { param($Milliseconds) }
      }
      try {
        Start-DispatcherServiceWithRetry -ServiceName "TestDispatcher" -Adapter $adapter -MaxAttempts 3 -HealthTimeoutSeconds 1 -PollIntervalMs 100 -RetryDelayMs 0
        exit 9
      }
      catch {
        $snapshot = [pscustomobject]@{ State = "Stopped"; StartMode = "Manual"; ProcessId = 0; ChildProcessIds = @(); ChildCount = 0 }
        [pscustomobject]@{
          stage = $_.Exception.Data["DispatcherStage"]
          attempts = $_.Exception.Data["DispatcherStartAttempts"]
          startCalls = $global:startCall
          message = $_.Exception.Message
          summary = Format-DispatcherServiceFailure -Stage "forward-start" -ErrorRecord $_ -Snapshot $snapshot
        } | ConvertTo-Json -Compress
      }
    `);

    expect(result.status, result.stderr).toBe(0);
    const failure = JSON.parse(result.stdout.trim());
    expect(failure).toMatchObject({
      stage: "service-start-retry",
      attempts: 3,
      startCalls: 3,
      message: "The dispatcher service failed its bounded start attempts.",
    });
    expect(failure.summary).toContain("nativeCode=1061");
    expect(result.stdout).not.toContain("SECRET_MARKER");
    expect(result.stderr).not.toContain("SECRET_MARKER");
  });

  it("restores a pre-existing code-mode host byte hash and distinct SDDL", () => {
    const escapedUpdaterPath = updaterPath.replaceAll("\\", "\\\\");
    const source = `
      $ErrorActionPreference = "Stop"
      if ($PSVersionTable.PSEdition -eq "Desktop") {
        $env:PSModulePath = "$env:SystemRoot\\System32\\WindowsPowerShell\\v1.0\\Modules;$env:ProgramFiles\\WindowsPowerShell\\Modules"
      }
      Import-Module Microsoft.PowerShell.Security -ErrorAction Stop
      $tokens = $null
      $parseErrors = $null
      $ast = [Management.Automation.Language.Parser]::ParseFile(
        "${escapedUpdaterPath}",
        [ref] $tokens,
        [ref] $parseErrors
      )
      if ($parseErrors.Count -ne 0) { throw "Updater parse failed" }
      $requiredFunctions = @(
        "Backup-DispatcherAclSnapshot",
        "Restore-DispatcherAclSnapshot",
        "Assert-DispatcherAclSnapshot"
      )
      $definitions = @($ast.FindAll({
        param($node)
        $node -is [Management.Automation.Language.FunctionDefinitionAst] -and
          $requiredFunctions -contains $node.Name
      }, $true))
      if ($definitions.Count -ne $requiredFunctions.Count) {
        throw "ACL rollback helpers are incomplete"
      }
      foreach ($definition in $definitions) {
        Invoke-Expression $definition.Extent.Text
      }

      $testRoot = Join-Path ([IO.Path]::GetTempPath()) (
        "dispatcher-host-acl-" + [guid]::NewGuid().ToString("N")
      )
      New-Item -ItemType Directory -Path $testRoot | Out-Null
      try {
        $hostPath = Join-Path $testRoot "codex-code-mode-host.exe"
        $backupPath = Join-Path $testRoot "codex-code-mode-host.backup.exe"
        $aclSnapshotPath = Join-Path $testRoot "acl-snapshot.json"
        [IO.File]::WriteAllBytes($hostPath, [Text.Encoding]::UTF8.GetBytes("original-host-bytes"))
        Copy-Item -LiteralPath $hostPath -Destination $backupPath

        $owner = [Security.Principal.WindowsIdentity]::GetCurrent().Name
        $initialAcl = Get-Acl -LiteralPath $hostPath
        $initialAcl.SetAccessRuleProtection($true, $false)
        $initialAcl.SetAccessRule((New-Object Security.AccessControl.FileSystemAccessRule(
          $owner,
          [Security.AccessControl.FileSystemRights]::FullControl,
          [Security.AccessControl.AccessControlType]::Allow
        )))
        Set-Acl -LiteralPath $hostPath -AclObject $initialAcl
        $initialSddl = (Get-Acl -LiteralPath $hostPath).Sddl
        $directorySddl = (Get-Acl -LiteralPath $testRoot).Sddl
        if ($initialSddl -eq $directorySddl) {
          throw "Companion ACL fixture is not distinct"
        }
        $initialHash = (Get-FileHash -Algorithm SHA256 -LiteralPath $hostPath).Hash

        Backup-DispatcherAclSnapshot -Paths @($hostPath) -Destination $aclSnapshotPath

        [IO.File]::WriteAllBytes($hostPath, [Text.Encoding]::UTF8.GetBytes("mutated-host-bytes"))
        $null = & icacls.exe $hostPath /grant '*S-1-5-19:(RX)'
        if ($LASTEXITCODE -ne 0) {
          throw "Forward companion ACL mutation failed"
        }
        $mutatedSddl = (Get-Acl -LiteralPath $hostPath).Sddl
        if ($mutatedSddl -eq $initialSddl) {
          throw "Forward ACL mutation did not change the companion SDDL"
        }

        Copy-Item -LiteralPath $backupPath -Destination $hostPath -Force
        Restore-DispatcherAclSnapshot -Path $aclSnapshotPath
        Assert-DispatcherAclSnapshot -Path $aclSnapshotPath

        $restoredHash = (Get-FileHash -Algorithm SHA256 -LiteralPath $hostPath).Hash
        $restoredSddl = (Get-Acl -LiteralPath $hostPath).Sddl
        [pscustomobject]@{
          hashRestored = $restoredHash -eq $initialHash
          sddlRestored = $restoredSddl -eq $initialSddl
          sddlWasDistinct = $initialSddl -ne $directorySddl
          forwardAclMutated = $mutatedSddl -ne $initialSddl
        } | ConvertTo-Json -Compress
      }
      finally {
        if (Test-Path -LiteralPath $testRoot) {
          Remove-Item -LiteralPath $testRoot -Recurse -Force
        }
      }
    `;

    for (const executable of ["powershell.exe", "pwsh.exe"]) {
      const result = runPowerShell(source, executable);
      expect(result.status, `${executable}: ${result.stderr}`).toBe(0);
      expect(JSON.parse(result.stdout.trim())).toEqual({
        hashRestored: true,
        sddlRestored: true,
        sddlWasDistinct: true,
        forwardAclMutated: true,
      });
    }
  });
});
