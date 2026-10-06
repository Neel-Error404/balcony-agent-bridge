# [SYS-A] Core autonomy goal — runtime, tasks, governance

## Goal

Make reliable runtime, automatic read-only task completion, and enforced
governance work between SYS-A and SYS-B without manual prompt relay. Use
red/green regressions, reviewed source history, compatible deployment with
validated backup/rollback, and real bilateral causal source-backed answers.
Never substitute local fixtures for deployed proof or award 80 without evidence.

## Milestones in order

1. **Reliable runtime:** truthful one-worker service ownership; a child whose
   supervising parent disappears must shut down rather than hold the worker
   lock indefinitely. Preserve foreground operation as a distinct mode.
2. **Automatic task handling:** incoming eligible tasks invoke the permitted
   worker, return a durable terminal result, and resume the owning workflow
   without manually pasted requests. Diagnose actual worker login/termination
   rather than interpreting an auth file as successful execution.
3. **Enforced governance:** deploy and test the locally verified 1.1
   no-delegation/default-deny contract, explicit bounded positive delegation,
   permission revocation, deadline/replay and causal result invariants.

Each milestone runs tests one tier at a time and records source-owned proof,
review, Git identity and SYS-B disposition before the next milestone.

## Current truth

Latest local candidate has 577 passing application tests, one platform skip,
and 12 tooling checks; real unauthenticated Codex initialization cancellation
passed; the follow-up offline installed-package consumer passed too. It is
uncommitted/unpublished/undeployed. Both existing nodes' service-wrapper and
transport ownership have drifted. SYS-B reports stopped dispatcher; SYS-A
bridge wrapper is stopped while lock PID 8000 survives with old parent absent.
No direct elevated SYS-A or verified direct SYS-B operation is available.

Protocol 1.1 is not safe to send to a 1.0 decoder. Signed candidate and raw
legacy operating traffic cannot be mixed. Runtime recovery and paired
compatibility remain prerequisites, not already completed tests.

## First runtime slice

Use explicit service-only parent supervision. Capture the runtime's parent
PID; monitor only its existence, abort the bridge/dispatcher when it disappears,
record a safe failure, and reuse bounded transport/worker shutdown. Do not
kill the parent, unrelated workers, or delete live locks. Foreground launch has
no supervising service and does not opt into this mode.

Test first at the exported supervision seam, then disposable OS parent/child
processes. Cover parent loss, unreadable parent status (fail closed), already
aborted signal, listener/timer cleanup and unsupervised foreground mode.
Wire the service templates explicitly, with contract tests for registration.
Record PID-reuse/event-loop limits; mere parent existence is not a complete
service readiness certificate.

## Authority and stop gates

Local implementation/tests/docs and bounded diagnostic SYS-B communication
are authorized. Preserve inherited dirty work. Do not issue blind elevated
process termination, lock deletion, service install/update or credential/RBAC
changes. Before actual runtime mutation require verified owner/PID/service
inventory, paired operator access, backup, reviewed exact revision and rollback.
Git staging/commit/push and deployment remain explicit reviewed operations,
not consequences of setting an active goal.

Stop external mutation at missing access/authority/compatibility/rollback;
continue only meaningful local proof. Do not mark the active goal complete
until the actual bilateral outcome is verified.

## Delivery and subsequent scope

Send SYS-B the runtime test requirements over ordinary diagnostics, with
message IDs and explicit no-mutation boundary. Preserve its source baseline;
eventually align both systems at one clean reviewed release. Keep CHANGELOG,
verification evidence and exact changed-path manifests; vault holds thin links.

Easier setup, additional agent/module interoperability and broader operations
are deferred until all three core milestones pass their runtime gates.

Current evidence: [first runtime slice](../verification/SYS-A-CORE-AUTONOMY-RUNTIME-2026-10-06.md).
Follow-up: [executor shutdown](../verification/SYS-A-EXECUTOR-SHUTDOWN-2026-10-06.md).
Git approval: [review scope and operator gate](../handoff/SYS-A-CORE-AUTONOMY-GIT-REVIEW-2026-10-06.md).
Peer requirements: [SYS-B handoff](../handoff/SYS-B-CORE-AUTONOMY-2026-10-06.md).
