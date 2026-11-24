[CmdletBinding()]
param()
$ErrorActionPreference='Stop'
$Host.UI.RawUI.WindowTitle='NukhbaPay | Native PostgreSQL console'
$project=(Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$psql=Join-Path $env:ProgramFiles 'PostgreSQL\18\bin\psql.exe'
$state=Join-Path $project '.local'
$status=Join-Path $state 'windows-staff-native-console.status'
$phase='target-check'
$start=$null
try {
  $service=(Get-ItemProperty -LiteralPath 'HKLM:\SYSTEM\CurrentControlSet\Services\postgresql-x64-18' -Name ImagePath).ImagePath
  $dir=[regex]::Match($service,'(?i)\s-D\s+"([^"]+)"')
  if(!$dir.Success -or (Get-Service postgresql-x64-18).Status -ne 'Running' -or !(Test-Path -LiteralPath $psql)){throw 'Local PostgreSQL unavailable.'}
  $env:NUKHBAPAY_REGISTERED_PG_DIRECTORY=$dir.Groups[1].Value
  $file=& node.exe (Join-Path $PSScriptRoot 'prepare-windows-staff-session.mjs')
  if($LASTEXITCODE -ne 0 -or !(Test-Path -LiteralPath $file)){throw 'Verified setup script unavailable.'}
  $file=Get-Item -LiteralPath $file
  if($file.Directory.FullName -ne $state -or $file.Name -notmatch '^windows-staff-session-[0-9a-f]{16}\.psql$'){throw 'Unexpected setup path.'}
  $start=[Diagnostics.ProcessStartInfo]::new()
  $start.FileName=$psql
  $start.WorkingDirectory=$state
  $start.UseShellExecute=$false
  $values=$start.EnvironmentVariables
  $values.Clear()
  foreach($key in @('PATH','SystemRoot','WINDIR','TEMP','TMP','USERPROFILE','LOCALAPPDATA','APPDATA','COMSPEC')){
    $v=[Environment]::GetEnvironmentVariable($key)
    if($v){$values[$key]=$v}
  }
  $values['PGHOSTADDR']='127.0.0.1';$values['PGREQUIREAUTH']='scram-sha-256';$values['PGCONNECT_TIMEOUT']='8'
  $values['PGAPPNAME']='nukhbapay-private-staff-setup';$values['PSQL_HISTORY']='NUL'
  $argsDb='-X -w -h 127.0.0.1 -p 5432 -U postgres -d nukhbapay_staff'
  $phase='administrator-login'
  Set-Content -LiteralPath $status 'waiting-for-postgres-password'
  Write-Host 'Native PostgreSQL console for the local nukhbapay_staff database.'
  Write-Host 'An authorized administrator can enter the existing postgres password here. The input is hidden.'
  $password=Read-Host 'Existing Windows PostgreSQL password for postgres (blank cancels)' -AsSecureString
  try {
    if($password.Length -eq 0){throw 'Cancelled.'}
    $ptr=[Runtime.InteropServices.Marshal]::SecureStringToBSTR($password)
    try{$values['PGPASSWORD']=[Runtime.InteropServices.Marshal]::PtrToStringBSTR($ptr)}
    finally{[Runtime.InteropServices.Marshal]::ZeroFreeBSTR($ptr)}
  }finally{$password.Dispose()}
  $phase='session-setup'
  Set-Content -LiteralPath $status 'verifying-session-credential'
  $start.Arguments=$argsDb+' -f '+$file.Name
  $check=[Diagnostics.Process]::Start($start)
  try{$check.WaitForExit();if($check.ExitCode -ne 0){throw 'Session verification stopped.'}}
  finally{$check.Dispose()}
  Write-Host 'Session role verified. Return to the private enrollment window to enter the approved profile.'
  Write-Host 'When that window displays its enrollment command, run it at the database prompt here. Type \q when enrollment is complete.'
  $phase='interactive-psql'
  $start.Arguments=$argsDb
  $console=[Diagnostics.Process]::Start($start)
  $values.Clear()
  try{
    Set-Content -LiteralPath $status 'session-verified-console-started'
    $console.WaitForExit()
    if($console.ExitCode -ne 0){throw 'PostgreSQL console stopped.'}
    Set-Content -LiteralPath $status 'console-closed'
  }finally{$console.Dispose()}
}catch{Set-Content -LiteralPath $status ('stopped-at-'+$phase);Write-Host ('Stopped at '+$phase+'.')}
finally{if($start){$start.EnvironmentVariables.Clear()}}
[void](Read-Host 'Press Enter to close this window')
