[CmdletBinding()]
param(
    [Parameter(Mandatory)]
    [string] $Location,

    [Parameter(Mandatory)]
    [string] $ParameterFile,

    [string] $TemplateFile = (
        Join-Path $PSScriptRoot "..\infra\deploy.bicep"
    )
)

$ErrorActionPreference = "Stop"

foreach ($path in @($TemplateFile, $ParameterFile)) {
    if (-not (Test-Path -LiteralPath $path -PathType Leaf)) {
        throw "Required deployment file does not exist: $path"
    }
}

& (Join-Path $PSScriptRoot "Test-BridgeTopologyParameters.ps1") `
    -ParameterFile $ParameterFile `
    -RequiredNodeId $env:BALCONY_SYSTEM_ID | Out-Null

az deployment sub what-if `
    --location $Location `
    --template-file $TemplateFile `
    --parameters "@$ParameterFile" `
    --no-pretty-print

if ($LASTEXITCODE -ne 0) {
    throw "Azure subscription what-if failed."
}
