<#
.SYNOPSIS  Build the add-in (C#, .NET Framework 4.8) and the sidebar (TypeScript, Bun) into word\dist\addin.
.EXAMPLE   pwsh word\build.ps1            # add-in + sidebar
.EXAMPLE   pwsh word\build.ps1 -Harness   # also the test harness (word\dist\harness)
.EXAMPLE   pwsh word\build.ps1 -OutDir D:\stage   # build into D:\stage\addin instead of word\dist\addin (the installer's staging; word\dist is left alone)
#>
param([switch]$Harness, [string]$OutDir)
$ErrorActionPreference = 'Stop'
Set-Location $PSScriptRoot
$distArgs = @()
if ($OutDir) {
  $OutDir = [IO.Path]::GetFullPath($OutDir)
  New-Item -ItemType Directory -Force (Join-Path $OutDir 'addin') | Out-Null
  $distArgs = @("-p:OutputPath=$OutDir\addin\")   # the csproj's OutputPath defaults to dist\addin\
  $env:ZN_WORD_DIST = $OutDir                      # sidebar\build.ts writes <ZN_WORD_DIST>\addin\sidebar
}
dotnet build addin\ZoteroNextWord.csproj -c Release -nologo -v q @distArgs
if ($LASTEXITCODE) { throw 'add-in build failed' }
Push-Location sidebar
bun install
if ($LASTEXITCODE) { throw 'bun install failed' }
bun build.ts
if ($LASTEXITCODE) { throw 'sidebar build failed' }
Pop-Location
if ($Harness) {
  dotnet build harness\ZoteroNextWord.Harness.csproj -c Release -nologo -v q
  if ($LASTEXITCODE) { throw 'harness build failed' }
}
Write-Host "Built: $(if ($OutDir) { Join-Path $OutDir 'addin' } else { Join-Path $PSScriptRoot 'dist\addin' })"
