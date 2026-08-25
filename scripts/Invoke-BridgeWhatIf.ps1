[CmdletBinding()]
param(
    [Parameter(Mandatory)]
    [string] $ResourceGroup,

    [Parameter(Mandatory)]
    [string] $ParameterFile,

    [string] $TemplateFile = (
        Join-Path $PSScriptRoot "..\infra\main.bicep"
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

az deployment group what-if `
    --resource-group $ResourceGroup `
    --template-file $TemplateFile `
    --parameters "@$ParameterFile" `
    --mode Incremental `
    --no-pretty-print

if ($LASTEXITCODE -ne 0) {
    throw "Azure resource-group what-if failed."
}
