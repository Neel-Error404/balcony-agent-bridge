#!/usr/bin/env node

import {
  loadConfig,
  loadMessageAuthenticationRuntimeConfig,
} from "../config.js";
import { loadMessageAuthenticator } from "../security/message-authentication.js";
import { safeErrorCode } from "../security/sanitize-error.js";
import { BridgeDatabase } from "../storage/database.js";
import { ServiceBusBridgeTransport } from "../transport/service-bus-transport.js";
import { acquireBridgeProcessLock } from "./process-lock.js";
import { closeTransportWithin, runBridgeLoops } from "./runtime.js";
import { BridgeWorker } from "./worker.js";

try {
  const config = loadConfig();
  const messageAuthentication = loadMessageAuthenticationRuntimeConfig(
    process.env,
    config,
  );
  const authenticator = loadMessageAuthenticator({
    localNodeId: config.systemId,
    authorizedNodeIds: config.authorizedNodeIds,
    membershipPath: messageAuthentication.membershipPath,
    signingKeyPath: messageAuthentication.signingKeyPath,
  });
  const processLock = acquireBridgeProcessLock(config.systemId);
  try {
    const database = new BridgeDatabase(config.databasePath);
    const transport = new ServiceBusBridgeTransport(config, authenticator);
    const worker = new BridgeWorker(config, database, transport);
    const controller = new AbortController();
    process.once("SIGINT", () => controller.abort());
    process.once("SIGTERM", () => controller.abort());
    try {
      await runBridgeLoops(worker, controller);
    } finally {
      const transportClosed = await closeTransportWithin(transport, 5000);
      if (transportClosed) {
        database.close();
      } else {
        console.error(
          "Bridge transport did not close within the shutdown deadline",
        );
        process.exitCode = 1;
        setImmediate(() => process.exit(1));
      }
    }
  } finally {
    processLock.release();
  }
} catch (error) {
  console.error(`Bridge process failed (${safeErrorCode(error)})`);
  process.exitCode = 1;
}
