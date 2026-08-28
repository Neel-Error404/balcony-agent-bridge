import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  runPreflight,
  type PreflightCommandId,
  type PreflightCommandProbe,
} from "../../src/onboarding/preflight.js";

const temporaryRoots: string[] = [];

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) {
    fs.rmSync(root, { force: true, recursive: true });
  }
});

describe("onboarding preflight", () => {
  it("passes the blind pilot prerequisites without exposing probe details", () => {
    const { pilotRoot, packageRoot } = createRuntimeFixture();
    const report = runPreflight({
      pilotRoot,
      packageRoot,
      platform: "win32",
      env: {
        Path: "C:\\Windows\\System32;C:\\npm\\bin",
      },
      now: () => new Date("2026-08-28T12:00:00.000Z"),
      probeCommand: commandProbe({
        node: { available: true, version: "v22.14.0" },
        npm: { available: true, version: "10.9.2", globalPrefix: "c:\\npm\\bin" },
        powershell: { available: true, version: "7.5.2" },
        git: { available: true, version: "2.50.0.windows.1" },
        codex: { available: true, version: "0.2.0" },
      }),
    });

    expect(report.ok).toBe(true);
    expect(report.checks).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "node_version", status: "PASS", observed: "22.14.0" }),
      expect.objectContaining({ id: "npm_version", status: "PASS", observed: "10.9.2" }),
      expect.objectContaining({ id: "powershell_version", status: "PASS", observed: "7.5.2" }),
      expect.objectContaining({ id: "git", status: "PASS" }),
      expect.objectContaining({ id: "codex", status: "PASS" }),
      expect.objectContaining({ id: "npm_global_bin_on_path", status: "PASS" }),
      expect.objectContaining({ id: "clock", status: "PASS", observed: "2026-08-28" }),
      expect.objectContaining({ id: "pilot_root_writable", status: "PASS" }),
      expect.objectContaining({ id: "bridge_artifact", status: "PASS" }),
      expect.objectContaining({ id: "dispatcher_artifact", status: "PASS" }),
    ]));
    expect(JSON.stringify(report)).not.toContain("C:\\npm");
    expect(JSON.stringify(report)).not.toContain("windows.1");
  });

  it("handles Windows PATH casing and reports safe actionable failures", () => {
    const { pilotRoot, packageRoot } = createRuntimeFixture();
    const report = runPreflight({
      pilotRoot,
      packageRoot,
      platform: "win32",
      env: {
        pAtH: "C:\\Windows\\System32;C:\\Tools",
      },
      now: () => new Date("2010-01-01T00:00:00.000Z"),
      probeCommand: (command: PreflightCommandId) => {
        if (command === "git") {
          throw new Error("token=should-not-appear");
        }
        return commandProbe({
        node: { available: true, version: "v21.0.0" },
        npm: { available: true, version: "9.0.0", globalPrefix: "C:\\npm" },
        powershell: { available: true, version: "5.1" },
        codex: { available: false },
        })(command);
      },
    });

    expect(report.ok).toBe(false);
    expect(report.checks).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "node_version", status: "FAIL", remediation: expect.any(String) }),
      expect.objectContaining({ id: "npm_version", status: "FAIL", remediation: expect.any(String) }),
      expect.objectContaining({ id: "powershell_version", status: "FAIL", remediation: expect.any(String) }),
      expect.objectContaining({ id: "git", status: "FAIL", observed: "unavailable" }),
      expect.objectContaining({ id: "codex", status: "FAIL", observed: "unavailable" }),
      expect.objectContaining({ id: "npm_global_bin_on_path", status: "FAIL" }),
      expect.objectContaining({ id: "clock", status: "FAIL" }),
    ]));
    const rendered = JSON.stringify(report);
    expect(rendered).not.toContain("token=should-not-appear");
    expect(rendered).not.toContain("C:\\npm");
  });

  it("fails artifact readiness and cleans its disposable write probe", () => {
    const pilotRoot = fs.mkdtempSync(path.join(os.tmpdir(), "balcony-preflight-"));
    temporaryRoots.push(pilotRoot);
    const packageRoot = path.join(pilotRoot, "package");
    fs.mkdirSync(packageRoot, { recursive: true });
    const report = runPreflight({
      pilotRoot,
      packageRoot,
      platform: "linux",
      env: { PATH: "/usr/bin" },
      now: () => new Date("2026-08-28T12:00:00.000Z"),
      probeCommand: commandProbe({
        node: { available: true, version: "v22.14.0" },
        npm: { available: true, version: "10.9.2", globalPrefix: "/usr" },
        powershell: { available: true, version: "7.5.2" },
        git: { available: true, version: "2.50.0" },
        codex: { available: true, version: "0.2.0" },
      }),
    });

    expect(report.ok).toBe(false);
    expect(report.checks).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "bridge_artifact", status: "FAIL" }),
      expect.objectContaining({ id: "dispatcher_artifact", status: "FAIL" }),
    ]));
    expect(fs.readdirSync(pilotRoot)).toEqual(["package"]);
  });
});

function createRuntimeFixture(): { pilotRoot: string; packageRoot: string } {
  const pilotRoot = fs.mkdtempSync(path.join(os.tmpdir(), "balcony-preflight-"));
  temporaryRoots.push(pilotRoot);
  const packageRoot = path.join(pilotRoot, "package");
  fs.mkdirSync(path.join(packageRoot, "dist", "bridge"), { recursive: true });
  fs.mkdirSync(path.join(packageRoot, "dist", "dispatcher"), { recursive: true });
  fs.writeFileSync(path.join(packageRoot, "dist", "bridge", "index.js"), "");
  fs.writeFileSync(path.join(packageRoot, "dist", "dispatcher", "index.js"), "");
  return { pilotRoot, packageRoot };
}

function commandProbe(
  results: Partial<Record<PreflightCommandId, PreflightCommandProbe>>,
): (command: PreflightCommandId) => PreflightCommandProbe {
  return (command) => results[command] ?? { available: false };
}
