# [SYS-A] Core autonomy — Git review and operator handoff

October 6, 2026. **Review request only; no staging, commit or deployment.**

## Why delivery is gated

The active candidate contains inherited onboarding/peer-check work together
with runtime, task lifecycle and governance fixes. Its committed base is
`fc876483b83ddebf16cc7ae5f3d3f437a845c63c`, not the exact tested dirty source.
Stage-all would silently include work outside the core goal; staging only the
latest few files would omit dependencies and could produce a broken release.

Current inventory and content hashes:
`tmp/dispatcher-entrypoint-20261006/git-review-inventory.json`.
This local inventory is not an approved staging list or secret-bearing backup.

## Proposed delivery scope

Prepare the smallest coherent **core runtime/governance** change-set:

- Bridge parent supervision, abortable waits, lane health/quiescence and
  recoverable interrupted deliveries.
- Executor termination deadlines/classification, dispatcher runtime stop and
  retained startup gate, cancellation-result fences and deterministic recovery.
- Explicit no-delegation/default-none contract, bounded delegation, result
  version/causation checks, deadlines, approval/revocation settlement rules.
- The corresponding regression, recovery, security and actual-entrypoint tests.
- Architecture/configuration/limitation/runbook updates and source-linked
  goal, verification, peer handoff and Unreleased changelog entries.

Some bridge/envelope/database files contain inherited signed peer-check seams.
Their exact dependency closure must be retained or extracted together;
do not delete inherited work in the canonical checkout to simplify staging.
Managed Codex initialization tests require the pinned native dependency and
toolchain resolver; do not omit them while claiming that test is reproducible.

Keep unrelated CLI/bootstrap/onboarding expansion and its documentation out
unless a necessary dependency is specifically identified and reviewed.
Full-file ownership does not mean all hunks in that file belong to this slice.
A separately assembled clean candidate must pass its own ordered tests before
its staged diff can be treated as the reviewed release.

## Git approval — granted for local assembly and commit

The owner approved isolated assembly, staging, review and commit of the core
runtime/governance changes and necessary dependencies. The isolated branch is
`codex/river-core-governance-20261006`, package `0.3.1-core.1`.
The original dirty checkout and operating checkout must remain untouched.
Final exact staged review and candidate verification precede commit.

Push, pull requests, tags, npm publication and service deployment remain
separate operations. This request does not authorize them.

## Runtime operator prerequisites

Before either node is changed, a bounded operator route must establish:

1. Current wrapper/worker/parent and lock ownership, actual entrypoint revision,
   schema and eligible/claimed/backlog state on both machines.
2. One exact compatible immutable artifact with service scripts/templates,
   native dependencies, approved identity/signing configuration and safe ACLs.
3. All SQLite writers quiesced and protected backups validated by restore on a
   copy; original runtime/XML/registry retained; paired rollback/wire-format
   handling defined.
4. Actual service and active Codex termination, no surviving prior workers,
   restart/reclaim/replay, then causal source-backed tasks both ways and
   default-none/denial/revocation/deadline/version tests.

SYS-A currently lacks elevated execution; SYS-B privileged control and causal
receipt are not verified. Do not remove a live lock, terminate an unverified
process or treat a diagnostic message as operation authority.

## Evidence and precise remaining proof

- [First runtime checkpoint](../verification/SYS-A-CORE-AUTONOMY-RUNTIME-2026-10-06.md)
- [Executor shutdown checkpoint](../verification/SYS-A-EXECUTOR-SHUTDOWN-2026-10-06.md)
- [SYS-B preparation contract](SYS-B-CORE-AUTONOMY-2026-10-06.md)

Actual dispatcher source-entrypoint tests now verify retained-failure startup
rejection and idle shutdown after its test-owned parent is killed. These use
disposable configuration/database/home and no production state. They do not
prove Windows Service Manager/WinSW behavior or active authenticated worker
termination. The live bilateral goal and 80/100 remain unachieved.
