# Packs the staged Windows runtime (Node + CLI tree) into the one archive the app
# downloads on first launch, and writes what the app and the shim need to find
# and verify it. Run after scripts\stage-runtime.ps1 and BEFORE `tauri build`:
# the app embeds assets\windows\runtime-pack.json at compile time.
# Upload dist\<file> to the URL printed at the end before publishing the installer.
Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$Root       = Split-Path -Parent $PSScriptRoot
$Cfg        = Get-Content (Join-Path $Root "runtime.json") -Raw | ConvertFrom-Json
$NodeDir    = Join-Path $Root "assets\windows\node"
$CliModules = Join-Path $Root "assets\codemie-cli\node_modules"
$OutDir     = Join-Path $Root "dist"
$PackJson   = Join-Path $Root "assets\windows\runtime-pack.json"
$KeyFile    = Join-Path $Root "assets\windows\bin\runtime-key"
# The in-box bsdtar: the same one the app unpacks with.
$Tar        = Join-Path $env:SystemRoot "System32\tar.exe"

function Fail([string]$msg) { Write-Error "[pack-runtime] $msg"; exit 1 }

if (-not (Test-Path (Join-Path $NodeDir "node.exe"))) { Fail "no staged node at $NodeDir; run scripts\stage-runtime.ps1 first" }
if (-not (Test-Path (Join-Path $CliModules "@codemieai\code\bin\codemie.js"))) { Fail "no staged CLI at $CliModules; run scripts\stage-runtime.ps1 first" }
if (-not (Test-Path $Tar)) { Fail "tar.exe not found at $Tar" }
if (-not $Cfg.runtimeBaseUrlWindows) { Fail "runtime.json: runtimeBaseUrlWindows missing" }

$Key  = "$($Cfg.cliVersion)-node$($Cfg.nodeVersion)"
$File = "codemie-runtime-$Key-win-x64.tar.gz"
$Url  = ($Cfg.runtimeBaseUrlWindows -replace '\{key\}', $Key) + "/$File"

# Same layout the installer's resources had: node\..., cli\node_modules\...
# Built in a temp tree so the archive never carries the staging paths.
$Tmp = Join-Path ([System.IO.Path]::GetTempPath()) "codemie-pack-$([guid]::NewGuid().ToString('N'))"
try {
    New-Item -ItemType Directory -Force -Path (Join-Path $Tmp "node"), (Join-Path $Tmp "cli\node_modules"), $OutDir | Out-Null
    Copy-Item (Join-Path $NodeDir "*") (Join-Path $Tmp "node") -Recurse -Force
    Copy-Item (Join-Path $CliModules "*") (Join-Path $Tmp "cli\node_modules") -Recurse -Force

    $Archive = Join-Path $OutDir $File
    if (Test-Path $Archive) { Remove-Item $Archive -Force }
    & $Tar -czf $Archive -C $Tmp node cli
    if ($LASTEXITCODE -ne 0) { Fail "tar failed with exit code $LASTEXITCODE" }
} finally {
    if (Test-Path $Tmp) { Remove-Item $Tmp -Recurse -Force -ErrorAction SilentlyContinue }
}

$Sha  = (Get-FileHash -Path $Archive -Algorithm SHA256).Hash.ToLower()
$Size = (Get-Item $Archive).Length
$utf8 = New-Object System.Text.UTF8Encoding($false)   # serde_json rejects a BOM
[System.IO.File]::WriteAllText($PackJson, (@{ key = $Key; url = $Url; sha256 = $Sha; size = $Size } | ConvertTo-Json), $utf8)
New-Item -ItemType Directory -Force -Path (Split-Path $KeyFile) | Out-Null
[System.IO.File]::WriteAllText($KeyFile, $Key, $utf8)

Write-Host "==> $Archive ($([math]::Round($Size / 1MB, 1)) MB)" -ForegroundColor Green
Write-Host "    sha256 $Sha"
Write-Host "    upload to $Url"
