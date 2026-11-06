# Reports the managed-CLI state on Windows so the EPMCDME-16840 update can be checked by eye.
# Run before and after launching the app: .\docs\testing\verify-cli-update.ps1
$Root = Resolve-Path (Join-Path $PSScriptRoot "..\..")
$Cfg  = Get-Content (Join-Path $Root "runtime.json") -Raw | ConvertFrom-Json
$Key  = "$($Cfg.cliVersion)-node$($Cfg.nodeVersion)"
$Dir  = Join-Path $env:LOCALAPPDATA "CodeMie\runtime\$Key"
$Pkg  = Join-Path $Dir "cli\node_modules\@codemieai\code\package.json"

"pinned (runtime.json): $($Cfg.cliVersion)"
"npm latest:            $((Invoke-RestMethod 'https://registry.npmjs.org/@codemieai/code/latest').version)"
if (Test-Path $Pkg) {
    "installed:             $((Get-Content $Pkg -Raw | ConvertFrom-Json).version)"
    $node = Join-Path $Dir "node\node.exe"
    $js   = Join-Path $Dir "cli\node_modules\@codemieai\code\bin\codemie.js"
    "codemie --version:     $(& $node $js --version 2>&1)"
} else { "installed:             (none at $Dir)" }
"leftovers:             $((Get-ChildItem (Split-Path $Dir) -Force -Filter '.staging-*' -ErrorAction SilentlyContinue | ForEach-Object Name) -join ', ')"
"                       $((Get-ChildItem $Dir -Force -Filter '*.old*' -ErrorAction SilentlyContinue | ForEach-Object Name) -join ', ')"
"--- wizard log (CodeMie CLI update lines) ---"
Get-ChildItem $env:USERPROFILE\AppData\Local\CodeMie\logs\codemie_wizard.log -ErrorAction SilentlyContinue |
    Select-String "CodeMie CLI update" | Select-Object -Last 5 | ForEach-Object Line
