# build-installer.ps1
# Writes the runtime-key the shim reads, builds the NSIS installer via Tauri, and
# verifies the bundle. Node and the CLI are NOT bundled: the app downloads them
# on first launch (src-tauri/src/commands/runtime.rs).
#
# Usage: .\build-installer.ps1

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$Root       = $PSScriptRoot
$Cfg        = Get-Content (Join-Path $Root "runtime.json") -Raw | ConvertFrom-Json
$Key        = "$($Cfg.cliVersion)-node$($Cfg.nodeVersion)"   # must match runtime_key() in runtime.rs
$KeyFile    = Join-Path $Root "assets\windows\bin\runtime-key"
$ReleaseDir = Join-Path $Root "src-tauri\target\release"

function Fail([string]$msg) { Write-Host ""; Write-Error "[build] $msg"; exit 1 }
function Step([string]$msg) { Write-Host ""; Write-Host "==> $msg" -ForegroundColor Cyan }

# -- 1. Runtime key ----------------------------------------------------------
Step "[1/3] Writing runtime-key $Key"
New-Item -ItemType Directory -Force -Path (Split-Path $KeyFile) | Out-Null
[System.IO.File]::WriteAllText($KeyFile, $Key, (New-Object System.Text.UTF8Encoding($false)))

# -- 2. Build ----------------------------------------------------------------
Step "[2/3] Building NSIS installer via Tauri"
Push-Location $Root
try {
    npx tauri build --bundles nsis
    if ($LASTEXITCODE -ne 0) { Fail "tauri build failed with exit code $LASTEXITCODE" }
} finally { Pop-Location }

# -- 3. Post-build assertions ------------------------------------------------
Step "[3/3] Verifying the produced bundle"

$cliBins = (Get-Content (Join-Path $Root "assets\codemie-cli\package-lock.json") -Raw | ConvertFrom-Json).packages."node_modules/@codemieai/code".bin.PSObject.Properties.Name
foreach ($rel in (@($cliBins | ForEach-Object { "bin\$_.cmd" }) + "bin\runtime-key")) {
    if (-not (Test-Path (Join-Path $ReleaseDir $rel))) { Fail "bundle is missing $rel (looked in $ReleaseDir)" }
}
if ((Get-Content (Join-Path $ReleaseDir "bin\runtime-key") -Raw).Trim() -ne $Key) { Fail "bundle runtime-key does not match runtime.json ($Key)" }
if (Test-Path (Join-Path $ReleaseDir "node\node.exe")) { Fail "Node is bundled: $ReleaseDir\node (it is downloaded on first launch)" }
if (Test-Path (Join-Path $ReleaseDir "cli")) { Fail "the CLI is bundled: $ReleaseDir\cli (it is downloaded on first launch)" }

$SetupExe = Get-ChildItem (Join-Path $ReleaseDir "bundle\nsis\*-setup.exe") -ErrorAction SilentlyContinue |
            Sort-Object LastWriteTime -Descending | Select-Object -First 1
if (-not $SetupExe) { Fail "no *-setup.exe produced in $ReleaseDir\bundle\nsis" }

$installerMb = [math]::Round($SetupExe.Length / 1MB, 1)
if ($SetupExe.Length -gt 40MB) { Fail "installer is $installerMb MB (limit 40 MB) - a runtime tree or WebView2 offline installer was bundled" }

Write-Host ""
Write-Host "==> Done - all assertions passed." -ForegroundColor Green
Write-Host "    Installer: $($SetupExe.FullName) ($installerMb MB)"
