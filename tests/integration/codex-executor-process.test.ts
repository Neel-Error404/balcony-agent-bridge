import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
} from "vitest";

import {
  LocalCodexExecutor,
  createChildEnvironment,
} from "../../src/dispatcher/codex-executor.js";

describe("LocalCodexExecutor process boundary", () => {
  let fixtureBuildDirectory: string;
  let fixtureTemplate: string;
  let temporaryDirectory: string;
  let projectDirectory: string;
  let codexHome: string;
  let codeModeHost: string;

  beforeAll(() => {
    fixtureBuildDirectory = fs.mkdtempSync(
      path.join(os.tmpdir(), "balcony-native-fixture-"),
    );
    fixtureTemplate = compileNativeFixture(fixtureBuildDirectory);
  }, 30_000);

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
    fs.rmSync(temporaryDirectory, {
      recursive: true,
      force: true,
      maxRetries: 10,
      retryDelay: 200,
    });
  }, 30_000);

  afterAll(() => {
    fs.rmSync(fixtureBuildDirectory, {
      recursive: true,
      force: true,
      maxRetries: 10,
      retryDelay: 200,
    });
  }, 30_000);

  it("uses fixed read-only arguments, stdin prompts, and a minimal environment", async () => {
    const executable = writeNativeFixture(
      fixtureTemplate,
      temporaryDirectory,
      "inspect",
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
    const executable = writeNativeFixture(
      fixtureTemplate,
      temporaryDirectory,
      "evidence-only",
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
    const executable = writeNativeFixture(
      fixtureTemplate,
      temporaryDirectory,
      "hang",
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
    const executable = writeNativeFixture(
      fixtureTemplate,
      temporaryDirectory,
      "abort",
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
  }, 10_000);

  it("terminates a worker whose output exceeds the configured bound", async () => {
    const executable = writeNativeFixture(
      fixtureTemplate,
      temporaryDirectory,
      "large-output",
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
    const executable = writeNativeFixture(
      fixtureTemplate,
      temporaryDirectory,
      "inspect",
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
    const executable = writeNativeFixture(
      fixtureTemplate,
      temporaryDirectory,
      "inspect",
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
    const executable = writeNativeFixture(
      fixtureTemplate,
      temporaryDirectory,
      "inspect",
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
    const executable = writeNativeFixture(
      fixtureTemplate,
      nested,
      "inspect",
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

function writeNativeFixture(
  template: string,
  directory: string,
  mode: string,
): string {
  const file = path.join(directory, "codex.exe");
  fs.copyFileSync(template, file);
  fs.writeFileSync(
    path.join(directory, "codex-fixture-mode.txt"),
    mode,
    "utf8",
  );
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

function compileNativeFixture(directory: string): string {
  if (process.platform !== "win32") {
    throw new Error("The native Codex process fixture requires Windows.");
  }
  const source = path.join(directory, "codex-fixture.cs");
  const output = path.join(directory, "codex-fixture.exe");
  fs.writeFileSync(
    source,
    [
      "using System;",
      "using System.Diagnostics;",
      "using System.IO;",
      "using System.Text;",
      "using System.Threading;",
      "public static class Program {",
      "  private static string Json(string value) {",
      "    if (value == null) return \"null\";",
      "    var result = new StringBuilder(\"\\\"\");",
      "    foreach (char character in value) {",
      "      switch (character) {",
      "        case '\\\\': result.Append(\"\\\\\\\\\"); break;",
      "        case '\\\"': result.Append(\"\\\\\\\"\"); break;",
      "        case '\\r': result.Append(\"\\\\r\"); break;",
      "        case '\\n': result.Append(\"\\\\n\"); break;",
      "        case '\\t': result.Append(\"\\\\t\"); break;",
      "        default:",
      "          if (character < 0x20) result.AppendFormat(\"\\\\u{0:x4}\", (int)character);",
      "          else result.Append(character);",
      "          break;",
      "      }",
      "    }",
      "    return result.Append('\\\"').ToString();",
      "  }",
      "  private static string JsonArray(string[] values) {",
      "    var result = new StringBuilder(\"[\");",
      "    for (int index = 0; index < values.Length; index++) {",
      "      if (index > 0) result.Append(',');",
      "      result.Append(Json(values[index]));",
      "    }",
      "    return result.Append(']').ToString();",
      "  }",
      "  private static string Argument(string[] args, string name) {",
      "    for (int index = 0; index + 1 < args.Length; index++) {",
      "      if (args[index] == name) return args[index + 1];",
      "    }",
      "    throw new InvalidOperationException(\"Missing fixture argument: \" + name);",
      "  }",
      "  public static int Main(string[] args) {",
      "    if (args.Length > 1 && args[0] == \"--fixture-abort-child\") {",
      "      Thread.Sleep(2000);",
      "      File.WriteAllText(args[1], \"orphaned\");",
      "      return 0;",
      "    }",
      "    var mode = File.ReadAllText(Path.Combine(AppDomain.CurrentDomain.BaseDirectory, \"codex-fixture-mode.txt\")).Trim();",
      "    var prompt = Console.In.ReadToEnd();",
      "    if (mode == \"hang\") {",
      "      Thread.Sleep(30000);",
      "      Console.Write(\"late output\");",
      "      return 0;",
      "    }",
      "    if (mode == \"abort\") {",
      "      var project = Argument(args, \"--cd\");",
      "      var marker = Path.Combine(Directory.GetParent(project).FullName, \"orphan-marker.txt\");",
      "      var child = Path.Combine(AppDomain.CurrentDomain.BaseDirectory, \"codex.exe\");",
      "      Process.Start(new ProcessStartInfo {",
      "        FileName = child,",
      "        Arguments = \"--fixture-abort-child \\\"\" + marker.Replace(\"\\\"\", \"\\\\\\\"\") + \"\\\"\",",
      "        UseShellExecute = false,",
      "        CreateNoWindow = true",
      "      });",
      "      Thread.Sleep(30000);",
      "      Console.Write(\"late output\");",
      "      return 0;",
      "    }",
      "    if (mode == \"large-output\") {",
      "      Console.Write(new string('x', 5000));",
      "      return 0;",
      "    }",
      "    Console.Write(\"{\\\"arguments\\\":\" + JsonArray(args)",
      "      + \",\\\"prompt\\\":\" + Json(prompt)",
      "      + \",\\\"codexHome\\\":\" + Json(Environment.GetEnvironmentVariable(\"CODEX_HOME\"))",
      "      + \",\\\"bridgeNamespace\\\":\" + Json(Environment.GetEnvironmentVariable(\"BALCONY_SERVICEBUS_NAMESPACE\"))",
      "      + \",\\\"azureSecret\\\":\" + Json(Environment.GetEnvironmentVariable(\"AZURE_CLIENT_SECRET\")) + \"}\");",
      "    return 0;",
      "  }",
      "}",
    ].join("\r\n"),
    "utf8",
  );
  const compiler = path.join(
    process.env["WINDIR"] ?? "C:\\Windows",
    "Microsoft.NET",
    "Framework64",
    "v4.0.30319",
    "csc.exe",
  );
  const result = spawnSync(
    compiler,
    ["/nologo", "/target:exe", `/out:${output}`, source],
    { encoding: "utf8", timeout: 30_000, windowsHide: true },
  );
  if (result.error || result.status !== 0) {
    throw new Error(
      `Unable to build the native Codex fixture: ${result.error?.message ?? result.stderr}`,
    );
  }
  return output;
}
