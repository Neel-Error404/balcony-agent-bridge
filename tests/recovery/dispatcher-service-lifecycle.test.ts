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

function runPowerShell(source: string) {
  const encoded = Buffer.from(source, "utf16le").toString("base64");
  return spawnSync(
    "powershell.exe",
    ["-NoProfile", "-NonInteractive", "-EncodedCommand", encoded],
    { cwd: repositoryRoot, encoding: "utf8" },
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
});
