# v0.1 Public Alpha Release Manifest

This manifest defines the decision gate for `balcony-agent-bridge` version
`0.1.0`. It is not a publication record. The package remains `private: true`
until the owner separately approves repository visibility and npm publication.

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

## npm Artifact Boundary

The tarball allowlist is:

- `dist/**`;
- `README.md`, `LICENSE`, `SECURITY.md`, and `package.json`;
- `config/codex-mcp.example.toml`;
- `config/dispatcher-projects.example.json`.

The artifact intentionally excludes source, tests, docs, infrastructure,
service templates, PowerShell scripts, verification records, and machine-local
state. README paths into source documentation are plain repository references,
not packaged-file links. Owner-approved public repository metadata and absolute
documentation URLs are required before npm publication.

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
- create or verify a clean public Git history/export and rerun the history
  secret scan on the exact release object;
- set a concrete private vulnerability-reporting contact/channel;
- add the approved public `repository`, `homepage`, and `bugs` package metadata
  so installed-package readers can reach the canonical documentation;
- remove `private: true`, choose npm access/tag, and publish the exact reviewed
  tarball;
- change repository visibility or push release commits/tags;
- review Azure `what-if`, identity inventory, network exposure, RBAC, budget,
  and diagnostic settings before deployment;
- install/restart services or change any live node;
- prove a signed round trip, restart recovery, duplicate handling, and
  revocation across real authorized machines.

Publication, Azure deployment, RBAC mutation, repository visibility, and live
cutover are distinct approval events. None is a side effect of the local
release checks.

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
