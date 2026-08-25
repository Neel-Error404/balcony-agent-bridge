import fs from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

const repositoryRoot = path.resolve(import.meta.dirname, "../..");

describe("public release examples", () => {
  it("do not contain machine-specific absolute paths", () => {
    for (const relativePath of [
      ".env.example",
      "config/codex-mcp.example.toml",
      "config/dispatcher-projects.example.json",
    ]) {
      const content = fs.readFileSync(
        path.join(repositoryRoot, relativePath),
        "utf8",
      );
      const withoutApprovedPlaceholders = content.replace(
        /C:\\+path\\+to\\+/gu,
        "",
      );
      expect(withoutApprovedPlaceholders, relativePath).not.toMatch(
        /[A-Za-z]:\\/u,
      );
    }
  });

  it("documents the source-export boundary separately from the npm package", () => {
    const boundary = fs.readFileSync(
      path.join(repositoryRoot, "docs", "public-release-boundary.md"),
      "utf8",
    );

    expect(boundary).toContain("Public Source Export");
    expect(boundary).toContain("docs/handoff/");
    expect(boundary).toContain("docs/verification/");
    expect(boundary).toContain("clean history");
  });
});
