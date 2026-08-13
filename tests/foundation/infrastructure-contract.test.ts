import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const repositoryRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);
const infrastructure = fs.readFileSync(
  path.join(repositoryRoot, "infra", "main.bicep"),
  "utf8",
);
const deployment = fs.readFileSync(
  path.join(repositoryRoot, "infra", "deploy.bicep"),
  "utf8",
);
const routingRules = fs.readFileSync(
  path.join(repositoryRoot, "infra", "routing-rules.bicep"),
  "utf8",
);

describe("Azure infrastructure contract", () => {
  it("uses the approved low-cost Service Bus topology", () => {
    expect(infrastructure).toContain("name: 'Standard'");
    expect(infrastructure).toContain("param location string = 'centralindia'");
    expect(infrastructure).toContain("disableLocalAuth: true");
    expect(infrastructure).toContain("publicNetworkAccess: 'Enabled'");
    expect(infrastructure).toContain(
      "requiresDuplicateDetection: true",
    );
  });

  it("creates two session-enabled filtered subscriptions", () => {
    expect(infrastructure.match(/requiresSession: true/g)).toHaveLength(2);
    expect(infrastructure).toContain("bridgeTarget: 'SYS-A'");
    expect(infrastructure).toContain("bridgeTarget: 'SYS-B'");
    expect(infrastructure.match(/name: 'bridge-target'/g)).toHaveLength(2);
    expect(infrastructure.match(/requiresPreprocessing: false/g)).toHaveLength(
      2,
    );
    expect(infrastructure).not.toContain("name: '$Default'");
    expect(routingRules.match(/existing =/g)).toHaveLength(4);
    expect(routingRules.match(/name: 'bridge-target'/g)).toHaveLength(2);
  });

  it("creates dedicated identities and assigns only data-plane roles", () => {
    expect(infrastructure.match(/userAssignedIdentities@2024-11-30/g)).toHaveLength(
      2,
    );
    expect(infrastructure).toContain("principalType: 'ServicePrincipal'");
    expect(infrastructure).not.toContain("Data Owner");
    expect(infrastructure).not.toMatch(/SharedAccessKey|connectionString/i);
  });

  it("creates an isolated resource group through a subscription deployment", () => {
    expect(deployment).toContain("targetScope = 'subscription'");
    expect(deployment).toContain(
      "Microsoft.Resources/resourceGroups@2023-07-01",
    );
    expect(deployment).toContain("module bridge './main.bicep'");
  });
});
