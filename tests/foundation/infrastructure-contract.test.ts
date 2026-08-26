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
const topologyValidator = fs.readFileSync(
  path.join(repositoryRoot, "scripts", "Test-BridgeTopologyParameters.ps1"),
  "utf8",
);
const resourceGroupWhatIf = fs.readFileSync(
  path.join(repositoryRoot, "scripts", "Invoke-BridgeWhatIf.ps1"),
  "utf8",
);
const subscriptionWhatIf = fs.readFileSync(
  path.join(repositoryRoot, "scripts", "Invoke-BridgeSubscriptionWhatIf.ps1"),
  "utf8",
);
const exampleParameters = JSON.parse(
  fs.readFileSync(
    path.join(repositoryRoot, "infra", "example.parameters.json"),
    "utf8",
  ),
) as {
  parameters: {
    nodes: {
      value: Array<{
        nodeId: string;
        subscriptionName: string;
        principalId: string;
      }>;
    };
  };
};

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

  it("generates one isolated filtered subscription for every bounded node", () => {
    for (const template of [infrastructure, deployment, routingRules]) {
      expect(template).toContain("param nodes nodeDefinition[]");
    }
    expect(infrastructure).toContain("@minLength(1)");
    expect(infrastructure).toContain("@maxLength(32)");
    expect(infrastructure).toContain("[for (node, index) in nodes:");
    expect(infrastructure).toContain("requiresSession: true");
    expect(infrastructure).toContain("name: '$Default'");
    expect(infrastructure).toContain("bridgeTarget: node.nodeId");
    expect(routingRules).toContain("name: '$Default'");
    expect(routingRules).toContain("bridgeTarget: node.nodeId");
    expect(routingRules).toContain("name: 'bridge-target'");
    expect(routingRules).toContain("sqlExpression: '1 = 0'");
  });

  it("preflights topology identity and uniqueness before Azure what-if", () => {
    expect(topologyValidator).toContain("between 1 and 32 nodes");
    expect(topologyValidator).toContain("Duplicate nodeId");
    expect(topologyValidator).toContain("Duplicate subscriptionName");
    expect(topologyValidator).toContain("Duplicate principalId");
    expect(resourceGroupWhatIf).toContain("Test-BridgeTopologyParameters.ps1");
    expect(subscriptionWhatIf).toContain("Test-BridgeTopologyParameters.ps1");
  });

  it("assigns existing node principals only the required data-plane roles", () => {
    expect(infrastructure).not.toContain("userAssignedIdentities@");
    expect(infrastructure).toContain("principalId: node.principalId");
    expect(infrastructure).toContain("scope: topic");
    expect(infrastructure).toContain("scope: subscriptions[index]");
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

  it("ships a deterministic public-safe three-node inventory example", () => {
    const nodes = exampleParameters.parameters.nodes.value;
    expect(nodes).toHaveLength(3);
    expect(new Set(nodes.map((node) => node.nodeId)).size).toBe(3);
    expect(new Set(nodes.map((node) => node.subscriptionName)).size).toBe(3);
    expect(new Set(nodes.map((node) => node.principalId)).size).toBe(3);
    for (const node of nodes) {
      expect(node.nodeId).toMatch(/^[a-z][a-z0-9-]{0,49}$/);
      expect(node.subscriptionName).toMatch(/^[a-z][a-z0-9-]{0,49}$/);
      expect(node.principalId).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
      );
    }
  });
});
