[CmdletBinding()]
param(
    [string] $ServiceName = "BalconyAgentDispatcher",

    [switch] $RequireAutomatic
)

$ErrorActionPreference = "Stop"
$issues = [System.Collections.Generic.List[string]]::new()
$service = Get-CimInstance Win32_Service -Filter "Name='$ServiceName'"
if (-not $service) {
    throw "Dispatcher service '$ServiceName' is not installed."
}

if ($service.State -ne "Running") {
    $issues.Add("SERVICE_NOT_RUNNING")
}
if ($service.StartName -ne "NT AUTHORITY\LocalService") {
    $issues.Add("UNEXPECTED_SERVICE_LOGON_ACCOUNT")
}
$sidType = (& sc.exe qsidtype $ServiceName | Out-String)
if ($LASTEXITCODE -ne 0 -or $sidType -notmatch "UNRESTRICTED") {
    $issues.Add("SERVICE_SID_NOT_UNRESTRICTED")
}
if ($RequireAutomatic -and $service.StartMode -ne "Auto") {
    $issues.Add("AUTOMATIC_STARTUP_NOT_ENABLED")
}

$children = @(
    Get-CimInstance Win32_Process -Filter "Name='node.exe'" |
        Where-Object { $_.ParentProcessId -eq $service.ProcessId }
)
if ($children.Count -ne 1) {
    $issues.Add("DISPATCHER_CHILD_COUNT_$($children.Count)")
}

[ordered]@{
    schemaVersion = "balcony-dispatcher-runtime-safety.v1"
    status = if ($issues.Count -eq 0) { "pass" } else { "fail" }
    service = [ordered]@{
        name = $ServiceName
        state = $service.State
        startMode = $service.StartMode
        account = $service.StartName
        uniqueServiceSid = $sidType -match "UNRESTRICTED"
        wrapperProcessId = [int]$service.ProcessId
    }
    childCount = $children.Count
    issues = @($issues)
} | ConvertTo-Json -Depth 5

if ($issues.Count -gt 0) {
    exit 1
}
