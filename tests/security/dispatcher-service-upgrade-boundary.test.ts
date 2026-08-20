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

describe("dispatcher service upgrade security boundary", () => {
  it("contains no Azure, bridge, credential, or authentication mutation", () => {
    expect(script).not.toMatch(/SERVICEBUS|AZURE_|connection string|token/iu);
    expect(script).not.toMatch(/auth\.json|device auth|login/iu);
    expect(script).not.toContain("BalconyAgentBridge");
  });

  it("requires service-SID execute access on both installed binaries", () => {
    expect(script).toContain('$serviceSidAccount = "NT SERVICE\\$serviceName"');
    expect(script).toContain("sc.exe qsidtype $serviceName");
    expect(script).toContain("UNRESTRICTED");
    expect(script).toContain(
      "Add-FileSystemAccessRule -Path $installedCodexExecutable",
    );
    expect(script).toContain(
      "Add-FileSystemAccessRule -Path $installedCodexCodeModeHost",
    );
    expect(script).toContain("-Rights ReadAndExecute");
  });

  it("keeps rollback material inside the explicit dispatcher install root", () => {
    expect(script).toContain("Assert-ContainedPath");
    expect(script).toContain("$backupDirectory");
    expect(script).toContain("$InstallRoot");
  });

  it("loads the atomic registry migration boundary from the approved release", () => {
    expect(script).toContain("DispatcherRegistryMigration.psm1");
    expect(script).toContain("Import-Module -Force -Name $registryMigrationModule");
    expect(script).toContain("Set-DispatcherProjectRegistry");
  });
});
