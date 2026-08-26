# Balcony Agent Bridge Roadmap

Balcony Agent Bridge is a durable MCP communication layer for coding agents.
It began as an operational one-to-one bridge between two trusted machines. The
source now implements a bounded static multi-node network while preserving the
working delivery, recovery, and security core.

This roadmap intentionally favors a small, usable release over a broad
platform. Dates are not release promises; each phase advances only after its
exit checks pass.

## Journey And Current State

This is the public-safe record of the project discussion and implementation
journey. Raw chat transcripts are not a product source of truth; code, tests,
Git history, and the dated verification records remain authoritative.

| Stage | What changed | Verified outcome |
|---|---|---|
| Operational starting point | A fixed SYS-A/SYS-B bridge used SQLite, Azure Service Bus, local MCP, and explicit human governance. | The accepted two-machine runtime remains pinned at `9468ab9`; the open-source work did not mutate it. |
| First-principles plan | The goal became lower-friction, secret-safe one-to-many coordination without hosted discovery, a control plane, or writable remote execution. | The roadmap bounded the work to static membership, explicit targets, local setup, documentation, and security. |
| Phase 0 | Isolated the work from the operational checkout and reproduced the baseline. | Existing behavior and test tiers passed before architecture changes. |
| Phase 1 | Added Apache-2.0, package allowlists, secret/history checks, sanitized examples, and runnable CLI output. | A reviewed local tarball could be built and installed without private runtime state. |
| Phase 2 | Replaced hard-coded two-node routing with validated node IDs, explicit targets, schema migration, and generated bounded Azure topology. | Three-node, reply, duplicate, and offline-recovery paths passed locally. |
| Phase 3 | Added the Azure-free demo, create-only setup, generated MCP registration, and `doctor`. | A new operator could evaluate and configure a node locally with one setup command. |
| Phase 4 | Added Ed25519 whole-envelope authentication, explicit membership, ingress provenance, rotation/revocation guidance, and Windows ACL gates. | Production transport fails closed on spoofing, malformed authentication, and unsafe runtime inputs. |
| Phase 5 | Reworked the README and runbooks around install, connect, verify, upgrade, recover, clean-consumer packaging, and known limitations. | PR #2 passed the ordered local verification and review cycle and merged as `2ab0b512`. |
| Phase 6 | Closed the post-merge provisioning-identity gap and reconciled documentation with the repository's actual public state. | Implemented, verified, and merged; final delivery and review close-outs are recorded in Git history. |

Current truth:

- the GitHub source repository is public and Apache-2.0 licensed, so anyone can
  clone, build, modify, and use it from source;
- the npm package remains unpublished and `private: true`; there is no version
  tag or GitHub release;
- the generic multi-node design is locally verified, but it has not replaced
  the accepted two-machine live runtime or completed a live signed three-node
  acceptance test; and
- the repository became public before the planned clean-export boundary was
  reconciled. Reachable-history scanning reports no known credential patterns,
  but operational evidence remains in public history and needs an explicit
  owner decision before a supported release.

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

Status: implemented on 2026-08-25 and merged to the public repository on
2026-08-26. Apache-2.0 is selected. The planned clean-export boundary was not
completed before visibility changed, and npm installation remains unpublished.

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

Status: implemented, reviewed, and merged. No Azure resources or running
services were changed.

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

Status: implemented, reviewed, and merged. Cloud provisioning, RBAC changes,
npm publication, and live multi-machine validation remain owner-gated.

- Add a single setup command that validates prerequisites, writes only local
  configuration, initializes the database, and prints the MCP registration.
- Add a `doctor` command that checks Node.js, runtime-file availability, local
  paths, identity mode, transport reachability, and schema compatibility.
- Provide a local demo using the fake transport before asking for Azure access.
- Keep cloud provisioning and RBAC changes explicit and owner controlled.

Exit: a new operator can run the local demo, configure an authorized node, and
diagnose failures using the documented happy path.

## Phase 4: Multi-Node Security Gate

Status: implemented, reviewed, and merged. Live multi-machine cutover, Azure
RBAC changes, service installation, and npm publication remain owner-gated.

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

Status: implemented on 2026-08-25 and merged to the public repository on
2026-08-26. The clean-environment proof uses a disposable empty npm consumer
and isolated empty npm cache on the current host; it does not claim validation
on a separate operating-system image. A private security-reporting channel,
clean-history decision, npm publication, Azure/service changes, and live signed
multi-machine acceptance remain owner-gated.

- Rewrite the README around install, local demo, deploy, configure, connect,
  verify, upgrade, and recover.
- Publish architecture, configuration reference, troubleshooting, and an
  example three-node topology.
- Test from a clean machine, virtual environment, or isolated empty package
  consumer/cache using only public instructions and artifacts, and state the
  exact isolation boundary.
- Produce a release manifest with exact checks and known limitations.

Exit: the repository is available as a public source alpha. A supported release,
npm publication, Azure deployment, and live cutover remain separate owner-gated
operations.

## Phase 6: Public-State And Identity Closure

Status: implemented, verified, and merged through PR #3 as `650c1773` on
2026-08-26.

- Enforce `BALCONY_SYSTEM_ID` for `identity --node-id` and `setup --node-id`
  before either command creates directories, credentials, profiles, or
  databases.
- Add negative integration coverage proving a mismatch fails with sanitized
  output and leaves the filesystem unchanged.
- Reconcile README, security, contribution, release-boundary, and limitation
  wording with the public GitHub repository and unpublished npm package.
- Add canonical repository URLs to package metadata without enabling npm
  publication.
- Record the completed public-safe journey and distinguish source availability,
  supported release, package publication, and live deployment.

Exit: every known implementation blocker from PR #2 is closed, public users get
truthful source-build guidance, and remaining history, security-channel,
release/tag, npm, and live-deployment decisions are explicit rather than
implied. Phase 6 does not rewrite Git history, publish a package, or mutate
Azure or live services.

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
