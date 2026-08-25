import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

const repositoryRoot = path.resolve(import.meta.dirname, "../..");
const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, {
      recursive: true,
      force: true,
      maxRetries: 5,
      retryDelay: 100,
    });
  }
});

describe("public safety script", () => {
  it("detects current secrets without printing their values", () => {
    const fixture = createRepository();
    const secret = `ghp_${"A".repeat(24)}`;
    fs.writeFileSync(path.join(fixture, "unsafe.txt"), `${secret}\n`, "utf8");

    const result = runChecker(fixture);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("github-token");
    expect(result.stderr).toContain("unsafe.txt");
    expect(result.stderr).not.toContain(secret);
  });

  it("detects forbidden filenames and secrets retained only in history", () => {
    const fixture = createRepository();
    const secret = `npm_${"B".repeat(36)}`;
    fs.writeFileSync(path.join(fixture, ".env.production"), "PLACEHOLDER=1\n");
    fs.writeFileSync(path.join(fixture, "removed-secret.txt"), `${secret}\n`);
    git(fixture, ["add", ".env.production", "removed-secret.txt"]);
    git(fixture, [
      "-c",
      "user.name=Release Test",
      "-c",
      "user.email=release-test@example.invalid",
      "commit",
      "-m",
      "add unsafe fixtures",
    ]);
    fs.rmSync(path.join(fixture, ".env.production"));
    fs.rmSync(path.join(fixture, "removed-secret.txt"));
    git(fixture, ["add", "-u"]);
    git(fixture, [
      "-c",
      "user.name=Release Test",
      "-c",
      "user.email=release-test@example.invalid",
      "commit",
      "-m",
      "remove unsafe fixtures",
    ]);

    const result = runChecker(fixture, ["--history"]);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain(".env.production");
    expect(result.stderr).toContain("npm-token");
    expect(result.stderr).not.toContain(secret);
  });

  it("accepts a clean repository and the documented example filename", () => {
    const fixture = createRepository();
    fs.writeFileSync(
      path.join(fixture, ".env.example"),
      "TOKEN=replace-with-local-value\n",
      "utf8",
    );

    const result = runChecker(fixture, ["--history"]);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('"findings":0');
  });
});

function createRepository(): string {
  const fixture = fs.mkdtempSync(
    path.join(os.tmpdir(), "balcony-public-safety-"),
  );
  temporaryDirectories.push(fixture);
  fs.mkdirSync(path.join(fixture, "scripts"));
  fs.copyFileSync(
    path.join(repositoryRoot, "scripts", "check-public-safety.mjs"),
    path.join(fixture, "scripts", "check-public-safety.mjs"),
  );
  fs.writeFileSync(path.join(fixture, "README.md"), "# Safe fixture\n", "utf8");
  git(fixture, ["init"]);
  git(fixture, ["add", "README.md"]);
  git(fixture, [
    "-c",
    "user.name=Release Test",
    "-c",
    "user.email=release-test@example.invalid",
    "commit",
    "-m",
    "initial",
  ]);
  return fixture;
}

function runChecker(fixture: string, args: string[] = []) {
  return spawnSync(
    process.execPath,
    [path.join(fixture, "scripts", "check-public-safety.mjs"), ...args],
    {
      cwd: fixture,
      encoding: "utf8",
      windowsHide: true,
    },
  );
}

function git(fixture: string, args: string[]): void {
  const result = spawnSync("git", args, {
    cwd: fixture,
    encoding: "utf8",
    windowsHide: true,
  });
  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    throw new Error(result.stderr);
  }
}
