# [SYS-A] Core runtime follow-up — executor shutdown

October 6, 2026 IST. Status: **locally tested; undeployed**.
Baseline remains `fc876483b83ddebf16cc7ae5f3d3f437a845c63c` on the dirty
`codex/npm-first-onboarding-v0.3.1` candidate. No staging, commits, push,
service/credential changes or Azure operations.

## Reproduced gaps and fixes

The prior runtime slice left a concrete executor gap: the five-second kill
watchdog did not settle execution without a process `close` event. The
regression observed `pending` after the deadline. It now rejects
`CODEX_TERMINATION_FAILED`; a later successful close cannot replace that error.
The Windows tree-kill helper has a two-second timeout and forced helper kill.
These configured bounds are not guarantees during an OS or event-loop stall.

Three downstream defects were observed red and corrected:

- Both dispatcher and coordinator settled an unverified stop as terminal
  failure, rather than retaining the claim for controlled recovery.
- Claim-renewal error masked the failed termination that it triggered.
- A child `error` after termination began was misclassified as launch failure;
  review identified this path, its regression reproduced, and it now fails
  closed. Genuine pre-termination launch failures retain their classification.

The extracted dispatcher runtime stops polling, records the existing durable
runtime error and propagates it. Entrypoint/startup checks both dispatcher and
consultation failure state before parent callbacks or healthy heartbeat can
erase the gate. A service restart cannot simply resume on the same database
over an unverified surviving executor. The fatal entrypoint exits rather than
waiting indefinitely on inherited child pipes.

No automatic clear is implemented. Authorized operator proof that the exact
process tree is gone is required before a separately reviewed clear/recovery
operation. Runtime heartbeat state is not a tamper-proof latch against local
administrators or other privileged clients.

### Actual dispatcher-entrypoint follow-up

`tests/integration/dispatcher-supervision-process.test.ts` subsequently passed
two real source-entrypoint checks with disposable database/configuration/home:

- A retained consultation `CODEX_TERMINATION_FAILED` causes nonzero startup
  rejection, no healthy dispatcher heartbeat and no clearing of the failure.
- An idle dispatcher launched under a test-owned detached parent reaches
  healthy status, then exits after that parent is killed and retains degraded
  `RUNTIME_PARENT_LOST`.

These checks close the synthetic-entrypoint gap for those two paths. They
do not qualify actual WinSW or active authenticated executor shutdown.
No production state or credentials were touched; no new implementation change
was needed because the previously implemented behavior passed.

A fresh ordered ladder after these additions passed foundation 217/1 skip,
component 188, integration 62, workflow 7, recovery 35, security 68:
**577 application passes, one skip**. Typecheck passed and the public-safety
scan covered 269 files plus history with zero findings. Evidence:
`tmp/dispatcher-entrypoint-20261006`. The prior 575-test/artifact checkpoint
below is retained as dated history, not overwritten.

## Proof and limits

New mocked external-process-boundary tests prove no-close, verified close,
post-termination error, late close and helper-deadline handling. Real dispatcher
and coordinator/database tests prove claim retention and no output settlement.
Runtime/database tests prove startup remains gated rather than polling again.

Real package-managed Codex `0.150.1` initialization cancellation passed with
an empty isolated home, no copied authentication/configuration, evidence-only
arguments and immediate cancellation. This is a real binary/process check,
**not active authenticated model execution or descendant/service qualification**.
The existing compiled native fixture tests include descendant interruption;
they are still fixtures, not actual authenticated Codex descendants.

Scoped independent source review found no remaining confirmed must-fix after
the post-termination error correction. Reviewer ran no tests.

The first full ladder attempt stopped at component when the newly added review
regression was red; integration was not run on that failure. After its fix,
component and all following tiers were rerun:

| Level | Passed | Skipped |
| --- | ---: | ---: |
| Foundation | 217 | 1 |
| Component | 188 | 0 |
| Integration | 60 | 0 |
| Workflow | 7 | 0 |
| Recovery | 35 | 0 |
| Security | 68 | 0 |
| Total | **575** | **1** |

Tooling 12 passed; typecheck/build/MCP smoke passed (13 tools, status success).
Public-safety scan at that checkpoint: 266 files plus history, zero findings.
Machine-local evidence: `tmp/executor-shutdown-20261006`.

Installed-package consumer passed with prepared offline cache and run-owned
D: temporary directory (not a clean VM). Tested local artifact:

- Filename `balcony-agent-bridge-0.3.1.tgz`
- SHA-1 `a8e18c7eea45d0e2a1bdf768fbbef84becc131c5`
- Integrity `sha512-rLSSjAHESiq8WPzbdR7ERt4jjlQaxvWOCNnPTf8ruXnFY84vdqXiFjDQ/FRwZI6PqgrbwHvDsh/t0RKhZa7DEQ==`
- 162 files; 255,116 packed bytes; 1,239,459 unpacked bytes.

Production dependency audit reported zero vulnerabilities. Package identity
is not a clean release revision or deployment approval. Source hash inventory
is in `tmp/executor-shutdown-20261006/git-candidate-change-set.json`; it is not
an approved staging list.

Final documentation/service foundation rerun: 14 passed. Final public-safety
scan: 267 files plus history, zero findings. `git diff --check` passed.

## Current operational boundary and next slice

Read-only observation at `2026-10-05T21:47:14.927Z` still found runtime
requirements `4313605f...` and checkpoint `4981181d...` locally sent, zero
causal replies. Bridge wrapper remains stopped; old worker remains alive with
its original parent absent. Dispatcher wrapper remains running. Current shell
is not elevated. SYS-B privileged control/receipt is not independently proved.

Follow-up packet `2558c937-6c97-42ff-bdec-75ed70b021a8` was sent on ordinary
diagnostics with causation pointing to checkpoint `4981181d...`. Read-only
observation at `2026-10-05T21:54:17.650Z` found local state `sent` (send time
`21:54:05.804Z`), zero causal inbox replies. This is not SYS-B receipt or agent
execution proof.

The next slice remains reviewed clean release and bounded paired operator
qualification: actual Windows service and active Codex interruption, process
quiescence, rollback, restart/replay, then both-direction source-backed task
answers and enforced governance. Do not substitute initialization cancellation
or 575 local passes for that outcome; do not award 80/100.

Explicit Git approval scope and operator prerequisites:
[core Git review handoff](../handoff/SYS-A-CORE-AUTONOMY-GIT-REVIEW-2026-10-06.md).
The full changed-file inventory is a review aid, not permission to stage all
inherited onboarding work.

Sources: [core goal](../plans/2026-10-06-core-autonomy-goal.md),
[first runtime checkpoint](SYS-A-CORE-AUTONOMY-RUNTIME-2026-10-06.md),
[SYS-B handoff](../handoff/SYS-B-CORE-AUTONOMY-2026-10-06.md).
