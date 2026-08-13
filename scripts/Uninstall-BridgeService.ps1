[CmdletBinding(SupportsShouldProcess)]
param(
    [string] $InstallRoot = (
        Join-Path $env:ProgramData "Balcony\AgentBridge"
    )
)

$ErrorActionPreference = "Stop"
$serviceExecutable = Join-Path (
    Join-Path $InstallRoot "service"
) "BalconyAgentBridge.exe"

if (-not (Test-Path -LiteralPath $serviceExecutable -PathType Leaf)) {
    throw "Installed WinSW service executable was not found."
}

if ($PSCmdlet.ShouldProcess(
    "BalconyAgentBridge",
    "Stop and uninstall the Windows service"
)) {
    & $serviceExecutable stop
    & $serviceExecutable uninstall
    if ($LASTEXITCODE -ne 0) {
        throw "WinSW failed to uninstall the Balcony Agent Bridge service."
    }
}
