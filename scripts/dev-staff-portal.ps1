$ErrorActionPreference = 'Stop'

$repositoryRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$certificateRoot = Join-Path $env:LOCALAPPDATA 'Nukhbapay\development-https'
$setupScript = Join-Path $PSScriptRoot 'setup-staff-development-https.ps1'
$launcherScript = Join-Path $PSScriptRoot 'start-staff-portal.ps1'

if ([string]::IsNullOrWhiteSpace($env:LOCALAPPDATA)) {
  throw 'LOCALAPPDATA is required for local HTTPS certificate storage'
}

function Test-MetadataPath($actual, $expected) {
  if ([string]::IsNullOrWhiteSpace([string]$actual)) { return $false }
  return [string]::Equals(
    [IO.Path]::GetFullPath([string]$actual),
    [IO.Path]::GetFullPath($expected),
    [StringComparison]::OrdinalIgnoreCase
  )
}

function Find-ValidCertificateMetadata {
  if (-not (Test-Path -LiteralPath $certificateRoot -PathType Container)) { return $null }

  $directories = Get-ChildItem -LiteralPath $certificateRoot -Directory |
    Sort-Object -Property LastWriteTime -Descending
  foreach ($directory in $directories) {
    $metadataPath = Join-Path $directory.FullName 'metadata.json'
    if (-not (Test-Path -LiteralPath $metadataPath -PathType Leaf)) { continue }

    $metadata = Get-Content -LiteralPath $metadataPath -Raw | ConvertFrom-Json
    $thumbprint = [string]$metadata.Thumbprint
    $expectedPfx = Join-Path $directory.FullName 'localhost.pfx'
    $expectedCertificate = Join-Path $directory.FullName 'localhost.cer'
    $expectedPassphrase = Join-Path $directory.FullName 'localhost.passphrase.clixml'
    if ($thumbprint -notmatch '^[0-9A-Fa-f]{40}$' -or
        -not (Test-MetadataPath $metadata.PfxPath $expectedPfx) -or
        -not (Test-MetadataPath $metadata.PublicCertificate $expectedCertificate) -or
        -not (Test-MetadataPath $metadata.PassphrasePath $expectedPassphrase) -or
        -not (Test-Path -LiteralPath $expectedPfx -PathType Leaf) -or
        -not (Test-Path -LiteralPath $expectedCertificate -PathType Leaf) -or
        -not (Test-Path -LiteralPath $expectedPassphrase -PathType Leaf)) {
      Write-Warning "Ignoring incomplete local HTTPS certificate metadata in '$($directory.Name)'."
      continue
    }

    & powershell.exe -NoProfile -ExecutionPolicy RemoteSigned -File $setupScript -Action Inspect -Thumbprint $thumbprint *> $null
    if ($LASTEXITCODE -eq 0) { return $metadataPath }
    Write-Warning "Ignoring invalid or expired local HTTPS certificate in '$($directory.Name)'."
  }
  return $null
}

Push-Location $repositoryRoot
try {
  $env:NODE_ENV = 'development'
  $env:NUKHBAPAY_STAFF_UI_PREVIEW = 'enabled'

  & corepack.cmd pnpm staff:build
  if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

  $metadataPath = Find-ValidCertificateMetadata
  if (-not $metadataPath) {
    Write-Output 'Creating a localhost-only HTTPS certificate; Windows trust will not be changed.'
    & powershell.exe -NoProfile -ExecutionPolicy RemoteSigned -File $setupScript -Action Create *> $null
    if ($LASTEXITCODE -ne 0) { throw 'Local HTTPS certificate creation failed' }
    $metadataPath = Find-ValidCertificateMetadata
  }
  if (-not $metadataPath) { throw 'No valid local HTTPS certificate is available' }

  & powershell.exe -NoProfile -ExecutionPolicy RemoteSigned -File $launcherScript `
    -CertificateMetadata $metadataPath -PinnedCertificateOnly
  exit $LASTEXITCODE
} finally {
  Pop-Location
}
