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
    /// A local Ollama was found but `ollama list` failed or timed out.
    NotRunning,
    /// Reserved for the UI while a refresh runs; detection itself never returns it.
    #[allow(dead_code)] // the Settings UI (Task 6) shows it
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
#[serde(rename_all = "camelCase")]
pub struct AiProfile {
    pub id: String,
    pub kind: ProfileKind,
    /// The CodeMie profile's `provider` (`ai-run-sso`, `litellm`, `bedrock`, `ollama`, …);
    /// `None` for the native Claude Code. Not a secret: Settings › CodeMie shows it already.
    pub provider: Option<String>,
    pub label: String,
    pub state: ProfileState,
    pub version: Option<String>,
    pub account: Option<AccountInfo>,
    pub models: Vec<ModelChoice>,
    pub default_model: Option<String>,
    pub message: Option<String>,
    /// For an Ollama profile, whether its base URL is local (ruling 10) — the only thing that
    /// decides whether it was actually probed with `ollama list`; `None` for every other
    /// profile. Not a secret: it carries no host or path, only yes/no.
    pub local: Option<bool>,
}

/// A CodeMie CLI profile with the models it offers.
#[derive(Clone, PartialEq, Eq)]
pub struct CodemieProfile {
    pub name: String,
    pub provider: String,
    /// Read only to decide where Ollama is (`ollama_is_local`); never leaves
    /// `ai::profiles`. Redacted from `Debug` below (a `baseUrl` can carry
    /// `user:pass@host`).
    pub base_url: String,
    pub models: Vec<ModelChoice>,
    pub default_model: Option<String>,
}

impl std::fmt::Debug for CodemieProfile {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        let base_url = if self.base_url.is_empty() {
            String::new()
        } else {
            "<redacted>".to_string()
        };
        f.debug_struct("CodemieProfile")
            .field("name", &self.name)
            .field("provider", &self.provider)
            .field("base_url", &base_url)
            .field("models", &self.models)
            .field("default_model", &self.default_model)
            .finish()
    }
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
            provider: p.provider.clone(),
            base_url: p.base_url.clone(),
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

/// `ollama list`'s output: the first column of every line after the header.
/// Empty input (no header, no models) is `[]`.
pub fn parse_ollama_list(out: &str) -> Vec<String> {
    out.lines()
        .skip(1)
        .filter_map(|line| line.split_whitespace().next())
        .map(str::to_string)
        .collect()
}

/// Whether `base_url` names a local Ollama: empty, or loopback (`localhost`,
/// `127.0.0.1`, `[::1]`) with no explicit port or port `11434`. Anything else
/// (another host, another port) is remote and never probed.
pub fn ollama_is_local(base_url: &str) -> bool {
    if base_url.is_empty() {
        return true;
    }
    let Ok(url) = url::Url::parse(base_url) else {
        return false;
    };
    let host_ok = matches!(url.host_str(), Some("localhost" | "127.0.0.1" | "[::1]"));
    let port_ok = matches!(url.port(), None | Some(11434));
    host_ok && port_ok
}

/// Ollama's `:latest` rule: a name without a tag means `:latest`.
fn same_ollama_model(a: &str, b: &str) -> bool {
    fn tagged(s: &str) -> std::borrow::Cow<'_, str> {
        if s.contains(':') {
            std::borrow::Cow::Borrowed(s)
        } else {
            std::borrow::Cow::Owned(format!("{s}:latest"))
        }
    }
    tagged(a) == tagged(b)
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
            // Ruling 10: only a local Ollama is ever probed. `ollama list` itself has no
            // "local only" flag — it asks whatever `OLLAMA_HOST` names — so an `OLLAMA_HOST`
            // the app inherited (for example from a dev shell) must never reach the probe.
            child.env_remove("OLLAMA_HOST");
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
    /// The fixed OS dirs `find_program_in` always searches in production (Homebrew,
    /// `/usr/local/bin`, the Ollama.app Resources dir — see `discover::system_dirs`).
    /// Empty in tests, so a program actually installed there on the developer's own
    /// Mac cannot leak into a "nothing installed" assertion.
    pub system_dirs: Vec<PathBuf>,
    /// Searched after the user's own dirs (for example the bundled `codemie-claude` shim).
    pub extra_dirs: Vec<PathBuf>,
    pub config_path: PathBuf,
}

impl DetectEnv {
    pub fn system(extra_dirs: Vec<PathBuf>) -> Self {
        Self {
            path_var: std::env::var("PATH").unwrap_or_default(),
            home: super::discover::home_dir(),
            system_dirs: super::discover::system_dirs(),
            extra_dirs,
            config_path: PathBuf::from(codemie_config::config_path()),
        }
    }
}

fn profile(id: &str, kind: ProfileKind, label: &str, state: ProfileState) -> AiProfile {
    AiProfile {
        id: id.to_string(),
        kind,
        provider: None,
        label: label.to_string(),
        state,
        version: None,
        account: None,
        models: Vec::new(),
        default_model: None,
        message: None,
        local: None,
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
    let Some(bin) = find_program_in("claude", &env.path_var, &env.home, &env.system_dirs, &[])
    else {
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

/// What probing the local Ollama found.
enum OllamaProbe {
    NotInstalled,
    NotRunning,
    Models(Vec<String>),
}

/// Find `ollama` and run `list` once. Never runs when no local Ollama profile exists.
async fn probe_ollama(probe: &dyn CommandProbe, env: &DetectEnv) -> OllamaProbe {
    let Some(bin) = find_program_in("ollama", &env.path_var, &env.home, &env.system_dirs, &[])
    else {
        return OllamaProbe::NotInstalled;
    };
    match probe.run(&bin, &["list"]).await {
        Ok(o) if o.success => OllamaProbe::Models(parse_ollama_list(&o.stdout)),
        _ => OllamaProbe::NotRunning,
    }
}

/// The Ollama models a profile offers, and whether it is ready: the pulled models
/// (from `probe`) plus the config's own models not among them; `Ready` when the
/// profile's default model is pulled.
fn apply_ollama(p: &mut AiProfile, default_model: &Option<String>, probe: &OllamaProbe) {
    match probe {
        OllamaProbe::NotInstalled => {
            p.state = ProfileState::NotInstalled;
            p.message = Some("Ollama is not installed on this Mac.".to_string());
        }
        OllamaProbe::NotRunning => {
            p.state = ProfileState::NotRunning;
            p.message = Some("Ollama isn't running. Open Ollama, then check again.".to_string());
        }
        OllamaProbe::Models(pulled) => {
            let mut models: Vec<ModelChoice> = pulled
                .iter()
                .map(|name| ModelChoice {
                    id: name.clone(),
                    label: name.clone(),
                })
                .collect();
            for m in p.models.drain(..).collect::<Vec<_>>() {
                if !pulled.iter().any(|name| same_ollama_model(name, &m.id)) {
                    models.push(m);
                }
            }
            p.models = models;
            let pulled_default = default_model
                .as_deref()
                .is_none_or(|d| pulled.iter().any(|name| same_ollama_model(name, d)));
            if pulled_default {
                p.state = ProfileState::Ready;
            } else {
                p.state = ProfileState::NotConfigured;
                p.message = Some(format!(
                    "Ollama doesn't have {}. Pull it in Ollama, then check again.",
                    default_model.clone().unwrap_or_default()
                ));
            }
        }
    }
}

async fn detect_codemie(probe: &dyn CommandProbe, env: &DetectEnv) -> Vec<AiProfile> {
    let kind_none = || ProfileKind::CodeMie {
        name: String::new(),
    };
    let found = find_program_in(
        "codemie-claude",
        &env.path_var,
        &env.home,
        &env.system_dirs,
        &env.extra_dirs,
    );
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
    // `ollama list` is the one new probe: run at most once, only when a local
    // Ollama profile exists, and shared by every such profile.
    let is_local_ollama =
        |c: &CodemieProfile| c.provider == "ollama" && ollama_is_local(&c.base_url);
    let ollama = if profiles.iter().any(is_local_ollama) {
        Some(probe_ollama(probe, env).await)
    } else {
        None
    };
    // Auth is confirmed by the first run, so a found binary plus a profile is Ready
    // (remote and non-Ollama profiles keep this path exactly).
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
            p.provider = Some(c.provider.clone()).filter(|s| !s.is_empty());
            p.models = c.models.clone();
            p.default_model = c.default_model.clone();
            if c.provider == "ollama" {
                p.local = Some(is_local_ollama(&c));
            }
            if is_local_ollama(&c) {
                if let Some(probed) = &ollama {
                    apply_ollama(&mut p, &c.default_model, probed);
                }
            }
            p
        })
        .collect()
}

/// Detect every AI profile. Never panics; problems show up as profile states.
pub async fn detect_profiles(probe: &dyn CommandProbe, env: &DetectEnv) -> Vec<AiProfile> {
    let mut all = vec![detect_native(probe, env).await];
    all.extend(detect_codemie(probe, env).await);
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
    /// Tests of other modules pin the detected profiles instead of probing.
    #[cfg(any(test, feature = "test-support"))]
    fixed: Option<Vec<AiProfile>>,
    #[cfg(any(test, feature = "test-support"))]
    fixed_delay: Duration,
}

impl ProfileCache {
    pub fn new(probe: Arc<dyn CommandProbe>, env: DetectEnv) -> Self {
        Self {
            probe,
            env,
            cached: Mutex::new(None),
            #[cfg(any(test, feature = "test-support"))]
            fixed: None,
            #[cfg(any(test, feature = "test-support"))]
            fixed_delay: Duration::ZERO,
        }
    }

    #[cfg(any(test, feature = "test-support"))]
    pub fn fixed(profiles: Vec<AiProfile>) -> Self {
        let mut cache = Self::system(Vec::new());
        cache.fixed = Some(profiles);
        cache
    }

    /// Like [`fixed`](Self::fixed), but detection takes `delay` (a slow CLI probe).
    #[cfg(test)]
    pub fn fixed_slow(profiles: Vec<AiProfile>, delay: Duration) -> Self {
        let mut cache = Self::fixed(profiles);
        cache.fixed_delay = delay;
        cache
    }

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

    pub async fn profiles(&self) -> Vec<AiProfile> {
        #[cfg(any(test, feature = "test-support"))]
        if let Some(p) = &self.fixed {
            tokio::time::sleep(self.fixed_delay).await;
            return p.clone();
        }
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
    pub fn invalidate(&self) {
        *self.cached.lock().unwrap_or_else(|e| e.into_inner()) = None;
    }
}

#[cfg(all(test, unix))]
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
        // `base_url` ("https://x.test") is redacted from `Debug`, not just `apiKey`/`token`.
        let dump = format!("{list:?}");
        assert!(!dump.contains("SECRET"), "{dump}");
        assert!(!dump.contains("x.test"), "{dump}");
        assert!(dump.contains("<redacted>"), "{dump}");
    }
    struct Fake {
        calls: std::sync::atomic::AtomicUsize,
        help: String,
        auth: String,
        /// `ollama list`'s answer; `None` means the command fails.
        list: Option<String>,
        list_calls: std::sync::atomic::AtomicUsize,
    }

    impl CommandProbe for Fake {
        fn run<'a>(&'a self, _p: &'a Path, args: &'a [&'a str]) -> ProbeFuture<'a> {
            self.calls.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
            if args.first().copied() == Some("list") {
                self.list_calls
                    .fetch_add(1, std::sync::atomic::Ordering::SeqCst);
                let list = self.list.clone();
                return Box::pin(async move {
                    match list {
                        Some(out) => Ok(ProbeOutput {
                            stdout: out,
                            success: true,
                        }),
                        None => Err("ollama is not running".to_string()),
                    }
                });
            }
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
            // Empty, unlike `DetectEnv::system`: a real `claude`/`codemie-claude`/`ollama`
            // installed at a fixed OS dir on the developer's own Mac must never leak in.
            system_dirs: vec![],
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
            list: None,
            list_calls: Default::default(),
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
            list: None,
            list_calls: Default::default(),
        };
        let got = detect_profiles(&old, &env_in(h)).await;
        assert_eq!(got[0].state, ProfileState::TooOld);
        assert!(got[0].message.as_deref().unwrap().contains("--safe-mode"));

        let out = Fake {
            calls: Default::default(),
            help: REQUIRED_FLAGS.join(" "),
            auth: r#"{"loggedIn":false}"#.into(),
            list: None,
            list_calls: Default::default(),
        };
        let got = detect_profiles(&out, &env_in(h)).await;
        assert_eq!(got[0].state, ProfileState::NeedsLogin);
    }

    /// A `Fake` with claude already logged in; `list` is `ollama list`'s answer
    /// (`None` means the command fails).
    fn ollama_fake(list: Option<&str>) -> Fake {
        Fake {
            calls: Default::default(),
            help: REQUIRED_FLAGS.join(" "),
            auth: r#"{"loggedIn":true}"#.into(),
            list: list.map(str::to_string),
            list_calls: Default::default(),
        }
    }

    fn write_config(h: &Path, body: &str) {
        std::fs::write(h.join("cfg.json"), body).unwrap();
    }

    #[test]
    fn parse_ollama_list_reads_names() {
        let out = "NAME ID SIZE MODIFIED\nllama3.2:latest a80c 2.0 GB 2 weeks ago\nqwen3:8b 500a 5.2 GB 3 days ago\n";
        assert_eq!(parse_ollama_list(out), vec!["llama3.2:latest", "qwen3:8b"]);
        assert_eq!(parse_ollama_list(""), Vec::<String>::new());
    }

    #[test]
    fn ollama_is_local_only_for_loopback_on_11434() {
        for local in [
            "",
            "http://localhost:11434",
            "http://127.0.0.1",
            "http://[::1]:11434/",
        ] {
            assert!(ollama_is_local(local), "{local}");
        }
        for remote in ["http://localhost:11500", "https://ollama.example.test"] {
            assert!(!ollama_is_local(remote), "{remote}");
        }
    }

    /// Ruling 10: the probe never inherits a remote `OLLAMA_HOST` the app's own
    /// environment set (for example a dev shell's). `SystemProbe` is the only thing
    /// that ever actually runs a program; this test exercises it directly, against
    /// a throwaway shell script, never against a real `ollama`/`claude`/`codemie`.
    #[tokio::test]
    async fn system_probe_never_passes_on_a_remote_ollama_host() {
        let dir = tempfile::tempdir().unwrap();
        let script = dir.path().join("print-ollama-host.sh");
        std::fs::write(
            &script,
            "#!/bin/sh\nprintf 'OLLAMA_HOST=[%s]' \"$OLLAMA_HOST\"\n",
        )
        .unwrap();
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&script, std::fs::Permissions::from_mode(0o755)).unwrap();

        // SAFETY: this test alone reads `OLLAMA_HOST`; it restores the prior value
        // (absent) when done. No other test in this crate touches it.
        std::env::set_var("OLLAMA_HOST", "http://ollama.example.test:9999");
        let out = SystemProbe.run(&script, &["list"]).await.unwrap();
        std::env::remove_var("OLLAMA_HOST");

        assert!(out.success);
        assert_eq!(out.stdout, "OLLAMA_HOST=[]");
    }

    #[tokio::test]
    async fn local_ollama_profile_states_and_models() {
        let home = tempfile::tempdir().unwrap();
        let h = home.path();
        exe(&h.join(".local/bin/codemie-claude"));
        write_config(
            h,
            r#"{"profiles":{"ol":{"provider":"ollama","model":"llama3.2"}}}"#,
        );
        let env = env_in(h);

        // No ollama binary. `env.system_dirs` is empty (see `env_in`), so this is
        // deterministic on every Mac, including one with a real Ollama installed at
        // a fixed OS dir.
        let fake = ollama_fake(None);
        let got = detect_profiles(&fake, &env).await;
        let ol = got.iter().find(|p| p.id == "codemie:ol").unwrap();
        assert_eq!(ol.state, ProfileState::NotInstalled);
        assert_eq!(
            ol.message.as_deref(),
            Some("Ollama is not installed on this Mac.")
        );

        // ollama present, `list` fails.
        exe(&h.join(".local/bin/ollama"));
        let fake = ollama_fake(None);
        let got = detect_profiles(&fake, &env).await;
        let ol = got.iter().find(|p| p.id == "codemie:ol").unwrap();
        assert_eq!(ol.state, ProfileState::NotRunning);
        assert_eq!(
            ol.message.as_deref(),
            Some("Ollama isn't running. Open Ollama, then check again.")
        );

        // `list` answers both models, the default is pulled.
        let fake = ollama_fake(Some(
            "NAME ID SIZE MODIFIED\nllama3.2:latest a80c 2.0 GB 2 weeks ago\nqwen3:8b 500a 5.2 GB 3 days ago\n",
        ));
        let got = detect_profiles(&fake, &env).await;
        let ol = got.iter().find(|p| p.id == "codemie:ol").unwrap();
        assert_eq!(ol.state, ProfileState::Ready);
        assert_eq!(ol.provider.as_deref(), Some("ollama"));
        let ids: Vec<_> = ol.models.iter().map(|m| m.id.as_str()).collect();
        assert_eq!(ids, vec!["llama3.2:latest", "qwen3:8b"]);

        // `list` answers only the other model: the default is not pulled.
        let fake = ollama_fake(Some(
            "NAME ID SIZE MODIFIED\nqwen3:8b 500a 5.2 GB 3 days ago\n",
        ));
        let got = detect_profiles(&fake, &env).await;
        let ol = got.iter().find(|p| p.id == "codemie:ol").unwrap();
        assert_eq!(ol.state, ProfileState::NotConfigured);
        assert_eq!(
            ol.message.as_deref(),
            Some("Ollama doesn't have llama3.2. Pull it in Ollama, then check again.")
        );
        let ids: Vec<_> = ol.models.iter().map(|m| m.id.as_str()).collect();
        assert_eq!(ids, vec!["qwen3:8b", "llama3.2"]);
    }

    #[tokio::test]
    async fn ollama_is_probed_once_for_two_profiles() {
        let home = tempfile::tempdir().unwrap();
        let h = home.path();
        exe(&h.join(".local/bin/codemie-claude"));
        exe(&h.join(".local/bin/ollama"));
        write_config(
            h,
            r#"{"profiles":{"ol1":{"provider":"ollama","model":"llama3.2"},
                             "ol2":{"provider":"ollama","model":"qwen3:8b"}}}"#,
        );
        let fake = ollama_fake(Some(
            "NAME ID SIZE MODIFIED\nllama3.2:latest a80c 2.0 GB 2 weeks ago\nqwen3:8b 500a 5.2 GB 3 days ago\n",
        ));
        let got = detect_profiles(&fake, &env_in(h)).await;
        assert_eq!(fake.list_calls.load(std::sync::atomic::Ordering::SeqCst), 1);
        assert_eq!(got.len(), 3, "native + two CodeMie profiles");
    }

    #[tokio::test]
    async fn remote_ollama_is_not_probed_and_leaks_nothing() {
        let home = tempfile::tempdir().unwrap();
        let h = home.path();
        exe(&h.join(".local/bin/codemie-claude"));
        exe(&h.join(".local/bin/ollama"));
        write_config(
            h,
            r#"{"profiles":{"remote":{"provider":"ollama","model":"m",
                "baseUrl":"https://ollama.example.test","apiKey":"SECRET-KEY"}}}"#,
        );
        let fake = ollama_fake(None);
        let got = detect_profiles(&fake, &env_in(h)).await;
        assert_eq!(fake.list_calls.load(std::sync::atomic::Ordering::SeqCst), 0);
        let remote = got.iter().find(|p| p.id == "codemie:remote").unwrap();
        assert_eq!(remote.state, ProfileState::Ready);
        assert_eq!(remote.provider.as_deref(), Some("ollama"));
        let dump = serde_json::to_string(&got).unwrap();
        assert!(!dump.contains("SECRET"), "{dump}");
        assert!(!dump.contains("example.test"), "{dump}");
    }

    #[tokio::test]
    async fn non_ollama_codemie_profiles_keep_their_provider() {
        let home = tempfile::tempdir().unwrap();
        let h = home.path();
        exe(&h.join(".local/bin/codemie-claude"));
        write_config(
            h,
            r#"{"profiles":{"prod":{"provider":"litellm","model":"gpt-x"}}}"#,
        );
        let fake = ollama_fake(None);
        let got = detect_profiles(&fake, &env_in(h)).await;
        assert_eq!(fake.list_calls.load(std::sync::atomic::Ordering::SeqCst), 0);
        let prod = got.iter().find(|p| p.id == "codemie:prod").unwrap();
        assert_eq!(prod.provider.as_deref(), Some("litellm"));
        assert_eq!(prod.state, ProfileState::Ready);
    }
}
