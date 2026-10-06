# Changelog

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
