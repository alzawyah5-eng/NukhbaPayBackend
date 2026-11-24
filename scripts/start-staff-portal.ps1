param([Parameter(Mandatory=$true)][string]$CertificateMetadata,[switch]$PinnedCertificateOnly,[switch]$Auth0TestLogin)
$ErrorActionPreference = 'Stop'
$previousPfx = $env:NUKHBAPAY_STAFF_TLS_PFX_PATH
$previousCertificate = $env:NUKHBAPAY_STAFF_TLS_CERT_PATH
$previousPassphrase = $env:NUKHBAPAY_STAFF_TLS_PASSPHRASE
try {
  if ($Auth0TestLogin -and $PinnedCertificateOnly) { throw 'Auth0 browser testing requires the reviewed browser-trusted localhost certificate' }
  $metadata = Get-Content -LiteralPath $CertificateMetadata -Raw | ConvertFrom-Json
  if ($metadata.Thumbprint -notmatch '^[0-9A-Fa-f]{40}$' -or
      (-not $PinnedCertificateOnly -and -not (Test-Path -LiteralPath ('Cert:\CurrentUser\Root\' + $metadata.Thumbprint)))) {
    throw 'A reviewed trusted development certificate is required'
  }
  if ($PinnedCertificateOnly) { Write-Output 'Windows trust unchanged: use clients that explicitly trust the reviewed public certificate. Browser trust is not established.' }
  $secure = Import-Clixml -LiteralPath $metadata.PassphrasePath
  $pointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)
  try { $env:NUKHBAPAY_STAFF_TLS_PASSPHRASE = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($pointer) }
  finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($pointer) }
  $env:NUKHBAPAY_STAFF_TLS_PFX_PATH = $metadata.PfxPath
  $env:NUKHBAPAY_STAFF_TLS_CERT_PATH = $metadata.PublicCertificate
  $portalMain = if ($Auth0TestLogin) { Join-Path $PSScriptRoot 'start-staff-auth0-test.mjs' }
    else { [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\apps\admin-web\dist\main.js')) }
  & node $portalMain
  exit $LASTEXITCODE
} catch { Write-Error 'Staff HTTPS portal startup failed; no credential details are emitted.'; exit 1 }
finally {
  $env:NUKHBAPAY_STAFF_TLS_PFX_PATH = $previousPfx
  $env:NUKHBAPAY_STAFF_TLS_CERT_PATH = $previousCertificate
  $env:NUKHBAPAY_STAFF_TLS_PASSPHRASE = $previousPassphrase
}
