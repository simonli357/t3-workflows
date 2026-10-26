param([Parameter(Mandatory=$true)][string]$Request)
$ErrorActionPreference='Stop'
$r=Get-Content -LiteralPath $Request -Raw | ConvertFrom-Json
$owners=@(Get-NetTCPConnection -LocalPort $r.port -State Listen | Select-Object -ExpandProperty OwningProcess -Unique)
if($owners.Count -ne 1){throw 'Listener owner changed'}
$backend=Get-CimInstance Win32_Process -Filter ('ProcessId=' + [int]$owners[0])
$parent=Get-CimInstance Win32_Process -Filter ('ProcessId=' + [int]$backend.ParentProcessId)
if($backend.ExecutablePath -ine $r.executable -or $parent.ExecutablePath -ine $r.executable){throw 'Desktop executable identity differs'}
$mainProcess=Get-Process -Id $parent.ProcessId
$backendProcess=Get-Process -Id $backend.ProcessId
# Capture handles before requesting graceful closure. No force or process-name kill.
& taskkill.exe /PID $parent.ProcessId | Out-Null
if($LASTEXITCODE -ne 0){throw 'Graceful desktop close failed'}
if(!$mainProcess.WaitForExit(90000) -or !$backendProcess.WaitForExit(30000)){throw 'Desktop did not close; no force used'}
if(@(Get-NetTCPConnection -LocalPort $r.port -State Listen -ErrorAction SilentlyContinue).Count){throw 'Port was reclaimed; stop before replacing files'}
@{closed=$true;main=$parent.ProcessId;backend=$backend.ProcessId} | ConvertTo-Json -Compress
