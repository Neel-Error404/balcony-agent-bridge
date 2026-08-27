# Configuration Reference

Balcony Agent Bridge deliberately separates configuration by process. The MCP
server needs node routing plus SQLite. The bridge adds Azure transport and
message-signing material. The optional dispatcher adds its own restricted
Codex runtime settings and receives no Azure credentials.

## Local MCP Profile

`balcony-agent-bridge setup` writes this JSON profile and initializes its
database. Use the same profile for the MCP server, `doctor`, and `status`.
Setup requires `BALCONY_SYSTEM_ID` to match `--node-id` before it writes. When
the variable is present, MCP, `doctor`, and `status` reject a profile for a
different node. `doctor` additionally requires the bridge-only
`BALCONY_MESSAGE_AUTH_*` variables so it can validate the membership policy
and signing key through an isolated bridge-service validation invocation
before reporting the service ready. The CLI process itself does not load the
private key.

| Field | Required | Meaning |
|---|---:|---|
| `nodeId` | yes | Stable local node ID. Use `SYS-A`, `SYS-B`, or lowercase `[a-z][a-z0-9-]{0,49}`. |
| `authorizedNodeIds` | yes | One to 32 unique remote node IDs. The local ID is forbidden. |
| `databasePath` | yes | Absolute path to this node's SQLite database. |
| `topicName` | yes | Service Bus topic; defaults to `agent-messages`. |
| `subscriptionName` | yes | This node's subscription; defaults to the lowercase node ID. Pass the same value as `-SubscriptionName` when installing the Windows service. |
| `serviceBusNamespace` | no | Fully qualified `*.servicebus.windows.net` hostname. Omit for local-only setup. |
| `azureAuthMode` | with Azure | `managed_identity` or `client_certificate`; defaults to managed identity. |
| `managedIdentityClientId` | user-assigned identity only | Approved client UUID. |
| `azureTenantId` | certificate mode only | Entra tenant UUID. |
| `azureClientId` | certificate mode only | Entra application client UUID. |
| `azureClientCertificatePath` | certificate mode only | Existing absolute machine-local PEM path. |

The profile contains deployment metadata and a local path, so keep it outside
Git even though it must not contain credentials. Setup is create-only and
idempotent: change an existing profile through a reviewed migration rather
than silently overwriting it.

The MCP registration printed by the CLI uses the absolute current Node.js
executable, the absolute installed `dist/mcp/index.js`, and the absolute profile
path. This makes a local tarball installation independent of the Codex process
PATH. Move the runtime only by rerunning setup for a new profile or deliberately
updating the registration. The MCP process must not receive message-signing or
Azure credential variables.

## Bridge Service Environment

The bridge worker accepts the profile-equivalent transport variables below.
The Windows installer renders them into a machine-private service file.

| Variable | Required/default | Meaning |
|---|---|---|
| `BALCONY_SYSTEM_ID` | required | Local node ID. |
| `BALCONY_AUTHORIZED_NODE_IDS` | required | Comma-separated exact peer set. |
| `BALCONY_BRIDGE_DB_PATH` | ProgramData default | Absolute local SQLite path. |
| `BALCONY_SERVICEBUS_NAMESPACE` | bridge required | Approved fully qualified namespace hostname. |
| `BALCONY_SERVICEBUS_TOPIC` | `agent-messages` | Shared topic name. |
| `BALCONY_SERVICEBUS_SUBSCRIPTION` | lowercase node ID | This node's filtered subscription. |
| `BALCONY_AZURE_AUTH_MODE` | `managed_identity` | Approved Azure identity mode. |
| `BALCONY_MANAGED_IDENTITY_CLIENT_ID` | user-assigned identity | Managed identity client UUID. |
| `BALCONY_AZURE_TENANT_ID` | certificate mode | Entra tenant UUID. |
| `BALCONY_AZURE_CLIENT_ID` | certificate mode | Entra application client UUID. |
| `BALCONY_AZURE_CLIENT_CERTIFICATE_PATH` | certificate mode | Absolute existing PEM path. |
| `BALCONY_MESSAGE_AUTH_MODE` | bridge required | Must be `ed25519`. |
| `BALCONY_MESSAGE_AUTH_MEMBERSHIP_PATH` | bridge required | Absolute regular membership-policy JSON path. |
| `BALCONY_MESSAGE_AUTH_SIGNING_KEY_PATH` | bridge required | Different absolute regular Ed25519 PKCS8 PEM path. |

Select one identity mode and supply only its fields. Setup profiles and the
Windows installer reject mixed modes; the bridge runtime also fails closed on
mixed or incomplete identity fields. Client secrets, connection strings, SAS
keys, tokens, Azure CLI fallback, and chained credentials are unsupported. The membership peer set must exactly match
`BALCONY_AUTHORIZED_NODE_IDS`. See `docs/message-authentication.md` for the
policy schema and key lifecycle.

## Dispatcher Environment

The optional dispatcher shares only node routing and SQLite with MCP. Its
required variables are:

| Variable | Meaning |
|---|---|
| `BALCONY_SYSTEM_ID` | Local node ID. |
| `BALCONY_AUTHORIZED_NODE_IDS` | Same exact remote peer set. |
| `BALCONY_BRIDGE_DB_PATH` | Same node-local SQLite database. |
| `BALCONY_DISPATCHER_PROJECTS_PATH` | Absolute local project registry JSON. |
| `BALCONY_CODEX_EXECUTABLE` | Absolute approved native Codex executable. |
| `BALCONY_CODEX_EXECUTABLE_SHA256` | Lowercase 64-character executable digest. |
| `BALCONY_CODEX_CODE_MODE_HOST_EXECUTABLE` | Absolute approved code-mode host. |
| `BALCONY_CODEX_CODE_MODE_HOST_SHA256` | Lowercase 64-character host digest. |
| `BALCONY_DISPATCHER_CODEX_HOME` | Dedicated machine-local Codex home. |
| `BALCONY_DISPATCHER_TRUSTED_PATH` | Explicit child-process PATH. |

Optional bounded settings are `BALCONY_DISPATCHER_POLL_INTERVAL_MS` (250 to
60,000; default 2,000), `BALCONY_DISPATCHER_DEFAULT_TIMEOUT_SECONDS` (30 to
600; default 300), `BALCONY_DISPATCHER_MAX_OUTPUT_BYTES` (1,024 to 60,000;
default 48,000), and the UTC activation cutoff
`BALCONY_DISPATCHER_NOT_BEFORE_UTC`.

`BALCONY_DISPATCHER_MODE` defaults to `legacy`. `consultation` additionally
requires `BALCONY_CONSULTATION_WORKING_DIRECTORY`, `BALCONY_GIT_EXECUTABLE`,
and `BALCONY_GIT_EXECUTABLE_SHA256`. Follow
`docs/runbooks/read-only-dispatcher.md`; the dispatcher is not part of initial
node connectivity.

## Per-Peer Resource Authorization

The dispatcher project registry and the durable authorization registry serve
different purposes. `BALCONY_DISPATCHER_PROJECTS_PATH` maps a project key to a
validated local directory. SQLite schema v8 records whether that same key is an
enabled resource and which exact peer IDs have active grants. Both conditions
must pass. `peer_readable: true`, message authentication, and membership alone
never create a resource grant.

Run the operator commands against the same profile/database used by the bridge
and dispatcher:

```powershell
$env:BALCONY_SYSTEM_ID = "build-node"
& $nodePath $bridgeCli resource register --config C:\absolute\config.json --resource-id voiceai
& $nodePath $bridgeCli grant create --config C:\absolute\config.json --peer-id laptop-a --resource-id voiceai
& $nodePath $bridgeCli resource list --config C:\absolute\config.json
& $nodePath $bridgeCli grant list --config C:\absolute\config.json
```

Use `resource disable` to stop every peer from reaching one resource, and use
`grant revoke` for one peer/resource pair. Re-enable a registered resource with
`resource enable`; recreate a revoked grant with `grant create`. Resource IDs
are lowercase-normalized and must match the configured project key. Grant
creation accepts only peers already present in `authorizedNodeIds`.

Upgrading an existing v0.1 database creates empty resource and grant tables.
It never converts `peer_readable: true` or an authenticated membership entry
into an authorization grant. Register and grant each intended pair explicitly
before starting or restarting a dispatcher; otherwise requests are rejected
without resolving the project path or starting Codex.

## Configuration That Must Stay Local

Never commit or package:

- private signing keys, client certificates, tokens, or credential caches;
- service XML rendered with real endpoints or identity identifiers;
- local profiles, dispatcher registries, `.env` files, or Azure parameter
  files with deployment mappings;
- SQLite databases, WAL/SHM files, logs, dead-letter bodies, or crash dumps.

Public enrollment JSON contains only a public key, key ID, algorithm, and node
ID. Review it before exchanging it. Principal IDs and namespace names are not
credentials, but the node-to-principal deployment map is security-sensitive.

Do not source `.env.example` into MCP or the dispatcher. It is a bridge-only
source-deployment example. The optional dispatcher has its own
`config/dispatcher.env.example`; keeping these files separate preserves the
process credential boundary.
