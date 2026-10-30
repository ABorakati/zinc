# Build zotero-next and deploy it as a portable copy, instead of running the installer.
#   pwsh -NoProfile -File app\portable.ps1            # build (stable) + deploy
#   pwsh -NoProfile -File app\portable.ps1 -NoBuild   # deploy the last build
# Each deploy unpacks into its own folder, %LOCALAPPDATA%\ZoteroNext\versions\<yyyyMMdd-HHmmss>\, and points the
# Start menu (and desktop) shortcuts at it, so the running app is never overwritten: close and reopen it to get the
# new version. Old versions are removed once nothing runs from them (the newest two are kept).
#   -NoShortcuts: unpack only (tests)
param([switch]$NoBuild, [switch]$NoShortcuts, [string]$Root = "$env:LOCALAPPDATA\ZoteroNext")
$ErrorActionPreference = "Stop"
$app = $PSScriptRoot
$env:PATH = "C:\Windows\System32;C:\Users\abora\.hutch\bin;" + $env:PATH # Hutch needs Windows' tar, not Git's

if (-not $NoBuild) {
	Push-Location $app
	try { hutch electrobun build --env=stable 2>&1 | Select-Object -Last 2 | Write-Host } finally { Pop-Location }
	if ($LASTEXITCODE) { throw "build failed" }
}
$archive = Join-Path $app "build\stable-win-x64\zotero-next-Setup.tar.zst"
if (-not (Test-Path $archive)) { throw "no build found at $archive" }

# 1. unpack into a new version folder
$version = Get-Date -Format "yyyyMMdd-HHmmss"
$dest = Join-Path $Root "versions\$version"
New-Item -ItemType Directory -Force $dest | Out-Null
& C:\Windows\System32\tar.exe -xf $archive -C $dest
if ($LASTEXITCODE) { throw "unpacking failed" }
$exe = Join-Path $dest "zotero-next\bin\launcher.exe"
if (-not (Test-Path $exe)) { throw "launcher.exe missing after unpacking" }
Write-Host "deployed $version -> $exe"

# 2. shortcuts: Start menu "Zotero Next", plus every shortcut (Start menu, desktop, taskbar pins) that still opens the
#    installed copy or an older portable version
$shell = New-Object -ComObject WScript.Shell
$links = @((Join-Path ([Environment]::GetFolderPath("Programs")) "Zotero Next.lnk"))
$installed = "$env:LOCALAPPDATA\dev.zotero-next.app\*\launcher.exe"
$folders = @([Environment]::GetFolderPath("Programs"), [Environment]::GetFolderPath("Desktop"), "$env:APPDATA\Microsoft\Internet Explorer\Quick Launch\User Pinned\TaskBar")
foreach ($f in $folders) {
	if (-not (Test-Path $f)) { continue }
	foreach ($l in Get-ChildItem $f -Filter *.lnk -Recurse -ErrorAction SilentlyContinue) {
		$t = $shell.CreateShortcut($l.FullName).TargetPath
		if (($t -like $installed -or $t -like "$Root\versions\*\launcher.exe") -and $links -notcontains $l.FullName) { $links += $l.FullName }
	}
}
if ($NoShortcuts) { $links = @() }
foreach ($l in $links) {
	$s = $shell.CreateShortcut($l)
	$s.TargetPath = $exe; $s.WorkingDirectory = Split-Path $exe; $s.IconLocation = "$exe,0"; $s.Description = "Zotero Next ($version)"
	$s.Save()
	Write-Host "shortcut -> $l"
}

# 3. remove old versions nothing is running from (keep the newest two)
$running = @(Get-Process -ErrorAction SilentlyContinue | Where-Object { $_.Path -like "$Root\versions\*" } | ForEach-Object { $_.Path })
Get-ChildItem (Join-Path $Root "versions") -Directory | Sort-Object Name -Descending | Select-Object -Skip 2 | ForEach-Object {
	$dir = $_.FullName
	if ($running | Where-Object { $_ -like "$dir\*" }) { Write-Host "kept (running): $($_.Name)"; return }
	try { Remove-Item $dir -Recurse -Force; Write-Host "removed old $($_.Name)" } catch { Write-Host "could not remove $($_.Name): $_" }
}
