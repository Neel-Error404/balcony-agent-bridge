# SYS-B Verification Handoff

## Source Gate

- Repository: `balcony-agent-bridge`
- SYS-A path: `D:\Work_Projects\balcony-agent-bridge`
- SYS-B path: `E:\Work_Projects\balcony-agent-bridge`
- Approved revision: use the exact commit SHA supplied with this handoff

Do not reconstruct the implementation from chat or copy SYS-A runtime files.
SYS-B must pull the supplied owner-approved private Git revision with
`--ff-only` and confirm `HEAD` matches the supplied SHA.

## Verified State

| Check | SYS-A | SYS-B |
|---|---|---|
| Tests | PASS, 53 | NOT RUN |
| Typecheck/build/audit | PASS | NOT RUN |
| MCP surface | PASS, 9 tools | NOT RUN |
| Bicep compilation | PASS | REVIEW ONLY |
| Azure resources | PASS | DO NOT MODIFY |
| Identity | Certificate-backed Entra app | Attached Azure VM UAMI |
| Azure Arc | NOT USED | NOT REQUIRED |
| Topic send | PASS | NOT RUN |
| Own-subscription receive | PASS | NOT RUN |
| Local claim/renew/complete | PASS | NOT RUN |
| Codex MCP registration | PASS | NOT RUN |
| Windows service | PENDING ADMIN + WinSW | NOT RUN |
| Real two-machine reply | PENDING | PENDING |

SYS-A has verified broker delivery into the SYS-B subscription. That is not a
claim that the real SYS-B bridge consumed or processed the message.

## SYS-B Acceptance Tasks

1. Pull the exact owner-approved revision with `--ff-only`.
2. Confirm the checkout is clean.
3. Set only process-scoped `BALCONY_SYSTEM_ID=SYS-B`.
4. Install from `package-lock.json`.
5. Run foundation, component, integration, workflow, recovery, and security
   tests in that order. Expected total: 53.
6. Run typecheck, build, dependency audit, MCP smoke, and both Bicep builds.
7. Confirm the existing SYS-B UAMI is attached directly to the Azure VM.
8. Configure explicit managed-identity mode with that UAMI client ID.
9. Do not install or use Azure Arc, a client certificate, Azure CLI auth,
   client secrets, SAS, or connection strings on SYS-B.
10. Run the service installer with `-WhatIf`, then install using an approved
    pinned WinSW executable in elevated PowerShell.
11. Verify service startup, heartbeat, restart recovery, and local persistence.
12. Run the real SYS-A to SYS-B consume-and-reply acceptance sequence.
13. Return secret-safe evidence and an `accept`, `amend`, or `reject` decision.

## Prohibited Handoff Material

Do not transfer PEM files, private keys, DPAPI material, SQLite databases,
generated service XML, tokens, endpoints, tenant/client/principal/resource
IDs, IP addresses, connection strings, raw logs, or Codex configuration.

Use `SYS-B-IMPLEMENTATION-PROMPT.md` as the task prompt with the supplied SHA.
