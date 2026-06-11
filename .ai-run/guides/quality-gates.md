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

**Run**: `cd src-tauri && CI=true cargo tauri build`
**Pass**: DMG lands in `src-tauri/target/release/bundle/dmg/`
**Fail**: Rust compile error or Tauri bundle error printed to stderr
**Universal build**: `rustup target add x86_64-apple-darwin aarch64-apple-darwin && CI=true cargo tauri build --target universal-apple-darwin`
**Skip if**: logic-only change verified by tests; skip to save ~2–5 min build time
