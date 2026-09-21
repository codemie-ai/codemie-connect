# Clean-VM Verification — EPMCDME-14505

## Status: PARTIAL — local gates PASS, clean-VM install PENDING

## Local Gates (Step 1)

All run on: 2026-09-04, Windows 11 Enterprise 10.0.26100

| Gate | Command | Result |
|---|---|---|
| cargo fmt --check | `cd src-tauri && cargo fmt --check` | PASS / EXIT=0 |
| cargo clippy | `cd src-tauri && cargo clippy -- -D warnings` | PASS / EXIT=0 |
| cargo test | `cd src-tauri && cargo test` | PASS / 62 tests |
| npm test | `npm test` | PASS / 24 tests |

## Clean-VM Acceptance Criteria (Steps 2-5 — PENDING)

These require a clean Windows user account (no Node.js, no npm) and the built NSIS installer.

**Prerequisites:**
- Run `.\build-installer.ps1` to completion (full Tauri build, ~20 min)
- A fresh Windows user account or VM where `where node` and `where npm` find nothing

### Step 2: Install
- [ ] Run `*-setup.exe` — PENDING
- [ ] Expected: no UAC credential prompt (currentUser install mode)
- [ ] Result: PENDING

### Step 3: Verify CLI in fresh shell
- [ ] `where codemie` → expected: `%LOCALAPPDATA%\Programs\CodeMie Connect\bin\codemie.cmd` — PENDING
- [ ] `codemie --version` → expected: `0.14.1` — PENDING
- [ ] Result: PENDING

### Step 4: Verify agent installation
- [ ] `codemie install claude` → expected: completes using only bundled runtime — PENDING
- [ ] Result: PENDING

### Step 5: Verify PATH scope and uninstall
- [ ] `reg query "HKCU\Environment" /v PATH` shows install bin dir — PENDING
- [ ] PATH entry NOT in HKLM — PENDING
- [ ] After uninstall: PATH entry removed, `%USERPROFILE%\.codemie` still present — PENDING
- [ ] Result: PENDING

## Installer Details (when built)
- Installer size: PENDING
- Windows version tested: PENDING
- Node version bundled: 22.23.2
- CLI version bundled: 0.14.1 (@codemieai/code)
