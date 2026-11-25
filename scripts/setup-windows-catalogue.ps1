[CmdletBinding()]
param([switch]$ForStartup, [switch]$Check, [switch]$Rehearse, [switch]$ImportFinxplor, [switch]$Full,
  [ValidatePattern('^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$')][string]$ProductId)

$ErrorActionPreference = 'Stop'
if ($ImportFinxplor -and ($ForStartup -or $Check -or $Rehearse)) { throw 'Select one catalogue operation.' }
if ($Full -and !$ImportFinxplor) { throw 'Full import requires ImportFinxplor.' }
if ($ProductId -and (!$ImportFinxplor -or $Full)) { throw 'A product detail check requires ImportFinxplor without Full.' }
if (!$ForStartup -and !$Check -and !$Rehearse -and !$ImportFinxplor) { $Host.UI.RawUI.WindowTitle = 'NukhbaPay | Private local catalogue setup' }
$project = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..')).Path
$vault = Join-Path ([Environment]::GetFolderPath('LocalApplicationData')) 'Nukhbapay\staff-portal'
$profile = Join-Path $vault 'windows-catalogue.clixml'
$owner = [Security.Principal.WindowsIdentity]::GetCurrent().User
$roles = @('nukhbapay_catalogue_reader', 'nukhbapay_catalogue_runtime', 'nukhbapay_catalogue_migrator')
$settings = $null
$admin = $null
$launch = $null
$status = Join-Path $project '.local\windows-catalogue-setup-status.txt'
$receiptPath = Join-Path $project '.local\windows-catalogue-result.json'

function Confirm-PrivateCataloguePath ([string]$Path) {
  if ((Get-Item -Force -LiteralPath $Path).Attributes -band [IO.FileAttributes]::ReparsePoint) {
    throw 'Unexpected protected settings path.'
  }
  $acl = Get-Acl -LiteralPath $Path
  $otherReaders = @($acl.GetAccessRules($true, $true, [Security.Principal.SecurityIdentifier]) |
    Where-Object { $_.AccessControlType -eq 'Allow' -and $_.IdentityReference -ne $owner })
  if ($acl.GetOwner([Security.Principal.SecurityIdentifier]) -ne $owner -or $otherReaders.Count) {
    throw 'The protected settings path must belong to the current Windows user.'
  }
}

function Unlock-CatalogueSetting ([Security.SecureString]$Value) {
  $buffer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($Value)
  try { return [Runtime.InteropServices.Marshal]::PtrToStringBSTR($buffer) }
  finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($buffer) }
}

try {
  $evidence = Get-Content -Raw -LiteralPath (Join-Path $project '.local\windows-staff-inspection.json') | ConvertFrom-Json
  if ($evidence.targetVerified -ne $true -or $evidence.systemIdentifier -notmatch '^[1-9][0-9]{15,19}$' -or
      (Get-Service -Name 'postgresql-x64-18').Status -ne 'Running') { throw 'The verified Windows PostgreSQL target is unavailable.' }
  $qualified = $false
  if (Test-Path -LiteralPath $receiptPath -PathType Leaf) {
    $receipt = Get-Content -Raw -LiteralPath $receiptPath | ConvertFrom-Json
    $qualified = $receipt.status -ceq 'verified' -and $receipt.foundationInstalled -eq $true -and $receipt.backendReaderVerified -eq $true
  }
  if (($Check -or $Rehearse -or $ImportFinxplor) -and !$qualified) { throw 'The local catalogue database needs first-time setup.' }
  if (!(Test-Path -LiteralPath $vault)) {
    if ($qualified) { throw 'The protected catalogue credential vault is missing.' }
    [void](New-Item -ItemType Directory -Path $vault)
    $acl = [Security.AccessControl.DirectorySecurity]::new()
    $acl.SetOwner($owner)
    $acl.SetAccessRuleProtection($true, $false)
    $acl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new($owner, 'FullControl', 'ContainerInherit,ObjectInherit', 'None', 'Allow'))
    Set-Acl -LiteralPath $vault -AclObject $acl
  }
  Confirm-PrivateCataloguePath $vault
  $client = (Get-Command node.exe -CommandType Application).Source
  if (!$qualified) {
    Push-Location -LiteralPath $project
    try {
      & $client 'scripts/local-catalogue-setup.mjs' '--sources-only'
      if ($LASTEXITCODE -ne 0) { throw 'Catalogue migration source verification failed.' }
    } finally { Pop-Location }
  }
  if (Test-Path -LiteralPath $profile) {
    Confirm-PrivateCataloguePath $profile
    $settings = Import-Clixml -LiteralPath $profile
    if ($settings.Version -ne 1 -or $settings.Cluster -cne $evidence.systemIdentifier -or $settings.Id -notmatch '^[a-f0-9]{32}$') {
      throw 'The saved catalogue profile belongs to a different PostgreSQL cluster.'
    }
  } else {
    if ($qualified) { throw 'The protected catalogue role profile is missing.' }
    $credentials = @{}
    $rng = [Security.Cryptography.RandomNumberGenerator]::Create()
    $bytes = New-Object byte[] 32
    try {
      foreach ($role in $roles) {
        $rng.GetBytes($bytes)
        $credentials[$role] = ConvertTo-SecureString ([BitConverter]::ToString($bytes).Replace('-', '').ToLowerInvariant()) -AsPlainText -Force
      }
    } finally {
      [Array]::Clear($bytes, 0, $bytes.Length)
      $rng.Dispose()
    }
    $settings = @{ Version = 1; Cluster = $evidence.systemIdentifier; Id = [Guid]::NewGuid().ToString('N'); Credentials = $credentials }
    $temporaryProfile = Join-Path $vault ([Guid]::NewGuid().ToString('N') + '.clixml')
    try {
      $settings | Export-Clixml -LiteralPath $temporaryProfile
      Confirm-PrivateCataloguePath $temporaryProfile
      [IO.File]::Move($temporaryProfile, $profile)
    } finally {
      if (Test-Path -LiteralPath $temporaryProfile) { Remove-Item -LiteralPath $temporaryProfile }
    }
  }
  $rolesForProcess = $roles
  if ($qualified) { $rolesForProcess = @('nukhbapay_catalogue_reader', 'nukhbapay_catalogue_migrator') }
  if ($ImportFinxplor) { $rolesForProcess = @('nukhbapay_catalogue_runtime') }
  foreach ($role in $rolesForProcess) {
    if ($settings.Credentials[$role] -isnot [Security.SecureString] -or $settings.Credentials[$role].Length -ne 64) {
      throw 'A protected catalogue role credential is missing.'
    }
  }
  if (!$qualified) {
    Set-Content -LiteralPath $status -Value 'awaiting-private-postgres-login'
    Write-Host 'Target: PostgreSQL 18 at 127.0.0.1:5432, database nukhbapay_catalogue.'
    Write-Host 'Three distinct catalogue role passwords are protected by Windows for this user.'
    $admin = Read-Host 'Existing Windows PostgreSQL postgres password' -AsSecureString
    if (!$admin.Length) { throw 'No administrator password was supplied.' }
  }
  $launch = [Diagnostics.ProcessStartInfo]::new()
  $launch.FileName = $client
  $launch.WorkingDirectory = $project
  $launch.Arguments = 'scripts/local-catalogue-setup.mjs'
  if ($ImportFinxplor) { $launch.Arguments = 'scripts/import-finxplor-pilot.mjs' }
  elseif ($Rehearse) { $launch.Arguments += ' --rehearse' }
  elseif ($Check) { $launch.Arguments += ' --check' }
  elseif ($qualified) { $launch.Arguments += ' --migrate' }
  if ($Full) { $launch.Arguments += ' --full' }
  if ($ProductId) { $launch.Arguments += ' --detail ' + $ProductId }
  $launch.UseShellExecute = $false
  $launch.EnvironmentVariables.Clear()
  foreach ($name in 'PATH', 'SystemRoot', 'WINDIR', 'TEMP', 'TMP', 'LOCALAPPDATA', 'USERPROFILE') {
    $value = [Environment]::GetEnvironmentVariable($name)
    if ($value) { $launch.EnvironmentVariables[$name] = $value }
  }
  $launch.EnvironmentVariables['NUKHBAPAY_CATALOGUE_SETUP_ID'] = $settings.Id
  if ($admin) { $launch.EnvironmentVariables['NUKHBAPAY_CATALOGUE_LOCAL_ADMIN'] = Unlock-CatalogueSetting $admin }
  foreach ($role in $rolesForProcess) {
    $launch.EnvironmentVariables[$role.ToUpperInvariant() + '_PASSWORD'] = Unlock-CatalogueSetting $settings.Credentials[$role]
  }
  if (!$qualified) { Set-Content -LiteralPath $status -Value 'provisioning-and-qualifying' }
  $process = [Diagnostics.Process]::Start($launch)
  try {
    $launch.EnvironmentVariables.Clear()
    if ($admin) { $admin.Dispose(); $admin = $null }
    $process.WaitForExit()
    if ($process.ExitCode -ne 0) { throw 'The catalogue database setup did not complete.' }
  } finally { $process.Dispose() }
  if (!$qualified) {
    Set-Content -LiteralPath $status -Value 'foundation-verified'
    Write-Host 'Local catalogue database foundation verified.'
  }
} catch {
  if ($ForStartup -or $Check -or $Rehearse -or $ImportFinxplor) { throw }
  if (!$qualified) { Set-Content -LiteralPath $status -Value 'catalogue-setup-stopped' }
  Write-Host 'Catalogue setup stopped. Check the message above before retrying in this window.'
} finally {
  if ($launch) { $launch.EnvironmentVariables.Clear() }
  if ($admin) { $admin.Dispose() }
  if ($settings) { foreach ($credential in $settings.Credentials.Values) { $credential.Dispose() } }
}
if (!$ForStartup -and !$Check -and !$Rehearse -and !$ImportFinxplor) { [void](Read-Host 'Press Enter to close this private window') }
