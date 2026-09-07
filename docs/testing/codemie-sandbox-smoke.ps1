# Smoke test — auto-runs inside Windows Sandbox via .wsb LogonCommand.
# EPMCDME-14505 DoD: clean install, app starts, uninstall, %APPDATA%\.codemie preserved.
$ErrorActionPreference = 'Stop'
$log = "$env:USERPROFILE\Desktop\smoke-result.txt"
function Log($m)  { Add-Content $log "[$(Get-Date -f HH:mm:ss)] $m"; Write-Host $m }
function Fail($m) { Log "FAIL: $m"; exit 1 }

# 1 — Find and run the installer silently (NSIS /S = silent, no UAC with currentUser)
$exe = Get-ChildItem C:\Install -Filter '*.exe' -ErrorAction Stop |
       Sort-Object LastWriteTime -Desc | Select-Object -First 1
if (-not $exe) { Fail "No installer found in C:\Install" }
Log "Installing $($exe.Name) silently..."
$r = Start-Process $exe.FullName -ArgumentList '/S' -PassThru -Wait
if ($r.ExitCode -ne 0) { Fail "Installer exit code $($r.ExitCode)" }
Log "PASS: installer exited 0 — no admin credential requested"

# 2 — Verify app executable exists and the process stays alive for 10 s
$appExe = "$env:LOCALAPPDATA\Programs\CodeMie Connect\CodeMie Connect.exe"
if (-not (Test-Path $appExe)) { Fail "App not found at $appExe" }
$app = Start-Process $appExe -PassThru
Start-Sleep 10
if (-not (Get-Process -Id $app.Id -ErrorAction SilentlyContinue)) {
    Fail "App process exited within 10 s after launch"
}
Log "PASS: app running (pid $($app.Id))"
$app | Stop-Process -Force -ErrorAction SilentlyContinue

# 3 — Create .codemie sentinel so we can assert it survives the uninstaller
$codemieDir = "$env:APPDATA\.codemie"
New-Item $codemieDir -ItemType Directory -Force | Out-Null
"smoke" | Set-Content "$codemieDir\sentinel.txt"
Log "Sentinel created at $codemieDir\sentinel.txt"

# 4 — Uninstall silently
$uninst = "$env:LOCALAPPDATA\Programs\CodeMie Connect\uninstall.exe"
if (-not (Test-Path $uninst)) { Fail "Uninstaller not found at $uninst" }
$u = Start-Process $uninst -ArgumentList '/S' -PassThru -Wait
if ($u.ExitCode -ne 0) { Fail "Uninstaller exit code $($u.ExitCode)" }
Log "PASS: uninstaller exited 0"

# 5 — Confirm .codemie was not removed by the uninstaller
if (-not (Test-Path "$codemieDir\sentinel.txt")) {
    Fail "$codemieDir was removed by the uninstaller — AC violated"
}
Log "PASS: $codemieDir preserved after uninstall"
Log "ALL PASS"
