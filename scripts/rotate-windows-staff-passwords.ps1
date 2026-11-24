[CmdletBinding()]
param([Parameter(Mandatory=$true)][ValidatePattern('^[a-f0-9]{32}$')][string]$RunId)
$ErrorActionPreference='Stop'
$Host.UI.RawUI.WindowTitle='NukhbaPay | Rotate reader and writer passwords'
$status=Join-Path $PSScriptRoot '..\.local\windows-staff-rotation.status'
$phase='prepare'
try {
  $reg=(Get-ItemProperty 'HKLM:\SYSTEM\CurrentControlSet\Services\postgresql-x64-18' -Name ImagePath).ImagePath
  $dir=[regex]::Match($reg,'(?i)\s-D\s+"([^"]+)"')
  if(!$dir.Success -or (Get-Service postgresql-x64-18).Status -ne 'Running'){throw 'Service unavailable'}
  $env:NUKHBAPAY_REGISTERED_PG_DIRECTORY=$dir.Groups[1].Value
  $sql=& node.exe (Join-Path $PSScriptRoot 'prepare-windows-staff-password-rotation.mjs')
  if($LASTEXITCODE -ne 0 -or !(Test-Path -LiteralPath $sql)){throw 'Rotation target unavailable'}
  foreach($key in @('PGPASSWORD','PGSERVICE','PGSERVICEFILE','PGOPTIONS')){[Environment]::SetEnvironmentVariable($key,$null,'Process')}
  $env:PGHOSTADDR='127.0.0.1';$env:PGREQUIREAUTH='scram-sha-256';$env:PGCONNECT_TIMEOUT='8'
  $phase='rotation';Set-Content -LiteralPath $status 'awaiting-private-postgres-and-role-passwords'
  Write-Host 'First enter the existing Windows postgres administrator password. Then enter and confirm a new password for each named role.'
  Write-Host 'Save two distinct passwords, 16 to 1024 characters each, different from the staff session password.'
  & (Join-Path $env:ProgramFiles 'PostgreSQL\18\bin\psql.exe') -X -W -h 127.0.0.1 -p 5432 -U postgres -d nukhbapay_staff -f $sql
  if($LASTEXITCODE -ne 0){throw 'Rotation did not report a successful commit'}
  Set-Content -LiteralPath $status 'committed'
  Write-Host 'Now verify both new passwords and the existing session password in the portal preflight.'
  $phase='portal'
  & (Join-Path $PSScriptRoot 'resume-windows-staff-portal.ps1') -RunId $RunId
}catch{if($phase -ne 'portal'){Set-Content -LiteralPath $status ('stopped-at-'+$phase)};Write-Host ('Stopped at '+$phase+'.');[void](Read-Host 'Press Enter to close')}
