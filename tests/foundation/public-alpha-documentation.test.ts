import fs from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

const repositoryRoot = path.resolve(import.meta.dirname, "../..");

function read(relativePath: string): string {
  return fs.readFileSync(path.join(repositoryRoot, relativePath), "utf8");
}

describe("public alpha documentation contract", () => {
  it("publishes one ordered operator path from install through recovery", () => {
    const readme = read("README.md");
    const cliSource = read("src/cli/index.ts");
    const messageAuthentication = read("docs/message-authentication.md");
    const roadmap = read("docs/ROADMAP.md");
    const windowsRunbook = read("docs/runbooks/windows-service.md");
    const headings = [
      "## Install",
      "## Try The Local Demo",
      "## Configure A Node",
      "## Deploy The Shared Transport",
      "## Connect The Node",
      "## Verify The Node",
      "## Upgrade",
      "## Recover",
    ];

    let previousIndex = -1;
    for (const heading of headings) {
      const index = readme.indexOf(heading);
      expect(index, `${heading} is missing`).toBeGreaterThan(previousIndex);
      previousIndex = index;
    }

    expect(readme).toContain("npm run verify:public-alpha");
    expect(readme).toContain("npm install --global balcony-agent-bridge@0.1.0");
    expect(readme).toContain("production service installation remains a reviewed source");
    expect(readme).toContain(
      "git clone https://github.com/Neel-Error404/balcony-agent-bridge.git",
    );
    expect(readme).toContain("--subscription build-node");
    expect(windowsRunbook).toContain('SubscriptionName = "build-node"');
    expect(roadmap).not.toContain("Git delivery is pending");
    expect(readme).toContain('$env:BALCONY_SYSTEM_ID = "laptop-a"');
    expect(readme).toContain('$env:BALCONY_SYSTEM_ID = "build-node"');
    expect(cliSource).toContain('$env:BALCONY_SYSTEM_ID="laptop-a";');
    expect(messageAuthentication).toContain(
      '$env:BALCONY_SYSTEM_ID = "laptop-a"',
    );
  });

  it("ships the minimum source documentation for an operator decision", () => {
    const requirements: Record<string, readonly string[]> = {
      "docs/configuration.md": [
        "# Configuration Reference",
        "## Local MCP Profile",
        "## Bridge Service Environment",
        "## Dispatcher Environment",
        "## Configuration That Must Stay Local",
      ],
      "docs/troubleshooting.md": [
        "# Troubleshooting",
        "## Setup",
        "## Doctor",
        "## Bridge Transport",
        "## Message Authentication",
        "## Recovery",
      ],
      "docs/examples/three-node-topology.md": [
        "# Three-Node Topology",
        "## Static Inventory",
        "## Per-Node Configuration",
        "## Routing Example",
        "## What This Example Does Not Do",
      ],
      "docs/known-limitations.md": [
        "# Known Limitations",
        "## Public Alpha Limits",
        "## Security Residuals",
        "## Deferred By Design",
      ],
      "docs/release-manifest-v0.1.md": [
        "# v0.1 Public Alpha Release Manifest",
        "## Included Source Surfaces",
        "### v0.1 GitHub Source-Archive Exception",
        "## npm Artifact Boundary",
        "## Required Local Checks",
        "## Owner-Gated Checks",
        "## Release Decision Record",
      ],
      "docs/verification/SYS-A-V0.1.0-HISTORY-PRIVACY-REVIEW-2026-08-26.md": [
        "# SYS-A v0.1.0 History And Privacy Review",
        "Decision: retain the existing public Git history for `v0.1.0`",
        "## Evidence",
        "## Decision And Residual Risk",
      ],
    };

    for (const [relativePath, fragments] of Object.entries(requirements)) {
      const content = read(relativePath);
      for (const fragment of fragments) {
        expect(content, `${relativePath} is missing ${fragment}`).toContain(fragment);
      }
    }
  });

  it("does not contradict the selected Apache-2.0 license", () => {
    const contributing = read("CONTRIBUTING.md");
    expect(contributing).toContain("Apache-2.0");
    expect(contributing).not.toContain("Until a license is selected");
  });

  it("allows only an explicitly public npm publication", () => {
    const packageJson = JSON.parse(read("package.json")) as {
      private?: boolean;
      publishConfig?: { access?: string };
    };

    expect(packageJson.private).not.toBe(true);
    expect(packageJson.publishConfig?.access).toBe("public");
  });

  it("keeps bridge credentials out of the dispatcher environment example", () => {
    const bridgeEnvironment = read(".env.example");
    const dispatcherEnvironment = read("config/dispatcher.env.example");

    expect(bridgeEnvironment).toContain("BALCONY_AZURE_AUTH_MODE");
    expect(bridgeEnvironment).toContain("BALCONY_MESSAGE_AUTH_SIGNING_KEY_PATH");
    expect(bridgeEnvironment).not.toContain("BALCONY_DISPATCHER_PROJECTS_PATH");
    expect(dispatcherEnvironment).toContain("BALCONY_AUTHORIZED_NODE_IDS");
    expect(dispatcherEnvironment).toContain("BALCONY_DISPATCHER_PROJECTS_PATH");
    expect(dispatcherEnvironment).not.toContain("BALCONY_SERVICEBUS_NAMESPACE");
    expect(dispatcherEnvironment).not.toContain("BALCONY_MESSAGE_AUTH_SIGNING_KEY_PATH");
  });
});
