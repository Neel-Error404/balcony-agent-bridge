import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { setupLocalProfile } from "../../src/setup/local-profile.js";

describe("resource authorization CLI", () => {
  const temporaryDirectories: string[] = [];

  afterEach(() => {
    for (const directory of temporaryDirectories) {
      fs.rmSync(directory, { recursive: true, force: true });
    }
    temporaryDirectories.length = 0;
  });

  it("registers resources and creates, lists, and revokes exact peer grants", () => {
    const { configPath } = fixture();

    const registered = runCli(configPath, [
      "resource",
      "register",
      "--resource-id",
      "VoiceAI",
    ]);
    expect(registered.status).toBe(0);
    expect(JSON.parse(registered.stdout)).toMatchObject({
      ok: true,
      resource: { resource_id: "voiceai", enabled: true },
    });

    const granted = runCli(configPath, [
      "grant",
      "create",
      "--peer-id",
      "node-b",
      "--resource-id",
      "voiceai",
    ]);
    expect(granted.status).toBe(0);
    expect(JSON.parse(granted.stdout)).toMatchObject({
      ok: true,
      grant: {
        peer_id: "node-b",
        resource_id: "voiceai",
        state: "active",
      },
    });

    const listed = runCli(configPath, ["grant", "list"]);
    expect(listed.status).toBe(0);
    expect(JSON.parse(listed.stdout)).toMatchObject({
      grants: [
        {
          peer_id: "node-b",
          resource_id: "voiceai",
          state: "active",
        },
      ],
    });

    const revoked = runCli(configPath, [
      "grant",
      "revoke",
      "--peer-id",
      "node-b",
      "--resource-id",
      "voiceai",
    ]);
    expect(revoked.status).toBe(0);
    expect(JSON.parse(revoked.stdout)).toMatchObject({
      grant: { state: "revoked" },
    });

    const disabled = runCli(configPath, [
      "resource",
      "disable",
      "--resource-id",
      "voiceai",
    ]);
    expect(disabled.status).toBe(0);
    expect(JSON.parse(disabled.stdout)).toMatchObject({
      resource: { resource_id: "voiceai", enabled: false },
    });
  }, 60_000);

  it("rejects grant administration for a peer outside the configured membership", () => {
    const { configPath } = fixture();
    expect(
      runCli(configPath, [
        "resource",
        "register",
        "--resource-id",
        "voiceai",
      ]).status,
    ).toBe(0);

    const denied = runCli(configPath, [
      "grant",
      "create",
      "--peer-id",
      "node-c",
      "--resource-id",
      "voiceai",
    ]);
    expect(denied.status).toBe(2);
    expect(denied.stdout).toBe("");
    expect(denied.stderr).not.toContain(configPath);
  }, 60_000);

  it("requires the exact process identity before mutating authorization state", () => {
    const { configPath } = fixture();

    for (const systemId of [null, "node-b"] as const) {
      const denied = runCli(
        configPath,
        ["resource", "register", "--resource-id", "voiceai"],
        systemId,
      );
      expect(denied.status).toBe(1);
      expect(denied.stdout).toBe("");
      expect(denied.stderr).toContain(
        "resource failed (CONFIGURATION_ERROR)",
      );
      expect(denied.stderr).not.toContain(configPath);
    }

    const listed = runCli(configPath, ["resource", "list"]);
    expect(listed.status).toBe(0);
    expect(JSON.parse(listed.stdout)).toEqual({ resources: [] });
  }, 60_000);

  function fixture(): { configPath: string } {
    const root = fs.mkdtempSync(
      path.join(os.tmpdir(), "balcony-resource-cli-"),
    );
    temporaryDirectories.push(root);
    const configPath = path.join(root, "config.json");
    setupLocalProfile({
      configPath,
      databasePath: path.join(root, "bridge.sqlite3"),
      nodeId: "node-a",
      authorizedNodeIds: ["node-b"],
    });
    return { configPath };
  }
});

function runCli(
  configPath: string,
  args: string[],
  systemId: string | null = "node-a",
) {
  const repositoryRoot = path.resolve(import.meta.dirname, "../..");
  const environment = { ...process.env };
  if (systemId === null) {
    delete environment["BALCONY_SYSTEM_ID"];
  } else {
    environment["BALCONY_SYSTEM_ID"] = systemId;
  }
  return spawnSync(
    process.execPath,
    [
      "--import",
      "tsx",
      path.join(repositoryRoot, "src", "cli", "index.ts"),
      ...args,
      "--config",
      configPath,
    ],
    {
      cwd: repositoryRoot,
      encoding: "utf8",
      env: environment,
      timeout: 60_000,
    },
  );
}
