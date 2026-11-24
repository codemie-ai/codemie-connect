//! The tour's quiet AI state (design § 2, § 4): the three fixed profiles the seed names, and the
//! runner every stray Claude call gets back.
use crate::ai::command::RunSpec;
use crate::ai::profiles::{AiProfile, ProfileKind, ProfileState};
use crate::ai::runner::ClaudeRunner;
use crate::ai::stream::{AiError, ErrorClass, RunEvent, RunOutcome};
use futures_util::future::BoxFuture;
use tokio_util::sync::CancellationToken;

/// The sentence every Claude run gets back — never reached: the tour's background loop is off
/// (ruling 9) and its deny-list blocks `ai_test` (design § 5).
pub const ANSWER: &str = "The tour doesn't call Claude.";

/// Answers [`ANSWER`] to every call, not only the first. Unlike `ai::fake::FakeRunner`, which
/// plays back a finite script and then falls back to a different, generic "Claude could not
/// complete the request." once it is empty, this never runs out (M2).
#[derive(Default)]
pub struct QuietRunner;

impl ClaudeRunner for QuietRunner {
    fn run<'a>(
        &'a self,
        _spec: RunSpec,
        _profile: &'a AiProfile,
        _cancel: CancellationToken,
        _on_event: Box<dyn Fn(RunEvent) + Send>,
    ) -> BoxFuture<'a, Result<RunOutcome, AiError>> {
        Box::pin(async {
            Err(AiError {
                class: ErrorClass::Failed,
                message: ANSWER.to_string(),
                spent: None,
            })
        })
    }
}

/// One of [`profiles`]'s entries.
fn profile(
    id: &str,
    kind: ProfileKind,
    provider: Option<&str>,
    label: &str,
    state: ProfileState,
    local: Option<bool>,
) -> AiProfile {
    AiProfile {
        id: id.into(),
        kind,
        provider: provider.map(str::to_string),
        label: label.into(),
        state,
        version: None,
        account: None,
        models: Vec::new(),
        default_model: None,
        message: None,
        local,
    }
}

/// The seed's three AI profiles (design § 4): Claude Code and CodeMie · prod ready, CodeMie ·
/// local-ollama not running. Ids follow the app's own CodeMie format, `codemie:<name>`
/// (`ai/profiles.rs`'s `profile()` helper, parsed back by `plugins/services/window.rs`'s
/// `strip_prefix("codemie:")`), matching `ui/test/fixtures/contract/ai-status.json` (I2).
pub fn profiles() -> Vec<AiProfile> {
    vec![
        profile(
            "claude",
            ProfileKind::Native,
            None,
            "Claude Code",
            ProfileState::Ready,
            None,
        ),
        profile(
            "codemie:prod",
            ProfileKind::CodeMie {
                name: "prod".into(),
            },
            Some("ai-run-sso"),
            "CodeMie · prod",
            ProfileState::Ready,
            None,
        ),
        profile(
            "codemie:local-ollama",
            ProfileKind::CodeMie {
                name: "local-ollama".into(),
            },
            Some("ollama"),
            "CodeMie · local-ollama",
            ProfileState::NotRunning,
            Some(true),
        ),
    ]
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ai::command::RunSpec;
    use futures_util::FutureExt;

    fn spec() -> RunSpec {
        RunSpec {
            purpose: "test".into(),
            profile_id: "claude".into(),
            model: None,
            system: String::new(),
            input: serde_json::json!({}),
            schema: None,
            timeout: std::time::Duration::from_secs(1),
            cap_usd: None,
            staging_root: std::path::PathBuf::from("/tmp"),
            folder: None,
        }
    }

    #[test]
    fn the_tour_profiles_are_two_ready_and_ollama_not_running() {
        let profiles = profiles();
        assert_eq!(profiles.len(), 3);
        assert_eq!(profiles[0].id, "claude");
        assert_eq!(profiles[0].label, "Claude Code");
        assert_eq!(profiles[0].state, ProfileState::Ready);
        assert_eq!(profiles[1].id, "codemie:prod");
        assert_eq!(profiles[1].label, "CodeMie · prod");
        assert_eq!(profiles[1].state, ProfileState::Ready);
        assert_eq!(profiles[2].id, "codemie:local-ollama");
        assert_eq!(profiles[2].label, "CodeMie · local-ollama");
        assert_eq!(profiles[2].provider.as_deref(), Some("ollama"));
        assert_eq!(profiles[2].state, ProfileState::NotRunning);
    }

    #[test]
    fn quiet_runner_answers_the_same_sentence_every_time() {
        let runner = QuietRunner;
        let profile = &profiles()[0];
        for _ in 0..3 {
            let err = runner
                .run(spec(), profile, CancellationToken::new(), Box::new(|_| {}))
                .now_or_never()
                .expect("the quiet runner never awaits")
                .expect_err("the quiet runner never answers");
            assert_eq!(err.message, ANSWER);
        }
    }
}
