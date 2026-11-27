//! Runs the real Todoist and Knowledge plugins from Connect's own marketplace
//! (codemie-connect-marketplace); nothing of them is copied into this repository. Skips, with a
//! message, when the folder (or the plugin) isn't there.
//!
//! - `CONNECT_MARKETPLACE_DIR` (default `$HOME/repos/codemie-ai/codemie-connect-marketplace`): the
//!   marketplace folder. The plugin is installed from a temp copy of it into a temp data root,
//!   loaded by the real `PluginManager` into the real host, and asked by the real `task_sync` over
//!   a real `Core`. Only Todoist is faked: `FakeTodoist` on loopback, reached through
//!   `HttpClient::for_tests` as `api.todoist.com` after the host checked the plugin may reach
//!   that host. The token is a sentinel; no real Todoist is ever called.
//! - Knowledge is installed the same way and reads a seeded temp folder the user "picks" through
//!   the picker double. Connect asks it as it asks any reply-context provider: the `voice_*`
//!   operations, the `voice_refresh` job and a reply draft's asks, Claude played back by a
//!   `FakeRunner`. Its network is `HttpClient::offline()`, whose log must stay empty, and
//!   Microsoft is a Graph double that answers nothing.
use app_lib::plugins::git::CliGit;
use app_lib::plugins::host::Limits;
use app_lib::plugins::install::{self, sheet_hash, Agreement};
use app_lib::plugins::manager::PluginManager;
use app_lib::plugins::market;
use app_lib::plugins::registry::PluginPaths;
use app_lib::plugins::services::Outside;
use app_lib::testing::{self, Core, FakeGh, FakeRunner, FakeTodoist, HttpClient, Picked, Recorded};
use serde_json::{json, Value};
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

const SENTINEL: &str = "tk_SENTINEL_do_not_log_0123456789";
const PROVIDER: &str = "plugin:todoist";
/// Wed 18 Nov 2026, 12:00 UTC: the sync runs' clock.
const T0: i64 = 1_795_003_200;
const SHEET_LINE: &str = "Hold your tasks: what you add and change in Connect goes to it, and \
                          Connect shows the tasks it lists.";

/// The marketplace folder, or `None` (with a `skipped:` line) when it isn't there.
fn marketplace() -> Option<PathBuf> {
    marketplace_with("todoist", "Todoist")
}

/// The marketplace folder holding plugin `id`, or `None` (with a `skipped:` line) when it doesn't.
fn marketplace_with(id: &str, name: &str) -> Option<PathBuf> {
    let dir = std::env::var_os("CONNECT_MARKETPLACE_DIR")
        .map(PathBuf::from)
        .or_else(|| {
            std::env::var_os("HOME")
                .map(|h| PathBuf::from(h).join("repos/codemie-ai/codemie-connect-marketplace"))
        })?;
    if dir.join(market::CATALOG_FILE).is_file() && dir.join("plugins").join(id).is_dir() {
        Some(dir)
    } else {
        eprintln!(
            "skipped: {} has no {name} plugin (set CONNECT_MARKETPLACE_DIR)",
            dir.display()
        );
        None
    }
}

/// Copies a marketplace folder, leaving out its git repository.
fn copy_market(from: &Path, to: &Path) {
    std::fs::create_dir_all(to).unwrap();
    for entry in std::fs::read_dir(from).unwrap().flatten() {
        if entry.file_name() == ".git" || entry.file_name() == "node_modules" {
            continue;
        }
        let target = to.join(entry.file_name());
        if entry.file_type().unwrap().is_dir() {
            copy_market(&entry.path(), &target);
        } else {
            std::fs::copy(entry.path(), target).unwrap();
        }
    }
}

/// Connect with the marketplace's Todoist installed (its sheet agreed to) and loaded, its network
/// answered by a `FakeTodoist`.
struct Connect {
    _tmp: tempfile::TempDir,
    core: Arc<Core>,
    manager: Arc<PluginManager>,
    paths: PluginPaths,
    todoist: FakeTodoist,
    /// The sheet the user agreed to: each line's key and text.
    sheet: Vec<(String, String)>,
}

impl Connect {
    async fn start(market_dir: &Path) -> Connect {
        let tmp = tempfile::Builder::new()
            .prefix("connect-")
            .tempdir()
            .unwrap();
        let copy = tmp.path().join("market");
        copy_market(market_dir, &copy);
        let core = testing::core(
            &tmp.path().join("data"),
            Arc::new(FakeRunner::new(vec![])),
            vec![testing::claude_profile()],
        );
        let paths = PluginPaths::new(&core.paths.data, &core.paths.private);
        let m = market::add(&paths, &CliGit::default(), copy.to_str().unwrap()).unwrap();
        let offer = install::offer(&paths, &m, "todoist").unwrap();
        assert!(offer.refusal.is_none(), "{:?}", offer.refusal);
        assert!(offer.featured, "Todoist is featured in the catalog");
        assert_eq!(offer.categories, ["tasks"]);
        let keys: Vec<String> = offer.sheet.iter().map(|l| l.key.clone()).collect();
        let hash = sheet_hash(&offer.sheet);
        let agreement = Agreement {
            keys: &keys,
            sheet_hash: &hash,
        };
        install::install(&paths, &m.name, "todoist", agreement).unwrap();
        let todoist = FakeTodoist::start(SENTINEL);
        let http = HttpClient::for_tests(
            &[("api.todoist.com", todoist.base())],
            Duration::from_secs(5),
        );
        let outside = Outside {
            picker: Arc::new(Picked::default()),
            signin: Arc::new(FakeGh::default()),
            http,
        };
        let manager = PluginManager::new(core.clone(), outside, Limits::default());
        manager.reload().await;
        let sheet = offer
            .sheet
            .iter()
            .map(|l| (l.key.clone(), l.text.clone()))
            .collect();
        Connect {
            _tmp: tmp,
            core,
            manager,
            paths,
            todoist,
            sheet,
        }
    }

    /// The user saved the token in Settings › Tasks and chose Todoist.
    async fn choose_todoist(&self) {
        app_lib::plugins::extras::set_setting(&self.paths, "todoist", "token", &json!(SENTINEL))
            .unwrap();
        let chosen = testing::workspace_op(
            &self.core,
            "task_provider_set",
            json!({"provider": PROVIDER}),
        )
        .await
        .unwrap();
        assert_eq!(chosen["provider"], PROVIDER);
    }

    async fn save(&self, data: Value) -> String {
        let saved = testing::workspace_op(&self.core, "task_save", data)
            .await
            .unwrap();
        saved["id"]
            .as_str()
            .or(saved["task"]["id"].as_str())
            .map(str::to_string)
            .unwrap_or_else(|| panic!("a saved task's id: {saved}"))
    }

    /// Connect's task `id` as stored.
    fn task(&self, id: &str) -> Value {
        testing::records(&self.core, "commitment")
            .into_iter()
            .find(|(rid, _)| rid == id)
            .map(|(_, data)| data)
            .unwrap_or_else(|| panic!("no task {id}"))
    }

    /// Requests of `route` (`METHOD /path`, no query) Todoist got.
    fn requests_of(&self, route: &str) -> usize {
        self.todoist
            .requests()
            .iter()
            .filter(|r| r.split('?').next() == Some(route))
            .count()
    }

    /// Nothing Connect keeps, shows or tells the window holds the token.
    fn token_kept_nowhere(&self) {
        let mut kept = vec![testing::task_provider(&self.core).to_string()];
        for kind in ["commitment", "task_outbox", "task_state", "task_key"] {
            for (id, data) in testing::records(&self.core, kind) {
                kept.push(format!("{kind} {id} {data}"));
            }
        }
        for text in kept {
            assert!(!text.contains(SENTINEL), "the token leaked: {text}");
        }
    }
}

#[tokio::test]
async fn todoist_installs_with_its_sheet_and_loads() {
    let Some(dir) = marketplace() else {
        return;
    };
    let c = Connect::start(&dir).await;
    assert!(
        c.sheet.iter().any(|(_, text)| text == SHEET_LINE),
        "{:?}",
        c.sheet
    );
    let (_, network) = c
        .sheet
        .iter()
        .find(|(key, _)| key == "network")
        .expect("a network line");
    assert!(network.contains("api.todoist.com"), "{network}");
    assert_eq!(
        c.manager.loaded(),
        ["todoist"],
        "{:?}",
        c.manager.problems()
    );
    let provider = testing::task_provider(&c.core);
    assert_eq!(
        provider["available"][1],
        json!({"id": PROVIDER, "name": "Todoist", "on": true, "ready": true, "pending": 0})
    );
    // Nothing is asked of Todoist until the user chooses it.
    assert!(c.todoist.requests().is_empty());
}

#[tokio::test]
async fn todoist_syncs_a_core_task_through_the_real_host() {
    let Some(dir) = marketplace() else {
        return;
    };
    let c = Connect::start(&dir).await;
    c.choose_todoist().await;
    let id = c
        .save(json!({
            "text": "Send the pilot user list", "status": "waiting",
            "owner": "marek.novak@example.test", "ownerName": "Marek Novak", "due": "2026-11-20",
            "notes": "  “I'll send you the names by Friday.” — Marek Novak  ",
        }))
        .await;
    // Someone known only by address: an owner line with no name.
    let other = c
        .save(
            json!({"text": "Chase the signed contract", "status": "waiting",
                     "owner": "legal@example.test"}),
        )
        .await;

    let summary = testing::task_sync(&c.core, T0).await;
    assert!(summary.starts_with("Tasks ready: 2 sent"), "{summary}");
    let held = c.todoist.tasks();
    assert_eq!(held.len(), 2, "{held:?}");
    let t = held
        .iter()
        .find(|t| t["content"] != "Chase the signed contract")
        .unwrap();
    let unnamed = held
        .iter()
        .find(|t| t["content"] == "Chase the signed contract")
        .unwrap();
    assert!(unnamed["description"]
        .as_str()
        .unwrap()
        .ends_with("owner: <legal@example.test>"));
    assert_eq!(t["content"], "Marek: Send the pilot user list");
    let description = t["description"].as_str().unwrap();
    assert!(
        description.lines().any(|l| l.starts_with("key: ")),
        "{description}"
    );
    assert!(description.contains("owner: Marek Novak <marek.novak@example.test>"));
    let labels: Vec<&str> = t["labels"]
        .as_array()
        .unwrap()
        .iter()
        .filter_map(Value::as_str)
        .collect();
    assert!(
        labels.contains(&"connect") && labels.contains(&"waiting"),
        "{labels:?}"
    );
    assert_eq!(t["due"]["date"], "2026-11-20");
    let rid = t["id"].as_str().unwrap().to_string();
    let task = c.task(&id);
    assert_eq!(task["remote"]["id"], rid.as_str());
    assert_eq!(task["pending"], false);
    assert_eq!(c.task(&other)["pending"], false);
    // The creates' answers read back what was sent: no update follows them, now or on the next
    // run.
    let updates = || {
        c.todoist
            .requests()
            .iter()
            .filter(|r| r.starts_with("POST /tasks/"))
            .count()
    };
    assert_eq!(updates(), 0, "{:?}", c.todoist.requests());
    testing::task_sync(&c.core, T0 + 61).await;
    assert_eq!(updates(), 0, "{:?}", c.todoist.requests());
    assert_eq!(
        c.requests_of("POST /projects"),
        1,
        "the project is made once"
    );

    // Edited in Todoist: the pull brings it.
    c.todoist.edit(
        &rid,
        json!({"content": "Marek: Send the final pilot list", "due": {"date": "2026-11-24", "string": "Nov 24"}}),
    );
    let summary = testing::task_sync(&c.core, T0 + 130).await;
    assert!(summary.contains("1 changed"), "{summary}");
    let task = c.task(&id);
    assert_eq!(task["text"], "Send the final pilot list");
    assert_eq!(task["due"], "2026-11-24");
    assert_eq!(task["status"], "waiting");

    // Done in Connect: closed in Todoist, even though Todoist won't read a completed task back.
    c.save(json!({"id": id, "status": "done"})).await;
    let summary = testing::task_sync(&c.core, T0 + 160).await;
    assert!(
        summary.starts_with("Tasks ready:") && summary.contains(" 0 parked"),
        "{summary}"
    );
    let closed = c
        .todoist
        .tasks()
        .into_iter()
        .find(|t| t["id"] == rid.as_str())
        .unwrap();
    assert_eq!(closed["checked"], true);
    let task = c.task(&id);
    assert_eq!(task["status"], "done");
    assert_eq!(task["pending"], false);
    assert_eq!(task["syncError"], Value::Null);

    // Todoist asks Connect to slow down: nothing is sent before Retry-After.
    c.todoist.fail_once("POST /sync", 429, Some(5));
    let summary = testing::task_sync(&c.core, T0 + 230).await;
    assert!(summary.starts_with("Tasks rate_limited"), "{summary}");
    let provider = testing::task_provider(&c.core);
    assert_eq!(provider["state"], "rate_limited");
    assert_eq!(provider["retryAt"], T0 + 230 + 5);
    let before = c.todoist.requests().len();
    testing::task_sync(&c.core, T0 + 232).await;
    assert_eq!(c.todoist.requests().len(), before, "nothing before retryAt");

    c.token_kept_nowhere();
}

/// Review Focus 1 against the real plugin: a create Todoist made whose answer never came back is
/// adopted by its key on the next run; Todoist holds exactly one.
#[tokio::test]
async fn a_lost_create_is_adopted_by_the_real_plugin() {
    let Some(dir) = marketplace() else {
        return;
    };
    let c = Connect::start(&dir).await;
    c.choose_todoist().await;
    let id = c.save(json!({"text": "Book a room for demo day"})).await;

    c.todoist.lose_once("POST /tasks");
    let summary = testing::task_sync(&c.core, T0).await;
    assert!(summary.starts_with("Tasks offline"), "{summary}");
    assert_eq!(c.todoist.tasks().len(), 1, "Todoist made it");
    assert_eq!(c.task(&id)["remote"]["id"], Value::Null);
    assert_eq!(c.task(&id)["pending"], true);

    // Next run (after the offline backoff): the replayed create finds it by key.
    let summary = testing::task_sync(&c.core, T0 + 31).await;
    assert!(summary.starts_with("Tasks ready"), "{summary}");
    let held = c.todoist.tasks();
    assert_eq!(held.len(), 1, "Todoist holds exactly one: {held:?}");
    assert_eq!(c.requests_of("POST /tasks"), 1, "made once");
    let task = c.task(&id);
    assert_eq!(task["remote"]["id"], held[0]["id"]);
    assert_eq!(task["pending"], false);
    assert_eq!(
        c.requests_of(&format!("POST /tasks/{}", held[0]["id"].as_str().unwrap())),
        0
    );

    c.token_kept_nowhere();
}

// ------------------------------------------------------------------ Knowledge (reply voice)

const KNOWLEDGE: &str = "plugin:knowledge";
/// Must reach a draft's run, and never a log line, the ledger, the snapshot or an error.
const VOICE_SENTINEL: &str = "VOICE_SENTINEL_9f3a";
const VOICE_SHEET_LINE: &str = "Shape your replies: Connect asks it how you write, about the \
                                people you write to and for notes on the names and codes in a \
                                message, and adds what it answers to your AI drafts. It can read \
                                the text of messages you sent that Connect has synced.";
const OFF_MAC: &str = "A reply-context plugin can't use the network: what it reads of your sent \
                       messages stays on this Mac.";
const NOT_UTF8: &str = "Knowledge didn't save it: Knowledge can't read Voice/rules.md: it isn't \
                        UTF-8 text. Save it as UTF-8 in your folder, then try again.";
/// Sam Ortiz's Teams user id (invented).
const SAM_TEAMS_ID: &str = "29:sam-ortiz-0001";

const PRIYA_PAGE: &str = "---\nname: Priya N.\naliases: [Priya, Priya Nair]\nemails: \
                          [priya.n@example.test]\n---\n# Priya N.\n\n## Overview\nProduct lead \
                          for the pilot.\n\n## Writing to them\nTwo lines at most; lead with the \
                          decision. VOICE_SENTINEL_9f3a\n";
const STYLE_PAGE: &str = "---\nbasedOn: {mail: 12, teams: 40}\n---\nShort sentences; no small \
                          talk. VOICE_SENTINEL_9f3a\n";
const RULES_PAGE: &str = "## to: priya.n@example.test\nBullet points, no greeting.\n\n## \
                          everyone\nNever promise a date.\n";
const ATLAS_PAGE: &str = "---\naliases: [Atlas]\n---\n# Atlas Rollout\n\n## Dates\nGo-live moved \
                          to 2026-12-08. VOICE_SENTINEL_9f3a\n";

fn now_s() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_secs() as i64
}

/// A reply draft as Claude answers it.
fn draft_answer() -> testing::ClaudeAnswer {
    testing::answer_json(json!({"draft": "Thanks, Priya. [Yes / No].", "questions": []}))
}

/// Connect with the marketplace's Knowledge installed (its sheet agreed to) and loaded, the user
/// signed in, and a knowledge folder (not yet picked) in a temp folder.
struct Knowledge {
    _tmp: tempfile::TempDir,
    folder: PathBuf,
    core: Arc<Core>,
    manager: Arc<PluginManager>,
    paths: PluginPaths,
    picker: Arc<Picked>,
    runner: Arc<FakeRunner>,
    graph_reads: Arc<dyn Fn() -> Vec<String> + Send + Sync>,
    http_sent: Recorded,
    sheet: Vec<(String, String)>,
}

impl Knowledge {
    /// Claude plays back `script` (by default, reply drafts).
    async fn start(market_dir: &Path) -> Knowledge {
        Knowledge::start_with(market_dir, (0..8).map(|_| draft_answer()).collect()).await
    }

    async fn start_with(market_dir: &Path, script: Vec<testing::ClaudeAnswer>) -> Knowledge {
        testing::capture_logs();
        // Not a hidden folder (`.tmpXXXX`): Knowledge never reads or writes inside one.
        let tmp = tempfile::Builder::new()
            .prefix("connect-")
            .tempdir()
            .unwrap();
        let copy = tmp.path().join("market");
        copy_market(market_dir, &copy);
        let runner = Arc::new(FakeRunner::new(script));
        let (core, graph_reads) = testing::core_and_graph_reads(
            &tmp.path().join("data"),
            runner.clone(),
            vec![testing::claude_profile()],
        );
        testing::choose_profile(&core, "claude");
        testing::signed_in(&core);
        let paths = PluginPaths::new(&core.paths.data, &core.paths.private);
        let m = market::add(&paths, &CliGit::default(), copy.to_str().unwrap()).unwrap();
        let offer = install::offer(&paths, &m, "knowledge").unwrap();
        assert!(offer.refusal.is_none(), "{:?}", offer.refusal);
        assert!(offer.featured, "Knowledge is featured in the catalog");
        assert_eq!(offer.categories, ["replies"]);
        let keys: Vec<String> = offer.sheet.iter().map(|l| l.key.clone()).collect();
        let hash = sheet_hash(&offer.sheet);
        install::install(
            &paths,
            &m.name,
            "knowledge",
            Agreement {
                keys: &keys,
                sheet_hash: &hash,
            },
        )
        .unwrap();
        let (http, http_sent) = HttpClient::offline();
        let picker = Arc::new(Picked::default());
        let outside = Outside {
            picker: picker.clone(),
            signin: Arc::new(FakeGh::default()),
            http,
        };
        let manager = PluginManager::new(core.clone(), outside, Limits::default());
        manager.reload().await;
        assert_eq!(manager.loaded(), ["knowledge"], "{:?}", manager.problems());
        let folder = tmp.path().join("kb");
        std::fs::create_dir_all(&folder).unwrap();
        let sheet = offer
            .sheet
            .iter()
            .map(|l| (l.key.clone(), l.text.clone()))
            .collect();
        Knowledge {
            _tmp: tmp,
            folder,
            core,
            manager,
            paths,
            picker,
            runner,
            graph_reads,
            http_sent,
            sheet,
        }
    }

    /// Writes `text` at `rel` in the knowledge folder.
    fn write(&self, rel: &str, text: &str) {
        let path = self.folder.join(rel);
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(path, text).unwrap();
    }

    fn read(&self, rel: &str) -> String {
        std::fs::read_to_string(self.folder.join(rel)).unwrap()
    }

    /// Priya's page, the style card and the instructions.
    fn seed_folder(&self) {
        self.write("People/priya-n.md", PRIYA_PAGE);
        self.write("Voice/style.md", STYLE_PAGE);
        self.write("Voice/rules.md", RULES_PAGE);
    }

    /// The user picks the knowledge folder on Knowledge's page.
    async fn pick_folder(&self) {
        self.picker.next(&self.folder);
        let picked = self
            .manager
            .call("knowledge", "pickFolder", Value::Null)
            .await
            .unwrap();
        let real = real_path(&self.folder);
        assert_eq!(picked["folder"], real.as_str(), "{picked}");
    }

    /// Settings › Your voice: the user chooses Knowledge.
    async fn choose_knowledge(&self) {
        let chosen = testing::workspace_op(&self.core, "voice_set", json!({"provider": KNOWLEDGE}))
            .await
            .unwrap();
        assert_eq!(chosen["provider"], KNOWLEDGE);
    }

    /// Picks the seeded folder, chooses Knowledge and runs the refresh it queued.
    async fn ready(&self) {
        self.seed_folder();
        self.pick_folder().await;
        self.choose_knowledge().await;
        testing::run_jobs(&self.core).await;
        assert_eq!(testing::voice_snapshot(&self.core)["state"], "ready");
    }

    /// Priya's mail `id` to the user saying `text`, a minute ago.
    fn priya_mail(&self, id: &str, title: &str, text: &str) {
        let at = now_s() - 60;
        testing::synced_message(
            &self.core,
            id,
            json!({"channel": "mail", "conversationId": format!("conv-{id}"), "title": title,
                   "from": "Priya N.", "fromAddress": "priya.n@example.test",
                   "to": [{"emailAddress": {"name": "Taylor Reed", "address": "taylor@example.test"}}],
                   "replyTo": [], "isMine": false, "isRead": false, "at": at, "text": text,
                   "providerId": format!("p-{id}")}),
        );
    }

    /// A reply draft of mail `id`, as Draft reply asks for it: the draft as stored and the
    /// input of the run that made it.
    async fn draft(&self, id: &str) -> (Value, Value) {
        self.draft_as(id, &format!("ai:{id}")).await
    }

    /// [`Self::draft`] of message `id`, whose draft is `draft_id` (a Teams chat's draft is the
    /// conversation's: `ai:chat:<conversation id>`).
    async fn draft_as(&self, id: &str, draft_id: &str) -> (Value, Value) {
        testing::workspace_op(&self.core, "ai_draft", json!({"sourceId": id}))
            .await
            .unwrap();
        testing::run_jobs(&self.core).await;
        let draft = testing::draft(&self.core, draft_id)
            .unwrap_or_else(|| panic!("no draft {draft_id} of {id}"));
        let input = self.runner.calls().last().expect("a run").input.clone();
        (draft, input)
    }

    /// Everything under `.git`, path and bytes.
    fn git_files(&self) -> Vec<(String, Vec<u8>)> {
        fn walk(dir: &Path, base: &Path, out: &mut Vec<(String, Vec<u8>)>) {
            for entry in std::fs::read_dir(dir).unwrap().flatten() {
                let path = entry.path();
                if path.is_dir() {
                    walk(&path, base, out);
                } else {
                    let rel = path.strip_prefix(base).unwrap().display().to_string();
                    out.push((rel, std::fs::read(&path).unwrap()));
                }
            }
        }
        let mut out = Vec::new();
        walk(&self.folder.join(".git"), &self.folder, &mut out);
        out.sort();
        out
    }

    /// Nothing was asked of the network (Knowledge has none to ask).
    fn nothing_left_this_mac(&self) {
        assert!(
            self.http_sent.lock().unwrap().is_empty(),
            "{:?}",
            self.http_sent
        );
    }

    /// Microsoft was asked nothing (a reply draft reads the mail's own text from it; nothing
    /// Knowledge does reads anything there).
    fn microsoft_asked_nothing(&self) {
        assert!(
            (self.graph_reads)().is_empty(),
            "{:?}",
            (self.graph_reads)()
        );
    }

    /// No log line, ledger record or snapshot holds a page's text.
    fn voice_text_kept_nowhere(&self) {
        for line in testing::logged_lines() {
            assert!(!line.contains(VOICE_SENTINEL), "a log line: {line}");
        }
        for (id, run) in testing::records(&self.core, "ai_run") {
            assert!(
                !run.to_string().contains(VOICE_SENTINEL),
                "ai_run {id}: {run}"
            );
        }
        let snapshot = testing::voice_snapshot(&self.core);
        // The style card is shown (and edited) in Settings › Your voice; profiles never are.
        let mut people = snapshot["people"].to_string();
        people.push_str(&snapshot["rules"].to_string());
        assert!(!people.contains(VOICE_SENTINEL), "{snapshot}");
    }
}

/// `path`'s real path, as Connect grants it.
fn real_path(path: &Path) -> String {
    std::fs::canonicalize(path).unwrap().display().to_string()
}

/// The marketplace folder with Knowledge, or `None` (with a `skipped:` line).
fn knowledge_marketplace() -> Option<PathBuf> {
    marketplace_with("knowledge", "Knowledge")
}

/// The carried check (ruling 10) against the real manifest: Knowledge asks for nothing that
/// leaves the Mac, and the same manifest asking for the network, the web, a sign-in or a
/// delivery is refused with the manifest refusal.
#[tokio::test]
async fn knowledges_manifest_asks_for_nothing_that_leaves_the_mac() {
    let Some(dir) = knowledge_marketplace() else {
        return;
    };
    let k = Knowledge::start(&dir).await;
    assert!(
        k.sheet
            .iter()
            .any(|(key, text)| key == "provides_reply-context" && text == VOICE_SHEET_LINE),
        "{:?}",
        k.sheet
    );
    for key in ["network", "web", "signin", "deliver"] {
        assert!(
            !k.sheet.iter().any(|(k, _)| k == key),
            "{key}: {:?}",
            k.sheet
        );
    }
    let manifest: Value = serde_json::from_str(
        &std::fs::read_to_string(dir.join("plugins/knowledge/echo-plugin.json")).unwrap(),
    )
    .unwrap();
    for (key, ask) in [
        ("network", json!({"hosts": ["api.example.test"]})),
        ("web", json!({})),
        ("signin", json!({"hosts": ["login.example.test"]})),
        ("deliver", json!({})),
    ] {
        let tmp = tempfile::Builder::new()
            .prefix("connect-")
            .tempdir()
            .unwrap();
        let copy = tmp.path().join("market");
        copy_market(&dir, &copy);
        let mut asking = manifest.clone();
        asking["uses"][key] = ask;
        std::fs::write(
            copy.join("plugins/knowledge/echo-plugin.json"),
            serde_json::to_string_pretty(&asking).unwrap(),
        )
        .unwrap();
        let (data, private) = (tmp.path().join("data"), tmp.path().join("private"));
        std::fs::create_dir_all(&data).unwrap();
        std::fs::create_dir_all(&private).unwrap();
        let paths = PluginPaths::new(&data, &private);
        let m = market::add(&paths, &CliGit::default(), copy.to_str().unwrap()).unwrap();
        let offer = install::offer(&paths, &m, "knowledge").unwrap();
        let refusal = offer.refusal.unwrap_or_else(|| panic!("{key} is refused"));
        assert_eq!(refusal.message, OFF_MAC, "{key}");
    }
    k.nothing_left_this_mac();
    k.microsoft_asked_nothing();
}

#[tokio::test]
async fn knowledge_needs_setup_until_a_folder_is_chosen() {
    let Some(dir) = knowledge_marketplace() else {
        return;
    };
    let k = Knowledge::start(&dir).await;
    let snapshot = testing::voice_snapshot(&k.core);
    assert_eq!(
        snapshot["available"][0],
        json!({"id": KNOWLEDGE, "name": "Knowledge", "on": true, "ready": true, "facts": true})
    );
    assert_eq!(snapshot["state"], "off");
    k.choose_knowledge().await;
    testing::run_jobs(&k.core).await;
    let snapshot = testing::voice_snapshot(&k.core);
    assert_eq!(snapshot["state"], "needs_setup", "{snapshot}");
    assert_eq!(snapshot["available"][0]["facts"], true);
    for op in ["status", "export", "context", "facts"] {
        assert_eq!(
            testing::voice_call(&k.core, op, json!({})).await,
            Err("needs_setup".into()),
            "{op}"
        );
    }
    // A save asks the folder first: "Choose its folder in Knowledge first."
    let refused = testing::workspace_op(
        &k.core,
        "voice_save",
        json!({"kind": "rule", "applies": {"kind": "everyone"}, "text": "Be brief."}),
    )
    .await
    .unwrap_err();
    assert_eq!(
        refused,
        "needs_setup: Choose its folder in Knowledge first."
    );
    // An empty folder chosen: the first instruction makes Voice/rules.md.
    k.pick_folder().await;
    assert_eq!(testing::voice_refresh(&k.core).await, "ready");
    testing::workspace_op(
        &k.core,
        "voice_save",
        json!({"kind": "rule", "applies": {"kind": "everyone"}, "text": "Be brief."}),
    )
    .await
    .unwrap();
    assert_eq!(k.read("Voice/rules.md"), "## everyone\nBe brief.\n");
    k.nothing_left_this_mac();
    k.microsoft_asked_nothing();
}

#[tokio::test]
async fn knowledge_fills_the_copy_from_its_folder() {
    let Some(dir) = knowledge_marketplace() else {
        return;
    };
    let k = Knowledge::start(&dir).await;
    k.seed_folder();
    k.pick_folder().await;
    k.choose_knowledge().await;
    assert_eq!(testing::voice_refresh(&k.core).await, "ready");

    let snapshot = testing::voice_snapshot(&k.core);
    assert_eq!(snapshot["state"], "ready", "{snapshot}");
    assert_eq!(snapshot["name"], "Knowledge");
    let people = snapshot["people"].as_array().unwrap();
    assert_eq!(people.len(), 1, "{snapshot}");
    assert_eq!(people[0]["name"], "Priya N.");
    let copy = testing::voice_copy(&k.core).expect("a copy");
    let style = &copy["style"];
    assert!(style["text"]
        .as_str()
        .unwrap()
        .contains("Short sentences; no small talk."));
    assert_eq!(style["source"], "Voice/style.md");
    assert_eq!(style["basedOn"], json!({"mail": 12, "teams": 40}));
    // The host's mtime is in seconds; Knowledge's `updatedAt` is a recent time, not 1970.
    let updated = chrono::DateTime::parse_from_rfc3339(style["updatedAt"].as_str().unwrap())
        .unwrap_or_else(|e| panic!("{style}: {e}"))
        .timestamp();
    assert!((now_s() - updated).abs() < 600, "{style}");
    let mut rules: Vec<(String, String)> = copy["rules"]
        .as_array()
        .unwrap()
        .iter()
        .map(|r| {
            (
                r["applies"]["kind"].as_str().unwrap().into(),
                r["text"].as_str().unwrap().into(),
            )
        })
        .collect();
    rules.sort();
    assert_eq!(
        rules,
        [
            ("everyone".to_string(), "Never promise a date.".to_string()),
            ("to".into(), "Bullet points, no greeting.".into())
        ]
    );
    let priya = &copy["people"][0];
    assert_eq!(priya["addresses"], json!(["priya.n@example.test"]));
    assert!(
        priya["text"]
            .as_str()
            .unwrap()
            .contains("lead with the decision"),
        "{priya}"
    );
    assert!(
        priya["about"].as_str().unwrap().contains("Product lead"),
        "{priya}"
    );

    // The six ops, end to end through the host.
    let status = testing::voice_call(&k.core, "status", json!({}))
        .await
        .unwrap();
    assert_eq!(
        status,
        json!({"ok": true, "people": 1, "rules": 2, "style": true, "skipped": 0})
    );
    let export = testing::voice_call(&k.core, "export", json!({}))
        .await
        .unwrap();
    assert_eq!(export["people"].as_array().unwrap().len(), 1);
    let context = testing::voice_call(
        &k.core,
        "context",
        json!({"person": {"name": "Nair Priya", "address": null, "id": null}, "channel": "teams",
               "subject": "pilot"}),
    )
    .await
    .unwrap();
    assert_eq!(
        context["person"]["name"], "Priya N.",
        "folded name, any order"
    );

    // Refresh now, after the folder changed: the copy follows it.
    k.write(
        "People/marek-novak.md",
        "---\nname: Marek Novak\n---\n## Writing to them\nKeep it formal.\n",
    );
    assert_eq!(testing::voice_refresh(&k.core).await, "ready");
    assert_eq!(
        testing::voice_snapshot(&k.core)["people"]
            .as_array()
            .unwrap()
            .len(),
        2
    );
    k.voice_text_kept_nowhere();
    k.nothing_left_this_mac();
    k.microsoft_asked_nothing();
}

/// A folder shaped like a knowledge base: `people/` in lower case, pages without `name`, the
/// writing sections after the facts, and a Teams-only person known by `Voice/ids.json`.
#[tokio::test]
async fn a_knowledge_base_shaped_folder_works() {
    let Some(dir) = knowledge_marketplace() else {
        return;
    };
    let k = Knowledge::start(&dir).await;
    k.write(
        "people/sam-ortiz.md",
        "---\naliases: [Sam]\ntags: [person]\n---\n# Sam Ortiz\n\n## Overview\nRuns the vendor \
         side of the pilot.\n\n## Roles And Background\nSupport lead.\n\n## Communication Style\n\
         Answers in one line; skip the pleasantries. VOICE_SENTINEL_9f3a\n",
    );
    k.write(
        "Voice/ids.json",
        &json!({"sam-ortiz": [SAM_TEAMS_ID]}).to_string(),
    );
    k.pick_folder().await;
    k.choose_knowledge().await;
    testing::run_jobs(&k.core).await;
    let copy = testing::voice_copy(&k.core).expect("a copy");
    let sam = &copy["people"][0];
    assert_eq!(sam["name"], "Sam Ortiz", "{copy}");
    assert_eq!(sam["ids"], json!([SAM_TEAMS_ID]));
    assert!(
        sam["text"]
            .as_str()
            .unwrap()
            .contains("skip the pleasantries"),
        "{sam}"
    );
    assert!(
        !sam["text"].as_str().unwrap().contains("vendor side"),
        "never the facts: {sam}"
    );

    // His Teams message, under a display name that matches no page: matched by id.
    testing::synced_message(
        &k.core,
        "t1",
        json!({"channel": "chat", "conversationId": "chat:19:sam", "chatId": "19:sam",
               "chatType": "oneOnOne", "title": "Ortiz S.", "from": "Ortiz S. (Vendor)",
               "fromId": SAM_TEAMS_ID, "isMine": false, "at": now_s() - 30,
               "text": "Can you confirm the cut-over window?"}),
    );
    let (draft, input) = k.draft_as("t1", "ai:chat:chat:19:sam").await;
    let voice = input["voice"].as_str().expect("a voice field");
    assert!(voice.contains("skip the pleasantries"), "{voice}");
    assert_eq!(draft["provenance"]["voice"]["person"], "Sam Ortiz");
    assert_eq!(draft["provenance"]["voice"]["from"], "provider");
    k.voice_text_kept_nowhere();
    k.nothing_left_this_mac();
}

#[tokio::test]
async fn a_draft_carries_knowledges_voice() {
    let Some(dir) = knowledge_marketplace() else {
        return;
    };
    let k = Knowledge::start(&dir).await;
    k.ready().await;
    k.priya_mail("p1", "re: next steps", "Could you share the plan today?");
    let (draft, input) = k.draft("p1").await;
    let voice = input["voice"].as_str().expect("a voice field");
    assert!(
        voice.contains("<person name=\"Priya N.\"><writing>"),
        "{voice}"
    );
    assert!(voice.contains("lead with the decision"), "{voice}");
    assert!(
        voice.contains(VOICE_SENTINEL),
        "the run reads the page text"
    );
    assert!(
        voice.contains(
            "<rule applies=\"to priya.n@example.test\">Bullet points, no greeting.</rule>"
        ),
        "{voice}"
    );
    assert!(voice.contains("Short sentences; no small talk."), "{voice}");
    let p = &draft["provenance"]["voice"];
    assert_eq!(p["from"], "provider", "{p}");
    assert_eq!(p["provider"], "Knowledge");
    assert_eq!(p["person"], "Priya N.");
    assert_eq!(p["style"], true);
    assert!(!draft.to_string().contains(VOICE_SENTINEL), "{draft}");
    k.voice_text_kept_nowhere();
    k.nothing_left_this_mac();
}

#[tokio::test]
async fn a_draft_carries_knowledges_facts() {
    let Some(dir) = knowledge_marketplace() else {
        return;
    };
    let k = Knowledge::start(&dir).await;
    k.write("projects/atlas-rollout.md", ATLAS_PAGE);
    k.write(
        "projects/unrelated.md",
        "# Office move\n\nNew desks on floor 3.\n",
    );
    k.ready().await;
    k.priya_mail("p2", "Atlas", "Can we move EPM-1234 for Atlas Rollout?");
    let (draft, input) = k.draft("p2").await;
    let facts = input["facts"].as_str().expect("a facts field");
    assert!(
        facts.starts_with("<facts provider=\"Knowledge\">"),
        "{facts}"
    );
    assert!(
        facts.contains("<fact source=\"projects/atlas-rollout.md\""),
        "{facts}"
    );
    assert!(facts.contains("Go-live moved to 2026-12-08."), "{facts}");
    assert!(!facts.contains("Office move"), "{facts}");
    assert!(
        !facts.contains("People/priya-n.md"),
        "the person's own page is left out"
    );
    let p = &draft["provenance"]["voice"];
    assert_eq!(p["factsMissed"], false, "{p}");
    assert_eq!(
        p["facts"][0],
        json!({"id": "projects/atlas-rollout.md", "title": "Atlas Rollout"})
    );
    let stored = draft.to_string();
    assert!(!stored.contains("Go-live"), "never a fact's text: {stored}");
    assert!(!stored.contains(VOICE_SENTINEL), "{stored}");
    k.voice_text_kept_nowhere();
    k.nothing_left_this_mac();
}

#[tokio::test]
async fn knowledge_turned_off_drafts_from_the_copy() {
    let Some(dir) = knowledge_marketplace() else {
        return;
    };
    let k = Knowledge::start(&dir).await;
    k.write("projects/atlas-rollout.md", ATLAS_PAGE);
    k.ready().await;
    install::set_enabled(&k.paths, "knowledge", false).unwrap();
    k.manager.reload().await;
    let snapshot = testing::voice_snapshot(&k.core);
    assert_eq!(snapshot["available"][0]["on"], false, "{snapshot}");
    assert_eq!(snapshot["state"], "unavailable");
    k.priya_mail("p3", "Atlas", "Can we move EPM-1234 for Atlas Rollout?");
    let (draft, input) = k.draft("p3").await;
    let voice = input["voice"].as_str().expect("the copy's voice");
    assert!(voice.contains("lead with the decision"), "{voice}");
    assert!(input.get("facts").is_none(), "{input}");
    let p = &draft["provenance"]["voice"];
    assert_eq!(p["from"], "copy", "{p}");
    assert_eq!(p["factsMissed"], true);
    assert!(p["at"].as_i64().unwrap() > 0, "{p}");
    k.nothing_left_this_mac();
}

/// Delete Connect's copy: the voice is off, the copy is gone and no refresh refills it, and the
/// folder is left as it was.
#[tokio::test]
async fn knowledge_delete_removes_connects_copy_and_leaves_the_folder() {
    let Some(dir) = knowledge_marketplace() else {
        return;
    };
    let k = Knowledge::start(&dir).await;
    k.ready().await;
    let before = (
        k.read("People/priya-n.md"),
        k.read("Voice/style.md"),
        k.read("Voice/rules.md"),
    );
    let deleted = testing::workspace_op(&k.core, "voice_forget", json!({}))
        .await
        .unwrap();
    assert_eq!(deleted["provider"], "off");
    assert!(deleted["deleted"].as_u64().unwrap() > 0, "{deleted}");
    assert!(testing::voice_copy(&k.core).is_none());
    let snapshot = testing::voice_snapshot(&k.core);
    assert_eq!(snapshot["state"], "off");
    assert_eq!(snapshot["copy"], false);
    assert_eq!(snapshot["people"], json!([]));
    // A reload of the plugin, Refresh now and the next draft refill nothing.
    k.manager.reload().await;
    let refresh = testing::workspace_op(&k.core, "voice_refresh", json!({}))
        .await
        .unwrap();
    assert_eq!(refresh, json!({"queued": false}));
    testing::run_jobs(&k.core).await;
    assert!(testing::voice_copy(&k.core).is_none());
    k.priya_mail("p4", "Atlas", "Can we move EPM-1234 for Atlas Rollout?");
    let (draft, input) = k.draft("p4").await;
    assert!(
        input.get("voice").is_none() && input.get("facts").is_none(),
        "{input}"
    );
    assert!(draft["provenance"].get("voice").is_none());
    let after = (
        k.read("People/priya-n.md"),
        k.read("Voice/style.md"),
        k.read("Voice/rules.md"),
    );
    assert_eq!(before, after, "the folder is untouched");
    k.nothing_left_this_mac();
}

#[tokio::test]
async fn knowledge_an_edit_in_connect_lands_in_the_folder() {
    let Some(dir) = knowledge_marketplace() else {
        return;
    };
    let k = Knowledge::start(&dir).await;
    k.ready().await;

    // A new instruction and the style card, saved in Settings › Your voice.
    let saved = testing::workspace_op(
        &k.core,
        "voice_save",
        json!({"kind": "rule", "applies": {"kind": "domain", "value": "bank.example.test", "channel": "mail"},
               "text": "Formal; full sentences."}),
    )
    .await
    .unwrap();
    let id = saved["item"]["id"].as_str().expect("its id").to_string();
    let rules = k.read("Voice/rules.md");
    assert!(
        rules.contains("## domain: bank.example.test · mail\nFormal; full sentences."),
        "{rules}"
    );
    assert!(
        rules.starts_with(RULES_PAGE.trim_end()),
        "the others untouched: {rules}"
    );
    testing::workspace_op(
        &k.core,
        "voice_save",
        json!({"kind": "style", "text": "Plain words."}),
    )
    .await
    .unwrap();
    let style = k.read("Voice/style.md");
    assert!(
        style.contains("basedOn") && style.contains("Plain words."),
        "{style}"
    );
    testing::run_jobs(&k.core).await;
    let copy = testing::voice_copy(&k.core).unwrap();
    assert_eq!(copy["style"]["text"], "Plain words.");
    assert!(copy["rules"]
        .as_array()
        .unwrap()
        .iter()
        .any(|r| r["id"] == id.as_str()));

    // Edited in the folder meanwhile: a hand-added instruction is kept by Connect's next edit.
    k.write(
        "Voice/rules.md",
        &format!(
            "{}\n## topic: invoices\nAsk for the PO number.\n",
            k.read("Voice/rules.md")
        ),
    );
    testing::workspace_op(
        &k.core,
        "voice_save",
        json!({"id": id, "kind": "rule",
               "applies": {"kind": "domain", "value": "bank.example.test", "channel": "mail"},
               "text": "Formal; no first names."}),
    )
    .await
    .unwrap();
    let rules = k.read("Voice/rules.md");
    assert!(
        rules.contains("Formal; no first names.") && rules.contains("Ask for the PO number."),
        "{rules}"
    );
    assert!(!rules.contains("Formal; full sentences."), "{rules}");

    // Removed in the folder meanwhile: Connect's edit of it is refused, the file unchanged.
    let without: String = rules.replace(
        "## domain: bank.example.test · mail\nFormal; no first names.\n",
        "",
    );
    assert_ne!(without, rules);
    k.write("Voice/rules.md", &without);
    let refused = testing::workspace_op(
        &k.core,
        "voice_save",
        json!({"id": id, "kind": "rule",
               "applies": {"kind": "domain", "value": "bank.example.test", "channel": "mail"},
               "text": "Formal; sign with the full name."}),
    )
    .await
    .unwrap_err();
    assert_eq!(
        refused,
        "refused: Knowledge didn't save it: This instruction is no longer there. Refresh and try again."
    );
    assert_eq!(k.read("Voice/rules.md"), without);

    // An unreadable page (bytes that aren't UTF-8) is never overwritten, and the refusal says
    // what is wrong, not "The page changed" (a refresh can't help).
    let mut odd = without.clone().into_bytes();
    odd.extend_from_slice(b"\n## everyone\nCaf\xe9 rules.\n");
    std::fs::write(k.folder.join("Voice/rules.md"), &odd).unwrap();
    let refused = testing::workspace_op(
        &k.core,
        "voice_save",
        json!({"kind": "rule", "applies": {"kind": "no-profile"}, "text": "Introduce yourself."}),
    )
    .await
    .unwrap_err();
    assert_eq!(refused, format!("refused: {NOT_UTF8}"));
    assert!(!refused.contains("The page changed"), "{refused}");
    assert_eq!(std::fs::read(k.folder.join("Voice/rules.md")).unwrap(), odd);

    // Remove, through Knowledge: gone from the file and the copy.
    std::fs::write(k.folder.join("Voice/rules.md"), RULES_PAGE).unwrap();
    assert_eq!(testing::voice_refresh(&k.core).await, "ready");
    let everyone = testing::voice_copy(&k.core).unwrap()["rules"]
        .as_array()
        .unwrap()
        .iter()
        .find(|r| r["applies"]["kind"] == "everyone")
        .map(|r| r["id"].as_str().unwrap().to_string())
        .unwrap();
    testing::workspace_op(&k.core, "voice_delete", json!({"id": everyone}))
        .await
        .unwrap();
    assert!(!k.read("Voice/rules.md").contains("Never promise a date."));
    assert!(!testing::voice_copy(&k.core).unwrap()["rules"]
        .to_string()
        .contains("Never promise"));
    k.voice_text_kept_nowhere();
    k.nothing_left_this_mac();
    k.microsoft_asked_nothing();
}

#[tokio::test]
async fn knowledge_importing_skills_lands_in_rules_md() {
    let Some(dir) = knowledge_marketplace() else {
        return;
    };
    let k = Knowledge::start(&dir).await;
    k.ready().await;
    let skills = Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/voice-skills");
    let preview = testing::workspace_op(
        &k.core,
        "voice_import_scan",
        json!({"path": skills.display().to_string()}),
    )
    .await
    .unwrap();
    let items: Vec<Value> = preview["items"]
        .as_array()
        .unwrap()
        .iter()
        .take(3)
        .map(|i| json!({"applies": i["applies"], "text": i["text"], "from": i["skill"]}))
        .collect();
    assert_eq!(items.len(), 3, "{preview}");
    let imported = testing::workspace_op(&k.core, "voice_import", json!({"items": items}))
        .await
        .unwrap();
    assert_eq!(imported["added"], 3, "{imported}");
    let rules = k.read("Voice/rules.md");
    assert!(rules.starts_with(RULES_PAGE.trim_end()), "{rules}");
    assert_eq!(
        rules.matches("<!-- imported from skill \"").count(),
        3,
        "{rules}"
    );
    for item in &items {
        let text = item["text"].as_str().unwrap();
        let first = text.lines().next().unwrap();
        assert!(rules.contains(first), "{first} in {rules}");
    }
    assert_eq!(testing::voice_refresh(&k.core).await, "ready");
    let copy = testing::voice_copy(&k.core).unwrap();
    let texts: Vec<&str> = copy["rules"]
        .as_array()
        .unwrap()
        .iter()
        .map(|r| r["text"].as_str().unwrap())
        .collect();
    assert_eq!(texts.len(), 5, "{texts:?}");
    for item in &items {
        assert!(
            texts.contains(&item["text"].as_str().unwrap()),
            "{item} in {texts:?}"
        );
    }
    k.nothing_left_this_mac();
    k.microsoft_asked_nothing();
}

/// Build reads only the sent messages Connect synced (`isMine`), never Microsoft or the network.
#[tokio::test]
async fn knowledge_reads_only_synced_sent_messages() {
    let Some(dir) = knowledge_marketplace() else {
        return;
    };
    let k = Knowledge::start_with(
        &dir,
        vec![testing::answer(
            "Writes short, plain mails; signs with a first name.",
        )],
    )
    .await;
    k.ready().await;
    let now = now_s();
    for i in 0..3 {
        testing::synced_message(
            &k.core,
            &format!("s{i}"),
            json!({"channel": "mail", "conversationId": format!("conv-s{i}"), "title": "Pilot",
                   "from": "Taylor Reed", "fromAddress": "taylor@example.test",
                   "to": [{"emailAddress": {"name": "Priya N.", "address": "priya.n@example.test"}}],
                   "isMine": true, "at": now - 3600 * (i + 1), "text": "Hi Priya, sounds good. Thanks, Taylor"}),
        );
    }
    for i in 0..2 {
        testing::synced_message(
            &k.core,
            &format!("c{i}"),
            json!({"channel": "chat", "conversationId": "chat:19:sam", "chatId": "19:sam",
                   "from": "Taylor Reed", "fromId": "me-1", "isMine": true,
                   "at": now - 600 * (i + 1), "text": "ok, on it"}),
        );
    }
    // Not mine: never read.
    k.priya_mail("p5", "Pilot", "Could you share the plan today?");

    // Hand-written card: Build asks first and writes nothing.
    let before = k.read("Voice/style.md");
    let asked = k
        .manager
        .call("knowledge", "build", json!({"ai": false}))
        .await
        .unwrap();
    assert_eq!(asked, json!({"ask": "Replace the style card you edited?"}));
    assert_eq!(k.read("Voice/style.md"), before);

    let built = k
        .manager
        .call("knowledge", "build", json!({"ai": false, "replace": true}))
        .await
        .unwrap();
    assert_eq!(
        built["style"]["basedOn"],
        json!({"mail": 3, "teams": 2}),
        "{built}"
    );
    assert!(
        built["warning"]
            .as_str()
            .unwrap()
            .starts_with("Only 3 mail previews"),
        "{built}"
    );
    let style = k.read("Voice/style.md");
    assert!(
        style.contains("## Mail") && style.contains("## Teams"),
        "{style}"
    );
    assert!(style.contains("basedOn"), "{style}");
    assert!(!style.contains("Could you share the plan"), "{style}");
    assert!(k.runner.calls().is_empty(), "no AI without Ask AI");

    // Ask AI: one tool-free run, played back by the fake runner, adds "In words".
    let built = k
        .manager
        .call("knowledge", "build", json!({"ai": true}))
        .await
        .unwrap();
    assert!(
        built["style"]["text"]
            .as_str()
            .unwrap()
            .contains("## In words"),
        "{built}"
    );
    let runs = k.runner.calls();
    assert_eq!(runs.len(), 1);
    let prompt = runs[0].input.to_string();
    assert!(
        !prompt.contains("priya.n@example.test"),
        "addresses removed: {prompt}"
    );
    assert!(k.read("Voice/style.md").contains("signs with a first name"));

    assert_eq!(testing::voice_refresh(&k.core).await, "ready");
    let copy = testing::voice_copy(&k.core).unwrap();
    assert_eq!(copy["style"]["basedOn"], json!({"mail": 3, "teams": 2}));
    k.nothing_left_this_mac();
    k.microsoft_asked_nothing();
}

/// A knowledge folder that is a git repository: refresh, facts, save and Build leave `.git`
/// byte for byte as it was, and no fact comes from inside it.
#[tokio::test]
async fn knowledge_a_git_folder_is_left_alone() {
    let Some(dir) = knowledge_marketplace() else {
        return;
    };
    let k = Knowledge::start(&dir).await;
    k.write(".git/HEAD", "ref: refs/heads/main\n");
    k.write(".git/config", "[core]\n\tbare = false\n");
    k.write(
        ".git/atlas-rollout.md",
        "# Atlas Rollout\n\nA copy git keeps. Atlas Rollout.\n",
    );
    k.write("projects/atlas-rollout.md", ATLAS_PAGE);
    let git = k.git_files();
    k.ready().await;
    let facts = testing::voice_call(
        &k.core,
        "facts",
        json!({"terms": ["Atlas Rollout"], "personId": null}),
    )
    .await
    .unwrap();
    let ids: Vec<&str> = facts["facts"]
        .as_array()
        .unwrap()
        .iter()
        .map(|f| f["id"].as_str().unwrap())
        .collect();
    assert_eq!(ids, ["projects/atlas-rollout.md"], "{facts}");
    testing::workspace_op(
        &k.core,
        "voice_save",
        json!({"kind": "rule", "applies": {"kind": "everyone"}, "text": "Be brief."}),
    )
    .await
    .unwrap();
    k.manager
        .call("knowledge", "build", json!({"ai": false, "replace": true}))
        .await
        .unwrap();
    assert_eq!(testing::voice_refresh(&k.core).await, "ready");
    assert_eq!(k.git_files(), git, ".git is unchanged");
    let export = testing::voice_call(&k.core, "export", json!({}))
        .await
        .unwrap();
    assert!(!export.to_string().contains(".git"), "{export}");
    k.nothing_left_this_mac();
    k.microsoft_asked_nothing();
}
