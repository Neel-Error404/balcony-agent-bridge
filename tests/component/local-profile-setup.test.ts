import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it, vi } from "vitest";

import { loadConfigFile } from "../../src/config.js";
import { setupLocalProfile } from "../../src/setup/local-profile.js";
import { BridgeDatabase } from "../../src/storage/database.js";

describe("local profile setup", () => {
  it("creates a secret-safe profile, initializes SQLite, and is idempotent", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "bridge-setup-"));
    const profilePath = path.join(root, "config", "node-a.json");
    const databasePath = path.join(root, "data", "bridge.sqlite3");
    try {
      const first = setupLocalProfile({
        configPath: profilePath,
        nodeId: "node-a",
        authorizedNodeIds: ["node-b", "node-c"],
        databasePath,
        mcpCommand: "C:\\Program Files\\nodejs\\node.exe",
        mcpCommandArgs: ["C:\\runtime\\dist\\mcp\\index.js"],
      });

      expect(first.created).toBe(true);
      expect(first.mcpRegistration).toContain(
        'command = "C:\\\\Program Files\\\\nodejs\\\\node.exe"',
      );
      expect(first.mcpRegistration).toContain(
        'args = ["C:\\\\runtime\\\\dist\\\\mcp\\\\index.js","--config",',
      );
      expect(first.mcpRegistration).toContain(JSON.stringify(profilePath));
      expect(first.mcpRegistration).toContain(
        'env = { BALCONY_SYSTEM_ID = "node-a" }',
      );
      expect(first.mcpRegistration).not.toContain("servicebus");
      expect(loadConfigFile(profilePath).systemId).toBe("node-a");
      expect(fs.existsSync(databasePath)).toBe(true);
      const database = new BridgeDatabase(databasePath);
      database.close();

      expect(
        setupLocalProfile({
          configPath: profilePath,
          nodeId: "node-a",
          authorizedNodeIds: ["node-b", "node-c"],
          databasePath,
        }).created,
      ).toBe(false);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("fails without overwriting a mismatched existing profile or database", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "bridge-setup-"));
    const profilePath = path.join(root, "node-a.json");
    const databasePath = path.join(root, "bridge.sqlite3");
    try {
      setupLocalProfile({
        configPath: profilePath,
        nodeId: "node-a",
        authorizedNodeIds: ["node-b"],
        databasePath,
      });
      const original = fs.readFileSync(profilePath);

      expect(() =>
        setupLocalProfile({
          configPath: profilePath,
          nodeId: "node-a",
          authorizedNodeIds: ["node-c"],
          databasePath,
        }),
      ).toThrow(/does not match/);
      expect(fs.readFileSync(profilePath)).toEqual(original);

      const orphanDatabase = path.join(root, "orphan.sqlite3");
      fs.writeFileSync(orphanDatabase, "not a bridge database");
      expect(() =>
        setupLocalProfile({
          configPath: path.join(root, "new.json"),
          nodeId: "node-a",
          authorizedNodeIds: ["node-b"],
          databasePath: orphanDatabase,
        }),
      ).toThrow(/already exists/);
      expect(fs.existsSync(path.join(root, "new.json"))).toBe(false);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("rejects invalid production metadata before creating local files", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "bridge-setup-"));
    const profilePath = path.join(root, "node-a.json");
    const databasePath = path.join(root, "bridge.sqlite3");
    try {
      expect(() =>
        setupLocalProfile({
          configPath: profilePath,
          nodeId: "node-a",
          authorizedNodeIds: ["node-b"],
          databasePath,
          serviceBusNamespace: "approved.servicebus.windows.net",
          azureAuthMode: "client_certificate",
          azureTenantId: "11111111-1111-4111-8111-111111111111",
          azureClientId: "22222222-2222-4222-8222-222222222222",
          azureClientCertificatePath: path.join(root, "missing.pem"),
        }),
      ).toThrow(/certificate/i);
      expect(fs.existsSync(profilePath)).toBe(false);
      expect(fs.existsSync(databasePath)).toBe(false);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("does not remove a database that wins a concurrent creation race", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "bridge-setup-race-"));
    const profilePath = path.join(root, "node-a.json");
    const databasePath = path.join(root, "bridge.sqlite3");
    const openSpy = vi.spyOn(fs, "openSync").mockImplementationOnce(
      ((..._arguments: Parameters<typeof fs.openSync>) => {
        fs.writeFileSync(databasePath, "owned-by-another-setup", "utf8");
        throw Object.assign(new Error("database already exists"), {
          code: "EEXIST",
        });
      }) as typeof fs.openSync,
    );

    try {
      expect(() =>
        setupLocalProfile({
          configPath: profilePath,
          nodeId: "node-a",
          authorizedNodeIds: ["node-b"],
          databasePath,
        }),
      ).toThrow();
      expect(fs.readFileSync(databasePath, "utf8")).toBe(
        "owned-by-another-setup",
      );
      expect(fs.existsSync(profilePath)).toBe(false);
    } finally {
      openSpy.mockRestore();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
