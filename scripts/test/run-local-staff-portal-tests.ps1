$ErrorActionPreference='Stop'
$project=(Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '../..')).Path
$certificateRoot=Join-Path $env:LOCALAPPDATA 'Nukhbapay/development-https'
$matchesFound=@(Get-ChildItem -Directory -LiteralPath $certificateRoot | Where-Object {
 $file=Join-Path $_.FullName 'localhost.cer'
 if(Test-Path -LiteralPath $file) {
  $cert=[Security.Cryptography.X509Certificates.X509Certificate2]::new($file)
  try {$cert.Thumbprint -eq 'C8169B7EA95CC2D75038459C30FB402A474EEA3A' -and $cert.NotAfter -gt (Get-Date)} finally {$cert.Dispose()}
 }
})
if($matchesFound.Count -ne 1){throw 'Reviewed local TLS fixture unavailable'}
$tlsDirectory=$matchesFound[0].FullName
$secure=Import-Clixml -LiteralPath (Join-Path $tlsDirectory 'localhost.passphrase.clixml')
$pointer=[Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)
try {
 $env:NUKHBAPAY_STAFF_TEST_PFX_PATH=Join-Path $tlsDirectory 'localhost.pfx'
 $env:NUKHBAPAY_STAFF_TEST_CA_PATH=Join-Path $tlsDirectory 'localhost.cer'
 $env:NUKHBAPAY_STAFF_TEST_PASSPHRASE=[Runtime.InteropServices.Marshal]::PtrToStringBSTR($pointer)
 Push-Location -LiteralPath $project
 try { & pnpm.cmd --filter '@nukhbapay/admin-web' exec tsc -p tsconfig.test.json; if($LASTEXITCODE -ne 0){throw 'Portal test compilation failed'}; & node.exe --test 'apps/admin-web/dist-test/test/portal.spec.js'; $result=$LASTEXITCODE } finally {Pop-Location}
} finally {
 [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($pointer)
 $secure.Dispose()
 Remove-Item Env:NUKHBAPAY_STAFF_TEST_PFX_PATH,Env:NUKHBAPAY_STAFF_TEST_CA_PATH,Env:NUKHBAPAY_STAFF_TEST_PASSPHRASE -ErrorAction SilentlyContinue
}
exit $result
