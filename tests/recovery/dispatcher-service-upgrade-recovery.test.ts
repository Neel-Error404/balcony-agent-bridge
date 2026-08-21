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

describe("dispatcher service upgrade recovery", () => {
  it("backs up every replaced artifact before stopping the service", () => {
    const mutationBlock = script.slice(script.indexOf("if ($PSCmdlet.ShouldProcess"));
    expect(
      mutationBlock.indexOf("Copy-Item -LiteralPath $serviceConfiguration"),
    ).toBeLessThan(
      mutationBlock.indexOf("Stop-DispatcherServiceAndWait"),
    );
    expect(script).toContain("$backupCodexExecutable");
    expect(script).toContain("$backupCodexCodeModeHost");
    expect(script).toContain("$backupProjectRegistry");
  });

  it("restores configuration and binaries before restarting after failure", () => {
    expect(script).toContain("catch {");
    expect(script).toContain("Restore-PreviousDispatcherState");
    expect(script).toContain("Restore-DispatcherProjectRegistry");
    expect(script).toContain("Restore-DispatcherAclSnapshot");
    expect(script).toContain("Assert-DispatcherAclSnapshot");
    expect(script).toContain("Assert-RestoredDispatcherState");
    expect(script).toMatch(/The previous dispatcher state ["\s+]*was restored/iu);
  });

  it("preserves the prior running state", () => {
    expect(script).toContain("$wasRunning");
    expect(script).toContain("if ($wasRunning)");
  });

  it("preserves both failure records and reports the failing stages", () => {
    expect(script).toContain("$forwardError = $_");
    expect(script).toContain("$forwardFailureStage = $operationStage");
    expect(script).toContain("$rollbackError = $_");
    expect(script).toContain("$rollbackFailureStage = $operationStage");
    expect(script).toContain("Format-DispatcherServiceFailure");
  });

  it("retains rollback material until post-deployment acceptance", () => {
    expect(script).not.toMatch(/Remove-Item[^\n]+\$backupDirectory/iu);
    expect(script).toContain("Rollback backup ");
    expect(script).toContain("retained at $backupDirectory");
  });
});
