# Windows managed-CLI auto-update (EPMCDME-16840) Implementation Plan

**Goal:** Replace the in-place `win::update_cli` with check, staged install, `--version` validation, then swap; any failure leaves the current CLI untouched.

**Architecture:** All changes are in `src-tauri/src/commands/runtime.rs`. Version helpers move to a non-cfg `shared` module used by `mac` and `win`. The swap renames only `<key>\cli` (runtime-key layout, shim, `remove_stale` and `.complete` unchanged). The decision core takes closures so tests need no npm or network. No frontend change.

**Conventions:** Commit per task using the repository's existing convention. Run Rust commands from `src-tauri/` (`cargo fmt`, `cargo clippy -- -D warnings`, `cargo test`). Windows tests run only on Windows.

---

### Task 1 — Share version helpers between mac and win

**Files:** Modify `src-tauri/src/commands/runtime.rs` (`mod mac`: `REGISTRY_LATEST` :67, `reports_version` :128, `newer` :142).

- [ ] Add a non-cfg `mod shared` (before `mod mac`, ~:42) holding `REGISTRY_LATEST`, `reports_version`, `newer` moved unchanged (pub(super)). In `mod mac` replace them with `use super::shared::{newer, reports_version, REGISTRY_LATEST};` so the existing mac tests (:503-707) compile untouched.

**Test-first:** no — pure move; existing `newer`/`reports_version` tests cover it, `cargo test` stays green.

### Task 2 — Staged swap core with restore-on-failure (`win`)

**Files:** Modify `runtime.rs` `mod win`: `npm_install_cli` :1190, `INSTALL_LOCK` :1005; tests near :1280-1524.

- [ ] `npm_install_cli`: take `version: &str` instead of reading `cfg.cli_version`; update its one existing caller in `install_sync` (:1105) to pass `&cfg.cli_version`.
- [ ] Hoist `INSTALL_LOCK` from inside `ensure_runtime` to module level (same static) so `update_cli` can take it.
- [ ] Add `fn apply_update(dir: &Path, version: &str, install: impl FnOnce(&Path) -> CmdResult<()>, validate: impl FnOnce(&Path) -> bool) -> CmdResult<()>`:
  - stage = `dir.with_file_name(format!(".update-{version}-{pid}-{nanos}"))` with `stage\cli` created; `install(&stage)` then `validate(&stage)` (false -> `InstallerError::Other`).
  - Swap using `rename_retry`: live `dir\cli` -> `dir\.old-cli`, `stage\cli` -> `dir\cli`; if the second rename fails, rename `.old-cli` back and return the error. On success delete `.old-cli`.
  - Always `remove_dir_all(stage)` on exit. Do not touch `.complete`, `node`, or the runtime-key dir name.

**Test-first:** yes — tests in `mod tests` (Windows block) using a tempdir runtime with `dir\cli\marker.txt = "old"`:
  (a) `apply_update` with an install closure writing `stage\cli\marker.txt = "new"` and `validate` true -> `dir\cli\marker.txt == "new"`, stage and `.old-cli` gone.
  (b) install closure returning `Err`, and separately `validate` returning false -> `Err`, `dir\cli\marker.txt == "old"`, stage removed.

### Task 3 — Rewrite `win::update_cli`

**Files:** Modify `runtime.rs` `mod win::update_cli` :1240-1278.

- [ ] Skip (`Ok(None)`) when `existing_cli || smoke_mode()` or `!is_ready(runtime_dir())`.
- [ ] Current version = `version` field of `dir\cli\node_modules\@codemieai\code\package.json` (serde_json; no value -> `Ok(None)`). Latest = GET `shared::REGISTRY_LATEST` with a reqwest client (copy the 30s/60s timeouts from `mac::client` :244), `["version"]`. `!newer(latest, current)` -> `Ok(None)`.
- [ ] Under `INSTALL_LOCK`, in `spawn_blocking`, call `apply_update` with: install = `npm_install_cli(&cfg, &node_dir(dir), &stage.join("cli"), latest)` then write `connect_json_path(stage)` with `CONNECT_JSON`; validate = run `node_exe` on `cli_entry(stage)` with `--version`, `reports_version(last stdout line, latest)`. Then `remove_stale(&base, &runtime_key(&cfg))`.
- [ ] Log success (`info`, "CodeMie CLI updated to {v}") and failure (`warn`) via `logger::write_line`, as `mac::update_cli` :292 does; return `Ok(Some(latest))` on success so the UI refreshes agents; errors return `Ok(None)`/`Err` as mac does (non-fatal at the call site `ui/renderer.js:897`).
- [ ] Optionally update `.ai-run/guides/architecture/architecture.md:52` with one line on the Windows flow.

**Test-first:** no — network/process glue; the decision logic is covered by Task 2 tests. Verified by the quality gates the calling flow runs.

---

**Negative-constraints:** honored — no symlinks (rename only, Task 2); runtime-key layout, shim, `remove_stale` unchanged (Tasks 2-3); helpers reused/moved, not duplicated (Task 1); no whole-suite gate or browser tasks in this plan; failure never mutates the live CLI (Task 2 restore).

**Known ceiling (ponytail):** `--version` validation and `npm install` have no timeout; add one (mac uses 600s/60s) if hangs are observed. A running CLI that locks `dir\cli` makes the swap fail and restore, so the update is retried next launch.
