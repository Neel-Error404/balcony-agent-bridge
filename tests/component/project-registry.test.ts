import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { ProjectRegistry } from "../../src/dispatcher/project-registry.js";

describe("ProjectRegistry", () => {
  const temporaryDirectories: string[] = [];

  afterEach(() => {
    vi.restoreAllMocks();
    for (const directory of temporaryDirectories) {
      fs.rmSync(directory, { recursive: true, force: true });
    }
    temporaryDirectories.length = 0;
  });

  it("resolves enabled local projects by stable key", () => {
    const root = temporaryDirectory();
    const project = path.join(root, "voiceai");
    fs.mkdirSync(project);
    const registryPath = writeRegistry(root, {
      schema_version: "1.0",
      projects: [
        { key: "VoiceAI", path: project, peer_readable: true },
        {
          key: "disabled",
          path: project,
          enabled: false,
          peer_readable: true,
        },
      ],
    });

    const registry = ProjectRegistry.load(registryPath);
    expect(registry.get("voiceai")).toEqual({
      key: "VoiceAI",
      path: fs.realpathSync.native(project),
    });
    expect(registry.get("disabled")).toBeUndefined();
  });

  it("rejects duplicate project keys", () => {
    const root = temporaryDirectory();
    const project = path.join(root, "project");
    fs.mkdirSync(project);
    const registryPath = writeRegistry(root, {
      schema_version: "1.0",
      projects: [
        { key: "voiceai", path: project, peer_readable: true },
        { key: "VoiceAI", path: project, peer_readable: true },
      ],
    });

    expect(() => ProjectRegistry.load(registryPath)).toThrow(
      /duplicate key/,
    );
  });

  it("rejects relative project paths", () => {
    const root = temporaryDirectory();
    const registryPath = writeRegistry(root, {
      schema_version: "1.0",
      projects: [
        {
          key: "voiceai",
          path: ".\\relative-project",
          peer_readable: true,
        },
      ],
    });

    expect(() => ProjectRegistry.load(registryPath)).toThrow(
      /absolute local filesystem path/,
    );
  });

  it("requires explicit whole-project peer-read approval", () => {
    const root = temporaryDirectory();
    const project = path.join(root, "project");
    fs.mkdirSync(project);
    const registryPath = writeRegistry(root, {
      schema_version: "1.0",
      projects: [{ key: "voiceai", path: project }],
    });

    expect(() => ProjectRegistry.load(registryPath)).toThrow(
      /peer_readable/,
    );
  });

  it("rejects a local reparse point that resolves to a network path", () => {
    const root = temporaryDirectory();
    const project = path.join(root, "project");
    fs.mkdirSync(project);
    const registryPath = writeRegistry(root, {
      schema_version: "1.0",
      projects: [
        {
          key: "voiceai",
          path: project,
          peer_readable: true,
        },
      ],
    });
    vi.spyOn(fs.realpathSync, "native").mockReturnValue(
      "\\\\private-host\\share",
    );

    expect(() => ProjectRegistry.load(registryPath)).toThrow(
      /accessible directory/,
    );
  });

  function temporaryDirectory(): string {
    const directory = fs.mkdtempSync(
      path.join(os.tmpdir(), "balcony-project-registry-"),
    );
    temporaryDirectories.push(directory);
    return directory;
  }
});

function writeRegistry(root: string, value: unknown): string {
  const registryPath = path.join(root, "projects.json");
  fs.writeFileSync(registryPath, JSON.stringify(value));
  return registryPath;
}
