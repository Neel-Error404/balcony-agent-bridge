import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { loadConfigFile, parseLocalBridgeProfile } from "../../src/config.js";
import { ConfigurationError } from "../../src/errors.js";

describe("local bridge profile", () => {
  it("loads an explicit local profile without merging process environment", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "bridge-profile-"));
    const profilePath = path.join(root, "node-a.json");
    try {
      fs.writeFileSync(
        profilePath,
        JSON.stringify({
          nodeId: "node-a",
          authorizedNodeIds: ["node-b", "node-c"],
          databasePath: path.join(root, "bridge.sqlite3"),
          topicName: "agent-messages",
          subscriptionName: "node-a",
        }),
      );

      expect(loadConfigFile(profilePath)).toMatchObject({
        systemId: "node-a",
        authorizedNodeIds: ["node-b", "node-c"],
        databasePath: path.join(root, "bridge.sqlite3"),
        topicName: "agent-messages",
        subscriptionName: "node-a",
      });
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("rejects relative paths and malformed local profiles", () => {
    expect(() => loadConfigFile("node-a.json")).toThrow(ConfigurationError);
  });

  it("allows system-assigned managed identity without a client identifier", () => {
    const profile = parseLocalBridgeProfile({
      nodeId: "node-a",
      authorizedNodeIds: ["node-b"],
      databasePath: path.resolve("bridge.sqlite3"),
      topicName: "agent-messages",
      subscriptionName: "node-a",
      serviceBusNamespace: "example.servicebus.windows.net",
      azureAuthMode: "managed_identity",
    });

    expect(profile.managedIdentityClientId).toBeUndefined();
  });
});
