# EPMCDME-14505 — Per-user install, uninstall, and existing-CLI handshake

## Goal

Remove the admin-elevated Node/Git/CLI acquisition flow from the installer, wire a download integrity check into `downloader.rs`, and expose a typed IPC command so the frontend can warn users about a pre-existing global npm CodeMie installation.

## Background

The app ships a bundled Node runtime (EPMCDME-14504/EPMCDME-14573). With that in place the installer no longer needs to download Node, Git CLT, or the CodeMie CLI — those steps required admin elevation and were the last blocker to a fully per-user installation. The NSIS installer already uses `installMode: currentUser` and the macOS DMG requires no admin; the packaging side is complete. What remains is removing the acquisition logic from every layer that references it, guarding downloads against truncation and tampering, and surfacing a typed IPC result that S12/EPMCDME-14515 will use to render the handshake warning card.

---

## Work Clusters

### Cluster 1 — Delete the Admin-Elevated Acquisition Flow

Remove all Git/Node/CLI acquisition logic across six synchronization layers. Missing any one causes a compile error or a dead UI step.

**Deletion targets:**

| Layer | File | What to remove |
|---|---|---|
| 1 | `config/steps.yaml` | Steps `1.1`, `1.1.1`, `1.3` |
| 2 | `config/steps-windows.yaml` | Steps `1.0`, `1.1`, `1.1.1`, `1.2`, `1.2.1`, `1.3` |
| 3 | `src-tauri/src/commands/installer.rs` | `install_node`, `install_git_clt`, `node_pkg_url`, `sudo_exec` functions and their unit tests |
| 4 | `src-tauri/src/lib.rs` | `install_node`, `install_git_clt` entries in invoke_handler |
| 5 | `ui/handlers.js:109-142` | Step `1.3` handler (npm-prefix writability check + global install); handler entries for `1.1`, `1.1.1`, `1.2`, `1.2.1` |
| 6 | `ui/runner-bridge.js` | Exports corresponding to removed handlers |

**Mandatory same-change cleanup:**

- `src-tauri/src/commands/error.rs`: remove `InstallerError::Sudo` — becomes dead code once `sudo_exec` is deleted; `cargo clippy -D warnings` hard-fails on unreachable enum variants.
- `ui/renderer.js:20` `INSTALL_ONLY_IDS`: remove `'1.2'` and `'1.2.1'` entries — those step IDs will no longer exist on either platform.

**Test rewrite:** `src-tauri/src/steps.rs` `loads_eight_steps_with_defaults` currently asserts 8 macOS steps but macOS YAML already has only 6 (test is stale). Rewrite to assert the actual post-deletion step count for each platform.

---

### Cluster 2 — Download Integrity Check

`src-tauri/src/commands/downloader.rs` currently performs no verification after download. Add the following function and call it for every download path before the payload is written or forwarded:

```rust
pub fn verify_download(data: &[u8], expected_hash: Option<&str>) -> Result<(), DownloaderError>
```

Behavior:
- Rejects empty or zero-length `data` unconditionally (truncation guard).
- When `expected_hash` is `Some(hash)`: computes SHA-256 over `data`; returns `Err` if the hex digest does not match.
- When `expected_hash` is `None`: only the truncation guard applies. Modified-but-correct-size files are not caught until S5 ships and passes the expected hash value.

No new dependencies are introduced if `sha2` is already in `Cargo.toml`; verify before adding.

---

### Cluster 3 — Handshake Precedence Detection

Add a new Tauri IPC command `check_handshake_state` that determines whether a global npm CodeMie exists and which installation will take precedence at runtime.

**Return type (new):**

```rust
#[derive(serde::Serialize)]
pub struct HandshakeState {
    pub global_found: bool,
    pub global_version: Option<String>,
    pub bundled_takes_precedence: bool,
}
```

**Detection rules:**

- `global_found`: probe for a global npm CodeMie using the pre-injection PATH — before `inject_bundled_bin_path` (EPMCDME-14573) prepends the bundled bin dir. Reference logic: `inspector.rs:64-68`.
- `global_version`: populated via `check_codemie_version` logic (`inspector.rs:93-96`) when `global_found` is true; `None` otherwise.
- `bundled_takes_precedence`: `true` when the bundled bin dir from `inject_bundled_bin_path` appears earlier in the resolved PATH than the npm global bin dir.

Register the command in `src-tauri/src/lib.rs` invoke_handler and export through `ui/runner-bridge.js`. Rendering this result as the handshake card is deferred to S12/EPMCDME-14515 — this ticket delivers the IPC contract only.

---

## Acceptance Criteria

| Ticket AC | Satisfied by |
|---|---|
| No-Node machine installs from download, app starts without terminal | Cluster 1 deletion; NSIS `currentUser` + DMG no-admin already in place |
| Installation never prompts for admin credential | Cluster 1 deletion; per-user packaging already complete |
| Removing the app leaves `~/.codemie` in place | NSIS `currentUser` default behavior — manual verification required (no NSIS script in repo) |
| Unwritable install location stops with location+reason, leaves nothing behind | Existing error handling in `downloader.rs`; confirm no partial write on error path |
| Truncated/modified downloaded file stops without installing | Cluster 2: `verify_download` rejects empty data; SHA-256 mismatch when hash provided |
| Pre-existing global npm CodeMie — warn which will take precedence before any change | Cluster 3: `check_handshake_state` exposes detection + precedence result |

---

## Test Coverage Requirements

- `verify_download`: unit tests for (a) empty input, (b) hash mismatch, (c) hash match, (d) `None` hash with non-empty data.
- `check_handshake_state`: unit tests for global-found path and global-not-found path (mock the subprocess or use a test double).
- `steps.rs`: rewritten step-count assertion for macOS and Windows post-deletion counts.
- `installer.rs` `#[cfg(test)]` block: delete `node_pkg_url` and `node_pkg_url_builds_official_universal_url` tests with their functions; retain or add coverage for `parse_npm_latest` and `fetch_codemie_latest`.

---

## Non-goals

- Bundled runtime acquisition, packaging, or PATH injection — EPMCDME-14504 / EPMCDME-14573.
- Handshake card UI rendering — S12/EPMCDME-14515; this ticket delivers the IPC contract only.
- Profile management or any read/write of `~/.codemie` content.
- Auto-migration from a global npm CodeMie install to the bundled install.
- Uninstaller behavior beyond the per-user NSIS default.
- Hash manifest delivery, storage, or signing — S5 responsibility; this ticket adds the verification hook only.
- Any step outside the six deletion layers listed above.

---

## Open Risks

- **Handshake PATH coupling**: `check_handshake_state` correctness depends on `inject_bundled_bin_path` from EPMCDME-14573 being merged and stable; PATH injection order must be preserved across any rebase.
- **Partial integrity protection until S5**: `verify_download` with `expected_hash: None` rejects truncated files but passes a modified-but-correct-size payload; this is the accepted interim state.
- **NSIS uninstall behavior unverifiable**: the `~/.codemie`-stays AC cannot be confirmed from this codebase; a Windows smoke-test on a clean machine is required before marking the AC complete.
