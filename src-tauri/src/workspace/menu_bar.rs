//! Menu-bar count (design `docs/superpowers/specs/2026-11-24-menu-bar-count-design.md`): the
//! settings that choose what is counted (§1), the seen marks that decide what is "new" (§2) and
//! the four counted sources (§3), what needs fixing (§4), the snapshot's `menuBar` (§5) and the
//! `menu_bar_seen` operation (§2). Later steps add the tray.
use super::meetings::model::{MeAlias, MeetingRecord};
use super::models::*;
use super::repository::Repository;
use super::task_provider::active_provider;
use super::tasks;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::BTreeMap;

/// Tasks and the seen record live in the workspace Connect boots into.
const PERSONAL: &str = "personal";
/// The bookkeeping record kind and id (design §2): unversioned, never in `snapshot.records`.
const SEEN_KIND: &str = "menu_bar_seen";
const SEEN_ID: &str = "personal";
/// How long a meeting's new notes or an automation result count as new (design §3, §5).
pub(crate) const NEW_FOR: i64 = 7 * 86_400;

fn invalid(message: &str) -> WorkspaceError {
    let mut e = WorkspaceError::new("validation", message);
    e.field = Some("menuBar".into());
    e
}

/// Settings › Notifications › "Menu bar" (design §1): which of the four sources are added up.
/// `#[serde(default)]` so settings written before this step read as the default.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct MenuBarSettings {
    pub replies: bool,
    pub tasks: bool,
    pub meetings: bool,
    pub automations: bool,
}
impl Default for MenuBarSettings {
    fn default() -> Self {
        Self {
            replies: true,
            tasks: false,
            meetings: false,
            automations: false,
        }
    }
}
impl MenuBarSettings {
    /// Applies `settings_update {menuBar: {...}}`: only the fields given change, each one a
    /// boolean; nothing changes when one of them is refused.
    pub fn apply(&mut self, v: &Value) -> Result<()> {
        let fields = v.as_object().ok_or_else(|| invalid("Choose on or off."))?;
        let mut next = self.clone();
        for (key, value) in fields {
            let on = value
                .as_bool()
                .ok_or_else(|| invalid("Choose on or off."))?;
            match key.as_str() {
                "replies" => next.replies = on,
                "tasks" => next.tasks = on,
                "meetings" => next.meetings = on,
                "automations" => next.automations = on,
                _ => return Err(invalid("Choose on or off.")),
            }
        }
        *self = next;
        Ok(())
    }
}

/// The `menu_bar_seen` bookkeeping record (design §2): when the user last saw automation results
/// and each new meeting, and `since`, written once so nothing made before this step is new.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(default)]
pub(crate) struct Seen {
    pub since: i64,
    pub automations: i64,
    pub meetings: BTreeMap<String, i64>,
}

fn save(r: &mut Repository, seen: &Seen, now: i64) -> Result<()> {
    r.put_record_unversioned(&Record {
        id: SEEN_ID.into(),
        kind: SEEN_KIND.into(),
        connection_id: None,
        workspace_id: Some(PERSONAL.into()),
        source: "local".into(),
        revision: id(),
        updated_at: now,
        data: serde_json::to_value(seen).map_err(|_| {
            WorkspaceError::new("storage", "Menu-bar seen marks could not be saved.")
        })?,
    })
}

/// The seen marks as stored; missing reads as `since: 0` (nothing has been marked seen yet).
pub(crate) fn seen(r: &Repository) -> Seen {
    r.record(SEEN_KIND, SEEN_ID, None, Some(PERSONAL))
        .ok()
        .and_then(|rec| serde_json::from_value(rec.data).ok())
        .unwrap_or_default()
}

/// Writes `since` the first time Core opens with this step, so an upgrade never counts meetings
/// and automation results made before it (design §2, anti-goal "a flood on upgrade"). A no-op
/// once the record exists.
pub(crate) fn ensure_since(r: &mut Repository, now: i64) -> Result<()> {
    if r.record(SEEN_KIND, SEEN_ID, None, Some(PERSONAL)).is_ok() {
        return Ok(());
    }
    save(
        r,
        &Seen {
            since: now,
            automations: 0,
            meetings: BTreeMap::new(),
        },
        now,
    )
}

/// The four counted sources (design §5's `sources`), serde camelCase like the rest of the
/// snapshot.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Sources {
    pub replies: u32,
    pub tasks: u32,
    pub meetings: u32,
    pub automations: u32,
}

/// Stable identity of a message row, matching `messageKey` in `selectors.js`: a Teams chat is one
/// row whatever its newest message is; mail stays one row per message.
fn message_key(r: &Record) -> String {
    if r.data["channel"].as_str() == Some("chat") {
        let conversation = r.data["conversationId"].as_str().filter(|s| !s.is_empty());
        format!("chat:{}", conversation.unwrap_or(r.source.as_str()))
    } else {
        r.id.clone()
    }
}

/// Whether a message is in Inbox at all (`visibleMessages` in `selectors.js`): not deleted, not
/// archived, not snoozed past `now`.
fn message_visible(r: &Record, now: i64) -> bool {
    r.kind == "message"
        && r.data["deleted"].as_bool() != Some(true)
        && r.data["lifecycle"].as_str() != Some("archived")
        && !r.data["snoozedUntil"].as_i64().is_some_and(|t| t > now)
}

/// Needs-reply rows, exactly as Inbox counts them (`selectors.js::attentionMessages`):
/// unacknowledged critical messages, then Needs-reply messages, one row per Teams chat, a chat
/// with a critical message represented by it.
pub(crate) fn attention_rows(records: &[Record], now: i64) -> u32 {
    let visible: Vec<&Record> = records.iter().filter(|r| message_visible(r, now)).collect();
    let mut taken = std::collections::HashSet::new();
    let mut count = 0u32;
    for r in visible.iter().filter(|r| {
        r.data["lane"].as_str() == Some("critical") && r.data["acknowledgedAt"].is_null()
    }) {
        if taken.insert(message_key(r)) {
            count += 1;
        }
    }
    let mut reply_keys = std::collections::HashSet::new();
    for r in visible
        .iter()
        .filter(|r| r.data["lane"].as_str() == Some("reply"))
    {
        let key = message_key(r);
        if taken.contains(&key) {
            continue;
        }
        if reply_keys.insert(key) {
            count += 1;
        }
    }
    count
}

/// The workspace time zone's day key (`YYYY-MM-DD`), as `tasks::due_today_reminders` computes it.
fn day_key(zone: &str, now: i64) -> String {
    let tz: chrono_tz::Tz = zone.parse().unwrap_or(chrono_tz::UTC);
    chrono::DateTime::from_timestamp(now, 0)
        .map(|t| t.with_timezone(&tz).format("%Y-%m-%d").to_string())
        .unwrap_or_default()
}

/// The four sources (design §3), computed over the snapshot's own records, and the ids of the
/// meetings counted (design §5's `newMeetings`).
pub(crate) fn sources(s: &Snapshot, me: &MeAlias, seen: &Seen, now: i64) -> (Sources, Vec<String>) {
    let replies = attention_rows(&s.records, now);

    let active = active_provider(&s.settings);
    let today = day_key(&s.settings.time_zone, now);
    let tasks = s
        .records
        .iter()
        .filter(|r| r.kind == tasks::KIND)
        .filter(|r| tasks::provider_of(&r.data) == active)
        .filter(|r| tasks::is_open(&r.data))
        .filter(|r| tasks::is_mine(&r.data, me))
        .filter(|r| {
            r.data["due"]
                .as_str()
                .is_some_and(|due| due <= today.as_str())
        })
        .filter(|r| !(s.settings.menu_bar.replies && r.data["kind"].as_str() == Some("reply")))
        .count() as u32;

    let mut new_meetings = Vec::new();
    for r in s
        .records
        .iter()
        .filter(|r| r.kind == super::meetings::model::KIND)
    {
        let Ok(meeting) = serde_json::from_value::<MeetingRecord>(r.data.clone()) else {
            continue;
        };
        let mark = seen
            .meetings
            .get(&r.id)
            .copied()
            .unwrap_or(0)
            .max(seen.since);
        let has_new_doc = meeting
            .docs
            .iter()
            .any(|d| d.updated_at > mark && now - d.updated_at <= NEW_FOR);
        if has_new_doc {
            new_meetings.push(r.id.clone());
        }
    }
    let meetings_count = new_meetings.len() as u32;

    let automations_mark = seen.automations.max(seen.since);
    let automations = s
        .records
        .iter()
        .filter(|r| r.kind == "automation_run")
        .filter(|r| r.data["status"].as_str() == Some("ok"))
        .filter(|r| {
            r.data["delivered"].as_array().is_some_and(|delivered| {
                !delivered.is_empty()
                    && !(delivered.len() == 1 && delivered[0].as_str() == Some("meeting_summary"))
            })
        })
        .filter(|r| r.updated_at > automations_mark && now - r.updated_at <= NEW_FOR)
        .count() as u32;

    (
        Sources {
            replies,
            tasks,
            meetings: meetings_count,
            automations,
        },
        new_meetings,
    )
}

/// One "needs fixing" row (design §4): what is broken and where the window fixes it
/// (`{route, tab?, runId?, automationId?}`).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Fix {
    pub id: String,
    pub text: String,
    pub open: Value,
}

/// The snapshot's `menuBar` (design §5): the count of the chosen sources, every source's own
/// count, what needs fixing, the meetings counted as new and the tooltip.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MenuBar {
    pub count: u32,
    pub label: String,
    pub amber: bool,
    pub sources: Sources,
    pub counted: Vec<String>,
    pub fixes: Vec<Fix>,
    pub new_meetings: Vec<String>,
    pub tooltip: String,
}

/// The four sources in the order the menu and the tooltip name them.
const SOURCE_NAMES: [&str; 4] = ["replies", "tasks", "meetings", "automations"];

fn count_of(s: &Sources, name: &str) -> u32 {
    match name {
        "replies" => s.replies,
        "tasks" => s.tasks,
        "meetings" => s.meetings,
        _ => s.automations,
    }
}

fn chosen(m: &MenuBarSettings, name: &str) -> bool {
    match name {
        "replies" => m.replies,
        "tasks" => m.tasks,
        "meetings" => m.meetings,
        _ => m.automations,
    }
}

/// A source's menu row (design § Copy).
fn source_text(name: &str, n: u32) -> String {
    let one = n == 1;
    match name {
        "replies" if one => "1 message needs a reply".into(),
        "replies" => format!("{n} messages need a reply"),
        "tasks" if one => "1 task due or late".into(),
        "tasks" => format!("{n} tasks due or late"),
        "meetings" if one => "1 meeting with new notes".into(),
        "meetings" => format!("{n} meetings with new notes"),
        _ if one => "1 automation result".into(),
        _ => format!("{n} automation results"),
    }
}

/// The menu-bar title: nothing at zero, the number up to 99, then "99+".
pub fn label(count: u32) -> String {
    match count {
        0 => String::new(),
        1..=99 => count.to_string(),
        _ => "99+".into(),
    }
}

/// The counted sources with a non-zero count, in menu order.
fn source_rows(m: &MenuBar) -> Vec<(String, String)> {
    SOURCE_NAMES
        .iter()
        .filter(|name| m.counted.iter().any(|c| c == *name))
        .map(|name| (*name, count_of(&m.sources, name)))
        .filter(|(_, n)| *n > 0)
        .map(|(name, n)| (name.to_string(), source_text(name, n)))
        .collect()
}

/// "CodeMie Connect", then the counted rows, then the first fix (design §5).
fn tooltip(m: &MenuBar) -> String {
    let parts: Vec<String> = source_rows(m).into_iter().map(|(_, text)| text).collect();
    let mut text = "CodeMie Connect".to_string();
    if !parts.is_empty() {
        text.push_str(" · ");
        text.push_str(&parts.join(", "));
    }
    if let Some(fix) = m.fixes.first() {
        text.push_str(" · Needs fixing: ");
        text.push_str(&fix.text);
    }
    text
}

/// The menu's rows above the separator (design §5): each counted non-zero source, then at most
/// three fixes, then "and <n> more". Each row is `(id, text)`: the source name or the fix id.
pub fn rows(m: &MenuBar) -> Vec<(String, String)> {
    /// At most this many fix rows, then "and <n> more".
    const FIX_ROWS: usize = 3;
    let mut rows = source_rows(m);
    rows.extend(
        m.fixes
            .iter()
            .take(FIX_ROWS)
            .map(|f| (f.id.clone(), f.text.clone())),
    );
    if m.fixes.len() > FIX_ROWS {
        rows.push((
            "more".into(),
            format!("and {} more", m.fixes.len() - FIX_ROWS),
        ));
    }
    rows
}

fn fix(id: impl Into<String>, text: impl Into<String>, open: Value) -> Fix {
    Fix {
        id: id.into(),
        text: text.into(),
        open,
    }
}

/// A run that failed because Connect was offline or something was rate limited (Claude's
/// `rate_limited` class, Microsoft's `throttled` code): it passes by itself, so it is not a fix
/// (ruling 10).
fn passes_by_itself(run: &Record) -> bool {
    let error = &run.data["error"];
    error["class"] == "rate_limited"
        || matches!(
            error["code"].as_str(),
            Some("offline" | "rate_limited" | "throttled")
        )
}

/// The six "needs fixing" conditions (design §4, ruling 10). Offline, rate limits, a sync in
/// progress and a provider turned off are not fixes.
fn fixes(s: &Snapshot, task_provider: &Value) -> Vec<Fix> {
    let mut out = Vec::new();
    if s.connection
        .as_ref()
        .is_some_and(|c| c.status != "connected" && c.status != "disconnected")
    {
        out.push(fix(
            "microsoft",
            "Microsoft 365 needs you to sign in again.",
            json!({"route": "settings", "tab": "microsoft"}),
        ));
    }
    let provider = task_provider["name"]
        .as_str()
        .filter(|n| !n.is_empty())
        .unwrap_or("Connect");
    let tasks_tab = json!({"route": "settings", "tab": "meetings-tasks"});
    match task_provider["state"].as_str() {
        Some("needs_token") => out.push(fix(
            "tasks-token",
            format!("{provider} needs your API token."),
            tasks_tab,
        )),
        Some("failed") => out.push(fix(
            "tasks-plugin",
            format!("The {provider} plugin didn't load."),
            tasks_tab,
        )),
        _ => {}
    }
    let parked = task_provider["parked"].as_u64().unwrap_or(0);
    if parked > 0 {
        out.push(fix(
            "tasks-parked",
            format!("{provider} refused {parked} task change(s)."),
            json!({"route": "tasks"}),
        ));
    }
    let mut automations: Vec<&Record> = s
        .records
        .iter()
        .filter(|r| r.kind == "automation" && r.data["enabled"] != false)
        .collect();
    automations.sort_by(|a, b| a.id.cmp(&b.id));
    for a in automations {
        let newest = s
            .records
            .iter()
            .filter(|r| r.kind == "automation_run" && r.data["automationId"] == a.id.as_str())
            .max_by_key(|r| {
                (
                    r.data["startedAt"].as_i64().unwrap_or(0),
                    r.updated_at,
                    r.id.clone(),
                )
            });
        let Some(run) = newest.filter(|r| r.data["status"] == "failed" && !passes_by_itself(r))
        else {
            continue;
        };
        let name = a.data["name"]
            .as_str()
            .filter(|n| !n.is_empty())
            .unwrap_or(&a.id);
        let text = match run.data["error"]["message"]
            .as_str()
            .filter(|m| !m.is_empty())
        {
            Some(message) => format!("{name} failed: {message}"),
            None => format!("{name} failed."),
        };
        out.push(fix(
            format!("automation:{}", a.id),
            text,
            json!({"route": "automations", "runId": run.id, "automationId": a.id}),
        ));
    }
    if s.records.iter().any(|r| {
        r.kind == super::meetings::model::KIND && r.data["saveError"]["code"] == "folder_unwritable"
    }) {
        out.push(fix(
            "meetings-folder",
            "Connect can't write to the meetings folder.",
            json!({"route": "settings", "tab": "meetings-transcripts"}),
        ));
    }
    out
}

/// The menu bar for snapshot `s` (design §5): pure, so the window's snapshot and the tray
/// compute the same thing.
pub fn compute(
    s: &Snapshot,
    task_provider: &Value,
    me: &MeAlias,
    seen: &Seen,
    now: i64,
) -> MenuBar {
    let (sources, new_meetings) = sources(s, me, seen, now);
    let counted: Vec<String> = SOURCE_NAMES
        .iter()
        .filter(|name| chosen(&s.settings.menu_bar, name))
        .map(|name| name.to_string())
        .collect();
    let count = counted.iter().map(|name| count_of(&sources, name)).sum();
    let fixes = fixes(s, task_provider);
    let mut m = MenuBar {
        count,
        label: label(count),
        amber: !fixes.is_empty(),
        sources,
        counted,
        fixes,
        new_meetings,
        tooltip: String::new(),
    };
    m.tooltip = tooltip(&m);
    m
}

/// [`compute`] over the repository's snapshot `s`: the snapshot keeps only each automation's
/// latest runs, so the unseen results of the last 7 days are read from the repository and
/// counted with it, then taken out again.
pub(crate) fn read(
    r: &Repository,
    s: &mut Snapshot,
    task_provider: &Value,
    me: &MeAlias,
    now: i64,
) -> Result<MenuBar> {
    let seen = seen(r);
    let mark = seen.automations.max(seen.since).max(now - NEW_FOR);
    let workspace = r.workspace(&s.settings.active_workspace)?;
    let account = r.visible_account(&workspace)?;
    let shown: std::collections::HashSet<String> = s
        .records
        .iter()
        .filter(|rec| rec.kind == "automation_run")
        .map(|rec| rec.id.clone())
        .collect();
    let kept = s.records.len();
    s.records.extend(
        r.automation_runs_since(&workspace.id, account.as_deref(), mark)?
            .into_iter()
            .filter(|rec| !shown.contains(&rec.id)),
    );
    let m = compute(s, task_provider, me, &seen, now);
    s.records.truncate(kept);
    Ok(m)
}

fn not_found() -> WorkspaceError {
    WorkspaceError::new("not_found", "This meeting is no longer available.")
}

/// Keeps the per-meeting marks whose meeting record still exists, under whichever account
/// stored it (a meeting of an account signed out for now keeps its mark).
fn keep_existing(r: &Repository, seen: &mut Seen) -> Result<()> {
    let mut gone = Vec::new();
    for id in seen.meetings.keys() {
        if !r.has_record(super::meetings::model::KIND, id)? {
            gone.push(id.clone());
        }
    }
    for id in gone {
        seen.meetings.remove(&id);
    }
    Ok(())
}

/// Marks meeting `meeting_id` seen at `now` (design §2); an unknown meeting is `not_found`.
/// Drops the marks of meetings that are gone.
pub(crate) fn mark_meeting(r: &mut Repository, meeting_id: &str, now: i64) -> Result<()> {
    let mut seen = seen(r);
    seen.meetings.insert(meeting_id.to_string(), now);
    keep_existing(r, &mut seen)?;
    if !seen.meetings.contains_key(meeting_id) {
        return Err(not_found());
    }
    save(r, &seen, now)
}

/// Marks the automation results seen at `now` (design §2). Drops the marks of meetings that
/// are gone.
pub(crate) fn mark_automations(r: &mut Repository, now: i64) -> Result<()> {
    let mut seen = seen(r);
    seen.automations = now;
    keep_existing(r, &mut seen)?;
    save(r, &seen, now)
}

/// One row of the tray's menu: `mb:<row id>`, its text and the place it opens (design §5).
#[derive(Clone, Debug, PartialEq)]
pub struct TrayRow {
    pub id: String,
    pub text: String,
    pub open: Value,
}

/// What the tray shows: the title (a number or nothing), whether the icon is amber, the
/// tooltip and the menu's rows above the separator.
#[derive(Clone, Debug, PartialEq)]
pub struct TrayView {
    pub title: Option<String>,
    pub amber: bool,
    pub tooltip: String,
    pub rows: Vec<TrayRow>,
}

/// The place a menu row opens (design §5 "A row's click").
fn row_open(m: &MenuBar, id: &str) -> Value {
    match id {
        "replies" => json!({"route": "inbox", "lane": "reply"}),
        "tasks" => json!({"route": "tasks"}),
        "meetings" => match m.new_meetings.as_slice() {
            [one] => json!({"meetingId": one}),
            _ => json!({"route": "meetings"}),
        },
        "automations" => json!({"route": "automations"}),
        // Settings › Notifications lists every fix in its Menu bar card.
        "more" => json!({"route": "settings", "tab": "notifications"}),
        fix => m
            .fixes
            .iter()
            .find(|f| f.id == fix)
            .map(|f| f.open.clone())
            .unwrap_or(Value::Null),
    }
}

/// The tray for menu bar `m`: no title at zero.
pub fn tray_view(m: &MenuBar) -> TrayView {
    TrayView {
        title: (!m.label.is_empty()).then(|| m.label.clone()),
        amber: m.amber,
        tooltip: m.tooltip.clone(),
        rows: rows(m)
            .into_iter()
            .map(|(id, text)| TrayRow {
                open: row_open(m, &id),
                id: format!("mb:{id}"),
                text,
            })
            .collect(),
    }
}

/// The `workspace:notification-open` payload of a clicked menu row.
pub fn open_payload(open: &Value) -> Value {
    let mut payload = match open {
        Value::Object(_) => open.clone(),
        _ => json!({}),
    };
    payload["workspaceId"] = PERSONAL.into();
    payload
}

/// Amber `#F5A623`.
const AMBER: [u8; 3] = [245, 166, 35];

/// The template glyph recoloured amber, alpha kept (ruling 9: no new image ships).
pub fn amber_rgba(rgba: &[u8]) -> Vec<u8> {
    rgba.chunks_exact(4)
        .flat_map(|px| [AMBER[0], AMBER[1], AMBER[2], px[3]])
        .collect()
}

/// Where a tray view goes: the app's tray, or `FakeTray` in tests.
pub trait TraySink: Send + Sync {
    fn apply(&self, view: &TrayView);
}

/// Records each applied view. `slow` makes each apply take that long, like the main-thread
/// round-trips of the real tray, and `overlapped` says whether two applies ever ran at once.
#[cfg(test)]
#[derive(Clone, Default)]
pub struct FakeTray {
    applied: std::sync::Arc<std::sync::Mutex<Vec<TrayView>>>,
    slow: std::sync::Arc<std::sync::atomic::AtomicU64>,
    /// An apply is under way (the fake's own flag, not [`Refresher`]'s `applying` lock).
    in_apply: std::sync::Arc<std::sync::atomic::AtomicBool>,
    overlapped: std::sync::Arc<std::sync::atomic::AtomicBool>,
}

#[cfg(test)]
impl FakeTray {
    pub fn applied(&self) -> Vec<TrayView> {
        self.applied.lock().unwrap().clone()
    }
    pub fn set_slow(&self, ms: u64) {
        self.slow.store(ms, std::sync::atomic::Ordering::SeqCst);
    }
    pub fn overlapped(&self) -> bool {
        self.overlapped.load(std::sync::atomic::Ordering::SeqCst)
    }
    /// Blocks until an apply is under way (at most 5 s), so a test can act during it.
    pub fn wait_until_applying(&self) {
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(5);
        while !self.in_apply.load(std::sync::atomic::Ordering::SeqCst) {
            assert!(std::time::Instant::now() < deadline, "no apply started");
            std::thread::sleep(std::time::Duration::from_millis(1));
        }
    }
}

#[cfg(test)]
impl TraySink for FakeTray {
    fn apply(&self, view: &TrayView) {
        use std::sync::atomic::Ordering::SeqCst;
        if self.in_apply.swap(true, SeqCst) {
            self.overlapped.store(true, SeqCst);
        }
        std::thread::sleep(std::time::Duration::from_millis(self.slow.load(SeqCst)));
        self.applied.lock().unwrap().push(view.clone());
        self.in_apply.store(false, SeqCst);
    }
}

/// How long the refresher waits for more changes before it counts (design §5).
const DEBOUNCE: std::time::Duration = std::time::Duration::from_millis(300);

/// Keeps the tray in step with the workspace: `Core::emit("workspace:changed")` wakes it, and
/// it applies a view only when it differs from the last one applied.
pub struct Refresher {
    notify: std::sync::Arc<tokio::sync::Notify>,
    last: std::sync::Mutex<Option<TrayView>>,
    /// Held across compare, record and apply, so applies never overlap and the tray always
    /// shows what `last` holds. Never taken on the main thread (`open_menu_row` reads `last`
    /// only), and `last` is let go before the tray is set.
    applying: std::sync::Mutex<()>,
    /// The main thread, recorded by `install` (`setup_tray` calls it there). Each macOS tray
    /// setter blocks on that thread, so `offer` never waits for `applying` while running on it:
    /// a busy lock there would deadlock against the apply it is waiting for.
    main_thread: std::sync::OnceLock<std::thread::ThreadId>,
    /// Installed once the tray exists; until then views are counted but not applied.
    sink: std::sync::OnceLock<Box<dyn TraySink>>,
    clock: std::sync::Mutex<fn() -> i64>,
    #[cfg(test)]
    fake: std::sync::OnceLock<FakeTray>,
}

impl Refresher {
    pub fn new(clock: fn() -> i64) -> Self {
        Self {
            notify: Default::default(),
            last: Default::default(),
            applying: Default::default(),
            main_thread: Default::default(),
            sink: Default::default(),
            clock: std::sync::Mutex::new(clock),
            #[cfg(test)]
            fake: Default::default(),
        }
    }

    /// Where views go from now on; a second sink is ignored. Records the calling thread as the
    /// main thread (`setup_tray` calls this there), so `offer` knows when it must not block.
    pub fn install(&self, sink: Box<dyn TraySink>) {
        let _ = self.main_thread.set(std::thread::current().id());
        let _ = self.sink.set(sink);
    }

    /// Whether a sink has already taken the slot. A test seam for callers (`commands::tour`'s
    /// `install_quiet_menu_bar`) that need to prove they claimed it, since [`install`] itself
    /// answers nothing and a second call is silently ignored.
    #[cfg(test)]
    pub(crate) fn has_sink(&self) -> bool {
        self.sink.get().is_some()
    }

    /// Asks for a recount. Takes no lock, so callers may hold the repository guard.
    pub fn wake(&self) {
        self.notify.notify_one();
    }

    /// The view last applied to the tray.
    pub fn last(&self) -> Option<TrayView> {
        self.last.lock().map(|l| l.clone()).unwrap_or(None)
    }

    fn now(&self) -> i64 {
        self.clock.lock().map(|c| (*c)()).unwrap_or_else(|_| now())
    }

    /// Applies `view` when a sink is installed and the view differs from the last one applied.
    /// One apply at a time; the tray is set outside the `last` lock. On the main thread, a busy
    /// `applying` lock is never waited on (ruling: that would deadlock the apply holding it, on
    /// macOS blocked on this same thread's tray setters); instead this asks for a recount.
    fn offer(&self, view: &TrayView) {
        let Some(sink) = self.sink.get() else { return };
        let on_main_thread = self.main_thread.get() == Some(&std::thread::current().id());
        let _applying = if on_main_thread {
            match self.applying.try_lock() {
                Ok(guard) => guard,
                Err(std::sync::TryLockError::Poisoned(e)) => e.into_inner(),
                Err(std::sync::TryLockError::WouldBlock) => {
                    self.wake();
                    return;
                }
            }
        } else {
            self.applying.lock().unwrap_or_else(|e| e.into_inner())
        };
        {
            let Ok(mut last) = self.last.lock() else {
                return;
            };
            if last.as_ref() == Some(view) {
                return;
            }
            *last = Some(view.clone());
        }
        sink.apply(view);
    }

    #[cfg(test)]
    pub(crate) fn install_fake(&self) {
        let fake = FakeTray::default();
        self.install(Box::new(fake.clone()));
        let _ = self.fake.set(fake);
    }

    #[cfg(test)]
    pub(crate) fn fake(&self) -> &FakeTray {
        self.fake.get().expect("test_core installs a FakeTray")
    }

    #[cfg(test)]
    pub(crate) fn set_clock(&self, clock: fn() -> i64) {
        *self.clock.lock().unwrap() = clock;
    }
}

impl super::Core {
    fn me_of(&self, s: &Snapshot) -> MeAlias {
        s.connection
            .as_ref()
            .map(|c| self.me_alias(c, &s.settings.meetings))
            .unwrap_or_default()
    }

    /// Counts now and applies the tray view if it changed (design §5). The repository guard is
    /// held only while reading; it is let go before the tray is set.
    pub(crate) fn refresh_menu_bar_now(&self) -> Result<TrayView> {
        let at = self.menu_bar.now();
        let mut s = self.repo()?.snapshot()?;
        s.task_provider = self.task_provider_snapshot(&s.settings);
        let me = self.me_of(&s);
        let task_provider = s.task_provider.clone();
        let m = {
            let r = self.repo()?;
            read(&r, &mut s, &task_provider, &me, at)?
        };
        let view = tray_view(&m);
        self.menu_bar.offer(&view);
        Ok(view)
    }

    /// Starts the refresher: each wake waits [`DEBOUNCE`] for more, then counts once. It runs
    /// once at start and ends when Connect stops or Core is gone.
    pub(crate) fn start_menu_bar(self: &std::sync::Arc<Self>) {
        let notify = self.menu_bar.notify.clone();
        let core = std::sync::Arc::downgrade(self);
        tauri::async_runtime::spawn(async move {
            loop {
                notify.notified().await;
                tokio::time::sleep(DEBOUNCE).await;
                // The wakes that came while waiting are this same count.
                let _ = tokio::time::timeout(std::time::Duration::ZERO, notify.notified()).await;
                let Some(core) = core.upgrade() else { break };
                if core.stop.load(std::sync::atomic::Ordering::Relaxed) {
                    break;
                }
                if let Err(e) = core.refresh_menu_bar_now() {
                    log::warn!("menu bar: the tray could not be refreshed ({})", e.code);
                }
            }
        });
        self.menu_bar.wake();
    }

    /// The window's `menuBar`, computed after `taskProvider` (design §7). `null` when the
    /// repository can't be read.
    pub(in crate::workspace) fn menu_bar_snapshot(&self, s: &mut Snapshot) -> Value {
        let me = self.me_of(s);
        let task_provider = s.task_provider.clone();
        let Ok(r) = self.repo() else {
            return Value::Null;
        };
        match read(&r, s, &task_provider, &me, now()) {
            Ok(m) => serde_json::to_value(m).unwrap_or(Value::Null),
            Err(e) => {
                log::warn!("menu bar: the count could not be computed ({})", e.code);
                Value::Null
            }
        }
    }

    /// `menu_bar_seen {meetingId}` or `{automations: true}` (design §2): answers `{seen: true}`.
    pub(in crate::workspace) fn menu_bar_seen(&self, req: &Request) -> Result<Value> {
        let said = || WorkspaceError::new("validation", "Say what was seen.");
        let mut r = self.repo()?;
        match req.data.get("meetingId").filter(|v| !v.is_null()) {
            Some(v) => {
                let id = v.as_str().filter(|id| !id.is_empty()).ok_or_else(said)?;
                mark_meeting(&mut r, id, now())?;
            }
            None if req.data["automations"] == true => mark_automations(&mut r, now())?,
            None => return Err(said()),
        }
        Ok(json!({"seen": true}))
    }
}

/// Test support: starts the seen marks over at `since`, as if nothing had been seen.
#[cfg(test)]
pub(crate) fn reset_seen_for_tests(r: &mut Repository, since: i64) {
    save(
        r,
        &Seen {
            since,
            automations: 0,
            meetings: BTreeMap::new(),
        },
        since,
    )
    .unwrap();
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn message(id: &str, lane: &str, data: Value) -> Record {
        let mut body = json!({"lane": lane});
        for (k, v) in data.as_object().unwrap() {
            body[k] = v.clone();
        }
        Record {
            id: id.into(),
            kind: "message".into(),
            connection_id: None,
            workspace_id: Some(PERSONAL.into()),
            source: "mail:inbox".into(),
            revision: "r1".into(),
            updated_at: 0,
            data: body,
        }
    }

    fn snapshot(settings: Settings, records: Vec<Record>) -> Snapshot {
        Snapshot {
            revision: 0,
            workspaces: Vec::new(),
            settings,
            connection: None,
            records,
            jobs: Vec::new(),
            available: true,
            meetings_root: None,
            note_templates: Vec::new(),
            task_provider: Value::Null,
            menu_bar: Value::Null,
            reply_voice: Value::Null,
            ask: Value::Null,
        }
    }

    fn task(id: &str, data: Value) -> Record {
        let mut body = json!({"status": "todo"});
        for (k, v) in data.as_object().unwrap() {
            body[k] = v.clone();
        }
        Record {
            id: id.into(),
            kind: tasks::KIND.into(),
            connection_id: None,
            workspace_id: Some(PERSONAL.into()),
            source: "local".into(),
            revision: "r1".into(),
            updated_at: 0,
            data: body,
        }
    }

    fn meeting(id: &str, docs: Vec<Value>) -> Record {
        Record {
            id: id.into(),
            kind: super::super::meetings::model::KIND.into(),
            connection_id: None,
            workspace_id: Some(PERSONAL.into()),
            source: "local".into(),
            revision: "r1".into(),
            updated_at: 0,
            data: json!({"eventId": id, "title": "", "start": "", "end": "", "docs": docs}),
        }
    }

    fn automation_run(id: &str, status: &str, delivered: Vec<&str>, updated_at: i64) -> Record {
        Record {
            id: id.into(),
            kind: "automation_run".into(),
            connection_id: None,
            workspace_id: Some(PERSONAL.into()),
            source: "automation".into(),
            revision: "r1".into(),
            updated_at,
            data: json!({"status": status, "delivered": delivered}),
        }
    }

    #[test]
    fn settings_default_to_replies_only() {
        let s = Settings::default();
        assert_eq!(
            s.menu_bar,
            MenuBarSettings {
                replies: true,
                tasks: false,
                meetings: false,
                automations: false,
            }
        );
        let v = serde_json::to_value(&s).unwrap();
        assert_eq!(
            v["menuBar"],
            json!({"replies": true, "tasks": false, "meetings": false, "automations": false})
        );

        let old: Settings = serde_json::from_str(r#"{"syncDays":7}"#).unwrap();
        assert_eq!(old.menu_bar, MenuBarSettings::default());

        let mut m = MenuBarSettings::default();
        m.apply(&json!({"tasks": true})).unwrap();
        assert!(m.replies);
        assert!(m.tasks);

        let err = m.apply(&json!({"tasks": "yes"})).unwrap_err();
        assert_eq!(err.code, "validation");
        assert_eq!(err.field.as_deref(), Some("menuBar"));
        assert_eq!(err.message, "Choose on or off.");
    }

    /// Snoozed far ahead, so the UI's own clock agrees when it checks the reply cases.
    const SNOOZED: i64 = 4_102_444_800;

    /// The Inbox cases the reply count must agree on (also the UI's parity fixture).
    fn inbox_cases() -> Vec<Record> {
        vec![
            // mail reply
            message("m1", "reply", json!({"channel": "mail"})),
            // chat c1: five reply messages + one critical unacknowledged -> one row
            message(
                "c1-1",
                "reply",
                json!({"channel": "chat", "conversationId": "c1"}),
            ),
            message(
                "c1-2",
                "reply",
                json!({"channel": "chat", "conversationId": "c1"}),
            ),
            message(
                "c1-3",
                "reply",
                json!({"channel": "chat", "conversationId": "c1"}),
            ),
            message(
                "c1-4",
                "reply",
                json!({"channel": "chat", "conversationId": "c1"}),
            ),
            message(
                "c1-5",
                "reply",
                json!({"channel": "chat", "conversationId": "c1"}),
            ),
            message(
                "c1-critical",
                "critical",
                json!({"channel": "chat", "conversationId": "c1", "acknowledgedAt": null}),
            ),
            // chat c2: critical acknowledged + reply -> the reply only
            message(
                "c2-critical",
                "critical",
                json!({"channel": "chat", "conversationId": "c2", "acknowledgedAt": 5}),
            ),
            message(
                "c2-reply",
                "reply",
                json!({"channel": "chat", "conversationId": "c2"}),
            ),
            // chat c3: critical with acknowledgedAt 0 (never written this way in practice, only
            // null or a real epoch timestamp) -> acknowledged, same as a real timestamp; pins the
            // parity gap against the JS port (selectors.js::attentionMessages), which used to
            // treat 0 as falsy and so unacknowledged.
            message(
                "c3-critical-zero",
                "critical",
                json!({"channel": "chat", "conversationId": "c3", "acknowledgedAt": 0}),
            ),
            // archived, deleted, snoozed -> none of these count
            message(
                "archived",
                "reply",
                json!({"channel": "mail", "lifecycle": "archived"}),
            ),
            message(
                "deleted",
                "reply",
                json!({"channel": "mail", "deleted": true}),
            ),
            message(
                "snoozed",
                "reply",
                json!({"channel": "mail", "snoozedUntil": SNOOZED}),
            ),
        ]
    }

    #[test]
    fn replies_match_inbox_one_per_chat() {
        let now = 1_000_000;
        let records = inbox_cases();
        assert_eq!(attention_rows(&records, now), 3);
    }

    #[test]
    fn tasks_are_my_open_tasks_due_today_or_late() {
        let now = 1_000_000; // 1970-01-12 13:46:40 UTC
        let mut settings = Settings::default();
        settings.time_zone = "Europe/Vilnius".into();
        let today = day_key("Europe/Vilnius", now);
        let yesterday = day_key("Europe/Vilnius", now - 86_400);
        let tomorrow = day_key("Europe/Vilnius", now + 86_400);
        let me = MeAlias {
            name: "Me".into(),
            aliases: Vec::new(),
            address: Some("me@example.test".into()),
        };
        let records = vec![
            task(
                "due-today",
                json!({"owner": "me@example.test", "due": today}),
            ),
            task(
                "due-yesterday",
                json!({"owner": "me@example.test", "due": yesterday}),
            ),
            task(
                "due-tomorrow",
                json!({"owner": "me@example.test", "due": tomorrow}),
            ),
            task(
                "done",
                json!({"owner": "me@example.test", "due": today, "status": "done"}),
            ),
            task(
                "dismissed",
                json!({"owner": "me@example.test", "due": today, "status": "dismissed"}),
            ),
            task(
                "review",
                json!({"owner": "me@example.test", "due": today, "status": "review"}),
            ),
            task("not-mine", json!({"owner": "Ann", "due": today})),
            task(
                "reply-kind",
                json!({"owner": "me@example.test", "due": today, "kind": "reply"}),
            ),
        ];
        let seen = Seen::default();

        let mut off = settings.clone();
        off.menu_bar.replies = false;
        let snap = snapshot(off, records.clone());
        let (counted, _) = sources(&snap, &me, &seen, now);
        assert_eq!(counted.tasks, 3); // due-today, due-yesterday, reply-kind (replies not counted)

        let mut on = settings;
        on.menu_bar.replies = true;
        let snap = snapshot(on, records);
        let (counted, _) = sources(&snap, &me, &seen, now);
        assert_eq!(counted.tasks, 2); // reply-kind dropped while replies are counted
    }

    #[test]
    fn meetings_with_new_notes_since_seen_within_seven_days() {
        let now = 1_000_000;
        let settings = Settings::default();
        let me = MeAlias::default();
        let mut seen = Seen {
            since: now - 10 * NEW_FOR,
            automations: 0,
            meetings: BTreeMap::new(),
        };

        let records = vec![
            meeting("new", vec![json!({"updatedAt": now - 10})]),
            meeting("marked-after", vec![json!({"updatedAt": now - 10})]),
            meeting("stale", vec![json!({"updatedAt": now - NEW_FOR - 10})]),
        ];
        seen.meetings.insert("marked-after".into(), now - 5);

        let snap = snapshot(settings, records);
        let (counted, new_meetings) = sources(&snap, &me, &seen, now);
        assert_eq!(counted.meetings, 1);
        assert_eq!(new_meetings, vec!["new".to_string()]);
    }

    #[test]
    fn automation_results_are_ok_runs_after_the_mark() {
        let now = 1_000_000;
        let settings = Settings::default();
        let me = MeAlias::default();
        let seen = Seen {
            since: now - 10 * NEW_FOR,
            automations: now - 100,
            meetings: BTreeMap::new(),
        };
        let records = vec![
            automation_run("ok", "ok", vec!["today"], now - 10),
            automation_run("failed", "failed", vec!["today"], now - 10),
            automation_run("skipped", "skipped", vec!["today"], now - 10),
            automation_run("summary-only", "ok", vec!["meeting_summary"], now - 10),
            automation_run("empty", "ok", vec![], now - 10),
        ];
        let snap = snapshot(settings, records);
        let (counted, _) = sources(&snap, &me, &seen, now);
        assert_eq!(counted.automations, 1);
    }

    #[test]
    fn nothing_before_since_is_new() {
        let now = 1_000_000;
        let since = now - 10;
        let settings = Settings::default();
        let me = MeAlias::default();
        let seen = Seen {
            since,
            automations: 0,
            meetings: BTreeMap::new(),
        };
        let mut records = Vec::new();
        for i in 0..100 {
            records.push(meeting(
                &format!("m{i}"),
                vec![json!({"updatedAt": since - 1})],
            ));
        }
        for i in 0..50 {
            records.push(automation_run(
                &format!("a{i}"),
                "ok",
                vec!["today"],
                since - 1,
            ));
        }
        let snap = snapshot(settings, records);
        let (counted, new_meetings) = sources(&snap, &me, &seen, now);
        assert_eq!(counted.meetings, 0);
        assert_eq!(counted.automations, 0);
        assert!(new_meetings.is_empty());
    }

    #[tokio::test]
    async fn settings_update_saves_menu_bar_and_open_sets_since() {
        use crate::ai::fake::FakeRunner;
        use crate::workspace::ai::tests::{mutation, ready};
        use crate::workspace::test_core;
        use std::sync::Arc;

        let dir = tempfile::tempdir().unwrap();
        let core = test_core(dir.path(), Arc::new(FakeRunner::new(vec![])), ready());
        assert!(seen(&core.repo().unwrap()).since > 0);

        let req = mutation(
            &core,
            Operation::SettingsUpdate,
            json!({"menuBar": {"meetings": true}}),
        );
        core.request(req).await.unwrap();
        let snapshot = core.repo().unwrap().snapshot().unwrap();
        assert!(snapshot.settings.menu_bar.meetings);
    }

    fn bar(sources: Sources, counted: &[&str], fixes: Vec<Fix>) -> MenuBar {
        let count = counted
            .iter()
            .map(|name| match *name {
                "replies" => sources.replies,
                "tasks" => sources.tasks,
                "meetings" => sources.meetings,
                _ => sources.automations,
            })
            .sum();
        let mut m = MenuBar {
            count,
            label: label(count),
            amber: !fixes.is_empty(),
            sources,
            counted: counted.iter().map(|s| s.to_string()).collect(),
            fixes,
            new_meetings: Vec::new(),
            tooltip: String::new(),
        };
        m.tooltip = tooltip(&m);
        m
    }

    fn fix(id: &str, text: &str) -> Fix {
        Fix {
            id: id.into(),
            text: text.into(),
            open: json!({"route": "tasks"}),
        }
    }

    #[test]
    fn label_and_tooltip() {
        assert_eq!(label(0), "");
        assert_eq!(label(7), "7");
        assert_eq!(label(99), "99");
        assert_eq!(label(100), "99+");

        let zero = bar(Sources::default(), &["replies"], Vec::new());
        assert_eq!(zero.tooltip, "CodeMie Connect");

        let two = Sources {
            replies: 2,
            tasks: 1,
            meetings: 0,
            automations: 0,
        };
        let m = bar(two.clone(), &["replies", "tasks"], Vec::new());
        assert_eq!(
            m.tooltip,
            "CodeMie Connect · 2 messages need a reply, 1 task due or late"
        );

        let m = bar(
            two,
            &["replies", "tasks"],
            vec![fix("tasks-token", "Todoist needs your API token.")],
        );
        assert!(
            m.tooltip
                .ends_with(" · Needs fixing: Todoist needs your API token."),
            "{}",
            m.tooltip
        );
    }

    #[test]
    fn only_counted_sources_add_up() {
        let now = 1_000_000;
        let mut settings = Settings::default();
        settings.menu_bar = MenuBarSettings {
            replies: true,
            tasks: true,
            meetings: false,
            automations: false,
        };
        let me = MeAlias {
            name: "Me".into(),
            aliases: Vec::new(),
            address: Some("me@example.test".into()),
        };
        let today = day_key(&settings.time_zone, now);
        let seen = Seen {
            since: now - 10 * NEW_FOR,
            automations: 0,
            meetings: BTreeMap::new(),
        };
        let records = vec![
            message("r1", "reply", json!({"channel": "mail"})),
            message("r2", "reply", json!({"channel": "mail"})),
            task("t1", json!({"owner": "me@example.test", "due": today})),
            meeting("m1", vec![json!({"updatedAt": now - 10})]),
            meeting("m2", vec![json!({"updatedAt": now - 10})]),
            meeting("m3", vec![json!({"updatedAt": now - 10})]),
            automation_run("a1", "ok", vec!["today"], now - 10),
            automation_run("a2", "ok", vec!["today"], now - 10),
            automation_run("a3", "ok", vec!["today"], now - 10),
            automation_run("a4", "ok", vec!["today"], now - 10),
        ];
        let m = compute(
            &snapshot(settings.clone(), records.clone()),
            &Value::Null,
            &me,
            &seen,
            now,
        );
        assert_eq!(
            m.sources,
            Sources {
                replies: 2,
                tasks: 1,
                meetings: 3,
                automations: 4
            }
        );
        assert_eq!(m.count, 3);
        assert_eq!(m.label, "3");
        assert_eq!(m.counted, vec!["replies".to_string(), "tasks".to_string()]);

        settings.menu_bar = MenuBarSettings {
            replies: false,
            tasks: false,
            meetings: false,
            automations: false,
        };
        let m = compute(&snapshot(settings, records), &Value::Null, &me, &seen, now);
        assert_eq!(m.count, 0);
        assert_eq!(m.label, "");
        assert!(m.counted.is_empty());
    }

    fn automation(id: &str, name: &str, enabled: bool) -> Record {
        Record {
            id: id.into(),
            kind: "automation".into(),
            connection_id: None,
            workspace_id: Some(PERSONAL.into()),
            source: "local".into(),
            revision: "r1".into(),
            updated_at: 0,
            data: json!({"id": id, "name": name, "enabled": enabled}),
        }
    }

    fn run_of(id: &str, automation: &str, status: &str, started: i64, message: &str) -> Record {
        let mut data = json!({"automationId": automation, "automationName": "Old name",
            "status": status, "startedAt": started, "delivered": []});
        if status == "failed" {
            data["error"] = json!({"class": "failed", "code": "failed", "message": message});
        }
        Record {
            id: id.into(),
            kind: "automation_run".into(),
            connection_id: None,
            workspace_id: Some(PERSONAL.into()),
            source: "automation".into(),
            revision: "r1".into(),
            updated_at: started + 5,
            data,
        }
    }

    fn fixes_of(connection: Option<Connection>, records: Vec<Record>, tp: Value) -> Vec<Fix> {
        let mut s = snapshot(Settings::default(), records);
        s.connection = connection;
        compute(&s, &tp, &MeAlias::default(), &Seen::default(), 1_000_000).fixes
    }

    fn ids_of(fixes: &[Fix]) -> Vec<&str> {
        fixes.iter().map(|f| f.id.as_str()).collect()
    }

    #[test]
    fn each_fix_has_its_condition() {
        let account = |status: &str| Connection {
            status: status.into(),
            ..Default::default()
        };
        let tp =
            |state: &str, parked: u64| json!({"name": "Todoist", "state": state, "parked": parked});

        // Microsoft 365: anything but connected or disconnected is "Sign in again".
        let f = fixes_of(Some(account("needs_login")), vec![], Value::Null);
        assert_eq!(ids_of(&f), vec!["microsoft"]);
        assert_eq!(f[0].text, "Microsoft 365 needs you to sign in again.");
        assert_eq!(f[0].open, json!({"route": "settings", "tab": "microsoft"}));
        assert!(fixes_of(Some(account("disconnected")), vec![], Value::Null).is_empty());
        assert!(fixes_of(Some(account("connected")), vec![], Value::Null).is_empty());
        assert!(fixes_of(None, vec![], Value::Null).is_empty());

        // The task provider.
        let f = fixes_of(None, vec![], tp("needs_token", 0));
        assert_eq!(ids_of(&f), vec!["tasks-token"]);
        assert_eq!(f[0].text, "Todoist needs your API token.");
        assert_eq!(
            f[0].open,
            json!({"route": "settings", "tab": "meetings-tasks"})
        );
        let f = fixes_of(None, vec![], tp("failed", 0));
        assert_eq!(ids_of(&f), vec!["tasks-plugin"]);
        assert_eq!(f[0].text, "The Todoist plugin didn't load.");
        assert_eq!(
            f[0].open,
            json!({"route": "settings", "tab": "meetings-tasks"})
        );
        let f = fixes_of(None, vec![], tp("ready", 2));
        assert_eq!(ids_of(&f), vec!["tasks-parked"]);
        assert_eq!(f[0].text, "Todoist refused 2 task change(s).");
        assert_eq!(f[0].open, json!({"route": "tasks"}));
        for state in [
            "offline",
            "rate_limited",
            "syncing",
            "off",
            "ready",
            "local",
            "loading",
        ] {
            assert!(
                fixes_of(None, vec![], tp(state, 0)).is_empty(),
                "{state} is not a fix"
            );
        }
        // No provider name: Connect.
        let f = fixes_of(None, vec![], json!({"state": "needs_token", "parked": 0}));
        assert_eq!(f[0].text, "Connect needs your API token.");

        // An enabled automation whose newest run failed.
        let failed = vec![
            automation("auto-brief", "Morning brief", true),
            run_of("run-old", "auto-brief", "ok", 100, ""),
            run_of(
                "run-new",
                "auto-brief",
                "failed",
                200,
                "Claude is not signed in.",
            ),
        ];
        let f = fixes_of(None, failed.clone(), Value::Null);
        assert_eq!(ids_of(&f), vec!["automation:auto-brief"]);
        assert_eq!(f[0].text, "Morning brief failed: Claude is not signed in.");
        assert_eq!(
            f[0].open,
            json!({"route": "automations", "runId": "run-new", "automationId": "auto-brief"})
        );
        // Turned off, or a newer ok run: none.
        let mut off = failed.clone();
        off[0] = automation("auto-brief", "Morning brief", false);
        assert!(fixes_of(None, off, Value::Null).is_empty());
        let mut later = failed.clone();
        later.push(run_of("run-later", "auto-brief", "ok", 300, ""));
        assert!(fixes_of(None, later, Value::Null).is_empty());
        // Offline or rate limited passes by itself: no amber. Any other failure: amber.
        for (error, amber) in [
            (
                json!({"class": "failed", "code": "offline", "message": "No network."}),
                false,
            ),
            (
                json!({"class": "rate_limited", "code": "rate_limited",
                "message": "Claude is rate limited right now."}),
                false,
            ),
            (
                json!({"class": "failed", "code": "throttled", "message": "Microsoft is busy."}),
                false,
            ),
            (
                json!({"class": "needs_login", "code": "needs_login",
                "message": "Claude is not signed in."}),
                true,
            ),
            (
                json!({"class": "timeout", "code": "timeout",
                "message": "Claude took too long to answer."}),
                true,
            ),
        ] {
            let mut runs = failed.clone();
            runs[2].data["error"] = error.clone();
            let f = fixes_of(None, runs, Value::Null);
            assert_eq!(!f.is_empty(), amber, "{error}");
        }

        // A meeting Connect could not save into its folder.
        let mut stuck = meeting("m1", vec![]);
        stuck.data["saveError"] = json!({"code": "folder_unwritable", "message": "x"});
        let mut offline = meeting("m2", vec![]);
        offline.data["saveError"] = json!({"code": "offline", "message": "x"});
        let f = fixes_of(None, vec![stuck, offline.clone()], Value::Null);
        assert_eq!(ids_of(&f), vec!["meetings-folder"]);
        assert_eq!(f[0].text, "Connect can't write to the meetings folder.");
        assert_eq!(
            f[0].open,
            json!({"route": "settings", "tab": "meetings-transcripts"})
        );
        assert!(fixes_of(None, vec![offline], Value::Null).is_empty());

        // Amber is exactly "something needs fixing".
        let mut s = snapshot(Settings::default(), vec![]);
        s.connection = Some(account("needs_login"));
        let m = compute(&s, &Value::Null, &MeAlias::default(), &Seen::default(), 0);
        assert!(m.amber);
        assert_eq!(m.count, 0);
        assert_eq!(m.label, "");
        assert_eq!(
            m.tooltip,
            "CodeMie Connect · Needs fixing: Microsoft 365 needs you to sign in again."
        );
        let m = compute(
            &snapshot(Settings::default(), vec![]),
            &Value::Null,
            &MeAlias::default(),
            &Seen::default(),
            0,
        );
        assert!(!m.amber);
        assert!(m.fixes.is_empty());
    }

    #[test]
    fn rows_name_the_parts_and_cap_fixes() {
        let one = |name: &str, n: u32| {
            let mut s = Sources::default();
            match name {
                "replies" => s.replies = n,
                "tasks" => s.tasks = n,
                "meetings" => s.meetings = n,
                _ => s.automations = n,
            }
            rows(&bar(s, &[name], Vec::new()))
        };
        assert_eq!(
            one("replies", 1),
            vec![("replies".to_string(), "1 message needs a reply".to_string())]
        );
        assert_eq!(one("replies", 3)[0].1, "3 messages need a reply");
        assert_eq!(one("tasks", 2)[0].1, "2 tasks due or late");
        assert_eq!(one("tasks", 1)[0].1, "1 task due or late");
        assert_eq!(one("meetings", 1)[0].1, "1 meeting with new notes");
        assert_eq!(one("meetings", 2)[0].1, "2 meetings with new notes");
        assert_eq!(one("automations", 4)[0].1, "4 automation results");
        assert_eq!(one("automations", 1)[0].1, "1 automation result");

        // Counted sources in order, zero and uncounted ones left out, then three fixes and the
        // rest as "and <n> more".
        let s = Sources {
            replies: 1,
            tasks: 0,
            meetings: 2,
            automations: 5,
        };
        let fixes: Vec<Fix> = (1..=5)
            .map(|n| fix(&format!("f{n}"), &format!("Fix {n}.")))
            .collect();
        let r = rows(&bar(s, &["replies", "tasks", "meetings"], fixes));
        assert_eq!(
            r,
            vec![
                ("replies".to_string(), "1 message needs a reply".to_string()),
                (
                    "meetings".to_string(),
                    "2 meetings with new notes".to_string()
                ),
                ("f1".to_string(), "Fix 1.".to_string()),
                ("f2".to_string(), "Fix 2.".to_string()),
                ("f3".to_string(), "Fix 3.".to_string()),
                ("more".to_string(), "and 2 more".to_string()),
            ]
        );
        assert!(rows(&bar(Sources::default(), &["replies"], Vec::new())).is_empty());
    }

    fn read_snapshot(op: Operation) -> Request {
        Request {
            op,
            workspace_id: Some(PERSONAL.into()),
            expected_revision: None,
            operation_id: None,
            data: json!({}),
        }
    }

    /// The snapshot keeps each automation's latest run (and its latest run delivered to Today);
    /// the menu bar still counts every unseen result of the last 7 days.
    #[tokio::test]
    async fn automation_results_count_every_unseen_run() {
        use crate::ai::fake::FakeRunner;
        use crate::workspace::ai::tests::ready;
        use crate::workspace::test_core;
        use std::sync::Arc;

        let dir = tempfile::tempdir().unwrap();
        let core = test_core(dir.path(), Arc::new(FakeRunner::new(vec![])), ready());
        let at = super::super::models::now();
        {
            let mut r = core.repo().unwrap();
            save(
                &mut r,
                &Seen {
                    since: at - 2 * NEW_FOR,
                    automations: at - 3_600,
                    meetings: BTreeMap::new(),
                },
                at,
            )
            .unwrap();
            let mut settings = r.settings().unwrap();
            settings.menu_bar.automations = true;
            r.settings_update(&settings).unwrap();
            r.put_record(&automation("auto-brief", "Morning brief", true))
                .unwrap();
            // Four results since the mark, one before it, one older than 7 days.
            for (n, ago) in [60, 600, 1_200, 1_800, 7_200, NEW_FOR + 60]
                .into_iter()
                .enumerate()
            {
                let mut run = automation_run(&format!("run-{n}"), "ok", vec!["today"], at - ago);
                run.data["automationId"] = "auto-brief".into();
                run.data["startedAt"] = (at - ago - 5).into();
                r.put_record(&run).unwrap();
            }
        }
        let shown = core.repo().unwrap().snapshot().unwrap();
        let runs = shown
            .records
            .iter()
            .filter(|r| r.kind == "automation_run")
            .count();
        assert!(
            runs < 4,
            "the snapshot keeps fewer runs ({runs}) than results"
        );

        let v = core
            .request(read_snapshot(Operation::Snapshot))
            .await
            .unwrap();
        let menu = &v["snapshot"]["menuBar"];
        assert_eq!(menu["sources"]["automations"], 4, "{menu}");
        assert_eq!(menu["count"], 4, "{menu}");
    }

    /// A test core at a fixed clock: the account (Taylor Morgan) signed in with mail, chats and
    /// the calendar, nothing seen since an hour before `FIXTURE_NOW`.
    const FIXTURE_NOW: i64 = 1_795_003_600;
    const FIXTURE_ACCT: &str = "acct-1";

    fn fixture_core(dir: &std::path::Path) -> std::sync::Arc<crate::workspace::Core> {
        use crate::ai::fake::FakeRunner;
        use crate::workspace::ai::tests::ready;
        use crate::workspace::test_core;
        let core = test_core(dir, std::sync::Arc::new(FakeRunner::new(vec![])), ready());
        {
            let mut r = core.repo().unwrap();
            r.save_connection(&Connection {
                id: FIXTURE_ACCT.into(),
                account_key: FIXTURE_ACCT.into(),
                display_name: "Taylor Morgan".into(),
                email: "taylor@example.test".into(),
                user_id: "me-1".into(),
                generation: 1,
                policy_revision: 1,
                scopes: vec![
                    "Mail.Read".into(),
                    "Chat.Read".into(),
                    "Calendars.Read".into(),
                ],
                enabled: vec!["mail".into(), "chats".into(), "calendar".into()],
                status: "connected".into(),
                ..Default::default()
            })
            .unwrap();
            let mut settings = r.settings().unwrap();
            settings.active_connection = Some(FIXTURE_ACCT.into());
            settings.time_zone = "Europe/Vilnius".into();
            r.settings_update(&settings).unwrap();
            let mut w = r.workspace(PERSONAL).unwrap();
            w.connection_id = Some(FIXTURE_ACCT.into());
            w.sources = json!({"all": true});
            r.save_workspace(&w).unwrap();
            save(
                &mut r,
                &Seen {
                    since: FIXTURE_NOW - 3_600,
                    automations: 0,
                    meetings: BTreeMap::new(),
                },
                FIXTURE_NOW,
            )
            .unwrap();
        }
        core
    }

    fn inbound(id: &str, conversation: Option<&str>, at: i64) -> Record {
        let (channel, source) = match conversation {
            Some(_) => ("chat", "chat:19:c1@thread.v2"),
            None => ("mail", "mail:inbox"),
        };
        Record {
            id: id.into(),
            kind: "message".into(),
            connection_id: Some(FIXTURE_ACCT.into()),
            workspace_id: None,
            source: source.into(),
            revision: "v1".into(),
            updated_at: at,
            // A direct question with no later reply: Inbox triage puts it in Needs reply.
            data: json!({"lane": "reply", "channel": channel, "conversationId": conversation,
                "title": format!("Can you send the plan ({id})?"), "mentionsMe": true, "at": at,
                "from": {"name": "Jordan Lee", "address": "jordan@example.test"}}),
        }
    }

    /// Two replies (a mail and a chat of two messages), a task due today, a meeting with new
    /// notes and two automation results.
    fn fill(core: &crate::workspace::Core) {
        let mut r = core.repo().unwrap();
        let at = FIXTURE_NOW - 600;
        for rec in [
            inbound("mail-1", None, at),
            inbound("chat-1", Some("c1"), at),
            inbound("chat-2", Some("c1"), at + 1),
        ] {
            r.put_record(&rec).unwrap();
        }
        let mut t = task(
            "task-1",
            json!({"text": "Send the pilot plan", "owner": "taylor@example.test",
                "due": day_key("Europe/Vilnius", FIXTURE_NOW)}),
        );
        t.updated_at = at;
        r.put_record(&t).unwrap();
        r.put_record(&Record {
            id: "m-ready".into(),
            kind: super::super::meetings::model::KIND.into(),
            connection_id: Some(FIXTURE_ACCT.into()),
            workspace_id: None,
            source: "calendar:cal-1".into(),
            revision: "v1".into(),
            updated_at: at,
            data: json!({"eventId": "m-ready", "title": "Pilot sync", "start": "", "end": "",
                "docs": [{"id": "meeting-notes", "updatedAt": at}]}),
        })
        .unwrap();
        r.put_record(&automation("auto-brief", "Morning brief", true))
            .unwrap();
        for (id, ago) in [("run-1", 1_200), ("run-2", 300)] {
            let mut run = automation_run(id, "ok", vec!["today"], FIXTURE_NOW - ago);
            run.data["automationId"] = "auto-brief".into();
            run.data["startedAt"] = (FIXTURE_NOW - ago - 5).into();
            r.put_record(&run).unwrap();
        }
    }

    fn choose(core: &crate::workspace::Core, chosen: [bool; 4]) {
        let mut r = core.repo().unwrap();
        let mut settings = r.settings().unwrap();
        settings.menu_bar = MenuBarSettings {
            replies: chosen[0],
            tasks: chosen[1],
            meetings: chosen[2],
            automations: chosen[3],
        };
        r.settings_update(&settings).unwrap();
    }

    fn state(core: &crate::workspace::Core, task_provider: Value) -> Value {
        let r = core.repo().unwrap();
        let mut s = r.snapshot().unwrap();
        let me = MeAlias::of(s.connection.as_ref().unwrap());
        serde_json::to_value(read(&r, &mut s, &task_provider, &me, FIXTURE_NOW).unwrap()).unwrap()
    }

    /// The snapshot's `menuBar` in each state the window draws, and the Inbox cases the UI's
    /// reply count is checked against. Regenerate with
    /// `UPDATE_CONTRACT_FIXTURES=1 cargo test contract_fixtures`.
    #[tokio::test]
    async fn contract_fixtures_match_the_menu_bar() {
        use crate::plugins::testkit::contract_fixture;
        let local = json!({"active": "local", "name": "Connect", "state": "local", "parked": 0});
        let todoist = |state: &str, parked: u64| json!({"active": "plugin:todoist", "name": "Todoist", "state": state, "parked": parked});

        let empty_dir = tempfile::tempdir().unwrap();
        let empty = fixture_core(empty_dir.path());
        let zero = state(&empty, local.clone());
        let amber_only = state(&empty, todoist("needs_token", 0));

        let dir = tempfile::tempdir().unwrap();
        let core = fixture_core(dir.path());
        fill(&core);
        let replies = state(&core, local.clone());
        let amber_with_count = state(&core, todoist("needs_token", 0));
        choose(&core, [true, true, true, true]);
        let several = state(&core, todoist("ready", 0));
        choose(&core, [false, false, false, false]);
        let nothing_chosen = state(&core, local.clone());

        let capped_dir = tempfile::tempdir().unwrap();
        let capped_core = fixture_core(capped_dir.path());
        {
            let mut r = capped_core.repo().unwrap();
            for n in 0..120 {
                r.put_record(&inbound(&format!("mail-{n}"), None, FIXTURE_NOW - 600 - n))
                    .unwrap();
            }
        }
        let capped = state(&capped_core, local);

        assert_eq!(zero["label"], "");
        assert_eq!(replies["count"], 2, "{replies}");
        assert_eq!(
            several["sources"],
            json!({"replies": 2, "tasks": 1, "meetings": 1, "automations": 2}),
            "{several}"
        );
        assert_eq!(several["count"], 6);
        assert_eq!(capped["label"], "99+");
        assert_eq!(
            (amber_only["amber"].clone(), amber_only["count"].clone()),
            (json!(true), json!(0))
        );
        assert_eq!(amber_with_count["count"], 2);
        assert_eq!(amber_with_count["amber"], true);
        assert_eq!(nothing_chosen["count"], 0);
        assert_eq!(nothing_chosen["label"], "");

        contract_fixture(
            "menu-bar-states.json",
            &json!({
                "zero": zero,
                "replies": replies,
                "several": several,
                "capped": capped,
                "amberOnly": amber_only,
                "amberWithCount": amber_with_count,
                "nothingChosen": nothing_chosen,
            }),
        );
        let records = inbox_cases();
        let count = attention_rows(&records, FIXTURE_NOW);
        contract_fixture(
            "menu-bar-reply-cases.json",
            &json!({"records": records, "replies": count}),
        );
    }

    fn states() -> BTreeMap<String, MenuBar> {
        let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../ui/test/fixtures/contract/menu-bar-states.json");
        serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap()
    }

    #[test]
    fn tray_view_for_each_state() {
        let states = states();
        let zero = tray_view(&states["zero"]);
        assert_eq!(
            zero,
            TrayView {
                title: None,
                amber: false,
                tooltip: "CodeMie Connect".into(),
                rows: Vec::new(),
            }
        );

        let replies = tray_view(&states["replies"]);
        assert_eq!(replies.title.as_deref(), Some("2"));
        assert!(!replies.amber);
        assert_eq!(
            replies.rows,
            vec![TrayRow {
                id: "mb:replies".into(),
                text: "2 messages need a reply".into(),
                open: json!({"route": "inbox", "lane": "reply"}),
            }]
        );

        assert_eq!(tray_view(&states["capped"]).title.as_deref(), Some("99+"));
        assert_eq!(tray_view(&states["nothingChosen"]).title, None);

        let amber_only = tray_view(&states["amberOnly"]);
        assert_eq!(amber_only.title, None);
        assert!(amber_only.amber);
        assert_eq!(amber_only.rows.len(), 1);
        assert_eq!(amber_only.rows[0].id, "mb:tasks-token");
        assert_eq!(amber_only.rows[0].text, "Todoist needs your API token.");
        assert_eq!(
            amber_only.rows[0].open,
            json!({"route": "settings", "tab": "meetings-tasks"})
        );
        assert!(amber_only.tooltip.contains("Needs fixing: "));

        let with_count = tray_view(&states["amberWithCount"]);
        assert_eq!(
            (with_count.title.as_deref(), with_count.amber),
            (Some("2"), true)
        );

        // "several": one new meeting opens that meeting; two open Meetings.
        let several = tray_view(&states["several"]);
        let ids: Vec<&str> = several.rows.iter().map(|r| r.id.as_str()).collect();
        assert_eq!(
            ids,
            ["mb:replies", "mb:tasks", "mb:meetings", "mb:automations"]
        );
        let open_of =
            |v: &TrayView, id: &str| v.rows.iter().find(|r| r.id == id).unwrap().open.clone();
        assert_eq!(open_of(&several, "mb:tasks"), json!({"route": "tasks"}));
        assert_eq!(
            open_of(&several, "mb:meetings"),
            json!({"meetingId": "m-ready"})
        );
        assert_eq!(
            open_of(&several, "mb:automations"),
            json!({"route": "automations"})
        );
        let mut two = states["several"].clone();
        two.sources.meetings = 2;
        two.new_meetings.push("m-other".into());
        assert_eq!(
            open_of(&tray_view(&two), "mb:meetings"),
            json!({"route": "meetings"})
        );

        // Beyond three fixes, "and <n> more" opens the card that lists them all.
        let mut many = states["zero"].clone();
        many.amber = true;
        many.fixes = (0..5).map(|n| fix(&format!("f{n}"), "Broken.")).collect();
        let view = tray_view(&many);
        assert_eq!(view.rows.len(), 4);
        assert_eq!(view.rows[3].text, "and 2 more");
        assert_eq!(
            view.rows[3].open,
            json!({"route": "settings", "tab": "notifications"})
        );

        assert_eq!(
            open_payload(&json!({"route": "inbox", "lane": "reply"})),
            json!({"route": "inbox", "lane": "reply", "workspaceId": "personal"})
        );
    }

    #[test]
    fn amber_keeps_alpha() {
        assert_eq!(
            amber_rgba(&[0, 0, 0, 0, 0, 0, 0, 128, 0, 0, 0, 255]),
            vec![245, 166, 35, 0, 245, 166, 35, 128, 245, 166, 35, 255]
        );
    }

    fn fixture_now() -> i64 {
        FIXTURE_NOW
    }

    /// Waits up to `ms` for the fake tray to hold `n` views.
    async fn applied_within(core: &crate::workspace::Core, n: usize, ms: u64) -> Vec<TrayView> {
        let deadline = std::time::Instant::now() + std::time::Duration::from_millis(ms);
        loop {
            let applied = core.menu_bar.fake().applied();
            if applied.len() >= n || std::time::Instant::now() >= deadline {
                return applied;
            }
            tokio::time::sleep(std::time::Duration::from_millis(20)).await;
        }
    }

    #[tokio::test]
    async fn refresh_applies_only_when_the_view_changes() {
        let dir = tempfile::tempdir().unwrap();
        let core = fixture_core(dir.path());
        core.menu_bar.set_clock(fixture_now);
        let first = core.refresh_menu_bar_now().unwrap();
        assert_eq!(first.title, None);
        core.refresh_menu_bar_now().unwrap();
        assert_eq!(core.menu_bar.fake().applied().len(), 1);

        core.repo()
            .unwrap()
            .put_record(&inbound("mail-1", None, FIXTURE_NOW - 60))
            .unwrap();
        let second = core.refresh_menu_bar_now().unwrap();
        let applied = core.menu_bar.fake().applied();
        assert_eq!(applied.len(), 2);
        assert_eq!(applied[1].title.as_deref(), Some("1"));
        assert_eq!(second, applied[1]);
        assert_eq!(core.menu_bar.last(), Some(second));
    }

    #[tokio::test]
    async fn a_burst_of_changes_applies_once() {
        let dir = tempfile::tempdir().unwrap();
        let core = fixture_core(dir.path());
        core.menu_bar.set_clock(fixture_now);
        core.start_menu_bar();
        // It runs once at start.
        assert_eq!(applied_within(&core, 1, 2_000).await.len(), 1);

        // Forty writes, each changing the count, then the forty events a sync round emits for
        // them; the events come well inside the debounce whatever the machine's load (the
        // writes before them take no part in the timing).
        for n in 0..40 {
            core.repo()
                .unwrap()
                .put_record(&inbound(&format!("mail-{n}"), None, FIXTURE_NOW - 60 - n))
                .unwrap();
        }
        let at = std::time::Instant::now();
        for _ in 0..40 {
            core.emit("workspace:changed");
        }
        let burst = at.elapsed();
        tokio::time::sleep(std::time::Duration::from_millis(600)).await;
        let applied = core.menu_bar.fake().applied();
        assert_eq!(applied.len(), 2, "burst took {burst:?}: {applied:?}");
        assert_eq!(applied[1].title.as_deref(), Some("40"));
        core.stop_background();
    }

    #[tokio::test]
    async fn emit_under_a_repository_guard_does_not_block() {
        let dir = tempfile::tempdir().unwrap();
        let core = fixture_core(dir.path());
        core.menu_bar.set_clock(fixture_now);
        core.start_menu_bar();
        assert_eq!(applied_within(&core, 1, 2_000).await.len(), 1);

        {
            let mut g = core.repo().unwrap();
            g.put_record(&inbound("mail-1", None, FIXTURE_NOW - 60))
                .unwrap();
            let at = std::time::Instant::now();
            core.emit("workspace:changed");
            assert!(at.elapsed() < std::time::Duration::from_millis(50));
        }
        let applied = applied_within(&core, 2, 2_000).await;
        assert_eq!(applied.len(), 2);
        assert_eq!(applied[1].title.as_deref(), Some("1"));
        core.stop_background();
    }

    /// I1: a finished plugin reload recounts too, not only `workspace:changed` — the task
    /// plugin may have gone from "still loading" to ready (or to a genuine failure) without any
    /// workspace record changing.
    #[tokio::test]
    async fn a_finished_plugin_reload_also_recounts() {
        let dir = tempfile::tempdir().unwrap();
        let core = fixture_core(dir.path());
        core.menu_bar.set_clock(fixture_now);
        core.start_menu_bar();
        assert_eq!(applied_within(&core, 1, 2_000).await.len(), 1);

        core.repo()
            .unwrap()
            .put_record(&inbound("mail-1", None, FIXTURE_NOW - 60))
            .unwrap();
        core.emit("plugins:reloaded");
        let applied = applied_within(&core, 2, 2_000).await;
        assert_eq!(applied.len(), 2);
        assert_eq!(applied[1].title.as_deref(), Some("1"));
        core.stop_background();
    }

    static MIDNIGHT_CLOCK: std::sync::atomic::AtomicI64 = std::sync::atomic::AtomicI64::new(0);
    fn midnight_clock() -> i64 {
        MIDNIGHT_CLOCK.load(std::sync::atomic::Ordering::SeqCst)
    }

    #[tokio::test]
    async fn the_minute_emit_recounts_after_midnight() {
        use chrono::TimeZone;
        let tz: chrono_tz::Tz = "Europe/Vilnius".parse().unwrap();
        let day = chrono::DateTime::from_timestamp(FIXTURE_NOW, 0)
            .unwrap()
            .with_timezone(&tz)
            .date_naive()
            .succ_opt()
            .unwrap();
        let midnight = tz
            .from_local_datetime(&day.and_hms_opt(0, 0, 0).unwrap())
            .single()
            .unwrap()
            .timestamp();

        let dir = tempfile::tempdir().unwrap();
        let core = fixture_core(dir.path());
        choose(&core, [false, true, false, false]);
        core.repo()
            .unwrap()
            .put_record(&task(
                "task-tomorrow",
                json!({"text": "Send the plan", "owner": "taylor@example.test",
                    "due": day.format("%Y-%m-%d").to_string()}),
            ))
            .unwrap();
        MIDNIGHT_CLOCK.store(midnight - 30, std::sync::atomic::Ordering::SeqCst);
        core.menu_bar.set_clock(midnight_clock);
        core.start_menu_bar();
        let applied = applied_within(&core, 1, 2_000).await;
        assert_eq!(applied.len(), 1);
        assert_eq!(applied[0].title, None);

        MIDNIGHT_CLOCK.store(midnight + 30, std::sync::atomic::Ordering::SeqCst);
        // The background loop's minute emit; no snapshot is asked for.
        core.emit("workspace:changed");
        let applied = applied_within(&core, 2, 2_000).await;
        assert_eq!(applied.len(), 2);
        assert_eq!(applied[1].title.as_deref(), Some("1"));
        assert_eq!(applied[1].rows[0].text, "1 task due or late");
        core.stop_background();
    }

    /// Two counts at once (the loop and a forced refresh) set the tray one after the other, and
    /// the tray ends on the view `last` holds.
    #[tokio::test]
    async fn concurrent_refreshes_apply_one_at_a_time() {
        let dir = tempfile::tempdir().unwrap();
        let core = fixture_core(dir.path());
        core.menu_bar.set_clock(fixture_now);
        core.menu_bar.fake().set_slow(200);
        let first = {
            let core = core.clone();
            std::thread::spawn(move || core.refresh_menu_bar_now().unwrap())
        };
        core.menu_bar.fake().wait_until_applying();
        core.repo()
            .unwrap()
            .put_record(&inbound("mail-1", None, FIXTURE_NOW - 60))
            .unwrap();
        let second = {
            let core = core.clone();
            std::thread::spawn(move || core.refresh_menu_bar_now().unwrap())
        };
        first.join().unwrap();
        second.join().unwrap();
        let fake = core.menu_bar.fake();
        assert!(!fake.overlapped(), "two applies ran at once");
        let applied = fake.applied();
        assert_eq!(applied.len(), 2, "{applied:?}");
        assert_eq!(applied.last().cloned(), core.menu_bar.last());
        assert_eq!(applied[1].title.as_deref(), Some("1"));
    }

    fn view(title: &str, amber: bool) -> TrayView {
        TrayView {
            title: (!title.is_empty()).then(|| title.to_string()),
            amber,
            tooltip: format!("CodeMie Connect ({title})"),
            rows: Vec::new(),
        }
    }

    /// `install` records the calling thread; a thread recorded that way is "the main thread"
    /// for the guard below, exactly how `setup_tray` makes the real main thread the one that
    /// matters (ruling: make the tray/loop deadlock impossible).
    #[test]
    fn offer_on_the_main_thread_never_waits_for_a_busy_apply() {
        let refresher = std::sync::Arc::new(Refresher::new(fixture_now));
        refresher.install_fake(); // this test thread is now "the main thread"
        refresher.fake().set_slow(200);

        let busy = view("1", false);
        let worker = {
            let refresher = refresher.clone();
            let busy = busy.clone();
            std::thread::spawn(move || refresher.offer(&busy))
        };
        // The worker holds `applying` and is in its slow apply.
        refresher.fake().wait_until_applying();

        let main_view = view("2", false);
        let started = std::time::Instant::now();
        refresher.offer(&main_view); // on the recorded main thread
        assert!(
            started.elapsed() < std::time::Duration::from_millis(100),
            "the main thread waited on a busy apply instead of backing off"
        );

        worker.join().unwrap();
        // Only the worker's view was applied; the main thread's offer backed off rather than
        // overlapping or waiting, so the tray still shows what the worker applied.
        assert_eq!(refresher.fake().applied(), vec![busy.clone()]);
        assert_eq!(refresher.last(), Some(busy));
        assert!(!refresher.fake().overlapped());
        // It asked for a recount instead of applying `main_view` itself.
        let woken = tokio::runtime::Builder::new_current_thread()
            .enable_time()
            .build()
            .unwrap()
            .block_on(async {
                tokio::time::timeout(
                    std::time::Duration::from_millis(50),
                    refresher.notify.notified(),
                )
                .await
                .is_ok()
            });
        assert!(
            woken,
            "a busy apply on the main thread should wake the loop"
        );
    }
}
