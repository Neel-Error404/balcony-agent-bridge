import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { createChildEnvironment } from "../../src/dispatcher/codex-executor.js";

const repositoryRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);
const executorSource = fs.readFileSync(
  path.join(repositoryRoot, "src", "dispatcher", "codex-executor.ts"),
  "utf8",
);
const dispatcherIndexSource = fs.readFileSync(
  path.join(repositoryRoot, "src", "dispatcher", "index.ts"),
  "utf8",
);
const pinnedGitSource = fs.readFileSync(
  path.join(
    repositoryRoot,
    "src",
    "evidence",
    "pinned-git-evidence-provider.ts",
  ),
  "utf8",
);

describe("read-only dispatcher security boundary", () => {
  it("pins the Codex CLI to read-only, non-interactive, ephemeral execution", () => {
    expect(executorSource).toContain('"--sandbox"');
    expect(executorSource).toContain('"read-only"');
    expect(executorSource).toContain('"--ask-for-approval"');
    expect(executorSource).toContain('"never"');
    expect(executorSource).toContain('"--ephemeral"');
    expect(executorSource).toContain('"--ignore-user-config"');
    expect(executorSource).toContain("shell: false");
    expect(executorSource).not.toContain(
      "--dangerously-bypass-approvals-and-sandbox",
    );
    expect(executorSource).not.toContain('"--add-dir"');
    expect(executorSource).not.toContain("shell: true");
  });

  it("does not expose bridge or Azure configuration to the child", () => {
    const environment = createChildEnvironment(
      {
        PATH: "approved-path",
        BALCONY_SYSTEM_ID: "SYS-A",
        BALCONY_SERVICEBUS_NAMESPACE:
          "private.servicebus.windows.net",
        BALCONY_AZURE_TENANT_ID:
          "11111111-1111-4111-8111-111111111111",
        AZURE_CLIENT_SECRET: "private-secret",
        AZURE_ACCESS_TOKEN: "private-token",
      },
      "C:\\isolated-codex-home",
      "C:\\trusted-node",
    );

    expect(environment).toEqual({
      CODEX_HOME: "C:\\isolated-codex-home",
      NO_COLOR: "1",
      PATH: "C:\\trusted-node",
      PATHEXT: ".COM;.EXE;.BAT;.CMD",
    });
  });

  it("passes the task prompt only through standard input", () => {
    expect(executorSource).toContain(
      'child.stdin.end(input.prompt, "utf8")',
    );
    expect(executorSource).not.toContain("codexArguments.push(input.prompt)");
    expect(executorSource).not.toContain("exec(");
    expect(executorSource).not.toContain("execFile(");
  });

  it("removes local read-capable tools from evidence-only turns", () => {
    expect(executorSource).toContain('"evidence_only"');
    expect(executorSource).toContain('"shell_tool"');
    expect(executorSource).toContain('"unified_exec"');
    expect(executorSource).toContain('"view_image"');
    expect(executorSource).toContain('"--skip-git-repo-check"');
  });

  it("selects exactly one foreground dispatcher mode", () => {
    expect(dispatcherIndexSource).toContain(
      "AutonomousConsultationCoordinator",
    );
    expect(dispatcherIndexSource).toContain(
      "PinnedGitEvidenceProvider",
    );
    expect(dispatcherIndexSource).toContain(
      'config.mode === "consultation"',
    );
  });

  it("bounds every synchronous Git evidence command", () => {
    expect(pinnedGitSource).toContain(
      "GIT_COMMAND_TIMEOUT_MS",
    );
    expect(pinnedGitSource).toContain(
      "timeout: GIT_COMMAND_TIMEOUT_MS",
    );
    expect(pinnedGitSource).not.toContain('return "git"');
    expect(pinnedGitSource).toContain("gitExecutable: z.string().trim().min(1)");
  });
});
