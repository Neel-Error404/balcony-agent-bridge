# Git-Pinned Artifact Handoff Protocol v1

Protocol name: `balcony-git-artifact-handoff.v1`

## Purpose

Move reviewed skill archives between `[SYS-A]` and `[SYS-B]` without copying
file contents through Azure Service Bus or chat. Git transports immutable
bytes. The Balcony Agent Bridge transports only the release pointer, expected
commit, manifest path, archive SHA-256, status, and acknowledgement.

## Security Boundary

- Use only the private `Neel-Error404/balcony-agent-bridge` remote.
- Never include credentials, authentication state, plugin caches, databases,
  browser state, private keys, tokens, `.env` files, or generated caches.
- A receiver installs only from a clean checkout whose exact `HEAD` equals the
  commit named in the bridge message.
- Archive paths, file hashes, declared skill names, target system, and existing
  destinations are checked before mutation.
- Existing identical skill directories are idempotently accepted. Any
  different existing directory fails closed; nothing is overwritten.
- The envelope records this as collision policy `accept-identical-or-fail`.
- Git publication and receiver installation remain separately owner-approved
  operations. A bridge message is coordination evidence, not authorization by
  itself.

## Release Layout

```text
transfers/releases/YYYY/MM/YYYY-MM-DD--sys-a-to-sys-b--codex-skills--rNN/
  release.json
  payload.zip
```

The directory name is the release ID. Its fields are:

- `YYYY-MM-DD`: UTC release date;
- `sys-a-to-sys-b`: lowercase transfer direction, reversed for return traffic;
- `codex-skills`: controlled artifact-family name;
- `rNN`: two-digit sequence for another release with the same date, direction,
  and artifact family, beginning at `r01`.

The hierarchy is fixed: `transfers/releases/<year>/<month>/<release-id>/`.
Do not put release files directly in `transfers/`, invent another release root,
repeat the descriptive release ID in filenames, or add temporary files beside
the two canonical files. Fixed filenames keep automation simple and the dated
directory keeps each package isolated.

`release.json` follows
`docs/contracts/artifact-release.v1.schema.json`. The ZIP must contain one
payload root with `codex/`, `agents/`, `README.md`, `MANIFEST.md`, and
`SHA256SUMS.txt`. `SHA256SUMS.txt` covers every payload file outside the three
metadata files.

## Sender

From a clean bridge checkout, create the release directory:

```powershell
$env:BALCONY_SYSTEM_ID = "SYS-A" # use SYS-B for the reverse direction
& scripts/Invoke-GitSkillArtifact.ps1 `
  -Mode Publish `
  -ArchivePath D:/path/to/reviewed-skills.zip `
  -ReleaseDateUtc 2026-08-23 `
  -ReleaseSequence 1 `
  -OriginSystem SYS-A `
  -TargetSystem SYS-B `
  -DeclaredNameException "codex/onboard-new-user=setup-codex"
```

Publish mode derives the release ID, directory, and both filenames. It refuses
to publish into a non-empty canonical directory. Operators do not supply an
output directory or destination filename.

Review the exact diff. After explicit Git approval, stage only the release,
contract, command, runbook, and related tests; commit with the machine tag and
push. Send a bridge message containing:

```json
{
  "protocol": "balcony-git-artifact-handoff.v1",
  "repository": "Neel-Error404/balcony-agent-bridge",
  "commit": "<full-40-character-commit>",
  "release_manifest": "transfers/releases/YYYY/MM/<release-id>/release.json",
  "archive_sha256": "<64-character-SHA-256>",
  "requested_action": "validate-and-install"
}
```

## Receiver

Fetch without merging unrelated work, create a detached clean worktree at the
exact commit, then validate before installing:

```powershell
$env:BALCONY_SYSTEM_ID = "SYS-B"
git fetch origin <full-commit>
git worktree add --detach E:/temp/balcony-artifact-<release-id> <full-commit>

& E:/temp/balcony-artifact-<release-id>/scripts/Invoke-GitSkillArtifact.ps1 `
  -Mode Validate `
  -ReleaseManifestPath E:/temp/balcony-artifact-<release-id>/transfers/releases/YYYY/MM/<release-id>/release.json `
  -SystemId SYS-B `
  -ExpectedCommit <full-commit>

& E:/temp/balcony-artifact-<release-id>/scripts/Invoke-GitSkillArtifact.ps1 `
  -Mode Install `
  -ReleaseManifestPath E:/temp/balcony-artifact-<release-id>/transfers/releases/YYYY/MM/<release-id>/release.json `
  -SystemId SYS-B `
  -ExpectedCommit <full-commit>
```

The receiver returns structured JSON. Send the release ID, commit, archive
hash, installed/already-present names, failures, and post-install capability
inventory through the bridge acknowledgement. The reverse SYS-B-to-SYS-A
flow uses the same command and contract with system IDs reversed.

## Stop Conditions

Stop without installing when any hash, path, count, system identity, Git pin,
release date, release ID, canonical directory, fixed filename, or destination
differs. Do not repair an archive in transit, infer a missing source, overwrite
a local skill, or fall back to a non-Git copy path.
