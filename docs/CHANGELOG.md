# Changelog

## Unreleased — `0.3.1-pilot.1`

October 7, 2026, `[SYS-A]`. Local first slice of paired deployment controls.
Not committed, deployed or bilaterally accepted at this checkpoint.

- Persistent six-launch pilot ledger, explicit model/subscription gates,
  bounded execution and actual dispatcher integration.
- Stage-only service replacement, gated activation/rollback, and manifest
  integrity checks; no real service operation by these fixture tests.
- Runtime bundle tool with clean revision gate and external archive receipt.
- Root-deadline and status-ledger identity defects reproduced and corrected.

Source: [controls checkpoint](verification/SYS-A-PAIRED-RUNTIME-CONTROLS-2026-10-07.md).

October 14, 2026, `[SYS-A]`: continued source delivery and independent review.
Pilot captured-output counting is combined without changing the ordinary
execution path. Paired updater targets, destination-path checks, schema-safe
failure recovery and started-worker identity are tightened. Fresh ordinary
installation is blocked by this host's Windows
build prerequisites; isolated source checks are not a new full-ladder verdict.
No service deployment or public package release follows from this checkpoint.
Source: [delivery boundary](verification/SYS-A-PAIRED-SOURCE-DELIVERY-2026-10-14.md)
and [SYS-B qualification handoff](handoff/SYS-B-PAIRED-SOURCE-QUALIFICATION-2026-10-14.md).

## Unreleased — `0.3.1-core.2`

October 6, 2026, `[SYS-A]`. Separate dependency-security revision over reviewed
core commit `cef068a...`; no merge, package publication or deployment.

- Pin MCP SDK `1.32.1` to address `GHSA-6qxp-vccf-f47h`.
- Add synthetic issuer-routing negative and trusted-positive regressions;
  dependency tests do not introduce an OAuth client into the product.
- Keep the previous candidate's source and artifact identity distinct.
- Prior zero-production-audit snapshots were superseded by the new advisory;
  audit results must be refreshed for each candidate.

Source: [security revision evidence](verification/SYS-A-MCP-SECURITY-2026-10-06.md).

## Unreleased — `0.3.1-core.1`

October 6, 2026, `[SYS-A]`. Local core candidate; not a public npm release,
installed service upgrade or bilateral acceptance.

- Added opt-in service-parent supervision, bounded bridge lane shutdown and
  recoverable interrupted sends.
- Bounded executor termination; unverified termination preserves claims,
  stops polling and blocks startup pending reviewed operator recovery.
- Prevented successful result publication after cancellation and reuse of
  late or mismatched results as continuation authority.
- Enforced explicit delegation contract `1.1`, default `none`, bounded caps,
  durable recovery policy and matching result versions.
- Hardened expiry, exact-request approve-once recovery, revocation-aware
  settlement and conservative runtime heartbeats.
- Retained internal signed peer-check dependencies and their regression lab;
  no new peer-check CLI, bootstrap or staged-onboarding features are included.
- Pinned package-managed Codex for reproducible isolated process tests and
  patched audit-flagged transitive runtime dependencies.

Sources:
[core goal](plans/2026-10-06-core-autonomy-goal.md),
[delegation](plans/2026-10-06-enforced-delegation-contract.md),
[runtime](verification/SYS-A-CORE-AUTONOMY-RUNTIME-2026-10-06.md),
[executor](verification/SYS-A-EXECUTOR-SHUTDOWN-2026-10-06.md),
[assembly evidence](verification/SYS-A-CORE-GIT-CANDIDATE-2026-10-06.md).

## Released baseline — `0.3.0`

August 31, 2026. Public npm-first onboarding baseline at `fc87648`.
Source: [v0.3 manifest](release-manifest-v0.3.md).

The older operational two-system fleet remains a separate legacy release.
Committing this candidate does not publish it or authorize service cutover.
