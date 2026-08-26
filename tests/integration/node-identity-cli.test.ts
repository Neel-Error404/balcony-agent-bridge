import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { createSecureIdentityDirectory } from "../helpers/windows-identity-directory.js";

describe("node identity CLI", () => {
  it(
    "rejects a node ID that differs from the process identity before writing",
    () => {
      const outputDirectory = createSecureIdentityDirectory(
        "bridge-identity-mismatch-",
      );
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
            env: {
              ...process.env,
              BALCONY_SYSTEM_ID: "node-b",
            },
          },
        );

        expect(result.status).toBe(1);
        expect(result.stdout).toBe("");
        expect(result.stderr.trim()).toBe(
          "identity failed (CONFIGURATION_ERROR)",
        );
        expect(result.stderr).not.toContain("node-a");
        expect(result.stderr).not.toContain("node-b");
        expect(result.stderr).not.toContain(outputDirectory);
        expect(fs.readdirSync(outputDirectory)).toEqual([]);
      } finally {
        fs.rmSync(outputDirectory, { recursive: true, force: true });
      }
    },
    30_000,
  );

  it("creates one private identity and a shareable public enrollment entry", () => {
    const outputDirectory = createSecureIdentityDirectory("bridge-identity-cli-");
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
          env: {
            ...process.env,
            BALCONY_SYSTEM_ID: "node-a",
          },
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
          env: {
            ...process.env,
            BALCONY_SYSTEM_ID: "node-a",
          },
        },
      );
      expect(retry.status).toBe(1);
      expect(retry.stdout).toBe("");
      expect(retry.stderr).toContain("IDENTITY_OUTPUT_EXISTS");
      expect(retry.stderr).not.toContain(outputDirectory);
      expect(retry.stderr).not.toContain("PRIVATE KEY");
    } finally {
      fs.rmSync(outputDirectory, { recursive: true, force: true });
    }
  }, 20_000);
});
