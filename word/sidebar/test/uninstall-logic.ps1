# Used by uninstall-script.test.ts. Parses word\uninstall.ps1 WITHOUT running it, lifts out its helper functions and calls them
# with fakes. Nothing is registered, unregistered or deleted, and the registry is not touched.
param([Parameter(Mandatory)][string]$Script, [Parameter(Mandatory)][string]$Scratch)
$ErrorActionPreference = 'Stop'
$errs = $null; $tokens = $null
$ast = [System.Management.Automation.Language.Parser]::ParseFile($Script, [ref]$tokens, [ref]$errs)
$out = [ordered]@{ parseErrors = @($errs | ForEach-Object { $_.Message }) }

$defs = $ast.FindAll({ param($n) $n -is [System.Management.Automation.Language.FunctionDefinitionAst] }, $true)
$out.functions = @($defs | ForEach-Object { $_.Name })
foreach ($d in $defs) { Invoke-Expression $d.Extent.Text }

# a helper only counts if the script itself calls it, outside its own definition
$called = @{}
foreach ($c in $ast.FindAll({ param($n) $n -is [System.Management.Automation.Language.CommandAst] }, $true)) {
  $name = $c.GetCommandName()
  $inside = $false
  foreach ($d in $defs) { if ($c.Extent.StartOffset -ge $d.Extent.StartOffset -and $c.Extent.EndOffset -le $d.Extent.EndOffset) { $inside = $true } }
  if ($name -and -not $inside) { $called[$name] = $true }
}
$out.calledByScript = @($called.Keys | Sort-Object)

if ($out.functions -contains 'Resolve-AddinDll') {
  $real = Join-Path $Scratch 'addin'
  New-Item -ItemType Directory -Force $real | Out-Null
  $out.resolveMissing = $null -eq (Resolve-AddinDll (Join-Path $Scratch 'no-such-folder'))
  $out.resolveEmpty = $null -eq (Resolve-AddinDll '')
  $out.resolveNull = $null -eq (Resolve-AddinDll $null)
  $out.resolveReal = [string](Resolve-AddinDll $real)
}

if ($out.functions -contains 'Invoke-RedirectedUnregister') {
  $script:log = New-Object System.Collections.ArrayList
  $redirectFail = { [void]$script:log.Add('redirect'); 5 }
  $redirectOk = { [void]$script:log.Add('redirect'); 0 }
  $restore = { [void]$script:log.Add('restore'); 0 }
  $unreg = { [void]$script:log.Add('unregister') }
  $unregThrows = { [void]$script:log.Add('unregister'); throw 'boom' }

  $script:log.Clear()
  $r = Invoke-RedirectedUnregister -Redirect $redirectFail -Restore $restore -Unregister $unreg 3>$null
  $out.failedRedirect = [ordered]@{ result = $r; log = @($script:log) }

  $script:log.Clear()
  $r = Invoke-RedirectedUnregister -Redirect $redirectOk -Restore $restore -Unregister $unreg
  $out.okRedirect = [ordered]@{ result = $r; log = @($script:log) }

  $script:log.Clear()
  $thrown = $null
  try { [void](Invoke-RedirectedUnregister -Redirect $redirectOk -Restore $restore -Unregister $unregThrows) } catch { $thrown = $_.Exception.Message }
  $out.throwingUnregister = [ordered]@{ thrown = $thrown; log = @($script:log) }
}

if ($out.functions -contains 'Get-DataFolders') {
  $out.dataFolders = @(Get-DataFolders -Roaming 'C:\Fake\Roaming' -Local 'C:\Fake\Local')
}
$out | ConvertTo-Json -Depth 6 -Compress
