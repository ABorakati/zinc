<#
.SYNOPSIS
  Per-user install of the Zinc Word add-in (no admin rights).

.DESCRIPTION
  Registers the add-in's two COM classes under HKCU\Software\Classes (what regasm /codebase would do under HKLM)
  and the add-in itself under HKCU\Software\Microsoft\Office\Word\Addins\ZoteroNext.WordAddIn (LoadBehavior 3 =
  load at startup). Nothing else is touched: no Word settings, templates, startup folder or machine-wide keys.
  Close Word before installing. Build first with build.ps1.

  -TestHive <file>  register into a private registry hive file (RegLoadAppKey) instead of the real HKCU. For testing
                    the script itself; the hive is not visible to any program and the real registry is untouched.
#>
[CmdletBinding()]
param(
  [string]$AddinDir,
  [string]$TestHive
)
$ErrorActionPreference = 'Stop'
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
if (-not $AddinDir) { $AddinDir = Join-Path $here 'dist\addin' }

# The CLR's RegistrationServices only exists in .NET Framework: run under Windows PowerShell 5.1.
if ($PSVersionTable.PSEdition -eq 'Core') {
  $args2 = @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', $MyInvocation.MyCommand.Path, '-AddinDir', $AddinDir)
  if ($TestHive) { $args2 += @('-TestHive', $TestHive) }
  & "$env:SystemRoot\System32\WindowsPowerShell\v1.0\powershell.exe" @args2
  exit $LASTEXITCODE
}

$AddinDir = (Resolve-Path $AddinDir).Path
$dll = Join-Path $AddinDir 'ZoteroNextWord.dll'
if (-not (Test-Path $dll)) { throw "ZoteroNextWord.dll not found in $AddinDir. Run build.ps1 first." }
if (-not (Test-Path (Join-Path $AddinDir 'sidebar\index.html'))) { throw "sidebar\index.html not found in $AddinDir. Run build.ps1 first." }
if (-not $TestHive -and (Get-Process WINWORD -ErrorAction SilentlyContinue)) {
  Write-Warning 'Word is running. Close it and run this again (Word reads add-in registrations at startup).'
}

Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class ZnReg {
  [DllImport("advapi32.dll", CharSet = CharSet.Unicode)] public static extern int RegOverridePredefKey(IntPtr hKey, IntPtr hNew);
  [DllImport("advapi32.dll", CharSet = CharSet.Unicode)] public static extern int RegLoadAppKey(string file, out IntPtr key, int sam, int options, int reserved);
  [DllImport("advapi32.dll")] public static extern int RegCloseKey(IntPtr key);
  public static readonly IntPtr HKCR = new IntPtr(unchecked((int)0x80000000));
}
'@

$progIdAddin = 'ZoteroNext.WordAddIn'
$hiveHandle = [IntPtr]::Zero
if ($TestHive) {
  $TestHive = [IO.Path]::GetFullPath($TestHive)
  $rc = [ZnReg]::RegLoadAppKey($TestHive, [ref]$hiveHandle, 0xF003F, 0, 0)
  if ($rc -ne 0) { throw "RegLoadAppKey failed ($rc) for $TestHive" }
  $safe = New-Object Microsoft.Win32.SafeHandles.SafeRegistryHandle($hiveHandle, $false)
  $root = [Microsoft.Win32.RegistryKey]::FromHandle($safe)
  Write-Host "TEST MODE: registering into private hive $TestHive (the real registry is not touched)"
} else {
  $root = [Microsoft.Win32.Registry]::CurrentUser
}

# Dependencies (WebView2) live next to the add-in: resolve them from there while registering.
$null = [AppDomain]::CurrentDomain.add_AssemblyResolve({
  param($s, $e)
  $p = Join-Path $AddinDir (($e.Name -split ',')[0] + '.dll')
  if (Test-Path $p) { return [Reflection.Assembly]::LoadFrom($p) }
  return $null
})

$classes = $root.CreateSubKey('Software\Classes')
try {
  # HKEY_CLASSES_ROOT writes made by the CLR's registration code now land in HKCU\Software\Classes
  $rc = [ZnReg]::RegOverridePredefKey([ZnReg]::HKCR, $classes.Handle.DangerousGetHandle())
  if ($rc -ne 0) { throw "RegOverridePredefKey failed ($rc)" }
  try {
    $asm = [Reflection.Assembly]::LoadFrom($dll)
    $rs = New-Object System.Runtime.InteropServices.RegistrationServices
    $ok = $rs.RegisterAssembly($asm, [System.Runtime.InteropServices.AssemblyRegistrationFlags]::SetCodeBase)
    if (-not $ok) { throw 'RegisterAssembly registered no types' }
  } finally {
    [void][ZnReg]::RegOverridePredefKey([ZnReg]::HKCR, [IntPtr]::Zero)
  }

  # the add-in registration Word looks at
  $key = $root.CreateSubKey("Software\Microsoft\Office\Word\Addins\$progIdAddin")
  $key.SetValue('FriendlyName', 'Zinc', 'String')
  $key.SetValue('Description', 'Citations from your Zinc library, in a sidebar', 'String')
  $key.SetValue('LoadBehavior', 3, 'DWord')
  $key.Close()

  # "Open in Zinc": the installed app sits two folders above the add-in ({app}\word\addin). Register its exe so the add-in can start
  # it with Zinc closed, wherever the install folder is. A dev checkout has no such exe: nothing is written and the add-in probes
  # the default install folders instead.
  $appExe = [IO.Path]::GetFullPath((Join-Path $AddinDir '..\..\zotero-next-gpui.exe'))
  if (Test-Path -LiteralPath $appExe) {
    $zk = $root.CreateSubKey('Software\ZoteroNextWord')
    $zk.SetValue('Launcher', $appExe, 'String')
    $zk.Close()
  }
} finally {
  $classes.Close()
}

# Hosting check: the pane is a WinForms control shown through Word's ActiveX task pane host.
$ctl = $root.OpenSubKey('Software\Classes\ZoteroNext.WordPane\CLSID')
$clsid = if ($ctl) { $ctl.GetValue('') } else { $null }
$summary = [ordered]@{
  AddIn      = ($root.OpenSubKey("Software\Microsoft\Office\Word\Addins\$progIdAddin") -ne $null)
  AddInClass = ($root.OpenSubKey('Software\Classes\ZoteroNext.WordAddIn\CLSID') -ne $null)
  PaneClass  = ($ctl -ne $null)
  PaneIsControl = $(if ($clsid) { ($root.OpenSubKey("Software\Classes\CLSID\$clsid\Control") -ne $null) } else { $false })
}
if ($TestHive) {
  $summary | Format-Table -AutoSize | Out-String | Write-Host
  [void][ZnReg]::RegCloseKey($hiveHandle)
}
if (-not ($summary.AddIn -and $summary.AddInClass -and $summary.PaneClass -and $summary.PaneIsControl)) {
  throw "Registration incomplete: $($summary | ConvertTo-Json -Compress)"
}

# WebView2 runtime (Evergreen) is needed for the sidebar; it ships with Microsoft 365 / Edge on Windows 11.
$wv = @(
  'HKLM:\SOFTWARE\WOW6432Node\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}',
  'HKLM:\SOFTWARE\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}',
  'HKCU:\Software\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}'
) | Where-Object { Test-Path $_ }
if (-not $wv) { Write-Warning 'WebView2 runtime not found. Install it from https://developer.microsoft.com/microsoft-edge/webview2/ (Evergreen runtime).' }

Write-Host "Installed for $env:USERNAME. Start Word: a 'Zinc' tab appears in the ribbon (Sidebar button)."
Write-Host "If Word does not show it: File > Options > Add-ins > Manage: COM Add-ins > Go..., and tick 'Zinc'."
Write-Host "Log: $env:LOCALAPPDATA\ZoteroNextWord\addin.log"
