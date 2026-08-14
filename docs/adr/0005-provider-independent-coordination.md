# ADR 0005: Provider-Independent Coordination Contract

## Status

Accepted and implemented locally. Production release and background dispatcher
activation remain separate owner gates.

## Decision

Expose a small high-level coordination API over the existing durable envelope:

- `agent_bridge_ask_agent` creates a versioned read-only `task_request` and
  returns a stable task ID immediately.
- `agent_bridge_get_result` reads local delivery state and returns the
  causally linked `task_result` when available.
- `agent_bridge_continue_agent` serializes the next turn from the latest
  completed result while preserving project and conversation identity.
- `agent_bridge_get_thread` returns a bounded ordered local conversation view.

Keep coordination, transfer, project context, and execution as separate
boundaries. The coordination contract identifies intent and access mode. The
`BridgeTransport` interface moves validated envelopes. The machine-local
project registry resolves stable project keys. The optional executor produces
an answer. None of these layers may smuggle local paths, credentials, or
provider-specific connection data into the protocol.

Idempotency belongs to the durable request boundary. Repeating the same target,
idempotency key, kind, stream, and payload returns the original task and its
authoritative conversation metadata. Reusing the key for different content is
a conflict.

Results are indexed locally by the original request's message ID. A versioned
coordination result must repeat that ID, and validation requires it to match the
envelope `causation_id`.

Multi-turn discussions use the envelope's existing conversation, causation,
and sequence fields rather than introducing a provider-owned thread object.
Only one project is allowed per conversation. Prior bridge messages are
bounded context, not project truth; the receiving agent must re-inspect the
approved local project for current claims.

## Consequences

- Callers no longer need to compose low-level dispatch envelopes or scan inbox
  messages to find an answer.
- The protocol can survive a future transport or executor replacement without
  changing the public task lifecycle.
- Service Bus remains the only production transport adapter.
- Codex CLI remains the only automated executor and is read-only.
- The caller polls; there is no callback or streaming result channel.
- The bridge transports requests and answers, not repositories or memory
  stores. Git and project-owned files remain the source of product truth.
- LangGraph Store, Letta, GitHub, HTTP, or other context providers require a
  separate authorized connector design and are not current capabilities.
- Starting the dispatcher automatically is still prohibited until the owner
  approves the operating identity, authentication home, project allowlist, and
  startup mechanism.
