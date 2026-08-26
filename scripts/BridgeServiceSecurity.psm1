Set-StrictMode -Version Latest

function ConvertTo-BridgeServiceSid {
    param([Parameter(Mandatory)] [object] $IdentityReference)

    if ($IdentityReference -is [Security.Principal.SecurityIdentifier]) {
        return $IdentityReference.Value
    }
    return ([Security.Principal.NTAccount]::new(
        [string] $IdentityReference
    ).Translate([Security.Principal.SecurityIdentifier])).Value
}

function Test-BridgeServiceAccessRuleAppliesToItem {
    param(
        [Parameter(Mandatory)]
        [Security.AccessControl.FileSystemAccessRule] $Rule
    )

    return (($Rule.PropagationFlags -band
        [Security.AccessControl.PropagationFlags]::InheritOnly) -eq 0)
}

function Assert-BridgeServiceLocalSystemReadAccess {
    param([Parameter(Mandatory)] [string] $Path)

    try {
        $acl = Get-Acl -LiteralPath $Path
        $item = Get-Item -LiteralPath $Path -Force
        if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
            throw "Service identity read validation failed."
        }
        $requiredReadRights = [Security.AccessControl.FileSystemRights]::Read
        $localSystemSid = "S-1-5-18"
        $localSystemTokenSids = @(
            "S-1-1-0",
            "S-1-5-6",
            "S-1-5-11",
            $localSystemSid,
            "S-1-5-32-544"
        )
        $hasLocalSystemRead = $false
        foreach ($rule in $acl.Access) {
            if (-not (Test-BridgeServiceAccessRuleAppliesToItem -Rule $rule)) {
                continue
            }
            $sid = ConvertTo-BridgeServiceSid -IdentityReference $rule.IdentityReference
            if (
                $rule.AccessControlType -eq [Security.AccessControl.AccessControlType]::Deny -and
                $localSystemTokenSids -contains $sid -and
                (($rule.FileSystemRights -band $requiredReadRights) -ne 0)
            ) {
                throw "Service identity read validation failed."
            }
            if (
                $rule.AccessControlType -eq [Security.AccessControl.AccessControlType]::Allow -and
                $sid -eq $localSystemSid -and
                (($rule.FileSystemRights -band $requiredReadRights) -eq $requiredReadRights)
            ) {
                $hasLocalSystemRead = $true
            }
        }
        if (-not $hasLocalSystemRead) {
            throw "Service identity read validation failed."
        }
    }
    catch {
        throw "Service identity read validation failed."
    }
}

function Assert-BridgeServiceCredentialAcl {
    param(
        [Parameter(Mandatory)] [string] $Path,
        [Parameter(Mandatory)] [string[]] $TrustedSids
    )

    try {
        Assert-BridgeServiceLocalSystemReadAccess -Path $Path
        $acl = Get-Acl -LiteralPath $Path
        $item = Get-Item -LiteralPath $Path -Force
        if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
            throw "Credential ACL validation failed."
        }
        $ownerSid = ConvertTo-BridgeServiceSid -IdentityReference $acl.Owner
        if ($TrustedSids -notcontains $ownerSid) {
            throw "Credential ACL validation failed."
        }
        $anyFileSystemRights = [Security.AccessControl.FileSystemRights]::FullControl
        foreach ($rule in $acl.Access) {
            if (-not (Test-BridgeServiceAccessRuleAppliesToItem -Rule $rule)) {
                continue
            }
            $sid = ConvertTo-BridgeServiceSid -IdentityReference $rule.IdentityReference
            if (
                $rule.AccessControlType -eq [Security.AccessControl.AccessControlType]::Allow -and
                $TrustedSids -notcontains $sid -and
                (($rule.FileSystemRights -band $anyFileSystemRights) -ne 0)
            ) {
                throw "Credential ACL validation failed."
            }
        }
    }
    catch {
        throw "Credential ACL validation failed."
    }
}

function Assert-BridgeServiceRuntimeItem {
    param(
        [Parameter(Mandatory)] [string] $Path,
        [Parameter(Mandatory)] [string[]] $TrustedSids,
        [Parameter(Mandatory)]
        [Security.AccessControl.FileSystemRights] $ProhibitedRights
    )

    try {
        $acl = Get-Acl -LiteralPath $Path
        $item = Get-Item -LiteralPath $Path -Force
        if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
            throw "Runtime integrity validation failed."
        }
        $ownerSid = ConvertTo-BridgeServiceSid -IdentityReference $acl.Owner
        if ($TrustedSids -notcontains $ownerSid) {
            throw "Runtime integrity validation failed."
        }
        foreach ($rule in $acl.Access) {
            if ($rule.AccessControlType -ne [Security.AccessControl.AccessControlType]::Allow) {
                continue
            }
            if (-not (Test-BridgeServiceAccessRuleAppliesToItem -Rule $rule)) {
                continue
            }
            $sid = ConvertTo-BridgeServiceSid `
                -IdentityReference $rule.IdentityReference
            if (
                $TrustedSids -notcontains $sid -and
                (($rule.FileSystemRights -band $ProhibitedRights) -ne 0)
            ) {
                throw "Runtime integrity validation failed."
            }
        }
    }
    catch {
        throw "Runtime integrity validation failed."
    }
}

function Assert-BridgeServiceRuntimePath {
    param(
        [Parameter(Mandatory)] [string] $Path,
        [Parameter(Mandatory)] [string[]] $TrustedSids,
        [Parameter(Mandatory)]
        [Security.AccessControl.FileSystemRights] $LeafMutationRights
    )

    try {
        $item = Get-Item -LiteralPath $Path -Force
        Assert-BridgeServiceRuntimeItem `
            -Path $item.FullName `
            -TrustedSids $TrustedSids `
            -ProhibitedRights $LeafMutationRights

        $ancestorReplacementRights = (
            [Security.AccessControl.FileSystemRights]::DeleteSubdirectoriesAndFiles -bor
            [Security.AccessControl.FileSystemRights]::Delete -bor
            [Security.AccessControl.FileSystemRights]::ChangePermissions -bor
            [Security.AccessControl.FileSystemRights]::TakeOwnership
        )
        $ancestorPath = Split-Path -Parent $item.FullName
        while ($ancestorPath) {
            $ancestor = Get-Item -LiteralPath $ancestorPath -Force
            Assert-BridgeServiceRuntimeItem `
                -Path $ancestor.FullName `
                -TrustedSids $TrustedSids `
                -ProhibitedRights $ancestorReplacementRights
            $nextAncestorPath = Split-Path -Parent $ancestor.FullName
            if ($nextAncestorPath -eq $ancestor.FullName) {
                break
            }
            $ancestorPath = $nextAncestorPath
        }
    }
    catch {
        throw "Runtime integrity validation failed."
    }
}

Export-ModuleMember -Function @(
    "ConvertTo-BridgeServiceSid",
    "Assert-BridgeServiceLocalSystemReadAccess",
    "Assert-BridgeServiceCredentialAcl",
    "Assert-BridgeServiceRuntimeItem",
    "Assert-BridgeServiceRuntimePath"
)
