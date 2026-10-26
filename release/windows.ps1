param([string]$Action, [string]$Executable, [int]$Port, [int]$MainPid = 0)
$ErrorActionPreference = 'Stop'
if ($Executable) { $Executable = [IO.Path]::GetFullPath($Executable) }
if ($Action -eq 'interactive') {
    $session = (Get-Process -Id $PID).SessionId
    if ($session -eq 0 -or !(Get-Process explorer -ErrorAction SilentlyContinue | Where-Object SessionId -eq $session)) {
        throw 'In signed-in desktop PowerShell run: node "$HOME\t3-workflows\bin\t3w.mjs" release --ref origin/main. Scheduled tasks must use LogonType Interactive.'
    }
    exit 0
}
# Same captured-process close used by the existing custom-release activation.
$owners = @(Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue | Select-Object -ExpandProperty OwningProcess -Unique)
if ($owners.Count -eq 0 -and $MainPid -gt 0) {
    # Startup may fail before binding. Only close the exact process we launched.
    $main = Get-Process -Id $MainPid -ErrorAction SilentlyContinue
    if (!$main) { exit 0 }
    if ($main.Path -ine $Executable) { throw 'Launched desktop identity changed' }
    $children = @(Get-CimInstance Win32_Process -Filter ('ParentProcessId=' + $MainPid) | Where-Object ExecutablePath -eq $Executable | ForEach-Object { Get-Process -Id $_.ProcessId })
    & taskkill.exe /PID $MainPid | Out-Null
    if ($LASTEXITCODE -ne 0 -or !$main.WaitForExit(90000)) { throw 'Launched desktop did not close' }
    foreach ($child in $children) { if (!$child.WaitForExit(30000)) { throw 'Desktop child did not close' } }
    exit 0
}
if ($owners.Count -ne 1) { throw 'Expected exactly one desktop listener owner' }
$backend = Get-CimInstance Win32_Process -Filter ('ProcessId=' + [int]$owners[0])
$parent = Get-CimInstance Win32_Process -Filter ('ProcessId=' + [int]$backend.ParentProcessId)
if ($backend.ExecutablePath -ine $Executable -or $parent.ExecutablePath -ine $Executable) { throw 'Desktop executable identity changed' }
$mainProcess = Get-Process -Id $parent.ProcessId
$backendProcess = Get-Process -Id $backend.ProcessId
if ($Action -eq 'inspect') { exit 0 }
if ($Action -ne 'stop') { throw 'Unknown action' }
& taskkill.exe /PID $parent.ProcessId | Out-Null
if ($LASTEXITCODE -ne 0) { throw 'Graceful desktop close failed' }
if (!$mainProcess.WaitForExit(90000) -or !$backendProcess.WaitForExit(30000)) { throw 'Desktop did not close; no force used' }
if (@(Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue).Count) { throw 'Port was reclaimed' }
