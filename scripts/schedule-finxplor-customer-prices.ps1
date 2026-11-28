[CmdletBinding(SupportsShouldProcess)]
param()

$ErrorActionPreference = 'Stop'
$name = 'NukhbaPay Finxplor Customer Prices'
$project = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..')).Path
$launcher = Join-Path $PSScriptRoot 'setup-windows-catalogue.ps1'
$receipt = Get-Content -Raw -LiteralPath (Join-Path $project '.local\windows-catalogue-result.json') | ConvertFrom-Json
if ($receipt.status -cne 'verified' -or $receipt.backendReaderVerified -ne $true) {
  throw 'Complete the local catalogue database setup before scheduling the exchange-rate refresh.'
}
if ([TimeZoneInfo]::Local.Id -cne 'Arabian Standard Time') {
  throw 'Set this development host to Dubai time before registering the two daily exchange-rate cycles.'
}

$principal = New-ScheduledTaskPrincipal -UserId ([Security.Principal.WindowsIdentity]::GetCurrent().User.Value) -LogonType Interactive -RunLevel Limited
$action = New-ScheduledTaskAction -Execute (Join-Path $PSHOME 'powershell.exe') -WorkingDirectory $project `
  -Argument ('-NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy RemoteSigned -File "{0}" -RefreshFinxplorPrices' -f $launcher)
$triggers = @(
  New-ScheduledTaskTrigger -Daily -At ([datetime]::Today)
  New-ScheduledTaskTrigger -Daily -At ([datetime]::Today.AddHours(12))
)
$settings = New-ScheduledTaskSettingsSet -MultipleInstances IgnoreNew -ExecutionTimeLimit (New-TimeSpan -Minutes 8) `
  -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries
if ($PSCmdlet.ShouldProcess($name, 'Register customer-price refreshes at 00:00 and 12:00 Dubai time')) {
  Register-ScheduledTask -TaskName $name -Principal $principal -Action $action -Trigger $triggers -Settings $settings `
    -Description 'Refreshes local Finxplor customer-price conversions using one Currency API snapshot per currency per 12-hour cycle.' -Force | Out-Null
  Write-Host 'Finxplor exchange-rate refresh registered at 00:00 and 12:00 Dubai time.'
}
