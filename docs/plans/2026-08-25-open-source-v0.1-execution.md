# Open-Source v0.1 Execution Contract

Prepared on 2026-08-25 from `[SYS-A]` for branch
`codex/open-source-v0.1`.

## Outcome

Produce a public-alpha candidate that another operator can evaluate locally
and connect as an authorized node without weakening the existing delivery and
recovery guarantees.

## Starting Point

- Accepted base commit: `9468ab9ba82a57e67cda451c19b8c1c3e5a2a4f3`.
- The accepted base is an operational two-node implementation.
- Azure Service Bus is the only production transport adapter.
- SQLite owns durable local state.
- The MCP surface and bridge worker are separate processes.
- The optional Codex dispatcher is read-only and remains optional.

These statements describe the branch starting point. Deployment state must be
re-verified before any later operational claim.

## Authority Boundary

The implementation session may create and edit files in this isolated
worktree, install project-local dependencies, run local checks, and write
project-owned verification evidence. It may not stage, commit, push, publish,
change repository visibility, provision infrastructure, alter RBAC or network
rules, install or restart services, or mutate a live bridge without explicit
owner approval.

## Release Contract

v0.1 includes only:

1. a secret-safe source and package boundary;
2. generic validated node identifiers and explicit direct routing;
3. static multi-node Azure Service Bus topology generation;
4. a local fake-transport demo;
5. one setup command per authorized node plus a diagnostic command;
6. migration and tests preserving delivery, idempotency, claims, replies, and
   offline recovery;
7. documentation sufficient for a clean-machine evaluation.

Hosted discovery, pairing relay, UI, writable dispatch, semantic project
search, cross-company multi-tenancy, and additional production transports are
not part of v0.1.

## Implementation Sequence

### Batch 0: Baseline

- Create the isolated branch from the accepted commit.
- Record this contract and the public roadmap.
- Install dependencies and run the untouched test tiers in order.

Proof: exact branch/HEAD, clean pre-edit baseline, tier results, typecheck,
build, and MCP smoke result.

### Batch 1: Release Boundary

- Inventory public, package-only, and internal-only files.
- Add automated secret and package-content checks.
- Repair package metadata, build contents, CLI entry point, and public-safe
  examples without changing message behavior.
- Present the owner with license choices; do not invent or apply a license
  without approval.

Proof: reviewed package manifest, `npm pack --dry-run`, installed tarball smoke
test, dependency audit, and security checks.

### Batch 2: Node Contract

- Write failing foundation and component tests for arbitrary validated node
  identifiers and explicit targets.
- Generalize envelope, configuration, routing, and database constraints.
- Add an explicit migration from the two-node schema.
- Keep reply causality and authorization fail-closed.

Proof: old two-node fixtures still work; three-node direct routing and unknown
node rejection pass; migration preserves queued state.

### Batch 3: Static Transport Topology

- Represent nodes as validated deployment data.
- Generate subscriptions and sender/receiver permissions from that inventory.
- Keep topic and subscription behavior compatible with the transport adapter.
- Do not deploy; compile and lint only unless separately authorized.

Proof: deterministic three-node template output, Bicep validation, least-
privilege review, and no embedded private deployment values.

### Batch 4: Setup And Diagnostics

- Add the supported CLI surface and local demo.
- Implement idempotent local initialization and actionable diagnostics.
- Generate MCP client registration without writing credentials into it.
- Document the manual Azure authorization boundary.

Proof: clean-directory demo and setup tests, repeated setup safety, doctor
failure cases, and packaged CLI smoke tests.

### Batch 5: Security And Release Candidate

- Add authenticated node membership for multi-node messages.
- Complete threat-model and public documentation.
- Test a clean installation and a three-node scenario.
- Produce a release checklist and known-limitations record.

Proof: security suite, secret/history review, package-content review,
clean-machine workflow, and an owner-readable release diff.

## Test Order

Run one level at a time and stop on the first unexplained failure:

1. `npm run test:foundation`
2. `npm run test:component`
3. `npm run test:integration`
4. `npm run test:workflow`
5. `npm run test:recovery`
6. `npm run test:security`
7. `npm run typecheck`
8. `npm run build`
9. `npm run smoke:mcp`

Re-run the same failed level after fixing its root cause before advancing.

## Orchestration Rules

- The primary Codex task owns scope, approvals, integration, and final checks.
- Delegate only bounded, independent packages after routing each through the
  installed skill router.
- Scouts may inspect distinct surfaces in parallel.
- Writers must have non-overlapping file ownership; contract, database, and
  integration changes are serialized through the primary task.
- Every agent reports files inspected or changed, checks run, unresolved risks,
  and whether its assigned skills were applied or rejected.
- Do not create a custom orchestrator unless a repeated coordination failure is
  observed and blocks this release.

## Session Continuity

Repository files are the durable source of implementation truth. At a session
boundary, record the verified HEAD, dirty paths, checks run, failures, and one
recommended next slice in project-owned evidence. The Obsidian project note
receives only a concise source-linked event. `00-Inbox/Handoff.md` is reserved
for an actual SYS-A/SYS-B machine switch.

Resume by re-reading `AGENTS.md`, this contract, `docs/ROADMAP.md`, the newest
project verification note, and current Git status, then rerun the lowest test
tier affected by the pending work.

## Stop Conditions

Pause for the owner if a change would:

- choose a license or public repository identity;
- add a hosted service, relay, UI, new datastore, or production transport;
- weaken identity, authorization, or secret boundaries;
- require Azure, Git remote, npm registry, service, or live-runtime mutation;
- change the v0.1 release contract or its proof standard.
