<#
.SYNOPSIS
  Removes what install.ps1 created: the Chrome and Edge registry values and the host manifest. The compiled host and
  the extension are left alone (remove the extension in chrome://extensions or edge://extensions).
#>
[CmdletBinding()]
param()
$ErrorActionPreference = "Stop"

$hostName = "com.zotero_next.connector_host"
foreach ($browser in "Google\Chrome", "Microsoft\Edge") {
  $key = "HKCU:\Software\$browser\NativeMessagingHosts\$hostName"
  if (Test-Path $key) {
    Remove-Item -Path $key -Recurse -Force
    Write-Host "Removed $key"
  } else {
    Write-Host "No registry key at $key"
  }
}

$localAppData = if ($env:LOCALAPPDATA) { $env:LOCALAPPDATA } else { [Environment]::GetFolderPath("LocalApplicationData") }
$dir = Join-Path $localAppData "zotero-next-connector-host"
if (Test-Path -LiteralPath $dir) {
  Remove-Item -LiteralPath $dir -Recurse -Force
  Write-Host "Removed $dir"
}
