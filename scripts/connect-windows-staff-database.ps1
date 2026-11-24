[CmdletBinding()]
param([switch]$VerifyOnly)
$ErrorActionPreference='Stop'
$Host.UI.RawUI.WindowTitle='NukhbaPay | Connect staff application roles'
$evidenceDirectory=Join-Path $PSScriptRoot '..\.local'
$status=Join-Path $evidenceDirectory 'windows-staff-connect-status.txt'
$stage='verified-target'
try {
  $target=Get-Content -Raw -LiteralPath (Join-Path $evidenceDirectory 'windows-staff-inspection.json') | ConvertFrom-Json
  if($target.targetVerified -ne $true -or $target.databaseOid -notmatch '^[1-9]\d{0,9}$' -or
     $target.systemIdentifier -notmatch '^[1-9]\d{15,19}$'){throw 'Missing target'}
  $service=Get-Service -Name 'postgresql-x64-18'
  $registration=(Get-ItemProperty -LiteralPath 'HKLM:\SYSTEM\CurrentControlSet\Services\postgresql-x64-18' -Name ImagePath).ImagePath
  $dataDirectory=[regex]::Match($registration,'(?i)\s-D\s+"([^"]+)"')
  if($service.Status -ne 'Running' -or !$dataDirectory.Success){throw 'Unexpected service'}
  $psql=Join-Path $env:ProgramFiles 'PostgreSQL\18\bin\psql.exe'
  $arguments=@('-X','-qAt','-W','-h','127.0.0.1','-p','5432','-d','nukhbapay_staff','-v','ON_ERROR_STOP=1',
    '-v',("database_oid="+$target.databaseOid),'-v',("system_identifier="+$target.systemIdentifier))
  $env:PGCONNECT_TIMEOUT='5'
  $env:PGHOSTADDR='127.0.0.1'
  Remove-Item Env:PGSERVICE -ErrorAction SilentlyContinue
  $env:PGREQUIREAUTH='scram-sha-256'
  $env:PGOPTIONS='-c search_path=pg_catalog -c statement_timeout=10000'
  if(!$VerifyOnly){
    $stage='owner-connect-grants'
    Set-Content -LiteralPath $status -Value 'awaiting-owner-password'
    Write-Host 'Enter the Windows PostgreSQL postgres password to allow the two existing IAM roles to connect to nukhbapay_staff.'
    & $psql @arguments -U postgres -v ("service_directory="+$dataDirectory.Groups[1].Value) -f (Join-Path $PSScriptRoot 'connect-windows-staff-database.sql') | Out-Null
    if($LASTEXITCODE -ne 0){throw 'Grant verification failed'}
    Set-Content -LiteralPath $status -Value 'owner-connect-grants-verified'
    Write-Host 'Database CONNECT verified for the existing IAM reader and writer.'
  }
  $env:PGOPTIONS='-c default_transaction_read_only=on -c search_path=pg_catalog -c statement_timeout=5000'
  foreach($role in @('nukhabapay_identity_reader','nukhabapay_identity_writer')){
    $stage=$role
    Set-Content -LiteralPath $status -Value ('awaiting-private-password-'+$role)
    Write-Host ("Password for PostgreSQL role "+$role+" on nukhbapay_staff. Typing is hidden. Press Enter to submit.")
    Write-Host 'This role has its own password. If you do not know it, close this window.'
    $ErrorActionPreference='Continue'
    try {
      $result=@(& $psql @arguments -U $role -v ("expected_role="+$role) -f (Join-Path $PSScriptRoot 'verify-windows-staff-login.sql') 2>&1)
      $queryExit=$LASTEXITCODE     
    }finally{$ErrorActionPreference='Stop'}
    if($queryExit -ne 0 -or $result.Count -ne 1 -or $result[0] -ne 't'){
      $reason='connection-or-target-check'
      if($result -match 'password authentication failed|28P01'){$reason='password-rejected'}
      elseif($result -match 'permission denied|42501'){$reason='permission-denied'}
      elseif($queryExit -eq 0){$reason='target-check-failed'}
      $stage=$role+'-'+$reason
      throw 'Workload connection unavailable'
    }
    Write-Host ($role+' verified on the persistent Windows database.')
  }
  Set-Content -LiteralPath $status -Value 'reader-and-writer-connections-verified'
} catch {
  Set-Content -LiteralPath $status -Value ('stopped-at-'+$stage)
  Write-Host ('Connection setup stopped at '+$stage+'.')
}
[void](Read-Host 'Press Enter to close')
