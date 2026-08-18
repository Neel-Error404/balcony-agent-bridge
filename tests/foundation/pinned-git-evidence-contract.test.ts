import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import { EvidenceBundleSchema } from "../../src/contracts/evidence.js";

describe("pinned Git evidence contract", () => {
  it("accepts evidence bound to one exact commit and blob", () => {
    const content = "Pinned documentation.\n";
    const bytes = Buffer.from(content, "utf8");
    const revision = "a".repeat(40);
    const bundle = EvidenceBundleSchema.parse({
      schema_version: "1.0",
      project: "balcony-agent-bridge",
      generated_at_utc: "2026-08-17T13:00:00.000Z",
      total_bytes: bytes.byteLength,
      git_snapshot: {
        revision,
        branch: "main",
        worktree_state: "clean",
        commit_time_utc: "2026-08-17T12:59:00.000Z",
      },
      items: [
        {
          path: "README.md",
          source: "pinned_git",
          git_commit: revision,
          git_blob_oid: "b".repeat(40),
          content,
          sha256: createHash("sha256").update(bytes).digest("hex"),
          byte_length: bytes.byteLength,
          modified_at_utc: "2026-08-17T12:59:00.000Z",
        },
      ],
    });

    expect(bundle.git_snapshot).toMatchObject({
      revision,
      worktree_state: "clean",
    });
  });

  it("rejects pinned evidence whose item commit differs from its snapshot", () => {
    const content = "Pinned documentation.\n";
    const bytes = Buffer.from(content, "utf8");

    expect(() =>
      EvidenceBundleSchema.parse({
        schema_version: "1.0",
        project: "balcony-agent-bridge",
        generated_at_utc: "2026-08-17T13:00:00.000Z",
        total_bytes: bytes.byteLength,
        git_snapshot: {
          revision: "a".repeat(40),
          branch: null,
          worktree_state: "clean",
          commit_time_utc: "2026-08-17T12:59:00.000Z",
        },
        items: [
          {
            path: "README.md",
            source: "pinned_git",
            git_commit: "c".repeat(40),
            git_blob_oid: "b".repeat(40),
            content,
            sha256: createHash("sha256").update(bytes).digest("hex"),
            byte_length: bytes.byteLength,
            modified_at_utc: "2026-08-17T12:59:00.000Z",
          },
        ],
      }),
    ).toThrow(/snapshot revision/);
  });
});
