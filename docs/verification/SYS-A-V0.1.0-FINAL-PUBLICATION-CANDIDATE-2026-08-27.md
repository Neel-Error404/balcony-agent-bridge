# [SYS-A] v0.1.0 Final Publication Candidate - 2026-08-27

## Decision and evidence boundary

`OBSERVED / TESTED`: The final local publication candidate is source commit
`7c233360496399be4b54ca70e3b2e0e0145c09b4` on branch
`codex/release-v0.1.0`. The checkout started clean, and the complete ordered
release ladder below passed on that exact source.

This record supersedes the package identity in the earlier
[release-candidate record](./SYS-A-V0.1.0-RELEASE-CANDIDATE-2026-08-27.md).
The former source `a9a6a6bb354851b142889c77afa9672b205dbe78` and artifact
SHA-256 `78b99b42624bcd9ec36651039f9416dd1ec093449117fcc76b37225df9dbf91d`
remain historical evidence but are not the final publication candidate.

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

## Fresh ordered verification on `7c23336`

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
| 11 | `npm run check:secrets` | Pass; 186 current-tree and reachable-history files scanned, 0 findings |
| 12 | `npm audit --omit=dev --audit-level=low` | Pass; 0 vulnerabilities |
| 13 | `npm run verify:package` | Pass |
| 14 | `npm run verify:public-alpha` | Pass; isolated clean-consumer workflow completed |
| 15 | `git diff --check` and clean-tree check | Pass |

Test total: 318 passed and 1 explicit platform skip across 60 test files.

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
`7c233360496399be4b54ca70e3b2e0e0145c09b4` produced:

| Property | Value |
|---|---|
| Filename | `balcony-agent-bridge-0.1.0.tgz` |
| npm SHA-1 shasum | `b98f88b09d56beac2aa04c5ca55d7f9bcad369bc` |
| Independent SHA-256 | `cfdf35053b9ee142f8ca46476cee2a0b0d2d2b007f4fd8d1cd8ddd9a64594d3a` |
| npm SHA-512 integrity | `sha512-v7TpzN8eJvYjZzFn+T4em37yaowb0hQWZ5rrBGd/UF/J88rh5TqvI8majld670ZXRFA2p9YAwOszKKZXeiPQxg==` |
| File count | 102 |
| Packed size | 124,691 bytes |
| Unpacked size | 633,206 bytes |
| Forbidden entries | 0 |

The tar listing contained zero `docs/verification/**` entries. A post-evidence
repack from evidence commit `a6af4c0ef01307e82fd82e6ae5669ed32d2c364d`
reproduced all seven artifact fields above, with zero forbidden entries and
zero `docs/verification/**` entries. That refreeze was release-evidence work,
not part of the narrow source-install reviews.

## Prior evidence and accepted limitations

- The earlier freeze history, ACL timeout disposition, packaged-doctor
  transient, release decisions, and owner-gated checks remain in the
  [prior release-candidate record](./SYS-A-V0.1.0-RELEASE-CANDIDATE-2026-08-27.md).
- Independent evidence-review provenance remains in the
  [Task 2 independent review record](./SYS-A-V0.1.0-TASK2-INDEPENDENT-REVIEW-2026-08-27.md).
- The retained-public-history decision remains in the
  [history privacy review](./SYS-A-V0.1.0-HISTORY-PRIVACY-REVIEW-2026-08-26.md).
- The complete [known limitations](../known-limitations.md) at `7c23336`
  remain accepted and canonical. This record does not imply that any accepted
  limitation was fixed by the README corrections.

## Deferred operations

At the time of this record, the candidate has not been pushed or merged, the
npm package has not been published or installed from the registry, and the
`v0.1.0` tag and GitHub Release have not been created. Azure, RBAC, service,
and live signed multi-node rollout state are unchanged. Approval remains
distinct from completion, and each external operation requires separate
execution evidence.
