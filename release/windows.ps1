param([string]$Action, [string]$Executable, [int]$Port, [int]$MainPid = 0, [int]$CloseSeconds = 600)
$ErrorActionPreference = 'Stop'
if ($Executable) { $Executable = [IO.Path]::GetFullPath($Executable) }
if ($Action -eq 'interactive') {
    $session = (Get-Process -Id $PID).SessionId
    if ($session -eq 0 -or !(Get-Process explorer -ErrorAction SilentlyContinue | Where-Object SessionId -eq $session)) {
        throw 'In signed-in desktop PowerShell run: node "$HOME\t3-workflows\bin\t3w.mjs" release --ref origin/main. Scheduled tasks must use LogonType Interactive.'
    }
    exit 0
}
function DesktopProcesses {
    $name = [WildcardPattern]::Escape([IO.Path]::GetFileNameWithoutExtension($Executable))
    @(Get-Process -Name $name -ErrorAction SilentlyContinue | Where-Object { $_.Path -ieq $Executable })
}
function WaitClosed {
    # Closed is a state, not an event: a close that finishes late or was already done counts.
    $deadline = (Get-Date).AddSeconds($CloseSeconds)
    while ((DesktopProcesses).Count -or @(Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue).Count) {
        if ((Get-Date) -ge $deadline) { throw "Desktop did not close within $CloseSeconds seconds; no force used" }
        Start-Sleep -Seconds 1
    }
}
# Exit 0 while any desktop process exists, 3 when none does; other codes are errors.
if ($Action -eq 'running') { if ((DesktopProcesses).Count) { exit 0 } else { exit 3 } }
# Same captured-process close used by the existing custom-release activation.
$owners = @(Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue | Select-Object -ExpandProperty OwningProcess -Unique)
if ($owners.Count -eq 0 -and $Action -eq 'stop') {
    # Nothing listens: the desktop is closed, still closing, or failed before binding.
    # Only ask the exact process we launched to close; otherwise just wait.
    $main = if ($MainPid -gt 0) { Get-Process -Id $MainPid -ErrorAction SilentlyContinue }
    if ($main) {
        if ($main.Path -ine $Executable) { throw 'Launched desktop identity changed' }
        & taskkill.exe /PID $MainPid | Out-Null
        if ($LASTEXITCODE -ne 0 -and !$main.HasExited) { throw 'Graceful desktop close failed' }
    }
    WaitClosed
    exit 0
}
if ($owners.Count -ne 1) { throw 'Expected exactly one desktop listener owner' }
$backend = Get-CimInstance Win32_Process -Filter ('ProcessId=' + [int]$owners[0])
$parent = Get-CimInstance Win32_Process -Filter ('ProcessId=' + [int]$backend.ParentProcessId)
if ($backend.ExecutablePath -ine $Executable -or $parent.ExecutablePath -ine $Executable) { throw 'Desktop executable identity changed' }
if ($Action -eq 'inspect') { exit 0 }
if ($Action -ne 'stop') { throw 'Unknown action' }
& taskkill.exe /PID $parent.ProcessId | Out-Null
if ($LASTEXITCODE -ne 0) { throw 'Graceful desktop close failed' }
WaitClosed
