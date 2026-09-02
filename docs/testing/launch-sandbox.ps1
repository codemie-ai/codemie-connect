# Builds the NSIS installer and launches Windows Sandbox with the smoke test.
# Prereqs: cargo + tauri-cli installed; Windows Sandbox feature enabled (optionalfeatures.exe).
param([string]$RepoRoot = (Resolve-Path "$PSScriptRoot\..\.." -ErrorAction Stop).Path)
$ErrorActionPreference = 'Stop'

# 1 — Build NSIS installer
Write-Host "Building NSIS installer (cargo tauri build)..."
Push-Location "$RepoRoot\src-tauri"
$env:CI = 'true'
cargo tauri build 2>&1 | Tee-Object -FilePath "$env:TEMP\tauri-build.log"
Pop-Location

# 2 — Locate the installer
$nsisDir = "$RepoRoot\src-tauri\target\release\bundle\nsis"
$installer = Get-ChildItem $nsisDir -Filter '*_x64-setup.exe' |
             Sort-Object LastWriteTime -Desc | Select-Object -First 1
if (-not $installer) { Write-Error "NSIS installer not found in $nsisDir"; exit 1 }
Write-Host "Found: $($installer.FullName)"

# 3 — Write temp .wsb with resolved absolute paths
$scriptsDir = "$RepoRoot\docs\testing"
$wsb = @"
<Configuration>
  <MappedFolders>
    <MappedFolder>
      <HostFolder>$($installer.DirectoryName)</HostFolder>
      <SandboxFolder>C:\Install</SandboxFolder>
      <ReadOnly>true</ReadOnly>
    </MappedFolder>
    <MappedFolder>
      <HostFolder>$scriptsDir</HostFolder>
      <SandboxFolder>C:\Scripts</SandboxFolder>
      <ReadOnly>true</ReadOnly>
    </MappedFolder>
  </MappedFolders>
  <LogonCommand>
    <Command>powershell -ExecutionPolicy Bypass -File C:\Scripts\codemie-sandbox-smoke.ps1</Command>
  </LogonCommand>
</Configuration>
"@
$wsbPath = "$env:TEMP\codemie-smoke-$(Get-Date -f yyyyMMddHHmmss).wsb"
$wsb | Set-Content $wsbPath -Encoding UTF8
Write-Host "Sandbox config written to $wsbPath"

# 4 — Launch Windows Sandbox
Start-Process "$env:SystemRoot\System32\WindowsSandbox.exe" -ArgumentList $wsbPath
Write-Host "Sandbox launched. Read smoke-result.txt on the sandbox desktop when it completes."
