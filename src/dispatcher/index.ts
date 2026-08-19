import {
  loadConfig,
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

async function run(
  dispatcher: ForegroundDispatcher,
  controller: AbortController,
  pollIntervalMs: number,
): Promise<void> {
  dispatcher.recordHeartbeat("healthy");
  let lastHeartbeat = Date.now();

  while (!controller.signal.aborted) {
    try {
      const processed = await dispatcher.runOnce(
        new Date(),
        controller.signal,
      );
      if (
        processed > 0 ||
        Date.now() - lastHeartbeat >= 5 * 60 * 1000
      ) {
        dispatcher.recordHeartbeat("healthy");
        lastHeartbeat = Date.now();
      }
      if (processed === 0) {
        await sleep(pollIntervalMs, controller.signal);
      }
    } catch (error) {
      if (controller.signal.aborted) {
        break;
      }
      const code = safeErrorCode(error);
      dispatcher.recordHeartbeat("degraded", code);
      console.error(`Read-only dispatcher cycle failed (${code})`);
      await sleep(Math.max(2000, pollIntervalMs), controller.signal);
    }
  }
}

try {
  const bridgeConfig = loadConfig();
  const config = loadReadOnlyDispatcherConfig();
  const database = new BridgeDatabase(config.databasePath);
  const projects = ProjectRegistry.load(config.projectsPath);
  const executor = new LocalCodexExecutor(
    config.codexExecutable,
    config.codexHome,
    config.codexExecutableSha256,
    config.codexCodeModeHostExecutable,
    config.codexCodeModeHostSha256,
    config.trustedPath,
  );
  const dispatcher: ForegroundDispatcher =
    config.mode === "consultation"
      ? createConsultationDispatcher(
          config,
          bridgeConfig,
          database,
          projects,
          executor,
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
  try {
    await run(dispatcher, controller, config.pollIntervalMs);
  } finally {
    database.close();
  }
} catch (error) {
  console.error(
    `Read-only dispatcher process failed (${safeErrorCode(error)})`,
  );
  process.exitCode = 1;
}

async function sleep(
  milliseconds: number,
  signal: AbortSignal,
): Promise<void> {
  await new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, milliseconds);
    signal.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        resolve();
      },
      { once: true },
    );
  });
}

interface ForegroundDispatcher {
  runOnce(now?: Date, abortSignal?: AbortSignal): Promise<number>;
  recordHeartbeat(
    status: "healthy" | "degraded",
    lastErrorCode?: string,
  ): void;
}

function createConsultationDispatcher(
  config: ReadOnlyDispatcherConfig,
  bridgeConfig: ReturnType<typeof loadConfig>,
  database: BridgeDatabase,
  projects: ProjectRegistry,
  executor: LocalCodexExecutor,
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
      maxRounds: 4,
      maxDepth: 2,
      runTimeoutSeconds: 900,
      claimLeaseSeconds: 720,
      maxOutputBytes: config.maxOutputBytes,
    },
    () => new Date(),
  );
}
