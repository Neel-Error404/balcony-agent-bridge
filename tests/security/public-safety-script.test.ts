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

  it("does not exempt a real secret placed in a former fixture path", () => {
    const fixture = createRepository();
    const fixturePath = path.join(
      fixture,
      "tests",
      "component",
      "read-only-dispatcher.test.ts",
    );
    fs.mkdirSync(path.dirname(fixturePath), { recursive: true });
    const marker = ["-----BEGIN ", "PRIVATE KEY-----"].join("");
    fs.writeFileSync(fixturePath, `${marker}\noperational-key-material\n`, "utf8");

    const result = runChecker(fixture);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("private-key");
    expect(result.stderr).toContain("read-only-dispatcher.test.ts");
    expect(result.stderr).not.toContain("operational-key-material");
  });

  it("detects binary tracked content instead of skipping all detectors", () => {
    const fixture = createRepository();
    fs.writeFileSync(
      path.join(fixture, "opaque.bin"),
      Buffer.concat([Buffer.from([0]), Buffer.from(`ghp_${"C".repeat(24)}`)]),
    );

    const result = runChecker(fixture);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("binary-file");
    expect(result.stderr).toContain("opaque.bin");
  });

  it("detects quoted JSON client secrets and encrypted private keys", () => {
    const fixture = createRepository();
    const clientSecret = "E".repeat(24);
    const privateKeyHeader = [
      "-----BEGIN ",
      "ENCRYPTED",
      " PRIVATE KEY-----",
    ].join("");
    fs.writeFileSync(
      path.join(fixture, "credentials.json"),
      JSON.stringify({ client_secret: clientSecret }),
      "utf8",
    );
    fs.writeFileSync(
      path.join(fixture, "encrypted.pem.txt"),
      `${privateKeyHeader}\nsynthetic-key-material\n`,
      "utf8",
    );

    const result = runChecker(fixture);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("client-secret-assignment");
    expect(result.stderr).toContain("private-key");
    expect(result.stderr).not.toContain(clientSecret);
    expect(result.stderr).not.toContain("synthetic-key-material");
  });

  it("detects PGP private-key blocks", () => {
    const fixture = createRepository();
    fs.writeFileSync(
      path.join(fixture, "pgp-private-key.txt"),
      `${["-----BEGIN ", "PGP PRIVATE KEY BLOCK-----"].join("")}\nfixture\n`,
      "utf8",
    );

    const result = runChecker(fixture);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("private-key");
    expect(result.stderr).toContain("pgp-private-key.txt");
  });

  it("scans complete historical blobs and renamed forbidden paths", () => {
    const fixture = createRepository();
    const secret = "D".repeat(24);
    fs.writeFileSync(
      path.join(fixture, "multiline.yaml"),
      `${["client", "secret"].join("_")}:\n"${secret}"\n`,
      "utf8",
    );
    fs.writeFileSync(path.join(fixture, "safe-name.txt"), "PLACEHOLDER=1\n");
    fs.writeFileSync(
      path.join(fixture, "historical-credentials.json"),
      JSON.stringify({ client_secret: "F".repeat(24) }),
      "utf8",
    );
    fs.writeFileSync(
      path.join(fixture, "historical-key.txt"),
      `${["-----BEGIN ", "DSA", " PRIVATE KEY-----"].join("")}\nfixture\n`,
      "utf8",
    );
    git(fixture, [
      "add",
      "multiline.yaml",
      "safe-name.txt",
      "historical-credentials.json",
      "historical-key.txt",
    ]);
    commit(fixture, "add historical fixtures");
    git(fixture, ["mv", "safe-name.txt", ".env.production"]);
    commit(fixture, "rename forbidden fixture");
    fs.rmSync(path.join(fixture, "multiline.yaml"));
    fs.rmSync(path.join(fixture, ".env.production"));
    fs.rmSync(path.join(fixture, "historical-credentials.json"));
    fs.rmSync(path.join(fixture, "historical-key.txt"));
    git(fixture, ["add", "-u"]);
    commit(fixture, "remove historical fixtures");

    const result = runChecker(fixture, ["--history"]);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("client-secret-assignment");
    expect(result.stderr).toContain("private-key");
    expect(result.stderr).toContain(".env.production");
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

function commit(fixture: string, message: string): void {
  git(fixture, [
    "-c",
    "user.name=Release Test",
    "-c",
    "user.email=release-test@example.invalid",
    "commit",
    "-m",
    message,
  ]);
}
