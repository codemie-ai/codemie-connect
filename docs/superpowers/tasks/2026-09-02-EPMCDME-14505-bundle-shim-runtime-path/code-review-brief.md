# Code review — 2026-09-02-EPMCDME-14505-bundle-shim-runtime-path (2026-09-04)

**approve** · confidence: high · 0 blocking · 9 resolved · 0 unresolved
Coverage: targeted verifier ✓  (9/9 prior blocking findings graded)

## Finding status

- `assets/windows/bin/codemie.cmd` — CR-001 **resolved**: if-not-exist guards for node.exe and CLI JS entry-point added before invocation
- `src-tauri/src/commands/codemie_config.rs:96` — CR-002 **resolved**: USERPROFILE fallback via `.or_else(|_| var("USERPROFILE"))` at line 98-100
- `src-tauri/src/commands/downloader.rs:80` — CR-003 **resolved**: MAX_DOWNLOAD_BYTES = 512 MB cap with per-chunk abort; pre-allocation bounded
- `src-tauri/src/commands/handshake.rs:60` — CR-004 **resolved**: version_cmd injectable closure; `global_version_populated_via_injectable_version_cmd` test asserts `Some("2.0.1")`
- `src-tauri/src/commands/pty.rs:109` — CR-005 **resolved**: `guard.is_some()` check returns `Err("PTY already active")` before overwriting occupied slot
- `src-tauri/src/commands/runner.rs:149` — CR-006 **resolved**: `tokio::time::timeout(120s)` wraps node.exe subprocess; timeout maps to `InstallerError::Other`
- `src-tauri/tauri.conf.json:30` — CR-007 **resolved**: node.exe and codemie.cmd moved to tauri.windows.conf.json; macOS DMG no longer carries Windows artifacts
- `ui/renderer.js:608` — CR-008 **resolved**: probe set updated to `['2.3.3','2.3.5','2.4']`; zero-step guard emits PROBE_ERR instead of false-green pass
- commit history — CR-009 **resolved**: git filter-branch exited 0 at current HEAD; commit messages rewritten per git-workflow.md

## Checked and clean

commit-format resolved via CR-009 · code-quality — n/a · security — n/a
