//! Test doubles shared by the crate's unit tests and the tests in `tests/` (the plugin conformance
//! tests, `tests/echo_plugins.rs`), which can't see `#[cfg(test)]` items: a scripted Claude, a
//! `Core` over a temp folder, a ready Claude Code profile, stand-ins for what plugins reach
//! outside Connect (the folder picker, the GitHub CLI, Todoist), and a way to run the workspace's
//! operations and task sync from outside the crate. Built only for tests and with the
//! `test-support` feature, which only the crate's own dev-dependency turns on.
use crate::ai::command::{build_command, RunSpec};
use crate::ai::profiles::{AccountInfo, AiProfile, ModelChoice, ProfileKind, ProfileState};
use crate::ai::stream::{AiError, RunOutcome, Usage};
use crate::plugins::services::signin::SignInSource;
use crate::plugins::services::FolderPicker;
use crate::workspace::models::{Connection, Record};
use futures_util::future::BoxFuture;
use serde_json::{json, Value};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};

pub use crate::ai::fake::{FakeRunner, Gate};
pub use crate::plugins::services::http::{Client as HttpClient, Recorded};
pub use crate::workspace::analytics::cli::{FakeAnalyticsCli, FakeCall};
pub use crate::workspace::Core;

/// A ready Claude Code profile on the user's own subscription.
pub fn claude_profile() -> AiProfile {
    AiProfile {
        id: "claude".into(),
        kind: ProfileKind::Native,
        provider: None,
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
        local: None,
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
pub struct Picked(
    pub Mutex<Option<PathBuf>>,
    pub Mutex<Vec<PathBuf>>,
    /// What the user types in the address box next.
    pub Mutex<Option<String>>,
);

impl Picked {
    /// The folder the user picks next.
    pub fn next(&self, folder: &Path) {
        *self.0.lock().unwrap() = Some(folder.to_path_buf());
    }

    /// The files the user picks next.
    pub fn next_files(&self, files: &[&Path]) {
        *self.1.lock().unwrap() = files.iter().map(|f| f.to_path_buf()).collect();
    }
}

impl FolderPicker for Picked {
    fn pick(&self, _title: String) -> BoxFuture<'static, Option<PathBuf>> {
        let picked = self.0.lock().unwrap().take();
        Box::pin(async move { picked })
    }

    fn pick_files(
        &self,
        _title: String,
        _multiple: bool,
        _exts: Vec<String>,
    ) -> BoxFuture<'static, Vec<PathBuf>> {
        let picked = std::mem::take(&mut *self.1.lock().unwrap());
        Box::pin(async move { picked })
    }

    fn ask_address(&self, _name: String) -> BoxFuture<'static, Option<String>> {
        let typed = self.2.lock().unwrap().take();
        Box::pin(async move { typed })
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

/// The Microsoft account the meeting helpers sign in.
const ACCOUNT: &str = "acct";

/// A signed-in Microsoft account bound to the personal workspace, every source shown (the AI
/// profile the user chose is kept).
pub fn signed_in(core: &Core) {
    let mut r = core.repo().unwrap();
    r.save_connection(&Connection {
        id: ACCOUNT.into(),
        account_key: ACCOUNT.into(),
        display_name: "Taylor Reed".into(),
        email: "taylor@example.test".into(),
        user_id: "me-1".into(),
        generation: 1,
        policy_revision: 1,
        scopes: vec![
            "Calendars.Read".into(),
            "Mail.Read".into(),
            "Chat.Read".into(),
        ],
        enabled: vec!["calendar".into(), "mail".into(), "chats".into()],
        status: "connected".into(),
        ..Default::default()
    })
    .unwrap();
    let mut s = r.settings().unwrap();
    s.active_connection = Some(ACCOUNT.into());
    r.settings_update(&s).unwrap();
    let mut w = r.workspace("personal").unwrap();
    w.connection_id = Some(ACCOUNT.into());
    w.sources = json!({"all": true});
    r.save_workspace(&w).unwrap();
}

/// A Teams meeting `id` the account synced (from `start` to `end`, RFC 3339), its transcript and
/// main notes (`notes`, Markdown) saved by Connect in `folder`: what Meetings shows, and plugins
/// read as Echo's call `call:<folder's name>`.
pub fn saved_meeting(
    core: &Core,
    id: &str,
    title: &str,
    (start, end): (&str, &str),
    folder: &Path,
    notes: &str,
) {
    std::fs::create_dir_all(folder).unwrap();
    std::fs::write(
        folder.join("transcript.md"),
        "**Ann Lee:** We ship in May.\n",
    )
    .unwrap();
    std::fs::write(folder.join("notes.md"), notes).unwrap();
    let record = |kind: &str, data: Value| Record {
        id: id.into(),
        kind: kind.into(),
        connection_id: Some(ACCOUNT.into()),
        workspace_id: None,
        source: "calendar:cal-1".into(),
        revision: "v1".into(),
        updated_at: 1_795_000_000,
        data,
    };
    let mut r = core.repo().unwrap();
    r.put_record(&record(
        "event",
        json!({
            "title": title, "start": start, "end": end,
            "organizer": {"name": "Ann Lee", "address": "ann@example.test"},
            "attendees": [{"name": "Taylor Reed", "address": "taylor@example.test"}],
        }),
    ))
    .unwrap();
    r.put_record(&record("meeting", json!({
        "title": title, "start": start, "end": end, "folder": folder.display().to_string(),
        "state": "ready", "main": "meeting-notes",
        "docs": [{"id": "meeting-notes", "file": "notes.md", "name": "Meeting notes", "version": 1}],
    })))
    .unwrap();
}

/// Connect wrote meeting `id`'s main notes (`rewritten`: over earlier ones): plugins hear
/// `minutes_written`, as after a notes run.
pub fn minutes_written(core: &Core, id: &str, rewritten: bool) {
    core.tell_minutes_written(id, rewritten);
}

// ------------------------------------------------------------------ task providers

/// Runs the workspace operation `op` (its wire name, `task_save`, `task_provider_set`, …) on the
/// personal workspace as the window sends it: with an operation id and the current revision.
pub async fn workspace_op(core: &Arc<Core>, op: &str, data: Value) -> Result<Value, String> {
    let fail = |e: crate::workspace::models::WorkspaceError| format!("{}: {}", e.code, e.message);
    let op = serde_json::from_value(json!(op)).map_err(|e| format!("{op}: {e}"))?;
    let revision = core.repo().and_then(|r| r.revision()).map_err(fail)?;
    let req = crate::workspace::models::Request {
        op,
        workspace_id: Some("personal".into()),
        expected_revision: Some(revision),
        operation_id: Some(crate::workspace::models::id()),
        data,
    };
    core.request(req).await.map_err(fail)
}

/// One `task_sync` run with the active provider at `at` (seconds), as the job runs it: answers its
/// summary (`Tasks <state>: …`).
pub async fn task_sync(core: &Arc<Core>, at: i64) -> String {
    let provider = core.repo().unwrap().settings().unwrap().tasks.provider;
    crate::workspace::task_provider::sync::run(core, &provider, at)
        .await
        .unwrap()
        .summary()
}

/// The snapshot's `taskProvider`: the active provider, every available one, its state.
pub fn task_provider(core: &Core) -> Value {
    let settings = core.repo().unwrap().settings().unwrap();
    core.task_provider_snapshot(&settings)
}

/// A Todoist on loopback for the tests that run the real Todoist plugin (`tests/
/// connect_marketplace.rs`): the endpoints of the marketplace's `tests/helpers/fake-todoist.mjs`
/// (`GET /user`, `GET|POST /projects`, `GET|POST /tasks`, `GET|POST /tasks/{id}`,
/// `/tasks/{id}/close` and `/reopen`, `DELETE /tasks/{id}`, `POST /sync` with sync tokens) under
/// `/api/v1`, a bearer-token check, a request log, failures by route (`fail_once`) and a lost
/// answer (`lose_once`: the work is done, then the connection closes unanswered). Each connection
/// is served on its own thread until the test ends; give its `base` to `HttpClient::for_tests` as
/// `api.todoist.com`.
pub struct FakeTodoist {
    base: String,
    state: Arc<Mutex<TodoistState>>,
}

#[derive(Default)]
struct TodoistState {
    token: String,
    projects: Vec<Value>,
    /// Every task ever made, in order: `(revision, deleted, Todoist's task)`.
    tasks: Vec<(u64, bool, Value)>,
    next_id: u64,
    rev: u64,
    requests: Vec<String>,
    /// `METHOD /path` -> `(status, Retry-After)`, once.
    fail: std::collections::HashMap<String, (u16, Option<u64>)>,
    lose: std::collections::HashSet<String>,
}

/// An answer: status, extra header lines and a JSON body; `None` closes the connection unanswered.
type Answer = Option<(u16, String, String)>;

fn todoist_time() -> String {
    chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Secs, true)
}

impl TodoistState {
    fn bump(&mut self) -> u64 {
        self.rev += 1;
        self.rev
    }

    fn new_id(&mut self) -> String {
        self.next_id += 1;
        (8000 + self.next_id).to_string()
    }

    fn task_mut(&mut self, id: &str) -> Option<&mut (u64, bool, Value)> {
        self.tasks
            .iter_mut()
            .find(|(_, deleted, t)| !deleted && t["id"] == id)
    }

    fn answer(&mut self, method: &str, target: &str, auth: &str, body: &str) -> Answer {
        let (path, query) = target.split_once('?').unwrap_or((target, ""));
        let path = path.strip_prefix("/api/v1").unwrap_or(path).to_string();
        let route = format!("{method} {path}");
        self.requests.push(format!(
            "{method} {path}{}",
            if query.is_empty() {
                String::new()
            } else {
                format!("?{query}")
            }
        ));
        let ok = |v: Value| Some((200, String::new(), v.to_string()));
        let status = |code: u16| Some((code, String::new(), json!({"error": "test"}).to_string()));
        if auth != format!("Bearer {}", self.token) {
            return Some((
                401,
                String::new(),
                json!({"error": "Invalid token"}).to_string(),
            ));
        }
        if let Some((code, retry)) = self.fail.remove(&route) {
            // As Todoist: `retry_after` in the body, and here in `Retry-After` too.
            let extra = retry.map_or(String::new(), |s| format!("Retry-After: {s}\r\n"));
            let mut body = json!({"error": "forced failure (test)"});
            if let Some(s) = retry {
                body["error_extra"] = json!({"retry_after": s});
            }
            return Some((code, extra, body.to_string()));
        }
        let lost = self.lose.remove(&route);
        let query: std::collections::HashMap<String, String> =
            url::form_urlencoded::parse(query.as_bytes())
                .into_owned()
                .collect();
        let data: Value = if path == "/sync" && !body.trim_start().starts_with('{') {
            let form: serde_json::Map<String, Value> = url::form_urlencoded::parse(body.as_bytes())
                .into_owned()
                .map(|(k, v)| (k, Value::String(v)))
                .collect();
            Value::Object(form)
        } else {
            serde_json::from_str(body).unwrap_or(json!({}))
        };
        let now = todoist_time();
        let task_route = path.strip_prefix("/tasks/").map(|rest| {
            let (id, action) = rest.split_once('/').unwrap_or((rest, ""));
            (id.to_string(), action.to_string())
        });
        let answer = match (method, path.as_str(), task_route) {
            ("GET", "/user", _) => ok(
                json!({"id": "u1", "email": "taylor@example.test", "full_name": "Taylor Morgan"}),
            ),
            ("GET", "/projects", _) => ok(json!({"results": self.projects, "next_cursor": null})),
            // Todoist allows two projects of one name.
            ("POST", "/projects", _) => {
                let p = json!({"id": self.new_id(), "name": data["name"], "is_archived": false});
                self.projects.push(p.clone());
                ok(p)
            }
            ("GET", p, _) if p.starts_with("/projects/") => {
                let id = &p["/projects/".len()..];
                match self.projects.iter().find(|p| p["id"] == id) {
                    Some(p) => ok(p.clone()),
                    None => status(404),
                }
            }
            ("GET", "/tasks", _) => {
                let project = query.get("project_id");
                let open: Vec<Value> = self
                    .tasks
                    .iter()
                    .filter(|(_, deleted, t)| {
                        !deleted
                            && t["checked"] != true
                            && project.is_none_or(|p| t["project_id"] == p.as_str())
                    })
                    .map(|(_, _, t)| t.clone())
                    .collect();
                ok(json!({"results": open, "next_cursor": null}))
            }
            ("POST", "/tasks", _) => {
                let due = match (data["due_date"].as_str(), data["due_string"].as_str()) {
                    (Some(d), _) => json!({"date": d, "string": d, "is_recurring": false}),
                    _ => Value::Null,
                };
                let task = json!({
                    "id": self.new_id(), "content": data["content"],
                    "description": data["description"].as_str().unwrap_or(""),
                    "project_id": data["project_id"], "labels": data["labels"].as_array().cloned().unwrap_or_default(),
                    "priority": 1, "checked": false, "is_deleted": false, "due": due,
                    "added_at": now, "updated_at": now,
                });
                let rev = self.bump();
                self.tasks.push((rev, false, task.clone()));
                ok(task)
            }
            ("POST", "/sync", _) => {
                let since: u64 = data["sync_token"]
                    .as_str()
                    .and_then(|t| t.parse().ok())
                    .unwrap_or(0);
                let items: Vec<Value> = self
                    .tasks
                    .iter()
                    // A full sync lists open tasks only.
                    .filter(|(rev, deleted, t)| {
                        *rev > since && (since > 0 || (!deleted && t["checked"] != true))
                    })
                    .map(|(_, deleted, t)| {
                        let mut t = t.clone();
                        t["is_deleted"] = (*deleted).into();
                        t
                    })
                    .collect();
                ok(
                    json!({"sync_token": self.rev.to_string(), "full_sync": since == 0, "items": items}),
                )
            }
            (_, _, Some((id, action))) => {
                // Only a change moves the sync revision.
                let rev = self.rev + 1;
                let mut changed = false;
                let answer = match self.task_mut(&id) {
                    None => status(404),
                    // A completed task can't be read (as REST v2 did; v1 is unconfirmed).
                    Some((_, _, t))
                        if method == "GET" && action.is_empty() && t["checked"] == true =>
                    {
                        status(404)
                    }
                    Some((_, _, t)) if method == "GET" && action.is_empty() => ok(t.clone()),
                    Some(entry) if method == "DELETE" && action.is_empty() => {
                        changed = true;
                        entry.0 = rev;
                        entry.1 = true;
                        entry.2["updated_at"] = now.into();
                        Some((204, String::new(), String::new()))
                    }
                    Some(entry) if method == "POST" => {
                        let t = &mut entry.2;
                        match action.as_str() {
                            "close" => t["checked"] = true.into(),
                            "reopen" => t["checked"] = false.into(),
                            "" => {
                                for k in ["content", "description", "labels", "priority"] {
                                    if !data[k].is_null() {
                                        t[k] = data[k].clone();
                                    }
                                }
                                if let Some(d) = data["due_date"].as_str() {
                                    t["due"] =
                                        json!({"date": d, "string": d, "is_recurring": false});
                                }
                                if data["due_string"].is_string() {
                                    t["due"] = Value::Null;
                                }
                            }
                            _ => return status(404),
                        }
                        t["updated_at"] = now.into();
                        entry.0 = rev;
                        changed = true;
                        if action.is_empty() {
                            ok(entry.2.clone())
                        } else {
                            Some((204, String::new(), String::new()))
                        }
                    }
                    Some(_) => status(404),
                };
                if changed {
                    self.rev = rev;
                }
                answer
            }
            _ => status(404),
        };
        if lost {
            None
        } else {
            answer
        }
    }
}

/// Reads one HTTP request from `stream`: its method, target, `Authorization` and body.
fn read_request(stream: &mut std::net::TcpStream) -> Option<(String, String, String, String)> {
    use std::io::Read as _;
    let mut buf = Vec::new();
    let mut chunk = [0u8; 8192];
    let head_end = loop {
        let n = stream.read(&mut chunk).ok()?;
        if n == 0 {
            return None;
        }
        buf.extend_from_slice(&chunk[..n]);
        if let Some(i) = buf.windows(4).position(|w| w == b"\r\n\r\n") {
            break i + 4;
        }
    };
    let head = String::from_utf8_lossy(&buf[..head_end]).to_string();
    let mut lines = head.lines();
    let mut first = lines.next()?.split_whitespace();
    let (method, target) = (first.next()?.to_string(), first.next()?.to_string());
    let header = |name: &str| {
        head.lines().find_map(|l| {
            let (k, v) = l.split_once(':')?;
            k.trim()
                .eq_ignore_ascii_case(name)
                .then(|| v.trim().to_string())
        })
    };
    let length: usize = header("content-length")
        .and_then(|v| v.parse().ok())
        .unwrap_or(0);
    while buf.len() < head_end + length {
        let n = stream.read(&mut chunk).ok()?;
        if n == 0 {
            break;
        }
        buf.extend_from_slice(&chunk[..n]);
    }
    let body = String::from_utf8_lossy(&buf[head_end..]).to_string();
    Some((
        method,
        target,
        header("authorization").unwrap_or_default(),
        body,
    ))
}

impl FakeTodoist {
    /// Starts it on loopback; it accepts `Bearer <token>` only.
    pub fn start(token: &str) -> FakeTodoist {
        use std::io::Write as _;
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let base = format!("http://{}", listener.local_addr().unwrap());
        let state = Arc::new(Mutex::new(TodoistState {
            token: token.into(),
            ..Default::default()
        }));
        let shared = state.clone();
        std::thread::spawn(move || {
            for stream in listener.incoming() {
                let Ok(mut stream) = stream else { continue };
                let state = shared.clone();
                std::thread::spawn(move || {
                    let Some((method, target, auth, body)) = read_request(&mut stream) else {
                        return;
                    };
                    let answer = state
                        .lock()
                        .unwrap_or_else(std::sync::PoisonError::into_inner)
                        .answer(&method, &target, &auth, &body);
                    // A lost answer: the connection closes with nothing said.
                    let Some((status, extra, body)) = answer else {
                        let _ = stream.shutdown(std::net::Shutdown::Both);
                        return;
                    };
                    let head = format!(
                        "HTTP/1.1 {status} X\r\nContent-Type: application/json\r\n{extra}Content-Length: {}\r\nConnection: close\r\n\r\n",
                        body.len()
                    );
                    let _ = stream.write_all(head.as_bytes());
                    let _ = stream.write_all(body.as_bytes());
                });
            }
        });
        FakeTodoist { base, state }
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, TodoistState> {
        self.state
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
    }

    /// Where it listens (`http://127.0.0.1:<port>`).
    pub fn base(&self) -> String {
        self.base.clone()
    }

    /// The tasks it holds (open and done; not the deleted ones), as Todoist answers them.
    pub fn tasks(&self) -> Vec<Value> {
        self.lock()
            .tasks
            .iter()
            .filter(|(_, deleted, _)| !deleted)
            .map(|(_, _, t)| t.clone())
            .collect()
    }

    /// A change made in Todoist itself: `fields` merged into task `id`.
    pub fn edit(&self, id: &str, fields: Value) {
        let mut s = self.lock();
        let rev = s.bump();
        let entry = s.task_mut(id).expect("a task Todoist holds");
        for (k, v) in fields.as_object().into_iter().flatten() {
            entry.2[k] = v.clone();
        }
        entry.2["updated_at"] = todoist_time().into();
        entry.0 = rev;
    }

    /// The next `METHOD /path` (e.g. `POST /sync`) answers `status`, with `Retry-After` when given.
    pub fn fail_once(&self, route: &str, status: u16, retry_after: Option<u64>) {
        self.lock().fail.insert(route.into(), (status, retry_after));
    }

    /// The next `METHOD /path` is done, but its connection closes unanswered.
    pub fn lose_once(&self, route: &str) {
        self.lock().lose.insert(route.into());
    }

    /// Every request so far, as `METHOD /path?query`.
    pub fn requests(&self) -> Vec<String> {
        self.lock().requests.clone()
    }
}

/// Every log line of the test process, kept once `capture_logs` installed the logger. The
/// process has one logger, so every test that reads log lines shares this one.
struct Capture;
static LOGGED: Mutex<Vec<String>> = Mutex::new(Vec::new());

impl log::Log for Capture {
    fn enabled(&self, _: &log::Metadata) -> bool {
        true
    }
    fn log(&self, record: &log::Record) {
        LOGGED
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .push(record.args().to_string());
    }
    fn flush(&self) {}
}

/// Installs the capturing logger (once per process) at `Info`.
pub fn capture_logs() {
    static ONCE: std::sync::Once = std::sync::Once::new();
    ONCE.call_once(|| {
        let _ = log::set_logger(&Capture);
        log::set_max_level(log::LevelFilter::Info);
    });
}

/// Every log line captured so far, in every test of the process.
pub fn logged_lines() -> Vec<String> {
    LOGGED
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
        .clone()
}

#[cfg(test)]
mod tests {
    use super::*;

    const TOKEN: &str = "tk_SENTINEL_do_not_log_0123456789";

    /// `METHOD path` with `body` to `fake`: status, headers and JSON body.
    async fn ask(
        fake: &FakeTodoist,
        method: &str,
        path: &str,
        body: Option<&str>,
    ) -> (u16, reqwest::header::HeaderMap, Value) {
        let client = reqwest::Client::builder().no_proxy().build().unwrap();
        let url = format!("{}/api/v1{path}", fake.base());
        let mut req = client
            .request(reqwest::Method::from_bytes(method.as_bytes()).unwrap(), url)
            .header("Authorization", format!("Bearer {TOKEN}"));
        if let Some(b) = body {
            req = req
                .header("Content-Type", "application/json")
                .body(b.to_string());
        }
        let res = req.send().await.unwrap();
        let status = res.status().as_u16();
        let headers = res.headers().clone();
        let text = res.text().await.unwrap();
        (
            status,
            headers,
            serde_json::from_str(&text).unwrap_or(Value::Null),
        )
    }

    async fn sync_token(fake: &FakeTodoist, token: &str) -> Value {
        let body = format!("sync_token={token}&resource_types=%5B%22items%22%5D");
        let client = reqwest::Client::builder().no_proxy().build().unwrap();
        let res = client
            .post(format!("{}/api/v1/sync", fake.base()))
            .header("Authorization", format!("Bearer {TOKEN}"))
            .header("Content-Type", "application/x-www-form-urlencoded")
            .body(body)
            .send()
            .await
            .unwrap();
        serde_json::from_str(&res.text().await.unwrap()).unwrap()
    }

    /// Review M3/M6 and I2: the fake behaves as Todoist does where the plugin depends on it.
    #[tokio::test]
    async fn the_fake_todoist_behaves_like_todoist() {
        let fake = FakeTodoist::start(TOKEN);
        // Project names may repeat; a project is read by id.
        let (_, _, a) = ask(&fake, "POST", "/projects", Some(r#"{"name":"Connect"}"#)).await;
        let (status, _, _) = ask(&fake, "POST", "/projects", Some(r#"{"name":"Connect"}"#)).await;
        assert_eq!(status, 200, "a second project of the same name");
        let pid = a["id"].as_str().unwrap().to_string();
        let (status, _, p) = ask(&fake, "GET", &format!("/projects/{pid}"), None).await;
        assert_eq!((status, p["name"].clone()), (200, json!("Connect")));

        let make = |content: &str| format!(r#"{{"content":"{content}","project_id":"{pid}"}}"#);
        let (_, _, open) = ask(&fake, "POST", "/tasks", Some(&make("Open"))).await;
        let (_, _, done) = ask(&fake, "POST", "/tasks", Some(&make("Done"))).await;
        let (_, _, gone) = ask(&fake, "POST", "/tasks", Some(&make("Gone"))).await;
        let id = |v: &Value| v["id"].as_str().unwrap().to_string();
        ask(&fake, "POST", &format!("/tasks/{}/close", id(&done)), None).await;
        ask(&fake, "DELETE", &format!("/tasks/{}", id(&gone)), None).await;

        // A completed task can't be read (as REST v2; v1 unconfirmed), an open one can.
        let (status, _, _) = ask(&fake, "GET", &format!("/tasks/{}", id(&done)), None).await;
        assert_eq!(status, 404);
        let (status, _, _) = ask(&fake, "GET", &format!("/tasks/{}", id(&open)), None).await;
        assert_eq!(status, 200);

        // A full sync lists open tasks only; an incremental one lists done and deleted ones.
        let full = sync_token(&fake, "*").await;
        let contents: Vec<&str> = full["items"]
            .as_array()
            .unwrap()
            .iter()
            .map(|i| i["content"].as_str().unwrap())
            .collect();
        assert_eq!(contents, ["Open"]);
        let delta = sync_token(&fake, "1").await;
        let changed: Vec<(&str, bool, bool)> = delta["items"]
            .as_array()
            .unwrap()
            .iter()
            .map(|i| {
                let content = i["content"].as_str().unwrap();
                (content, i["checked"] == true, i["is_deleted"] == true)
            })
            .collect();
        assert_eq!(changed, [("Done", true, false), ("Gone", false, true)]);

        // Reads and 404s don't move the sync revision.
        let before = sync_token(&fake, "*").await["sync_token"].clone();
        ask(&fake, "GET", &format!("/tasks/{}", id(&open)), None).await;
        ask(&fake, "GET", "/tasks/nope", None).await;
        ask(&fake, "POST", "/tasks/nope", Some("{}")).await;
        assert_eq!(sync_token(&fake, "*").await["sync_token"], before);

        // A 429 says retry_after in its body, and in Retry-After.
        fake.fail_once("GET /user", 429, Some(7));
        let (status, headers, body) = ask(&fake, "GET", "/user", None).await;
        assert_eq!(status, 429);
        assert_eq!(headers["retry-after"], "7");
        assert_eq!(body["error_extra"]["retry_after"], 7);
    }
}
