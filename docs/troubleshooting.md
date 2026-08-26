# Troubleshooting

Start with the earliest failing layer. Do not bypass a failed check with a
fallback identity, an unsigned message mode, a new database, or automatic
dead-letter replay.

## Setup

- `setup` requires Node.js 22+, one valid local node ID, at least one distinct
  authorized peer, and absolute paths when `--config` or `--database` is used.
- `identity --node-id` and `setup --node-id` require
  `BALCONY_SYSTEM_ID` and reject a missing or different value before creating
  any directory or file. Set the variable to the node being provisioned.
- `created: false` is the expected result of an exact rerun.
- If setup reports `setup failed (CONFIGURATION_ERROR)`, first confirm
  `BALCONY_SYSTEM_ID` is set and matches `--node-id`, then compare the requested
  values with the existing profile. Setup intentionally does not disclose path
  details or overwrite a different profile.
- If the requested database already exists without the requested profile,
  preserve it and determine its owner before proceeding.
- Certificate mode requires an existing absolute certificate file plus tenant
  and client UUIDs. Managed-identity and certificate fields cannot be mixed.

## Doctor

`doctor` returns structured checks and exits nonzero if any requested layer
fails.

| Code | Action |
|---|---|
| `PACKAGE_RUNTIME_UNSUPPORTED` | Install Node.js 22+ and use a complete built or packaged runtime. |
| `CONFIGURATION_ERROR` | Validate the profile against `docs/configuration.md`; do not add credentials. |
| `DATABASE_MISSING` | Confirm the profile points to this node's database. Do not copy another node's database. |
| `DATABASE_INTEGRITY_FAILED` | Stop writers, preserve the database, and investigate before recovery. |
| `DATABASE_SCHEMA_UNSUPPORTED` | Use the matching runtime and test migration on a copy. |
| `DATABASE_UNAVAILABLE` | Stop writers and inspect filesystem access or SQLite open failures without replacing the database. |
| `IDENTITY_CONFIGURATION_INVALID` | Supply exactly one supported Azure identity mode. |
| `IDENTITY_CERTIFICATE_UNAVAILABLE` | Restore the approved absolute certificate path and ACL. |
| `MESSAGE_AUTHENTICATION_INVALID` | Restore the required Ed25519 mode, exact membership policy, signing key, and service-readable file access. Do not enable unsigned fallback. |
| `TRANSPORT_CONFIGURATION_MISSING` | Add approved namespace metadata before requesting `--check-transport`. |
| `RUNTIME_CONFIGURATION_UNAVAILABLE` | Fix the failed identity or message-authentication check before probing Azure. |
| `TRANSPORT_TIMEOUT` / `TRANSPORT_UNREACHABLE` | Check network, identity, topic sender RBAC, and namespace approval. |

`identity_configuration: skipped` with `LOCAL_ONLY`, and
`transport_send_link: skipped` with `NOT_REQUESTED`, are healthy local-only
results only when `message_authentication` passes. `--check-transport` opens a
sender link but does not prove a receiving subscription or end-to-end delivery.

## Bridge Transport

If local checks pass but messages do not arrive:

1. Confirm every node uses the same namespace, topic, and network membership
   ID.
2. Confirm each node's local subscription name matches its infrastructure
   inventory entry.
3. Confirm the subscription has only the exact `bridgeTarget` rule and no
   effective catch-all rule.
4. Confirm the node principal can send to the topic and receive only from its
   own subscription.
5. Confirm both bridges are running before sending a fresh diagnostic message.
6. Inspect bounded status and dead-letter reason codes; do not expose or paste
   message bodies into a public issue.

The bridge intentionally emits stable error codes instead of raw SDK details,
endpoints, paths, or message bodies. Use owner-controlled Azure diagnostics for
deeper transport investigation.

## Message Authentication

Production Service Bus has no unsigned compatibility mode. Startup or ingress
fails closed when:

- the local signing key is missing, malformed, or not an Ed25519 PKCS8 key;
- membership peers do not exactly match the authorized-node list;
- two nodes reuse one public key or derived key ID;
- a key is inactive, revoked, expired, or outside its issuance window;
- network, origin, target, lifetime, signature, or broker metadata differs.

Use `docs/message-authentication.md` for initial enrollment, coordinated
rotation, revocation, and incident response. Do not transfer a private key to
another node and do not re-enable an old key merely to drain rejected traffic.

## Recovery

- Restart the bridge and allow leases to expire; pending work remains durable.
- Preserve message IDs during retry so broker and inbox deduplication work.
- Do not delete pending, leased, available, claimed, or quarantined rows.
- Do not automatically replay dead-lettered messages. Record the root cause,
  fix it, and perform a bounded reviewed requeue only if appropriate.
- Never copy one node's SQLite database to another node.

Follow `docs/runbooks/recovery.md`. For service installation or upgrade
failures, also use `docs/runbooks/windows-service.md`. If credentials or
signing material may be exposed, stop the bridge, revoke access, rotate the
affected material, and preserve evidence without publishing it.
