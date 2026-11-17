//! Test doubles shared by the crate's unit tests and the tests in `tests/` (the plugin conformance
//! tests, `tests/echo_plugins.rs`), which can't see `#[cfg(test)]` items: a scripted Claude, a
//! `Core` over a temp folder, a ready Claude Code profile, and stand-ins for what plugins reach
//! outside Connect (the folder picker, the GitHub CLI). Built only for tests and with the
//! `test-support` feature, which only the crate's own dev-dependency turns on.
use crate::ai::command::{build_command, RunSpec};
use crate::ai::profiles::{AccountInfo, AiProfile, ModelChoice, ProfileKind, ProfileState};
use crate::ai::stream::{AiError, RunOutcome, Usage};
use crate::plugins::services::signin::SignInSource;
use crate::plugins::services::FolderPicker;
use futures_util::future::BoxFuture;
use serde_json::Value;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};

pub use crate::ai::fake::{FakeRunner, Gate};
pub use crate::plugins::services::http::{Client as HttpClient, Recorded};
pub use crate::workspace::Core;

/// A ready Claude Code profile on the user's own subscription.
pub fn claude_profile() -> AiProfile {
    AiProfile {
        id: "claude".into(),
        kind: ProfileKind::Native,
        label: "Claude Code · your subscription".into(),
        state: ProfileState::Ready,
        version: None,
        account: Some(AccountInfo::default()),
        models: ["", "haiku", "sonnet"]
            .iter()
            .map(|m| ModelChoice {
                id: m.to_string(),
                label: m.to_string(),
            })
            .collect(),
        default_model: None,
        message: None,
    }
}

/// A Claude answer for [`FakeRunner`] to play back.
pub fn answered(text: &str) -> RunOutcome {
    RunOutcome {
        structured: None,
        text: text.into(),
        usage: Usage {
            input_tokens: 120,
            output_tokens: 30,
            cache_read_tokens: 5,
            cache_creation_tokens: 0,
        },
        cost_usd: Some(0.012),
        duration_ms: 900,
        model: Some("claude-sonnet-4".into()),
    }
}

/// [`answered`], as the runner's script takes it.
pub fn answer(text: &str) -> Result<RunOutcome, AiError> {
    Ok(answered(text))
}

/// A `Core` over `dir` (data and private files together) with no window, Claude played back by
/// `runner`, and `profiles` as the detected AI profiles.
pub fn core(dir: &Path, runner: Arc<FakeRunner>, profiles: Vec<AiProfile>) -> Arc<Core> {
    crate::workspace::test_core(dir, runner, profiles)
}

/// The user chose `profile` as the AI profile Connect writes with (Settings → Claude).
pub fn choose_profile(core: &Core, profile: &str) {
    let mut r = core.repo().unwrap();
    let mut settings = r.settings().unwrap();
    settings.ai.default_profile = Some(profile.into());
    r.settings_update(&settings).unwrap();
}

/// What Connect keeps of `kind` (`plugin_item`, `plugin_widget`, `ai_run`, …): each record's id
/// and data.
pub fn records(core: &Core, kind: &str) -> Vec<(String, Value)> {
    core.repo()
        .and_then(|r| r.records_of_kind(kind))
        .unwrap()
        .into_iter()
        .map(|r| (r.id, r.data))
        .collect()
}

/// The arguments the Claude Code CLI would get for a run, on the [`claude_profile`].
pub fn command_args(spec: &RunSpec) -> Vec<String> {
    build_command(
        spec,
        &claude_profile(),
        Path::new("/bin/claude"),
        Path::new("/tmp/stage"),
    )
    .args
}

/// Answers the folder picker with whatever the test put in it (then nothing: the user cancelled).
#[derive(Default)]
pub struct Picked(pub Mutex<Option<PathBuf>>);

impl Picked {
    /// The folder the user picks next.
    pub fn next(&self, folder: &Path) {
        *self.0.lock().unwrap() = Some(folder.to_path_buf());
    }
}

impl FolderPicker for Picked {
    fn pick(&self, _title: String) -> BoxFuture<'static, Option<PathBuf>> {
        let picked = self.0.lock().unwrap().take();
        Box::pin(async move { picked })
    }
}

/// A made-up GitHub CLI: its token, and how often it was read.
#[derive(Default)]
pub struct FakeGh {
    pub token: Mutex<Option<String>>,
    pub reads: AtomicUsize,
}

impl FakeGh {
    /// How often the CLI's token was read.
    pub fn read_count(&self) -> usize {
        self.reads.load(Ordering::SeqCst)
    }
}

impl SignInSource for FakeGh {
    fn gh_token(&self, _host: &str) -> BoxFuture<'static, Result<Option<String>, String>> {
        self.reads.fetch_add(1, Ordering::SeqCst);
        let token = self.token.lock().unwrap().clone();
        Box::pin(async move { Ok(token) })
    }
    fn installed(&self, program: &str) -> bool {
        program == "gh"
    }
}
