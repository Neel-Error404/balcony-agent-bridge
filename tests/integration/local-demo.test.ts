import { describe, expect, it } from "vitest";

import { runLocalDemo } from "../../src/cli/local-demo.js";

describe("local fake-transport demo", () => {
  it("proves isolated direct delivery, duplicate suppression, and a causal reply without Azure", async () => {
    await expect(runLocalDemo()).resolves.toEqual({
      demo: "local-fake-transport",
      azure_used: false,
      nodes: ["demo-a", "demo-b", "demo-c"],
      direct_route: {
        from: "demo-a",
        to: "demo-c",
      },
      wrong_target: {
        node: "demo-b",
        reason: "WrongTargetSystem",
      },
      duplicate_delivery: {
        node: "demo-c",
        inbox_available: 1,
      },
      reply_route: {
        from: "demo-c",
        to: "demo-a",
      },
      result: "passed",
    });
  });
});
