# Recovery Runbook

Use this runbook only for a node you are authorized to operate. Service stops,
restores, dead-letter actions, and live Azure inspection are explicit operator
changes; local verification does not authorize them.

## Before Maintenance

1. Stop the bridge, close the MCP client, and stop the optional dispatcher so
   no process can write the shared SQLite database.
2. Confirm the processes are stopped. Do not take a filesystem copy while any
   writer remains active.
3. Preserve the database, profile, membership policy, rendered service
   configuration, and current reviewed runtime in an access-controlled local
   backup. Include `-wal` or `-shm` companions if they still exist.
4. Record the runtime revision, schema version, node ID, and reason for the
   operation. Never put the backup in Git, npm, Obsidian, or another node.
5. Start the existing runtime again unless the approved maintenance window is
   proceeding immediately.

## Outbox

An outbox item is never removed while pending or leased. If the bridge exits,
its lease expires and a replacement worker retries the same message ID.

An uncertain send is retried with the same message ID. Azure duplicate
detection and the remote inbox primary key make an identical duplicate safe.

## Inbox

The bridge commits an inbox row before completing the Azure delivery. If broker
completion is uncertain, the message may be redelivered and is deduplicated
locally.

Invalid envelopes, routing mismatches, session mismatches, and message identity
collisions are dead-lettered with bounded reasons. Database failures are
abandoned for redelivery rather than dead-lettered.

## Consumer Claims

Claims require an opaque token stored locally only as a hash. Expired claims
return to the available state. Stale owners cannot renew or settle reclaimed
work.

## Operator Rules

- Do not delete pending, leased, available, or claimed rows.
- Do not replay the dead-letter queue automatically.
- Preserve message IDs during every retry.
- Record root cause before manually requeueing quarantined work.
- Never copy a machine database to the other system.

## Transport Outage

Leave the MCP server available if local queuing is desired and the database is
healthy. Stop or restart only the bridge worker. Pending outbox rows remain
durable and retry after lease expiry. When Azure is restored, run `doctor
--check-transport`, start the bridge, and confirm counts move without changing
message IDs.

## Database Or Schema Failure

1. Stop every SQLite writer and preserve the failed database before attempting
   repair.
2. Run `doctor` against the exact node profile and record its bounded code.
3. If the database is missing, verify the profile path and filesystem ACLs; do
   not create a replacement over an unknown path.
4. If integrity or schema fails, test recovery on a copy with the matching
   reviewed runtime. Do not edit bridge tables manually.
5. Restore a backup only to the same node and only while all writers are
   stopped. Preserve the failed copy until the incident is closed.
6. Rerun `doctor`, then start MCP/dispatcher/bridge one process at a time and
   confirm status before continuing.

## Dead-Letter And Authentication Failure

Do not replay the dead-letter queue automatically. First classify the bounded
reason, verify routing and membership locally, and follow
`docs/message-authentication.md` if a key or node may be compromised. Requeue
only a reviewed message that is still authorized and unexpired, retaining its
original message ID. Broker bodies and deployment identifiers stay in the
owner-controlled incident channel, never a public issue.
