import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { expect, it } from "vitest";

it("explicit pilot preparation creates a ledger once and read-only status does not reset it", () => {
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "pilot-cli-test-")));
  const config = path.join(root, "pilot.json");
  fs.writeFileSync(config, JSON.stringify({
    schema_version: "river-pilot.v1", run_id: "20f4ef56-f06d-4391-ac3a-46c6b06af514",
    system_id: "SYS-A", resource_id: "balcony-agent-bridge", model: "approved-test-model",
    ledger_path: path.join(root, "launches.sqlite3"),
    billing_mode: "subscription_only", billing_verified_until_utc: "2026-10-08T00:00:00Z",
    maximum_launches: 6, execution_timeout_seconds: 120, root_timeout_seconds: 300,
    maximum_rounds: 2, maximum_depth: 1, final_answer_characters: 4000, maximum_output_bytes: 48000,
  }));
  const repository = path.resolve(import.meta.dirname, "../..");
  const command = (operation: string) => spawnSync(process.execPath, [
    "--import", "tsx", path.join(repository, "src/dispatcher/pilot-cli.ts"),
    operation, "--config", config,
  ], {
    cwd: repository, env: { ...process.env, BALCONY_SYSTEM_ID: "SYS-A" },
    encoding: "utf8", windowsHide: true, timeout: 15_000,
  });
  try {
    const first = command("prepare");
    expect(first.status, first.stderr).toBe(0);
    const status = command("status");
    expect(status.status, status.stderr).toBe(0);
    expect(JSON.parse(status.stdout)).toMatchObject({ consumed: 0, remaining: 6, active: false });
    const before = fs.readFileSync(path.join(root, "launches.sqlite3"));
    expect(command("prepare").status).toBe(1);
    expect(fs.readFileSync(path.join(root, "launches.sqlite3"))).toEqual(before);
    const changed = JSON.parse(fs.readFileSync(config, "utf8")) as { run_id: string };
    changed.run_id = "a11767c3-7e90-48d3-bf8c-4e31f45f5cc3";
    fs.writeFileSync(config, JSON.stringify(changed));
    const mismatch = command("status");
    expect(mismatch.status).toBe(1);
    expect(mismatch.stdout).toBe("");
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
}, 30_000);
