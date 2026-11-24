[CmdletBinding()]
param([switch]$EnrollFirstStaff,[switch]$LaunchPortal,[string]$RosterDigest)
$ErrorActionPreference='Stop'
if(($EnrollFirstStaff -and $RosterDigest -notmatch '^[0-9a-f]{64}$') -or ($LaunchPortal -and !$EnrollFirstStaff)){throw 'The approved first staff roster is required.'}
function Read-Private([string]$Label) {
  $secure=Read-Host $Label -AsSecureString
  $ptr=[Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)
  try{return [Runtime.InteropServices.Marshal]::PtrToStringBSTR($ptr)}
  finally{[Runtime.InteropServices.Marshal]::ZeroFreeBSTR($ptr);$secure.Dispose()}
}
$Host.UI.RawUI.WindowTitle='NukhbaPay | Install qualified Windows staff schema'
$project=(Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$state=Join-Path $project '.local'
$status=Join-Path $state 'windows-staff-install-status.txt'
$psql=Join-Path $env:ProgramFiles 'PostgreSQL\18\bin\psql.exe'
$phase='qualification'
try {
  $report=Get-Content -LiteralPath (Join-Path $state 'windows-staff-rehearsal.json') -Raw | ConvertFrom-Json
  $backup=Get-Content -LiteralPath (Join-Path $state 'windows-staff-backup.json') -Raw | ConvertFrom-Json
  if($report.status -ne 'passed' -or $report.backupHash -ne $backup.sha256 -or $report.sourceDatabaseOid -ne $backup.databaseOid -or
     $report.sourceCluster -ne $backup.systemIdentifier){throw 'Qualification does not match the backup'}
  $registration=(Get-ItemProperty -LiteralPath 'HKLM:\SYSTEM\CurrentControlSet\Services\postgresql-x64-18' -Name ImagePath).ImagePath
  $directory=[regex]::Match($registration,'(?i)\s-D\s+"([^"]+)"')
  if(!$directory.Success -or (Get-Service postgresql-x64-18).Status -ne 'Running'){throw 'Windows service mismatch'}
  $env:NUKHBAPAY_REGISTERED_PG_DIRECTORY=$directory.Groups[1].Value
  $env:PGHOSTADDR='127.0.0.1';$env:PGREQUIREAUTH='scram-sha-256';$env:PGCONNECT_TIMEOUT='5'
  Remove-Item Env:PGSERVICE -ErrorAction SilentlyContinue
  $env:PGOPTIONS='-c search_path=pg_catalog -c statement_timeout=30000'
  $phase='owner-login';Set-Content $status 'awaiting-private-owner-login'
  $value=Read-Host 'Windows PostgreSQL postgres password for the qualified nukhbapay_staff migration' -AsSecureString
  $buffer=[Runtime.InteropServices.Marshal]::SecureStringToBSTR($value)
  try {$env:PGPASSWORD=[Runtime.InteropServices.Marshal]::PtrToStringBSTR($buffer)}finally{[Runtime.InteropServices.Marshal]::ZeroFreeBSTR($buffer);$value.Dispose()}
  $phase='installation'
  Push-Location $project
  try {& node.exe scripts/windows-staff-migration.mjs --apply-qualified;if($LASTEXITCODE -ne 0){throw 'Schema installation stopped'}}
  finally{Pop-Location}
  $phase='session-login';Set-Content $status 'schema-installed-session-credential-pending'
  Write-Host 'Choose a new, distinct database password of at least 16 characters for nukhabapay_session_backend. Save it privately. PostgreSQL will ask for it twice if the role is new.'
  $common=@('-X','-qAt','-w','-h','127.0.0.1','-p','5432','-U','postgres','-d','nukhbapay_staff','-v','ON_ERROR_STOP=1')
  & $psql @common -v ("oid="+$backup.databaseOid) -v ("cluster="+$backup.systemIdentifier) -v ("candidate="+$report.candidateHash) -v ("backup="+$backup.sha256) -v ("directory="+$directory.Groups[1].Value) -f (Join-Path $PSScriptRoot 'windows-staff-session-login.sql')
  if($LASTEXITCODE -ne 0){throw 'Session login setup stopped'}
  $phase='readback'
  $raw=& $psql @common -v ("service_directory="+$directory.Groups[1].Value) -f (Join-Path $PSScriptRoot 'inspect-windows-staff-database.sql')
  if($LASTEXITCODE -ne 0){throw 'Readback failed'}
  $actual=$raw|ConvertFrom-Json
  if(!$actual.targetVerified -or $actual.databaseOid -ne $backup.databaseOid -or $actual.systemIdentifier -ne $backup.systemIdentifier -or
     !$actual.iamInstalled -or !$actual.workspaceInstalled -or !$actual.sessionsInstalled -or !$actual.sessionRoleExists){throw 'Unexpected readback'}
  $actual|ConvertTo-Json|Set-Content -LiteralPath (Join-Path $state 'windows-staff-inspection.json') -Encoding ascii
  Set-Content $status 'windows-schema-and-session-login-installed'
  $phase='runtime-verification'
  $env:NUKHBAPAY_STAFF_AUTH0_ISSUER=& $psql @common -c 'SELECT issuer FROM nukhabapay.windows_staff_schema_history WHERE version=1'
  if($LASTEXITCODE -ne 0){throw 'Installation binding unavailable'}
  if($EnrollFirstStaff){
    $phase='login-only-enrollment'
    Set-Content $status 'awaiting-private-enrollment'
    Write-Host 'First enrollment for nukhbapay-staff-dev. One staff member, six department definitions, zero role grants.'
    $name=Read-Private 'Approved staff work name'
    $email=Read-Private 'Approved staff work email'
    $subject=Read-Private 'Auth0 User ID from the approved test user profile'
    if($subject -cne (Read-Private 'Confirm the same Auth0 User ID')){throw 'Auth0 User IDs differ'}
    $env:NUKHBAPAY_FIRST_ROSTER_SHA256=$RosterDigest
    $payload=@{tenantKey='nukhbapay-staff-dev';name=$name;email=$email;subject=$subject}
    Push-Location $project
    try{$tenant=($payload | ConvertTo-Json -Compress) | node.exe scripts/enroll-windows-staff.mjs
      if($LASTEXITCODE -ne 0 -or $tenant -notmatch '^[0-9a-f-]{36}$'){throw 'Enrollment unavailable'}}
    finally{Pop-Location;$payload=$null}
    $env:NUKHBAPAY_STAFF_AUTH0_TENANT_ID=$tenant
    $env:NUKHBAPAY_STAFF_ENROLLMENT_SUBJECT=$subject
    $env:NUKHBAPAY_STAFF_AUTH0_STAFF_KIND_CLAIM='https://claims.nukhbapay.com/principal'
    Set-Content $status 'windows-login-only-enrollment-verified'
  }
  Remove-Item Env:PGPASSWORD -ErrorAction SilentlyContinue
  $phase='runtime-verification'
  Write-Host 'Enter the reader, writer and session role passwords in turn to verify the application connections.'
  foreach($binding in @(@('DB_IDENTITY_READER_URL','nukhabapay_identity_reader'),@('DB_IDENTITY_WRITER_URL','nukhabapay_identity_writer'),@('DB_STAFF_SESSION_URL','nukhabapay_session_backend'))){
    if(![Environment]::GetEnvironmentVariable($binding[0])){
      $password=Read-Private ('Existing password for '+$binding[1])
      [Environment]::SetEnvironmentVariable($binding[0],('postgresql://'+$binding[1]+':'+[Uri]::EscapeDataString($password)+'@127.0.0.1:5432/nukhbapay_staff'),'Process')
      $password=$null
    }
  }
  & (Join-Path $PSScriptRoot 'start-windows-staff-portal.ps1') -StorageOnly
  Set-Content $status 'windows-staff-runtime-storage-verified'
  Write-Host 'All three application connections passed. The preview is still running.'
  if($LaunchPortal){
    $phase='portal-launch'
    Write-Host 'Enter the Auth0 test staff application settings. The portal checks the enrolled identity, MFA configuration and HTTPS before switching.'
    & (Join-Path $PSScriptRoot 'start-windows-staff-portal.ps1')
  }
}catch{Set-Content $status ('stopped-at-'+$phase);Write-Host ('Setup stopped at '+$phase+'.')}
finally{
  foreach($variable in @('PGPASSWORD','DB_IDENTITY_READER_URL','DB_IDENTITY_WRITER_URL','DB_STAFF_SESSION_URL','NUKHBAPAY_STAFF_ENROLLMENT_SUBJECT')){
    [Environment]::SetEnvironmentVariable($variable,$null,'Process')
  }
  $subject=$null
}
[void](Read-Host 'Press Enter to close')
