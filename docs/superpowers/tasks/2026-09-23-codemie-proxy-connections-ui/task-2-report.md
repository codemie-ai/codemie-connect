DONE

## Task 2: Rust — VS Code Copilot Chat (BYOK) presence check

Commit: `1f0dfdd17f346f0e81f8efaac25f5e3bea0b154e`
"EPMCDME-14574 : Add VS Code Copilot Chat (BYOK) connector presence check (task 2/8)"

Changed files (confirmed via `git show --stat HEAD`):
- `src-tauri/src/commands/connectors.rs` (only file changed, +49/-2)

## What was done

1. Added 3 failing tests to the existing `mod tests` block (RED — confirmed
   compile failure: `cannot find function vscode_copilot_connected`).
2. Implemented `fn vscode_copilot_connected(raw: &str) -> bool` exactly per
   plan: parses `raw` as `Vec<serde_json::Value>`, returns `false` on parse
   failure (malformed/empty JSON never panics), true if any entry has
   `vendor == "customendpoint"` and `name == "CodeMie"`.
3. Wired into `check_connector_status()`: reads
   `~/Library/Application Support/Code/User/chatLanguageModels.json` via the
   same `home_dir()`/`Path::new(&home)` pattern already used for
   `claude_base`/`codex_state`; if that read fails or the file is empty,
   falls back to the `Code - Insiders` variant; if neither exists, passes
   `""` to `vscode_copilot_connected` (which returns `false`). Did not touch
   `claude_desktop_connected`, `codex_desktop_connected`, `ConnectorStatus`,
   or Task 1's existing tests — only added.
4. Ran `cargo fmt -p app` (rustfmt reformatted this file only, including some
   pre-existing Task 1 lines that hadn't been fmt'd — no logic changes; still
   the only file in the commit).

## Test commands + output

RED (before implementation):
```
cd src-tauri && cargo test -p app connectors::tests -- --nocapture
EXIT=101
error[E0425]: cannot find function `vscode_copilot_connected` in this scope
   (x4, one per new test call site)
```

GREEN (after implementation), exact command from the task:
```
cd src-tauri && cargo test -p app connectors::tests -- --nocapture > .../test.local.log 2>&1; echo "EXIT=$?"; tail -40 .../test.local.log
```
Tail output:
```
EXIT=0
running 8 tests
test commands::connectors::tests::vscode_copilot_not_connected_on_malformed_or_missing_json ... ok
test commands::connectors::tests::vscode_copilot_connected_when_codemie_entry_present ... ok
test commands::connectors::tests::vscode_copilot_not_connected_without_matching_entry ... ok
test commands::connectors::tests::codex_desktop_not_connected_when_state_file_absent ... ok
test commands::connectors::tests::codex_desktop_connected_when_state_file_exists ... ok
test commands::connectors::tests::claude_desktop_not_connected_when_applied_file_missing ... ok
test commands::connectors::tests::claude_desktop_not_connected_when_meta_absent_or_malformed ... ok
test commands::connectors::tests::claude_desktop_connected_when_meta_and_applied_file_exist ... ok

test result: ok. 8 passed; 0 failed; 0 ignored; 0 measured; 91 filtered out; finished in 0.00s
```
(log persisted at
`docs/superpowers/tasks/2026-09-23-codemie-proxy-connections-ui/test.local.log`)

Full-crate regression check: `cargo test -p app` → `test result: ok. 99 passed; 0 failed`
(all Task 1 tests + rest of crate unaffected), plus `bundle_resources` (2
passed) and doc-tests (0).

## Verification

- Tests GREEN (exit 0), including Task 1's pre-existing 5 connector tests.
- `git show --stat HEAD` shows exactly `src-tauri/src/commands/connectors.rs`
  changed — nothing else.
- Work is committed (`1f0dfdd`).

## Concerns

None. Malformed/empty `chatLanguageModels.json` is handled defensively
(`serde_json::from_str` failure → `false`, never panics), matching the
plan's Review Focus requirement.
