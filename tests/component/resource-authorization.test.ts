import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { ReadOnlyDispatcherConfig } from "../../src/config.js";
import { createEnvelope } from "../../src/contracts/envelope.js";
import type {
  CodexExecutionInput,
  CodexExecutionResult,
  CodexExecutor,
} from "../../src/dispatcher/codex-executor.js";
import { ReadOnlyDispatcher } from "../../src/dispatcher/dispatcher.js";
import { ProjectRegistry } from "../../src/dispatcher/project-registry.js";
import { BridgeDatabase } from "../../src/storage/database.js";

describe("durable peer resource authorization", () => {
  let database: BridgeDatabase;

  beforeEach(() => {
    database = new BridgeDatabase(":memory:");
  });

  afterEach(() => {
    database.close();
  });

  it("defaults deny and grants only the exact peer and resource pair", () => {
    database.registerResource("voiceai");

    expect(database.isPeerAuthorizedForResource("SYS-A", "voiceai")).toBe(false);
    database.grantPeerResource("SYS-A", "voiceai");

    expect(database.isPeerAuthorizedForResource("SYS-A", "voiceai")).toBe(true);
    expect(database.isPeerAuthorizedForResource("SYS-B", "voiceai")).toBe(false);
    expect(database.isPeerAuthorizedForResource("SYS-A", "trading")).toBe(false);
  });

  it("fails closed for revoked, disabled, unknown, and malformed state", () => {
    database.registerResource("voiceai");
    database.grantPeerResource("SYS-A", "voiceai");

    database.revokePeerResource("SYS-A", "voiceai");
    expect(database.isPeerAuthorizedForResource("SYS-A", "voiceai")).toBe(false);

    database.grantPeerResource("SYS-A", "voiceai");
    database.setResourceEnabled("voiceai", false);
    expect(database.isPeerAuthorizedForResource("SYS-A", "voiceai")).toBe(false);
    expect(database.isPeerAuthorizedForResource("SYS-A", "unknown")).toBe(false);
    expect(database.isPeerAuthorizedForResource("SYS-A", "../voiceai")).toBe(false);
    expect(database.isPeerAuthorizedForResource("not a peer", "voiceai")).toBe(false);
  });

  it("persists revocation across restart and migrates v7 without broad grants", () => {
    database.close();
    const root = fs.mkdtempSync(
      path.join(os.tmpdir(), "balcony-resource-persistence-"),
    );
    const databasePath = path.join(root, "bridge.sqlite3");
    const original = new BridgeDatabase(databasePath);
    original.registerResource("voiceai");
    original.grantPeerResource("SYS-A", "voiceai");
    original.revokePeerResource("SYS-A", "voiceai");
    original.close();

    const reopened = new BridgeDatabase(databasePath);
    expect(reopened.isPeerAuthorizedForResource("SYS-A", "voiceai")).toBe(false);
    expect(reopened.listPeerResourceGrants()).toMatchObject([
      { peerSystemId: "SYS-A", resourceId: "voiceai", state: "revoked" },
    ]);
    reopened.close();

    const raw = new Database(databasePath);
    raw.exec(`
      DROP TABLE peer_resource_grants;
      DROP TABLE resources;
      DELETE FROM schema_migrations WHERE version = 8;
    `);
    raw.close();

    const migrated = new BridgeDatabase(databasePath);
    expect(migrated.listResources()).toEqual([]);
    expect(migrated.listPeerResourceGrants()).toEqual([]);
    expect(migrated.isPeerAuthorizedForResource("SYS-A", "voiceai")).toBe(false);
    migrated.close();
    fs.rmSync(root, { recursive: true, force: true });
    database = new BridgeDatabase(":memory:");
  });

  it("does not authorize malformed persisted state", () => {
    database.close();
    const root = fs.mkdtempSync(
      path.join(os.tmpdir(), "balcony-resource-malformed-"),
    );
    const databasePath = path.join(root, "bridge.sqlite3");
    const bridge = new BridgeDatabase(databasePath);
    bridge.registerResource("voiceai");
    bridge.grantPeerResource("SYS-A", "voiceai");
    bridge.close();

    const raw = new Database(databasePath);
    raw.pragma("ignore_check_constraints = ON");
    raw.prepare(
      "UPDATE peer_resource_grants SET revoked_at_utc = '2026-08-27T00:00:00.000Z' WHERE peer_system_id = 'SYS-A' AND resource_id = 'voiceai'",
    ).run();
    raw.close();

    const reopened = new BridgeDatabase(databasePath);
    expect(reopened.isPeerAuthorizedForResource("SYS-A", "voiceai")).toBe(false);
    reopened.close();
    fs.rmSync(root, { recursive: true, force: true });
    database = new BridgeDatabase(":memory:");
  });
});

describe("read-only dispatcher resource authorization boundary", () => {
  const temporaryDirectories: string[] = [];

  afterEach(() => {
    vi.restoreAllMocks();
    for (const directory of temporaryDirectories) {
      fs.rmSync(directory, { recursive: true, force: true });
    }
    temporaryDirectories.length = 0;
  });

  it("parks an ungranted request before resolving the project or starting Codex", async () => {
    const fixture = createFixture();
    fixture.database.registerResource("voiceai");
    const projectLookup = vi.spyOn(fixture.registry, "get");
    fixture.database.persistIncoming(request("denied"), 1, new Date(), true);

    expect(await fixture.dispatcher.runOnce()).toBe(1);
    expect(projectLookup).not.toHaveBeenCalled();
    expect(fixture.executor.inputs).toHaveLength(0);
    expect(fixture.database.getStatus().inbox.quarantined).toBe(1);
    expect(fixture.database.listAuthorizationRequests()).toHaveLength(1);
    expect(fixture.database.leaseOutbox("test", 1, 60)).toEqual([]);

    fixture.close();
  });

  it("executes only an authenticated request with the exact active grant", async () => {
    const fixture = createFixture();
    fixture.database.registerResource("voiceai");
    fixture.database.grantPeerResource("SYS-A", "voiceai");
    fixture.database.persistIncoming(request("allowed"), 1, new Date(), true);

    expect(await fixture.dispatcher.runOnce()).toBe(1);
    expect(fixture.executor.inputs).toHaveLength(1);
    expect(fixture.executor.inputs[0]?.projectPath).toBe(
      fs.realpathSync.native(fixture.projectDirectory),
    );

    fixture.close();
  });

  it("rejects invalid provenance/resource state and parks missing active grants", async () => {
    const cases = [
      { name: "unauthenticated", authenticated: false, expected: "rejected" },
      { name: "revoked", authenticated: true, revoke: true, expected: "quarantined" },
      { name: "disabled", authenticated: true, disable: true, expected: "rejected" },
      { name: "peer-mismatch", authenticated: true, grantPeer: "SYS-B" as const, expected: "quarantined" },
    ];

    for (const testCase of cases) {
      const fixture = createFixture();
      fixture.database.registerResource("voiceai");
      fixture.database.grantPeerResource(
        testCase.grantPeer ?? "SYS-A",
        "voiceai",
      );
      if (testCase.revoke) {
        fixture.database.revokePeerResource("SYS-A", "voiceai");
      }
      if (testCase.disable) {
        fixture.database.setResourceEnabled("voiceai", false);
      }
      const envelope = request(testCase.name);
      fixture.database.persistIncoming(
        envelope,
        1,
        new Date(),
        testCase.authenticated,
      );

      expect(await fixture.dispatcher.runOnce()).toBe(1);
      expect(fixture.executor.inputs, testCase.name).toHaveLength(0);
      expect(
        fixture.database.getInboxMessage(envelope.message_id)?.state,
        testCase.name,
      ).toBe(testCase.expected);
      expect(
        fixture.database.listAuthorizationRequests(),
        testCase.name,
      ).toHaveLength(testCase.expected === "quarantined" ? 1 : 0);
      fixture.close();
    }
  });

  function createFixture(): {
    database: BridgeDatabase;
    registry: ProjectRegistry;
    executor: RecordingExecutor;
    dispatcher: ReadOnlyDispatcher;
    projectDirectory: string;
    close: () => void;
  } {
    const root = fs.mkdtempSync(
      path.join(os.tmpdir(), "balcony-resource-authorization-"),
    );
    temporaryDirectories.push(root);
    const projectDirectory = path.join(root, "voiceai");
    fs.mkdirSync(projectDirectory);
    fs.writeFileSync(
      path.join(projectDirectory, "README.md"),
      "RESOURCE_CONTENT_SENTINEL",
    );
    const registryPath = path.join(root, "projects.json");
    fs.writeFileSync(
      registryPath,
      JSON.stringify({
        schema_version: "1.0",
        projects: [
          {
            key: "voiceai",
            path: projectDirectory,
            peer_readable: true,
          },
        ],
      }),
    );
    const database = new BridgeDatabase(":memory:");
    const registry = ProjectRegistry.load(registryPath);
    const executor = new RecordingExecutor();
    const dispatcher = new ReadOnlyDispatcher(
      dispatcherConfig(registryPath),
      database,
      registry,
      executor,
    );
    return {
      database,
      registry,
      executor,
      dispatcher,
      projectDirectory,
      close: () => database.close(),
    };
  }
});

class RecordingExecutor implements CodexExecutor {
  public readonly inputs: CodexExecutionInput[] = [];

  public async execute(
    input: CodexExecutionInput,
  ): Promise<CodexExecutionResult> {
    this.inputs.push(input);
    return { output: "Authorized read-only result." };
  }
}

function dispatcherConfig(projectsPath: string): ReadOnlyDispatcherConfig {
  return {
    systemId: "SYS-B",
    authorizedNodeIds: ["SYS-A", "SYS-B"],
    databasePath: ":memory:",
    projectsPath,
    codexExecutable: "unused-in-component-test",
    codexExecutableSha256: "a".repeat(64),
    codexCodeModeHostExecutable: "unused-in-component-test",
    codexCodeModeHostSha256: "b".repeat(64),
    codexHome: "unused-in-component-test",
    trustedPath: "unused-in-component-test",
    pollIntervalMs: 1000,
    defaultTimeoutSeconds: 300,
    maxOutputBytes: 48_000,
  };
}

function request(idempotencyKey: string) {
  return createEnvelope({
    idempotencyKey,
    originSystem: "SYS-A",
    targetSystem: "SYS-B",
    kind: "task_request",
    streamId: "resource-authorization",
    payload: {
      subject: "Inspect VoiceAI",
      body: "Report repository state.",
      project: "voiceai",
      evidence: [],
      dispatch: {
        executor: "codex_cli",
        access: "read_only",
        timeout_seconds: 120,
      },
    },
  });
}
