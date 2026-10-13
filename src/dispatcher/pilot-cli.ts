#!/usr/bin/env node
import { parseArgs } from "node:util";
import Database from "better-sqlite3";
import { configurationDigest, initializePilotLedger, readPilotConfiguration } from "./pilot-executor.js";
import { safeErrorCode } from "../security/sanitize-error.js";

try {
  const { positionals, values } = parseArgs({
    allowPositionals: true, strict: true, options: { config: { type: "string" } },
  });
  const [operation] = positionals;
  if (positionals.length !== 1 || !values.config ||
      !["prepare", "status"].includes(operation ?? "") ||
      !["SYS-A", "SYS-B"].includes(process.env["BALCONY_SYSTEM_ID"] ?? "")) {
    throw new Error("Usage: pilot-cli <prepare|status> --config <absolute-path>; set BALCONY_SYSTEM_ID.");
  }
  const config = readPilotConfiguration(values.config, process.env["BALCONY_SYSTEM_ID"]!);
  if (operation === "prepare") {
    initializePilotLedger(config);
    process.stdout.write(JSON.stringify({ prepared: true, run_id: config.run_id, system_id: config.system_id }) + "\n");
  } else {
    const database = new Database(config.ledger_path, { readonly: true, fileMustExist: true });
    try {
      const identity = database.prepare("SELECT digest FROM pilot_identity WHERE singleton=1")
        .get() as { digest: string } | undefined;
      if (identity?.digest !== configurationDigest(config)) {
        throw new Error("Pilot ledger belongs to a different approved run.");
      }
      const status = database.prepare(
        "SELECT COUNT(*) AS consumed, COALESCE(SUM(outcome IN ('reserved','uncertain')),0) AS active FROM pilot_launches",
      ).get() as { consumed: number; active: number };
      process.stdout.write(JSON.stringify({
        run_id: config.run_id, system_id: config.system_id, model: config.model,
        consumed: status.consumed, remaining: Math.max(0, 6 - status.consumed), active: status.active > 0,
      }) + "\n");
    } finally { database.close(); }
  }
} catch (error) {
  console.error(`Pilot operation failed (${safeErrorCode(error)}). No ledger reset or recovery was performed.`);
  process.exitCode = 1;
}
