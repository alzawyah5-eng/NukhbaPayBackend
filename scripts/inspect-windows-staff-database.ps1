[CmdletBinding()]
param()
$ErrorActionPreference='Stop'
$Host.UI.RawUI.WindowTitle='NukhbaPay | Verify Windows PostgreSQL connection'
$root=Join-Path $PSScriptRoot '..\.local'
$status=Join-Path $root 'windows-staff-inspection-status.txt'
try {
  $psql=Join-Path $env:ProgramFiles 'PostgreSQL\18\bin\psql.exe'
  $service=Get-Service -Name 'postgresql-x64-18'
  $registration=(Get-ItemProperty -LiteralPath 'HKLM:\SYSTEM\CurrentControlSet\Services\postgresql-x64-18' -Name ImagePath).ImagePath
  $directory=[regex]::Match($registration,'(?i)\s-D\s+"([^"]+)"')
  if($service.Status -ne 'Running' -or -not $directory.Success){throw 'Unexpected service'}
  $env:PGCONNECT_TIMEOUT='5'
  $env:PGHOSTADDR='127.0.0.1'
  Remove-Item Env:PGSERVICE -ErrorAction SilentlyContinue
  $env:PGOPTIONS='-c default_transaction_read_only=on -c statement_timeout=5000 -c search_path=pg_catalog'
  Set-Content -LiteralPath $status -Value 'awaiting-private-postgres-login'
  Write-Host 'Read-only connection check for the Windows database nukhbapay_staff.'
  Write-Host 'Enter the local PostgreSQL postgres password below. No characters appear as you type.'
  $sql=Join-Path $PSScriptRoot 'inspect-windows-staff-database.sql'
  $result=& $psql -X -qAt -W -h 127.0.0.1 -p 5432 -U postgres -d nukhbapay_staff -v ON_ERROR_STOP=1 -v "service_directory=$($directory.Groups[1].Value)" -f $sql
  if($LASTEXITCODE -ne 0 -or !$result){throw 'Read-only connection check failed'}
  $evidence=$result | ConvertFrom-Json
  if($evidence.targetVerified -ne $true){throw 'Windows target mismatch'}
  Set-Content -LiteralPath (Join-Path $root 'windows-staff-inspection.json') -Encoding ascii -Value ($evidence | ConvertTo-Json -Depth 4)
  Set-Content -LiteralPath $status -Value 'windows-target-inspected'
  Write-Host 'Windows PostgreSQL target verified. The non-secret readiness result is available to the portal setup.'
}catch{
  Set-Content -LiteralPath $status -Value 'windows-target-inspection-stopped'
  Write-Host 'Inspection stopped. Check the private password and registered Windows service.'
}
[void](Read-Host 'Press Enter to close')
