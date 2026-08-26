[CmdletBinding()]
param(
    [string]$ServiceName = "BalconyAgentBridge",

    [ValidatePattern("^(?:SYS-[AB]|[a-z][a-z0-9-]{0,49})$")]
    [string]$SystemId = $env:BALCONY_SYSTEM_ID,

    [string]$ProgramDataRoot = $(
        if ($env:ProgramData) { $env:ProgramData } else { "C:\ProgramData" }
    )
)

$ErrorActionPreference = "Stop"
$issues = [System.Collections.Generic.List[string]]::new()

if (-not $SystemId) {
    throw "SystemId is required when BALCONY_SYSTEM_ID is not set."
}

$service = Get-CimInstance Win32_Service -Filter "Name='$ServiceName'"
if (-not $service) {
    throw "Bridge service '$ServiceName' is not installed."
}
if ($service.State -ne "Running") {
    $issues.Add("SERVICE_NOT_RUNNING")
}

$nodeProcesses = @(Get-CimInstance Win32_Process -Filter "Name='node.exe'")
$serviceChildren = @(
    $nodeProcesses | Where-Object { $_.ParentProcessId -eq $service.ProcessId }
)
$commandWorkers = @(
    $nodeProcesses | Where-Object {
        $_.CommandLine -and
        $_.CommandLine -match 'dist[\\/]bridge[\\/]index\.js'
    }
)

$workersById = @{}
foreach ($worker in @($serviceChildren + $commandWorkers)) {
    $workersById[[string]$worker.ProcessId] = $worker
}
$workers = @($workersById.Values)

if ($workers.Count -ne 1) {
    $issues.Add("BRIDGE_WORKER_COUNT_$($workers.Count)")
}
if ($serviceChildren.Count -ne 1) {
    $issues.Add("SERVICE_CHILD_COUNT_$($serviceChildren.Count)")
}

$lockPath = Join-Path $ProgramDataRoot (
    "Balcony\AgentBridge\runtime\{0}.bridge-worker.lock" -f $SystemId.ToLowerInvariant()
)
$lockRecord = $null
if (-not (Test-Path -LiteralPath $lockPath -PathType Leaf)) {
    $issues.Add("WORKER_LOCK_MISSING")
}
else {
    try {
        $lockRecord = Get-Content -LiteralPath $lockPath -Raw | ConvertFrom-Json
        if (-not $lockRecord.process_id) {
            $issues.Add("WORKER_LOCK_INVALID")
        }
    }
    catch {
        $issues.Add("WORKER_LOCK_UNREADABLE")
    }
}

if ($lockRecord -and $serviceChildren.Count -eq 1) {
    if ([int]$lockRecord.process_id -ne [int]$serviceChildren[0].ProcessId) {
        $issues.Add("WORKER_LOCK_OWNER_MISMATCH")
    }
}

$workerSummary = @(
    $workers | Sort-Object ProcessId | ForEach-Object {
        [pscustomobject]@{
            processId = [int]$_.ProcessId
            parentProcessId = [int]$_.ParentProcessId
            role = if ($_.ParentProcessId -eq $service.ProcessId) {
                "canonical-service-child"
            }
            else {
                "manual-or-orphaned"
            }
            startedAt = if ($_.CreationDate) {
                ([datetime]$_.CreationDate).ToUniversalTime().ToString("o")
            }
            else {
                $null
            }
        }
    }
)

$result = [ordered]@{
    schemaVersion = "balcony-bridge-runtime-safety.v1"
    systemId = $SystemId
    status = if ($issues.Count -eq 0) { "pass" } else { "fail" }
    service = [ordered]@{
        name = $ServiceName
        state = $service.State
        wrapperProcessId = [int]$service.ProcessId
    }
    workers = $workerSummary
    workerLock = [ordered]@{
        exists = Test-Path -LiteralPath $lockPath -PathType Leaf
        ownerProcessId = if ($lockRecord.process_id) {
            [int]$lockRecord.process_id
        }
        else {
            $null
        }
        acquiredAtUtc = if ($lockRecord.acquired_at_utc) {
            ([datetime]$lockRecord.acquired_at_utc).ToUniversalTime().ToString("o")
        }
        else {
            $null
        }
    }
    issues = @($issues)
}

$result | ConvertTo-Json -Depth 6
if ($issues.Count -gt 0) {
    exit 1
}
