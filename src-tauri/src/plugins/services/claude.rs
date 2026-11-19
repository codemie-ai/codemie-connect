//! `ctx.claude.run({prompt, title, profile, model, tools, dir, timeout, key, folder, path, mode,
//! exclude})` and `ctx.claude.stop(key)` (PLUGIN-ENGINE.md §4.4, Echo 0.10), on the user's own
//! profiles only (the one named, else the `plugin` route). The run is an `ai_run` of purpose
//! `plugin`. With `dir`, its prompt and answer are kept in the plugin's store there (`prompt.md`,
//! `answer.md`), as Echo keeps them. `timeout` is in minutes: 20 by default, 1–60.
//!
//! Without `folder` a run is tool-free, whatever `tools` says (it is recorded). With `folder` (a
//! folder the user gave the plugin, `path` a folder in it) Claude works there, with the folder's
//! own CLAUDE.md and skills and never its hooks, the web, a terminal or an MCP server:
//! - `mode: 'read'` (the default): read tools only;
//! - `mode: 'edit'`: edit tools in the folder itself (needs `folders.write`);
//! - `mode: 'copy'`: edit tools in a copy in the plugin's store (`snapshot`), answered as
//!   `snapshot: {path, files, bytes, skipped, why}`; a run that fails removes its copy.
//!
//! A folder whose `.claude/settings*.json` could send the run elsewhere (`env`, `apiKeyHelper`…)
//! is refused. One run per `key` at a time; `claude.stop(key)` stops it, and it fails `stopped`.
use super::store::{inside, root};
use super::{bad, fs, lock, snapshot, Granted, Services};
use crate::ai::command::FolderRun;
use crate::ai::stream::{AiError, ErrorClass};
use crate::plugins::host::{ErrorCode, HostError};
use crate::workspace::plugin_data::PluginRun;
use serde_json::Value;
use std::path::Path;
use std::time::Duration;
use tokio_util::sync::CancellationToken;

const MAX_PROMPT: usize = 200_000;
const DEFAULT_MINUTES: u64 = 20;
const MAX_MINUTES: u64 = 60;
/// Settings a folder's own `.claude/settings*.json` may not have: each can send a run elsewhere.
/// Claude settings keys that run a program of the folder's own to sign Claude in or send its
/// requests: always refused.
const REDIRECTING: [&str; 4] = [
    "apiKeyHelper",
    "awsAuthRefresh",
    "awsCredentialExport",
    "otelHeadersHelper",
];

/// Whether an `env` name routes Claude's requests elsewhere or as another account (Echo: "a
/// routing variable in its env"): Anthropic's endpoint, keys and models, the cloud providers and
/// their credentials, a proxy, another config folder, an OAuth token, the TLS trust. A folder's
/// own telemetry (`OTEL_*`, `CLAUDE_CODE_ENABLE_TELEMETRY`) and other settings aren't routing.
fn routing_variable(name: &str) -> bool {
    let n = name.to_ascii_uppercase();
    const PREFIXES: [&str; 7] = [
        "ANTHROPIC_",
        "AWS_",
        "CLAUDE_CODE_USE_",
        "CLAUDE_CODE_SKIP_",
        "CLOUD_ML_",
        "GOOGLE_",
        "VERTEX_",
    ];
    const NAMES: [&str; 8] = [
        "HTTP_PROXY",
        "HTTPS_PROXY",
        "ALL_PROXY",
        "NO_PROXY",
        "CLAUDE_CONFIG_DIR",
        "CLAUDE_CODE_OAUTH_TOKEN",
        "NODE_EXTRA_CA_CERTS",
        "NODE_TLS_REJECT_UNAUTHORIZED",
    ];
    PREFIXES.iter().any(|p| n.starts_with(p)) || NAMES.contains(&n.as_str())
}

/// The runs going on under a key, by plugin and key (lowercase): their stop tokens.
#[derive(Default)]
pub struct Keyed(std::collections::HashMap<(String, String), CancellationToken>);

/// Holds a key while its run lasts.
pub(super) struct KeyHold<'a> {
    s: &'a Services,
    slot: (String, String),
}

impl Drop for KeyHold<'_> {
    fn drop(&mut self) {
        lock(&self.s.runs).0.remove(&self.slot);
    }
}

pub(super) fn claim<'a>(
    s: &'a Services,
    plugin: &str,
    key: &str,
    token: &CancellationToken,
) -> Result<KeyHold<'a>, HostError> {
    let slot = (plugin.to_string(), key.to_lowercase());
    let mut runs = lock(&s.runs);
    if runs.0.contains_key(&slot) {
        return Err(bad(format!(
            "the run's key is busy: a run with key “{key}” is running already"
        )));
    }
    runs.0.insert(slot.clone(), token.clone());
    Ok(KeyHold { s, slot })
}

/// `claude.stop(key)`: stops the plugin's run under `key`; whether one was running.
pub fn stop(s: &Services, p: &Granted, key: &str) -> Result<Value, HostError> {
    p.needs("claude", "ask Claude")?;
    let slot = (p.id.clone(), key.to_lowercase());
    Ok(match lock(&s.runs).0.get(&slot) {
        Some(token) => {
            token.cancel();
            Value::Bool(true)
        }
        None => Value::Bool(false),
    })
}

/// The folder's own Claude settings refuse it when they could send the run elsewhere.
pub(crate) fn refuse_redirecting(dir: &Path) -> Result<(), HostError> {
    for name in ["settings.json", "settings.local.json"] {
        let f = dir.join(".claude").join(name);
        let Ok(text) = std::fs::read_to_string(&f) else {
            continue;
        };
        let found: Vec<String> = match serde_json::from_str::<Value>(&text) {
            Ok(Value::Object(m)) => {
                let mut found: Vec<String> = REDIRECTING
                    .iter()
                    .filter(|k| m.contains_key(**k))
                    .map(|k| (*k).to_string())
                    .collect();
                match m.get("env") {
                    None => {}
                    Some(Value::Object(env)) => found.extend(
                        env.keys()
                            .filter(|k| routing_variable(k))
                            .map(|k| format!("env {k}")),
                    ),
                    // An `env` Connect can't read could hold anything.
                    Some(_) => found.push("env".into()),
                }
                found
            }
            _ => vec!["(settings Connect can't read)".into()],
        };
        if !found.is_empty() {
            return Err(HostError::new(
                ErrorCode::Permission,
                format!(
                    "this folder has Claude settings of its own (.claude/{name}: {}) that could send the run elsewhere, so Connect doesn't run Claude in it",
                    found.join(", ")
                ),
            ));
        }
    }
    Ok(())
}

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
        .unwrap_or(DEFAULT_MINUTES)
        .clamp(1, MAX_MINUTES);
    let key = match &opts["key"] {
        Value::Null => None,
        Value::String(k)
            if (1..=64).contains(&k.len())
                && k.bytes()
                    .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'.' | b'_' | b'-')) =>
        {
            Some(k.clone())
        }
        _ => return Err(bad("a run's key is 1–64 letters, digits, . _ -")),
    };
    // Where it runs, when in a folder: (mode, the folder).
    let place = match field("folder") {
        None => None,
        Some(folder) => {
            let mode = field("mode").unwrap_or_else(|| "read".into());
            let base = match mode.as_str() {
                "read" | "copy" => fs::root_of(s, p, &folder)?,
                "edit" => fs::writable_root(s, p, &folder)?,
                _ => return Err(bad("mode: read, edit or copy")),
            };
            let at = match field("path") {
                Some(rel) => fs::resolve(&base, &rel)?,
                None => base.clone(),
            };
            if !at.is_dir() {
                return Err(bad("a run's path is a folder in the folder it was given"));
            }
            refuse_redirecting(&base)?;
            refuse_redirecting(&at)?;
            Some((mode, at))
        }
    };
    let core = s.core()?.clone();
    let token = core.plugin_stop_token();
    let _hold = match &key {
        Some(k) => Some(claim(s, &p.id, k, &token)?),
        None => None,
    };
    let exclude: Vec<String> = opts["exclude"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(Value::as_str)
        .map(str::to_string)
        .collect();
    let snap = match &place {
        Some((mode, at)) if mode == "copy" => {
            let store = root(s, &p.id);
            let at = at.clone();
            Some(
                tauri::async_runtime::spawn_blocking(move || snapshot::take(&store, &at, &exclude))
                    .await
                    .map_err(|e| bad(e.to_string()))??,
            )
        }
        _ => None,
    };
    let folder = place.as_ref().map(|(mode, at)| FolderRun {
        dir: snap.as_ref().map_or_else(|| at.clone(), |x| x.dir.clone()),
        edit: mode != "read",
    });
    let tools = match &place {
        Some((mode, _)) => mode.clone(),
        None => field("tools").unwrap_or_default(),
    };
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
        tools,
        timeout: Duration::from_secs(minutes * 60),
        folder,
        cancel: token.clone(),
    };
    let keep = dir.map(|d| (d, run.prompt.clone()));
    let answer = match core.plugin_claude(run).await {
        Ok(answer) => answer,
        Err(e) => {
            if let Some(x) = &snap {
                x.remove();
            }
            if token.is_cancelled() && e.class == ErrorClass::Cancelled {
                return Err(bad("stopped"));
            }
            return Err(ai_failed(e));
        }
    };
    let mut answer = answer;
    if let Some(x) = &snap {
        answer["snapshot"] = x.answer.clone();
    }
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
    use crate::workspace::test_core;
    use serde_json::json;
    use std::sync::Arc;

    pub use crate::testing::{answered, claude_profile};

    /// A plugin granted a vault (`folders`, with `write` when asked) and `claude`, over a core
    /// whose runner plays `runner`.
    async fn vault_env(runner: Arc<FakeRunner>, write: bool) -> (tempfile::TempDir, Env, String) {
        let dir = tempfile::Builder::new()
            .prefix("connect-")
            .tempdir()
            .unwrap();
        let core = test_core(dir.path(), runner, vec![claude_profile()]);
        crate::workspace::plugin_data::tests::seed(&core);
        let env = Env::with(Some(core), super::super::http::Client::new());
        env.plugin(
            "kn",
            json!({"claude": {}, "folders": {"write": write}}),
            json!([]),
        );
        let vault = env.dir.path().join("Vault");
        for (p, t) in [
            ("notes/a.md", "# A"),
            ("CLAUDE.md", "Rules"),
            (".git/config", "x"),
            (".obsidian/plugins/x/main.js", "code"),
        ] {
            let f = vault.join(p);
            std::fs::create_dir_all(f.parent().unwrap()).unwrap();
            std::fs::write(f, t).unwrap();
        }
        env.picker.next(&vault);
        let root = env
            .call_async("kn", "system.pickFolder", json!(["A vault"]))
            .await
            .unwrap();
        (dir, env, root.as_str().unwrap().to_string())
    }

    #[tokio::test]
    async fn a_read_run_works_in_the_vault_with_read_tools() {
        let runner = Arc::new(FakeRunner::new(vec![Ok(answered("[]"))]));
        let (_d, env, root) = vault_env(runner.clone(), false).await;
        let out = env
            .call_async(
                "kn",
                "claude.run",
                json!([{"prompt": "Check the vault", "folder": root, "mode": "read", "timeout": 60, "key": "lint-v"}]),
            )
            .await
            .unwrap();
        assert_eq!(out["answer"], "[]");
        assert!(out.get("snapshot").is_none());
        let spec = &runner.calls()[0];
        let folder = spec.folder.as_ref().unwrap();
        assert_eq!(folder.dir, Path::new(&root));
        assert!(!folder.edit);
        assert_eq!(spec.timeout, Duration::from_secs(3600));
        assert!(spec.system.contains("folder of the user's notes"));
        // The key is free again once the run is over.
        assert_eq!(
            env.call("kn", "claude.stop", json!(["lint-v"])).unwrap(),
            json!(false)
        );
        // Edit needs folders.write; a mode Connect doesn't know is refused; so is a bad key.
        for (opts, says) in [
            (
                json!({"prompt": "x", "folder": root, "mode": "edit"}),
                "folders.write",
            ),
            (
                json!({"prompt": "x", "folder": root, "mode": "yolo"}),
                "mode: read, edit or copy",
            ),
            (json!({"prompt": "x", "key": "bad key"}), "a run's key"),
            (
                json!({"prompt": "x", "folder": "/etc"}),
                "isn't a folder you gave",
            ),
        ] {
            let e = env
                .call_async("kn", "claude.run", json!([opts]))
                .await
                .unwrap_err();
            assert!(e.message.contains(says), "{opts}: {e}");
        }
        assert_eq!(runner.calls().len(), 1);
    }

    #[tokio::test]
    async fn a_copy_run_edits_a_snapshot_which_a_failed_run_removes() {
        let runner = Arc::new(FakeRunner::new(vec![
            Ok(answered("Done")),
            Err(AiError::new(ErrorClass::Failed)),
        ]));
        // Claude changes a page in the folder it was started in.
        runner.on_run(|spec| {
            if let Some(f) = &spec.folder {
                std::fs::write(f.dir.join("notes/a.md"), "# A, edited").unwrap();
            }
        });
        let (_d, env, root) = vault_env(runner.clone(), false).await;
        let out = env
            .call_async(
                "kn",
                "claude.run",
                json!([{"prompt": "Ingest", "folder": root, "mode": "copy", "exclude": ["CLAUDE.md"]}]),
            )
            .await
            .unwrap();
        // Echo's answer, as the plugin's fakes give it.
        assert!(
            super::super::testing::has_shape(
                &out,
                &json!({"answer": "str", "model": "str", "actions": "empty",
                   "usage": {"input_tokens": "num", "output_tokens": "num", "cost_usd": "num"},
                   "snapshot": {"path": "str", "files": "num", "bytes": "num", "skipped": "num",
                                "why": {"large": "num", "unreadable": "num"}}})
            ),
            "{out}"
        );
        let snap = &out["snapshot"];
        let path = snap["path"].as_str().unwrap();
        assert!(path.starts_with("cache/snapshots/"), "{snap}");
        assert_eq!(snap["files"], 1, "notes/a.md only: {snap}");
        assert_eq!(snap["why"], json!({"large": 0, "unreadable": 0}));
        let spec = &runner.calls()[0];
        assert!(spec.folder.as_ref().unwrap().edit);
        // The copy changed; the user's vault didn't.
        assert_eq!(
            env.call("kn", "store.read", json!([format!("{path}/notes/a.md")]))
                .unwrap(),
            json!("# A, edited")
        );
        assert_eq!(
            std::fs::read_to_string(Path::new(&root).join("notes/a.md")).unwrap(),
            "# A"
        );
        let e = env
            .call_async(
                "kn",
                "claude.run",
                json!([{"prompt": "Ingest", "folder": root, "mode": "copy"}]),
            )
            .await
            .unwrap_err();
        assert!(e.message.contains("Claude didn't answer"), "{e}");
        let kept = env
            .call("kn", "store.list", json!(["cache/snapshots"]))
            .unwrap();
        assert_eq!(
            kept.as_array().unwrap().len(),
            1,
            "the failed run's copy is gone: {kept}"
        );
    }

    #[tokio::test]
    async fn one_run_per_key_and_stop_stops_it() {
        let (runner, gate) = FakeRunner::gated(vec![Ok(answered("late"))]);
        let runner = Arc::new(runner);
        let (_d, env, root) = vault_env(runner.clone(), false).await;
        let env = Arc::new(env);
        let first = {
            let env = env.clone();
            let root = root.clone();
            tokio::spawn(async move {
                env.call_async(
                    "kn",
                    "claude.run",
                    json!([{"prompt": "x", "folder": root, "key": "Ingest-1"}]),
                )
                .await
            })
        };
        gate.started.notified().await;
        let e = env
            .call_async(
                "kn",
                "claude.run",
                json!([{"prompt": "y", "key": "ingest-1"}]),
            )
            .await
            .unwrap_err();
        assert!(e.message.contains("the run's key is busy"), "{e}");
        assert_eq!(
            env.call("kn", "claude.stop", json!(["INGEST-1"])).unwrap(),
            json!(true)
        );
        let e = first.await.unwrap().unwrap_err();
        assert_eq!(e.message, "stopped");
    }

    #[tokio::test]
    async fn a_folder_whose_claude_settings_redirect_runs_is_refused() {
        let runner = Arc::new(FakeRunner::new(vec![]));
        let (_d, env, root) = vault_env(runner.clone(), true).await;
        std::fs::create_dir_all(Path::new(&root).join(".claude")).unwrap();
        std::fs::write(
            Path::new(&root).join(".claude/settings.local.json"),
            r#"{"env": {"ANTHROPIC_BASE_URL": "https://elsewhere.example"}}"#,
        )
        .unwrap();
        let e = env
            .call_async("kn", "claude.run", json!([{"prompt": "x", "folder": root}]))
            .await
            .unwrap_err();
        assert_eq!(e.code, ErrorCode::Permission);
        assert!(
            e.message
                .contains(".claude/settings.local.json: env ANTHROPIC_BASE_URL"),
            "{e}"
        );
        assert!(runner.calls().is_empty());
        // A proxy, another account's folder, a cloud provider: each sends the run elsewhere.
        for (k, v) in [
            ("HTTPS_PROXY", "http://proxy.example:8080"),
            ("CLAUDE_CONFIG_DIR", "/elsewhere"),
            ("CLAUDE_CODE_USE_BEDROCK", "1"),
            ("AWS_PROFILE", "other"),
            ("https_proxy", "http://proxy.example:8080"),
        ] {
            std::fs::write(
                Path::new(&root).join(".claude/settings.json"),
                json!({"env": {k: v}}).to_string(),
            )
            .unwrap();
            std::fs::remove_file(Path::new(&root).join(".claude/settings.local.json")).ok();
            assert!(
                super::refuse_redirecting(Path::new(&root)).is_err(),
                "{k} routes the run"
            );
        }
    }

    #[test]
    fn a_folders_own_telemetry_and_other_settings_are_not_routing() {
        // A twin vault as CodeMie sets one up: its own telemetry, plugins and permissions.
        let dir = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(dir.path().join(".claude")).unwrap();
        std::fs::write(
            dir.path().join(".claude/settings.local.json"),
            json!({"env": {"CLAUDE_CODE_ENABLE_TELEMETRY": "1", "OTEL_EXPORTER_OTLP_ENDPOINT": "https://otel.example",
                           "OTEL_EXPORTER_OTLP_PROTOCOL": "http/json", "OTEL_LOGS_EXPORTER": "otlp",
                           "OTEL_METRICS_EXPORTER": "otlp", "OTEL_METRICS_INCLUDE_SESSION_ID": "true",
                           "MAX_THINKING_TOKENS": "8000"},
                   "enabledPlugins": {"x@y": true}, "permissions": {"allow": ["Read"]}})
            .to_string(),
        )
        .unwrap();
        assert_eq!(super::refuse_redirecting(dir.path()), Ok(()));
        // Settings that aren't JSON are still refused: Connect can't tell what they do.
        std::fs::write(dir.path().join(".claude/settings.json"), "{ not json").unwrap();
        assert!(super::refuse_redirecting(dir.path()).is_err());
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
