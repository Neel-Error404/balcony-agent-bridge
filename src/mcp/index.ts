#!/usr/bin/env node

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import path from "node:path";
import { parseArgs } from "node:util";

import { AgentBridgeService } from "../application/agent-bridge-service.js";
import {
  assertConfigMatchesProcessIdentity,
  loadConfig,
  loadConfigFile,
} from "../config.js";
import { safeErrorCode } from "../security/sanitize-error.js";
import { BridgeDatabase } from "../storage/database.js";
import { createMcpServer } from "./server.js";

try {
  const { values, positionals } = parseArgs({
    args: process.argv.slice(2),
    allowPositionals: true,
    strict: true,
    options: { config: { type: "string" } },
  });
  if (positionals.length > 0) {
    throw new Error("Unexpected MCP positional argument");
  }
  if (values.config && !path.isAbsolute(values.config)) {
    throw new Error("MCP --config path must be absolute");
  }
  const config = values.config
    ? assertConfigMatchesProcessIdentity(
        loadConfigFile(path.resolve(values.config)),
      )
    : loadConfig();
  const database = new BridgeDatabase(config.databasePath);
  const service = new AgentBridgeService(config, database);
  const server = createMcpServer(service);
  const transport = new StdioServerTransport();
  const shutdown = async (): Promise<void> => {
    await server.close();
    database.close();
  };
  process.once("SIGINT", () => {
    void shutdown().finally(() => process.exit(0));
  });
  process.once("SIGTERM", () => {
    void shutdown().finally(() => process.exit(0));
  });
  await server.connect(transport);
} catch (error) {
  console.error(
    `Balcony Agent Bridge MCP startup failed (${safeErrorCode(error)})`,
  );
  process.exitCode = 1;
}
