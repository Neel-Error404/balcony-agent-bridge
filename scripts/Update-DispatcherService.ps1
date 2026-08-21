[CmdletBinding(SupportsShouldProcess)]
param(
    [Parameter(Mandatory)]
    [ValidateSet("SYS-A", "SYS-B")]
    [string] $SystemId,

    [Parameter(Mandatory)]
    [ValidatePattern("^[a-f0-9]{40}$")]
    [string] $ApprovedRevision,

    [Parameter(Mandatory)]
    [string] $ProjectRegistryPath,

    [Parameter(Mandatory)]
    [string] $CodexExecutable,

    [Parameter(Mandatory)]
    [ValidatePattern("^[a-f0-9]{64}$")]
    [string] $CodexExecutableSha256,

    [Parameter(Mandatory)]
    [string] $CodexCodeModeHostExecutable,

    [Parameter(Mandatory)]
    [ValidatePattern("^[a-f0-9]{64}$")]
    [string] $CodexCodeModeHostExecutableSha256,

    [Parameter(Mandatory)]
    [string] $GitExecutable,

    [Parameter(Mandatory)]
    [ValidatePattern("^[a-f0-9]{64}$")]
    [string] $GitExecutableSha256,

    [Parameter(Mandatory)]
    [ValidateSet("consultation")]
    [string] $DispatcherMode,

    [Parameter(Mandatory)]
    [datetimeoffset] $NotBeforeUtc,

    [string] $RepositoryRoot = (
        Resolve-Path (Join-Path $PSScriptRoot "..")
    ),

    [string] $NodeExecutable = (
        (Get-Command node -ErrorAction Stop).Source
    ),

    [string] $InstallRoot = (
        Join-Path $env:ProgramData "Balcony\AgentDispatcher"
    ),

    [string] $BridgeDataDirectory = (
        Join-Path $env:ProgramData "Balcony\AgentBridge\data"
    ),

    [ValidateRange(250, 60000)]
    [int] $PollIntervalMs = 2000,

    [ValidateRange(30, 600)]
    [int] $DefaultTimeoutSeconds = 300,

    [ValidateRange(1024, 60000)]
    [int] $MaxOutputBytes = 48000,

    [ValidateRange(1, 120)]
    [int] $ServiceStopTimeoutSeconds = 30,

    [ValidateRange(1, 120)]
    [int] $ServiceStartTimeoutSeconds = 30,

    [ValidateRange(1, 5)]
    [int] $ServiceStartMaxAttempts = 3,

    [ValidateRange(0, 10000)]
    [int] $ServiceRetryDelayMs = 1000
)

$ErrorActionPreference = "Stop"
$serviceName = "BalconyAgentDispatcher"
$serviceAccount = "NT AUTHORITY\LocalService"
$serviceSidAccount = "NT SERVICE\$serviceName"
$registryMigrationModule = Join-Path (
    $PSScriptRoot
) "DispatcherRegistryMigration.psm1"
$serviceLifecycleModule = Join-Path (
    $PSScriptRoot
) "DispatcherServiceLifecycle.psm1"
Import-Module -Force -Name $registryMigrationModule
Import-Module -Force -Name $serviceLifecycleModule
$serviceAdapter = New-DispatcherServiceAdapter

function Assert-ContainedPath {
    param(
        [Parameter(Mandatory)] [string] $Parent,
        [Parameter(Mandatory)] [string] $Child
    )

    $parentPath = [IO.Path]::GetFullPath($Parent).TrimEnd('\') + '\'
    $childPath = [IO.Path]::GetFullPath($Child)
    if (-not $childPath.StartsWith(
        $parentPath,
        [StringComparison]::OrdinalIgnoreCase
    )) {
        throw "The upgrade path is outside the dispatcher install root."
    }
}

function Assert-FileHash {
    param(
        [Parameter(Mandatory)] [string] $Path,
        [Parameter(Mandatory)] [string] $ExpectedSha256,
        [Parameter(Mandatory)] [string] $Label
    )

    $actual = (Get-FileHash -Algorithm SHA256 -LiteralPath $Path).Hash
    if ($actual -ne $ExpectedSha256) {
        throw "$Label does not match the approved SHA-256."
    }
}

function Add-FileSystemAccessRule {
    param(
        [Parameter(Mandatory)] [string] $Path,
        [Parameter(Mandatory)] [Security.Principal.IdentityReference] $Identity,
        [Parameter(Mandatory)] [Security.AccessControl.FileSystemRights] $Rights
    )

    $acl = Get-Acl -LiteralPath $Path
    $inheritance = if (Test-Path -LiteralPath $Path -PathType Container) {
        [Security.AccessControl.InheritanceFlags]::ContainerInherit -bor
        [Security.AccessControl.InheritanceFlags]::ObjectInherit
    }
    else {
        [Security.AccessControl.InheritanceFlags]::None
    }
    $acl.SetAccessRule((New-Object Security.AccessControl.FileSystemAccessRule(
        $Identity,
        $Rights,
        $inheritance,
        [Security.AccessControl.PropagationFlags]::None,
        [Security.AccessControl.AccessControlType]::Allow
    )))
    Set-Acl -LiteralPath $Path -AclObject $acl
}

function Backup-DispatcherAclSnapshot {
    param(
        [Parameter(Mandatory)] [string[]] $Paths,
        [Parameter(Mandatory)] [string] $Destination
    )

    $snapshot = @(
        $Paths |
            Select-Object -Unique |
            ForEach-Object {
                $resolvedPath = (Resolve-Path -LiteralPath $_).Path
                [pscustomobject]@{
                    path = $resolvedPath
                    sddl = (Get-Acl -LiteralPath $resolvedPath).Sddl
                }
            }
    )
    $snapshot | ConvertTo-Json -Depth 3 | Set-Content `
        -LiteralPath $Destination -Encoding UTF8
}

function Restore-DispatcherAclSnapshot {
    param([Parameter(Mandatory)] [string] $Path)

    $snapshot = @(Get-Content -Raw -LiteralPath $Path | ConvertFrom-Json)
    foreach ($entry in $snapshot) {
        $acl = Get-Acl -LiteralPath $entry.path
        $acl.SetSecurityDescriptorSddlForm([string] $entry.sddl)
        Set-Acl -LiteralPath $entry.path -AclObject $acl
    }
}

function Assert-DispatcherAclSnapshot {
    param([Parameter(Mandatory)] [string] $Path)

    $snapshot = @(Get-Content -Raw -LiteralPath $Path | ConvertFrom-Json)
    foreach ($entry in $snapshot) {
        $actual = (Get-Acl -LiteralPath $entry.path).Sddl
        if ($actual -ne [string] $entry.sddl) {
            throw "A dispatcher ACL did not match the retained rollback snapshot."
        }
    }
}

function Get-DispatcherFailureSnapshot {
    try {
        return Get-DispatcherServiceSnapshot `
            -ServiceName $serviceName -Adapter $serviceAdapter
    }
    catch {
        return [pscustomobject]@{
            State = "Unknown"
            StartMode = "Unknown"
            ProcessId = 0
            ChildProcessIds = @()
            ChildCount = 0
        }
    }
}

if ($env:BALCONY_SYSTEM_ID -ne $SystemId) {
    throw (
        "The upgrade SystemId must match the process-scoped " +
        "BALCONY_SYSTEM_ID declaration."
    )
}

$principal = New-Object Security.Principal.WindowsPrincipal(
    [Security.Principal.WindowsIdentity]::GetCurrent()
)
if (-not $principal.IsInRole(
    [Security.Principal.WindowsBuiltInRole]::Administrator
)) {
    throw "Upgrading the dispatcher service requires an elevated PowerShell session."
}

$service = Get-CimInstance Win32_Service -Filter "Name='$serviceName'"
if (-not $service) {
    throw "Dispatcher service '$serviceName' is not installed."
}
if ($service.StartName -ne $serviceAccount) {
    throw "The installed dispatcher does not use the approved LocalService account."
}
$sidType = (& sc.exe qsidtype $serviceName | Out-String)
if ($LASTEXITCODE -ne 0 -or $sidType -notmatch "UNRESTRICTED") {
    throw "The installed dispatcher must have an unrestricted unique service SID."
}

$RepositoryRoot = (Resolve-Path -LiteralPath $RepositoryRoot).Path
$ProjectRegistryPath = (Resolve-Path -LiteralPath $ProjectRegistryPath).Path
$CodexExecutable = (Resolve-Path -LiteralPath $CodexExecutable).Path
$CodexCodeModeHostExecutable = (
    Resolve-Path -LiteralPath $CodexCodeModeHostExecutable
).Path
$GitExecutable = (Resolve-Path -LiteralPath $GitExecutable).Path
$NodeExecutable = (Resolve-Path -LiteralPath $NodeExecutable).Path
$InstallRoot = [IO.Path]::GetFullPath($InstallRoot)
$BridgeDataDirectory = (
    Resolve-Path -LiteralPath $BridgeDataDirectory
).Path

if (
    (Split-Path -Parent $CodexExecutable) -ne
    (Split-Path -Parent $CodexCodeModeHostExecutable)
) {
    throw "Codex and its code-mode host must come from the same package directory."
}
if (
    (Split-Path -Leaf $CodexCodeModeHostExecutable) -ne
    "codex-code-mode-host.exe"
) {
    throw "The Codex companion must be named codex-code-mode-host.exe."
}

$dispatcherEntrypoint = Join-Path $RepositoryRoot "dist\dispatcher\index.js"
$serviceTemplate = Join-Path (
    $RepositoryRoot
) "service\balcony-agent-dispatcher.xml.template"
$serviceDirectory = Join-Path $InstallRoot "service"
$binaryDirectory = Join-Path $InstallRoot "bin"
$logDirectory = Join-Path $InstallRoot "logs"
$workDirectory = Join-Path $InstallRoot "work"
$codexHome = Join-Path $InstallRoot "codex-home"
$serviceConfiguration = Join-Path $serviceDirectory "$serviceName.xml"
$installedCodexExecutable = Join-Path $binaryDirectory "codex.exe"
$installedCodexCodeModeHost = Join-Path (
    $binaryDirectory
) "codex-code-mode-host.exe"
$databasePath = Join-Path $BridgeDataDirectory "bridge.sqlite3"

foreach ($requiredPath in @(
    $dispatcherEntrypoint,
    $serviceTemplate,
    $serviceConfiguration,
    $installedCodexExecutable,
    $databasePath
)) {
    if (-not (Test-Path -LiteralPath $requiredPath -PathType Leaf)) {
        throw "Required dispatcher upgrade file does not exist: $requiredPath"
    }
}
if (-not (Test-Path -LiteralPath $codexHome -PathType Container)) {
    throw "The dedicated dispatcher CODEX_HOME must already exist."
}

Assert-FileHash -Path $CodexExecutable `
    -ExpectedSha256 $CodexExecutableSha256 -Label "Codex executable"
Assert-FileHash -Path $CodexCodeModeHostExecutable `
    -ExpectedSha256 $CodexCodeModeHostExecutableSha256 `
    -Label "Codex code-mode host"
Assert-FileHash -Path $GitExecutable `
    -ExpectedSha256 $GitExecutableSha256 -Label "Git executable"

$head = (& $GitExecutable -C $RepositoryRoot rev-parse HEAD).Trim()
if ($LASTEXITCODE -ne 0 -or $head -ne $ApprovedRevision) {
    throw "Repository HEAD does not match ApprovedRevision."
}
$worktreeStatus = (& $GitExecutable -C $RepositoryRoot status --porcelain)
if ($LASTEXITCODE -ne 0) {
    throw "Git could not verify the dispatcher release worktree."
}
if ($worktreeStatus) {
    throw "The dispatcher release worktree must be clean."
}

if (Test-CanonicalPathContained `
    -Parent $RepositoryRoot `
    -Child $ProjectRegistryPath
) {
    throw "The machine-local project registry must remain outside Git."
}
$currentRegistryJson = Get-Content -Raw -LiteralPath $ProjectRegistryPath
$registry = $currentRegistryJson | ConvertFrom-Json
if ($registry.schema_version -ne "1.2") {
    throw "The dispatcher project registry must use schema_version 1.2."
}
$enabledProjects = @($registry.projects | Where-Object { $_.enabled })
if ($enabledProjects.Count -lt 1) {
    throw "The dispatcher upgrade requires at least one enabled project."
}
foreach ($project in $enabledProjects) {
    if (-not $project.peer_readable) {
        throw "Every enabled project must explicitly be peer-readable."
    }
    if (
        $project.evidence.provider -ne "pinned_git" -or
        $project.evidence.revision -notmatch "^[a-f0-9]{40}$"
    ) {
        throw "Every enabled project must use a pinned Git evidence revision."
    }
    if (-not (Test-Path -LiteralPath $project.path -PathType Container)) {
        throw "An enabled project path is not accessible."
    }
}
$bridgeProject = @(
    $enabledProjects | Where-Object { $_.key -eq "balcony-agent-bridge" }
)
if ($bridgeProject.Count -ne 1) {
    throw "The upgrade requires exactly one balcony-agent-bridge project entry."
}
$currentBridgeRepositoryRoot = (
    Resolve-Path -LiteralPath $bridgeProject[0].path
).Path
$currentBridgeRevision = (
    & $GitExecutable -C $currentBridgeRepositoryRoot rev-parse HEAD
).Trim()
if (
    $LASTEXITCODE -ne 0 -or
    $currentBridgeRevision -notmatch "^[a-f0-9]{40}$"
) {
    throw "Git could not resolve the currently deployed bridge revision."
}
$currentBridgeWorktreeStatus = (
    & $GitExecutable -C $currentBridgeRepositoryRoot status --porcelain
)
if ($LASTEXITCODE -ne 0) {
    throw "Git could not verify the currently deployed bridge checkout."
}
if ($currentBridgeWorktreeStatus) {
    throw "The currently deployed bridge checkout must be clean."
}
$desiredRegistryJson = Get-DispatcherRegistryMigrationJson `
    -RegistryJson $currentRegistryJson `
    -CurrentRepositoryRoot $currentBridgeRepositoryRoot `
    -CurrentRevision $currentBridgeRevision `
    -DesiredRepositoryRoot $RepositoryRoot `
    -DesiredRevision $ApprovedRevision

$template = Get-Content -Raw -LiteralPath $serviceTemplate
$replacements = @{
    "__NODE_EXECUTABLE__" = $NodeExecutable
    "__DISPATCHER_ENTRYPOINT__" = $dispatcherEntrypoint
    "__WORKING_DIRECTORY__" = $workDirectory
    "__SYSTEM_ID__" = $SystemId
    "__DATABASE_PATH__" = $databasePath
    "__PROJECT_REGISTRY_PATH__" = $ProjectRegistryPath
    "__CODEX_EXECUTABLE__" = $installedCodexExecutable
    "__CODEX_EXECUTABLE_SHA256__" = $CodexExecutableSha256
    "__CODEX_CODE_MODE_HOST_EXECUTABLE__" = $installedCodexCodeModeHost
    "__CODEX_CODE_MODE_HOST_SHA256__" = (
        $CodexCodeModeHostExecutableSha256
    )
    "__CODEX_HOME__" = $codexHome
    "__TRUSTED_PATH__" = (
        (Split-Path -Parent $NodeExecutable) + ";" +
        "$env:SystemRoot\System32;$env:SystemRoot"
    )
    "__POLL_INTERVAL_MS__" = $PollIntervalMs.ToString()
    "__DEFAULT_TIMEOUT_SECONDS__" = $DefaultTimeoutSeconds.ToString()
    "__MAX_OUTPUT_BYTES__" = $MaxOutputBytes.ToString()
    "__NOT_BEFORE_UTC__" = $NotBeforeUtc.ToUniversalTime().ToString("o")
    "__DISPATCHER_MODE__" = $DispatcherMode
    "__GIT_EXECUTABLE__" = $GitExecutable
    "__GIT_EXECUTABLE_SHA256__" = $GitExecutableSha256
    "__LOG_PATH__" = $logDirectory
}
foreach ($replacement in $replacements.GetEnumerator()) {
    $template = $template.Replace(
        $replacement.Key,
        [Security.SecurityElement]::Escape($replacement.Value)
    )
}

$backupDirectory = Join-Path (
    $InstallRoot
) ("upgrade-backup-" + [guid]::NewGuid().ToString("N"))
Assert-ContainedPath -Parent $InstallRoot -Child $backupDirectory
$backupConfiguration = Join-Path $backupDirectory "$serviceName.xml"
$backupCodexExecutable = Join-Path $backupDirectory "codex.exe"
$backupCodexCodeModeHost = Join-Path (
    $backupDirectory
) "codex-code-mode-host.exe"
$backupProjectRegistry = Join-Path $backupDirectory "projects.json"
$backupAclSnapshot = Join-Path $backupDirectory "acl-snapshot.json"
$hadCodeModeHost = Test-Path -LiteralPath (
    $installedCodexCodeModeHost
) -PathType Leaf
$wasRunning = $service.State -eq "Running"
$originalStartMode = [string] $service.StartMode
$aclProtectedPaths = @(
    $RepositoryRoot,
    $ProjectRegistryPath,
    $BridgeDataDirectory,
    $binaryDirectory,
    $installedCodexExecutable,
    $NodeExecutable,
    $GitExecutable,
    $logDirectory,
    $workDirectory,
    $codexHome
) | Where-Object { Test-Path -LiteralPath $_ }

function Restore-PreviousDispatcherState {
    param([Parameter(Mandatory)] [ref] $Stage)

    $Stage.Value = "rollback-stop-quiescence"
    Stop-DispatcherServiceAndWait `
        -ServiceName $serviceName `
        -Adapter $serviceAdapter `
        -TimeoutSeconds $ServiceStopTimeoutSeconds | Out-Null
    $Stage.Value = "rollback-restore-configuration"
    Copy-Item -LiteralPath $backupConfiguration `
        -Destination $serviceConfiguration -Force
    $Stage.Value = "rollback-restore-codex"
    Copy-Item -LiteralPath $backupCodexExecutable `
        -Destination $installedCodexExecutable -Force
    if ($hadCodeModeHost) {
        $Stage.Value = "rollback-restore-code-mode-host"
        Copy-Item -LiteralPath $backupCodexCodeModeHost `
            -Destination $installedCodexCodeModeHost -Force
    }
    elseif (Test-Path -LiteralPath $installedCodexCodeModeHost -PathType Leaf) {
        $Stage.Value = "rollback-remove-code-mode-host"
        Remove-Item -LiteralPath $installedCodexCodeModeHost -Force
    }
    $Stage.Value = "rollback-restore-registry"
    Restore-DispatcherProjectRegistry `
        -Path $ProjectRegistryPath `
        -BackupPath $backupProjectRegistry
    $Stage.Value = "rollback-restore-acls"
    Restore-DispatcherAclSnapshot -Path $backupAclSnapshot
    if ($wasRunning) {
        $Stage.Value = "rollback-start"
        Start-DispatcherServiceWithRetry `
            -ServiceName $serviceName `
            -Adapter $serviceAdapter `
            -MaxAttempts $ServiceStartMaxAttempts `
            -HealthTimeoutSeconds $ServiceStartTimeoutSeconds `
            -RetryDelayMs $ServiceRetryDelayMs | Out-Null
    }
}

function Assert-RestoredDispatcherState {
    param([Parameter(Mandatory)] [ref] $Stage)

    $Stage.Value = "rollback-verify-configuration"
    Assert-FileHash -Path $serviceConfiguration `
        -ExpectedSha256 (
            Get-FileHash -Algorithm SHA256 -LiteralPath $backupConfiguration
        ).Hash -Label "Restored dispatcher configuration"
    $Stage.Value = "rollback-verify-codex"
    Assert-FileHash -Path $installedCodexExecutable `
        -ExpectedSha256 (
            Get-FileHash -Algorithm SHA256 -LiteralPath $backupCodexExecutable
        ).Hash -Label "Restored Codex executable"
    if ($hadCodeModeHost) {
        $Stage.Value = "rollback-verify-code-mode-host"
        Assert-FileHash -Path $installedCodexCodeModeHost `
            -ExpectedSha256 (
                Get-FileHash `
                    -Algorithm SHA256 `
                    -LiteralPath $backupCodexCodeModeHost
            ).Hash -Label "Restored Codex code-mode host"
    }
    elseif (Test-Path -LiteralPath $installedCodexCodeModeHost -PathType Leaf) {
        throw "Rollback retained an executable that was absent before upgrade."
    }
    $Stage.Value = "rollback-verify-registry"
    Assert-FileHash -Path $ProjectRegistryPath `
        -ExpectedSha256 (
            Get-FileHash -Algorithm SHA256 -LiteralPath $backupProjectRegistry
        ).Hash -Label "Restored dispatcher project registry"
    $Stage.Value = "rollback-verify-acls"
    Assert-DispatcherAclSnapshot -Path $backupAclSnapshot
    $Stage.Value = "rollback-verify-service"
    $snapshot = Get-DispatcherServiceSnapshot `
        -ServiceName $serviceName -Adapter $serviceAdapter
    if ($snapshot.StartMode -ne $originalStartMode) {
        throw "Rollback did not preserve the dispatcher service start mode."
    }
    if (
        $wasRunning -and
        (
            $snapshot.State -ne "Running" -or
            $snapshot.ProcessId -eq 0 -or
            $snapshot.ChildCount -ne 1
        )
    ) {
        throw "Rollback did not restore the running one-child dispatcher state."
    }
    if (
        -not $wasRunning -and
        (
            $snapshot.State -ne "Stopped" -or
            $snapshot.ProcessId -ne 0 -or
            $snapshot.ChildCount -ne 0
        )
    ) {
        throw "Rollback did not restore the stopped dispatcher state."
    }
}

if ($PSCmdlet.ShouldProcess(
    $serviceName,
    "Upgrade the existing dispatcher to the approved consultation release"
)) {
    New-Item -ItemType Directory -Path $backupDirectory | Out-Null
    Copy-Item -LiteralPath $serviceConfiguration `
        -Destination $backupConfiguration
    Copy-Item -LiteralPath $installedCodexExecutable `
        -Destination $backupCodexExecutable
    if ($hadCodeModeHost) {
        Copy-Item -LiteralPath $installedCodexCodeModeHost `
            -Destination $backupCodexCodeModeHost
    }
    Backup-DispatcherProjectRegistry `
        -Path $ProjectRegistryPath `
        -BackupPath $backupProjectRegistry
    Backup-DispatcherAclSnapshot `
        -Paths $aclProtectedPaths `
        -Destination $backupAclSnapshot

    $operationStage = "forward-stop-quiescence"
    try {
        Stop-DispatcherServiceAndWait `
            -ServiceName $serviceName `
            -Adapter $serviceAdapter `
            -TimeoutSeconds $ServiceStopTimeoutSeconds | Out-Null
        $operationStage = "forward-install-codex"
        Copy-Item -LiteralPath $CodexExecutable `
            -Destination $installedCodexExecutable -Force
        Copy-Item -LiteralPath $CodexCodeModeHostExecutable `
            -Destination $installedCodexCodeModeHost -Force
        $operationStage = "forward-verify-codex"
        Assert-FileHash -Path $installedCodexExecutable `
            -ExpectedSha256 $CodexExecutableSha256 `
            -Label "Installed Codex executable"
        Assert-FileHash -Path $installedCodexCodeModeHost `
            -ExpectedSha256 $CodexCodeModeHostExecutableSha256 `
            -Label "Installed Codex code-mode host"
        $operationStage = "forward-write-configuration"
        Set-Content -LiteralPath $serviceConfiguration `
            -Value $template -Encoding UTF8
        $operationStage = "forward-write-registry"
        Set-DispatcherProjectRegistry `
            -Path $ProjectRegistryPath `
            -Content $desiredRegistryJson `
            -Confirm:$false

        $operationStage = "forward-apply-acls"
        $serviceIdentity = New-Object Security.Principal.NTAccount(
            $serviceSidAccount
        )
        Add-FileSystemAccessRule -Path $RepositoryRoot `
            -Identity $serviceIdentity -Rights ReadAndExecute
        Add-FileSystemAccessRule -Path $ProjectRegistryPath `
            -Identity $serviceIdentity -Rights Read
        Add-FileSystemAccessRule -Path $BridgeDataDirectory `
            -Identity $serviceIdentity -Rights Modify
        Add-FileSystemAccessRule -Path $binaryDirectory `
            -Identity $serviceIdentity -Rights ReadAndExecute
        Add-FileSystemAccessRule -Path $installedCodexExecutable `
            -Identity $serviceIdentity -Rights ReadAndExecute
        Add-FileSystemAccessRule -Path $installedCodexCodeModeHost `
            -Identity $serviceIdentity -Rights ReadAndExecute
        foreach ($path in @($NodeExecutable, $GitExecutable)) {
            Add-FileSystemAccessRule -Path $path `
                -Identity $serviceIdentity -Rights ReadAndExecute
        }
        foreach ($path in @($logDirectory, $workDirectory, $codexHome)) {
            Add-FileSystemAccessRule -Path $path `
                -Identity $serviceIdentity -Rights Modify
        }

        $operationStage = "forward-start"
        Start-DispatcherServiceWithRetry `
            -ServiceName $serviceName `
            -Adapter $serviceAdapter `
            -MaxAttempts $ServiceStartMaxAttempts `
            -HealthTimeoutSeconds $ServiceStartTimeoutSeconds `
            -RetryDelayMs $ServiceRetryDelayMs | Out-Null
        if (-not $wasRunning) {
            $operationStage = "forward-restore-stopped-state"
            Stop-DispatcherServiceAndWait `
                -ServiceName $serviceName `
                -Adapter $serviceAdapter `
                -TimeoutSeconds $ServiceStopTimeoutSeconds | Out-Null
        }

        Write-Output (
            "Upgraded $serviceName to consultation mode at revision " +
            "$ApprovedRevision. Dedicated CODEX_HOME was preserved and the " +
            "bridge registry pin was atomically migrated. Rollback backup " +
            "retained at $backupDirectory until post-deployment acceptance."
        )
    }
    catch {
        $forwardError = $_
        $forwardFailureStage = $operationStage
        $forwardSnapshot = Get-DispatcherFailureSnapshot
        try {
            Restore-PreviousDispatcherState -Stage ([ref] $operationStage)
            Assert-RestoredDispatcherState -Stage ([ref] $operationStage)
        }
        catch {
            $rollbackError = $_
            $rollbackFailureStage = $operationStage
            $rollbackSnapshot = Get-DispatcherFailureSnapshot
            $forwardSummary = Format-DispatcherServiceFailure `
                -Stage $forwardFailureStage `
                -ErrorRecord $forwardError `
                -Snapshot $forwardSnapshot
            $rollbackSummary = Format-DispatcherServiceFailure `
                -Stage $rollbackFailureStage `
                -ErrorRecord $rollbackError `
                -Snapshot $rollbackSnapshot
            throw (New-Object InvalidOperationException(
                (
                    "Dispatcher upgrade failed and rollback also failed. " +
                    "Forward[$forwardSummary] Rollback[$rollbackSummary] " +
                    "Manual recovery is required; rollback backup retained."
                )
            ))
        }
        $forwardSummary = Format-DispatcherServiceFailure `
            -Stage $forwardFailureStage `
            -ErrorRecord $forwardError `
            -Snapshot $forwardSnapshot
        throw (New-Object InvalidOperationException(
            (
                "Dispatcher upgrade failed. The previous dispatcher state " +
                "was restored. Forward[$forwardSummary] Rollback backup " +
                "retained for acceptance evidence."
            )
        ))
    }
}
