import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { PinnedGitEvidenceProvider } from "../../src/evidence/pinned-git-evidence-provider.js";

describe("PinnedGitEvidenceProvider", () => {
  const directories: string[] = [];

  afterEach(() => {
    for (const directory of directories) {
      fs.rmSync(directory, { recursive: true, force: true });
    }
    directories.length = 0;
  });

  it("returns committed blob content with exact Git metadata", () => {
    const repository = createRepository();
    const revision = git(repository, ["rev-parse", "HEAD"]);
    const provider = pinnedProvider();

    const evidence = provider.collect({
      project: "bridge",
      projectRoot: repository,
      revision,
      paths: ["README.md"],
      now: new Date("2026-08-17T13:00:00.000Z"),
    });

    expect(evidence).toMatchObject({
      project: "bridge",
      git_snapshot: {
        revision,
        worktree_state: "clean",
      },
      items: [
        {
          path: "README.md",
          source: "pinned_git",
          git_commit: revision,
          content: "Committed bridge docs.\n",
        },
      ],
    });
    expect(evidence.items[0]?.git_blob_oid).toMatch(/^[a-f0-9]{40,64}$/);
  });

  it("rejects a revision that is not the repository HEAD", () => {
    const repository = createRepository();
    const revision = git(repository, ["rev-parse", "HEAD"]);

    expect(() =>
      pinnedProvider().collect({
        project: "bridge",
        projectRoot: repository,
        revision: "0".repeat(revision.length),
        paths: ["README.md"],
      }),
    ).toThrow(/HEAD|revision/);
  });

  it("rejects dirty repositories by default", () => {
    const repository = createRepository();
    const revision = git(repository, ["rev-parse", "HEAD"]);
    fs.writeFileSync(
      path.join(repository, "README.md"),
      "Mutable working-tree content.\n",
    );

    expect(() =>
      pinnedProvider().collect({
        project: "bridge",
        projectRoot: repository,
        revision,
        paths: ["README.md"],
      }),
    ).toThrow(/clean/);
  });

  it("reads the committed blob rather than dirty working-tree bytes when explicitly allowed", () => {
    const repository = createRepository();
    const revision = git(repository, ["rev-parse", "HEAD"]);
    fs.writeFileSync(
      path.join(repository, "README.md"),
      "Mutable working-tree content.\n",
    );

    const evidence = pinnedProvider({
      requireClean: false,
    }).collect({
      project: "bridge",
      projectRoot: repository,
      revision,
      paths: ["README.md"],
    });

    expect(evidence.git_snapshot?.worktree_state).toBe("dirty");
    expect(evidence.items[0]?.content).toBe("Committed bridge docs.\n");
    expect(evidence.items[0]?.content).not.toContain("Mutable");
  });

  it(
    "rejects untracked paths and secret-bearing committed blobs",
    () => {
      const repository = createRepository();
      const revision = git(repository, ["rev-parse", "HEAD"]);
      fs.writeFileSync(path.join(repository, "untracked.md"), "Untracked.\n");

      expect(() =>
        pinnedProvider({ requireClean: false }).collect({
          project: "bridge",
          projectRoot: repository,
          revision,
          paths: ["untracked.md"],
        }),
      ).toThrow(/tracked|blob/);

      fs.writeFileSync(
        path.join(repository, "credential.json"),
        '{"client_secret":"not-a-real-secret"}\n',
      );
      git(repository, ["add", "credential.json"]);
      git(repository, ["commit", "-m", "add synthetic credential"]);
      const unsafeRevision = git(repository, ["rev-parse", "HEAD"]);
      expect(() =>
        pinnedProvider({ requireClean: false }).collect({
          project: "bridge",
          projectRoot: repository,
          revision: unsafeRevision,
          paths: ["credential.json"],
        }),
      ).toThrow(/secret-safe/);
    },
    20_000,
  );

  it("rejects a tracked symbolic-link blob", () => {
    const repository = createRepository();
    const targetFile = path.join(repository, "link-target.txt");
    fs.writeFileSync(targetFile, "README.md");
    const blobOid = git(repository, ["hash-object", "-w", "link-target.txt"]);
    fs.rmSync(targetFile);
    git(repository, [
      "update-index",
      "--add",
      "--cacheinfo",
      `120000,${blobOid},linked.md`,
    ]);
    git(repository, ["commit", "-m", "add synthetic symlink"]);
    const revision = git(repository, ["rev-parse", "HEAD"]);

    expect(() =>
      pinnedProvider({ requireClean: false }).collect({
        project: "bridge",
        projectRoot: repository,
        revision,
        paths: ["linked.md"],
      }),
    ).toThrow(/regular blob/);
  });

  it("rejects an executable whose bytes do not match the approved pin", () => {
    expect(
      () =>
        new PinnedGitEvidenceProvider({
          gitExecutable: findGitExecutable(),
          gitExecutableSha256: "0".repeat(64),
        }),
    ).toThrow(/approved SHA-256/);
  });

  function createRepository(): string {
    const repository = fs.mkdtempSync(
      path.join(os.tmpdir(), "balcony-pinned-git-"),
    );
    directories.push(repository);
    git(repository, ["init", "-b", "main"]);
    git(repository, ["config", "user.name", "Bridge Test"]);
    git(repository, ["config", "user.email", "bridge-test@example.invalid"]);
    fs.writeFileSync(
      path.join(repository, "README.md"),
      "Committed bridge docs.\n",
    );
    git(repository, ["add", "README.md"]);
    git(repository, ["commit", "-m", "initial evidence"]);
    return repository;
  }
});

function git(repository: string, arguments_: string[]): string {
  const result = spawnSync("git", ["-C", repository, ...arguments_], {
    encoding: "utf8",
    shell: false,
    windowsHide: true,
  });
  if (result.status !== 0) {
    throw new Error(result.stderr.trim() || "Git test command failed");
  }
  return result.stdout.trim();
}

function pinnedProvider(
  overrides: { requireClean?: boolean } = {},
): PinnedGitEvidenceProvider {
  const gitExecutable = findGitExecutable();
  return new PinnedGitEvidenceProvider({
    ...overrides,
    gitExecutable,
    gitExecutableSha256: createHash("sha256")
      .update(fs.readFileSync(gitExecutable))
      .digest("hex"),
  });
}

function findGitExecutable(): string {
  const candidates = (process.env["PATH"] ?? "")
    .split(path.delimiter)
    .flatMap((directory) => [
      path.join(directory, process.platform === "win32" ? "git.exe" : "git"),
    ]);
  for (const candidate of candidates) {
    try {
      if (fs.statSync(candidate).isFile()) {
        return fs.realpathSync.native(candidate);
      }
    } catch {
      continue;
    }
  }
  throw new Error("Git executable was not found on PATH for the component test.");
}
