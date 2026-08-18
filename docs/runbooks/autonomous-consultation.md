# Autonomous Consultation Runbook

## Current Boundary

The candidate contains the evidence provider, durable coordinator, status
fields, recovery controls, and an explicit consultation mode in the foreground
dispatcher entrypoint. It has no approved production release.

Do not install it, replace the running bridge, edit the machine allowlist,
create a service or scheduled task, or change Azure configuration. The
consultation coordinator is foreground-only for the later acceptance phase,
and automatic startup remains disabled.

## Pinned Git Preconditions

Before collecting Git evidence:

1. Resolve the approved allowlisted project key locally.
2. Obtain the expected full commit object ID through the release gate.
3. Confirm the supplied full commit exactly matches repository `HEAD`.
4. Keep the repository clean unless the owner explicitly approves a
   dirty-worktree diagnostic.
5. Request only canonical relative paths to tracked text files.

`PinnedGitEvidenceProvider` reads each committed blob from the Git object
database. It does not read mutable working-tree content. Each item records the
commit, blob object ID, SHA-256 content digest, byte length, and commit time.
Each Git command is bounded to ten seconds.

A dirty diagnostic is evidence about the pinned commit only. It is not
evidence that dirty or untracked files were inspected, tested, approved, or
deployed.

## Status

Use the existing local bridge status surface. The candidate adds:

```text
consultation.pending_child
consultation.needs_information
consultation.waiting_peer
consultation.completed
consultation.failed
consultationCoordinatorHeartbeatAtUtc
consultationCoordinatorRuntimeStatus
lastConsultationCoordinatorErrorCode
```

The heartbeat proves only that the coordinator recorded local liveness. It
does not prove peer delivery, child completion, result return, or deployment.

Interpret nonterminal states as follows:

- `pending_child`: the next bounded child turn can run.
- `needs_information`: approved local evidence paths are parked durably.
- `waiting_peer`: a deterministic nested request is queued or awaiting its
  correlated result. Its durable next-at timestamp prevents claim churn.

## Restart Recovery

After an approved foreground-process interruption:

1. Confirm the canonical bridge service still owns the single bridge-worker
   lock.
2. Confirm the same candidate source revision and machine-local database are
   selected.
3. Inspect consultation counts and the sanitized last error code.
4. Start only the approved foreground coordinator integration.
5. Verify the heartbeat becomes current.
6. Confirm the parked run advances by one durable transition.
7. For `waiting_peer`, confirm replay reuses the same nested task ID.
8. Confirm terminal settlement creates one deterministic parent result.

Do not edit SQLite, delete a run, rewrite its version, settle inbox work
manually, or resend a nested request with a new idempotency key.

## Foreground Acceptance Gate

Before foreground consultation acceptance, set process-local configuration
for consultation mode, a neutral working directory, and independently hashed
Codex and Git executables. Use registry schema `1.2`; each enabled project must
bind `pinned_git` to one full approved revision.

Evidence-only Codex turns must retain all of these controls:

```text
--ignore-user-config
--sandbox read-only
--skip-git-repo-check
--disable shell_tool
--disable unified_exec
--disable view_image
```

Acceptance requires:

1. Exact approved source revision and clean checkout.
2. One allowlisted project only.
3. A dedicated authenticated Codex home and verified native executable.
4. Pinned Git evidence from the exact revision.
5. Local evidence parking and restart-safe resume.
6. One correlated nested peer request and result.
7. Duplicate, timeout, round, depth, cycle, and stale-writer controls.
8. Repository non-mutation before and after execution.
9. Secret-safe stdout, stderr, status, and returned result.
10. Confirmation that automatic startup remains disabled.

New consultation requests must declare `evidence_mode=pinned_git`. Requests
without that marker remain on the legacy path; the two claimers must not
compete for one inbox row.

Broker send acknowledgement alone is insufficient. Record canonical inbox,
coordinator state, child result, outbox, peer inbox, and caller-visible result
as separate evidence boundaries.
