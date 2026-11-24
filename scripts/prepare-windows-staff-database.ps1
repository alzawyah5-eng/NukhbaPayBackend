[CmdletBinding()]
param()
$ErrorActionPreference='Stop'
$Host.UI.RawUI.WindowTitle='NukhbaPay | Windows PostgreSQL database setup'
$instance='postgresql-x64-18'
$status=Join-Path $PSScriptRoot '..\.local\windows-staff-database-status.txt'
try {
  Set-Content -LiteralPath $status -Value 'awaiting-private-postgres-login' -Encoding ascii
  if((Get-Service -Name $instance).Status -ne 'Running'){throw 'The Windows PostgreSQL service is unavailable.'}
  $registration=(Get-ItemProperty -LiteralPath ('HKLM:\SYSTEM\CurrentControlSet\Services\'+$instance) -Name ImagePath).ImagePath
  $directory=[regex]::Match($registration,'(?i)\s-D\s+"([^"]+)"')
  if(-not $directory.Success){throw 'The registered PostgreSQL data directory is unavailable.'}
  $psql=Join-Path $env:ProgramFiles 'PostgreSQL\18\bin\psql.exe'
  $sql=Join-Path $PSScriptRoot 'prepare-windows-staff-database.sql'
  $env:PGCONNECT_TIMEOUT='8'
  Write-Host 'Target: new database nukhbapay_staff on Windows PostgreSQL 18, 127.0.0.1:5432.'
  Write-Host 'Enter the local PostgreSQL postgres password at the hidden prompt. Close this window to cancel.'
  & $psql -X -W -h 127.0.0.1 -p 5432 -d postgres -U postgres -v ON_ERROR_STOP=1 -v "registered_directory=$($directory.Groups[1].Value)" -f $sql
  if($LASTEXITCODE -ne 0){throw 'Database setup stopped. See the PostgreSQL message above.'}
  Set-Content -LiteralPath $status -Value 'windows-database-created-and-verified' -Encoding ascii
  Write-Host 'The persistent database is ready for schema provisioning. The portal has not been switched.'
}catch{
  Set-Content -LiteralPath $status -Value 'windows-database-setup-stopped' -Encoding ascii
  Write-Host $_.Exception.Message
}
[void](Read-Host 'Press Enter to close')
