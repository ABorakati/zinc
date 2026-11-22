<#
.SYNOPSIS  Build the LibreOffice extension: libreoffice\dist\zinc-libreoffice.oxt (install with Tools > Extensions, or unopkg add).
           It holds the UNO components (extension\), the pane process (pane\, .NET Framework 4.8, Windows x64) and the
           SAME sidebar bundle the Word add-in shows (word\sidebar, built with Bun).
.EXAMPLE   pwsh libreoffice\build.ps1
#>
$ErrorActionPreference = 'Stop'
Set-Location $PSScriptRoot
$dist = Join-Path $PSScriptRoot 'dist'
$stage = Join-Path $dist 'oxt'
New-Item -ItemType Directory -Force $dist | Out-Null
if (Test-Path $stage) { Remove-Item -Recurse -Force $stage }

# the pane process (and the Word add-in assembly it reuses for lib.* / style.* / settings.*)
dotnet build pane\ZincLibreOfficePane.csproj -c Release -nologo -v q
if ($LASTEXITCODE) { throw 'pane build failed' }

# the sidebar bundle, built into a scratch folder (word\dist is left alone)
$sidebarOut = Join-Path $dist 'sidebar-build'
$env:ZN_WORD_DIST = $sidebarOut
Push-Location ..\word\sidebar
bun build.ts
$rc = $LASTEXITCODE
Pop-Location
Remove-Item Env:\ZN_WORD_DIST
if ($rc) { throw 'sidebar build failed' }

# stage: extension files, pane\ (exe + dlls + sidebar\), icons\
New-Item -ItemType Directory -Force $stage | Out-Null
Copy-Item -Recurse extension\* $stage -Force
Get-ChildItem $stage -Recurse -Directory -Filter '__pycache__' | Remove-Item -Recurse -Force
$paneOut = Join-Path $stage 'pane'
New-Item -ItemType Directory -Force $paneOut | Out-Null
Get-ChildItem (Join-Path $dist 'pane') -File | Where-Object { $_.Name -notmatch '\.Wpf\.dll$' } | Copy-Item -Destination $paneOut
Copy-Item -Recurse (Join-Path $sidebarOut 'addin\sidebar') (Join-Path $paneOut 'sidebar')

# icons: the app icon scaled to the sidebar tab (24 px) and the extension manager (42 px)
Add-Type -AssemblyName System.Drawing
$icons = Join-Path $stage 'icons'
New-Item -ItemType Directory -Force $icons | Out-Null
$src = [System.Drawing.Image]::FromFile((Resolve-Path '..\gpui-ui\assets\icon.png'))
foreach ($n in 24, 42) {
  $bmp = New-Object System.Drawing.Bitmap $n, $n
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
  $g.DrawImage($src, 0, 0, $n, $n)
  $g.Dispose()
  $bmp.Save((Join-Path $icons "zinc-$n.png"), [System.Drawing.Imaging.ImageFormat]::Png)
  $bmp.Dispose()
}
$src.Dispose()

# zip (an .oxt is a zip with META-INF\manifest.xml)
$oxt = Join-Path $dist 'zinc-libreoffice.oxt'
if (Test-Path $oxt) { Remove-Item $oxt }
Add-Type -AssemblyName System.IO.Compression.FileSystem
[System.IO.Compression.ZipFile]::CreateFromDirectory($stage, $oxt, [System.IO.Compression.CompressionLevel]::Optimal, $false)
Write-Host "Built: $oxt ($([math]::Round((Get-Item $oxt).Length / 1MB, 1)) MB)"
