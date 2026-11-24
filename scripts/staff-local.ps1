[CmdletBinding()]
param([switch]$Configure, [switch]$Check, [switch]$Catalogue)

$ErrorActionPreference = 'Stop'
$project = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..')).Path
$state = Join-Path $project '.local'
$launcher = Join-Path $PSScriptRoot 'start-windows-staff-portal.ps1'
$roleBindings = [ordered]@{
  DB_IDENTITY_READER_URL = 'nukhabapay_identity_reader'
  DB_IDENTITY_WRITER_URL = 'nukhabapay_identity_writer'
  DB_STAFF_SESSION_URL = 'nukhabapay_session_backend'
}
$secretPrompts = [ordered]@{
  NUKHBAPAY_STAFF_ENROLLMENT_SUBJECT = 'Enrolled Auth0 test User ID (including auth0|)'
  NUKHBAPAY_STAFF_AUTH0_CLIENT_SECRET = 'Auth0 test Staff Portal Client Secret'
}
foreach ($role in $roleBindings.Values) {
  $secretPrompts[$role] = "Existing PostgreSQL password for $role"
}

function Unlock-StaffSetting([Security.SecureString]$Value) {
  $buffer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($Value)
  try { return [Runtime.InteropServices.Marshal]::PtrToStringBSTR($buffer) }
  finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($buffer) }
}

function Confirm-PrivateProfilePath([string]$Path, [Security.Principal.SecurityIdentifier]$Owner) {
  if ((Get-Item -Force -LiteralPath $Path).Attributes -band [IO.FileAttributes]::ReparsePoint) {
    throw 'The local staff settings path must be a regular file or directory.'
  }
  $acl = Get-Acl -LiteralPath $Path
  $allowedUsers = @($acl.GetAccessRules($true, $true, [Security.Principal.SecurityIdentifier]) |
    Where-Object { $_.AccessControlType -eq 'Allow' -and $_.IdentityReference -ne $Owner })
  if ($acl.GetOwner([Security.Principal.SecurityIdentifier]) -ne $Owner -or $allowedUsers.Count) {
    throw 'The local staff settings path must be private to the current Windows user.'
  }
}

$inspection = Get-Content -LiteralPath (Join-Path $state 'windows-staff-inspection.json') -Raw | ConvertFrom-Json
if ($inspection.targetVerified -ne $true -or $inspection.databaseOid -notmatch '^[1-9]\d{0,9}$' -or
    $inspection.systemIdentifier -notmatch '^[1-9]\d{15,19}$') {
  throw 'Refresh the Windows staff database inspection before starting the portal.'
}
$tenants = @(Get-ChildItem -LiteralPath $state -Filter 'windows-enrollment-*.txt' -File |
  Where-Object { $_.BaseName -match '^windows-enrollment-[a-f0-9]{32}$' -and $_.Length -le 64 } |
  ForEach-Object { (Get-Content -Raw -LiteralPath $_.FullName).Trim() } |
  Where-Object { $_ -cmatch '^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$' } |
  Sort-Object -Unique)
if ($tenants.Count -ne 1) {
  throw 'Exactly one enrolled Windows staff tenant is required. Check the local enrollment receipts.'
}

# Development Staff Portal application and Staff API already used by the Windows enrollment.
$settings = @{
  NUKHBAPAY_STAFF_AUTH0_TENANT_ID = $tenants[0]
  NUKHBAPAY_STAFF_AUTH0_ISSUER = 'https://dev-whz1tr4aj20nxswq.us.auth0.com/'
  NUKHBAPAY_STAFF_AUTH0_STAFF_KIND_CLAIM = 'https://claims.nukhbapay.com/principal'
  NUKHBAPAY_STAFF_AUTH0_CLIENT_ID = 'TBbIOZVfqVisv5S3xebFXSfBQfXsaEwu'
  NUKHBAPAY_STAFF_AUTH0_AUDIENCE = 'https://api.dev.nukhbapay.com/staff'
}
$scope = @($inspection.systemIdentifier, $inspection.databaseOid, $tenants[0],
  $settings.NUKHBAPAY_STAFF_AUTH0_ISSUER, $settings.NUKHBAPAY_STAFF_AUTH0_CLIENT_ID,
  $settings.NUKHBAPAY_STAFF_AUTH0_AUDIENCE) -join '|'
$owner = [Security.Principal.WindowsIdentity]::GetCurrent().User
$vault = Join-Path ([Environment]::GetFolderPath('LocalApplicationData')) 'Nukhbapay\staff-portal'
$profilePath = Join-Path $vault 'windows-staff.clixml'
$credentials = [ordered]@{}
$passwords = [Collections.Generic.HashSet[string]]::new([StringComparer]::Ordinal)
$temporaryProfile = $null
$password = $null
$catalogueProfile = $null
try {
  if (Test-Path -LiteralPath $vault) { Confirm-PrivateProfilePath $vault $owner }
  $profileExists = Test-Path -LiteralPath $profilePath
  if ($profileExists) { Confirm-PrivateProfilePath $profilePath $owner }
  $needsSetup = $Configure -or !$profileExists
  if ($needsSetup) {
    Write-Host 'One-time setup for the local Auth0 Staff Portal.'
    Write-Host 'Enter the existing values below. Windows saves them privately after preflight passes.'
    foreach ($name in $secretPrompts.Keys) {
      $credentials[$name] = Read-Host $secretPrompts[$name] -AsSecureString
    }
  } else {
    try { $saved = Import-Clixml -LiteralPath $profilePath }
    catch { throw 'Windows could not open the saved staff settings. Run the launcher with -Configure.' }
    if ($saved.Version -ne 1 -or $saved.Scope -cne $scope) {
      throw 'The saved staff settings belong to a different enrollment or database. Run with -Configure.'
    }
    foreach ($name in $secretPrompts.Keys) { $credentials[$name] = $saved.Credentials[$name] }
  }

  foreach ($name in $secretPrompts.Keys) {
    if ($credentials[$name] -isnot [Security.SecureString] -or !$credentials[$name].Length) {
      throw 'A required private setting is missing. Run the launcher with -Configure.'
    }
  }
  foreach ($name in $roleBindings.Keys) {
    $role = $roleBindings[$name]
    if ($credentials[$role].Length -lt 16 -or $credentials[$role].Length -gt 1024) {
      throw "The PostgreSQL password for $role must be 16 to 1024 characters."
    }
    $password = Unlock-StaffSetting $credentials[$role]
    if (!$passwords.Add($password)) { throw 'The three PostgreSQL roles must have distinct passwords.' }
    $settings[$name] = 'postgresql://' + $role + ':' + [Uri]::EscapeDataString($password) + '@127.0.0.1:5432/nukhbapay_staff'
    $password = $null
  }
  $passwords.Clear()
  $settings['NUKHBAPAY_STAFF_ENROLLMENT_SUBJECT'] = Unlock-StaffSetting $credentials['NUKHBAPAY_STAFF_ENROLLMENT_SUBJECT']
  $settings['NUKHBAPAY_STAFF_AUTH0_CLIENT_SECRET'] = Unlock-StaffSetting $credentials['NUKHBAPAY_STAFF_AUTH0_CLIENT_SECRET']

  if ($Catalogue) {
    $catalogueSetup = Join-Path $PSScriptRoot 'setup-windows-catalogue.ps1'
    & $catalogueSetup -ForStartup -Check:$Check
    $cataloguePath = Join-Path $vault 'windows-catalogue.clixml'
    Confirm-PrivateProfilePath $cataloguePath $owner
    $catalogueProfile = Import-Clixml -LiteralPath $cataloguePath
    $catalogueCredential = $catalogueProfile.Credentials['nukhbapay_catalogue_reader']
    if ($catalogueProfile.Version -ne 1 -or $catalogueProfile.Cluster -cne $inspection.systemIdentifier -or
        $catalogueProfile.Id -notmatch '^[a-f0-9]{32}$' -or $catalogueCredential -isnot [Security.SecureString]) {
      throw 'Catalogue reader settings do not match the verified Windows cluster.'
    }
    $settings['NUKHBAPAY_LOCAL_CATALOGUE_SETUP_ID'] = $catalogueProfile.Id
    $settings['DB_LOCAL_CATALOGUE_READER_PASSWORD'] = Unlock-StaffSetting $catalogueCredential
  }

  if ($needsSetup -or $Check) { & $launcher -PreflightOnly -Settings $settings }
  if ($needsSetup) {
    if (!(Test-Path -LiteralPath $vault)) {
      [void](New-Item -ItemType Directory -Path $vault)
      $acl = [Security.AccessControl.DirectorySecurity]::new()
      $acl.SetOwner($owner)
      $acl.SetAccessRuleProtection($true, $false)
      $acl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new($owner, 'FullControl', 'ContainerInherit,ObjectInherit', 'None', 'Allow'))
      Set-Acl -LiteralPath $vault -AclObject $acl
    }
    Confirm-PrivateProfilePath $vault $owner
    $temporaryProfile = Join-Path $vault ([Guid]::NewGuid().ToString('N') + '.clixml')
    try { @{Version=1; Scope=$scope; Credentials=$credentials} | Export-Clixml -LiteralPath $temporaryProfile }
    catch { throw 'Windows could not protect the staff settings. Run this command in your normal Windows PowerShell terminal.' }
    Confirm-PrivateProfilePath $temporaryProfile $owner
    if ($profileExists) {
      [IO.File]::Replace($temporaryProfile, $profilePath, [System.Management.Automation.Language.NullString]::Value)
    } else {
      [IO.File]::Move($temporaryProfile, $profilePath)
    }
    $temporaryProfile = $null
    Write-Host 'Private settings saved. Future starts reuse them for this Windows user.'
  }
  if (!$Check) { & $launcher -Settings $settings }
} finally {
  $password = $null
  $passwords.Clear()
  $settings.Clear()
  if ($catalogueProfile) {
    foreach ($credential in $catalogueProfile.Credentials.Values) {
      if ($credential -is [Security.SecureString]) { $credential.Dispose() }
    }
  }
  foreach ($credential in $credentials.Values) {
    if ($credential -is [Security.SecureString]) { $credential.Dispose() }
  }
  $credentials.Clear()
  if ($temporaryProfile -and (Test-Path -LiteralPath $temporaryProfile)) { Remove-Item -LiteralPath $temporaryProfile }
}
