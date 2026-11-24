//! The tour's quiet AI state (design § 2, § 4): the three fixed profiles the seed names, and the
//! sentence a stray Claude run would get back. The answer is never reached: the tour's background
//! loop is off (ruling 9) and its deny-list blocks `ai_test` (design § 5).
use crate::ai::fake::FakeRunner;
use crate::ai::profiles::{AiProfile, ProfileKind, ProfileState};
use crate::ai::stream::{AiError, ErrorClass};

/// The sentence a scripted Claude run answers, if one is ever started.
pub const ANSWER: &str = "The tour doesn't call Claude.";

/// A runner scripted with [`ANSWER`], for `Core::open_tour`.
pub fn fake_runner() -> FakeRunner {
    FakeRunner::new(vec![Err(AiError {
        class: ErrorClass::Failed,
        message: ANSWER.to_string(),
        spent: None,
    })])
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
/// local-ollama not running.
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
            "codemie-prod",
            ProfileKind::CodeMie {
                name: "prod".into(),
            },
            Some("ai-run-sso"),
            "CodeMie · prod",
            ProfileState::Ready,
            None,
        ),
        profile(
            "codemie-local-ollama",
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

    #[test]
    fn the_tour_profiles_are_two_ready_and_ollama_not_running() {
        let profiles = profiles();
        assert_eq!(profiles.len(), 3);
        assert_eq!(profiles[0].id, "claude");
        assert_eq!(profiles[0].label, "Claude Code");
        assert_eq!(profiles[0].state, ProfileState::Ready);
        assert_eq!(profiles[1].id, "codemie-prod");
        assert_eq!(profiles[1].label, "CodeMie · prod");
        assert_eq!(profiles[1].state, ProfileState::Ready);
        assert_eq!(profiles[2].id, "codemie-local-ollama");
        assert_eq!(profiles[2].label, "CodeMie · local-ollama");
        assert_eq!(profiles[2].provider.as_deref(), Some("ollama"));
        assert_eq!(profiles[2].state, ProfileState::NotRunning);
    }
}
