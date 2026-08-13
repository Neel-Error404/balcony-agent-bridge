import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

import { AgentBridgeService } from "../application/agent-bridge-service.js";
import { loadConfig } from "../config.js";
import { safeErrorCode } from "../security/sanitize-error.js";
import { BridgeDatabase } from "../storage/database.js";
import { createMcpServer } from "./server.js";

try {
  const config = loadConfig();
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
