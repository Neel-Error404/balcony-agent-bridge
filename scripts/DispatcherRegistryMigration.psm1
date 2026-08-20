Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

function Get-CanonicalPath {
    param([Parameter(Mandatory)] [string] $Path)

    $fullPath = [IO.Path]::GetFullPath($Path).Replace('/', '\')
    $root = [IO.Path]::GetPathRoot($fullPath)
    if ($fullPath.Length -gt $root.Length) {
        return $fullPath.TrimEnd('\')
    }
    return $fullPath
}

function Test-CanonicalPathContained {
    param(
        [Parameter(Mandatory)] [string] $Parent,
        [Parameter(Mandatory)] [string] $Child
    )

    $parentPath = Get-CanonicalPath -Path $Parent
    $childPath = Get-CanonicalPath -Path $Child
    if ($childPath.Equals(
        $parentPath,
        [StringComparison]::OrdinalIgnoreCase
    )) {
        return $true
    }
    $parentPrefix = $parentPath
    if (-not $parentPrefix.EndsWith('\')) {
        $parentPrefix += '\'
    }
    return $childPath.StartsWith(
        $parentPrefix,
        [StringComparison]::OrdinalIgnoreCase
    )
}

function Get-DispatcherRegistryMigrationJson {
    param(
        [Parameter(Mandatory)] [string] $RegistryJson,
        [Parameter(Mandatory)] [string] $CurrentRepositoryRoot,
        [Parameter(Mandatory)]
        [ValidatePattern("^[a-f0-9]{40}$")]
        [string] $CurrentRevision,
        [Parameter(Mandatory)] [string] $DesiredRepositoryRoot,
        [Parameter(Mandatory)]
        [ValidatePattern("^[a-f0-9]{40}$")]
        [string] $DesiredRevision
    )

    $registry = $RegistryJson | ConvertFrom-Json
    if ($registry.schema_version -ne "1.2") {
        throw "The dispatcher project registry must use schema_version 1.2."
    }
    $enabledProjects = @($registry.projects | Where-Object { $_.enabled })
    $bridgeProjects = @(
        $enabledProjects |
            Where-Object { $_.key -eq "balcony-agent-bridge" }
    )
    if ($bridgeProjects.Count -ne 1) {
        throw "The upgrade requires exactly one balcony-agent-bridge project entry."
    }
    $bridgeProject = $bridgeProjects[0]
    if (
        -not $bridgeProject.evidence -or
        $bridgeProject.evidence.provider -ne "pinned_git"
    ) {
        throw "The current bridge project must use pinned Git evidence."
    }
    $registeredCurrentRoot = Get-CanonicalPath -Path $bridgeProject.path
    $expectedCurrentRoot = Get-CanonicalPath -Path $CurrentRepositoryRoot
    if (-not $registeredCurrentRoot.Equals(
        $expectedCurrentRoot,
        [StringComparison]::OrdinalIgnoreCase
    )) {
        throw "The bridge registry path does not match the currently deployed checkout."
    }
    if ($bridgeProject.evidence.revision -ne $CurrentRevision) {
        throw "The bridge registry revision does not match the currently deployed checkout."
    }

    $bridgeProject.path = Get-CanonicalPath -Path $DesiredRepositoryRoot
    $bridgeProject.evidence.revision = $DesiredRevision
    return $registry | ConvertTo-Json -Depth 100
}

function Invoke-AtomicFileReplacement {
    param(
        [Parameter(Mandatory)] [string] $Path,
        [Parameter(Mandatory)] [byte[]] $Bytes
    )

    $canonicalPath = Get-CanonicalPath -Path $Path
    if (-not (Test-Path -LiteralPath $canonicalPath -PathType Leaf)) {
        throw "The registry file to replace does not exist."
    }
    $directory = Split-Path -Parent $canonicalPath
    $temporaryPath = Join-Path (
        $directory
    ) ("." + [IO.Path]::GetFileName($canonicalPath) + "." +
        [guid]::NewGuid().ToString("N") + ".tmp")
    $replacementBackupPath = Join-Path (
        $directory
    ) ("." + [IO.Path]::GetFileName($canonicalPath) + "." +
        [guid]::NewGuid().ToString("N") + ".replace-backup")
    try {
        $originalAcl = [IO.File]::GetAccessControl($canonicalPath)
        [IO.File]::WriteAllBytes($temporaryPath, $Bytes)
        [IO.File]::SetAccessControl($temporaryPath, $originalAcl)
        [IO.File]::Replace(
            $temporaryPath,
            $canonicalPath,
            $replacementBackupPath,
            $true
        )
    }
    finally {
        foreach ($cleanupPath in @($temporaryPath, $replacementBackupPath)) {
            if (Test-Path -LiteralPath $cleanupPath -PathType Leaf) {
                Remove-Item -LiteralPath $cleanupPath -Force
            }
        }
    }
}

function Set-DispatcherProjectRegistry {
    [CmdletBinding(SupportsShouldProcess)]
    param(
        [Parameter(Mandatory)] [string] $Path,
        [Parameter(Mandatory)] [string] $Content
    )

    if ($PSCmdlet.ShouldProcess(
        $Path,
        "Atomically migrate only the balcony-agent-bridge registry pin"
    )) {
        $encoding = New-Object Text.UTF8Encoding($false)
        $bytes = $encoding.GetBytes($Content)
        Invoke-AtomicFileReplacement -Path $Path -Bytes $bytes
    }
}

function Backup-DispatcherProjectRegistry {
    param(
        [Parameter(Mandatory)] [string] $Path,
        [Parameter(Mandatory)] [string] $BackupPath
    )

    Copy-Item -LiteralPath $Path -Destination $BackupPath
}

function Restore-DispatcherProjectRegistry {
    param(
        [Parameter(Mandatory)] [string] $Path,
        [Parameter(Mandatory)] [string] $BackupPath
    )

    if (-not (Test-Path -LiteralPath $BackupPath -PathType Leaf)) {
        throw "The registry rollback backup does not exist."
    }
    Invoke-AtomicFileReplacement `
        -Path $Path `
        -Bytes ([IO.File]::ReadAllBytes($BackupPath))
}

Export-ModuleMember -Function @(
    "Backup-DispatcherProjectRegistry",
    "Get-DispatcherRegistryMigrationJson",
    "Restore-DispatcherProjectRegistry",
    "Set-DispatcherProjectRegistry",
    "Test-CanonicalPathContained"
)
