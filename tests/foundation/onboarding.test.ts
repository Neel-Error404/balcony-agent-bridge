import { createHash, generateKeyPairSync } from "node:crypto";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  buildMembershipPolicy,
  exportPublicEnrollment,
  exportEnrollmentFile,
  exportOnboardingEnrollment,
  generateOnboardingIdentity,
  importPublicEnrollment,
  prepareIdentityDirectory,
  startOnboarding as startOnboardingRaw,
  statusOnboarding,
  resumeOnboarding,
  writeMembershipPolicy,
} from "../../src/onboarding/index.js";
import { loadMessageAuthenticator } from "../../src/security/message-authentication.js";

const roots: string[] = [];

function startOnboarding(
  input: Parameters<typeof startOnboardingRaw>[0],
) {
  return startOnboardingRaw({
    ...input,
    identityDirectory: path.join(input.root, "identity"),
  });
}

afterEach(() => {
  for (const root of roots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

describe("npm-first onboarding", () => {
  it("rejects invalid start inputs before writing", () => {
    const root = temporaryRoot();

    expect(() =>
      startOnboarding({
        root,
        nodeId: "node-a",
        processIdentity: "node-b",
        networkId: "engineering",
        authorizedNodeIds: ["node-c"],
      }),
    ).toThrowError(expect.objectContaining({ code: "PROCESS_IDENTITY_MISMATCH" }));
    expect(fs.readdirSync(root)).toEqual([]);
  });

  it.each([
    ["unsorted", ["node-c", "node-b"]],
    ["duplicate", ["node-b", "node-b"]],
    ["local peer", ["node-a"]],
  ])("rejects %s peer input before writing", (_label, authorizedNodeIds) => {
    const root = temporaryRoot();
    expect(() => startOnboarding({
      root,
      nodeId: "node-a",
      processIdentity: "node-a",
      networkId: "engineering",
      authorizedNodeIds,
    })).toThrowError(expect.objectContaining({ code: "ONBOARDING_INPUT_INVALID" }));
    expect(fs.readdirSync(root)).toEqual([]);
  });

  it("creates an idempotent manifest with sorted remote peers", () => {
    const root = temporaryRoot();
    const first = startOnboarding({
      root,
      nodeId: "node-a",
      processIdentity: "node-a",
      networkId: "engineering",
      authorizedNodeIds: ["node-b", "node-c"],
    });
    const second = startOnboarding({
      root,
      nodeId: "node-a",
      processIdentity: "node-a",
      networkId: "engineering",
      authorizedNodeIds: ["node-b", "node-c"],
    });

    expect(second).toEqual(first);
    expect(first.status).toBe("pending");
    expect(JSON.stringify(first)).not.toMatch(/PRIVATE KEY|private_key/iu);
  });

  it("exports deterministic public enrollment and imports exact peers", () => {
    const root = temporaryRoot();
    const manifest = startOnboarding({
      root,
      nodeId: "node-a",
      processIdentity: "node-a",
      networkId: "engineering",
      authorizedNodeIds: ["node-b", "node-c"],
    });
    const enrollment = PEER_ENROLLMENTS["node-b"];
    const exported = exportPublicEnrollment(enrollment);
    expect(exported.json).toBe(
      `{"key_id":"${enrollment.key_id}","network_id":"engineering","node_id":"${enrollment.node_id}",` +
        `"schema_version":"1.0",` +
        `"spki_der_base64url":"${enrollment.spki_der_base64url}","status":"active"}\n`,
    );

    const inputPath = path.join(root, "node-b.json");
    fs.writeFileSync(inputPath, exported.json);
    const imported = importPublicEnrollment({
      manifestPath: manifest.manifestPath,
      inputPath,
      expectedPeerId: "node-b",
    });
    expect(imported.enrollments["node-b"]).toEqual(enrollment);
    expect(importPublicEnrollment({
      manifestPath: manifest.manifestPath,
      inputPath,
      expectedPeerId: "node-b",
    })).toEqual(imported);
    const exportPath = path.join(root, "node-b-copy.json");
    expect(exportEnrollmentFile(inputPath, exportPath)).toEqual(
      exportEnrollmentFile(inputPath, exportPath),
    );
  });

  it("builds v0.2-compatible deterministic membership", () => {
    const root = temporaryRoot();
    const manifest = startOnboarding({
      root,
      nodeId: "node-a",
      processIdentity: "node-a",
      networkId: "engineering",
      authorizedNodeIds: ["node-b", "node-c"],
    });
    const withPeers = {
      ...manifest,
      enrollments: {
        "node-b": PEER_ENROLLMENTS["node-b"],
        "node-c": PEER_ENROLLMENTS["node-c"],
      },
    };
    const membership = buildMembershipPolicy(withPeers);
    expect(membership).toEqual({
      schema_version: "1.0",
      network_id: "engineering",
      peers: [
        { node_id: "node-b", keys: [membershipKey(PEER_ENROLLMENTS["node-b"]) ] },
        { node_id: "node-c", keys: [membershipKey(PEER_ENROLLMENTS["node-c"]) ] },
      ],
    });
  });

  it("writes membership accepted by the existing v0.2 authenticator", () => {
    const root = temporaryRoot();
    const manifest = startOnboarding({
      root,
      nodeId: "node-a",
      processIdentity: "node-a",
      networkId: "engineering",
      authorizedNodeIds: ["node-b", "node-c"],
    });
    for (const peerId of ["node-b", "node-c"] as const) {
      const inputPath = path.join(root, `${peerId}.json`);
      fs.writeFileSync(inputPath, exportPublicEnrollment(PEER_ENROLLMENTS[peerId]).json);
      importPublicEnrollment({ manifestPath: manifest.manifestPath, inputPath, expectedPeerId: peerId });
    }
    const updated = writeMembershipPolicy(manifest.manifestPath);
    expect(writeMembershipPolicy(manifest.manifestPath)).toEqual(updated);
    const localPair = generateKeyPairSync("ed25519");
    const localKeyPath = path.join(root, "local-signing-key.pem");
    fs.writeFileSync(localKeyPath, localPair.privateKey.export({ format: "pem", type: "pkcs8" }), { mode: 0o600 });

    expect(() => loadMessageAuthenticator({
      localNodeId: updated.node_id,
      authorizedNodeIds: updated.authorized_node_ids,
      membershipPath: updated.membership_path,
      signingKeyPath: localKeyPath,
    })).not.toThrow();
  });

  it("reports artifact tampering as blocked without exposing private data", () => {
    const root = temporaryRoot();
    const manifest = startOnboarding({
      root,
      nodeId: "node-a",
      processIdentity: "node-a",
      networkId: "engineering",
      authorizedNodeIds: ["node-b"],
    });
    fs.writeFileSync(manifest.manifestPath, "{}\n");

    expect(() => statusOnboarding(manifest.manifestPath)).toThrowError(
      expect.objectContaining({ code: "MANIFEST_INVALID" }),
    );
  });

  it("resumes to complete only after identity, peer enrollment, and membership validate", () => {
    const root = temporaryRoot();
    const manifest = startOnboarding({
      root,
      nodeId: "node-a",
      processIdentity: "node-a",
      networkId: "engineering",
      authorizedNodeIds: ["node-b"],
    });
    const withIdentity = generateOnboardingIdentity({ manifestPath: manifest.manifestPath });
    const inputPath = path.join(root, "node-b.json");
    fs.writeFileSync(inputPath, exportPublicEnrollment(PEER_ENROLLMENTS["node-b"]).json);
    importPublicEnrollment({ manifestPath: withIdentity.manifestPath, inputPath, expectedPeerId: "node-b" });
    writeMembershipPolicy(manifest.manifestPath);

    expect(resumeOnboarding(manifest.manifestPath).status).toBe("complete");
    fs.rmSync(path.join(root, "enrollments", "node-b.json"));
    expect(statusOnboarding(manifest.manifestPath).status).toBe("blocked");
  }, 20_000);

  it("resumes identity generation without replacing an existing private key", () => {
    const root = temporaryRoot();
    const manifest = startOnboarding({
      root,
      nodeId: "node-a",
      processIdentity: "node-a",
      networkId: "engineering",
      authorizedNodeIds: ["node-b"],
    });
    const first = generateOnboardingIdentity({ manifestPath: manifest.manifestPath });
    const privateKeyBefore = fs.readFileSync(first.signing_key_path);

    const second = generateOnboardingIdentity({ manifestPath: manifest.manifestPath });

    expect(second.local_enrollment).toEqual(first.local_enrollment);
    expect(fs.readFileSync(second.signing_key_path)).toEqual(privateKeyBefore);
  });

  it("refuses to export a substituted local public enrollment", () => {
    const root = temporaryRoot();
    const manifest = startOnboarding({
      root,
      nodeId: "node-a",
      processIdentity: "node-a",
      networkId: "engineering",
      authorizedNodeIds: ["node-b"],
    });
    const generated = generateOnboardingIdentity({
      manifestPath: manifest.manifestPath,
    });
    const attacker = generateKeyPairSync("ed25519");
    const attackerPublic = attacker.publicKey.export({
      format: "der",
      type: "spki",
    }) as Buffer;
    fs.writeFileSync(
      generated.local_enrollment_path,
      exportPublicEnrollment({
        schema_version: "1.0",
        network_id: generated.network_id,
        node_id: generated.node_id,
        key_id: `ed25519:${createHash("sha256").update(attackerPublic).digest("base64url")}`,
        spki_der_base64url: attackerPublic.toString("base64url"),
        status: "active",
      }).json,
    );
    const outputPath = path.join(root, "public.json");

    expect(() => exportOnboardingEnrollment(
      manifest.manifestPath,
      outputPath,
    )).toThrow(expect.objectContaining({ code: "IDENTITY_CONFLICT" }));
    expect(fs.existsSync(outputPath)).toBe(false);
  });

  it.skipIf(process.platform !== "win32")(
    "revalidates ancestor ACLs before reusing an existing private key",
    () => {
      const root = temporaryRoot();
      const manifest = startOnboarding({
        root,
        nodeId: "node-a",
        processIdentity: "node-a",
        networkId: "engineering",
        authorizedNodeIds: ["node-b"],
      });
      generateOnboardingIdentity({ manifestPath: manifest.manifestPath });
      const icacls = path.join(
        process.env["SystemRoot"]!,
        "System32",
        "icacls.exe",
      );
      const grant = spawnSync(
        icacls,
        [root, "/grant", "*S-1-5-11:(OI)(CI)(M)"],
        { encoding: "utf8", windowsHide: true },
      );
      expect(grant.status).toBe(0);
      try {
        expect(() => generateOnboardingIdentity({
          manifestPath: manifest.manifestPath,
        })).toThrow(expect.objectContaining({
          code: "IDENTITY_PREPARATION_FAILED",
        }));
      } finally {
        spawnSync(icacls, [root, "/remove:g", "*S-1-5-11"], {
          encoding: "utf8",
          windowsHide: true,
        });
      }
    },
    20_000,
  );

  it("prepares a non-Windows identity directory with owner-only permissions", () => {
    if (process.platform === "win32") return;
    const root = temporaryRoot();
    const directory = path.join(root, "identity");

    const prepared = prepareIdentityDirectory(directory);

    expect(prepared).toBe(path.resolve(directory));
    expect(fs.statSync(directory).mode & 0o077).toBe(0);
  });

  it("rejects a new onboarding root reached through a reparse ancestor", () => {
    const parent = temporaryRoot();
    const target = path.join(parent, "target");
    const redirectedParent = path.join(parent, "redirected");
    fs.mkdirSync(target);
    fs.symlinkSync(
      target,
      redirectedParent,
      process.platform === "win32" ? "junction" : "dir",
    );
    const redirectedRoot = path.join(redirectedParent, "pilot");

    expect(() => startOnboarding({
      root: redirectedRoot,
      nodeId: "node-a",
      processIdentity: "node-a",
      networkId: "engineering",
      authorizedNodeIds: ["node-b"],
    })).toThrow(expect.objectContaining({ code: "ONBOARDING_ROOT_INVALID" }));
    expect(fs.existsSync(path.join(redirectedRoot, "onboarding-manifest.json"))).toBe(false);
  });

  it("rejects an onboarding root replaced by a reparse point after setup", () => {
    const root = temporaryRoot();
    const manifest = startOnboarding({
      root,
      nodeId: "node-a",
      processIdentity: "node-a",
      networkId: "engineering",
      authorizedNodeIds: ["node-b"],
    });
    const target = `${root}-target`;
    fs.renameSync(root, target);
    roots.push(target);
    fs.symlinkSync(
      target,
      root,
      process.platform === "win32" ? "junction" : "dir",
    );

    expect(() => statusOnboarding(manifest.manifestPath)).toThrow(
      expect.objectContaining({ code: "ONBOARDING_ROOT_INVALID" }),
    );
  });

  it("rejects enrollment with unknown/private fields", () => {
    const root = temporaryRoot();
    const manifest = startOnboarding({
      root,
      nodeId: "node-a",
      processIdentity: "node-a",
      networkId: "engineering",
      authorizedNodeIds: ["node-b"],
    });
    const inputPath = path.join(root, "bad.json");
    fs.writeFileSync(
      inputPath,
      JSON.stringify({ ...PEER_ENROLLMENTS["node-b"], private_key: "PEM" }),
    );

    expect(() =>
      importPublicEnrollment({
        manifestPath: manifest.manifestPath,
        inputPath,
        expectedPeerId: "node-b",
      }),
    ).toThrowError(expect.objectContaining({ code: "ENROLLMENT_INVALID" }));
  });

  it("fails closed without replacing a changed peer enrollment artifact", () => {
    const root = temporaryRoot();
    const manifest = startOnboarding({
      root,
      nodeId: "node-a",
      processIdentity: "node-a",
      networkId: "engineering",
      authorizedNodeIds: ["node-b"],
    });
    const inputPath = path.join(root, "node-b.json");
    fs.writeFileSync(inputPath, exportPublicEnrollment(PEER_ENROLLMENTS["node-b"]).json);
    importPublicEnrollment({
      manifestPath: manifest.manifestPath,
      inputPath,
      expectedPeerId: "node-b",
    });
    const storedPath = path.join(root, "enrollments", "node-b.json");
    const changed = `${JSON.stringify(makeEnrollment("node-b"))}\n`;
    fs.writeFileSync(storedPath, changed);

    expect(() => importPublicEnrollment({
      manifestPath: manifest.manifestPath,
      inputPath,
      expectedPeerId: "node-b",
    })).toThrow(expect.objectContaining({ code: "ENROLLMENT_CONFLICT" }));
    expect(fs.readFileSync(storedPath, "utf8")).toBe(changed);
  });

  it("adopts an exact peer enrollment orphaned before its manifest update", () => {
    const root = temporaryRoot();
    const manifest = startOnboarding({
      root,
      nodeId: "node-a",
      processIdentity: "node-a",
      networkId: "engineering",
      authorizedNodeIds: ["node-b"],
    });
    const inputPath = path.join(root, "node-b.json");
    const exact = exportPublicEnrollment(PEER_ENROLLMENTS["node-b"]).json;
    fs.writeFileSync(inputPath, exact);
    const enrollmentDirectory = path.join(root, "enrollments");
    prepareIdentityDirectory(enrollmentDirectory);
    fs.writeFileSync(path.join(enrollmentDirectory, "node-b.json"), exact, {
      flag: "wx",
      mode: 0o600,
    });

    const recovered = importPublicEnrollment({
      manifestPath: manifest.manifestPath,
      inputPath,
      expectedPeerId: "node-b",
    });

    expect(recovered.enrollments["node-b"]).toEqual(PEER_ENROLLMENTS["node-b"]);
    expect(recovered.artifact_sha256["enrollment:node-b"]).toMatch(/^[a-f0-9]{64}$/u);
  });

  it("fails closed without replacing a changed membership artifact", () => {
    const root = temporaryRoot();
    const manifest = startOnboarding({
      root,
      nodeId: "node-a",
      processIdentity: "node-a",
      networkId: "engineering",
      authorizedNodeIds: ["node-b"],
    });
    const inputPath = path.join(root, "node-b.json");
    fs.writeFileSync(inputPath, exportPublicEnrollment(PEER_ENROLLMENTS["node-b"]).json);
    importPublicEnrollment({
      manifestPath: manifest.manifestPath,
      inputPath,
      expectedPeerId: "node-b",
    });
    writeMembershipPolicy(manifest.manifestPath);
    const membershipPath = path.join(root, "membership.json");
    const changed = "{}\n";
    fs.writeFileSync(membershipPath, changed);

    expect(() => writeMembershipPolicy(manifest.manifestPath)).toThrow(
      expect.objectContaining({ code: "MEMBERSHIP_INVALID" }),
    );
    expect(fs.readFileSync(membershipPath, "utf8")).toBe(changed);
  });

  it("rejects a peer enrollment from a different network", () => {
    const root = temporaryRoot();
    const manifest = startOnboarding({
      root,
      nodeId: "node-a",
      processIdentity: "node-a",
      networkId: "engineering",
      authorizedNodeIds: ["node-b"],
    });
    const inputPath = path.join(root, "wrong-network.json");
    fs.writeFileSync(
      inputPath,
      exportPublicEnrollment({
        ...PEER_ENROLLMENTS["node-b"],
        network_id: "other-network",
      }).json,
    );

    expect(() => importPublicEnrollment({
      manifestPath: manifest.manifestPath,
      inputPath,
      expectedPeerId: "node-b",
    })).toThrowError(expect.objectContaining({ code: "ENROLLMENT_INVALID" }));
  });

  it.each([
    ["peer node binding", { node_id: "node-c" }],
    ["peer network binding", { network_id: "other-network" }],
  ])("rejects manifest tampering that violates %s", (_name, change) => {
    const root = temporaryRoot();
    const manifest = startOnboarding({
      root,
      nodeId: "node-a",
      processIdentity: "node-a",
      networkId: "engineering",
      authorizedNodeIds: ["node-b"],
    });
    const inputPath = path.join(root, "node-b.json");
    fs.writeFileSync(inputPath, exportPublicEnrollment(PEER_ENROLLMENTS["node-b"]).json);
    importPublicEnrollment({
      manifestPath: manifest.manifestPath,
      inputPath,
      expectedPeerId: "node-b",
    });
    const tampered = JSON.parse(fs.readFileSync(manifest.manifestPath, "utf8"));
    tampered.enrollments["node-b"] = {
      ...PEER_ENROLLMENTS["node-b"],
      ...change,
    };
    fs.writeFileSync(manifest.manifestPath, `${JSON.stringify(tampered, null, 2)}\n`);

    expect(() => statusOnboarding(manifest.manifestPath)).toThrow(
      expect.objectContaining({ code: "MANIFEST_INVALID" }),
    );
    expect(() => writeMembershipPolicy(manifest.manifestPath)).toThrow(
      expect.objectContaining({ code: "MANIFEST_INVALID" }),
    );
  });
});

function temporaryRoot(): string {
  const parent = process.platform === "win32"
    ? process.env["ProgramData"]!
    : os.tmpdir();
  const root = fs.mkdtempSync(path.join(parent, "balcony-onboarding-"));
  roots.push(root);
  return root;
}

function makeEnrollment(nodeId: "node-b" | "node-c") {
  const pair = generateKeyPairSync("ed25519");
  const publicDer = pair.publicKey.export({ format: "der", type: "spki" }) as Buffer;
  return {
    schema_version: "1.0" as const,
    network_id: "engineering",
    node_id: nodeId,
    key_id: `ed25519:${createHash("sha256").update(publicDer).digest("base64url")}`,
    spki_der_base64url: publicDer.toString("base64url"),
    status: "active" as const,
  };
}

const PEER_ENROLLMENTS = {
  "node-b": makeEnrollment("node-b"),
  "node-c": makeEnrollment("node-c"),
};

function membershipKey(value: (typeof PEER_ENROLLMENTS)["node-b"]) {
  return {
    key_id: value.key_id,
    spki_der_base64url: value.spki_der_base64url,
    status: value.status,
  };
}
