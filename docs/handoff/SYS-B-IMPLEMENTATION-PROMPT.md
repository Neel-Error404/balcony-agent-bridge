# SYS-B Implementation Prompt

You are the SYS-B implementation, verification, and integration owner for
Balcony Agent Bridge.

## Machine Declaration

At the beginning of every PowerShell process, set only:

```powershell
$env:BALCONY_SYSTEM_ID = 'SYS-B'
```

Do not persist this variable at machine or user scope.

## Source Gate

Use only the owner-approved `balcony-agent-bridge` revision at:

```text
E:\Work_Projects\balcony-agent-bridge
```

Pull with `--ff-only`, checkout the exact owner-supplied commit SHA, and confirm
the checkout is clean. If the SHA is missing or cannot be resolved, stop and
report that source publication is the active gate. Do not reconstruct files
from chat, SYS-A databases, service configuration, or Obsidian.

## Security Boundary

- Use the existing dedicated SYS-B user-assigned managed identity.
- SYS-B is an Azure VM. Use the attached identity directly; do not onboard
  Azure Arc.
- Do not create another identity or use the SYS-A identity.
- Do not use connection strings, SAS keys, client secrets, Azure CLI
  credentials, or the physical-host certificate mode.
- Keep the managed-identity client ID, namespace hostname, generated service
  XML, database, logs, and Azure identifiers machine-local.
- Do not change Azure resources, RBAC, networking, diagnostics, or budgets.
- Do not stage, commit, or push without separate owner approval.

## Local Build

1. Confirm Node.js 22 or later, npm, Azure CLI, and Bicep are available.
2. Install exactly from `package-lock.json`.
3. Run one verification level at a time and stop on the first failure:

```powershell
npm run test:foundation
npm run test:component
npm run test:integration
npm run test:workflow
npm run test:recovery
npm run test:security
npm run typecheck
npm run build
npm audit --omit=dev --audit-level=high
npm run smoke:mcp
az bicep lint --file .\infra\deploy.bicep
az bicep build --file .\infra\deploy.bicep
az bicep build --file .\infra\routing-rules.bicep
```

Expected SYS-A baseline: 53 tests and 9 MCP tools. Record failures with root
cause and rerun the same level after any approved fix.

## SYS-B Runtime

Use a unique SYS-B SQLite database under machine-local ProgramData. Configure
the background bridge with:

- `BALCONY_SYSTEM_ID=SYS-B`
- shared approved Service Bus namespace hostname
- shared topic name
- SYS-B subscription name
- `BALCONY_AZURE_AUTH_MODE=managed_identity`
- dedicated SYS-B managed-identity client ID

Run `Install-BridgeService.ps1 -WhatIf` first. Use an owner-approved, pinned
WinSW executable and verify its checksum. Real installation requires elevated
PowerShell.

The MCP process receives only the SYS-B system declaration and local database
path. It must not receive Service Bus credentials.

## Local Acceptance

Verify:

1. The Windows service starts and remains running.
2. The bridge records a healthy heartbeat.
3. The MCP server exposes exactly nine tools.
4. MCP standard output contains protocol traffic only.
5. Local send writes to the outbox before returning.
6. Claims are atomic and return opaque claim tokens.
7. Renewal extends only a current matching claim.
8. Expired claims are reclaimable.
9. Stale consumers cannot complete reclaimed work.
10. Service restart preserves inbox, outbox, IDs, and retry state.

## Cross-System Acceptance

After SYS-A confirms that its Windows service or a supervised bridge process
is actively running:

1. SYS-A sends a synthetic secret-safe message while SYS-B's agent is idle.
2. SYS-B receives, reads, claims, renews if necessary, and completes it.
3. SYS-B replies using the same conversation.
4. SYS-A receives and completes the reply.
5. Repeat a message ID and verify local deduplication.
6. Restart the SYS-B bridge with pending work and verify retry with the same
   message ID.
7. Verify wrong-target and session-mismatch messages are not delivered to the
   normal inbox.
8. Confirm delivery is reported as at least once, never exactly once.

## Return Evidence

Return:

- source revision and clean-checkout result;
- Node/npm versions;
- each test level and count;
- typecheck, build, audit, Bicep, and MCP smoke results;
- service state and heartbeat age;
- secret-safe SYS-A to SYS-B and SYS-B to SYS-A message IDs;
- duplicate, claim-expiry, stale-settlement, and restart-recovery outcomes;
- `accept`, `amend`, or `reject` parity decision.

Do not return message bodies, tokens, endpoints, client IDs, principal IDs,
resource IDs, IP addresses, connection strings, databases, raw logs, or
generated service XML.
