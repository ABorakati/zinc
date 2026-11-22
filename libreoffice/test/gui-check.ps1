<#
.SYNOPSIS  The extension inside a real, windowed LibreOffice, WITHOUT using the visible screen: LibreOffice runs on a separate,
           never-shown Windows desktop (CreateDesktop), with the .oxt installed into a throwaway profile, a synthetic library
           and scratch settings. gui_drive.py opens a document and the Zinc deck; the pane logs where its window went and
           saves a picture of the page; this script also captures the whole LibreOffice window (PrintWindow).
.EXAMPLE   pwsh libreoffice/test/gui-check.ps1 -Program "<LibreOffice>\program" -Out C:\scratch\gui
#>
param([Parameter(Mandatory)][string]$Program, [Parameter(Mandatory)][string]$Out)
$ErrorActionPreference = 'Stop'
$here = $PSScriptRoot
$oxt = Join-Path $here '..\dist\zinc-libreoffice.oxt'
if (-not (Test-Path $oxt)) { throw 'build the extension first: pwsh libreoffice/build.ps1' }
if (Test-Path $Out) { Remove-Item -Recurse -Force $Out }
New-Item -ItemType Directory -Force $Out | Out-Null
$Out = (Resolve-Path $Out).Path
$profile = Join-Path $Out 'profile'
$logdir = Join-Path $Out 'logs'
New-Item -ItemType Directory -Force (Join-Path $profile 'user'), $logdir | Out-Null

# a fresh profile without the first-start dialogs (a modal dialog on an invisible desktop would wait forever)
@'
<?xml version="1.0" encoding="UTF-8"?>
<oor:items xmlns:oor="http://openoffice.org/2001/registry" xmlns:xs="http://www.w3.org/2001/XMLSchema" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
<item oor:path="/org.openoffice.Office.Common/Misc"><prop oor:name="ShowTipOfTheDay" oor:op="fuse"><value>false</value></prop></item>
<item oor:path="/org.openoffice.Office.Common/Misc"><prop oor:name="FirstRun" oor:op="fuse"><value>false</value></prop></item>
<item oor:path="/org.openoffice.Office.Common/Misc"><prop oor:name="ShowDonation" oor:op="fuse"><value>false</value></prop></item>
</oor:items>
'@ | Set-Content -Encoding utf8 (Join-Path $profile 'user\registrymodifications.xcu')
$profileUrl = ([Uri]$profile).AbsoluteUri

& (Join-Path $Program 'unopkg.com') add --suppress-license "-env:UserInstallation=$profileUrl" $oxt
if ($LASTEXITCODE) { throw 'unopkg add failed' }

$db = Join-Path $Out 'library.sqlite'
bun (Join-Path $here 'make-library.ts') $db
if ($LASTEXITCODE) { throw 'library build failed' }
$cache = Join-Path $logdir 'pane-cache'
New-Item -ItemType Directory -Force (Join-Path $cache 'styles'), (Join-Path $cache 'locales') | Out-Null
$fix = Join-Path $here '..\..\core\test\cite\fixtures'
Copy-Item (Join-Path $fix 'vancouver.csl') (Join-Path $cache 'styles')
Copy-Item (Join-Path $fix 'locales-en-US.xml') (Join-Path $cache 'locales')
'{"style":"vancouver"}' | Set-Content -Encoding utf8 (Join-Path $Out 'settings.json')

# inherited by soffice, and from it by the pane: never the user's library, settings or caches
$env:ZN_DB = $db
$env:ZN_LO_PANE_SETTINGS = Join-Path $Out 'settings.json'
$env:ZN_LO_PANE_CACHE = $cache
$env:ZN_LO_PANE_SHOT = Join-Path $Out 'page.png'
$env:ZN_LO_LOG_DIR = $logdir
# the page clicks its first search result (cites it at the cursor), as a user would
$env:ZN_LO_PANE_EVAL = "document.querySelector('#results li')?.click()"

$refs = @('System.Drawing.Common', 'System.Drawing.Primitives', 'System.Threading.Thread', 'System.Threading', 'System.Runtime.InteropServices', 'System.Runtime')
if ($PSVersionTable.PSVersion.Major -ge 7) { $refs += @('System.Private.Windows.Core', 'System.Private.Windows.GdiPlus') | Where-Object { [AppDomain]::CurrentDomain.GetAssemblies().Name -contains $_ -or (Test-Path (Join-Path ([Runtime.InteropServices.RuntimeEnvironment]::GetRuntimeDirectory()) "$_.dll")) -or (Test-Path (Join-Path $PSHOME "$_.dll")) } }
Add-Type -ReferencedAssemblies $refs -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class HiddenDesktop
{
    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    struct STARTUPINFO { public int cb; public string lpReserved; public string lpDesktop; public string lpTitle; public int dwX, dwY, dwXSize, dwYSize, dwXCountChars, dwYCountChars, dwFillAttribute, dwFlags; public short wShowWindow, cbReserved2; public IntPtr lpReserved2, hStdInput, hStdOutput, hStdError; }
    [StructLayout(LayoutKind.Sequential)]
    struct PROCESS_INFORMATION { public IntPtr hProcess, hThread; public int dwProcessId, dwThreadId; }
    [DllImport("user32.dll", SetLastError = true, CharSet = CharSet.Unicode)] static extern IntPtr CreateDesktop(string name, IntPtr dev, IntPtr dm, int flags, uint access, IntPtr sa);
    [DllImport("user32.dll")] static extern bool CloseDesktop(IntPtr h);
    [DllImport("user32.dll")] static extern bool SetThreadDesktop(IntPtr h);
    [DllImport("user32.dll")] static extern bool PrintWindow(IntPtr hwnd, IntPtr hdc, uint flags);
    [DllImport("user32.dll")] static extern bool GetWindowRect(IntPtr hwnd, out RECT r);
    [DllImport("user32.dll")] static extern IntPtr SetThreadDpiAwarenessContext(IntPtr ctx);
    [StructLayout(LayoutKind.Sequential)] struct RECT { public int L, T, R, B; }
    [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
    static extern bool CreateProcess(string app, string cmd, IntPtr pa, IntPtr ta, bool inherit, uint flags, IntPtr env, string cwd, ref STARTUPINFO si, out PROCESS_INFORMATION pi);
    public static IntPtr Desk;
    public static string Name;
    public static void Create(string name) { Name = name; Desk = CreateDesktop(name, IntPtr.Zero, IntPtr.Zero, 0, 0x10000000, IntPtr.Zero); if (Desk == IntPtr.Zero) throw new Exception("CreateDesktop failed " + Marshal.GetLastWin32Error()); }
    public static int Start(string cmdLine)
    {
        var si = new STARTUPINFO(); si.cb = Marshal.SizeOf(si); si.lpDesktop = "WinSta0\\" + Name;
        PROCESS_INFORMATION pi;
        if (!CreateProcess(null, cmdLine, IntPtr.Zero, IntPtr.Zero, false, 0, IntPtr.Zero, null, ref si, out pi)) throw new Exception("CreateProcess failed " + Marshal.GetLastWin32Error());
        return pi.dwProcessId;
    }
    /// <summary>PrintWindow from a thread that sits on the hidden desktop (PW_RENDERFULLCONTENT).</summary>
    public static string Capture(IntPtr hwnd, string path)
    {
        string err = null;
        var t = new System.Threading.Thread(() =>
        {
            try
            {
                if (!SetThreadDesktop(Desk)) { err = "SetThreadDesktop failed"; return; }
                SetThreadDpiAwarenessContext(new IntPtr(-4));   // real pixels: PrintWindow draws them, GetWindowRect must count them
                RECT r; GetWindowRect(hwnd, out r);
                int w = Math.Max(1, r.R - r.L), h = Math.Max(1, r.B - r.T);
                using (var bmp = new System.Drawing.Bitmap(w, h))
                {
                    using (var g = System.Drawing.Graphics.FromImage(bmp))
                    {
                        var hdc = g.GetHdc();
                        bool ok = PrintWindow(hwnd, hdc, 2);
                        g.ReleaseHdc(hdc);
                        if (!ok) err = "PrintWindow failed";
                    }
                    bmp.Save(path, System.Drawing.Imaging.ImageFormat.Png);
                }
            }
            catch (Exception e) { err = e.Message; }
        });
        t.Start(); t.Join();
        return err ?? ("saved " + path);
    }
    public static void Close() { if (Desk != IntPtr.Zero) CloseDesktop(Desk); Desk = IntPtr.Zero; }
}
'@

$pipe = "zinc_gui_$PID"
[HiddenDesktop]::Create("ZincGuiCheck$PID")
$soffice = Join-Path $Program 'soffice.exe'
$sofficePid = [HiddenDesktop]::Start("`"$soffice`" -env:UserInstallation=$profileUrl --norestore --nologo --nolockcheck `"--accept=pipe,name=$pipe;urp;StarOffice.ComponentContext`"")
Write-Host "soffice started on the hidden desktop, pid $sofficePid"
try {
    $psi = [Diagnostics.ProcessStartInfo]::new((Join-Path $Program 'python.exe'))
    $psi.ArgumentList.Add((Join-Path $here 'gui_drive.py')); $psi.ArgumentList.Add($pipe); $psi.ArgumentList.Add($logdir); $psi.ArgumentList.Add($env:ZN_LO_PANE_SHOT)
    $psi.RedirectStandardInput = $true; $psi.RedirectStandardOutput = $true; $psi.UseShellExecute = $false
    $drv = [Diagnostics.Process]::Start($psi)
    $line = $drv.StandardOutput.ReadLine()
    $line | Set-Content -Encoding utf8 (Join-Path $Out 'result.json')
    $r = $line | ConvertFrom-Json
    if ($r.frameHwnd) { Write-Host ([HiddenDesktop]::Capture([IntPtr]$r.frameHwnd, (Join-Path $Out 'libreoffice.png'))) }
    $drv.StandardInput.WriteLine('quit')
    if (-not $drv.WaitForExit(30000)) { $drv.Kill() }
    $line
}
finally {
    Start-Sleep -Seconds 2
    Get-Process -Id $sofficePid -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
    Get-Process soffice.bin -ErrorAction SilentlyContinue | Where-Object { $_.Path -like "$Program*" } | Stop-Process -Force -ErrorAction SilentlyContinue
    Get-Process ZincLibreOfficePane -ErrorAction SilentlyContinue | Where-Object { $_.Path -like "$profile*" } | Stop-Process -Force -ErrorAction SilentlyContinue
    [HiddenDesktop]::Close()
}
