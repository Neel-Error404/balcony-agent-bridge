import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

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

describe("ReadOnlyDispatcher", () => {
  let database: BridgeDatabase;
  let temporaryDirectory: string;
  let projectDirectory: string;
  let registry: ProjectRegistry;
  let executor: FakeCodexExecutor;
  let dispatcher: ReadOnlyDispatcher;

  beforeEach(() => {
    database = new BridgeDatabase(":memory:");
    temporaryDirectory = fs.mkdtempSync(
      path.join(os.tmpdir(), "balcony-dispatcher-component-"),
    );
    projectDirectory = path.join(temporaryDirectory, "project");
    fs.mkdirSync(projectDirectory);
    const registryPath = path.join(temporaryDirectory, "projects.json");
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
    registry = ProjectRegistry.load(registryPath);
    executor = new FakeCodexExecutor();
    dispatcher = new ReadOnlyDispatcher(
      dispatcherConfig(registryPath),
      database,
      registry,
      executor,
    );
  });

  afterEach(() => {
    vi.restoreAllMocks();
    database.close();
    fs.rmSync(temporaryDirectory, { recursive: true, force: true });
  });

  it("claims only explicitly marked read-only tasks", async () => {
    database.persistIncoming(incomingEnvelope("manual-task", false), 1);
    const dispatchable = incomingEnvelope("dispatch-task", true);
    database.persistIncoming(dispatchable, 1);

    expect(await dispatcher.runOnce()).toBe(1);
    expect(executor.inputs).toHaveLength(1);
    expect(executor.inputs[0]).toMatchObject({
      projectPath: fs.realpathSync.native(projectDirectory),
      timeoutSeconds: 120,
      maxOutputBytes: 48_000,
    });
    expect(executor.inputs[0]?.prompt).toContain(
      "Do not create, edit, delete",
    );
    expect(executor.inputs[0]?.prompt).toContain(
      "The validated receiving system ID is SYS-B.",
    );
    expect(database.getStatus().inbox).toMatchObject({
      available: 1,
      processed: 1,
    });
    expect(database.getStatus().outbox.pending).toBe(1);
  });

  it("rejects projects outside the machine-local allowlist", async () => {
    const message = incomingEnvelope("unknown-project", true, "trading");
    database.persistIncoming(message, 1);

    expect(await dispatcher.runOnce()).toBe(1);
    expect(executor.inputs).toHaveLength(0);
    expect(database.getStatus().inbox.rejected).toBe(1);
    expect(database.getStatus().outbox.pending).toBe(1);
  });

  it("fails closed when worker output violates message safety policy", async () => {
    executor.result = {
      output: "-----BEGIN PRIVATE KEY-----",
    };
    database.persistIncoming(incomingEnvelope("unsafe-output", true), 1);

    expect(await dispatcher.runOnce()).toBe(1);
    expect(database.getStatus().inbox.rejected).toBe(1);
    const reply = database.leaseOutbox("test", 1, 60)[0]!;
    expect(reply.envelope.kind).toBe("task_result");
    expect(reply.envelope.payload.body).toContain(
      "rejected by the bridge safety policy",
    );
    expect(reply.envelope.payload.body).not.toContain("PRIVATE KEY");
  });

  it("does nothing when no dispatchable work exists", async () => {
    expect(await dispatcher.runOnce()).toBe(0);
    expect(executor.inputs).toHaveLength(0);
  });

  it("leaves unexpected local failures recoverable instead of rejecting the task", async () => {
    executor.error = new Error("Synthetic local database-adjacent failure");
    database.persistIncoming(incomingEnvelope("transient-error", true), 1);

    await expect(dispatcher.runOnce()).rejects.toThrow(
      /Synthetic local database-adjacent failure/,
    );
    expect(database.getStatus().inbox.claimed).toBe(1);
    expect(database.getStatus().inbox.rejected).toBe(0);
    expect(database.getStatus().outbox.pending).toBe(0);
  });

  it("renews the claim while a long-running worker is active", async () => {
    const renewal = vi.spyOn(database, "renewClaim");
    const slowDispatcher = new ReadOnlyDispatcher(
      dispatcherConfig(path.join(temporaryDirectory, "projects.json")),
      database,
      registry,
      new DelayedCodexExecutor(100),
      {
        claimLeaseSeconds: 60,
        claimRenewalIntervalMs: 10,
      },
    );
    database.persistIncoming(incomingEnvelope("renewal", true), 1);

    expect(await slowDispatcher.runOnce()).toBe(1);
    expect(renewal).toHaveBeenCalled();
    expect(database.getStatus().inbox.processed).toBe(1);
  });

  it("cancels the worker and preserves the claim when renewal fails", async () => {
    vi.spyOn(database, "renewClaim").mockImplementation(() => {
      throw new Error("Synthetic renewal failure");
    });
    const slowDispatcher = new ReadOnlyDispatcher(
      dispatcherConfig(path.join(temporaryDirectory, "projects.json")),
      database,
      registry,
      new DelayedCodexExecutor(1000),
      {
        claimLeaseSeconds: 60,
        claimRenewalIntervalMs: 10,
      },
    );
    database.persistIncoming(
      incomingEnvelope("renewal-failure", true),
      1,
    );

    await expect(slowDispatcher.runOnce()).rejects.toThrow(
      /Synthetic renewal failure/,
    );
    expect(database.getStatus().inbox.claimed).toBe(1);
    expect(database.getStatus().inbox.rejected).toBe(0);
    expect(database.getStatus().outbox.pending).toBe(0);
  });
});

class FakeCodexExecutor implements CodexExecutor {
  public readonly inputs: CodexExecutionInput[] = [];
  public result: CodexExecutionResult = {
    output: "The repository is clean and its tests pass.",
  };
  public error?: Error;

  public async execute(
    input: CodexExecutionInput,
  ): Promise<CodexExecutionResult> {
    this.inputs.push(input);
    if (this.error) {
      throw this.error;
    }
    return this.result;
  }
}

class DelayedCodexExecutor implements CodexExecutor {
  public constructor(private readonly delayMs: number) {}

  public async execute(
    input: CodexExecutionInput,
  ): Promise<CodexExecutionResult> {
    return new Promise<CodexExecutionResult>((resolve, reject) => {
      const timer = setTimeout(
        () => resolve({ output: "Delayed read-only answer." }),
        this.delayMs,
      );
      const abort = (): void => {
        clearTimeout(timer);
        reject(new Error("Synthetic worker cancellation"));
      };
      input.abortSignal?.addEventListener("abort", abort, {
        once: true,
      });
      if (input.abortSignal?.aborted) {
        abort();
      }
    });
  }
}

function dispatcherConfig(
  projectsPath: string,
): ReadOnlyDispatcherConfig {
  return {
    systemId: "SYS-B",
    authorizedNodeIds: ["SYS-A"],
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

function incomingEnvelope(
  idempotencyKey: string,
  dispatch: boolean,
  project = "voiceai",
) {
  return createEnvelope({
    idempotencyKey,
    originSystem: "SYS-A",
    targetSystem: "SYS-B",
    kind: "task_request",
    streamId: "dispatcher-component",
    payload: {
      subject: "Inspect project",
      body: "Report branch and test status.",
      project,
      evidence: [],
      ...(dispatch
        ? {
            dispatch: {
              executor: "codex_cli" as const,
              access: "read_only" as const,
              timeout_seconds: 120,
            },
          }
        : {}),
    },
  });
}
