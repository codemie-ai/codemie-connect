# build-installer.ps1
# Stages the bundled Node runtime + CodeMie CLI tree, verifies every artifact,
# then builds the NSIS installer via Tauri.
#
# Usage: .\build-installer.ps1 [-SkipStage] [-NoBaseline]
#
# -SkipStage   Reuse an already-staged tree. Does NOT skip verification.
# -NoBaseline  Forwarded to stage-runtime.ps1 (drops the ~159 MB baseline build).
#
# There is deliberately no switch to skip verification. Every defect this
# script guards against was produced by a tool that reported success:
#   * pkg emitted a warning and exited 0, shipping a snapshot missing a file.
#   * dist/index.js exits 0 and prints nothing, so the CLI never starts.
#   * A glob in bundle.resources flattens 19,754 files and reports errors: 0.
# An exit-code check is not verification. Do not add a bypass.

param(
    [switch]$SkipStage,
    [switch]$NoBaseline
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$Root       = $PSScriptRoot
$Cfg        = Get-Content (Join-Path $Root "runtime.json") -Raw | ConvertFrom-Json
$NodeExe    = Join-Path $Root "assets\windows\node\node.exe"
$CliModules = Join-Path $Root "assets\codemie-cli\node_modules"
$CliEntry   = Join-Path $CliModules "@codemieai\code\bin\codemie.js"
$Manifest   = Join-Path $Root "assets\staging-manifest.json"

function Fail([string]$msg) { Write-Host ""; Write-Error "[build] $msg"; exit 1 }
function Step([string]$msg) { Write-Host ""; Write-Host "==> $msg" -ForegroundColor Cyan }

# ── 1. Stage ────────────────────────────────────────────────────────────────
if ($SkipStage) {
    Step "[1/5] Skipping staging (-SkipStage); verification still runs"
} else {
    Step "[1/5] Staging bundled runtime and CLI tree"
    $stageArgs = @("-File", (Join-Path $Root "scripts\stage-runtime.ps1"))
    if ($NoBaseline) { $stageArgs += "-NoBaseline" }
    & pwsh @stageArgs
    if ($LASTEXITCODE -ne 0) { Fail "stage-runtime.ps1 failed with exit code $LASTEXITCODE" }
}

# ── 2. Pre-build assertions ─────────────────────────────────────────────────
Step "[2/5] Verifying staged artifacts"

if (-not (Test-Path $NodeExe)) { Fail "missing bundled runtime: $NodeExe" }
$nodeSize = (Get-Item $NodeExe).Length
if ($nodeSize -lt 10MB) {
    Fail "bundled node.exe is $nodeSize bytes, expected > 10 MB — 0-byte placeholder at $NodeExe"
}

$nodeVersion = (& $NodeExe --version 2>&1).Trim()
if ($LASTEXITCODE -ne 0) { Fail "node.exe --version failed: $nodeVersion" }
if ($nodeVersion -ne "v$($Cfg.nodeVersion)") {
    Fail "bundled node reports $nodeVersion but runtime.json pins v$($Cfg.nodeVersion)"
}
Write-Host "    node $nodeVersion ($([math]::Round($nodeSize/1MB,1)) MB)" -ForegroundColor DarkCyan

foreach ($rel in @(
    "@codemieai\code\bin\codemie.js",
    "@codemieai\code\dist\cli\index.js",
    "@codemieai\code\package.json",
    "keytar\build\Release\keytar.node"
)) {
    $p = Join-Path $CliModules $rel
    if (-not (Test-Path $p)) { Fail "missing required bundled file: $p" }
    if ((Get-Item $p).Length -eq 0) { Fail "required bundled file is empty: $p" }
}

if (-not (Test-Path $Manifest)) { Fail "missing staging manifest: $Manifest (run without -SkipStage)" }
$mf = Get-Content $Manifest -Raw | ConvertFrom-Json
if ($mf.cliVersion -ne $Cfg.cliVersion) {
    Fail "staging manifest reports CLI $($mf.cliVersion) but runtime.json pins $($Cfg.cliVersion)"
}
Write-Host "    CLI $($mf.cliVersion): $($mf.fileCount) files, $([math]::Round($mf.byteSize/1MB,1)) MB" -ForegroundColor DarkCyan

# ── 3. Smoke-test the staged tree ───────────────────────────────────────────
Step "[3/5] Smoke-testing the staged CLI"

# Non-empty stdout is the real assertion. dist/index.js would exit 0 silently.
$smoke = & $NodeExe $CliEntry --version 2>&1
$smokeCode = $LASTEXITCODE
if ($smokeCode -ne 0) { Fail "staged CLI exited $smokeCode`n$smoke" }
if ([string]::IsNullOrWhiteSpace(($smoke | Out-String))) {
    Fail "staged CLI produced NO output. The entry point is almost certainly wrong — dist/index.js is a library barrel that exits 0 and prints nothing. Expected bin/codemie.js."
}
Write-Host "    codemie --version -> $(($smoke | Out-String).Trim())" -ForegroundColor Green

# ── 4. Build ────────────────────────────────────────────────────────────────
Step "[4/5] Building NSIS installer via Tauri"
Push-Location $Root
try {
    npx tauri build --bundles nsis
    if ($LASTEXITCODE -ne 0) { Fail "tauri build failed with exit code $LASTEXITCODE" }
} finally { Pop-Location }

# ── 5. Post-build assertions ────────────────────────────────────────────────
Step "[5/5] Verifying the produced bundle"

# tauri-build copies bundle.resources into target_dir itself, NOT a
# resources/ subdirectory: copy_resources() does target_dir.join(target),
# and target_dir is out_dir's third parent — i.e. target\release.
# Verified in tauri-build-2.6.2/src/lib.rs:88-103 and :536-543.
$ReleaseDir = Join-Path $Root "src-tauri\target\release"
if (-not (Test-Path $ReleaseDir)) { Fail "no release directory at $ReleaseDir" }

$CliTreeRoot = Join-Path $ReleaseDir "cli\node_modules"

foreach ($rel in @(
    "bin\codemie.cmd",
    "node\node.exe",
    "cli\node_modules\@codemieai\code\bin\codemie.js"
)) {
    $p = Join-Path $ReleaseDir $rel
    if (-not (Test-Path $p)) {
        Fail "bundle is missing $rel (looked at $p). If the CLI tree is present but flat, a glob key crept back into bundle.resources — see spec §5."
    }
}

# A flattened tree still contains every file NAME, so presence checks alone
# cannot detect Form A. Assert nesting depth: the scoped path above
# (cli\node_modules\@codemieai\code\bin\codemie.js) is 5 segments deep and
# would not exist under a flattened layout, but assert independently too.
$deep = Get-ChildItem $CliTreeRoot -Recurse -File -ErrorAction SilentlyContinue |
        Where-Object { $_.FullName.Substring($CliTreeRoot.Length).Trim('\').Split('\').Count -ge 4 } |
        Select-Object -First 1
if (-not $deep) {
    Fail "bundled cli\node_modules has no nested files — the tree was FLATTENED. Remove any '*' from the bundle.resources CLI-tree key (spec §5)."
}

# Scope the stray-binary scan to the three resource roots. Scanning all of
# target\release would walk build intermediates and is both slow and noisy.
foreach ($scope in @("bin", "node", "cli")) {
    $d = Join-Path $ReleaseDir $scope
    if (-not (Test-Path $d)) { continue }
    $stray = Get-ChildItem $d -Recurse -File -Filter "codemie*.exe" -ErrorAction SilentlyContinue
    if ($stray) { Fail "pkg binary present in bundle: $($stray[0].FullName)" }
}

$SetupExe = Get-ChildItem (Join-Path $ReleaseDir "bundle\nsis\*-setup.exe") -ErrorAction SilentlyContinue |
            Sort-Object LastWriteTime -Descending | Select-Object -First 1
if (-not $SetupExe) { Fail "no *-setup.exe produced in $ReleaseDir\bundle\nsis" }

Write-Host ""
Write-Host "==> Done — all assertions passed." -ForegroundColor Green
Write-Host "    Installer: $($SetupExe.FullName)"
Write-Host "    Size:      $([math]::Round($SetupExe.Length / 1MB, 1)) MB"
