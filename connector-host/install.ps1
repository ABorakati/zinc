<#
.SYNOPSIS
  Registers the "zotero-next host" as a Chrome native-messaging host for the current user.

.DESCRIPTION
  Chrome finds a native-messaging host through the registry:
    HKCU\Software\Google\Chrome\NativeMessagingHosts\com.zotero_next.connector_host
  whose default value is the path of a host-manifest JSON. This script
    1. checks that the compiled host exists (build it with `bun run build` in this folder),
    2. writes the host manifest (allowed_origins = the Zinc Connector extension id) to
       %LOCALAPPDATA%\zotero-next-connector-host\,
    3. creates the registry value above.
  It changes nothing else: no Chrome profile, no machine-wide key. Undo with uninstall.ps1.

.PARAMETER ExtensionId
  The extension id. The default is the id the fork's manifest "key" pins (zotero-next-connector/extension-id.txt),
  which is the same on every machine, so it normally needs no change.

.PARAMETER HostExe
  The compiled host. Defaults to dist\zotero-next-host.exe next to this script.

.PARAMETER ManifestDir
  Where the host manifest is written. Defaults to %LOCALAPPDATA%\zotero-next-connector-host. The Windows installer passes
  its own folder (<app>\connector), so the manifest lives and dies with the installed app.

.PARAMETER HostName
  The native-messaging host name (registry key name and the manifest's "name"). The extension asks for the default;
  the installer's test builds pass another one so they never overwrite a real registration.
#>
[CmdletBinding()]
param(
  [string]$ExtensionId = "pakgagonakcalfbmckaolkpidcojacaf",
  [string]$HostExe,
  [string]$ManifestDir,
  [string]$HostName = "com.zotero_next.connector_host"
)
$ErrorActionPreference = "Stop"
# Windows PowerShell 5.1 leaves $PSScriptRoot empty in parameter defaults, so resolve paths here
$here = if ($PSScriptRoot) { $PSScriptRoot } else { Split-Path -Parent $MyInvocation.MyCommand.Path }
if (-not $HostExe) { $HostExe = Join-Path $here "dist\zotero-next-host.exe" }
$localAppData = if ($env:LOCALAPPDATA) { $env:LOCALAPPDATA } else { [Environment]::GetFolderPath("LocalApplicationData") }

$hostName = $HostName
if ($hostName -notmatch '^[a-z0-9_]+(\.[a-z0-9_]+)+$') { throw "HostName must be lower-case dotted words (a-z, 0-9, _), as Chrome requires." }
if ($ExtensionId -notmatch '^[a-p]{32}$') { throw "ExtensionId must be 32 letters a-p (see chrome://extensions)." }
if (-not (Test-Path -LiteralPath $HostExe)) {
  throw "Host not found: $HostExe`nBuild it first:  cd '$here'; bun run build"
}
$HostExe = (Resolve-Path -LiteralPath $HostExe).Path

$dir = if ($ManifestDir) { $ManifestDir } else { Join-Path $localAppData "zotero-next-connector-host" }
New-Item -ItemType Directory -Force -Path $dir | Out-Null
$manifestPath = Join-Path $dir "$hostName.json"

$manifest = [ordered]@{
  name            = $hostName
  description     = "Zinc Connector host: saves from the browser extension into the Zinc library"
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
