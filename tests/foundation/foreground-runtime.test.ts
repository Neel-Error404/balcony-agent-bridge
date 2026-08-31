import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

import { describe, expect, it } from "vitest";

import {
  buildBridgeLaunch,
  buildDispatcherLaunch,
  validateForegroundEntrypoints,
} from "../../src/onboarding/foreground-runtime.js";

const packageRoot = path.resolve(import.meta.dirname, "../..");

describe("npm foreground runtime contract", () => {
  it.each(["bridge", "dispatcher"])(
    "provides safe foreground help for %s",
    (runtime) => {
      const tsxCli = path.join(packageRoot, "node_modules", "tsx", "dist", "cli.mjs");
      const runtimeSource = path.join(packageRoot, "src", runtime, "index.ts");
      const result = spawnSync(process.execPath, [tsxCli, runtimeSource, "--help"], {
        cwd: packageRoot,
        encoding: "utf8",
        windowsHide: true,
      });

      expect(result.status).toBe(0);
      expect(result.stderr).toBe("");
      expect(result.stdout).toContain(`Usage: balcony-agent-bridge runtime ${runtime}`);
    },
    15_000,
  );

  it("finds both installed-artifact entrypoints", () => {
    expect(validateForegroundEntrypoints(packageRoot)).toEqual({
      bridge: path.join(packageRoot, "dist", "bridge", "index.js"),
      dispatcher: path.join(packageRoot, "dist", "dispatcher", "index.js"),
    });
  });

  it("rejects an entrypoint that resolves outside the installed package", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "balcony-runtime-links-"));
    try {
      const outside = path.join(root, "outside");
      const candidate = path.join(root, "package");
      fs.mkdirSync(outside, { recursive: true });
      fs.mkdirSync(path.join(candidate, "dist", "dispatcher"), { recursive: true });
      fs.writeFileSync(path.join(outside, "index.js"), "export {};\n");
      fs.writeFileSync(
        path.join(candidate, "dist", "dispatcher", "index.js"),
        "export {};\n",
      );
      fs.symlinkSync(
        outside,
        path.join(candidate, "dist", "bridge"),
        process.platform === "win32" ? "junction" : "dir",
      );

      expect(() => validateForegroundEntrypoints(candidate)).toThrow(
        /missing the bridge foreground entrypoint/,
      );
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("gives signing and transport configuration only to the bridge", () => {
    const launch = buildBridgeLaunch({
      packageRoot,
      configPath: "C:\\pilot\\config.json",
      nodeId: "pilot-a",
      networkId: "pilot-network",
      membershipPath: "C:\\pilot\\membership.json",
      signingKeyPath: "C:\\secure\\pilot-a-signing-key.pem",
      azure: {
        serviceBusNamespace: "example.servicebus.windows.net",
        subscriptionName: "pilot-a",
        authMode: "managed_identity",
      },
      validateOnly: true,
    });

    expect(launch.args).toContain("--validate-message-authentication");
    expect(launch.env["BALCONY_MESSAGE_AUTH_SIGNING_KEY_PATH"]).toBe(
      "C:\\secure\\pilot-a-signing-key.pem",
    );
    expect(launch.env["BALCONY_SERVICEBUS_NAMESPACE"]).toBe(
      "example.servicebus.windows.net",
    );
  });

  it("keeps Azure and signing material out of the dispatcher", () => {
    const launch = buildDispatcherLaunch({
      packageRoot,
      configPath: "C:\\pilot\\config.json",
      nodeId: "pilot-a",
      projectsConfigPath: "C:\\pilot\\dispatcher-projects.json",
      codexExecutable: "C:\\codex\\codex.exe",
      codexSha256: "a".repeat(64),
      codeModeHostExecutable: "C:\\codex\\codex-code-mode-host.exe",
      codeModeHostSha256: "b".repeat(64),
      codexHome: "C:\\pilot\\codex-home",
      validateOnly: true,
    });

    expect(launch.args.at(-1)).toBe("--validate-config");
    expect(Object.keys(launch.env)).not.toContain(
      "BALCONY_MESSAGE_AUTH_SIGNING_KEY_PATH",
    );
    expect(Object.keys(launch.env).some((key) => key.startsWith("AZURE_"))).toBe(
      false,
    );
  });
});
