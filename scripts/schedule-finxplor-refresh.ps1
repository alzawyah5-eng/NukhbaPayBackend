[CmdletBinding(SupportsShouldProcess)]
param()

$ErrorActionPreference = 'Stop'
$name = 'NukhbaPay Finxplor Catalogue Refresh'
$project = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..')).Path
$importer = Join-Path $PSScriptRoot 'setup-windows-catalogue.ps1'
$receipt = Get-Content -Raw -LiteralPath (Join-Path $project '.local\windows-catalogue-result.json') | ConvertFrom-Json
if ($receipt.status -cne 'verified' -or $receipt.backendReaderVerified -ne $true) {
  throw 'Complete the local catalogue database setup before scheduling refreshes.'
}

$principal = New-ScheduledTaskPrincipal -UserId ([Security.Principal.WindowsIdentity]::GetCurrent().User.Value) -LogonType Interactive -RunLevel Limited
$action = New-ScheduledTaskAction -Execute (Join-Path $PSHOME 'powershell.exe') -WorkingDirectory $project `
  -Argument ('-NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy RemoteSigned -File "{0}" -ImportFinxplor -Full' -f $importer)
$triggers = @(
  New-ScheduledTaskTrigger -Daily -At ([datetime]::Today.AddHours(8))
  New-ScheduledTaskTrigger -Daily -At ([datetime]::Today.AddHours(20))
)
$settings = New-ScheduledTaskSettingsSet -MultipleInstances IgnoreNew -ExecutionTimeLimit (New-TimeSpan -Minutes 4) `
  -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries
if ($PSCmdlet.ShouldProcess($name, 'Register daily sandbox catalogue reads at 08:00 and 20:00 local time')) {
  Register-ScheduledTask -TaskName $name -Principal $principal -Action $action -Trigger $triggers -Settings $settings `
    -Description 'Finxplor sandbox catalogue observations only. Uses the verified local development database.' | Out-Null
  Write-Host ('Finxplor refresh registered at 08:00 and 20:00 ({0}).' -f [TimeZoneInfo]::Local.Id)
}
