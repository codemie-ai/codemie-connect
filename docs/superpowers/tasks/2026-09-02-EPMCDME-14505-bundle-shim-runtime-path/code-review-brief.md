# Code review — 2026-09-02-EPMCDME-14505-bundle-shim-runtime-path (2026-09-03)

**request-changes** · confidence: low · 9 unresolved · 6 resolved · 0 superseded
Coverage: targeted verifier ✓  (all 15 prior blocking findings graded)

## Look here first

- `assets/windows/bin/codemie.cmd:3` — [infra] existence check for bundled node.exe not added — CR-001
- `src-tauri/src/commands/pty.rs:109` — [infra] spawn_pty slot-overwrite guard not added; prior child leaks — CR-009
- `src-tauri/src/commands/pty.rs:193` — [infra] pty_kill run_id validation not added; race kills wrong process — CR-010
- `src-tauri/src/commands/downloader.rs:56` — [security] Vec::with_capacity still uncapped from Content-Length — CR-003
- `src-tauri/src/commands/codemie_config.rs:96` — [infra] USERPROFILE fallback missing on Windows — CR-002

## Also flagged

- `src-tauri/src/commands/runner.rs:149` — [infra] self_update_direct has no timeout; hangs if node.exe stalls — CR-011
- `ui/renderer.js:607` — [other] probe safe-set still references deleted step IDs; probe always false-green — CR-014
- `tauri.conf.json:30` — [config] Windows .cmd unconditionally bundled into macOS DMG — CR-012
- (commit history) — [other] five commits violate documented commit-format standard — CR-015

## Resolved

- CR-004 — `expected_sha256` parameter forwarded to `verify_download`; SHA-256 now live in production path
- CR-005 — path validation added: absolute, no `..`, must be within `temp_dir()`
- CR-006 — `parse_global_version` strips leading `v`; v-prefixed semver now detected
- CR-007 — `detect_handshake_state` wrapped in `tokio::task::spawn_blocking`
- CR-008 — `fetch_codemie_latest` test added
- CR-013 — `INSTALL_ONLY_IDS` updated to `['2.3.3', '2.3.5', '2.4']`; Install only tile no longer produces empty step set

## Checked and clean

Standards and business_review carried forward from final round — `review-standards` is a final-round actor and does not re-run on check.
