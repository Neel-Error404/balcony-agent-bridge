import { createHash, createPrivateKey, createPublicKey } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  NodeIdentityError,
  generateNodeIdentity,
} from "../../src/security/node-identity.js";

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

describe("offline node identity generation", () => {
  it("creates a restrictive PKCS8 Ed25519 key and public enrollment entry", () => {
    const outputDirectory = temporaryDirectory("new-identity");
    const result = generateNodeIdentity({ nodeId: "node-a", outputDirectory });
    const enrollment = JSON.parse(fs.readFileSync(result.enrollmentPath, "utf8")) as {
      node_id: string;
      key_id: string;
      spki_der_base64url: string;
      status: string;
    };
    const privateKey = createPrivateKey(fs.readFileSync(result.signingKeyPath, "utf8"));
    const publicDer = createPublicKey(privateKey).export({
      format: "der",
      type: "spki",
    }) as Buffer;
    const expectedKeyId = `ed25519:${createHash("sha256")
      .update(publicDer)
      .digest("base64url")}`;

    expect(privateKey.asymmetricKeyType).toBe("ed25519");
    if (process.platform !== "win32") {
      expect(fs.statSync(result.signingKeyPath).mode & 0o077).toBe(0);
    }
    expect(enrollment).toEqual({
      node_id: "node-a",
      key_id: expectedKeyId,
      spki_der_base64url: publicDer.toString("base64url"),
      status: "active",
    });
    expect(result).toEqual({
      signingKeyPath: result.signingKeyPath,
      enrollmentPath: result.enrollmentPath,
      keyId: expectedKeyId,
      enrollment,
    });
    expect(JSON.stringify(result)).not.toContain("PRIVATE KEY");
  });

  it("fails closed rather than overwriting existing identity outputs", () => {
    const outputDirectory = temporaryDirectory("existing-identity");
    const first = generateNodeIdentity({ nodeId: "node-a", outputDirectory });
    const originalPrivateKey = fs.readFileSync(first.signingKeyPath, "utf8");

    expect(() => generateNodeIdentity({ nodeId: "node-a", outputDirectory })).toThrow(
      NodeIdentityError,
    );
    expect(fs.readFileSync(first.signingKeyPath, "utf8")).toBe(originalPrivateKey);
  });

  it("rejects relative output directories without leaking filesystem details", () => {
    try {
      generateNodeIdentity({ nodeId: "node-a", outputDirectory: "relative-output" });
      throw new Error("Expected node identity generation to fail");
    } catch (error) {
      expect(error).toBeInstanceOf(NodeIdentityError);
      expect((error as Error).message).not.toContain("relative-output");
    }
  });
});

function temporaryDirectory(name: string): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "bridge-node-identity-"));
  temporaryDirectories.push(root);
  return path.join(root, name);
}
