# [SYS-A] Batch 6 Updater Recovery Amendment - 2026-08-21

## Scope

Amend only the existing-dispatcher deployment transaction after SYS-B's exact
Batch 6 rollout stopped the dispatcher and the original updater discarded both
the forward and rollback exceptions. This remains Batch 6 closeout work. It is
not Batch 7 and does not change the pinned-Git evidence provider or message
protocol.

Base release: `069368d971a4f4c461145752b3456691809f6731`.

Development branch: `codex/sys-a-batch6-updater-recovery`.

No deployment, service restart, Azure/RBAC/network/queue mutation, registry
mutation, persistent Git trust change, vault mutation, staging, commit, or push
is part of this implementation record.

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

## Amendment

- `DispatcherServiceLifecycle.psm1` centralizes service snapshots, stopped
  process quiescence, bounded start retry, exactly-one-child health, and
  secret-safe failure summaries behind an injectable adapter.
- The updater records a forward or rollback stage before each mutation.
- Forward and rollback errors retain type, HRESULT/native code, stage, and final
  bounded service state without returning exception messages.
- Rollback now restores and verifies XML, Codex files, registry bytes, ACL SDDL,
  original startup mode, and the prior running/stopped plus child state.
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
| Recovery | 19/19 pass |
| Security | 33/33 pass |
| **Total** | **201/201 pass** |
| Typecheck | PASS |
| Production build | PASS |
| MCP smoke | PASS, 13 tools |
| Production audit | PASS, 0 vulnerabilities |
| PowerShell parser | PASS |
| Real read-only SYS-A service/CIM health seam | PASS, Running/Auto/one child |

The lifecycle tests execute injected transient start failure, bounded retry,
retry exhaustion, stale wrapper/child exit, exactly-one-child health, and
secret-marker exclusion. The unchanged pinned-Git component fixture exceeded
its historical five-second per-test timeout under current Windows Git/temp
latency when run with the default harness; the exact file passed alone and the
complete 68-test component level passed with `--testTimeout=15000`. No timeout,
assertion, or production source was changed for that unrelated fixture.

## Remaining Gates

1. Review the exact diff and obtain independent SYS-B source acceptance.
2. Create a new immutable release SHA only under explicit commit permission.
3. Under separate deployment approval, run zero-mutation `-WhatIf`, deploy one
   machine at a time, preserve the previous worktree and rollback directory,
   and run local plus SYS-A-triggered nested acceptance.
