[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [ValidateSet("Publish", "Validate", "Install")]
    [string] $Mode,

    [string] $ArchivePath,
    [ValidatePattern("^[0-9]{4}-[0-9]{2}-[0-9]{2}$")]
    [string] $ReleaseDateUtc,
    [ValidateRange(1, 99)]
    [int] $ReleaseSequence = 1,
    [ValidateSet("SYS-A", "SYS-B")]
    [string] $OriginSystem,
    [ValidateSet("SYS-A", "SYS-B")]
    [string] $TargetSystem,
    [string[]] $DeclaredNameException = @(),

    [string] $ReleaseManifestPath,
    [ValidateSet("SYS-A", "SYS-B")]
    [string] $SystemId,
    [string] $ExpectedCommit,
    [string] $CodexSkillsPath = $(Join-Path $HOME ".codex/skills"),
    [string] $AgentSkillsPath = $(Join-Path $HOME ".agents/skills")
)

$ErrorActionPreference = "Stop"

$HandoffProtocol = "balcony-git-artifact-handoff.v1"
$ManifestFileName = "release.json"
$ArchiveFileName = "payload.zip"
$ReleaseIdPattern = "^(?<date>[0-9]{4}-[0-9]{2}-[0-9]{2})--(?<origin>sys-[ab])-to-(?<target>sys-[ab])--codex-skills--r(?<sequence>[0-9]{2})$"

function ConvertTo-SystemSlug {
    param([Parameter(Mandatory = $true)][string] $Identity)
    return $Identity.ToLowerInvariant()
}

function New-ReleaseId {
    param(
        [Parameter(Mandatory = $true)][string] $Date,
        [Parameter(Mandatory = $true)][string] $Origin,
        [Parameter(Mandatory = $true)][string] $Target,
        [Parameter(Mandatory = $true)][int] $Sequence
    )

    $originSlug = ConvertTo-SystemSlug -Identity $Origin
    $targetSlug = ConvertTo-SystemSlug -Identity $Target
    return "$Date--$originSlug-to-$targetSlug--codex-skills--r$($Sequence.ToString('00'))"
}

function Get-CanonicalManifestRelativePath {
    param(
        [Parameter(Mandatory = $true)][string] $ReleaseDate,
        [Parameter(Mandatory = $true)][string] $ReleaseId
    )

    $year = $ReleaseDate.Substring(0, 4)
    $month = $ReleaseDate.Substring(5, 2)
    return "transfers/releases/$year/$month/$ReleaseId/$ManifestFileName"
}

function Get-Sha256Hex {
    param([Parameter(Mandatory = $true)][string] $Path)
    return (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash.ToUpperInvariant()
}

function Get-DirectoryManifest {
    param([Parameter(Mandatory = $true)][string] $Path)

    $root = [IO.Path]::GetFullPath($Path).TrimEnd("\", "/")
    $reparsePoints = @(
        Get-ChildItem -LiteralPath $root -Recurse -Force |
            Where-Object { $_.Attributes -band [IO.FileAttributes]::ReparsePoint }
    )
    if ($reparsePoints.Count) {
        throw "Skill directory contains a reparse point: $($reparsePoints[0].FullName)"
    }
    return @(
        Get-ChildItem -LiteralPath $root -File -Recurse -Force |
            Sort-Object FullName |
            ForEach-Object {
                $relative = $_.FullName.Substring($root.Length).
                    TrimStart("\", "/").Replace("\", "/")
                "$relative|$(Get-Sha256Hex -Path $_.FullName)"
            }
    ) -join "`n"
}

function Read-ZipText {
    param(
        [Parameter(Mandatory = $true)] $Entry
    )

    $reader = [IO.StreamReader]::new($Entry.Open())
    try {
        return $reader.ReadToEnd()
    } finally {
        $reader.Dispose()
    }
}

function Get-SkillArchiveInventory {
    param([Parameter(Mandatory = $true)][string] $Path)

    Add-Type -AssemblyName System.IO.Compression.FileSystem
    $archive = [IO.Compression.ZipFile]::OpenRead($Path)
    try {
        $entries = @($archive.Entries)
        if ($entries.Count -eq 0) {
            throw "Archive is empty: $Path"
        }
        if ($entries.Count -gt 2000) {
            throw "Archive exceeds the 2000-entry safety limit."
        }

        $normalizedNames = @($entries | ForEach-Object { $_.FullName.Replace("\", "/").ToLowerInvariant() })
        if (@($normalizedNames | Sort-Object -Unique).Count -ne $normalizedNames.Count) {
            throw "Archive contains duplicate case-insensitive paths."
        }

        foreach ($entry in $entries) {
            $name = $entry.FullName.Replace("\", "/")
            if (
                $entry.FullName.Contains("\") -or
                $name.StartsWith("/") -or
                $name -match "^[A-Za-z]:" -or
                @($name.Split("/") | Where-Object { $_ -eq ".." }).Count -gt 0
            ) {
                throw "Unsafe ZIP entry path: $($entry.FullName)"
            }
        }

        $files = @($entries | Where-Object { -not $_.FullName.EndsWith("/") })
        $uncompressedBytes = ($files | Measure-Object Length -Sum).Sum
        $maxFileBytes = ($files | Measure-Object Length -Maximum).Maximum
        if ($uncompressedBytes -gt 50MB) {
            throw "Archive exceeds the 50 MiB uncompressed safety limit."
        }
        if ($maxFileBytes -gt 10MB) {
            throw "Archive contains a file larger than the 10 MiB safety limit."
        }
        $roots = @(
            $files |
                ForEach-Object { $_.FullName.Replace("\", "/").Split("/")[0] } |
                Sort-Object -Unique
        )
        if ($roots.Count -ne 1 -or -not $roots[0]) {
            throw "Archive must contain exactly one payload root."
        }
        $root = $roots[0]
        $prefix = "$root/"

        $metadata = @("README.md", "MANIFEST.md", "SHA256SUMS.txt")
        foreach ($name in $metadata) {
            if (-not ($files | Where-Object FullName -eq "$prefix$name")) {
                throw "Archive metadata file is missing: $name"
            }
        }

        $sumEntry = $files | Where-Object FullName -eq "${prefix}SHA256SUMS.txt"
        $expected = @{}
        foreach ($line in ((Read-ZipText -Entry $sumEntry) -split "`r?`n")) {
            if (-not $line) {
                continue
            }
            if ($line -notmatch "^([0-9A-Fa-f]{64})\s{2}(.+)$") {
                throw "Malformed SHA256SUMS line: $line"
            }
            $declaredHash = $matches[1].ToUpperInvariant()
            $relative = $matches[2].Replace("\", "/")
            if ($relative -notmatch "^(codex|agents)/[a-zA-Z0-9._-]+/.+") {
                throw "Unsupported payload path in SHA256SUMS: $relative"
            }
            if ($expected.ContainsKey($relative)) {
                throw "Duplicate SHA256SUMS path: $relative"
            }
            $expected[$relative] = $declaredHash
        }

        $actualPayload = @(
            $files |
                ForEach-Object { $_.FullName.Substring($prefix.Length) } |
                Where-Object { $_ -notin $metadata }
        )
        $unlisted = @($actualPayload | Where-Object { -not $expected.ContainsKey($_) })
        $missing = @($expected.Keys | Where-Object { $_ -notin $actualPayload })
        if ($unlisted.Count -or $missing.Count) {
            throw "SHA256SUMS coverage mismatch. Unlisted=$($unlisted -join ', '); Missing=$($missing -join ', ')"
        }

        foreach ($relative in $expected.Keys) {
            $entry = $files | Where-Object FullName -eq "$prefix$relative"
            $sha = [Security.Cryptography.SHA256]::Create()
            try {
                $stream = $entry.Open()
                try {
                    $actual = (($sha.ComputeHash($stream) |
                        ForEach-Object { $_.ToString("X2") }) -join "")
                } finally {
                    $stream.Dispose()
                }
            } finally {
                $sha.Dispose()
            }
            if ($actual -ne $expected[$relative]) {
                throw "Archive file hash mismatch: $relative"
            }
        }

        $codexSkills = @(
            $actualPayload |
                Where-Object { $_ -match "^codex/([^/]+)/SKILL\.md$" } |
                ForEach-Object { if ($_ -match "^codex/([^/]+)/SKILL\.md$") { $matches[1] } } |
                Sort-Object -Unique
        )
        $agentSkills = @(
            $actualPayload |
                Where-Object { $_ -match "^agents/([^/]+)/SKILL\.md$" } |
                ForEach-Object { if ($_ -match "^agents/([^/]+)/SKILL\.md$") { $matches[1] } } |
                Sort-Object -Unique
        )
        if (-not $codexSkills.Count -and -not $agentSkills.Count) {
            throw "Archive contains no skill entrypoints."
        }

        return [pscustomobject]@{
            payloadRoot = $root
            zipEntryCount = $entries.Count
            fileEntryCount = $files.Count
            directoryEntryCount = @($entries | Where-Object { $_.FullName.EndsWith("/") }).Count
            payloadFileCount = $expected.Count
            uncompressedByteLength = [long]$uncompressedBytes
            maxFileByteLength = [long]$maxFileBytes
            metadataFiles = $metadata
            codexSkills = $codexSkills
            agentSkills = $agentSkills
        }
    } finally {
        $archive.Dispose()
    }
}

function Resolve-Release {
    param(
        [Parameter(Mandatory = $true)][string] $ManifestPath,
        [Parameter(Mandatory = $true)][string] $TargetIdentity,
        [string] $Commit
    )

    $resolvedManifest = (Resolve-Path -LiteralPath $ManifestPath).Path
    $release = Get-Content -Raw -LiteralPath $resolvedManifest | ConvertFrom-Json
    if ($release.schema_version -ne "balcony-artifact-release.v1") {
        throw "Unsupported artifact release schema: $($release.schema_version)"
    }
    if ($release.handoff_protocol -ne $HandoffProtocol) {
        throw "Unsupported handoff protocol: $($release.handoff_protocol)"
    }
    if ($release.artifact_type -ne "codex-skill-archive") {
        throw "Unsupported artifact type: $($release.artifact_type)"
    }
    if ($release.origin_system -eq $release.target_system) {
        throw "Origin and target systems must differ."
    }
    if ($release.target_system -ne $TargetIdentity) {
        throw "Release targets '$($release.target_system)', not '$TargetIdentity'."
    }
    if ($release.release_id -notmatch $ReleaseIdPattern) {
        throw "Release ID does not follow the canonical naming convention."
    }
    $releaseIdFields = $matches.Clone()
    if (
        $releaseIdFields.date -ne $release.release_date_utc -or
        $releaseIdFields.origin -ne (ConvertTo-SystemSlug -Identity $release.origin_system) -or
        $releaseIdFields.target -ne (ConvertTo-SystemSlug -Identity $release.target_system)
    ) {
        throw "Release ID fields do not match the release envelope."
    }
    $parsedReleaseDate = [DateTime]::MinValue
    if (-not [DateTime]::TryParseExact(
        $release.release_date_utc,
        "yyyy-MM-dd",
        [Globalization.CultureInfo]::InvariantCulture,
        [Globalization.DateTimeStyles]::None,
        [ref] $parsedReleaseDate
    )) {
        throw "release_date_utc must be a real UTC calendar date in YYYY-MM-DD form."
    }
    $parsedCreatedAt = [DateTimeOffset]::MinValue
    if (-not [DateTimeOffset]::TryParse(
        $release.created_at_utc,
        [Globalization.CultureInfo]::InvariantCulture,
        [Globalization.DateTimeStyles]::RoundtripKind,
        [ref] $parsedCreatedAt
    )) {
        throw "created_at_utc must be a valid timestamp."
    }
    if ($parsedCreatedAt.UtcDateTime.ToString("yyyy-MM-dd") -ne $release.release_date_utc) {
        throw "created_at_utc must fall on release_date_utc."
    }
    if ($release.archive.file_name -ne $ArchiveFileName) {
        throw "Archive file_name must be '$ArchiveFileName'."
    }

    $manifestDirectory = Split-Path -Parent $resolvedManifest
    $repositoryRoot = (& git -C $manifestDirectory rev-parse --show-toplevel).Trim()
    if ($LASTEXITCODE -ne 0) {
        throw "Release manifest is not inside a Git repository."
    }
    $manifestRelativePath = [IO.Path]::GetRelativePath($repositoryRoot, $resolvedManifest).
        Replace("\", "/")
    $expectedManifestRelativePath = Get-CanonicalManifestRelativePath `
        -ReleaseDate $release.release_date_utc `
        -ReleaseId $release.release_id
    if ($manifestRelativePath -cne $expectedManifestRelativePath) {
        throw "Release manifest must use the canonical path '$expectedManifestRelativePath'."
    }
    $archivePath = Join-Path $manifestDirectory $release.archive.file_name
    if (-not (Test-Path -LiteralPath $archivePath -PathType Leaf)) {
        throw "Release archive is missing: $archivePath"
    }
    $archiveItem = Get-Item -LiteralPath $archivePath
    if ($archiveItem.Length -ne $release.archive.byte_length) {
        throw "Archive byte length mismatch."
    }
    $archiveHash = Get-Sha256Hex -Path $archivePath
    if ($archiveHash -ne $release.archive.sha256) {
        throw "Archive SHA-256 mismatch."
    }

    if ($Commit) {
        if ($Commit -notmatch "^[0-9a-fA-F]{40}$") {
            throw "ExpectedCommit must be a full 40-character Git object ID."
        }
        $head = (& git -C $repositoryRoot rev-parse HEAD).Trim()
        if ($head -ne $Commit.ToLowerInvariant()) {
            throw "Git HEAD '$head' does not match expected commit '$Commit'."
        }
        $dirty = @(& git -C $repositoryRoot status --porcelain --untracked-files=no)
        if ($dirty.Count) {
            throw "Git worktree is dirty; refusing pinned artifact use."
        }
        foreach ($path in @($resolvedManifest, $archivePath)) {
            $relativePath = [IO.Path]::GetRelativePath($repositoryRoot, $path).
                Replace("\", "/")
            & git -C $repositoryRoot ls-files --error-unmatch -- $relativePath *> $null
            if ($LASTEXITCODE -ne 0) {
                throw "Release file is not tracked at the pinned commit: $relativePath"
            }
        }
    }

    $inventory = Get-SkillArchiveInventory -Path $archivePath
    foreach ($property in @(
        @("payloadRoot", "payload_root"),
        @("zipEntryCount", "zip_entry_count"),
        @("fileEntryCount", "file_entry_count"),
        @("directoryEntryCount", "directory_entry_count"),
        @("payloadFileCount", "payload_file_count"),
        @("uncompressedByteLength", "uncompressed_byte_length"),
        @("maxFileByteLength", "max_file_byte_length")
    )) {
        if ($inventory.($property[0]) -ne $release.archive.($property[1])) {
            throw "Archive inventory mismatch for $($property[1])."
        }
    }

    $manifestCodex = @($release.skills.codex | Sort-Object)
    $manifestAgents = @($release.skills.agents | Sort-Object)
    if (@(Compare-Object $manifestCodex $inventory.codexSkills).Count) {
        throw "Codex skill list does not match archive entrypoints."
    }
    if (@(Compare-Object $manifestAgents $inventory.agentSkills).Count) {
        throw "Agent skill list does not match archive entrypoints."
    }

    return [pscustomobject]@{
        release = $release
        manifestPath = $resolvedManifest
        archivePath = $archivePath
        archiveHash = $archiveHash
        inventory = $inventory
        gitPinVerified = [bool]$Commit
    }
}

function Publish-Release {
    foreach ($required in @("ArchivePath", "ReleaseDateUtc", "OriginSystem", "TargetSystem")) {
        if (-not (Get-Variable -Name $required -ValueOnly)) {
            throw "$required is required in Publish mode."
        }
    }
    if ($OriginSystem -eq $TargetSystem) {
        throw "OriginSystem and TargetSystem must differ."
    }
    $parsedReleaseDate = [DateTime]::MinValue
    if (-not [DateTime]::TryParseExact(
        $ReleaseDateUtc,
        "yyyy-MM-dd",
        [Globalization.CultureInfo]::InvariantCulture,
        [Globalization.DateTimeStyles]::None,
        [ref] $parsedReleaseDate
    )) {
        throw "ReleaseDateUtc must be a real UTC calendar date in YYYY-MM-DD form."
    }

    $resolvedArchive = (Resolve-Path -LiteralPath $ArchivePath).Path
    $inventory = Get-SkillArchiveInventory -Path $resolvedArchive
    $releaseId = New-ReleaseId `
        -Date $ReleaseDateUtc `
        -Origin $OriginSystem `
        -Target $TargetSystem `
        -Sequence $ReleaseSequence
    $repositoryRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot ".."))
    $manifestRelativePath = Get-CanonicalManifestRelativePath `
        -ReleaseDate $ReleaseDateUtc `
        -ReleaseId $releaseId
    $output = Split-Path -Parent (Join-Path $repositoryRoot $manifestRelativePath)
    if (Test-Path -LiteralPath $output) {
        if (@(Get-ChildItem -LiteralPath $output -Force).Count) {
            throw "Canonical release directory already exists and is not empty: $output"
        }
    } else {
        New-Item -ItemType Directory -Path $output | Out-Null
    }

    $destinationArchive = Join-Path $output $ArchiveFileName
    Copy-Item -LiteralPath $resolvedArchive -Destination $destinationArchive

    $exceptions = @()
    foreach ($item in $DeclaredNameException) {
        if ($item -notmatch "^(codex|agents)/([^/=]+)=([^/=]+)$") {
            throw "Malformed DeclaredNameException: $item"
        }
        $exceptions += [ordered]@{
            surface = $matches[1]
            directory = $matches[2]
            declared_name = $matches[3]
            reason = "preserved-source-mismatch"
        }
    }

    $archiveItem = Get-Item -LiteralPath $destinationArchive
    $release = [ordered]@{
        schema_version = "balcony-artifact-release.v1"
        handoff_protocol = $HandoffProtocol
        release_id = $releaseId
        release_date_utc = $ReleaseDateUtc
        artifact_type = "codex-skill-archive"
        origin_system = $OriginSystem
        target_system = $TargetSystem
        created_at_utc = [DateTime]::UtcNow.ToString("o")
        archive = [ordered]@{
            file_name = $ArchiveFileName
            sha256 = Get-Sha256Hex -Path $destinationArchive
            byte_length = $archiveItem.Length
            payload_root = $inventory.payloadRoot
            zip_entry_count = $inventory.zipEntryCount
            file_entry_count = $inventory.fileEntryCount
            directory_entry_count = $inventory.directoryEntryCount
            payload_file_count = $inventory.payloadFileCount
            uncompressed_byte_length = $inventory.uncompressedByteLength
            max_file_byte_length = $inventory.maxFileByteLength
            metadata_files = $inventory.metadataFiles
        }
        skills = [ordered]@{
            codex = $inventory.codexSkills
            agents = $inventory.agentSkills
        }
        install_policy = [ordered]@{
            collision = "accept-identical-or-fail"
            require_git_commit_pin = $true
            require_target_system_identity = $true
        }
        declared_name_exceptions = $exceptions
    }
    $manifestPath = Join-Path $output $ManifestFileName
    $release | ConvertTo-Json -Depth 10 | Set-Content -LiteralPath $manifestPath -Encoding utf8
    return Resolve-Release -ManifestPath $manifestPath -TargetIdentity $TargetSystem
}

function Install-Release {
    param([Parameter(Mandatory = $true)] $Resolved)

    if (-not $ExpectedCommit) {
        throw "Install mode requires ExpectedCommit."
    }
    if (-not $env:BALCONY_SYSTEM_ID) {
        throw "BALCONY_SYSTEM_ID must be set for installation."
    }
    if ($env:BALCONY_SYSTEM_ID -ne $SystemId) {
        throw "BALCONY_SYSTEM_ID '$env:BALCONY_SYSTEM_ID' does not match '$SystemId'."
    }

    foreach ($root in @($CodexSkillsPath, $AgentSkillsPath)) {
        if (-not (Test-Path -LiteralPath $root -PathType Container)) {
            throw "Skill destination root is missing: $root"
        }
    }

    $temporary = Join-Path ([IO.Path]::GetTempPath()) ("balcony-artifact-" + [guid]::NewGuid().ToString("N"))
    New-Item -ItemType Directory -Path $temporary | Out-Null
    $created = [System.Collections.Generic.List[string]]::new()
    try {
        [IO.Compression.ZipFile]::ExtractToDirectory($Resolved.archivePath, $temporary)
        $payloadRoot = Join-Path $temporary $Resolved.inventory.payloadRoot
        $toInstall = [System.Collections.Generic.List[object]]::new()
        $alreadyPresent = [System.Collections.Generic.List[string]]::new()

        foreach ($surface in @(
            [pscustomobject]@{ name = "codex"; skills = $Resolved.inventory.codexSkills; destination = $CodexSkillsPath },
            [pscustomobject]@{ name = "agents"; skills = $Resolved.inventory.agentSkills; destination = $AgentSkillsPath }
        )) {
            foreach ($skill in $surface.skills) {
                $source = Join-Path (Join-Path $payloadRoot $surface.name) $skill
                $destination = Join-Path $surface.destination $skill
                if (Test-Path -LiteralPath $destination) {
                    if ((Get-DirectoryManifest -Path $source) -ne (Get-DirectoryManifest -Path $destination)) {
                        throw "Different destination already exists: $destination"
                    }
                    $alreadyPresent.Add("$($surface.name)/$skill")
                    continue
                }
                $toInstall.Add([pscustomobject]@{
                    surface = $surface.name
                    skill = $skill
                    source = $source
                    destination = $destination
                })
            }
        }

        foreach ($item in $toInstall) {
            Copy-Item -LiteralPath $item.source -Destination $item.destination -Recurse
            $created.Add($item.destination)
            if ((Get-DirectoryManifest -Path $item.source) -ne (Get-DirectoryManifest -Path $item.destination)) {
                throw "Installed skill verification failed: $($item.surface)/$($item.skill)"
            }
        }

        return [ordered]@{
            schema_version = "balcony-artifact-install-result.v1"
            release_id = $Resolved.release.release_id
            archive_sha256 = $Resolved.archiveHash
            target_system = $SystemId
            git_commit = $ExpectedCommit.ToLowerInvariant()
            outcome = "installed"
            installed = @($toInstall | ForEach-Object { "$($_.surface)/$($_.skill)" })
            already_present_identical = @($alreadyPresent)
            failed = @()
        }
    } catch {
        foreach ($path in @($created | Sort-Object Length -Descending)) {
            if (Test-Path -LiteralPath $path) {
                Remove-Item -LiteralPath $path -Recurse -Force
            }
        }
        throw
    } finally {
        if (Test-Path -LiteralPath $temporary) {
            Remove-Item -LiteralPath $temporary -Recurse -Force
        }
    }
}

switch ($Mode) {
    "Publish" {
        $resolved = Publish-Release
        [ordered]@{
            schema_version = "balcony-artifact-publish-result.v1"
            release_id = $resolved.release.release_id
            manifest_path = $resolved.manifestPath
            archive_path = $resolved.archivePath
            archive_sha256 = $resolved.archiveHash
            codex_skills = $resolved.inventory.codexSkills
            agent_skills = $resolved.inventory.agentSkills
            outcome = "published-locally-uncommitted"
        } | ConvertTo-Json -Depth 8
    }
    "Validate" {
        if (-not $ReleaseManifestPath -or -not $SystemId) {
            throw "ReleaseManifestPath and SystemId are required in Validate mode."
        }
        $resolved = Resolve-Release -ManifestPath $ReleaseManifestPath -TargetIdentity $SystemId -Commit $ExpectedCommit
        [ordered]@{
            schema_version = "balcony-artifact-validation-result.v1"
            release_id = $resolved.release.release_id
            archive_sha256 = $resolved.archiveHash
            target_system = $SystemId
            git_pin_verified = $resolved.gitPinVerified
            codex_skill_count = $resolved.inventory.codexSkills.Count
            agent_skill_count = $resolved.inventory.agentSkills.Count
            payload_file_count = $resolved.inventory.payloadFileCount
            outcome = "valid"
        } | ConvertTo-Json -Depth 8
    }
    "Install" {
        if (-not $ReleaseManifestPath -or -not $SystemId) {
            throw "ReleaseManifestPath and SystemId are required in Install mode."
        }
        $resolved = Resolve-Release -ManifestPath $ReleaseManifestPath -TargetIdentity $SystemId -Commit $ExpectedCommit
        Install-Release -Resolved $resolved | ConvertTo-Json -Depth 8
    }
}
