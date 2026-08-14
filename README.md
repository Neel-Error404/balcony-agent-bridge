# Balcony Agent Bridge

Balcony Agent Bridge provides durable, secret-safe asynchronous communication
between coding agents running on SYS-A and SYS-B.

The local MCP server writes to a machine-local SQLite inbox and outbox. A
separate background bridge service owns Azure Service Bus access and moves
messages between machines. Azure-hosted bridges use managed identity; an
owner-approved physical host can use a dedicated Entra client certificate.

## Runtime Components

- `balcony-agent-bridge-mcp-server`: local stdio MCP server.
- `bridge-service`: long-running Azure transport worker.
- `read-only-dispatcher`: optional local process that starts bounded Codex CLI
  inspection jobs for explicitly routed requests.
- SQLite: durable local message and claim state.
- Azure Service Bus Standard: cross-machine transport.

Current per-item and scenario estimates are recorded in `docs/costs.md`.

## Trust Boundaries

- Project repositories contain code, tests, evidence, and founder logs.
- Obsidian contains verified coordination summaries and evidence references.
- Credentials, tokens, connection strings, endpoints, caches, and private
  machine configuration remain local.

## Current Status

The approved Azure Service Bus topology is provisioned and the two-machine
bridge acceptance is complete. The transport, local service, native MCP
surface, durable claim lifecycle, restart recovery, and reverse reply path are
verified on SYS-A and SYS-B.

The SYS-B managed identity is attached to the verified SYS-B Azure VM. SYS-A
is a physical Windows host and uses the approved certificate-backed Entra
application. Azure Arc is not used. Live SYS-A certificate authentication,
topic send, filtered subscription receive, PeekLock completion, durable
SQLite processing, and the original nine MCP tools are verified in the live
deployment. The current source candidate exposes thirteen tools, including
high-level ask, result, continue, and thread operations; those additions still
require the full release and SYS-B acceptance gates below. Codex has the local
MCP registration without Azure credentials.

The SYS-A Windows service is installed with the owner-approved WinSW v2.12.0
x64 wrapper, starts automatically, and reports a healthy heartbeat. Restart,
forced child-process termination, native MCP-to-service delivery, live
idempotency, and offline pending-work recovery pass. Codex and the service
share the ProgramData SQLite database through a least-privilege data-directory
ACL.

The read-only dispatcher is implemented but is not installed or enabled as a
machine background process yet. It claims only `task_request` messages whose
payload explicitly selects `codex_cli` and `read_only`. It ignores ordinary
tasks, resolves projects through a machine-local allowlist, starts Codex with
an ephemeral read-only sandbox and no approval escalation, bounds time and
output, and atomically publishes the result while completing the inbox claim.
Long-running claims are renewed, lost claims cancel the child, and process
shutdown terminates the active child tree.

Git remains the transfer mechanism for code, skills, and documents. Dispatcher
messages carry instructions and project keys, not local paths or files.

## High-Level Coordination API

`agent_bridge_ask_agent` creates a durable, versioned, read-only coordination
request and immediately returns a `task_id`. Repeating the same logical request
with the same idempotency key returns the original task. The caller uses
`agent_bridge_get_result` to observe `queued`, `waiting`, `completed`,
`rejected`, or `failed` state and retrieve the linked result when it arrives.
After a completed result, `agent_bridge_continue_agent` creates the next turn
without allowing the caller to change the project or causal chain.
`agent_bridge_get_thread` returns a bounded ordered local view of the
discussion. Requests and results advance a single conversation sequence, and
only the latest completed result can be continued.

This API is independent of Azure Service Bus and Codex at the contract layer.
The coordination envelope, SQLite state, idempotency, and result linkage do not
know which broker or agent runtime is underneath them. Azure Service Bus is the
only production transport adapter today, and the optional dispatcher supports
only bounded Codex CLI read-only execution.

The bridge does not synchronize project memory, repository files, or external
conversation databases. Multi-turn context is reconstructed only from bounded
validated requests and results already present in the machine-local bridge
database. The receiving agent re-inspects one locally allowlisted project for
current-state claims. Git remains the code/document transfer mechanism. A
GitHub, HTTP, filesystem snapshot, LangGraph Store, Letta, or other memory
connector would be a separate adapter behind the project/context boundary; it
must not be embedded into the coordination envelope or trusted as project truth
without its own authorization and evidence rules.

## Read-Only Dispatch

Example routing fragment:

```json
{
  "project": "balcony-agent-bridge",
  "dispatch": {
    "executor": "codex_cli",
    "access": "read_only",
    "timeout_seconds": 300
  }
}
```

Each machine keeps its own uncommitted project registry based on
`config/dispatcher-projects.example.json`. Build the repository, set the
dispatcher environment variables, and start the foreground process with:

```powershell
npm run start:dispatcher
```

The process uses the same SQLite database as MCP and the Azure bridge but does
not authenticate to Azure. See `docs/runbooks/read-only-dispatcher.md` before
enabling background startup.

`peer_readable: true` approves the entire configured project tree for read-only
inspection by the peer system. Do not register a project that contains
machine-private credentials, local `.env` files, private keys, connection
material, or other files the peer is not allowed to read. Read-only prevents
mutation; it is not a confidentiality boundary.

## Local Verification

Run the levels in order:

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
```

Azure templates can be linted and compiled without deployment:

```powershell
az bicep lint --file .\infra\deploy.bicep
az bicep build --file .\infra\deploy.bicep
az bicep build --file .\infra\routing-rules.bicep
```
