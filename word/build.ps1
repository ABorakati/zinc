<#
.SYNOPSIS  Build the add-in (C#, .NET Framework 4.8) and the sidebar (TypeScript, Bun) into word\dist\addin.
.EXAMPLE   pwsh word\build.ps1            # add-in + sidebar
.EXAMPLE   pwsh word\build.ps1 -Harness   # also the test harness (word\dist\harness)
#>
param([switch]$Harness)
$ErrorActionPreference = 'Stop'
Set-Location $PSScriptRoot
dotnet build addin\ZoteroNextWord.csproj -c Release -nologo -v q
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
Write-Host "Built: $PSScriptRoot\dist\addin"
