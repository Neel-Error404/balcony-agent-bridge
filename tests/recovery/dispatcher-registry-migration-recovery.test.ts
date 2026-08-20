import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const repositoryRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);
const modulePath = path.join(
  repositoryRoot,
  "scripts/DispatcherRegistryMigration.psm1",
);
const powerShell = path.join(
  process.env["SystemRoot"] ?? "C:\\Windows",
  "System32/WindowsPowerShell/v1.0/powershell.exe",
);

describe("dispatcher registry migration recovery", () => {
  it("restores the exact original registry bytes after migration failure", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "bridge-registry-rollback-"));
    try {
      const registryPath = path.join(root, "projects.json");
      const backupPath = path.join(root, "projects.backup.json");
      const desiredPath = path.join(root, "desired.json");
      const original = Buffer.from(
        `\uFEFF{\r\n  "schema_version": "1.2",\r\n  "marker": "original"\r\n}\r\n`,
        "utf8",
      );
      fs.writeFileSync(registryPath, original);
      fs.writeFileSync(
        desiredPath,
        '{"schema_version":"1.2","marker":"candidate"}',
      );

      runPowerShell(`
        $ErrorActionPreference = 'Stop'
        Import-Module -Force '${powerShellLiteral(modulePath)}'
        Backup-DispatcherProjectRegistry ` +
        `-Path $env:TEST_REGISTRY -BackupPath $env:BACKUP_REGISTRY
        Set-DispatcherProjectRegistry ` +
        `-Path $env:TEST_REGISTRY ` +
        `-Content (Get-Content -Raw -LiteralPath $env:DESIRED_REGISTRY) ` +
        `-Confirm:$false
        Restore-DispatcherProjectRegistry ` +
        `-Path $env:TEST_REGISTRY -BackupPath $env:BACKUP_REGISTRY
      `, {
        BACKUP_REGISTRY: backupPath,
        DESIRED_REGISTRY: desiredPath,
        TEST_REGISTRY: registryPath,
      });

      expect(fs.readFileSync(registryPath)).toEqual(original);
    } finally {
      fs.rmSync(root, { force: true, recursive: true });
    }
  });
});

function runPowerShell(
  command: string,
  environment: Record<string, string>,
): void {
  const result = spawnSync(
    powerShell,
    [
      "-NoLogo",
      "-NoProfile",
      "-NonInteractive",
      "-ExecutionPolicy",
      "Bypass",
      "-Command",
      command,
    ],
    {
      cwd: repositoryRoot,
      encoding: "utf8",
      env: { ...process.env, ...environment },
    },
  );
  if (result.status !== 0) {
    throw new Error(
      `PowerShell exited ${result.status}: ${result.stderr || result.stdout}`,
    );
  }
}

function powerShellLiteral(value: string): string {
  return value.replaceAll("'", "''");
}
