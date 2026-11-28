[CmdletBinding()]
param(
  [Parameter(Mandatory)][ValidateSet('Rehearse','Apply')][string]$Mode
)

$ErrorActionPreference = 'Stop'
$project = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..')).Path
$vault = Join-Path ([Environment]::GetFolderPath('LocalApplicationData')) 'Nukhbapay\staff-portal'
$profilePath = Join-Path $vault 'windows-catalogue.clixml'
$sid = [Security.Principal.WindowsIdentity]::GetCurrent().User
foreach ($path in @($vault,$profilePath)) {
  $item = Get-Item -LiteralPath $path
  $acl = Get-Acl -LiteralPath $path
  if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -or
      $acl.GetOwner([Security.Principal.SecurityIdentifier]) -ne $sid -or
      @($acl.GetAccessRules($true,$true,[Security.Principal.SecurityIdentifier]) |
        Where-Object { $_.AccessControlType -eq 'Allow' -and $_.IdentityReference -ne $sid }).Count) {
    throw 'The catalogue credential binding and backup parent must be private to this Windows user.'
  }
}
$profile = Import-Clixml -LiteralPath $profilePath
try {
  if ($profile.Version -ne 1 -or $profile.Id -cnotmatch '^[0-9a-f]{32}$') {
    throw 'Verified private Windows catalogue settings are required.'
  }
  $backup = Join-Path $vault ('staff-consolidation-' + [Guid]::NewGuid().ToString('N'))
  [void][IO.Directory]::CreateDirectory($backup)
  $env:NUKHBAPAY_STAFF_MERGE_BACKUP_DIRECTORY = $backup
  $env:NUKHBAPAY_STAFF_MERGE_CATALOGUE_SETUP_ID = $profile.Id
  & node.exe (Join-Path $PSScriptRoot 'consolidate-windows-staff-database.mjs') ('--'+$Mode.ToLowerInvariant())
  if ($LASTEXITCODE -ne 0) { throw 'Windows staff consolidation did not finish.' }
} finally {
  Remove-Item Env:NUKHBAPAY_STAFF_MERGE_BACKUP_DIRECTORY,Env:NUKHBAPAY_STAFF_MERGE_CATALOGUE_SETUP_ID -ErrorAction SilentlyContinue
  foreach ($credential in $profile.Credentials.Values) {
    if ($credential -is [Security.SecureString]) { $credential.Dispose() }
  }
}
