[CmdletBinding()]
param(
    [Parameter(Mandatory)]
    [string] $ParameterFile,

    [string] $RequiredNodeId = $env:BALCONY_SYSTEM_ID
)

$ErrorActionPreference = "Stop"
$nodeIdPattern = "^(?:SYS-[AB]|[a-z][a-z0-9-]{0,49})$"

if ($RequiredNodeId -notmatch $nodeIdPattern) {
    throw "RequiredNodeId must identify the node initiating the Azure what-if."
}

if (-not (Test-Path -LiteralPath $ParameterFile -PathType Leaf)) {
    throw "Topology parameter file does not exist: $ParameterFile"
}

$parameters = Get-Content -Raw -LiteralPath $ParameterFile | ConvertFrom-Json
$nodes = @($parameters.parameters.nodes.value)
if ($nodes.Count -lt 1 -or $nodes.Count -gt 32) {
    throw "Topology must contain between 1 and 32 nodes."
}

$subscriptionNamePattern = "^[a-z][a-z0-9-]{0,49}$"
$nodeIds = [Collections.Generic.HashSet[string]]::new(
    [StringComparer]::Ordinal
)
$subscriptionNames = [Collections.Generic.HashSet[string]]::new(
    [StringComparer]::OrdinalIgnoreCase
)
$principalIds = [Collections.Generic.HashSet[string]]::new(
    [StringComparer]::OrdinalIgnoreCase
)

foreach ($node in $nodes) {
    if ($node.nodeId -notmatch $nodeIdPattern) {
        throw "Invalid nodeId in topology: $($node.nodeId)"
    }
    if (-not $nodeIds.Add([string] $node.nodeId)) {
        throw "Duplicate nodeId in topology: $($node.nodeId)"
    }
    if ($node.subscriptionName -notmatch $subscriptionNamePattern) {
        throw "Invalid subscriptionName in topology: $($node.subscriptionName)"
    }
    if (-not $subscriptionNames.Add([string] $node.subscriptionName)) {
        throw "Duplicate subscriptionName in topology: $($node.subscriptionName)"
    }
    $principalId = [guid]::Empty
    if (
        -not [guid]::TryParse([string] $node.principalId, [ref] $principalId) -or
        $principalId -eq [guid]::Empty
    ) {
        throw "Invalid principalId in topology for node: $($node.nodeId)"
    }
    if (-not $principalIds.Add($principalId.ToString())) {
        throw "Duplicate principalId in topology: $($node.principalId)"
    }
}

if (-not $nodeIds.Contains($RequiredNodeId)) {
    throw "The initiating node is not present in the topology inventory."
}

[pscustomobject]@{
    NodeCount = $nodes.Count
    NodeIds = @($nodes | ForEach-Object { $_.nodeId })
}
