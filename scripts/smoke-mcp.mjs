import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = path.resolve(scriptDirectory, "..");
const temporaryDirectory = fs.mkdtempSync(
  path.join(os.tmpdir(), "balcony-agent-bridge-smoke-"),
);
const inheritedEnvironment = Object.fromEntries(
  Object.entries(process.env).filter((entry) => entry[1] !== undefined),
);
const transport = new StdioClientTransport({
  command: process.execPath,
  args: [path.join(repositoryRoot, "dist", "mcp", "index.js")],
  cwd: repositoryRoot,
  env: {
    ...inheritedEnvironment,
    BALCONY_SYSTEM_ID: "SYS-A",
    BALCONY_BRIDGE_DB_PATH: path.join(
      temporaryDirectory,
      "bridge.sqlite3",
    ),
  },
  stderr: "pipe",
});
const client = new Client({
  name: "balcony-agent-bridge-smoke-client",
  version: "0.1.0",
});

try {
  await client.connect(transport);
  const tools = await client.listTools();
  const status = await client.callTool({
    name: "agent_bridge_status",
    arguments: {},
  });
  if (status.isError) {
    throw new Error("Compiled MCP status call returned an error");
  }
  process.stdout.write(
    `${JSON.stringify({
      connected: true,
      tool_count: tools.tools.length,
      status_success: true,
    })}\n`,
  );
} finally {
  await client.close();
  fs.rmSync(temporaryDirectory, { recursive: true, force: true });
}
