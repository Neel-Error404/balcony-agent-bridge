Set-StrictMode -Version Latest

function New-DispatcherServiceAdapter {
    return @{
        GetSnapshot = {
            param([string] $ServiceName)

            $service = Get-CimInstance Win32_Service `
                -Filter "Name='$ServiceName'"
            if (-not $service) {
                throw "The dispatcher service is not installed."
            }
            $children = if ($service.ProcessId -gt 0) {
                @(
                    Get-CimInstance Win32_Process -Filter "Name='node.exe'" |
                        Where-Object {
                            $_.ParentProcessId -eq $service.ProcessId
                        }
                )
            }
            else {
                @()
            }
            return [pscustomobject]@{
                State = [string] $service.State
                StartMode = [string] $service.StartMode
                ProcessId = [uint32] $service.ProcessId
                ChildProcessIds = @(
                    $children | ForEach-Object { [uint32] $_.ProcessId }
                )
                ChildCount = [int] $children.Count
            }
        }
        ProcessExists = {
            param([uint32] $ProcessId)

            return [bool] (Get-CimInstance Win32_Process `
                -Filter "ProcessId=$ProcessId" -ErrorAction SilentlyContinue)
        }
        Stop = {
            param([string] $ServiceName)

            Stop-Service -Name $ServiceName -Force -ErrorAction Stop
        }
        Start = {
            param([string] $ServiceName)

            Start-Service -Name $ServiceName -ErrorAction Stop
        }
        Sleep = {
            param([int] $Milliseconds)

            Start-Sleep -Milliseconds $Milliseconds
        }
    }
}

function Assert-DispatcherLifecycleAdapter {
    param([Parameter(Mandatory)] [hashtable] $Adapter)

    foreach ($key in @(
        "GetSnapshot",
        "ProcessExists",
        "Stop",
        "Start",
        "Sleep"
    )) {
        if (-not $Adapter.ContainsKey($key) -or $Adapter[$key] -isnot [scriptblock]) {
            throw "The dispatcher lifecycle adapter is incomplete."
        }
    }
}

function Get-DispatcherServiceSnapshot {
    param(
        [Parameter(Mandatory)] [string] $ServiceName,
        [Parameter(Mandatory)] [hashtable] $Adapter
    )

    Assert-DispatcherLifecycleAdapter -Adapter $Adapter
    $snapshot = & $Adapter.GetSnapshot $ServiceName
    if (-not $snapshot) {
        throw "The dispatcher service snapshot is unavailable."
    }
    return $snapshot
}

function Get-DispatcherPollCount {
    param(
        [Parameter(Mandatory)] [int] $TimeoutSeconds,
        [Parameter(Mandatory)] [int] $PollIntervalMs
    )

    return [Math]::Max(
        1,
        [int] [Math]::Ceiling(($TimeoutSeconds * 1000) / $PollIntervalMs)
    )
}

function Wait-DispatcherServiceQuiesced {
    param(
        [Parameter(Mandatory)] [string] $ServiceName,
        [Parameter(Mandatory)] [hashtable] $Adapter,
        [uint32[]] $TrackedProcessIds = @(),
        [ValidateRange(1, 120)] [int] $TimeoutSeconds = 30,
        [ValidateRange(50, 5000)] [int] $PollIntervalMs = 250
    )

    $pollCount = Get-DispatcherPollCount `
        -TimeoutSeconds $TimeoutSeconds -PollIntervalMs $PollIntervalMs
    for ($poll = 0; $poll -le $pollCount; $poll++) {
        $snapshot = Get-DispatcherServiceSnapshot `
            -ServiceName $ServiceName -Adapter $Adapter
        $trackedProcessExists = $false
        foreach ($processId in @($TrackedProcessIds | Select-Object -Unique)) {
            if ($processId -gt 0 -and (& $Adapter.ProcessExists $processId)) {
                $trackedProcessExists = $true
                break
            }
        }
        if (
            $snapshot.State -eq "Stopped" -and
            $snapshot.ProcessId -eq 0 -and
            $snapshot.ChildCount -eq 0 -and
            -not $trackedProcessExists
        ) {
            return $snapshot
        }
        if ($poll -lt $pollCount) {
            & $Adapter.Sleep $PollIntervalMs
        }
    }

    $exception = New-Object InvalidOperationException(
        "The dispatcher service did not reach a quiesced stopped state."
    )
    $exception.Data["DispatcherStage"] = "service-stop-quiescence"
    throw $exception
}

function Stop-DispatcherServiceAndWait {
    param(
        [Parameter(Mandatory)] [string] $ServiceName,
        [Parameter(Mandatory)] [hashtable] $Adapter,
        [ValidateRange(1, 120)] [int] $TimeoutSeconds = 30,
        [ValidateRange(50, 5000)] [int] $PollIntervalMs = 250
    )

    $initial = Get-DispatcherServiceSnapshot `
        -ServiceName $ServiceName -Adapter $Adapter
    $trackedProcessIds = @(
        [uint32] $initial.ProcessId
        @($initial.ChildProcessIds | ForEach-Object { [uint32] $_ })
    ) | Where-Object { $_ -gt 0 } | Select-Object -Unique

    if (
        $initial.State -ne "Stopped" -or
        $initial.ProcessId -ne 0 -or
        $initial.ChildCount -ne 0
    ) {
        try {
            & $Adapter.Stop $ServiceName
        }
        catch {
            $_.Exception.Data["DispatcherStage"] = "service-stop-request"
            throw
        }
    }

    return Wait-DispatcherServiceQuiesced `
        -ServiceName $ServiceName `
        -Adapter $Adapter `
        -TrackedProcessIds $trackedProcessIds `
        -TimeoutSeconds $TimeoutSeconds `
        -PollIntervalMs $PollIntervalMs
}

function Wait-DispatcherServiceHealthy {
    param(
        [Parameter(Mandatory)] [string] $ServiceName,
        [Parameter(Mandatory)] [hashtable] $Adapter,
        [ValidateRange(1, 120)] [int] $TimeoutSeconds = 30,
        [ValidateRange(50, 5000)] [int] $PollIntervalMs = 250
    )

    $pollCount = Get-DispatcherPollCount `
        -TimeoutSeconds $TimeoutSeconds -PollIntervalMs $PollIntervalMs
    for ($poll = 0; $poll -le $pollCount; $poll++) {
        $snapshot = Get-DispatcherServiceSnapshot `
            -ServiceName $ServiceName -Adapter $Adapter
        if (
            $snapshot.State -eq "Running" -and
            $snapshot.ProcessId -gt 0 -and
            $snapshot.ChildCount -eq 1
        ) {
            return $snapshot
        }
        if ($poll -lt $pollCount) {
            & $Adapter.Sleep $PollIntervalMs
        }
    }

    $exception = New-Object InvalidOperationException(
        "The dispatcher service did not reach the required one-child state."
    )
    $exception.Data["DispatcherStage"] = "service-start-health"
    throw $exception
}

function Start-DispatcherServiceWithRetry {
    param(
        [Parameter(Mandatory)] [string] $ServiceName,
        [Parameter(Mandatory)] [hashtable] $Adapter,
        [ValidateRange(1, 5)] [int] $MaxAttempts = 3,
        [ValidateRange(1, 120)] [int] $HealthTimeoutSeconds = 30,
        [ValidateRange(50, 5000)] [int] $PollIntervalMs = 250,
        [ValidateRange(0, 10000)] [int] $RetryDelayMs = 1000
    )

    $lastError = $null
    for ($attempt = 1; $attempt -le $MaxAttempts; $attempt++) {
        try {
            & $Adapter.Start $ServiceName
            return Wait-DispatcherServiceHealthy `
                -ServiceName $ServiceName `
                -Adapter $Adapter `
                -TimeoutSeconds $HealthTimeoutSeconds `
                -PollIntervalMs $PollIntervalMs
        }
        catch {
            $lastError = $_
        }

        if ($attempt -lt $MaxAttempts) {
            Stop-DispatcherServiceAndWait `
                -ServiceName $ServiceName `
                -Adapter $Adapter `
                -TimeoutSeconds $HealthTimeoutSeconds `
                -PollIntervalMs $PollIntervalMs | Out-Null
            if ($RetryDelayMs -gt 0) {
                & $Adapter.Sleep $RetryDelayMs
            }
        }
    }

    $exception = New-Object InvalidOperationException(
        "The dispatcher service failed its bounded start attempts.",
        $lastError.Exception
    )
    $exception.Data["DispatcherStage"] = "service-start-retry"
    $exception.Data["DispatcherStartAttempts"] = $MaxAttempts
    throw $exception
}

function Format-DispatcherServiceFailure {
    param(
        [Parameter(Mandatory)] [string] $Stage,
        [Parameter(Mandatory)] [Management.Automation.ErrorRecord] $ErrorRecord,
        [Parameter(Mandatory)] $Snapshot
    )

    $exception = $ErrorRecord.Exception
    while ($exception.InnerException) {
        $exception = $exception.InnerException
    }
    $nativeCode = if ($exception -is [ComponentModel.Win32Exception]) {
        [string] $exception.NativeErrorCode
    }
    else {
        "none"
    }
    $hresult = "0x{0:X8}" -f ($exception.HResult -band 0xffffffffL)
    return (
        "stage=$Stage;" +
        "errorType=$($exception.GetType().FullName);" +
        "hresult=$hresult;" +
        "nativeCode=$nativeCode;" +
        "serviceState=$($Snapshot.State);" +
        "startMode=$($Snapshot.StartMode);" +
        "processId=$($Snapshot.ProcessId);" +
        "childCount=$($Snapshot.ChildCount)"
    )
}

Export-ModuleMember -Function @(
    "New-DispatcherServiceAdapter",
    "Get-DispatcherServiceSnapshot",
    "Wait-DispatcherServiceQuiesced",
    "Stop-DispatcherServiceAndWait",
    "Wait-DispatcherServiceHealthy",
    "Start-DispatcherServiceWithRetry",
    "Format-DispatcherServiceFailure"
)
