import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, expect, it } from "vitest";
import Database from "better-sqlite3";
import { CodexExecutionError } from "../../src/errors.js";

import {
  initializePilotLedger, PilotCodexExecutor, type PilotConfiguration,
  createPilotExecution,
  validatePilotRegistry,
} from "../../src/dispatcher/pilot-executor.js";

let root: string;
let config: PilotConfiguration;
beforeEach(() => {
  root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "river-pilot-test-")));
  config = {
    schema_version: "river-pilot.v1",
    run_id: "20f4ef56-f06d-4391-ac3a-46c6b06af514",
    system_id: "SYS-A",
    resource_id: "balcony-agent-bridge",
    model: "approved-test-model",
    ledger_path: path.join(root, "launches.sqlite3"),
    billing_mode: "subscription_only",
    billing_verified_until_utc: "2026-10-08T00:00:00.000Z",
    maximum_launches: 6, execution_timeout_seconds: 120,
    root_timeout_seconds: 300, maximum_rounds: 2, maximum_depth: 1,
    final_answer_characters: 4000, maximum_output_bytes: 48000,
  };
});
afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

it("refuses the seventh launch after restart without resetting consumed reservations", async () => {
  initializePilotLedger(config);
  let launches = 0;
  const delegate = { execute: async () => { launches++; return { output: "Test answer." }; } };
  const first = new PilotCodexExecutor(config, delegate, () => new Date("2026-10-07T00:00:00Z"));
  try {
    for (let i = 0; i < 3; i++) await first.execute({
      projectPath: root, prompt: "Private prompt must not be stored.",
      timeoutSeconds: 600, maxOutputBytes: 60000,
    });
  } finally { first.close(); }
  const restarted = new PilotCodexExecutor(config, delegate, () => new Date("2026-10-07T00:00:00Z"));
  try {
    for (let i = 0; i < 3; i++) await restarted.execute({
      projectPath: root, prompt: "Read-only fixture.", timeoutSeconds: 120, maxOutputBytes: 48000,
    });
    await expect(restarted.execute({
      projectPath: root, prompt: "Seventh.", timeoutSeconds: 120, maxOutputBytes: 48000,
    })).rejects.toMatchObject({ code: "PILOT_BUDGET_EXHAUSTED" });
    expect(launches).toBe(6);
    expect(restarted.status()).toMatchObject({ consumed: 6, remaining: 0, active: false });
  } finally { restarted.close(); }
});

it("consumes failed launches and records only safe execution metadata", async () => {
  initializePilotLedger(config);
  const worker = new PilotCodexExecutor(config, {
    execute: async () => { throw new CodexExecutionError("CODEX_EXIT_FAILED", "Private diagnostic must not be stored."); },
  }, () => new Date("2026-10-07T00:00:00Z"));
  try {
    await expect(worker.execute({
      projectPath: root, prompt: "Private prompt must not be stored.",
      timeoutSeconds: 120, maxOutputBytes: 48000,
    })).rejects.toThrow("Private diagnostic");
    expect(worker.status()).toMatchObject({ consumed: 1, remaining: 5, active: false });
  } finally { worker.close(); }
  const database = new Database(config.ledger_path, { readonly: true });
  try {
    const serialized = JSON.stringify(database.prepare("SELECT * FROM pilot_launches").all());
    expect(serialized).not.toContain("Private");
    expect(database.prepare("SELECT model,run_id,system_id FROM pilot_identity").get())
      .toMatchObject({ model: config.model, run_id: config.run_id, system_id: config.system_id });
  } finally { database.close(); }
});

it("blocks another executor while one reservation remains active", async () => {
  initializePilotLedger(config);
  let finish!: () => void;
  const first = new PilotCodexExecutor(config, {
    execute: () => new Promise(resolve => { finish = () => resolve({ output: "safe" }); }),
  }, () => new Date("2026-10-07T00:00:00Z"));
  const second = new PilotCodexExecutor(config, { execute: async () => ({ output: "must not launch" }) },
    () => new Date("2026-10-07T00:00:00Z"));
  try {
    const running = first.execute({ projectPath: root, prompt: "fixture", timeoutSeconds: 120, maxOutputBytes: 48000 });
    await expect(second.execute({ projectPath: root, prompt: "fixture", timeoutSeconds: 120, maxOutputBytes: 48000 }))
      .rejects.toMatchObject({ code: "CODEX_TERMINATION_FAILED" });
    finish();
    await running;
    expect(second.status().consumed).toBe(1);
  } finally { first.close(); second.close(); }
});

it("refuses missing ledgers and does not reinitialize an existing ledger", () => {
  expect(() => new PilotCodexExecutor(config, { execute: async () => ({ output: "" }) })).toThrow();
  initializePilotLedger(config);
  expect(() => initializePilotLedger(config)).toThrow();
});

it("rejects API-key authentication and applies pilot settings only when explicitly configured", () => {
  initializePilotLedger(config);
  const configPath = path.join(root, "pilot.json");
  fs.writeFileSync(configPath, JSON.stringify(config));
  fs.writeFileSync(path.join(root, "auth.json"), JSON.stringify({ auth_mode: "apikey", OPENAI_API_KEY: "synthetic" }));
  const delegate = { execute: async () => ({ output: "safe" }) };
  const clock = () => new Date("2026-10-07T00:00:00Z");
  expect(() => createPilotExecution(configPath, "SYS-A", root, delegate, clock)).toThrow(/subscription|sign-in/i);
  fs.writeFileSync(path.join(root, "auth.json"), JSON.stringify({ auth_mode: "chatgpt", tokens: { access_token: "synthetic" } }));
  const configured = createPilotExecution(configPath, "SYS-A", root, delegate, clock);
  try { expect(configured.pilot).toMatchObject({ maximum_launches: 6, maximum_rounds: 2 }); }
  finally { configured.close(); }
  expect(createPilotExecution(undefined, "SYS-A", root, delegate).executor).toBe(delegate);
});

it("enforces timeout/output bounds and rejects oversized final answers before success", async () => {
  initializePilotLedger(config);
  let received: { timeoutSeconds: number; maxOutputBytes: number } | undefined;
  const worker = new PilotCodexExecutor(config, {
    execute: async input => {
      received = input;
      return { output: JSON.stringify({ outcome: "completed", answer: "x".repeat(4001) }) };
    },
  }, () => new Date("2026-10-07T00:00:00Z"));
  try {
    await expect(worker.execute({
      projectPath: root, prompt: "fixture", timeoutSeconds: 600, maxOutputBytes: 60000,
    })).rejects.toMatchObject({ code: "CODEX_OUTPUT_INVALID" });
    expect(received).toMatchObject({ timeoutSeconds: 120, maxOutputBytes: 48000 });
    expect(worker.status()).toMatchObject({ consumed: 1, active: false });
  } finally { worker.close(); }
});

it("retains uncertain launches across restart rather than releasing the active slot", async () => {
  initializePilotLedger(config);
  const worker = new PilotCodexExecutor(config, {
    execute: async () => { throw new CodexExecutionError("CODEX_TERMINATION_FAILED", "synthetic"); },
  }, () => new Date("2026-10-07T00:00:00Z"));
  try {
    await expect(worker.execute({
      projectPath: root, prompt: "fixture", timeoutSeconds: 120, maxOutputBytes: 48000,
    })).rejects.toMatchObject({ code: "CODEX_TERMINATION_FAILED" });
  } finally { worker.close(); }
  const restart = new PilotCodexExecutor(config, { execute: async () => ({ output: "must not launch" }) },
    () => new Date("2026-10-07T00:00:00Z"));
  try {
    await expect(restart.execute({
      projectPath: root, prompt: "fixture", timeoutSeconds: 120, maxOutputBytes: 48000,
    })).rejects.toMatchObject({ code: "CODEX_TERMINATION_FAILED" });
    expect(restart.status()).toMatchObject({ consumed: 1, active: true });
  } finally { restart.close(); }
});

it("requires only the pinned River resource to be enabled for the pilot", () => {
  const file = path.join(root, "registry.json");
  const bridge = {
    key: "balcony-agent-bridge", path: root, enabled: true, peer_readable: true,
    evidence: { provider: "pinned_git", revision: "a".repeat(40) },
  };
  fs.writeFileSync(file, JSON.stringify({ schema_version: "1.2", projects: [bridge] }));
  expect(() => validatePilotRegistry(file)).not.toThrow();
  fs.writeFileSync(file, JSON.stringify({
    schema_version: "1.2", projects: [bridge, { ...bridge, key: "other" }],
  }));
  expect(() => validatePilotRegistry(file)).toThrow(/only|River|pilot/i);
});

it("rechecks subscription sign-in before each launch after authentication files change", async () => {
  initializePilotLedger(config);
  const configPath = path.join(root, "pilot.json");
  fs.writeFileSync(configPath, JSON.stringify(config));
  const auth = path.join(root, "auth.json");
  fs.writeFileSync(auth, JSON.stringify({ auth_mode: "chatgpt", tokens: { access_token: "synthetic" } }));
  let launched = 0;
  const worker = createPilotExecution(configPath, "SYS-A", root, {
    execute: async () => { launched++; return { output: "safe" }; },
  }, () => new Date("2026-10-07T00:00:00Z"));
  try {
    fs.writeFileSync(auth, JSON.stringify({ auth_mode: "apikey", OPENAI_API_KEY: "synthetic" }));
    await expect(worker.executor.execute({
      projectPath: root, prompt: "fixture", timeoutSeconds: 120, maxOutputBytes: 48000,
    })).rejects.toThrow(/subscription|sign-in/i);
    expect(launched).toBe(0);
  } finally { worker.close(); }
});

it("binds each reservation to a safe causal request ID without storing the prompt", async () => {
  initializePilotLedger(config);
  const requestMessageId = "c119b844-37c2-471a-8f2d-dee0893c1e0a";
  const worker = new PilotCodexExecutor(config, { execute: async () => ({ output: "safe" }) },
    () => new Date("2026-10-07T00:00:00Z"));
  try {
    await worker.execute({
      projectPath: root, requestMessageId, prompt: "private", timeoutSeconds: 120, maxOutputBytes: 48000,
    });
  } finally { worker.close(); }
  const database = new Database(config.ledger_path, { readonly: true });
  try {
    expect(database.prepare("SELECT request_message_id FROM pilot_launches").get())
      .toEqual({ request_message_id: requestMessageId });
  } finally { database.close(); }
});
