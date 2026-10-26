param([Parameter(Mandatory=$true)][string]$Request)
$ErrorActionPreference='Stop'
$r=Get-Content -LiteralPath $Request -Raw | ConvertFrom-Json
if($r.verifyOwner){
  $connections=@(Get-NetTCPConnection -LocalPort $r.port -State Listen)
  $owners=@($connections.OwningProcess | Sort-Object -Unique)
  if($owners.Count -ne 1){throw 'Listener owner is not unique'}
  $backend=Get-CimInstance Win32_Process -Filter ('ProcessId=' + [int]$owners[0])
  $parent=Get-CimInstance Win32_Process -Filter ('ProcessId=' + [int]$backend.ParentProcessId)
  if($backend.ExecutablePath -ine $r.executable -or $parent.ExecutablePath -ine $r.executable){throw 'Desktop executable identity differs'}
}
$measurements=foreach($item in $r.paths){
  $volume=Get-Volume -FilePath $item
  $partitions=@(Get-Partition -Volume $volume)
  $drives=@($partitions | Get-Disk)
  if($drives.Count -ne 1){throw 'Cannot identify backing disk'}
  $disk=$drives[0]
  $type=if($disk.BusType -eq 'USB'){'usb'}elseif($volume.DriveType -ne 'Fixed'){'removable'}else{'fixed'}
  @{path=$item;device=$volume.UniqueId;freeBytes=[long]$volume.SizeRemaining;blockBytes=[long]$volume.AllocationUnitSize;type=$type;model=$disk.FriendlyName}
}
@{portOwnerVerified=[bool]$r.verifyOwner;disks=@($measurements)} | ConvertTo-Json -Depth 5 -Compress
