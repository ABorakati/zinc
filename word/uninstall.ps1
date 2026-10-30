<#
.SYNOPSIS
  Removes the per-user registration made by install.ps1. Leaves your documents and your zotero-next library alone.
.DESCRIPTION
  -RemoveData also deletes %APPDATA%\ZoteroNextWord (settings) and %LOCALAPPDATA%\ZoteroNextWord (WebView2 profile,
  downloaded styles, log).
  -TestHive <file>  operate on a private registry hive file instead of the real HKCU (for testing the script).
#>
[CmdletBinding()]
param(
  [string]$AddinDir,
  [switch]$RemoveData,
  [string]$TestHive
)
$ErrorActionPreference = 'Stop'
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
if (-not $AddinDir) { $AddinDir = Join-Path $here 'dist\addin' }

if ($PSVersionTable.PSEdition -eq 'Core') {
  $args2 = @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', $MyInvocation.MyCommand.Path, '-AddinDir', $AddinDir)
  if ($RemoveData) { $args2 += '-RemoveData' }
  if ($TestHive) { $args2 += @('-TestHive', $TestHive) }
  & "$env:SystemRoot\System32\WindowsPowerShell\v1.0\powershell.exe" @args2
  exit $LASTEXITCODE
}

if (-not $TestHive -and (Get-Process WINWORD -ErrorAction SilentlyContinue)) { Write-Warning 'Word is running: close it so it releases the add-in.' }

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

$hiveHandle = [IntPtr]::Zero
if ($TestHive) {
  $TestHive = [IO.Path]::GetFullPath($TestHive)
  $rc = [ZnReg]::RegLoadAppKey($TestHive, [ref]$hiveHandle, 0xF003F, 0, 0)
  if ($rc -ne 0) { throw "RegLoadAppKey failed ($rc) for $TestHive" }
  $root = [Microsoft.Win32.RegistryKey]::FromHandle((New-Object Microsoft.Win32.SafeHandles.SafeRegistryHandle($hiveHandle, $false)))
} else {
  $root = [Microsoft.Win32.Registry]::CurrentUser
}

$dll = Join-Path ((Resolve-Path $AddinDir -ErrorAction SilentlyContinue).Path) 'ZoteroNextWord.dll'
$null = [AppDomain]::CurrentDomain.add_AssemblyResolve({
  param($s, $e)
  $p = Join-Path (Split-Path $dll) (($e.Name -split ',')[0] + '.dll')
  if (Test-Path $p) { return [Reflection.Assembly]::LoadFrom($p) }
  return $null
})

$root.DeleteSubKeyTree('Software\Microsoft\Office\Word\Addins\ZoteroNext.WordAddIn', $false)

$classes = $root.CreateSubKey('Software\Classes')
try {
  [void][ZnReg]::RegOverridePredefKey([ZnReg]::HKCR, $classes.Handle.DangerousGetHandle())
  try {
    if (Test-Path $dll) {
      $asm = [Reflection.Assembly]::LoadFrom($dll)
      $rs = New-Object System.Runtime.InteropServices.RegistrationServices
      [void]$rs.UnregisterAssembly($asm)
    }
  } finally {
    [void][ZnReg]::RegOverridePredefKey([ZnReg]::HKCR, [IntPtr]::Zero)
  }
} finally { $classes.Close() }
# belt and braces if the dll is gone: remove the ProgIds and (known) CLSIDs directly
foreach ($p in 'ZoteroNext.WordAddIn', 'ZoteroNext.WordPane') {
  $root.DeleteSubKeyTree("Software\Classes\$p", $false)
}
foreach ($g in '{D2A7E6B4-3C19-4F5E-9A08-71B6C4E2F853}', '{6F3B1C2A-8E64-4B8F-A3D2-5C7E91A0B4D1}') {
  $root.DeleteSubKeyTree("Software\Classes\CLSID\$g", $false)
}

if ($TestHive) {
  $left = @()
  foreach ($k in 'Software\Classes\ZoteroNext.WordAddIn', 'Software\Classes\ZoteroNext.WordPane', 'Software\Microsoft\Office\Word\Addins\ZoteroNext.WordAddIn',
                 'Software\Classes\CLSID\{D2A7E6B4-3C19-4F5E-9A08-71B6C4E2F853}', 'Software\Classes\CLSID\{6F3B1C2A-8E64-4B8F-A3D2-5C7E91A0B4D1}') {
    if ($root.OpenSubKey($k)) { $left += $k }
  }
  [void][ZnReg]::RegCloseKey($hiveHandle)
  if ($left.Count) { throw "left behind: $($left -join ', ')" }
  Write-Host 'TEST MODE: all keys removed from the private hive.'
}

if ($RemoveData) {
  foreach ($d in "$env:APPDATA\ZoteroNextWord", "$env:LOCALAPPDATA\ZoteroNextWord") { if (Test-Path $d) { Remove-Item -Recurse -Force $d } }
}
Write-Host 'Zotero Next Word add-in unregistered.'
