# build-installer.ps1
# Stages the Node runtime + CodeMie CLI tree, packs them into the archive the app
# downloads on first launch (the installer itself bundles only the shim), verifies
# every artifact, then builds the NSIS installer via Tauri. Upload
# dist\codemie-runtime-*.tar.gz to the URL pack-runtime.ps1 prints before
# publishing the installer.
#
# Usage: .\build-installer.ps1 [-SkipStage] [-NoBaseline] [-Force]
#
# -SkipStage   Reuse an already-staged tree (and an existing runtime-pack.json).
#              Does NOT skip verification.
# -NoBaseline  Forwarded to stage-runtime.ps1 (drops the ~159 MB baseline build).
# -Force       Forwarded to stage-runtime.ps1 (re-downloads Node and reinstalls CLI).
#
# There is deliberately no switch to skip verification. Every defect this
# script guards against was produced by a tool that reported success:
#   * pkg emitted a warning and exited 0, shipping a snapshot missing a file.
#   * dist/index.js exits 0 and prints nothing, so the CLI never starts.
#   * A glob in bundle.resources flattens 19,754 files and reports errors: 0.
#   * An archive whose checksum is not the one baked into the app would be
#     rejected by every user's first launch.
# An exit-code check is not verification. Do not add a bypass.

param(
    [switch]$SkipStage,
    [switch]$NoBaseline,
    [switch]$Force
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$Root       = $PSScriptRoot
$Cfg        = Get-Content (Join-Path $Root "runtime.json") -Raw | ConvertFrom-Json
$NodeExe    = Join-Path $Root "assets\windows\node\node.exe"
$CliModules = Join-Path $Root "assets\codemie-cli\node_modules"
$CliEntry   = Join-Path $CliModules "@codemieai\code\bin\codemie.js"
$Manifest   = Join-Path $Root "assets\staging-manifest.json"
$PackJson   = Join-Path $Root "assets\windowsuntime-pack.json"

function Fail([string]$msg) { Write-Host ""; Write-Error "[build] $msg"; exit 1 }
function Step([string]$msg) { Write-Host ""; Write-Host "==> $msg" -ForegroundColor Cyan }

# -- 1. Stage ----------------------------------------------------------------
if ($SkipStage) {
    Step "[1/5] Skipping staging (-SkipStage); verification still runs"
} else {
    Step "[1/5] Staging bundled runtime and CLI tree"
    $stageArgs = @("-File", (Join-Path $Root "scripts\stage-runtime.ps1"))
    if ($NoBaseline) { $stageArgs += "-NoBaseline" }
    if ($Force)      { $stageArgs += "-Force" }
    & pwsh @stageArgs
    if ($LASTEXITCODE -ne 0) { Fail "stage-runtime.ps1 failed with exit code $LASTEXITCODE" }
}

# The app embeds runtime-pack.json at compile time, so it must exist before cargo runs.
if ((-not $SkipStage) -or (-not (Test-Path $PackJson))) {
    Step "[1/5] Packing the runtime archive"
    & pwsh -File (Join-Path $Root "scripts\pack-runtime.ps1")
    if ($LASTEXITCODE -ne 0) { Fail "pack-runtime.ps1 failed with exit code $LASTEXITCODE" }
}

# -- 2. Pre-build assertions -------------------------------------------------
Step "[2/5] Verifying staged artifacts"

if (-not (Test-Path $NodeExe)) { Fail "missing bundled runtime: $NodeExe" }
$nodeSize = (Get-Item $NodeExe).Length
if ($nodeSize -lt 10MB) {
    Fail "bundled node.exe is $nodeSize bytes, expected > 10 MB - 0-byte placeholder at $NodeExe"
}

$nodeVersion = (& $NodeExe --version 2>&1).Trim()
if ($LASTEXITCODE -ne 0) { Fail "node.exe --version failed: $nodeVersion" }
if ($nodeVersion -ne "v$($Cfg.nodeVersion)") {
    Fail "bundled node reports $nodeVersion but runtime.json pins v$($Cfg.nodeVersion)"
}
Write-Host "    node $nodeVersion ($([math]::Round($nodeSize/1MB,1)) MB)" -ForegroundColor DarkCyan

$NpmCmd = Join-Path $Root "assets\windows\node\npm.cmd"
if (-not (Test-Path $NpmCmd)) { Fail "missing bundled npm: $NpmCmd" }
if ((Get-Item $NpmCmd).Length -eq 0) { Fail "bundled npm is empty: $NpmCmd" }
$NpmCli = Join-Path $Root "assets\windows\node\node_modules\npm\bin\npm-cli.js"
if (-not (Test-Path $NpmCli)) { Fail "missing: $NpmCli (the npm shim would exec into this and fail at runtime)" }
if ((Get-Item $NpmCli).Length -eq 0) { Fail "empty: $NpmCli (the npm shim would exec into this and fail at runtime)" }
$npmReported = & $NpmCmd --version 2>&1
if ($LASTEXITCODE -ne 0) { Fail "bundled npm.cmd --version failed: $npmReported ($NpmCmd)" }
if ([string]::IsNullOrWhiteSpace(($npmReported | Out-String))) { Fail "bundled npm produced NO output: $NpmCmd" }
Write-Host "    npm $(($npmReported | Out-String).Trim())" -ForegroundColor DarkCyan

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

# -- 3. Smoke-test the staged tree -------------------------------------------
Step "[3/5] Smoke-testing the staged CLI"

# Non-empty stdout is the real assertion. dist/index.js would exit 0 silently.
$smoke = & $NodeExe $CliEntry --version 2>&1
$smokeCode = $LASTEXITCODE
if ($smokeCode -ne 0) { Fail "staged CLI exited $smokeCode`n$smoke" }
if ([string]::IsNullOrWhiteSpace(($smoke | Out-String))) {
    Fail "staged CLI produced NO output. The entry point is almost certainly wrong - dist/index.js is a library barrel that exits 0 and prints nothing. Expected bin/codemie.js."
}
Write-Host "    codemie --version -> $(($smoke | Out-String).Trim())" -ForegroundColor Green

# -- 4. Build ----------------------------------------------------------------
# Remove stale codemie*.exe from bin\ and node\ before bundling. These are
# not regenerated by the current build; if left over from a prior pkg build
# they would trip the post-build stray check. cli\ is excluded here because
# the Tauri bundle copies codemie-opencode-windows-x64\bin\codemie.exe from
# the staged CLI tree - that file is expected and not stale.
$ReleaseDir = Join-Path $Root "src-tauri\target\release"
foreach ($scope in @("bin", "node")) {
    $d = Join-Path $ReleaseDir $scope
    if (-not (Test-Path $d)) { continue }
    Get-ChildItem $d -Recurse -File -Filter "codemie*.exe" -ErrorAction SilentlyContinue |
        ForEach-Object { Remove-Item $_.FullName -Force; Write-Host "    removed stale $($_.Name) from $scope\" -ForegroundColor DarkYellow }
}

Step "[4/5] Building NSIS installer via Tauri"
Push-Location $Root
try {
    npx tauri build --bundles nsis
    if ($LASTEXITCODE -ne 0) { Fail "tauri build failed with exit code $LASTEXITCODE" }
} finally { Pop-Location }

# -- 5. Post-build assertions ------------------------------------------------
Step "[5/5] Verifying the produced bundle"

# tauri-build copies bundle.resources into target_dir itself, NOT a
# resources/ subdirectory: copy_resources() does target_dir.join(target),
# and target_dir is out_dir's third parent - i.e. target\release.
# Verified in tauri-build-2.6.2/src/lib.rs:88-103 and :536-543.
if (-not (Test-Path $ReleaseDir)) { Fail "no release directory at $ReleaseDir" }

foreach ($rel in @("bin\codemie.cmd", "binuntime-key")) {
    $p = Join-Path $ReleaseDir $rel
    if (-not (Test-Path $p)) { Fail "bundle is missing $rel (looked at $p)" }
}
if (Test-Path (Join-Path $ReleaseDir "node
ode.exe")) { Fail "Node is bundled again: $ReleaseDir
ode (it is downloaded on first launch)" }
if (Test-Path (Join-Path $ReleaseDir "cli")) { Fail "the CLI is bundled again: $ReleaseDir\cli (it is downloaded on first launch)" }

$stray = Get-ChildItem (Join-Path $ReleaseDir "bin") -Recurse -File -Filter "codemie*.exe" -ErrorAction SilentlyContinue
if ($stray) { Fail "pkg binary present in bundle: $($stray[0].FullName)" }

# The archive on disk has to be the one the app was compiled to accept.
$pack = Get-Content $PackJson -Raw | ConvertFrom-Json
$Archive = Join-Path $Root "dist\codemie-runtime-$($pack.key)-win-x64.tar.gz"
if (-not (Test-Path $Archive)) { Fail "missing runtime archive: $Archive (run without -SkipStage)" }
$archiveSha = (Get-FileHash -Path $Archive -Algorithm SHA256).Hash.ToLower()
if ($archiveSha -ne $pack.sha256) { Fail "runtime-pack.json sha does not match $Archive; the app would reject the download" }
if ((Get-Content (Join-Path $ReleaseDir "binuntime-key") -Raw).Trim() -ne $pack.key) { Fail "bundle runtime-key does not match runtime-pack.json" }

# The strongest check: unpack the archive where the app would, then run the
# bundled shim exactly as an installed user would, against a throwaway LOCALAPPDATA.
$TestLocal = Join-Path ([System.IO.Path]::GetTempPath()) "codemie-verify-$([guid]::NewGuid().ToString('N'))"
$oldLocal = $env:LOCALAPPDATA
try {
    $rt = Join-Path $TestLocal "CodeMieuntime\$($pack.key)"
    New-Item -ItemType Directory -Force -Path $rt | Out-Null
    & (Join-Path $env:SystemRoot "System32\tar.exe") -xzf $Archive -C $rt
    if ($LASTEXITCODE -ne 0) { Fail "could not unpack $Archive" }
    [System.IO.File]::WriteAllText((Join-Path $rt ".complete"), $pack.key)
    $env:LOCALAPPDATA = $TestLocal
    $shimOut = & cmd.exe /d /c (Join-Path $ReleaseDir "bin\codemie.cmd") --version 2>&1
    $shimCode = $LASTEXITCODE
} finally {
    $env:LOCALAPPDATA = $oldLocal
    if (Test-Path $TestLocal) { Remove-Item $TestLocal -Recurse -Force -ErrorAction SilentlyContinue }
}
if ($shimCode -ne 0) { Fail "bundled shim exited $shimCode`n$shimOut" }
if ([string]::IsNullOrWhiteSpace(($shimOut | Out-String))) { Fail "bundled shim produced NO output: $ReleaseDir\bin\codemie.cmd" }
Write-Host "    bundled shim: codemie --version -> $(($shimOut | Out-String).Trim())" -ForegroundColor DarkCyan

$SetupExe = Get-ChildItem (Join-Path $ReleaseDir "bundle\nsis\*-setup.exe") -ErrorAction SilentlyContinue |
            Sort-Object LastWriteTime -Descending | Select-Object -First 1
if (-not $SetupExe) { Fail "no *-setup.exe produced in $ReleaseDir\bundle\nsis" }

Write-Host ""
Write-Host "==> Done - all assertions passed." -ForegroundColor Green
Write-Host "    Installer: $($SetupExe.FullName)"
Write-Host "    Size:      $([math]::Round($SetupExe.Length / 1MB, 1)) MB (Node and the CLI are downloaded, not bundled)"
Write-Host "    Upload:    $Archive"
