# [SYS-A] v0.2.0 Final Publication Evidence - 2026-08-28

## Decision And Evidence Boundary

`OBSERVED / TESTED`: Phase 2A merged through PR #9 as
`c78c172eb479046f0e44c7726a67ab06c7eecb10`; Phase 2B merged through PR #10
as `23952cbaaadc1bd7504026670b2b7c751e176c76`; and the v0.2.0 release
preparation merged through PR #11 as
`f32a2aa957ad2d948f769d908567d330823cb6cd`.

The complete ordered release ladder and authoritative package freeze below ran
against the clean PR #11 merge commit. This record is excluded from the npm
package by the package allowlist. Publication, tag, and GitHub prerelease
results are recorded here only after their remote state is independently
verified.

No command in this release validation changed the operational SYS-A/SYS-B
bridge, Azure, RBAC, Windows services, live databases, broker entities,
production signing configuration, or credentials.

## Phase 2 Release Contract

- Phase 2A adds schema-v8 durable resources and exact persistent
  peer/resource grants.
- Phase 2B adds schema-v9 durable approval requests, approve-once,
  peer/resource-scoped temporary approval, strict expiry, and append-only
  metadata audit.
- Migration is additive and creates no implicit resources, grants, approvals,
  or decisions. Existing nodes remain deny-by-default until explicitly
  configured by a local operator.
- Both dispatcher paths enforce the resource decision before project lookup,
  conversation history, or execution context is exposed.
- The signed v0.1 wire format, Azure transport contract, and MCP tool inventory
  remain unchanged. Approval administration is CLI-only.

## Exact-Head Review And Merge

The release-preparation branch head was
`b56cf7372fada9dcbf05572c6c4b8f4133b64043`. An independent read-only
exact-diff review compared all 11 changed paths with the Phase 2 merge base and
reported no P0, P1, or P2 findings. GitHub reported PR #11 mergeable and its
configured Devin status context as successful, but the check disclosed that
the automated review itself was skipped because trial credits were exhausted;
that status is not represented here as substantive review evidence.

PR #11 merged with two parents as
`f32a2aa957ad2d948f769d908567d330823cb6cd`. Local `main` was then verified
clean and byte-identical by commit identity to `origin/main`.

## Final Ordered Verification

Every command ran with process-scoped `BALCONY_SYSTEM_ID=SYS-A` where the
runtime required identity. The host environment did not have that variable set
globally, so no machine identity was inferred from the drive path alone.

| Order | Command | Observed result |
|---:|---|---|
| 1 | `npm ci` | Pass; 228 packages installed, 229 audited, 0 vulnerabilities |
| 2 | `npm run test:foundation` | Pass; 16 files, 103 passed, 1 skipped |
| 3 | `npm run test:component` | Pass; 19 files, 120 passed |
| 4 | `npm run test:integration` | Pass; 11 files, 50 passed |
| 5 | `npm run test:workflow` | Pass; 3 files, 4 passed |
| 6 | `npm run test:recovery` | Pass; 7 files, 26 passed |
| 7 | `npm run test:security` | Pass; 11 files, 58 passed |
| 8 | `npm run typecheck` | Pass; no TypeScript diagnostics |
| 9 | `npm run build` | Pass |
| 10 | `npm run smoke:mcp` | Pass; connected, 13 tools, status succeeded |
| 11 | `npm run check:secrets` | Pass; 199 current-tree/history files scanned, 0 findings |
| 12 | `npm audit --omit=dev --audit-level=high` | Pass; 0 vulnerabilities |
| 13 | `npm run verify:package` | Pass; allowlist and package command checks passed |
| 14 | `npm run verify:public-alpha` | Pass; isolated empty npm cache and consumer, valid dependency tree, Phase 2 administration smoke passed |
| 15 | `git diff --check` and clean-tree check | Pass |

Test total: 361 passed and 1 explicit skip across 67 test files.

Additional release checks:

- PowerShell parser: 12 release/service scripts, 0 parse errors.
- Bicep: all 4 entry points built successfully with `az bicep`.
- Node.js: `v22.14.0`.
- npm: `10.9.2`.

## Authoritative Artifact

`OBSERVED / VERIFIED`: `npm pack --json` produced the preserved artifact from
clean merged source `f32a2aa957ad2d948f769d908567d330823cb6cd`. A second
pack from a separate detached clean checkout of that exact commit produced the
same size and SHA-256 byte-for-byte.

| Property | Value |
|---|---|
| Filename | `balcony-agent-bridge-0.2.0.tgz` |
| npm SHA-1 shasum | `022023a3d6d277436f2729fed009fc6c8cbda790` |
| Independent SHA-256 | `d6c93033342ee7413ad93fd36feb329d9c8abbde55591f7029c3854f6a12ad14` |
| npm SHA-512 integrity | `sha512-FPDNjyC4isCgYU6bicb3c9JpDoJLgVieo7sbNY3VEqJb5KSJH2pXlIMhUt8DM2maQzQKUM0fLQSJpPUNAHaU7g==` |
| File count | 108 |
| Packed size | 139,569 bytes |
| Unpacked size | 732,330 bytes |
| Forbidden entries | 0 |

Only this frozen tarball is authorized as the npm publication input. The
canonical evidence record is excluded from the npm allowlist; a post-evidence
pack comparison must remain byte-identical before publication.

## Public Publication Outcome

`DEPLOYED / VERIFIED`: npm published `balcony-agent-bridge@0.2.0` publicly at
2026-08-27T19:36:04.784Z. The publish command named only the frozen tarball,
not the source directory. Registry metadata reports the expected SHA-1 and
SHA-512 integrity. A download through a new empty npm cache reproduced
SHA-256 `d6c93033342ee7413ad93fd36feb329d9c8abbde55591f7029c3854f6a12ad14`
and size 139,569 bytes exactly.

A separate empty consumer and empty cache installed exactly version `0.2.0`
from the public registry and verified:

- CLI help and the resource, grant, and approval command inventory;
- local demo result `passed` with `azure_used=false`;
- isolated setup, healthy doctor, and matching status;
- resource registration/listing and persistent grant create/list/revoke; and
- empty approval list/audit administration on the newly initialized database.

The package-level clean-consumer verifier had already exercised a seeded
pending request, approve-once decision, and append-only approval audit against
the byte-identical frozen artifact. The first public-consumer harness attempt
correctly failed on an inherited-ACL identity directory. A second attempt
correctly failed doctor on a malformed test membership shape. After using the
documented restricted directory and nested key-list membership schema, the
same public-consumer gate passed. All disposable consumers, caches, databases,
membership files, and test private identities were moved to the Windows
Recycle Bin after verification.

## Tag And GitHub Prerelease Outcome

`DEPLOYED / VERIFIED`: Annotated tag `v0.2.0` has tag-object ID
`7a5556ccc854be49447b9ae6c81042fc9c687383` and peels locally and remotely to
the final package-equivalent tested source/evidence commit
`a6b266232c599d5a67d4e0f1ca3aed2d5577d9c1`.

The GitHub prerelease is
[Balcony Agent Bridge v0.2.0](https://github.com/Neel-Error404/balcony-agent-bridge/releases/tag/v0.2.0).
Its attached `balcony-agent-bridge-0.2.0.tgz` is 139,569 bytes; GitHub reports
SHA-256 `d6c93033342ee7413ad93fd36feb329d9c8abbde55591f7029c3854f6a12ad14`,
and a fresh release download reproduced that digest. The canonical evidence
asset is this repository file, uploaded again after its final evidence-only
merge so the attached copy matches the concluded record.

## Accepted Residuals And Deferred Operations

- Durable ingress provenance stores the authenticated bit, exact origin, and
  request fingerprint, but not the verified signing key ID.
- Local OS access plus exact `BALCONY_SYSTEM_ID` remains the approval-operator
  trust boundary; no web or MCP administration surface was added.
- npm's public metadata records `_from` as the relative tarball filename but
  `_resolved` as the publisher-local absolute Windows artifact path. The path
  contains no credential or token and is absent from the verified tarball, but
  it is an accepted privacy residual of npm's direct-tarball publication flow.
- Local clean-consumer verification is not a separate clean operating-system
  image and is not live signed two-node acceptance.
- Deployment and Phase 3 remain deferred. No live infrastructure or
  operational bridge change is part of this release.
