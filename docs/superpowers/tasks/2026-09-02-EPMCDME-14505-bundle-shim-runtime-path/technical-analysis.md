# Technical Analysis — EPMCDME-14505
## CodeMie Desktop: Per-user install, uninstall, and existing-CLI handshake

research_path: filesystem  
layers: config/steps-yaml, Rust-commands/installer, Rust-commands/inspector, Rust-commands/pathman, JS-handlers, JS-runner-bridge, JS-renderer, tauri-conf/bundle, Rust-lib/invoke-handler  
risks: 9

---

## Section 1 — Task Summary

Ticket: EPMCDME-14505 — Sub-task S2 of EPMCDME-14350. Depends on S1/EPMCDME-14504 (bundled runtime, current branch EPMCDME-14573-bundle-shim-runtime-path).

Three work clusters:
1. **Delete** the admin-elevated Git/Node/CLI acquisition flow across six synchronization layers
2. **Wire** a download integrity check into `downloader.rs`
3. **Expose** a precedence-warning using existing `check_codemie` and `check_codemie_version` inspector commands

---

## Section 2 — Architecture Context

Five layers are affected simultaneously:
- Two YAML step-plan files embedded at compile time (`config/steps.yaml`, `config/steps-windows.yaml`)
- A multi-platform Rust command module (`src-tauri/src/commands/installer.rs`)
- The JS handler table and bridge (`ui/handlers.js`, `ui/runner-bridge.js`)
- The JS renderer bootstrap (`ui/renderer.js`)
- The Tauri bundle manifest (`src-tauri/tauri.conf.json`)

---

## Section 3 — Current State Evidence

**`src-tauri/tauri.conf.json`**: `bundle.targets: ["dmg","nsis"]`; `bundle.windows.nsis.installMode: "currentUser"` — per-user Windows install already configured. No `node/` or `cli/` entries under `bundle.resources` (lib.rs comment at line 27 explicitly defers those to this ticket). macOS `bundle.macOS.minimumSystemVersion: "10.15"` with no admin requirement. **Per-user installer packaging is already complete.**

**`config/steps.yaml` (macOS)**: Current live steps are `1.1` (Check Git), `1.1.1` (Install Git CLT), `1.3` (Install CodeMie), `2.3.3`, `2.3.5`, `2.4`. Steps `1.2`/`1.2.1` (Node check/install) are **absent** — the macOS YAML is already partially trimmed.

**`config/steps-windows.yaml`**: Still has the full pre-S2 set: `1.0`, `1.1`, `1.1.1`, `1.2`, `1.2.1`, `1.3`, `2.3.3`, `2.3.5`, `2.4`.

**`src-tauri/src/commands/inspector.rs:64-68`** (`check_codemie`): Runs `codemie --help`; treats non-zero exit with non-empty output as "found"; treats exit 127/"command not found" as "not found". `check_codemie_version` (line 93-96) extracts semver from `codemie --version`. Both registered in `lib.rs` and exported in `runner-bridge.js`. These are the hooks for handshake detection — no new Rust commands needed.

**`ui/handlers.js:109-142`** (step 1.3): npm-prefix writability check → redirects to `~/.npm-global` if unwritable → `npm install -g @codemieai/code` → re-probes binary. Entirety targeted for deletion.

---

## Section 4 — Deletion Sync Points (Six Layers)

| Layer | File | What to delete |
|---|---|---|
| 1 | `config/steps.yaml` | Steps `1.1`, `1.1.1`, `1.3` entries |
| 2 | `config/steps-windows.yaml` | Steps `1.0`, `1.1`, `1.1.1`, `1.2`, `1.2.1`, `1.3` entries |
| 3 | `src-tauri/src/commands/installer.rs` | `install_node`, `install_git_clt`, `node_pkg_url`, `sudo_exec` functions |
| 4 | `src-tauri/src/lib.rs` | `install_node`, `install_git_clt` registrations in invoke_handler |
| 5 | `ui/handlers.js` | Steps `1.1`, `1.1.1`, `1.2`, `1.2.1`, `1.3` handler entries |
| 6 | `ui/runner-bridge.js` | Corresponding exports |

Additionally: `ui/renderer.js:20` `INSTALL_ONLY_IDS` constant needs update.

---

## Section 5 — New Work Required

**Integrity check** (`src-tauri/src/commands/downloader.rs`): No hash or size verification after download; AC requires truncated/modified files to be rejected. Need to add SHA-256 or size check before proceeding.

**Precedence warning** (detection side): Use `check_codemie_version` (existing) vs `inspect_bundled_bin_path` (S1 branch) to determine if a global npm codemie is installed and establish which will take precedence. Expose a new IPC command or extend existing for the handshake result. Rendering is deferred to S12/EPMCDME-14515.

---

## Codebase Findings

The per-user installer packaging is complete — NSIS `installMode: currentUser` is set and DMG requires no admin. The remaining implementation is:
1. **Six-layer deletion** of the Git/Node/CLI acquisition flow (synchronized changes required)
2. **Error type cleanup** — `InstallerError::Sudo` in `error.rs` becomes unreachable once `install_node` is deleted; must prune to avoid `cargo clippy -D warnings` failure
3. **Test rewrite** — `src-tauri/src/steps.rs` test `loads_eight_steps_with_defaults` expects 8 macOS steps but macOS YAML only has 6; the test is already stale and must be rewritten post-deletion
4. **Download integrity check** — new logic in `downloader.rs` (AC: truncated/modified file stops without installing)
5. **Precedence warning** — detection + IPC exposure using existing inspector commands; rendering deferred to S12

Handshake precedence depends on `inject_bundled_bin_path` from EPMCDME-14573 (current branch), creating tight coupling with S1.

---

## Section 6 — Risk Indicators

1. **`src-tauri/src/steps.rs` test is stale**: `loads_eight_steps_with_defaults` expects 8 macOS steps but macOS YAML only has 6 (`1.2`/`1.2.1` absent). This test fails today and must be rewritten as part of deletion work.

2. **`INSTALL_ONLY_IDS` in `ui/renderer.js:20`** includes `'1.2'`, `'1.2.1'` which are absent from macOS YAML and will be removed from Windows too; the constant must be updated or removed entirely.

3. **Six-layer sync requirement**: Deleting acquisition steps requires consistent changes across `config/steps.yaml`, `config/steps-windows.yaml`, `src-tauri/src/steps.rs` test, `ui/handlers.js`, `src-tauri/src/lib.rs` invoke-handler block, and `ui/runner-bridge.js`. Any one missed causes compile errors or dead UI states.

4. **`InstallerError::Sudo` orphaned after `install_node` deletion**: `sudo_exec` is macOS-only and called only by `install_node`. Removing `install_node` leaves `InstallerError::Sudo` unreachable; `cargo clippy -D warnings` will fail on dead variant. `error.rs` needs a matching prune.

5. **No integrity check in `downloader.rs`**: AC requires truncated/modified files to be rejected; `downloader.rs` currently performs no hash or size verification after download.

6. **NSIS uninstaller `~/.codemie` behavior unverifiable in this repo**: The AC "Removing the app leaves `~/.codemie` in place" depends on Tauri's generated NSIS script. No NSIS script or test harness exists in this repository to confirm it. Manual verification item.

7. **`handlers.js` has no `'1.2'`/`'1.2.1'` handlers**: Windows steps `1.2` and `1.2.1` in `steps-windows.yaml` auto-complete silently via engine fallback (`handler ? await handler() : true`). Deletion removes the symptom but surfaces that these steps were never implemented.

8. **Handshake precedence depends on S1 PATH injection**: `inject_bundled_bin_path` from EPMCDME-14573 (current branch) determines that the bundled CLI resolves ahead of global npm. The handshake warning logic must reason about the same PATH order that `inject_bundled_bin_path` establishes — tight coupling with the S1 branch.

9. **`node_pkg_url` / `node_pkg_url_builds_official_universal_url` tests in `installer.rs`**: Two unit tests cover `node_pkg_url` and one covers `parse_npm_latest`. All three will be deleted with the function; the test file's `#[cfg(test)]` block needs to retain coverage for remaining functions (`parse_npm_latest`, `fetch_codemie_latest`).

---

## Section 7 — Summary for Complexity Assessment

The task touches five distinct layers simultaneously: two YAML step-plan files (embedded at compile time), a multi-platform Rust command module (`installer.rs`), the JS handler table and bridge (`handlers.js`, `runner-bridge.js`), the JS renderer bootstrap (`renderer.js`), and the Tauri bundle manifest (`tauri.conf.json`). The per-user installer packaging is already complete — NSIS `installMode: currentUser` is set and DMG requires no admin — so that sub-criterion is satisfied. The remaining work falls into three clusters: (a) delete the Git/Node/CLI acquisition flow across all five layers in sync, (b) wire a download integrity check into `downloader.rs`, and (c) expose a precedence-warning surface using the already-registered `check_codemie` and `check_codemie_version` inspector commands.

Technical novelty is moderate. The deletion cluster is straightforward but has six synchronization points that must move together. Missing any one leaves the build broken (compile error) or the UI presenting dead steps. The handshake detection reuses existing Rust commands; the precedence logic itself belongs here while rendering is deferred to S12/EPMCDME-14515 — the seam is clean because `check_codemie_version` returns a `String` and `inspect_bundled_bin_path` already prepends the bundled dir to PATH, making the resolution deterministic.

Test coverage posture is the main risk area. The `steps.rs` non-Windows test currently asserts eight macOS steps but macOS YAML only has six — this test is already mismatched and will need rewriting after deletion. `install_node` and `node_pkg_url` have unit tests that will be deleted along with the functions. No test exists for the handshake/precedence logic, the integrity-check path in `downloader.rs`, or the uninstall leave-`~/.codemie`-intact requirement. The `InstallerError::Sudo` variant in `error.rs` is only reachable through `install_node` → `sudo_exec`; removing that path without pruning the variant will cause a dead-code clippy warning that blocks the quality gate.

---

## Section 8 — External References

All six paths named by task_context were resolved and read:

- **`src-tauri/tauri.conf.json`**: `bundle.targets: ["dmg","nsis"]`; `bundle.windows.nsis.installMode: "currentUser"` — per-user Windows install already configured.
- **`config/steps.yaml`** (macOS): 6 steps, no `1.2`/`1.2.1` — partially trimmed already.
- **`config/steps-windows.yaml`**: Full pre-S2 set with all 8 steps including `1.0`, `1.2`, `1.2.1`.
- **`src-tauri/src/commands/inspector.rs:64-68`**: `check_codemie` and `check_codemie_version` both registered and exposed — detection primitives ready to use.
- **`ui/handlers.js:109-142`**: Step 1.3 handler with npm-prefix writability and global install logic — entirety targeted for deletion.
- **`src-tauri/src/lib.rs`**: `install_node`, `install_git_clt` registered in invoke_handler — must be removed.
