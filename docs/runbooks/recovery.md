# Recovery Runbook

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
