# v0.1 Public Alpha Release Manifest

This manifest defines the release gate for `balcony-agent-bridge` version
`0.1.0`. The owner approved public npm publication, a `v0.1.0` Git tag and
GitHub Release, retained public history, private vulnerability reporting, and a
separately verified live multi-node rollout on 2026-08-26.

## Included Source Surfaces

The clean public export may include only reviewed reusable surfaces:

- root release files: `.gitignore`, `.env.example`, `README.md`,
  `CONTRIBUTING.md`, `LICENSE`, `SECURITY.md`, `package.json`,
  `package-lock.json`, and TypeScript configs;
- `src/**`, `tests/**`, generic reviewed `scripts/**`, and `service/*.template`;
- sanitized examples under `config/`;
- `infra/*.bicep`, `infra/example.parameters.json`, and `infra/README.md`;
- public architecture, ADRs, roadmap, release boundary, configuration,
  troubleshooting, message-authentication, routing, limitation, and generic
  runbook documents.

The export must explicitly exclude `AGENTS.md`, `docs/handoff/**`,
`docs/verification/**`, `docs/plans/**`, `docs/costs.md`, and
`docs/runbooks/sys-a-physical-host.md`, plus any machine profile, deployment
parameters, rendered service XML, database, logs, private identity material,
membership file, or generated evidence.

Private profiles, deployment parameters, rendered service XML, databases,
logs, credentials, founder handoffs, machine inventories, and local evidence
remain outside the public release.

Observed state differs from the original clean-export boundary: public Git
history includes operational evidence paths listed above. The owner accepted
that existing history for `v0.1.0` after a dedicated review found no live cloud
tenant identifier, credential, private key, connection string, access token,
non-example Service Bus hostname, or user-profile credential path. Rewriting
already-public history was rejected because it would break clones without
retracting existing copies.

## npm Artifact Boundary

The tarball allowlist is:

- `dist/**`;
- `README.md`, `LICENSE`, `SECURITY.md`, and `package.json`;
- `config/codex-mcp.example.toml`;
- `config/dispatcher-projects.example.json`.

The artifact intentionally excludes source, tests, docs, infrastructure,
service templates, PowerShell scripts, verification records, and machine-local
state. README paths into source documentation are plain repository references,
not packaged-file links. Package metadata points installed-package readers to
the public repository, README, and issue tracker; `publishConfig.access` is
fixed to `public`.

## Required Local Checks

Run in order and stop on the first unexplained failure:

```powershell
npm ci
npm run test:foundation
npm run test:component
npm run test:integration
npm run test:workflow
npm run test:recovery
npm run test:security
npm run typecheck
npm run build
npm run smoke:mcp
npm run check:secrets
npm audit --omit=dev
npm run verify:package
npm run verify:public-alpha
git diff --check
```

Also parse the PowerShell release/service scripts and locally lint/build every
Bicep entry point when the required tools are available. Record unavailable
tools as unverified; do not silently skip them.

`verify:public-alpha` builds the current source, creates a tarball, resolves its
pinned dependencies through the configured registry into an isolated empty npm
cache, installs it into a disposable empty npm consumer, checks both bin links,
executes the CLI bin, executes the setup-generated
absolute MCP registration from a neutral directory, and exercises help,
identity, setup, idempotent setup, doctor, local
three-node demo, status, and invalid-command behavior. This proves package
consumption on the current host only.

## Owner-Gated Checks

These checks require explicit authority and are not implied by local success:

- review the exact release diff and confirm every included path is public;
- rerun the current-tree and reachable-history scan on the exact release
  candidate;
- verify GitHub private vulnerability reporting;
- publish the exact reviewed tarball with public npm access;
- create the approved `v0.1.0` tag and GitHub release;
- review Azure `what-if`, identity inventory, network exposure, RBAC, budget,
  and diagnostic settings before deployment;
- install/restart services or change any live node;
- prove a signed round trip, restart recovery, duplicate handling, and
  revocation across real authorized machines.

Package and release publication, Azure deployment, RBAC mutation, and live
cutover remain distinct operations even though the owner approved them in the
same release instruction. Each still requires its own verification evidence.

## Release Decision Record

Before approval, record:

- reviewed commit or exported source digest;
- package filename, integrity/digest, file count, packed and unpacked size;
- Node.js/npm versions and test counts for every tier;
- secret/history, dependency, package-content, clean-consumer, PowerShell, and
  Bicep results;
- independent documentation/security review findings and their disposition;
- all known limitations and every check that remains unverified;
- owner decision, date, registry/repository target, and rollback point.

An empty checkbox is not evidence. Link each claim to captured command output
or a verification record, and describe local-only results as local-only.
