import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

export type PreflightStatus = "PASS" | "FAIL" | "WARN";

export type PreflightCommandId =
  | "node"
  | "npm"
  | "powershell"
  | "git"
  | "codex";

export interface PreflightCommandProbe {
  available: boolean;
  version?: string;
  globalPrefix?: string;
}

export interface PreflightCheck {
  id: string;
  required: boolean;
  status: PreflightStatus;
  observed: string;
  remediation: string;
}

export interface PreflightReport {
  ok: boolean;
  checks: readonly PreflightCheck[];
}

export interface PreflightOptions {
  pilotRoot: string;
  packageRoot?: string;
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  now?: () => Date;
  probeCommand?: (command: PreflightCommandId) => PreflightCommandProbe;
}

const MIN_NODE_MAJOR = 22;
const MIN_NPM_MAJOR = 10;
const MIN_POWERSHELL_MAJOR = 7;
const CLOCK_MIN_MS = Date.UTC(2020, 0, 1);
const CLOCK_MAX_MS = Date.UTC(2100, 0, 1);

export function runPreflight(options: PreflightOptions): PreflightReport {
  const platform = options.platform ?? process.platform;
  const env = options.env ?? process.env;
  const packageRoot = options.packageRoot ?? defaultPackageRoot();
  assertAbsoluteDirectoryInput(options.pilotRoot, "pilotRoot");
  assertAbsoluteDirectoryInput(packageRoot, "packageRoot");

  const probeCommand = options.probeCommand ?? defaultCommandProbe(platform);
  const checks: PreflightCheck[] = [];
  const commandResults = new Map<PreflightCommandId, PreflightCommandProbe>();

  for (const command of ["node", "npm", "powershell", "git", "codex"] as const) {
    commandResults.set(command, safeProbe(probeCommand, command));
  }

  checks.push(versionCheck(
    "node_version",
    commandResults.get("node")!,
    MIN_NODE_MAJOR,
    "Node.js 22 or newer is required. Install or select Node.js 22+ and rerun the preflight.",
  ));
  checks.push(versionCheck(
    "npm_version",
    commandResults.get("npm")!,
    MIN_NPM_MAJOR,
    "npm 10 or newer is required. Upgrade npm in the selected Node.js installation and rerun the preflight.",
  ));
  checks.push(versionCheck(
    "powershell_version",
    commandResults.get("powershell")!,
    MIN_POWERSHELL_MAJOR,
    "PowerShell 7 is required for the blind pilot commands. Install PowerShell 7 and ensure pwsh is on PATH.",
  ));
  checks.push(commandPresenceCheck(
    "git",
    commandResults.get("git")!,
    true,
    "Install Git and ensure the git executable is available on PATH.",
  ));
  checks.push(commandPresenceCheck(
    "codex",
    commandResults.get("codex")!,
    true,
    "Install Codex or make the codex executable available on PATH before the MCP pilot.",
  ));
  checks.push(npmGlobalBinCheck(
    commandResults.get("npm")!,
    platform,
    env,
  ));
  checks.push(clockCheck(options.now ?? (() => new Date())));
  checks.push(writableRootCheck(options.pilotRoot));
  checks.push(artifactCheck(
    "bridge_artifact",
    path.join(packageRoot, "dist", "bridge", "index.js"),
    "Build or install the package so the bridge foreground entrypoint is present.",
  ));
  checks.push(artifactCheck(
    "dispatcher_artifact",
    path.join(packageRoot, "dist", "dispatcher", "index.js"),
    "Build or install the package so the dispatcher foreground entrypoint is present.",
  ));

  return {
    ok: checks.every((check) => !check.required || check.status === "PASS"),
    checks,
  };
}

function versionCheck(
  id: string,
  probe: PreflightCommandProbe,
  minimumMajor: number,
  remediation: string,
): PreflightCheck {
  const parsed = parseVersion(probe.version);
  if (!probe.available || parsed === undefined) {
    return {
      id,
      required: true,
      status: "FAIL",
      observed: "unavailable",
      remediation,
    };
  }
  return {
    id,
    required: true,
    status: parsed.major >= minimumMajor ? "PASS" : "FAIL",
    observed: parsed.display,
    remediation,
  };
}

function commandPresenceCheck(
  id: string,
  probe: PreflightCommandProbe,
  required: boolean,
  remediation: string,
): PreflightCheck {
  return {
    id,
    required,
    status: probe.available ? "PASS" : required ? "FAIL" : "WARN",
    observed: probe.available ? safeVersion(probe.version) : "unavailable",
    remediation,
  };
}

function npmGlobalBinCheck(
  npmProbe: PreflightCommandProbe,
  platform: NodeJS.Platform,
  env: NodeJS.ProcessEnv,
): PreflightCheck {
  const prefix = npmProbe.globalPrefix;
  const globalBin = prefix === undefined || prefix.length === 0
    ? undefined
    : npmGlobalBin(prefix, platform);
  const pathValue = environmentValue(env, "PATH");
  const pathDelimiter = platform === "win32" ? ";" : ":";
  const onPath = globalBin !== undefined && pathValue !== undefined &&
    pathValue.split(pathDelimiter).some((entry) => pathsEqual(entry, globalBin, platform));
  return {
    id: "npm_global_bin_on_path",
    required: true,
    status: onPath ? "PASS" : "FAIL",
    observed: onPath ? "present" : "missing",
    remediation: "Add npm's global bin directory to PATH, then open a new shell and rerun the preflight.",
  };
}

function clockCheck(now: () => Date): PreflightCheck {
  try {
    const value = now();
    const timestamp = value.getTime();
    const valid = Number.isFinite(timestamp) && timestamp >= CLOCK_MIN_MS && timestamp < CLOCK_MAX_MS;
    return {
      id: "clock",
      required: true,
      status: valid ? "PASS" : "FAIL",
      observed: valid ? value.toISOString().slice(0, 10) : "outside-bounded-range",
      remediation: "Set the local system clock to a valid current date and rerun the preflight.",
    };
  } catch {
    return {
      id: "clock",
      required: true,
      status: "FAIL",
      observed: "unavailable",
      remediation: "Make the local system clock readable and rerun the preflight.",
    };
  }
}

function writableRootCheck(root: string): PreflightCheck {
  let probeDirectory: string | undefined;
  let result: PreflightCheck = {
    id: "pilot_root_writable",
    required: true,
    status: "FAIL",
    observed: "not-writable",
    remediation: "Choose an existing writable directory as the disposable pilot root.",
  };
  try {
    const rootStat = fs.statSync(root);
    if (!rootStat.isDirectory()) {
      result = {
        id: "pilot_root_writable",
        required: true,
        status: "FAIL",
        observed: "not-a-directory",
        remediation: "Choose an existing writable directory as the disposable pilot root.",
      };
      return result;
    }
    probeDirectory = fs.mkdtempSync(path.join(root, ".balcony-preflight-"));
    const probeFile = path.join(probeDirectory, "write-check");
    fs.writeFileSync(probeFile, "ok", { encoding: "utf8", flag: "wx" });
    fs.readFileSync(probeFile, "utf8");
    result = {
      id: "pilot_root_writable",
      required: true,
      status: "PASS",
      observed: "writable",
      remediation: "Choose an existing writable directory as the disposable pilot root.",
    };
  } catch {
    result = {
      id: "pilot_root_writable",
      required: true,
      status: "FAIL",
      observed: "not-writable",
      remediation: "Choose an existing writable directory as the disposable pilot root.",
    };
  } finally {
    if (probeDirectory !== undefined) {
      try {
        fs.rmSync(probeDirectory, { force: true, recursive: true });
      } catch {
        if (result.status === "PASS") {
          result = {
            ...result,
            status: "FAIL",
            observed: "cleanup-failed",
            remediation: "Choose an existing writable directory whose temporary probe files can be removed.",
          };
        }
      }
    }
  }
  return result;
}

function artifactCheck(id: string, artifactPath: string, remediation: string): PreflightCheck {
  try {
    const stat = fs.statSync(artifactPath);
    return {
      id,
      required: true,
      status: stat.isFile() ? "PASS" : "FAIL",
      observed: stat.isFile() ? "present" : "not-a-file",
      remediation,
    };
  } catch {
    return {
      id,
      required: true,
      status: "FAIL",
      observed: "missing",
      remediation,
    };
  }
}

function safeProbe(
  probeCommand: (command: PreflightCommandId) => PreflightCommandProbe,
  command: PreflightCommandId,
): PreflightCommandProbe {
  try {
    const result = probeCommand(command);
    if (!result || typeof result.available !== "boolean") {
      return { available: false };
    }
    return {
      available: result.available,
      ...(typeof result.version === "string" ? { version: result.version } : {}),
      ...(typeof result.globalPrefix === "string" ? { globalPrefix: result.globalPrefix } : {}),
    };
  } catch {
    return { available: false };
  }
}

function parseVersion(value: string | undefined): { major: number; display: string } | undefined {
  if (value === undefined) {
    return undefined;
  }
  const match = value.trim().match(/(?:^|\s)v?(\d+)(?:\.(\d+))?(?:\.(\d+))?/u);
  if (!match) {
    return undefined;
  }
  const major = Number(match[1]);
  if (!Number.isSafeInteger(major)) {
    return undefined;
  }
  const minor = match[2] ?? "0";
  const patch = match[3] ?? "0";
  return { major, display: `${major}.${minor}.${patch}` };
}

function safeVersion(value: string | undefined): string {
  return parseVersion(value)?.display ?? "available";
}

function npmGlobalBin(prefix: string, platform: NodeJS.Platform): string {
  return platform === "win32" ? prefix : path.join(prefix, "bin");
}

function environmentValue(env: NodeJS.ProcessEnv, name: string): string | undefined {
  const entry = Object.entries(env).find(([key]) => key.toLowerCase() === name.toLowerCase());
  return entry?.[1];
}

function pathsEqual(left: string, right: string, platform: NodeJS.Platform): boolean {
  const normalize = (value: string): string => {
    const trimmed = value.trim();
    if (platform === "win32") {
      return trimmed.replace(/[\\/]+/gu, "\\").replace(/\\$/u, "").toLowerCase();
    }
    return path.normalize(trimmed).replace(/\/$/u, "");
  };
  return normalize(left) === normalize(right);
}

function defaultCommandProbe(platform: NodeJS.Platform): (command: PreflightCommandId) => PreflightCommandProbe {
  return (command) => {
    const npmCli = path.join(
      path.dirname(process.execPath),
      "node_modules",
      "npm",
      "bin",
      "npm-cli.js",
    );
    const executable = command === "node" || command === "npm"
      ? process.execPath
      : command === "powershell"
        ? "pwsh"
      : platform === "win32" && command === "codex"
        ? "codex.cmd"
        : command;
    const commandArgs = command === "npm" ? [npmCli, "--version"] : ["--version"];
    if (command === "npm" && !fs.existsSync(npmCli)) {
      return { available: false };
    }
    const versionResult = spawnSync(executable, commandArgs, {
      encoding: "utf8",
      shell: platform === "win32" && executable.endsWith(".cmd"),
      timeout: 3_000,
      windowsHide: true,
    });
    if (versionResult.error || versionResult.status !== 0) {
      return { available: false };
    }
    const version = firstSafeVersion(`${versionResult.stdout}\n${versionResult.stderr}`);
    if (command !== "npm") {
      return version === undefined ? { available: true } : { available: true, version };
    }
    const prefixResult = spawnSync(
      process.execPath,
      [npmCli, "prefix", "-g"],
      {
      encoding: "utf8",
      timeout: 3_000,
      windowsHide: true,
      },
    );
    const globalPrefix = prefixResult.error || prefixResult.status !== 0
      ? undefined
      : prefixResult.stdout.trim().split(/\r?\n/u)[0];
    return {
      available: true,
      ...(version === undefined ? {} : { version }),
      ...(globalPrefix === undefined || globalPrefix.length === 0 ? {} : { globalPrefix }),
    };
  };
}

function firstSafeVersion(value: string): string | undefined {
  for (const line of value.split(/\r?\n/u)) {
    const version = parseVersion(line);
    if (version !== undefined) {
      return version.display;
    }
  }
  return undefined;
}

function defaultPackageRoot(): string {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
}

function assertAbsoluteDirectoryInput(value: string, name: string): void {
  if (!path.isAbsolute(value)) {
    throw new TypeError(`${name} must be an absolute path`);
  }
}
