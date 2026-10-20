// Presence checks for external tool connectors (Claude Desktop, Codex Desktop,
// VS Code extensions) feeding the Connections screen. Each field reports
// whether a CodeMie-managed config is currently applied for that tool — not
// whether the tool itself is installed.
use serde::Serialize;
use std::path::{Path, PathBuf};

#[derive(Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct ConnectorStatus {
    pub claude_desktop: bool,
    pub codex_desktop: bool,
    pub vscode_copilot: bool,
    pub vscode_claude_code: bool,
}

/// The keys `codemie proxy connect --claude-desktop` writes into the applied
/// config and `disconnect` removes (CLI proxy/connectors/desktop.ts,
/// INFERENCE_KEYS). The user's own settings can share the file, so only these
/// say whether CodeMie is set up there.
const CLAUDE_GATEWAY_KEYS: [&str; 4] = [
    "inferenceProvider",
    "inferenceGatewayBaseUrl",
    "inferenceGatewayApiKey",
    "inferenceGatewayAuthScheme",
];

/// Claude Desktop is "connected" when its configLibrary's currently-applied
/// entry (per `_meta.json`'s `appliedId`) still carries CodeMie's gateway
/// keys. `disconnect` keeps the file and `appliedId` (so a later `connect`
/// reuses the same config id) and strips only CodeMie's keys, so a file left
/// holding the user's own settings is not a connection.
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
        .ok()
        .and_then(|s| serde_json::from_str::<serde_json::Value>(s.trim()).ok())
        .and_then(|v| v.as_object().cloned())
        .is_some_and(|map| CLAUDE_GATEWAY_KEYS.iter().any(|k| map.contains_key(*k)))
}

/// Codex Desktop is "connected" when CodeMie's proxy has written a non-empty
/// state file. A successful `disconnect` doesn't delete the file — it
/// overwrites it with an empty string — so `exists()` alone can't tell a live
/// connection from an already-disconnected one.
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
fn home_dir() -> Option<String> {
    std::env::var("HOME")
        .or_else(|_| std::env::var("USERPROFILE"))
        .ok()
        .filter(|h| !h.is_empty())
}

/// Where the CLI writes each connector's config, per OS. Mirrors the CLI's own
/// resolvers (proxy/connectors/*.ts): Claude Desktop under
/// `~/Library/Application Support/Claude-3p` on macOS and
/// `%LOCALAPPDATA%\Claude-3p` on Windows, VS Code's `User` dir under
/// Application Support on macOS and `%APPDATA%` on Windows, and the Codex
/// state file under `~/.codemie/proxy` everywhere.
struct ConnectorPaths {
    claude_base: PathBuf,
    codex_state: PathBuf,
    vscode_user_dirs: Vec<PathBuf>,
}

fn connector_paths(
    windows: bool,
    home: &Path,
    appdata: Option<&Path>,
    local_appdata: Option<&Path>,
) -> ConnectorPaths {
    let codex_state = home
        .join(".codemie")
        .join("proxy")
        .join("codex-desktop-state.json");
    if windows {
        let local = local_appdata
            .map(Path::to_path_buf)
            .unwrap_or_else(|| home.join("AppData").join("Local"));
        let roaming = appdata
            .map(Path::to_path_buf)
            .unwrap_or_else(|| home.join("AppData").join("Roaming"));
        ConnectorPaths {
            claude_base: local.join("Claude-3p"),
            codex_state,
            vscode_user_dirs: ["Code", "Code - Insiders"]
                .iter()
                .map(|d| roaming.join(d).join("User"))
                .collect(),
        }
    } else {
        let support = home.join("Library").join("Application Support");
        ConnectorPaths {
            claude_base: support.join("Claude-3p"),
            codex_state,
            vscode_user_dirs: ["Code", "Code - Insiders"]
                .iter()
                .map(|d| support.join(d).join("User"))
                .collect(),
        }
    }
}

fn read_or_empty(path: &Path) -> String {
    std::fs::read_to_string(path).unwrap_or_default()
}

/// Whether a CodeMie-managed config is applied for each connector. Every
/// VS Code edition (stable and Insiders) is read and OR-ed: gating Insiders on
/// the stable file being empty would skip it whenever a valid but non-matching
/// stable file exists. Returns all-false when no home dir can be resolved.
#[tauri::command]
pub fn check_connector_status() -> ConnectorStatus {
    let Some(home) = home_dir() else {
        return ConnectorStatus::default();
    };
    let appdata = std::env::var_os("APPDATA").map(PathBuf::from);
    let local_appdata = std::env::var_os("LOCALAPPDATA").map(PathBuf::from);
    let paths = connector_paths(
        cfg!(windows),
        Path::new(&home),
        appdata.as_deref(),
        local_appdata.as_deref(),
    );
    let any_vscode = |file: &str, check: fn(&str) -> bool| {
        paths
            .vscode_user_dirs
            .iter()
            .any(|dir| check(&read_or_empty(&dir.join(file))))
    };
    ConnectorStatus {
        claude_desktop: claude_desktop_connected(&paths.claude_base),
        codex_desktop: codex_desktop_connected(&paths.codex_state),
        vscode_copilot: any_vscode("chatLanguageModels.json", vscode_copilot_connected),
        vscode_claude_code: any_vscode("settings.json", vscode_claude_code_connected),
    }
}

/// Where the CLI looks for each app on Windows (client-install.ts
/// `windowsApplicationDirs` + `getCodexDesktopAppCandidates`), as full paths.
fn windows_app_paths(name: &str, local: &Path, pf: &Path, pf_x86: &Path) -> Vec<PathBuf> {
    match name {
        "Visual Studio Code" => vec![
            pf.join("Microsoft VS Code").join("Code.exe"),
            pf_x86.join("Microsoft VS Code").join("Code.exe"),
            local
                .join("Programs")
                .join("Microsoft VS Code")
                .join("Code.exe"),
        ],
        "Claude" => vec![local.join("AnthropicClaude").join("claude.exe")],
        "ChatGPT" => vec![local.join("Programs").join("ChatGPT"), pf.join("ChatGPT")],
        _ => vec![],
    }
}

/// A Microsoft Store (MSIX) ChatGPT has no predictable folder, but the
/// per-user package registry lists it by name; `reg query` exits 0 on a match.
#[cfg(windows)]
fn store_package_installed(name: &str) -> bool {
    use std::os::windows::process::CommandExt;
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    std::process::Command::new("reg")
        .args([
            "query",
            r"HKCU\Software\Classes\Local Settings\Software\Microsoft\Windows\CurrentVersion\AppModel\Repository\Packages",
            "/f",
            name,
            "/k",
        ])
        .creation_flags(CREATE_NO_WINDOW)
        .output()
        .map(|o| o.status.success())
        .unwrap_or(false)
}

#[cfg(not(windows))]
fn store_package_installed(_name: &str) -> bool {
    false
}

fn windows_app_installed(name: &str) -> bool {
    let env = |k: &str, d: &str| PathBuf::from(std::env::var(k).unwrap_or_else(|_| d.to_string()));
    let local = std::env::var("LOCALAPPDATA")
        .map(PathBuf::from)
        .unwrap_or_else(|_| {
            PathBuf::from(home_dir().unwrap_or_default())
                .join("AppData")
                .join("Local")
        });
    let paths = windows_app_paths(
        name,
        &local,
        &env("ProgramFiles", r"C:\Program Files"),
        &env("ProgramFiles(x86)", r"C:\Program Files (x86)"),
    );
    paths.iter().any(|p| p.exists()) || (name == "ChatGPT" && store_package_installed(name))
}

/// Best-effort "is this app installed" signal. On macOS: does
/// `/Applications/<name>.app` or `~/Applications/<name>.app` exist. On
/// Windows: the same places the CLI checks, plus a Store install of ChatGPT.
/// Other platforms have no install location to check, so the answer is
/// "assume yes": a wrong "not installed" would hide the only way to connect,
/// while a wrong "installed" just lets the CLI report the missing app itself.
#[tauri::command]
pub fn app_bundle_exists(name: String) -> bool {
    if cfg!(windows) {
        return windows_app_installed(&name);
    }
    if !cfg!(target_os = "macos") {
        return true;
    }
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

    // What the CLI's disconnect really leaves when the user had a setting of
    // their own in the file (measured with PR #580's build, 2026-10-01).
    #[test]
    fn claude_desktop_not_connected_when_only_user_settings_are_left() {
        let tmp = tempdir_for_test("claude-user-left");
        fs::create_dir_all(tmp.join("configLibrary")).unwrap();
        fs::write(
            tmp.join("configLibrary/_meta.json"),
            r#"{"appliedId":"abc"}"#,
        )
        .unwrap();
        fs::write(
            tmp.join("configLibrary/abc.json"),
            r#"{"isClaudeCodeForDesktopEnabled":true}"#,
        )
        .unwrap();
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

    #[cfg(target_os = "macos")]
    #[test]
    fn app_bundle_exists_true_when_bundle_present() {
        assert!(app_bundle_exists("Safari".to_string()));
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn app_bundle_exists_false_when_bundle_absent() {
        assert!(!app_bundle_exists(
            "Definitely Not A Real App 12345".to_string()
        ));
    }

    #[cfg(windows)]
    #[test]
    fn app_bundle_exists_false_when_app_absent_on_windows() {
        assert!(!app_bundle_exists("ChatGPT-Not-Real-12345".to_string()));
        assert!(!app_bundle_exists(
            "Definitely Not A Real App 12345".to_string()
        ));
    }

    #[test]
    fn windows_app_paths_match_the_cli_locations() {
        let (l, pf, x86) = (Path::new("L"), Path::new("PF"), Path::new("PF86"));
        let vs = windows_app_paths("Visual Studio Code", l, pf, x86);
        assert_eq!(vs.len(), 3);
        assert!(
            vs[2].ends_with("Programs/Microsoft VS Code/Code.exe")
                || vs[2].ends_with(r"Programs\Microsoft VS Code\Code.exe")
        );
        assert!(windows_app_paths("Claude", l, pf, x86)[0].ends_with("claude.exe"));
        assert_eq!(windows_app_paths("ChatGPT", l, pf, x86).len(), 2);
        assert!(windows_app_paths("Nope", l, pf, x86).is_empty());
    }

    // Off macOS and Windows there is no install location to check, and a
    // wrong "not installed" would leave the row with no way to connect.
    #[cfg(not(any(target_os = "macos", windows)))]
    #[test]
    fn app_bundle_exists_assumes_installed_off_macos() {
        assert!(app_bundle_exists(
            "Definitely Not A Real App 12345".to_string()
        ));
    }

    #[test]
    fn windows_paths_follow_the_cli_appdata_dirs() {
        let p = connector_paths(
            true,
            Path::new("/u"),
            Some(Path::new("/roam")),
            Some(Path::new("/local")),
        );
        assert_eq!(p.claude_base, Path::new("/local/Claude-3p"));
        assert_eq!(
            p.vscode_user_dirs,
            vec![
                PathBuf::from("/roam/Code/User"),
                PathBuf::from("/roam/Code - Insiders/User")
            ]
        );
        assert_eq!(
            p.codex_state,
            Path::new("/u/.codemie/proxy/codex-desktop-state.json")
        );
    }

    #[test]
    fn windows_paths_fall_back_to_the_profile_when_appdata_is_unset() {
        let p = connector_paths(true, Path::new("/u"), None, None);
        assert_eq!(p.claude_base, Path::new("/u/AppData/Local/Claude-3p"));
        assert_eq!(
            p.vscode_user_dirs[0],
            Path::new("/u/AppData/Roaming/Code/User")
        );
    }

    #[test]
    fn macos_paths_live_under_application_support() {
        let p = connector_paths(false, Path::new("/u"), Some(Path::new("/ignored")), None);
        assert_eq!(
            p.claude_base,
            Path::new("/u/Library/Application Support/Claude-3p")
        );
        assert_eq!(
            p.vscode_user_dirs[1],
            Path::new("/u/Library/Application Support/Code - Insiders/User")
        );
    }
}
