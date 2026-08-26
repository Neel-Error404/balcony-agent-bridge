# Architecture

## Process Boundaries

The MCP server and background bridge service are separate processes that share
one local SQLite database.

The MCP server validates requests and performs short SQLite transactions. It
does not connect to Azure. The bridge service is the only process allowed to
authenticate to Azure Service Bus.

The bridge runtime has independent lanes. The inbound lane may remain inside
Service Bus's session-accept long poll while the outbound lane continues to
lease and send local work and refresh the runtime heartbeat. The sender and
session receiver use separate Service Bus clients. Idle receiving therefore
cannot starve queued outbound work. Shutdown is separately bounded because an
SDK session accept or client close may not honor cancellation promptly.

Exactly one bridge transport worker may run for each machine identity. The
process acquires a machine-wide worker lock before opening SQLite or Service
Bus. A second live worker fails closed, while a lock left by a process that no
longer exists is reclaimed. This prevents competing receivers from consuming
the same subscription into different local state stores.

The optional read-only dispatcher is a third local process. It shares the
SQLite database, claims only explicitly routed read-only Codex tasks, and never
connects to Azure. Codex execution does not occur inside the broker receive
handler, so a long inspection cannot hold an Azure message lock.

The optional consultation mode adds a durable autonomous consultation
coordinator beside that dispatcher. It parks child information requests in
version-fenced SQLite runs, resumes one transition at a time, and may create
one correlated nested peer request within bounded round, depth, timeout,
duplicate, and cycle controls. The foreground entrypoint selects either the
legacy dispatcher or consultation coordinator, never both in one process.

The dispatcher uses a machine-local project registry. Remote messages select a
stable project key and never provide a filesystem path or executable command.
The child process receives a minimal environment and fixed Codex arguments:
ephemeral session, ignored user configuration, read-only sandbox, no approval
requests, bounded runtime, and bounded stdout. The configured executable is
SHA-256 pinned, and the child receives an explicit trusted PATH rather than the
operator's inherited PATH.

Project registration requires explicit whole-project peer-read approval.
Read-only execution prevents writes but does not make secret-bearing project
files safe to expose. Projects containing machine-private material must not be
registered; stronger confidentiality requires a restricted operating-system
account and filesystem ACLs.

## Coordination And Adapter Boundaries

The high-level coordination contract is versioned independently from the
transport. A request contains an intent (`inspect`, `question`, or `review`), a
read-only access declaration, a stable project key, and ordinary task content.
A result identifies the original request through both `causation_id` and
`coordination_result.request_message_id`. Envelope validation rejects a
mismatch before persistence.

The durable transaction is:

1. `agent_bridge_ask_agent` commits a local outbox request and returns its task
   ID.
2. A `BridgeTransport` implementation moves the unchanged envelope to the
   explicitly addressed authorized node.
3. That node either leaves it for an interactive consumer or an explicitly
   started dispatcher claims it.
4. The peer publishes one causally linked task result.
5. `agent_bridge_get_result` finds that result in the local inbox without
   requiring broker access.
6. `agent_bridge_continue_agent` may create the next turn only from the latest
   completed peer result, preserving the project and conversation.
7. `agent_bridge_get_thread` returns a bounded ordered local view.

The turn chain is `request seq0 -> result seq1 -> follow-up seq2 -> result
seq3`. Every response is caused by its request; every follow-up is caused by
the preceding result. Reusing an idempotency key returns the same turn, while
parallel or stale continuations fail closed. The dispatcher receives at most
eight prior validated coordination messages and 8,000 context characters. It
is instructed to treat prior text as discussion data and re-inspect local
evidence for current-state claims.

`BridgeTransport` is the narrow transfer seam: send one envelope, receive
available deliveries, and close. Service Bus is the only production adapter;
the fake adapter verifies the protocol without Azure. A future broker, HTTPS
relay, or GitHub-backed queue can implement the same seam, but must preserve
at-least-once delivery, stable message IDs, acknowledgement behavior, and the
secret policy.

Project context is a different seam. Today the dispatcher maps a stable project
key to one machine-local allowlisted directory and Codex reads that directory.
The bridge has no generalized memory provider, LangGraph Store integration,
Letta integration, remote repository reader, or file-transfer protocol. Such a
connector should produce bounded evidence for an executor; it should not change
message delivery semantics or place paths, credentials, or complete memory
stores in broker messages.

The evidence boundary has two local adapters. The filesystem adapter
reads explicit allowlisted text paths with containment and reparse controls.
The Git adapter requires a caller-supplied full revision equal to repository
`HEAD`, verifies tracked blobs, and reads committed bytes from the Git object
database. Evidence bundles include content SHA-256 values and source-specific
provenance without exposing the machine-local repository root.

Evidence-only child turns run from a neutral directory and receive the bundle
through standard input. User configuration is ignored, the read-only sandbox
prevents mutation, and the native shell, unified executor, and image-file
reader features are disabled. This is an executable tool-surface boundary, not
a claim that the native process cannot read its own authentication home or
required operating-system files.

The current orchestration is intentionally small: a bounded static inventory
of authorized nodes, one explicit target per initial request, serialized
bounded turns inside one project, caller polling, and read-only execution.
Replies and continuations derive their destination from the validated causal
chain rather than a global peer setting. Broadcasts, dynamic discovery,
multi-party discussions, push notifications, streamed partial answers,
writable tasks, dynamic executor selection, and durable cross-project
conversational memory are not implemented.

## Delivery Semantics

Delivery is at least once.

1. An MCP send call commits an outbox row before returning.
2. The bridge leases the outbox row, sends it, and marks it sent only after
   Azure acknowledges the send.
3. The receiving bridge persists a valid message before completing the broker
   delivery.
4. Broker redelivery is deduplicated by the local inbox primary key.
5. Consumer side effects must use `message_id` as an idempotency key.

No distributed transaction exists across SQLite, Azure Service Bus, and an
agent's external side effects. The system must never claim exactly-once
execution.

For read-only dispatch, result enqueue and inbox settlement are one fenced
SQLite transaction. The transaction verifies the unexpired claim token,
inserts or reuses the deterministic result, records the result identity, and
marks the request processed or rejected. A stale dispatcher cannot publish
after another consumer reclaims the task. Codex inspection itself remains
at-least-once because a crash before settlement may cause the read-only work to
run again.

An existing pending, leased, or sent deterministic result is authoritative
after crash recovery. A quarantined or expired prior result is not reused as a
successful reply; the dispatcher rejects the request through a separate
deliverable failure result.

The dispatcher renews its local claim while Codex runs. Claim-renewal failure
or process shutdown cancels the child process tree and leaves the request
recoverable after lease expiry. Windows cancellation is not reported complete
until `taskkill /T /F` succeeds and the launched process closes.

## Azure Topology

The supported target topology is one dedicated Service Bus Standard namespace,
one `agent-messages` topic, and one filtered subscription for every node in a
bounded static inventory. Messages use stable `MessageId` values and
conversation-scoped `SessionId` values. Each subscription removes the default
catch-all rule and adds one correlation rule that matches the exact
`bridgeTarget` application property for that node.

Every node supplies an existing execution principal. Azure hosts may use an
explicitly selected user-assigned managed identity; approved non-Azure hosts
may use an Entra application with a machine-local client certificate. The
principal receives sender access at the topic and receiver access only at its
own subscription. The bridge never falls back to Azure CLI credentials,
shared SAS keys, client secrets, or a chained default credential.

Subscription filters and local authorization lists limit routing, while a
separate Ed25519 signed-wire layer authenticates `origin_system` and the whole
unchanged durable envelope. Azure identity remains the broker credential; it
is not used as the message-signing identity.

The bridge service is the only process that loads the private signing key. It
signs immediately before Service Bus send. On ingress it verifies the strict
wire wrapper, network, key status and validity, target, lifetime, signature,
and broker message/session/correlation/subject/routing metadata before it
constructs a delivery for the worker. Invalid messages are dead-lettered with
fixed body-free text and never reach SQLite. The MCP server and dispatcher do
not load the private signing key.

The membership policy is a local static trust root whose peers must exactly
match `BALCONY_AUTHORIZED_NODE_IDS`. Multiple active peer keys permit staged
rotation; revoked and expired keys fail closed. A signed message lives for at
most seven days and never beyond its envelope expiry. Exact live replay still
reaches SQLite deduplication by `message_id`; expired replay is rejected before
persistence.

The fake transport remains raw and unsigned for the Azure-free local demo.
Production Service Bus has no unsigned compatibility fallback, so upgrading an
existing network requires a coordinated cutover. The policy format, operator
procedure, and residual risks are documented in `message-authentication.md`
and `threat-model.md`.

Operational failures are reduced to stable allowlisted error codes before
they enter SQLite, MCP status, or stderr. Raw SDK exception text, endpoints,
certificate paths, broker identifiers, and message identifiers are not
written to operational logs.

Azure resources are not created until the owner approves a reviewed Bicep
`what-if`.
