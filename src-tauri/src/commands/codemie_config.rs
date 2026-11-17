// Reads ~/.codemie/codemie-cli.config.json for the identity bar.
//
// The CLI never prints the account email (`codemie profile status` omits it, and
// so does --show-sources), so the file is the only source for these four fields —
// and no file-read API is reachable from the frontend: no bridge export, no
// tauri-plugin-fs, and capabilities grant only core:default.
//
// `runCapture("cat ...")` would also have worked. It is deliberately not used:
// it spawns a login shell to read a small JSON file, and it would leave the
// three states below — and the absent-vs-unread account distinction that
// EPMCDME-14515 and EPMCDME-14589 both depend on — as untyped conventions each
// consumer re-derives, rather than one contract with tests behind it.
use serde::Serialize;

/// The three states the identity bar has to tell apart.
///
/// - `no-configuration` — the file is missing or unreadable; setup has not run.
/// - `valid` — the file parses and `activeProfile` resolves inside `profiles`.
/// - `broken` — the file parses but `activeProfile` resolves to nothing.
#[derive(Serialize, Clone, Copy, PartialEq, Eq, Debug, Default)]
#[serde(rename_all = "kebab-case")]
pub enum ConfigState {
    #[default]
    NoConfiguration,
    Valid,
    Broken,
}

/// Identity read off the config file.
///
/// `account` is `None` when the config records no `userEmail` — only the SSO
/// login path writes one, so an API-key profile legitimately has none. Consumers
/// tell "no account recorded" from "not read yet" by pairing it with `state`:
/// `valid` + `account: null` is an absent account, `no-configuration` is unread.
#[derive(Serialize, Default, Clone)]
pub struct CodemieConfig {
    pub state: ConfigState,
    pub profile: String,
    pub model: String,
    pub project: String,
    pub account: Option<String>,
}

fn str_field(v: &serde_json::Value, key: &str) -> String {
    v.get(key)
        .and_then(|x| x.as_str())
        .unwrap_or("")
        .to_string()
}

/// Parse the raw config text. Split from the command so every state is testable
/// without touching the filesystem (same seam as `logger::format_line`).
pub fn parse_config(raw: &str) -> CodemieConfig {
    let Ok(json) = serde_json::from_str::<serde_json::Value>(raw) else {
        // Unparseable is indistinguishable from absent for the bar's purpose.
        return CodemieConfig::default();
    };

    // Top-level, and optional even in a perfectly good config.
    let account = json
        .get("userEmail")
        .and_then(|v| v.as_str())
        .filter(|s| !s.is_empty())
        .map(str::to_string);

    let profile = json
        .get("activeProfile")
        .and_then(|v| v.as_str())
        .unwrap_or("");

    match json
        .get("profiles")
        .and_then(|p| p.get(profile))
        .filter(|p| p.is_object())
    {
        Some(p) => {
            // CLI 0.15 moved the project out of the profile into the top-level
            // `workspace`, which wins over the profile the way the CLI's own config
            // loader applies it. Profiles written by older CLIs still carry their own.
            let project = json
                .get("workspace")
                .map(|w| str_field(w, "codeMieProject"))
                .filter(|s| !s.is_empty())
                .unwrap_or_else(|| str_field(p, "codeMieProject"));
            CodemieConfig {
                state: ConfigState::Valid,
                profile: profile.to_string(),
                model: str_field(p, "model"),
                project,
                account,
            }
        }
        // activeProfile names nothing in `profiles`. Show what is readable.
        None => CodemieConfig {
            state: ConfigState::Broken,
            profile: profile.to_string(),
            account,
            ..Default::default()
        },
    }
}

/// One CodeMie CLI profile as the AI features need it. Names and model ids only:
/// tokens, API keys and URLs in the file are never copied out.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ProfileSummary {
    pub name: String,
    pub provider: String,
    pub model: String,
    pub haiku_model: String,
    pub sonnet_model: String,
    pub opus_model: String,
}

/// Every profile in the parsed config, sorted by name. An entry that is not an
/// object is skipped; the key is the name when the entry has no `name` of its own.
pub fn list_profiles(json: &serde_json::Value) -> Vec<ProfileSummary> {
    let Some(map) = json.get("profiles").and_then(|p| p.as_object()) else {
        return Vec::new();
    };
    let mut out: Vec<ProfileSummary> = map
        .iter()
        .filter(|(_, p)| p.is_object())
        .map(|(key, p)| ProfileSummary {
            name: key.clone(),
            provider: str_field(p, "provider"),
            model: str_field(p, "model"),
            haiku_model: str_field(p, "haikuModel"),
            sonnet_model: str_field(p, "sonnetModel"),
            opus_model: str_field(p, "opusModel"),
        })
        .collect();
    out.sort_by(|a, b| a.name.cmp(&b.name));
    out
}

/// Every profile as Settings → CodeMie shows it. Like `ProfileSummary`, no
/// secret is ever copied: only the fields named here leave the file.
#[derive(Serialize, Debug, Clone, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ProfileDetail {
    pub name: String,
    pub provider: String,
    pub model: Option<String>,
    pub codemie_url: Option<String>,
    pub codemie_project: Option<String>,
    pub base_url: Option<String>,
}

/// The whole profile list plus the file's state (`no-configuration`, `valid`,
/// `broken` — the same names `ConfigState` serializes to).
#[derive(Serialize, Debug, Clone, PartialEq, Eq)]
pub struct CodemieProfiles {
    pub state: String,
    pub active: Option<String>,
    pub account: Option<String>,
    pub profiles: Vec<ProfileDetail>,
}

fn opt_field(v: &serde_json::Value, key: &str) -> Option<String> {
    v.get(key)
        .and_then(|x| x.as_str())
        .filter(|s| !s.is_empty())
        .map(str::to_string)
}

/// Build the profile list from the parsed config. The active profile comes
/// first, then the rest by name. A file with neither profiles nor an active
/// profile is `no-configuration`; one whose active profile resolves to nothing
/// is `broken`.
pub fn profiles_from_value(v: &serde_json::Value) -> CodemieProfiles {
    let active = opt_field(v, "activeProfile");
    let map = v.get("profiles").and_then(|p| p.as_object());
    let has_profiles = map.is_some_and(|m| !m.is_empty());
    let state = if active.is_none() && !has_profiles {
        "no-configuration"
    } else if active
        .as_deref()
        .and_then(|a| map.and_then(|m| m.get(a)))
        .is_some_and(|p| p.is_object())
    {
        "valid"
    } else {
        "broken"
    };
    // CLI 0.15+ keeps the project in the top-level workspace, which wins over a
    // profile's own value the way the CLI's config loader applies it.
    let workspace_project = v
        .get("workspace")
        .and_then(|w| opt_field(w, "codeMieProject"));
    let mut profiles: Vec<ProfileDetail> = map
        .into_iter()
        .flatten()
        .filter(|(_, p)| p.is_object())
        .map(|(key, p)| ProfileDetail {
            name: key.clone(),
            provider: str_field(p, "provider"),
            model: opt_field(p, "model"),
            codemie_url: opt_field(p, "codeMieUrl"),
            codemie_project: workspace_project
                .clone()
                .or_else(|| opt_field(p, "codeMieProject")),
            base_url: opt_field(p, "baseUrl"),
        })
        .collect();
    let is_active = |p: &ProfileDetail| Some(&p.name) == active.as_ref();
    profiles.sort_by(|a, b| is_active(b).cmp(&is_active(a)).then(a.name.cmp(&b.name)));
    CodemieProfiles {
        state: state.to_string(),
        active,
        account: opt_field(v, "userEmail"),
        profiles,
    }
}

/// Every profile for Settings → CodeMie. Never fails: an unreadable or
/// unparseable file is `no-configuration`.
#[tauri::command]
pub fn read_codemie_profiles() -> CodemieProfiles {
    let value = std::fs::read_to_string(config_path())
        .ok()
        .and_then(|raw| serde_json::from_str::<serde_json::Value>(&raw).ok())
        .unwrap_or(serde_json::Value::Null);
    profiles_from_value(&value)
}

/// The app is Finder-launched with cwd `/`, so a repository-local `.codemie/`
/// never applies — the global file under $HOME is always the right one.
/// On Windows, HOME is typically unset; fall back to USERPROFILE.
pub fn config_path() -> String {
    config_path_with(
        &std::env::var("HOME")
            .or_else(|_| std::env::var("USERPROFILE"))
            .unwrap_or_default(),
    )
}

fn config_path_with(home: &str) -> String {
    format!("{home}/.codemie/codemie-cli.config.json")
}

/// Read the config for the identity bar. Never fails: a missing or unreadable
/// file is the `no-configuration` state, not an error.
#[tauri::command]
pub fn read_codemie_config() -> CodemieConfig {
    match std::fs::read_to_string(config_path()) {
        Ok(raw) => parse_config(&raw),
        Err(_) => CodemieConfig::default(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn unreadable_file_is_no_configuration() {
        let c = parse_config("not json at all");
        assert_eq!(c.state, ConfigState::NoConfiguration);
        assert!(c.profile.is_empty());
        assert!(c.account.is_none());
    }

    #[test]
    fn resolving_active_profile_is_valid() {
        let c = parse_config(
            r#"{"activeProfile":"mine","userEmail":"a@b.com",
                "profiles":{"mine":{"model":"sonnet","codeMieProject":"epm-sdai"}}}"#,
        );
        assert_eq!(c.state, ConfigState::Valid);
        assert_eq!(c.profile, "mine");
        assert_eq!(c.model, "sonnet");
        assert_eq!(c.project, "epm-sdai");
        assert_eq!(c.account.as_deref(), Some("a@b.com"));
    }

    // An API-key profile records no userEmail — the .codemie/ file in this very
    // repository is a valid config with none.
    #[test]
    fn valid_config_may_record_no_account() {
        let c = parse_config(
            r#"{"activeProfile":"epm-cdme",
                "profiles":{"epm-cdme":{"model":"claude-sonnet-4-6","codeMieProject":"epm-cdme"}}}"#,
        );
        assert_eq!(c.state, ConfigState::Valid);
        assert_eq!(c.model, "claude-sonnet-4-6");
        assert!(c.account.is_none(), "absent account must stay absent");
    }

    // Shape written by CLI 0.15: the profile has no project, the workspace does.
    #[test]
    fn project_is_read_from_the_workspace_when_the_profile_has_none() {
        let c = parse_config(
            r#"{"activeProfile":"test9",
                "profiles":{"test9":{"model":"claude-sonnet-5"}},
                "workspace":{"codeMieUrl":"https://codemie.lab.epam.com","codeMieProject":"epm-sdai"}}"#,
        );
        assert_eq!(c.project, "epm-sdai");
    }

    #[test]
    fn workspace_project_wins_over_the_profile_like_the_cli() {
        let c = parse_config(
            r#"{"activeProfile":"old",
                "profiles":{"old":{"model":"x","codeMieProject":"from-profile"}},
                "workspace":{"codeMieProject":"from-workspace"}}"#,
        );
        assert_eq!(c.project, "from-workspace");
    }

    #[test]
    fn unresolvable_active_profile_is_broken_but_still_readable() {
        let c = parse_config(r#"{"activeProfile":"gone","profiles":{"other":{"model":"x"}}}"#);
        assert_eq!(c.state, ConfigState::Broken);
        assert_eq!(c.profile, "gone", "show what is readable");
        assert!(c.model.is_empty());
    }

    #[test]
    fn state_serializes_to_its_documented_name() {
        let json = serde_json::to_string(&CodemieConfig::default()).unwrap();
        assert!(json.contains(r#""state":"no-configuration""#), "{json}");
        assert!(json.contains(r#""account":null"#), "{json}");
    }

    #[test]
    fn profiles_from_value_lists_all_without_secrets() {
        let v = serde_json::json!({ "version": 2, "activeProfile": "prod", "userEmail": "a@b.c",
          "profiles": { "prod": { "name": "prod", "provider": "ai-run-sso", "model": "claude-sonnet-4-5",
            "codeMieUrl": "https://codemie.lab.epam.com", "codeMieProject": "EPM-CDME", "apiKey": "sso-provided" },
            "local": { "name": "local", "provider": "litellm", "baseUrl": "http://localhost:4000", "apiKey": "sk-secret" } } });
        let p = profiles_from_value(&v);
        assert_eq!(p.state, "valid");
        assert_eq!(p.active.as_deref(), Some("prod"));
        assert_eq!(p.profiles.len(), 2);
        let json = serde_json::to_string(&p).unwrap();
        assert!(
            !json.contains("sk-secret")
                && !json.contains("sso-provided")
                && !json.contains("apiKey")
        );
        assert!(json.contains("\"codemieProject\":\"EPM-CDME\""));
    }

    #[test]
    fn profiles_from_value_broken_when_active_missing() {
        let v = serde_json::json!({ "activeProfile": "gone", "profiles": { "prod": { "provider": "ai-run-sso" } } });
        assert_eq!(profiles_from_value(&v).state, "broken");
    }

    #[test]
    fn profiles_from_value_empty_is_no_configuration() {
        assert_eq!(
            profiles_from_value(&serde_json::json!({})).state,
            "no-configuration"
        );
    }

    #[test]
    fn profiles_from_value_puts_active_first() {
        let v = serde_json::json!({ "activeProfile": "zeta",
          "profiles": { "alpha": { "provider": "litellm" }, "zeta": { "provider": "ai-run-sso" }, "mid": { "provider": "ollama" } } });
        let names: Vec<_> = profiles_from_value(&v)
            .profiles
            .into_iter()
            .map(|p| p.name)
            .collect();
        assert_eq!(names, ["zeta", "alpha", "mid"]);
    }

    #[test]
    fn config_path_with_unix_home() {
        let p = config_path_with("/home/alice");
        assert_eq!(p, "/home/alice/.codemie/codemie-cli.config.json");
    }

    #[test]
    fn config_path_with_windows_userprofile() {
        let p = config_path_with("C:\\Users\\alice");
        assert_eq!(p, "C:\\Users\\alice/.codemie/codemie-cli.config.json");
    }
}
