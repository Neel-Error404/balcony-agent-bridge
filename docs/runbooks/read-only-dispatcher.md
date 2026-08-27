# Read-Only Dispatcher Runbook

## Purpose

The dispatcher turns an explicitly routed bridge request into one bounded
read-only Codex CLI job and returns the answer through the existing outbox.
It does not edit repositories, connect to Azure, or replace the interactive
Codex application.

## Preconditions

- Foundation through security tests pass in order.
- Typecheck and production build pass.
- The existing MCP server and Azure bridge use the same local SQLite database.
- The local Codex CLI supports `exec`, `--ephemeral`,
  `--ignore-user-config`, `--sandbox read-only`, and approval policy `never`.
- A dedicated `CODEX_HOME` is available for dispatcher authentication.
- The approved `codex.exe` and sibling `codex-code-mode-host.exe` SHA-256
  values and a trusted Node executable directory are known. Treat these two
  Codex files as one version-pinned bundle; a main executable without its
  companion is not an acceptable dispatcher runtime.
- The project registry is stored outside Git with access limited to the
  dispatcher operator.

## Local Configuration

Copy the shape of `config/dispatcher-projects.example.json` to a machine-local
path and add only approved local repositories. Project keys must be stable
across SYS-A and SYS-B, but paths remain machine-specific and must never be
sent through the bridge. Every enabled entry must set `peer_readable: true`.
That flag makes the path eligible; it does not authorize a peer.

Before starting the dispatcher, register the project key as a durable resource
and grant only the intended peer/resource pairs against the shared profile and
SQLite database:

```powershell
$env:BALCONY_SYSTEM_ID = "SYS-B"
& $nodePath $bridgeCli resource register --config C:\absolute\config.json --resource-id balcony-agent-bridge
& $nodePath $bridgeCli grant create --config C:\absolute\config.json --peer-id SYS-A --resource-id balcony-agent-bridge
& $nodePath $bridgeCli resource list --config C:\absolute\config.json
& $nodePath $bridgeCli grant list --config C:\absolute\config.json
```

Existing v0.1 databases migrate to schema v8 with empty authorization tables.
No project or peer is granted automatically. A request is eligible only when
it arrived through authenticated ingress, the resource is enabled, and the
exact peer/resource grant is active. Use `grant revoke` for one pair or
`resource disable` for an immediate all-peer stop on that resource. Restart and
recovery re-evaluate the durable policy before resource access.

Do not register projects containing local `.env` files, private keys,
connection files, credential caches, private certificates, `vms.yaml`, or
other machine-private material. The read-only sandbox prevents mutation but
does not guarantee that readable files cannot be returned in the answer.

Set these variables only in the dispatcher process:

```text
BALCONY_SYSTEM_ID
BALCONY_AUTHORIZED_NODE_IDS
BALCONY_BRIDGE_DB_PATH
BALCONY_DISPATCHER_PROJECTS_PATH
BALCONY_CODEX_EXECUTABLE
BALCONY_CODEX_EXECUTABLE_SHA256
BALCONY_CODEX_CODE_MODE_HOST_EXECUTABLE
BALCONY_CODEX_CODE_MODE_HOST_SHA256
BALCONY_DISPATCHER_CODEX_HOME
BALCONY_DISPATCHER_TRUSTED_PATH
BALCONY_DISPATCHER_POLL_INTERVAL_MS
BALCONY_DISPATCHER_DEFAULT_TIMEOUT_SECONDS
BALCONY_DISPATCHER_MAX_OUTPUT_BYTES
BALCONY_DISPATCHER_NOT_BEFORE_UTC
BALCONY_DISPATCHER_MODE
BALCONY_CONSULTATION_WORKING_DIRECTORY
BALCONY_GIT_EXECUTABLE
BALCONY_GIT_EXECUTABLE_SHA256
```

Do not provide Azure namespace, identity, certificate, token, connection
string, or Git credential variables to the dispatcher child.

The trusted PATH should contain only the approved Node executable directory
and any operating-system directories required by the pinned Codex wrapper.
Recalculate and reapprove the wrapper SHA-256 after every Codex CLI update.
Recalculate and reapprove the code-mode host SHA-256 at the same time. The
dispatcher fails closed at process startup if either file is absent, has the
wrong hash, uses the wrong companion filename, or is not installed beside the
main Codex executable.

## Foreground Acceptance

Before and after any foreground bridge or service acceptance, verify that one
canonical bridge worker owns the machine-wide lock:

```powershell
pwsh -NoProfile -File scripts/Test-BridgeRuntimeSafety.ps1 -SystemId SYS-A
```

Use `SYS-B` on the peer machine. A failure such as
`BRIDGE_WORKER_COUNT_2`, `manual-or-orphaned`, or
`WORKER_LOCK_OWNER_MISMATCH` blocks acceptance. Stop only the specifically
identified orphan after explicit process-mutation approval. Never leave a
foreground `dist/bridge/index.js` process running beside the Windows service.

1. Build the repository.
2. Start `npm run start:dispatcher` under the intended Windows user.
3. Confirm the dispatcher heartbeat appears in `bridge:status`.
4. Register the test resource, grant the exact requesting peer, then send one
   explicitly routed read-only request for that project.
5. Confirm exactly one `task_result` is returned.
6. Confirm the repository worktree and tracked file hashes did not change.
7. Repeat without a grant, after revocation, with a disabled resource, and with
   an unknown project; confirm terminal rejection without project-path or
   resource-content disclosure.
8. Repeat with a forced timeout and confirm the child process tree stops.
9. Stop the dispatcher, queue a request, restart it, and confirm recovery.
10. Run a long request and confirm claim renewal.
11. Stop the dispatcher during a hanging child and confirm the child tree
    exits while the inbox request remains recoverable. Treat
    `CODEX_TERMINATION_FAILED` as a stop-acceptance failure.
12. Attempt a workspace mutation and confirm no file or Git state changes.
13. Quarantine a synthetic prior deterministic result and confirm the request
    is rejected through a separate pending failure result rather than marked
    processed without a deliverable reply.
14. Continue a completed result twice with the same idempotency key and confirm
    both calls return one follow-up at the same sequence number.
15. Complete at least two follow-up turns and confirm the dispatcher receives
    only bounded prior context from the same project.
16. Attempt a stale parallel continuation or cross-project continuation and
    confirm it fails before another request is persisted.

## Background Activation Gate

Do not install automatic startup until the owner selects one of these modes:

- User-session startup: starts at logon and reuses that user's dedicated Codex
  authentication. It stops when the Windows user session ends.
- Windows service startup: runs without a user session but requires an
  approved restricted service account and dedicated noninteractive Codex
  authentication storage.

The restricted account must have read access only to approved project trees,
write access only to the bridge SQLite data directory and required temporary
locations, and no access to unrelated user profiles or machine credentials.

For true unattended operation, use the Windows service mode on both machines.
User-session startup is useful for foreground acceptance but is not always-on
when the user is logged out. Selecting or creating the restricted service
identity, granting project and runtime ACLs, and provisioning its dedicated
noninteractive Codex authentication home remain explicit machine-local owner
actions. Source approval does not by itself authorize those operating-system
changes.

After both services use the same exact source revision, acceptance requires an
unattended request/result round trip in each direction and at least two
follow-up turns in each conversation. Broker send acknowledgement is not peer
execution evidence; verify the peer inbox, dispatcher claim/result, return
delivery, and caller-visible result chain.

Do not place passwords, API keys, access tokens, or copied interactive login
material in WinSW XML, Task Scheduler arguments, repository files, Obsidian,
or bridge messages.

### Restricted Windows service procedure

Use `scripts/Install-DispatcherService.ps1` only from an elevated shell and
only against a clean checkout whose `HEAD` equals the owner-approved full
revision. The installer verifies the native Codex and Git executable hashes,
the owner-approved WinSW wrapper hash,
requires registry schema `1.2` with exactly one initial pinned project, and
registers `BalconyAgentDispatcher` under low-privilege `LocalService` with an
unrestricted unique `NT SERVICE\BalconyAgentDispatcher` SID. Sensitive ACLs
are granted to that unique service SID, not to the shared LocalService
identity.
It deliberately leaves startup set to `Manual` and does not start the service.

Authenticate the dedicated ProgramData `codex-home` directly; do not copy an
interactive user's auth files. Then start the service manually, complete the
foreground/service acceptance checklist, and run
`scripts/Test-DispatcherRuntimeSafety.ps1`. Only after a live request/result
round trip succeeds may an elevated operator run
`scripts/Enable-DispatcherAutomaticStartup.ps1 -OwnerApproved`. That final
step selects delayed automatic startup at Windows boot. Re-run the safety
check with `-RequireAutomatic` after activation and again after a reboot.

The installer defaults to legacy mode so ordinary read-only coordination
requests receive an automatic result or an explicit policy rejection. Select
consultation mode only for pinned-Git consultation requests. One service runs
one mode; do not install competing copies casually. Add further projects one
at a time only after their own privacy review, exact revision pin, and
acceptance evidence.

A request enters that consultation route only when its dispatch object also
declares `evidence_mode=pinned_git`. Service mode and request admission are
independent: a consultation service does not reinterpret marker-free legacy
requests, and a pinned request must not be claimed by the legacy dispatcher.

For an existing service, do not rerun the initial installer and do not remove
the service merely to change modes. After a separately approved exact release
is available, run `scripts/Update-DispatcherService.ps1 -WhatIf` with both
Codex source files and hashes, the pinned Git executable and hash, the
machine-local registry, and `-DispatcherMode consultation`. The upgrade script
validates the registry's currently deployed bridge path and revision, computes
the desired candidate pin in memory, and does not require or perform a
premature registry edit during `-WhatIf`. A real upgrade preserves the
dedicated `CODEX_HOME`, database, service identity, existing startup selection,
and every unrelated registry entry. It backs up the registry, service XML, and
installed Codex bundle plus affected ACL descriptors before stopping only
`BalconyAgentDispatcher`. It waits for the service state, wrapper PID, and child
processes to become fully quiescent before mutation, atomically migrates only
the `balcony-agent-bridge` path and revision, and uses bounded restart attempts
that require one service-owned child. On failure it returns secret-safe forward
and rollback stage/type/code evidence, restores and verifies the exact original
registry, files, ACLs, startup mode, and runtime state, and retains the rollback
directory. Do not remove that directory or the previous registered worktree
until local runtime acceptance and a SYS-A-triggered nested acceptance pass and
no service or registry reference remains.

Before and after the transaction, the operator must independently record the
bridge PID and Service Bus active/DLQ/transfer-DLQ counts. The updater has no
bridge or Azure mutation authority, so bridge-PID and queue invariance are
external acceptance gates. Any unexplained drift stops deployment closeout.

The installer or upgrade copies the two Codex executables into the same
restricted ProgramData `bin` directory, verifies both after copying, and
grants `NT SERVICE\BalconyAgentDispatcher` `ReadAndExecute`. Never point the
service at a normal user's package cache or copy that cache's ACLs.

Set the mandatory `NotBeforeUtc` installation cutoff after the newest obsolete
request and at or before the first explicitly accepted activation probe. The
legacy dispatcher will not claim older requests even when they remain
available in the durable inbox. Record the chosen cutoff in machine-local
deployment evidence; do not silently widen it during an upgrade.
