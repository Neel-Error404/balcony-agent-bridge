[CmdletBinding(SupportsShouldProcess)]
param(
    [switch] $OwnerApproved,

    [string] $ServiceName = "BalconyAgentDispatcher"
)

$ErrorActionPreference = "Stop"

if (-not $OwnerApproved) {
    throw (
        "OwnerApproved is required after dedicated authentication and live " +
        "request/result acceptance succeed."
    )
}

$principal = New-Object Security.Principal.WindowsPrincipal(
    [Security.Principal.WindowsIdentity]::GetCurrent()
)
if (-not $principal.IsInRole(
    [Security.Principal.WindowsBuiltInRole]::Administrator
)) {
    throw "Enabling dispatcher automatic startup requires elevation."
}

$service = Get-CimInstance Win32_Service -Filter "Name='$ServiceName'"
if (-not $service) {
    throw "Dispatcher service '$ServiceName' is not installed."
}
$expectedAccount = "NT SERVICE\$ServiceName"
if ($service.StartName -ne $expectedAccount) {
    throw "Dispatcher service is not using its restricted virtual account."
}
if ($service.State -ne "Running") {
    throw "Dispatcher service must pass live acceptance and be running first."
}

$children = @(
    Get-CimInstance Win32_Process -Filter "Name='node.exe'" |
        Where-Object { $_.ParentProcessId -eq $service.ProcessId }
)
if ($children.Count -ne 1) {
    throw "Expected exactly one dispatcher service child process."
}

if ($PSCmdlet.ShouldProcess(
    $ServiceName,
    "Enable delayed automatic startup"
)) {
    & sc.exe config $ServiceName start= delayed-auto | Out-Null
    if ($LASTEXITCODE -ne 0) {
        throw "Windows could not enable delayed automatic dispatcher startup."
    }
    Write-Output "$ServiceName is configured for delayed automatic startup."
}
