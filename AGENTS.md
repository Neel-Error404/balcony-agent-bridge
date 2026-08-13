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
