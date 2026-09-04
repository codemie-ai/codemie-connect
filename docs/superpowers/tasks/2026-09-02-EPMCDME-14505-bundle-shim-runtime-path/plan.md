# Bundled Node Runtime Staging and Shim Wiring Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `codemie --version` and `codemie install [agent]` work on a clean Windows account with no system Node.js or npm, by staging a pinned portable Node runtime plus a production CLI tree into the NSIS bundle and pointing the existing `.cmd` shim at them.

**Architecture:** Replace the `@yao-pkg/pkg` single-binary approach entirely. A staging script produces two artifacts (`node.exe`, a pruned `node_modules` tree); `tauri.conf.json` ships them as bundle resources preserving directory structure; a `.cmd` shim on per-user PATH execs the bundled Node against the CLI's real `bin/codemie.js`. Every stage asserts against the produced artifact rather than the producing tool's exit code.

**Tech Stack:** PowerShell 7 (staging + build orchestration), Rust / Tauri 2.11.2 (`tauri-utils` 2.9.2 for resource resolution), NSIS (`installMode: currentUser`), Node.js 22.23.2 (bundled runtime), `node:test` (JS tests).

**Spec:** `.ai-run/specs/2026-09-03-EPMCDME-14505-bundled-node-runtime.md`
**Decision record:** `.ai-run/decisions/2026-09-03-EPMCDME-14505-packaging-approach.md`

## Global Constraints

- **Windows only.** Do not touch macOS paths, the `#[cfg(target_os = "macos")]` branch in `pathman.rs`, or `assets/bin/codemie-aarch64-apple-darwin`.
- **Node version: `22.23.2`.** SHA-256 of `node-v22.23.2-win-x64.zip` is `1177b4137ba5adaa56354ae40f1080c7450e8ae09cecb47da459d1c52ac99f97`.
- **CLI package: `@codemieai/code@0.14.1`.**
- **Product name: `CodeMie Connect`** (`tauri.conf.json:productName`). Install root is `%LOCALAPPDATA%\Programs\CodeMie Connect\`. Never hardcode it — use `%~dp0`-relative addressing.
- **Shim entry point is `bin/codemie.js`, never `dist/index.js`.** `dist/index.js` is a library barrel: it exits 0 and prints nothing.
- **The CLI-tree `bundle.resources` key must be a plain directory path with NO `*`.** A glob flattens 19,754 files into 9,782 targets and reports no error.
- **Assertions are not negotiable.** No `-SkipVerify`-style switch. Every assertion checks a produced artifact, not a tool's exit code. Do not downgrade an assertion to a warning.
- Rust commands run from `src-tauri/`. JS commands run from repo root.
- Commits: conventional, ticket-scoped, matching this branch's existing log — `feat(EPMCDME-14505): <desc>`.
- Quality gates (`.ai-run/guides/quality-gates.md`): `cargo fmt --check`, `cargo clippy -- -D warnings`, `cargo test`, `npm test`.

## File Structure

| File | Responsibility | Task |
|---|---|---|
| `runtime.json` (new, root) | Single source of truth for pinned Node + CLI versions and the Node zip checksum | 1 |
| `scripts/stage-runtime.ps1` (new) | Sole producer of `assets/windows/node/node.exe` and `assets/codemie-cli/node_modules/`; writes `assets/staging-manifest.json` | 1 |
| `.gitignore` (modify) | Ignore `assets/windows/node/` and `assets/staging-manifest.json` | 1 |
| `assets/windows/bin/codemie.cmd` (modify) | Exec bundled Node against `bin/codemie.js`; propagate exit code | 2 |
| `ui/test/shim.test.mjs` (new) | Pin shim contents: `%~dp0..`, correct entry, `exit /b` | 2 |
| `src-tauri/tauri.conf.json` (modify) | Ship shim + `node.exe` + CLI tree; drop the pkg exe | 3 |
| `src-tauri/Cargo.toml` (modify) | Add `tauri-utils` dev-dependency with `resources` feature | 3 |
| `src-tauri/tests/bundle_resources.rs` (new) | Assert resource map resolves 1:1 and ships no `codemie.exe` | 3 |
| `src-tauri/src/commands/pathman.rs` (modify) | Remove `codemie.exe` from probe candidates and the `.exe` sidecar name | 4 |
| `build-installer.ps1` (rewrite) | Stage → assert → smoke-test → build → assert bundle | 5 |

---

### Task 1: Pinned versions and the staging script

**Files:**
- Create: `runtime.json`
- Create: `scripts/stage-runtime.ps1`
- Modify: `.gitignore`

**Interfaces:**
- Consumes: nothing (first task).
- Produces: `assets/windows/node/node.exe`; `assets/codemie-cli/node_modules/` (pruned); `assets/staging-manifest.json` with keys `nodeVersion` (string), `cliPackage` (string), `cliVersion` (string), `fileCount` (number), `byteSize` (number). Tasks 3, 5 depend on these paths existing.

- [ ] **Step 1: Write `runtime.json`**

```json
{
  "nodeVersion": "22.23.2",
  "nodeWin64Sha256": "1177b4137ba5adaa56354ae40f1080c7450e8ae09cecb47da459d1c52ac99f97",
  "cliPackage": "@codemieai/code",
  "cliVersion": "0.14.1"
}
```

- [ ] **Step 2: Verify the pinned Node artifact and checksum are real**

Run:
```powershell
$c = Get-Content runtime.json | ConvertFrom-Json
$u = "https://nodejs.org/dist/v$($c.nodeVersion)/SHASUMS256.txt"
(Invoke-WebRequest -Uri $u -UseBasicParsing).Content -split "`n" |
  Where-Object { $_ -match 'win-x64\.zip$' }
```
Expected: a line whose hash equals `nodeWin64Sha256`. If it differs, the pin is wrong — stop and correct `runtime.json` before continuing.

- [ ] **Step 3: Write `scripts/stage-runtime.ps1`**

```powershell
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

if ((-not (Test-Path $NodeExe)) -or ((Get-Item $NodeExe).Length -eq 0)) {
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
    Remove-Item $tmp -Recurse -Force
    Write-Host "    node.exe staged" -ForegroundColor Green
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
```

- [ ] **Step 4: Add ignore entries to `.gitignore`**

Append:
```gitignore
assets/windows/node/
assets/staging-manifest.json
```
`node_modules/` at line 6 already covers `assets/codemie-cli/node_modules/`.

- [ ] **Step 5: Run the staging script and confirm it passes**

Run: `pwsh -File .\scripts\stage-runtime.ps1`
Expected: ends with `==> Staging OK: <N> files, <M> MB` and exit code 0. `assets/windows/node/node.exe` now exists and is > 10 MB.

- [ ] **Step 6: Prove the verification block actually fails on a bad artifact**

The assertions are the deliverable — confirm they are not decorative:
```powershell
Move-Item assets\windows\node\node.exe assets\windows\node\node.exe.bak
New-Item -ItemType File assets\windows\node\node.exe | Out-Null   # 0-byte placeholder
pwsh -File .\scripts\stage-runtime.ps1
```
Expected: exits non-zero with `node.exe is only 0 bytes — expected > 10 MB`.

Then restore and re-verify:
```powershell
Remove-Item assets\windows\node\node.exe
Move-Item assets\windows\node\node.exe.bak assets\windows\node\node.exe
pwsh -File .\scripts\stage-runtime.ps1
```
Expected: `==> Staging OK`, exit 0.

- [ ] **Step 7: Commit**

```bash
git add runtime.json scripts/stage-runtime.ps1 .gitignore
git commit -m "feat(EPMCDME-14505): pin bundled Node/CLI versions and add staging script"
```

---

### Task 2: Shim rewrite

**Files:**
- Modify: `assets/windows/bin/codemie.cmd`
- Create: `ui/test/shim.test.mjs`

**Interfaces:**
- Consumes: the layout produced by Task 1, as it will appear *installed*: `node\node.exe` and `cli\node_modules\@codemieai\code\bin\codemie.js` relative to the install root.
- Produces: a shim resolving `%~dp0..` as the bundle root. Task 3 maps it to `bin/codemie.cmd`; Task 4's PATH probe finds it by the name `codemie.cmd`.

- [ ] **Step 1: Write the failing test**

Create `ui/test/shim.test.mjs`:

```javascript
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const SHIM = 'assets/windows/bin/codemie.cmd';
const shim = readFileSync(SHIM, 'utf8');

test('shim resolves the bundle root relative to its own location', () => {
  assert.match(shim, /%~dp0\.\./, 'must use %~dp0.. so the install root is not hardcoded');
  assert.doesNotMatch(shim, /CodeMie Connect/, 'must not hardcode the product name');
});

test('shim execs the bundled node runtime', () => {
  assert.match(shim, /node[\\/]node\.exe/, 'must invoke the bundled node\\node.exe');
});

// dist/index.js is a library barrel: it exits 0 and prints nothing, so a build
// gated on exit code alone would pass while `codemie --version` produced no output.
test('shim targets bin/codemie.js, never dist/index.js', () => {
  assert.match(shim, /bin[\\/]codemie\.js/, 'must target the package bin entry');
  assert.doesNotMatch(shim, /dist[\\/]index\.js/, 'dist/index.js is a barrel with no CLI bootstrap');
});

test('shim propagates the CLI exit code', () => {
  assert.match(shim, /exit \/b %ERRORLEVEL%/i, 'without this the shim always reports success');
});

test('shim does not reference the removed pkg binary', () => {
  assert.doesNotMatch(shim, /codemie\.exe/i, 'the pkg binary is no longer produced');
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test`
Expected: FAIL. The current shim contains `"%~dp0codemie.exe" %*`, so `shim execs the bundled node runtime`, `shim targets bin/codemie.js`, `shim propagates the CLI exit code`, and `shim does not reference the removed pkg binary` all fail.

- [ ] **Step 3: Rewrite the shim**

Replace the entire contents of `assets/windows/bin/codemie.cmd`:

```bat
@echo off
:: CodeMie CLI shim. Runs the bundled Node runtime against the bundled CLI tree.
:: %~dp0.. is the install root, so this file is correct regardless of where
:: CodeMie Connect is installed and needs no update if productName changes.
setlocal
set "BUNDLE_DIR=%~dp0.."
"%BUNDLE_DIR%\node\node.exe" "%BUNDLE_DIR%\cli\node_modules\@codemieai\code\bin\codemie.js" %*
exit /b %ERRORLEVEL%
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm test`
Expected: PASS — all 5 `shim.test.mjs` tests, plus the pre-existing `ui/test/*.test.mjs` suites unaffected.

- [ ] **Step 5: Verify the shim works against the staged tree**

The staged layout differs from the installed layout, so exercise the same relative contract by hand:

```powershell
& "assets\windows\node\node.exe" `
  "assets\codemie-cli\node_modules\@codemieai\code\bin\codemie.js" --version
```
Expected: prints `0.14.1`, exit code 0. **Non-empty stdout is the assertion that matters** — a wrong entry point would exit 0 silently.

- [ ] **Step 6: Commit**

```bash
git add assets/windows/bin/codemie.cmd ui/test/shim.test.mjs
git commit -m "feat(EPMCDME-14505): point shim at bundled node runtime and CLI bin entry"
```

---

### Task 3: Bundle resources and the resolution regression test

**Files:**
- Modify: `src-tauri/tauri.conf.json`
- Modify: `src-tauri/Cargo.toml`
- Create: `src-tauri/tests/bundle_resources.rs`

**Interfaces:**
- Consumes: staged paths from Task 1 and the shim from Task 2.
- Produces: installed layout `bin\codemie.cmd`, `node\node.exe`, `cli\node_modules\...`. Task 4's probe expects `bin\codemie.cmd`; Task 5 asserts all three post-build.

**Note on placement:** `.ai-run/guides/quality-gates.md` documents Rust tests as inline `#[cfg(test)]`. This one is an integration test in `tests/` because it reads `tauri.conf.json` from the package root and walks the filesystem — it is not a unit test. `[lib] name = "app_lib"` already exists, so the `tests/` directory works.

- [ ] **Step 1: Write the failing test**

Create `src-tauri/tests/bundle_resources.rs`:

```rust
//! Guards the `bundle.resources` contract in tauri.conf.json.
//!
//! A glob key (`.../**/*`) makes tauri-utils join only the file name
//! (resources.rs:196), flattening 19,754 files into 9,782 targets — 620 of
//! them onto a single `index.js`. Tauri reports `errors: 0`, so the build
//! succeeds and ships a bundle Node cannot resolve. Only this test catches it.
use std::collections::{HashMap, HashSet};
use tauri_utils::resources::ResourcePaths;

fn resources_map() -> HashMap<String, String> {
    let raw = std::fs::read_to_string("tauri.conf.json").expect("read tauri.conf.json");
    let conf: serde_json::Value = serde_json::from_str(&raw).expect("parse tauri.conf.json");
    serde_json::from_value(conf["bundle"]["resources"].clone())
        .expect("bundle.resources must be a map of source -> target")
}

#[test]
fn bundle_resources_resolve_one_to_one() {
    let map = resources_map();

    // allow_walk = true matches tauri-build-2.6.2/src/lib.rs:572
    let mut total = 0usize;
    let mut targets = HashSet::new();
    for res in ResourcePaths::from_map(&map, true).iter() {
        let r = res.expect("a bundle.resources pattern failed to resolve");
        total += 1;
        targets.insert(r.target().to_path_buf());
    }

    assert!(total > 0, "bundle.resources resolved to no files at all");
    assert_eq!(
        targets.len(),
        total,
        "bundle.resources collapses {} sources into {} targets — a glob key is \
         flattening the tree; use a plain directory path instead (spec §5)",
        total,
        targets.len()
    );
}

#[test]
fn bundle_resources_ship_no_pkg_exe() {
    for (src, target) in &resources_map() {
        assert!(
            !src.contains("codemie-x86_64-pc-windows-msvc") && !target.ends_with("codemie.exe"),
            "the pkg binary was reintroduced into bundle.resources: {src} -> {target}"
        );
    }
}
```

- [ ] **Step 2: Add the dev-dependency**

In `src-tauri/Cargo.toml`, extend the existing `[dev-dependencies]` block (currently `tempfile = "3"`):

```toml
[dev-dependencies]
tempfile = "3"
tauri-utils = { version = "2", features = ["resources"] }
```

`tauri-utils` is already a transitive dependency locked at 2.9.2, so this downloads nothing new and cannot drift from what `tauri-build` uses. `serde_json` is already in `[dependencies]`; Cargo makes it available to test targets.

- [ ] **Step 3: Run the test to verify it fails**

Run: `cd src-tauri && cargo test --test bundle_resources`
Expected: `bundle_resources_resolve_one_to_one` PASSES (the current config has only 2 single-file entries) but `bundle_resources_ship_no_pkg_exe` FAILS with:
```
the pkg binary was reintroduced into bundle.resources:
  ../assets/bin/codemie-x86_64-pc-windows-msvc.exe -> bin/codemie.exe
```

- [ ] **Step 4: Update `bundle.resources`**

In `src-tauri/tauri.conf.json`, replace the `bundle.resources` object:

```json
"resources": {
  "../assets/windows/bin/codemie.cmd": "bin/codemie.cmd",
  "../assets/windows/node/node.exe": "node/node.exe",
  "../assets/codemie-cli/node_modules": "cli/node_modules"
}
```

The CLI-tree key is a **plain directory path**. Adding `/**/*` silently reverts to the flattening behaviour the test in Step 1 exists to catch.

- [ ] **Step 5: Run the test to verify it passes**

Run: `cd src-tauri && cargo test --test bundle_resources`
Expected: both tests PASS. `bundle_resources_resolve_one_to_one` resolves ~19,700 files 1:1 in roughly 4 s.

- [ ] **Step 6: Prove the test catches the glob form**

Temporarily change the CLI-tree key to `"../assets/codemie-cli/node_modules/**/*": "cli/node_modules/"` and run:

`cd src-tauri && cargo test --test bundle_resources`

Expected: FAIL with `collapses 19754 sources into 9782 targets`. **Revert the change** and re-run to confirm PASS. This step exists because the defect is otherwise invisible — the build succeeds either way.

- [ ] **Step 7: Commit**

```bash
git add src-tauri/tauri.conf.json src-tauri/Cargo.toml src-tauri/tests/bundle_resources.rs
git commit -m "feat(EPMCDME-14505): bundle node runtime and CLI tree, drop pkg exe"
```

---

### Task 4: Remove the `codemie.exe` probe candidate

**Files:**
- Modify: `src-tauri/src/commands/pathman.rs:253` (candidate list), `:303-308` (sidecar name), plus a new inline test

**Interfaces:**
- Consumes: `bin\codemie.cmd` in the installed layout from Task 3.
- Produces: `candidate_bin_names() -> &'static [&'static str]` on Windows returns `["codemie.cmd", "codemie"]`. No signature change.

**Why this matters:** `codemie.exe` is currently probed *first*, so any stale pkg binary left by a previous install of this branch shadows the working shim and reproduces the original crash.

- [ ] **Step 1: Write the failing test**

Add to the existing `#[cfg(all(test, windows))] mod tests_windows_probe` block in `src-tauri/src/commands/pathman.rs:359`, alongside `probe_dir_detects_codemie_cmd_shim`. That module already has `use super::*; use std::fs; use tempfile::TempDir;` — add no new imports:

```rust
    /// The pkg binary is no longer produced. Leaving `codemie.exe` in the
    /// candidate list — and first, at that — means a stale binary from an
    /// earlier install shadows the shim and reproduces the crash this
    /// ticket fixes.
    #[test]
    fn candidate_bin_names_exclude_pkg_exe() {
        assert!(
            !candidate_bin_names().contains(&"codemie.exe"),
            "codemie.exe must not be a probe candidate: {:?}",
            candidate_bin_names()
        );
        assert_eq!(
            candidate_bin_names().first(),
            Some(&"codemie.cmd"),
            "the shim must be the first candidate"
        );
    }

    /// A directory holding only the stale pkg binary must not be treated as
    /// the bundled bin dir.
    #[test]
    fn probe_dir_ignores_stale_pkg_exe() {
        let dir = TempDir::new().unwrap();
        fs::write(dir.path().join("codemie.exe"), b"stale").unwrap();
        assert!(
            !probe_dir(dir.path()),
            "a directory with only codemie.exe must not be detected"
        );
    }
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd src-tauri && cargo test candidate_bin_names_exclude_pkg_exe probe_dir_ignores_stale_pkg_exe`
Expected: both FAIL — the list currently is `["codemie.exe", "codemie.cmd", "codemie"]`, so `codemie.exe` is present, is first, and `probe_dir` matches it.

- [ ] **Step 3: Remove the candidate**

`src-tauri/src/commands/pathman.rs:253` — change:

```rust
    &["codemie.exe", "codemie.cmd", "codemie"]
```
to:
```rust
    &["codemie.cmd", "codemie"]
```

- [ ] **Step 4: Remove the `.exe` sidecar name**

`src-tauri/src/commands/pathman.rs:303-308` — replace the three-way `cfg` block:

```rust
    #[cfg(target_os = "macos")]
    let sidecar_name = format!("codemie-{}-apple-darwin", std::env::consts::ARCH);
    #[cfg(target_os = "windows")]
    let sidecar_name = format!("codemie-{}-pc-windows-msvc.exe", std::env::consts::ARCH);
    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    let sidecar_name = "codemie".to_string();
```

with:

```rust
    #[cfg(target_os = "macos")]
    let sidecar_name = format!("codemie-{}-apple-darwin", std::env::consts::ARCH);
    // Windows no longer ships a sidecar binary — the shim is found by
    // candidate_bin_names() via probe_dir. macOS is unchanged.
    #[cfg(not(target_os = "macos"))]
    let sidecar_name = "codemie".to_string();
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `cd src-tauri && cargo test`
Expected: PASS, including the pre-existing `probe_dir_detects_codemie_cmd_shim` (line 366) and its `bin/` variant (line 389).

- [ ] **Step 6: Run the Rust quality gates**

Run: `cd src-tauri && cargo fmt --check && cargo clippy -- -D warnings`
Expected: both exit 0. If `clippy` flags the now-unused `.exe` formatting or an unreachable `cfg`, fix it here rather than deferring.

- [ ] **Step 7: Commit**

```bash
git add src-tauri/src/commands/pathman.rs
git commit -m "fix(EPMCDME-14505): stop probing for the removed pkg codemie.exe"
```

---

### Task 5: Rewrite `build-installer.ps1` with non-negotiable assertions

**Files:**
- Rewrite: `build-installer.ps1`

**Interfaces:**
- Consumes: `scripts/stage-runtime.ps1` (Task 1), `runtime.json` (Task 1), `assets/staging-manifest.json` (Task 1), `bundle.resources` (Task 3).
- Produces: a verified NSIS installer at `src-tauri/target/release/bundle/nsis/*-setup.exe`.

**Constraint:** every assertion below checks a produced artifact. None may be skippable. Do not add a bypass switch — the three defects this ticket fixed all returned success from their own tooling.

- [ ] **Step 1: Rewrite `build-installer.ps1`**

Replace the entire file. The pkg stage and the chalk `#imports` patch are deleted outright — Node resolves the `imports` field natively.

```powershell
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
```

- [ ] **Step 2: Verify the pre-build assertions fire**

```powershell
Move-Item assets\windows\node\node.exe assets\windows\node\node.exe.bak
.\build-installer.ps1 -SkipStage
```
Expected: exits non-zero with `missing bundled runtime: ...node.exe`, **before** any Tauri build starts. Restore:
```powershell
Move-Item assets\windows\node\node.exe.bak assets\windows\node\node.exe
```

- [ ] **Step 3: Verify the smoke-test assertion fires on a wrong entry point**

Temporarily change `$CliEntry` in `build-installer.ps1` to the barrel:
```powershell
$CliEntry = Join-Path $CliModules "@codemieai\code\dist\index.js"
```
Run: `.\build-installer.ps1 -SkipStage`
Expected: exits non-zero with `staged CLI produced NO output...`. This is the assertion that catches an exit-0 failure. **Revert `$CliEntry`** to `bin\codemie.js`.

- [ ] **Step 4: Run the full build**

Run: `.\build-installer.ps1`
Expected: all five stages pass, ending with `==> Done — all assertions passed.` and a `*-setup.exe` path. Record the reported installer size.

- [ ] **Step 5: Commit**

```bash
git add build-installer.ps1
git commit -m "feat(EPMCDME-14505): replace pkg build with staged runtime and mandatory artifact assertions"
```

---

### Task 6: Clean-machine verification

**Files:** none — this task produces evidence, not code.

**Interfaces:**
- Consumes: the installer from Task 5.
- Produces: a pass/fail record for each acceptance criterion that cannot be tested locally.

No CI exists for this repo, so this manual gate is the only thing that exercises the end-to-end install path. The original defect passed every local check and failed only here.

- [ ] **Step 1: Run all local gates one final time**

```bash
cd src-tauri && cargo fmt --check && cargo clippy -- -D warnings && cargo test
cd .. && npm test
```
Expected: all exit 0.

- [ ] **Step 2: Install on a clean Windows VM**

Use a Windows VM or fresh user account with **no** Node.js and **no** npm (`where node` and `where npm` must both find nothing). Run the `*-setup.exe`.

Record: whether any UAC credential prompt appeared. Expected: none.

- [ ] **Step 3: Verify the CLI in a fresh shell**

Open a **new** `cmd.exe` (PATH changes need a fresh shell), then:
```
where codemie
codemie --version
```
Expected: `where` resolves to `%LOCALAPPDATA%\Programs\CodeMie Connect\bin\codemie.cmd`; `--version` prints `0.14.1` and exits 0.

A blank line here means the shim's entry point is wrong. A `[pkg]` error means a stale `codemie.exe` is still on PATH from a previous install — uninstall it first.

- [ ] **Step 4: Verify agent installation**

Run: `codemie install claude`
Expected: completes end-to-end using only the bundled runtime.

- [ ] **Step 5: Verify PATH scope and uninstall**

```powershell
reg query "HKCU\Environment" /v PATH
reg query "HKLM\SYSTEM\CurrentControlSet\Control\Session Manager\Environment" /v PATH
```
Expected: the install `bin` dir appears in `HKCU` only, never `HKLM`.

Then uninstall and re-query `HKCU\Environment`. Expected: the entry is gone, and `%USERPROFILE%\.codemie` still exists.

- [ ] **Step 6: Record results in the ticket artifacts**

Write findings to `docs/superpowers/tasks/2026-09-02-EPMCDME-14505-bundle-shim-runtime-path/clean-vm-verification.md`: one line per acceptance criterion with PASS/FAIL, the installer size, and the Windows build tested.

- [ ] **Step 7: Commit**

```bash
git add docs/superpowers/tasks/2026-09-02-EPMCDME-14505-bundle-shim-runtime-path/clean-vm-verification.md
git commit -m "docs(EPMCDME-14505): record clean-VM verification results"
```

---

## Self-Review

**Spec coverage.** Every spec section maps to a task: §1 pinned versions → Task 1; §2 staging script → Task 1; §3 prune list → Task 1 Step 3; §4 shim → Task 2; §5 bundle resources → Task 3; §6 build verification → Task 5; §7 `pathman.rs` → Task 4; §7a regression test → Task 3; §8 (`installer-hooks.nsi` unchanged) → no task, correctly. Acceptance criteria requiring a clean machine → Task 6.

**Type consistency.** `candidate_bin_names()` keeps its `&'static [&'static str]` signature (Task 4). `resources_map() -> HashMap<String, String>` is defined once in Task 3 and used by both tests there. Manifest keys (`nodeVersion`, `cliPackage`, `cliVersion`, `noBaseline`, `fileCount`, `byteSize`) are written in Task 1 Step 3 and read in Task 5 Step 1 under the same names.

**Deliberate omissions, with reasons:**
- The `-baseline` prune defaults to *off* and is exposed as `-NoBaseline`. Shipping without it breaks `codemie-opencode` on CPUs lacking modern SIMD — a product decision, not an implementer's.
- `-SkipStage` exists on `build-installer.ps1` for iteration speed but explicitly does **not** skip verification.
- The `cli-updater` npm advice and the upstream `const __filename` idiom are follow-ups in the decision record, not tasks here.
