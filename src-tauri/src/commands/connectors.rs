// Presence checks for external tool connectors (Claude Desktop, Codex Desktop,
// VS Code extensions) feeding the Connections screen. Each field reports
// whether a CodeMie-managed config is currently applied for that tool — not
// whether the tool itself is installed.
use serde::Serialize;
#[cfg(target_os = "macos")]
use std::path::Path;

#[derive(Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct ConnectorStatus {
    pub claude_desktop: bool,
    pub codex_desktop: bool,
    pub vscode_copilot: bool,
    pub vscode_claude_code: bool,
}

/// Claude Desktop is "connected" when its configLibrary's currently-applied
/// entry (per `_meta.json`'s `appliedId`) exists on disk and still carries
/// gateway settings. `disconnect` doesn't delete the file or clear
/// `appliedId` (so a later `connect` can reuse the same config id) — it
/// strips the managed keys, leaving `{}` when nothing else was in the file.
/// Mirrors `codex_desktop_connected`'s content check below.
#[cfg(target_os = "macos")]
fn claude_desktop_connected(base_dir: &Path) -> bool {
    let meta_path = base_dir.join("configLibrary/_meta.json");
    let Ok(raw) = std::fs::read_to_string(&meta_path) else {
        return false;
    };
    let Ok(json) = serde_json::from_str::<serde_json::Value>(&raw) else {
        return false;
    };
    let Some(applied_id) = json.get("appliedId").and_then(|v| v.as_str()) else {
        return false;
    };
    let applied_path = base_dir
        .join("configLibrary")
        .join(format!("{applied_id}.json"));
    std::fs::read_to_string(&applied_path)
        .map(
            |s| match serde_json::from_str::<serde_json::Value>(s.trim()) {
                // Only an empty object counts as "stripped" — anything else
                // (including unparseable content, since disconnect always leaves
                // valid JSON behind) is treated as still carrying gateway settings.
                Ok(serde_json::Value::Object(map)) => !map.is_empty(),
                _ => !s.trim().is_empty(),
            },
        )
        .unwrap_or(false)
}

/// Codex Desktop is "connected" when CodeMie's proxy has written a non-empty
/// state file. A successful `disconnect` doesn't delete the file — it
/// overwrites it with an empty string — so `exists()` alone can't tell a live
/// connection from an already-disconnected one.
#[cfg(target_os = "macos")]
fn codex_desktop_connected(state_file: &Path) -> bool {
    std::fs::read_to_string(state_file)
        .map(|s| !s.trim().is_empty())
        .unwrap_or(false)
}

/// VS Code Copilot Chat (BYOK) is "connected" when its chat model provider
/// list contains a CodeMie-managed custom endpoint entry.
///
/// Parsed as JSONC (comments/trailing commas), not strict JSON: both this
/// file and `settings.json` below are VS Code user config, which VS Code
/// itself writes/accepts in JSONC form — a strict parse silently rejects a
/// file a user hand-edited with a trailing comma, permanently reporting
/// "not connected" even right after a real connect.
fn vscode_copilot_connected(raw: &str) -> bool {
    let Ok(arr) = jsonc_parser::parse_to_serde_value::<Vec<serde_json::Value>>(
        raw,
        &jsonc_parser::ParseOptions::default(),
    ) else {
        return false;
    };
    arr.iter().any(|p| {
        p.get("vendor").and_then(|v| v.as_str()) == Some("customendpoint")
            && p.get("name").and_then(|v| v.as_str()) == Some("CodeMie")
    })
}

/// VS Code Claude Code extension is "connected" when its settings define both
/// the CodeMie-managed base URL and auth token env vars. JSONC, see
/// `vscode_copilot_connected` doc comment above for why.
fn vscode_claude_code_connected(raw: &str) -> bool {
    let Ok(json) = jsonc_parser::parse_to_serde_value::<serde_json::Value>(
        raw,
        &jsonc_parser::ParseOptions::default(),
    ) else {
        return false;
    };
    let Some(vars) = json
        .get("claudeCode.environmentVariables")
        .and_then(|v| v.as_array())
    else {
        return false;
    };
    let names: Vec<&str> = vars
        .iter()
        .filter_map(|e| e.get("name").and_then(|n| n.as_str()))
        .collect();
    names.contains(&"ANTHROPIC_BASE_URL") && names.contains(&"ANTHROPIC_AUTH_TOKEN")
}

/// Resolves the user's home dir from HOME (or USERPROFILE on Windows). `None`
/// when neither is set — callers must treat that as "can't check", not build
/// paths against an empty/root fallback.
#[cfg(target_os = "macos")]
fn home_dir() -> Option<String> {
    std::env::var("HOME")
        .or_else(|_| std::env::var("USERPROFILE"))
        .ok()
}

/// macOS-only: all connector config paths live under
/// `~/Library/Application Support/...`. Returns all-false (via `None` HOME,
/// or on any other target OS) rather than resolving paths against a bogus
/// root — connectors.rs has no Windows/Linux path support yet.
#[tauri::command]
pub fn check_connector_status() -> ConnectorStatus {
    #[cfg(target_os = "macos")]
    {
        let Some(home) = home_dir() else {
            return ConnectorStatus::default();
        };
        let claude_base = Path::new(&home).join("Library/Application Support/Claude-3p");
        let codex_state = Path::new(&home).join(".codemie/proxy/codex-desktop-state.json");

        let vscode_chat_models_path = |dir: &str| {
            Path::new(&home).join(format!(
                "Library/Application Support/{dir}/User/chatLanguageModels.json"
            ))
        };
        // Read both stable and Insiders variants and OR the parsed result —
        // gating the Insiders read on the stable file being empty/missing
        // would skip it whenever a non-matching (but valid) stable file exists.
        let stable_chat =
            std::fs::read_to_string(vscode_chat_models_path("Code")).unwrap_or_default();
        let insiders_chat =
            std::fs::read_to_string(vscode_chat_models_path("Code - Insiders")).unwrap_or_default();

        let vscode_settings_path = |dir: &str| {
            Path::new(&home).join(format!(
                "Library/Application Support/{dir}/User/settings.json"
            ))
        };
        let stable_settings =
            std::fs::read_to_string(vscode_settings_path("Code")).unwrap_or_default();
        let insiders_settings =
            std::fs::read_to_string(vscode_settings_path("Code - Insiders")).unwrap_or_default();

        ConnectorStatus {
            claude_desktop: claude_desktop_connected(&claude_base),
            codex_desktop: codex_desktop_connected(&codex_state),
            vscode_copilot: vscode_copilot_connected(&stable_chat)
                || vscode_copilot_connected(&insiders_chat),
            vscode_claude_code: vscode_claude_code_connected(&stable_settings)
                || vscode_claude_code_connected(&insiders_settings),
        }
    }
    #[cfg(not(target_os = "macos"))]
    {
        ConnectorStatus::default()
    }
}

/// Best-effort "is this app installed" signal: does `/Applications/<name>.app`
/// or `~/Applications/<name>.app` exist? Bundle names are assumed from
/// convention, not confirmed with the product team — flagged for
/// verification, not a hard blocker. macOS-only, like check_connector_status.
#[tauri::command]
pub fn app_bundle_exists(name: String) -> bool {
    #[cfg(target_os = "macos")]
    {
        Path::new("/Applications")
            .join(format!("{name}.app"))
            .exists()
            || home_dir()
                .map(|home| {
                    Path::new(&home)
                        .join("Applications")
                        .join(format!("{name}.app"))
                        .exists()
                })
                .unwrap_or(false)
    }
    #[cfg(not(target_os = "macos"))]
    {
        false
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::path::PathBuf;

    fn tempdir_for_test(name: &str) -> PathBuf {
        tempfile::tempdir().unwrap().keep().join(name)
    }

    #[test]
    fn claude_desktop_connected_when_meta_and_applied_file_exist() {
        let tmp = tempdir_for_test("claude-ok");
        fs::create_dir_all(tmp.join("configLibrary")).unwrap();
        fs::write(
            tmp.join("configLibrary/_meta.json"),
            r#"{"appliedId":"abc"}"#,
        )
        .unwrap();
        fs::write(
            tmp.join("configLibrary/abc.json"),
            r#"{"inferenceProvider":"gateway"}"#,
        )
        .unwrap();
        assert!(claude_desktop_connected(&tmp));
    }

    #[test]
    fn claude_desktop_not_connected_when_applied_file_emptied_by_disconnect() {
        let tmp = tempdir_for_test("claude-disconnected");
        fs::create_dir_all(tmp.join("configLibrary")).unwrap();
        fs::write(
            tmp.join("configLibrary/_meta.json"),
            r#"{"appliedId":"abc"}"#,
        )
        .unwrap();
        fs::write(tmp.join("configLibrary/abc.json"), "{}").unwrap();
        assert!(!claude_desktop_connected(&tmp));
    }

    #[test]
    fn claude_desktop_not_connected_when_applied_file_is_whitespace_variant_empty_object() {
        let tmp = tempdir_for_test("claude-disconnected-whitespace");
        fs::create_dir_all(tmp.join("configLibrary")).unwrap();
        fs::write(
            tmp.join("configLibrary/_meta.json"),
            r#"{"appliedId":"abc"}"#,
        )
        .unwrap();
        fs::write(tmp.join("configLibrary/abc.json"), "{ }").unwrap();
        assert!(!claude_desktop_connected(&tmp));
    }

    #[test]
    fn claude_desktop_not_connected_when_applied_file_missing() {
        let tmp = tempdir_for_test("claude-stale");
        fs::create_dir_all(tmp.join("configLibrary")).unwrap();
        fs::write(
            tmp.join("configLibrary/_meta.json"),
            r#"{"appliedId":"missing"}"#,
        )
        .unwrap();
        assert!(!claude_desktop_connected(&tmp));
    }

    #[test]
    fn claude_desktop_not_connected_when_meta_absent_or_malformed() {
        let tmp = tempdir_for_test("claude-none");
        assert!(!claude_desktop_connected(&tmp));
        fs::create_dir_all(tmp.join("configLibrary")).unwrap();
        fs::write(tmp.join("configLibrary/_meta.json"), "not json").unwrap();
        assert!(!claude_desktop_connected(&tmp));
    }

    #[test]
    fn codex_desktop_connected_when_state_file_has_content() {
        let tmp = tempdir_for_test("codex-ok");
        fs::write(&tmp, "{}").unwrap(); // state file path itself, not a dir
        assert!(codex_desktop_connected(&tmp));
    }

    #[test]
    fn codex_desktop_not_connected_when_state_file_absent() {
        let tmp = tempdir_for_test("codex-missing/state.json");
        assert!(!codex_desktop_connected(&tmp));
    }

    #[test]
    fn codex_desktop_not_connected_when_state_file_emptied_by_disconnect() {
        let tmp = tempdir_for_test("codex-disconnected");
        fs::write(&tmp, "").unwrap(); // `disconnect` overwrites with "" rather than deleting
        assert!(!codex_desktop_connected(&tmp));
    }

    #[test]
    fn vscode_copilot_connected_when_codemie_entry_present() {
        let raw = r#"[{"vendor":"other","name":"X"},
                      {"vendor":"customendpoint","name":"CodeMie"}]"#;
        assert!(vscode_copilot_connected(raw));
    }

    #[test]
    fn vscode_copilot_not_connected_without_matching_entry() {
        assert!(!vscode_copilot_connected(
            r#"[{"vendor":"other","name":"X"}]"#
        ));
    }

    #[test]
    fn vscode_copilot_not_connected_on_malformed_or_missing_json() {
        assert!(!vscode_copilot_connected("not json"));
        assert!(!vscode_copilot_connected(""));
    }

    #[test]
    fn vscode_claude_code_connected_when_both_env_entries_present() {
        let raw = r#"{"claudeCode.environmentVariables":[
            {"name":"ANTHROPIC_BASE_URL","value":"x"},
            {"name":"ANTHROPIC_AUTH_TOKEN","value":"y"}]}"#;
        assert!(vscode_claude_code_connected(raw));
    }

    #[test]
    fn vscode_claude_code_not_connected_when_one_entry_missing() {
        let raw =
            r#"{"claudeCode.environmentVariables":[{"name":"ANTHROPIC_BASE_URL","value":"x"}]}"#;
        assert!(!vscode_claude_code_connected(raw));
    }

    #[test]
    fn vscode_copilot_connected_with_trailing_comma_jsonc() {
        // Real VS Code settings/config files are JSONC: users' editors (and VS Code
        // itself) commonly leave a trailing comma. A strict serde_json parse would
        // reject this and silently report "not connected" forever.
        let raw = r#"[{"vendor":"customendpoint","name":"CodeMie"},]"#;
        assert!(vscode_copilot_connected(raw));
    }

    #[test]
    fn vscode_claude_code_connected_with_trailing_comma_and_url_value() {
        // Mirrors a real captured settings.json: trailing comma after the array,
        // and a gateway URL value containing `//` — must not be mistaken for a
        // JSONC line comment by whatever parses this.
        let raw = r#"{
            "editor.fontSize": 14,
            "claudeCode.environmentVariables": [
                {"name":"ANTHROPIC_BASE_URL","value":"http://127.0.0.1:4001"},
                {"name":"ANTHROPIC_AUTH_TOKEN","value":"codemie-proxy"}
            ],
        }"#;
        assert!(vscode_claude_code_connected(raw));
    }

    #[test]
    fn vscode_claude_code_not_connected_without_the_key_or_on_malformed_json() {
        assert!(!vscode_claude_code_connected(r#"{"other":"x"}"#));
        assert!(!vscode_claude_code_connected("not json"));
    }

    #[test]
    fn app_bundle_exists_true_when_bundle_present() {
        assert!(app_bundle_exists("Safari".to_string()));
    }

    #[test]
    fn app_bundle_exists_false_when_bundle_absent() {
        assert!(!app_bundle_exists(
            "Definitely Not A Real App 12345".to_string()
        ));
    }
}
