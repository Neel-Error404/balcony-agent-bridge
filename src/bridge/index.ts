import { loadConfig } from "../config.js";
import { safeErrorCode } from "../security/sanitize-error.js";
import { BridgeDatabase } from "../storage/database.js";
import { ServiceBusBridgeTransport } from "../transport/service-bus-transport.js";
import { BridgeWorker } from "./worker.js";

async function run(
  worker: BridgeWorker,
  controller: AbortController,
): Promise<void> {
  worker.recordHeartbeat("healthy");
  let lastHeartbeat = Date.now();

  while (!controller.signal.aborted) {
    try {
      await worker.runOutboundOnce();
      await worker.runInboundOnce(controller.signal);
      if (Date.now() - lastHeartbeat >= 15 * 60 * 1000) {
        worker.recordHeartbeat("healthy");
        lastHeartbeat = Date.now();
      }
    } catch (error) {
      const code = safeErrorCode(error);
      worker.recordHeartbeat("degraded", code);
      console.error(`Bridge worker cycle failed (${code})`);
      await sleep(2000, controller.signal);
    }
  }
}

try {
  const config = loadConfig();
  const database = new BridgeDatabase(config.databasePath);
  const transport = new ServiceBusBridgeTransport(config);
  const worker = new BridgeWorker(config, database, transport);
  const controller = new AbortController();
  process.once("SIGINT", () => controller.abort());
  process.once("SIGTERM", () => controller.abort());
  try {
    await run(worker, controller);
  } finally {
    await transport.close();
    database.close();
  }
} catch (error) {
  console.error(`Bridge process failed (${safeErrorCode(error)})`);
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
