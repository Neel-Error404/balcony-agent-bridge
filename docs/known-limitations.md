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
  downgrade after schema-v7 signed-ingress provenance is unsupported, and there is
  no automatic package updater. Schema v6 quarantines pending legacy inbox
  work; schema v7 marks all remaining legacy inbox rows as unauthenticated so
  they cannot authorize new continuation work.
- Current clean-consumer proof uses an isolated npm cache on the current host;
  it is not evidence from a separate clean OS/VM. Version `0.1.0` is the
  approved public alpha package and GitHub release target, not a
  production-service support promise; registry and release availability must
  be verified independently.
- GitHub private vulnerability reporting is enabled. Follow `SECURITY.md` and
  never put sensitive vulnerability details in a public issue.
- The owner accepted the existing public Git history for `v0.1.0` after a
  dedicated review found no live tenant identifier, credential, private key,
  connection string, token, or non-example Service Bus hostname. Operational
  handoff and verification records remain intentionally public; the automated
  scan cannot prove the absence of every unknown secret format.
- A live signed three-machine acceptance test has not been performed on this
  candidate.

## Security Residuals

- An authorized peer can send any schema-valid message allowed by the protocol.
  Membership authenticates nodes; it does not make a compromised node benign.
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
- Dispatcher project approval is not scoped per originating peer: every
  authorized peer can request any project marked `peer_readable: true`.
- A local administrator or the service account can access runtime material and
  can weaken filesystem ACLs after installation.
- Filesystem validation and later use are separate operations; a local
  privileged actor may race or replace trusted runtime inputs.

## Deferred By Design

- hosted relay, node directory, automated enrollment, and one-time join codes;
- web UI, dashboards, fleet policy, and dynamic topology changes;
- cross-company multi-tenancy, enterprise SSO, and adversarial tenant isolation;
- semantic/vector search, generalized memory providers, and file transfer;
- writable remote tasks, arbitrary command execution, and autonomous code
  mutation;
- transport and agent-runtime plugin marketplaces;
- exactly-once external side effects or distributed transactions across SQLite,
  Service Bus, and agent tools.
