import fs from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

const repositoryRoot = path.resolve(import.meta.dirname, "../..");

describe("Phase 4 security documentation", () => {
  it("publishes the implemented threat model and residual trust boundaries", () => {
    const threatModel = read("docs/threat-model.md");

    for (const heading of [
      "## 1. System Overview",
      "## 2. Threat Model",
      "## 3. Attack Surface",
      "## 4. Severity Calibration",
    ]) {
      expect(threatModel).toContain(heading);
    }
    expect(threatModel).toMatch(/no unsigned compatibility\s+fallback/u);
    expect(threatModel).toContain("active grant");
    expect(threatModel).toContain("exact authenticated origin");
    expect(threatModel).toContain("no grants automatically");
    expect(threatModel).toContain("Repository: balcony-agent-bridge-open-source");
    expect(threatModel).toContain("Version:");
  });

  it("documents enrollment, cutover, rotation, revocation, incidents, and replay", () => {
    const guide = read("docs/message-authentication.md");

    for (const heading of [
      "## Create A Node Identity",
      "## Create The Membership Policy",
      "## Coordinated First Cutover",
      "## Rotation",
      "## Revocation And Incident Response",
      "## Replay Semantics",
    ]) {
      expect(guide).toContain(heading);
    }
    expect(guide).toContain("BALCONY_MESSAGE_AUTH_MODE=ed25519");
    expect(guide).toContain("must not contain the local node");
  });
});

function read(relativePath: string): string {
  return fs.readFileSync(path.join(repositoryRoot, relativePath), "utf8");
}
