import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { setupLocalProfile } from "../../src/setup/local-profile.js";
import { createEnvelope } from "../../src/contracts/envelope.js";
import { BridgeDatabase } from "../../src/storage/database.js";

const requestId = "a1111111-1111-4111-8111-111111111111";
const peerId = "node-b";
const resourceId = "voiceai";
const temporaryExpiry = "2030-01-02T03:04:05.000Z";

describe("approval workflow CLI", () => {
  const temporaryDirectories: string[] = [];

  afterEach(() => {
    for (const directory of temporaryDirectories.splice(0)) {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  it("lists, shows, approves once, and records a redacted audit trail", () => {
    const fixture = createFixture();
    seedPendingRequest(fixture.databasePath);

    const listed = runCli(fixture.configPath, ["approval", "list", "--state", "pending"]);
    expect(listed.status).toBe(0);
    expectRedactedJson(listed.stdout, {
      requests: [
        {
          request_id: requestId,
          peer_id: peerId,
          resource_id: resourceId,
          state: "pending",
        },
      ],
    });

    const shown = runCli(fixture.configPath, [
      "approval",
      "show",
      "--request-id",
      requestId,
    ]);
    expect(shown.status).toBe(0);
    expectRedactedJson(shown.stdout, {
      request: {
        request_id: requestId,
        peer_id: peerId,
        resource_id: resourceId,
        state: "pending",
      },
    });

    const approved = runCli(fixture.configPath, [
      "approval",
      "approve-once",
      "--request-id",
      requestId,
    ]);
    expect(approved.status).toBe(0);
    expectRedactedJson(approved.stdout, {
      approval: { request_id: requestId, state: "approved_once" },
    });

    const audited = runCli(fixture.configPath, [
      "approval",
      "audit",
      "--request-id",
      requestId,
    ]);
    expect(audited.status).toBe(0);
    expectRedactedJson(audited.stdout, {
      events: expect.arrayContaining([
        expect.objectContaining({ request_id: requestId, state: "pending" }),
        expect.objectContaining({ request_id: requestId, state: "approved_once" }),
      ]),
    });
  }, 60_000);

  it("temporarily approves, revokes, and filters audit records by peer and resource", () => {
    const fixture = createFixture();
    seedPendingRequest(fixture.databasePath);

    const temporarilyApproved = runCli(fixture.configPath, [
      "approval",
      "approve-temporary",
      "--request-id",
      requestId,
      "--expires-at-utc",
      temporaryExpiry,
    ]);
    expect(temporarilyApproved.status).toBe(0);
    expectRedactedJson(temporarilyApproved.stdout, {
      approval: {
        request_id: requestId,
        state: "approved_temporary",
        expires_at_utc: temporaryExpiry,
      },
    });

    const revoked = runCli(fixture.configPath, [
      "approval",
      "revoke",
      "--request-id",
      requestId,
      "--reason",
      "operator withdrew approval",
    ]);
    expect(revoked.status).toBe(0);
    expectRedactedJson(revoked.stdout, {
      approval: { request_id: requestId, state: "revoked" },
    });

    const audited = runCli(fixture.configPath, [
      "approval",
      "audit",
      "--peer-id",
      peerId,
      "--resource-id",
      resourceId,
    ]);
    expect(audited.status).toBe(0);
    expectRedactedJson(audited.stdout, {
      events: expect.arrayContaining([
        expect.objectContaining({ request_id: requestId, state: "revoked" }),
      ]),
    });
  }, 60_000);

  it("denies a pending request without exposing the operator reason", () => {
    const fixture = createFixture();
    seedPendingRequest(fixture.databasePath);

    const denied = runCli(fixture.configPath, [
      "approval",
      "deny",
      "--request-id",
      requestId,
      "--reason",
      "the supplied claim token was not reviewed",
    ]);
    expect(denied.status).toBe(0);
    expectRedactedJson(denied.stdout, {
      approval: { request_id: requestId, state: "denied" },
    });
  }, 60_000);

  it.each([
    ["approval", "list"],
    ["approval", "show", "--request-id", requestId],
    ["approval", "approve-once", "--request-id", requestId],
    [
      "approval",
      "approve-temporary",
      "--request-id",
      requestId,
      "--expires-at-utc",
      temporaryExpiry,
    ],
    ["approval", "deny", "--request-id", requestId],
    ["approval", "revoke", "--request-id", requestId],
    ["approval", "audit"],
  ])("rejects %s before opening the configured database when identity does not match", (...args: string[]) => {
    const fixture = createFixture();
    fs.rmSync(fixture.databasePath, { force: true });

    const rejected = runCli(fixture.configPath, args, "node-b");

    expect(rejected.status).toBe(1);
    expect(rejected.stdout).toBe("");
    expect(rejected.stderr.trim()).toBe("approval failed (CONFIGURATION_ERROR)");
    expect(rejected.stderr).not.toContain(fixture.configPath);
    expect(rejected.stderr).not.toContain(fixture.databasePath);
    expect(fs.existsSync(fixture.databasePath)).toBe(false);
  }, 60_000);

  it("returns usage exit code 2 when an approval action lacks its required request ID", () => {
    const fixture = createFixture();

    const result = runCli(fixture.configPath, ["approval", "show"]);

    expect(result.status).toBe(2);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("Usage:");
  }, 60_000);

  function createFixture(): { configPath: string; databasePath: string } {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "balcony-approval-cli-"));
    temporaryDirectories.push(root);
    const configPath = path.join(root, "config.json");
    const databasePath = path.join(root, "bridge.sqlite3");
    setupLocalProfile({
      configPath,
      databasePath,
      nodeId: "node-a",
      authorizedNodeIds: [peerId],
    });
    return { configPath, databasePath };
  }
});

function seedPendingRequest(databasePath: string): void {
  const database = new BridgeDatabase(databasePath) as BridgeDatabase & {
    authorizeClaimedResourceAccess(input: {
      requestMessageId: string;
      consumerId: string;
      claimToken: string;
      resourceId: string;
      actorId: string;
      now: Date;
    }): unknown;
  };
  try {
    database.registerResource(resourceId);
    const envelope = {
      ...createEnvelope({
        idempotencyKey: "approval-cli-request",
        originSystem: peerId,
        targetSystem: "node-a",
        kind: "task_request",
        streamId: "approval-workflow",
        payload: {
          subject: "Inspect resource",
          body: "Sensitive request body must stay out of approval output.",
          project: resourceId,
          evidence: [],
          dispatch: {
            executor: "codex_cli" as const,
            access: "read_only" as const,
          },
        },
      }),
      message_id: requestId,
    };
    database.persistIncoming(envelope, 1, new Date(), true);
    const consumerId = "approval-cli-seed";
    const claim = database.claimReadOnlyDispatchInbox(
      consumerId,
      1,
      720,
    )[0]!;
    database.authorizeClaimedResourceAccess({
      requestMessageId: requestId,
      consumerId,
      claimToken: claim.claimToken,
      resourceId,
      actorId: "node-a",
      now: new Date(),
    });
  } finally {
    database.close();
  }
}

function runCli(
  configPath: string,
  args: string[],
  systemId = "node-a",
) {
  const repositoryRoot = path.resolve(import.meta.dirname, "../..");
  return spawnSync(
    process.execPath,
    [
      "--import",
      "tsx",
      path.join(repositoryRoot, "src", "cli", "index.ts"),
      ...args,
      "--config",
      configPath,
    ],
    {
      cwd: repositoryRoot,
      encoding: "utf8",
      env: { ...process.env, BALCONY_SYSTEM_ID: systemId },
      timeout: 60_000,
    },
  );
}

function expectRedactedJson(
  stdout: string,
  expected: Record<string, unknown>,
): void {
  const json = JSON.parse(stdout) as unknown;
  expect(json).toMatchObject(expected);
  const rendered = JSON.stringify(json);
  expect(rendered).not.toContain("message_body");
  expect(rendered).not.toContain("project_path");
  expect(rendered).not.toContain("credential");
  expect(rendered).not.toContain("claim_token");
}
