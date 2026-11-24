//! Workspace side of the AI features (DESIGN 6.1/6.2): which Claude profile serves which
//! purpose, the Settings operations, and the usage ledger. Running Claude itself is the
//! `crate::ai` runner's job; the draft and summary jobs are in `ai_jobs`.
use super::{models::*, Core};
use crate::ai::command::RunSpec;
use crate::ai::profiles::{AiProfile, ProfileState};
use crate::ai::stream::{AiError, ErrorClass, RunEvent, RunOutcome};
use serde::Serialize;
use serde_json::{json, Value};
use std::sync::Arc;
use std::time::{Duration, Instant};
use tokio_util::sync::CancellationToken;

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
pub(super) fn unready_error(profile: &AiProfile) -> Option<AiError> {
    let class = match profile.state {
        ProfileState::Ready => return None,
        ProfileState::NotInstalled => ErrorClass::NotInstalled,
        ProfileState::TooOld => ErrorClass::TooOld,
        ProfileState::NeedsLogin => ErrorClass::NeedsLogin,
        ProfileState::NotConfigured => ErrorClass::NotConfigured,
        ProfileState::NotRunning | ProfileState::Checking | ProfileState::Error => {
            ErrorClass::Failed
        }
    };
    let mut e = AiError::new(class);
    if let Some(m) = profile.message.as_ref().filter(|m| !m.is_empty()) {
        e.message = m.clone();
    }
    Some(e)
}

/// What a run uses: the profile and model, the fallback for one retry after a failure that
/// says the profile itself can't run, and the chosen profile when the fallback is already in
/// use because the chosen one wasn't ready.
#[derive(Clone, Debug)]
pub struct Resolved {
    pub profile: AiProfile,
    pub model: Option<String>,
    pub fallback: Option<AiProfile>,
    pub fell_back_from: Option<String>,
    /// The chosen profile's own readiness class, kept only when the fallback was already in
    /// use before the run started (`fell_back_from.is_some()`). A fixed class code, never a
    /// message: a caller that wants to say why (the Run log) maps it to its own copy.
    pub(super) pre_run_reason: Option<ErrorClass>,
}

impl Resolved {
    /// `fallbackFrom` of the ledger entry for the attempt that ran `spec`.
    pub(super) fn fallback_from(&self, spec: &RunSpec) -> Option<String> {
        if spec.profile_id == self.profile.id {
            self.fell_back_from.clone()
        } else {
            Some(self.profile.id.clone())
        }
    }

    /// The profile that ran `spec`: the resolved one, or the fallback it retried on.
    pub(super) fn profile_of(&self, spec: &RunSpec) -> &AiProfile {
        self.fallback
            .as_ref()
            .filter(|f| f.id == spec.profile_id)
            .unwrap_or(&self.profile)
    }
}

/// A run that failed with one of these classes may be retried once on the fallback: they
/// say the profile itself can't run. Timeout, invalid output, failed and cancelled never are.
fn falls_back_after(class: ErrorClass) -> bool {
    matches!(
        class,
        ErrorClass::NeedsLogin
            | ErrorClass::NotInstalled
            | ErrorClass::TooOld
            | ErrorClass::NotConfigured
            | ErrorClass::RateLimited
    )
}

/// The profile and model for a row (spec §3). The chosen profile runs when it is ready;
/// otherwise a ready fallback runs with its own default model and `fell_back_from` names the
/// chosen one; otherwise the chosen profile's own error. No profile: `NeedsChoice`.
pub fn resolve(
    s: &AiSettings,
    profiles: &[AiProfile],
    key: &RouteKey,
) -> std::result::Result<Resolved, AiError> {
    resolve_chosen(choose(s, key), profiles)
}

/// The row of a plugin's run (spec §3 "Plugins"): its own row when the user set a profile on
/// it; else the profile the plugin `named`; else All plugins, else Default. The fallback is
/// always the plugin row's.
pub fn resolve_plugin(
    s: &AiSettings,
    profiles: &[AiProfile],
    plugin: &str,
    named: Option<&str>,
) -> std::result::Result<Resolved, AiError> {
    let key = RouteKey::Plugin(plugin.to_string());
    let row = choose(s, &key);
    let own = s
        .plugins
        .get(plugin)
        .and_then(|r| set(&r.profile))
        .is_some();
    let chosen = match named.filter(|n| !own && !n.is_empty()) {
        Some(named) => without_self_fallback(Chosen {
            profile: Some(named.to_string()),
            model: None,
            fallback: row.fallback,
        }),
        None => row,
    };
    resolve_chosen(chosen, profiles)
}

fn resolve_chosen(c: Chosen, profiles: &[AiProfile]) -> std::result::Result<Resolved, AiError> {
    let id = c
        .profile
        .ok_or_else(|| AiError::new(ErrorClass::NeedsChoice))?;
    let find = |id: &str| profiles.iter().find(|p| p.id == id);
    let fallback = c.fallback.as_deref().and_then(find).cloned();
    let error = match find(&id) {
        Some(p) => match unready_error(p) {
            None => {
                return Ok(Resolved {
                    profile: p.clone(),
                    model: c.model,
                    fallback,
                    fell_back_from: None,
                    pre_run_reason: None,
                })
            }
            Some(e) => e,
        },
        None => {
            let mut e = AiError::new(ErrorClass::NotConfigured);
            e.message = format!("Connect has no AI profile “{id}”.");
            e
        }
    };
    let class = error.class;
    match fallback.filter(|f| f.state == ProfileState::Ready) {
        Some(f) => Ok(Resolved {
            profile: f,
            model: None,
            fallback: None,
            fell_back_from: Some(id),
            pre_run_reason: Some(class),
        }),
        None => Err(error),
    }
}

/// The profile id `purpose` is routed to, `None` until the user has chosen one.
pub(super) fn chosen_profile(settings: &AiSettings, purpose: Purpose) -> Option<String> {
    choose(settings, &RouteKey::Purpose(purpose)).profile
}

/// One row of Settings › AI: a purpose, or a single plugin by id.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum RouteKey {
    Purpose(Purpose),
    Plugin(String),
}

impl RouteKey {
    /// The row's key in `chosen`: `triage`, `plugin:knowledge`.
    pub fn wire(&self) -> String {
        match self {
            RouteKey::Purpose(p) => wire_name(p),
            RouteKey::Plugin(id) => format!("plugin:{id}"),
        }
    }
}

/// The row a row inherits from when it sets nothing; `None` is the Default row.
pub fn group_of(key: &RouteKey) -> Option<RouteKey> {
    match key {
        RouteKey::Purpose(Purpose::Briefing | Purpose::Triage | Purpose::Commitments) => {
            Some(RouteKey::Purpose(Purpose::Automation))
        }
        RouteKey::Plugin(_) => Some(RouteKey::Purpose(Purpose::Plugin)),
        RouteKey::Purpose(_) => None,
    }
}

/// What a row runs on: its profile and model, and the profile used when that can't run.
#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Chosen {
    pub profile: Option<String>,
    pub model: Option<String>,
    pub fallback: Option<String>,
}

fn set(value: &Option<String>) -> Option<String> {
    value.clone().filter(|v| !v.is_empty())
}

fn saved_route<'a>(s: &'a AiSettings, key: &RouteKey) -> Option<&'a Route> {
    match key {
        RouteKey::Purpose(p) => s.routes.get(p),
        RouteKey::Plugin(id) => s.plugins.get(id),
    }
}

/// The row's choice with its fallback as inherited, before it is compared to the profile.
fn inherited(s: &AiSettings, key: Option<&RouteKey>) -> Chosen {
    let Some(key) = key else {
        return Chosen {
            profile: set(&s.default_profile),
            model: set(&s.default_model),
            fallback: set(&s.default_fallback),
        };
    };
    let group = inherited(s, group_of(key).as_ref());
    let Some(route) = saved_route(s, key) else {
        return group;
    };
    let model = set(&route.model);
    let (profile, model) = match set(&route.profile) {
        Some(profile) => (Some(profile), model),
        None => (group.profile, model.or(group.model)),
    };
    Chosen {
        profile,
        model,
        fallback: set(&route.fallback).or(group.fallback),
    }
}

/// The one resolution rule (spec §2). Profile and model go together: a row that sets a
/// profile uses its own model (none = the profile's default); a row that sets no profile
/// takes its group's profile, with its own model if it set one. The fallback is inherited
/// on its own, and a fallback equal to the chosen profile is no fallback.
pub fn choose(s: &AiSettings, key: &RouteKey) -> Chosen {
    without_self_fallback(inherited(s, Some(key)))
}

/// [`choose`] for the Default row.
pub fn choose_default(s: &AiSettings) -> Chosen {
    without_self_fallback(inherited(s, None))
}

fn without_self_fallback(mut c: Chosen) -> Chosen {
    if c.fallback.is_some() && c.fallback == c.profile {
        c.fallback = None;
    }
    c
}

/// `chosen` of `ai_status` and `ai_settings_save`: `default`, every purpose, and
/// `plugin:<id>` for each saved plugin row.
/// Each entry also names its `group`: the row it follows when it sets nothing (`default`,
/// `automation` or `plugin`; null for Default itself), so the window's "Same as" labels
/// come from this rule and not from a copy of it.
pub(super) fn chosen_all(s: &AiSettings) -> serde_json::Map<String, Value> {
    let value = |c: Chosen, group: Value| {
        let mut v = serde_json::to_value(c).unwrap_or(Value::Null);
        if let Some(o) = v.as_object_mut() {
            o.insert("group".into(), group);
        }
        v
    };
    let mut out = serde_json::Map::new();
    out.insert("default".into(), value(choose_default(s), Value::Null));
    let keys = Purpose::ALL
        .into_iter()
        .map(RouteKey::Purpose)
        .chain(s.plugins.keys().cloned().map(RouteKey::Plugin));
    for key in keys {
        let group = group_of(&key).map_or_else(|| "default".to_string(), |g| g.wire());
        out.insert(key.wire(), value(choose(s, &key), Value::String(group)));
    }
    out
}

fn invalid(message: &str) -> WorkspaceError {
    WorkspaceError::new("validation", message)
}

const NOT_OFFERED: &str = "That model is not offered by this profile.";

/// Whether `profile` offers `model`. Ollama reads a name without a tag as `<name>:latest`
/// (ruling 11), so `llama3.2` is `llama3.2:latest`; other ids compare exactly.
pub(crate) fn offers_model(profile: &AiProfile, model: &str) -> bool {
    let ollama = profile.provider.as_deref() == Some("ollama");
    let tagged = |m: &str| {
        if ollama && !m.contains(':') {
            format!("{m}:latest")
        } else {
            m.to_string()
        }
    };
    let want = tagged(model);
    profile.models.iter().any(|c| tagged(&c.id) == want)
}

/// A model must be one the profile offers; empty means the profile's own default.
fn checked_model(profile: &AiProfile, model: Option<&str>) -> Result<Option<String>> {
    match model.filter(|m| !m.is_empty()) {
        None => Ok(None),
        Some(m) if offers_model(profile, m) => Ok(Some(m.to_string())),
        Some(_) => Err(invalid(NOT_OFFERED)),
    }
}

/// The row `key` names in `s` (`None` is the Default row), as a route.
fn row_of(s: &AiSettings, key: Option<&RouteKey>) -> Route {
    match key {
        Some(k) => saved_route(s, k).cloned().unwrap_or_default(),
        None => Route {
            profile: set(&s.default_profile),
            model: set(&s.default_model),
            fallback: set(&s.default_fallback),
        },
    }
}

/// Clears the model saved on row `key`, dropping the row when it then sets nothing.
fn drop_model(s: &mut AiSettings, key: Option<&RouteKey>) {
    let rows = match key {
        None => return s.default_model = None,
        Some(RouteKey::Purpose(p)) => s.routes.get_mut(p),
        Some(RouteKey::Plugin(id)) => s.plugins.get_mut(id),
    };
    if let Some(r) = rows {
        r.model = None;
    }
    s.routes.retain(|_, r| *r != Route::default());
    s.plugins.retain(|_, r| *r != Route::default());
}

/// A route with empty strings cleared, `None` when it sets nothing.
fn normalized(route: Route) -> Option<Route> {
    let route = Route {
        profile: set(&route.profile),
        model: set(&route.model),
        fallback: set(&route.fallback),
    };
    (route != Route::default()).then_some(route)
}

/// Checks every profile, fallback and model of `settings` against the detected profiles
/// and returns the normalised settings (empty rows dropped). A model already saved on a
/// row whose chosen profile did not change is kept as it is, so a closed Ollama doesn't
/// refuse an edit of another row (ruling 13). A saved model whose row moved, in this edit,
/// to a profile that doesn't offer it is dropped; a model picked in this edit that the
/// profile doesn't offer is refused. The window sends only the field the user changed.
fn validate_ai_settings(
    settings: AiSettings,
    profiles: &[AiProfile],
    saved: &AiSettings,
) -> Result<AiSettings> {
    if !settings
        .plugins
        .keys()
        .all(|id| crate::plugins::valid_id(id))
    {
        return Err(invalid("That plugin is not known."));
    }
    let mut s = AiSettings {
        default_profile: set(&settings.default_profile),
        default_model: set(&settings.default_model),
        default_fallback: set(&settings.default_fallback),
        routes: settings
            .routes
            .into_iter()
            .filter_map(|(k, r)| Some((k, normalized(r)?)))
            .collect(),
        plugins: settings
            .plugins
            .into_iter()
            .filter_map(|(k, r)| Some((k, normalized(r)?)))
            .collect(),
    };
    let find = |id: &str| {
        profiles
            .iter()
            .find(|p| p.id == id)
            .ok_or_else(|| invalid("Choose one of the listed profiles."))
    };
    // Default first, then the groups before their rows (`Purpose` order puts Automation and
    // Plugin before the rows that follow them), so a dropped group model is seen below it.
    let keys: Vec<Option<RouteKey>> = std::iter::once(None)
        .chain(s.routes.keys().map(|p| Some(RouteKey::Purpose(*p))))
        .chain(
            s.plugins
                .keys()
                .map(|id| Some(RouteKey::Plugin(id.clone()))),
        )
        .collect();
    for key in keys {
        let row = row_of(&s, key.as_ref());
        for id in [&row.profile, &row.fallback].into_iter().flatten() {
            find(id)?;
        }
        let pick = |s: &AiSettings| inherited(s, key.as_ref());
        let chosen = pick(&s);
        let before = row_of(saved, key.as_ref());
        // Refused only when the row itself sets both, or sets this fallback in this edit.
        // A group moving onto a row's saved fallback is fine: `choose` drops it.
        let sets_both = row.profile.is_some() && row.fallback == row.profile;
        let new_fallback = row.fallback != before.fallback && row.fallback == chosen.profile;
        if row.fallback.is_some() && (sets_both || new_fallback) {
            return Err(invalid("The fallback must be a different profile."));
        }
        let Some(model) = &row.model else { continue };
        let profile = chosen
            .profile
            .as_deref()
            .ok_or_else(|| invalid("Choose a profile before choosing a model."))?;
        let was_saved = before.model.as_ref() == Some(model);
        let moved = pick(saved).profile != chosen.profile;
        if (was_saved && !moved) || offers_model(find(profile)?, model) {
            continue;
        }
        if !was_saved {
            return Err(invalid(NOT_OFFERED));
        }
        drop_model(&mut s, key.as_ref());
    }
    Ok(s)
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
    /// [`resolve`] for `key` from the saved settings and a fresh-enough detection. Errors are
    /// the class a caller shows (including `NeedsChoice`).
    pub(super) async fn resolve_key(
        &self,
        key: &RouteKey,
    ) -> std::result::Result<Resolved, AiError> {
        let settings = self
            .repo()
            .and_then(|r| r.settings())
            .map_err(|_| AiError::new(ErrorClass::Failed))?;
        resolve(&settings.ai, &self.profiles.profiles().await, key)
    }

    /// Runs `spec` (built on `r.profile` and `r.model`) once. When that run fails with a class
    /// that says the profile can't run, a ready fallback was not used yet and the run is not
    /// in a folder (whose edits may already be made), the failed
    /// attempt is recorded here and the same run goes once more to the fallback, on its own
    /// default model. Answers the last attempt's result and spec; the caller records that one.
    pub(super) async fn run_resolved(
        &self,
        r: &Resolved,
        spec: RunSpec,
        cancel: CancellationToken,
        on_event: Arc<dyn Fn(RunEvent) + Send + Sync>,
        ref_id: Option<&str>,
    ) -> (
        std::result::Result<RunOutcome, AiError>,
        RunSpec,
        Option<ErrorClass>,
    ) {
        self.run_resolved_with(r, spec, cancel, on_event, ref_id, &|_| {})
            .await
    }

    /// [`Self::run_resolved`] whose own ledger entry is completed by `decorate` (a plugin's
    /// name and tools). The third answer is the class of the first attempt's own failure, kept
    /// only when this run retried on the fallback after it (not when the fallback was already
    /// in use before the run started — that's [`Resolved::pre_run_reason`]).
    pub(super) async fn run_resolved_with(
        &self,
        r: &Resolved,
        spec: RunSpec,
        cancel: CancellationToken,
        on_event: Arc<dyn Fn(RunEvent) + Send + Sync>,
        ref_id: Option<&str>,
        decorate: &(dyn Fn(&mut Record) + Sync),
    ) -> (
        std::result::Result<RunOutcome, AiError>,
        RunSpec,
        Option<ErrorClass>,
    ) {
        let events = |f: &Arc<dyn Fn(RunEvent) + Send + Sync>| -> Box<dyn Fn(RunEvent) + Send> {
            let f = f.clone();
            Box::new(move |e| f(e))
        };
        let started = Instant::now();
        let first = self
            .runner
            .run(spec.clone(), &r.profile, cancel.clone(), events(&on_event))
            .await;
        let fallback = match (&first, &r.fallback) {
            (Err(e), Some(f))
                if falls_back_after(e.class)
                    // A folder run may already have changed the folder: never run it twice.
                    && spec.folder.is_none()
                    && f.state == ProfileState::Ready
                    && r.fell_back_from.is_none()
                    && !cancel.is_cancelled() =>
            {
                f
            }
            _ => return (first, spec, None),
        };
        let error = first.as_ref().err();
        let reason = error.map(|e| e.class);
        let spent = error.and_then(|e| e.spent.as_deref());
        let mut record = self.ai_run_record(&spec, spent, error, started.elapsed(), ref_id);
        record.data["fallbackFrom"] = json!(r.fallback_from(&spec));
        decorate(&mut record);
        self.put_ai_run(&record);
        log::info!(
            "ai: {} could not run ({}), trying its fallback",
            spec.purpose,
            wire_name(error.map_or(ErrorClass::Failed, |e| e.class))
        );
        let retry = RunSpec {
            profile_id: fallback.id.clone(),
            model: None,
            ..spec
        };
        let second = self
            .runner
            .run(retry.clone(), fallback, cancel, events(&on_event))
            .await;
        (second, retry, reason)
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
            None,
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
        fallback_from: Option<&str>,
    ) {
        let mut record = self.ai_run_record(spec, outcome, error, elapsed, ref_id);
        record.data["fallbackFrom"] = json!(fallback_from);
        self.put_ai_run(&record);
    }

    /// Writes an `ai_run` record; a ledger problem is only logged.
    pub(super) fn put_ai_run(&self, record: &Record) {
        if let Err(e) = self.repo().and_then(|mut r| r.put_ai_run(record)) {
            log::warn!("ai: cannot record usage: {}", e.code);
        }
    }

    /// The `ai_run` record of one run (see [`Core::record_run`]).
    pub(super) fn ai_run_record(
        &self,
        spec: &RunSpec,
        outcome: Option<&RunOutcome>,
        error: Option<&AiError>,
        elapsed: Duration,
        ref_id: Option<&str>,
    ) -> Record {
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
        Record {
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
                "fallbackFrom": null,
                "month": month_now(&zone),
                "at": at,
            }),
        }
    }

    /// `ai_status`: the detected profiles and the saved routing. `refresh` re-detects.
    pub(super) async fn ai_status(&self, req: &Request) -> Result<Value> {
        if req.data["refresh"].as_bool() == Some(true) {
            self.profiles.invalidate();
        }
        let profiles = self.profiles.profiles().await;
        let settings = self.repo()?.settings()?.ai;
        Ok(json!({"profiles": profiles, "chosen": chosen_all(&settings), "settings": settings}))
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

    /// `ai_settings_save {defaultProfile, defaultModel, defaultFallback, routes, plugins}`.
    /// `profiles` were detected by the caller before the mutation lock was taken.
    pub(super) fn ai_settings_save(&self, req: &Request, profiles: &[AiProfile]) -> Result<Value> {
        let wanted: AiSettings = serde_json::from_value(req.data.clone())
            .map_err(|_| invalid("Those AI settings are not valid."))?;
        let mut r = self.repo()?;
        let mut s = r.settings()?;
        let ai = validate_ai_settings(wanted, profiles, &s.ai)?;
        s.ai = ai.clone();
        r.settings_update(&s)?;
        Ok(json!({"chosen": chosen_all(&ai), "settings": ai}))
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
            .ok_or_else(|| invalid("Choose one of the listed profiles."))?;
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
            staging_root: self.paths.ensure_staging()?,
            folder: None,
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
            provider: None,
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
            local: None,
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

    fn ollama(id: &str, models: &[&str]) -> AiProfile {
        let mut p = profile(id, ProfileState::Ready);
        p.provider = Some("ollama".into());
        p.local = Some(true);
        p.models = models
            .iter()
            .map(|m| ModelChoice {
                id: m.to_string(),
                label: m.to_string(),
            })
            .collect();
        p
    }
    fn settings(v: Value) -> AiSettings {
        serde_json::from_value(v).unwrap()
    }
    fn chosen(profile: Option<&str>, model: Option<&str>, fallback: Option<&str>) -> Chosen {
        Chosen {
            profile: profile.map(str::to_string),
            model: model.map(str::to_string),
            fallback: fallback.map(str::to_string),
        }
    }
    fn key(p: Purpose) -> RouteKey {
        RouteKey::Purpose(p)
    }

    #[test]
    fn route_keys_have_wire_names_and_groups() {
        assert_eq!(key(Purpose::Triage).wire(), "triage");
        assert_eq!(
            RouteKey::Plugin("knowledge".into()).wire(),
            "plugin:knowledge"
        );
        for p in [Purpose::Briefing, Purpose::Triage, Purpose::Commitments] {
            assert_eq!(group_of(&key(p)), Some(key(Purpose::Automation)));
        }
        assert_eq!(
            group_of(&RouteKey::Plugin("knowledge".into())),
            Some(key(Purpose::Plugin))
        );
        for p in [
            Purpose::MailDraft,
            Purpose::ChatDraft,
            Purpose::Summary,
            Purpose::Meeting,
            Purpose::Automation,
            Purpose::Plugin,
            Purpose::Ask,
        ] {
            assert_eq!(group_of(&key(p)), None, "{p:?}");
        }
    }

    #[test]
    fn old_settings_read_unchanged() {
        let s = settings(json!({"defaultProfile": "claude", "routes": {
            "summary": {"profile": "codemie:prod", "model": "claude-haiku-4-5"}}}));
        assert_eq!(
            choose(&s, &key(Purpose::Summary)),
            chosen(Some("codemie:prod"), Some("claude-haiku-4-5"), None)
        );
        assert_eq!(
            choose(&s, &key(Purpose::MailDraft)),
            chosen(Some("claude"), None, None)
        );
        assert_eq!(choose_default(&s), chosen(Some("claude"), None, None));
    }

    #[test]
    fn rows_inherit_from_their_group() {
        let s = settings(json!({"defaultProfile": "claude", "routes": {
            "automation": {"profile": "codemie:prod", "model": "m1"}}}));
        assert_eq!(
            choose(&s, &key(Purpose::Triage)),
            chosen(Some("codemie:prod"), Some("m1"), None)
        );
        // A plugin without a row (or with an empty one) is All plugins'.
        let s = settings(json!({"defaultProfile": "claude",
            "routes": {"plugin": {"profile": "codemie:prod", "model": "m2"}},
            "plugins": {"knowledge": {}}}));
        assert_eq!(
            choose(&s, &RouteKey::Plugin("knowledge".into())),
            choose(&s, &key(Purpose::Plugin))
        );
        assert_eq!(
            choose(&s, &RouteKey::Plugin("other".into())),
            chosen(Some("codemie:prod"), Some("m2"), None)
        );
        // Profile and model go together.
        let s = settings(json!({"defaultProfile": "claude", "routes": {
            "automation": {"profile": "codemie:prod", "model": "m1"},
            "triage": {"profile": "claude"},
            "briefing": {"model": "sonnet"}}}));
        assert_eq!(
            choose(&s, &key(Purpose::Triage)),
            chosen(Some("claude"), None, None)
        );
        assert_eq!(
            choose(&s, &key(Purpose::Briefing)),
            chosen(Some("codemie:prod"), Some("sonnet"), None)
        );
        let s = settings(json!({"routes": {
            "automation": {"profile": "claude"},
            "triage": {"model": "sonnet"}}}));
        assert_eq!(
            choose(&s, &key(Purpose::Triage)),
            chosen(Some("claude"), Some("sonnet"), None)
        );
        // An empty string is no choice.
        let s = settings(json!({"defaultProfile": "claude", "defaultModel": "haiku",
            "routes": {"summary": {"profile": "", "model": ""}}}));
        assert_eq!(
            choose(&s, &key(Purpose::Summary)),
            chosen(Some("claude"), Some("haiku"), None)
        );
    }

    #[test]
    fn fallback_inherits_on_its_own_and_never_equals_the_profile() {
        let s = settings(
            json!({"defaultProfile": "claude", "defaultFallback": "codemie:prod",
            "routes": {"triage": {"profile": "claude"}}}),
        );
        assert_eq!(
            choose(&s, &key(Purpose::Triage)).fallback.as_deref(),
            Some("codemie:prod")
        );
        let s = settings(
            json!({"defaultProfile": "claude", "defaultFallback": "codemie:prod",
            "routes": {"triage": {"profile": "codemie:prod"}}}),
        );
        assert_eq!(choose(&s, &key(Purpose::Triage)).fallback, None);
        // The group's fallback, not the default's, and it is inherited raw: a fallback
        // equal to the group's own profile still backs up a row on another profile.
        let s = settings(
            json!({"defaultProfile": "claude", "defaultFallback": "codemie:a",
            "routes": {"automation": {"fallback": "claude"},
                       "briefing": {"profile": "codemie:b"}}}),
        );
        assert_eq!(choose(&s, &key(Purpose::Automation)).fallback, None);
        assert_eq!(
            choose(&s, &key(Purpose::Briefing)),
            chosen(Some("codemie:b"), None, Some("claude"))
        );
        assert_eq!(
            choose(&s, &key(Purpose::Summary)).fallback.as_deref(),
            Some("codemie:a")
        );
    }

    #[test]
    fn nothing_chosen_is_none() {
        let s = AiSettings::default();
        assert_eq!(choose_default(&s), chosen(None, None, None));
        for p in Purpose::ALL {
            assert_eq!(choose(&s, &key(p)).profile, None, "{p:?}");
        }
        assert_eq!(
            choose(&s, &RouteKey::Plugin("knowledge".into())).profile,
            None
        );
        assert_eq!(chosen_profile(&s, Purpose::Meeting), None);
    }

    #[tokio::test]
    async fn save_validates_fallbacks_plugins_and_models() {
        let dir = tempfile::tempdir().unwrap();
        let core = test_core(dir.path(), Arc::new(FakeRunner::new(vec![])), ready());
        let save = |data: Value| {
            let req = mutation(&core, Operation::AiSettingsSave, data);
            let core = core.clone();
            async move { core.request(req).await }
        };
        for (bad, message) in [
            (
                json!({"defaultProfile": "claude", "defaultFallback": "nope"}),
                "Choose one of the listed profiles.",
            ),
            (
                json!({"defaultProfile": "claude", "routes": {"triage": {"fallback": "nope"}}}),
                "Choose one of the listed profiles.",
            ),
            (
                json!({"defaultProfile": "claude",
                       "routes": {"summary": {"profile": "claude", "fallback": "claude"}}}),
                "The fallback must be a different profile.",
            ),
            (
                json!({"defaultProfile": "claude", "defaultFallback": "claude"}),
                "The fallback must be a different profile.",
            ),
            (
                json!({"defaultProfile": "claude", "plugins": {"../x": {"profile": "claude"}}}),
                "That plugin is not known.",
            ),
            (
                json!({"defaultProfile": "claude", "plugins": {"knowledge": {"model": "gpt-9"}}}),
                "That model is not offered by this profile.",
            ),
            (
                json!({"defaultProfile": "claude", "defaultModel": "gpt-9"}),
                "That model is not offered by this profile.",
            ),
        ] {
            let e = save(bad.clone()).await.unwrap_err();
            assert_eq!(
                (e.code.as_str(), e.message.as_str()),
                ("validation", message),
                "{bad}"
            );
        }
        assert_eq!(
            core.repo().unwrap().settings().unwrap().ai,
            AiSettings::default()
        );
        let out = save(json!({"defaultProfile": "claude", "defaultModel": "haiku",
            "defaultFallback": "codemie:prod",
            "routes": {"triage": {"profile": "codemie:prod", "model": "sonnet"}},
            "plugins": {"knowledge": {"fallback": "codemie:prod"}, "github": {}}}))
        .await
        .unwrap();
        let ai = core.repo().unwrap().settings().unwrap().ai;
        assert_eq!(ai.default_model.as_deref(), Some("haiku"));
        assert_eq!(ai.default_fallback.as_deref(), Some("codemie:prod"));
        assert_eq!(ai.plugins.len(), 1, "empty plugin rows are dropped");
        assert_eq!(out["settings"], serde_json::to_value(&ai).unwrap());
        assert_eq!(out["chosen"]["triage"]["profile"], "codemie:prod");
        assert!(out["chosen"]["triage"]["fallback"].is_null());
    }

    #[tokio::test]
    async fn a_saved_model_is_kept_while_its_profile_cannot_list_it() {
        let dir = tempfile::tempdir().unwrap();
        let open = vec![
            profile("claude", ProfileState::Ready),
            ollama("codemie:ol", &["qwen3:8b", "llama3.2:latest"]),
        ];
        let core = test_core(dir.path(), Arc::new(FakeRunner::new(vec![])), open);
        core.request(mutation(
            &core,
            Operation::AiSettingsSave,
            json!({"defaultProfile": "claude",
                   "plugins": {"knowledge": {"profile": "codemie:ol", "model": "qwen3:8b"}}}),
        ))
        .await
        .unwrap();
        // Ollama is closed: the profile lists only the config's models.
        let mut closed_ol = ollama("codemie:ol", &["llama3.2:latest"]);
        closed_ol.state = ProfileState::NotRunning;
        let closed = vec![
            profile("codemie:prod", ProfileState::Ready),
            closed_ol,
            profile("claude", ProfileState::Ready),
        ];
        let req = mutation(
            &core,
            Operation::AiSettingsSave,
            json!({"defaultProfile": "codemie:prod",
                   "plugins": {"knowledge": {"profile": "codemie:ol", "model": "qwen3:8b"}}}),
        );
        let out = core.ai_settings_save(&req, &closed).unwrap();
        assert_eq!(out["settings"]["plugins"]["knowledge"]["model"], "qwen3:8b");
        let ai = core.repo().unwrap().settings().unwrap().ai;
        assert_eq!(ai.plugins["knowledge"].model.as_deref(), Some("qwen3:8b"));
        assert_eq!(ai.default_profile.as_deref(), Some("codemie:prod"));
        // A new row with that model is refused, and so is the same model on another row.
        for data in [
            json!({"defaultProfile": "codemie:prod",
                   "plugins": {"knowledge": {"profile": "codemie:ol", "model": "qwen3:8b"},
                               "github": {"profile": "codemie:ol", "model": "qwen3:8b"}}}),
            json!({"defaultProfile": "codemie:prod",
                   "routes": {"summary": {"profile": "codemie:ol", "model": "qwen3:8b"}}}),
        ] {
            let req = mutation(&core, Operation::AiSettingsSave, data.clone());
            let e = core.ai_settings_save(&req, &closed).unwrap_err();
            assert_eq!(
                e.message, "That model is not offered by this profile.",
                "{data}"
            );
        }
    }

    #[tokio::test]
    async fn a_row_moved_to_a_profile_without_its_model_drops_the_model() {
        let dir = tempfile::tempdir().unwrap();
        let profiles = vec![
            profile("claude", ProfileState::Ready),
            ollama("codemie:ol", &["qwen3:8b"]),
        ];
        let core = test_core(
            dir.path(),
            Arc::new(FakeRunner::new(vec![])),
            profiles.clone(),
        );
        let save = |data: Value| {
            let req = mutation(&core, Operation::AiSettingsSave, data);
            core.ai_settings_save(&req, &profiles)
        };
        save(
            json!({"defaultProfile": "claude", "routes": {"summary": {"model": "sonnet"}},
                    "plugins": {"knowledge": {"profile": "claude", "model": "haiku"}}}),
        )
        .unwrap();
        // Default moves Summaries onto Ollama, which has no sonnet: the model goes, not the edit.
        let out = save(
            json!({"defaultProfile": "codemie:ol", "routes": {"summary": {"model": "sonnet"}},
                              "plugins": {"knowledge": {"profile": "claude", "model": "haiku"}}}),
        )
        .unwrap();
        let ai = core.repo().unwrap().settings().unwrap().ai;
        assert_eq!(ai.default_profile.as_deref(), Some("codemie:ol"));
        assert!(
            !ai.routes.contains_key(&Purpose::Summary),
            "{:?}",
            ai.routes
        );
        assert_eq!(out["chosen"]["summary"]["model"], Value::Null);
        // The row's own profile changes: its model goes with the old profile.
        save(json!({"defaultProfile": "codemie:ol",
                    "plugins": {"knowledge": {"profile": "codemie:ol", "model": "haiku"}}}))
        .unwrap();
        let ai = core.repo().unwrap().settings().unwrap().ai;
        assert_eq!(
            ai.plugins["knowledge"].profile.as_deref(),
            Some("codemie:ol")
        );
        assert_eq!(ai.plugins["knowledge"].model, None);
        // A model picked in this edit that the profile doesn't offer is still refused.
        let e = save(json!({"defaultProfile": "codemie:ol",
                            "routes": {"meeting": {"model": "sonnet"}}}))
        .unwrap_err();
        assert_eq!(e.message, "That model is not offered by this profile.");
    }

    #[tokio::test]
    async fn an_ollama_profile_that_lists_nothing_keeps_the_saved_model() {
        let dir = tempfile::tempdir().unwrap();
        let open = vec![
            profile("claude", ProfileState::Ready),
            ollama("codemie:ol", &["qwen3:8b"]),
        ];
        let core = test_core(dir.path(), Arc::new(FakeRunner::new(vec![])), open.clone());
        let saved = json!({"defaultProfile": "claude",
                           "routes": {"plugin": {"profile": "codemie:ol", "model": "qwen3:8b"}}});
        core.ai_settings_save(&mutation(&core, Operation::AiSettingsSave, saved), &open)
            .unwrap();
        let mut closed_ol = ollama("codemie:ol", &[]);
        closed_ol.state = ProfileState::NotRunning;
        let closed = vec![profile("claude", ProfileState::Ready), closed_ol];
        // Another row changes while Ollama is closed: the plugin row keeps its model.
        let req = mutation(
            &core,
            Operation::AiSettingsSave,
            json!({"defaultProfile": "claude",
                   "routes": {"plugin": {"profile": "codemie:ol", "model": "qwen3:8b"},
                              "summary": {"model": "haiku"}}}),
        );
        core.ai_settings_save(&req, &closed).unwrap();
        let ai = core.repo().unwrap().settings().unwrap().ai;
        assert_eq!(
            ai.routes[&Purpose::Plugin].model.as_deref(),
            Some("qwen3:8b")
        );
    }

    #[tokio::test]
    async fn an_ollama_name_without_a_tag_is_its_latest() {
        let dir = tempfile::tempdir().unwrap();
        let profiles = vec![
            profile("claude", ProfileState::Ready),
            ollama("codemie:ol", &["llama3.2:latest"]),
        ];
        let core = test_core(
            dir.path(),
            Arc::new(FakeRunner::new(vec![])),
            profiles.clone(),
        );
        let req = mutation(
            &core,
            Operation::AiSettingsSave,
            json!({"defaultProfile": "claude",
                   "routes": {"summary": {"profile": "codemie:ol", "model": "llama3.2"}}}),
        );
        core.ai_settings_save(&req, &profiles).unwrap();
        // Only Ollama names work this way: Claude's ids compare exactly.
        let req = mutation(
            &core,
            Operation::AiSettingsSave,
            json!({"defaultProfile": "claude", "routes": {"meeting": {"model": "sonnet:latest"}}}),
        );
        assert_eq!(
            core.ai_settings_save(&req, &profiles).unwrap_err().message,
            "That model is not offered by this profile."
        );
    }

    #[tokio::test]
    async fn moving_a_row_onto_its_own_fallback_with_the_fallback_cleared_is_saved() {
        // What Settings › AI sends when Default (Claude Code, fallback prod) moves to prod.
        let dir = tempfile::tempdir().unwrap();
        let core = test_core(dir.path(), Arc::new(FakeRunner::new(vec![])), ready());
        let save = |data: Value| {
            let req = mutation(&core, Operation::AiSettingsSave, data);
            let core = core.clone();
            async move { core.request(req).await }
        };
        save(
            json!({"defaultProfile": "claude", "defaultFallback": "codemie:prod",
                    "routes": {"summary": {"profile": "claude", "fallback": "codemie:prod"}}}),
        )
        .await
        .unwrap();
        save(
            json!({"defaultProfile": "codemie:prod", "defaultFallback": null,
                    "routes": {"summary": {"profile": "claude", "fallback": "codemie:prod"}}}),
        )
        .await
        .unwrap();
        save(json!({"defaultProfile": "codemie:prod",
                    "routes": {"summary": {"profile": "codemie:prod"}}}))
        .await
        .unwrap();
        let ai = core.repo().unwrap().settings().unwrap().ai;
        assert_eq!(ai.default_fallback, None);
        assert_eq!(ai.routes[&Purpose::Summary].fallback, None);
    }

    #[tokio::test]
    async fn a_group_change_onto_a_rows_fallback_is_saved() {
        let dir = tempfile::tempdir().unwrap();
        let core = test_core(dir.path(), Arc::new(FakeRunner::new(vec![])), ready());
        let save = |data: Value| {
            let req = mutation(&core, Operation::AiSettingsSave, data);
            let core = core.clone();
            async move { core.request(req).await }
        };
        save(json!({"defaultProfile": "claude",
                    "routes": {"summary": {"fallback": "codemie:prod"},
                               "automation": {"profile": "claude"},
                               "triage": {"fallback": "codemie:prod"}}}))
        .await
        .unwrap();
        // Default, then Automations, move onto the profile those rows fall back to.
        let out = save(json!({"defaultProfile": "codemie:prod",
                              "routes": {"summary": {"fallback": "codemie:prod"},
                                         "automation": {"profile": "codemie:prod"},
                                         "triage": {"fallback": "codemie:prod"}}}))
        .await
        .unwrap();
        for row in ["summary", "triage"] {
            assert_eq!(
                out["chosen"][row],
                json!({"profile": "codemie:prod", "model": null, "fallback": null,
                       "group": if row == "triage" { "automation" } else { "default" }}),
                "{row}"
            );
        }
        let ai = core.repo().unwrap().settings().unwrap().ai;
        assert_eq!(ai.default_profile.as_deref(), Some("codemie:prod"));
        assert_eq!(
            ai.routes[&Purpose::Summary].fallback.as_deref(),
            Some("codemie:prod")
        );
    }

    #[tokio::test]
    async fn a_row_whose_own_fallback_equals_its_profile_is_refused() {
        let dir = tempfile::tempdir().unwrap();
        let core = test_core(dir.path(), Arc::new(FakeRunner::new(vec![])), ready());
        let save = |data: Value| {
            let req = mutation(&core, Operation::AiSettingsSave, data);
            let core = core.clone();
            async move { core.request(req).await }
        };
        for bad in [
            // The row sets both, equal.
            json!({"defaultProfile": "claude",
                   "routes": {"summary": {"profile": "codemie:prod", "fallback": "codemie:prod"}}}),
            json!({"defaultProfile": "claude",
                   "plugins": {"knowledge": {"profile": "claude", "fallback": "claude"}}}),
            // A fallback set in this edit onto the profile the row inherits.
            json!({"defaultProfile": "claude", "routes": {"summary": {"fallback": "claude"}}}),
        ] {
            let e = save(bad.clone()).await.unwrap_err();
            assert_eq!(
                e.message, "The fallback must be a different profile.",
                "{bad}"
            );
        }
    }

    #[tokio::test]
    async fn status_and_save_answer_chosen() {
        let dir = tempfile::tempdir().unwrap();
        let core = test_core(dir.path(), Arc::new(FakeRunner::new(vec![])), ready());
        let out = core
            .request(mutation(
                &core,
                Operation::AiSettingsSave,
                json!({"defaultProfile": "claude",
                       "plugins": {"knowledge": {"profile": "codemie:prod"}}}),
            ))
            .await
            .unwrap();
        let status = core
            .request(request(Operation::AiStatus, json!({})))
            .await
            .unwrap();
        assert_eq!(status["chosen"], out["chosen"]);
        let mut keys: Vec<&str> = status["chosen"]
            .as_object()
            .unwrap()
            .keys()
            .map(String::as_str)
            .collect();
        keys.sort_unstable();
        let mut want = vec![
            "default",
            "mail_draft",
            "chat_draft",
            "summary",
            "automation",
            "plugin",
            "meeting",
            "briefing",
            "triage",
            "commitments",
            "ask",
            "plugin:knowledge",
        ];
        want.sort_unstable();
        assert_eq!(keys, want);
        assert_eq!(
            status["chosen"]["plugin:knowledge"],
            json!({"profile": "codemie:prod", "model": null, "fallback": null, "group": "plugin"})
        );
        assert_eq!(status["chosen"]["ask"]["profile"], "claude");
        // Each row names the row it follows when it sets nothing (`group_of`).
        for (row, group) in [
            ("default", Value::Null),
            ("summary", json!("default")),
            ("ask", json!("default")),
            ("plugin", json!("default")),
            ("automation", json!("default")),
            ("briefing", json!("automation")),
            ("triage", json!("automation")),
            ("commitments", json!("automation")),
        ] {
            assert_eq!(status["chosen"][row]["group"], group, "{row}");
        }
    }

    #[test]
    fn resolve_uses_the_fallback_when_the_profile_is_not_ready() {
        let s = settings(
            json!({"defaultProfile": "codemie:prod", "defaultModel": "sonnet",
            "defaultFallback": "claude"}),
        );
        let k = key(Purpose::Summary);
        // The chosen profile can run: it is used with its model, the fallback kept for later.
        let r = resolve(&s, &ready(), &k).unwrap();
        assert_eq!(r.profile.id, "codemie:prod");
        assert_eq!(r.model.as_deref(), Some("sonnet"));
        assert_eq!(r.fallback.as_ref().map(|f| f.id.as_str()), Some("claude"));
        assert_eq!(r.fell_back_from, None);
        // Not signed in: the fallback runs with its own default model.
        let profiles = [
            profile("claude", ProfileState::Ready),
            profile("codemie:prod", ProfileState::NeedsLogin),
        ];
        let r = resolve(&s, &profiles, &k).unwrap();
        assert_eq!(r.profile.id, "claude");
        assert_eq!(r.model, None);
        assert!(r.fallback.is_none(), "the fallback is used once");
        assert_eq!(r.fell_back_from.as_deref(), Some("codemie:prod"));
        // Neither can run: the chosen profile's own error.
        let profiles = [
            profile("claude", ProfileState::NotInstalled),
            profile("codemie:prod", ProfileState::NeedsLogin),
        ];
        assert_eq!(
            resolve(&s, &profiles, &k).unwrap_err().class,
            ErrorClass::NeedsLogin
        );
        // A closed Ollama falls back too.
        let mut closed = ollama("codemie:local", &["qwen3:8b"]);
        closed.state = ProfileState::NotRunning;
        let s = settings(json!({"defaultProfile": "codemie:local", "defaultFallback": "claude"}));
        let r = resolve(&s, &[closed, profile("claude", ProfileState::Ready)], &k).unwrap();
        assert_eq!(r.profile.id, "claude");
        assert_eq!(r.fell_back_from.as_deref(), Some("codemie:local"));
        // No profile anywhere asks the user, even with a fallback set.
        let s = settings(json!({"defaultFallback": "claude"}));
        assert_eq!(
            resolve(&s, &ready(), &k).unwrap_err().class,
            ErrorClass::NeedsChoice
        );
    }

    #[tokio::test]
    async fn meeting_notes_need_a_choice_through_the_chain() {
        let dir = tempfile::tempdir().unwrap();
        let core = test_core(dir.path(), Arc::new(FakeRunner::new(vec![])), ready());
        let set = |ai: Value| {
            let mut r = core.repo().unwrap();
            let mut s = r.settings().unwrap();
            s.ai = settings(ai);
            r.settings_update(&s).unwrap();
        };
        let meeting = key(Purpose::Meeting);
        // Other rows and a fallback are not a choice for meeting notes.
        set(
            json!({"routes": {"summary": {"profile": "claude"}, "automation": {"profile": "claude"}},
            "defaultFallback": "codemie:prod"}),
        );
        assert_eq!(
            core.resolve_key(&meeting).await.unwrap_err().class,
            ErrorClass::NeedsChoice
        );
        assert_eq!(
            chosen_profile(
                &core.repo().unwrap().settings().unwrap().ai,
                Purpose::Meeting
            ),
            None
        );
        // The default is.
        set(json!({"defaultProfile": "claude"}));
        assert_eq!(
            core.resolve_key(&meeting).await.unwrap().profile.id,
            "claude"
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
                folder: None,
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
            provider: None,
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
            local: None,
        };
        let codemie = |name: &str, state, message: Option<&str>| AiProfile {
            id: format!("codemie:{name}"),
            kind: ProfileKind::CodeMie { name: name.into() },
            provider: Some("ai-run-sso".into()),
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
            local: None,
        };
        let local_ollama = AiProfile {
            provider: Some("ollama".into()),
            models: models(&[
                ("qwen3:8b", "qwen3:8b"),
                ("llama3.2:latest", "llama3.2:latest"),
            ]),
            default_model: Some("qwen3:8b".into()),
            local: Some(true),
            ..codemie("local-ollama", ProfileState::Ready, None)
        };
        let profiles = vec![
            native,
            codemie("prod", ProfileState::Ready, None),
            codemie(
                "staging",
                ProfileState::NeedsLogin,
                Some("Sign in to this CodeMie profile."),
            ),
            local_ollama,
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
            json!({"defaultProfile": "claude", "defaultFallback": "codemie:prod",
                "routes": {
                    "summary": {"profile": "codemie:prod", "model": "claude-haiku-4-5"},
                    "mail_draft": {"model": "sonnet"},
                    "triage": {"fallback": "codemie:local-ollama"}},
                "plugins": {
                    "knowledge": {"profile": "codemie:local-ollama", "model": "qwen3:8b"}}}),
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

        for (name, value) in [
            ("ai-status.json", status),
            ("ai-usage.json", usage),
            ("ai-test-ok.json", ok),
            ("ai-test-fail.json", fail),
        ] {
            contract_fixture(name, &value);
        }
    }

    /// `ai-route-cases.json`: saved settings and the `chosen` [`choose`] answers for them,
    /// which the window's tests read to check the rows' "Same as" labels.
    #[test]
    fn contract_fixtures_route_cases() {
        let cases = [
            ("empty", json!({})),
            (
                "old default and summary",
                json!({"defaultProfile": "claude", "routes": {
                    "summary": {"profile": "codemie:prod", "model": "claude-haiku-4-5"}}}),
            ),
            (
                "automation group gives triage",
                json!({"defaultProfile": "claude", "routes": {
                    "automation": {"profile": "codemie:prod", "model": "claude-haiku-4-5"},
                    "triage": {"model": "claude-sonnet-4-5"}}}),
            ),
            (
                "plugin row",
                json!({"defaultProfile": "claude",
                    "routes": {"plugin": {"profile": "codemie:prod"}},
                    "plugins": {"knowledge": {"profile": "codemie:local-ollama", "model": "qwen3:8b"},
                                "github": {"model": "claude-haiku-4-5"}}}),
            ),
            (
                "fallback inheritance",
                json!({"defaultProfile": "claude", "defaultFallback": "codemie:prod",
                    "routes": {"automation": {"fallback": "codemie:local-ollama"},
                               "summary": {"profile": "codemie:prod"},
                               "briefing": {"profile": "codemie:local-ollama"}}}),
            ),
        ];
        let cases: Vec<Value> = cases
            .into_iter()
            .map(|(name, saved)| {
                let s = settings(saved);
                json!({"name": name, "settings": s, "chosen": chosen_all(&s)})
            })
            .collect();
        contract_fixture("ai-route-cases.json", &Value::Array(cases));
    }

    /// Writes (`UPDATE_CONTRACT_FIXTURES=1`) or checks one UI contract fixture.
    fn contract_fixture(name: &str, value: &Value) {
        let dir =
            std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../ui/test/fixtures/contract");
        let text = serde_json::to_string_pretty(value).unwrap() + "\n";
        let path = dir.join(name);
        if std::env::var("UPDATE_CONTRACT_FIXTURES").is_ok_and(|v| v == "1") {
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
