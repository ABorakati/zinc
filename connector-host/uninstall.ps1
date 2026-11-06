<#
.SYNOPSIS
  Removes what install.ps1 created: the Chrome and Edge registry values and the host manifest. The compiled host and
  the extension are left alone (remove the extension in chrome://extensions or edge://extensions).
#>
[CmdletBinding()]
param(
  # Match what was given to install.ps1. With -ManifestDir only the manifest file is removed (the folder belongs to the installer).
  [string]$ManifestDir,
  [string]$HostName = "com.zotero_next.connector_host"
)
$ErrorActionPreference = "Stop"

$hostName = $HostName
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
if ($ManifestDir) {
  $manifest = Join-Path $ManifestDir "$hostName.json"
  if (Test-Path -LiteralPath $manifest) {
    Remove-Item -LiteralPath $manifest -Force
    Write-Host "Removed $manifest"
  }
} else {
  $dir = Join-Path $localAppData "zotero-next-connector-host"
  if (Test-Path -LiteralPath $dir) {
    Remove-Item -LiteralPath $dir -Recurse -Force
    Write-Host "Removed $dir"
  }
}
