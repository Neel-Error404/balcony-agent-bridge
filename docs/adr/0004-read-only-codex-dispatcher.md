# ADR 0004: Read-Only Codex Dispatcher

## Status

Accepted for implementation. Background installation remains an owner gate.

## Decision

Run read-only Codex automation in a separate local dispatcher process that
shares the bridge SQLite database. Do not run Codex inside the MCP server,
Azure bridge worker, or broker delivery callback.

Only `task_request` messages with the validated `codex_cli` and `read_only`
dispatch discriminator are eligible. Ordinary tasks remain available to
interactive agents.

The dispatcher resolves a project key through a machine-local allowlist and
starts a fixed Codex CLI command. The prompt is supplied through standard
input. The CLI ignores normal user configuration, uses an ephemeral read-only
sandbox, never requests approval, receives no additional writable directory,
and has strict time and output bounds. Its wrapper is pinned by SHA-256 and the
child receives a configured trusted PATH instead of the operator's inherited
PATH.

Result publication and inbox settlement use one claim-fenced SQLite
transaction. A stale or expired claimant cannot publish a result.
Long-running work renews the claim. Renewal failure or dispatcher shutdown
cancels the child process tree and leaves the request recoverable.

## Consequences

- The Codex application does not need to be open for a dispatcher process to
  start a one-shot worker.
- The machine and dispatcher process must be running.
- A user-level dispatcher can reuse that user's Codex authentication while the
  Windows session exists.
- True service startup without an interactive session requires a separately
  approved service account and dedicated noninteractive Codex authentication
  home.
- Read-only work may run more than once after a crash, but only one fenced
  deterministic result can settle the request.
- Code and documents continue to move through their existing Git repositories,
  not through Service Bus.
- `peer_readable: true` approves the complete registered project tree for peer
  inspection. Read-only is not a confidentiality boundary, so secret-bearing
  projects cannot be registered without stronger operating-system isolation.
