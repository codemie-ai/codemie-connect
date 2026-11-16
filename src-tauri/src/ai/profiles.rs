//! AI profile detection (DESIGN 6.1): the native Claude Code subscription plus one
//! profile per CodeMie CLI profile, each with a state the UI can explain.
use super::discover::find_program_in;
use crate::commands::codemie_config::{self, ProfileSummary};
use serde::Serialize;
use std::future::Future;
use std::path::{Path, PathBuf};
use std::pin::Pin;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

/// Every flag the isolated run in DESIGN 6.2 passes. A `claude` whose `--help`
/// lacks one of them is too old to run it safely.
pub const REQUIRED_FLAGS: &[&str] = &[
    "--safe-mode",
    "--print",
    "--model",
    "--tools",
    "--disable-slash-commands",
    "--strict-mcp-config",
    "--mcp-config",
    "--no-session-persistence",
    "--setting-sources",
    "--settings",
    "--output-format",
    "--verbose",
    "--json-schema",
    "--system-prompt",
];

#[allow(dead_code)] // used from Task 5, through SystemProbe
const PROBE_TIMEOUT: Duration = Duration::from_secs(15);
const CACHE_OK: Duration = Duration::from_secs(30);
const CACHE_FAILED: Duration = Duration::from_secs(10);

pub const NATIVE_ID: &str = "claude";

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum ProfileKind {
    Native,
    CodeMie { name: String },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ProfileState {
    Ready,
    NotInstalled,
    TooOld,
    NeedsLogin,
    NotConfigured,
    #[allow(dead_code)] // set by the UI layer in Task 5 while a refresh runs
    Checking,
    Error,
}

/// Account details from `claude auth status`. Kept in memory only: the manual
/// `Debug` hides every field so it cannot reach a log by accident.
#[derive(Clone, PartialEq, Eq, Serialize, Default)]
pub struct AccountInfo {
    pub plan: Option<String>,
    pub email: Option<String>,
    pub org: Option<String>,
    pub method: Option<String>,
}

impl std::fmt::Debug for AccountInfo {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("AccountInfo(..)")
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct ModelChoice {
    /// Value for `--model`; empty means the account default.
    pub id: String,
    pub label: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct AiProfile {
    pub id: String,
    pub kind: ProfileKind,
    pub label: String,
    pub state: ProfileState,
    pub version: Option<String>,
    pub account: Option<AccountInfo>,
    pub models: Vec<ModelChoice>,
    pub default_model: Option<String>,
    pub message: Option<String>,
}

/// A CodeMie CLI profile with the models it offers.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CodemieProfile {
    pub name: String,
    pub models: Vec<ModelChoice>,
    pub default_model: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum AuthStatus {
    LoggedIn(AccountInfo),
    LoggedOut,
}

// ---------------------------------------------------------------- pure parsers

/// `2.1.322 (Claude Code)` -> `2.1.322`.
pub fn parse_version(out: &str) -> Option<String> {
    let token = out.split_whitespace().next()?;
    let ok = token.split('.').count() >= 2
        && token
            .split('.')
            .all(|p| !p.is_empty() && p.chars().all(|c| c.is_ascii_digit()));
    ok.then(|| token.to_string())
}

fn capitalize(s: &str) -> String {
    let mut c = s.chars();
    match c.next() {
        Some(f) => f.to_uppercase().collect::<String>() + c.as_str(),
        None => String::new(),
    }
}

/// `claude auth status --json`. Errors when the text is not the expected JSON.
pub fn parse_auth_status(out: &str) -> Result<AuthStatus, String> {
    let v: serde_json::Value =
        serde_json::from_str(out.trim()).map_err(|_| "auth status is not JSON".to_string())?;
    let logged_in = v
        .get("loggedIn")
        .and_then(|x| x.as_bool())
        .ok_or_else(|| "auth status has no loggedIn".to_string())?;
    if !logged_in {
        return Ok(AuthStatus::LoggedOut);
    }
    let text = |k: &str| {
        v.get(k)
            .and_then(|x| x.as_str())
            .filter(|s| !s.is_empty())
            .map(str::to_string)
    };
    Ok(AuthStatus::LoggedIn(AccountInfo {
        plan: text("subscriptionType").map(|s| capitalize(&s)),
        email: text("email"),
        org: text("orgName"),
        method: text("authMethod"),
    }))
}

fn state_for_auth(r: &Result<AuthStatus, String>) -> ProfileState {
    match r {
        Ok(AuthStatus::LoggedIn(_)) => ProfileState::Ready,
        Ok(AuthStatus::LoggedOut) => ProfileState::NeedsLogin,
        Err(_) => ProfileState::Error,
    }
}

/// The required flags that `--help` does not list (whole-flag match, so
/// `--printer` does not satisfy `--print`).
pub fn missing_flags(help: &str) -> Vec<&'static str> {
    let listed: std::collections::HashSet<&str> = help
        .split(|c: char| !(c.is_ascii_alphanumeric() || c == '-'))
        .filter(|t| t.starts_with("--"))
        .collect();
    REQUIRED_FLAGS
        .iter()
        .copied()
        .filter(|f| !listed.contains(f))
        .collect()
}

fn model_choices(p: &ProfileSummary) -> Vec<ModelChoice> {
    let mut seen: Vec<ModelChoice> = Vec::new();
    for id in [&p.model, &p.haiku_model, &p.sonnet_model, &p.opus_model] {
        if !id.is_empty() && !seen.iter().any(|m| &m.id == id) {
            seen.push(ModelChoice {
                id: id.clone(),
                label: id.clone(),
            });
        }
    }
    seen
}

/// The CodeMie CLI profiles in the parsed config, by name, with their models.
/// Secrets in the file are never read into the result.
pub fn codemie_profiles(config: &serde_json::Value) -> Vec<CodemieProfile> {
    codemie_config::list_profiles(config)
        .iter()
        .map(|p| CodemieProfile {
            name: p.name.clone(),
            models: model_choices(p),
            default_model: Some(p.model.clone()).filter(|m| !m.is_empty()),
        })
        .collect()
}

fn native_models() -> Vec<ModelChoice> {
    [
        ("", "Account default"),
        ("haiku", "Haiku"),
        ("sonnet", "Sonnet"),
        ("opus", "Opus"),
    ]
    .iter()
    .map(|(id, label)| ModelChoice {
        id: id.to_string(),
        label: label.to_string(),
    })
    .collect()
}

// ------------------------------------------------------------- command probing

pub struct ProbeOutput {
    pub stdout: String,
    pub success: bool,
}

pub type ProbeFuture<'a> = Pin<Box<dyn Future<Output = Result<ProbeOutput, String>> + Send + 'a>>;

/// Runs a program to completion. Injectable so detection is testable without the
/// real binaries.
pub trait CommandProbe: Send + Sync {
    fn run<'a>(&'a self, program: &'a Path, args: &'a [&'a str]) -> ProbeFuture<'a>;
}

/// Real probe: no stdin, 15 s timeout, killed if dropped.
#[allow(dead_code)] // used from Task 5
pub struct SystemProbe;

impl CommandProbe for SystemProbe {
    fn run<'a>(&'a self, program: &'a Path, args: &'a [&'a str]) -> ProbeFuture<'a> {
        Box::pin(async move {
            let mut child = tokio::process::Command::new(program);
            child
                .args(args)
                .stdin(std::process::Stdio::null())
                .kill_on_drop(true);
            // Detection sees the same environment as a run (only the native profile is probed).
            for k in super::command::NATIVE_ENV_REMOVE {
                child.env_remove(k);
            }
            let child = child.output();
            match tokio::time::timeout(PROBE_TIMEOUT, child).await {
                Err(_) => Err("timed out".to_string()),
                Ok(Err(e)) => Err(format!("could not run: {e}")),
                Ok(Ok(o)) => Ok(ProbeOutput {
                    stdout: String::from_utf8_lossy(&o.stdout).into_owned(),
                    success: o.status.success(),
                }),
            }
        })
    }
}

// ------------------------------------------------------------------ detection

/// Where detection looks. Fixed at construction so tests can point it at a temp dir.
#[derive(Clone)]
pub struct DetectEnv {
    pub path_var: String,
    pub home: PathBuf,
    /// Searched after the user's own dirs (for example the bundled `codemie-claude` shim).
    pub extra_dirs: Vec<PathBuf>,
    pub config_path: PathBuf,
}

impl DetectEnv {
    #[allow(dead_code)] // used from Task 5
    pub fn system(extra_dirs: Vec<PathBuf>) -> Self {
        Self {
            path_var: std::env::var("PATH").unwrap_or_default(),
            home: PathBuf::from(std::env::var("HOME").unwrap_or_default()),
            extra_dirs,
            config_path: PathBuf::from(codemie_config::config_path()),
        }
    }
}

fn profile(id: &str, kind: ProfileKind, label: &str, state: ProfileState) -> AiProfile {
    AiProfile {
        id: id.to_string(),
        kind,
        label: label.to_string(),
        state,
        version: None,
        account: None,
        models: Vec::new(),
        default_model: None,
        message: None,
    }
}

async fn detect_native(probe: &dyn CommandProbe, env: &DetectEnv) -> AiProfile {
    let mut p = profile(
        NATIVE_ID,
        ProfileKind::Native,
        "Claude Code \u{b7} your subscription",
        ProfileState::NotInstalled,
    );
    p.models = native_models();
    let Some(bin) = find_program_in("claude", &env.path_var, &env.home, &[]) else {
        p.message = Some("Claude Code is not installed.".to_string());
        return p;
    };

    p.version = match probe.run(&bin, &["--version"]).await {
        Ok(o) if o.success => parse_version(&o.stdout),
        _ => None,
    };
    if p.version.is_none() {
        p.state = ProfileState::Error;
        p.message = Some("Claude Code did not report a version.".to_string());
        return p;
    }

    let (help, auth) = tokio::join!(
        probe.run(&bin, &["--help"]),
        probe.run(&bin, &["auth", "status", "--json"])
    );
    let Ok(help) = help else {
        p.state = ProfileState::Error;
        p.message = Some("Claude Code did not answer --help.".to_string());
        return p;
    };
    let missing = missing_flags(&help.stdout);
    if !missing.is_empty() {
        p.state = ProfileState::TooOld;
        p.message = Some(format!(
            "This Claude Code is too old: it lacks {}. Update it with `claude update`.",
            missing.join(", ")
        ));
        return p;
    }

    // A logged-out `claude` may exit non-zero but still print the JSON, so the
    // exit status is not consulted.
    let status = auth
        .map_err(|e| e.to_string())
        .and_then(|o| parse_auth_status(&o.stdout));
    p.state = state_for_auth(&status);
    match status {
        Ok(AuthStatus::LoggedIn(a)) => p.account = Some(a),
        Ok(AuthStatus::LoggedOut) => {
            p.message = Some("Sign in to Claude Code with `claude auth login`.".to_string())
        }
        Err(_) => p.message = Some("Could not read the Claude Code sign-in status.".to_string()),
    }
    p
}

fn detect_codemie(env: &DetectEnv) -> Vec<AiProfile> {
    let kind_none = || ProfileKind::CodeMie {
        name: String::new(),
    };
    let found = find_program_in("codemie-claude", &env.path_var, &env.home, &env.extra_dirs);
    if found.is_none() {
        let mut p = profile(
            "codemie",
            kind_none(),
            "CodeMie",
            ProfileState::NotInstalled,
        );
        p.message = Some("The CodeMie Claude launcher (codemie-claude) was not found.".into());
        return vec![p];
    }
    let config = std::fs::read_to_string(&env.config_path)
        .ok()
        .and_then(|raw| serde_json::from_str::<serde_json::Value>(&raw).ok());
    let profiles = config.as_ref().map(codemie_profiles).unwrap_or_default();
    if profiles.is_empty() {
        let mut p = profile(
            "codemie",
            kind_none(),
            "CodeMie",
            ProfileState::NotConfigured,
        );
        p.message = Some("No CodeMie profile is configured yet.".to_string());
        return vec![p];
    }
    // Auth is confirmed by the first run, so a found binary plus a profile is Ready.
    profiles
        .into_iter()
        .map(|c| {
            let mut p = profile(
                &format!("codemie:{}", c.name),
                ProfileKind::CodeMie {
                    name: c.name.clone(),
                },
                &format!("CodeMie \u{b7} {}", c.name),
                ProfileState::Ready,
            );
            p.models = c.models;
            p.default_model = c.default_model;
            p
        })
        .collect()
}

/// Detect every AI profile. Never panics; problems show up as profile states.
pub async fn detect_profiles(probe: &dyn CommandProbe, env: &DetectEnv) -> Vec<AiProfile> {
    let mut all = vec![detect_native(probe, env).await];
    all.extend(detect_codemie(env));
    all
}

// ---------------------------------------------------------------------- cache

struct Cached {
    at: Instant,
    ttl: Duration,
    profiles: Vec<AiProfile>,
}

/// Detection results, kept 30 s (10 s when something failed). The lock is never
/// held across an await.
pub struct ProfileCache {
    probe: Arc<dyn CommandProbe>,
    env: DetectEnv,
    cached: Mutex<Option<Cached>>,
}

impl ProfileCache {
    pub fn new(probe: Arc<dyn CommandProbe>, env: DetectEnv) -> Self {
        Self {
            probe,
            env,
            cached: Mutex::new(None),
        }
    }

    #[allow(dead_code)] // used from Task 5
    pub fn system(extra_dirs: Vec<PathBuf>) -> Self {
        Self::new(Arc::new(SystemProbe), DetectEnv::system(extra_dirs))
    }

    fn fresh(&self) -> Option<Vec<AiProfile>> {
        let guard = self.cached.lock().unwrap_or_else(|e| e.into_inner());
        guard
            .as_ref()
            .filter(|c| c.at.elapsed() < c.ttl)
            .map(|c| c.profiles.clone())
    }

    #[cfg_attr(not(test), allow(dead_code))] // used from Task 5
    pub async fn profiles(&self) -> Vec<AiProfile> {
        if let Some(p) = self.fresh() {
            return p;
        }
        let profiles = detect_profiles(self.probe.as_ref(), &self.env).await;
        let failed = profiles.iter().any(|p| p.state == ProfileState::Error);
        let ttl = if failed { CACHE_FAILED } else { CACHE_OK };
        *self.cached.lock().unwrap_or_else(|e| e.into_inner()) = Some(Cached {
            at: Instant::now(),
            ttl,
            profiles: profiles.clone(),
        });
        profiles
    }

    /// Forget the cached result (Settings opened, or Test pressed).
    #[cfg_attr(not(test), allow(dead_code))] // used from Task 5
    pub fn invalidate(&self) {
        *self.cached.lock().unwrap_or_else(|e| e.into_inner()) = None;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_version_reads_claude_code_line() {
        assert_eq!(
            parse_version("2.1.322 (Claude Code)\n").as_deref(),
            Some("2.1.322")
        );
        assert_eq!(parse_version("garbage"), None);
        assert_eq!(parse_version(""), None);
    }

    #[test]
    fn auth_status_maps_logged_in_subscription_and_logged_out() {
        let ok = r#"{"loggedIn":true,"authMethod":"claude.ai","apiProvider":"firstParty","subscriptionType":"max","email":"x@example.test","orgName":"Org"}"#;
        match parse_auth_status(ok).unwrap() {
            AuthStatus::LoggedIn(a) => {
                assert_eq!(a.plan.as_deref(), Some("Max"));
                assert_eq!(a.email.as_deref(), Some("x@example.test"));
                assert_eq!(a.org.as_deref(), Some("Org"));
                assert_eq!(a.method.as_deref(), Some("claude.ai"));
            }
            other => panic!("{other:?}"),
        }
        assert_eq!(
            parse_auth_status(r#"{"loggedIn":false}"#),
            Ok(AuthStatus::LoggedOut)
        );
        assert!(parse_auth_status("Not json").is_err());
        assert_eq!(
            state_for_auth(&parse_auth_status(r#"{"loggedIn":false}"#)),
            ProfileState::NeedsLogin
        );
        assert_eq!(
            state_for_auth(&parse_auth_status("nope")),
            ProfileState::Error
        );
    }

    #[test]
    fn missing_required_flag_marks_too_old_and_names_it() {
        let full = REQUIRED_FLAGS.join("\n  ");
        assert!(missing_flags(&full).is_empty());
        let help = full.replace("--safe-mode", "");
        assert_eq!(missing_flags(&help), vec!["--safe-mode"]);
        // --print must not be satisfied by --print-something-else.
        assert_eq!(missing_flags("--printer"), REQUIRED_FLAGS.to_vec());
    }

    #[test]
    fn codemie_profiles_lists_names_and_models_without_secrets() {
        let cfg: serde_json::Value = serde_json::from_str(
            r#"{"activeProfile":"b","profiles":{
              "b":{"name":"b","provider":"ai-run-sso","model":"claude-sonnet-5","haikuModel":"claude-haiku-4-5","opusModel":"claude-opus-5","baseUrl":"https://x.test","apiKey":"SECRET-KEY","token":"SECRET-TOKEN"},
              "a":{"name":"a","provider":"litellm","model":"gpt-x"}}}"#,
        )
        .unwrap();
        let list = codemie_profiles(&cfg);
        assert_eq!(
            list.iter().map(|p| p.name.as_str()).collect::<Vec<_>>(),
            vec!["a", "b"]
        );
        let b = &list[1];
        assert_eq!(b.default_model.as_deref(), Some("claude-sonnet-5"));
        let ids: Vec<_> = b.models.iter().map(|m| m.id.as_str()).collect();
        assert_eq!(
            ids,
            vec!["claude-sonnet-5", "claude-haiku-4-5", "claude-opus-5"]
        );
        let dump = format!("{list:?}");
        assert!(!dump.contains("SECRET"), "{dump}");
    }
    struct Fake {
        calls: std::sync::atomic::AtomicUsize,
        help: String,
        auth: String,
    }

    impl CommandProbe for Fake {
        fn run<'a>(&'a self, _p: &'a Path, args: &'a [&'a str]) -> ProbeFuture<'a> {
            self.calls.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
            let out = match args[0] {
                "--version" => "2.1.322 (Claude Code)".to_string(),
                "--help" => self.help.clone(),
                _ => self.auth.clone(),
            };
            Box::pin(async move {
                Ok(ProbeOutput {
                    stdout: out,
                    success: true,
                })
            })
        }
    }

    fn exe(p: &Path) {
        use std::os::unix::fs::PermissionsExt;
        std::fs::create_dir_all(p.parent().unwrap()).unwrap();
        std::fs::write(p, "x").unwrap();
        std::fs::set_permissions(p, std::fs::Permissions::from_mode(0o755)).unwrap();
    }

    fn env_in(h: &Path) -> DetectEnv {
        DetectEnv {
            path_var: String::new(),
            home: h.to_path_buf(),
            extra_dirs: vec![],
            config_path: h.join("cfg.json"),
        }
    }

    #[tokio::test]
    async fn detects_native_and_codemie_states_and_caches() {
        let home = tempfile::tempdir().unwrap();
        let h = home.path();
        let fake = Arc::new(Fake {
            calls: Default::default(),
            help: REQUIRED_FLAGS.join(" "),
            auth: r#"{"loggedIn":true,"subscriptionType":"pro"}"#.into(),
        });

        // Nothing installed.
        let none = detect_profiles(fake.as_ref(), &env_in(h)).await;
        assert_eq!(none[0].state, ProfileState::NotInstalled);
        assert_eq!(none[1].state, ProfileState::NotInstalled);

        // Installed, no config.
        exe(&h.join(".local/bin/claude"));
        exe(&h.join(".local/bin/codemie-claude"));
        let cache = ProfileCache::new(fake.clone(), env_in(h));
        let got = cache.profiles().await;
        assert_eq!(got[0].state, ProfileState::Ready);
        assert_eq!(got[0].version.as_deref(), Some("2.1.322"));
        assert_eq!(
            got[0].account.as_ref().unwrap().plan.as_deref(),
            Some("Pro")
        );
        assert_eq!(got[1].state, ProfileState::NotConfigured);

        // Second call is served from the cache; invalidate forces a re-probe.
        let calls = fake.calls.load(std::sync::atomic::Ordering::SeqCst);
        cache.profiles().await;
        assert_eq!(fake.calls.load(std::sync::atomic::Ordering::SeqCst), calls);
        cache.invalidate();
        cache.profiles().await;
        assert!(fake.calls.load(std::sync::atomic::Ordering::SeqCst) > calls);

        // With a config, each profile is Ready with its id.
        std::fs::write(
            h.join("cfg.json"),
            r#"{"profiles":{"work":{"model":"m1"}}}"#,
        )
        .unwrap();
        cache.invalidate();
        let got = cache.profiles().await;
        assert_eq!(got[1].id, "codemie:work");
        assert_eq!(got[1].state, ProfileState::Ready);
    }

    #[tokio::test]
    async fn old_claude_is_too_old_and_logged_out_needs_login() {
        let home = tempfile::tempdir().unwrap();
        let h = home.path();
        exe(&h.join(".local/bin/claude"));
        let old = Fake {
            calls: Default::default(),
            help: "--print --model".into(),
            auth: "{}".into(),
        };
        let got = detect_profiles(&old, &env_in(h)).await;
        assert_eq!(got[0].state, ProfileState::TooOld);
        assert!(got[0].message.as_deref().unwrap().contains("--safe-mode"));

        let out = Fake {
            calls: Default::default(),
            help: REQUIRED_FLAGS.join(" "),
            auth: r#"{"loggedIn":false}"#.into(),
        };
        let got = detect_profiles(&out, &env_in(h)).await;
        assert_eq!(got[0].state, ProfileState::NeedsLogin);
    }
}
