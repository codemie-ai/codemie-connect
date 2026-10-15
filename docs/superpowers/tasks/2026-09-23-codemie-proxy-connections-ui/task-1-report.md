DONE

## Commit
`f8fc38f` — EPMCDME-14574 : Add Claude/Codex desktop connector presence checks (task 1/8)

## Changed files (git show --stat HEAD)
- src-tauri/src/commands/connectors.rs (new, 113 lines)
- src-tauri/src/commands/mod.rs (+1: `pub mod connectors;`)
- src-tauri/src/lib.rs (+1: `commands::connectors::check_connector_status,` registered in `invoke_handler!`, alongside `commands::codemie_config::read_codemie_config`)

Nothing else touched.

## Deviation from plan
The plan's test command used `-p codemie-installer`, but the actual Cargo package name in
`src-tauri/Cargo.toml` is `app` (lib name `app_lib`) — `codemie-installer` does not exist as a
package ID in this repo. Substituted `-p app` for all cargo invocations; everything else matches
the plan verbatim.

## Test command run (RED then GREEN)
```
cd src-tauri && cargo test -p app connectors::tests -- --nocapture > .../test.local.log 2>&1; echo "EXIT=$?"; tail -40 .../test.local.log
```

GREEN output tail:
```
running 5 tests
test commands::connectors::tests::codex_desktop_not_connected_when_state_file_absent ... ok
test commands::connectors::tests::codex_desktop_connected_when_state_file_exists ... ok
test commands::connectors::tests::claude_desktop_not_connected_when_meta_absent_or_malformed ... ok
test commands::connectors::tests::claude_desktop_not_connected_when_applied_file_missing ... ok
test commands::connectors::tests::claude_desktop_connected_when_meta_and_applied_file_exist ... ok

test result: ok. 5 passed; 0 failed; 0 ignored; 0 measured; 91 filtered out; finished in 0.00s
```
EXIT=0

Before committing, also ran (both green):
- `cargo build -p app` — exit 0, crate compiles, `invoke_handler!` registration is syntactically
  correct.
- `cargo test -p app` (full suite) — 96 passed, 0 failed (plus 2 passed in
  `tests/bundle_resources.rs`), confirming no regressions to Tasks 2/3's starting point.

## Implementation notes
- `ConnectorStatus` struct with `claude_desktop`, `codex_desktop`, `vscode_copilot` (stub `false`),
  `vscode_claude_code` (stub `false`), `Serialize` + `camelCase` rename, per spec.
- `claude_desktop_connected(base_dir: &Path)` and `codex_desktop_connected(state_file: &Path)` are
  pure functions taking `&Path`, mirroring `codemie_config.rs`'s `config_path_with(home)` seam —
  no test touches real `$HOME`.
- `check_connector_status()` resolves `$HOME` (falling back to `USERPROFILE`, then empty string),
  joins `Library/Application Support/Claude-3p` and `.codemie/proxy/codex-desktop-state.json`,
  matching the `config_path()` pattern in `codemie_config.rs`.
- Test-only `tempdir_for_test(name: &str) -> PathBuf` uses `tempfile::tempdir().unwrap().keep()`
  (leaked, OS-cleaned scratch dirs) joined with `name` — satisfies both the plain-name calls and the
  `"codex-missing/state.json"` non-existent nested-path call, since `Path::join` treats the whole
  string as path components without requiring the intermediate dir to exist.

## Concerns
None. Left `vscode_copilot`/`vscode_claude_code` as `false` stubs for Tasks 2/3 as instructed; did
not touch any file outside the three listed.
