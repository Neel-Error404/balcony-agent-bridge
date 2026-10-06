# Known Limitations

These are release boundaries, not hidden roadmap promises. A limitation should
be reconsidered only when a concrete public-alpha use case cannot be handled by
the smaller static design.

## Public Alpha Limits

- Azure Service Bus is the only production transport. The fake transport is
  local-test-only and unsigned.
- MCP is local stdio only. The project does not expose or authenticate a remote
  MCP endpoint.
- Membership, subscriptions, RBAC, and public-key exchange are static operator
  procedures. There is no hosted discovery, pairing code, or control plane.
- The network supports one explicit target per message. There is no broadcast,
  group conversation, push notification, or streaming partial response.
- The optional dispatcher supports bounded read-only Codex CLI inspection. It
  is not writable automation and does not support arbitrary executors.
- The npm package contains runtime commands but not infrastructure or Windows
  service-management scripts; production deployment is a reviewed source
  operation.
- Setup creates or exactly reuses a profile; it cannot edit an existing
  profile. Production metadata must be correct on first creation or changed by
  a separately reviewed migration.
- Static topology and each local authorization list are bounded to 32 nodes.
- `doctor --check-transport` proves only that a sender link can be opened. A
  real peer is required for end-to-end delivery validation.
- Upgrade and rollback are operator-run. Database migrations are forward-only,
  downgrade after schema-v8 resource authorization or schema-v9 local approval
  is unsupported, and there is no automatic package updater. Schema v6 quarantines pending legacy inbox
  work; schema v7 marks all remaining legacy inbox rows as unauthenticated, and
  schema v8 creates empty resource/grant tables so existing peers receive no
  implicit project access. Schema v9 preserves those persistent grants but adds
  empty local approval and append-only metadata-audit tables, so it also grants
  no one-time or temporary access implicitly.
- Approval is a local SQLite/operator workflow, not remote approval, a wire or
  MCP protocol extension, or a live-service control plane. Its protection is
  the local OS/process identity boundary; signer key IDs are not retained as a
  separate inbox audit field.
- Current automated clean-consumer proof uses an isolated npm cache on its
  executing host. Version `0.3.0` is the public npm-first baseline; `0.3.1-core.1`
  is an unpublished core candidate, not the broader onboarding candidate.
  Public publication, byte-identity and two independent clean-machine
  acceptance remain gates. Neither metadata nor local tests are a
  production-service support promise.
- GitHub private vulnerability reporting is enabled. Follow `SECURITY.md` and
  never put sensitive vulnerability details in a public issue.
- The owner accepted the existing public Git history for `v0.1.0` after a
  dedicated review found no live tenant identifier, credential, private key,
  connection string, token, or non-example Service Bus hostname. Operational
  handoff and verification records remain intentionally public; the automated
  scan cannot prove the absence of every unknown secret format.
- A live signed multi-machine acceptance test has not been performed on this
  candidate; Azure provisioning and operational cutover remain owner-gated.
- The retained signed peer-check service is an internal diagnostic seam, not
  a newly exposed CLI onboarding command in this core candidate. Its local
  tests use file-backed node state and the production signed
  transport with a simulated SDK broker, not Azure or independent Windows
  machines. Database/service reopen is not an OS-process crash test.
- The local hardening candidate uses request expiry as the completion deadline
  and refuses late answers as continuation authority, but has no caller-facing
  remote cancellation protocol. Deadline failure does not stop a worker that
  is already running. The default seven-day message expiry is not a short
  application SLO; callers should deliberately set a bounded expiry.
- A consumed approve-once row is an exact-request retry reservation, not an
  exactly-once execution ledger. Worker work may repeat after a crash before
  result persistence; matching stored results are reused. Revocation cannot
  retract an already-enqueued result.
- The conservative aggregate heartbeat distinguishes failed lanes internally
  but still labels both cold unproven readiness and observed failure degraded.
  No complete per-lane diagnostic, alerting path or clean-host ready certificate
  follows from this local change.

## Security Residuals

- An authorized peer can send any schema-valid message allowed by the protocol.
  Membership authenticates nodes; it does not make a compromised node benign.
- Peer-check acknowledgement lookup streams matching candidates without
  truncating before validation. Memory is bounded, but CPU work grows with
  candidate count. Per-peer admission/storage quotas remain unimplemented;
  this is not a denial-of-service-hardening claim.
- Revocation is a coordinated static policy update and bridge restart, not an
  online revocation service.
- Exact replay of a still-valid signed message after loss of the receiving
  SQLite deduplication state can be processed again. Consumer side effects must
  use `message_id` as an idempotency key.
- The verified signing key ID is not persisted in the durable SQLite envelope,
  so long-term cryptographic attribution depends on retained broker and policy
  evidence.
- Dead-lettered broker messages still consume broker storage and may retain
  their body under Azure controls even though application logs and dead-letter
  descriptions are body-free.
- `peer_readable: true` approves a complete registered project tree. Read-only
  prevents mutation, not disclosure of secrets already present in that tree.
  Per-peer grants limit which authenticated peer can request that tree, but
  they do not provide file-level filtering within it.
- A local administrator or the service account can access runtime material and
  can weaken filesystem ACLs after installation.
- Filesystem validation and later use are separate operations; a local
  privileged actor may race or replace trusted runtime inputs.

## Deferred By Design

The local parent-supervision candidate is service-only and existence-based.
It prevents a cooperative Node child from continuing after its original parent
disappears, but cannot identify a reused PID or poll during event-loop
starvation. The bridge independently bounds lane quiescence. The dispatcher
bounds process-close waiting: failed or unverified termination stops polling,
retains the task claim, and leaves a runtime failure gate that blocks restart
before a healthy heartbeat or execution. This is not proof of child death.
The gate requires explicitly authorized operator verification of process
quiescence; never clear it solely because a wrapper stopped or a timer elapsed.
Real managed Codex initialization cancellation passed without credentials;
active authenticated descendants and real service interruption remain untested.
A real service/worker interruption must be tested before deployed supervision
is certified. No parent/process kill is authorized by a diagnostic message.

Protocol `1.1` no-delegation enforcement is a local candidate. It requires
compatible receivers; legacy `1.0` requests do not authorize new peer
delegation after upgrade. Existing legacy waiting-peer runs may terminate
instead of resuming nested work and require backlog review. The patch does not
itself recover orphan transport processes, restart dispatchers, verify worker
login, or provide automatic caller-chat wake-up.

- hosted relay, node directory, automated enrollment, and one-time join codes;
- web UI, dashboards, fleet policy, and dynamic topology changes;
- cross-company multi-tenancy, enterprise SSO, and adversarial tenant isolation;
- semantic/vector search, generalized memory providers, and file transfer;
- writable remote tasks, arbitrary command execution, and autonomous code
  mutation;
- transport and agent-runtime plugin marketplaces;
- exactly-once external side effects or distributed transactions across SQLite,
  Service Bus, and agent tools.
