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

/// One row of the profile list. Only these four fields cross IPC: the profile
/// object also holds `apiKey` and other secrets that must never leave Rust.
#[derive(Serialize, Clone, Debug)]
pub struct ProfileSummary {
    pub name: String,
    pub provider: String,
    pub model: String,
    pub active: bool,
}

/// List the profiles in the raw config text. The `profiles` map key is the
/// profile identity (the CLI indexes by it); the `name` field is ignored.
pub fn parse_profiles(raw: &str) -> Vec<ProfileSummary> {
    let Ok(json) = serde_json::from_str::<serde_json::Value>(raw) else {
        return Vec::new();
    };
    let active = json
        .get("activeProfile")
        .and_then(|v| v.as_str())
        .unwrap_or("");
    let Some(map) = json.get("profiles").and_then(|p| p.as_object()) else {
        return Vec::new();
    };
    map.iter()
        .map(|(key, p)| ProfileSummary {
            name: key.clone(),
            provider: str_field(p, "provider"),
            model: str_field(p, "model"),
            active: !active.is_empty() && key == active,
        })
        .collect()
}

/// The app is Finder-launched with cwd `/`, so a repository-local `.codemie/`
/// never applies — the global file under $HOME is always the right one.
/// On Windows, HOME is typically unset; fall back to USERPROFILE.
fn config_path() -> String {
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

/// List the CLI profiles for Home. A missing or unreadable file is an empty list.
#[tauri::command]
pub fn list_codemie_profiles() -> Vec<ProfileSummary> {
    std::fs::read_to_string(config_path())
        .map(|raw| parse_profiles(&raw))
        .unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;

    const TWO: &str = r#"{"activeProfile":"b","profiles":{
        "a":{"name":"ignored","provider":"ai-run-sso","model":"m1","apiKey":"SECRET-KEY"},
        "b":{"provider":"litellm","model":"m2"}}}"#;

    #[test]
    fn profiles_are_listed_with_one_active() {
        let p = parse_profiles(TWO);
        assert_eq!(p.len(), 2);
        assert_eq!(
            (p[0].name.as_str(), p[0].provider.as_str()),
            ("a", "ai-run-sso")
        );
        assert_eq!(p[0].model, "m1");
        assert!(!p[0].active);
        assert_eq!(p[1].name, "b");
        assert!(p[1].active);
    }

    #[test]
    fn profile_list_never_carries_a_secret() {
        let json = serde_json::to_string(&parse_profiles(TWO)).unwrap();
        assert!(!json.contains("apiKey"));
        assert!(!json.contains("SECRET-KEY"));
    }

    #[test]
    fn no_profile_is_active_when_active_profile_names_nothing_or_is_empty() {
        let missing = r#"{"activeProfile":"zzz","profiles":{"a":{"model":"m"}}}"#;
        let empty = r#"{"activeProfile":"","profiles":{"a":{"model":"m"}}}"#;
        for raw in [missing, empty] {
            let p = parse_profiles(raw);
            assert_eq!(p.len(), 1);
            assert!(p.iter().all(|x| !x.active));
        }
    }

    #[test]
    fn garbage_gives_an_empty_profile_list() {
        assert!(parse_profiles("not json").is_empty());
    }

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
