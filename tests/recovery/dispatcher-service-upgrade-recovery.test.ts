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
    expect(script.indexOf("Copy-Item -LiteralPath $serviceConfiguration")).toBeLessThan(
      script.indexOf("Stop-Service -Name $serviceName"),
    );
    expect(script).toContain("$backupCodexExecutable");
    expect(script).toContain("$backupCodexCodeModeHost");
    expect(script).toContain("$backupProjectRegistry");
  });

  it("restores configuration and binaries before restarting after failure", () => {
    expect(script).toContain("catch {");
    expect(script).toContain("Restore-PreviousDispatcherState");
    expect(script).toContain("Restore-DispatcherProjectRegistry");
    expect(script).toContain("The previous dispatcher state was restored");
  });

  it("preserves the prior running state", () => {
    expect(script).toContain("$wasRunning");
    expect(script).toContain("if ($wasRunning)");
  });
});
