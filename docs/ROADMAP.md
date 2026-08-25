# Balcony Agent Bridge Roadmap

Balcony Agent Bridge is a durable MCP communication layer for coding agents.
The current system is operational between two trusted machines. The first
open-source release will preserve that working core while making node setup,
configuration, packaging, and security boundaries understandable to another
operator.

This roadmap intentionally favors a small, usable release over a broad
platform. Dates are not release promises; each phase advances only after its
exit checks pass.

## Product Direction

The target is a static one-to-many network of trusted agent nodes:

- every node has a stable identifier;
- a node can address another authorized node explicitly;
- Azure Service Bus remains the first production transport;
- SQLite remains the local durable inbox, outbox, and claim store;
- MCP remains local to the agent host;
- Git remains the transfer path for code and large artifacts;
- messages carry coordination and evidence references, not credentials or
  project memory databases.

The v0.1 setup goal is one command per node after the operator supplies a valid
deployment profile and identity authorization. Fully hosted discovery and
one-time pairing are separate product choices, not hidden prerequisites for
the first release.

## Phase 0: Reproducible Baseline

- Isolate open-source work from the operational checkout.
- Record the accepted source commit and release boundary.
- Re-run the existing test tiers without changing behavior.
- Keep the operational two-node deployment untouched.

Exit: the branch starts from the accepted commit and the current suite passes
in the isolated worktree.

## Phase 1: Public Safety And Packaging

Status: locally implemented on 2026-08-25. Apache-2.0 was selected on
2026-08-25. Clean-history export and public-registry installation remain
owner-gated release checks.

- Audit the repository and Git history for credentials, private endpoints,
  machine-local configuration, private identities, and internal-only evidence.
- Define what is included in the public package and source release.
- Document the license decision, add contribution and security-reporting
  guidance, and provide public-safe examples. Add the selected license only
  after owner approval.
- Produce runnable build output and a supported CLI entry point.
- Make `npm pack --dry-run` an explicit release check.

Exit: a local package can be built and inspected without including tests,
private handoffs, local databases, logs, or internal evidence.

## Phase 2: Generic Node Addressing

Status: locally implemented on 2026-08-25. Final verification and owner review
remain release gates; no Azure resources or running services were changed.

- Replace the closed `SYS-A`/`SYS-B` type with validated node identifiers.
- Replace implicit peer selection with explicit source and target routing.
- Migrate local durable state without losing pending work.
- Generate Service Bus subscriptions and filters from a bounded static node
  inventory rather than two hard-coded resources.
- Preserve idempotency, at-least-once delivery, claim, replay, and reply
  behavior.

Exit: tests demonstrate at least three isolated nodes, direct routing, replies,
duplicates, offline recovery, and rejection of unknown nodes.

## Phase 3: One-Command Node Setup

Status: locally implemented on 2026-08-25. Cloud provisioning, RBAC changes,
registry publication, and live multi-machine validation remain owner-gated.

- Add a single setup command that validates prerequisites, writes only local
  configuration, initializes the database, and prints the MCP registration.
- Add a `doctor` command that checks Node.js, runtime-file availability, local
  paths, identity mode, transport reachability, and schema compatibility.
- Provide a local demo using the fake transport before asking for Azure access.
- Keep cloud provisioning and RBAC changes explicit and owner controlled.

Exit: a new operator can run the local demo, configure an authorized node, and
diagnose failures using the documented happy path.

## Phase 4: Multi-Node Security Gate

Status: locally implemented on 2026-08-25. Live multi-machine cutover, Azure
RBAC changes, service installation, publication, and Git delivery remain
owner-gated.

- Add an explicit network membership policy and least-privilege routing model.
- Authenticate node messages so integrity is not based only on an unkeyed
  payload hash.
- Document threat boundaries, rotation, revocation, and incident response.
- Verify that MCP output and logs do not disclose message bodies by default.
- Run dependency, secret, package-content, and adversarial routing checks.

Exit: the public threat model matches implemented controls, and security tests
cover spoofed sender, unauthorized target, replay, malformed input, and secret
leakage cases.

## Phase 5: Public Alpha Candidate

Status: locally implemented on 2026-08-25. The clean-environment proof uses a
disposable empty npm consumer and isolated empty npm cache on the current host;
it does not claim validation on a separate operating-system image. Public Git
export, security contact, package/repository URLs, publication, Azure/service
changes, and live signed multi-machine acceptance remain owner-gated.

- Rewrite the README around install, local demo, deploy, configure, connect,
  verify, upgrade, and recover.
- Publish architecture, configuration reference, troubleshooting, and an
  example three-node topology.
- Test from a clean machine, virtual environment, or isolated empty package
  consumer/cache using only public instructions and artifacts, and state the
  exact isolation boundary.
- Produce a release manifest with exact checks and known limitations.

Exit: the repository is decision-ready for an owner-approved public release.
Publication, npm release, Azure deployment, and repository visibility changes
remain separate owner-gated operations.

## Deferred Until Demand Is Proven

- hosted discovery or relay services;
- one-time host/join pairing codes;
- a web UI or control plane;
- semantic or vector search across projects;
- cross-company multi-tenancy and enterprise SSO;
- writable autonomous dispatch;
- broadcast messaging by default;
- transport or agent-runtime marketplaces.

These can be reconsidered only when a concrete v0.1 limitation is reproduced
and the smaller static-network design cannot satisfy it.
