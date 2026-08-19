import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const repositoryRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);

describe("autonomous consultation operating documentation", () => {
  it("documents pinned evidence, status, recovery, and foreground-only activation", () => {
    const runbook = fs.readFileSync(
      path.join(
        repositoryRoot,
        "docs",
        "runbooks",
        "autonomous-consultation.md",
      ),
      "utf8",
    );

    expect(runbook).toContain("full commit");
    expect(runbook).toContain("committed blob");
    expect(runbook).toContain("consultationCoordinatorHeartbeatAtUtc");
    expect(runbook).toContain("needs_information");
    expect(runbook).toContain("waiting_peer");
    expect(runbook).toContain("foreground");
    expect(runbook).toContain("automatic startup remains disabled");
    expect(runbook).toContain("Do not");
  });

  it("documents the Codex bundle, consultation admission, and MCP reload gates", () => {
    const consultation = fs.readFileSync(
      path.join(
        repositoryRoot,
        "docs",
        "runbooks",
        "autonomous-consultation.md",
      ),
      "utf8",
    );
    const dispatcher = fs.readFileSync(
      path.join(
        repositoryRoot,
        "docs",
        "runbooks",
        "read-only-dispatcher.md",
      ),
      "utf8",
    );

    for (const document of [consultation, dispatcher]) {
      expect(document).toContain("codex-code-mode-host.exe");
      expect(document).toContain("Update-DispatcherService.ps1");
      expect(document).toContain("evidence_mode");
      expect(document).toContain("consultation");
    }
    expect(consultation).toContain("restart the Codex application or task");
    expect(consultation).toContain("loaded MCP tool schema");
    expect(consultation).toContain("legacy claim route");
  });

  it("records Phase 3 without claiming deployment", () => {
    const decision = fs.readFileSync(
      path.join(
        repositoryRoot,
        "docs",
        "adr",
        "0008-pinned-git-evidence-and-consultation-operations.md",
      ),
      "utf8",
    );
    const architecture = fs.readFileSync(
      path.join(repositoryRoot, "docs", "architecture.md"),
      "utf8",
    );

    expect(decision).toContain("not deployed");
    expect(decision).toContain("PinnedGitEvidenceProvider");
    expect(architecture).toMatch(
      /durable autonomous consultation\s+coordinator/u,
    );
  });
});
