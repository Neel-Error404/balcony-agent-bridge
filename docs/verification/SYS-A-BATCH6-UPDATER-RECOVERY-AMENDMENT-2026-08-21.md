# [SYS-A] Batch 6 Updater Recovery Amendment - 2026-08-21

## Scope

Amend only the existing-dispatcher deployment transaction after SYS-B's exact
Batch 6 rollout stopped the dispatcher and the original updater discarded both
the forward and rollback exceptions. SYS-B then returned `AMEND` on candidate
`6d4232a7c61904222abfaffc941f69d342608e71` because the rollback ACL snapshot
omitted a pre-existing `codex-code-mode-host.exe`. This remains Batch 6
closeout work. It is not Batch 7 and does not change the pinned-Git evidence
provider or message protocol.

Base release: `069368d971a4f4c461145752b3456691809f6731`.

Development branch: `codex/sys-a-batch6-updater-recovery`.

No deployment, service restart, Azure/RBAC/network/queue mutation, registry
mutation, persistent Git trust change, or vault mutation was performed while
implementing or verifying this correction.

## Demonstrated Failure Boundary

- SYS-B restored the exact legacy XML, registry, executable bundle, identity,
  and startup selection, but the updater's one rollback `Start-Service` call
  failed and left the dispatcher stopped.
- One later controlled start recovered the unchanged legacy service.
- The original updater catch replaced both error records with a generic string,
  so the exact first forward failure is unrecoverable.
- The previous recovery tests asserted source strings but did not execute
  service-stop quiescence, transient start failure, retry exhaustion, or
  secret-safe error formatting.
- Candidate `6d4232a7...` backed up and hash-verified the companion executable,
  but excluded it from `$aclProtectedPaths`; rollback therefore could not
  restore or prove its exact pre-existing SDDL after the forward ACL mutation.

## Amendment

- `DispatcherServiceLifecycle.psm1` centralizes service snapshots, stopped
  process quiescence, bounded start retry, exactly-one-child health, and
  secret-safe failure summaries behind an injectable adapter.
- The updater records a forward or rollback stage before each mutation.
- Forward and rollback errors retain type, HRESULT/native code, stage, and final
  bounded service state without returning exception messages.
- Rollback now restores and verifies XML, Codex files, registry bytes, ACL SDDL,
  original startup mode, and the prior running/stopped plus child state.
- Both `codex.exe` and `codex-code-mode-host.exe` are included in the retained
  ACL snapshot before any forward ACL change.
- ACL rollback writes only the captured access-control section through the
  version-appropriate Windows file ACL API. Owner, group, and audit sections
  are not mutated; the post-restore assertion still compares the complete SDDL
  and fails closed on any drift.
- Rollback material is retained after success or recovery until post-deployment
  acceptance explicitly authorizes cleanup.
- Bridge PID and queue/DLQ invariance remain external operator gates because the
  updater must not inspect or mutate the bridge or Azure transport.

## Focused Verification

The regression was first made red with seven focused failures. After the
amendment:

| Gate | Result |
|---|---:|
| Foundation | 54/54 pass |
| Component | 68/68 pass |
| Integration | 24/24 pass |
| Workflow | 3/3 pass |
| Recovery | 21/21 pass |
| Security | 33/33 pass |
| **Total** | **203/203 pass** |
| Typecheck | PASS |
| Production build | PASS |
| MCP smoke | PASS, 13 tools |
| Production audit | PASS, 0 vulnerabilities |
| PowerShell parser | PASS |
| Real read-only SYS-A service/CIM health seam | PASS, Running/Auto/one child |

The lifecycle tests execute injected transient start failure, bounded retry,
retry exhaustion, stale wrapper/child exit, exactly-one-child health, and
secret-marker exclusion. The companion regression begins with pre-existing
bytes and a protected ACL distinct from its directory, captures both, mutates
both, rolls back, and proves exact SHA-256 plus complete SDDL restoration. A
separate source-boundary test requires both installed Codex executables in the
ACL snapshot input. The executable companion scenario passes under both
Windows PowerShell 5.1 and PowerShell 7, exercising both ACL API branches.

The unchanged pinned-Git component fixture exceeded its historical five-second
per-test timeout under current Windows Git/temp latency when run with the
default harness; the exact file passed alone and the complete 68-test component
level passed with `--testTimeout=15000`. No timeout, assertion, or production
source was changed for that unrelated fixture.

## Fresh Read-Only Runtime Baseline

Immediately before replacement-candidate creation, without invoking any
service command:

- `BalconyAgentBridge`: Running/Auto, wrapper PID `22812`, one child `23344`.
- `BalconyAgentDispatcher`: Running/Auto, wrapper PID `9936`, one child `2060`.
- Dispatcher service XML SHA-256:
  `69E4E2EDE235A80B3A399007D82139A24C0E11161AB6126C062581F49E6D4A2F`.
- Machine-local dispatcher registry: `4564` bytes, SHA-256
  `B5B0D6AD6E7F566A46CB3766D5B9CCB60D2721B7AE7D261A34698BB4085C2321`.
- Bridge queue: pending `0`, leased `0`, sent `59`, quarantined `0`, expired
  `0`; bridge runtime reported healthy.
- The dispatcher process was running with one child, but its application
  heartbeat remained stale. This source review does not infer runtime
  acceptance from process health.

No service, ACL, registry, queue, Azure, persistent Git trust, or deployment
mutation was performed by these checks.

## Remaining Gates

1. Create an immutable replacement SHA and obtain independent SYS-B source
   acceptance against that exact candidate.
2. Under separate deployment approval, run zero-mutation `-WhatIf`, deploy one
   machine at a time, preserve the previous worktree and rollback directory,
   and run local plus SYS-A-triggered nested acceptance.
