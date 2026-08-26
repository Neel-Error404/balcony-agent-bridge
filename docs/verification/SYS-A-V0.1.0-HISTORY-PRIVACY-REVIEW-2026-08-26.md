# SYS-A v0.1.0 History And Privacy Review

Date: 2026-08-26

System: `[SYS-A]` (inferred from the D-drive workspace because the process
environment did not define `BALCONY_SYSTEM_ID`)

Reviewed candidate: `498047b998e1e0851782e354278b7800e93043ef` plus the
evidence-only corrections that add this record

Decision: retain the existing public Git history for `v0.1.0`

## Scope

The review covered the current tree and every blob reachable from `HEAD`, with
special attention to the operational paths that the original clean-export plan
would have excluded: `AGENTS.md`, handoffs, verification records, plans, cost
notes, and machine-oriented runbooks.

## Evidence

- `npm run check:secrets` scanned 183 current/history files and reported zero
  findings. Its detectors cover private-key blocks, common provider tokens,
  Service Bus and Storage connection strings, bearer credentials, client-secret
  assignments, SAS signatures, credentialed URLs, and forbidden credential or
  database filenames.
- A separate reachable-history review checked absolute Windows paths, IPv4-like
  values, Service Bus hostnames, UUIDs, and email addresses.
- The active Azure tenant identifier was not present in reachable history.
- Every Service Bus hostname found in history was an obvious documentation or
  test placeholder. No live namespace hostname was present.
- The only IPv4-like match was a version-shaped test value, not a network
  address.
- Email matches were public Git commit identities or invalid test addresses.
- Remaining absolute paths are generic project, ProgramData, and vault routes;
  they contain no credential value or user-profile secret.
- Remaining UUIDs are synthetic fixtures or operational message identifiers;
  none matches the active Azure tenant identifier.

## Decision And Residual Risk

The owner approved retaining the already-public history. Rewriting it would
invalidate existing clones and references without retracting copies that may
already exist. The operational documentation and evidence are therefore an
explicit `v0.1.0` GitHub source-archive exception, while the npm artifact keeps
its much smaller allowlist.

Automated and pattern-based review cannot prove the absence of every unknown
secret format. Any later confirmed exposure must be handled by revoking or
rotating the affected credential first. A history rewrite by itself is not
credential remediation.

Before creating the final tag, rerun `npm run check:secrets` on the release
commit and confirm that `v0.1.0` resolves to that exact commit.
