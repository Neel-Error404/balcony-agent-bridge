import { createHash, generateKeyPairSync } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { SystemIdSchema, type SystemId } from "../contracts/envelope.js";

const PRIVATE_KEY_FILE = "node-identity.pkcs8.pem";
const ENROLLMENT_FILE = "node-enrollment.json";

export interface GenerateNodeIdentityOptions {
  nodeId: SystemId;
  outputDirectory: string;
}

export interface PublicNodeEnrollment {
  node_id: SystemId;
  key_id: string;
  spki_der_base64url: string;
  status: "active";
}

export interface GeneratedNodeIdentity {
  signingKeyPath: string;
  enrollmentPath: string;
  keyId: string;
  enrollment: PublicNodeEnrollment;
}

export class NodeIdentityError extends Error {
  public constructor() {
    super("Node identity generation rejected.");
    this.name = "NodeIdentityError";
  }
}

export function generateNodeIdentity(
  options: GenerateNodeIdentityOptions,
): GeneratedNodeIdentity {
  try {
    const nodeId = SystemIdSchema.parse(options.nodeId);
    const outputDirectory = prepareOutputDirectory(options.outputDirectory);
    const signingKeyPath = path.join(outputDirectory, PRIVATE_KEY_FILE);
    const enrollmentPath = path.join(outputDirectory, ENROLLMENT_FILE);
    assertOutputMissing(signingKeyPath);
    assertOutputMissing(enrollmentPath);

    const pair = generateKeyPairSync("ed25519");
    const privateKeyPem = pair.privateKey.export({
      format: "pem",
      type: "pkcs8",
    }) as string;
    const spkiDer = pair.publicKey.export({
      format: "der",
      type: "spki",
    }) as Buffer;
    const keyId = deriveEd25519KeyId(spkiDer);
    const enrollment: PublicNodeEnrollment = {
      node_id: nodeId,
      key_id: keyId,
      spki_der_base64url: spkiDer.toString("base64url"),
      status: "active",
    };

    let createdPrivateKey = false;
    try {
      fs.writeFileSync(signingKeyPath, privateKeyPem, {
        encoding: "utf8",
        mode: 0o600,
        flag: "wx",
      });
      fs.chmodSync(signingKeyPath, 0o600);
      createdPrivateKey = true;
      fs.writeFileSync(enrollmentPath, `${JSON.stringify(enrollment, null, 2)}\n`, {
        encoding: "utf8",
        mode: 0o600,
        flag: "wx",
      });
    } catch (error) {
      if (createdPrivateKey) {
        try {
          fs.rmSync(signingKeyPath, { force: true });
        } catch {
          throw new NodeIdentityError();
        }
      }
      throw error;
    }

    return { signingKeyPath, enrollmentPath, keyId, enrollment };
  } catch (error) {
    if (error instanceof NodeIdentityError) {
      throw error;
    }
    throw new NodeIdentityError();
  }
}

export function deriveEd25519KeyId(spkiDer: Buffer): string {
  return `ed25519:${createHash("sha256").update(spkiDer).digest("base64url")}`;
}

function prepareOutputDirectory(outputDirectory: string): string {
  if (!path.isAbsolute(outputDirectory)) {
    throw new NodeIdentityError();
  }
  const resolved = path.resolve(outputDirectory);
  const existing = lstatIfPresent(resolved);
  if (existing) {
    if (!existing.isDirectory() || existing.isSymbolicLink()) {
      throw new NodeIdentityError();
    }
  } else {
    fs.mkdirSync(resolved, { recursive: true, mode: 0o700 });
  }
  const created = fs.lstatSync(resolved);
  if (!created.isDirectory() || created.isSymbolicLink()) {
    throw new NodeIdentityError();
  }
  return resolved;
}

function assertOutputMissing(filePath: string): void {
  if (lstatIfPresent(filePath)) {
    throw new NodeIdentityError();
  }
}

function lstatIfPresent(filePath: string): fs.Stats | undefined {
  try {
    return fs.lstatSync(filePath);
  } catch (error) {
    if (
      error &&
      typeof error === "object" &&
      "code" in error &&
      error.code === "ENOENT"
    ) {
      return undefined;
    }
    throw error;
  }
}
