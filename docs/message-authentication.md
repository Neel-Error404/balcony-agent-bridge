# Message Authentication And Membership

The production Service Bus transport requires an Ed25519 signature on every
message. Azure identity controls access to the broker; the Ed25519 identity
binds a message to the node named by `origin_system`. They are separate
credentials and neither replaces the other.

The fake transport used by `balcony-agent-bridge demo` remains unsigned and
local-only. There is no unsigned fallback in the production transport.

## Create A Node Identity

Run this once for each node, using an absolute directory outside the source
repository. On Windows, create the directory with inheritance removed before
writing the private key. This example grants full control only to the current
operator, LocalSystem, and the local Administrators group:

```powershell
$identityRoot = "$env:LOCALAPPDATA\Balcony\AgentBridge\identity"
New-Item -ItemType Directory -Force -Path $identityRoot | Out-Null
$operatorSid = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
$grants = @(
  "*${operatorSid}:(OI)(CI)F",
  "*S-1-5-18:(OI)(CI)F",
  "*S-1-5-32-544:(OI)(CI)F"
)
& icacls.exe $identityRoot /inheritance:r /grant:r $grants
if ($LASTEXITCODE -ne 0) { throw "Unable to restrict identity directory ACL." }

balcony-agent-bridge identity `
  --node-id laptop-a `
  --output-directory $identityRoot
```

The command refuses to overwrite an existing identity. It creates:

- `node-identity.pkcs8.pem`: the private signing key; keep it on that node;
- `node-enrollment.json`: the public enrollment entry to exchange with the
  other operators.

The command prints public enrollment data and file locations, never private
key content. If another location or service account is used, construct an
equivalent explicit ACL before generation. File mode alone is not a Windows
confidentiality boundary, so the service installer rejects broad key-read ACLs
and untrusted runtime replacement rights.

Exchange `node-enrollment.json` through an authenticated channel. Confirm its
`node_id` and `key_id` out of band before trusting it.

## Create The Membership Policy

Every node keeps its own `membership.json`. `network_id` must be identical on
all nodes in that network. `peers` must contain exactly the remote node IDs in
that node's `BALCONY_AUTHORIZED_NODE_IDS`; it must not contain the local node.

This is an illustrative template, not a valid policy until every placeholder
is replaced with the public enrollment data from the corresponding peer:

```json
{
  "schema_version": "1.0",
  "network_id": "engineering-bridge",
  "peers": [
    {
      "node_id": "laptop-b",
      "keys": [
        {
          "key_id": "REPLACE_WITH_DERIVED_KEY_ID",
          "spki_der_base64url": "REPLACE_WITH_PUBLIC_SPKI_DER",
          "status": "active"
        }
      ]
    }
  ]
}
```

The parser is strict. A policy fails closed when peers differ from the local
authorized-node list, keys are duplicated, key IDs do not match the public
keys, a key is revoked or outside its optional activation interval, files are
relative/symlinked/oversized, or the private key is not Ed25519 PKCS8 PEM.

## Configure The Bridge Service

The long-running bridge process requires these bridge-only variables:

```text
BALCONY_MESSAGE_AUTH_MODE=ed25519
BALCONY_MESSAGE_AUTH_MEMBERSHIP_PATH=C:\absolute\path\membership.json
BALCONY_MESSAGE_AUTH_SIGNING_KEY_PATH=C:\absolute\path\node-identity.pkcs8.pem
```

The Windows bridge installer takes the two paths explicitly, verifies that
they are distinct absolute regular files, rejects broad private-key access,
and places them only in the bridge service configuration. It also rejects a
membership file, repository root, Node executable, or WinSW executable that is
writable outside LocalSystem, Administrators, or TrustedInstaller. Deploy the
built runtime from an administrator-controlled location; do not point a
LocalSystem service at a developer-writable checkout. The MCP server and
read-only dispatcher do not load the private signing key.

Membership is deliberately static in v0.1. There is no hosted directory,
pairing service, automatic trust negotiation, or membership builder. Operators
review the small JSON policy directly.

## Coordinated First Cutover

Signed and unsigned production messages are intentionally incompatible. For a
network already running an older release:

1. Generate every node identity and exchange the public enrollment entries.
2. Build and independently review every node's complete membership policy.
3. Drain or explicitly account for the existing broker backlog.
4. Stop all bridge services while leaving MCP and SQLite state intact.
5. Install the same signed-wire release and authentication configuration on
   every node.
6. Start the bridges and perform one addressed round trip per node pair.
7. Inspect inbox state and the Service Bus dead-letter queues before declaring
   the cutover complete.

Do not use a mixed signed/unsigned fleet. A legacy raw envelope received by the
new transport is dead-lettered with a generic authentication reason.

## Rotation

A peer may have up to four keys so rotation does not require accepting unsigned
messages:

1. Generate the replacement identity in a new directory.
2. Add its public key as `active` to every receiving node's policy while the old
   key remains active.
3. Restart receivers and verify they accept a test message signed by the new
   key.
4. Switch the sending node to the new private key and restart its bridge.
5. After at least the seven-day signed-message lifetime plus five minutes of
   clock tolerance, and after queue/DLQ inspection, mark the old key `revoked`
   or remove it everywhere.

Optional `not_before_utc` and `not_after_utc` values can bound a key's validity.
Use UTC timestamps with offsets. A key outside that interval is rejected even
when its signature is otherwise valid.

## Revocation And Incident Response

When a node or signing key may be compromised:

1. Stop the affected bridge and protect its SQLite evidence.
2. Mark the key `revoked` in every peer policy and restart those bridges.
3. Remove the node from local authorized-node lists where communication is no
   longer permitted; queued outbound rows for that node are quarantined by the
   worker.
4. Separately review and, with owner approval, remove or rotate its Azure
   Service Bus principal and route/RBAC assignments.
5. Inspect DLQs and durable inbox/outbox state for the exposure interval.
6. Generate a new identity and repeat authenticated enrollment before restoring
   the node.

Revocation governs future signing and ingress. An item already authenticated
and persisted in SQLite remains durable evidence; it is not silently deleted.
An operator must review or quarantine affected persisted work explicitly.

## Replay Semantics

An exact signed replay remains cryptographically valid until its signed expiry.
SQLite deduplicates it by `message_id`. An expired signed replay is rejected
before persistence. If a node loses or rebuilds its SQLite state, an unexpired
replay may be accepted again, so consumers must continue to use `message_id` as
their idempotency key. Agent Bridge does not claim exactly-once execution.
