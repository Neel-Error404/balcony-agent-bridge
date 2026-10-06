import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  ManagedCodexToolchainError,
  resolveManagedCodexToolchain,
} from "../../src/onboarding/codex-toolchain.js";

const temporaryRoots: string[] = [];

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) {
    fs.rmSync(root, { force: true, recursive: true });
  }
});

describe("managed Codex toolchain", () => {
  it("resolves the pinned native executable pair inside this package dependency tree", () => {
    const packageRoot = createToolchainFixture("0.150.1");

    const resolved = resolveManagedCodexToolchain({
      packageRoot,
      platform: "win32",
      arch: "x64",
    });

    expect(resolved.version).toBe("0.150.1");
    expect(path.basename(resolved.codexExecutable)).toBe("codex.exe");
    expect(path.basename(resolved.codeModeHostExecutable)).toBe("codex-code-mode-host.exe");
    expect(resolved.codexExecutable).toContain(path.join(packageRoot, "node_modules"));
  });

  it("resolves an exact npm-hoisted dependency without consulting global Codex", () => {
    const consumerRoot = fs.mkdtempSync(path.join(os.tmpdir(), "balcony-codex-consumer-"));
    temporaryRoots.push(consumerRoot);
    const packageRoot = createToolchainFixture("0.150.1", true, consumerRoot);

    const resolved = resolveManagedCodexToolchain({
      packageRoot,
      platform: "win32",
      arch: "x64",
    });

    expect(resolved.codexExecutable).toContain(
      path.join(consumerRoot, "node_modules", "@openai", "codex"),
    );
    expect(resolved.codexExecutable).not.toContain(
      path.join(packageRoot, "node_modules"),
    );
  });

  it("rejects an unpinned managed Codex package", () => {
    const packageRoot = createToolchainFixture("0.153.2");

    expect(() => resolveManagedCodexToolchain({
      packageRoot,
      platform: "win32",
      arch: "x64",
    })).toThrowError(expect.objectContaining<Partial<ManagedCodexToolchainError>>({
      code: "MANAGED_CODEX_PACKAGE_INVALID",
    }));
  });

  it("fails closed when the native companion is missing", () => {
    const packageRoot = createToolchainFixture("0.150.1", false);

    expect(() => resolveManagedCodexToolchain({
      packageRoot,
      platform: "win32",
      arch: "x64",
    })).toThrowError(expect.objectContaining<Partial<ManagedCodexToolchainError>>({
      code: "MANAGED_CODEX_BINARY_MISSING",
    }));
  });
});

function createToolchainFixture(
  version: string,
  includeCompanion = true,
  consumerRoot?: string,
): string {
  const packageRoot = consumerRoot
    ? path.join(consumerRoot, "node_modules", "balcony-agent-bridge")
    : fs.mkdtempSync(path.join(os.tmpdir(), "balcony-codex-toolchain-"));
  if (!consumerRoot) temporaryRoots.push(packageRoot);
  fs.mkdirSync(packageRoot, { recursive: true });
  fs.writeFileSync(
    path.join(packageRoot, "package.json"),
    JSON.stringify({
      name: "balcony-agent-bridge",
      dependencies: { "@openai/codex": "0.150.1" },
    }),
  );
  const dependencyRoot = consumerRoot ?? packageRoot;
  const codexRoot = path.join(dependencyRoot, "node_modules", "@openai", "codex");
  const nativeRoot = path.join(
    codexRoot,
    "node_modules",
    "@openai",
    "codex-win32-x64",
  );
  const bin = path.join(nativeRoot, "vendor", "x86_64-pc-windows-msvc", "bin");
  fs.mkdirSync(bin, { recursive: true });
  fs.writeFileSync(
    path.join(codexRoot, "package.json"),
    JSON.stringify({ name: "@openai/codex", version }),
  );
  fs.writeFileSync(
    path.join(nativeRoot, "package.json"),
    JSON.stringify({ name: "@openai/codex", version: `${version}-win32-x64` }),
  );
  fs.writeFileSync(path.join(bin, "codex.exe"), "native");
  if (includeCompanion) {
    fs.writeFileSync(path.join(bin, "codex-code-mode-host.exe"), "native");
  }
  return packageRoot;
}
