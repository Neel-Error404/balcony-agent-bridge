import {
  createHash,
  createPrivateKey,
  createPublicKey,
  randomUUID,
} from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  NodeIdentityError,
  generateNodeIdentity,
} from "../../src/security/node-identity.js";
import {
  addInheritOnlyReadAccess,
  createSecureIdentityDirectory,
  prepareSecureIdentityDirectory,
} from "../helpers/windows-identity-directory.js";

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

describe("offline node identity generation", () => {
  it("creates a restrictive PKCS8 Ed25519 key and public enrollment entry", () => {
    const outputDirectory = secureIdentityDirectory("bridge-node-identity-");
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
    const outputDirectory = secureIdentityDirectory("bridge-existing-identity-");
    const first = generateNodeIdentity({ nodeId: "node-a", outputDirectory });
    const originalPrivateKey = fs.readFileSync(first.signingKeyPath, "utf8");

    expect(() => generateNodeIdentity({ nodeId: "node-a", outputDirectory })).toThrow(
      expect.objectContaining({
        name: "NodeIdentityError",
        code: "IDENTITY_OUTPUT_EXISTS",
      }),
    );
    expect(fs.readFileSync(first.signingKeyPath, "utf8")).toBe(originalPrivateKey);
  });

  it("rejects relative output directories without leaking filesystem details", () => {
    try {
      generateNodeIdentity({ nodeId: "node-a", outputDirectory: "relative-output" });
      throw new Error("Expected node identity generation to fail");
    } catch (error) {
      expect(error).toBeInstanceOf(NodeIdentityError);
      expect((error as NodeIdentityError).code).toBe(
        "IDENTITY_DIRECTORY_INVALID",
      );
      expect((error as Error).message).not.toContain("relative-output");
    }
  });

  it.skipIf(process.platform !== "win32")(
    "rejects a missing Windows directory before writing a private key",
    () => {
      const outputDirectory = temporaryDirectory("missing-identity");

      expect(() =>
        generateNodeIdentity({ nodeId: "node-a", outputDirectory }),
      ).toThrow(
        expect.objectContaining({ code: "IDENTITY_DIRECTORY_MISSING" }),
      );
      expect(fs.existsSync(outputDirectory)).toBe(false);
    },
  );

  it.skipIf(process.platform !== "win32")(
    "rejects an inherited Windows directory before writing a private key",
    () => {
      const outputDirectory = temporaryDirectory("inherited-identity");
      fs.mkdirSync(outputDirectory, { recursive: true });

      expect(() =>
        generateNodeIdentity({ nodeId: "node-a", outputDirectory }),
      ).toThrow(expect.objectContaining({ code: "IDENTITY_ACL_UNSAFE" }));
      expect(fs.existsSync(path.join(outputDirectory, "node-identity.pkcs8.pem"))).toBe(
        false,
      );
    },
  );

  it.skipIf(process.platform !== "win32")(
    "rejects child-only read access before writing a private key",
    () => {
      const outputDirectory = secureIdentityDirectory("bridge-inherited-read-");
      addInheritOnlyReadAccess(outputDirectory);

      expect(() =>
        generateNodeIdentity({ nodeId: "node-a", outputDirectory }),
      ).toThrow(NodeIdentityError);
      expect(fs.existsSync(path.join(outputDirectory, "node-identity.pkcs8.pem"))).toBe(
        false,
      );
    },
  );

  it.skipIf(process.platform !== "win32")(
    "rejects a restricted directory reached through a junction ancestor",
    () => {
      const actualRoot = secureIdentityDirectory("bridge-junction-target-");
      const directOutput = path.join(actualRoot, "direct");
      const junctionOutput = path.join(actualRoot, "through-junction");
      const programData = process.env["ProgramData"]!;
      const junctionPath = path.join(
        programData,
        `bridge-junction-link-${randomUUID()}`,
      );
      prepareSecureIdentityDirectory(directOutput);
      prepareSecureIdentityDirectory(junctionOutput);
      fs.symlinkSync(actualRoot, junctionPath, "junction");
      temporaryDirectories.unshift(junctionPath);

      expect(
        generateNodeIdentity({ nodeId: "node-a", outputDirectory: directOutput }),
      ).toMatchObject({ keyId: expect.stringMatching(/^ed25519:/) });

      expect(() =>
        generateNodeIdentity({
          nodeId: "node-a",
          outputDirectory: path.join(junctionPath, "through-junction"),
        }),
      ).toThrow(NodeIdentityError);
      expect(
        fs.existsSync(path.join(junctionOutput, "node-identity.pkcs8.pem")),
      ).toBe(false);
    },
  );

  it.skipIf(process.platform === "win32")(
    "creates a missing absolute output directory outside Windows",
    () => {
      const outputDirectory = temporaryDirectory("missing-posix-identity");

      const result = generateNodeIdentity({ nodeId: "node-a", outputDirectory });

      expect(fs.statSync(outputDirectory).isDirectory()).toBe(true);
      expect(fs.statSync(result.signingKeyPath).mode & 0o077).toBe(0);
    },
  );
});

function temporaryDirectory(name: string): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "bridge-node-identity-"));
  temporaryDirectories.push(root);
  return path.join(root, name);
}

function secureIdentityDirectory(prefix: string): string {
  const directory = createSecureIdentityDirectory(prefix);
  temporaryDirectories.push(directory);
  return directory;
}
