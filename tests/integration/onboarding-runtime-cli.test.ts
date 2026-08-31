import { createHash, generateKeyPairSync } from "node:crypto";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  exportPublicEnrollment,
  generateOnboardingIdentity,
  importPublicEnrollment,
  startOnboarding,
  writeMembershipPolicy,
} from "../../src/onboarding/index.js";

const repositoryRoot = path.resolve(import.meta.dirname, "../..");
const cliSource = path.join(repositoryRoot, "src", "cli", "index.ts");
const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

describe("onboarding foreground runtime gate", () => {
  it("rejects a runtime launched for a different process identity", () => {
    const root = completeOnboarding();
    const result = runRuntime(root, "node-b");

    expect(result.status).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr.trim()).toBe(
      "runtime failed (CONFIGURATION_ERROR)",
    );
  }, 45_000);

  it("rejects changed membership before exposing runtime paths", () => {
    const root = completeOnboarding();
    fs.writeFileSync(
      path.join(root, "membership.json"),
      `${JSON.stringify({ schema_version: "1.0", network_id: "tampered", nodes: [] })}\n`,
    );

    const result = runRuntime(root, "node-a");

    expect(result.status).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr.trim()).toBe(
      "runtime failed (STATE_TRANSITION_ERROR)",
    );
  }, 45_000);
});

function completeOnboarding(): string {
  const parent = process.platform === "win32"
    ? process.env["ProgramData"]!
    : os.tmpdir();
  const root = fs.mkdtempSync(path.join(parent, "balcony-runtime-cli-"));
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
  const peerPath = path.join(root, "node-b.json");
  fs.writeFileSync(peerPath, exportPublicEnrollment(peer).json);
  importPublicEnrollment({
    manifestPath: manifest.manifestPath,
    inputPath: peerPath,
    expectedPeerId: "node-b",
  });
  writeMembershipPolicy(manifest.manifestPath);
  return root;
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

function runRuntime(root: string, processIdentity: string) {
  return spawnSync(
    process.execPath,
    ["--import", "tsx", cliSource, "runtime", "bridge", "--root", root, "--validate"],
    {
      cwd: repositoryRoot,
      encoding: "utf8",
      env: { ...process.env, BALCONY_SYSTEM_ID: processIdentity },
      timeout: 30_000,
      windowsHide: true,
    },
  );
}
