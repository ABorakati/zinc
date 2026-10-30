<#
.SYNOPSIS
  Removes what install.ps1 created: the Chrome registry value and the host manifest. The compiled host and the
  extension are left alone (remove the extension in chrome://extensions).
#>
[CmdletBinding()]
param()
$ErrorActionPreference = "Stop"

$hostName = "com.zotero_next.connector_host"
$key = "HKCU:\Software\Google\Chrome\NativeMessagingHosts\$hostName"
if (Test-Path $key) {
  Remove-Item -Path $key -Recurse -Force
  Write-Host "Removed $key"
} else {
  Write-Host "No registry key at $key"
}

$dir = Join-Path $env:LOCALAPPDATA "zotero-next-connector-host"
if (Test-Path -LiteralPath $dir) {
  Remove-Item -LiteralPath $dir -Recurse -Force
  Write-Host "Removed $dir"
}
