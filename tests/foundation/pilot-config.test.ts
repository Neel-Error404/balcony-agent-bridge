import path from "node:path";
import { expect, it } from "vitest";
import { loadReadOnlyDispatcherConfig } from "../../src/config.js";

function environment() {
  return {
    BALCONY_SYSTEM_ID: "SYS-A", BALCONY_AUTHORIZED_NODE_IDS: "SYS-B",
    BALCONY_DISPATCHER_PROJECTS_PATH: path.resolve("projects.json"),
    BALCONY_CODEX_EXECUTABLE: path.resolve("codex.exe"),
    BALCONY_CODEX_EXECUTABLE_SHA256: "a".repeat(64),
    BALCONY_CODEX_CODE_MODE_HOST_EXECUTABLE: path.resolve("codex-code-mode-host.exe"),
    BALCONY_CODEX_CODE_MODE_HOST_SHA256: "b".repeat(64),
    BALCONY_DISPATCHER_CODEX_HOME: path.resolve("home"),
    BALCONY_DISPATCHER_TRUSTED_PATH: "approved",
    BALCONY_DISPATCHER_MODE: "consultation",
    BALCONY_CONSULTATION_WORKING_DIRECTORY: path.resolve("neutral"),
    BALCONY_GIT_EXECUTABLE: path.resolve("git.exe"),
    BALCONY_GIT_EXECUTABLE_SHA256: "c".repeat(64),
  };
}
it("projects only an explicit absolute pilot configuration path", () => {
  const pilotPath = path.resolve("pilot.json");
  expect(loadReadOnlyDispatcherConfig({
    ...environment(), BALCONY_DISPATCHER_PILOT_CONFIG_PATH: pilotPath,
  })).toMatchObject({ pilotConfigPath: pilotPath });
  expect(() => loadReadOnlyDispatcherConfig({
    ...environment(), BALCONY_DISPATCHER_PILOT_CONFIG_PATH: "relative.json",
  })).toThrow(/pilot|absolute/i);
  expect(loadReadOnlyDispatcherConfig(environment())).not.toHaveProperty("pilotConfigPath");
});
