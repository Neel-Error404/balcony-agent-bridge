# [SYS-A] Paired pilot source checkpoint — delivery and qualification boundary

October 14, 2026, SYS-A local date; October 13 UTC. Owner approved Git source
delivery and SYS-A/SYS-B coordination. This checkpoint does **not** approve a
production cutover, authentication, system tool installation or a paid call.

## Source identity and scope

Branch: `codex/river-paired-runtime-20261007`.
Base: `e1ea77b65f47fb6bc9f1837503a1576b8283d7b6`.
Metadata: `0.3.1-pilot.1`.

The October 7 checkpoint's 27 recorded file hashes matched at the start of
this continuation. New review corrections and this handoff produce a new Git
revision; the post-push receipt identifies that exact commit/tree. No earlier
artifact is overwritten or relabeled.

Scope: persistent pilot limits, transactional stage-only service replacement,
bundle integrity tooling and a same-revision peer qualification contract.
The original development checkout's 114 dirty files and clean operating
checkout are preserved. Only reviewed candidate paths belong to this source
delivery; unrelated vault changes are not part of it.

## First failed gate — ordinary dependency installation

Fresh ordinary `npm ci` under Windows x64 Node **22.14.0**, npm **10.9.2**
failed before the acceptance ladder. The native package's implicit node-gyp
path selected Windows SDK `10.0.22621.0`, absent on this host (`MSB8036`).
The SDK include/library directories are absent despite retained registry
entries. A fresh cache reproduced it. A project-local npm **11.16.0** reproduced
the same failure without changing any system default. A no-op-build diagnostic
also exposed unavailable MSVC toolset selection; it did not repair the gate.

The exact lockfile `better-sqlite3@13.0.3` archive declares `gypfile: false`,
contains a Windows x64 prebuild, and uses non-compiling targets when that
prebuild is present. An explicitly isolated `npm ci --ignore-scripts`
preparation and in-memory native import succeeded (SQLite `3.53.4`), allowing
source regressions to be investigated. That command is **not** an ordinary
install pass, approved installer fallback, clean-host proof or service bundle
qualification. No system SDK/toolchain was installed or default changed.

**The ordered acceptance ladder remains stopped at installation.** October 7's
585 application passes / one skip and 18 tooling passes remain historical
evidence, not the October 14 final candidate's full-suite verdict.

## Source review and regression work

Independent source review found additional deployment/output safety gaps.
Corrections are checked at their public module or executor boundaries with
disposable fixtures, not production Windows services.

The pilot output cap now combines captured stdout and stderr only when the
pilot is enabled; ordinary execution behavior remains unchanged. The regression
was observed red with 47,000 stdout bytes plus 1,001 stderr bytes, then green.
A fixed-time pilot authentication fixture had also expired on the real clock;
it now injects the intended test clock rather than weakening runtime expiry.

The paired dispatcher updater now requires an explicit install root. Stage and
rollback backup destinations are fenced before writes; activation failures
leave legacy code stopped pending database restoration proof. A running child
must match the approved executable/entrypoint and its creation-bound identity,
not merely satisfy a child-count check. Focused service tests use a fake adapter;
real worker identity and ACL inheritance still require disposable rehearsal.
Rollback worker validation uses the digest-checked original XML, not the
candidate entrypoint. Destination rechecks address the reproduced snapshot-boundary
junction change; they are not an atomic defense against adversarial concurrent
path replacement. Stage WhatIf makes no writes and does not certify ACLs.

Fresh focused results: pilot configuration 1 pass; pilot/executor components
16 passes; ledger CLI integration 1 pass; service deployment fixtures 29 passes
with `--testTimeout 20000`; bundle tooling 18 passes. These are selected checks,
not a full repository ladder. Two unchanged service fixtures exceeded the
default five-second test timeout; the higher fixture timeout accommodates
PowerShell startup without weakening service stop/start bounds.

Independent source checks also confirmed typecheck/build, isolated MCP smoke
(13 tools/status), bundle-tooling fixtures and the public-safety scanner.
Fresh production dependency audit reports zero findings; all-dependency audit
reports two moderate development findings in Vitest / `@vitest/mocker`.
No automatic dependency upgrade or audit suppression was applied.

## SYS-A / SYS-B synchronization

SYS-A's current service configuration still references the older operating
runtime and schema 5. Both services were observed running with service-owned
direct children; this is not candidate deployment or authenticated task proof.
SYS-B's latest received qualification report remains the October 6 UTC report
for `e1ea77b...`; its historical service inventory is not current evidence.

Preflight diagnostic `55240011-bd9c-4fa1-8a9d-3b19e8a340cb` was locally queued,
then recorded sent at `2026-10-13T19:08:25.288Z`. No causal peer reply was found
in the subsequent local check. Sent state is not SYS-B receipt or agent execution.
After source push, send a separate exact-revision notice and verify its actual
outbox state and any causal peer reply; do not manufacture an acknowledgement.

The peer contract is
[SYS-B same-revision qualification](../handoff/SYS-B-PAIRED-SOURCE-QUALIFICATION-2026-10-14.md).
It requires an isolated checkout, exact commit/tree, first-failure reporting,
fresh local service inventory and one causal diagnostic response. It does not
authorize B to deploy, change signing/grants, copy credentials or invoke a model.

## Next gate and completion boundary

This is a source checkpoint awaiting **ordinary installation and full source
qualification on both hosts**. Resolve the Windows build prerequisite or an
explicitly reviewed supported installation contract, then rerun installation
and the ordered ladder. Do not automatically install system tools or silently
waive the failed gate.

After both hosts qualify the selected revision: one approved immutable bundle,
same-archive byte verification, unique-ID disposable services, backup/restore,
trust/backlog/grants, coordinated activation/rollback and fresh causal tasks.
No source fixture certifies any of those external operations.

Billing remains subscription-only with no incremental paid execution. No
authenticated Codex CLI invocation, credit purchase, provider-default change
or launch-budget reset occurred. The later live limit remains six reservations
per node, twelve total including failures. Additional projects, writable tasks,
community expansion, setup/adapters and 80% maturity remain unaccepted.
