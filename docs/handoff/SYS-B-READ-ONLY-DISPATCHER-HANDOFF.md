# SYS-B Read-Only Dispatcher Handoff

## Release Gate

Do not implement from chat and do not pull an unapproved branch. Wait for an
owner-approved exact Git SHA from SYS-A, pull with `--ff-only`, and verify the
checkout is clean.

## Intended Capability

The dispatcher is a separate local process that watches the existing durable
SQLite inbox. An explicitly routed read-only request starts one ephemeral Codex
CLI inspection in an allowlisted project and atomically returns a
`task_result`.

SYS-B must preserve the coordination protocol rather than construct a
machine-specific alternative. `agent_bridge_ask_agent` produces a versioned
read-only request; the returned task ID is the request `message_id`.
`agent_bridge_get_result` resolves only a `task_result` whose `causation_id` and
`coordination_result.request_message_id` both match that task ID. Local project
paths stay in the SYS-B registry and never cross the bridge.

It must not edit files, stage, commit, push, install packages, change services,
modify Azure, or inherit normal user MCP servers and hooks.

## SYS-B Verification

1. Set only the process-scoped `BALCONY_SYSTEM_ID=SYS-B`.
2. Pull the approved SHA with `--ff-only`.
3. Run Foundation, Component, Integration, Workflow, Recovery, and Security in
   that order.
4. Confirm the MCP server exposes thirteen tools, including
   `agent_bridge_ask_agent`, `agent_bridge_get_result`,
   `agent_bridge_continue_agent`, and `agent_bridge_get_thread`.
5. Run typecheck, build, dependency audit, and MCP smoke.
6. Create a machine-local project registry outside Git.
7. Mark only whole-project trees approved for peer inspection with
   `peer_readable: true`; do not register secret-bearing project roots.
8. Identify the local Codex PowerShell wrapper, approved SHA-256, trusted Node
   PATH, and a dedicated dispatcher `CODEX_HOME` without printing
   authentication material.
9. Run foreground dispatcher acceptance before configuring automatic startup.
10. Confirm ordinary `task_request` messages are not claimed.
11. Send one `ask_agent` request twice with the same idempotency key and confirm
    both calls return the same task and conversation IDs.
12. Confirm `get_result` reports waiting before delivery and exactly one
    completed or rejected result afterward.
13. Confirm unknown projects, timeouts, unsafe output, stale claims, and
    duplicate delivery fail closed.
14. Confirm claim renewal and child cancellation during dispatcher shutdown.
15. Confirm repository files, Git state, Azure state, and machine configuration
    remain unchanged.
16. Complete at least two serialized follow-up turns and confirm sequence,
    causation, one-project enforcement, bounded prior context, and duplicate
    continuation idempotency.
17. Return secret-safe evidence and an `accept`, `amend`, or `reject` decision.

Automatic startup is a separate owner gate. Do not create a scheduled task,
Windows service, service account, or machine-level Codex configuration without
explicit approval.
