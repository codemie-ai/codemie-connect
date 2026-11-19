//! Reads and runs the real Echo plugins; nothing of those plugins is copied into this repository.
//! Each directory skips on its own, with a message, when it isn't there.
//!
//! - `CONNECT_ECHO_PLUGINS_DIR` (default `$HOME/AI/projects/other/echo-plugins/plugins`; the
//!   marketplace folder above it works too): the published plugins (echo-plugins main).
//!   Scheduler, GitHub, Knowledge (`obsidian`) and Telegram must parse, have a sheet with nothing
//!   blocking, and fit Connect's plugin engine and the Echo API it provides (`ECHO_COMPAT`). Then
//!   each one's real `main.js` runs (Task 25's conformance): installed from a temp copy of the
//!   marketplace into a temp data root, loaded by the real `PluginManager` into the real host
//!   with Connect's real services over a real `Core`, and only what is outside Connect faked:
//!   Claude (`FakeRunner`), the network (an offline client that records what it was asked to
//!   send), the folder picker and the GitHub CLI. Knowledge's flow grows with each Echo 0.10
//!   member Connect adds (docs/superpowers/plans/2026-11-18-knowledge-plugin-in-connect.md).
//!
//! Each directory's parent holds its `echo-marketplace.json`, so it is also added as a local
//! marketplace and installed from, into a temp data root.
use app_lib::plugins::capabilities::{sheet, Support};
use app_lib::plugins::git::CliGit;
use app_lib::plugins::host::{ErrorCode, Limits};
use app_lib::plugins::install::{self, sheet_hash, Agreement, Outcome};
use app_lib::plugins::manager::PluginManager;
use app_lib::plugins::manifest::{check_compat, parse_manifest, ManifestError, ECHO_COMPAT};
use app_lib::plugins::market;
use app_lib::plugins::registry::{Market, PluginPaths, Registry};
use app_lib::plugins::services::Outside;
use app_lib::plugins::tree::tree_hash;
use app_lib::testing::{self, Core, FakeGh, FakeRunner, HttpClient, Picked, Recorded};
use serde_json::{json, Value};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, OnceLock};

const PUBLISHED: [&str; 4] = ["scheduler", "github", "obsidian", "telegram"];

/// A plugins folder named by `var`: a marketplace folder is taken as its `plugins/`.
fn dir(var: &str, default_under_home: &str) -> Option<PathBuf> {
    let d = std::env::var_os(var)
        .map(PathBuf::from)
        .or_else(|| std::env::var_os("HOME").map(|h| PathBuf::from(h).join(default_under_home)))?;
    if d.join(market::CATALOG_FILE).is_file() && d.join("plugins").is_dir() {
        return Some(d.join("plugins"));
    }
    if d.is_dir() {
        Some(d)
    } else {
        eprintln!("skipped: {} not found (set {var})", d.display());
        None
    }
}

fn published() -> Option<PathBuf> {
    dir(
        "CONNECT_ECHO_PLUGINS_DIR",
        "AI/projects/other/echo-plugins/plugins",
    )
}

#[test]
fn published_manifests_parse_and_none_is_blocked() {
    let Some(dir) = published() else {
        return;
    };
    for id in PUBLISHED {
        let m = parse_manifest(&dir.join(id)).unwrap_or_else(|e| panic!("{id}: {e}"));
        assert_eq!(m.id, id);
        let lines = sheet(&m).unwrap_or_else(|e| panic!("{id}: {e}"));
        assert!(!lines.is_empty(), "{id}");
        assert!(
            lines
                .iter()
                .all(|l| !matches!(l.support, Support::Blocking(_))),
            "{id} must not be blocked: {lines:?}"
        );
        check_compat(&m).unwrap_or_else(|e| panic!("{id}: {e}"));
    }
}

#[test]
fn knowledge_needs_the_echo_api_connect_provides() {
    let Some(dir) = published() else {
        return;
    };
    let m = parse_manifest(&dir.join("obsidian")).unwrap();
    assert_eq!(m.name, "Knowledge");
    // Knowledge 1.1.0 says `"echo": ">=0.10.1"`; Connect gives plugins Echo 0.10.1's API.
    let echo = m.echo.clone().expect("Knowledge names the Echo it needs");
    assert!(echo.matches(&semver::Version::parse(ECHO_COMPAT).unwrap()));
    check_compat(&m).unwrap();
    // A Knowledge made for a newer Echo would be listed as needing a newer Connect.
    let mut newer = m.clone();
    newer.echo = Some(semver::VersionReq::parse(">=0.11.0").unwrap());
    assert!(matches!(
        check_compat(&newer),
        Err(ManifestError::NeedsNewerConnect { .. })
    ));
}

/// The marketplace a plugins directory belongs to (its parent), added to a temp data root.
fn local_market(plugins: &Path) -> Option<(tempfile::TempDir, PluginPaths, Market)> {
    let root = plugins.parent()?;
    if !root.join(market::CATALOG_FILE).is_file() {
        eprintln!("skipped: no {} in {}", market::CATALOG_FILE, root.display());
        return None;
    }
    let tmp = tempfile::tempdir().unwrap();
    let data = tmp.path().join("data");
    std::fs::create_dir_all(&data).unwrap();
    let paths = PluginPaths::new(&data, &tmp.path().join("private"));
    // A folder is read where it is: nothing is fetched.
    let m = market::add(&paths, &CliGit::default(), root.to_str().unwrap()).unwrap();
    Some((tmp, paths, m))
}

#[test]
fn published_plugins_install_from_their_local_marketplace() {
    let Some(dir) = published() else {
        return;
    };
    let Some((_tmp, paths, m)) = local_market(&dir) else {
        return;
    };
    // Its catalog is named like the built-in one, so it gets the next free name.
    assert_eq!(m.name, "onetest-2");
    for id in PUBLISHED {
        let offer = install::offer(&paths, &m, id).unwrap();
        assert!(offer.refusal.is_none(), "{id}: {:?}", offer.refusal);
        let agreed: Vec<String> = offer.sheet.iter().map(|l| l.key.clone()).collect();
        let hash = sheet_hash(&offer.sheet);
        let agreement = Agreement {
            keys: &agreed,
            sheet_hash: &hash,
        };
        let out = install::install(&paths, &m.name, id, agreement).unwrap();
        assert!(matches!(out, Outcome::Installed(ref got) if got == id));
        let reg = Registry::load(&paths).unwrap();
        let p = &reg.installed[id];
        let copy = paths.installed().join(id).join(&p.version);
        assert_eq!(p.hash, tree_hash(&copy).unwrap(), "{id}");
        assert_eq!(p.hash, tree_hash(&dir.join(id)).unwrap(), "{id}");
        let mut want = agreed.clone();
        want.sort();
        assert_eq!(p.agreed, want, "{id}");
        assert!(p.enabled);
    }
    for id in PUBLISHED {
        install::remove(&paths, id, true).unwrap();
    }
    assert!(Registry::load(&paths).unwrap().installed.is_empty());
    assert_eq!(std::fs::read_dir(paths.installed()).unwrap().count(), 0);
    assert_eq!(
        std::fs::read_dir(paths.root.join("tmp")).unwrap().count(),
        0
    );
}

#[test]
fn knowledge_installs_with_an_honest_sheet() {
    let Some(dir) = published() else {
        return;
    };
    let Some((_tmp, paths, m)) = local_market(&dir) else {
        return;
    };
    let offer = install::offer(&paths, &m, "obsidian").unwrap();
    assert!(offer.refusal.is_none(), "{:?}", offer.refusal);
    let line = |k: &str| {
        offer
            .sheet
            .iter()
            .find(|l| l.key == k)
            .unwrap_or_else(|| panic!("no {k} line: {:?}", offer.sheet))
            .clone()
    };
    // What Connect does for it, and what it doesn't, line by line.
    assert_eq!(line("skills").support, Support::Supported);
    assert_eq!(
        line("skills").text,
        "Add a skill to your own Claude Code, only when you click and confirm"
    );
    assert_eq!(
        line("m365").text,
        "Read your Outlook mail and Teams chats, never send"
    );
    assert_eq!(line("sessions").support, Support::Unsupported);
    assert!(line("network")
        .text
        .ends_with("fetch one web page from an address you type in Connect's box"));
    assert!(line("events")
        .text
        .contains("Connect doesn't have: recording_started, recording_stopped"));
    assert!(line("echo").text.contains("your name and email address"));
    assert!(offer
        .sheet
        .iter()
        .all(|l| !matches!(l.support, Support::Blocking(_))));
    let keys: Vec<String> = offer.sheet.iter().map(|l| l.key.clone()).collect();
    let hash = sheet_hash(&offer.sheet);
    let agreement = Agreement {
        keys: &keys,
        sheet_hash: &hash,
    };
    let out = install::install(&paths, &m.name, "obsidian", agreement).unwrap();
    assert!(matches!(out, Outcome::Installed(ref got) if got == "obsidian"));
    let reg = Registry::load(&paths).unwrap();
    // The version the marketplace publishes (1.0.1, 1.1.0 …), as installed.
    let published = parse_manifest(&dir.join("obsidian")).unwrap();
    assert_eq!(
        reg.installed["obsidian"].version,
        published.version.to_string()
    );
}

// ------------------------------------------------------------------ the plugins running (Task 25)

/// Every log line, for what plugins and the host say only there: a plugin's `ctx.log`, and the
/// host's note of a service Connect answered `unsupported`.
struct Capture(Mutex<Vec<String>>);

impl log::Log for Capture {
    fn enabled(&self, _: &log::Metadata) -> bool {
        true
    }
    fn log(&self, record: &log::Record) {
        let line = format!("{} {}", record.level(), record.args());
        self.0.lock().unwrap().push(line);
    }
    fn flush(&self) {}
}

fn captured() -> &'static Capture {
    static CAPTURE: OnceLock<&'static Capture> = OnceLock::new();
    CAPTURE.get_or_init(|| {
        let capture: &'static Capture = Box::leak(Box::new(Capture(Mutex::default())));
        log::set_logger(capture).expect("one logger for this test binary");
        log::set_max_level(log::LevelFilter::Info);
        capture
    })
}

/// The log lines of one plugin (`[plugin:<id>] …`).
fn lines_of(id: &str) -> Vec<String> {
    let tag = format!("[plugin:{id}]");
    let lines = captured().0.lock().unwrap();
    lines.iter().filter(|l| l.contains(&tag)).cloned().collect()
}

/// Copies a marketplace folder, leaving out its git repository (`.git`); the plugins' own hidden
/// files (Knowledge's starter `.claude/skills`, `.obsidian`) come along, as a clone has them.
fn copy_market(from: &Path, to: &Path) {
    std::fs::create_dir_all(to).unwrap();
    for entry in std::fs::read_dir(from).unwrap().flatten() {
        if entry.file_name() == ".git" {
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

/// Connect with the four published plugins installed (every sheet agreed to) and loaded.
struct Connect {
    /// The marketplace copy, the data root and anything a test makes (a vault).
    tmp: tempfile::TempDir,
    core: Arc<Core>,
    manager: Arc<PluginManager>,
    runner: Arc<FakeRunner>,
    /// What the plugins asked the network for: nothing is ever sent.
    sent: Recorded,
    picker: Arc<Picked>,
    gh: Arc<FakeGh>,
}

impl Connect {
    /// Claude answers `answers`, in order.
    async fn start(plugins: &Path, answers: &[&str]) -> Connect {
        Connect::start_with(plugins, answers, HttpClient::offline()).await
    }

    /// As `start`, the network answering a plain GET of `pages` (`web.read`).
    async fn start_with_pages(
        plugins: &Path,
        answers: &[&str],
        pages: &[(&str, u16, &str, &[u8])],
    ) -> Connect {
        Connect::start_with(plugins, answers, HttpClient::canned(pages)).await
    }

    async fn start_with(
        plugins: &Path,
        answers: &[&str],
        (http, sent): (HttpClient, Recorded),
    ) -> Connect {
        captured();
        // Not a hidden folder (`.tmpXXXX`): Knowledge, like Echo, never changes a vault inside one.
        let tmp = tempfile::Builder::new()
            .prefix("connect-")
            .tempdir()
            .unwrap();
        let copy = tmp.path().join("market");
        copy_market(plugins.parent().unwrap(), &copy);
        let script = answers.iter().map(|a| testing::answer(a)).collect();
        let runner = Arc::new(FakeRunner::new(script));
        let core = testing::core(
            &tmp.path().join("data"),
            runner.clone(),
            vec![testing::claude_profile()],
        );
        testing::choose_profile(&core, "claude");
        let paths = PluginPaths::new(&core.paths.data, &core.paths.private);
        let m = market::add(&paths, &CliGit::default(), copy.to_str().unwrap()).unwrap();
        for id in PUBLISHED {
            let offer = install::offer(&paths, &m, id).unwrap();
            assert!(offer.refusal.is_none(), "{id}: {:?}", offer.refusal);
            let keys: Vec<String> = offer.sheet.iter().map(|l| l.key.clone()).collect();
            let hash = sheet_hash(&offer.sheet);
            let agreement = Agreement {
                keys: &keys,
                sheet_hash: &hash,
            };
            install::install(&paths, &m.name, id, agreement).unwrap();
        }
        let picker = Arc::new(Picked::default());
        let gh = Arc::new(FakeGh::default());
        let outside = Outside {
            picker: picker.clone(),
            signin: gh.clone(),
            http,
        };
        let manager = PluginManager::new(core.clone(), outside, Limits::default());
        manager.reload().await;
        Connect {
            tmp,
            core,
            manager,
            runner,
            sent,
            picker,
            gh,
        }
    }

    async fn call(&self, id: &str, command: &str, args: Value) -> Value {
        self.manager
            .call(id, command, args)
            .await
            .unwrap_or_else(|e| panic!("{id} {command}: {e}"))
    }

    /// Today's records of `kind` (`plugin_item`, `plugin_widget`) by id.
    fn record(&self, kind: &str, id: &str) -> Option<Value> {
        testing::records(&self.core, kind)
            .into_iter()
            .find(|(rid, _)| rid == id)
            .map(|(_, data)| data)
    }

    fn sent(&self) -> Vec<String> {
        self.sent.lock().unwrap().clone()
    }

    /// The arguments the Claude Code CLI would have got for each run.
    fn runs(&self) -> Vec<(Value, Vec<String>)> {
        self.runner
            .calls()
            .iter()
            .map(|spec| (spec.input.clone(), testing::command_args(spec)))
            .collect()
    }
}

/// The value after `--tools` on a Claude command line: "" is a run with no tools.
fn tools_of(args: &[String]) -> Option<&str> {
    let at = args.iter().position(|a| a == "--tools")?;
    args.get(at + 1).map(String::as_str)
}

#[tokio::test]
async fn scheduler_routine_runs_claude_tool_free_and_delivers_today() {
    let Some(dir) = published() else {
        return;
    };
    let c = Connect::start(
        &dir,
        &["**Three asks** are open:\n\n- the budget\n- the review"],
    )
    .await;
    let routine = json!({"routine": {
        "name": "Monday asks", "schedule": "mon 09:00", "tools": "read",
        "deliver": ["today"], "prompt": "What do I owe people this week?",
    }});
    let saved = c.call("scheduler", "save", routine).await;
    assert_eq!(saved["id"], "monday-asks");

    let run = c
        .call("scheduler", "run_wait", json!({"id": "monday-asks"}))
        .await;
    assert_eq!(run["state"], "done", "{run}");
    assert_eq!(run["sent"], json!(["today"]));
    assert_eq!(run["model"], "claude-sonnet-4");

    // One Claude run, with no tools whatever the routine asked for, carrying the user's prompt.
    let runs = c.runs();
    assert_eq!(runs.len(), 1);
    let (input, args) = &runs[0];
    assert_eq!(tools_of(args), Some(""), "{args:?}");
    let request = input["request"].as_str().unwrap();
    assert!(request.contains("“Monday asks”"), "{request}");
    assert!(
        request.contains("What do I owe people this week?"),
        "{request}"
    );
    let ai_runs = testing::records(&c.core, "ai_run");
    assert_eq!(ai_runs.len(), 1);
    assert_eq!(ai_runs[0].1["plugin"], "scheduler");
    // The published Scheduler takes the routine's `read` as `auto` itself (its `toolsOf`).
    assert_eq!(ai_runs[0].1["tools"], "auto");

    // Its answer is a card on Today, named by the routine.
    let cards: Vec<Value> = testing::records(&c.core, "plugin_item")
        .into_iter()
        .map(|(_, d)| d)
        .filter(|d| d["type"] == "delivery" && d["plugin"] == "scheduler")
        .collect();
    assert_eq!(cards.len(), 1, "{cards:?}");
    assert_eq!(cards[0]["to"], "today");
    assert_eq!(cards[0]["title"], "Monday asks");
    assert_eq!(cards[0]["about"], "Routine · Monday asks");
    assert!(cards[0]["markdown"]
        .as_str()
        .unwrap()
        .contains("Three asks"));
    // The routine's page sees the run, and the answer's copy is in its store.
    let view = c.call("scheduler", "view", json!({})).await;
    let mine = &view["routines"][0];
    assert_eq!(mine["id"], "monday-asks");
    assert_eq!(mine["last"]["state"], "done");
    let detail = c
        .call(
            "scheduler",
            "run_detail",
            json!({"id": "monday-asks", "run": mine["runs"][0]["run"]}),
        )
        .await;
    assert!(detail["answer"].as_str().unwrap().contains("Three asks"));
    assert!(c.sent().is_empty(), "{:?}", c.sent());
}

#[tokio::test]
async fn github_without_signin_shows_prompt_and_makes_no_requests() {
    let Some(dir) = published() else {
        return;
    };
    let c = Connect::start(&dir, &[]).await;
    // The GitHub CLI on this computer is signed in, but the user never pressed Sign in.
    *c.gh.token.lock().unwrap() = Some("gho_synthetic_never_read".into());

    let status = c.call("github", "status", json!({})).await;
    assert_eq!(status["signedIn"], false, "{status}");
    assert_eq!(status["echoCanSignIn"], true);
    assert_eq!(status["sources"], json!({"gh": true, "git": false}));

    // Today's widgets ask the user to sign in.
    c.manager.tick().await;
    let prompt = "Sign in to GitHub on this computer (gh auth login), then Refresh";
    let repos = c.record("plugin_widget", "github:repos").unwrap();
    assert_eq!(repos["data"]["empty"], prompt, "{repos}");
    assert_eq!(repos["data"]["items"], json!([]));
    let ci = c.record("plugin_widget", "github:ci").unwrap();
    assert_eq!(ci["data"]["state"], "warn");
    assert_eq!(ci["data"]["text"], prompt);
    let glance = c.record("plugin_widget", "github:glance").unwrap();
    assert_eq!(glance["data"]["items"][0]["label"], "Sign in to GitHub");
    let work = c.record("plugin_widget", "github:work").unwrap();
    assert_eq!(work["rows"], json!([]));

    // Picking a repo, refreshing and looking for repos to pick: still nothing is asked of
    // GitHub, and the computer's sign-in is never read without the user's click.
    let picks = c
        .call("github", "pick", json!({"entry": "octo-org/hello"}))
        .await;
    assert_eq!(picks, json!(["octo-org/hello"]));
    assert_eq!(c.call("github", "refresh", json!({})).await, json!(true));
    assert_eq!(
        c.call("github", "discover", json!({"force": true})).await,
        Value::Null
    );
    assert_eq!(
        c.call("github", "status", json!({})).await["signedIn"],
        false
    );
    assert!(c.sent().is_empty(), "{:?}", c.sent());
    assert_eq!(c.gh.read_count(), 0);
    assert!(c.runner.calls().is_empty());
}

/// A small vault: a person, a project linking to them, a daily note and Obsidian's settings.
fn fixture_vault(root: &Path) {
    let files = [
        (".obsidian/app.json", r#"{"attachmentFolderPath": "Files"}"#),
        (".obsidian/daily-notes.json", r#"{"folder": "Daily"}"#),
        (
            "People/Ann Lee.md",
            "---\ntype: person\nrole: Design lead\n---\n# Ann Lee\n\nLeads design on [[Atlas]]. #team/design\n",
        ),
        (
            "Projects/Atlas.md",
            "---\ntype: project\nstatus: active\n---\n# Atlas\n\nOwner: [[Ann Lee]]. #project\n\n- [ ] Ship the beta\n",
        ),
        ("Daily/2026-11-16.md", "# Monday\n\nTalked to [[Ann Lee]].\n"),
        ("README.md", "# Team wiki\n\nPeople, projects and decisions.\n"),
    ];
    for (path, text) in files {
        let f = root.join(path);
        std::fs::create_dir_all(f.parent().unwrap()).unwrap();
        std::fs::write(f, text).unwrap();
    }
}

#[tokio::test]
async fn obsidian_walks_fixture_vault_sets_inbox_and_survives_unsupported_agent_calls() {
    let Some(dir) = published() else {
        return;
    };
    let description = json!({
        "kind": "team",
        "when": "Questions about the Atlas project and the people on it",
        "what": "A small team wiki: people and projects.",
        "where": "People/ and Projects/",
        "how": "Frontmatter type, wiki links, tags",
        "can": "Answer and cite notes",
        "leave": "Daily/",
        "belongs": [],
    });
    let c = Connect::start(&dir, &[&description.to_string()]).await;
    let vault = c.tmp.path().join("Team Wiki");
    fixture_vault(&vault);
    c.picker.next(&vault);

    let added = c.call("obsidian", "add", json!({"wait": true})).await;
    assert_eq!(added, json!({"id": "team-wiki"}));

    // It walked the vault and described it with one tool-free run that saw the survey.
    let runs = c.runs();
    assert_eq!(runs.len(), 1);
    let (input, args) = &runs[0];
    assert_eq!(tools_of(args), Some(""), "{args:?}");
    let request = input["request"].as_str().unwrap();
    assert!(request.contains("“Team Wiki”"), "{request}");
    assert!(request.contains(r#""notes":4"#), "{request}");
    assert!(request.contains("### People/Ann Lee.md"), "{request}");
    assert!(request.contains(r#""is_vault":true"#), "{request}");

    // The description waits for the user's look: an Inbox item on Today.
    let item = c
        .record("plugin_item", "obsidian:inbox:review:team-wiki")
        .expect("the review item");
    assert_eq!(
        item["title"],
        "Check what Claude will be told about Team Wiki"
    );
    let view = c.call("obsidian", "view", json!({})).await;
    let v = &view["vaults"][0];
    assert_eq!(v["state"], "review", "{v}");
    assert_eq!(v["notes"], 4);
    assert_eq!(v["description"]["when"], description["when"]);
    assert_eq!(view["threads"], json!([]));

    // Its index answers from the vault: who links to Ann Lee.
    let back = c
        .call(
            "obsidian",
            "backlinks",
            json!({"vault": "team-wiki", "note": "People/Ann Lee"}),
        )
        .await;
    let from: Vec<&str> = back["links"]
        .as_array()
        .unwrap()
        .iter()
        .map(|l| l["path"].as_str().unwrap())
        .collect();
    assert_eq!(from, ["Daily/2026-11-16.md", "Projects/Atlas.md"], "{back}");

    // Confirmed: published again (Echo's sessions, agent and hints are absent here, and each
    // of those calls fails inside the plugin's own guard), the item goes, the plugin keeps going.
    assert_eq!(
        c.call("obsidian", "confirm", json!({"id": "team-wiki"}))
            .await,
        json!(true)
    );
    assert!(c
        .record("plugin_item", "obsidian:inbox:review:team-wiki")
        .is_none());
    let logged = lines_of("obsidian");
    for step in ["skill:", "agent:", "folders:", "hints:"] {
        assert!(
            logged
                .iter()
                .any(|l| l.contains(step) && l.contains("undefined")),
            "{step} {logged:?}"
        );
    }
    assert_eq!(c.manager.loaded(), ["github", "obsidian", "scheduler"]);
    let view = c.call("obsidian", "view", json!({})).await;
    assert_eq!(view["vaults"][0]["state"], "ready");
    assert!(c.sent().is_empty(), "{:?}", c.sent());
}

#[tokio::test]
async fn telegram_fails_to_load_with_a_clear_unsupported_sessions_error() {
    let Some(dir) = published() else {
        return;
    };
    let c = Connect::start(&dir, &[]).await;
    let problems = c.manager.problems();
    assert_eq!(problems.keys().collect::<Vec<_>>(), ["telegram"]);
    assert_eq!(
        problems["telegram"],
        "unsupported: CodeMie Connect doesn't have ctx.sessions (only Echo has it), so this \
         plugin needs a change to run here: cannot read property 'clearChannel' of undefined"
    );

    // The host stays healthy: the other three are loaded and answer; Telegram isn't on, and
    // nothing of it is left behind (its delivery way, its Today items).
    assert_eq!(c.manager.loaded(), ["github", "obsidian", "scheduler"]);
    let refused = c
        .manager
        .call("telegram", "status", json!({}))
        .await
        .unwrap_err();
    assert_eq!(refused.code, ErrorCode::NotFound);
    let scheduler = c.call("scheduler", "view", json!({})).await;
    assert_eq!(scheduler["deliver"]["provided"], json!([]), "{scheduler}");
    assert!(
        c.call("scheduler", "templates", json!({}))
            .await
            .as_array()
            .unwrap()
            .len()
            >= 4
    );
    assert_eq!(
        c.call("github", "status", json!({})).await["signedIn"],
        false
    );
    assert_eq!(
        c.call("obsidian", "view", json!({})).await["vaults"],
        json!([])
    );
    assert!(testing::records(&c.core, "plugin_item")
        .iter()
        .all(|(id, _)| !id.starts_with("telegram:")));

    // Loading again fails the same way, and changes nothing for the others.
    c.manager.reload().await;
    assert_eq!(c.manager.problems(), problems);
    assert_eq!(c.manager.loaded(), ["github", "obsidian", "scheduler"]);
    assert!(c.sent().is_empty(), "{:?}", c.sent());
}

#[tokio::test]
async fn all_four_load_without_unknown_capability_errors() {
    let Some(dir) = published() else {
        return;
    };
    // Every `uses` key, `echo.read` kind and event they ask for is one Connect knows.
    for id in PUBLISHED {
        let m = parse_manifest(&dir.join(id)).unwrap();
        sheet(&m).unwrap_or_else(|e| panic!("{id}: {e}"));
    }
    let c = Connect::start(&dir, &[]).await;
    assert_eq!(c.manager.loaded(), ["github", "obsidian", "scheduler"]);
    // Telegram's one problem is the Echo-only API it calls, which needs a change in the plugin
    // (PLUGIN-ENGINE.md §10): not a capability Connect doesn't know.
    let problems = c.manager.problems();
    assert_eq!(problems.len(), 1, "{problems:?}");
    assert!(
        problems["telegram"].starts_with("unsupported: CodeMie Connect doesn't have ctx.sessions")
    );

    // Running: Today's providers asked, and each one's page data read.
    c.manager.tick().await;
    c.call("scheduler", "view", json!({})).await;
    c.call("scheduler", "templates", json!({})).await;
    c.call("github", "status", json!({})).await;
    c.call("obsidian", "view", json!({"window": true})).await;
    c.call("obsidian", "kn", json!({})).await;

    // No service any of them reached was one Connect lacks, and every event was granted.
    for id in PUBLISHED {
        let refused: Vec<String> = lines_of(id)
            .into_iter()
            .filter(|l| {
                l.contains("is not available in CodeMie Connect yet")
                    || l.contains("Connect doesn't share")
                    || l.contains("ctx.on(")
            })
            .collect();
        assert!(refused.is_empty(), "{id}: {refused:?}");
    }
    for id in ["github", "obsidian", "scheduler"] {
        assert!(c
            .manager
            .call(id, "no-such-command", json!({}))
            .await
            .is_err());
    }
    assert!(c.sent().is_empty(), "{:?}", c.sent());
}

/// Knowledge's fixture vault with an attachment, a link to a page that isn't there and a table.
fn fixture_vault_with_media(root: &Path) {
    fixture_vault(root);
    std::fs::create_dir_all(root.join("Files")).unwrap();
    std::fs::write(root.join("Files/chart.png"), b"\x89PNG").unwrap();
    std::fs::write(
        root.join("Projects/Atlas.md"),
        "---\ntype: project\nstatus: active\n---\n# Atlas\n\nOwner: [[Ann Lee]]. See [[Nowhere]].\n\n\
         ![[chart.png]]\n\n| Phase | Due |\n|---|---|\n| Beta | May |\n\n- [ ] Ship the beta\n",
    )
    .unwrap();
}

/// A description Claude gives for a vault (the one tool-free run `add` makes).
fn described() -> String {
    json!({"kind": "team", "when": "Questions about Atlas", "what": "A team wiki", "where": "People/, Projects/",
           "how": "Wiki links", "can": "Answer", "leave": "Daily/", "belongs": []})
    .to_string()
}

#[tokio::test]
async fn knowledge_reads_a_vault_home_pages_graph_health_and_find() {
    let Some(dir) = published() else {
        return;
    };
    let c = Connect::start(&dir, &[&described()]).await;
    let vault = c.tmp.path().join("Team Wiki");
    fixture_vault_with_media(&vault);
    c.picker.next(&vault);
    let id = c.call("obsidian", "add", json!({"wait": true})).await["id"]
        .as_str()
        .unwrap()
        .to_string();
    assert_eq!(id, "team-wiki");

    let kn = c.call("obsidian", "kn", json!({})).await;
    let v = &kn["vaults"][0];
    assert_eq!(v["available"], true, "{v}");
    assert_eq!(
        v["read_only"],
        Value::Null,
        "a vault in a plain folder can be changed: {v}"
    );
    assert_eq!(v["detected"]["obsidian"]["attachments"], "Files");

    let tree = c.call("obsidian", "tree", json!({"id": id})).await;
    let pages: Vec<&str> = tree["pages"]
        .as_array()
        .unwrap()
        .iter()
        .map(|p| p["path"].as_str().unwrap())
        .collect();
    assert_eq!(
        pages,
        [
            "Daily/2026-11-16.md",
            "People/Ann Lee.md",
            "Projects/Atlas.md",
            "README.md"
        ]
    );

    // A page: its wiki link to a page of the vault is its Knowledge route, a missing page is
    // marked, the attachment comes by the frame's image route, the table and task list render.
    let page = c
        .call(
            "obsidian",
            "page",
            json!({"id": id, "path": "Projects/Atlas.md"}),
        )
        .await;
    let html = page["html"].as_str().unwrap();
    assert!(
        html.contains(r##"href="#obsidian:knowledge/team-wiki/pages/People/Ann%20Lee.md""##),
        "{html}"
    );
    assert!(html.contains(r#"data-md-missing="Nowhere""#), "{html}");
    let root = urlencoding(vault.canonicalize().unwrap().to_str().unwrap());
    assert!(
        html.contains(&format!(
            r#"src="plugin/obsidian/folder/{root}/Files/chart.png""#
        )),
        "{html}"
    );
    assert!(
        html.contains("<table>") && html.contains("type=\"checkbox\""),
        "{html}"
    );
    assert!(!html.contains("<script"), "{html}");

    let graph = c
        .call("obsidian", "graph", json!({"id": id, "mode": "links"}))
        .await;
    assert!(graph["edges"]
        .as_array()
        .unwrap()
        .contains(&json!(["Projects/Atlas.md", "People/Ann Lee.md"])));

    // Health in code alone: no Claude run beyond the description.
    let health = c.call("obsidian", "health", json!({"id": id})).await;
    let kinds: Vec<&str> = health["findings"]
        .as_array()
        .unwrap()
        .iter()
        .map(|f| f["kind"].as_str().unwrap())
        .collect();
    assert!(kinds.contains(&"broken"), "{kinds:?}");
    assert!(kinds.contains(&"not_in_index"), "{kinds:?}");
    assert_eq!(c.runs().len(), 1);

    let found = c
        .call("obsidian", "find", json!({"id": id, "q": "Atlas"}))
        .await;
    assert_eq!(found["hits"][0]["path"], "Projects/Atlas.md");
    let home = c.call("obsidian", "home", json!({"id": id})).await;
    assert_eq!(home["vault"]["pages"], 4);
    assert_eq!(home["vault"]["obsidian"], true);
    // The page's revision for the 2 s poll.
    let rev = c.call("obsidian", "rev", json!({"id": id})).await;
    assert_eq!(rev["rev"], tree["rev"]);
    let logged = lines_of("obsidian");
    assert!(
        logged
            .iter()
            .all(|l| !l.contains("is not available in CodeMie Connect")),
        "{logged:?}"
    );
    assert!(c.sent().is_empty(), "{:?}", c.sent());
}

/// `encodeURIComponent` as the plugin writes a root into its image route.
fn urlencoding(text: &str) -> String {
    text.bytes()
        .map(|b| match b {
            b'A'..=b'Z'
            | b'a'..=b'z'
            | b'0'..=b'9'
            | b'-'
            | b'_'
            | b'.'
            | b'!'
            | b'~'
            | b'*'
            | b'\''
            | b'('
            | b')' => (b as char).to_string(),
            _ => format!("%{b:02X}"),
        })
        .collect()
}

#[tokio::test]
async fn knowledge_writes_pages_with_git_history_and_takes_picked_files() {
    let Some(dir) = published() else {
        return;
    };
    let c = Connect::start(&dir, &[&described(), &described()]).await;
    // The twin preset makes a new vault, with its own git repository, in a folder the user picks.
    let folder = c.tmp.path().join("My Twin");
    std::fs::create_dir_all(&folder).unwrap();
    c.picker.next(&folder);
    let made = c
        .call(
            "obsidian",
            "new_vault",
            json!({"name": "My Twin", "git": true, "minutes": "auto"}),
        )
        .await;
    assert_eq!(made["git"], "committed", "{made}");
    assert_eq!(made["left_out"], json!([]), "{made}");
    let id = made["id"].as_str().unwrap().to_string();
    let root = Path::new(made["root"].as_str().unwrap()).to_path_buf();
    assert!(root.join(".git").is_dir());
    assert!(
        root.join(".gitignore").is_file(),
        "the preset's hidden files are written"
    );
    c.call(
        "obsidian",
        "set",
        json!({"id": id, "key": "commit", "value": "true"}),
    )
    .await;

    // Edit a page over the text it was opened with; an edit over a stale copy is a conflict.
    let page = c
        .call("obsidian", "page", json!({"id": id, "path": "CATALOG.md"}))
        .await;
    let base = page["base"].clone();
    assert_eq!(page["editable"], true, "{page}");
    let original = std::fs::read_to_string(root.join("knowledge/CATALOG.md")).unwrap();
    let edited = format!("{original}\nEdited in Connect.\n");
    let saved = c
        .call(
            "obsidian",
            "save_page",
            json!({"id": id, "path": "CATALOG.md", "text": edited, "base": base, "message": "Edit the index"}),
        )
        .await;
    assert!(
        saved
            .get("conflict")
            .is_none_or(|x| !x.as_bool().unwrap_or(false)),
        "{saved}"
    );
    assert_eq!(
        std::fs::read_to_string(root.join("knowledge/CATALOG.md")).unwrap(),
        edited
    );
    let stale = c
        .manager
        .call(
            "obsidian",
            "save_page",
            json!({"id": id, "path": "CATALOG.md", "text": "# Gone\n", "base": base, "message": "x"}),
        )
        .await;
    let stale_said = match stale {
        Ok(v) => v.to_string(),
        Err(e) => e.to_string(),
    };
    assert!(
        stale_said.contains("conflict") || stale_said.contains("changed since"),
        "{stale_said}"
    );
    assert_eq!(
        std::fs::read_to_string(root.join("knowledge/CATALOG.md")).unwrap(),
        edited,
        "the stale save wrote nothing"
    );

    // History: the preset's commit and the edit, newest first, each by the plugin; restore the
    // first version over the edit.
    let history = c
        .call(
            "obsidian",
            "history",
            json!({"id": id, "path": "CATALOG.md"}),
        )
        .await;
    let versions = history["versions"].as_array().unwrap();
    assert_eq!(versions.len(), 2, "{history}");
    assert_eq!(versions[0]["echo"], "obsidian");
    let first = versions[1]["rev"].as_str().unwrap().to_string();
    let version = c
        .call(
            "obsidian",
            "version",
            json!({"id": id, "path": "CATALOG.md", "rev": first}),
        )
        .await;
    assert!(version.get("diff").is_some(), "{version}");
    c.call(
        "obsidian",
        "restore",
        json!({"id": id, "path": "CATALOG.md", "rev": first}),
    )
    .await;
    assert_eq!(
        std::fs::read_to_string(root.join("knowledge/CATALOG.md")).unwrap(),
        original
    );

    // A new page, committed.
    let fresh = c
        .call(
            "obsidian",
            "new_page",
            json!({"id": id, "folder": "topics", "title": "Atlas", "template": null, "index_row": true}),
        )
        .await;
    assert!(fresh["commit"].is_string(), "{fresh}");
    assert!(root.join("knowledge/topics/Atlas.md").is_file());

    // A page the index doesn't list, fixed by Fix all.
    std::fs::write(root.join("knowledge/topics/Beta.md"), "# Beta\n").unwrap();
    let health = c.call("obsidian", "health", json!({"id": id})).await;
    let key = health["findings"]
        .as_array()
        .unwrap()
        .iter()
        .find(|f| f["kind"] == "not_in_index" && f["key"].as_str().unwrap().ends_with("Beta.md"))
        .unwrap_or_else(|| panic!("{health}"))["key"]
        .clone();
    // As Health's Fix all sends them: each fix with the text it was shown over (`base`, `sha`).
    let fixes = c
        .call(
            "obsidian",
            "fixes",
            json!({"id": id, "kind": "not_in_index"}),
        )
        .await;
    let items: Vec<Value> = fixes["fixes"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|f| f["key"] == key)
        .map(
            |f| json!({"key": f["key"], "choice": f["choice"], "base": f["base"], "sha": f["sha"]}),
        )
        .collect();
    assert_eq!(items.len(), 1, "{fixes}");
    let fixed = c
        .call("obsidian", "fix_all", json!({"id": id, "items": items}))
        .await;
    assert_eq!(fixed["changed_since"], json!([]), "{fixed}");
    assert!(
        std::fs::read_to_string(root.join("knowledge/CATALOG.md"))
            .unwrap()
            .contains("Beta"),
        "{fixed}"
    );

    // A file the user picks becomes one of Ingest's sources.
    let brief = c.tmp.path().join("Brief.md");
    std::fs::write(&brief, "# Brief\n\nThe Atlas launch is in May.\n").unwrap();
    c.picker.next_files(&[&brief]);
    let added = c
        .call("obsidian", "source_add", json!({"id": id, "kind": "files"}))
        .await;
    assert_eq!(added["added"][0]["path"], "raw_inbox/Brief.md", "{added}");
    let queue = c.call("obsidian", "ingest_queue", json!({"id": id})).await;
    assert_eq!(queue["sources"][0]["path"], "raw_inbox/Brief.md");
    assert_eq!(queue["sources"][0]["state"], "new");
    // Nothing was left uncommitted by the plugin's own writes.
    let status = std::process::Command::new("git")
        .args(["status", "--porcelain"])
        .current_dir(&root)
        .output()
        .unwrap();
    let dirty = String::from_utf8_lossy(&status.stdout).to_string();
    assert!(
        dirty
            .lines()
            .all(|l| l.ends_with("topics/Beta.md") || l.contains("CATALOG.md")),
        "{dirty}"
    );
    assert!(c.sent().is_empty(), "{:?}", c.sent());
}

#[tokio::test]
async fn knowledge_asks_claude_in_the_vault_and_in_a_copy_of_it() {
    let Some(dir) = published() else {
        return;
    };
    let lint = json!({"findings": [{"kind": "contradiction", "title": "Two launch dates",
        "note": "The topic and the brief disagree.",
        "pages": [{"path": "knowledge/topics/Atlas.md", "line": 3, "quote": "The Atlas launch is in June."}]}]})
    .to_string();
    let c = Connect::start(&dir, &[&described(), &lint, "Ingested the brief."]).await;
    // Claude, when it may edit, changes a page in the folder it was started in and says why.
    c.runner.on_run(|spec| {
        let Some(f) = spec.folder.as_ref().filter(|f| f.edit) else {
            return;
        };
        std::fs::write(
            f.dir.join("knowledge/topics/Atlas.md"),
            "# Atlas\n\nThe Atlas launch is in May.\n",
        )
        .unwrap();
        std::fs::create_dir_all(f.dir.join(".echo-ingest")).unwrap();
        let notes = json!({"changes": [{"path": "knowledge/topics/Atlas.md", "why": "The brief dates the launch",
            "quotes": [{"source": "raw_inbox/Brief.md", "text": "The Atlas launch is in May."}]}]});
        std::fs::write(f.dir.join(".echo-ingest/changes.json"), notes.to_string()).unwrap();
    });
    let folder = c.tmp.path().join("My Twin");
    std::fs::create_dir_all(&folder).unwrap();
    c.picker.next(&folder);
    let made = c
        .call(
            "obsidian",
            "new_vault",
            json!({"name": "My Twin", "git": true, "minutes": "auto"}),
        )
        .await;
    let id = made["id"].as_str().unwrap().to_string();
    let root = Path::new(made["root"].as_str().unwrap()).to_path_buf();
    // The starter's own skills are in the vault (the package's hidden files reach it).
    assert!(root.join(".claude/skills/process-inbox/SKILL.md").is_file());
    let atlas = root.join("knowledge/topics/Atlas.md");
    std::fs::write(&atlas, "# Atlas\n\nThe Atlas launch is in June.\n").unwrap();

    // AI checks: read tools in the vault itself; the finding is kept.
    let lint = c
        .call("obsidian", "lint", json!({"id": id, "wait": true}))
        .await;
    assert_eq!(lint["state"], "done", "{lint}");
    assert_eq!(lint["kept"], 1, "{lint}");
    let health = c.call("obsidian", "health", json!({"id": id})).await;
    assert!(
        health["findings"]
            .as_array()
            .unwrap()
            .iter()
            .any(|f| f["kind"] == "contradiction"),
        "{health}"
    );

    // Ingest: the file the user added is run through the vault's skill in a copy; the change
    // waits for review, and only what is approved reaches the vault.
    let brief = c.tmp.path().join("Brief.md");
    std::fs::write(&brief, "# Brief\n\nThe Atlas launch is in May.\n").unwrap();
    c.picker.next_files(&[&brief]);
    c.call("obsidian", "source_add", json!({"id": id, "kind": "files"}))
        .await;
    let run = c
        .call("obsidian", "ingest_go", json!({"id": id, "wait": true}))
        .await;
    assert_eq!(run["state"], "review", "{run}");
    assert_eq!(run["skill"], "process-inbox");
    let run_id = run["run"].clone();
    assert_eq!(
        std::fs::read_to_string(&atlas).unwrap(),
        "# Atlas\n\nThe Atlas launch is in June.\n",
        "nothing reaches the vault before review"
    );
    let changes = c
        .call(
            "obsidian",
            "ingest_changes",
            json!({"id": id, "run": run_id}),
        )
        .await;
    assert_eq!(changes["changes"][0]["path"], "knowledge/topics/Atlas.md");
    assert_eq!(changes["changes"][0]["invented"], 0, "{changes}");
    c.call(
        "obsidian",
        "change",
        json!({"id": id, "run": run_id, "path": "knowledge/topics/Atlas.md", "decision": "approve"}),
    )
    .await;
    let applied = c
        .call("obsidian", "ingest_apply", json!({"id": id, "run": run_id}))
        .await;
    assert_eq!(
        applied["written"],
        json!(["knowledge/topics/Atlas.md"]),
        "{applied}"
    );
    assert_eq!(
        std::fs::read_to_string(&atlas).unwrap(),
        "# Atlas\n\nThe Atlas launch is in May.\n"
    );

    // Three runs: the description tool-free, the checks with read tools, Ingest with edit tools
    // in a copy that is gone afterwards.
    let tools: Vec<Option<String>> = c
        .runs()
        .iter()
        .map(|(_, args)| tools_of(args).map(str::to_string))
        .collect();
    assert_eq!(
        tools,
        [
            Some(String::new()),
            Some("Read,Grep,Glob,Skill".into()),
            Some("Read,Grep,Glob,Skill,Edit,Write".into())
        ]
    );
    let snapshots = c
        .core
        .paths
        .data
        .join("plugins/data/obsidian/store/cache/snapshots");
    assert_eq!(
        std::fs::read_dir(&snapshots).map_or(0, |d| d.count()),
        0,
        "the run's copy was removed"
    );
    assert!(c.sent().is_empty(), "{:?}", c.sent());
}

#[tokio::test]
async fn knowledge_reads_a_web_page_from_the_address_typed_in_connects_box() {
    let Some(dir) = published() else {
        return;
    };
    let page = "<html lang=en><head><title>Atlas</title></head><body><nav>Menu</nav><article>\
        <h1>Atlas launches in May</h1><p>The team ships the beta to the first customers.</p>\
        <img src=\"/img/chart.png\" alt=\"Launch chart\" width=\"640\" height=\"480\"></article></body></html>";
    let c = Connect::start_with_pages(
        &dir,
        &[&described()],
        &[
            (
                "https://news.example.com/atlas",
                200,
                "text/html; charset=utf-8",
                page.as_bytes(),
            ),
            (
                "https://news.example.com/img/chart.png",
                200,
                "image/png",
                b"\x89PNG\r\n",
            ),
        ],
    )
    .await;
    let folder = c.tmp.path().join("My Twin");
    std::fs::create_dir_all(&folder).unwrap();
    c.picker.next(&folder);
    let made = c
        .call(
            "obsidian",
            "new_vault",
            json!({"name": "My Twin", "git": true, "minutes": "auto"}),
        )
        .await;
    let id = made["id"].as_str().unwrap().to_string();
    let root = Path::new(made["root"].as_str().unwrap()).to_path_buf();
    // The site isn't one the user listed: Knowledge hears "may reach only" and asks for the
    // address in Connect's own box, where the user types it.
    *c.picker.2.lock().unwrap() = Some("https://news.example.com/atlas".into());
    let added = c
        .call(
            "obsidian",
            "source_add",
            json!({"id": id, "kind": "web", "url": "https://news.example.com/atlas"}),
        )
        .await;
    let path = added["path"].as_str().unwrap_or_else(|| panic!("{added}"));
    assert!(path.starts_with("raw_inbox/"), "{added}");
    let text = std::fs::read_to_string(root.join(path)).unwrap();
    assert!(
        text.contains("The team ships the beta to the first customers."),
        "{text}"
    );
    assert!(
        !text.contains("Menu"),
        "the page's navigation is left out: {text}"
    );
    // Its picture was saved by Connect and copied beside the page.
    assert_eq!(added["pictures_failed"], 0, "{added}");
    let pictures = std::fs::read_dir(root.join(path).with_extension(""))
        .map(|d| d.count())
        .unwrap_or(0);
    assert_eq!(pictures, 1, "{added}");
    // One read of the page and one of its picture; nothing else went out.
    assert_eq!(
        c.sent(),
        [
            "GET https://news.example.com/atlas",
            "GET https://news.example.com/img/chart.png"
        ]
    );
    // The typed address was good once: Knowledge's next read of it needs the box again.
    let again = c
        .manager
        .call(
            "obsidian",
            "source_add",
            json!({"id": id, "kind": "web", "url": "https://news.example.com/atlas"}),
        )
        .await;
    let said = match again {
        Ok(v) => v.to_string(),
        Err(e) => e.to_string(),
    };
    assert!(
        said.contains("cancelled") || said.contains("in the vault already"),
        "{said}"
    );
}

/// Knowledge over a real vault the developer names (`KN_MY_VAULT`, a copy: Knowledge may write its
/// index there). Prints counts and timings only, never a page's title or text. Run by hand:
/// `KN_MY_VAULT=<copy> cargo test --test echo_plugins my_vault -- --ignored --nocapture`.
/// The vault's Markdown files whose text holds `needle`, by path in it.
fn notes_holding(vault: &Path, needle: &str) -> Vec<String> {
    let mut found = Vec::new();
    let mut stack = vec![vault.to_path_buf()];
    while let Some(dir) = stack.pop() {
        for e in std::fs::read_dir(&dir).unwrap().flatten() {
            let path = e.path();
            if e.file_name().to_string_lossy().starts_with('.') {
                continue;
            }
            if path.is_dir() {
                stack.push(path);
            } else if path.extension().is_some_and(|x| x == "md")
                && std::fs::read_to_string(&path).is_ok_and(|t| t.contains(needle))
            {
                found.push(path.strip_prefix(vault).unwrap().display().to_string());
            }
        }
    }
    found.sort();
    found
}

#[tokio::test]
async fn knowledge_saves_connects_meeting_minutes_into_a_vault() {
    let Some(dir) = published() else {
        return;
    };
    let c = Connect::start(&dir, &[&described()]).await;
    let vault = c.tmp.path().join("Team Wiki");
    fixture_vault(&vault);
    c.picker.next(&vault);
    let id = c
        .call("obsidian", "add", json!({"wait": true, "minutes": "auto"}))
        .await["id"]
        .as_str()
        .unwrap()
        .to_string();
    c.call("obsidian", "default", json!({"id": id})).await;
    // A meeting Connect saved, with its notes: Knowledge's past minutes and sample list it.
    testing::signed_in(&c.core);
    let meetings = c.tmp.path().join("Meetings");
    let atlas = meetings.join("2026-11-18_093000-atlas-sync");
    testing::saved_meeting(
        &c.core,
        "ev1",
        "Atlas sync",
        ("2026-11-18T09:30:00Z", "2026-11-18T10:15:00Z"),
        &atlas,
        "# Atlas sync\n\n## Summary\n\nThe beta ships in May.\n\n## Decisions\n\n- Ship the beta in May\n\n## Next steps\n\n- [ ] Ann Lee: draft the plan\n",
    );
    let past = c.call("obsidian", "past", json!({"id": id})).await;
    assert_eq!(past["count"], 1, "{past}");
    assert_eq!(past["first"][0]["call"], "2026-11-18_093000-atlas-sync");
    assert_eq!(past["first"][0]["title"], "Atlas sync");
    let sample = c.call("obsidian", "sample", json!({"id": id})).await;
    assert!(
        sample.to_string().contains("The beta ships in May"),
        "{sample}"
    );
    // What the meeting's page asks (its chip and ⋯ items): the vault takes it by itself.
    let k = c
        .call(
            "obsidian",
            "call_knowledge",
            json!({"call": {"name": "2026-11-18_093000-atlas-sync", "stamp": "2026-11-18_093000", "title": "Atlas sync",
                            "started_at": "2026-11-18T09:30:00Z", "notes": true, "profile": null, "memo": false,
                            "threads": [], "client": null}}),
        )
        .await;
    assert_eq!(k["targets"][0]["id"], id.as_str(), "{k}");
    assert_eq!(k["vaults"][0]["mode"], "auto");
    // Saved by hand: the minutes' note in the vault.
    let saved = c
        .call(
            "obsidian",
            "save_minutes",
            json!({"call": "2026-11-18_093000-atlas-sync", "vault": id}),
        )
        .await;
    assert_ne!(saved["state"], "mismatch", "{saved}");
    let notes = notes_holding(&vault, "The beta ships in May");
    assert_eq!(notes.len(), 1, "{notes:?} {saved}");
    assert!(
        std::fs::read_to_string(vault.join(&notes[0]))
            .unwrap()
            .contains("Ship the beta in May"),
        "{notes:?}"
    );
    assert_eq!(
        c.call("obsidian", "past", json!({"id": id})).await["count"],
        0,
        "saved: not a past minute any more"
    );
    // A new meeting's notes are written: `minutes_written` saves them into the vault by itself.
    let pricing = meetings.join("2026-11-19_100000-pricing");
    testing::saved_meeting(
        &c.core,
        "ev2",
        "Pricing",
        ("2026-11-19T10:00:00Z", "2026-11-19T10:30:00Z"),
        &pricing,
        "# Pricing\n\n## Summary\n\nThe price stays until June.\n",
    );
    testing::minutes_written(&c.core, "ev2", false);
    let mut written = Vec::new();
    for _ in 0..100 {
        written = notes_holding(&vault, "The price stays until June");
        if !written.is_empty() {
            break;
        }
        tokio::time::sleep(std::time::Duration::from_millis(100)).await;
    }
    assert_eq!(
        written.len(),
        1,
        "minutes_written saved the new meeting: {:?}",
        lines_of("obsidian")
    );
    // Knowledge 1.1.0's person pages (Echo 0.10.1's `echo.read('people')`): Connect's people
    // (who wrote and who was in the meetings) have no place in a thread, so no page is written.
    let version = parse_manifest(&dir.join("obsidian")).unwrap().version;
    if version >= semver::Version::new(1, 1, 0) {
        let synced = c.call("obsidian", "people_sync", json!({"id": id})).await;
        assert_eq!(synced["added"], 0, "{synced}");
        assert!(notes_holding(&vault, "echo://person/").is_empty());
    }
    let logged = lines_of("obsidian");
    assert!(
        logged
            .iter()
            .all(|l| !l.contains("is not available in CodeMie Connect")
                && !l.contains("minutes_written:")),
        "{logged:?}"
    );
    assert!(c.sent().is_empty(), "{:?}", c.sent());
}

/// Knowledge's whole flow in Connect, as the user goes through it: a twin vault made, read
/// (Home, Pages, a page, Graph, Health), a page edited with its history, AI checks, Ingest of a
/// file the user picked, and a Connect meeting's minutes saved into it.
#[tokio::test]
async fn knowledge_full_flow_in_connect() {
    let Some(dir) = published() else {
        return;
    };
    let lint = json!({"findings": [{"kind": "contradiction", "title": "Two launch dates",
        "note": "The topic and the brief disagree.",
        "pages": [{"path": "knowledge/topics/Atlas.md", "line": 3, "quote": "The Atlas launch is in June."}]}]})
    .to_string();
    let c = Connect::start(&dir, &[&described(), &lint, "Ingested the brief."]).await;
    c.runner.on_run(|spec| {
        let Some(f) = spec.folder.as_ref().filter(|f| f.edit) else {
            return;
        };
        std::fs::write(
            f.dir.join("knowledge/topics/Atlas.md"),
            "# Atlas\n\nThe Atlas launch is in May.\n",
        )
        .unwrap();
        std::fs::create_dir_all(f.dir.join(".echo-ingest")).unwrap();
        let notes = json!({"changes": [{"path": "knowledge/topics/Atlas.md", "why": "The brief dates the launch",
            "quotes": [{"source": "raw_inbox/Brief.md", "text": "The Atlas launch is in May."}]}]});
        std::fs::write(f.dir.join(".echo-ingest/changes.json"), notes.to_string()).unwrap();
    });

    // add: the twin preset, in a folder the user picks, with git.
    let folder = c.tmp.path().join("My Twin");
    std::fs::create_dir_all(&folder).unwrap();
    c.picker.next(&folder);
    let made = c
        .call(
            "obsidian",
            "new_vault",
            json!({"name": "My Twin", "git": true, "minutes": "auto"}),
        )
        .await;
    assert_eq!(made["git"], "committed", "{made}");
    let id = made["id"].as_str().unwrap().to_string();
    let root = Path::new(made["root"].as_str().unwrap()).to_path_buf();
    c.call(
        "obsidian",
        "set",
        json!({"id": id, "key": "commit", "value": "true"}),
    )
    .await;
    let atlas = root.join("knowledge/topics/Atlas.md");
    std::fs::create_dir_all(atlas.parent().unwrap()).unwrap();
    std::fs::write(&atlas, "# Atlas\n\nThe Atlas launch is in June.\n").unwrap();

    // kn, tree, page, graph, health: what Home, Pages, Graph and Health show.
    let kn = c.call("obsidian", "kn", json!({})).await;
    assert_eq!(kn["vaults"][0]["id"], id.as_str(), "{kn}");
    assert_eq!(kn["vaults"][0]["available"], true);
    let tree = c.call("obsidian", "tree", json!({"id": id})).await;
    let pages: Vec<&str> = tree["pages"]
        .as_array()
        .unwrap()
        .iter()
        .map(|p| p["path"].as_str().unwrap())
        .collect();
    assert!(
        pages.contains(&"CATALOG.md") && pages.contains(&"topics/Atlas.md"),
        "{pages:?}"
    );
    let page = c
        .call("obsidian", "page", json!({"id": id, "path": "CATALOG.md"}))
        .await;
    assert_eq!(page["editable"], true, "{page}");
    assert!(page["html"]
        .as_str()
        .is_some_and(|h| !h.contains("<script")));
    let graph = c
        .call("obsidian", "graph", json!({"id": id, "mode": "links"}))
        .await;
    assert!(graph["edges"].is_array(), "{graph}");
    let health = c.call("obsidian", "health", json!({"id": id})).await;
    assert!(health["findings"].is_array(), "{health}");

    // save_page over the text it was opened with, then its history.
    let original = std::fs::read_to_string(root.join("knowledge/CATALOG.md")).unwrap();
    let edited = format!("{original}\nEdited in Connect.\n");
    c.call(
        "obsidian",
        "save_page",
        json!({"id": id, "path": "CATALOG.md", "text": edited, "base": page["base"], "message": "Edit the index"}),
    )
    .await;
    assert_eq!(
        std::fs::read_to_string(root.join("knowledge/CATALOG.md")).unwrap(),
        edited
    );
    let history = c
        .call(
            "obsidian",
            "history",
            json!({"id": id, "path": "CATALOG.md"}),
        )
        .await;
    assert_eq!(
        history["versions"].as_array().unwrap().len(),
        2,
        "{history}"
    );

    // lint: Claude's checks, read tools in the vault; the finding is kept.
    let checked = c
        .call("obsidian", "lint", json!({"id": id, "wait": true}))
        .await;
    assert_eq!(checked["state"], "done", "{checked}");
    assert_eq!(checked["kept"], 1, "{checked}");

    // ingest: a file the user picked, run in a copy; the approved change reaches the vault.
    let brief = c.tmp.path().join("Brief.md");
    std::fs::write(&brief, "# Brief\n\nThe Atlas launch is in May.\n").unwrap();
    c.picker.next_files(&[&brief]);
    c.call("obsidian", "source_add", json!({"id": id, "kind": "files"}))
        .await;
    let run = c
        .call("obsidian", "ingest_go", json!({"id": id, "wait": true}))
        .await;
    assert_eq!(run["state"], "review", "{run}");
    c.call(
        "obsidian",
        "change",
        json!({"id": id, "run": run["run"], "path": "knowledge/topics/Atlas.md", "decision": "approve"}),
    )
    .await;
    let applied = c
        .call(
            "obsidian",
            "ingest_apply",
            json!({"id": id, "run": run["run"]}),
        )
        .await;
    assert_eq!(applied["written"], json!(["knowledge/topics/Atlas.md"]));
    assert_eq!(
        std::fs::read_to_string(&atlas).unwrap(),
        "# Atlas\n\nThe Atlas launch is in May.\n"
    );

    // save_minutes: a meeting Connect saved, its minutes into the vault.
    testing::signed_in(&c.core);
    testing::saved_meeting(
        &c.core,
        "ev1",
        "Atlas sync",
        ("2026-11-18T09:30:00Z", "2026-11-18T10:15:00Z"),
        &c.tmp.path().join("Meetings/2026-11-18_093000-atlas-sync"),
        "# Atlas sync\n\n## Summary\n\nThe beta ships in May.\n\n## Decisions\n\n- Ship the beta in May\n",
    );
    let saved = c
        .call(
            "obsidian",
            "save_minutes",
            json!({"call": "2026-11-18_093000-atlas-sync", "vault": id}),
        )
        .await;
    assert_eq!(saved["state"], "saved", "{saved}");
    assert_eq!(saved["index"], "added", "with a row in the index: {saved}");
    let note = std::fs::read_to_string(root.join(saved["path"].as_str().unwrap())).unwrap();
    assert!(
        note.contains("The beta ships in May") && note.contains("Ship the beta in May"),
        "{note}"
    );

    // Three Claude runs (description, checks, Ingest); nothing sent; no member missing.
    assert_eq!(c.runs().len(), 3);
    assert!(c.sent().is_empty(), "{:?}", c.sent());
    let logged = lines_of("obsidian");
    assert!(
        logged
            .iter()
            .all(|l| !l.contains("is not available in CodeMie Connect")),
        "{logged:?}"
    );
}

#[tokio::test]
#[ignore]
async fn my_vault_reads_in_connect() {
    let (Some(dir), Ok(vault)) = (published(), std::env::var("KN_MY_VAULT")) else {
        return;
    };
    let c = Connect::start(&dir, &[&described()]).await;
    c.picker.next(Path::new(&vault));
    let timed =
        |what: &str, t: std::time::Instant| println!("{what}: {} ms", t.elapsed().as_millis());
    let t = std::time::Instant::now();
    let id = c.call("obsidian", "add", json!({"wait": true})).await["id"]
        .as_str()
        .unwrap()
        .to_string();
    timed("add (walk, survey, description)", t);
    let t = std::time::Instant::now();
    let kn = c.call("obsidian", "kn", json!({"id": id})).await;
    timed("kn", t);
    let v = &kn["vaults"][0];
    println!(
        "vault: available={} read_only={} pages={} notes={} in_git={} is_vault={}",
        v["available"],
        !v["read_only"].is_null(),
        v["pages"],
        v["notes"],
        v["in_git"],
        v["is_vault"]
    );
    let t = std::time::Instant::now();
    let tree = c.call("obsidian", "tree", json!({"id": id})).await;
    timed("tree", t);
    let pages = tree["pages"].as_array().map_or(0, Vec::len);
    println!("tree: {pages} pages");
    if let Some(first) = tree["pages"].as_array().and_then(|p| p.first()) {
        let t = std::time::Instant::now();
        let page = c
            .manager
            .call("obsidian", "page", json!({"id": id, "path": first["path"]}))
            .await;
        timed("page (first)", t);
        match page {
            Ok(p) => println!(
                "page: html {} bytes, editable={}",
                p["html"].as_str().map_or(0, str::len),
                p["editable"]
            ),
            Err(e) => println!("page: ERR {}", e.code.as_str()),
        }
        let t = std::time::Instant::now();
        let h = c
            .manager
            .call(
                "obsidian",
                "history",
                json!({"id": id, "path": first["path"]}),
            )
            .await;
        timed("history (first)", t);
        println!(
            "history: {} versions",
            h.ok()
                .and_then(|h| h["versions"].as_array().map(Vec::len))
                .unwrap_or(0)
        );
    }
    let t = std::time::Instant::now();
    let graph = c
        .call("obsidian", "graph", json!({"id": id, "mode": "links"}))
        .await;
    timed("graph", t);
    println!(
        "graph: {} nodes, {} edges",
        graph["nodes"].as_array().map_or(0, Vec::len),
        graph["edges"].as_array().map_or(0, Vec::len)
    );
    let t = std::time::Instant::now();
    let health = c.call("obsidian", "health", json!({"id": id})).await;
    timed("health", t);
    let mut kinds = std::collections::BTreeMap::new();
    for f in health["findings"].as_array().into_iter().flatten() {
        *kinds
            .entry(f["kind"].as_str().unwrap_or("?").to_string())
            .or_insert(0) += 1;
    }
    println!(
        "health: score {} findings {kinds:?}",
        health["score"]["total"]
    );
    let t = std::time::Instant::now();
    let found = c
        .call("obsidian", "find", json!({"id": id, "q": "the"}))
        .await;
    timed("find", t);
    println!(
        "find: {} hits",
        found["hits"].as_array().map_or(0, Vec::len)
    );
    for _ in 0..3 {
        let t = std::time::Instant::now();
        c.call("obsidian", "rev", json!({"id": id})).await;
        timed("rev (the 2 s poll)", t);
    }
    let problems: Vec<String> = lines_of("obsidian")
        .into_iter()
        .filter(|l| l.contains("not available") || l.contains("unsupported"))
        .collect();
    println!("unsupported calls: {}", problems.len());
    assert!(problems.is_empty(), "{problems:?}");
    assert!(c.sent().is_empty());
}
