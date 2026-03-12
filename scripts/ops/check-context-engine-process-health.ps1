[CmdletBinding()]
param(
    [switch]$KillDuplicates
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

function Get-RepoRoot {
    param([string]$ScriptPath)

    $opsDir = Split-Path -Parent $ScriptPath
    $scriptsDir = Split-Path -Parent $opsDir
    return Split-Path -Parent $scriptsDir
}

function Get-NormalizedPath {
    param([string]$Path)

    return ($Path -replace '/', '\\').ToLowerInvariant()
}

function Get-ContextEngineProcesses {
    param([string]$RepoRoot)

    $repoRootNorm = Get-NormalizedPath -Path $RepoRoot

    $allNodeProcesses = Get-CimInstance Win32_Process -Filter "Name='node.exe'" |
        Where-Object { $null -ne $_.CommandLine }

    $matches = foreach ($proc in $allNodeProcesses) {
        $cmdRaw = [string]$proc.CommandLine
        $cmdNorm = Get-NormalizedPath -Path $cmdRaw

        # Match both relative (dist/index.js) and absolute paths (...\dist\index.js)
        # so normal Windows absolute command lines are detected reliably.
        $hasDistIndex = $cmdNorm -match '(?i)(^|[\s"\\/])dist[\\/]+index\.js(\s|"|$)'
        $hasRepoRoot = $cmdNorm.Contains($repoRootNorm)

        if ($hasDistIndex -and $hasRepoRoot) {
            [PSCustomObject]@{
                ProcessId    = [int]$proc.ProcessId
                CreationDate = [Management.ManagementDateTimeConverter]::ToDateTime($proc.CreationDate)
                CommandLine  = $cmdRaw
            }
        }
    }

    return $matches | Sort-Object -Property CreationDate -Descending
}

function Write-Result {
    param(
        [string]$Status,
        [string]$Message,
        [int[]]$Pids,
        [int[]]$KeptPids,
        [int[]]$StoppedPids,
        [int[]]$FailedPids
    )

    $pidText = if ($Pids.Count -gt 0) { ($Pids -join ', ') } else { 'none' }
    $keptText = if ($KeptPids.Count -gt 0) { ($KeptPids -join ', ') } else { 'none' }
    $stoppedText = if ($StoppedPids.Count -gt 0) { ($StoppedPids -join ', ') } else { 'none' }
    $failedText = if ($FailedPids.Count -gt 0) { ($FailedPids -join ', ') } else { 'none' }

    Write-Output "[$Status] $Message"
    Write-Output "- Matching PIDs: $pidText"
    Write-Output "- Kept PID(s): $keptText"
    Write-Output "- Stopped PID(s): $stoppedText"
    Write-Output "- Failed stop PID(s): $failedText"
}

try {
    $repoRoot = Get-RepoRoot -ScriptPath $PSCommandPath
    $processes = @(Get-ContextEngineProcesses -RepoRoot $repoRoot)
    $pids = @($processes | ForEach-Object { $_.ProcessId })

    if ($processes.Count -eq 0) {
        Write-Result -Status 'WARN' -Message 'No context-engine dist/index.js MCP process found.' -Pids $pids -KeptPids @() -StoppedPids @() -FailedPids @()
        exit 1
    }

    if ($processes.Count -eq 1) {
        Write-Result -Status 'PASS' -Message 'Single context-engine dist/index.js MCP process detected.' -Pids $pids -KeptPids $pids -StoppedPids @() -FailedPids @()
        exit 0
    }

    if (-not $KillDuplicates) {
        Write-Result -Status 'WARN' -Message 'Duplicate context-engine dist/index.js MCP processes detected. Re-run with -KillDuplicates to keep one latest process.' -Pids $pids -KeptPids @($processes[0].ProcessId) -StoppedPids @() -FailedPids @()
        exit 1
    }

    $keeper = $processes[0]
    $toStop = @($processes | Select-Object -Skip 1)
    $stopped = @()
    $failed = @()

    foreach ($proc in $toStop) {
        try {
            Stop-Process -Id $proc.ProcessId -Force -ErrorAction Stop
            $stopped += $proc.ProcessId
        }
        catch {
            $failed += $proc.ProcessId
        }
    }

    if ($failed.Count -gt 0) {
        Write-Result -Status 'FAIL' -Message 'Duplicate process cleanup failed for one or more PIDs.' -Pids $pids -KeptPids @($keeper.ProcessId) -StoppedPids $stopped -FailedPids $failed
        exit 1
    }

    Write-Result -Status 'PASS' -Message 'Duplicate process cleanup succeeded. Kept latest process and stopped extras.' -Pids $pids -KeptPids @($keeper.ProcessId) -StoppedPids $stopped -FailedPids @()
    exit 0
}
catch {
    Write-Output "[FAIL] Unexpected error while checking context-engine MCP process health: $($_.Exception.Message)"
    exit 1
}
