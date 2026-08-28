import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from "node:child_process";

import { CodexExecutionError, DispatchConfigurationError } from "../errors.js";
import { sanitizeErrorMessage } from "../security/sanitize-error.js";

export interface CodexExecutionInput {
  projectPath: string;
  executionBoundary?: "project_read_only" | "evidence_only";
  prompt: string;
  timeoutSeconds: number;
  maxOutputBytes: number;
  abortSignal?: AbortSignal;
}

export interface CodexExecutionResult {
  output: string;
}

export interface CodexExecutor {
  execute(input: CodexExecutionInput): Promise<CodexExecutionResult>;
}

export class LocalCodexExecutor implements CodexExecutor {
  private readonly executable: string;
  private readonly codexHome: string;
  private readonly powerShell:
    | { executable: string; sha256: string }
    | undefined;

  public constructor(
    executable: string,
    codexHome: string,
    expectedExecutableSha256: string,
    codeModeHostExecutable: string,
    expectedCodeModeHostSha256: string,
    private readonly trustedPath: string,
    private readonly sourceEnvironment: NodeJS.ProcessEnv = process.env,
  ) {
    this.executable = requireFile(executable, "Codex executable");
    this.powerShell =
      process.platform === "win32" &&
      path.extname(this.executable).toLowerCase() === ".ps1"
        ? resolvePowerShell7(sourceEnvironment)
        : undefined;
    const codeModeHost = requireFile(
      codeModeHostExecutable,
      "Codex code-mode host",
    );
    if (
      path.basename(codeModeHost).toLowerCase() !==
      "codex-code-mode-host.exe"
    ) {
      throw new DispatchConfigurationError(
        "The Codex code-mode host must use the expected companion filename.",
      );
    }
    const executableDirectory = path.dirname(
      fs.realpathSync.native(this.executable),
    );
    const codeModeHostDirectory = path.dirname(
      fs.realpathSync.native(codeModeHost),
    );
    if (
      executableDirectory.toLowerCase() !==
      codeModeHostDirectory.toLowerCase()
    ) {
      throw new DispatchConfigurationError(
        "The Codex executable and code-mode host must be in the same directory.",
      );
    }
    this.codexHome = requireDirectory(codexHome, "dispatcher CODEX_HOME");
    verifyFileHash(
      this.executable,
      expectedExecutableSha256,
      "Codex executable",
    );
    verifyFileHash(
      codeModeHost,
      expectedCodeModeHostSha256,
      "Codex code-mode host",
    );
  }

  public async execute(
    input: CodexExecutionInput,
  ): Promise<CodexExecutionResult> {
    if (input.abortSignal?.aborted) {
      throw new CodexExecutionError(
        "CODEX_ABORTED",
        "The read-only Codex worker was cancelled before launch.",
      );
    }
    const projectPath = requireDirectory(
      input.projectPath,
      "dispatcher project",
    );
    const evidenceOnlyArguments =
      input.executionBoundary === "evidence_only"
        ? [
            "--skip-git-repo-check",
            "--disable",
            "shell_tool",
            "--disable",
            "unified_exec",
            "--disable",
            "view_image",
          ]
        : [];
    const invocation = createInvocation(
      this.executable,
      [
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
        ...evidenceOnlyArguments,
        "--cd",
        projectPath,
        "-",
      ],
      this.powerShell,
    );

    return new Promise<CodexExecutionResult>((resolve, reject) => {
      let child: ChildProcessWithoutNullStreams;
      try {
        child = spawn(invocation.command, invocation.args, {
          cwd: projectPath,
          env: createChildEnvironment(
            this.sourceEnvironment,
            this.codexHome,
            this.trustedPath,
          ),
          shell: false,
          windowsHide: true,
          stdio: ["pipe", "pipe", "pipe"],
        });
      } catch (error) {
        reject(
          new CodexExecutionError(
            "CODEX_LAUNCH_FAILED",
            "The dispatcher could not launch the Codex CLI.",
            { cause: error },
          ),
        );
        return;
      }

      const stdout: Buffer[] = [];
      const stderr: Buffer[] = [];
      let stdoutBytes = 0;
      let stderrBytes = 0;
      let settled = false;
      let outputExceeded = false;
      let timeout: ReturnType<typeof setTimeout> | undefined;
      let terminationWatchdog:
        | ReturnType<typeof setTimeout>
        | undefined;
      let termination:
        | {
            code:
              | "CODEX_ABORTED"
              | "CODEX_TIMED_OUT"
              | "CODEX_OUTPUT_INVALID";
            message: string;
            verified: boolean;
          }
        | undefined;

      const finish = (
        operation: () => void,
      ): void => {
        if (settled) {
          return;
        }
        settled = true;
        if (timeout) {
          clearTimeout(timeout);
        }
        if (terminationWatchdog) {
          clearTimeout(terminationWatchdog);
        }
        input.abortSignal?.removeEventListener("abort", abortListener);
        operation();
      };

      const requestTermination = (
        code:
          | "CODEX_ABORTED"
          | "CODEX_TIMED_OUT"
          | "CODEX_OUTPUT_INVALID",
        message: string,
      ): void => {
        if (settled || termination) {
          return;
        }
        termination = {
          code,
          message,
          verified: terminateProcessTree(child),
        };
        terminationWatchdog = setTimeout(() => {
          if (!settled) {
            child.kill("SIGKILL");
          }
        }, 5000);
      };

      const abortListener = (): void => {
        requestTermination(
          "CODEX_ABORTED",
          "The read-only Codex worker was cancelled before completion.",
        );
      };
      input.abortSignal?.addEventListener("abort", abortListener, {
        once: true,
      });
      if (input.abortSignal?.aborted) {
        abortListener();
        return;
      }

      timeout = setTimeout(() => {
        requestTermination(
          "CODEX_TIMED_OUT",
          "The read-only Codex worker exceeded its execution timeout.",
        );
      }, input.timeoutSeconds * 1000);

      child.stdout.on("data", (chunk: Buffer) => {
        if (settled || outputExceeded) {
          return;
        }
        stdoutBytes += chunk.byteLength;
        if (stdoutBytes > input.maxOutputBytes) {
          outputExceeded = true;
          requestTermination(
            "CODEX_OUTPUT_INVALID",
            "The read-only Codex worker exceeded its output limit.",
          );
          return;
        }
        stdout.push(chunk);
      });

      child.stderr.on("data", (chunk: Buffer) => {
        if (stderrBytes >= 8192) {
          return;
        }
        const remaining = 8192 - stderrBytes;
        const bounded = chunk.subarray(0, remaining);
        stderr.push(bounded);
        stderrBytes += bounded.byteLength;
      });
      child.once("error", (error) => {
        finish(() =>
          reject(
            new CodexExecutionError(
              "CODEX_LAUNCH_FAILED",
              "The dispatcher could not start the Codex CLI process.",
              { cause: error },
            ),
          ),
        );
      });
      child.once("close", (exitCode, signal) => {
        finish(() => {
          if (termination) {
            const verified =
              termination.verified ||
              (termination.code === "CODEX_OUTPUT_INVALID" &&
                exitCode === 0 &&
                signal === null);
            reject(
              new CodexExecutionError(
                verified
                  ? termination.code
                  : "CODEX_TERMINATION_FAILED",
                verified
                  ? termination.message
                  : "The dispatcher could not verify termination of the Codex process tree.",
              ),
            );
            return;
          }
          if (exitCode !== 0) {
            const diagnostic = sanitizeErrorMessage(
              Buffer.concat(stderr).toString("utf8").trim(),
              500,
            );
            reject(
              new CodexExecutionError(
                "CODEX_EXIT_FAILED",
                signal
                  ? "The read-only Codex worker was terminated before completion."
                  : [
                      `The read-only Codex worker exited with code ${exitCode ?? "unknown"}.`,
                      diagnostic
                        ? `Diagnostic: ${diagnostic}`
                        : "",
                    ]
                      .filter(Boolean)
                      .join(" "),
              ),
            );
            return;
          }

          const output = Buffer.concat(stdout).toString("utf8").trim();
          if (!output) {
            reject(
              new CodexExecutionError(
                "CODEX_OUTPUT_INVALID",
                "The read-only Codex worker returned no final response.",
              ),
            );
            return;
          }
          resolve({ output });
        });
      });

      child.stdin.once("error", () => {
        requestTermination(
          "CODEX_ABORTED",
          "The read-only Codex worker input stream failed.",
        );
      });
      child.stdin.end(input.prompt, "utf8");
    });
  }
}

export function createChildEnvironment(
  source: NodeJS.ProcessEnv,
  codexHome: string,
  trustedPath: string,
): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {
    CODEX_HOME: codexHome,
    NO_COLOR: "1",
    PATH: trustedPath,
    PATHEXT: source["PATHEXT"] ?? ".COM;.EXE;.BAT;.CMD",
  };
  for (const key of [
    "SystemRoot",
    "WINDIR",
    "COMSPEC",
    "TEMP",
    "TMP",
  ]) {
    const value = source[key];
    if (value) {
      environment[key] = value;
    }
  }
  return environment;
}

function verifyFileHash(
  file: string,
  expectedSha256: string,
  label: string,
): void {
  const normalizedExpected = expectedSha256.trim().toLowerCase();
  if (!/^[a-f0-9]{64}$/u.test(normalizedExpected)) {
    throw new DispatchConfigurationError(
      `The configured ${label} SHA-256 is invalid.`,
    );
  }
  const actual = fileSha256(file);
  if (actual !== normalizedExpected) {
    throw new DispatchConfigurationError(
      `The configured ${label} did not match its approved SHA-256.`,
    );
  }
}

function createInvocation(
  executable: string,
  codexArguments: readonly string[],
  powerShell?: { executable: string; sha256: string },
): { command: string; args: string[] } {
  if (
    process.platform === "win32" &&
    path.extname(executable).toLowerCase() === ".ps1"
  ) {
    if (!powerShell) {
      throw new DispatchConfigurationError(
        "PowerShell 7 is required to launch a Codex PowerShell wrapper.",
      );
    }
    verifyFileHash(
      powerShell.executable,
      powerShell.sha256,
      "PowerShell 7 executable",
    );
    const script = [
      "$ErrorActionPreference = 'Stop'",
      `$arguments = @(${codexArguments
        .map((argument) => powerShellLiteral(argument))
        .join(", ")})`,
      `& ${powerShellLiteral(executable)} @arguments`,
      "exit $LASTEXITCODE",
    ].join("\n");
    return {
      command: powerShell.executable,
      args: [
        "-NoLogo",
        "-NoProfile",
        "-NonInteractive",
        "-ExecutionPolicy",
        "Bypass",
        "-EncodedCommand",
        Buffer.from(script, "utf16le").toString("base64"),
      ],
    };
  }
  if (
    process.platform === "win32" &&
    [".cmd", ".bat"].includes(path.extname(executable).toLowerCase())
  ) {
    throw new DispatchConfigurationError(
      "Use the Codex PowerShell wrapper or a native executable; batch wrappers are not supported.",
    );
  }
  return {
    command: executable,
    args: [...codexArguments],
  };
}

function resolvePowerShell7(
  source: NodeJS.ProcessEnv,
): { executable: string; sha256: string } {
  const systemRoot = source["SystemRoot"] ?? source["WINDIR"] ?? "C:\\Windows";
  const whereExecutable = path.join(systemRoot, "System32", "where.exe");
  const lookup = spawnSync(whereExecutable, ["pwsh.exe"], {
    encoding: "utf8",
    env: source,
    timeout: 5000,
    windowsHide: true,
  });
  const candidate = lookup.status === 0
    ? lookup.stdout.split(/\r?\n/u).map((entry) => entry.trim()).find(Boolean)
    : undefined;
  if (!candidate) {
    throw new DispatchConfigurationError(
      "PowerShell 7 is required to launch a Codex PowerShell wrapper.",
    );
  }
  let resolved: string;
  try {
    const metadata = fs.lstatSync(candidate);
    if (!metadata.isFile() || metadata.isSymbolicLink()) {
      throw new Error("not a regular file");
    }
    resolved = fs.realpathSync.native(candidate);
  } catch (error) {
    throw new DispatchConfigurationError(
      "PowerShell 7 must resolve to a regular, non-reparse executable.",
      { cause: error },
    );
  }
  const hashBeforeSignature = fileSha256(resolved);
  const systemPowerShell = path.join(
    systemRoot,
    "System32",
    "WindowsPowerShell",
    "v1.0",
    "powershell.exe",
  );
  const signatureScript = [
    `$signature = Get-AuthenticodeSignature -LiteralPath ${powerShellLiteral(resolved)}`,
    "$subject = if ($signature.SignerCertificate) { $signature.SignerCertificate.Subject } else { '' }",
    "@{ status = [string]$signature.Status; subject = [string]$subject } | ConvertTo-Json -Compress",
  ].join("\n");
  const signature = spawnSync(
    systemPowerShell,
    [
      "-NoLogo",
      "-NoProfile",
      "-NonInteractive",
      "-ExecutionPolicy",
      "Bypass",
      "-EncodedCommand",
      Buffer.from(signatureScript, "utf16le").toString("base64"),
    ],
    {
      encoding: "utf8",
      env: {
        PATH: path.dirname(systemPowerShell),
        PATHEXT: source["PATHEXT"] ?? ".COM;.EXE;.BAT;.CMD",
        SystemRoot: systemRoot,
        WINDIR: source["WINDIR"] ?? systemRoot,
      },
      timeout: 5000,
      windowsHide: true,
    },
  );
  let signatureResult: { status?: unknown; subject?: unknown } = {};
  try {
    signatureResult = JSON.parse(signature.stdout.trim()) as {
      status?: unknown;
      subject?: unknown;
    };
  } catch {
    // The stable error below deliberately avoids exposing tool output or paths.
  }
  const hashAfterSignature = fileSha256(resolved);
  if (
    signature.error ||
    signature.status !== 0 ||
    signatureResult.status !== "Valid" ||
    typeof signatureResult.subject !== "string" ||
    !/(?:^|,\s*)O=Microsoft Corporation(?:,|$)/u.test(signatureResult.subject) ||
    hashBeforeSignature !== hashAfterSignature
  ) {
    throw new DispatchConfigurationError(
      "A valid Microsoft-signed PowerShell 7 executable is required to launch a Codex PowerShell wrapper.",
    );
  }
  const probeEnvironment: NodeJS.ProcessEnv = {
    PATH: path.dirname(resolved),
    PATHEXT: source["PATHEXT"] ?? ".COM;.EXE;.BAT;.CMD",
    SystemRoot: systemRoot,
    WINDIR: source["WINDIR"] ?? systemRoot,
  };
  for (const key of ["TEMP", "TMP"]) {
    if (source[key]) probeEnvironment[key] = source[key];
  }
  const version = spawnSync(
    resolved,
    [
      "-NoLogo",
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      "$PSVersionTable.PSVersion.Major",
    ],
    {
      encoding: "utf8",
      env: probeEnvironment,
      timeout: 5000,
      windowsHide: true,
    },
  );
  const versionText = version.stdout.trim();
  const major = /^\d+$/u.test(versionText)
    ? Number.parseInt(versionText, 10)
    : Number.NaN;
  if (version.error || version.status !== 0 || !Number.isInteger(major) || major < 7) {
    throw new DispatchConfigurationError(
      "PowerShell 7 is required to launch a Codex PowerShell wrapper.",
    );
  }
  return { executable: resolved, sha256: hashAfterSignature };
}

function fileSha256(file: string): string {
  return createHash("sha256")
    .update(fs.readFileSync(file))
    .digest("hex");
}

function powerShellLiteral(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

function terminateProcessTree(
  child: ChildProcessWithoutNullStreams,
): boolean {
  if (!child.pid) {
    return child.kill("SIGKILL");
  }
  if (process.platform === "win32") {
    const result = spawnSync(
      path.join(
        process.env["SystemRoot"] ?? "C:\\Windows",
        "System32",
        "taskkill.exe",
      ),
      ["/PID", String(child.pid), "/T", "/F"],
      {
        windowsHide: true,
        stdio: "ignore",
      },
    );
    if (result.status === 0) {
      return true;
    }
    child.kill("SIGKILL");
    return false;
  }
  return child.kill("SIGKILL");
}

function requireFile(value: string, label: string): string {
  const resolved = path.resolve(value);
  try {
    if (!fs.statSync(resolved).isFile()) {
      throw new Error("not a file");
    }
  } catch (error) {
    throw new DispatchConfigurationError(
      `${label} does not resolve to an accessible file.`,
      { cause: error },
    );
  }
  return resolved;
}

function requireDirectory(value: string, label: string): string {
  const resolved = path.resolve(value);
  try {
    if (!fs.statSync(resolved).isDirectory()) {
      throw new Error("not a directory");
    }
  } catch (error) {
    throw new DispatchConfigurationError(
      `${label} does not resolve to an accessible directory.`,
      { cause: error },
    );
  }
  return fs.realpathSync.native(resolved);
}
