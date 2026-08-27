# [SYS-A] v0.1.0 Final Publication Candidate - 2026-08-27

## Decision and evidence boundary

`OBSERVED / TESTED`: The final local publication candidate is source commit
`9458a50afeb28fb3f759de53f3889380af983e90` on branch
`codex/release-v0.1.0`. The checkout started clean, and the complete ordered
release ladder below passed on that exact source.

This record supersedes the package identity in the earlier
[release-candidate record](./SYS-A-V0.1.0-RELEASE-CANDIDATE-2026-08-27.md).
The former source/artifact pairs
`a9a6a6bb354851b142889c77afa9672b205dbe78` /
`78b99b42624bcd9ec36651039f9416dd1ec093449117fcc76b37225df9dbf91d` and
`7c233360496399be4b54ca70e3b2e0e0145c09b4` /
`cfdf35053b9ee142f8ca46476cee2a0b0d2d2b007f4fd8d1cd8ddd9a64594d3a`, and
`ce9fed3c05aa046e4b5bc4853c3169e929ea7fc9` /
`de7544bd582d816192635894a0da6514350ed46d166e1ace48cb3e3ea97fee7d`
remain historical evidence but are superseded and are not the publication
candidate.

This is a sanitized, durable record of source-bound commands, exit status,
counts, review outcomes, and artifact metadata. Raw session captures remain
machine-local because they contain local paths. The governing release checks
remain in the [v0.1 release manifest](../release-manifest-v0.1.md).

## Fresh Codex P2 and TDD disposition

`OBSERVED / RESOLVED`: After commit `60a9489` pinned source installation to
the future `v0.1.0` tag, a fresh Codex P2 review found that the packaged README
source-install example still did not fail closed across every Git acquisition
step. A failed clone, tag fetch, tag lookup, or checkout could otherwise allow
subsequent commands to run without the intended reviewed release.

Four test-first corrections closed the finding:

| Commit | TDD disposition |
|---|---|
| `3e5fd8cc3e80231f9c29323e368379b5a4637bb1` | Required the published `v0.1.0` tag and detached checkout before installation |
| `85b88ce935c62b5384314e8b352e12a73aeed755` | Made release-tag fetch fail closed |
| `652018c564da3d0bf5b500a6562eb01425b20656` | Made release-tag checkout fail closed |
| `7c233360496399be4b54ca70e3b2e0e0145c09b4` | Made repository clone and working-directory selection fail closed |

Each correction changed `README.md` together with its foundation documentation
contract. The final independent specification and quality reviews passed on
`7c23336`; their roles, methods, scope, results, and finding dispositions are
bound to the exact source in the
[source-install independent review record](./SYS-A-V0.1.0-SOURCE-INSTALL-INDEPENDENT-REVIEW-2026-08-27.md).
No review result is inferred from the tests alone.

A later fresh review of evidence commit `05ad76f` produced two additional P2
findings covering source-to-tag binding and the registry quickstart. A final
exact-head review of evidence commit `9da77bf` found that the source build path
also needed to fail closed. Their public links, exact dispositions, follow-up
commits, inherited SQLite concurrency diagnosis, and final independent review
provenance are in the
[final-head review record](./SYS-A-V0.1.0-FINAL-HEAD-REVIEW-2026-08-27.md).

## Fresh ordered verification on `9458a50`

Every command ran with process-scoped `BALCONY_SYSTEM_ID=SYS-A`, one test level
at a time. The recorded ladder completed in the manifest order.

| Order | Check | Observed result |
|---:|---|---|
| 1 | `npm ci` | Pass |
| 2 | `npm run test:foundation` | Pass; 16 files, 102 passed and 1 skipped out of 103 tests |
| 3 | `npm run test:component` | Pass; 16 files, 98/98 tests |
| 4 | `npm run test:integration` | Pass; 8 files, 34/34 tests |
| 5 | `npm run test:workflow` | Pass; 3 files, 4/4 tests |
| 6 | `npm run test:recovery` | Pass; 6 files, 22/22 tests |
| 7 | `npm run test:security` | Pass; 11 files, 58/58 tests |
| 8 | `npm run typecheck` | Pass; no TypeScript diagnostics |
| 9 | `npm run build` | Pass |
| 10 | `npm run smoke:mcp` | Pass; connected, 13 tools, status succeeded |
| 11 | `npm run check:secrets` | Pass; 189 current-tree and reachable-history files scanned, 0 findings |
| 12 | `npm audit --omit=dev --audit-level=low` | Pass; 0 vulnerabilities |
| 13 | `npm run verify:package` | Pass |
| 14 | `npm run verify:public-alpha` | Pass; isolated clean-consumer workflow completed |
| 15 | `git diff --check` and clean-tree check | Pass |

Test total: 318 passed and 1 explicit platform skip across 60 test files.
The integration level initially exposed a reproducible `SQLITE_BUSY` race;
after the bounded WAL-initialization fix and deterministic regression at
`ce9fed3c`, retained in `9458a50` ancestry, the focused test passed 1/1 and the
final integration run passed 34/34. The diagnosis and repetition counts are in
the final-head review record.

Additional release surfaces also passed:

- PowerShell parser: all 15 `scripts/*.ps1` and `scripts/*.psm1` files, 0
  parse errors.
- Direct Windows ACL behavior proof: `ACL_BEHAVIORAL_PROOF_PASS`.
- Topology validation: `infra/example.parameters.json`, required node
  `node-a`, 3 nodes.
- Bicep lint and build: all four entrypoints, `deploy.bicep`, `main.bicep`,
  `routing-rules.bicep`, and `subscription-budget.bicep`.
- Package allowlist: 0 forbidden entries.

Tool versions:

- Node.js `v22.14.0`
- npm `10.9.2`
- PowerShell `7.6.4`
- Azure CLI `2.77.0`
- Bicep CLI `0.46.1` (`545b338e2c`)

## Final source artifact

`OBSERVED`: `npm pack --json` at source commit
`9458a50afeb28fb3f759de53f3889380af983e90` produced:

| Property | Value |
|---|---|
| Filename | `balcony-agent-bridge-0.1.0.tgz` |
| npm SHA-1 shasum | `1e6dacbe22530d1673b15845135e171df82e24c9` |
| Independent SHA-256 | `5cde6070b07ec7b8ca40d0960ac5f40ba8d9eabbf43fa2119a4397a1ae224e09` |
| npm SHA-512 integrity | `sha512-vcbJmj+xcBoC/5lMbDVMADnPsYg4+N4TLAZ9v6N0JccWClga32e3y0wYlk+2dU2lgoYT71EJi9vwCvkPDSskcg==` |
| File count | 102 |
| Packed size | 125,975 bytes |
| Unpacked size | 638,832 bytes |
| Forbidden entries | 0 |

The tar listing contained zero `docs/verification/**` entries. The preserved
tarball produced from `9458a50` is the only artifact authorized as the future
npm publication input. Evidence-only commits follow this source and do not
enter the npm package. Their post-commit repack must remain identical,
but a post-merge package comparison against every field above is still required
before tagging or publishing.

## Prior evidence and accepted limitations

- The earlier freeze history, ACL timeout disposition, packaged-doctor
  transient, release decisions, and owner-gated checks remain in the
  [prior release-candidate record](./SYS-A-V0.1.0-RELEASE-CANDIDATE-2026-08-27.md).
- Independent evidence-review provenance remains in the
  [Task 2 independent review record](./SYS-A-V0.1.0-TASK2-INDEPENDENT-REVIEW-2026-08-27.md).
- Final-head review provenance and the `SQLITE_BUSY` disposition remain in the
  [final-head review record](./SYS-A-V0.1.0-FINAL-HEAD-REVIEW-2026-08-27.md).
- The retained-public-history decision remains in the
  [history privacy review](./SYS-A-V0.1.0-HISTORY-PRIVACY-REVIEW-2026-08-26.md).
- The complete [known limitations](../known-limitations.md) at `9458a50`
  remain accepted and canonical. This record does not imply that any accepted
  limitation was fixed except where an exact disposition is recorded above.

## Deferred operations

At the time of this record, the candidate has not been pushed or merged, the
npm package has not been published or installed from the registry, and the
`v0.1.0` tag and GitHub Release have not been created. The future `v0.1.0` tag
target **will be exactly `9458a50afeb28fb3f759de53f3889380af983e90`**, even
if the PR merge tip contains later package-excluded evidence commits, and npm
publication must use the preserved `9458a50` tarball above. Azure, RBAC,
service, and live signed multi-node rollout remain separate and deferred.
Approval remains distinct from completion, and each external operation
requires separate execution evidence.
