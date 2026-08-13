[CmdletBinding()]
param()

$ErrorActionPreference = "Stop"

if ($env:BALCONY_SYSTEM_ID -notin @("SYS-A", "SYS-B")) {
    throw "BALCONY_SYSTEM_ID must be set in this process to SYS-A or SYS-B."
}

$requiredCommands = @("node", "npm", "az")
foreach ($command in $requiredCommands) {
    if (-not (Get-Command $command -ErrorAction SilentlyContinue)) {
        throw "Required command '$command' is unavailable."
    }
}

$account = az account show `
    --query "{state:state,cloud:environmentName}" `
    --output json 2>$null | ConvertFrom-Json

if ($account.state -ne "Enabled") {
    throw "The current Azure account context is not enabled."
}

$bicepAvailable = $true
try {
    az bicep version 2>$null | Out-Null
}
catch {
    $bicepAvailable = $false
}

[pscustomobject]@{
    SystemId = $env:BALCONY_SYSTEM_ID
    Node = node --version
    Npm = npm --version
    AzureCloud = $account.cloud
    AzureAccountState = $account.state
    BicepAvailable = $bicepAvailable
}
