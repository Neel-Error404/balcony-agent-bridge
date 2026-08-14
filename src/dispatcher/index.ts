import { loadReadOnlyDispatcherConfig } from "../config.js";
import { safeErrorCode } from "../security/sanitize-error.js";
import { BridgeDatabase } from "../storage/database.js";
import { LocalCodexExecutor } from "./codex-executor.js";
import { ReadOnlyDispatcher } from "./dispatcher.js";
import { ProjectRegistry } from "./project-registry.js";

async function run(
  dispatcher: ReadOnlyDispatcher,
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
  const config = loadReadOnlyDispatcherConfig();
  const database = new BridgeDatabase(config.databasePath);
  const projects = ProjectRegistry.load(config.projectsPath);
  const executor = new LocalCodexExecutor(
    config.codexExecutable,
    config.codexHome,
    config.codexExecutableSha256,
    config.trustedPath,
  );
  const dispatcher = new ReadOnlyDispatcher(
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
