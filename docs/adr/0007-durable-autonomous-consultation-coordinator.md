# ADR 0007: Durable Autonomous Consultation Coordinator

## Status

Phase 2 is implemented and locally verified in a detached SYS-B candidate
worktree. It is not wired into the foreground dispatcher entrypoint, installed,
or deployed.

## Decision

Use a durable parent coordinator for evidence-only child turns. The coordinator
uses the existing envelope schema and coordination protocol version `1.0`.
Nested consultation metadata is an optional payload context; transport,
conversation, correlation, causation, and idempotency remain envelope-owned.

Each parent request has one version-fenced SQLite run in
`consultation_runs`. The run freezes:

- parent, root, conversation, and project identity;
- current state and round count;
- depth, maximum depth, and ancestry fingerprints;
- maximum rounds and the overall deadline;
- hash-bound local and peer evidence;
- pending local paths or peer request;
- nested task identity; and
- terminal answer or safe error code.

The coordinator performs one durable transition per inbox claim:

1. `pending_child` executes one evidence-only child turn.
2. `needs_information` collects only explicit approved local paths.
3. `waiting_peer` idempotently creates or waits for one correlated peer task.
4. New evidence returns the run to `pending_child`.
5. `completed` or `failed` settles the parent with one deterministic result.

Nonterminal transitions return the parent inbox message to `available`. This
avoids holding a broker-independent local claim while waiting for evidence or
a peer. Optimistic run versions fence stale coordinator writers.

Pinned consultation requests declare `dispatch.evidence_mode=pinned_git`.
Legacy and consultation claim queries are mutually exclusive, so a current
legacy dispatcher cannot consume evidence-only work. Expired consultation
requests remain claimable only by the consultation coordinator so it can
publish their deterministic timeout result.

## Nested Requests

A nested request:

- uses a separate conversation;
- sets `correlation_id` to the root request;
- sets `causation_id` to the immediate parent request;
- retains protocol `1.0` and read-only access;
- increments depth;
- appends a canonical request fingerprint; and
- uses a deterministic parent-and-round idempotency key.

If a crash occurs after the nested outbox insert but before its task ID is
stored in the run, replay returns the authoritative existing outbox message.
It does not create another peer request.

Completed peer results become `peer_result` evidence with a source message ID,
content hash, byte length, and source timestamp. They do not become trusted
instructions.

## Safety Controls

The coordinator fails closed on:

- overall timeout;
- round exhaustion;
- depth exhaustion;
- a repeated ancestry fingerprint;
- invalid or unavailable evidence;
- invalid peer results; and
- stale SQLite run versions.

The claim lease must be at least 720 seconds. A child turn remains capped at
600 seconds, leaving termination margin before settlement.

The foreground process supplies a live clock after child and Git work. An
expired claimant therefore cannot settle using its cycle-start timestamp.
Synchronous Git commands have a ten-second process timeout.

Peer waits persist `next_attempt_at_utc`. The claim query skips the parent
until that timestamp, avoiding continuous claim/retry churn while preserving
restart-safe polling.

Persisted limits remain authoritative after restart. A changed process policy
cannot expand or invalidate an already-started run.

## Current Boundary

The Phase 4 candidate selects consultation mode inside the existing foreground
dispatcher process, so the legacy dispatcher and coordinator cannot claim the
same request concurrently. Evidence-only turns use a neutral directory,
receive evidence through standard input, ignore user configuration, and
disable the native `shell_tool`, `unified_exec`, and `view_image` features.
The read-only sandbox remains in force as a second write-prevention boundary.

These controls remove the model-call tools that can read arbitrary local
paths. They do not claim that the native process itself lacks access to its
dedicated authentication home or operating-system libraries.

No automatic startup, service, scheduler, allowlist, Azure, identity, or
networking change is authorized by this ADR.
