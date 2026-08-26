[CmdletBinding()]
param()

$ErrorActionPreference = "Stop"

$nodeIdPattern = "^(?:SYS-[AB]|[a-z][a-z0-9-]{0,49})$"
if ($env:BALCONY_SYSTEM_ID -notmatch $nodeIdPattern) {
    throw "BALCONY_SYSTEM_ID must be a valid node ID."
}

$authorizedNodeIds = @(
    $env:BALCONY_AUTHORIZED_NODE_IDS -split "," |
        ForEach-Object { $_.Trim() } |
        Where-Object { $_ }
)
if ($authorizedNodeIds.Count -lt 1 -or $authorizedNodeIds.Count -gt 32) {
    throw "BALCONY_AUTHORIZED_NODE_IDS must contain between 1 and 32 node IDs."
}
foreach ($nodeId in $authorizedNodeIds) {
    if ($nodeId -notmatch $nodeIdPattern) {
        throw "BALCONY_AUTHORIZED_NODE_IDS contains an invalid node ID: $nodeId"
    }
}
if (($authorizedNodeIds | Select-Object -Unique).Count -ne $authorizedNodeIds.Count) {
    throw "BALCONY_AUTHORIZED_NODE_IDS must not contain duplicates."
}
if ($authorizedNodeIds -contains $env:BALCONY_SYSTEM_ID) {
    throw "BALCONY_AUTHORIZED_NODE_IDS must contain only remote node IDs."
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
    AuthorizedNodeIds = $authorizedNodeIds
    Node = node --version
    Npm = npm --version
    AzureCloud = $account.cloud
    AzureAccountState = $account.state
    BicepAvailable = $bicepAvailable
}
