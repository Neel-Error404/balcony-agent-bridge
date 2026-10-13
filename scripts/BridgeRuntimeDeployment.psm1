Set-StrictMode -Version Latest
Import-Module -Force (Join-Path $PSScriptRoot "BridgeServiceSecurity.psm1") -ErrorAction Stop

function Assert-RiverContained {
    param([string] $Root, [string] $Path)
    $base = [IO.Path]::GetFullPath($Root).TrimEnd('\', '/') + [IO.Path]::DirectorySeparatorChar
    $full = [IO.Path]::GetFullPath($Path)
    if (-not $full.StartsWith($base, [StringComparison]::OrdinalIgnoreCase)) {
        throw [IO.InvalidDataException]::new("Release path escapes its declared root.")
    }
    return $full
}

function Get-RiverDigest {
    param([string] $Path)
    return (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash.ToLowerInvariant()
}

function Test-RiverFreshProofTime {
    param($Value)
    $text = [string] $Value
    if ($text -cnotmatch '^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,7})?Z$') {
        return $false
    }
    $parsed = [DateTimeOffset]::MinValue
    if (-not [DateTimeOffset]::TryParse(
        $text, [Globalization.CultureInfo]::InvariantCulture,
        [Globalization.DateTimeStyles]::AssumeUniversal, [ref] $parsed
    )) {
        return $false
    }
    $age = [DateTimeOffset]::UtcNow - $parsed
    return ($age.TotalMinutes -ge -2 -and $age.TotalMinutes -le 15)
}

function Assert-RiverNoReparsePath {
    param([string] $Path)
    $current = [IO.Path]::GetFullPath($Path)
    while ($current) {
        if (Test-Path -LiteralPath $current) {
            $item = Get-Item -LiteralPath $current -Force -ErrorAction Stop
            if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
                throw [IO.InvalidDataException]::new("Deployment path contains a reparse point.")
            }
        }
        $parent = Split-Path -Parent $current
        if (-not $parent -or $parent -eq $current) { break }
        $current = $parent
    }
}

function Assert-RiverProtectedPath {
    param([string] $Path)
    $trusted = @(
        "S-1-5-18", "S-1-5-32-544",
        "S-1-5-80-956008885-3418522649-1831038044-1853292631-2271478464",
        [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
    )
    $mutation = (
        [Security.AccessControl.FileSystemRights]::WriteData -bor
        [Security.AccessControl.FileSystemRights]::AppendData -bor
        [Security.AccessControl.FileSystemRights]::CreateFiles -bor
        [Security.AccessControl.FileSystemRights]::CreateDirectories -bor
        [Security.AccessControl.FileSystemRights]::WriteAttributes -bor
        [Security.AccessControl.FileSystemRights]::WriteExtendedAttributes -bor
        [Security.AccessControl.FileSystemRights]::DeleteSubdirectoriesAndFiles -bor
        [Security.AccessControl.FileSystemRights]::Delete -bor
        [Security.AccessControl.FileSystemRights]::ChangePermissions -bor
        [Security.AccessControl.FileSystemRights]::TakeOwnership
    )
    Assert-BridgeServiceRuntimePath -Path $Path -TrustedSids $trusted -LeafMutationRights $mutation
}

function Assert-RiverRuntimeManifest {
    param(
        [string] $ReleaseRoot,
        [string] $ApprovedRevision,
        [string] $ApprovedManifestSha256,
        [string] $ServiceId
    )

    $root = (Resolve-Path -LiteralPath $ReleaseRoot -ErrorAction Stop).Path
    $manifestPath = Join-Path $root "manifest.json"
    Assert-RiverNoReparsePath -Path $manifestPath
    if ((Get-RiverDigest -Path $manifestPath) -cne $ApprovedManifestSha256) {
        throw [IO.InvalidDataException]::new("Runtime manifest differs from ApprovedManifestSha256.")
    }
    $manifest = Get-Content -Raw -LiteralPath $manifestPath -ErrorAction Stop |
        ConvertFrom-Json -ErrorAction Stop
    if (
        $manifest.schema_version -cne "river-runtime-bundle.v1" -or
        $ApprovedRevision -cnotmatch '^[a-f0-9]{40}$' -or
        $manifest.source_revision -cne $ApprovedRevision -or
        $manifest.source_tree -cnotmatch '^[a-f0-9]{40}$' -or
        $manifest.platform -cne "win32" -or
        $manifest.architecture -cne "x64" -or
        $manifest.node_version -cne "22.14.0" -or
        $manifest.codex_version -cne "0.150.1" -or
        $manifest.database_schema_version -ne 9 -or
        (@($manifest.coordination_versions) -join ",") -cne "1.0,1.1"
    ) {
        throw [IO.InvalidDataException]::new("Runtime manifest contract or approved revision mismatch.")
    }
    $seen = [Collections.Generic.HashSet[string]]::new([StringComparer]::OrdinalIgnoreCase)
    foreach ($entry in @($manifest.files)) {
        $relative = [string] $entry.path
        if (
            $relative -cnotmatch '^[a-zA-Z0-9@._+/-]+$' -or
            $relative -match '(^|/)\.\.?(/|$)' -or
            $relative.Contains('\') -or
            $relative -match '(?i)(^|/)(?:\.env(?:\..*)?|[^/]*\.(?:pem|pfx|key|sqlite3?|db)|[^/]*(?:secret|credential|password|token)[^/]*)$' -or
            $relative -notmatch '^(?:runtime/(?:node|codex|codex-code-mode-host)\.exe|(?:dist|node_modules)/[a-zA-Z0-9@._+/-]+|scripts/(?:[a-zA-Z0-9._-]+\.(?:ps1|psm1)|runtime-bundle\.mjs)|service/[a-zA-Z0-9._-]+\.template|package(?:-lock)?\.json|LICENSE|NOTICE)$' -or
            -not $seen.Add($relative)
        ) {
            throw [IO.InvalidDataException]::new("Runtime manifest contains an unsafe or duplicate path.")
        }
        $full = Assert-RiverContained -Root $root -Path (Join-Path $root $relative)
        if (-not (Test-Path -LiteralPath $full -PathType Leaf)) {
            throw [IO.FileNotFoundException]::new("Runtime manifest file is missing.")
        }
        $item = Get-Item -LiteralPath $full -Force
        if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
            throw [IO.InvalidDataException]::new("Runtime manifest cannot reference reparse points.")
        }
        if (
            $entry.length -isnot [long] -and
            $entry.length -isnot [int] -and
            $entry.length -isnot [decimal]
        ) {
            throw [IO.InvalidDataException]::new("Runtime manifest length must be an integer.")
        }
        if (
            $entry.length -lt 0 -or
            $item.Length -ne $entry.length -or
            $entry.sha256 -cnotmatch '^[a-f0-9]{64}$' -or
            (Get-RiverDigest -Path $full) -cne $entry.sha256
        ) {
            throw [IO.InvalidDataException]::new("Runtime file length or digest mismatch.")
        }
        $ancestor = Split-Path -Parent $full
        while ($ancestor -and $ancestor -ne $root) {
            if (((Get-Item -LiteralPath $ancestor -Force).Attributes -band
                [IO.FileAttributes]::ReparsePoint) -ne 0) {
                throw [IO.InvalidDataException]::new("Runtime tree cannot contain reparse points.")
            }
            $ancestor = Split-Path -Parent $ancestor
        }
    }
    $required = @(
        "runtime/node.exe",
        "runtime/codex.exe",
        "runtime/codex-code-mode-host.exe",
        "dist/bridge/index.js",
        "dist/dispatcher/index.js",
        "dist/mcp/index.js",
        "package.json",
        "package-lock.json",
        "LICENSE",
        "service/balcony-agent-bridge.xml.template",
        "service/balcony-agent-dispatcher.xml.template",
        "scripts/runtime-bundle.mjs"
    )
    foreach ($path in $required) {
        if (-not $seen.Contains($path)) {
            throw [IO.InvalidDataException]::new("Runtime manifest lacks a required entrypoint.")
        }
    }
    $actualFiles = @(
        Get-ChildItem -LiteralPath $root -Recurse -File -Force |
            Where-Object { $_.FullName -ne $manifestPath }
    )
    if ($actualFiles.Count -ne $seen.Count) {
        throw [IO.InvalidDataException]::new("Runtime release contains unmanifested files.")
    }
    return [pscustomobject]@{
        Root = $root
        ManifestPath = $manifestPath
        ManifestSha256 = Get-RiverDigest -Path $manifestPath
        Entries = @($manifest.files)
    }
}

function Assert-RiverServiceXml {
    param(
        [string] $Path,
        [string] $ServiceId,
        [string] $NodeId,
        [string] $TargetRoot,
        [object[]] $ManifestEntries
    )
    $content = Get-Content -LiteralPath $Path -Raw -ErrorAction Stop
    if ($content -match '__[A-Z_]+__' -or $content -match '<!DOCTYPE|<!ENTITY') {
        throw [IO.InvalidDataException]::new("Rendered service XML cannot contain templates or entities.")
    }
    try {
        $xml = [xml] $content
    }
    catch {
        throw [IO.InvalidDataException]::new("Rendered service XML is malformed.")
    }
    $allowedElements = @(
        "id", "name", "description", "executable", "arguments",
        "workingdirectory", "startmode", "env", "logpath", "log",
        "onfailure", "resetfailure", "stoptimeout"
    )
    if ($xml.DocumentElement.LocalName -cne "service" -or
        @($xml.DocumentElement.ChildNodes | Where-Object {
            $_ -is [Xml.XmlElement] -and $allowedElements -cnotcontains $_.LocalName
        }).Count -gt 0 -or
        @("id", "executable", "arguments", "workingdirectory" | Where-Object {
            @($xml.DocumentElement.SelectNodes($_)).Count -ne 1
        }).Count -gt 0 -or
        ($ServiceId -eq "BalconyAgentBridge" -and
            $xml.DocumentElement.SelectSingleNode("startmode")) -or
        ($ServiceId -eq "BalconyAgentDispatcher" -and
            $xml.DocumentElement.SelectSingleNode("startmode") -and
            $xml.DocumentElement.SelectSingleNode("startmode").InnerText -cne "Manual")
    ) {
        throw [IO.InvalidDataException]::new("Rendered service XML contains invalid service settings.")
    }
    $entry = if ($ServiceId -eq "BalconyAgentBridge") {
        "dist/bridge/index.js"
    }
    else {
        "dist/dispatcher/index.js"
    }
    $node = Join-Path $TargetRoot "runtime/node.exe"
    $entryPath = Join-Path $TargetRoot $entry
    if (
        $xml.service.id -cne $ServiceId -or
        $xml.service.executable -cne $node -or
        $xml.service.arguments -cne $entryPath -or
        $xml.service.workingdirectory -cne $TargetRoot
    ) {
        throw [IO.InvalidDataException]::new("Rendered service XML has a wrong identity or runtime entrypoint.")
    }
    $environments = @($xml.service.env)
    $names = @($environments | ForEach-Object { [string] $_.name })
    $expectedPeer = if ($NodeId -ceq "SYS-A") { "SYS-B" }
        elseif ($NodeId -ceq "SYS-B") { "SYS-A" }
        else { $null }
    $common = @(
        "BALCONY_SYSTEM_ID", "BALCONY_RUNTIME_SUPERVISION",
        "BALCONY_AUTHORIZED_NODE_IDS", "BALCONY_BRIDGE_DB_PATH"
    )
    $bridgeOnly = @(
        "BALCONY_SERVICEBUS_NAMESPACE", "BALCONY_SERVICEBUS_TOPIC",
        "BALCONY_SERVICEBUS_SUBSCRIPTION", "BALCONY_MESSAGE_AUTH_MODE",
        "BALCONY_MESSAGE_AUTH_MEMBERSHIP_PATH",
        "BALCONY_MESSAGE_AUTH_SIGNING_KEY_PATH",
        "BALCONY_AZURE_AUTH_MODE", "BALCONY_MANAGED_IDENTITY_CLIENT_ID",
        "BALCONY_AZURE_TENANT_ID", "BALCONY_AZURE_CLIENT_ID",
        "BALCONY_AZURE_CLIENT_CERTIFICATE_PATH"
    )
    $dispatcherOnly = @(
        "BALCONY_DISPATCHER_PROJECTS_PATH", "BALCONY_CODEX_EXECUTABLE",
        "BALCONY_CODEX_EXECUTABLE_SHA256",
        "BALCONY_CODEX_CODE_MODE_HOST_EXECUTABLE",
        "BALCONY_CODEX_CODE_MODE_HOST_SHA256",
        "BALCONY_DISPATCHER_CODEX_HOME",
        "BALCONY_DISPATCHER_TRUSTED_PATH",
        "BALCONY_DISPATCHER_POLL_INTERVAL_MS",
        "BALCONY_DISPATCHER_DEFAULT_TIMEOUT_SECONDS",
        "BALCONY_DISPATCHER_MAX_OUTPUT_BYTES",
        "BALCONY_DISPATCHER_NOT_BEFORE_UTC",
        "BALCONY_DISPATCHER_MODE",
        "BALCONY_DISPATCHER_PILOT_CONFIG_PATH",
        "BALCONY_CONSULTATION_WORKING_DIRECTORY",
        "BALCONY_GIT_EXECUTABLE", "BALCONY_GIT_EXECUTABLE_SHA256"
    )
    $allowed = $common + $(if ($ServiceId -eq "BalconyAgentBridge") {
        $bridgeOnly
    } else {
        $dispatcherOnly
    })
    if (
        $content -match '(?i)<\s*(?:serviceaccount|password|username)\b' -or
        (@($names | Where-Object { $_ -eq "BALCONY_SYSTEM_ID" }).Count -ne 1) -or
        (@($environments | Where-Object { $_.name -eq "BALCONY_SYSTEM_ID" })[0].value -cne $NodeId) -or
        (@($names | Where-Object { $_ -eq "BALCONY_RUNTIME_SUPERVISION" }).Count -ne 1) -or
        (@($environments | Where-Object {
            $_.name -eq "BALCONY_RUNTIME_SUPERVISION"
        })[0].value -cne "service_parent") -or
        -not $expectedPeer -or
        (@($names | Where-Object { $_ -eq "BALCONY_AUTHORIZED_NODE_IDS" }).Count -ne 1) -or
        (@($environments | Where-Object {
            $_.name -eq "BALCONY_AUTHORIZED_NODE_IDS"
        })[0].value -cne $expectedPeer) -or
        (@($names | Select-Object -Unique).Count -ne $names.Count) -or
        @($names | Where-Object { $allowed -cnotcontains $_ }).Count -gt 0 -or
        @($environments | Where-Object {
            $_.Attributes.Count -ne 2 -or
            -not $_.HasAttribute("name") -or -not $_.HasAttribute("value")
        }).Count -gt 0
    ) {
        throw [IO.InvalidDataException]::new("Rendered service XML contains invalid environment settings.")
    }
    if ($ServiceId -eq "BalconyAgentDispatcher") {
        foreach ($binding in @(
            @("runtime/codex.exe", "BALCONY_CODEX_EXECUTABLE",
                "BALCONY_CODEX_EXECUTABLE_SHA256"),
            @("runtime/codex-code-mode-host.exe",
                "BALCONY_CODEX_CODE_MODE_HOST_EXECUTABLE",
                "BALCONY_CODEX_CODE_MODE_HOST_SHA256")
        )) {
            $manifestEntry = @($ManifestEntries | Where-Object {
                $_.path -ceq $binding[0]
            })
            $executable = @($environments | Where-Object {
                $_.name -ceq $binding[1]
            })
            $digest = @($environments | Where-Object {
                $_.name -ceq $binding[2]
            })
            if ($manifestEntry.Count -ne 1 -or
                $executable.Count -ne 1 -or $digest.Count -ne 1 -or
                $executable[0].value -cne (Join-Path $TargetRoot $binding[0]) -or
                $digest[0].value -cne $manifestEntry[0].sha256
            ) {
                throw [IO.InvalidDataException]::new(
                    "Dispatcher Codex and companion must bind to the approved bundled runtime and hashes."
                )
            }
        }
    }
    return Get-RiverDigest -Path $Path
}

function New-RiverServiceAdapter {
    return @{
        AssertRuntimePath = { param($Path) Assert-RiverProtectedPath -Path $Path }
        GetSnapshot = {
            param($ServiceId)
            $service = Get-CimInstance Win32_Service -Filter "Name='$ServiceId'" -ErrorAction Stop
            if (-not $service) {
                throw [InvalidOperationException]::new("The declared service is not installed.")
            }
            $sidType = (& sc.exe qsidtype $ServiceId | Out-String)
            if ($LASTEXITCODE -ne 0) {
                throw [InvalidOperationException]::new("Cannot read the installed service SID type.")
            }
            $recovery = (& sc.exe qfailure $ServiceId | Out-String)
            if ($LASTEXITCODE -ne 0) {
                throw [InvalidOperationException]::new("Cannot read the installed service recovery policy.")
            }
            $children = @(
                if ($service.ProcessId -gt 0) {
                    Get-CimInstance Win32_Process -ErrorAction Stop |
                        Where-Object { $_.ParentProcessId -eq $service.ProcessId }
                }
            )
            [pscustomobject]@{
                State = [string] $service.State
                ProcessId = [uint32] $service.ProcessId
                ChildCount = $children.Count
                ChildProcessId = if ($children.Count -eq 1) { [uint32] $children[0].ProcessId } else { 0 }
                ChildCreation = if ($children.Count -eq 1) { [string] $children[0].CreationDate } else { "" }
                ChildExecutable = if ($children.Count -eq 1) { [string] $children[0].ExecutablePath } else { "" }
                ChildCommandLine = if ($children.Count -eq 1) { [string] $children[0].CommandLine } else { "" }
                StartName = [string] $service.StartName
                SidType = [string] $sidType.Trim()
                StartMode = [string] $service.StartMode
                Recovery = [string] $recovery.Trim()
            }
        }
        GetProcessTree = {
            param($RootProcessId)
            $processes = @(Get-CimInstance Win32_Process -ErrorAction Stop)
            $known = [Collections.Generic.HashSet[uint32]]::new()
            [void] $known.Add([uint32] $RootProcessId)
            $result = [Collections.Generic.List[object]]::new()
            # Also discovers children retaining a dead parent's PID during the stop window.
            do {
                $added = $false
                foreach ($process in $processes) {
                    $id = [uint32] $process.ProcessId
                    if (
                        -not ($result | Where-Object { $_.Id -eq $id }) -and
                        ($id -eq $RootProcessId -or $known.Contains([uint32] $process.ParentProcessId))
                    ) {
                        [void] $known.Add($id)
                        $result.Add([pscustomobject]@{
                            Id = $id
                            Creation = [string] $process.CreationDate
                            ParentId = [uint32] $process.ParentProcessId
                        })
                        $added = $true
                    }
                }
            } while ($added)
            return @($result.ToArray())
        }
        ProcessIdentityExists = {
            param($Id, $Creation)
            $process = Get-CimInstance Win32_Process -Filter "ProcessId=$Id" -ErrorAction Stop
            return [bool] ($process -and [string] $process.CreationDate -ceq $Creation)
        }
        Stop = { param($ServiceId) Stop-Service -Name $ServiceId -Force -ErrorAction Stop }
        Start = { param($ServiceId) Start-Service -Name $ServiceId -ErrorAction Stop }
        Sleep = { param($Milliseconds) Start-Sleep -Milliseconds $Milliseconds }
    }
}

function Assert-RiverServiceAdapter {
    param([hashtable] $Adapter)
    foreach ($key in @(
        "AssertRuntimePath", "GetSnapshot", "GetProcessTree",
        "ProcessIdentityExists", "Stop", "Start", "Sleep"
    )) {
        if (-not $Adapter.ContainsKey($key) -or $Adapter[$key] -isnot [scriptblock]) {
            throw [ArgumentException]::new("The service adapter is incomplete.")
        }
    }
}

function Assert-RiverServiceMetadata {
    param($Before, $After)
    foreach ($key in @("StartName", "SidType", "StartMode", "Recovery")) {
        if (
            -not $Before.PSObject.Properties[$key] -or
            -not $After.PSObject.Properties[$key] -or
            [string] $Before.$key -cne [string] $After.$key
        ) {
            throw [InvalidOperationException]::new(
                "The installed service account, SID type, startup, or recovery policy changed."
            )
        }
    }
}

function Stop-RiverTrackedService {
    param(
        [string] $ServiceId,
        [hashtable] $Adapter,
        $Before,
        [int] $TimeoutSeconds
    )
    $tracked = [Collections.Generic.Dictionary[uint32,string]]::new()
    if ($Before.ProcessId -gt 0) {
        foreach ($process in @(& $Adapter.GetProcessTree $Before.ProcessId)) {
            if (-not $process.Creation -or $process.Id -le 0) {
                throw [InvalidOperationException]::new("Process identity proof is incomplete.")
            }
            $tracked[[uint32] $process.Id] = [string] $process.Creation
        }
        if (-not $tracked.ContainsKey([uint32] $Before.ProcessId)) {
            throw [InvalidOperationException]::new("The service wrapper identity was not observed.")
        }
    }
    if ($Before.State -ne "Stopped" -or $Before.ProcessId -gt 0) {
        & $Adapter.Stop $ServiceId
    }
    $polls = [Math]::Ceiling($TimeoutSeconds * 1000 / 250)
    for ($poll = 0; $poll -le $polls; $poll++) {
        if ($Before.ProcessId -gt 0) {
            foreach ($process in @(& $Adapter.GetProcessTree $Before.ProcessId)) {
                $id = [uint32] $process.Id
                if (-not $process.Creation -or $id -le 0) {
                    throw [InvalidOperationException]::new("Process identity proof is incomplete.")
                }
                if ($tracked.ContainsKey($id) -and $tracked[$id] -cne [string] $process.Creation) {
                    throw [InvalidOperationException]::new("Tracked process ID was reused during shutdown.")
                }
                $tracked[$id] = [string] $process.Creation
            }
        }
        $after = & $Adapter.GetSnapshot $ServiceId
        Assert-RiverServiceMetadata -Before $Before -After $after
        $live = $false
        foreach ($identity in $tracked.GetEnumerator()) {
            if (& $Adapter.ProcessIdentityExists $identity.Key $identity.Value) {
                $live = $true
            }
        }
        if (
            $after.State -eq "Stopped" -and
            $after.ProcessId -eq 0 -and
            $after.ChildCount -eq 0 -and
            -not $live
        ) {
            return
        }
        if ($poll -lt $polls) {
            & $Adapter.Sleep 250
        }
    }
    throw [TimeoutException]::new("The service and tracked descendants did not quiesce.")
}

function Assert-RiverDeploymentProof {
    param(
        [string] $ProofPath,
        [string] $PeerStageStatePath,
        [string] $ServiceId,
        [string] $NodeId,
        [string] $Revision,
        [string] $DeploymentRunId,
        [string] $ManifestSha256,
        [string] $XmlSha256
    )
    if (-not $ProofPath -or -not $PeerStageStatePath) {
        throw [InvalidOperationException]::new("Activation requires explicit readiness, backup, and peer stage proofs.")
    }
    $proof = Get-Content -Raw -LiteralPath $ProofPath -ErrorAction Stop |
        ConvertFrom-Json -AsHashtable -DateKind String
    $peer = Get-Content -Raw -LiteralPath $PeerStageStatePath -ErrorAction Stop |
        ConvertFrom-Json -AsHashtable -DateKind String
    $expectedPeerNode = if ($NodeId -ceq "SYS-A") { "SYS-B" }
        elseif ($NodeId -ceq "SYS-B") { "SYS-A" }
        else { $null }
    if (
        $proof['serviceId'] -cne $ServiceId -or
        $proof['nodeId'] -cne $NodeId -or
        $proof['revision'] -cne $Revision -or
        $proof['runId'] -cne $DeploymentRunId -or
        $proof['manifestSha256'] -cne $ManifestSha256 -or
        $proof['xmlSha256'] -cne $XmlSha256 -or
        $proof['operatorReady'] -cne $true -or
        $proof['allWritersQuiesced'] -cne $true -or
        $proof['restoredCopyVerified'] -cne $true -or
        $proof['wirePlanApproved'] -cne $true -or
        -not (Test-RiverFreshProofTime -Value $proof['verifiedAtUtc']) -or
        -not (Test-RiverFreshProofTime -Value $peer['verifiedAtUtc']) -or
        $proof['databaseSchemaVersion'] -ne 9 -or
        ($proof['databaseSchemaVersion'] -isnot [int] -and
            $proof['databaseSchemaVersion'] -isnot [long]) -or
        ($proof['preMigrationSchemaVersion'] -isnot [int] -and
            $proof['preMigrationSchemaVersion'] -isnot [long]) -or
        $proof['preMigrationSchemaVersion'] -lt 1 -or
        $proof['preMigrationSchemaVersion'] -gt 9 -or
        $proof['backupSha256'] -cnotmatch '^[a-f0-9]{64}$' -or
        -not [IO.Path]::IsPathRooted([string] $proof['backupPath']) -or
        -not (Test-Path -LiteralPath $proof['backupPath'] -PathType Leaf) -or
        (Get-RiverDigest -Path $proof['backupPath']) -cne $proof['backupSha256'] -or
        $peer['status'] -cnotin @("staged", "active") -or
        $peer['serviceId'] -cne $ServiceId -or
        $peer['nodeId'] -cne $expectedPeerNode -or
        $peer['revision'] -cne $Revision -or
        $peer['runId'] -cne $DeploymentRunId -or
        $peer['manifestSha256'] -cne $ManifestSha256
    ) {
        throw [InvalidOperationException]::new(
            "Readiness, retained backup, or paired service stage proof does not match the release."
        )
    }
}

function Assert-RiverRollbackProof {
    param(
        [string] $ProofPath,
        [string] $ServiceId,
        [string] $NodeId,
        [string] $Revision,
        [string] $DeploymentRunId,
        [string] $ManifestSha256,
        $OriginalDatabaseSchemaVersion
    )
    if (-not $ProofPath) {
        throw [InvalidOperationException]::new(
            "Rollback requires explicit fresh pre-migration database restoration proof."
        )
    }
    Assert-RiverNoReparsePath -Path $ProofPath
    $proof = Get-Content -Raw -LiteralPath $ProofPath -ErrorAction Stop |
        ConvertFrom-Json -AsHashtable -DateKind String
    if (
        $proof['serviceId'] -cne $ServiceId -or
        $proof['nodeId'] -cne $NodeId -or
        $proof['revision'] -cne $Revision -or
        $proof['runId'] -cne $DeploymentRunId -or
        $proof['manifestSha256'] -cne $ManifestSha256 -or
        -not (Test-RiverFreshProofTime -Value $proof['verifiedAtUtc']) -or
        $proof['allWritersQuiesced'] -cne $true -or
        $proof['restoredCopyVerified'] -cne $true -or
        $proof['restoredPreMigration'] -cne $true -or
        ($proof['restoredDatabaseSchemaVersion'] -isnot [int] -and
            $proof['restoredDatabaseSchemaVersion'] -isnot [long]) -or
        $proof['restoredDatabaseSchemaVersion'] -ne $OriginalDatabaseSchemaVersion -or
        $proof['restoredCopySha256'] -cnotmatch '^[a-f0-9]{64}$' -or
        -not [IO.Path]::IsPathRooted([string] $proof['restoredCopyPath']) -or
        -not (Test-Path -LiteralPath $proof['restoredCopyPath'] -PathType Leaf) -or
        (Get-RiverDigest -Path $proof['restoredCopyPath']) -cne $proof['restoredCopySha256']
    ) {
        throw [InvalidOperationException]::new(
            "Rollback restoration proof is stale, incomplete, or mismatched to the original database schema."
        )
    }
    return $proof
}

function Set-RiverXmlAtomically {
    param([string] $Source, [string] $Destination)
    $temporary = Join-Path (Split-Path -Parent $Destination) (
        ".service-" + [guid]::NewGuid().ToString("N") + ".xml"
    )
    $atomicBackup = "$temporary.previous"
    try {
        Copy-Item -LiteralPath $Source -Destination $temporary -ErrorAction Stop
        [IO.File]::Replace($temporary, $Destination, $atomicBackup)
    }
    finally {
        if (Test-Path -LiteralPath $temporary) {
            Remove-Item -LiteralPath $temporary -Force
        }
        if (Test-Path -LiteralPath $atomicBackup) {
            Remove-Item -LiteralPath $atomicBackup -Force
        }
    }
}

function Invoke-BridgeRuntimeDeployment {
    [CmdletBinding(SupportsShouldProcess)]
    param(
        [Parameter(Mandatory)]
        [ValidateSet("Validate", "Stage", "Activate", "Rollback")]
        [string] $Operation,
        [Parameter(Mandatory)]
        [ValidateSet("BalconyAgentBridge", "BalconyAgentDispatcher")]
        [string] $ServiceId,
        [Parameter(Mandatory)]
        [ValidatePattern('^(?:SYS-[AB]|[a-z][a-z0-9-]{0,49})$')]
        [string] $NodeId,
        [Parameter(Mandatory)] [string] $InstallRoot,
        [Parameter(Mandatory)] [string] $ReleaseRoot,
        [Parameter(Mandatory)] [ValidatePattern('^[a-f0-9]{40}$')]
        [string] $ApprovedRevision,
        [Parameter(Mandatory)] [ValidatePattern('^[a-f0-9]{64}$')]
        [string] $ApprovedManifestSha256,
        [Parameter(Mandatory)]
        [ValidatePattern('^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$')]
        [string] $DeploymentRunId,
        [Parameter(Mandatory)] [string] $DesiredServiceXmlPath,
        [string] $ReadinessProofPath,
        [string] $PeerStageStatePath,
        [string] $RestoreReadinessProofPath,
        [hashtable] $ServiceAdapter,
        [ValidateRange(1, 120)] [int] $StopTimeoutSeconds = 30,
        [ValidateRange(1, 120)] [int] $StartTimeoutSeconds = 30
    )

    $ErrorActionPreference = "Stop"
    if ($env:BALCONY_SYSTEM_ID -ne $NodeId) {
        throw [InvalidOperationException]::new("Declared NodeId does not match BALCONY_SYSTEM_ID.")
    }
    $install = [IO.Path]::GetFullPath($InstallRoot)
    Assert-RiverNoReparsePath -Path $install
    if (-not (Test-Path -LiteralPath $install -PathType Container)) {
        throw [IO.DirectoryNotFoundException]::new("Explicit install root must already exist.")
    }
    $target = Join-Path $install "releases/$ApprovedRevision"
    $release = Assert-RiverRuntimeManifest -ReleaseRoot $ReleaseRoot `
        -ApprovedRevision $ApprovedRevision -ApprovedManifestSha256 $ApprovedManifestSha256 `
        -ServiceId $ServiceId
    $installPrefix = $install.TrimEnd('\', '/') + [IO.Path]::DirectorySeparatorChar
    $releasePrefix = $release.Root.TrimEnd('\', '/') + [IO.Path]::DirectorySeparatorChar
    if ($release.Root -eq $install -or
        $release.Root.StartsWith($installPrefix, [StringComparison]::OrdinalIgnoreCase) -or
        $install.StartsWith($releasePrefix, [StringComparison]::OrdinalIgnoreCase)
    ) {
        throw [IO.InvalidDataException]::new("Release and install roots must not overlap.")
    }
    $xmlDigest = Assert-RiverServiceXml -Path $DesiredServiceXmlPath `
        -ServiceId $ServiceId -NodeId $NodeId -TargetRoot $target `
        -ManifestEntries $release.Entries

    if ($Operation -eq "Validate") {
        return [pscustomobject]@{
            status = "validated"; revision = $ApprovedRevision
            serviceId = $ServiceId; runId = $DeploymentRunId
            manifestSha256 = $release.ManifestSha256
            xmlSha256 = $xmlDigest
        }
    }
    if ($Operation -eq "Stage") {
        $releaseParent = Join-Path $install "releases"
        $statePath = Join-Path $releaseParent "$ApprovedRevision.$ServiceId.state.json"
        foreach ($path in @($releaseParent, $target, $statePath)) {
            [void] (Assert-RiverContained -Root $install -Path $path)
            Assert-RiverNoReparsePath -Path $path
        }
        if (Test-Path -LiteralPath $target) {
            throw [IO.IOException]::new("The exact release is already staged; refusing to overwrite.")
        }
        if (Test-Path -LiteralPath $statePath) {
            throw [IO.IOException]::new("The exact service stage state already exists.")
        }
        if (-not $PSCmdlet.ShouldProcess($target, "Stage verified service runtime")) {
            return
        }
        if ($ServiceAdapter) {
            if (-not $ServiceAdapter.ContainsKey("AssertRuntimePath") -or
                $ServiceAdapter.AssertRuntimePath -isnot [scriptblock]
            ) {
                throw [ArgumentException]::new("The stage runtime-path adapter is incomplete.")
            }
            $assertRuntimePath = $ServiceAdapter.AssertRuntimePath
        }
        else {
            $assertRuntimePath = (New-RiverServiceAdapter).AssertRuntimePath
        }
        foreach ($path in @($install, $releaseParent)) {
            if (Test-Path -LiteralPath $path -PathType Container) {
                & $assertRuntimePath $path
            }
        }
        New-Item -ItemType Directory -Path $releaseParent -Force | Out-Null
        $temporary = Join-Path $releaseParent (".stage-" + [guid]::NewGuid().ToString("N"))
        $stateTemporary = Join-Path $releaseParent (".state-" + [guid]::NewGuid().ToString("N") + ".json")
        $moved = $false
        try {
            Copy-Item -LiteralPath $release.Root -Destination $temporary -Recurse
            $copied = Assert-RiverRuntimeManifest -ReleaseRoot $temporary `
                -ApprovedRevision $ApprovedRevision `
                -ApprovedManifestSha256 $ApprovedManifestSha256 -ServiceId $ServiceId
            if ($copied.ManifestSha256 -ne $release.ManifestSha256) {
                throw [IO.InvalidDataException]::new("Staged manifest digest mismatch.")
            }
            $state = [pscustomobject]@{
                status = "staged"; revision = $ApprovedRevision
                serviceId = $ServiceId; nodeId = $NodeId
                runId = $DeploymentRunId
                verifiedAtUtc = [DateTimeOffset]::UtcNow.ToString(
                    "yyyy-MM-ddTHH:mm:ss.fff'Z'", [Globalization.CultureInfo]::InvariantCulture
                )
                manifestSha256 = $release.ManifestSha256
                xmlSha256 = $xmlDigest
            }
            $state | ConvertTo-Json -Compress | Set-Content -LiteralPath $stateTemporary -Encoding UTF8
            [IO.Directory]::Move($temporary, $target)
            $moved = $true
            [IO.File]::Move($stateTemporary, $statePath)
            return $state
        }
        catch {
            if (Test-Path -LiteralPath $temporary) {
                [void] (Assert-RiverContained -Root $releaseParent -Path $temporary)
                Remove-Item -LiteralPath $temporary -Recurse -Force
            }
            if ($moved -and (Test-Path -LiteralPath $target)) {
                [void] (Assert-RiverContained -Root $releaseParent -Path $target)
                Remove-Item -LiteralPath $target -Recurse -Force
            }
            if (Test-Path -LiteralPath $stateTemporary) {
                Remove-Item -LiteralPath $stateTemporary -Force
            }
            throw
        }
    }
    $statePath = Join-Path $install "releases/$ApprovedRevision.$ServiceId.state.json"
    if (-not (Test-Path -LiteralPath $statePath -PathType Leaf)) {
        throw [InvalidOperationException]::new("This exact service release has not been staged.")
    }
    $state = Get-Content -Raw -LiteralPath $statePath | ConvertFrom-Json
    if (
        $state.revision -cne $ApprovedRevision -or
        $state.serviceId -cne $ServiceId -or
        $state.nodeId -cne $NodeId -or
        $state.runId -cne $DeploymentRunId -or
        $state.manifestSha256 -cne $release.ManifestSha256 -or
        $state.xmlSha256 -cne $xmlDigest
    ) {
        throw [InvalidOperationException]::new("The staged state does not match the approved release.")
    }
    $staged = Assert-RiverRuntimeManifest -ReleaseRoot $target `
        -ApprovedRevision $ApprovedRevision `
        -ApprovedManifestSha256 $ApprovedManifestSha256 -ServiceId $ServiceId
    if ($staged.ManifestSha256 -cne $state.manifestSha256) {
        throw [IO.InvalidDataException]::new("The staged release digest changed.")
    }
    if ($Operation -eq "Activate") {
        if ($state.status -cne "staged") {
            throw [InvalidOperationException]::new("Activation requires staged state.")
        }
        Assert-RiverDeploymentProof -ProofPath $ReadinessProofPath `
            -PeerStageStatePath $PeerStageStatePath -ServiceId $ServiceId `
            -NodeId $NodeId -Revision $ApprovedRevision `
            -DeploymentRunId $DeploymentRunId `
            -ManifestSha256 $release.ManifestSha256 -XmlSha256 $xmlDigest
    }
    elseif ($Operation -eq "Rollback") {
        if ($state.status -cne "active") {
            throw [InvalidOperationException]::new("Rollback requires an activated release.")
        }
        $restoreProof = Assert-RiverRollbackProof `
            -ProofPath $RestoreReadinessProofPath -ServiceId $ServiceId `
            -NodeId $NodeId -Revision $ApprovedRevision `
            -DeploymentRunId $DeploymentRunId `
            -ManifestSha256 $release.ManifestSha256 `
            -OriginalDatabaseSchemaVersion $state.originalDatabaseSchemaVersion
        if (-not $state.rollbackXmlPath) {
            throw [IO.InvalidDataException]::new("The retained rollback XML is missing.")
        }
        [void] (Assert-RiverContained -Root $install -Path $state.rollbackXmlPath)
        Assert-RiverNoReparsePath -Path $state.rollbackXmlPath
        if (-not (Test-Path -LiteralPath $state.rollbackXmlPath -PathType Leaf) -or
            (Get-RiverDigest -Path $state.rollbackXmlPath) -cne $state.rollbackXmlSha256
        ) {
            throw [IO.InvalidDataException]::new("The retained rollback XML is missing or changed.")
        }
        $rollbackXmlText = Get-Content -Raw -LiteralPath $state.rollbackXmlPath -ErrorAction Stop
        if ($rollbackXmlText -match '<!DOCTYPE|<!ENTITY') {
            throw [IO.InvalidDataException]::new("Rollback XML cannot contain entities.")
        }
        try {
            $rollbackXml = [xml] $rollbackXmlText
        }
        catch {
            throw [IO.InvalidDataException]::new("Retained rollback XML is malformed.")
        }
        if ($rollbackXml.service.id -cne $ServiceId -or
            @($rollbackXml.service.executable).Count -ne 1 -or
            @($rollbackXml.service.arguments).Count -ne 1
        ) {
            throw [IO.InvalidDataException]::new("Retained rollback XML has an invalid service identity.")
        }
        $rollbackExecutable = ([string] $rollbackXml.service.executable).Trim('"')
        $rollbackEntry = ([string] $rollbackXml.service.arguments).Trim('"')
        if (-not [IO.Path]::IsPathRooted($rollbackExecutable) -or
            -not [IO.Path]::IsPathRooted($rollbackEntry)
        ) {
            throw [IO.InvalidDataException]::new("Retained rollback XML lacks absolute worker paths.")
        }
    }
    $rollbackRoot = Join-Path $install "rollback"
    $rollbackRevisionRoot = Join-Path $rollbackRoot $ApprovedRevision
    $backupDirectory = Join-Path $rollbackRevisionRoot (
        $ServiceId + "-" + [guid]::NewGuid().ToString("N")
    )
    $backup = Join-Path $backupDirectory "$ServiceId.xml"
    foreach ($path in @($rollbackRoot, $rollbackRevisionRoot, $backupDirectory, $backup)) {
        [void] (Assert-RiverContained -Root $install -Path $path)
        Assert-RiverNoReparsePath -Path $path
    }
    $existingBackupAncestors = @(
        foreach ($path in @($rollbackRoot, $rollbackRevisionRoot)) {
            if (-not (Test-Path -LiteralPath $path)) { continue }
            if (-not (Test-Path -LiteralPath $path -PathType Container)) {
                throw [IO.InvalidDataException]::new("Rollback backup parent must be a directory.")
            }
            $path
        }
    )
    if (-not $PSCmdlet.ShouldProcess($ServiceId, "$Operation exact River service release")) {
        return
    }
    if (-not $ServiceAdapter) {
        $principal = [Security.Principal.WindowsPrincipal]::new(
            [Security.Principal.WindowsIdentity]::GetCurrent()
        )
        if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
            throw [UnauthorizedAccessException]::new("Service replacement requires elevation.")
        }
        $ServiceAdapter = New-RiverServiceAdapter
    }
    Assert-RiverServiceAdapter -Adapter $ServiceAdapter
    $servicePath = Join-Path $install "service/$ServiceId.xml"
    if (-not (Test-Path -LiteralPath $servicePath -PathType Leaf)) {
        throw [IO.FileNotFoundException]::new("Installed service XML is absent.")
    }
    $protectedPaths = @(
        $install, (Join-Path $install "releases"), $target,
        $staged.ManifestPath, $statePath, $DesiredServiceXmlPath, $servicePath
    )
    $protectedPaths += $existingBackupAncestors
    if ($Operation -eq "Activate") {
        $protectedPaths += @($ReadinessProofPath, $PeerStageStatePath)
        $proofForAcl = Get-Content -Raw -LiteralPath $ReadinessProofPath | ConvertFrom-Json
        $protectedPaths += [string] $proofForAcl.backupPath
    }
    elseif ($state.rollbackXmlPath) {
        $protectedPaths += @(
            [string] $state.rollbackXmlPath,
            $RestoreReadinessProofPath,
            [string] $restoreProof['restoredCopyPath']
        )
    }
    foreach ($path in $protectedPaths + @($staged.Entries | ForEach-Object {
        Join-Path $target $_.path
    })) {
        Assert-RiverNoReparsePath -Path $path
        & $ServiceAdapter.AssertRuntimePath $path
    }
    $before = & $ServiceAdapter.GetSnapshot $ServiceId
    foreach ($path in @($rollbackRoot, $rollbackRevisionRoot, $backupDirectory, $backup)) {
        Assert-RiverNoReparsePath -Path $path
    }
    $expectedAccount = if ($ServiceId -eq "BalconyAgentBridge") {
        "LocalSystem"
    } else {
        "NT AUTHORITY\LocalService"
    }
    if ($before.StartName -cne $expectedAccount -or
        [string] $before.SidType -notmatch '\bUNRESTRICTED\b'
    ) {
        throw [InvalidOperationException]::new(
            "Installed service account or unrestricted SID identity is not approved."
        )
    }
    if ($before.State -notin @("Running", "Stopped") -or
        ($before.State -eq "Running" -and
            ($before.ProcessId -le 0 -or $before.ChildCount -ne 1))
    ) {
        throw [InvalidOperationException]::new("Installed service state or child identity is unsafe.")
    }
    New-Item -ItemType Directory -Path $backupDirectory -Force | Out-Null
    Assert-RiverNoReparsePath -Path $backup
    & $ServiceAdapter.AssertRuntimePath $backupDirectory
    Copy-Item -LiteralPath $servicePath -Destination $backup -ErrorAction Stop
    $originalDigest = Get-RiverDigest -Path $backup
    $xmlChanged = $false
    $stopped = $false
    $startAttempted = $false
    try {
        Stop-RiverTrackedService -ServiceId $ServiceId -Adapter $ServiceAdapter `
            -Before $before -TimeoutSeconds $StopTimeoutSeconds
        $stopped = $true
        if ($Operation -eq "Activate") {
            $xmlChanged = $true
            Set-RiverXmlAtomically -Source $DesiredServiceXmlPath -Destination $servicePath
            $expectedDigest = $xmlDigest
        }
        else {
            if (-not $state.rollbackXmlPath -or
                -not (Test-Path -LiteralPath $state.rollbackXmlPath -PathType Leaf) -or
                (Get-RiverDigest -Path $state.rollbackXmlPath) -cne $state.rollbackXmlSha256
            ) {
                throw [IO.InvalidDataException]::new("The retained rollback XML is missing or changed.")
            }
            $xmlChanged = $true
            Set-RiverXmlAtomically -Source $state.rollbackXmlPath -Destination $servicePath
            $expectedDigest = $state.rollbackXmlSha256
        }
        if ((Get-RiverDigest -Path $servicePath) -cne $expectedDigest) {
            throw [IO.InvalidDataException]::new("Installed rendered XML digest differs.")
        }
        if ($before.State -eq "Running") {
            $startAttempted = $true
            & $ServiceAdapter.Start $ServiceId
            $healthy = $false
            $expectedExecutable = if ($Operation -eq "Rollback") {
                $rollbackExecutable
            } else {
                Join-Path $target "runtime/node.exe"
            }
            $expectedEntry = if ($Operation -eq "Rollback") {
                $rollbackEntry
            } else {
                Join-Path $target $(if ($ServiceId -eq "BalconyAgentBridge") {
                    "dist/bridge/index.js"
                } else {
                    "dist/dispatcher/index.js"
                })
            }
            $expectedCommand = '^"?'+ [regex]::Escape($expectedExecutable) +
                '"?\s+"?' + [regex]::Escape($expectedEntry) + '"?$'
            for ($attempt = 0; $attempt -le ($StartTimeoutSeconds * 4); $attempt++) {
                $after = & $ServiceAdapter.GetSnapshot $ServiceId
                Assert-RiverServiceMetadata -Before $before -After $after
                if ($after.State -eq "Running" -and
                    $after.ProcessId -gt 0 -and $after.ChildCount -eq 1
                ) {
                    if (
                        -not $after.PSObject.Properties['ChildProcessId'] -or
                        -not $after.PSObject.Properties['ChildCreation'] -or
                        -not $after.PSObject.Properties['ChildExecutable'] -or
                        -not $after.PSObject.Properties['ChildCommandLine'] -or
                        $after.ChildProcessId -le 0 -or
                        -not $after.ChildCreation -or
                        $after.ChildExecutable -ine $expectedExecutable -or
                        $after.ChildCommandLine -inotmatch $expectedCommand -or
                        -not (& $ServiceAdapter.ProcessIdentityExists $after.ChildProcessId $after.ChildCreation)
                    ) {
                        throw [InvalidOperationException]::new(
                            "Started service child identity does not match the approved executable and entrypoint."
                        )
                    }
                    $healthy = $true
                    break
                }
                if ($attempt -lt ($StartTimeoutSeconds * 4)) {
                    & $ServiceAdapter.Sleep 250
                }
            }
            if (-not $healthy) {
                throw [TimeoutException]::new("Service did not regain the one-child running state.")
            }
        }
        else {
            $after = & $ServiceAdapter.GetSnapshot $ServiceId
            Assert-RiverServiceMetadata -Before $before -After $after
            if ($after.State -ne "Stopped" -or $after.ProcessId -ne 0) {
                throw [InvalidOperationException]::new("Stopped service unexpectedly started.")
            }
        }
        $state.status = if ($Operation -eq "Activate") { "active" } else { "rolled-back" }
        if ($Operation -eq "Activate") {
            $state | Add-Member -NotePropertyName rollbackXmlPath -NotePropertyValue $backup
            $state | Add-Member -NotePropertyName rollbackXmlSha256 -NotePropertyValue $originalDigest
            $proofForSchema = Get-Content -Raw -LiteralPath $ReadinessProofPath | ConvertFrom-Json
            $state | Add-Member -NotePropertyName originalDatabaseSchemaVersion `
                -NotePropertyValue $proofForSchema.preMigrationSchemaVersion
        }
        $state | ConvertTo-Json -Compress | Set-Content -LiteralPath $statePath -Encoding UTF8
        return $state
    }
    catch {
        $forward = $_
        try {
            if ($stopped) {
                $current = & $ServiceAdapter.GetSnapshot $ServiceId
                Stop-RiverTrackedService -ServiceId $ServiceId -Adapter $ServiceAdapter `
                    -Before $current -TimeoutSeconds $StopTimeoutSeconds
            }
            if ($xmlChanged) {
                Set-RiverXmlAtomically -Source $backup -Destination $servicePath
            }
            if ((Get-RiverDigest -Path $servicePath) -cne $originalDigest) {
                throw [IO.InvalidDataException]::new("Rollback XML digest differs.")
            }
            if ($Operation -eq "Rollback" -and
                $before.State -eq "Running" -and $stopped -and -not $startAttempted
            ) {
                & $ServiceAdapter.Start $ServiceId
            }
            $restored = & $ServiceAdapter.GetSnapshot $ServiceId
            Assert-RiverServiceMetadata -Before $before -After $restored
            if (($Operation -eq "Activate" -and $stopped) -or $startAttempted) {
                if ($restored.State -ne "Stopped" -or
                    $restored.ProcessId -ne 0 -or $restored.ChildCount -ne 0
                ) {
                    throw [InvalidOperationException]::new(
                        "Candidate may remain active after failure; manual recovery is required."
                    )
                }
            }
            elseif ($restored.State -ne $before.State -or
                ($before.State -eq "Running" -and
                    ($restored.ProcessId -le 0 -or $restored.ChildCount -ne 1))
            ) {
                throw [InvalidOperationException]::new("Previous service state was not restored.")
            }
        }
        catch {
            throw [InvalidOperationException]::new(
                "Service replacement failed and rollback failed; retained backup requires manual recovery.",
                $forward.Exception
            )
        }
        if ($Operation -eq "Activate" -and $stopped) {
            throw [InvalidOperationException]::new(
                "Service activation failed; original XML was restored, " +
                "service remains stopped, and database restoration proof is required before restart.",
                $forward.Exception
            )
        }
        throw [InvalidOperationException]::new(
            "Service replacement failed; previous service state restored and rollback backup retained.",
            $forward.Exception
        )
    }
}

Export-ModuleMember -Function Invoke-BridgeRuntimeDeployment
