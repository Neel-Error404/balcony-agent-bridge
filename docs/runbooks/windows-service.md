# Windows Service Runbook

The bridge service uses an owner-supplied, version-pinned WinSW executable.
WinSW is not downloaded, installed, or committed automatically.

## Preconditions

- Local foundation through security tests pass.
- `npm run build` succeeds.
- The approved machine identity and Service Bus RBAC are deployed.
- The Ed25519 node identity and exact local membership policy are prepared as
  described in `docs/message-authentication.md`.
- The WinSW release and checksum are approved.
- PowerShell is elevated for installation.

Azure VMs use the `ManagedIdentity` parameter set with an explicit
user-assigned identity client ID. Physical hosts use the
`ClientCertificate` parameter set only when the owner has approved the
fallback, the certificate is stored outside the repository, and its private
key ACL is restricted to administrators and the Windows service account.

Run `Install-BridgeService.ps1 -WhatIf` before installation. Supply the local
`-SystemId`, the matching topology `-SubscriptionName`, and the bounded remote
`-AuthorizedNodeIds` list explicitly. `-SubscriptionName` defaults to the
lowercase system ID when the topology uses that convention. The
message-authentication membership and signing-key paths are mandatory. The
installer refuses reparse points, broad private-key read ACLs, or runtime
inputs writable outside LocalSystem, Administrators, and TrustedInstaller.
Place the built repository, Node executable, and WinSW binary under an
administrator-controlled path; never run a LocalSystem service from a
developer-writable checkout. The real installation writes only to the
machine-local ProgramData directory and registers the `BalconyAgentBridge`
service.

For an Azure worker using an approved user-assigned managed identity, prepare
the complete parameter set in an elevated PowerShell session. Replace every
path with an absolute path in an administrator-controlled durable runtime,
never a temporary npm consumer or developer-writable checkout:

```powershell
$env:BALCONY_SYSTEM_ID = "build-node"
$identityRoot = "$env:LOCALAPPDATA\Balcony\AgentBridge\build-node-identity"
$install = @{
    SystemId = "build-node"
    SubscriptionName = "bridge-build"
    AuthorizedNodeIds = @("laptop-a", "laptop-b")
    ServiceBusNamespace = "replace-with-approved.servicebus.windows.net"
    ManagedIdentityClientId = "11111111-1111-4111-8111-111111111111"
    WinSwExecutable = "C:\approved\winsw\WinSW-x64.exe"
    MessageAuthenticationMembershipPath = "$identityRoot\membership.json"
    MessageAuthenticationSigningKeyPath = "$identityRoot\node-identity.pkcs8.pem"
    RepositoryRoot = "C:\Program Files\Balcony\AgentBridge\runtime"
}

& "$($install.RepositoryRoot)\scripts\Install-BridgeService.ps1" @install -WhatIf
```

Review the complete preview. Only after separate owner approval, run the same
command without `-WhatIf`. Installation registers the service but does not
start it:

```powershell
& "$($install.RepositoryRoot)\scripts\Install-BridgeService.ps1" @install
Get-Service -Name BalconyAgentBridge
```

Then use the compiled CLI from the same durable runtime to create the MCP
profile with
`--database "$env:ProgramData\Balcony\AgentBridge\data\bridge.sqlite3"`.
Run `doctor` against that profile before starting the service, from a shell
with the same `BALCONY_SYSTEM_ID` and `BALCONY_MESSAGE_AUTH_*` values rendered
for the service. A passing report therefore proves that the membership policy
and signing key can be loaded by an isolated bridge-service validation
invocation, not only that their paths were configured. The general CLI process
does not load the private key.

Start, inspect, and stop are explicit operator actions:

```powershell
Start-Service -Name BalconyAgentBridge
Get-Service -Name BalconyAgentBridge
Stop-Service -Name BalconyAgentBridge
```

For an approved physical host, replace the managed-identity entry in the
splat with all three certificate-mode entries:

```powershell
$install.Remove("ManagedIdentityClientId")
$install.AzureTenantId = "11111111-1111-4111-8111-111111111111"
$install.AzureClientId = "22222222-2222-4222-8222-222222222222"
$install.AzureClientCertificatePath = "C:\ProgramData\Balcony\AgentBridge\credentials\client.pem"
```

Repeat `-WhatIf` and approval after changing identity mode. Never mix the two
parameter sets.

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

## Upgrade Boundary

v0.1 has no supported in-place bridge-service updater or downgrade. Do not
rerun the initial installer over an existing registered service: it is a
fresh-install path, not a transactional update path. A package-only
installation is for local CLI/MCP evaluation and cannot upgrade this source
deployment because it excludes service scripts and templates. Any production
replacement, service re-registration, or rollback needs a separately reviewed
operator procedure. Before such work, quiesce every SQLite writer, preserve the
database and rendered configuration, and retain the prior durable runtime as a
rollback point. A schema-v5 database must not be opened by an older
incompatible runtime.

This installer deploys only the Azure bridge transport worker. Keep the
restricted Codex dispatcher as a separate service so the transport receives
Azure credentials but no Codex credentials, while the dispatcher receives a
dedicated Codex home but no Azure variables. Its manual-first installation and
owner-approved automatic activation are documented in
`docs/runbooks/read-only-dispatcher.md`.
