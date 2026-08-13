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
- SQLite: durable local message and claim state.
- Azure Service Bus Standard: cross-machine transport.

Current per-item and scenario estimates are recorded in `docs/costs.md`.

## Trust Boundaries

- Project repositories contain code, tests, evidence, and founder logs.
- Obsidian contains verified coordination summaries and evidence references.
- Credentials, tokens, connection strings, endpoints, caches, and private
  machine configuration remain local.

## Current Status

The approved Azure Service Bus topology is provisioned. All 54 tests, type
checking, production build, Bicep compilation, dependency audit, and the
compiled MCP smoke test pass.

The SYS-B managed identity is attached to the verified SYS-B Azure VM. SYS-A
is a physical Windows host and uses the approved certificate-backed Entra
application. Azure Arc is not used. Live SYS-A certificate authentication,
topic send, filtered subscription receive, PeekLock completion, durable
SQLite processing, and all nine MCP tools are verified. Codex has the local
MCP registration without Azure credentials.

The SYS-A Windows service is installed with the owner-approved WinSW v2.12.0
x64 wrapper, starts automatically, and reports a healthy heartbeat. Restart,
forced child-process termination, native MCP-to-service delivery, live
idempotency, and offline pending-work recovery pass. Codex and the service
share the ProgramData SQLite database through a least-privilege data-directory
ACL.

The remaining gates are SYS-B service installation from the next exact
published revision, a reverse SYS-B-to-SYS-A reply, and final two-system reboot
and recovery acceptance.

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
