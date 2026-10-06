# [SYS-A] Core autonomy — first runtime slice

Local date: October 6, 2026 (IST). October 5 UTC test/peer timestamps fall on
October 6 locally. Status: **locally tested; not deployed**.

## Outcome and boundary

The active goal is reliable runtime, then automatic read-only task handling,
then enforced governance across SYS-A and SYS-B. Easier setup, additional
agent/module adapters and broader operations remain deferred.

This slice adds service-parent loss detection and cancellation-safe shutdown.
It does not establish unattended bilateral task completion, real Codex
termination, production service recovery, or 80/100 maturity.

Source baseline: `fc876483b83ddebf16cc7ae5f3d3f437a845c63c`, branch
`codex/npm-first-onboarding-v0.3.1`, local package metadata `0.3.1`. The candidate
contains inherited uncommitted work. No stage, commit, push, tag, publication
or service cutover occurred. Release identity must ultimately be a reviewed
clean revision, not this baseline plus an unspecified dirty tree.

Latest follow-up: [executor shutdown qualification](SYS-A-EXECUTOR-SHUTDOWN-2026-10-06.md).
The 565-test and package identities below remain the first-slice checkpoint,
not the newer follow-up artifact.

## Implemented behavior

- Service templates opt into `BALCONY_RUNTIME_SUPERVISION=service_parent`.
  Foreground use remains unsupervised unless explicitly opted in; unknown
  values raise an error.
- The supervisor checks the captured parent PID. Missing or unreadable parent
  status aborts the runtime and records a safe failure once. Timers and
  listeners are cleaned up.
- Bridge lanes preserve parent-loss classification after cancellation and
  wait for in-flight work to settle within a bounded shutdown interval.
  Without proof of quiescence, the entrypoint exits before closing its
  database or voluntarily releasing ownership; reclaim follows process death,
  not overlap with a still-active lane.
- Outbound cancellation does not turn an uncertain send into success or
  release its lease early. Inbound work checks cancellation before further
  persistence/settlement. Delivery remains at least once, not exactly once.
- Dispatcher and consultation results resolving after cancellation cannot
  publish successful terminal results. Durable claims remain subject to the
  established recovery mechanism.

Primary code: `src/runtime/parent-supervision.ts`, bridge runtime/entrypoint/
worker, dispatcher entrypoint/worker, autonomous consultation coordinator.

## TDD and review evidence

Observed before fixes: missing supervision module, missing service opt-in,
already-aborted heartbeat, secondary lane error overwriting parent loss,
premature return before lane quiescence, and dispatcher/coordinator success
publication after cancellation. Focused regressions passed after corrections.

The first OS-process harness failed because a non-detached Windows child died
with its parent, not because it reproduced an orphan. The corrected harness
creates a detached test-owned child, kills only the test-created parent, and
verifies parent-loss classification, owned-lock release and child exit.
It imports production supervision/lock mechanisms but uses a synthetic runtime:
**not** actual WinSW entrypoints, Azure or a real Codex process-tree test.

Scoped review found lane-error and quiescence gaps; these were fixed and
retested. Actual executor termination remains a deployment gate.

## Recorded verification

Evidence: `tmp/core-autonomy-20261006` (machine-local, not an immutable release).

| Ordered level | Passed | Skipped | Evidence |
| --- | ---: | ---: | --- |
| Foundation | 217 | 1 | `foundation.log` |
| Component | 179 | 0 | `component-final.log` |
| Integration | 59 | 0 | `integration-final.log` |
| Workflow | 7 | 0 | `workflow-final.log` |
| Recovery | 35 | 0 | `recovery-final.log` |
| Security | 68 | 0 | `security-final.log` |
| Application total | **565** | **1** | Six levels above |

Tooling: 12 passed. Typecheck, build and MCP smoke passed; MCP smoke connected
13 tools and obtained successful status. Public-safety scan reported 260 files,
history checked, zero findings; production audit reported zero vulnerabilities
at that checkpoint.

Installed-package smoke passed in an empty disposable npm project with prepared
offline cache and run-owned D: temporary directory. Not a clean VM or two
independent clean Windows hosts. Checkpoint artifact:

- `balcony-agent-bridge-0.3.1.tgz`
- SHA-1 `a587f15da4789eb946aee0307beb48cf537604c4`
- Integrity `sha512-c3w+LZjqEmUDZ1jBwLRLy33cu7jlDO0IwEip7J15czfi8MN/MGU87F9IEWEpizwFd7kwmKwZ6vVzoFG6CUVt+w==`
- 159 files; 253,336 packed bytes; 1,233,016 unpacked bytes.

This is a tested local artifact, not deployment authorization. Later packaged
source/docs changes require a new package identity.

After the evidence/handoff documentation was added, tiered closure checks
passed: 14 documentation/service foundation tests, 47 focused runtime/task
component tests, and the one disposable process integration test. The fresh
public-safety scan covered 262 files and history with zero findings;
`git diff --check` passed. These focused reruns are not added to the 565 total.

Vault project discovery found one registered repository with the source and
operating checkouts. Vault freshness still reports four unrelated existing
note/registry timestamp mismatches (trading, AI Career Portfolio, Elder
Protocol, Personal Authoring Lab); no bridge issue was reported. This is not
a clean-vault claim.

## Peer communication and operational truth

Ordinary diagnostics were used on the legacy fleet; no 1.1 task or one-sided
signed traffic was introduced.

- Requirements: `4313605f-389f-45c8-ac1e-092d20e3a26f`
- Tested checkpoint: `4981181d-4660-4567-a6c3-146625762710`
- Conversation: `8b096084-4cb2-48c1-adb4-5c1ae185256a`
- Stream: `benchmark80-diagnostics`

Read-only SYS-A SQLite observation at `2026-10-05T21:30:58.552Z` found both
outbox rows `sent`, zero causal inbox replies. Requirements sent at
`21:07:15.195Z`; checkpoint at `21:30:01.001Z`. This is local broker-send
evidence only; SYS-B receipt, acknowledgement and execution remain unverified.

Fresh local inventory still showed bridge wrapper stopped and dispatcher
wrapper running. The identified old bridge child remained alive with its
original parent absent; installed bridge XML had no new supervision mode.
No production service/process, XML, credential or database was changed.

## Remaining gates and next slice

1. Review the exact change-set, preserve inherited dirt, obtain explicit Git
   delivery authority, and produce a clean immutable source revision.
2. Obtain bounded operator control on both nodes, fresh ownership inventory,
   compatible artifact and validated backup/rollback. Do not remove live locks
   or kill unverified processes.
3. Test actual WinSW entrypoints and real Codex interruption. Parent existence
   does not prevent PID reuse or detect blocked event loops. Dispatcher abort
   still depends on executor closure; hung real shutdown is not qualified.
4. Only then upgrade both nodes and prove restart/reclaim/replay and bilateral
   task receipt, authorized claim, source-backed terminal result and causal
   acceptance. Default-none must produce no nested request.

**Next slice:** reviewed release preparation and controlled real-worker shutdown
qualification, not easier onboarding or more adapters.

Machine-local `tmp/core-autonomy-20261006/git-candidate-change-set.json`
records changed-path hashes and the unstaged inventory. It is a review aid,
not an approved staging list: several owned files also contain inherited
changes, so file-level staging alone cannot isolate this slice.

Sources: [goal](../plans/2026-10-06-core-autonomy-goal.md),
[SYS-B handoff](../handoff/SYS-B-CORE-AUTONOMY-2026-10-06.md),
[delegation proof](SYS-A-ENFORCED-DELEGATION-2026-10-06.md).
