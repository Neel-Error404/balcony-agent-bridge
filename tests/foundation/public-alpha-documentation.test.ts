import fs from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

const repositoryRoot = path.resolve(import.meta.dirname, "../..");

function read(relativePath: string): string {
  return fs
    .readFileSync(path.join(repositoryRoot, relativePath), "utf8")
    .replace(/\r\n/g, "\n");
}

describe("public beta documentation contract", () => {
  it("publishes one ordered operator path from install through recovery", () => {
    const readme = read("README.md");
    const cliSource = read("src/cli/index.ts");
    const messageAuthentication = read("docs/message-authentication.md");
    const roadmap = read("docs/ROADMAP.md");
    const windowsRunbook = read("docs/runbooks/windows-service.md");
    const headings = [
      "## Install",
      "## npm-first two-node onboarding",
      "## Try The Local Demo",
      "## Configure A Node",
      "## Deploy The Shared Transport",
      "## Source-managed Windows service path",
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
    expect(readme).toContain("npm install --global balcony-agent-bridge@0.3.0");
    expect(readme).toContain("balcony-agent-bridge preflight --root C:\\BalconyPilot-R2");
    expect(readme).toContain("balcony-agent-bridge onboard start");
    expect(readme).toContain("docs/npm-first-onboarding.md");
    expect(readme).toContain(
      "npm view balcony-agent-bridge@0.3.0 version\nif ($LASTEXITCODE -ne 0) {\n  throw \"Unable to confirm balcony-agent-bridge@0.3.0 in the npm registry; registry installation is unavailable.\"\n}\nnpm install --global balcony-agent-bridge@0.3.0\nif ($LASTEXITCODE -ne 0) {\n  throw \"Unable to install balcony-agent-bridge@0.3.0 from the npm registry; registry installation is unavailable.\"\n}",
    );
    expect(readme).toContain("& $nodePath $bridgeCli demo");
    expect(readme).toContain("& $nodePath $bridgeCli setup `");
    expect(readme).toContain("& $nodePath $bridgeCli identity `");
    expect(readme).toContain("& $nodePath $bridgeCli doctor --config");
    expect(readme).toContain("& $nodePath $bridgeCli status --config");
    expect(readme).toMatch(
      /^balcony-agent-bridge (?:preflight|onboard|runtime)\b/m,
    );
    expect(readme).toContain("installation and Azure provisioning remain separately reviewed owner actions");
    expect(readme).toContain(
      "`& $nodePath $bridgeCli`; do not rely on a global PATH shim.",
    );
    expect(readme).not.toContain(
      "The remaining commands assume the source-checkout `$bridgeCli`",
    );
    expect(readme).toContain(
      "git clone https://github.com/Neel-Error404/balcony-agent-bridge.git",
    );
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
      "docs/release-manifest-v0.2.md": [
        "# v0.2 Phase 2 Release Manifest",
        "## Security And Migration Contract",
        "## npm Artifact Boundary",
        "## Required Local Checks",
        "## Review, Merge, And Artifact Freeze",
        "## Publication And Public Verification",
        "## Deferred Operations",
      ],
      "docs/release-manifest-v0.3.md": [
        "# v0.3 npm-first onboarding release manifest",
        "## Compatibility contract",
        "## Required verification ladder",
        "## Exact artifact and publication evidence",
        "## Deferred owner operations",
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

  it("documents explicit deny-by-default per-peer resource authorization", () => {
    const readme = read("README.md");
    const configuration = read("docs/configuration.md");
    const runbook = read("docs/runbooks/read-only-dispatcher.md");
    const limitations = read("docs/known-limitations.md");

    for (const document of [readme, configuration, runbook]) {
      expect(document).toContain("peer_readable: true");
      expect(document).toMatch(/does not authorize|never create/iu);
      expect(document).toContain("grant create");
      expect(document).toContain("grant revoke");
    }
    expect(configuration).toContain("schema v8");
    expect(configuration).toContain("empty resource and grant tables");
    expect(limitations).toContain("schema-v8 resource authorization");
    expect(limitations).toContain("do not provide file-level filtering");
  });
});
