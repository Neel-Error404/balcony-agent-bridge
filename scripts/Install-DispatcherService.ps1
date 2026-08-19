[CmdletBinding(SupportsShouldProcess)]
param(
    [Parameter(Mandatory)]
    [ValidateSet("SYS-A", "SYS-B")]
    [string] $SystemId,

    [Parameter(Mandatory)]
    [ValidatePattern("^[a-f0-9]{40}$")]
    [string] $ApprovedRevision,

    [Parameter(Mandatory)]
    [string] $WinSwExecutable,

    [Parameter(Mandatory)]
    [ValidatePattern("^[a-f0-9]{64}$")]
    [string] $WinSwExecutableSha256,

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

    [ValidateSet("legacy", "consultation")]
    [string] $DispatcherMode = "legacy",

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
    [int] $MaxOutputBytes = 48000
)

$ErrorActionPreference = "Stop"
$serviceName = "BalconyAgentDispatcher"
$serviceAccount = "NT AUTHORITY\LocalService"
$serviceSidAccount = "NT SERVICE\$serviceName"

if ($env:BALCONY_SYSTEM_ID -ne $SystemId) {
    throw (
        "The installer SystemId must match the process-scoped " +
        "BALCONY_SYSTEM_ID declaration."
    )
}

$principal = New-Object Security.Principal.WindowsPrincipal(
    [Security.Principal.WindowsIdentity]::GetCurrent()
)
if (-not $principal.IsInRole(
    [Security.Principal.WindowsBuiltInRole]::Administrator
)) {
    throw "Installing the dispatcher service requires an elevated PowerShell session."
}

if (Get-Service -Name $serviceName -ErrorAction SilentlyContinue) {
    throw (
        "Dispatcher service '$serviceName' is already installed. " +
        "Remove or deliberately upgrade it before reinstalling."
    )
}

$RepositoryRoot = (Resolve-Path -LiteralPath $RepositoryRoot).Path
$ProjectRegistryPath = (Resolve-Path -LiteralPath $ProjectRegistryPath).Path
$CodexExecutable = (Resolve-Path -LiteralPath $CodexExecutable).Path
$CodexCodeModeHostExecutable = (
    Resolve-Path -LiteralPath $CodexCodeModeHostExecutable
).Path
$GitExecutable = (Resolve-Path -LiteralPath $GitExecutable).Path
$NodeExecutable = (Resolve-Path -LiteralPath $NodeExecutable).Path
$WinSwExecutable = (Resolve-Path -LiteralPath $WinSwExecutable).Path

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
$databasePath = Join-Path $BridgeDataDirectory "bridge.sqlite3"

foreach ($path in @(
    $dispatcherEntrypoint,
    $serviceTemplate,
    $databasePath
)) {
    if (-not (Test-Path -LiteralPath $path -PathType Leaf)) {
        throw "Required file does not exist: $path"
    }
}

foreach ($pin in @(
    @($WinSwExecutable, $WinSwExecutableSha256, "WinSW"),
    @($CodexExecutable, $CodexExecutableSha256, "Codex"),
    @(
        $CodexCodeModeHostExecutable,
        $CodexCodeModeHostExecutableSha256,
        "Codex code-mode host"
    ),
    @($GitExecutable, $GitExecutableSha256, "Git")
)) {
    $actualHash = (Get-FileHash -Algorithm SHA256 -LiteralPath $pin[0]).Hash
    if ($actualHash -ne $pin[1]) {
        throw "$($pin[2]) executable does not match the approved SHA-256."
    }
}

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

$registry = Get-Content -Raw -LiteralPath $ProjectRegistryPath | ConvertFrom-Json
if ($registry.schema_version -ne "1.2") {
    throw "The dispatcher project registry must use schema_version 1.2."
}
$enabledProjects = @($registry.projects | Where-Object { $_.enabled })
if ($enabledProjects.Count -ne 1) {
    throw "Initial unattended activation requires exactly one enabled project."
}
if ($enabledProjects[0].key -ne "balcony-agent-bridge") {
    throw "Initial unattended activation is limited to balcony-agent-bridge."
}
if (-not $enabledProjects[0].peer_readable) {
    throw "The enabled project must explicitly set peer_readable to true."
}
if (
    $enabledProjects[0].evidence.provider -ne "pinned_git" -or
    $enabledProjects[0].evidence.revision -ne $ApprovedRevision
) {
    throw "The enabled project must pin Git evidence to ApprovedRevision."
}

$registeredProjectRoot = (
    Resolve-Path -LiteralPath $enabledProjects[0].path
).Path
if ($registeredProjectRoot -ne $RepositoryRoot) {
    throw "The enabled project path must equal the approved release checkout."
}
$registryRelativePath = [IO.Path]::GetRelativePath(
    $RepositoryRoot,
    $ProjectRegistryPath
)
if (
    $registryRelativePath -ne ".." -and
    -not $registryRelativePath.StartsWith("..\")
) {
    throw "The machine-local project registry must remain outside Git."
}

$forbiddenFiles = [System.Collections.Generic.List[string]]::new()
$directories = [System.Collections.Generic.Stack[IO.DirectoryInfo]]::new()
$directories.Push((Get-Item -LiteralPath $RepositoryRoot))
while ($directories.Count -gt 0) {
    $directory = $directories.Pop()
    foreach ($file in $directory.EnumerateFiles()) {
        if (
            $file.Name -in @(".env", "auth.json", "vms.yaml") -or
            $file.Extension -in @(".pfx", ".p12", ".key")
        ) {
            $forbiddenFiles.Add($file.FullName)
        }
    }
    foreach ($child in $directory.EnumerateDirectories()) {
        if ($child.Name -notin @(".git", "node_modules", "dist")) {
            $directories.Push($child)
        }
    }
}
if ($forbiddenFiles.Count -gt 0) {
    throw "The approved project tree contains a forbidden secret-bearing filename."
}

$serviceDirectory = Join-Path $InstallRoot "service"
$binaryDirectory = Join-Path $InstallRoot "bin"
$logDirectory = Join-Path $InstallRoot "logs"
$workDirectory = Join-Path $InstallRoot "work"
$codexHome = Join-Path $InstallRoot "codex-home"
$serviceExecutable = Join-Path $serviceDirectory "$serviceName.exe"
$serviceConfiguration = Join-Path $serviceDirectory "$serviceName.xml"
$installedCodexExecutable = Join-Path $binaryDirectory "codex.exe"
$installedCodexCodeModeHost = Join-Path $binaryDirectory "codex-code-mode-host.exe"

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

if ($PSCmdlet.ShouldProcess(
    $serviceDirectory,
    "Install the restricted Balcony Agent Dispatcher Windows service"
)) {
    New-Item -ItemType Directory -Force -Path @(
        $serviceDirectory,
        $binaryDirectory,
        $logDirectory,
        $workDirectory,
        $codexHome
    ) | Out-Null

    Copy-Item -LiteralPath $WinSwExecutable `
        -Destination $serviceExecutable -Force
    Copy-Item -LiteralPath $CodexExecutable `
        -Destination $installedCodexExecutable -Force
    Copy-Item -LiteralPath $CodexCodeModeHostExecutable `
        -Destination $installedCodexCodeModeHost -Force
    $installedCodexHash = (
        Get-FileHash -Algorithm SHA256 -LiteralPath $installedCodexExecutable
    ).Hash
    if ($installedCodexHash -ne $CodexExecutableSha256) {
        throw "The installed Codex executable failed post-copy verification."
    }
    $installedCodexCodeModeHostHash = (
        Get-FileHash -Algorithm SHA256 `
            -LiteralPath $installedCodexCodeModeHost
    ).Hash
    if (
        $installedCodexCodeModeHostHash -ne
        $CodexCodeModeHostExecutableSha256
    ) {
        throw (
            "The installed Codex code-mode host failed post-copy verification."
        )
    }

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
    Set-Content -LiteralPath $serviceConfiguration `
        -Value $template -Encoding UTF8

    & $serviceExecutable install
    if ($LASTEXITCODE -ne 0) {
        throw "WinSW failed to install the Balcony Agent Dispatcher service."
    }

    & sc.exe sidtype $serviceName unrestricted | Out-Null
    if ($LASTEXITCODE -ne 0) {
        throw "Windows could not enable the dispatcher service SID."
    }
    $accountCommand = (
        'sc.exe config "{0}" obj= "{1}" password= ""' -f
        $serviceName,
        $serviceAccount
    )
    & cmd.exe /d /s /c $accountCommand | Out-Null
    if ($LASTEXITCODE -ne 0) {
        throw "Windows could not assign the restricted LocalService account."
    }
    Set-Service -Name $serviceName -StartupType Manual

    $serviceIdentity = New-Object Security.Principal.NTAccount($serviceSidAccount)
    Add-FileSystemAccessRule -Path $RepositoryRoot `
        -Identity $serviceIdentity -Rights ReadAndExecute
    Add-FileSystemAccessRule -Path $BridgeDataDirectory `
        -Identity $serviceIdentity -Rights Modify
    Add-FileSystemAccessRule -Path $ProjectRegistryPath `
        -Identity $serviceIdentity -Rights Read
    Add-FileSystemAccessRule -Path $serviceDirectory `
        -Identity $serviceIdentity -Rights ReadAndExecute
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

    Write-Output (
        "Installed $serviceName in Manual mode. Authenticate the dedicated " +
        "Codex home and complete foreground/service acceptance before enabling startup."
    )
}
