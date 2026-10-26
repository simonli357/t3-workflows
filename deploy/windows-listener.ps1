param([Parameter(Mandatory=$true)][string]$Request)
$ErrorActionPreference='Stop'
# Read-only identity of the desktop listener: the backend that owns the port and its parent, each with its OS process start time.
# Used only to prove that the app a failed attempt never closed is the same, unrestarted process. Closes and changes nothing.
$r=Get-Content -LiteralPath $Request -Raw | ConvertFrom-Json
$owners=@(Get-NetTCPConnection -LocalPort $r.port -State Listen | Select-Object -ExpandProperty OwningProcess -Unique)
if($owners.Count -ne 1){throw 'Listener owner is not unique'}
$backend=Get-CimInstance Win32_Process -Filter ('ProcessId=' + [int]$owners[0])
$parent=Get-CimInstance Win32_Process -Filter ('ProcessId=' + [int]$backend.ParentProcessId)
if($backend.ExecutablePath -ine $r.executable -or $parent.ExecutablePath -ine $r.executable){throw 'Desktop executable identity differs'}
@{backend=@{pid=[int]$backend.ProcessId;startedAt=$backend.CreationDate.ToUniversalTime().ToString('o')};parent=@{pid=[int]$parent.ProcessId;startedAt=$parent.CreationDate.ToUniversalTime().ToString('o')}} | ConvertTo-Json -Compress -Depth 4
