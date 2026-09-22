# Sole producer of the bundled runtime artifacts. Idempotent.
# Usage: .\scripts\stage-runtime.ps1 [-NoBaseline] [-Force]
#   -NoBaseline  Drop codemie-opencode-windows-x64-baseline (~159 MB).
#                WARNING: breaks codemie-opencode on CPUs without modern SIMD.
#   -Force       Re-download Node and reinstall the CLI tree from scratch.
param(
    [switch]$NoBaseline,
    [switch]$Force
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$Root      = Split-Path -Parent $PSScriptRoot
$Cfg       = Get-Content (Join-Path $Root "runtime.json") -Raw | ConvertFrom-Json
$NodeDir   = Join-Path $Root "assets\windows\node"
$NodeExe   = Join-Path $NodeDir "node.exe"
$CliDir    = Join-Path $Root "assets\codemie-cli"
$CliModules= Join-Path $CliDir "node_modules"
$Manifest  = Join-Path $Root "assets\staging-manifest.json"

function Fail([string]$msg) { Write-Error "[stage-runtime] $msg"; exit 1 }

# ── 1. Node runtime ─────────────────────────────────────────────────────────
if ($Force -and (Test-Path $NodeDir)) { Remove-Item $NodeDir -Recurse -Force }

if (-not (Test-Path $NodeExe)) {
    Write-Host "==> Fetching Node v$($Cfg.nodeVersion) (win-x64)..." -ForegroundColor Cyan
    New-Item -ItemType Directory -Force -Path $NodeDir | Out-Null

    $zipName = "node-v$($Cfg.nodeVersion)-win-x64.zip"
    $zipUrl  = "https://nodejs.org/dist/v$($Cfg.nodeVersion)/$zipName"
    $tmp     = Join-Path ([System.IO.Path]::GetTempPath()) "codemie-node-stage"
    if (Test-Path $tmp) { Remove-Item $tmp -Recurse -Force }
    New-Item -ItemType Directory -Force -Path $tmp | Out-Null
    $zipPath = Join-Path $tmp $zipName

    Invoke-WebRequest -Uri $zipUrl -OutFile $zipPath -UseBasicParsing

    $actual = (Get-FileHash -Path $zipPath -Algorithm SHA256).Hash.ToLower()
    $expect = $Cfg.nodeWin64Sha256.ToLower()
    if ($actual -ne $expect) {
        Fail "Node zip checksum mismatch for $zipName`n  expected: $expect`n  actual:   $actual"
    }
    Write-Host "    checksum OK" -ForegroundColor DarkCyan

    Expand-Archive -Path $zipPath -DestinationPath $tmp -Force
    $src = Join-Path $tmp "node-v$($Cfg.nodeVersion)-win-x64\node.exe"
    if (-not (Test-Path $src)) { Fail "node.exe not found in extracted archive at $src" }
    Copy-Item $src $NodeExe -Force
    Write-Host "    node.exe staged" -ForegroundColor Green

    # npm ships as a sibling of node.exe in the Windows zip layout (node_modules\npm,
    # not under lib\ as on macOS). EPMCDME-15180: no separate download.
    $npmSrc = Join-Path $tmp "node-v$($Cfg.nodeVersion)-win-x64\node_modules\npm"
    if (-not (Test-Path $npmSrc)) { Fail "npm tree not found in Node zip at node_modules\npm — zip layout may have changed" }
    Copy-Item $npmSrc (Join-Path $NodeDir "node_modules\npm") -Recurse -Force

    # npm shim: execs the staged node.exe against npm's own CLI entry.
    @'
@echo off
"%~dp0node.exe" "%~dp0node_modules\npm\bin\npm-cli.js" %*
'@ | Set-Content (Join-Path $NodeDir "npm.cmd") -Encoding ASCII
    Write-Host "    npm.cmd staged" -ForegroundColor Green

    Remove-Item $tmp -Recurse -Force
} else {
    Write-Host "==> node.exe already staged (use -Force to refresh)" -ForegroundColor Yellow
}

# ── 2. CLI tree ─────────────────────────────────────────────────────────────
$wantSpec = "$($Cfg.cliPackage)@$($Cfg.cliVersion)"
$installedVersion = $null
$cliPkgJson = Join-Path $CliModules "$($Cfg.cliPackage)\package.json"
if (Test-Path $cliPkgJson) {
    $installedVersion = (Get-Content $cliPkgJson -Raw | ConvertFrom-Json).version
}

if ($Force -or ($installedVersion -ne $Cfg.cliVersion)) {
    Write-Host "==> Installing $wantSpec (production deps only)..." -ForegroundColor Cyan
    if ($Force -and (Test-Path $CliModules)) { Remove-Item $CliModules -Recurse -Force }
    New-Item -ItemType Directory -Force -Path $CliDir | Out-Null

    # Minimal manifest so npm resolves exactly the pinned CLI and nothing else.
    @{
        name         = "codemie-cli-bundle"
        version      = "0.0.0"
        private      = $true
        dependencies = @{ "$($Cfg.cliPackage)" = $Cfg.cliVersion }
    } | ConvertTo-Json -Depth 5 | Set-Content (Join-Path $CliDir "package.json") -Encoding UTF8

    Push-Location $CliDir
    try {
        # --omit=dev drops node-pty (64 MB) and typescript (23 MB).
        # Postinstall scripts MUST run: keytar and codemie-opencode need them.
        npm install --omit=dev
        if ($LASTEXITCODE -ne 0) { Fail "npm install failed with exit code $LASTEXITCODE" }
    } finally { Pop-Location }
} else {
    Write-Host "==> CLI tree already at $wantSpec (use -Force to refresh)" -ForegroundColor Yellow
}

# ── 3. Prune ────────────────────────────────────────────────────────────────
Write-Host "==> Pruning..." -ForegroundColor Cyan
$before = (Get-ChildItem $CliModules -Recurse -File -ErrorAction SilentlyContinue).Count

Get-ChildItem $CliModules -Recurse -File -Filter "*.map" -ErrorAction SilentlyContinue |
    Remove-Item -Force -ErrorAction SilentlyContinue

foreach ($d in @("test", "tests", "__tests__", "example", "examples", "docs")) {
    Get-ChildItem $CliModules -Recurse -Directory -Filter $d -ErrorAction SilentlyContinue |
        Remove-Item -Recurse -Force -ErrorAction SilentlyContinue
}

foreach ($p in @("node-pty", "typescript", "@rollup", "@esbuild")) {
    $t = Join-Path $CliModules $p
    if (Test-Path $t) { Remove-Item $t -Recurse -Force }
}

if ($NoBaseline) {
    $bl = Join-Path $CliModules "@codemieai\codemie-opencode-windows-x64-baseline"
    if (Test-Path $bl) {
        Remove-Item $bl -Recurse -Force
        Write-Warning "Removed codemie-opencode baseline build — codemie-opencode will not run on CPUs without modern SIMD."
    }
}

$after = (Get-ChildItem $CliModules -Recurse -File).Count
Write-Host "    files: $before -> $after" -ForegroundColor DarkCyan

# ── 4. Verify (see spec §6 — these are not negotiable) ──────────────────────
Write-Host "==> Verifying staged artifacts..." -ForegroundColor Cyan

if (-not (Test-Path $NodeExe)) { Fail "missing: $NodeExe" }
$nodeSize = (Get-Item $NodeExe).Length
if ($nodeSize -lt 10MB) { Fail "node.exe is only $nodeSize bytes — expected > 10 MB (0-byte placeholder?)" }

$reportedVersion = & $NodeExe --version 2>&1
if ($LASTEXITCODE -ne 0) { Fail "node.exe --version failed: $reportedVersion" }
if ($reportedVersion.Trim() -ne "v$($Cfg.nodeVersion)") {
    Fail "node.exe reports $reportedVersion, expected v$($Cfg.nodeVersion)"
}

if (-not (Test-Path (Join-Path $NodeDir "npm.cmd"))) { Fail "missing: $NodeDir\npm.cmd" }
$npmCli = Join-Path $NodeDir "node_modules\npm\bin\npm-cli.js"
if (-not (Test-Path $npmCli)) { Fail "missing: $npmCli" }
if ((Get-Item $npmCli).Length -eq 0) { Fail "empty: $npmCli" }
$npmVersion = & (Join-Path $NodeDir "npm.cmd") --version 2>&1
if ($LASTEXITCODE -ne 0) { Fail "npm.cmd --version failed: $npmVersion" }
Write-Host "    npm $(($npmVersion | Out-String).Trim())" -ForegroundColor DarkCyan

$required = @(
    "$($Cfg.cliPackage)\bin\codemie.js",
    "$($Cfg.cliPackage)\dist\cli\index.js",
    "$($Cfg.cliPackage)\package.json",
    "keytar\build\Release\keytar.node"
)
foreach ($r in $required) {
    $p = Join-Path $CliModules $r
    if (-not (Test-Path $p)) { Fail "missing required bundled file: $p" }
    if ((Get-Item $p).Length -eq 0) { Fail "required bundled file is empty: $p" }
}

$actualCli = (Get-Content $cliPkgJson -Raw | ConvertFrom-Json).version
if ($actualCli -ne $Cfg.cliVersion) {
    Fail "staged CLI is $actualCli but runtime.json pins $($Cfg.cliVersion)"
}

# ── 5. Manifest ─────────────────────────────────────────────────────────────
$files = Get-ChildItem $CliModules -Recurse -File
@{
    nodeVersion = $Cfg.nodeVersion
    cliPackage  = $Cfg.cliPackage
    cliVersion  = $Cfg.cliVersion
    noBaseline  = [bool]$NoBaseline
    fileCount   = $files.Count
    byteSize    = ($files | Measure-Object -Property Length -Sum).Sum
} | ConvertTo-Json | Set-Content $Manifest -Encoding UTF8

$mb = [math]::Round(((Get-Content $Manifest -Raw | ConvertFrom-Json).byteSize / 1MB), 1)
Write-Host "==> Staging OK: $($files.Count) files, $mb MB" -ForegroundColor Green
