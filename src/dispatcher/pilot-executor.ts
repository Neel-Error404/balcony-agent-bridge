import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import Database from "better-sqlite3";
import { z } from "zod";

import { BridgeError, CodexExecutionError, DispatchConfigurationError } from "../errors.js";
import type { CodexExecutionInput, CodexExecutionResult, CodexExecutor } from "./codex-executor.js";
import { ProjectRegistrySchema } from "./project-registry.js";

export const PilotConfigurationSchema = z.object({
  schema_version: z.literal("river-pilot.v1"),
  run_id: z.string().uuid(),
  system_id: z.enum(["SYS-A", "SYS-B"]),
  resource_id: z.literal("balcony-agent-bridge"),
  model: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,99}$/),
  ledger_path: z.string().refine(value => path.isAbsolute(value), "Ledger path must be absolute."),
  billing_mode: z.literal("subscription_only"),
  billing_verified_until_utc: z.string().datetime(),
  maximum_launches: z.literal(6),
  execution_timeout_seconds: z.literal(120),
  root_timeout_seconds: z.literal(300),
  maximum_rounds: z.literal(2),
  maximum_depth: z.literal(1),
  final_answer_characters: z.literal(4000),
  maximum_output_bytes: z.literal(48000),
}).strict();

export type PilotConfiguration = z.infer<typeof PilotConfigurationSchema>;

export function validatePilotRegistry(file: string): void {
  assertLocalFile(file);
  const registry = ProjectRegistrySchema.parse(JSON.parse(fs.readFileSync(file, "utf8")));
  const enabled = registry.projects.filter(project => project.enabled);
  if (registry.schema_version !== "1.2" || enabled.length !== 1 ||
      enabled[0]?.key !== "balcony-agent-bridge") {
    throw new DispatchConfigurationError("The pilot permits only the pinned River resource.");
  }
}

export function createPilotExecution(
  configPath: string | undefined, systemId: string, codexHome: string,
  delegate: CodexExecutor, clock: () => Date = () => new Date(),
): { executor: CodexExecutor; pilot?: PilotConfiguration; close(): void } {
  if (configPath === undefined) return { executor: delegate, close: () => undefined };
  const pilot = readPilotConfiguration(configPath, systemId);
  assertSubscriptionSignIn(codexHome);
  if (Date.parse(pilot.billing_verified_until_utc) <= clock().getTime()) {
    throw new DispatchConfigurationError("Pilot subscription and no-overflow attestation must be current.");
  }
  const executor = new PilotCodexExecutor(pilot, delegate, clock, () => assertSubscriptionSignIn(codexHome));
  if (executor.status().active) {
    executor.close();
    throw new CodexExecutionError("CODEX_TERMINATION_FAILED", "Pilot ledger retains an unverified launch; operator quiescence proof is required.");
  }
  return { executor, pilot, close: () => executor.close() };
}

function assertSubscriptionSignIn(codexHome: string): void {
  const authFile = path.join(codexHome, "auth.json");
  try {
    assertLocalFile(authFile);
    const auth = JSON.parse(fs.readFileSync(authFile, "utf8")) as {
      auth_mode?: unknown; tokens?: { access_token?: unknown }; OPENAI_API_KEY?: unknown;
    };
    if (auth.auth_mode !== "chatgpt" || typeof auth.tokens?.access_token !== "string" ||
        !auth.tokens.access_token || auth.OPENAI_API_KEY) throw new Error("Not subscription sign-in.");
  } catch (error) {
    throw new DispatchConfigurationError("Pilot requires a dedicated Codex subscription sign-in; paid API authentication is prohibited.", { cause: error });
  }
}

export function readPilotConfiguration(file: string, systemId: string): PilotConfiguration {
  try {
    assertLocalFile(file);
    const config = PilotConfigurationSchema.parse(JSON.parse(fs.readFileSync(file, "utf8")));
    if (config.system_id !== systemId) throw new Error("Wrong pilot node.");
    return config;
  } catch (error) {
    throw new DispatchConfigurationError("Pilot configuration is invalid or belongs to another node.", { cause: error });
  }
}

/** Explicit preparation only. Runtime never creates or resets a missing ledger. */
export function initializePilotLedger(value: PilotConfiguration): void {
  const config = PilotConfigurationSchema.parse(value);
  assertLocalParents(config.ledger_path);
  const descriptor = fs.openSync(config.ledger_path, "wx", 0o600);
  fs.closeSync(descriptor);
  const database = new Database(config.ledger_path);
  try {
    database.pragma("synchronous = FULL");
    database.exec(`
      CREATE TABLE pilot_identity (
        singleton INTEGER PRIMARY KEY CHECK(singleton=1), digest TEXT NOT NULL,
        run_id TEXT NOT NULL, system_id TEXT NOT NULL, model TEXT NOT NULL
      );
      CREATE TABLE pilot_launches (
        sequence INTEGER PRIMARY KEY, launch_id TEXT UNIQUE NOT NULL,
        request_message_id TEXT,
        started_at_utc TEXT NOT NULL, finished_at_utc TEXT,
        outcome TEXT NOT NULL CHECK(outcome IN ('reserved','succeeded','failed','uncertain')),
        error_code TEXT
      );
    `);
    database.prepare("INSERT INTO pilot_identity VALUES (1, ?, ?, ?, ?)")
      .run(configurationDigest(config), config.run_id, config.system_id, config.model);
  } finally { database.close(); }
}

export class PilotCodexExecutor implements CodexExecutor {
  private readonly database: Database.Database;
  private readonly config: PilotConfiguration;

  public constructor(
    value: PilotConfiguration,
    private readonly delegate: CodexExecutor,
    private readonly clock: () => Date = () => new Date(),
    private readonly beforeLaunch: () => void = () => undefined,
  ) {
    this.config = PilotConfigurationSchema.parse(value);
    assertLocalFile(this.config.ledger_path);
    this.database = new Database(this.config.ledger_path, { fileMustExist: true });
    try {
      this.database.pragma("busy_timeout = 5000");
      this.database.pragma("synchronous = FULL");
      const identity = this.database.prepare("SELECT digest FROM pilot_identity WHERE singleton=1").get() as
        { digest: string } | undefined;
      if (identity?.digest !== configurationDigest(this.config)) {
        throw new Error("Pilot ledger identity differs from its approved configuration.");
      }
    } catch (error) {
      this.database.close();
      throw new DispatchConfigurationError("Pilot ledger is missing, invalid or changed; do not reset it.", { cause: error });
    }
  }

  public status(): { consumed: number; remaining: number; active: boolean } {
    const row = this.database.prepare(
      "SELECT COUNT(*) AS consumed, COALESCE(SUM(outcome IN ('reserved','uncertain')),0) AS active FROM pilot_launches",
    ).get() as { consumed: number; active: number };
    return { consumed: row.consumed, remaining: Math.max(0, 6 - row.consumed), active: row.active > 0 };
  }

  public async execute(input: CodexExecutionInput): Promise<CodexExecutionResult> {
    if (input.abortSignal?.aborted) {
      throw new CodexExecutionError("CODEX_ABORTED", "Pilot execution was cancelled before reservation.");
    }
    if (Date.parse(this.config.billing_verified_until_utc) <= this.clock().getTime()) {
      throw new DispatchConfigurationError("Pilot subscription attestation expired; reverify billing before execution.");
    }
    this.beforeLaunch();
    const requestMessageId = input.requestMessageId === undefined
      ? null : z.string().uuid().parse(input.requestMessageId);
    const reservation = this.database.transaction(() => {
      const status = this.status();
      if (status.active) {
        throw new CodexExecutionError("CODEX_TERMINATION_FAILED", "Prior pilot execution has unverified quiescence.");
      }
      if (status.consumed >= 6) {
        throw new BridgeError("PILOT_BUDGET_EXHAUSTED", "This node's six pilot launches are consumed.");
      }
      const id = randomUUID();
      this.database.prepare(
        "INSERT INTO pilot_launches(sequence,launch_id,started_at_utc,request_message_id,outcome) VALUES (?,?,?,?,'reserved')",
      ).run(status.consumed + 1, id, this.clock().toISOString(), requestMessageId);
      return id;
    }).immediate();
    try {
      const result = await this.delegate.execute({
        ...input,
        timeoutSeconds: Math.min(input.timeoutSeconds, 120),
        maxOutputBytes: Math.min(input.maxOutputBytes, 48000),
        prompt: `${input.prompt}\n\nPilot limit: final answer must be at most 4000 characters.`,
      });
      if (input.abortSignal?.aborted) {
        throw new CodexExecutionError("CODEX_ABORTED", "Pilot cancellation prevents publishing the answer.");
      }
      let answer = result.output;
      try {
        const parsed: unknown = JSON.parse(result.output);
        if (parsed && typeof parsed === "object" && "answer" in parsed &&
            typeof parsed.answer === "string") answer = parsed.answer;
      } catch { /* Plain read-only executor output is also supported. */ }
      if (Buffer.byteLength(result.output, "utf8") > 48000 || answer.length > 4000) {
        throw new CodexExecutionError("CODEX_OUTPUT_INVALID", "Pilot final output exceeded its approved limit.");
      }
      this.finish(reservation, "succeeded");
      return result;
    } catch (error) {
      const uncertain = !(error instanceof CodexExecutionError) || error.code === "CODEX_TERMINATION_FAILED";
      const code = error instanceof BridgeError ? error.code : "PILOT_EXECUTION_FAILED";
      this.finish(reservation, uncertain ? "uncertain" : "failed", code);
      throw error;
    }
  }

  public close(): void { this.database.close(); }

  private finish(id: string, outcome: "succeeded" | "failed" | "uncertain", code?: string): void {
    const changed = this.database.prepare(
      "UPDATE pilot_launches SET outcome=?,finished_at_utc=?,error_code=? WHERE launch_id=? AND outcome='reserved'",
    ).run(outcome, this.clock().toISOString(), code ?? null, id);
    if (changed.changes !== 1) throw new Error("Pilot reservation settlement failed; verify execution before recovery.");
  }
}

export function configurationDigest(config: PilotConfiguration): string {
  return createHash("sha256").update(JSON.stringify(PilotConfigurationSchema.parse(config))).digest("hex");
}

function assertLocalFile(file: string): void {
  assertLocalParents(file);
  if (!fs.lstatSync(file).isFile() || fs.lstatSync(file).isSymbolicLink()) {
    throw new DispatchConfigurationError("Pilot file must be a regular local file.");
  }
}

function assertLocalParents(file: string): void {
  if (!path.isAbsolute(file) || file.startsWith("\\\\") || file.startsWith("//")) {
    throw new DispatchConfigurationError("Pilot paths must be absolute local paths.");
  }
  let parent = path.dirname(file);
  while (true) {
    const stat = fs.lstatSync(parent);
    if (!stat.isDirectory() || stat.isSymbolicLink()) {
      throw new DispatchConfigurationError("Pilot paths must not traverse links.");
    }
    const next = path.dirname(parent);
    if (next === parent) break;
    parent = next;
  }
}
