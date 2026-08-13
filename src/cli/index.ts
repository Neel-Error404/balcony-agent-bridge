import { loadConfig } from "../config.js";
import { BridgeDatabase } from "../storage/database.js";

const command = process.argv[2];
if (command !== "status") {
  console.error("Usage: node dist/cli/index.js status");
  process.exitCode = 2;
} else {
  const config = loadConfig();
  const database = new BridgeDatabase(config.databasePath);
  try {
    process.stdout.write(
      `${JSON.stringify(
        {
          system_id: config.systemId,
          peer_system_id: config.peerSystemId,
          ...database.getStatus(),
        },
        null,
        2,
      )}\n`,
    );
  } finally {
    database.close();
  }
}
