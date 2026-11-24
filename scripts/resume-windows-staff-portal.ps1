[CmdletBinding()]
param([Parameter(Mandatory=$true)][ValidatePattern('^[a-f0-9]{32}$')][string]$RunId)
$ErrorActionPreference='Stop'
$Host.UI.RawUI.WindowTitle='NukhbaPay | Resume enrolled staff portal'
$state=Join-Path $PSScriptRoot '..\.local'
$status=Join-Path $state 'windows-portal-retry.status'
$bindings=[ordered]@{DB_IDENTITY_READER_URL='nukhabapay_identity_reader';DB_IDENTITY_WRITER_URL='nukhabapay_identity_writer';DB_STAFF_SESSION_URL='nukhabapay_session_backend'}
$seen=[Collections.Generic.HashSet[string]]::new([StringComparer]::Ordinal)
$phase='enrollment-receipt'
try {
  $tenant=([string](Get-Content -LiteralPath (Join-Path $state ('windows-enrollment-'+$RunId+'.txt')) -Raw)).Trim()
  if($tenant -notmatch '^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$'){throw 'Invalid enrollment receipt'}
  $env:NUKHBAPAY_STAFF_AUTH0_TENANT_ID=$tenant
  $env:NUKHBAPAY_STAFF_AUTH0_ISSUER='https://dev-whz1tr4aj20nxswq.us.auth0.com/'
  $env:NUKHBAPAY_STAFF_AUTH0_STAFF_KIND_CLAIM='https://claims.nukhbapay.com/principal'
  foreach($key in $bindings.Keys){
    $role=$bindings[$key]
    $phase='credential-'+$role
    Set-Content -LiteralPath $status $phase
    $secret=Read-Host ('Existing password for '+$role) -AsSecureString
    try {
      if($secret.Length -lt 16 -or $secret.Length -gt 1024){
        Write-Host "$role requires its existing password of 16 to 1024 characters. If its actual password falls outside that range, coordinate rotation before retrying."
        throw 'Credential length'
      }
      $ptr=[Runtime.InteropServices.Marshal]::SecureStringToBSTR($secret)
      try{$plain=[Runtime.InteropServices.Marshal]::PtrToStringBSTR($ptr)}finally{[Runtime.InteropServices.Marshal]::ZeroFreeBSTR($ptr)}
      if(!$seen.Add($plain)){Write-Host 'Each database role requires a distinct credential.';throw 'Repeated credential'}
      [Environment]::SetEnvironmentVariable($key,('postgresql://'+$role+':'+[Uri]::EscapeDataString($plain)+'@127.0.0.1:5432/nukhbapay_staff'),'Process')
    }finally{$secret.Dispose();$plain=$null}
    $check=& node.exe (Join-Path $PSScriptRoot 'check-windows-portal-role.mjs') $role
    if($LASTEXITCODE -ne 0 -or $check -ne 'verified'){
      if($check -notin @('password-rejected','permission-denied','connection-refused','target-or-role-guard','configuration','connection')){$check='unavailable'}
      $phase=$role+'-'+$check
      throw 'Private role verification stopped'
    }
    Write-Host ($role+' verified.')
  }
  $seen.Clear()
  $launcher=Join-Path $PSScriptRoot 'start-windows-staff-portal.ps1'
  $phase='storage-preflight';Set-Content -LiteralPath $status $phase
  & $launcher -StorageOnly
  $phase='auth0-portal-preflight';Set-Content -LiteralPath $status $phase
  & $launcher
}catch{Set-Content -LiteralPath $status ('stopped-at-'+$phase);Write-Host ('Portal startup stopped at '+$phase+'.')}
finally{$seen.Clear();foreach($key in $bindings.Keys){[Environment]::SetEnvironmentVariable($key,$null,'Process')}}
[void](Read-Host 'Press Enter to close')
