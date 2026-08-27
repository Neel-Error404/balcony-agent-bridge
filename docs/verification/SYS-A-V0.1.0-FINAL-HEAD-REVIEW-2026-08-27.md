# [SYS-A] v0.1.0 Final-Head Review - 2026-08-27

## Scope and revisions

`OBSERVED`: A fresh Codex review began from evidence commit
`05ad76fef8cda33846a06b1787618216700fdb8d`, and a final exact-head Codex
review ran on evidence commit `9da77bf33b2540fab8a7909f1cad237a4d3533c4`.
The final reviewed, tested, and packaged source is
`9458a50afeb28fb3f759de53f3889380af983e90`. This is a sanitized durable
record; it contains no private session metadata.

## Review findings and dispositions

| Finding | Disposition |
|---|---|
| [Bind the release evidence to the reviewed commit](https://github.com/Neel-Error404/balcony-agent-bridge/pull/6#discussion_r3868675593) | **Resolved.** The final ladder and package freeze were repeated on the final source. The `v0.1.0` tag target **will be exactly `9458a50afeb28fb3f759de53f3889380af983e90`**, even if the PR merge tip also contains later package-excluded evidence commits. |
| [Stop the registry quickstart after failed npm commands](https://github.com/Neel-Error404/balcony-agent-bridge/pull/6#discussion_r3868675595) | **Resolved.** Commit `a2cb6891ffb3be92af7a409345193bfcaf6185a2` made registry lookup and installation fail closed. Intermediate commit `4d36822ce95c671240ed074b8be2c94d407a6b83` verified the installed 0.1.0 manifest and entrypoint. Commit `dc304657c48e5bffb6c474eb28120ca6ad3e5f85` completed exact Node/CLI path resolution, explicit process-result checks, and exact-path use in the quickstart commands, eliminating stale global PATH fallback. |
| [Fail closed when source setup or compilation fails](https://github.com/Neel-Error404/balcony-agent-bridge/pull/6#discussion_r3869041503) | **Resolved.** Commit `9458a50afeb28fb3f759de53f3889380af983e90` stops after failed `npm ci` or `npm run build`, requires the built CLI entrypoint to resolve, and checks the exact CLI process result so a missing build cannot collapse into a misleading `node --help` success. |

Each README correction changed its foundation documentation contract in the
same commit.

## Integration failure, diagnosis, and fix

`OBSERVED-IN-THIS-PHASE`: The final ladder initially exposed `SQLITE_BUSY` at
the SQLite WAL pragma. The diagnosis separated incidental scheduling from a
controlled simultaneous-open race:

- Ordinary focused loop: 38/40 passed; 2/40 reproduced the exact
  `SQLITE_BUSY` failure (5.0%).
- Pre-WAL full-constructor control: 50/50 passed.
- Barrier-synchronized pragma-only pre-fix harness: 84/100 rounds failed.
- Real-constructor barrier, two children: 7/10 rounds failed.
- Real-constructor barrier, eight children: 5/5 rounds failed, affecting 25/40
  child processes.
- Bounded-retry low-level harness: 50/50 passed; 36 child processes retried,
  with at most one retry each.

Commit `ce9fed3c05aa046e4b5bc4853c3169e929ea7fc9`, retained in the final source
ancestry, sets the busy timeout before WAL initialization, retries only
`SQLITE_BUSY` within the five-second bound, validates the returned journal
mode, and adds an eight-process synchronized regression. The initial barrier
regression passed 10/10; the simplified final committed implementation passed
5/5. The focused test then passed 1/1 and the full integration level passed
34/34. These counts are the sanitized observed results; this record does not
claim that transient raw diagnostic output is retained in the repository.

## Independent final reviews on `9458a50`

| Review | Role and method | Result |
|---|---|---|
| Specification | An independent specification reviewer compared all public P2 findings, their exact commit dispositions, the inherited SQLite failure disposition, and the requested tag/package boundary with the final source diff and verification results. | **PASS**; no remaining actionable specification finding was reported for the local Phase 1 candidate. |
| Quality | An independent quality reviewer inspected the fail-closed registry and source PowerShell flows, exact CLI resolution, bounded WAL retry, deterministic concurrency regression, and evidence/source separation. | **PASS**; no remaining actionable correctness or maintainability finding was reported for the local Phase 1 candidate. |

These reviews were independent, narrow source-and-evidence reviews. Package
construction and refreeze were separate release-evidence work and are recorded
in the
[final publication-candidate evidence](./SYS-A-V0.1.0-FINAL-PUBLICATION-CANDIDATE-2026-08-27.md),
not attributed to either reviewer.

## Release and rollout boundary

The npm publication input must be the preserved tarball produced from
`9458a50`, verified against the hashes and sizes in the final candidate
record. A post-merge package comparison against all recorded fields remains
required before tagging or publishing. Publication, tag creation, GitHub
Release creation, registry installation, Azure changes, service changes, and
live multi-node rollout remain separate and deferred.
