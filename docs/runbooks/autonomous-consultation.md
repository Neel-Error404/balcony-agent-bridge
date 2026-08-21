# Autonomous Consultation Runbook

## Current Boundary

The candidate contains the evidence provider, durable coordinator, status
fields, recovery controls, an explicit consultation mode, a pinned two-file
Codex bundle contract, and a reversible existing-service upgrade script. It
has no approved production release.

Do not install it, replace the running bridge, edit the machine allowlist,
create a service or scheduled task, or change Azure configuration. Source
verification does not authorize `Update-DispatcherService.ps1`, a service
restart, MCP reconfiguration, or automatic startup.

## Pinned Git Preconditions

Before collecting Git evidence:

1. Resolve the approved allowlisted project key locally.
2. Obtain the expected full commit object ID through the release gate.
3. Confirm the supplied full commit exactly matches repository `HEAD`.
4. Keep the repository clean unless the owner explicitly approves a
   dirty-worktree diagnostic.
5. Request only canonical relative paths to tracked text files.
6. Configure an absolute Git executable and its approved SHA-256. The
   provider has no PATH-based Git fallback.

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
consultationEvidence.runsWithEvidence
consultationEvidence.items
consultationEvidence.totalBytes
consultationCoordinatorHeartbeatAtUtc
consultationCoordinatorHeartbeatAgeSeconds
consultationCoordinatorRuntimeStatus
consultationCoordinatorReportedStatus
lastConsultationCoordinatorErrorCode
```

Runtime status is derived from heartbeat age. Bridge heartbeats become stale
after 30 minutes; dispatcher and consultation-coordinator heartbeats become
stale after 10 minutes. `*ReportedStatus` retains the last process report,
while `*RuntimeStatus` is the effective current classification. The heartbeat
still does not prove peer delivery, child completion, result return, or
deployment.

On completion, only evidence paths cited by the evidence-only child are
promoted into the result envelope. Pinned files return `repository_path` and
`git_commit` references; peer evidence returns the exact `bridge_message`
identifier. Evidence content remains local and is never copied into status.

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

Before consultation acceptance, set process-local configuration for
consultation mode, a neutral working directory, independently hashed Git, and
the complete sibling Codex bundle: `codex.exe` plus
`codex-code-mode-host.exe`. Use registry schema `1.2`; each enabled project
must bind `pinned_git` to one full approved revision.

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
without that marker remain on the legacy claim route; the two claimers must
not compete for one inbox row. Selecting consultation mode on the receiving
service and including the request marker are separate required gates.

## MCP Admission And Reload

The interactive Codex MCP process creates the envelope; the Windows bridge
service only transports it. Confirm the machine-local MCP registration points
to the exact approved release whose `agent_bridge_ask_agent` input schema
contains optional `evidence_mode: pinned_git`. After changing the MCP release
path, restart the Codex application or task so the stdio server and its tool
definition are reloaded. Existing MCP child processes do not hot-reload source
or compiled output.

Before a live nested test:

1. Inspect the loaded MCP tool schema and confirm `evidence_mode` is present.
2. Send a new request with `evidence_mode=pinned_git`; do not reuse a legacy
   request or dead-lettered message.
3. Confirm the destination inbox persisted that marker and the consultation
   coordinator, rather than `ReadOnlyDispatcher`, claimed the row.
4. Confirm a durable consultation run exists before expecting a nested peer
   request.

Do not infer consultation from a successful Codex answer. A legacy child can
exit successfully with explanatory text while creating no consultation run.

For an already installed service, the later approved operator procedure is:
run `scripts/Update-DispatcherService.ps1 -WhatIf`, review its exact paths and
hashes, run the upgrade with `-DispatcherMode consultation`, verify the
service-owned child and consultation heartbeat, then reload the MCP client.
The script must receive the approved `codex.exe` and sibling
`codex-code-mode-host.exe`; it does not discover or trust a user-profile copy.
The preflight validates the currently registered bridge checkout and computes
the desired release pin without mutating the registry. The real transaction
backs up the registry, service XML, installed Codex bundle, and affected ACL
descriptors before stopping the dispatcher. It waits for `Stopped`, service
PID zero, and the former wrapper and child processes to exit before mutation.
Startup is bounded to three attempts and requires `Running` plus exactly one
service-owned Node child. A failure reports only the stage, exception type,
HRESULT/native code, and bounded service state; exception messages are not
included because they may contain machine-local paths. Rollback restores and
verifies the original bytes, ACLs, startup mode, running/stopped selection, and
one-child state. The rollback directory remains in the dispatcher install root
until local acceptance and a SYS-A-triggered nested acceptance both pass.

The updater deliberately does not inspect the bridge service or Azure queues.
The operator must snapshot the bridge PID and queue/DLQ/transfer-DLQ counts
before `-WhatIf`, after the real transaction, and after acceptance. Any bridge
PID change or queue-baseline drift blocks acceptance. Do not delete the
previous registered worktree until the new runtime is accepted and no service
XML or project-registry entry references it.

Broker send acknowledgement alone is insufficient. Record canonical inbox,
coordinator state, child result, outbox, peer inbox, and caller-visible result
as separate evidence boundaries.
