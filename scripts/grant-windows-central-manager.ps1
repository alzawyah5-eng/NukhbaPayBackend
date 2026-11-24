[CmdletBinding()]
param()
$ErrorActionPreference='Stop'
$Host.UI.RawUI.WindowTitle='NukhbaPay | Approve SYMH central staff management'
$project=(Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$state=Join-Path $project '.local'
$status=Join-Path $state 'central-manager-bootstrap.status'
$sql=$null;$backup=$null
function Reveal([Security.SecureString]$Value){$p=[Runtime.InteropServices.Marshal]::SecureStringToBSTR($Value);try{[Runtime.InteropServices.Marshal]::PtrToStringBSTR($p)}finally{[Runtime.InteropServices.Marshal]::ZeroFreeBSTR($p)}}
try{
 Set-Content $status 'waiting-for-approver-identity'
 Write-Host 'This local-development bootstrap grants only TENANT_STAFF_MANAGER to the enrolled SYMH identity.'
 Write-Host 'The approver must be a different person using admin@nukhbalzawiya.com in the same Auth0 test tenant.'
 $name=Read-Host 'Approved work name for admin@nukhbalzawiya.com'
 $one=Read-Host 'Auth0 test User ID for admin@nukhbalzawiya.com (including auth0|)' -AsSecureString
 $two=Read-Host 'Confirm the same Auth0 test User ID' -AsSecureString
 try{$subject=Reveal $one;$confirm=Reveal $two}finally{$one.Dispose();$two.Dispose()}
 if($subject -cne $confirm){throw 'Auth0 User ID confirmation mismatch'}
 $phrase=Read-Host 'If the approver is a different person from SYMH, type APPROVE SYMH TENANT STAFF MANAGER' -AsSecureString
 try{$approval=Reveal $phrase}finally{$phrase.Dispose()}
 $env:NUKHBAPAY_BOOTSTRAP_APPROVER_NAME=$name;$env:NUKHBAPAY_BOOTSTRAP_APPROVER_SUBJECT=$subject;$env:NUKHBAPAY_BOOTSTRAP_APPROVAL=$approval
 $sql=& node.exe (Join-Path $PSScriptRoot 'prepare-windows-central-manager-bootstrap.mjs')
 if($LASTEXITCODE -ne 0 -or !(Test-Path -LiteralPath $sql)){throw 'Bootstrap candidate preparation failed'}
 Set-Content $status 'waiting-for-postgres-password'
 $secret=Read-Host 'Existing Windows PostgreSQL postgres password' -AsSecureString
 try{$password=Reveal $secret}finally{$secret.Dispose()}
 $env:PGPASSWORD=$password;$env:PGHOSTADDR='127.0.0.1';$env:PGREQUIREAUTH='scram-sha-256';$env:PGCONNECT_TIMEOUT='8';$env:PSQL_HISTORY='NUL'
 $bin=Join-Path $env:ProgramFiles 'PostgreSQL\18\bin';$run=[Guid]::NewGuid().ToString('N')
 $vault=Join-Path $env:LOCALAPPDATA ('Nukhbapay\staff-db-backups\'+$run);[void](New-Item -ItemType Directory -Path $vault)
 $sid=[Security.Principal.WindowsIdentity]::GetCurrent().User;$acl=[Security.AccessControl.DirectorySecurity]::new();$acl.SetOwner($sid);$acl.SetAccessRuleProtection($true,$false);$acl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new($sid,'FullControl','ContainerInherit,ObjectInherit','None','Allow'));Set-Acl $vault $acl
 $backup=Join-Path $vault 'staff-before-central-manager.dump';Set-Content $status 'creating-restricted-backup'
 & (Join-Path $bin 'pg_dump.exe') -h 127.0.0.1 -p 5432 -U postgres -w -d nukhbapay_staff --format=custom --file=$backup
 if($LASTEXITCODE -ne 0){throw 'Backup failed'};& (Join-Path $bin 'pg_restore.exe') --list $backup | Out-Null;if($LASTEXITCODE -ne 0){throw 'Backup verification failed'}
 Set-Content $status 'applying-atomic-bootstrap'
 & (Join-Path $bin 'psql.exe') -X -P pager=off -w -h 127.0.0.1 -p 5432 -U postgres -d nukhbapay_staff -f $sql
 if($LASTEXITCODE -ne 0){throw 'Central manager bootstrap failed'}
 Set-Content $status 'committed-and-verified';Write-Host 'SYMH central staff management access committed. Sign out and sign in again to refresh authority.'
}catch{Set-Content $status ('stopped-'+$_.Exception.Message);Write-Host ('Central management access stopped. '+$_.Exception.Message)}
finally{Remove-Item Env:PGPASSWORD,Env:NUKHBAPAY_BOOTSTRAP_APPROVER_NAME,Env:NUKHBAPAY_BOOTSTRAP_APPROVER_SUBJECT,Env:NUKHBAPAY_BOOTSTRAP_APPROVAL -ErrorAction SilentlyContinue;$password=$subject=$confirm=$approval=$null;if($sql -and (Test-Path $sql)){Remove-Item -LiteralPath $sql -Force}}
[void](Read-Host 'Press Enter to close')
