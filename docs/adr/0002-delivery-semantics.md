# ADR 0002: At-Least-Once Delivery

## Status

Accepted for initial implementation.

## Decision

Use durable outbox and inbox records, stable message identifiers, broker
PeekLock delivery, and idempotent state transitions.

## Consequences

Duplicates can occur after uncertain sends or crashes. Identical duplicates are
safe. A repeated message identifier with different content is quarantined as
an identity collision. Agent-side effects must be idempotent.
