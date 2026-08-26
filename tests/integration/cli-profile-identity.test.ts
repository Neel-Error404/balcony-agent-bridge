import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { setupLocalProfile } from "../../src/setup/local-profile.js";

describe("CLI explicit profile identity", () => {
  const temporaryDirectories: string[] = [];

  afterEach(() => {
    for (const directory of temporaryDirectories.splice(0)) {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  it("rejects setup for a different process identity before writing", () => {
    const temporaryDirectory = fs.mkdtempSync(
      path.join(os.tmpdir(), "balcony-agent-bridge-setup-identity-"),
    );
    temporaryDirectories.push(temporaryDirectory);
    const configPath = path.join(temporaryDirectory, "profile", "config.json");
    const databasePath = path.join(temporaryDirectory, "data", "bridge.sqlite3");
    const repositoryRoot = path.resolve(import.meta.dirname, "../..");

    const result = spawnSync(
      process.execPath,
      [
        "--import",
        "tsx",
        path.join(repositoryRoot, "src", "cli", "index.ts"),
        "setup",
        "--config",
        configPath,
        "--database",
        databasePath,
        "--node-id",
        "node-a",
        "--authorized-node",
        "node-b",
      ],
      {
        cwd: repositoryRoot,
        encoding: "utf8",
        env: {
          ...process.env,
          BALCONY_SYSTEM_ID: "node-b",
        },
        timeout: 10_000,
      },
    );

    expect(result.status).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr.trim()).toBe("setup failed (CONFIGURATION_ERROR)");
    expect(result.stderr).not.toContain("node-a");
    expect(result.stderr).not.toContain("node-b");
    expect(result.stderr).not.toContain(configPath);
    expect(result.stderr).not.toContain(databasePath);
    expect(fs.readdirSync(temporaryDirectory)).toEqual([]);
  });

  it.each(["status", "doctor"])(
    "rejects a %s profile for a different process identity",
    (command) => {
      const temporaryDirectory = fs.mkdtempSync(
        path.join(os.tmpdir(), "balcony-agent-bridge-cli-profile-"),
      );
      temporaryDirectories.push(temporaryDirectory);
      const configPath = path.join(temporaryDirectory, "config.json");
      setupLocalProfile({
        configPath,
        databasePath: path.join(temporaryDirectory, "bridge.sqlite3"),
        nodeId: "node-a",
        authorizedNodeIds: ["node-b"],
      });

      const repositoryRoot = path.resolve(import.meta.dirname, "../..");
      const result = spawnSync(
        process.execPath,
        [
          "--import",
          "tsx",
          path.join(repositoryRoot, "src", "cli", "index.ts"),
          command,
          "--config",
          configPath,
        ],
        {
          cwd: repositoryRoot,
          encoding: "utf8",
          env: {
            ...process.env,
            BALCONY_SYSTEM_ID: "node-b",
          },
          timeout: 10_000,
        },
      );

      expect(result.status).toBe(1);
      expect(`${result.stdout}\n${result.stderr}`).not.toContain(configPath);
      expect(`${result.stdout}\n${result.stderr}`).not.toContain("node-a");
      expect(`${result.stdout}\n${result.stderr}`).not.toContain("node-b");
      if (command === "status") {
        expect(result.stdout).toBe("");
        expect(result.stderr.trim()).toBe(
          "status failed (CONFIGURATION_ERROR)",
        );
      } else {
        const report = JSON.parse(result.stdout) as {
          ok: boolean;
          checks: Array<{ name: string; status: string; code?: string }>;
        };
        expect(report.ok).toBe(false);
        expect(report.checks).toContainEqual({
          name: "configuration",
          status: "fail",
          code: "CONFIGURATION_ERROR",
        });
        expect(result.stderr).toBe("");
      }
    },
  );
});
