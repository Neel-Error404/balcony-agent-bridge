# ADR 0008: Pinned Git Evidence And Consultation Operations

## Status

Phase 3 is implemented and locally verified in a detached SYS-B candidate
worktree. It is not deployed, installed, or wired into an automatic startup
path.

## Decision

Add `PinnedGitEvidenceProvider` as a parent-side evidence adapter. A caller
must provide a full Git commit object ID. The provider requires that revision
to equal the repository's exact `HEAD`.

The provider:

- requires the allowlisted project root to equal the Git repository root;
- rejects a dirty worktree by default;
- verifies each path is a tracked regular blob at the pinned revision;
- reads bytes from the Git object database rather than the working tree;
- preserves the exact commit and blob object IDs;
- requires an independently hashed Git executable and never falls back to a
  PATH-resolved command;
- applies the existing extension, size, UTF-8, binary, and secret controls;
- returns branch, worktree state, and commit time without returning a local
  repository path; and
- invokes Git directly with `shell: false` and bounded output.

An operator may explicitly allow a dirty worktree for diagnostic use. The
bundle then reports `dirty`, but file content still comes from the committed
blob. Mutable or untracked working-tree bytes are never promoted as pinned Git
evidence.

## Status Surface

Bridge status includes bounded consultation counts for:

- `pending_child`;
- `needs_information`;
- `waiting_peer`;
- `completed`; and
- `failed`.

It may also include the consultation coordinator heartbeat timestamp, runtime
state, heartbeat age, last process-reported state, sanitized last error code,
and aggregate evidence item/byte counts. Heartbeat age converts an old
otherwise-healthy report to `stale`. Status never includes evidence content,
local paths, child output, Git remotes, message bodies, or credentials.

The coordinator persists the evidence paths cited by a completed child and
returns only structured provenance references. Pinned files produce repository
path and commit references; evidence received from a nested peer produces a
bridge-message reference. Uncited bundle items are not promoted.

## Consequences

Pinned Git evidence can prove which committed bytes supported a child turn,
independently of later worktree changes. It does not prove that the commit is
owner-approved; release approval remains an external gate.

The Phase 4 candidate extends the existing foreground dispatcher entrypoint
with an explicit `legacy` or `consultation` mode. Exactly one mode is
instantiated per process. Consultation mode requires registry schema `1.2`, a
neutral working directory, and independently hashed Codex and Git
executables.

Source-revision deployment, live cross-system acceptance, and any startup
mechanism remain separate owner-approved actions.

Automatic startup remains disabled.
