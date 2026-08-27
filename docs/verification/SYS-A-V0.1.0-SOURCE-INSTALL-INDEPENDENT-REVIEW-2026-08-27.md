# [SYS-A] v0.1.0 Source-Install Independent Review - 2026-08-27

## Scope and bound revisions

`OBSERVED`: This sanitized record supplies durable provenance for the final
source-install reviews asserted by the
[final publication-candidate evidence](./SYS-A-V0.1.0-FINAL-PUBLICATION-CANDIDATE-2026-08-27.md).
The reviewed source is
`7c233360496399be4b54ca70e3b2e0e0145c09b4`; the evidence revision whose
review claim required this record is
`a6af4c0ef01307e82fd82e6ae5669ed32d2c364d`. No private session metadata,
credentials, or machine-local paths are retained here.

## P2 and test-first disposition

The fresh Codex P2 is public at
[PR 6 discussion 3868466895](https://github.com/Neel-Error404/balcony-agent-bridge/pull/6#discussion_r3868466895).
It found that the production source-install path could build the advancing
default branch instead of the reviewed `v0.1.0` release, potentially mixing an
unreviewed service runtime with the 0.1.0 CLI and violating the exact-candidate
gate.

Each disposition changed `README.md` and its foundation documentation
contract together:

| Commit | Finding disposition |
|---|---|
| `60a948909808b9896a28108315789e759dad092e` | Added an explicit `v0.1.0` checkout, resolving the original unpinned-source finding but leaving failure handling to be hardened. |
| `3e5fd8cc3e80231f9c29323e368379b5a4637bb1` | Required the release tag to exist and selected it detached, preventing branch advancement from changing the reviewed source. |
| `85b88ce935c62b5384314e8b352e12a73aeed755` | Made a failed tag fetch stop source installation with an actionable error. |
| `652018c564da3d0bf5b500a6562eb01425b20656` | Made a failed detached checkout stop source installation with an actionable error. |
| `7c233360496399be4b54ca70e3b2e0e0145c09b4` | Made clone failure stop the flow and made repository-directory selection terminating. |

## Independent final reviews on `7c23336`

| Review | Role and method | Result |
|---|---|---|
| Specification | An independent specification reviewer compared the public P2 and exact-candidate requirement with the five-commit README/test sequence and the final source-install command ordering. | **PASS**; the source path selects the reviewed `v0.1.0` tag before dependency installation, and no actionable specification finding remained in this narrow scope. |
| Quality | An independent quality reviewer inspected the final PowerShell flow and its foundation contract for deterministic tag selection, fail-closed Git steps, actionable errors, and scope hygiene. | **PASS**; no actionable correctness or maintainability finding remained in this narrow scope. |

These were narrow, read-only source-install reviews. They did not rerun or
opine on the full ordered release ladder, infrastructure checks, package
construction, or artifact refreeze. Those independently executed checks and
the frozen package identity are recorded in the
[final publication-candidate evidence](./SYS-A-V0.1.0-FINAL-PUBLICATION-CANDIDATE-2026-08-27.md).
They also do not establish publication, tag creation, registry installation,
deployment, or live operation.
