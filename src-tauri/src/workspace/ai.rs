//! Workspace side of the AI features (DESIGN 6.1/6.2): which Claude profile serves which
//! purpose, the Settings operations, and the usage ledger. Running Claude itself is the
//! `crate::ai` runner's job; the draft and summary jobs are in `ai_jobs`.
use super::{models::*, Core};
use crate::ai::command::RunSpec;
use crate::ai::profiles::{AiProfile, ProfileState};
use crate::ai::stream::{AiError, ErrorClass, RunOutcome};
use serde_json::{json, Value};
use std::time::Duration;

/// The ledger purpose of the Settings test run; not a routable [`Purpose`].
const TEST_PURPOSE: &str = "test";
const TEST_TIMEOUT: Duration = Duration::from_secs(60);

/// The snake_case name of a serde enum value (`needs_login`, `mail_draft`).
pub(super) fn wire_name<T: serde::Serialize>(value: T) -> String {
    serde_json::to_value(value)
        .ok()
        .and_then(|v| v.as_str().map(str::to_string))
        .unwrap_or_else(|| "failed".into())
}

/// A Claude failure as a workspace error: the code is the class (so the UI can match
/// `needs_choice`), and `class` marks it as Claude's rather than Microsoft's.
impl From<AiError> for WorkspaceError {
    fn from(e: AiError) -> Self {
        let class = wire_name(e.class);
        let mut error = WorkspaceError::new(&class, e.message);
        error.class = Some(class);
        error
    }
}

/// The error that explains an unready profile, `None` when it can run.
fn unready_error(profile: &AiProfile) -> Option<AiError> {
    let class = match profile.state {
        ProfileState::Ready => return None,
        ProfileState::NotInstalled => ErrorClass::NotInstalled,
        ProfileState::TooOld => ErrorClass::TooOld,
        ProfileState::NeedsLogin => ErrorClass::NeedsLogin,
        ProfileState::NotConfigured => ErrorClass::NotConfigured,
        ProfileState::Checking | ProfileState::Error => ErrorClass::Failed,
    };
    let mut e = AiError::new(class);
    if let Some(m) = profile.message.as_ref().filter(|m| !m.is_empty()) {
        e.message = m.clone();
    }
    Some(e)
}

/// The profile and model for one purpose: its own route, else the default. With neither
/// chosen the caller must ask the user (`NeedsChoice`); nothing is picked automatically.
pub fn resolve_route(
    settings: &AiSettings,
    profiles: &[AiProfile],
    purpose: Purpose,
) -> std::result::Result<(AiProfile, Option<String>), AiError> {
    let route = settings.routes.get(&purpose);
    let id =
        chosen_profile(settings, purpose).ok_or_else(|| AiError::new(ErrorClass::NeedsChoice))?;
    let profile = profiles
        .iter()
        .find(|p| &p.id == id)
        .ok_or_else(|| AiError::new(ErrorClass::NotConfigured))?;
    if let Some(e) = unready_error(profile) {
        return Err(e);
    }
    Ok((profile.clone(), route.and_then(|r| r.model.clone())))
}

/// The profile id `purpose` is routed to, `None` until the user has chosen one.
pub(super) fn chosen_profile(settings: &AiSettings, purpose: Purpose) -> Option<&String> {
    settings
        .routes
        .get(&purpose)
        .and_then(|r| r.profile.as_ref())
        .or(settings.default_profile.as_ref())
}

fn invalid(message: &str) -> WorkspaceError {
    WorkspaceError::new("validation", message)
}

/// A model must be one the profile offers; empty means the profile's own default.
fn checked_model(profile: &AiProfile, model: Option<&str>) -> Result<Option<String>> {
    match model.filter(|m| !m.is_empty()) {
        None => Ok(None),
        Some(m) if profile.models.iter().any(|c| c.id == m) => Ok(Some(m.to_string())),
        Some(_) => Err(invalid("That model is not offered by this Claude profile.")),
    }
}

/// Checks every profile id and model of `settings` against the detected profiles and
/// returns the normalised settings (empty routes dropped).
fn validate_ai_settings(settings: AiSettings, profiles: &[AiProfile]) -> Result<AiSettings> {
    let find = |id: &str| {
        profiles
            .iter()
            .find(|p| p.id == id)
            .ok_or_else(|| invalid("Choose one of the listed Claude profiles."))
    };
    let default = settings.default_profile.filter(|d| !d.is_empty());
    if let Some(d) = &default {
        find(d)?;
    }
    let mut routes = std::collections::BTreeMap::new();
    for (purpose, route) in settings.routes {
        let profile = route.profile.filter(|p| !p.is_empty());
        let model = route.model.filter(|m| !m.is_empty());
        if profile.is_none() && model.is_none() {
            continue;
        }
        let effective = profile
            .as_deref()
            .or(default.as_deref())
            .ok_or_else(|| invalid("Choose a Claude profile before choosing a model."))?;
        let model = checked_model(find(effective)?, model.as_deref())?;
        routes.insert(purpose, Route { profile, model });
    }
    Ok(AiSettings {
        default_profile: default,
        routes,
    })
}

fn month_now(time_zone: &str) -> String {
    let now = chrono::Utc::now();
    match time_zone.parse::<chrono_tz::Tz>() {
        Ok(tz) => now.with_timezone(&tz).format("%Y-%m").to_string(),
        Err(_) => now.format("%Y-%m").to_string(),
    }
}

fn valid_month(month: &str) -> bool {
    let b = month.as_bytes();
    b.len() == 7
        && b[4] == b'-'
        && b.iter()
            .enumerate()
            .all(|(i, c)| i == 4 || c.is_ascii_digit())
        && matches!(
            &month[5..],
            "01" | "02" | "03" | "04" | "05" | "06" | "07" | "08" | "09" | "10" | "11" | "12"
        )
}

impl Core {
    /// The profile and model for `purpose` from the saved settings and a fresh-enough
    /// detection. Errors are the class a caller shows (including `NeedsChoice`).
    pub(super) async fn route(
        &self,
        purpose: Purpose,
    ) -> std::result::Result<(AiProfile, Option<String>), AiError> {
        let settings = self
            .repo()
            .and_then(|r| r.settings())
            .map_err(|_| AiError::new(ErrorClass::Failed))?;
        resolve_route(&settings.ai, &self.profiles.profiles().await, purpose)
    }

    /// Appends one `ai_run` record. Never fails the caller: a ledger problem is logged
    /// (without any message content) and the run's own result still stands.
    pub(super) fn record_ai_run(
        &self,
        spec: &RunSpec,
        result: &std::result::Result<RunOutcome, AiError>,
        elapsed: Duration,
        ref_id: Option<&str>,
    ) {
        self.record_run(
            spec,
            result.as_ref().ok(),
            result.as_ref().err(),
            elapsed,
            ref_id,
        );
    }

    /// The ledger entry of one run: `error` sets the status, and whatever the run reported
    /// (`outcome`) is kept even when its answer could not be used, so its cost still counts.
    pub(super) fn record_run(
        &self,
        spec: &RunSpec,
        outcome: Option<&RunOutcome>,
        error: Option<&AiError>,
        elapsed: Duration,
        ref_id: Option<&str>,
    ) {
        let status = error.map_or_else(|| "ok".to_string(), |e| wire_name(e.class));
        let model = outcome
            .and_then(|o| o.model.clone())
            .or_else(|| spec.model.clone());
        let duration = outcome.map_or(elapsed.as_millis() as u64, |o| o.duration_ms);
        let tokens = outcome.map_or(Value::Null, |o| {
            json!({
                "input": o.usage.input_tokens,
                "output": o.usage.output_tokens,
                "cacheRead": o.usage.cache_read_tokens,
                "cacheCreation": o.usage.cache_creation_tokens,
            })
        });
        let cost = outcome.and_then(|o| o.cost_usd);
        let at = now();
        let zone = self
            .repo()
            .and_then(|r| r.settings())
            .map(|s| s.time_zone)
            .unwrap_or_default();
        let record = Record {
            id: id(),
            kind: "ai_run".into(),
            connection_id: None,
            workspace_id: None,
            source: "ai".into(),
            revision: id(),
            updated_at: at,
            data: json!({
                "purpose": spec.purpose,
                "profile": spec.profile_id,
                "model": model,
                "status": status,
                "durationMs": duration,
                "tokens": tokens,
                "costUsd": cost,
                "refId": ref_id,
                "month": month_now(&zone),
                "at": at,
            }),
        };
        if let Err(e) = self.repo().and_then(|mut r| r.put_ai_run(&record)) {
            log::warn!("ai: cannot record usage: {}", e.code);
        }
    }

    /// `ai_status`: the detected profiles and the saved routing. `refresh` re-detects.
    pub(super) async fn ai_status(&self, req: &Request) -> Result<Value> {
        if req.data["refresh"].as_bool() == Some(true) {
            self.profiles.invalidate();
        }
        let profiles = self.profiles.profiles().await;
        let settings = self.repo()?.settings()?.ai;
        Ok(json!({"profiles": profiles, "settings": settings}))
    }

    /// `ai_usage`: this month's (default) runs and cost, in total and per profile.
    pub(super) fn ai_usage(&self, req: &Request) -> Result<Value> {
        let month = match req.data["month"].as_str() {
            Some(m) if valid_month(m) => m.to_string(),
            Some(_) => return Err(invalid("Choose a month as YYYY-MM.")),
            None => month_now(&self.repo()?.settings()?.time_zone),
        };
        self.repo()?.ai_usage(&month)
    }

    /// `ai_settings_save {defaultProfile, routes}`.
    /// `profiles` were detected by the caller before the mutation lock was taken.
    pub(super) fn ai_settings_save(&self, req: &Request, profiles: &[AiProfile]) -> Result<Value> {
        let wanted: AiSettings = serde_json::from_value(req.data.clone())
            .map_err(|_| invalid("Those AI settings are not valid."))?;
        let ai = validate_ai_settings(wanted, profiles)?;
        let mut r = self.repo()?;
        let mut s = r.settings()?;
        s.ai = ai.clone();
        r.settings_update(&s)?;
        Ok(json!({"settings": ai}))
    }

    /// `ai_test {profileId, model?}`: one tiny isolated run that proves sign-in and model.
    /// A failing profile is an answer, not an error: `{ok:false, errorClass, message}`.
    pub(super) async fn ai_test(&self, req: &Request) -> Result<Value> {
        let profile_id = super::required(&req.data, "profileId", 200)?;
        self.profiles.invalidate();
        let profiles = self.profiles.profiles().await;
        let profile = profiles
            .iter()
            .find(|p| p.id == profile_id)
            .ok_or_else(|| invalid("Choose one of the listed Claude profiles."))?;
        let model = checked_model(profile, req.data["model"].as_str())?;
        let failed = |e: &AiError, ms: u128| json!({"ok": false, "ms": ms as u64, "errorClass": e.class, "message": e.message});
        if let Some(e) = unready_error(profile) {
            return Ok(failed(&e, 0));
        }
        let spec = RunSpec {
            purpose: TEST_PURPOSE.into(),
            profile_id: profile.id.clone(),
            model: model.clone(),
            system: "Reply with ok=true.".into(),
            input: json!({}),
            schema: Some(json!({
                "type": "object",
                "properties": {"ok": {"type": "boolean"}},
                "required": ["ok"]
            })),
            timeout: TEST_TIMEOUT,
            cap_usd: None,
            staging_root: self.data_dir.join("ai-staging"),
        };
        let started = std::time::Instant::now();
        let ledger_spec = spec.clone();
        let result = self
            .runner
            .run(
                spec,
                profile,
                self.ai_cancel.child_token(),
                Box::new(|_| {}),
            )
            .await;
        let elapsed = started.elapsed();
        self.record_ai_run(&ledger_spec, &result, elapsed, None);
        Ok(match result {
            Ok(o) => json!({
                "ok": o.structured.as_ref().is_some_and(|s| s["ok"] == true),
                "ms": o.duration_ms,
                "costUsd": o.cost_usd,
                "model": o.model.or(model),
            }),
            Err(e) => failed(&e, elapsed.as_millis()),
        })
    }
}

#[cfg(test)]
pub(super) mod tests {
    use super::*;
    use crate::ai::fake::FakeRunner;
    use crate::ai::profiles::{AccountInfo, ModelChoice, ProfileKind};
    use crate::ai::stream::Usage;
    use crate::workspace::test_core;
    use std::sync::Arc;

    fn profile(id: &str, state: ProfileState) -> AiProfile {
        AiProfile {
            id: id.into(),
            kind: if id == "claude" {
                ProfileKind::Native
            } else {
                ProfileKind::CodeMie {
                    name: id.trim_start_matches("codemie:").into(),
                }
            },
            label: id.into(),
            state,
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
    pub(crate) fn ready() -> Vec<AiProfile> {
        vec![
            profile("claude", ProfileState::Ready),
            profile("codemie:prod", ProfileState::Ready),
        ]
    }
    fn outcome(cost: f64) -> RunOutcome {
        RunOutcome {
            structured: Some(json!({"ok": true})),
            text: String::new(),
            usage: Usage {
                input_tokens: 10,
                output_tokens: 5,
                ..Default::default()
            },
            cost_usd: Some(cost),
            duration_ms: 1200,
            model: Some("claude-haiku".into()),
        }
    }
    fn request(op: Operation, data: Value) -> Request {
        Request {
            op,
            workspace_id: Some("personal".into()),
            expected_revision: None,
            operation_id: None,
            data,
        }
    }
    /// A mutation request carrying the operation id and the current revision.
    pub(crate) fn mutation(core: &Core, op: Operation, data: Value) -> Request {
        let mut r = request(op, data);
        r.operation_id = Some(id());
        r.expected_revision = Some(core.repo().unwrap().revision().unwrap());
        r
    }

    #[test]
    fn resolve_route_without_choice_needs_choice() {
        let e = resolve_route(&AiSettings::default(), &ready(), Purpose::MailDraft).unwrap_err();
        assert_eq!(e.class, ErrorClass::NeedsChoice);
        // Detected profiles never become an automatic choice.
        let only = [profile("claude", ProfileState::Ready)];
        assert!(resolve_route(&AiSettings::default(), &only, Purpose::Summary).is_err());
    }

    #[test]
    fn resolve_route_uses_route_then_default() {
        let mut s = AiSettings {
            default_profile: Some("claude".into()),
            ..Default::default()
        };
        s.routes.insert(
            Purpose::Summary,
            Route {
                profile: Some("codemie:prod".into()),
                model: Some("sonnet".into()),
            },
        );
        s.routes.insert(
            Purpose::ChatDraft,
            Route {
                profile: None,
                model: Some("haiku".into()),
            },
        );
        let (p, m) = resolve_route(&s, &ready(), Purpose::Summary).unwrap();
        assert_eq!(
            (p.id.as_str(), m.as_deref()),
            ("codemie:prod", Some("sonnet"))
        );
        let (p, m) = resolve_route(&s, &ready(), Purpose::ChatDraft).unwrap();
        assert_eq!((p.id.as_str(), m.as_deref()), ("claude", Some("haiku")));
        let (p, m) = resolve_route(&s, &ready(), Purpose::MailDraft).unwrap();
        assert_eq!((p.id.as_str(), m), ("claude", None));
    }

    #[test]
    fn resolve_route_unready_profile_errors_with_state() {
        let s = AiSettings {
            default_profile: Some("claude".into()),
            ..Default::default()
        };
        for (state, class) in [
            (ProfileState::NotInstalled, ErrorClass::NotInstalled),
            (ProfileState::TooOld, ErrorClass::TooOld),
            (ProfileState::NeedsLogin, ErrorClass::NeedsLogin),
            (ProfileState::NotConfigured, ErrorClass::NotConfigured),
            (ProfileState::Error, ErrorClass::Failed),
        ] {
            let e = resolve_route(&s, &[profile("claude", state)], Purpose::Plugin).unwrap_err();
            assert_eq!(e.class, class);
        }
        // A saved profile that no longer exists is reported, not replaced.
        let gone = AiSettings {
            default_profile: Some("codemie:old".into()),
            ..Default::default()
        };
        assert_eq!(
            resolve_route(&gone, &ready(), Purpose::Plugin)
                .unwrap_err()
                .class,
            ErrorClass::NotConfigured
        );
    }

    #[tokio::test]
    async fn ai_settings_save_rejects_unknown_profile_and_model() {
        let dir = tempfile::tempdir().unwrap();
        let core = test_core(dir.path(), Arc::new(FakeRunner::new(vec![])), ready());
        let save = |data: Value| {
            let req = mutation(&core, Operation::AiSettingsSave, data);
            let core = core.clone();
            async move { core.request(req).await }
        };
        for bad in [
            json!({"defaultProfile": "codemie:missing", "routes": {}}),
            json!({"defaultProfile": "claude", "routes": {"summary": {"profile": "nope"}}}),
            json!({"defaultProfile": "claude", "routes": {"summary": {"model": "gpt-9"}}}),
            json!({"defaultProfile": null, "routes": {"summary": {"model": "haiku"}}}),
            json!({"defaultProfile": "claude", "routes": {"knowledge": {"profile": "claude"}}}),
        ] {
            assert_eq!(
                save(bad.clone()).await.unwrap_err().code,
                "validation",
                "{bad}"
            );
        }
        assert_eq!(
            core.repo().unwrap().settings().unwrap().ai,
            AiSettings::default()
        );

        save(json!({
            "defaultProfile": "claude",
            "routes": {"summary": {"profile": "codemie:prod", "model": "sonnet"}, "plugin": {}}
        }))
        .await
        .unwrap();
        let ai = core.repo().unwrap().settings().unwrap().ai;
        assert_eq!(ai.default_profile.as_deref(), Some("claude"));
        assert_eq!(ai.routes.len(), 1, "empty routes are dropped");
        assert_eq!(
            ai.routes[&Purpose::Summary].model.as_deref(),
            Some("sonnet")
        );
    }

    #[tokio::test]
    async fn ai_settings_save_detects_profiles_without_holding_the_mutation_lock() {
        let dir = tempfile::tempdir().unwrap();
        let core = crate::workspace::test_core_slow(
            dir.path(),
            Arc::new(FakeRunner::new(vec![])),
            ready(),
            Duration::from_millis(1500),
        );
        let save = mutation(
            &core,
            Operation::AiSettingsSave,
            json!({"defaultProfile": "claude", "routes": {}}),
        );
        let saving = tokio::spawn({
            let core = core.clone();
            async move { core.request(save).await }
        });
        tokio::time::sleep(Duration::from_millis(200)).await;
        let other = mutation(&core, Operation::SettingsUpdate, json!({"timeZone": "UTC"}));
        tokio::time::timeout(Duration::from_millis(600), core.request(other))
            .await
            .expect("a mutation waited for profile detection")
            .unwrap();
        assert!(!saving.is_finished(), "detection should still be running");
        // The slow save then fails on its stale revision, never writes half-state.
        assert_eq!(saving.await.unwrap().unwrap_err().code, "stale_view");
    }

    #[tokio::test]
    async fn ai_status_and_usage_need_no_operation_id() {
        let dir = tempfile::tempdir().unwrap();
        let core = test_core(dir.path(), Arc::new(FakeRunner::new(vec![])), ready());
        let before = core.repo().unwrap().revision().unwrap();
        let status = core
            .request(request(Operation::AiStatus, json!({})))
            .await
            .unwrap();
        assert_eq!(status["profiles"].as_array().unwrap().len(), 2);
        assert_eq!(status["profiles"][0]["id"], "claude");
        assert!(status["settings"]["defaultProfile"].is_null());
        let usage = core
            .request(request(Operation::AiUsage, json!({"month": "2026-11"})))
            .await
            .unwrap();
        assert_eq!(usage["runs"], 0);
        assert_eq!(core.repo().unwrap().revision().unwrap(), before);
        assert!(core
            .request(request(Operation::AiUsage, json!({"month": "Nov"})))
            .await
            .is_err());
    }

    #[tokio::test]
    async fn ai_test_runs_with_fake_runner_and_records_ai_run() {
        let dir = tempfile::tempdir().unwrap();
        let fake = Arc::new(FakeRunner::new(vec![
            Ok(outcome(0.02)),
            Err(AiError::new(ErrorClass::NeedsLogin)),
        ]));
        let core = test_core(dir.path(), fake.clone(), ready());
        let req = request(
            Operation::AiTest,
            json!({"profileId": "claude", "model": "haiku"}),
        );
        let out = core.request(req).await.unwrap();
        assert_eq!(out["ok"], true);
        assert_eq!(out["ms"], 1200);
        assert_eq!(out["costUsd"], 0.02);
        assert_eq!(out["model"], "claude-haiku");
        let spec = &fake.calls()[0];
        assert_eq!(spec.purpose, "test");
        assert_eq!(spec.profile_id, "claude");
        assert_eq!(spec.model.as_deref(), Some("haiku"));
        assert_eq!(spec.system, "Reply with ok=true.");
        assert_eq!(spec.input, json!({}));
        assert_eq!(spec.timeout, Duration::from_secs(60));
        assert_eq!(spec.staging_root, dir.path().join("ai-staging"));

        // A failing run is reported as data and recorded too.
        let req = request(Operation::AiTest, json!({"profileId": "codemie:prod"}));
        let out = core.request(req).await.unwrap();
        assert_eq!(out["ok"], false);
        assert_eq!(out["errorClass"], "needs_login");

        let month = month_now(&core.repo().unwrap().settings().unwrap().time_zone);
        let usage = core.repo().unwrap().ai_usage(&month).unwrap();
        assert_eq!(usage["runs"], 2);
        assert_eq!(usage["byProfile"]["claude"]["runs"], 1);
        let r = core.repo().unwrap();
        let runs = r.records_of_kind("ai_run").unwrap();
        let ok = runs.iter().find(|r| r.data["profile"] == "claude").unwrap();
        assert_eq!(ok.data["purpose"], "test");
        assert_eq!(ok.data["status"], "ok");
        assert_eq!(ok.data["tokens"]["input"], 10);
        let bad = runs
            .iter()
            .find(|r| r.data["profile"] == "codemie:prod")
            .unwrap();
        assert_eq!(bad.data["status"], "needs_login");
    }

    #[tokio::test]
    async fn ai_test_rejects_unknown_profile_and_skips_unready_ones() {
        let dir = tempfile::tempdir().unwrap();
        let fake = Arc::new(FakeRunner::new(vec![]));
        let profiles = vec![profile("claude", ProfileState::NeedsLogin)];
        let core = test_core(dir.path(), fake.clone(), profiles);
        let req = request(Operation::AiTest, json!({"profileId": "codemie:x"}));
        assert_eq!(core.request(req).await.unwrap_err().code, "validation");
        let req = request(Operation::AiTest, json!({"profileId": "claude"}));
        let out = core.request(req).await.unwrap();
        assert_eq!(out["errorClass"], "needs_login");
        assert!(
            fake.calls().is_empty(),
            "no run for a profile known to be unusable"
        );
    }

    #[tokio::test]
    async fn ai_usage_sums_month_by_profile() {
        let dir = tempfile::tempdir().unwrap();
        let core = test_core(dir.path(), Arc::new(FakeRunner::new(vec![])), ready());
        let add = |profile: &str, month: &str, cost: Option<f64>| {
            let mut o = outcome(cost.unwrap_or(0.0));
            o.cost_usd = cost;
            let spec = RunSpec {
                purpose: "summary".into(),
                profile_id: profile.into(),
                model: None,
                system: String::new(),
                input: json!({}),
                schema: None,
                timeout: Duration::from_secs(1),
                cap_usd: None,
                staging_root: dir.path().join("s"),
            };
            let before: Vec<String> = core
                .repo()
                .unwrap()
                .records_of_kind("ai_run")
                .unwrap()
                .into_iter()
                .map(|r| r.id)
                .collect();
            core.record_ai_run(&spec, &Ok(o), Duration::ZERO, Some("r1"));
            // The one record that was not there before is the new one.
            let mut r = core.repo().unwrap();
            let mut new: Vec<Record> = r
                .records_of_kind("ai_run")
                .unwrap()
                .into_iter()
                .filter(|x| !before.contains(&x.id))
                .collect();
            assert_eq!(new.len(), 1);
            let mut rec = new.remove(0);
            rec.data["month"] = month.into();
            r.put_ai_run(&rec).unwrap();
        };
        add("claude", "2026-11", Some(0.25));
        add("claude", "2026-11", None);
        add("codemie:prod", "2026-11", Some(0.5));
        add("claude", "2026-10", Some(9.0));
        let out = core
            .request(request(Operation::AiUsage, json!({"month": "2026-11"})))
            .await
            .unwrap();
        assert_eq!(out["runs"], 3);
        assert!((out["costUsd"].as_f64().unwrap() - 0.75).abs() < 1e-9);
        assert_eq!(out["byProfile"]["claude"]["runs"], 2);
        assert!((out["byProfile"]["claude"]["costUsd"].as_f64().unwrap() - 0.25).abs() < 1e-9);
        assert_eq!(out["byProfile"]["codemie:prod"]["runs"], 1);
    }

    /// The JSON the UI reads, written from the real handlers so the UI fixtures cannot drift.
    /// Regenerate with `UPDATE_CONTRACT_FIXTURES=1 cargo test contract_fixtures`.
    #[tokio::test]
    async fn contract_fixtures_match_the_real_responses() {
        let models = |ids: &[(&str, &str)]| -> Vec<ModelChoice> {
            ids.iter()
                .map(|(id, label)| ModelChoice {
                    id: id.to_string(),
                    label: label.to_string(),
                })
                .collect()
        };
        let native = AiProfile {
            id: "claude".into(),
            kind: ProfileKind::Native,
            label: "Claude Code · your subscription".into(),
            state: ProfileState::Ready,
            version: Some("2.1.150".into()),
            account: Some(AccountInfo {
                plan: Some("Max".into()),
                email: Some("taylor@example.com".into()),
                org: None,
                method: Some("claude.ai".into()),
            }),
            models: models(&[
                ("", "Account default"),
                ("haiku", "Haiku"),
                ("sonnet", "Sonnet"),
                ("opus", "Opus"),
            ]),
            default_model: None,
            message: None,
        };
        let codemie = |name: &str, state, message: Option<&str>| AiProfile {
            id: format!("codemie:{name}"),
            kind: ProfileKind::CodeMie { name: name.into() },
            label: format!("CodeMie · {name}"),
            state,
            version: None,
            account: None,
            models: models(&[
                ("claude-sonnet-4-5", "claude-sonnet-4-5"),
                ("claude-haiku-4-5", "claude-haiku-4-5"),
            ]),
            default_model: Some("claude-sonnet-4-5".into()),
            message: message.map(str::to_string),
        };
        let profiles = vec![
            native,
            codemie("prod", ProfileState::Ready, None),
            codemie(
                "staging",
                ProfileState::NeedsLogin,
                Some("Sign in to this CodeMie profile."),
            ),
        ];
        let run = |cost: f64, model: &str| {
            let mut o = outcome(cost);
            o.duration_ms = 2100;
            o.model = Some(model.into());
            Ok(o)
        };
        let fake = Arc::new(FakeRunner::new(vec![
            run(0.0004, "sonnet"),
            run(0.0302, "claude-haiku-4-5"),
        ]));
        let dir = tempfile::tempdir().unwrap();
        let core = test_core(dir.path(), fake, profiles);
        core.request(mutation(
            &core,
            Operation::AiSettingsSave,
            json!({"defaultProfile": "claude", "routes": {
                "summary": {"profile": "codemie:prod", "model": "claude-haiku-4-5"},
                "mail_draft": {"model": "sonnet"}}}),
        ))
        .await
        .unwrap();
        let status = core
            .request(request(Operation::AiStatus, json!({})))
            .await
            .unwrap();
        let test = |profile: &str, model: Option<&str>| {
            request(
                Operation::AiTest,
                json!({"profileId": profile, "model": model}),
            )
        };
        let ok = core.request(test("claude", Some("sonnet"))).await.unwrap();
        core.request(test("codemie:prod", None)).await.unwrap();
        let fail = core.request(test("codemie:staging", None)).await.unwrap();
        let month = month_now(&core.repo().unwrap().settings().unwrap().time_zone);
        let mut usage = core
            .request(request(Operation::AiUsage, json!({"month": month})))
            .await
            .unwrap();
        usage["month"] = "2026-11".into();
        assert_eq!(usage["byProfile"].as_object().unwrap().len(), 2);

        let dir =
            std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../ui/test/fixtures/contract");
        let update = std::env::var("UPDATE_CONTRACT_FIXTURES").is_ok_and(|v| v == "1");
        for (name, value) in [
            ("ai-status.json", status),
            ("ai-usage.json", usage),
            ("ai-test-ok.json", ok),
            ("ai-test-fail.json", fail),
        ] {
            let text = serde_json::to_string_pretty(&value).unwrap() + "\n";
            let path = dir.join(name);
            if update {
                std::fs::create_dir_all(&dir).unwrap();
                std::fs::write(&path, &text).unwrap();
            } else {
                let saved = std::fs::read_to_string(&path).unwrap_or_default();
                assert_eq!(
                    saved, text,
                    "{name} is stale: run UPDATE_CONTRACT_FIXTURES=1 cargo test contract_fixtures"
                );
            }
        }
    }
}
