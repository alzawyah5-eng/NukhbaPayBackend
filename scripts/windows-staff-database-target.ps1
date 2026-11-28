function Read-WindowsStaffDatabaseTarget([string]$Project) {
  $state = Join-Path $Project '.local'
  $inspection = Get-Content -Raw -LiteralPath (Join-Path $state 'windows-staff-inspection.json') | ConvertFrom-Json
  if ($inspection.targetVerified -ne $true -or $inspection.databaseOid -notmatch '^[1-9]\d{0,9}$' -or
      $inspection.systemIdentifier -notmatch '^[1-9]\d{15,19}$') {
    throw 'Refresh the Windows staff database inspection before starting the portal.'
  }
  $target = @{
    Inspection = $inspection
    Database = 'nukhbapay_staff'
    Oid = $inspection.databaseOid
    CatalogueSetupId = $null
  }
  $receipt = Join-Path $state 'windows-staff-catalogue-cutover.json'
  if (Test-Path -LiteralPath $receipt) {
    $file = Get-Item -LiteralPath $receipt
    if ($file.PSIsContainer -or ($file.Attributes -band [IO.FileAttributes]::ReparsePoint) -or $file.Length -gt 2048) {
      throw 'Invalid local staff consolidation receipt.'
    }
    $cutover = Get-Content -LiteralPath $receipt -Raw | ConvertFrom-Json
    if ($cutover.version -ne 1 -or $cutover.status -cne 'verified' -or
        $cutover.sourceOid -cne $inspection.databaseOid -or $cutover.systemIdentifier -cne $inspection.systemIdentifier -or
        $cutover.catalogueOid -notmatch '^[1-9]\d{0,9}$' -or $cutover.catalogueOid -ceq $cutover.sourceOid -or
        $cutover.catalogueSetupId -cnotmatch '^[0-9a-f]{32}$') {
      throw 'The local staff consolidation receipt does not match the inspected Windows cluster.'
    }
    $target.Database = 'nukhbapay_catalogue'
    $target.Oid = $cutover.catalogueOid
    $target.CatalogueSetupId = $cutover.catalogueSetupId
  }
  return $target
}
