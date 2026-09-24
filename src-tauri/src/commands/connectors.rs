// Presence checks for external tool connectors (Claude Desktop, Codex Desktop,
// VS Code extensions) feeding the Connections screen. Each field reports
// whether a CodeMie-managed config is currently applied for that tool — not
// whether the tool itself is installed.
use serde::Serialize;
use std::path::Path;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConnectorStatus {
    pub claude_desktop: bool,
    pub codex_desktop: bool,
    pub vscode_copilot: bool,
    pub vscode_claude_code: bool,
}

/// Claude Desktop is "connected" when its configLibrary's currently-applied
/// entry (per `_meta.json`'s `appliedId`) still exists on disk.
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
    base_dir
        .join("configLibrary")
        .join(format!("{applied_id}.json"))
        .exists()
}

/// Codex Desktop is "connected" when CodeMie's proxy has written its state file.
fn codex_desktop_connected(state_file: &Path) -> bool {
    state_file.exists()
}

/// VS Code Copilot Chat (BYOK) is "connected" when its chat model provider
/// list contains a CodeMie-managed custom endpoint entry.
fn vscode_copilot_connected(raw: &str) -> bool {
    let Ok(arr) = serde_json::from_str::<Vec<serde_json::Value>>(raw) else {
        return false;
    };
    arr.iter().any(|p| {
        p.get("vendor").and_then(|v| v.as_str()) == Some("customendpoint")
            && p.get("name").and_then(|v| v.as_str()) == Some("CodeMie")
    })
}

/// VS Code Claude Code extension is "connected" when its settings define both
/// the CodeMie-managed base URL and auth token env vars.
fn vscode_claude_code_connected(raw: &str) -> bool {
    let Ok(json) = serde_json::from_str::<serde_json::Value>(raw) else {
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

fn home_dir() -> String {
    std::env::var("HOME")
        .or_else(|_| std::env::var("USERPROFILE"))
        .unwrap_or_default()
}

#[tauri::command]
pub fn check_connector_status() -> ConnectorStatus {
    let home = home_dir();
    let claude_base = Path::new(&home).join("Library/Application Support/Claude-3p");
    let codex_state = Path::new(&home).join(".codemie/proxy/codex-desktop-state.json");

    let vscode_chat_models_path = |dir: &str| {
        Path::new(&home).join(format!(
            "Library/Application Support/{dir}/User/chatLanguageModels.json"
        ))
    };
    let raw = std::fs::read_to_string(vscode_chat_models_path("Code"))
        .ok()
        .filter(|s| !s.is_empty())
        .or_else(|| std::fs::read_to_string(vscode_chat_models_path("Code - Insiders")).ok())
        .unwrap_or_default();

    let vscode_settings_path = |dir: &str| {
        Path::new(&home).join(format!(
            "Library/Application Support/{dir}/User/settings.json"
        ))
    };
    let settings_raw = std::fs::read_to_string(vscode_settings_path("Code"))
        .ok()
        .filter(|s| !s.is_empty())
        .or_else(|| std::fs::read_to_string(vscode_settings_path("Code - Insiders")).ok())
        .unwrap_or_default();

    ConnectorStatus {
        claude_desktop: claude_desktop_connected(&claude_base),
        codex_desktop: codex_desktop_connected(&codex_state),
        vscode_copilot: vscode_copilot_connected(&raw),
        vscode_claude_code: vscode_claude_code_connected(&settings_raw),
    }
}

/// Best-effort "is this app installed" signal: does `/Applications/<name>.app`
/// exist? Bundle names are assumed from convention, not confirmed with the
/// product team — flagged for verification, not a hard blocker.
#[tauri::command]
pub fn app_bundle_exists(name: String) -> bool {
    Path::new("/Applications")
        .join(format!("{name}.app"))
        .exists()
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
        fs::write(tmp.join("configLibrary/abc.json"), "{}").unwrap();
        assert!(claude_desktop_connected(&tmp));
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
    fn codex_desktop_connected_when_state_file_exists() {
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
