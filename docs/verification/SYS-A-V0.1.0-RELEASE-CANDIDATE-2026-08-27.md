# [SYS-A] v0.1.0 Release Candidate Evidence - 2026-08-27

## Decision and boundary

`OBSERVED`: The local v0.1.0 npm release candidate was frozen from source
commit `a9a6a6bb354851b142889c77afa9672b205dbe78` on Windows x64. The checkout
started clean on branch `codex/release-v0.1.0`, and all required local checks
below passed in the manifest order. This establishes a local release-candidate
artifact only.

The rollback/base point is
`ee569936473f17c23a9f3a4c2c2ea1a97fe640d9`. Release correction commits are
`c3a98384292b945f56248dac3361afb254172228`,
`6ccbcb4bec29fb86ab1582faea54a237174e36a4`, and
`a9a6a6bb354851b142889c77afa9672b205dbe78`.

This file is the durable, sanitized record of the command invocations, exit
status, counts, and result summaries for the local freeze. The tables below are
the source-linked verification record for the requirements in the
[v0.1 release manifest](../release-manifest-v0.1.md). Raw session captures
remain outside the repository because they contain machine-local paths; they
are not publication evidence.

## Owner decision and release targets

- Owner decision recorded in the release manifest on 2026-08-26: approve
  public npm publication, a `v0.1.0` Git tag and GitHub Release, retained
  public history, private vulnerability reporting, and a separately gated live
  multi-node rollout.
- Phase 1A decision on 2026-08-27: approve local release-candidate verification
  and its evidence commit only. Phase 1A approval does not execute Phase 1B
  publication, despite the prior release approval.
- npm registry target: the public npm registry, package
  `balcony-agent-bridge@0.1.0`.
- GitHub repository/release target: `Neel-Error404/balcony-agent-bridge`, tag
  and release `v0.1.0`.
- Rollback point: `ee569936473f17c23a9f3a4c2c2ea1a97fe640d9`, as recorded
  above. No rollback operation was performed.

## Required local check results

Every command ran with process-scoped `BALCONY_SYSTEM_ID=SYS-A`. The test
levels ran individually and in order; no failed level was bypassed.

| Order | Check | Observed result |
|---:|---|---|
| 1 | `npm ci` | Pass; 228 packages added, 229 packages audited, 0 vulnerabilities |
| 2 | `npm run test:foundation` | Pass; 16 files, 102 passed and 1 skipped out of 103 tests; 8.63 s |
| 3 | `npm run test:component` | Pass; 16 files, 98/98 tests; 9.61 s |
| 4 | `npm run test:integration` | Pass; 8 files, 34/34 tests; 28.08 s |
| 5 | `npm run test:workflow` | Pass; 3 files, 4/4 tests; 0.863 s |
| 6 | `npm run test:recovery` | Pass; 6 files, 22/22 tests; 5.17 s |
| 7 | `npm run test:security` | Pass; 11 files, 58/58 tests; 5.94 s |
| 8 | `npm run typecheck` | Pass; TypeScript emitted no diagnostics |
| 9 | `npm run build` | Pass; clean production TypeScript build |
| 10 | `npm run smoke:mcp` | Pass; connected, 13 tools, status succeeded |
| 11 | `npm run check:secrets` | Pass; 184 reachable-history files scanned, 0 findings |
| 12 | `npm audit --omit=dev --audit-level=low` | Pass; 0 vulnerabilities |
| 13 | `npm run verify:package` | Pass; package boundary verified; install smoke intentionally not requested by this command |
| 14 | `npm run verify:public-alpha` | Pass; isolated-cache network install into a disposable empty npm project, valid dependency tree, offline `npm exec` command path |
| 15 | `git diff --check` | Pass; no whitespace errors before creation of this evidence file |

Test total: 318 passed and 1 platform skip across 60 test files. The skipped
test remains explicitly reported; it was not converted into a pass.

`verify:package` and `verify:public-alpha` both reported the same package
filename, SHA-1 shasum, SHA-512 integrity, file count, packed size, and
unpacked size shown below.

## Additional platform and infrastructure proof

| Check | Observed result |
|---|---|
| PowerShell parser over every `scripts/*.ps1` and `scripts/*.psm1` | Pass; 15/15 files parsed, 0 parser errors |
| Direct `tests/foundation/bridge-service-security-behavior.ps1` | Pass; `ACL_BEHAVIORAL_PROOF_PASS` |
| `scripts/Test-BridgeTopologyParameters.ps1` with `infra/example.parameters.json` and required node `node-a` | Pass; 3 example nodes and the required node were present |
| Bicep lint | Pass for all four entrypoints: `deploy.bicep`, `main.bicep`, `routing-rules.bicep`, and `subscription-budget.bicep` |
| Bicep build | Pass for the same four entrypoints; output was directed outside the repository |

Tool versions observed on the verification host:

- Node.js `v22.14.0`
- npm `10.9.2`
- PowerShell `7.6.4`
- Azure CLI `2.77.0`
- Bicep CLI `0.46.1` (`545b338e2c`)

All tools required for these additional checks were available. Two command
wrapper mistakes occurred before their target checks ran: the initial parser
wrapper had invalid PowerShell syntax, and the initial Azure CLI version query
had invalid quoting. Both were explicit harness errors, not repository check
failures; corrected invocations then produced the results above.

## Frozen source artifact

`OBSERVED`: `npm pack --json` ran at source commit
`a9a6a6bb354851b142889c77afa9672b205dbe78`. A comparison copy was preserved
outside the repository, and SHA-256 was computed independently from the
created tarball.

| Property | Value |
|---|---|
| Filename | `balcony-agent-bridge-0.1.0.tgz` |
| npm SHA-1 shasum | `38576c4e1eadcf77aa61b95b8b8d2ad143da12c3` |
| npm SHA-512 integrity | `sha512-6D7K5oP8mEJA9rDjsocJdb94vcx0j09no11fdG/uJV5ZZeA+4YwgcmTpnY6PmjiBPqixKqI4ZU0pBpabf1aQIg==` |
| Independent SHA-256 | `78b99b42624bcd9ec36651039f9416dd1ec093449117fcc76b37225df9dbf91d` |
| File count | 102 |
| Packed size | 124,472 bytes |
| Unpacked size | 632,470 bytes |

The observed tarball contained only the declared package surfaces: compiled
`dist/**`, `README.md`, `LICENSE`, `SECURITY.md`, `package.json`, and the two
sanitized configuration examples. It did not contain `docs/verification/**`.

`OBSERVED`: After evidence commit
`733e1c3e6b3193d6e9eeb15b0faf6906cbf1b4da` was committed, a new
`npm pack --json` artifact was compared with the preserved artifact from source
commit `a9a6a6bb354851b142889c77afa9672b205dbe78`. Filename, npm SHA-1
shasum, independently computed SHA-256, npm SHA-512 integrity, file count,
packed size, and unpacked size all matched exactly. Tar inspection found zero
`docs/verification/**` entries.

## Failure history and disposition

`OBSERVED-IN-THIS-PHASE`: The first Phase 1A foundation run failed because the
Windows ACL behavior child inherited Vitest's five-second per-test timeout.
Diagnosis reproduced the timeout under contention. Commit
`a9a6a6bb354851b142889c77afa9672b205dbe78` added a 15-second child-process
timeout and a 20-second per-test timeout. The correction had red/green stress,
isolated-test, full-foundation, specification, and quality approval before this
freeze. The current foundation tier and direct ACL behavior proof both passed;
the earlier failure is retained here rather than erased by the green rerun.

`HANDOFF-REPORTED`: During the earlier clean npm audit, the first of three
verification runs had packaged `doctor` exit 1, but the verifier did not retain
that command's stdout, so the failed check could not be identified. The second
and third unchanged runs passed and produced identical package bytes. That
unexplained first failure remains a release-quality concern, although it was
not reproducible in those two runs. In this freeze, command output and
check-level results were retained, and the single required
`verify:public-alpha` run passed; it was not retried to hide a failure.

## Independent review findings and dispositions

- Task 1 specification review found stale contradictory CLI guidance. Commit
  `6ccbcb4bec29fb86ab1582faea54a237174e36a4` removed the contradiction;
  Task 1 re-review and quality review then passed.
- The ACL timeout correction in
  `a9a6a6bb354851b142889c77afa9672b205dbe78` received specification and
  quality approval after the red/green, stress, isolated, and foundation
  evidence described above.
- This Task 2 specification review found omissions in the durable evidence
  record: the completed post-commit package comparison, release-decision
  fields, review dispositions, provenance, and the ACL history label were
  incomplete or missing. This follow-up documentation-only commit corrects
  those omissions. The pending re-review has not passed and is not claimed as
  complete.

The retained-public-history decision and its separate review evidence are in
[the v0.1.0 history privacy review](./SYS-A-V0.1.0-HISTORY-PRIVACY-REVIEW-2026-08-26.md).

## Proof limits and unchanged state

These results are local-only proof on one `[SYS-A]` Windows x64 host. They do
not establish cross-machine behavior, registry availability, cloud
configuration, service health, or production operation. Local logs and the
comparison artifact remain outside the repository and are not publication
evidence.

The owner-gated checks from the release manifest have the following explicit
status:

- `VERIFIED IN THIS PHASE` - The current-tree and reachable-history scan ran
  on the exact source candidate
  `a9a6a6bb354851b142889c77afa9672b205dbe78` through
  `npm run check:secrets`: 184 files scanned, 0 findings.
- `VERIFIED IN THIS PHASE` - GitHub private vulnerability reporting was
  independently checked through the GitHub API and was enabled. No token or
  sensitive API output is retained in this record.
- `UNVERIFIED / DEFERRED` - Owner review of the complete exact release diff and
  public inclusion boundary. Current reviews cover the incremental Phase 1A
  changes and artifact contents, not a renewed owner review of the whole PR
  diff.
- `UNVERIFIED / DEFERRED` - PR push, review comments, fresh remote review, and
  merge.
- `UNVERIFIED / DEFERRED` - npm publication with public access and subsequent
  registry installation of the published package.
- `UNVERIFIED / DEFERRED` - Creation of the approved `v0.1.0` Git tag and
  GitHub Release.
- `UNVERIFIED / DEFERRED` - Azure `what-if`, identity inventory, network
  exposure, RBAC, budget, and diagnostic-settings review, plus any resulting
  Azure change.
- `UNVERIFIED / DEFERRED` - Service installation, restart, configuration, or
  change to a live node.
- `UNVERIFIED / DEFERRED` - A signed live round trip, restart recovery,
  duplicate handling, revocation, and multi-node acceptance across real
  authorized machines.

The prior owner approval permits later gated operations; it is not evidence
that publication, release creation, deployment, service mutation, or live
acceptance has been completed. Each operation requires its own execution and
verification evidence.

No product source, tests, README, configuration, infrastructure, or scripts
were changed for this evidence task.
