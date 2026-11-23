//! Runs the real Todoist plugin from Connect's own marketplace (codemie-connect-marketplace);
//! nothing of it is copied into this repository. Skips, with a message, when the folder isn't
//! there.
//!
//! - `CONNECT_MARKETPLACE_DIR` (default `$HOME/repos/codemie-ai/codemie-connect-marketplace`): the
//!   marketplace folder. The plugin is installed from a temp copy of it into a temp data root,
//!   loaded by the real `PluginManager` into the real host, and asked by the real `task_sync` over
//!   a real `Core`. Only Todoist is faked: `FakeTodoist` on loopback, reached through
//!   `HttpClient::for_tests` as `api.todoist.com` after the host checked the plugin may reach
//!   that host. The token is a sentinel; no real Todoist is ever called.
use app_lib::plugins::git::CliGit;
use app_lib::plugins::host::Limits;
use app_lib::plugins::install::{self, sheet_hash, Agreement};
use app_lib::plugins::manager::PluginManager;
use app_lib::plugins::market;
use app_lib::plugins::registry::PluginPaths;
use app_lib::plugins::services::Outside;
use app_lib::testing::{self, Core, FakeGh, FakeRunner, FakeTodoist, HttpClient, Picked};
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
    let dir = std::env::var_os("CONNECT_MARKETPLACE_DIR")
        .map(PathBuf::from)
        .or_else(|| {
            std::env::var_os("HOME")
                .map(|h| PathBuf::from(h).join("repos/codemie-ai/codemie-connect-marketplace"))
        })?;
    if dir.join(market::CATALOG_FILE).is_file() && dir.join("plugins/todoist").is_dir() {
        Some(dir)
    } else {
        eprintln!(
            "skipped: {} has no Todoist plugin (set CONNECT_MARKETPLACE_DIR)",
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
        json!({"id": PROVIDER, "name": "Todoist", "on": true, "ready": true})
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

    // Todoist asks Connect to slow down: nothing is sent before Retry-After.
    c.todoist.fail_once("POST /sync", 429, Some(5));
    let summary = testing::task_sync(&c.core, T0 + 200).await;
    assert!(summary.starts_with("Tasks rate_limited"), "{summary}");
    let provider = testing::task_provider(&c.core);
    assert_eq!(provider["state"], "rate_limited");
    assert_eq!(provider["retryAt"], T0 + 200 + 5);
    let before = c.todoist.requests().len();
    testing::task_sync(&c.core, T0 + 202).await;
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
