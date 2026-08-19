# [SYS-A] Batch 5 Codex Bundle Candidate — 2026-08-20

## Scope

Build and verify, without deployment, the shared fix for
the missing native Codex companion and the legacy-versus-consultation
admission mismatch demonstrated on SYS-A and SYS-B.

Candidate branch: `codex/sys-a-batch5-codex-bundle`

Base revision: `e90951e73e862a4c20583df120b2e4897e1ae8b8`

## Implemented

- Dispatcher configuration now requires explicit paths and SHA-256 values for
  both `codex.exe` and sibling `codex-code-mode-host.exe`.
- `LocalCodexExecutor` fails closed when the companion is absent, renamed,
  outside the main executable directory, or hash-mismatched.
- Initial installation verifies the source pair, copies both files, verifies
  both after copying, and grants the unique dispatcher service SID explicit
  `ReadAndExecute` access.
- `Update-DispatcherService.ps1` upgrades only an existing restricted
  dispatcher. It requires an exact clean release, external schema-1.2 pinned
  registry, pinned Git, consultation mode, an unrestricted service SID, and
  the complete Codex bundle.
- The upgrade preserves the dedicated `CODEX_HOME`, registry, database,
  identity, and startup selection. It backs up configuration and binaries
  before stopping the service, validates one service-owned child, and restores
  the previous files and running state on failure.
- Runbooks now treat dispatcher mode, request `evidence_mode=pinned_git`, and
  loaded MCP tool schema/reload as three separate admission gates.

## Verification

| Level | Result |
|---|---:|
| Foundation | 53/53 |
| Component | 67/67 |
| Integration | 19/19 |
| Workflow | 3/3 |
| Recovery | 11/11 |
| Security | 32/32 |
| **Total** | **185/185** |

Additional verification:

- Typecheck: passed after correcting three typed test fixtures.
- Production build: passed.
- Compiled MCP smoke: connected, 13 tools, status successful.
- Production audit: zero reported vulnerabilities.
- Installer and upgrade PowerShell parsing: passed.
- `git diff --check`: no whitespace errors; only expected Windows line-ending
  notices.

## Runtime Boundary

No service, process, ProgramData configuration, Codex MCP registration,
project registry, DLQ message, Azure resource, RBAC assignment, network rule,
credential, or authentication state was changed. This source candidate was
authorized for commit and branch publication only; it remains unmerged and
undeployed. Nothing was installed, restarted, replayed, or settled.

## Remaining Gates

1. Review the published candidate branch and reconcile an owner-approved
   release SHA on `main`.
2. Independently hash each machine's Codex pair and run upgrade `-WhatIf`.
3. Upgrade one machine at a time under separate deployment approval.
4. Reload each Codex MCP client from the approved release and confirm the
   loaded `agent_bridge_ask_agent` schema exposes `evidence_mode`.
5. Run a fresh nested consultation and prove durable park, peer request,
   correlated result, parent resume, final return, and repository non-mutation.
