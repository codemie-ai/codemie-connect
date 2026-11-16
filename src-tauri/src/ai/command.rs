//! Builds the isolated headless `claude` command of DESIGN 6.2. Pure: nothing here
//! starts a process.
use super::profiles::{AiProfile, ProfileKind};
use serde_json::Value;
use std::path::{Path, PathBuf};
use std::time::Duration;

/// Variables removed for every run, so the run does not think it is inside Claude Code.
pub const SESSION_ENV_REMOVE: &[&str] = &[
    "CLAUDECODE",
    "CLAUDE_CODE_SESSION_ID",
    "CLAUDE_CODE_ENTRYPOINT",
];

/// Removed for the native profile: the run (and detection) must use the subscription,
/// never an API key or gateway left in the environment.
pub const NATIVE_ENV_REMOVE: &[&str] = &[
    "CLAUDECODE",
    "CLAUDE_CODE_SESSION_ID",
    "CLAUDE_CODE_ENTRYPOINT",
    "ANTHROPIC_API_KEY",
    "ANTHROPIC_AUTH_TOKEN",
    "ANTHROPIC_BASE_URL",
];

const SETTINGS_JSON: &str = r#"{"disableAllHooks":true,"claudeMdExcludes":["**"]}"#;
const MCP_JSON: &str = r#"{"mcpServers":{}}"#;

#[derive(Debug, Clone)]
pub struct RunSpec {
    pub purpose: String,
    pub profile_id: String,
    pub model: Option<String>,
    pub system: String,
    pub input: Value,
    pub schema: Option<Value>,
    pub timeout: Duration,
    pub cap_usd: Option<f64>,
    pub staging_root: PathBuf,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CommandPlan {
    pub program: PathBuf,
    pub args: Vec<String>,
    pub env_remove: Vec<String>,
    pub env_set: Vec<(String, String)>,
    pub cwd: PathBuf,
}

/// The command for one run. For a CodeMie profile the wrapper options come first and
/// the wrapper supplies `ANTHROPIC_*` itself, so those are left alone.
pub fn build_command(spec: &RunSpec, profile: &AiProfile, bin: &Path, cwd: &Path) -> CommandPlan {
    let mut args: Vec<String> = Vec::new();
    let model = spec.model.as_ref().filter(|m| !m.is_empty());
    let env_remove: &[&str] = match &profile.kind {
        ProfileKind::CodeMie { name } => {
            args.extend(["--profile".to_string(), name.clone()]);
            if let Some(m) = model {
                args.extend(["--model".to_string(), m.clone()]);
            }
            SESSION_ENV_REMOVE
        }
        ProfileKind::Native => NATIVE_ENV_REMOVE,
    };
    args.extend(["--safe-mode".to_string(), "--print".to_string()]);
    if let (ProfileKind::Native, Some(m)) = (&profile.kind, model) {
        args.extend(["--model".to_string(), m.clone()]);
    }
    for a in [
        "--tools",
        "",
        "--disable-slash-commands",
        "--strict-mcp-config",
        "--mcp-config",
        MCP_JSON,
        "--no-session-persistence",
        "--setting-sources",
        "",
        "--settings",
        SETTINGS_JSON,
        "--output-format",
        "stream-json",
        "--verbose",
    ] {
        args.push(a.to_string());
    }
    if let Some(schema) = &spec.schema {
        args.extend(["--json-schema".to_string(), schema.to_string()]);
    }
    args.extend(["--system-prompt".to_string(), spec.system.clone()]);
    CommandPlan {
        program: bin.to_path_buf(),
        args,
        env_remove: env_remove.iter().map(|s| s.to_string()).collect(),
        env_set: vec![("CLAUDE_CODE_DISABLE_AUTO_MEMORY".into(), "1".into())],
        cwd: cwd.to_path_buf(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ai::profiles::{ProfileState, NATIVE_ID};
    use serde_json::json;

    pub(crate) fn spec(model: Option<&str>, schema: Option<Value>) -> RunSpec {
        RunSpec {
            purpose: "mail_draft".into(),
            profile_id: NATIVE_ID.into(),
            model: model.map(str::to_string),
            system: "SYS".into(),
            input: json!({"a": 1}),
            schema,
            timeout: Duration::from_secs(60),
            cap_usd: None,
            staging_root: PathBuf::from("/tmp/stage"),
        }
    }

    fn profile(kind: ProfileKind) -> AiProfile {
        AiProfile {
            id: "x".into(),
            kind,
            label: "x".into(),
            state: ProfileState::Ready,
            version: None,
            account: None,
            models: vec![],
            default_model: None,
            message: None,
        }
    }

    fn v(a: &[&str]) -> Vec<String> {
        a.iter().map(|s| s.to_string()).collect()
    }

    const TAIL: &[&str] = &[
        "--tools",
        "",
        "--disable-slash-commands",
        "--strict-mcp-config",
        "--mcp-config",
        r#"{"mcpServers":{}}"#,
        "--no-session-persistence",
        "--setting-sources",
        "",
        "--settings",
        r#"{"disableAllHooks":true,"claudeMdExcludes":["**"]}"#,
        "--output-format",
        "stream-json",
        "--verbose",
    ];

    #[test]
    fn build_command_native_isolated_matches_design() {
        let p = profile(ProfileKind::Native);
        let plan = build_command(
            &spec(Some("haiku"), Some(json!({"type": "object"}))),
            &p,
            Path::new("/bin/claude"),
            Path::new("/stage/1"),
        );
        let mut want = v(&["--safe-mode", "--print", "--model", "haiku"]);
        want.extend(v(TAIL));
        want.extend(v(&["--json-schema", r#"{"type":"object"}"#]));
        want.extend(v(&["--system-prompt", "SYS"]));
        assert_eq!(plan.args, want);
        assert_eq!(plan.program, Path::new("/bin/claude"));
        assert_eq!(plan.cwd, Path::new("/stage/1"));
        assert_eq!(
            plan.env_set,
            vec![(
                "CLAUDE_CODE_DISABLE_AUTO_MEMORY".to_string(),
                "1".to_string()
            )]
        );
        assert!(plan.env_remove.contains(&"ANTHROPIC_API_KEY".to_string()));

        // Neither model nor schema: both flags disappear, nothing else moves.
        let plan = build_command(
            &spec(None, None),
            &p,
            Path::new("/bin/claude"),
            Path::new("/s"),
        );
        let mut want = v(&["--safe-mode", "--print"]);
        want.extend(v(TAIL));
        want.extend(v(&["--system-prompt", "SYS"]));
        assert_eq!(plan.args, want);
    }

    #[test]
    fn build_command_codemie_puts_wrapper_options_first() {
        let p = profile(ProfileKind::CodeMie {
            name: "prod".into(),
        });
        let plan = build_command(
            &spec(Some("m1"), None),
            &p,
            Path::new("/bin/codemie-claude"),
            Path::new("/s"),
        );
        let mut want = v(&[
            "--profile",
            "prod",
            "--model",
            "m1",
            "--safe-mode",
            "--print",
        ]);
        want.extend(v(TAIL));
        want.extend(v(&["--system-prompt", "SYS"]));
        assert_eq!(plan.args, want);
        assert!(!plan.env_remove.iter().any(|e| e.starts_with("ANTHROPIC_")));
        let plan = build_command(&spec(None, None), &p, Path::new("/b"), Path::new("/s"));
        assert_eq!(
            &plan.args[..4],
            &v(&["--profile", "prod", "--safe-mode", "--print"])[..]
        );
    }

    #[test]
    fn env_remove_lists_are_exact() {
        assert_eq!(
            SESSION_ENV_REMOVE,
            [
                "CLAUDECODE",
                "CLAUDE_CODE_SESSION_ID",
                "CLAUDE_CODE_ENTRYPOINT"
            ]
        );
        assert_eq!(
            NATIVE_ENV_REMOVE,
            [
                "CLAUDECODE",
                "CLAUDE_CODE_SESSION_ID",
                "CLAUDE_CODE_ENTRYPOINT",
                "ANTHROPIC_API_KEY",
                "ANTHROPIC_AUTH_TOKEN",
                "ANTHROPIC_BASE_URL"
            ]
        );
        let p = build_command(
            &spec(None, None),
            &profile(ProfileKind::Native),
            Path::new("/b"),
            Path::new("/s"),
        );
        assert_eq!(p.env_remove, NATIVE_ENV_REMOVE);
        let p = build_command(
            &spec(None, None),
            &profile(ProfileKind::CodeMie { name: "n".into() }),
            Path::new("/b"),
            Path::new("/s"),
        );
        assert_eq!(p.env_remove, SESSION_ENV_REMOVE);
    }
}
