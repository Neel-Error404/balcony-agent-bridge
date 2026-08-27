# Balcony Agent Bridge

Balcony Agent Bridge is a durable MCP communication layer for coding agents on
separately operated machines. Each agent talks to a machine-local MCP server;
a separate bridge service moves signed messages through Azure Service Bus; and
SQLite preserves inbox, outbox, claim, reply, and recovery state.

The public-alpha design is intentionally small: a static network of explicitly
authorized nodes, direct one-to-one routing, one production transport, and an
optional read-only Codex dispatcher. It is not a hosted discovery service, a
file-sync product, or a writable remote-execution platform.

This repository is public under Apache-2.0, and version `0.1.0` is approved for
public npm distribution as an alpha. Anyone may clone, build, inspect, modify,
and use it under that license. The npm artifact is for local CLI and MCP
evaluation; production service installation remains a reviewed source
operation because the package intentionally excludes infrastructure and
Windows service-management scripts.

## Install

Requirements:

- Node.js 22 or newer;
- npm 10 or newer;
- PowerShell 7 for the exact quickstart commands below;
- Windows for the service tooling and the currently verified Phase 5 path;
- Azure access only when deliberately deploying or checking the production
  transport.

After the registry reports version `0.1.0`, install the public CLI and MCP
package:

```powershell
npm view balcony-agent-bridge@0.1.0 version
npm install --global balcony-agent-bridge@0.1.0
balcony-agent-bridge --help
```

Source installation is available only after GitHub exposes the `v0.1.0` release
tag. Fetch tags, stop clearly if that tag is unavailable, then check out the
reviewed tag detached before installing dependencies:

```powershell
git clone https://github.com/Neel-Error404/balcony-agent-bridge.git
Set-Location balcony-agent-bridge
git fetch --tags --force
if (-not (git tag --list v0.1.0)) {
  throw "GitHub has not exposed the v0.1.0 release tag; source installation is unavailable."
}
git checkout --detach v0.1.0
npm ci
npm run build
$bridgeCli = (Resolve-Path .\dist\cli\index.js).Path
node $bridgeCli --help
```

The remaining examples use the installed `balcony-agent-bridge` command. When
working only from the source checkout, replace that command with
`node $bridgeCli`.

To evaluate the exact npm artifact from a source checkout:

```powershell
npm pack
$tarball = (Resolve-Path .\balcony-agent-bridge-0.1.0.tgz).Path
$consumer = Join-Path $env:TEMP ("balcony-agent-bridge-consumer-" + [guid]::NewGuid())
try {
  New-Item -ItemType Directory -Force -Path $consumer | Out-Null
  Push-Location $consumer
  try {
    npm init -y
    npm install $tarball
    $packageCli = Join-Path $consumer "node_modules/balcony-agent-bridge/dist/cli/index.js"
    node $packageCli --help
  } finally {
    Pop-Location
  }
} finally {
  if (Test-Path -LiteralPath $consumer) {
    Remove-Item -LiteralPath $consumer -Recurse -Force -ErrorAction Stop
  }
}
```

The core Node runtime may work on other operating systems, but
this release candidate has only been verified on Windows; translate paths and
shell syntax before evaluating it elsewhere.

The artifact contains compiled runtime files, the README, license, security
policy, package metadata, and sanitized examples. It excludes source, tests,
infrastructure, service scripts, internal evidence, databases, and local
configuration.

## Try The Local Demo

Run the deterministic three-node round trip before configuring Azure:

```powershell
balcony-agent-bridge demo
```

The expected JSON contains `"result":"passed"` and `"azure_used":false`.
The demo uses in-memory SQLite and a fake transport; it neither needs nor
proves Azure connectivity.

## Configure A Node

Choose one stable lowercase node ID and the complete list of remote nodes this
machine may contact. Setup creates a private local JSON profile plus a v7
SQLite database:

```powershell
$env:BALCONY_SYSTEM_ID = "laptop-a"
balcony-agent-bridge setup `
  --node-id laptop-a `
  --authorized-node laptop-b `
  --authorized-node build-node
```

On Windows the default profile is below
`%LOCALAPPDATA%\Balcony\AgentBridge`; on other systems it is below
`$XDG_CONFIG_HOME` or `~/.config`. Pass absolute `--config` and `--database`
paths to choose another location. An exact rerun is idempotent and returns
`created: false`; setup refuses to overwrite a different profile or pair a new
profile with an existing database.

Treat this default-path profile as a local evaluation profile. Setup is
create-only, so do not try to add Azure fields to it later. A production node
gets a fresh, explicit profile and database path after its namespace, identity,
service location, and ACLs have been approved. Create that production profile
from the durable reviewed runtime only after the service installer prepares its
shared data directory, as shown under Connect.

Setup records metadata, not credentials. It never accepts client secrets,
connection strings, tokens, certificate contents, or signing-key contents.
The complete field contract is in `docs/configuration.md`.

## Deploy The Shared Transport

The production topology is one dedicated Service Bus Standard namespace, one
`agent-messages` topic, and one filtered subscription per node. Every node
gets sender access to the topic and receiver access only to its own
subscription. The templates create no identities and contain no credentials.

1. Copy `infra/example.parameters.json` to an ignored machine-local file.
2. Replace the example namespace, node inventory, subscription names, and
   existing Entra principal object IDs.
3. Run the local Bicep lint/build checks.
4. Set `BALCONY_SYSTEM_ID` to one node in that inventory, then run
   `scripts/Invoke-BridgeSubscriptionWhatIf.ps1 -Location centralindia
   -ParameterFile C:\absolute\path\parameters.json` and review every resource
   and role assignment.
5. Deploy only after the owner separately approves the Azure mutation.

`infra/README.md` is the authoritative deployment sequence. The example
`docs/examples/three-node-topology.md` shows the exact three-node mapping.
Nothing in install, setup, demo, or package verification deploys Azure.

## Connect The Node

Create a signing identity in an absolute machine-local directory outside every
repository. Before running this command, complete the pre-generation Windows
ACL procedure in `docs/message-authentication.md` for the same output directory:

```powershell
$env:BALCONY_SYSTEM_ID = "build-node"
balcony-agent-bridge identity `
  --node-id build-node `
  --output-directory "$env:LOCALAPPDATA\Balcony\AgentBridge\build-node-identity"
```

Exchange only each node's generated public enrollment JSON. Build an explicit
membership policy whose network ID is shared by the deployment and whose peer
set exactly matches that node's authorized-node list. Keep the PKCS8 private
key on its originating machine. The canonical policy format, rotation,
revocation, and coordinated cutover are in
`docs/message-authentication.md`.
The installer later verifies those ACLs and fails closed on broader access.

Source deployments can use `scripts/Install-BridgeService.ps1` after reviewing
its `-WhatIf` output. Service installation is deliberately not an npm package
side effect. Pass the node's provisioned topology subscription as
`-SubscriptionName`; omitting it keeps the lowercase node-ID default. On
Windows, install but do not start the service, then create the
production MCP profile with its database set to
`%ProgramData%\Balcony\AgentBridge\data\bridge.sqlite3`; the installer grants
the installing user access to that shared data directory. Register the printed
MCP snippet only after both processes point at that same database. See
`docs/runbooks/windows-service.md`.

From that durable reviewed source runtime, after the service has been installed
but before it is started, create the matching production profile:

```powershell
$env:BALCONY_SYSTEM_ID = "build-node"
balcony-agent-bridge setup `
  --config "$env:LOCALAPPDATA\Balcony\AgentBridge\build-node.json" `
  --database "$env:ProgramData\Balcony\AgentBridge\data\bridge.sqlite3" `
  --node-id build-node `
  --authorized-node laptop-a `
  --authorized-node laptop-b `
  --servicebus-namespace replace-with-approved.servicebus.windows.net `
  --subscription build-node `
  --auth-mode managed_identity `
  --managed-identity-client-id 11111111-1111-4111-8111-111111111111
```

Both `identity --node-id` and `setup --node-id` require
`BALCONY_SYSTEM_ID` and fail before writing when it is missing or names another
node. Set it to the node being provisioned.

Register only this production setup's returned MCP snippet. The MCP process
receives the profile path and SQLite access, but no Azure credential or
signing-key path. The service must use the same node, peer, database, topic, and
subscription values, one approved Azure identity mode,
`BALCONY_MESSAGE_AUTH_MODE=ed25519`, and the absolute membership/signing-key
paths. Run `doctor`, then use the owner-approved start procedure in the Windows
runbook.

## Verify The Node

Verify local runtime, profile, schema, database integrity, and mandatory message
authentication readiness. Run `doctor` with the same
`BALCONY_MESSAGE_AUTH_*` variables and process-scoped `BALCONY_SYSTEM_ID` that
the bridge service will receive; `status` needs only the matching profile and
process identity. `doctor` delegates the private-key readiness check to an
isolated validation invocation of the bridge service entrypoint, so the CLI
process does not load signing material:

```powershell
balcony-agent-bridge doctor --config "C:\absolute\path\config.json"
balcony-agent-bridge status --config "C:\absolute\path\config.json"
```

After Azure identity and RBAC are ready, explicitly probe only the sender
link:

```powershell
balcony-agent-bridge doctor `
  --config "C:\absolute\path\config.json" `
  --check-transport
```

The transport check opens and closes a sender link; it does not send an agent
message. A real end-to-end test additionally needs another authorized node and
its running bridge.

Maintainers run the packaged CLI clean-consumer smoke with:

```powershell
npm run verify:public-alpha
```

That command builds, packs, resolves dependencies using an isolated empty npm
cache, installs the tarball into a disposable empty npm consumer, and exercises
help, identity, setup, idempotent setup, doctor, demo,
status, and invalid-command behavior. It is clean-consumer evidence on the
current host, not a claim of a separate clean operating-system VM.

## Upgrade

There is no supported in-place production bridge-service upgrade or downgrade
in v0.1. Do not rerun the initial installer over an existing service. Before an
owner-defined replacement procedure:

1. Stop the bridge, MCP client, and optional dispatcher so every SQLite writer
   is quiesced.
2. Preserve the database, profile, membership policy, service configuration,
   and previous reviewed source/runtime outside Git and outside other nodes.
3. Run the ordered checks in `docs/release-manifest-v0.1.md` against the new
   revision.
4. Treat the retained runtime and state as the rollback point. The replacement
   procedure and any service re-registration require separate owner review.
5. For signing-policy changes, use the staged key-rotation procedure and keep
   old and new public keys active until every node has cut over.

The current database migration is automatic and forward-only. Test recovery
on a copy before upgrading an important node. The signed-ingress migration
preserves outbound and completed history but quarantines pending legacy inbox
work for explicit review. The repository does not provide an automatic package
updater or an automatic production rollback.

## Recover

Restarting a bridge is safe: pending or leased outbox work is retried after its
lease expires, received messages are persisted before broker completion, and
duplicate message IDs are deduplicated locally.

Do not delete pending rows, change message IDs, automatically replay the
dead-letter queue, or copy one node's database to another. Diagnose with
`doctor`, preserve the database and logs, record the root cause, and follow
`docs/runbooks/recovery.md`. Authentication incidents also require the
revocation procedure in `docs/message-authentication.md`.

## Architecture And Trust Boundary

- `balcony-agent-bridge-mcp` is the local stdio MCP server.
- `balcony-agent-bridge` provides demo, identity, setup, doctor, and status.
- `bridge-service` is the only Azure-connected process and the only process
  that loads the Ed25519 private signing key.
- `read-only-dispatcher` is optional, shares SQLite, has no Azure credentials,
  and can inspect only explicitly registered projects.
- SQLite provides local durable state; Azure Service Bus is the only production
  transport adapter today.

Production ingress requires an exact authorized peer, network membership,
valid key window, whole-envelope Ed25519 signature, and matching broker routing
metadata before persistence. Azure authorization controls broker access; it is
not treated as message identity. The local fake transport is intentionally
unsigned and has no production compatibility fallback.

The high-level MCP contract uses explicit targets and durable task IDs.
`agent_bridge_ask_agent` queues a read-only coordination request;
`agent_bridge_get_result` polls its result; `agent_bridge_continue_agent`
creates the next bounded turn; and `agent_bridge_get_thread` returns the local
validated conversation view. Git remains the transfer path for code and large
artifacts. Messages do not carry credentials, filesystem paths, repository
contents, or external memory databases.

Read `docs/architecture.md`, `docs/threat-model.md`,
`docs/configuration.md`, `docs/troubleshooting.md`, and
`docs/known-limitations.md` before a production decision.

## Optional Read-Only Dispatch

The dispatcher maps stable project keys to machine-local allowlisted
directories. `peer_readable: true` authorizes the whole configured project
tree for an authorized peer. Read-only execution prevents mutation; it is not
a confidentiality boundary. Never register a project that contains local
credentials, private keys, connection material, or files that peer may not
read.

The dispatcher is configured separately from MCP and the bridge. It is not
required for direct human-consumed bridge messages. See
`docs/runbooks/read-only-dispatcher.md`.

## Development And Release State

The project is licensed under Apache-2.0. Run tests one level at a time:

```powershell
npm run test:foundation
npm run test:component
npm run test:integration
npm run test:workflow
npm run test:recovery
npm run test:security
npm run typecheck
npm run build
npm run smoke:mcp
npm run check:secrets
npm run verify:public-alpha
```

Stop on the first unexplained failure, fix its root cause, and rerun that same
level. `docs/release-manifest-v0.1.md` separates locally verifiable checks from
owner-gated Git history, publication, Azure, service, and live multi-node
checks.

The source repository is public and version `0.1.0` is the approved npm and
GitHub release target. Confirm external package availability with `npm view`.
The commands above do not deploy Azure resources, install a service, change
RBAC, or alter a live bridge. See `SECURITY.md` before reporting a vulnerability
and `docs/ROADMAP.md` for the implementation journey and current release gates.

The local verification workflow does not publish anything.
