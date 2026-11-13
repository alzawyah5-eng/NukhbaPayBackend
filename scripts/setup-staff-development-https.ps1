param(
  [ValidateSet('Create','Trust','Inspect')][string]$Action = 'Inspect',
  [string]$Thumbprint
)
$ErrorActionPreference = 'Stop'
$certificateLabel = 'Nukhbapay Local Staff HTTPS'
$stage = 'initialization'
try {
  if ($Action -eq 'Create') {
    # Private material stays outside the OneDrive checkout and recovery archives.
    $certificateRoot = [IO.Path]::GetFullPath((Join-Path $env:LOCALAPPDATA 'Nukhbapay\development-https'))
    $certificateDirectory = Join-Path $certificateRoot ([Guid]::NewGuid().ToString('N'))
    if (Test-Path -LiteralPath $certificateDirectory) { throw 'Existing certificate directory' }
    New-Item -ItemType Directory -Path $certificateDirectory -Force | Out-Null
    $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
    $acl = New-Object Security.AccessControl.DirectorySecurity
    $acl.SetOwner($identity.User)
    $acl.SetAccessRuleProtection($true, $false)
    $rule = New-Object Security.AccessControl.FileSystemAccessRule($identity.User,'FullControl','ContainerInherit,ObjectInherit','None','Allow')
    $acl.AddAccessRule($rule)
    Set-Acl -LiteralPath $certificateDirectory -AclObject $acl
    $certificate = New-SelfSignedCertificate -DnsName 'localhost' -Subject 'CN=localhost' -FriendlyName $certificateLabel `
      -CertStoreLocation 'Cert:\CurrentUser\My' -Type SSLServerAuthentication -KeyAlgorithm RSA -KeyLength 3072 `
      -KeyExportPolicy Exportable -HashAlgorithm SHA256 -NotAfter (Get-Date).AddDays(30) `
      -TextExtension @('2.5.29.19={critical}{text}ca=FALSE')
    $passwordBytes = New-Object byte[] 32
    $generator = [Security.Cryptography.RandomNumberGenerator]::Create()
    try { $generator.GetBytes($passwordBytes) } finally { $generator.Dispose() }
    $password = ConvertTo-SecureString ([Convert]::ToBase64String($passwordBytes)) -AsPlainText -Force
    [Array]::Clear($passwordBytes,0,$passwordBytes.Length)
    $pfxPath = Join-Path $certificateDirectory 'localhost.pfx'
    $passwordPath = Join-Path $certificateDirectory 'localhost.passphrase.clixml'
    $publicPath = Join-Path $certificateDirectory 'localhost.cer'
    Export-PfxCertificate -Cert $certificate -FilePath $pfxPath -Password $password | Out-Null
    $password | Export-Clixml -LiteralPath $passwordPath
    Export-Certificate -Cert $certificate -FilePath $publicPath | Out-Null
    $metadata = [ordered]@{ Thumbprint=$certificate.Thumbprint; PublicCertificate=$publicPath; PfxPath=$pfxPath; PassphrasePath=$passwordPath; Expires=$certificate.NotAfter.ToUniversalTime().ToString('o') }
    $metadata | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $certificateDirectory 'metadata.json') -Encoding UTF8
    # Only public metadata. No private key, PFX content or passphrase is printed.
    $metadata | ConvertTo-Json
    Write-Output 'Certificate created but not trusted. Review its public thumbprint before a separate Trust action.'
    exit 0
  }
  if ($Thumbprint -notmatch '^[0-9A-Fa-f]{40}$') { throw 'Exact public certificate thumbprint required' }
  $stage = 'read public certificate metadata'
  $certificate = Get-Item -LiteralPath ('Cert:\CurrentUser\My\' + $Thumbprint)
  $names = @($certificate.DnsNameList | ForEach-Object { $_.Unicode })
  $basic = @($certificate.Extensions | Where-Object { $_.Oid.Value -eq '2.5.29.19' })
  $enhanced = @($certificate.EnhancedKeyUsageList | ForEach-Object { $_.ObjectId })
  $stage = 'validate localhost certificate policy'
  if ($certificate.FriendlyName -ne $certificateLabel -or $certificate.Subject -ne 'CN=localhost' -or
      $certificate.Issuer -ne $certificate.Subject -or -not $certificate.HasPrivateKey -or
      $names.Count -ne 1 -or $names[0] -ne 'localhost' -or $basic.Count -ne 1 -or $basic[0].CertificateAuthority -or
      $enhanced -notcontains '1.3.6.1.5.5.7.3.1' -or $certificate.NotAfter -le (Get-Date) -or
      $certificate.NotAfter -gt (Get-Date).AddDays(31)) { throw 'Unexpected development certificate' }
  if ($Action -eq 'Trust') {
    $store = New-Object Security.Cryptography.X509Certificates.X509Store('Root','CurrentUser')
    try {
      $stage = 'open current-user trust store'
      $store.Open([Security.Cryptography.X509Certificates.OpenFlags]::ReadWrite)
      $stage = 'add public localhost trust entry'
      $store.Add((New-Object Security.Cryptography.X509Certificates.X509Certificate2(,$certificate.RawData)))
    } finally { $store.Close() }
  }
  Write-Output ('Verified localhost-only, non-CA certificate: ' + $certificate.Thumbprint)
  Write-Output ('Current-user trust present: ' + (Test-Path -LiteralPath ('Cert:\CurrentUser\Root\' + $certificate.Thumbprint)))
} catch { Write-Error ('Development HTTPS certificate operation failed at '+$stage+' ('+$_.Exception.GetType().Name+', code '+$_.Exception.HResult+'); no credential details are emitted.'); exit 1 }
