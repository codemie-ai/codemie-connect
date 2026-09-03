# build-installer.ps1
# Compiles the CodeMie CLI from codemie-code into a standalone Windows exe,
# then builds the NSIS installer via Tauri.
#
# Usage: .\build-installer.ps1 [-SkipCliCompile]
#
# -SkipCliCompile  Skip the pkg step if you already have a built binary in assets/bin/.

param(
    [switch]$SkipCliCompile
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$InstallerRoot = $PSScriptRoot
$CodemieCodeDir = "C:\Work\codemie\codemie-code"
$CliEntry       = Join-Path $CodemieCodeDir "bin\codemie.js"
$AssetsDir      = Join-Path $InstallerRoot "assets\bin"
$CliOut         = Join-Path $AssetsDir "codemie-x86_64-pc-windows-msvc.exe"

# ── 1. Compile CLI ──────────────────────────────────────────────────────────
if (-not $SkipCliCompile) {
    Write-Host ""
    Write-Host "==> [1/2] Compiling CodeMie CLI with pkg..." -ForegroundColor Cyan

    if (-not (Test-Path $CliEntry)) {
        Write-Error "CLI entry point not found: $CliEntry`nMake sure codemie-code is checked out at $CodemieCodeDir"
        exit 1
    }

    New-Item -ItemType Directory -Force -Path $AssetsDir | Out-Null

    # ── Pre-build: patch chalk v5 to remove Node.js `imports` specifiers ────
    # chalk v5 uses the Node.js `imports` package field (#ansi-styles,
    # #supports-color).  @yao-pkg/pkg neither traces that field during asset
    # discovery nor resolves # specifiers at runtime in its snapshot bootstrap,
    # so `require('#ansi-styles')` would crash on any machine.
    # Fix: swap to direct relative paths before pkg runs; restore afterwards.
    $ChalkIndex    = Join-Path $CodemieCodeDir "node_modules\chalk\source\index.js"
    $ChalkOriginal = Get-Content $ChalkIndex -Raw -Encoding UTF8
    $ChalkPatched  = $ChalkOriginal `
        -replace "from '#ansi-styles'",    "from './vendor/ansi-styles/index.js'" `
        -replace "from '#supports-color'", "from './vendor/supports-color/index.js'"

    try {
        Set-Content -Path $ChalkIndex -Value $ChalkPatched -Encoding UTF8 -NoNewline
        Write-Host "    Patched chalk #imports → relative paths" -ForegroundColor DarkCyan

        # pkg must run from the CLI source directory so relative require()s resolve.
        Push-Location $CodemieCodeDir
        try {
            pkg $CliEntry `
                --target node22-win-x64 `
                --output $CliOut `
                --public-packages "*"

            if ($LASTEXITCODE -ne 0) {
                Write-Error "pkg failed with exit code $LASTEXITCODE"
                exit $LASTEXITCODE
            }
        } finally {
            Pop-Location
        }
    } finally {
        # Always restore chalk — even if pkg errors or the user Ctrl-C's.
        Set-Content -Path $ChalkIndex -Value $ChalkOriginal -Encoding UTF8 -NoNewline
        Write-Host "    Restored chalk source" -ForegroundColor DarkCyan
    }

    $size = (Get-Item $CliOut).Length / 1MB
    Write-Host "    Built: $CliOut ($([math]::Round($size, 1)) MB)" -ForegroundColor Green
} else {
    Write-Host ""
    Write-Host "==> [1/2] Skipping CLI compile (-SkipCliCompile)" -ForegroundColor Yellow
    if (-not (Test-Path $CliOut)) {
        Write-Error "No binary at $CliOut — remove -SkipCliCompile to build it first."
        exit 1
    }
}

# ── 2. Build NSIS installer ──────────────────────────────────────────────────
Write-Host ""
Write-Host "==> [2/2] Building NSIS installer via Tauri..." -ForegroundColor Cyan

Push-Location $InstallerRoot
try {
    npx tauri build --bundles nsis

    if ($LASTEXITCODE -ne 0) {
        Write-Error "tauri build failed with exit code $LASTEXITCODE"
        exit $LASTEXITCODE
    }
} finally {
    Pop-Location
}

$SetupExe = Get-ChildItem "$InstallerRoot\src-tauri\target\release\bundle\nsis\*-setup.exe" |
            Sort-Object LastWriteTime -Descending |
            Select-Object -First 1

Write-Host ""
Write-Host "==> Done!" -ForegroundColor Green
Write-Host "    Installer: $($SetupExe.FullName)"
Write-Host "    Size:      $([math]::Round($SetupExe.Length / 1MB, 1)) MB"
