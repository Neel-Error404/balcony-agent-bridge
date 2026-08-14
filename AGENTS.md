# Balcony Agent Bridge Agent Instructions

## System Boundary

This repository is shared by SYS-A and SYS-B. Derive the active machine only
from the process-scoped `BALCONY_SYSTEM_ID` environment variable. Never infer
identity from a drive letter when that variable is present.

## Sources Of Truth

- This repository owns implementation, tests, migrations, runbooks, and
  detailed runtime evidence.
- Obsidian Git owns verified coordination summaries and links to evidence.
- Azure owns transport state and delivery locks.
- Machine-local SQLite owns durable local inbox, outbox, and consumer claims.

## Obsidian Routing

- Shared vault: `D:/Balcony/Obsidian` on SYS-A and the corresponding SYS-B
  checkout.
- Project note: `02-Projects/Balcony Agent Bridge.md`.
- Current evidence entrypoint:
  `docs/verification/SYS-A-CONTINUATION-2026-08-14.md`.
- Cross-machine handoff: `00-Inbox/Handoff.md`.

Read the project note and current verification entrypoint before work that
depends on history or deployed state. Update repository-owned evidence first,
then add only a concise source-linked summary to the vault. Never copy local
service XML, databases, logs, endpoints, identities, certificates, tokens, or
other machine-private configuration into Obsidian.

## Security

- Never commit credentials, connection strings, SAS tokens, access tokens,
  private endpoints, IP addresses, machine-local configuration, or database
  files.
- Runtime Azure access must use managed identity when the host is an Azure
  resource. A separately approved physical host may use a dedicated Microsoft
  Entra application with a machine-local client certificate. Client secrets,
  shared access keys, SAS tokens, Azure CLI credentials, and chained fallback
  credentials are prohibited.
- MCP output and logs must not expose message bodies unless the caller
  explicitly reads an authorized inbox item.
- Standard output is reserved for MCP protocol traffic. Send diagnostics to
  standard error.

## Engineering

- Use TypeScript with strict type checking.
- Validate all external input with Zod.
- Raise explicit, actionable errors. Do not silently fall back.
- Preserve at-least-once delivery semantics and idempotency. Do not claim
  exactly-once execution.
- Run tests one level at a time: foundation, component, integration, workflow,
  recovery, security.

## Git And Azure

- Never stage, commit, push, provision Azure resources, change RBAC, or change
  networking without explicit owner approval.
- Run Azure Bicep `what-if` before any approved deployment.
