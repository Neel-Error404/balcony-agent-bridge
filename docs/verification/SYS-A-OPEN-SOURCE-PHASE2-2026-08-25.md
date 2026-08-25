# [SYS-A] Open-Source Phase 2 Verification - 2026-08-25

## Claim Boundary

This record verifies the local generic-node implementation on branch
`codex/open-source-v0.1`, based on accepted commit
`9468ab9ba82a57e67cda451c19b8c1c3e5a2a4f3` plus the uncommitted Phase 1 and
Phase 2 worktree changes.

It does not claim an Azure deployment, a running-service upgrade, public
repository publication, npm publication, or clean-public-history approval.
No Azure resources, installed services, Git index, commit, remote branch, or
repository visibility were changed.

## Implemented

- Added the approved Apache License 2.0 while retaining `private: true` as the
  separate publication safety gate.
- Replaced the closed runtime node enum with validated generic node IDs while
  retaining `SYS-A` and `SYS-B` compatibility.
- Added the required bounded `BALCONY_AUTHORIZED_NODE_IDS` configuration to
  source entry points, service templates, installers, updater, and prerequisite
  checks.
- Added explicit `target_node_id` to direct send and initial coordination MCP
  tools. Replies and continuations derive their routes from validated causal
  messages rather than a global peer.
- Reject unknown targets before enqueue, quarantine newly unauthorized queued
  targets before transport, and dead-letter unknown origins before inbox
  persistence.
- Made result lookup route-aware so a result from a different authorized node
  cannot hide the later legitimate response.
- Added transactional SQLite schema version 5. It preserves existing rows and
  indexes while removing only the legacy two-node column constraints. The
  version check occurs inside the immediate write transaction to close the
  concurrent-first-open race.
- Replaced duplicated two-node Bicep declarations with a bounded typed static
  inventory. Existing principals receive topic-level send and only their own
  subscription-level receive role.
- Configured each effective `$Default` rule as an exact `bridgeTarget`
  correlation filter. The explicit migration template disables the legacy
  named `bridge-target` rule.
- Added a local topology preflight that validates cardinality, node and
  subscription syntax, principal GUIDs, uniqueness, and initiating-node
  membership before either what-if wrapper calls Azure CLI.

## Final Verification

| Level | Result |
| --- | --- |
| Foundation | 63 passed |
| Component | 73 passed |
| Integration | 24 passed |
| Workflow | 4 passed |
| Recovery | 22 passed |
| Security | 39 passed |
| Type checking | passed |
| Build | passed |
| MCP smoke | connected; 13 tools; status succeeded |
| PowerShell parsing | bridge/dispatcher install and update, prerequisite, runtime safety, and topology preflight scripts passed |
| Topology preflight | public three-node parameter file passed |
| Bicep lint/build | `main`, `deploy`, `routing-rules`, and `subscription-budget` passed without deployment |
| TOML parsing | public Codex MCP example passed Python `tomllib` parsing |
| Current/history safety check | 150 files scanned; 0 findings |
| npm package manifest | 87 files; allowlist passed |
| Tarball install smoke | passed using the existing offline npm cache |
| Production dependency audit | 0 vulnerabilities |

Total tests in the final ordered run: 225.

The recovery tier initially exposed a Windows timing issue in an existing ACL
round-trip test that launches both Windows PowerShell and PowerShell 7. Its
operations completed successfully but exceeded Vitest's generic five-second
limit. Only that test received a 15-second timeout; the full recovery tier then
passed without changing runtime behavior.

Three independent read-only reviews covered routing/security, SQLite migration,
and infrastructure. Their actionable findings were corrected and re-reviewed;
no P0-P2 implementation defect remained. The database reviewer noted only a
non-blocking coverage opportunity for additional seeded lease/result metadata,
although every current column is copied explicitly and the migration tests
preserve queued and available work.

## Compatibility And Security Boundaries

- `SYS-A` and `SYS-B` remain accepted for existing installations. New node IDs
  use lowercase letters, digits, and hyphens, start with a letter, and have a
  maximum length of 50 characters.
- Once generic-node messages exist in SQLite, downgrading to an older binary is
  unsupported because that parser recognizes only the two legacy IDs.
- Stop bridge and dispatcher writers during an operational migration. The
  migration is concurrency-safe, but quiescing avoids startup contention and
  makes rollback decisions explicit.
- The authorized-node list and Service Bus filters enforce local routing policy;
  they do not cryptographically authenticate a claimed message origin. Keep
  nodes inside one trusted administrative boundary until Phase 4 implements
  authenticated membership, rotation, and revocation.
- The package remains private. Public Git history sanitization, clean-network
  install, repository visibility, npm publication, Azure deployment, and
  running-service upgrades remain owner-gated.

## Next Slice

Phase 3 should add the smallest supported setup and doctor commands around the
now-stable generic-node contract. It should not add hosted discovery, pairing,
broadcasting, or a control plane.
