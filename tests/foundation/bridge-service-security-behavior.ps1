$ErrorActionPreference = "Stop"

$repositoryRoot = Resolve-Path (Join-Path $PSScriptRoot "..\..")
$securityModule = Join-Path $repositoryRoot "scripts\BridgeServiceSecurity.psm1"
Import-Module -Force -Name $securityModule

function Set-RestrictedTestDirectoryAcl {
    param(
        [Parameter(Mandatory)] [string] $Path,
        [Parameter(Mandatory)]
        [Security.Principal.SecurityIdentifier[]] $TrustedIdentities,
        [Security.AccessControl.FileSystemAccessRule[]] $AdditionalRules = @()
    )

    $directoryAcl = Get-Acl -LiteralPath $Path
    $directoryAcl.SetAccessRuleProtection($true, $false)
    foreach ($trustedIdentity in $TrustedIdentities) {
        $directoryAcl.SetAccessRule(
            [Security.AccessControl.FileSystemAccessRule]::new(
                $trustedIdentity,
                [Security.AccessControl.FileSystemRights]::FullControl,
                (
                    [Security.AccessControl.InheritanceFlags]::ContainerInherit -bor
                    [Security.AccessControl.InheritanceFlags]::ObjectInherit
                ),
                [Security.AccessControl.PropagationFlags]::None,
                [Security.AccessControl.AccessControlType]::Allow
            )
        )
    }
    foreach ($additionalRule in $AdditionalRules) {
        $directoryAcl.AddAccessRule($additionalRule)
    }
    Set-Acl -LiteralPath $Path -AclObject $directoryAcl
}

function Set-RestrictedTestFileAcl {
    param(
        [Parameter(Mandatory)] [string] $Path,
        [Parameter(Mandatory)]
        [Security.Principal.SecurityIdentifier[]] $TrustedIdentities,
        [Security.AccessControl.FileSystemAccessRule[]] $AdditionalRules = @()
    )

    $fileAcl = [Security.AccessControl.FileSecurity]::new()
    $fileAcl.SetOwner($TrustedIdentities[0])
    $fileAcl.SetAccessRuleProtection($true, $false)
    foreach ($trustedIdentity in $TrustedIdentities) {
        $fileAcl.AddAccessRule(
            [Security.AccessControl.FileSystemAccessRule]::new(
                $trustedIdentity,
                [Security.AccessControl.FileSystemRights]::FullControl,
                [Security.AccessControl.AccessControlType]::Allow
            )
        )
    }
    foreach ($additionalRule in $AdditionalRules) {
        $fileAcl.AddAccessRule($additionalRule)
    }
    Set-Acl -LiteralPath $Path -AclObject $fileAcl
}

$temporaryFile = [IO.Path]::GetTempFileName()
$withoutSystemReadFile = [IO.Path]::GetTempFileName()
$deniedSystemReadFile = [IO.Path]::GetTempFileName()
$deniedServiceReadFile = [IO.Path]::GetTempFileName()
$temporaryRoot = Join-Path $env:ProgramData (
    "balcony-acl-{0}" -f [guid]::NewGuid().ToString("N")
)
$protectedLeaf = Join-Path $temporaryRoot "protected-leaf"
$unsafeLeaf = Join-Path $temporaryRoot "unsafe-leaf"
$replacementRoot = Join-Path $env:ProgramData (
    "balcony-acl-{0}" -f [guid]::NewGuid().ToString("N")
)
$replacementLeaf = Join-Path $replacementRoot "protected-leaf"
try {
    $acl = Get-Acl -LiteralPath $temporaryFile
    $ownerSid = ConvertTo-BridgeServiceSid -IdentityReference $acl.Owner
    if ($ownerSid -notmatch "^S-\d-") {
        throw "Owner translation did not return a SID."
    }

    $currentSid = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
    $trustedSids = @($ownerSid, $currentSid) | Select-Object -Unique
    $everyone = [Security.Principal.SecurityIdentifier]::new("S-1-1-0")
    $broadReadRule = [Security.AccessControl.FileSystemAccessRule]::new(
        $everyone,
        [Security.AccessControl.FileSystemRights]::ReadData,
        [Security.AccessControl.AccessControlType]::Allow
    )
    $acl.AddAccessRule($broadReadRule)
    Set-Acl -LiteralPath $temporaryFile -AclObject $acl

    $rejected = $false
    try {
        Assert-BridgeServiceCredentialAcl `
            -Path $temporaryFile `
            -TrustedSids $trustedSids
    }
    catch {
        if ($_.Exception.Message -ne "Credential ACL validation failed.") {
            throw
        }
        $rejected = $true
    }
    if (-not $rejected) {
        throw "Broad ACL was accepted."
    }

    $systemSid = [Security.Principal.SecurityIdentifier]::new("S-1-5-18")
    $administratorsSid = [Security.Principal.SecurityIdentifier]::new(
        "S-1-5-32-544"
    )
    $currentIdentity = [Security.Principal.SecurityIdentifier]::new($currentSid)
    $trustedIdentities = @(
        $currentIdentity,
        $systemSid,
        $administratorsSid
    )
    $runtimeTrustedSids = @(
        $currentSid,
        $systemSid.Value,
        $administratorsSid.Value,
        "S-1-5-80-956008885-3418522649-1831038044-1853292631-2271478464"
    )

    Set-RestrictedTestFileAcl `
        -Path $withoutSystemReadFile `
        -TrustedIdentities @($currentIdentity, $administratorsSid)
    try {
        Assert-BridgeServiceCredentialAcl `
            -Path $withoutSystemReadFile `
            -TrustedSids $runtimeTrustedSids
        throw "Credential without LocalSystem read access was accepted."
    }
    catch {
        if ($_.Exception.Message -ne "Credential ACL validation failed.") {
            throw
        }
    }

    $denyEveryoneReadRule = [Security.AccessControl.FileSystemAccessRule]::new(
        $everyone,
        [Security.AccessControl.FileSystemRights]::ReadData,
        [Security.AccessControl.AccessControlType]::Deny
    )
    Set-RestrictedTestFileAcl `
        -Path $deniedSystemReadFile `
        -TrustedIdentities $trustedIdentities `
        -AdditionalRules $denyEveryoneReadRule
    try {
        Assert-BridgeServiceCredentialAcl `
            -Path $deniedSystemReadFile `
            -TrustedSids $runtimeTrustedSids
        throw "Credential with denied LocalSystem read access was accepted."
    }
    catch {
        if ($_.Exception.Message -ne "Credential ACL validation failed.") {
            throw
        }
    }

    $serviceSid = [Security.Principal.SecurityIdentifier]::new("S-1-5-6")
    $denyServiceReadRule = [Security.AccessControl.FileSystemAccessRule]::new(
        $serviceSid,
        [Security.AccessControl.FileSystemRights]::ReadData,
        [Security.AccessControl.AccessControlType]::Deny
    )
    Set-RestrictedTestFileAcl `
        -Path $deniedServiceReadFile `
        -TrustedIdentities $trustedIdentities `
        -AdditionalRules $denyServiceReadRule
    try {
        Assert-BridgeServiceCredentialAcl `
            -Path $deniedServiceReadFile `
            -TrustedSids $runtimeTrustedSids
        throw "Credential denied to the service SID was accepted."
    }
    catch {
        if ($_.Exception.Message -ne "Credential ACL validation failed.") {
            throw
        }
    }

    $ancestorCreateRule = [Security.AccessControl.FileSystemAccessRule]::new(
        $everyone,
        [Security.AccessControl.FileSystemRights]::CreateDirectories,
        [Security.AccessControl.AccessControlType]::Allow
    )
    New-Item -ItemType Directory -Path $temporaryRoot | Out-Null
    Set-RestrictedTestDirectoryAcl `
        -Path $temporaryRoot `
        -TrustedIdentities $trustedIdentities `
        -AdditionalRules $ancestorCreateRule

    New-Item -ItemType Directory -Path $protectedLeaf | Out-Null
    Set-RestrictedTestDirectoryAcl `
        -Path $protectedLeaf `
        -TrustedIdentities $trustedIdentities

    $runtimeMutationRights = (
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
    Assert-BridgeServiceRuntimePath `
        -Path $protectedLeaf `
        -TrustedSids $runtimeTrustedSids `
        -LeafMutationRights $runtimeMutationRights

    $leafWriteRule = [Security.AccessControl.FileSystemAccessRule]::new(
        $everyone,
        [Security.AccessControl.FileSystemRights]::WriteData,
        [Security.AccessControl.AccessControlType]::Allow
    )
    New-Item -ItemType Directory -Path $unsafeLeaf | Out-Null
    Set-RestrictedTestDirectoryAcl `
        -Path $unsafeLeaf `
        -TrustedIdentities $trustedIdentities `
        -AdditionalRules $leafWriteRule
    try {
        Assert-BridgeServiceRuntimePath `
            -Path $unsafeLeaf `
            -TrustedSids $runtimeTrustedSids `
            -LeafMutationRights $runtimeMutationRights
        throw "Untrusted leaf write access was accepted."
    }
    catch {
        if ($_.Exception.Message -ne "Runtime integrity validation failed.") {
            throw
        }
    }

    $ancestorDeleteRule = [Security.AccessControl.FileSystemAccessRule]::new(
        $everyone,
        [Security.AccessControl.FileSystemRights]::DeleteSubdirectoriesAndFiles,
        [Security.AccessControl.AccessControlType]::Allow
    )
    New-Item -ItemType Directory -Path $replacementRoot | Out-Null
    Set-RestrictedTestDirectoryAcl `
        -Path $replacementRoot `
        -TrustedIdentities $trustedIdentities `
        -AdditionalRules $ancestorDeleteRule
    New-Item -ItemType Directory -Path $replacementLeaf | Out-Null
    Set-RestrictedTestDirectoryAcl `
        -Path $replacementLeaf `
        -TrustedIdentities $trustedIdentities
    try {
        Assert-BridgeServiceRuntimePath `
            -Path $replacementLeaf `
            -TrustedSids $runtimeTrustedSids `
            -LeafMutationRights $runtimeMutationRights
        throw "Untrusted ancestor replacement access was accepted."
    }
    catch {
        if ($_.Exception.Message -ne "Runtime integrity validation failed.") {
            throw
        }
    }

    Write-Output "ACL_BEHAVIORAL_PROOF_PASS"
}
finally {
    Remove-Item -LiteralPath $temporaryFile -Force -ErrorAction SilentlyContinue
    Remove-Item -LiteralPath $withoutSystemReadFile -Force -ErrorAction SilentlyContinue
    Remove-Item -LiteralPath $deniedSystemReadFile -Force -ErrorAction SilentlyContinue
    Remove-Item -LiteralPath $deniedServiceReadFile -Force -ErrorAction SilentlyContinue
    Remove-Item -LiteralPath $protectedLeaf -Force -ErrorAction SilentlyContinue
    Remove-Item -LiteralPath $unsafeLeaf -Force -ErrorAction SilentlyContinue
    Remove-Item -LiteralPath $temporaryRoot -Force -ErrorAction SilentlyContinue
    Remove-Item -LiteralPath $replacementLeaf -Force -ErrorAction SilentlyContinue
    Remove-Item -LiteralPath $replacementRoot -Force -ErrorAction SilentlyContinue
    Remove-Module BridgeServiceSecurity -Force -ErrorAction SilentlyContinue
}
