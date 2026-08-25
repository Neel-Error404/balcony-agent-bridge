import fs from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

const repositoryRoot = path.resolve(import.meta.dirname, "../..");

interface PackageManifest {
  private?: boolean;
  license?: string;
  files?: string[];
  bin?: Record<string, string>;
  scripts?: Record<string, string>;
  engines?: Record<string, string>;
}

function readPackageManifest(): PackageManifest {
  return JSON.parse(
    fs.readFileSync(path.join(repositoryRoot, "package.json"), "utf8"),
  ) as PackageManifest;
}

describe("npm release boundary", () => {
  it("packages only licensed compiled runtime files while publication approval is pending", () => {
    const manifest = readPackageManifest();

    expect(manifest.private).toBe(true);
    expect(manifest.license).toBe("Apache-2.0");
    expect(manifest.files).toEqual([
      "dist",
      "LICENSE",
      "config/codex-mcp.example.toml",
      "config/dispatcher-projects.example.json",
      "SECURITY.md",
    ]);
    expect(manifest.bin).toEqual({
      "balcony-agent-bridge": "./dist/cli/index.js",
      "balcony-agent-bridge-mcp": "./dist/mcp/index.js",
    });
    expect(manifest.engines).toEqual({ node: ">=22.0.0", npm: ">=10.0.0" });
    expect(manifest.scripts?.["build"]).toBe(
      "node scripts/clean-dist.mjs && tsc -p tsconfig.build.json",
    );
    expect(manifest.scripts?.["prepack"]).toBe("npm run build");
    expect(manifest.scripts?.["verify:package"]).toBe(
      "npm run build && node scripts/verify-package.mjs",
    );
    expect(manifest.scripts?.["smoke:package"]).toBe(
      "npm run build && node scripts/verify-package.mjs --install",
    );
    expect(manifest.scripts?.["verify:public-alpha"]).toBe(
      "npm run build && node scripts/verify-package.mjs --install --clean-cache",
    );
    expect(manifest.scripts?.["check:secrets"]).toBe(
      "node scripts/check-public-safety.mjs --history",
    );
    expect(
      fs.existsSync(path.join(repositoryRoot, "scripts", "check-public-safety.mjs")),
    ).toBe(true);
    expect(fs.readFileSync(path.join(repositoryRoot, "LICENSE"), "utf8")).toContain(
      "Apache License",
    );
  });

  it("keeps every packaged executable directly runnable by Node", () => {
    for (const relativePath of [
      "src/cli/index.ts",
      "src/mcp/index.ts",
    ]) {
      const source = fs.readFileSync(
        path.join(repositoryRoot, relativePath),
        "utf8",
      );
      expect(source.startsWith("#!/usr/bin/env node\n"), relativePath).toBe(
        true,
      );
    }
  });
});
