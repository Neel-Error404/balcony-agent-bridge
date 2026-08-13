[CmdletBinding(
    SupportsShouldProcess,
    DefaultParameterSetName = "ManagedIdentity"
)]
param(
    [Parameter(Mandatory)]
    [ValidateSet("SYS-A", "SYS-B")]
    [string] $SystemId,

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

$requiredPaths = @(
    $WinSwExecutable,
    $NodeExecutable,
    (Join-Path $RepositoryRoot "dist\bridge\index.js"),
    (Join-Path $RepositoryRoot "service\balcony-agent-bridge.xml.template")
)
if ($PSCmdlet.ParameterSetName -eq "ClientCertificate") {
    $requiredPaths += $AzureClientCertificatePath
}
foreach ($path in $requiredPaths) {
    if (-not (Test-Path -LiteralPath $path -PathType Leaf)) {
        throw "Required file does not exist: $path"
    }
}

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

    $template = Get-Content -LiteralPath (
        Join-Path $RepositoryRoot "service\balcony-agent-bridge.xml.template"
    ) -Raw
    $replacements = @{
        "__NODE_EXECUTABLE__" = $NodeExecutable
        "__BRIDGE_ENTRYPOINT__" = (
            Join-Path $RepositoryRoot "dist\bridge\index.js"
        )
        "__REPOSITORY_ROOT__" = $RepositoryRoot
        "__SYSTEM_ID__" = $SystemId
        "__DATABASE_PATH__" = $databasePath
        "__SERVICEBUS_NAMESPACE__" = $ServiceBusNamespace
        "__TOPIC_NAME__" = $TopicName
        "__SUBSCRIPTION_NAME__" = $subscriptionName
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

    & $serviceExecutable install
    if ($LASTEXITCODE -ne 0) {
        throw "WinSW failed to install the Balcony Agent Bridge service."
    }
}
