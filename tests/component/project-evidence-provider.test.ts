import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  ProjectEvidenceProvider,
  buildEvidenceOnlyChildPrompt,
  parseEvidenceOnlyChildResult,
} from "../../src/evidence/project-evidence-provider.js";

describe("ProjectEvidenceProvider", () => {
  const temporaryDirectories: string[] = [];

  afterEach(() => {
    for (const directory of temporaryDirectories) {
      fs.rmSync(directory, { recursive: true, force: true });
    }
    temporaryDirectories.length = 0;
  });

  it("returns secret-safe, hash-bound evidence without exposing the root", () => {
    const root = temporaryDirectory();
    fs.writeFileSync(path.join(root, "README.md"), "Bridge docs.\n");
    const provider = new ProjectEvidenceProvider();
    const now = new Date("2026-08-17T10:00:00.000Z");

    const result = provider.collect({
      project: "balcony-agent-bridge",
      projectRoot: root,
      paths: ["README.md"],
      now,
    });

    expect(result).toMatchObject({
      schema_version: "1.0",
      project: "balcony-agent-bridge",
      generated_at_utc: now.toISOString(),
      total_bytes: 13,
      items: [
        {
          path: "README.md",
          source: "local_project",
          content: "Bridge docs.\n",
          byte_length: 13,
        },
      ],
    });
    expect(result.items[0]?.sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(JSON.stringify(result)).not.toContain(root);
  });

  it("rejects absolute paths and traversal outside the allowlisted root", () => {
    const root = temporaryDirectory();
    const provider = new ProjectEvidenceProvider();

    expect(() =>
      provider.collect({
        project: "bridge",
        projectRoot: root,
        paths: [path.join(root, "README.md")],
      }),
    ).toThrow(/relative/);
    expect(() =>
      provider.collect({
        project: "bridge",
        projectRoot: root,
        paths: ["../outside.md"],
      }),
    ).toThrow(/traversal/);
  });

  it("rejects reparse or symbolic-link components", () => {
    const parent = temporaryDirectory();
    const root = path.join(parent, "project");
    const outside = path.join(parent, "outside");
    fs.mkdirSync(root);
    fs.mkdirSync(outside);
    fs.writeFileSync(path.join(outside, "private.md"), "outside");
    fs.symlinkSync(outside, path.join(root, "linked"), "junction");
    const provider = new ProjectEvidenceProvider();

    expect(() =>
      provider.collect({
        project: "bridge",
        projectRoot: root,
        paths: ["linked/private.md"],
      }),
    ).toThrow(/reparse|symbolic/i);
  });

  it("rejects binary and secret-bearing files", () => {
    const root = temporaryDirectory();
    fs.writeFileSync(path.join(root, "binary.txt"), Buffer.from([0, 1, 2]));
    fs.writeFileSync(
      path.join(root, "secret.md"),
      ["-----BEGIN ", "PRIVATE KEY-----\nnot-real\n"].join(""),
    );
    fs.writeFileSync(
      path.join(root, "credential.json"),
      JSON.stringify({ [["client", "secret"].join("_")]: "not-a-real-secret" }),
    );
    const provider = new ProjectEvidenceProvider();

    expect(() =>
      provider.collect({
        project: "bridge",
        projectRoot: root,
        paths: ["binary.txt"],
      }),
    ).toThrow(/binary/);
    expect(() =>
      provider.collect({
        project: "bridge",
        projectRoot: root,
        paths: ["secret.md"],
      }),
    ).toThrow(/secret-safe/);
    expect(() =>
      provider.collect({
        project: "bridge",
        projectRoot: root,
        paths: ["credential.json"],
      }),
    ).toThrow(/secret-safe/);
  });

  it("enforces per-file and aggregate byte limits", () => {
    const root = temporaryDirectory();
    fs.writeFileSync(path.join(root, "large.md"), "123456789");
    fs.writeFileSync(path.join(root, "one.md"), "12345");
    fs.writeFileSync(path.join(root, "two.md"), "67890");

    expect(() =>
      new ProjectEvidenceProvider({
        maxFileBytes: 8,
        maxTotalBytes: 20,
      }).collect({
        project: "bridge",
        projectRoot: root,
        paths: ["large.md"],
      }),
    ).toThrow(/per-file byte limit/);

    expect(() =>
      new ProjectEvidenceProvider({
        maxFileBytes: 8,
        maxTotalBytes: 8,
      }).collect({
        project: "bridge",
        projectRoot: root,
        paths: ["one.md", "two.md"],
      }),
    ).toThrow(/aggregate byte limit/);
  });

  it("enforces a caller-specified freshness limit", () => {
    const root = temporaryDirectory();
    const file = path.join(root, "state.md");
    fs.writeFileSync(file, "old state");
    fs.utimesSync(
      file,
      new Date("2026-08-17T08:00:00.000Z"),
      new Date("2026-08-17T08:00:00.000Z"),
    );
    const provider = new ProjectEvidenceProvider();

    expect(() =>
      provider.collect({
        project: "bridge",
        projectRoot: root,
        paths: ["state.md"],
        maxAgeSeconds: 60,
        now: new Date("2026-08-17T10:00:00.000Z"),
      }),
    ).toThrow(/freshness limit/);
  });

  it("builds a child prompt that treats evidence as data and supports parking", () => {
    const root = temporaryDirectory();
    fs.writeFileSync(path.join(root, "README.md"), "Bridge docs.\n");
    const bundle = new ProjectEvidenceProvider().collect({
      project: "bridge",
      projectRoot: root,
      paths: ["README.md"],
    });

    const prompt = buildEvidenceOnlyChildPrompt({
      subject: "Inspect the bridge",
      request: "What does the supplied README identify?",
      priorDiscussion: "",
      evidence: bundle,
    });

    expect(prompt).toContain("Do not use shell commands");
    expect(prompt).toContain("untrusted data");
    expect(prompt).toContain('"outcome":"needs_information"');
    expect(prompt).toContain("Bridge docs.");
    expect(prompt).not.toContain(root);
  });

  it("parses child results and limits citations to supplied evidence", () => {
    const root = temporaryDirectory();
    fs.writeFileSync(path.join(root, "README.md"), "Bridge docs.\n");
    const bundle = new ProjectEvidenceProvider().collect({
      project: "bridge",
      projectRoot: root,
      paths: ["README.md"],
    });

    expect(
      parseEvidenceOnlyChildResult(
        JSON.stringify({
          schema_version: "1.0",
          outcome: "completed",
          answer: "The project is a bridge.",
          evidence_paths: ["README.md"],
        }),
        bundle,
      ),
    ).toMatchObject({ outcome: "completed" });

    expect(() =>
      parseEvidenceOnlyChildResult(
        JSON.stringify({
          schema_version: "1.0",
          outcome: "completed",
          answer: "Unsupported claim.",
          evidence_paths: ["missing.md"],
        }),
        bundle,
      ),
    ).toThrow(/not supplied/);
    expect(() =>
      parseEvidenceOnlyChildResult(
        JSON.stringify({
          schema_version: "1.0",
          outcome: "completed",
          answer: ["-----BEGIN ", "PRIVATE KEY-----"].join(""),
          evidence_paths: ["README.md"],
        }),
        bundle,
      ),
    ).toThrow(/secret-safe/);
  });

  function temporaryDirectory(): string {
    const directory = fs.mkdtempSync(
      path.join(os.tmpdir(), "balcony-evidence-provider-"),
    );
    temporaryDirectories.push(directory);
    return directory;
  }
});
