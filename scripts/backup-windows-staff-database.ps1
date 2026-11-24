[CmdletBinding()]
param()
$ErrorActionPreference='Stop'
$Host.UI.RawUI.WindowTitle='NukhbaPay | Back up the Windows staff database'
$root=(Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$state=Join-Path $root '.local'
$status=Join-Path $state 'windows-staff-backup-status.txt'
$bin=Join-Path $env:ProgramFiles 'PostgreSQL\18\bin'
$phase='inspect'
try {
  $pin=Get-Content -LiteralPath (Join-Path $state 'windows-staff-inspection.json') -Raw | ConvertFrom-Json
  $registration=(Get-ItemProperty -LiteralPath 'HKLM:\SYSTEM\CurrentControlSet\Services\postgresql-x64-18' -Name ImagePath).ImagePath
  $directory=[regex]::Match($registration,'(?i)\s-D\s+"([^"]+)"')
  if(!$directory.Success -or (Get-Service postgresql-x64-18).Status -ne 'Running' -or !$pin.targetVerified){throw 'Target unavailable'}
  $env:PGHOSTADDR='127.0.0.1'
  $env:PGREQUIREAUTH='scram-sha-256'
  $env:PGCONNECT_TIMEOUT='5'
  $env:PGOPTIONS='-c default_transaction_read_only=on -c search_path=pg_catalog -c statement_timeout=30000'
  Remove-Item Env:PGSERVICE -ErrorAction SilentlyContinue
  Set-Content $status 'waiting-for-private-backup-password'
  $value=Read-Host 'Windows PostgreSQL postgres password for a read-only backup of nukhbapay_staff' -AsSecureString
  $buffer=[Runtime.InteropServices.Marshal]::SecureStringToBSTR($value)
  try {$env:PGPASSWORD=[Runtime.InteropServices.Marshal]::PtrToStringBSTR($buffer)}finally{[Runtime.InteropServices.Marshal]::ZeroFreeBSTR($buffer);$value.Dispose()}
  $argsDb=@('-h','127.0.0.1','-p','5432','-U','postgres','-w','-d','nukhbapay_staff')
  $raw=& (Join-Path $bin 'psql.exe') @argsDb -X -qAt -v ON_ERROR_STOP=1 -v ("service_directory="+$directory.Groups[1].Value) -f (Join-Path $PSScriptRoot 'inspect-windows-staff-database.sql')
  if($LASTEXITCODE -ne 0){throw 'Private login failed'}
  $actual=$raw | ConvertFrom-Json
  if(!$actual.targetVerified -or $actual.databaseOid -ne $pin.databaseOid -or $actual.systemIdentifier -ne $pin.systemIdentifier){throw 'Target mismatch'}
  $empty=& (Join-Path $bin 'psql.exe') @argsDb -X -qAt -v ON_ERROR_STOP=1 -f (Join-Path $PSScriptRoot 'windows-staff-empty.sql')
  if($LASTEXITCODE -ne 0 -or $empty -ne 't'){throw 'Database already contains project objects or unexpected defaults'}
  $phase='archive'
  $run=[Guid]::NewGuid().ToString('N')
  $vault=Join-Path $env:LOCALAPPDATA ('Nukhbapay\staff-db-backups\'+$run)
  [void](New-Item -ItemType Directory -Path $vault)
  $sid=[Security.Principal.WindowsIdentity]::GetCurrent().User
  $acl=New-Object Security.AccessControl.DirectorySecurity
  $acl.SetOwner($sid);$acl.SetAccessRuleProtection($true,$false)
  $acl.AddAccessRule((New-Object Security.AccessControl.FileSystemAccessRule($sid,'FullControl','ContainerInherit,ObjectInherit','None','Allow')))
  Set-Acl -LiteralPath $vault -AclObject $acl
  $archive=Join-Path $vault 'staff-before-schema.dump'
  & (Join-Path $bin 'pg_dump.exe') @argsDb --format=custom --file=$archive
  if($LASTEXITCODE -ne 0){throw 'Backup failed'}
  & (Join-Path $bin 'pg_restore.exe') --list $archive | Out-Null
  if($LASTEXITCODE -ne 0){throw 'Archive unreadable'}
  $record=@{run=$run;sha256=(Get-FileHash -LiteralPath $archive -Algorithm SHA256).Hash.ToLowerInvariant();databaseOid=$pin.databaseOid;systemIdentifier=$pin.systemIdentifier}
  $record | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $state 'windows-staff-backup.json') -Encoding ascii
  Set-Content $status 'empty-windows-database-backed-up'
  Write-Host 'Backup completed. The restricted archive is ready for the restore rehearsal.'
}catch{Set-Content $status ('stopped-at-'+$phase);Write-Host ('Backup stopped at '+$phase+'.')}
finally{Remove-Item Env:PGPASSWORD -ErrorAction SilentlyContinue}
[void](Read-Host 'Press Enter to close')
