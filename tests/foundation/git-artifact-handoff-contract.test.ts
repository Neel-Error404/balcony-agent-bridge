import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const repositoryRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);
const releaseDirectory = path.join(
  repositoryRoot,
  "transfers",
  "releases",
  "2026",
  "08",
  "2026-08-23--sys-a-to-sys-b--codex-skills--r01",
);

describe("Git-pinned skill artifact handoff", () => {
  it("binds the release envelope to the authoritative archive", () => {
    expect(fs.readdirSync(releaseDirectory).sort()).toEqual([
      "payload.zip",
      "release.json",
    ]);
    const release = JSON.parse(
      fs.readFileSync(path.join(releaseDirectory, "release.json"), "utf8"),
    ) as {
      schema_version: string;
      handoff_protocol: string;
      release_id: string;
      release_date_utc: string;
      origin_system: string;
      target_system: string;
      archive: {
        file_name: string;
        sha256: string;
        byte_length: number;
        zip_entry_count: number;
        file_entry_count: number;
        payload_file_count: number;
        uncompressed_byte_length: number;
      };
      skills: { codex: string[]; agents: string[] };
      install_policy: {
        collision: string;
        require_git_commit_pin: boolean;
        require_target_system_identity: boolean;
      };
      declared_name_exceptions: Array<{
        surface: string;
        directory: string;
        declared_name: string;
      }>;
    };
    const archivePath = path.join(releaseDirectory, release.archive.file_name);
    const archiveBytes = fs.readFileSync(archivePath);

    expect(release.schema_version).toBe("balcony-artifact-release.v1");
    expect(release.handoff_protocol).toBe("balcony-git-artifact-handoff.v1");
    expect(release.release_id).toBe(
      "2026-08-23--sys-a-to-sys-b--codex-skills--r01",
    );
    expect(release.release_date_utc).toBe("2026-08-23");
    expect(release.origin_system).toBe("SYS-A");
    expect(release.target_system).toBe("SYS-B");
    expect(release.archive.file_name).toBe("payload.zip");
    expect(crypto.createHash("sha256").update(archiveBytes).digest("hex").toUpperCase()).toBe(
      release.archive.sha256,
    );
    expect(archiveBytes.byteLength).toBe(release.archive.byte_length);
    expect(release.archive).toMatchObject({
      zip_entry_count: 64,
      file_entry_count: 62,
      payload_file_count: 59,
      uncompressed_byte_length: 245248,
    });
    expect(release.skills.codex).toHaveLength(18);
    expect(release.skills.agents).toHaveLength(8);
    expect(new Set(release.skills.codex).size).toBe(18);
    expect(new Set(release.skills.agents).size).toBe(8);
    expect(release.install_policy).toEqual({
      collision: "accept-identical-or-fail",
      require_git_commit_pin: true,
      require_target_system_identity: true,
    });
    expect(release.declared_name_exceptions).toContainEqual({
      surface: "codex",
      directory: "onboard-new-user",
      declared_name: "setup-codex",
      reason: "preserved-source-mismatch",
    });
  });

  it("locks naming, date, and filenames in the release schema", () => {
    const schema = JSON.parse(
      fs.readFileSync(
        path.join(repositoryRoot, "docs", "contracts", "artifact-release.v1.schema.json"),
        "utf8",
      ),
    ) as {
      properties: {
        handoff_protocol: { const: string };
        release_id: { pattern: string };
        release_date_utc: { format: string };
        archive: { properties: { file_name: { const: string } } };
      };
    };

    expect(schema.properties.handoff_protocol.const).toBe(
      "balcony-git-artifact-handoff.v1",
    );
    expect(schema.properties.release_date_utc.format).toBe("date");
    expect(schema.properties.archive.properties.file_name.const).toBe("payload.zip");
    expect(
      new RegExp(schema.properties.release_id.pattern).test(
        "2026-08-23--sys-a-to-sys-b--codex-skills--r01",
      ),
    ).toBe(true);
  });

  it("documents exact-commit delivery and fail-closed installation", () => {
    const runbook = fs.readFileSync(
      path.join(repositoryRoot, "docs", "runbooks", "git-artifact-handoff.md"),
      "utf8",
    );
    const command = fs.readFileSync(
      path.join(repositoryRoot, "scripts", "Invoke-GitSkillArtifact.ps1"),
      "utf8",
    );

    expect(runbook).toContain("full-40-character-commit");
    expect(runbook).toContain("detached clean worktree");
    expect(runbook).toContain("accept-identical-or-fail");
    expect(runbook).toContain(
      "transfers/releases/YYYY/MM/YYYY-MM-DD--sys-a-to-sys-b--codex-skills--rNN/",
    );
    expect(runbook).toContain("release.json");
    expect(runbook).toContain("payload.zip");
    expect(command).toContain("ExpectedCommit must be a full 40-character Git object ID");
    expect(command).toContain("Git worktree is dirty; refusing pinned artifact use");
    expect(command).toContain("Different destination already exists");
    expect(command).toContain("BALCONY_SYSTEM_ID");
    expect(command).toContain("Release manifest must use the canonical path");
  });
});
