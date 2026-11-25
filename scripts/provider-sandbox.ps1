[CmdletBinding()]
param(
  [Parameter(Mandatory)][ValidateSet('ssl-topup','ssl-utilities','irongate','finxplor','ipay')][string]$Provider,
  [Parameter(Mandatory)][ValidateSet('service-list','package-list','prepaid','postpaid','games','game-format','game-servers','esim-indonesia','esim-international','documentation')][string]$Operation,
  [switch]$Read
)

$ErrorActionPreference = 'Stop'
$project = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..')).Path
$node = (Get-Command node.exe -CommandType Application).Source
$Provider = $Provider.ToLowerInvariant()
$Operation = $Operation.ToLowerInvariant()
if (!$Read) {
  & $node (Join-Path $PSScriptRoot 'provider-sandbox.mjs') $Provider $Operation '--check'
  exit $LASTEXITCODE
}

# Perform the configuration check before opening the saved database profile.
& $node (Join-Path $PSScriptRoot 'provider-sandbox.mjs') $Provider $Operation '--check'
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

$vault = Join-Path ([Environment]::GetFolderPath('LocalApplicationData')) 'Nukhbapay\staff-portal'
$profilePath = Join-Path $vault 'windows-catalogue.clixml'
$owner = [Security.Principal.WindowsIdentity]::GetCurrent().User
$profile = $null
$buffer = [IntPtr]::Zero
$launch = $null
try {
  foreach ($path in $vault, $profilePath) {
    $item = Get-Item -Force -LiteralPath $path
    $acl = Get-Acl -LiteralPath $path
    $other = @($acl.GetAccessRules($true, $true, [Security.Principal.SecurityIdentifier]) |
      Where-Object { $_.AccessControlType -eq 'Allow' -and $_.IdentityReference -ne $owner })
    if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -or
        $acl.GetOwner([Security.Principal.SecurityIdentifier]) -ne $owner -or $other.Count) {
      throw 'Unexpected catalogue profile path.'
    }
  }
  $profile = Import-Clixml -LiteralPath $profilePath
  $inspection = Get-Content -Raw -LiteralPath (Join-Path $project '.local\windows-staff-inspection.json') | ConvertFrom-Json
  $credential = $profile.Credentials['nukhbapay_catalogue_reader']
  if ($inspection.targetVerified -ne $true -or $profile.Version -ne 1 -or $profile.Cluster -cne $inspection.systemIdentifier -or
      $profile.Id -notmatch '^[a-f0-9]{32}$' -or $credential -isnot [Security.SecureString]) {
    throw 'Unexpected catalogue profile scope.'
  }
  $buffer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($credential)
  $launch = [Diagnostics.ProcessStartInfo]::new()
  $launch.FileName = $node
  $launch.WorkingDirectory = $project
  $launch.Arguments = "scripts/provider-sandbox.mjs $Provider $Operation --read"
  $launch.UseShellExecute = $false
  $launch.EnvironmentVariables.Clear()
  foreach ($name in 'PATH','SystemRoot','WINDIR','TEMP','TMP','LOCALAPPDATA','USERPROFILE') {
    $value = [Environment]::GetEnvironmentVariable($name)
    if ($value) { $launch.EnvironmentVariables[$name] = $value }
  }
  $launch.EnvironmentVariables['NUKHBAPAY_LOCAL_CATALOGUE_SETUP_ID'] = $profile.Id
  $launch.EnvironmentVariables['DB_LOCAL_CATALOGUE_READER_PASSWORD'] = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($buffer)
  $process = [Diagnostics.Process]::Start($launch)
  try {
    $launch.EnvironmentVariables.Clear()
    $process.WaitForExit()
    exit $process.ExitCode
  } finally { $process.Dispose() }
} catch {
  Write-Error 'Provider sandbox read stopped. The approved catalogue account or private reader profile must be available.' -ErrorAction Continue
  exit 1
} finally {
  if ($launch) { $launch.EnvironmentVariables.Clear() }
  if ($buffer -ne [IntPtr]::Zero) { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($buffer) }
  if ($profile) {
    foreach ($credential in $profile.Credentials.Values) {
      if ($credential -is [Security.SecureString]) { $credential.Dispose() }
    }
  }
}
