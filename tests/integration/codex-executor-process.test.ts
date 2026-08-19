import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  LocalCodexExecutor,
  createChildEnvironment,
} from "../../src/dispatcher/codex-executor.js";

describe("LocalCodexExecutor process boundary", () => {
  let temporaryDirectory: string;
  let projectDirectory: string;
  let codexHome: string;
  let codeModeHost: string;

  beforeEach(() => {
    temporaryDirectory = fs.mkdtempSync(
      path.join(os.tmpdir(), "balcony-codex-executor-"),
    );
    projectDirectory = path.join(temporaryDirectory, "project");
    codexHome = path.join(temporaryDirectory, "codex-home");
    fs.mkdirSync(projectDirectory);
    fs.mkdirSync(codexHome);
    codeModeHost = path.join(
      temporaryDirectory,
      "codex-code-mode-host.exe",
    );
    fs.writeFileSync(codeModeHost, "pinned code mode host", "utf8");
  });

  afterEach(() => {
    fs.rmSync(temporaryDirectory, { recursive: true, force: true });
  });

  it("uses fixed read-only arguments, stdin prompts, and a minimal environment", async () => {
    const executable = writePowerShellFixture(
      temporaryDirectory,
      "inspect.ps1",
      [
        "$prompt = $input | Out-String",
        "$result = @{",
        "  arguments = @($args)",
        "  prompt = $prompt",
        "  codexHome = $env:CODEX_HOME",
        "  bridgeNamespace = $env:BALCONY_SERVICEBUS_NAMESPACE",
        "  azureSecret = $env:AZURE_CLIENT_SECRET",
        "}",
        "$result | ConvertTo-Json -Compress",
      ],
    );
    const executor = new LocalCodexExecutor(
      executable,
      codexHome,
      fileHash(executable),
      codeModeHost,
      fileHash(codeModeHost),
      trustedPath(),
      {
        ...process.env,
        BALCONY_SERVICEBUS_NAMESPACE:
          "private.servicebus.windows.net",
        AZURE_CLIENT_SECRET: "must-not-cross",
      },
    );
    const prompt =
      "Inspect only; literal metacharacters: & | > < ` $() and \"quotes\".";

    const result = await executor.execute({
      projectPath: projectDirectory,
      prompt,
      timeoutSeconds: 30,
      maxOutputBytes: 20_000,
    });
    const output = JSON.parse(result.output) as {
      arguments: string[];
      prompt: string;
      codexHome: string;
      bridgeNamespace?: string;
      azureSecret?: string;
    };

    expect(output.arguments).toEqual(
      expect.arrayContaining([
        "--ask-for-approval",
        "never",
        "exec",
        "--ephemeral",
        "--ignore-user-config",
        "--strict-config",
        "--sandbox",
        "read-only",
        "--color",
        "never",
        "--cd",
        fs.realpathSync.native(projectDirectory),
        "-",
      ]),
    );
    expect(output.arguments).not.toContain(
      "--dangerously-bypass-approvals-and-sandbox",
    );
    expect(output.arguments).not.toContain("--add-dir");
    expect(output.prompt.trimEnd()).toBe(prompt);
    expect(output.codexHome).toBe(fs.realpathSync.native(codexHome));
    expect(output.bridgeNamespace).toBeFalsy();
    expect(output.azureSecret).toBeFalsy();
  });

  it("disables local file-reading tools for evidence-only execution", async () => {
    const executable = writePowerShellFixture(
      temporaryDirectory,
      "evidence-only.ps1",
      [
        "$prompt = $input | Out-String",
        "@{ arguments = @($args); prompt = $prompt } | ConvertTo-Json -Compress",
      ],
    );
    const executor = new LocalCodexExecutor(
      executable,
      codexHome,
      fileHash(executable),
      codeModeHost,
      fileHash(codeModeHost),
      trustedPath(),
      process.env,
    );

    const result = await executor.execute({
      projectPath: projectDirectory,
      executionBoundary: "evidence_only",
      prompt: "Use only the supplied evidence.",
      timeoutSeconds: 30,
      maxOutputBytes: 20_000,
    });
    const output = JSON.parse(result.output) as {
      arguments: string[];
      prompt: string;
    };

    expect(output.arguments).toEqual(
      expect.arrayContaining([
        "--skip-git-repo-check",
        "--disable",
        "shell_tool",
        "--disable",
        "unified_exec",
        "--disable",
        "view_image",
      ]),
    );
    expect(output.arguments).not.toContain("--add-dir");
    expect(output.prompt.trimEnd()).toBe(
      "Use only the supplied evidence.",
    );
  });

  it("terminates a worker that exceeds its timeout", async () => {
    const executable = writePowerShellFixture(
      temporaryDirectory,
      "hang.ps1",
      [
        "$input | Out-Null",
        "Start-Sleep -Seconds 30",
        "Write-Output 'late output'",
      ],
    );
    const executor = new LocalCodexExecutor(
      executable,
      codexHome,
      fileHash(executable),
      codeModeHost,
      fileHash(codeModeHost),
      trustedPath(),
      process.env,
    );

    await expect(
      executor.execute({
        projectPath: projectDirectory,
        prompt: "Wait forever.",
        timeoutSeconds: 0.2,
        maxOutputBytes: 20_000,
      }),
    ).rejects.toMatchObject({
      code: "CODEX_TIMED_OUT",
    });
  });

  it("terminates a worker when the dispatcher is shutting down", async () => {
    const marker = path.join(temporaryDirectory, "orphan-marker.txt");
    const childScript = writePowerShellFixture(
      temporaryDirectory,
      "abort-child.ps1",
      [
        "Start-Sleep -Seconds 2",
        `Set-Content -LiteralPath ${powerShellLiteral(marker)} -Value 'orphaned'`,
      ],
    );
    const executable = writePowerShellFixture(
      temporaryDirectory,
      "abort.ps1",
      [
        "$input | Out-Null",
        [
          "Start-Process",
          `-FilePath ${powerShellLiteral(path.join(process.env["SystemRoot"] ?? "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe"))}`,
          `-ArgumentList @('-NoProfile', '-NonInteractive', '-File', ${powerShellLiteral(childScript)})`,
          "-WindowStyle Hidden",
        ].join(" "),
        "Start-Sleep -Seconds 30",
        "Write-Output 'late output'",
      ],
    );
    const executor = new LocalCodexExecutor(
      executable,
      codexHome,
      fileHash(executable),
      codeModeHost,
      fileHash(codeModeHost),
      trustedPath(),
      process.env,
    );
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 100);

    await expect(
      executor.execute({
        projectPath: projectDirectory,
        prompt: "Wait until cancelled.",
        timeoutSeconds: 30,
        maxOutputBytes: 20_000,
        abortSignal: controller.signal,
      }),
    ).rejects.toMatchObject({
      code: "CODEX_ABORTED",
    });
    await new Promise((resolve) => setTimeout(resolve, 2500));
    expect(fs.existsSync(marker)).toBe(false);
  });

  it("terminates a worker whose output exceeds the configured bound", async () => {
    const executable = writePowerShellFixture(
      temporaryDirectory,
      "large-output.ps1",
      [
        "$input | Out-Null",
        "Write-Output ('x' * 5000)",
      ],
    );
    const executor = new LocalCodexExecutor(
      executable,
      codexHome,
      fileHash(executable),
      codeModeHost,
      fileHash(codeModeHost),
      trustedPath(),
      process.env,
    );

    await expect(
      executor.execute({
        projectPath: projectDirectory,
        prompt: "Return too much output.",
        timeoutSeconds: 30,
        maxOutputBytes: 1024,
      }),
    ).rejects.toMatchObject({
      code: "CODEX_OUTPUT_INVALID",
    });
  });

  it("never copies arbitrary parent environment variables", () => {
    const environment = createChildEnvironment(
      {
        PATH: "approved-path",
        SystemRoot: "C:\\Windows",
        RANDOM_PRIVATE_VALUE: "must-not-cross",
        BALCONY_AZURE_CLIENT_ID: "must-not-cross",
      },
      codexHome,
      "C:\\trusted-node",
    );

    expect(environment).toMatchObject({
      PATH: "C:\\trusted-node",
      PATHEXT: ".COM;.EXE;.BAT;.CMD",
      SystemRoot: "C:\\Windows",
      CODEX_HOME: codexHome,
      NO_COLOR: "1",
    });
    expect(environment).not.toHaveProperty("RANDOM_PRIVATE_VALUE");
    expect(environment).not.toHaveProperty("BALCONY_AZURE_CLIENT_ID");
  });

  it("rejects an executable that does not match the approved hash", () => {
    const executable = writePowerShellFixture(
      temporaryDirectory,
      "hash-mismatch.ps1",
      ["Write-Output 'should not run'"],
    );

    expect(
      () =>
        new LocalCodexExecutor(
          executable,
          codexHome,
          "0".repeat(64),
          codeModeHost,
          fileHash(codeModeHost),
          trustedPath(),
          process.env,
        ),
    ).toThrow(/approved SHA-256/);
  });

  it("rejects a missing Codex code-mode host", () => {
    const executable = writePowerShellFixture(
      temporaryDirectory,
      "missing-companion.ps1",
      ["Write-Output 'should not run'"],
    );

    expect(
      () =>
        new LocalCodexExecutor(
          executable,
          codexHome,
          fileHash(executable),
          path.join(temporaryDirectory, "missing-host.exe"),
          "0".repeat(64),
          trustedPath(),
          process.env,
        ),
    ).toThrow(/Codex code-mode host.*accessible file/);
  });

  it("rejects a Codex code-mode host with the wrong approved hash", () => {
    const executable = writePowerShellFixture(
      temporaryDirectory,
      "companion-hash.ps1",
      ["Write-Output 'should not run'"],
    );

    expect(
      () =>
        new LocalCodexExecutor(
          executable,
          codexHome,
          fileHash(executable),
          codeModeHost,
          "0".repeat(64),
          trustedPath(),
          process.env,
        ),
    ).toThrow(/code-mode host.*approved SHA-256/);
  });

  it("requires the Codex executable and companion to be sibling files", () => {
    const nested = path.join(temporaryDirectory, "nested");
    fs.mkdirSync(nested);
    const executable = writePowerShellFixture(
      nested,
      "sibling-boundary.ps1",
      ["Write-Output 'should not run'"],
    );

    expect(
      () =>
        new LocalCodexExecutor(
          executable,
          codexHome,
          fileHash(executable),
          codeModeHost,
          fileHash(codeModeHost),
          trustedPath(),
          process.env,
        ),
    ).toThrow(/same directory/);
  });
});

function writePowerShellFixture(
  directory: string,
  name: string,
  lines: string[],
): string {
  const file = path.join(directory, name);
  fs.writeFileSync(file, `${lines.join("\r\n")}\r\n`, "utf8");
  return file;
}

function fileHash(file: string): string {
  return createHash("sha256")
    .update(fs.readFileSync(file))
    .digest("hex");
}

function trustedPath(): string {
  return process.env["PATH"] ?? process.env["Path"] ?? "";
}

function powerShellLiteral(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}
