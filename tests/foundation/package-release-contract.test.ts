import fs from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

const repositoryRoot = path.resolve(import.meta.dirname, "../..");

interface PackageManifest {
  version?: string;
  private?: boolean;
  license?: string;
  files?: string[];
  bin?: Record<string, string>;
  scripts?: Record<string, string>;
  engines?: Record<string, string>;
  repository?: { type?: string; url?: string };
  homepage?: string;
  bugs?: { url?: string };
  publishConfig?: { access?: string };
}

function readPackageManifest(): PackageManifest {
  return JSON.parse(
    fs.readFileSync(path.join(repositoryRoot, "package.json"), "utf8"),
  ) as PackageManifest;
}

describe("npm release boundary", () => {
  it("packages only licensed compiled runtime files for explicit public publication", () => {
    const manifest = readPackageManifest();

    expect(manifest.private).not.toBe(true);
    expect(manifest.publishConfig).toEqual({ access: "public" });
    expect(manifest.license).toBe("Apache-2.0");
    expect(manifest.files).toEqual([
      "dist",
      "LICENSE",
      "docs/architecture.md",
      "docs/configuration.md",
      "docs/examples/three-node-topology.md",
      "docs/known-limitations.md",
      "docs/message-authentication.md",
      "docs/npm-first-onboarding.md",
      "docs/release-manifest-v0.2.md",
      "docs/release-manifest-v0.3.md",
      "docs/ROADMAP.md",
      "docs/runbooks/read-only-dispatcher.md",
      "docs/runbooks/recovery.md",
      "docs/runbooks/windows-service.md",
      "docs/threat-model.md",
      "docs/troubleshooting.md",
      "config/codex-mcp.example.toml",
      "config/dispatcher-projects.example.json",
      "SECURITY.md",
    ]);
    expect(manifest.bin).toEqual({
      "balcony-agent-bridge": "dist/cli/index.js",
      "balcony-agent-bridge-mcp": "dist/mcp/index.js",
    });
    expect(manifest.engines).toEqual({ node: ">=22.0.0", npm: ">=10.0.0" });
    expect(manifest.repository).toEqual({
      type: "git",
      url: "git+https://github.com/Neel-Error404/balcony-agent-bridge.git",
    });
    expect(manifest.homepage).toBe(
      "https://github.com/Neel-Error404/balcony-agent-bridge#readme",
    );
    expect(manifest.bugs).toEqual({
      url: "https://github.com/Neel-Error404/balcony-agent-bridge/issues",
    });
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
      "npm run build && node scripts/verify-package.mjs --install --clean-cache --require-preflight",
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

  it("ships every onboarding and security document referenced by packaged markdown", () => {
    const manifest = readPackageManifest();
    const packagedEntries = new Set(manifest.files ?? []);
    const documentationSources = ["README.md", "SECURITY.md"];
    const referencedDocuments = new Set<string>();

    for (const sourcePath of documentationSources) {
      const source = fs.readFileSync(path.join(repositoryRoot, sourcePath), "utf8");
      for (const match of source.matchAll(/docs\/[a-z0-9._/-]+\.md/giu)) {
        referencedDocuments.add(match[0]!.replaceAll("\\", "/"));
      }
    }

    expect(referencedDocuments.size).toBeGreaterThan(0);
    for (const referencedDocument of referencedDocuments) {
      const isPackaged = [...packagedEntries].some((entry) =>
        entry === referencedDocument ||
        (entry.endsWith("/") && referencedDocument.startsWith(entry))
      );
      expect(isPackaged, `${referencedDocument} must be shipped`).toBe(true);
      expect(
        fs.existsSync(path.join(repositoryRoot, referencedDocument)),
        `${referencedDocument} must exist`,
      ).toBe(true);
    }
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

  it("pins CI to the verified Windows Node runtime", () => {
    const workflow = fs.readFileSync(
      path.join(repositoryRoot, ".github", "workflows", "ci.yml"),
      "utf8",
    );

    expect(workflow).toContain("node-version: 22.14.0");
  });
});
