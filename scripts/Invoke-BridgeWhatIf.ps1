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

if ($env:BALCONY_SYSTEM_ID -ne "SYS-A") {
    throw "Azure bridge infrastructure what-if must be initiated from SYS-A."
}

foreach ($path in @($TemplateFile, $ParameterFile)) {
    if (-not (Test-Path -LiteralPath $path -PathType Leaf)) {
        throw "Required deployment file does not exist: $path"
    }
}

az deployment group what-if `
    --resource-group $ResourceGroup `
    --template-file $TemplateFile `
    --parameters "@$ParameterFile" `
    --mode Incremental `
    --no-pretty-print

if ($LASTEXITCODE -ne 0) {
    throw "Azure resource-group what-if failed."
}
