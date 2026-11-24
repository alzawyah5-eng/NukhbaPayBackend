[CmdletBinding()]
param([switch]$PreflightOnly,[switch]$StorageOnly,[System.Collections.IDictionary]$Settings)
$ErrorActionPreference='Stop'
function Unprotect-LocalValue([Security.SecureString]$Value) {
  $buffer=[Runtime.InteropServices.Marshal]::SecureStringToBSTR($Value)
  try {return [Runtime.InteropServices.Marshal]::PtrToStringBSTR($buffer)}
  finally {[Runtime.InteropServices.Marshal]::ZeroFreeBSTR($buffer)}
}
function Read-PortalSetting([string]$Name) {
  if($null -ne $Settings){return $Settings[$Name]}
  return [Environment]::GetEnvironmentVariable($Name)
}
$project=(Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..')).Path
$evidence=Get-Content -Raw -LiteralPath (Join-Path $project '.local\windows-staff-inspection.json') | ConvertFrom-Json
if($evidence.targetVerified -ne $true -or $evidence.databaseOid -notmatch '^[1-9]\d{0,9}$' -or
   $evidence.systemIdentifier -notmatch '^[1-9]\d{15,19}$'){throw 'Run the Windows staff database inspection first.'}
$missing=@(@('readerExists','writerExists','sessionRoleExists','iamInstalled','sessionsInstalled','workspaceInstalled') |
  Where-Object {$evidence.$_ -ne $true})
if($missing.Count){throw ('Windows staff database prerequisites missing in the last inspection: '+($missing -join ', ')+'. Refresh the inspection after provisioning.')}

function Get-ReviewedTlsDirectory {
$thumbprint='C8169B7EA95CC2D75038459C30FB402A474EEA3A'
if(!(Test-Path -LiteralPath ('Cert:\CurrentUser\Root\'+$thumbprint))){throw 'Reviewed localhost certificate is not trusted by this user.'}
$certificateRoot=Join-Path $env:LOCALAPPDATA 'Nukhbapay\development-https'
$matchesFound=@(Get-ChildItem -Directory -LiteralPath $certificateRoot | ForEach-Object {
  $certificateFile=Join-Path $_.FullName 'localhost.cer'
  if(Test-Path -LiteralPath $certificateFile){
    $cert=New-Object Security.Cryptography.X509Certificates.X509Certificate2($certificateFile)
    try {if($cert.Thumbprint -eq $thumbprint -and $cert.NotAfter -gt (Get-Date)){ $_.FullName }}finally{$cert.Dispose()}
  }
})
if($matchesFound.Count -ne 1){throw 'The reviewed localhost certificate is missing, expired or ambiguous.'}
return $matchesFound[0]
}
$launch=[Diagnostics.ProcessStartInfo]::new()
$launch.FileName=(Get-Command node.exe -CommandType Application).Source
$launch.WorkingDirectory=$project
$launch.UseShellExecute=$false
$values=$launch.EnvironmentVariables
$values.Clear()
foreach($name in @('PATH','SystemRoot','WINDIR','TEMP','TMP','LOCALAPPDATA','USERPROFILE')){
  $value=[Environment]::GetEnvironmentVariable($name)
  if($value){$values[$name]=$value}
}
$values['NODE_ENV']='development'
$values['NUKHBAPAY_ENV']='local'
$values['NUKHBAPAY_ENVIRONMENT']='development'
$values['NUKHBAPAY_STAFF_SESSION_MODE']='windows-staff-development'
$values['DB_IDENTITY_CONNECTION_TIMEOUT_MS']='10000'
$values['NUKHBAPAY_STAFF_AUTH0_ACCESS_TOKEN_AUDIENCE_MODE']='api-and-userinfo'
$values['DB_STAFF_SESSION_EXPECTED_DATABASE_OID']=$evidence.databaseOid
$values['DB_STAFF_SESSION_EXPECTED_SYSTEM_IDENTIFIER']=$evidence.systemIdentifier
$values['DB_STAFF_SESSION_ROLE']='nukhabapay_session_backend'
try {
  $keys=@('ISSUER')
  if(!$StorageOnly){
    $tlsDir=Get-ReviewedTlsDirectory
    $values['NUKHBAPAY_STAFF_TLS_PFX_PATH']=Join-Path $tlsDir 'localhost.pfx'
    $values['NUKHBAPAY_STAFF_TLS_CERT_PATH']=Join-Path $tlsDir 'localhost.cer'
    $values['NUKHBAPAY_STAFF_TLS_PASSPHRASE']=Unprotect-LocalValue (Import-Clixml -LiteralPath (Join-Path $tlsDir 'localhost.passphrase.clixml'))
    $subject=Read-PortalSetting 'NUKHBAPAY_STAFF_ENROLLMENT_SUBJECT'
    $values['NUKHBAPAY_STAFF_ENROLLMENT_SUBJECT']=$subject
    if(!$subject){$values['NUKHBAPAY_STAFF_ENROLLMENT_SUBJECT']=Unprotect-LocalValue (Read-Host 'Existing enrolled Auth0 test User ID for the startup membership check' -AsSecureString)}
    $keys+=@('CLIENT_ID','CLIENT_SECRET','AUDIENCE','STAFF_KIND_CLAIM','TENANT_ID')
  }
  foreach($key in $keys){
    $field='NUKHBAPAY_STAFF_AUTH0_'+$key
    $configured=Read-PortalSetting $field
    if($configured){$values[$field]=$configured}
    if(!$values[$field]){
      $values[$field]=Unprotect-LocalValue (Read-Host ("Auth0 test "+$key+" for the persistent staff tenant") -AsSecureString)
    }
  }
  foreach($binding in @(@('DB_IDENTITY_READER_URL','nukhabapay_identity_reader'),@('DB_IDENTITY_WRITER_URL','nukhabapay_identity_writer'),@('DB_STAFF_SESSION_URL','nukhabapay_session_backend'))){
    $configured=Read-PortalSetting $binding[0]
    if($configured){$values[$binding[0]]=$configured}
    if(!$values[$binding[0]]){
      $password=Unprotect-LocalValue (Read-Host ('Database password for '+$binding[1]) -AsSecureString)
      $values[$binding[0]]='postgresql://'+$binding[1]+':'+[Uri]::EscapeDataString($password)+'@127.0.0.1:5432/nukhbapay_staff'
      $password=$null
    }
  }
  $launch.Arguments='scripts/start-windows-staff-portal.mjs --preflight'
  if($StorageOnly){$launch.Arguments='scripts/start-windows-staff-portal.mjs --verify-storage'}
  do {
    $preflight=[Diagnostics.Process]::Start($launch)
    try {$preflight.WaitForExit();$code=$preflight.ExitCode}finally{$preflight.Dispose()}
    if($code -eq 0){break}
    if($code -ne 2 -or $StorageOnly -or $subject){throw 'Staff portal preflight stopped.'}
    $retry=Read-Host 'Paste the enrolled SYMH User ID from the Auth0 test user profile (including auth0|), or press Enter to stop' -AsSecureString
    try {
      if(!$retry.Length){throw 'Enrollment retry cancelled.'}
      $values['NUKHBAPAY_STAFF_ENROLLMENT_SUBJECT']=Unprotect-LocalValue $retry
    }finally{$retry.Dispose()}
  }while($true)
  if($PreflightOnly -or $StorageOnly){return}
  $listeners=@([Net.NetworkInformation.IPGlobalProperties]::GetIPGlobalProperties().GetActiveTcpListeners() | Where-Object Port -eq 3001)
  if($listeners.Count){
    $listening=@(Get-NetTCPConnection -State Listen -LocalPort 3001 -ErrorAction Stop)
    if($listening.Count -ne 1 -or $listening[0].LocalAddress -ne '127.0.0.1'){throw 'Unexpected port 3001 listener.'}
    $owner=Get-Process -Id $listening[0].OwningProcess -ErrorAction Stop
    try {
      $null=$owner.Handle
      $old=Get-CimInstance Win32_Process -Filter ('ProcessId='+$owner.Id)
      $knownBridge=Join-Path $project '.local\staff-iam-local\bridge.mjs'
      $expectedPortal=($env:NUKHBAPAY_REPLACE_LOCAL_PORTAL -ceq ($owner.Id.ToString()+':'+$owner.StartTime.ToUniversalTime().Ticks)) -and
        ($old.CommandLine -match '^(?:"[^"]*node(?:\.exe)?"|\S*node(?:\.exe)?)\s+scripts/start-windows-staff-portal\.mjs\s*$')
      if($old.Name -ne 'node.exe' -or $old.ExecutablePath -ne $launch.FileName -or
         (!$expectedPortal -and $old.CommandLine -notmatch ('(?i)^(?:"[^"]*node(?:\.exe)?"|\S*node(?:\.exe)?)\s+"'+[regex]::Escape($knownBridge)+'"(?:\s+--detached-workspace)?\s*$')) -or
         $owner.HasExited){throw 'Port 3001 is owned by an unrecognized process.'}
      Stop-Process -InputObject $owner
      if(!$owner.WaitForExit(5000)){throw 'Prior portal did not release port 3001.'}
    }finally{$owner.Dispose()}
  }
  $launch.Arguments='scripts/start-windows-staff-portal.mjs'
  $portal=[Diagnostics.Process]::Start($launch)
  try {$portal.WaitForExit();if($portal.ExitCode -ne 0){throw 'Windows staff portal stopped.'}}finally{$portal.Dispose()}
}finally{$configured=$null;$subject=$null;$values.Clear()}
