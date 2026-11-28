[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.IO.Compression.FileSystem
$backend = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$frontend = (Resolve-Path (Join-Path $backend '..\frontend')).Path
$archivePath = Join-Path $backend ('.local\staging-source-' + [guid]::NewGuid().ToString('N') + '.zip')
$archive = [IO.Compression.ZipFile]::Open($archivePath, 'Create')
try {
  foreach ($repository in @{backend=$backend;frontend=$frontend}.GetEnumerator()) {
    $files = @(git -C $repository.Value -c core.quotepath=false ls-files --cached --others --exclude-standard)
    if ($LASTEXITCODE -ne 0) { throw 'Unable to list staging source files.' }
    $include = if ($repository.Key -eq 'backend') {
      '^(apps/|packages/|scripts/|config/|infra/deployment/aws/Dockerfile$|\.dockerignore$|package\.json$|pnpm-lock\.yaml$|pnpm-workspace\.yaml$)'
    } else {
      '^(src/|public/|package(-lock)?\.json$|vite\.config\.ts$|tsconfig\.json$|(?:index|kiosk)\.html$)'
    }
    foreach ($relative in $files | Sort-Object -Unique) {
      if ($relative -notmatch $include) { continue }
      if ($relative -match '(^|/)(\.env(?:[./]|$)|\.local(?:/|$)|node_modules/|dist(?:-test|-kiosk)?/|secrets/|\.aws/)' -or
          $relative -match '\.(?:key|pfx|p12|clixml|dump|backup|pem|tfstate|log)$') { continue }
      $path = Join-Path $repository.Value $relative
      if (!(Test-Path -LiteralPath $path -PathType Leaf)) { continue }
      $file = Get-Item -LiteralPath $path -Force
      # OneDrive marks regular hydrated files as reparse points as well.
      if ($file.LinkType -or $file.Length -gt 20MB) {
        throw ('Unexpected link or oversized file in ' + $repository.Key+'/'+$relative)
      }
      [void][IO.Compression.ZipFileExtensions]::CreateEntryFromFile(
        $archive,$file.FullName,($repository.Key+'/'+$relative),[IO.Compression.CompressionLevel]::Optimal)
    }
  }
} finally {
  $archive.Dispose()
}
$archivePath
