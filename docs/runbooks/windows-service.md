# Windows Service Runbook

The bridge service uses an owner-supplied, version-pinned WinSW executable.
WinSW is not downloaded, installed, or committed automatically.

## Preconditions

- Local foundation through security tests pass.
- `npm run build` succeeds.
- The approved machine identity and Service Bus RBAC are deployed.
- The WinSW release and checksum are approved.
- PowerShell is elevated for installation.

Azure VMs use the `ManagedIdentity` parameter set with an explicit
user-assigned identity client ID. Physical hosts use the
`ClientCertificate` parameter set only when the owner has approved the
fallback, the certificate is stored outside the repository, and its private
key ACL is restricted to administrators and the Windows service account.

Run `Install-BridgeService.ps1 -WhatIf` before installation. The real
installation writes only to the machine-local ProgramData directory and
registers the `BalconyAgentBridge` service.

The installer grants the elevated installing user `Modify` access only on the
ProgramData `data` directory so the local MCP server and Windows service can
share the SQLite inbox and outbox. Service configuration, credentials, and
logs remain outside that writable boundary.

The generated service configuration is machine-private because it contains the
local Azure namespace endpoint. Never commit it or copy it through Obsidian.

After installation, test start, stop, restart, process termination, Azure
unavailability, reboot startup, database access, log rotation, and service
recovery. The Codex MCP entry may remain enabled because it has no Azure
credentials; queued work stays local while the bridge service is unavailable.
