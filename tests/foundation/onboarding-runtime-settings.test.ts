import { generateKeyPairSync, createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  configureDispatcher,
  configureMcp,
  configureTransport,
  readRuntimeSettings,
} from "../../src/onboarding/runtime-settings.js";
import {
  exportPublicEnrollment,
  generateOnboardingIdentity,
  importPublicEnrollment,
  readOnboardingManifest,
  startOnboarding,
  statusOnboarding,
  writeMembershipPolicy,
} from "../../src/onboarding/index.js";

const roots: string[] = [];
const protectedDirectories: string[] = [];

afterEach(() => {
  vi.unstubAllEnvs();
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
  for (const directory of protectedDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

describe("onboarding runtime settings", () => {
  it("creates an idempotent local profile without Azure mutation", () => {
    const manifestPath = completeOnboarding();
    const first = configureTransport({
      manifestPath,
      packageRoot: path.resolve(import.meta.dirname, "../.."),
      subscriptionName: "node-a",
      topicName: "agent-messages",
      authMode: "managed_identity",
      localOnly: true,
    });
    const second = configureTransport({
      manifestPath,
      packageRoot: path.resolve(import.meta.dirname, "../.."),
      subscriptionName: "node-a",
      topicName: "agent-messages",
      authMode: "managed_identity",
      localOnly: true,
    });

    expect(first).toEqual(second);
    expect(first.transport.configured).toBe(true);
    expect(fs.existsSync(first.transport.profile_path)).toBe(true);
    expect(fs.existsSync(first.transport.database_path)).toBe(true);
    expect(JSON.stringify(first)).not.toMatch(/PRIVATE KEY|client_secret|connection_string/iu);
    expect(() => configureTransport({
      manifestPath,
      packageRoot: path.resolve(import.meta.dirname, "../.."),
      subscriptionName: "different-subscription",
      topicName: "agent-messages",
      authMode: "managed_identity",
      localOnly: true,
    })).toThrow(expect.objectContaining({ code: "RUNTIME_SETTINGS_CONFLICT" }));
    expect(() => configureTransport({
      manifestPath,
      packageRoot: path.resolve(import.meta.dirname, "../.."),
      authMode: "managed_identity",
      localOnly: true,
      managedIdentityClientId: "not-a-uuid",
    })).toThrow(expect.objectContaining({ code: "RUNTIME_SETTINGS_INVALID" }));
  }, 45_000);

  it("reports a missing configured profile or database as blocked", () => {
    const manifestPath = completeOnboarding();
    const configured = configureTransport({
      manifestPath,
      packageRoot: path.resolve(import.meta.dirname, "../.."),
      authMode: "managed_identity",
      localOnly: true,
    });

    fs.rmSync(configured.transport.database_path);

    expect(statusOnboarding(manifestPath)).toMatchObject({
      status: "blocked",
      issues: expect.arrayContaining(["database: artifact missing"]),
    });
  }, 45_000);

  it("reports a normal SQLite database larger than the public JSON limit", () => {
    const manifestPath = completeOnboarding();
    const configured = configureTransport({
      manifestPath,
      packageRoot: path.resolve(import.meta.dirname, "../.."),
      authMode: "managed_identity",
      localOnly: true,
    });
    fs.appendFileSync(
      configured.transport.database_path,
      Buffer.alloc(1024 * 1024 + 1),
    );

    expect(statusOnboarding(manifestPath)).toMatchObject({
      status: "complete",
      artifacts: {
        database: { present: true },
      },
    });
  }, 45_000);

  it("pins dispatcher executables and registers MCP through an injected Codex runner", () => {
    vi.stubEnv("AZURE_CLIENT_SECRET", "must-not-reach-codex");
    const manifestPath = completeOnboarding();
    const root = path.dirname(manifestPath);
    configureTransport({
      manifestPath,
      packageRoot: path.resolve(import.meta.dirname, "../.."),
      subscriptionName: "node-a",
      authMode: "managed_identity",
      localOnly: true,
    });
    const bin = path.join(root, "codex-bin");
    fs.mkdirSync(bin);
    const codexExecutable = path.join(bin, "codex.exe");
    const codeModeHostExecutable = path.join(bin, "codex-code-mode-host.exe");
    fs.writeFileSync(codexExecutable, "codex");
    fs.writeFileSync(codeModeHostExecutable, "host");
    const projectPath = path.join(root, "project");
    fs.mkdirSync(projectPath);
    const configured = configureDispatcher({
      manifestPath,
      projectKey: "pilot-project",
      projectPath,
      codexExecutable,
      codeModeHostExecutable,
    });
    protectedDirectories.push(configured.dispatcher.codex_home);
    const mcpRunner = createMcpRunner(manifestPath);
    const registered = configureMcp({
      manifestPath,
      codexExecutable,
      packageRoot: path.resolve(import.meta.dirname, "../.."),
      runCodex: mcpRunner.run,
    });

    expect(configured.dispatcher.codex_sha256).toBe(createHash("sha256").update("codex").digest("hex"));
    expect(configured.dispatcher.code_mode_host_sha256).toBe(createHash("sha256").update("host").digest("hex"));
    expect(mcpRunner.calls).toHaveLength(3);
    expect(mcpRunner.calls[1]?.args).toEqual(expect.arrayContaining(["mcp", "add", "balcony-agent-bridge"]));
    expect(mcpRunner.calls[0]?.env["CODEX_HOME"]).toBe(configured.dispatcher.codex_home);
    expect(mcpRunner.calls[0]?.env["AZURE_CLIENT_SECRET"]).toBeUndefined();
    expect(registered.mcp.configured).toBe(true);
    expect(readRuntimeSettings(manifestPath)).toEqual(registered);
    expect(configureMcp({
      manifestPath,
      codexExecutable,
      packageRoot: path.resolve(import.meta.dirname, "../.."),
      runCodex: mcpRunner.run,
    })).toEqual(registered);
    expect(mcpRunner.calls).toHaveLength(4);
    expect(mcpRunner.calls[3]?.args).toEqual([
      "mcp",
      "get",
      "balcony-agent-bridge",
      "--json",
    ]);
  }, 45_000);

  it("recovers MCP state after Codex registration succeeded before local persistence", () => {
    const manifestPath = completeOnboarding();
    const root = path.dirname(manifestPath);
    configureTransport({
      manifestPath,
      packageRoot: path.resolve(import.meta.dirname, "../.."),
      authMode: "managed_identity",
      localOnly: true,
    });
    const bin = createCodexBundle(root);
    const projectPath = path.join(root, "project");
    fs.mkdirSync(projectPath);
    const dispatcher = configureDispatcher({
      manifestPath,
      projectKey: "pilot-project",
      projectPath,
      ...bin,
    });
    protectedDirectories.push(dispatcher.dispatcher.codex_home);
    const mcpRunner = createMcpRunner(manifestPath, true);

    const recovered = configureMcp({
      manifestPath,
      codexExecutable: bin.codexExecutable,
      packageRoot: path.resolve(import.meta.dirname, "../.."),
      runCodex: mcpRunner.run,
    });

    expect(mcpRunner.calls).toHaveLength(1);
    expect(mcpRunner.calls[0]?.args).toEqual([
      "mcp",
      "get",
      "balcony-agent-bridge",
      "--json",
    ]);
    expect(recovered.mcp.configured).toBe(true);
  }, 45_000);

  it("fails closed when dispatcher configuration contradicts durable state", () => {
    const manifestPath = completeOnboarding();
    const root = path.dirname(manifestPath);
    configureTransport({
      manifestPath,
      packageRoot: path.resolve(import.meta.dirname, "../.."),
      authMode: "managed_identity",
      localOnly: true,
    });
    const bin = createCodexBundle(root);
    const firstProject = path.join(root, "project-a");
    const secondProject = path.join(root, "project-b");
    fs.mkdirSync(firstProject);
    fs.mkdirSync(secondProject);
    const first = configureDispatcher({
      manifestPath,
      projectKey: "project-a",
      projectPath: firstProject,
      ...bin,
    });
    protectedDirectories.push(first.dispatcher.codex_home);

    expect(configureDispatcher({
      manifestPath,
      projectKey: "project-a",
      projectPath: firstProject,
      ...bin,
    })).toEqual(first);
    expect(() => configureDispatcher({
      manifestPath,
      projectKey: "project-b",
      projectPath: secondProject,
      ...bin,
    })).toThrow(expect.objectContaining({ code: "RUNTIME_SETTINGS_CONFLICT" }));
    expect(() => configureDispatcher({
      manifestPath,
      projectKey: "../invalid",
      projectPath: firstProject,
      ...bin,
    })).toThrow(expect.objectContaining({
      code: "DISPATCHER_CONFIGURATION_INVALID",
    }));
  }, 45_000);

  it("refuses MCP registration after executable replacement or path substitution", () => {
    const manifestPath = completeOnboarding();
    const root = path.dirname(manifestPath);
    configureTransport({
      manifestPath,
      packageRoot: path.resolve(import.meta.dirname, "../.."),
      authMode: "managed_identity",
      localOnly: true,
    });
    const bin = createCodexBundle(root);
    const projectPath = path.join(root, "project");
    fs.mkdirSync(projectPath);
    const dispatcher = configureDispatcher({
      manifestPath,
      projectKey: "pilot-project",
      projectPath,
      ...bin,
    });
    protectedDirectories.push(dispatcher.dispatcher.codex_home);
    const alternateCodex = path.join(root, "alternate-codex.exe");
    fs.writeFileSync(alternateCodex, "codex");
    expect(() => configureMcp({
      manifestPath,
      codexExecutable: alternateCodex,
      packageRoot: path.resolve(import.meta.dirname, "../.."),
      runCodex: () => ({ status: 0, stdout: "", stderr: "" }),
    })).toThrow(expect.objectContaining({ code: "RUNTIME_SETTINGS_CONFLICT" }));

    fs.writeFileSync(bin.codexExecutable, "replaced");
    expect(() => configureMcp({
      manifestPath,
      codexExecutable: bin.codexExecutable,
      packageRoot: path.resolve(import.meta.dirname, "../.."),
      runCodex: () => ({ status: 0, stdout: "", stderr: "" }),
    })).toThrow(expect.objectContaining({ code: "RUNTIME_SETTINGS_CONFLICT" }));
  }, 45_000);

  it("rejects symlinked runtime settings", () => {
    const manifestPath = completeOnboarding();
    const root = path.dirname(manifestPath);
    const settingsPath = path.join(root, "runtime-settings.json");
    const outside = path.join(root, "outside-settings");
    fs.mkdirSync(outside);
    fs.symlinkSync(
      outside,
      settingsPath,
      process.platform === "win32" ? "junction" : "dir",
    );
    expect(() => readRuntimeSettings(manifestPath)).toThrow(
      expect.objectContaining({ code: "RUNTIME_SETTINGS_INVALID" }),
    );
  }, 45_000);

  it("rejects runtime settings that diverge from the onboarding manifest", () => {
    const manifestPath = completeOnboarding();
    const root = path.dirname(manifestPath);
    const settingsPath = path.join(root, "runtime-settings.json");
    configureTransport({
      manifestPath,
      packageRoot: path.resolve(import.meta.dirname, "../.."),
      authMode: "managed_identity",
      localOnly: true,
    });
    const tampered = JSON.parse(fs.readFileSync(settingsPath, "utf8"));
    tampered.transport.profile_path = path.join(root, "other-config.json");
    fs.writeFileSync(settingsPath, `${JSON.stringify(tampered, null, 2)}\n`);
    expect(() => readRuntimeSettings(manifestPath)).toThrow(
      expect.objectContaining({ code: "RUNTIME_SETTINGS_INVALID" }),
    );
  }, 45_000);

  it("recovers an interrupted runtime-settings manifest update", () => {
    const manifestPath = completeOnboarding();
    const current = configureTransport({
      manifestPath,
      packageRoot: path.resolve(import.meta.dirname, "../.."),
      authMode: "managed_identity",
      localOnly: true,
    });
    const manifest = readOnboardingManifest(manifestPath);
    const settingsPath = path.join(manifest.root, "runtime-settings.json");
    const transactionPath = path.join(
      manifest.identity_directory,
      ".runtime_settings.transaction.json",
    );
    const target = { ...current, mcp: { configured: true as const } };
    const targetContent = `${JSON.stringify(target, null, 2)}\n`;
    fs.writeFileSync(
      transactionPath,
      `${JSON.stringify({
        schema_version: "1.0",
        artifact: "runtime_settings",
        previous_sha256: manifest.artifact_sha256["runtime_settings"],
        target_sha256: createHash("sha256").update(targetContent).digest("hex"),
      }, null, 2)}\n`,
      { flag: "wx", mode: 0o600 },
    );
    fs.writeFileSync(settingsPath, targetContent);

    expect(readRuntimeSettings(manifestPath)).toEqual(target);
    expect(fs.existsSync(transactionPath)).toBe(false);
    expect(
      readOnboardingManifest(manifestPath).artifact_sha256["runtime_settings"],
    ).toBe(createHash("sha256").update(targetContent).digest("hex"));
  }, 45_000);

  it.skipIf(process.platform !== "win32")(
    "blocks status and runtime settings after identity ACL weakening",
    () => {
      const manifestPath = completeOnboarding();
      const configured = configureTransport({
        manifestPath,
        packageRoot: path.resolve(import.meta.dirname, "../.."),
        authMode: "managed_identity",
        localOnly: true,
      });
      const manifest = readOnboardingManifest(manifestPath);
      const icacls = path.join(
        process.env["SystemRoot"]!,
        "System32",
        "icacls.exe",
      );
      const grant = spawnSync(
        icacls,
        [manifest.root, "/grant", "*S-1-5-11:(OI)(CI)(M)"],
        { encoding: "utf8", windowsHide: true },
      );
      expect(grant.status).toBe(0);
      try {
        expect(statusOnboarding(manifestPath)).toMatchObject({
          status: "blocked",
          issues: expect.arrayContaining([
            "identity_directory: unsafe ACL",
          ]),
        });
        expect(() => readRuntimeSettings(manifestPath)).toThrow(
          expect.objectContaining({ code: "RUNTIME_SETTINGS_CONFLICT" }),
        );
      } finally {
        const remove = spawnSync(
          icacls,
          [manifest.root, "/remove:g", "*S-1-5-11"],
          { encoding: "utf8", windowsHide: true },
        );
        expect(remove.status).toBe(0);
        expect(fs.existsSync(configured.transport.database_path)).toBe(true);
      }
    },
    45_000,
  );
});

function createCodexBundle(root: string) {
  const bin = path.join(root, `codex-bin-${Math.random().toString(16).slice(2)}`);
  fs.mkdirSync(bin);
  const codexExecutable = path.join(bin, "codex.exe");
  const codeModeHostExecutable = path.join(bin, "codex-code-mode-host.exe");
  fs.writeFileSync(codexExecutable, "codex");
  fs.writeFileSync(codeModeHostExecutable, "host");
  return { codexExecutable, codeModeHostExecutable };
}

function createMcpRunner(manifestPath: string, initiallyRegistered = false) {
  const manifest = readOnboardingManifest(manifestPath);
  let registered = initiallyRegistered;
  const calls: Array<{ args: string[]; env: NodeJS.ProcessEnv }> = [];
  return {
    calls,
    run(args: readonly string[], env: NodeJS.ProcessEnv) {
      calls.push({ args: [...args], env });
      if (args[1] === "get") {
        if (!registered) {
          return {
            status: 1,
            stdout: "",
            stderr: "Error: No MCP server named 'balcony-agent-bridge' found.",
          };
        }
        return {
          status: 0,
          stdout: JSON.stringify({
            name: "balcony-agent-bridge",
            enabled: true,
            transport: {
              type: "stdio",
              command: process.execPath,
              args: [
                path.join(
                  path.resolve(import.meta.dirname, "../.."),
                  "dist",
                  "mcp",
                  "index.js",
                ),
                "--config",
                manifest.profile_path,
              ],
              env: { BALCONY_SYSTEM_ID: manifest.node_id },
            },
          }),
          stderr: "",
        };
      }
      registered = true;
      return { status: 0, stdout: "", stderr: "" };
    },
  };
}

function completeOnboarding(): string {
  const parent = process.platform === "win32" ? process.env["ProgramData"]! : os.tmpdir();
  const root = fs.mkdtempSync(path.join(parent, "balcony-runtime-settings-"));
  roots.push(root);
  const manifest = startOnboarding({
    root,
    nodeId: "node-a",
    processIdentity: "node-a",
    networkId: "pilot-network",
    authorizedNodeIds: ["node-b"],
    identityDirectory: path.join(root, "identity"),
  });
  generateOnboardingIdentity({ manifestPath: manifest.manifestPath });
  const peer = makeEnrollment();
  const peerPath = path.join(root, "peer.json");
  fs.writeFileSync(peerPath, exportPublicEnrollment(peer).json);
  importPublicEnrollment({
    manifestPath: manifest.manifestPath,
    inputPath: peerPath,
    expectedPeerId: "node-b",
  });
  writeMembershipPolicy(manifest.manifestPath);
  return manifest.manifestPath;
}

function makeEnrollment() {
  const pair = generateKeyPairSync("ed25519");
  const publicDer = pair.publicKey.export({ format: "der", type: "spki" }) as Buffer;
  return {
    schema_version: "1.0" as const,
    network_id: "pilot-network",
    node_id: "node-b" as const,
    key_id: `ed25519:${createHash("sha256").update(publicDer).digest("base64url")}`,
    spki_der_base64url: publicDer.toString("base64url"),
    status: "active" as const,
  };
}
