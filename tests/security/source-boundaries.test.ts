import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const repositoryRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);

describe("source security boundaries", () => {
  it("uses explicit credentials without credential-chain fallback", () => {
    const source = readSourceFiles();
    expect(source).toContain("ManagedIdentityCredential");
    expect(source).toContain("ClientCertificateCredential");
    expect(source).not.toContain("DefaultAzureCredential");
    expect(source).not.toContain("EnvironmentCredential");
    expect(source).not.toContain("AzureCliCredential");
    expect(source).not.toContain("ClientSecretCredential");
  });

  it("keeps MCP standard output protocol-clean", () => {
    for (const file of sourceFiles()) {
      const content = fs.readFileSync(file, "utf8");
      expect(content, file).not.toMatch(/\bconsole\.log\s*\(/);
    }
  });

  it("does not contain embedded Azure connection-string values", () => {
    const source = readSourceFiles();
    expect(source).not.toMatch(
      /Endpoint=sb:\/\/[^;\s]+;SharedAccessKeyName=[^;\s]+;SharedAccessKey=[^;\s]+/i,
    );
  });
});

function readSourceFiles(): string {
  return sourceFiles()
    .map((file) => fs.readFileSync(file, "utf8"))
    .join("\n");
}

function sourceFiles(): string[] {
  return walk(path.join(repositoryRoot, "src")).filter((file) =>
    file.endsWith(".ts"),
  );
}

function walk(directory: string): string[] {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const fullPath = path.join(directory, entry.name);
    return entry.isDirectory() ? walk(fullPath) : [fullPath];
  });
}
