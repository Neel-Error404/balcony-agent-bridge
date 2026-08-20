import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

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
const temporaryDirectories: string[] = [];

describe("dispatcher registry migration process", () => {
  afterEach(() => {
    for (const directory of temporaryDirectories.splice(0)) {
      fs.rmSync(directory, { force: true, recursive: true });
    }
  });

  it("accepts an external registry on another volume and rejects contained paths", () => {
    const output = runPowerShell(`
      $ErrorActionPreference = 'Stop'
      Import-Module -Force '${powerShellLiteral(modulePath)}'
      $crossVolume = Test-CanonicalPathContained ` +
      `-Parent 'E:\\candidate' -Child 'C:\\ProgramData\\projects.json'
      $contained = Test-CanonicalPathContained ` +
      `-Parent 'E:\\candidate' -Child 'E:\\candidate\\config\\projects.json'
      $prefixSibling = Test-CanonicalPathContained ` +
      `-Parent 'E:\\candidate' -Child 'E:\\candidate-other\\projects.json'
      Write-Output "$crossVolume|$contained|$prefixSibling"
    `);

    expect(output).toBe("False|True|False");
  });

  it("migrates only the bridge entry from current to candidate state", () => {
    const fixture = createRegistryFixture();
    const currentRevision = "a".repeat(40);
    const desiredRevision = "b".repeat(40);
    const registry = {
      schema_version: "1.2",
      projects: [
        {
          key: "balcony-agent-bridge",
          path: fixture.currentRoot,
          enabled: true,
          peer_readable: true,
          evidence: {
            provider: "pinned_git",
            revision: currentRevision,
          },
        },
        {
          key: "agenticseek",
          path: path.join(fixture.root, "agenticseek"),
          enabled: true,
          peer_readable: true,
          evidence: {
            provider: "pinned_git",
            revision: "c".repeat(40),
          },
          policy: { maximum_bytes: 4096 },
        },
      ],
      metadata: { owner: "SYS-B" },
    };
    fs.writeFileSync(fixture.registryPath, JSON.stringify(registry, null, 2));

    const migratedJson = runPowerShell(`
        $ErrorActionPreference = 'Stop'
        Import-Module -Force '${powerShellLiteral(modulePath)}'
        Get-DispatcherRegistryMigrationJson ` +
        `-RegistryJson (Get-Content -Raw -LiteralPath $env:TEST_REGISTRY) ` +
        `-CurrentRepositoryRoot $env:CURRENT_ROOT ` +
        `-CurrentRevision '${currentRevision}' ` +
        `-DesiredRepositoryRoot $env:DESIRED_ROOT ` +
        `-DesiredRevision '${desiredRevision}'
      `, {
        CURRENT_ROOT: fixture.currentRoot,
        DESIRED_ROOT: fixture.desiredRoot,
        TEST_REGISTRY: fixture.registryPath,
      });
    fs.writeFileSync(fixture.desiredPath, migratedJson);
    runPowerShell(`
      $ErrorActionPreference = 'Stop'
      Import-Module -Force '${powerShellLiteral(modulePath)}'
      Set-DispatcherProjectRegistry ` +
      `-Path $env:TEST_REGISTRY ` +
      `-Content (Get-Content -Raw -LiteralPath $env:DESIRED_REGISTRY) ` +
      `-Confirm:$false
    `, {
      DESIRED_REGISTRY: fixture.desiredPath,
      TEST_REGISTRY: fixture.registryPath,
    });
    const migrated = JSON.parse(
      fs.readFileSync(fixture.registryPath, "utf8"),
    ) as typeof registry;

    expect(canonicalWindowsFilesystemIdentity(
      migrated.projects[0]?.path ?? "",
    )).toBe(canonicalWindowsFilesystemIdentity(fixture.desiredRoot));
    expect(migrated.projects[0]?.evidence.revision).toBe(desiredRevision);
    expect(migrated.projects[1]).toEqual(registry.projects[1]);
    expect(migrated.metadata).toEqual(registry.metadata);
  });

  it("treats Windows 8.3 and long paths as the same filesystem identity", () => {
    const shortAlias = "C:\\PROGRA~1";
    expect(fs.existsSync(shortAlias)).toBe(true);
    const longPath = fs.realpathSync.native(shortAlias);
    expect(path.win32.normalize(shortAlias).toLowerCase()).not.toBe(
      path.win32.normalize(longPath).toLowerCase(),
    );

    expect(canonicalWindowsFilesystemIdentity(shortAlias)).toBe(
      canonicalWindowsFilesystemIdentity(longPath),
    );
  });

  it("rejects a registry pin that does not match the current checkout", () => {
    const fixture = createRegistryFixture();
    fs.writeFileSync(fixture.registryPath, JSON.stringify({
      schema_version: "1.2",
      projects: [{
        key: "balcony-agent-bridge",
        path: fixture.currentRoot,
        enabled: true,
        peer_readable: true,
        evidence: {
          provider: "pinned_git",
          revision: "a".repeat(40),
        },
      }],
    }));

    expect(() => runPowerShell(`
      $ErrorActionPreference = 'Stop'
      Import-Module -Force '${powerShellLiteral(modulePath)}'
      Get-DispatcherRegistryMigrationJson ` +
      `-RegistryJson (Get-Content -Raw -LiteralPath $env:TEST_REGISTRY) ` +
      `-CurrentRepositoryRoot $env:CURRENT_ROOT ` +
      `-CurrentRevision '${"d".repeat(40)}' ` +
      `-DesiredRepositoryRoot $env:DESIRED_ROOT ` +
      `-DesiredRevision '${"b".repeat(40)}'
    `, {
      CURRENT_ROOT: fixture.currentRoot,
      DESIRED_ROOT: fixture.desiredRoot,
      TEST_REGISTRY: fixture.registryPath,
    })).toThrow(/does not match the currently deployed checkout/);
  });

  it("does not mutate the registry under WhatIf", () => {
    const fixture = createRegistryFixture();
    const original = '{"schema_version":"1.2","projects":[]}\r\n';
    const desired = '{"schema_version":"1.2","projects":[{"key":"x"}]}';
    fs.writeFileSync(fixture.registryPath, original);
    fs.writeFileSync(fixture.desiredPath, desired);

    runPowerShell(`
      $ErrorActionPreference = 'Stop'
      Import-Module -Force '${powerShellLiteral(modulePath)}'
      Set-DispatcherProjectRegistry ` +
      `-Path $env:TEST_REGISTRY ` +
      `-Content (Get-Content -Raw -LiteralPath $env:DESIRED_REGISTRY) ` +
      `-WhatIf
    `, {
      DESIRED_REGISTRY: fixture.desiredPath,
      TEST_REGISTRY: fixture.registryPath,
    });

    expect(fs.readFileSync(fixture.registryPath, "utf8")).toBe(original);
  });
});

function createRegistryFixture(): {
  currentRoot: string;
  desiredPath: string;
  desiredRoot: string;
  registryPath: string;
  root: string;
} {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "bridge-registry-migration-"));
  temporaryDirectories.push(root);
  const currentRoot = path.join(root, "current");
  const desiredRoot = path.join(root, "candidate");
  fs.mkdirSync(currentRoot);
  fs.mkdirSync(desiredRoot);
  return {
    currentRoot,
    desiredPath: path.join(root, "desired.json"),
    desiredRoot,
    registryPath: path.join(root, "projects.json"),
    root,
  };
}

function runPowerShell(
  command: string,
  environment: Record<string, string> = {},
): string {
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
  return result.stdout.trim();
}

function powerShellLiteral(value: string): string {
  return value.replaceAll("'", "''");
}

function canonicalWindowsFilesystemIdentity(value: string): string {
  return path.win32
    .normalize(fs.realpathSync.native(value))
    .toLowerCase();
}
