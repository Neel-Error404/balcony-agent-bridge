[CmdletBinding(SupportsShouldProcess)]
param(
    [Parameter(Mandatory)]
    [ValidateSet("Validate", "Stage", "Activate", "Rollback")]
    [string] $Operation,

    [Parameter(Mandatory)]
    [ValidateSet("BalconyAgentBridge")]
    [string] $ServiceId,

    [Parameter(Mandatory)]
    [ValidatePattern('^(?:SYS-[AB]|[a-z][a-z0-9-]{0,49})$')]
    [string] $NodeId,

    [Parameter(Mandatory)] [string] $InstallRoot,
    [Parameter(Mandatory)] [string] $ReleaseRoot,
    [Parameter(Mandatory)]
    [ValidatePattern('^[a-f0-9]{40}$')]
    [string] $ApprovedRevision,
    [Parameter(Mandatory)]
    [ValidatePattern('^[a-f0-9]{64}$')]
    [string] $ApprovedManifestSha256,
    [Parameter(Mandatory)]
    [ValidatePattern('^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$')]
    [string] $DeploymentRunId,
    [Parameter(Mandatory)] [string] $DesiredServiceXmlPath,
    [string] $ReadinessProofPath,
    [string] $PeerStageStatePath,
    [string] $RestoreReadinessProofPath,
    [ValidateRange(1, 120)] [int] $StopTimeoutSeconds = 30,
    [ValidateRange(1, 120)] [int] $StartTimeoutSeconds = 30
)

$ErrorActionPreference = "Stop"
Import-Module -Force (Join-Path $PSScriptRoot "BridgeRuntimeDeployment.psm1")
Invoke-BridgeRuntimeDeployment -Operation $Operation -ServiceId $ServiceId `
    -NodeId $NodeId -InstallRoot $InstallRoot -ReleaseRoot $ReleaseRoot `
    -ApprovedRevision $ApprovedRevision -ApprovedManifestSha256 $ApprovedManifestSha256 `
    -DeploymentRunId $DeploymentRunId `
    -DesiredServiceXmlPath $DesiredServiceXmlPath `
    -ReadinessProofPath $ReadinessProofPath -PeerStageStatePath $PeerStageStatePath `
    -RestoreReadinessProofPath $RestoreReadinessProofPath `
    -StopTimeoutSeconds $StopTimeoutSeconds `
    -StartTimeoutSeconds $StartTimeoutSeconds -WhatIf:$WhatIfPreference
