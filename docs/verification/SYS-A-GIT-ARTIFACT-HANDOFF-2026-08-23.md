# [SYS-A] Git Artifact Handoff Protocol v1 Verification

Date: 2026-08-23
Protocol: `balcony-git-artifact-handoff.v1`

## Outcome

The bridge repository now has one deterministic, non-littering layout for
reviewed skill bundles exchanged between SYS-A and SYS-B:

```text
transfers/releases/YYYY/MM/YYYY-MM-DD--sys-a-to-sys-b--codex-skills--rNN/
  release.json
  payload.zip
```

Publish mode derives the directory, release ID, and filenames. Validate and
Install modes reject a release whose date, direction, artifact family,
sequence, manifest location, or archive filename does not match this layout.

## First Release

- Release ID: `2026-08-23--sys-a-to-sys-b--codex-skills--r01`
- Direction: SYS-A to SYS-B
- Archive SHA-256:
  `7E5C313D66BBB8DBFF03D88E48C18BDB21CB541949D44102A0143BDC0DE3D790`
- Archive size: 120586 bytes
- Payload: 18 Codex skills, 8 Agents mirrors, 59 hashed payload files
- Collision policy: `accept-identical-or-fail`

## Verification

- Canonical `r01` release validation: passed locally.
- Generated `r99` publish probe: produced only `release.json` and
  `payload.zip` in the derived canonical directory; the probe was then moved
  out of the repository to recoverable temporary storage.
- Foundation: 12 files, 57 tests passed.
- TypeScript typecheck: passed.
- Staged diff check: passed.
- Detached-worktree validation pinned to the full release commit: passed with
  `git_pin_verified: true`.
- Wrong-machine installation gate: SYS-A identity was rejected for the SYS-B
  target before any destination mutation.

A successful target installation remains a SYS-B acceptance check. No SYS-B
installation is claimed by this note.
