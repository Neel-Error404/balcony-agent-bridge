import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

describe("node identity CLI", () => {
  it("creates one private identity and a shareable public enrollment entry", () => {
    const temporaryRoot = fs.mkdtempSync(
      path.join(os.tmpdir(), "bridge-identity-cli-"),
    );
    const outputDirectory = path.join(temporaryRoot, "node-a");
    try {
      const result = spawnSync(
        process.execPath,
        [
          "--import",
          "tsx",
          path.resolve(import.meta.dirname, "../../src/cli/index.ts"),
          "identity",
          "--node-id",
          "node-a",
          "--output-directory",
          outputDirectory,
        ],
        {
          cwd: path.resolve(import.meta.dirname, "../.."),
          encoding: "utf8",
          env: process.env,
        },
      );

      expect(result.status, result.stderr).toBe(0);
      expect(result.stderr).toBe("");
      const output = JSON.parse(result.stdout) as Record<string, unknown>;
      expect(output).toMatchObject({
        ok: true,
        node_id: "node-a",
        signing_key_path: path.join(outputDirectory, "node-identity.pkcs8.pem"),
        enrollment_path: path.join(outputDirectory, "node-enrollment.json"),
      });
      expect(String(output["key_id"])).toMatch(/^ed25519:[A-Za-z0-9_-]{43}$/);
      expect(output).toHaveProperty("enrollment");
      expect(result.stdout).not.toContain("PRIVATE KEY");
      expect(fs.existsSync(String(output["signing_key_path"]))).toBe(true);
      expect(fs.existsSync(String(output["enrollment_path"]))).toBe(true);

      const retry = spawnSync(
        process.execPath,
        [
          "--import",
          "tsx",
          path.resolve(import.meta.dirname, "../../src/cli/index.ts"),
          "identity",
          "--node-id",
          "node-a",
          "--output-directory",
          outputDirectory,
        ],
        {
          cwd: path.resolve(import.meta.dirname, "../.."),
          encoding: "utf8",
          env: process.env,
        },
      );
      expect(retry.status).toBe(1);
      expect(retry.stdout).toBe("");
      expect(retry.stderr).not.toContain(outputDirectory);
      expect(retry.stderr).not.toContain("PRIVATE KEY");
    } finally {
      fs.rmSync(temporaryRoot, { recursive: true, force: true });
    }
  });
});
