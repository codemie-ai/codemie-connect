//! `ctx.claude.run({prompt, title, profile, model, tools, dir, timeout})` (PLUGIN-ENGINE.md §4.4,
//! DESIGN 7.2): always tool-free in Connect, whatever `tools` says (it is recorded), on the
//! user's own profiles only (the one named, else the `plugin` route). The run is an `ai_run` of
//! purpose `plugin`. With `dir`, its prompt and answer are kept in the plugin's store there
//! (`prompt.md`, `answer.md`), as Echo keeps them. `timeout` is in minutes: 20 by default, 1–20.
use super::store::{inside, root};
use super::{bad, Granted, Services};
use crate::ai::stream::{AiError, ErrorClass};
use crate::plugins::host::{ErrorCode, HostError};
use crate::workspace::plugin_data::PluginRun;
use serde_json::Value;
use std::time::Duration;

const MAX_PROMPT: usize = 200_000;
const MAX_MINUTES: u64 = 20;

pub async fn run(s: &Services, p: &Granted, opts: &Value) -> Result<Value, HostError> {
    p.needs("claude", "ask Claude")?;
    let field = |k: &str| {
        opts[k]
            .as_str()
            .map(str::trim)
            .filter(|v| !v.is_empty())
            .map(str::to_string)
    };
    let prompt = opts["prompt"].as_str().unwrap_or("");
    if prompt.trim().is_empty() {
        return Err(bad("a Claude run needs a prompt"));
    }
    if prompt.chars().count() > MAX_PROMPT {
        return Err(HostError::new(
            ErrorCode::Limit,
            format!("a Claude run's prompt is {MAX_PROMPT} characters at most"),
        ));
    }
    let dir = match field("dir") {
        Some(rel) => Some(inside(&root(s, &p.id), &rel, false)?),
        None => None,
    };
    let minutes = opts["timeout"]
        .as_u64()
        .unwrap_or(MAX_MINUTES)
        .clamp(1, MAX_MINUTES);
    let run = PluginRun {
        plugin: p.id.clone(),
        title: field("title")
            .unwrap_or_else(|| format!("{}'s run", p.name))
            .chars()
            .take(200)
            .collect(),
        prompt: prompt.to_string(),
        profile: field("profile"),
        model: field("model"),
        tools: field("tools").unwrap_or_default(),
        timeout: Duration::from_secs(minutes * 60),
    };
    let core = s.core()?.clone();
    let keep = dir.map(|d| (d, run.prompt.clone()));
    let answer = core.plugin_claude(run).await.map_err(ai_failed)?;
    if let Some((dir, prompt)) = keep {
        // Best effort: the answer stands even if the plugin's folder can't take a copy.
        let saved = std::fs::create_dir_all(&dir)
            .and_then(|_| std::fs::write(dir.join("prompt.md"), prompt))
            .and_then(|_| {
                std::fs::write(
                    dir.join("answer.md"),
                    answer["answer"].as_str().unwrap_or(""),
                )
            });
        if let Err(e) = saved {
            log::warn!("[plugin:{}] its run's copy wasn't kept: {e}", p.id);
        }
    }
    Ok(answer)
}

/// A Claude failure as the plugin hears it: its class and Connect's sentence for it.
fn ai_failed(e: AiError) -> HostError {
    let class = serde_json::to_value(e.class)
        .ok()
        .and_then(|v| v.as_str().map(str::to_string))
        .unwrap_or_else(|| "failed".into());
    let code = match e.class {
        ErrorClass::Timeout => ErrorCode::Timeout,
        ErrorClass::NeedsChoice | ErrorClass::NeedsLogin | ErrorClass::NotConfigured => {
            ErrorCode::Permission
        }
        _ => ErrorCode::PluginError,
    };
    HostError::new(
        code,
        format!("Claude didn't answer ({class}): {}", e.message),
    )
}

#[cfg(test)]
pub(crate) mod tests {
    use super::super::testing::Env;
    use super::*;
    use crate::ai::fake::FakeRunner;
    use crate::ai::profiles::{AccountInfo, AiProfile, ModelChoice, ProfileKind, ProfileState};
    use crate::ai::stream::{RunOutcome, Usage};
    use crate::workspace::test_core;
    use serde_json::json;
    use std::sync::Arc;

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

    #[tokio::test]
    async fn claude_run_is_tool_free_returns_answer_and_records_ai_run() {
        let dir = tempfile::tempdir().unwrap();
        let runner = Arc::new(FakeRunner::new(vec![Ok(answered("**Done.**"))]));
        let core = test_core(dir.path(), runner.clone(), vec![claude_profile()]);
        crate::workspace::plugin_data::tests::seed(&core);
        let env = Env::with(Some(core.clone()), super::super::http::Client::new());
        env.plugin("routines", json!({"claude": {}}), json!([]));
        env.plugin("plain", json!({}), json!([]));

        let out = env
            .call_async(
                "routines",
                "claude.run",
                json!([{"prompt": "Summarise the week", "title": "Weekly", "tools": "read",
                        "model": "sonnet", "dir": "runs/weekly/1", "timeout": 5}]),
            )
            .await
            .unwrap();
        assert_eq!(out["answer"], "**Done.**");
        assert_eq!(out["model"], "claude-sonnet-4");
        assert_eq!(out["costUsd"], 0.012);
        assert_eq!(out["actions"], json!([]));
        assert_eq!(out["usage"]["input_tokens"], 120);
        assert_eq!(out["usage"]["output_tokens"], 30);

        // The run is the isolated, tool-free one, on the plugin route, whatever `tools` said.
        let spec = &runner.calls()[0];
        assert_eq!(spec.purpose, "plugin");
        assert_eq!(spec.profile_id, "claude");
        assert_eq!(spec.model.as_deref(), Some("sonnet"));
        assert_eq!(spec.timeout, Duration::from_secs(300));
        assert!(spec.schema.is_none());
        assert!(spec.system.contains("You have no tools"));
        assert_eq!(spec.input["request"], "Summarise the week");
        let plan = crate::ai::command::build_command(
            spec,
            &claude_profile(),
            std::path::Path::new("/bin/claude"),
            std::path::Path::new("/tmp/stage"),
        );
        let at = plan.args.iter().position(|a| a == "--tools").unwrap();
        assert_eq!(plan.args[at + 1], "");

        // Recorded as a plugin run, with the tools it asked for.
        let runs = core.repo().unwrap().records_of_kind("ai_run").unwrap();
        assert_eq!(runs.len(), 1);
        let run = &runs[0].data;
        assert_eq!(run["purpose"], "plugin");
        assert_eq!(run["plugin"], "routines");
        assert_eq!(run["tools"], "read");
        assert_eq!(run["refId"], "plugin:routines");
        assert_eq!(run["status"], "ok");
        assert_eq!(run["costUsd"], 0.012);
        // Its copy in the plugin's store.
        let kept = env.services.data_of("routines").join("store/runs/weekly/1");
        assert_eq!(
            std::fs::read_to_string(kept.join("answer.md")).unwrap(),
            "**Done.**"
        );
        assert_eq!(
            std::fs::read_to_string(kept.join("prompt.md")).unwrap(),
            "Summarise the week"
        );

        // Without `claude` agreed, nothing runs; a prompt is needed; dir stays in the store.
        let e = env
            .call_async("plain", "claude.run", json!([{"prompt": "x"}]))
            .await
            .unwrap_err();
        assert_eq!(e.code, ErrorCode::Permission);
        for opts in [
            json!({"prompt": "  "}),
            json!({"prompt": "x", "dir": "../out"}),
        ] {
            assert!(env
                .call_async("routines", "claude.run", json!([opts]))
                .await
                .is_err());
        }
        // A profile Connect doesn't have is refused before any run.
        let e = env
            .call_async(
                "routines",
                "claude.run",
                json!([{"prompt": "x", "profile": "acme-key"}]),
            )
            .await
            .unwrap_err();
        assert_eq!(e.code, ErrorCode::Permission, "{e}");
        assert_eq!(runner.calls().len(), 1);
    }
}
