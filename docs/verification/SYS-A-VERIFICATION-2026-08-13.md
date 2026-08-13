# SYS-A Verification - 2026-08-13

## Environment

- System: SYS-A
- Repository path: `D:\Work_Projects\balcony-agent-bridge`
- Node.js: 22.x
- Azure CLI account state: enabled
- Git publication: approved; exact revision is supplied with the handoff
- SYS-A host: physical Windows 11 machine
- Azure Arc: not installed and not required by the selected design
- Windows service: installed, automatic, and running
- Current PowerShell session: not elevated

## Local Verification

| Check | Result |
|---|---|
| Dependency audit | PASS, zero reported vulnerabilities |
| TypeScript typecheck | PASS |
| Production build | PASS |
| Foundation tests | PASS, 17 |
| Component tests | PASS, 16 |
| Integration tests | PASS, 7 |
| Workflow tests | PASS, 1 |
| Recovery tests | PASS, 3 |
| Security tests | PASS, 10 |
| Aggregate tests | PASS, 54 |
| Compiled MCP smoke | PASS, 9 tools |
| PowerShell syntax | PASS |
| Main Bicep compilation | PASS |
| Routing-repair Bicep compilation | PASS |
| Codex MCP registration | PASS, enabled stdio server |

The Codex MCP registration contains only the SYS-A declaration and shared
ProgramData SQLite path. It contains no Azure endpoint, tenant, client,
certificate, token, or connection-string value.

## Azure State

The approved topology is active:

- Service Bus Standard with local authentication disabled.
- One topic.
- Two active session-enabled subscriptions.
- One explicit correlation rule per subscription.
- Dedicated sender and receiver role assignments at entity scope.
- SYS-B user-assigned managed identity attached directly to the Azure VM.

Live inspection found that the originally declared reserved `$Default` rule
was absent from both subscriptions. A minimal resource-group what-if showed
two creates, zero modifies, and zero deletes. The repair deployed two explicit
`bridge-target` correlation rules. Both rules are now present and match their
intended target system.

## SYS-A Identity

- Dedicated certificate-backed Entra application and service principal.
- One public certificate credential.
- Zero password credentials and zero client secrets.
- Private PEM stored outside repositories and Obsidian.
- File ACL limited to the current user, Local System, and local Administrators.
- Topic-level Data Sender and SYS-A-subscription Data Receiver roles only.
- No Service Bus Data Owner, namespace-wide data role, or management role.
- Certificate expiry: August 13, 2027.
- Rotation reminder date: July 14, 2027.

The unused SYS-A user-assigned managed identity remains unattached. It was not
attached to an unrelated Azure VM.

## Live Acceptance

| Check | Result |
|---|---|
| Certificate parsing | PASS |
| Entra token acquisition | PASS |
| Topic send | PASS |
| Correlation routing | PASS |
| SYS-A subscription receive | PASS |
| PeekLock completion | PASS |
| Background bridge startup | PASS |
| Durable outbox send | PASS |
| Inbound SQLite persistence | PASS |
| Atomic claim | PASS |
| Atomic lease renewal | PASS |
| Terminal completion | PASS |
| Hardened MCP status | PASS |
| Bridge stdout/stderr leakage | PASS, zero output in final live run |
| Broker delivery to SYS-B subscription | PASS |
| Windows service automatic start type | PASS |
| Windows service restart | PASS |
| Forced child-process recovery | PASS |
| Native MCP and service shared database | PASS |
| Live duplicate idempotency | PASS |
| Offline pending-work recovery | PASS |

The SYS-A bridge is now an always-on Windows service. WinSW v2.12.0 x64 was
downloaded from the official release and verified against the owner-approved
SHA-256 before installation. The service and local MCP server share the
ProgramData database; only the elevated installing user receives `Modify`
access to the data directory. Reboot startup remains to be observed during the
final two-system acceptance sequence.

## Security Hardening

- No Azure CLI, default credential chain, client secret, SAS, or connection
  string fallback.
- SDK failures are reduced to stable error codes before persistence or output.
- MCP state-transition errors return fixed messages without caller IDs.
- Raw broker IDs, message IDs, endpoints, certificate paths, and free-form
  SDK exception text are excluded from service logs and status.
- Service XML remains machine-local and must never enter Git or Obsidian.

## Remaining Gates

1. Publish the ProgramData data-directory ACL correction.
2. SYS-B installs from the next exact published revision, uses its attached
   managed identity, and runs all 54 tests.
3. SYS-B sends a reverse reply that the persistent SYS-A service receives.
4. SYS-A and SYS-B complete final reboot and two-system recovery acceptance.
