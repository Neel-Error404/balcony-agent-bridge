# SYS-A Physical Host Authentication

SYS-A is a physical Windows 11 host. The selected identity is a dedicated
certificate-backed Microsoft Entra application. Azure Arc is not used.

## Verified Identity

1. The private PEM is machine-local and outside all repositories and Obsidian.
2. Only the public certificate is registered in Entra.
3. The application has no password credential or client secret.
4. RBAC is limited to topic sender and SYS-A-subscription receiver.
5. The bridge uses explicit `client_certificate` mode.
6. Entra token acquisition and Service Bus send/receive are verified.

The certificate expires on August 13, 2027. Begin rotation by July 14, 2027.
During rotation, append the new public certificate, verify the new private PEM
on SYS-A, update the service configuration, restart and test, then remove the
old public certificate.

## Service Installation Gate

The current session is not elevated and no approved WinSW executable is
available. The owner must:

1. Supply a version-pinned WinSW executable and verified checksum.
2. Open an elevated PowerShell session.
3. Set only process-scoped `BALCONY_SYSTEM_ID=SYS-A`.
4. Run `Install-BridgeService.ps1` with the `ClientCertificate` parameter set
   and machine-local Azure values.
5. Start, stop, restart, and terminate the service process to verify recovery.
6. Confirm the service uses ProgramData SQLite/log paths and emits only stable
   error codes.

Never put the private PEM, service XML, Azure identifiers, namespace hostname,
or generated logs in Git or Obsidian.

## Acceptance

SYS-A certificate authentication, topic send, own-subscription receive,
PeekLock completion, durable outbox/inbox processing, atomic claim renewal,
and MCP operation are verified. Always-on operation and reboot recovery remain
pending until the Windows service is installed.
