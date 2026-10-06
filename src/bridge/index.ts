#!/usr/bin/env node

import path from "node:path";
import { parseArgs } from "node:util";

import {
  assertConfigMatchesProcessIdentity,
  loadConfig,
  loadConfigFile,
  loadMessageAuthenticationRuntimeConfig,
} from "../config.js";
import { loadMessageAuthenticator } from "../security/message-authentication.js";
import { safeErrorCode } from "../security/sanitize-error.js";
import { BridgeDatabase } from "../storage/database.js";
import { ServiceBusBridgeTransport } from "../transport/service-bus-transport.js";
import { acquireBridgeProcessLock } from "./process-lock.js";
import { closeTransportWithin, runBridgeLoops } from "./runtime.js";
import { BridgeWorker } from "./worker.js";
import { PeerCheckService } from "./peer-check.js";
import { serviceParentSupervisionEnabled, superviseParent } from "../runtime/parent-supervision.js";

try {
  const invocation = parseBridgeInvocation(process.argv.slice(2));
  if (invocation.help) {
    process.stdout.write(
      "Usage: balcony-agent-bridge runtime bridge --root <absolute-path> [--validate]\n" +
      "Internal: node dist/bridge/index.js [--config <absolute-path>] [--validate-message-authentication]\n",
    );
  } else {
    const parentSupervised = serviceParentSupervisionEnabled(
      process.env["BALCONY_RUNTIME_SUPERVISION"],
    );
    const config = invocation.configPath
      ? assertConfigMatchesProcessIdentity(loadConfigFile(invocation.configPath))
      : loadConfig();
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
    if (!invocation.validateMessageAuthentication) {
      const processLock = acquireBridgeProcessLock(config.systemId);
      let ownershipReleaseSafe = true;
      try {
        const database = new BridgeDatabase(config.databasePath);
        const transport = new ServiceBusBridgeTransport(config, authenticator);
        const peerChecks = new PeerCheckService(config, database, authenticator.networkId);
        const worker = new BridgeWorker(config, database, transport, peerChecks);
        const controller = new AbortController();
        process.once("SIGINT", () => controller.abort());
        process.once("SIGTERM", () => controller.abort());
        const stopSupervision = superviseParent(controller, {
          enabled: parentSupervised,
          onFailure: (code) => {
            worker.recordHeartbeat("degraded", code);
            console.error(`Bridge supervision failed (${code})`);
            process.exitCode = 1;
          },
        });
        try {
          ownershipReleaseSafe = false;
          ownershipReleaseSafe = await runBridgeLoops(worker, controller);
        } finally {
          stopSupervision();
          controller.abort();
          if (!ownershipReleaseSafe) {
            // Live SDK work may still own SQLite/transport state. Exit before
            // releasing the lock; the next process reclaims it only after death.
            console.error("Bridge shutdown could not prove lane quiescence");
            process.exit(1);
          }
          const transportClosed = await closeTransportWithin(transport, 5000);
          if (transportClosed) {
            database.close();
          } else {
            console.error(
              "Bridge transport did not close within the shutdown deadline",
            );
            process.exitCode = 1;
            ownershipReleaseSafe = false;
            process.exit(1);
          }
        }
      } finally {
        if (ownershipReleaseSafe) processLock.release();
      }
    }
  }
} catch (error) {
  console.error(`Bridge process failed (${safeErrorCode(error)})`);
  process.exitCode = 1;
}

function parseBridgeInvocation(args: readonly string[]): {
  configPath?: string;
  validateMessageAuthentication: boolean;
  help: boolean;
} {
  if (args.length === 0) {
    return { validateMessageAuthentication: false, help: false };
  }
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    strict: true,
    options: {
      "validate-message-authentication": { type: "boolean" },
      config: { type: "string" },
      help: { type: "boolean", short: "h" },
    },
  });
  if (
    positionals.length > 0 ||
    (values.config !== undefined && !path.isAbsolute(values.config))
  ) {
    throw new Error("Invalid bridge process arguments");
  }
  return {
    help: values.help ?? false,
    validateMessageAuthentication:
      values["validate-message-authentication"] ?? false,
    ...(values.config === undefined ? {} : { configPath: values.config }),
  };
}
