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
        Some(p) => CodemieConfig {
            state: ConfigState::Valid,
            profile: profile.to_string(),
            model: str_field(p, "model"),
            project: str_field(p, "codeMieProject"),
            account,
        },
        // activeProfile names nothing in `profiles`. Show what is readable.
        None => CodemieConfig {
            state: ConfigState::Broken,
            profile: profile.to_string(),
            account,
            ..Default::default()
        },
    }
}

/// The app is Finder-launched with cwd `/`, so a repository-local `.codemie/`
/// never applies — the global file under $HOME is always the right one.
fn config_path() -> String {
    let home = std::env::var("HOME").unwrap_or_default();
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
}
