[CmdletBinding()]
param(
    [Parameter(Mandatory)]
    [ValidateSet(
        "foundation",
        "component",
        "integration",
        "workflow",
        "recovery",
        "security"
    )]
    [string] $Level
)

$ErrorActionPreference = "Stop"
$repositoryRoot = Resolve-Path (Join-Path $PSScriptRoot "..")

Push-Location $repositoryRoot
try {
    npm run "test:$Level"
    if ($LASTEXITCODE -ne 0) {
        throw "The $Level test level failed."
    }
}
finally {
    Pop-Location
}
