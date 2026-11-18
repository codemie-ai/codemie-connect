// Which desktop apps are on this machine, and which of them `codemie proxy
// connect` has pointed at the CodeMie gateway. The CLI has no command that
// says so, so this reads the same files its connectors write
// (`dist/cli/commands/proxy/connectors/*.js` in @codemieai/code 0.16):
//
// - Claude Desktop: `Claude-3p/configLibrary/_meta.json` applies an entry
//   named "CodeMie Proxy".
// - VS Code Copilot Chat: `Code/User/chatLanguageModels.json` holds a provider
//   `{ "name": "CodeMie", "vendor": "customendpoint" }`.
// - VS Code Claude Code extension: `Code/User/settings.json` sets
//   `claudeCode.environmentVariables` with `ANTHROPIC_BASE_URL`.
// - Codex app: `~/.codex/config.toml` has `[model_providers.codemie]`.
use serde::Serialize;
use std::io::Read;
use std::path::{Path, PathBuf};

/// One app's state. `configured` says the app's own files point at CodeMie; the
/// frontend pairs it with the gateway state to tell connected from stopped.
#[derive(Serialize, Debug, Clone, PartialEq, Eq)]
pub struct AppStateInfo {
    pub id: String,
    pub installed: bool,
    pub configured: bool,
}

/// Where to look. Split from the command so tests build the tree in a temp dir.
#[derive(Debug, Clone)]
pub struct AppDirs {
    pub home: PathBuf,
    /// macOS `~/Library/Application Support`; Windows `%APPDATA%`.
    pub app_support: PathBuf,
    /// Windows `%LOCALAPPDATA%`; on macOS the same as `app_support`.
    pub local_app_data: PathBuf,
    /// macOS `/Applications` and `~/Applications`; empty on Windows.
    pub applications: Vec<PathBuf>,
}

const READ_CAP: u64 = 256 * 1024;

/// A config file's text, at most 256 KB. Unreadable is `None`.
fn read_capped(path: &Path) -> Option<String> {
    let mut text = String::new();
    std::fs::File::open(path)
        .ok()?
        .take(READ_CAP)
        .read_to_string(&mut text)
        .ok()?;
    Some(text)
}

fn read_json(path: &Path) -> Option<serde_json::Value> {
    serde_json::from_str(&read_capped(path)?).ok()
}

fn installed(env: &AppDirs, bundle: &str, windows_dir: &str) -> bool {
    env.applications.iter().any(|d| d.join(bundle).exists())
        || env.local_app_data.join(windows_dir).exists()
}

fn claude_desktop_configured(env: &AppDirs) -> bool {
    let meta = env
        .local_app_data
        .join("Claude-3p/configLibrary/_meta.json");
    let Some(meta) = read_json(&meta) else {
        return false;
    };
    let Some(applied) = meta.get("appliedId").and_then(|v| v.as_str()) else {
        return false;
    };
    meta.get("entries")
        .and_then(|e| e.as_array())
        .into_iter()
        .flatten()
        .any(|e| {
            e.get("name").and_then(|n| n.as_str()) == Some("CodeMie Proxy")
                && e.get("id").and_then(|i| i.as_str()) == Some(applied)
        })
}

fn is_codemie_provider(v: &serde_json::Value) -> bool {
    v.get("name").and_then(|n| n.as_str()) == Some("CodeMie")
        && v.get("vendor").and_then(|n| n.as_str()) == Some("customendpoint")
}

fn vscode_copilot_configured(env: &AppDirs) -> bool {
    let path = env.app_support.join("Code/User/chatLanguageModels.json");
    match read_json(&path) {
        Some(serde_json::Value::Array(providers)) => providers.iter().any(is_codemie_provider),
        Some(serde_json::Value::Object(map)) => map
            .values()
            .filter_map(|v| v.as_array())
            .flatten()
            .any(is_codemie_provider),
        _ => false,
    }
}

fn vscode_claude_configured(env: &AppDirs) -> bool {
    // settings.json is JSONC (comments, trailing commas): a substring check, no parse.
    read_capped(&env.app_support.join("Code/User/settings.json")).is_some_and(|t| {
        t.contains("claudeCode.environmentVariables") && t.contains("ANTHROPIC_BASE_URL")
    })
}

fn codex_configured(env: &AppDirs) -> bool {
    read_capped(&env.home.join(".codex/config.toml"))
        .is_some_and(|t| t.contains("[model_providers.codemie]"))
}

/// The four apps, in the order Settings shows them.
pub fn app_states(env: &AppDirs) -> Vec<AppStateInfo> {
    let vscode = installed(env, "Visual Studio Code.app", "Programs/Microsoft VS Code");
    let row = |id: &str, installed: bool, configured: bool| AppStateInfo {
        id: id.to_string(),
        installed,
        configured,
    };
    vec![
        row(
            "claude-desktop",
            installed(env, "Claude.app", "AnthropicClaude"),
            claude_desktop_configured(env),
        ),
        row("vscode-copilot", vscode, vscode_copilot_configured(env)),
        row("vscode-claude", vscode, vscode_claude_configured(env)),
        row(
            "codex-desktop",
            installed(env, "Codex.app", "Programs/Codex"),
            codex_configured(env),
        ),
    ]
}

fn env_path(key: &str) -> Option<PathBuf> {
    std::env::var_os(key)
        .filter(|v| !v.is_empty())
        .map(PathBuf::from)
}

fn app_dirs() -> AppDirs {
    let home = env_path("HOME")
        .or_else(|| env_path("USERPROFILE"))
        .unwrap_or_default();
    #[cfg(windows)]
    {
        AppDirs {
            app_support: env_path("APPDATA").unwrap_or_else(|| home.join("AppData/Roaming")),
            local_app_data: env_path("LOCALAPPDATA").unwrap_or_else(|| home.join("AppData/Local")),
            applications: Vec::new(),
            home,
        }
    }
    #[cfg(target_os = "macos")]
    {
        let app_support = home.join("Library/Application Support");
        AppDirs {
            local_app_data: app_support.clone(),
            app_support,
            applications: vec![PathBuf::from("/Applications"), home.join("Applications")],
            home,
        }
    }
    #[cfg(not(any(windows, target_os = "macos")))]
    {
        let config = env_path("XDG_CONFIG_HOME").unwrap_or_else(|| home.join(".config"));
        AppDirs {
            local_app_data: config.clone(),
            app_support: config,
            applications: Vec::new(),
            home,
        }
    }
}

/// Which apps are installed and which point at CodeMie. Never fails: an
/// unreadable file is "not configured".
#[tauri::command]
pub fn codemie_app_states() -> Vec<AppStateInfo> {
    app_states(&app_dirs())
}

#[cfg(test)]
mod tests {
    use super::*;

    struct Fixture {
        _root: tempfile::TempDir,
        dirs: AppDirs,
    }

    fn dirs_in_temp() -> Fixture {
        let root = tempfile::tempdir().unwrap();
        let base = root.path().to_path_buf();
        let dirs = AppDirs {
            home: base.join("home"),
            app_support: base.join("support"),
            local_app_data: base.join("support"),
            applications: vec![base.join("Applications"), base.join("home/Applications")],
        };
        Fixture { _root: root, dirs }
    }

    fn write(path: &Path, text: &str) {
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(path, text).unwrap();
    }

    fn find(states: &[AppStateInfo], id: &str) -> AppStateInfo {
        states.iter().find(|s| s.id == id).cloned().unwrap()
    }

    #[test]
    fn claude_desktop_configured_only_when_applied() {
        let f = dirs_in_temp();
        let d = &f.dirs;
        write(
            &d.app_support.join("Claude-3p/configLibrary/_meta.json"),
            r#"{"appliedId":"x1","entries":[{"id":"x1","name":"CodeMie Proxy"}]}"#,
        );
        std::fs::create_dir_all(d.applications[0].join("Claude.app")).unwrap();
        let s = find(&app_states(d), "claude-desktop");
        assert!(s.installed && s.configured);
        write(
            &d.app_support.join("Claude-3p/configLibrary/_meta.json"),
            r#"{"appliedId":"other","entries":[{"id":"x1","name":"CodeMie Proxy"}]}"#,
        );
        assert!(!find(&app_states(d), "claude-desktop").configured);
    }

    #[test]
    fn vscode_copilot_needs_codemie_customendpoint() {
        let f = dirs_in_temp();
        let d = &f.dirs;
        std::fs::create_dir_all(d.applications[1].join("Visual Studio Code.app")).unwrap();
        let models = d.app_support.join("Code/User/chatLanguageModels.json");
        write(
            &models,
            r#"[{"name":"Other","vendor":"customendpoint"},{"name":"CodeMie","vendor":"azure"}]"#,
        );
        let s = find(&app_states(d), "vscode-copilot");
        assert!(s.installed && !s.configured);
        write(
            &models,
            r#"[{"name":"CodeMie","vendor":"customendpoint","models":[]}]"#,
        );
        assert!(find(&app_states(d), "vscode-copilot").configured);
    }

    #[test]
    fn vscode_claude_detects_env_keys() {
        let f = dirs_in_temp();
        let d = &f.dirs;
        let settings = d.app_support.join("Code/User/settings.json");
        write(&settings, "{\n  // JSONC\n  \"editor.fontSize\": 13,\n}");
        assert!(!find(&app_states(d), "vscode-claude").configured);
        write(
            &settings,
            "{\n  // JSONC\n  \"claudeCode.environmentVariables\": [{\"name\": \"ANTHROPIC_BASE_URL\", \"value\": \"http://localhost:4001\"}],\n}",
        );
        let s = find(&app_states(d), "vscode-claude");
        assert!(s.configured && !s.installed);
    }

    #[test]
    fn codex_needs_codemie_provider_block() {
        let f = dirs_in_temp();
        let d = &f.dirs;
        std::fs::create_dir_all(d.applications[0].join("Codex.app")).unwrap();
        let config = d.home.join(".codex/config.toml");
        write(&config, "model = \"gpt-5\"\n[model_providers.other]\n");
        let s = find(&app_states(d), "codex-desktop");
        assert!(s.installed && !s.configured);
        write(
            &config,
            "model_provider = \"codemie\"\n[model_providers.codemie]\nbase_url = \"http://localhost:4001\"\n",
        );
        assert!(find(&app_states(d), "codex-desktop").configured);
    }

    #[test]
    fn nothing_installed_is_all_false() {
        let f = dirs_in_temp();
        let states = app_states(&f.dirs);
        let ids: Vec<_> = states.iter().map(|s| s.id.as_str()).collect();
        assert_eq!(
            ids,
            [
                "claude-desktop",
                "vscode-copilot",
                "vscode-claude",
                "codex-desktop"
            ]
        );
        assert!(states.iter().all(|s| !s.installed && !s.configured));
    }
}
