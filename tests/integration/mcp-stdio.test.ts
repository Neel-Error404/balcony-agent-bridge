import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { afterEach, describe, expect, it } from "vitest";

describe("MCP stdio process", () => {
  const temporaryDirectories: string[] = [];

  afterEach(() => {
    for (const directory of temporaryDirectories) {
      fs.rmSync(directory, { recursive: true, force: true });
    }
    temporaryDirectories.length = 0;
  });

  it("starts with protocol-clean stdout and exposes bridge status", async () => {
    const temporaryDirectory = fs.mkdtempSync(
      path.join(os.tmpdir(), "balcony-agent-bridge-"),
    );
    temporaryDirectories.push(temporaryDirectory);
    const repositoryRoot = path.resolve(import.meta.dirname, "../..");
    const inheritedEnvironment = Object.fromEntries(
      Object.entries(process.env).filter(
        (entry): entry is [string, string] => entry[1] !== undefined,
      ),
    );
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [
        "--import",
        "tsx",
        path.join(repositoryRoot, "src", "mcp", "index.ts"),
      ],
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
      name: "stdio-integration-test",
      version: "0.1.0",
    });

    try {
      await client.connect(transport);
      const tools = await client.listTools();
      expect(tools.tools).toHaveLength(13);
      expect(tools.tools.map((tool) => tool.name)).toEqual(
        expect.arrayContaining([
          "agent_bridge_ask_agent",
          "agent_bridge_continue_agent",
          "agent_bridge_get_result",
          "agent_bridge_get_thread",
        ]),
      );
      const status = await client.callTool({
        name: "agent_bridge_status",
        arguments: {},
      });
      expect(status.isError).not.toBe(true);
      expect(JSON.stringify(status.content)).toContain("SYS-A");
    } finally {
      await client.close();
    }
  });
});
