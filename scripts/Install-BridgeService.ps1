[CmdletBinding(
    SupportsShouldProcess,
    DefaultParameterSetName = "ManagedIdentity"
)]
param(
    [Parameter(Mandatory)]
    [ValidatePattern("^(?:SYS-[AB]|[a-z][a-z0-9-]{0,49})$")]
    [string] $SystemId,

    [Parameter(Mandatory)]
    [ValidateCount(1, 32)]
    [string[]] $AuthorizedNodeIds,

    [Parameter(Mandatory)]
    [ValidatePattern("^[a-z0-9-]+\.servicebus\.windows\.net$")]
    [string] $ServiceBusNamespace,

    [Parameter(Mandatory, ParameterSetName = "ManagedIdentity")]
    [guid] $ManagedIdentityClientId,

    [Parameter(Mandatory, ParameterSetName = "ClientCertificate")]
    [guid] $AzureTenantId,

    [Parameter(Mandatory, ParameterSetName = "ClientCertificate")]
    [guid] $AzureClientId,

    [Parameter(Mandatory, ParameterSetName = "ClientCertificate")]
    [string] $AzureClientCertificatePath,

    [Parameter(Mandatory)]
    [string] $WinSwExecutable,

    [Parameter(Mandatory)]
    [string] $MessageAuthenticationMembershipPath,

    [Parameter(Mandatory)]
    [string] $MessageAuthenticationSigningKeyPath,

    [string] $RepositoryRoot = (
        Resolve-Path (Join-Path $PSScriptRoot "..")
    ),

    [string] $NodeExecutable = (
        (Get-Command node -ErrorAction Stop).Source
    ),

    [string] $InstallRoot = (
        Join-Path $env:ProgramData "Balcony\AgentBridge"
    ),

    [string] $TopicName = "agent-messages"
)

$ErrorActionPreference = "Stop"

$bridgeServiceSecurityModule = Join-Path $PSScriptRoot "BridgeServiceSecurity.psm1"
if (-not (Test-Path -LiteralPath $bridgeServiceSecurityModule -PathType Leaf)) {
    throw "Runtime integrity validation failed."
}
Import-Module -Force -Name $bridgeServiceSecurityModule

$baseTrustedRuntimeSids = @(
    "S-1-5-18",
    "S-1-5-32-544",
    "S-1-5-80-956008885-3418522649-1831038044-1853292631-2271478464"
)
$runtimeMutationRights = (
    [Security.AccessControl.FileSystemRights]::WriteData -bor
    [Security.AccessControl.FileSystemRights]::AppendData -bor
    [Security.AccessControl.FileSystemRights]::CreateFiles -bor
    [Security.AccessControl.FileSystemRights]::CreateDirectories -bor
    [Security.AccessControl.FileSystemRights]::WriteAttributes -bor
    [Security.AccessControl.FileSystemRights]::WriteExtendedAttributes -bor
    [Security.AccessControl.FileSystemRights]::DeleteSubdirectoriesAndFiles -bor
    [Security.AccessControl.FileSystemRights]::Delete -bor
    [Security.AccessControl.FileSystemRights]::ChangePermissions -bor
    [Security.AccessControl.FileSystemRights]::TakeOwnership
)

function Assert-NoBroadSensitiveCredentialAccess {
    param([Parameter(Mandatory)] [string] $Path)

    Assert-BridgeServiceCredentialAcl `
        -Path $Path `
        -TrustedSids $trustedCredentialSids
}

function Assert-TrustedRuntimeItem {
    param([Parameter(Mandatory)] [string] $Path)

    Assert-BridgeServiceRuntimeItem `
        -Path $Path `
        -TrustedSids $trustedWriteSids `
        -ProhibitedRights $runtimeMutationRights
}

function Assert-TrustedRuntimePath {
    param([Parameter(Mandatory)] [string] $Path)

    Assert-BridgeServiceRuntimePath `
        -Path $Path `
        -TrustedSids $trustedWriteSids `
        -LeafMutationRights $runtimeMutationRights
}

function Assert-TrustedRuntimeTree {
    param([Parameter(Mandatory)] [string] $Path)

    try {
        Assert-TrustedRuntimePath -Path $Path
        $root = Get-Item -LiteralPath $Path
        $directories = [System.Collections.Generic.Stack[IO.DirectoryInfo]]::new()
        if ($root -is [IO.DirectoryInfo]) {
            $directories.Push($root)
        }
        while ($directories.Count -gt 0) {
            $directory = $directories.Pop()
            Assert-TrustedRuntimeItem -Path $directory.FullName
            foreach ($child in $directory.GetFileSystemInfos()) {
                Assert-TrustedRuntimeItem -Path $child.FullName
                if ($child -is [IO.DirectoryInfo]) {
                    $directories.Push($child)
                }
            }
        }
    }
    catch {
        throw "Runtime integrity validation failed."
    }
}

function Assert-NoUntrustedWriteAccess {
    param([Parameter(Mandatory)] [string] $Path)

    Assert-TrustedRuntimePath -Path $Path
}

function Get-InstallerSid {
    try {
        return [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
    }
    catch {
        throw "Runtime integrity validation failed."
    }
}

$nodeIdPattern = "^(?:SYS-[AB]|[a-z][a-z0-9-]{0,49})$"
foreach ($nodeId in $AuthorizedNodeIds) {
    if ($nodeId -notmatch $nodeIdPattern) {
        throw "AuthorizedNodeIds contains an invalid node ID: $nodeId"
    }
}
if (($AuthorizedNodeIds | Select-Object -Unique).Count -ne $AuthorizedNodeIds.Count) {
    throw "AuthorizedNodeIds must not contain duplicates."
}
if ($AuthorizedNodeIds -contains $SystemId) {
    throw "AuthorizedNodeIds must contain only remote node IDs."
}
$authorizedNodeIdsValue = $AuthorizedNodeIds -join ","

if ($env:BALCONY_SYSTEM_ID -ne $SystemId) {
    throw (
        "The installer SystemId must match the process-scoped " +
        "BALCONY_SYSTEM_ID declaration."
    )
}

$principal = New-Object Security.Principal.WindowsPrincipal(
    [Security.Principal.WindowsIdentity]::GetCurrent()
)
if (-not $principal.IsInRole(
    [Security.Principal.WindowsBuiltInRole]::Administrator
)) {
    throw "Installing the bridge service requires an elevated PowerShell session."
}
$installerSid = (
    Get-InstallerSid
)
$trustedWriteSids = @($baseTrustedRuntimeSids + $installerSid)
$trustedCredentialSids = $trustedWriteSids

$RepositoryRoot = (Resolve-Path -LiteralPath $RepositoryRoot).Path
$bridgeEntrypoint = Join-Path $RepositoryRoot "dist\bridge\index.js"
$serviceTemplate = Join-Path $RepositoryRoot "service\balcony-agent-bridge.xml.template"
$distDirectory = Join-Path $RepositoryRoot "dist"
$nodeModulesDirectory = Join-Path $RepositoryRoot "node_modules"

$requiredPaths = @(
    $WinSwExecutable,
    $NodeExecutable,
    $bridgeEntrypoint,
    $serviceTemplate
)
if ($PSCmdlet.ParameterSetName -eq "ClientCertificate") {
    $requiredPaths += $AzureClientCertificatePath
}
foreach ($path in $requiredPaths) {
    if (-not (Test-Path -LiteralPath $path -PathType Leaf)) {
        throw "Required file does not exist: $path"
    }
}
foreach ($path in @($distDirectory, $nodeModulesDirectory)) {
    if (-not (Test-Path -LiteralPath $path -PathType Container)) {
        throw "Required runtime directory does not exist."
    }
}
$NodeExecutable = (Resolve-Path -LiteralPath $NodeExecutable).Path
$WinSwExecutable = (Resolve-Path -LiteralPath $WinSwExecutable).Path

foreach ($path in @(
    $MessageAuthenticationMembershipPath,
    $MessageAuthenticationSigningKeyPath
)) {
    if (-not [IO.Path]::IsPathRooted($path)) {
        throw "Message authentication files must use absolute paths."
    }
    if (-not (Test-Path -LiteralPath $path -PathType Leaf)) {
        throw "Message authentication files must exist and be regular files."
    }
    $item = Get-Item -LiteralPath $path
    if ($item -isnot [IO.FileInfo]) {
        throw "Message authentication files must exist and be regular files."
    }
    if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
        throw "Message authentication files must not be reparse points."
    }
}
$MessageAuthenticationMembershipPath = (
    Resolve-Path -LiteralPath $MessageAuthenticationMembershipPath
).Path
$MessageAuthenticationSigningKeyPath = (
    Resolve-Path -LiteralPath $MessageAuthenticationSigningKeyPath
).Path
if ([string]::Equals(
    $MessageAuthenticationMembershipPath,
    $MessageAuthenticationSigningKeyPath,
    [StringComparison]::OrdinalIgnoreCase
)) {
    throw "Message authentication membership and signing-key paths must be different."
}

Assert-NoBroadSensitiveCredentialAccess -Path $MessageAuthenticationSigningKeyPath
Assert-TrustedRuntimePath -Path $MessageAuthenticationSigningKeyPath
if ($PSCmdlet.ParameterSetName -eq "ClientCertificate") {
    Assert-NoBroadSensitiveCredentialAccess -Path $AzureClientCertificatePath
    Assert-TrustedRuntimePath -Path $AzureClientCertificatePath
}
Assert-NoUntrustedWriteAccess -Path $MessageAuthenticationMembershipPath
Assert-BridgeServiceLocalSystemReadAccess -Path $MessageAuthenticationMembershipPath
Assert-NoUntrustedWriteAccess -Path $RepositoryRoot
Assert-NoUntrustedWriteAccess -Path $NodeExecutable
Assert-NoUntrustedWriteAccess -Path $WinSwExecutable
Assert-TrustedRuntimePath -Path $serviceTemplate
Assert-TrustedRuntimePath -Path $bridgeEntrypoint
Assert-TrustedRuntimePath -Path $NodeExecutable
Assert-TrustedRuntimePath -Path $WinSwExecutable
Assert-TrustedRuntimeTree -Path $distDirectory
Assert-TrustedRuntimeTree -Path $nodeModulesDirectory

$serviceDirectory = Join-Path $InstallRoot "service"
$dataDirectory = Join-Path $InstallRoot "data"
$logDirectory = Join-Path $InstallRoot "logs"
$databasePath = Join-Path $dataDirectory "bridge.sqlite3"
$serviceExecutable = Join-Path $serviceDirectory "BalconyAgentBridge.exe"
$serviceConfiguration = Join-Path $serviceDirectory "BalconyAgentBridge.xml"
$subscriptionName = $SystemId.ToLowerInvariant()
$authEnvironment = if (
    $PSCmdlet.ParameterSetName -eq "ManagedIdentity"
) {
    @(
        '  <env name="BALCONY_AZURE_AUTH_MODE" value="managed_identity" />'
        (
            '  <env name="BALCONY_MANAGED_IDENTITY_CLIENT_ID" ' +
            'value="{0}" />' -f [Security.SecurityElement]::Escape(
                $ManagedIdentityClientId.ToString()
            )
        )
    ) -join [Environment]::NewLine
}
else {
    @(
        '  <env name="BALCONY_AZURE_AUTH_MODE" value="client_certificate" />'
        (
            '  <env name="BALCONY_AZURE_TENANT_ID" value="{0}" />' -f (
                [Security.SecurityElement]::Escape(
                    $AzureTenantId.ToString()
                )
            )
        )
        (
            '  <env name="BALCONY_AZURE_CLIENT_ID" value="{0}" />' -f (
                [Security.SecurityElement]::Escape(
                    $AzureClientId.ToString()
                )
            )
        )
        (
            '  <env name="BALCONY_AZURE_CLIENT_CERTIFICATE_PATH" ' +
            'value="{0}" />' -f [Security.SecurityElement]::Escape(
                (Resolve-Path -LiteralPath $AzureClientCertificatePath).Path
            )
        )
    ) -join [Environment]::NewLine
}

if ($PSCmdlet.ShouldProcess(
    $serviceDirectory,
    "Install the Balcony Agent Bridge Windows service"
)) {
    New-Item -ItemType Directory -Force -Path (
        $serviceDirectory,
        $dataDirectory,
        $logDirectory
    ) | Out-Null
    Assert-TrustedRuntimePath -Path $InstallRoot
    Assert-TrustedRuntimePath -Path $serviceDirectory

    $mcpUser = [Security.Principal.WindowsIdentity]::GetCurrent()
    $dataAcl = Get-Acl -LiteralPath $dataDirectory
    $dataAcl.SetAccessRule(
        (New-Object Security.AccessControl.FileSystemAccessRule(
            $mcpUser.User,
            [Security.AccessControl.FileSystemRights]::Modify,
            (
                [Security.AccessControl.InheritanceFlags]::ContainerInherit -bor
                [Security.AccessControl.InheritanceFlags]::ObjectInherit
            ),
            [Security.AccessControl.PropagationFlags]::None,
            [Security.AccessControl.AccessControlType]::Allow
        ))
    )
    Set-Acl -LiteralPath $dataDirectory -AclObject $dataAcl

    Copy-Item -LiteralPath $WinSwExecutable `
        -Destination $serviceExecutable -Force

    $template = Get-Content -LiteralPath $serviceTemplate -Raw
    $replacements = @{
        "__NODE_EXECUTABLE__" = $NodeExecutable
        "__BRIDGE_ENTRYPOINT__" = (
            Join-Path $RepositoryRoot "dist\bridge\index.js"
        )
        "__REPOSITORY_ROOT__" = $RepositoryRoot
        "__SYSTEM_ID__" = $SystemId
        "__AUTHORIZED_NODE_IDS__" = $authorizedNodeIdsValue
        "__DATABASE_PATH__" = $databasePath
        "__SERVICEBUS_NAMESPACE__" = $ServiceBusNamespace
        "__TOPIC_NAME__" = $TopicName
        "__SUBSCRIPTION_NAME__" = $subscriptionName
        "__MESSAGE_AUTH_MEMBERSHIP_PATH__" = $MessageAuthenticationMembershipPath
        "__MESSAGE_AUTH_SIGNING_KEY_PATH__" = $MessageAuthenticationSigningKeyPath
        "__LOG_PATH__" = $logDirectory
    }
    foreach ($replacement in $replacements.GetEnumerator()) {
        $template = $template.Replace(
            $replacement.Key,
            [Security.SecurityElement]::Escape($replacement.Value)
        )
    }
    $template = $template.Replace(
        "__AUTH_ENVIRONMENT__",
        $authEnvironment
    )
    Set-Content -LiteralPath $serviceConfiguration `
        -Value $template -Encoding UTF8
    Assert-TrustedRuntimePath -Path $serviceDirectory
    Assert-TrustedRuntimePath -Path $serviceExecutable
    Assert-TrustedRuntimePath -Path $serviceConfiguration

    & $serviceExecutable install
    if ($LASTEXITCODE -ne 0) {
        throw "WinSW failed to install the Balcony Agent Bridge service."
    }
}
