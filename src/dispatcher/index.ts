#!/usr/bin/env node

import { parseArgs } from "node:util";
import path from "node:path";

import {
  loadConfig,
  loadConfigFile,
  assertConfigMatchesProcessIdentity,
  loadReadOnlyDispatcherConfig,
  type ReadOnlyDispatcherConfig,
} from "../config.js";
import {
  AutonomousConsultationCoordinator,
  type ConsultationEvidenceProvider,
} from "../coordination/autonomous-consultation-coordinator.js";
import { DispatchConfigurationError } from "../errors.js";
import { PinnedGitEvidenceProvider } from "../evidence/pinned-git-evidence-provider.js";
import { safeErrorCode } from "../security/sanitize-error.js";
import { BridgeDatabase } from "../storage/database.js";
import { LocalCodexExecutor } from "./codex-executor.js";
import { ReadOnlyDispatcher } from "./dispatcher.js";
import { ProjectRegistry } from "./project-registry.js";
import { serviceParentSupervisionEnabled, superviseParent } from "../runtime/parent-supervision.js";
import { assertDispatcherTerminationVerified, runDispatcher, type ForegroundDispatcher } from "./runtime.js";
import {
  createPilotExecution, readPilotConfiguration, validatePilotRegistry,
} from "./pilot-executor.js";
import type { CodexExecutor } from "./codex-executor.js";

try {
  const { values, positionals } = parseArgs({
    args: process.argv.slice(2),
    allowPositionals: true,
    strict: true,
    options: {
      help: { type: "boolean", short: "h" },
      "validate-config": { type: "boolean" },
      config: { type: "string" },
    },
  });
  if (positionals.length > 0) {
    throw new DispatchConfigurationError(
      "The foreground dispatcher does not accept positional arguments.",
    );
  }
  if (values.config !== undefined && !path.isAbsolute(values.config)) {
    throw new DispatchConfigurationError(
      "The foreground dispatcher --config path must be absolute.",
    );
  }
  if (values.help) {
    process.stdout.write(
      "Usage: balcony-agent-bridge runtime dispatcher --root <absolute-path> [--validate]\n" +
      "Internal: node dist/dispatcher/index.js [--config <absolute-path>] [--validate-config]\n",
    );
  } else {
    const parentSupervised = serviceParentSupervisionEnabled(
      process.env["BALCONY_RUNTIME_SUPERVISION"],
    );
    const bridgeConfig = values.config
      ? assertConfigMatchesProcessIdentity(loadConfigFile(values.config))
      : loadConfig();
    const config = loadReadOnlyDispatcherConfig(process.env, bridgeConfig);
    if (config.pilotConfigPath && config.mode !== "consultation") {
      throw new DispatchConfigurationError("Pilot execution requires pinned-evidence consultation mode.");
    }
    const pilot = config.pilotConfigPath
      ? readPilotConfiguration(config.pilotConfigPath, config.systemId)
      : undefined;
    if (pilot) validatePilotRegistry(config.projectsPath);
    const database = new BridgeDatabase(config.databasePath);
    // Must run before supervision callbacks or healthy startup can overwrite
    // a durable unverified-executor failure left by the prior service process.
    assertDispatcherTerminationVerified(database);
    const projects = ProjectRegistry.load(config.projectsPath);
    const localExecutor = new LocalCodexExecutor(
      config.codexExecutable,
      config.codexHome,
      config.codexExecutableSha256,
      config.codexCodeModeHostExecutable,
      config.codexCodeModeHostSha256,
      config.trustedPath,
      process.env,
      pilot ? { model: pilot.model, combinedOutputLimit: true } : {},
    );
    const execution = createPilotExecution(config.pilotConfigPath, config.systemId, config.codexHome, localExecutor);
    const executor = execution.executor;
    if (values["validate-config"]) {
      process.stdout.write('{"ok":true,"runtime":"dispatcher"}\n');
      database.close();
      execution.close();
    } else {
      const dispatcher: ForegroundDispatcher =
        config.mode === "consultation"
          ? createConsultationDispatcher(
              config,
              bridgeConfig,
              database,
              projects,
              executor,
              pilot,
            )
          : new ReadOnlyDispatcher(
              config,
              database,
              projects,
              executor,
            );
      const controller = new AbortController();
      process.once("SIGINT", () => controller.abort());
      process.once("SIGTERM", () => controller.abort());
      const stopSupervision = superviseParent(controller, {
        enabled: parentSupervised,
        onFailure: (code) => {
          dispatcher.recordHeartbeat("degraded", code);
          console.error(`Dispatcher supervision failed (${code})`);
          process.exitCode = 1;
        },
      });
      try {
        await runDispatcher(dispatcher, controller, config.pollIntervalMs, database);
      } catch (error) {
        if (safeErrorCode(error) === "CODEX_TERMINATION_FAILED") {
          console.error("Dispatcher stopped: Codex worker quiescence requires operator verification.");
          // Do not wait indefinitely on inherited pipes or let an automatic
          // service restart claim work over an unverified surviving executor.
          process.exit(1);
        }
        throw error;
      } finally {
        stopSupervision();
        database.close();
        execution.close();
      }
    }
  }
} catch (error) {
  console.error(
    `Read-only dispatcher process failed (${safeErrorCode(error)})`,
  );
  process.exitCode = 1;
}

function createConsultationDispatcher(
  config: ReadOnlyDispatcherConfig,
  bridgeConfig: ReturnType<typeof loadConfig>,
  database: BridgeDatabase,
  projects: ProjectRegistry,
  executor: CodexExecutor,
  pilot?: ReturnType<typeof readPilotConfiguration>,
): AutonomousConsultationCoordinator {
  if (
    !config.consultationWorkingDirectory ||
    !config.gitExecutable ||
    !config.gitExecutableSha256
  ) {
    throw new DispatchConfigurationError(
      "Consultation mode requires its working directory and pinned Git executable.",
    );
  }
  const pinnedGit = new PinnedGitEvidenceProvider({
    requireClean: true,
    gitExecutable: config.gitExecutable,
    gitExecutableSha256: config.gitExecutableSha256,
  });
  const evidenceProvider: ConsultationEvidenceProvider = {
    collect(input) {
      const project = projects.get(input.project);
      if (!project?.evidence) {
        throw new DispatchConfigurationError(
          `Project '${input.project}' is not configured for pinned Git evidence.`,
        );
      }
      return pinnedGit.collect({
        project: input.project,
        projectRoot: input.projectRoot,
        revision: project.evidence.revision,
        paths: input.paths,
        ...(input.now ? { now: input.now } : {}),
      });
    },
  };
  return new AutonomousConsultationCoordinator(
    bridgeConfig,
    database,
    projects,
    executor,
    evidenceProvider,
    config.consultationWorkingDirectory,
    {
      maxRounds: pilot?.maximum_rounds ?? 4,
      maxDepth: pilot?.maximum_depth ?? 2,
      runTimeoutSeconds: pilot?.root_timeout_seconds ?? 900,
      claimLeaseSeconds: 720,
      maxOutputBytes: pilot?.maximum_output_bytes ?? config.maxOutputBytes,
    },
    () => new Date(),
  );
}
