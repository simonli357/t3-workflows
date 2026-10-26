param([Parameter(Mandatory=$true)][string]$Request)
$ErrorActionPreference='Stop'
$r=Get-Content -LiteralPath $Request -Raw | ConvertFrom-Json
$found=@(Get-NetTCPConnection -LocalPort $r.port -State Listen -ErrorAction SilentlyContinue)
@{listening=($found.Count -gt 0)} | ConvertTo-Json -Compress
