[CmdletBinding()]
param([Parameter(Mandatory=$true)][ValidatePattern('^[0-9a-f]{32}$')][string]$RunId,
      [Parameter(Mandatory=$true)][ValidatePattern('^[0-9a-f]{64}$')][string]$RosterDigest)
$ErrorActionPreference='Stop'
$Host.UI.RawUI.WindowTitle='NukhbaPay | Private staff enrollment and portal'
$project=(Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$state=Join-Path $project '.local'
$status=Join-Path $state ('windows-enrollment-'+$RunId+'.status')
$receipt=Join-Path $state ('windows-enrollment-'+$RunId+'.txt')
function Read-PrivateValue([string]$label) {
  $secure=Read-Host $label -AsSecureString
  $ptr=[Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)
  try {return [Runtime.InteropServices.Marshal]::PtrToStringBSTR($ptr)}
  finally {[Runtime.InteropServices.Marshal]::ZeroFreeBSTR($ptr); $secure.Dispose()}
}
function Wait-ForReceipt([string]$file) {
  $until=[DateTime]::UtcNow.AddMinutes(5)
  do {
    if(Test-Path -LiteralPath $file) {
      $text=([string](Get-Content -LiteralPath $file -Raw -ErrorAction SilentlyContinue)).Trim()
      if($text -match '^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$'){return $text}
    }
    Start-Sleep -Milliseconds 400
  } while([DateTime]::UtcNow -lt $until)
  throw 'Committed enrollment readback unavailable.'
}
$phase='session-readback';$pipe=$null
try {
  $reg=(Get-ItemProperty -LiteralPath 'HKLM:\SYSTEM\CurrentControlSet\Services\postgresql-x64-18' -Name ImagePath).ImagePath
  $dir=[regex]::Match($reg,'(?i)\s-D\s+"([^"]+)"')
  if(!$dir.Success -or (Get-Service postgresql-x64-18).Status -ne 'Running'){throw 'Registered service unavailable.'}
  $env:NUKHBAPAY_REGISTERED_PG_DIRECTORY=$dir.Groups[1].Value
  $readback=Join-Path $state 'windows-staff-session-readback.json'
  if(!(Test-Path -LiteralPath $readback)){
    $setup=& node.exe (Join-Path $PSScriptRoot 'prepare-windows-staff-session.mjs')
    if($LASTEXITCODE -ne 0 -or !(Test-Path -LiteralPath $setup)){throw 'Session setup file unavailable.'}
    Set-Content -LiteralPath $status 'waiting-for-session-credential'
    Write-Host 'In pgAdmin, select nukhbapay_staff and open Tools > PSQL Tool. Run the following line there.'
    Write-Host ("\i '"+$setup.Replace('\','/')+"'")
    Write-Host 'Set a distinct password of at least 16 characters for the new session role in PSQL Tool. This window will continue automatically.'
  }
  $until=[DateTime]::UtcNow.AddMinutes(30)
  do {
    if(Test-Path -LiteralPath $readback) {
      try{$actual=Get-Content -LiteralPath $readback -Raw | ConvertFrom-Json}catch{$actual=$null}
      if($actual){break}
    }
    Start-Sleep -Seconds 1
  } while([DateTime]::UtcNow -lt $until)
  $backup=Get-Content -LiteralPath (Join-Path $state 'windows-staff-backup.json') -Raw | ConvertFrom-Json
  if (!$actual -or $actual.databaseOid -ne $backup.databaseOid -or $actual.systemIdentifier -ne $backup.systemIdentifier -or
      !$actual.targetVerified -or !$actual.readerExists -or !$actual.writerExists -or !$actual.sessionRoleExists -or
      !$actual.iamInstalled -or !$actual.sessionsInstalled -or !$actual.workspaceInstalled){throw 'Session readback unavailable or mismatched.'}
  $phase='prepare'
  $scriptFile=& node.exe (Join-Path $PSScriptRoot 'windows-staff-enrollment-psql.mjs') $RunId $RosterDigest
  if($LASTEXITCODE -ne 0 -or !(Test-Path -LiteralPath $scriptFile)){throw 'Enrollment file unavailable.'}
  $phase='private-identity';Set-Content -LiteralPath $status $phase
  Write-Host 'First staff enrollment in nukhbapay-staff-dev. One active staff member, zero role grants.'
  $name=Read-PrivateValue 'Approved work name'
  $email=Read-PrivateValue 'Approved lowercase work email'
  $subject=Read-PrivateValue 'Auth0 test User ID from the approved user profile'
  if($subject -cnotmatch '^auth0\|[a-zA-Z0-9_-]{1,128}$' -or $subject -cne (Read-PrivateValue 'Confirm the same Auth0 test User ID')){throw 'Private identity did not match.'}
  $roster=ConvertTo-Json -Compress -InputObject @('nukhbapay-staff-dev',$name,$email)
  $digest=[Security.Cryptography.SHA256]::Create()
  try{$actualDigest=[BitConverter]::ToString($digest.ComputeHash([Text.Encoding]::UTF8.GetBytes($roster))).Replace('-','').ToLowerInvariant()}
  finally{$digest.Dispose()}
  if($actualDigest -cne $RosterDigest){throw 'Private roster did not match.'}
  $payload=@{tenantKey='nukhbapay-staff-dev';name=$name;email=$email;subject=$subject} | ConvertTo-Json -Compress
  $bytes=[Text.Encoding]::ASCII.GetBytes([Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($payload))+"`n")
  $payload=$null;$roster=$null
  $phase='private-transfer'
  $sid=[Security.Principal.WindowsIdentity]::GetCurrent().User
  $networkSid=New-Object Security.Principal.SecurityIdentifier([Security.Principal.WellKnownSidType]::NetworkSid,$null)
  $security=New-Object IO.Pipes.PipeSecurity
  $security.SetAccessRuleProtection($true,$false);$security.SetOwner($sid)
  $security.AddAccessRule([IO.Pipes.PipeAccessRule]::new($networkSid,[IO.Pipes.PipeAccessRights]::FullControl,'Deny'))
  $security.AddAccessRule([IO.Pipes.PipeAccessRule]::new($sid,[IO.Pipes.PipeAccessRights]::FullControl,'Allow'))
  $pipe=[IO.Pipes.NamedPipeServerStream]::new(('nukhbapay-enroll-'+$RunId),[IO.Pipes.PipeDirection]::Out,1,
    [IO.Pipes.PipeTransmissionMode]::Byte,[IO.Pipes.PipeOptions]::Asynchronous,4096,4096,$security)
  $wait=$pipe.BeginWaitForConnection($null,$null)
  Set-Content -LiteralPath $status 'waiting-for-local-psql'
  Write-Host 'In the local pgAdmin PSQL Tool, run this line:'
  Write-Host ("\i '"+$scriptFile.Replace('\','/')+"'")
  try{if(!$wait.AsyncWaitHandle.WaitOne([TimeSpan]::FromMinutes(15))){throw 'PSQL connection timed out.'}
    $pipe.EndWaitForConnection($wait)
  }finally{$wait.AsyncWaitHandle.Close()}
  $pipe.Write($bytes,0,$bytes.Length);$pipe.Flush();$pipe.WaitForPipeDrain();$pipe.Dispose();$pipe=$null
  [Array]::Clear($bytes,0,$bytes.Length)
  $phase='committed-readback';Set-Content -LiteralPath $status $phase
  $tenant=Wait-ForReceipt $receipt
  $actual | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $state 'windows-staff-inspection.json') -Encoding ascii
  $env:NUKHBAPAY_STAFF_ENROLLMENT_SUBJECT=$subject
  $env:NUKHBAPAY_STAFF_AUTH0_TENANT_ID=$tenant
  $env:NUKHBAPAY_STAFF_AUTH0_ISSUER='https://dev-whz1tr4aj20nxswq.us.auth0.com/'
  $env:NUKHBAPAY_STAFF_AUTH0_STAFF_KIND_CLAIM='https://claims.nukhbapay.com/principal'
  $phase='portal-preflight';Set-Content -LiteralPath $status 'enrollment-committed-starting-portal'
  Write-Host 'Enrollment committed. Enter the test staff application settings and the three separate database role passwords for the portal.'
  & (Join-Path $PSScriptRoot 'start-windows-staff-portal.ps1')
}catch{Set-Content -LiteralPath $status ('stopped-at-'+$phase);Write-Host ('Stopped at '+$phase+'.')}
finally{
  if($pipe){$pipe.Dispose()};if($bytes){[Array]::Clear($bytes,0,$bytes.Length)}
  Remove-Item Env:NUKHBAPAY_STAFF_ENROLLMENT_SUBJECT -ErrorAction SilentlyContinue
  $subject=$null;$payload=$null
}
[void](Read-Host 'Press Enter to close')
