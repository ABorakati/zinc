<#
.SYNOPSIS
  Registers the "zotero-next host" as a Chrome native-messaging host for the current user.

.DESCRIPTION
  Chrome finds a native-messaging host through the registry:
    HKCU\Software\Google\Chrome\NativeMessagingHosts\com.zotero_next.connector_host
  whose default value is the path of a host-manifest JSON. This script
    1. checks that the compiled host exists (build it with `bun run build` in this folder),
    2. writes the host manifest (allowed_origins = the Zotero Next Connector extension id) to
       %LOCALAPPDATA%\zotero-next-connector-host\,
    3. creates the registry value above.
  It changes nothing else: no Chrome profile, no machine-wide key. Undo with uninstall.ps1.

.PARAMETER ExtensionId
  The extension id. The default is the id the fork's manifest "key" pins (zotero-next-connector/extension-id.txt),
  which is the same on every machine, so it normally needs no change.

.PARAMETER HostExe
  The compiled host. Defaults to dist\zotero-next-host.exe next to this script.
#>
[CmdletBinding()]
param(
  [string]$ExtensionId = "pakgagonakcalfbmckaolkpidcojacaf",
  [string]$HostExe
)
$ErrorActionPreference = "Stop"
# Windows PowerShell 5.1 leaves $PSScriptRoot empty in parameter defaults, so resolve paths here
$here = if ($PSScriptRoot) { $PSScriptRoot } else { Split-Path -Parent $MyInvocation.MyCommand.Path }
if (-not $HostExe) { $HostExe = Join-Path $here "dist\zotero-next-host.exe" }
$localAppData = if ($env:LOCALAPPDATA) { $env:LOCALAPPDATA } else { [Environment]::GetFolderPath("LocalApplicationData") }

$hostName = "com.zotero_next.connector_host"
if ($ExtensionId -notmatch '^[a-p]{32}$') { throw "ExtensionId must be 32 letters a-p (see chrome://extensions)." }
if (-not (Test-Path -LiteralPath $HostExe)) {
  throw "Host not found: $HostExe`nBuild it first:  cd '$here'; bun run build"
}
$HostExe = (Resolve-Path -LiteralPath $HostExe).Path

$dir = Join-Path $localAppData "zotero-next-connector-host"
New-Item -ItemType Directory -Force -Path $dir | Out-Null
$manifestPath = Join-Path $dir "$hostName.json"

$manifest = [ordered]@{
  name            = $hostName
  description     = "Zotero Next Connector host: saves from the browser extension into the zotero-next library"
  path            = $HostExe
  type            = "stdio"
  allowed_origins = @("chrome-extension://$ExtensionId/")
}
# Chrome reads the file as UTF-8 without a BOM.
[System.IO.File]::WriteAllText($manifestPath, ($manifest | ConvertTo-Json), (New-Object System.Text.UTF8Encoding($false)))

# Chrome and Edge (also Chromium) each look under their own key; the same manifest and extension id serve both.
foreach ($browser in "Google\Chrome", "Microsoft\Edge") {
  $key = "HKCU:\Software\$browser\NativeMessagingHosts\$hostName"
  New-Item -Path $key -Force | Out-Null
  Set-ItemProperty -Path $key -Name "(default)" -Value $manifestPath
}

Write-Host "Registered native messaging host '$hostName' for Chrome and Edge"
Write-Host "  manifest : $manifestPath"
Write-Host "  host exe : $HostExe"
Write-Host "  allowed  : chrome-extension://$ExtensionId/"
Write-Host ""
Write-Host "Next: chrome://extensions or edge://extensions -> Developer mode -> Load unpacked -> zotero-next-connector\build\manifestv3"
