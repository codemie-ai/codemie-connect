DONE

## Summary

Task 3 of 8 (Connections Screen, Rust side): implemented `vscode_claude_code_connected()` in
`src-tauri/src/commands/connectors.rs` and wired it into `check_connector_status()`, replacing the
hardcoded `false`. All 4 `ConnectorStatus` fields are now computed from real checks (no stubs
remain).

## Commit

`bfd650eed98f9e1e324f6595b2534ad75e1d3b9a` — "EPMCDME-14574 : Add VS Code Claude Code extension
connector presence check (task 3/8)"

`git show --stat HEAD`:
```
src-tauri/src/commands/connectors.rs | 50 +++++++++++++++++++++++++++++++++++-
1 file changed, 49 insertions(+), 1 deletion(-)
```
Only the owned file changed — no other files touched.

## Implementation

- Added `vscode_claude_code_connected(raw: &str) -> bool`: parses `raw` as JSON, reads
  `claudeCode.environmentVariables` array, checks both `ANTHROPIC_BASE_URL` and
  `ANTHROPIC_AUTH_TOKEN` names are present. Malformed JSON or missing key returns `false`, never
  panics (uses `let ... else` early returns, same pattern as Task 2's `vscode_copilot_connected`).
- Wired into `check_connector_status()`: reads
  `~/Library/Application Support/Code/User/settings.json`, falling back to
  `Code - Insiders` if `Code`'s file is missing/empty — mirrors Task 2's
  `chatLanguageModels.json` read pattern exactly.
- Added 3 tests per plan spec to `mod tests` (RED confirmed before implementation, GREEN after).

## Test-first evidence

RED (before implementation): `cargo test -p app connectors::tests -- --nocapture` →
`error[E0425]: cannot find function vscode_claude_code_connected` (EXIT=101).

GREEN (after implementation):

Command:
```
cd src-tauri && cargo test -p app connectors:: -- --nocapture > .../test.local.log 2>&1; echo "EXIT=$?"; tail -50 .../test.local.log
```

Tail output:
```
running 11 tests
test commands::connectors::tests::codex_desktop_not_connected_when_state_file_absent ... ok
test commands::connectors::tests::vscode_copilot_connected_when_codemie_entry_present ... ok
test commands::connectors::tests::vscode_copilot_not_connected_without_matching_entry ... ok
test commands::connectors::tests::vscode_copilot_not_connected_on_malformed_or_missing_json ... ok
test commands::connectors::tests::vscode_claude_code_not_connected_without_the_key_or_on_malformed_json ... ok
test commands::connectors::tests::vscode_claude_code_not_connected_when_one_entry_missing ... ok
test commands::connectors::tests::vscode_claude_code_connected_when_both_env_entries_present ... ok
test commands::connectors::tests::codex_desktop_connected_when_state_file_exists ... ok
test commands::connectors::tests::claude_desktop_not_connected_when_meta_absent_or_malformed ... ok
test commands::connectors::tests::claude_desktop_not_connected_when_applied_file_missing ... ok
test commands::connectors::tests::claude_desktop_connected_when_meta_and_applied_file_exist ... ok

test result: ok. 11 passed; 0 failed; 0 ignored; 0 measured; 91 filtered out; finished in 0.00s
```
EXIT=0.

Full suite regression check: `cargo test -p app` → `test result: ok. 102 passed; 0 failed;`
(plus 2 bundle_resources tests, 0 doc-tests). No regressions to Task 1/2 tests.

## Concerns

None. `#[tauri::command]` attribute on `check_connector_status()` was already present from Task 1
(no changes needed there per plan's "if not already present" caveat).
