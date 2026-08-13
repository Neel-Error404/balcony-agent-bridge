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

## Windows Service

The owner-approved WinSW v2.12.0 x64 wrapper is installed machine-locally
after SHA-256 verification. `BalconyAgentBridge` starts automatically and runs
in explicit `client_certificate` mode.

The service uses ProgramData SQLite and log paths. The local MCP server uses
the same SQLite database. The installer grants the elevated installing user
`Modify` access only on the data directory so the MCP process can create WAL
files and enqueue work; service configuration, credentials, and logs remain
outside that writable boundary.

Verified service behavior:

1. Healthy startup and heartbeat.
2. Stop, start, and restart.
3. Automatic replacement after forced child-process termination.
4. Native MCP enqueue followed by automatic Azure delivery.
5. Duplicate idempotency with one durable delivery.
6. Pending work preserved while stopped and delivered after restart.

Never put the private PEM, service XML, Azure identifiers, namespace hostname,
or generated logs in Git or Obsidian.

## Acceptance

SYS-A certificate authentication, topic send, own-subscription receive,
PeekLock completion, durable outbox/inbox processing, atomic claim renewal,
MCP operation, and always-on service recovery are verified. Reboot startup and
the final reverse SYS-B-to-SYS-A reply remain pending.
