import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import type { ConsultationRun } from "../../src/contracts/consultation.js";
import { BridgeDatabase } from "../../src/storage/database.js";

describe("durable consultation runs", () => {
  const temporaryDirectories: string[] = [];
  const databases: BridgeDatabase[] = [];

  afterEach(() => {
    for (const database of databases) {
      database.close();
    }
    for (const directory of temporaryDirectories) {
      fs.rmSync(directory, { recursive: true, force: true });
    }
    databases.length = 0;
    temporaryDirectories.length = 0;
  });

  it("parks and resumes a versioned run after reopening SQLite", () => {
    const directory = temporaryDirectory();
    const databasePath = path.join(directory, "bridge.sqlite3");
    let database = openDatabase(databasePath);
    const initial = initialRun();

    const created = database.ensureConsultationRun(initial);
    expect(created).toMatchObject({
      created: true,
      run: {
        request_message_id: initial.request_message_id,
        state: "pending_child",
        version: 0,
      },
    });

    const parked = database.saveConsultationRun(
      {
        ...created.run,
        state: "needs_information",
        requested_evidence: ["README.md"],
      },
      created.run.version,
      new Date("2026-08-17T12:00:01.000Z"),
    );
    expect(parked).toMatchObject({
      state: "needs_information",
      requested_evidence: ["README.md"],
      version: 1,
    });

    database.close();
    databases.splice(databases.indexOf(database), 1);
    database = openDatabase(databasePath);
    expect(
      database.getConsultationRun(initial.request_message_id),
    ).toEqual(parked);
  });

  it("returns the authoritative run for duplicate initialization", () => {
    const database = openDatabase(":memory:");
    const initial = initialRun();

    expect(database.ensureConsultationRun(initial).created).toBe(true);
    const duplicate = database.ensureConsultationRun(initial);

    expect(duplicate).toMatchObject({
      created: false,
      run: {
        request_message_id: initial.request_message_id,
        version: 0,
      },
    });
  });

  it("rejects stale writers with optimistic version fencing", () => {
    const database = openDatabase(":memory:");
    const created = database.ensureConsultationRun(initialRun()).run;
    database.saveConsultationRun(
      {
        ...created,
        state: "needs_information",
        requested_evidence: ["README.md"],
      },
      created.version,
    );

    expect(() =>
      database.saveConsultationRun(
        {
          ...created,
          state: "failed",
          error_code: "STALE_WRITER",
        },
        created.version,
      ),
    ).toThrow(/version|stale/i);
  });

  it("reports consultation state counts and coordinator heartbeat", () => {
    const database = openDatabase(":memory:");
    const first = database.ensureConsultationRun(initialRun()).run;
    database.saveConsultationRun(
      {
        ...first,
        state: "needs_information",
        requested_evidence: ["README.md"],
      },
      first.version,
    );
    database.recordConsultationCoordinatorHeartbeat(
      "coordinator-test",
      "healthy",
      undefined,
      new Date("2026-08-17T13:00:00.000Z"),
    );

    expect(database.getStatus()).toMatchObject({
      consultation: {
        pending_child: 0,
        needs_information: 1,
        waiting_peer: 0,
        completed: 0,
        failed: 0,
      },
      consultationCoordinatorRuntimeStatus: "healthy",
      consultationCoordinatorHeartbeatAtUtc:
        "2026-08-17T13:00:00.000Z",
    });
  });

  function temporaryDirectory(): string {
    const directory = fs.mkdtempSync(
      path.join(os.tmpdir(), "balcony-consultation-db-"),
    );
    temporaryDirectories.push(directory);
    return directory;
  }

  function openDatabase(databasePath: string): BridgeDatabase {
    const database = new BridgeDatabase(databasePath);
    databases.push(database);
    return database;
  }
});

function initialRun(): ConsultationRun {
  return {
    schema_version: "1.0",
    request_message_id: "11111111-1111-4111-8111-111111111111",
    conversation_id: "22222222-2222-4222-8222-222222222222",
    root_request_id: "11111111-1111-4111-8111-111111111111",
    project: "balcony-agent-bridge",
    state: "pending_child",
    round_count: 0,
    depth: 0,
    max_rounds: 4,
    max_depth: 2,
    ancestry_fingerprints: [
      "d0d55f3d76afca72fbda973398f70021a955a5d22d1ac7cce5c9aacf284a03ca",
    ],
    deadline_at_utc: "2026-08-17T12:15:00.000Z",
    evidence: {
      schema_version: "1.0",
      project: "balcony-agent-bridge",
      generated_at_utc: "2026-08-17T12:00:00.000Z",
      total_bytes: 0,
      items: [],
    },
    version: 0,
    created_at_utc: "2026-08-17T12:00:00.000Z",
    updated_at_utc: "2026-08-17T12:00:00.000Z",
  };
}
