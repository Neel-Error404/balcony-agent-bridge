import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";

describe("database migration concurrency", () => {
  it("serializes simultaneous first opens of a pre-dispatcher schema", async () => {
    const temporaryDirectory = fs.mkdtempSync(
      path.join(os.tmpdir(), "balcony-migration-concurrency-"),
    );
    const databasePath = path.join(
      temporaryDirectory,
      "bridge.sqlite3",
    );
    createVersionOneDatabase(databasePath);
    try {
      const [first, second] = await Promise.all([
        openInChild(databasePath),
        openInChild(databasePath),
      ]);
      expect(first).toMatchObject({ exitCode: 0, stderr: "" });
      expect(second).toMatchObject({ exitCode: 0, stderr: "" });

      const database = new Database(databasePath, { readonly: true });
      try {
        const columns = database
          .prepare("PRAGMA table_info(inbox)")
          .all() as Array<{ name: string }>;
        expect(
          columns
            .map((column) => column.name)
            .filter((name) => name.startsWith("result_"))
            .sort(),
        ).toEqual([
          "result_idempotency_key",
          "result_message_id",
          "result_payload_sha256",
        ]);
        expect(columns.map((column) => column.name)).toContain(
          "authenticated_ingress",
        );
        const tableSql = database
          .prepare(
            "SELECT sql FROM sqlite_master WHERE type = 'table' AND name IN ('inbox', 'outbox')",
          )
          .all() as Array<{ sql: string }>;
        expect(tableSql.map((row) => row.sql).join("\n")).not.toContain(
          "SYS-A",
        );
        const migration = database
          .prepare(
            "SELECT COUNT(*) AS count FROM schema_migrations WHERE version = 7",
          )
          .get() as { count: number };
        expect(migration.count).toBe(1);
      } finally {
        database.close();
      }
    } finally {
      fs.rmSync(temporaryDirectory, {
        recursive: true,
        force: true,
      });
    }
  });
});

function createVersionOneDatabase(databasePath: string): void {
  const database = new Database(databasePath);
  try {
    database.exec(`
      CREATE TABLE schema_migrations (
        version INTEGER PRIMARY KEY,
        applied_at_utc TEXT NOT NULL
      );
      INSERT INTO schema_migrations (version, applied_at_utc)
      VALUES (1, '2026-08-13T00:00:00.000Z');

      CREATE TABLE inbox (
        message_id TEXT PRIMARY KEY,
        origin_system TEXT NOT NULL,
        kind TEXT NOT NULL,
        stream_id TEXT NOT NULL,
        payload_sha256 TEXT NOT NULL,
        envelope_json TEXT NOT NULL,
        state TEXT NOT NULL,
        claim_owner TEXT,
        claim_token_hash TEXT,
        claim_until_utc TEXT,
        attempt_count INTEGER NOT NULL DEFAULT 0,
        first_received_at_utc TEXT NOT NULL,
        last_received_at_utc TEXT NOT NULL,
        broker_delivery_count INTEGER NOT NULL DEFAULT 0,
        processed_at_utc TEXT,
        last_error TEXT
      );
    `);
  } finally {
    database.close();
  }
}

async function openInChild(
  databasePath: string,
): Promise<{ exitCode: number | null; stderr: string }> {
  const script = [
    'import { BridgeDatabase } from "./src/storage/database.ts";',
    "const database = new BridgeDatabase(process.argv[1]);",
    "database.close();",
  ].join(" ");
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [
        "--import",
        "tsx",
        "--input-type=module",
        "--eval",
        script,
        databasePath,
      ],
      {
        cwd: path.resolve(
          path.dirname(fileURLToPath(import.meta.url)),
          "../..",
        ),
        env: process.env,
        shell: false,
        windowsHide: true,
        stdio: ["ignore", "ignore", "pipe"],
      },
    );
    const stderr: Buffer[] = [];
    child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
    child.once("error", reject);
    child.once("close", (exitCode) =>
      resolve({
        exitCode,
        stderr: Buffer.concat(stderr).toString("utf8").trim(),
      }),
    );
  });
}
