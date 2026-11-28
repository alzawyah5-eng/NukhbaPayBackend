[CmdletBinding()]
param([switch]$ForStartup, [switch]$Check, [switch]$Rehearse, [switch]$ImportFinxplor, [switch]$Full, [switch]$Global, [switch]$RehearseImport, [switch]$CheckFinxplorCost, [switch]$InspectFinxplor, [switch]$VerifyFinxplorCoverage, [switch]$VerifyFinxplorLayer1, [switch]$RefreshFinxplorPrices, [switch]$RefreshFinxplorPricesNow, [switch]$RefreshFinxplorArtwork,
  [switch]$VerifyIpay, [switch]$SyncIpay, [ValidatePattern('^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$')][string]$ProductId)

$ErrorActionPreference = 'Stop'
if ($CheckFinxplorCost) { throw 'AED_NORMALIZATION_UNAVAILABLE: AED acquisition-cost normalization is unavailable during the Layer 1 rebuild.' }
if ($Global) { $Full = $true; $ImportFinxplor = $true }
$providerOperations = @($ImportFinxplor, $InspectFinxplor, $VerifyFinxplorCoverage, $VerifyFinxplorLayer1, $RefreshFinxplorPrices, $RefreshFinxplorPricesNow, $RefreshFinxplorArtwork, $VerifyIpay, $SyncIpay | Where-Object { $_ })
if ($providerOperations.Count -gt 1 -or ($providerOperations.Count -eq 1 -and ($ForStartup -or $Check -or $Rehearse))) {
  throw 'Select one catalogue operation.'
}
$providerOperation = $providerOperations.Count -eq 1
if ($Full -and !$ImportFinxplor) { throw 'Full import requires ImportFinxplor.' }
if ($RehearseImport -and !$Full) { throw 'Import rehearsal requires Full.' }
if (($InspectFinxplor -or $VerifyFinxplorCoverage) -and !$ProductId) { throw 'Inspection requires a product ID.' }
if ($ProductId -and (!$InspectFinxplor -and !$VerifyFinxplorCoverage -and (!$ImportFinxplor -or $Full))) { throw 'Select a read-only product operation.' }
if (!$ForStartup -and !$Check -and !$Rehearse -and !$providerOperation) { $Host.UI.RawUI.WindowTitle = 'NukhbaPay | Private local catalogue setup' }
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
$refreshRun = $null
$refreshPhase = 'verified Windows PostgreSQL target'
$providerResult = $null

function Save-FullRefreshReceipt([string]$State, [string]$Phase) {
  $entry = [ordered]@{
    version = 2
    runId = $refreshRun
    timeUtc = [DateTime]::UtcNow.ToString('o')
    state = $State
    phase = $Phase
    requestedCoverage = $(if ($Global) {'ALL_COUNTRIES'} else {'ARE_GIFT_CARD'})
  }
  if ($State -in @('COMMITTED','PARTIAL_COMMITTED','REHEARSED')) {
    $entry['importResult'] = $providerResult.result
    $entry['completedCoverage'] = $providerResult.completedCoverage
    $entry['scanDigest'] = $providerResult.scanDigest
    $entry['persisted'] = $providerResult.persisted
    if ($State -ceq 'PARTIAL_COMMITTED') {
      $entry['nextPage'] = $providerResult.nextPage
      $entry['verificationPending'] = $providerResult.verificationPending -eq $true
      $entry['verificationMismatch'] = $providerResult.verificationMismatch -eq $true
      $entry['storedCoverage'] = $providerResult.storedCoverage
    }
  }
  foreach ($counter in 'pages','pagesRetrieved','requests','products','inserted','unchanged','rejected','legacyCorrections','protocolCases','partialRollbackChecks') {
    if ($providerResult.$counter -is [int] -and $providerResult.$counter -ge 0 -and $providerResult.$counter -le 100000) {
      $entry[$counter] = $providerResult.$counter
    }
  }
  if ($providerResult.code -is [string] -and $providerResult.code -cmatch '^(UNAVAILABLE|[A-Z0-9]{5})$') {
    $entry['code'] = $providerResult.code
  }
  if ($providerResult.providerStatus -is [int] -and $providerResult.providerStatus -ge 100 -and $providerResult.providerStatus -le 599) {
    $entry['httpStatus'] = $providerResult.providerStatus
  }
  $json = ConvertTo-Json -InputObject $entry -Compress
  $suffix = if ($State -eq 'STARTED') { 'start' } else { 'result' }
  $file = Join-Path $refreshDirectory ($refreshRun + '-' + $suffix + '.json')
  # Publish the small receipt atomically. Unpaired start records identify interrupted runs.
  $temp = $file + '.tmp'
  try {
    [IO.File]::WriteAllText($temp, $json, [Text.UTF8Encoding]::new($false))
    [IO.File]::Move($temp, $file)
  } finally {
    if (Test-Path -LiteralPath $temp) { Remove-Item -LiteralPath $temp -ErrorAction SilentlyContinue }
  }
  if ($State -ne 'STARTED') { Write-Host $json }
}

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
  if ($Full) {
    $local = Get-Item -LiteralPath (Join-Path $project '.local')
    if (!$local.PSIsContainer -or $local.LinkType) { throw 'Unexpected local state path.' }
    $refreshDirectory = Join-Path $local.FullName 'finxplor-refresh'
    [void][IO.Directory]::CreateDirectory($refreshDirectory)
    if ((Get-Item -LiteralPath $refreshDirectory).LinkType) { throw 'Unexpected local refresh receipt path.' }
    $refreshRun = [Guid]::NewGuid().ToString('N')
    Save-FullRefreshReceipt 'STARTED' $refreshPhase
  }
  $evidence = Get-Content -Raw -LiteralPath (Join-Path $project '.local\windows-staff-inspection.json') | ConvertFrom-Json
  if ($evidence.targetVerified -ne $true -or $evidence.systemIdentifier -notmatch '^[1-9][0-9]{15,19}$' -or
      (Get-Service -Name 'postgresql-x64-18').Status -ne 'Running') { throw 'The verified Windows PostgreSQL target is unavailable.' }
  $qualified = $false
  if (Test-Path -LiteralPath $receiptPath -PathType Leaf) {
    $receipt = Get-Content -Raw -LiteralPath $receiptPath | ConvertFrom-Json
    $qualified = $receipt.status -ceq 'verified' -and $receipt.foundationInstalled -eq $true -and $receipt.backendReaderVerified -eq $true
  }
  $refreshPhase = 'catalogue installation receipt'
  if (($Check -or $Rehearse -or $providerOperation) -and !$qualified) { throw 'The local catalogue database needs first-time setup.' }
  $refreshPhase = 'protected catalogue credentials'
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
  $refreshPhase = 'Node executable resolution'
  $client = (Get-Command node.exe -CommandType Application).Source
  $refreshPhase = 'protected catalogue credentials'
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
  if ($providerOperation) { $rolesForProcess = @('nukhbapay_catalogue_runtime') }
  if ($VerifyFinxplorCoverage) { $rolesForProcess = @('nukhbapay_catalogue_reader') }
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
  if ($VerifyIpay) { $launch.Arguments = 'scripts/import-ipay-catalogue.mjs --check' }
  elseif ($SyncIpay) { $launch.Arguments = 'scripts/import-ipay-catalogue.mjs --sync' }
  elseif ($InspectFinxplor) { $launch.Arguments = 'scripts/import-finxplor-pilot.mjs --inspect ' + $ProductId }
  elseif ($RefreshFinxplorArtwork) { $launch.Arguments = 'scripts/import-finxplor-pilot.mjs --refresh-artwork' }
  elseif ($RefreshFinxplorPricesNow) { $launch.Arguments = 'scripts/import-finxplor-pilot.mjs --refresh-prices-now' }
  elseif ($RefreshFinxplorPrices) { $launch.Arguments = 'scripts/import-finxplor-pilot.mjs --refresh-prices' }
  elseif ($VerifyFinxplorLayer1) { $launch.Arguments = 'scripts/import-finxplor-pilot.mjs --verify-layer1' }
  elseif ($VerifyFinxplorCoverage) { $launch.Arguments = 'scripts/import-finxplor-pilot.mjs --verify-scope ' + $ProductId }
  elseif ($ImportFinxplor) { $launch.Arguments = 'scripts/import-finxplor-pilot.mjs' }
  elseif ($Rehearse) { $launch.Arguments += ' --rehearse' }
  elseif ($Check) { $launch.Arguments += ' --check' }
  elseif ($qualified) { $launch.Arguments += ' --migrate' }
  if ($RehearseImport) { $launch.Arguments += ' --rehearse-scope' }
  elseif ($Global) { $launch.Arguments += ' --global' }
  elseif ($Full) { $launch.Arguments += ' --full' }
  if ($ProductId -and $ImportFinxplor) { $launch.Arguments += ' --detail ' + $ProductId }
  $launch.UseShellExecute = $false
  $launch.RedirectStandardOutput = [bool]$Full
  $launch.RedirectStandardError = [bool]$Full
  $launch.EnvironmentVariables.Clear()
  foreach ($name in 'PATH', 'SystemRoot', 'WINDIR', 'TEMP', 'TMP', 'LOCALAPPDATA', 'USERPROFILE') {
    $value = [Environment]::GetEnvironmentVariable($name)
    if ($value) { $launch.EnvironmentVariables[$name] = $value }
  }
  $launch.EnvironmentVariables['NUKHBAPAY_CATALOGUE_SETUP_ID'] = $settings.Id
  if ($Full) { $launch.EnvironmentVariables['NUKHBAPAY_CATALOGUE_REFRESH_RUN_ID'] = $refreshRun }
  if ($admin) { $launch.EnvironmentVariables['NUKHBAPAY_CATALOGUE_LOCAL_ADMIN'] = Unlock-CatalogueSetting $admin }
  foreach ($role in $rolesForProcess) {
    $launch.EnvironmentVariables[$role.ToUpperInvariant() + '_PASSWORD'] = Unlock-CatalogueSetting $settings.Credentials[$role]
  }
  if (!$qualified) { Set-Content -LiteralPath $status -Value 'provisioning-and-qualifying' }
  $refreshPhase = 'importer startup'
  $refreshState = 'STOPPED'
  $process = [Diagnostics.Process]::Start($launch)
  try {
    $launch.EnvironmentVariables.Clear()
    if ($admin) { $admin.Dispose(); $admin = $null }
    if ($Full) {
      $refreshPhase = 'importer result unavailable'
      $refreshState = 'OUTCOME_UNCONFIRMED'
      $output = $process.StandardOutput.ReadToEndAsync()
      $errors = $process.StandardError.ReadToEndAsync()
    }
    $process.WaitForExit()
    if ($Full) {
      $text = if ($process.ExitCode -eq 0) { $output.GetAwaiter().GetResult() } else { $errors.GetAwaiter().GetResult() }
      if ($text.Length -le 1024) {
        try { $providerResult = $text | ConvertFrom-Json -ErrorAction Stop }
        catch { $providerResult = $null }
      }
      $expectedResults = if ($RehearseImport) { @('REHEARSED') } else { @('IMPORTED','REPLAYED') }
      $partial = $Global -and $null -eq $providerResult.completedCoverage -and $providerResult.storedCoverage -ceq 'PARTIAL_ALL_COUNTRIES' -and
        $providerResult.nextPage -is [int] -and $providerResult.nextPage -ge 1 -and $providerResult.nextPage -le 1000
      $qualifiedCoverage = if ($partial) {
        $providerResult.pages -is [int] -and $providerResult.pages -ge 1 -and $providerResult.pages -le 1000 -and
          $providerResult.products -ge $providerResult.pages -and $providerResult.products -le (100 * $providerResult.pages)
      } elseif ($Global) {
        $providerResult.completedCoverage -ceq 'ALL_COUNTRIES' -and $providerResult.pages -is [int] -and
          $providerResult.pages -ge 2 -and $providerResult.pages -le 1000 -and
          $providerResult.products -ge ($providerResult.pages - 1) -and $providerResult.products -le (100 * ($providerResult.pages - 1))
      } else {
        $providerResult.completedCoverage -ceq $providerResult.requestedCoverage -and
          $providerResult.pages -is [int] -and $providerResult.pages -eq ([Math]::Ceiling($providerResult.products / 100) + 1)
      }
      if ($process.ExitCode -eq 0 -and $providerResult.result -cin $expectedResults -and
          $providerResult.requestedCoverage -ceq $(if ($Global) {'ALL_COUNTRIES'} else {'ARE_GIFT_CARD'}) -and $qualifiedCoverage -and
          $providerResult.scanDigest -cmatch '^[a-f0-9]{64}$' -and $providerResult.products -is [int] -and
          $providerResult.products -ge 1 -and $providerResult.products -le 100000 -and
          ($Global -or ($providerResult.pagesRetrieved -is [int] -and $providerResult.pagesRetrieved -eq (2 * ($providerResult.pages + 1)))) -and
          ($Global -or ($providerResult.requests -is [int] -and $providerResult.requests -ge $providerResult.pagesRetrieved)) -and
          $providerResult.inserted -is [int] -and $providerResult.unchanged -is [int] -and $providerResult.rejected -eq 0 -and
          $providerResult.inserted -ge 0 -and $providerResult.inserted -le $providerResult.products -and
          $providerResult.unchanged -eq ($providerResult.products - $providerResult.inserted) -and
          $providerResult.persisted -is [bool] -and $providerResult.persisted -eq (!$RehearseImport)) {
        $refreshPhase = if ($RehearseImport) { 'discovery rollback acknowledged' } else { 'discovery commit acknowledged' }
        Save-FullRefreshReceipt $(if ($RehearseImport) { 'REHEARSED' } elseif ($partial) { 'PARTIAL_COMMITTED' } else { 'COMMITTED' }) $refreshPhase
      } else {
        if ($process.ExitCode -ne 0 -and $providerResult.result -ceq 'STOPPED' -and $providerResult.phase -cin @(
            'configuration', 'catalogue database login', 'catalogue database scope', 'local provider account','refresh lock',
            'Finxplor catalogue read', 'Finxplor pagination qualification','discovery transaction', 'discovery commit')) {
          $refreshPhase = $providerResult.phase
          if ($refreshPhase -cne 'discovery commit') { $refreshState = 'STOPPED' }
        }
        throw 'Full catalogue refresh did not return a verified result.'
      }
    }
    if ($process.ExitCode -ne 0) { throw 'The catalogue database setup did not complete.' }
  } finally { $process.Dispose() }
  if (!$qualified) {
    Set-Content -LiteralPath $status -Value 'foundation-verified'
    Write-Host 'Local catalogue database foundation verified.'
  }
} catch {
  if ($Full) {
    if ($refreshRun) {
      if (!$refreshState) { $refreshState = 'STOPPED' }
      Save-FullRefreshReceipt $refreshState $refreshPhase
    }
    throw 'Full catalogue refresh stopped. Check the sanitized local receipt.'
  }
  if ($ForStartup -or $Check -or $Rehearse -or $providerOperation) { throw }
  if (!$qualified) { Set-Content -LiteralPath $status -Value 'catalogue-setup-stopped' }
  Write-Host 'Catalogue setup stopped. Check the message above before retrying in this window.'
} finally {
  if ($launch) { $launch.EnvironmentVariables.Clear() }
  if ($admin) { $admin.Dispose() }
  if ($settings) { foreach ($credential in $settings.Credentials.Values) { $credential.Dispose() } }
}
if (!$ForStartup -and !$Check -and !$Rehearse -and !$providerOperation) { [void](Read-Host 'Press Enter to close this private window') }
