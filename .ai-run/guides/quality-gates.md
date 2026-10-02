# Quality Gates

Gates ordered fastest to slowest. All Rust commands run from `src-tauri/`; JS commands run from the repo root.

---

### Format Check (Rust)

**Run**: `cd src-tauri && cargo fmt --check`
**Pass**: exits 0, no output
**Fail**: lists files that would be reformatted; indicates unformatted Rust code
**Auto-fix**: `cd src-tauri && cargo fmt`

---

### Lint (Rust)

**Run**: `cd src-tauri && cargo clippy -- -D warnings`
**Pass**: exits 0, warnings treated as errors
**Fail**: prints clippy diagnostics with file:line references
**Auto-fix**: some lints have `cargo clippy --fix` suggestions; others require manual edits

---

### Unit Tests — JS

**Run**: `npm test` (from repo root)
**Pass**: all `node:test` suites in `ui/test/*.test.mjs` exit 0
**Fail**: TAP output shows failing assertion and file:line
**Skip if**: no UI logic was changed (Rust-only changes)

---

### Unit Tests — Rust

**Run**: `cd src-tauri && cargo test`
**Pass**: all tests pass; `test result: ok` summary printed
**Fail**: failing test name, assertion, and file:line printed
**Note**: Rust unit tests live inline in each module under `#[cfg(test)]` — see `src-tauri/src/commands/runner.rs:129`, `src-tauri/src/commands/logger.rs:67`

---

### Build

**Prerequisite (both platforms)**: the bundled runtime must be staged once per checkout or `tauri-build` aborts every cargo command with `resource path ... doesn't exist`. macOS: `scripts/stage-runtime.sh` (it also refreshes the tracked `assets/codemie-cli/package.json` and `package-lock.json`, which the app embeds at compile time). Windows: `scripts\stage-runtime.ps1`. The staged tree is gitignored and survives branch switches; worktrees need their own.
**Run**: `./build-installer.sh` (macOS) or `.\build-installer.ps1` (Windows). Both stage, assert every artifact, build, then assert the produced bundle. There is no switch to skip verification.
**Pass**: `Done. All assertions passed.` with the app and DMG (macOS) or the NSIS setup exe (Windows) paths
**Fail**: the first failing assertion names the missing, empty or non-executable path
**Plain Tauri build**: `cd src-tauri && CI=true cargo tauri build` still works but verifies nothing; use it only for UI-only changes
**Skip if**: logic-only change verified by tests; skip to save ~2–5 min build time
