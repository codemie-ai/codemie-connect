//! The `PluginManager` (DESIGN 7.2): it starts after `Core`, loads every enabled plugin's host
//! half into the `PluginHost` with Connect's `Services`, and reloads when the registry changes
//! (install, update, enable, disable, remove, reset). It gives `Core` its event sink, keeps
//! Today's plugin records to the plugins that are on, and on its tick asks the plugins' widget
//! and work-row providers (on load, after `refresh`, after `changed()`), refreshes what
//! `ctx.profiles()` answers, and starts again plugins stopped for a fault.
use super::host::{ErrorCode, Grants, HostError, Limits, PluginHost};
use super::registry::{Installed, PluginPaths, Registry};
use super::services::events::HostEvents;
use super::services::signin::{self, GhCli};
use super::services::today::{widget_record, work_record};
use super::services::{http, lock, FolderPicker, Granted, Outside, Services};
use crate::workspace::Core;
use futures_util::future::BoxFuture;
use serde_json::{json, Value};
use std::collections::{BTreeMap, HashMap};
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

/// How often the manager looks after its plugins.
const TICK: Duration = Duration::from_secs(2);
/// A provider answers within this (PLUGIN-ENGINE.md §4.1).
const PROVIDER_ANSWER: Duration = Duration::from_secs(5);
/// A provider asked again after `changed()` no sooner than this.
const CHANGED_AFTER: Duration = Duration::from_secs(10);
/// Work rows are asked again this often; a widget after its `refresh` (60 s at least).
const WORK_REFRESH: Duration = Duration::from_secs(60);
/// `ctx.profiles()` is detected again this often.
const PROFILES_REFRESH: Duration = Duration::from_secs(60);

/// What a loaded plugin was loaded from: a change to any of it reloads the plugin.
#[derive(Debug, Clone, PartialEq)]
struct LoadedFrom {
    version: String,
    hash: String,
    agreed: Vec<String>,
}

impl LoadedFrom {
    fn of(p: &Installed) -> LoadedFrom {
        LoadedFrom {
            version: p.version.clone(),
            hash: p.hash.clone(),
            agreed: p.agreed.clone(),
        }
    }
}

pub struct PluginManager {
    paths: PluginPaths,
    core: Arc<Core>,
    services: Arc<Services>,
    host: Arc<PluginHost>,
    loaded: Mutex<HashMap<String, LoadedFrom>>,
    /// Why a plugin that is on didn't load.
    problems: Mutex<BTreeMap<String, String>>,
    /// When each provider (`(plugin, target)`) was last asked.
    asked: Mutex<HashMap<(String, String), Instant>>,
    profiles_at: Mutex<Option<Instant>>,
    /// One reload at a time.
    reloading: tokio::sync::Mutex<()>,
}

impl PluginManager {
    pub fn new(core: Arc<Core>, outside: Outside, limits: Limits) -> Arc<PluginManager> {
        let paths = PluginPaths::new(&core.paths.data, &core.paths.private);
        let services = Services::new(paths.clone(), Some(core.clone()), outside);
        let host = Arc::new(PluginHost::with_limits(services.clone(), limits));
        services.set_host(&host);
        core.set_event_sink(Arc::new(HostEvents(Arc::downgrade(&host))));
        Arc::new(PluginManager {
            paths,
            core,
            services,
            host,
            loaded: Mutex::default(),
            problems: Mutex::default(),
            asked: Mutex::default(),
            profiles_at: Mutex::default(),
            reloading: tokio::sync::Mutex::new(()),
        })
    }

    /// The app's manager: native folder picker, the GitHub CLI and the network; plugins load in
    /// the background, and the tick runs while the app does.
    pub fn start(app: &tauri::AppHandle, core: &Arc<Core>) -> Arc<PluginManager> {
        let outside = Outside {
            picker: Arc::new(NativePicker(app.clone())),
            signin: Arc::new(GhCli),
            http: http::Client::new(),
        };
        let manager = PluginManager::new(core.clone(), outside, Limits::default());
        let running = manager.clone();
        tauri::async_runtime::spawn(async move {
            running.reload().await;
            while !running.core.stop.load(std::sync::atomic::Ordering::Relaxed) {
                tokio::time::sleep(TICK).await;
                running.tick().await;
            }
        });
        manager
    }

    /// The registry changed: loads what is now on, unloads what is off, reloads what changed.
    pub fn on_registry_change(self: &Arc<Self>) {
        let me = self.clone();
        tauri::async_runtime::spawn(async move { me.reload().await });
    }

    /// Brings the loaded plugins in line with the registry.
    pub async fn reload(&self) {
        let _one = self.reloading.lock().await;
        self.refresh_profiles(true).await;
        let reg = match Registry::load(&self.paths) {
            Ok(reg) => reg,
            Err(e) => {
                log::warn!("plugins: not loaded: {}", e.message);
                return;
            }
        };
        let want: BTreeMap<String, Installed> = reg
            .installed
            .into_iter()
            .filter(|(id, p)| super::valid_id(id) && p.enabled)
            .collect();
        let loaded: Vec<(String, LoadedFrom)> = lock(&self.loaded)
            .iter()
            .map(|(id, from)| (id.clone(), from.clone()))
            .collect();
        for (id, from) in loaded {
            if want.get(&id).is_none_or(|p| LoadedFrom::of(p) != from) {
                self.unload(&id).await;
            }
        }
        let keep: Vec<String> = want.keys().cloned().collect();
        if let Err(e) = self.core.plugin_keep_only(&keep) {
            log::warn!(
                "plugins: Today's items of plugins that are off stay: {}",
                e.message
            );
        }
        lock(&self.problems).retain(|id, _| want.contains_key(id));
        for (id, p) in &want {
            if !lock(&self.loaded).contains_key(id) {
                self.load(id, p).await;
            }
        }
    }

    async fn load(&self, id: &str, p: &Installed) {
        let granted = match Granted::of(&self.paths, id, p) {
            Ok(g) => g,
            Err(why) => return self.problem(id, why),
        };
        let main = granted.main.as_ref().map(|m| granted.dir.join(m));
        let grants = Grants::from_uses(&granted.uses);
        self.services.register(granted);
        if let Some(main) = main {
            if let Err(e) = self.host.load(id, &main, grants).await {
                self.services.forget(id);
                let _ = self.core.plugin_delete(None, &format!("{id}:"), true);
                return self.problem(id, e.to_string());
            }
        }
        lock(&self.problems).remove(id);
        lock(&self.loaded).insert(id.to_string(), LoadedFrom::of(p));
        log::info!("[plugin:{id}] loaded {}", p.version);
    }

    async fn unload(&self, id: &str) {
        self.host.unload(id).await;
        self.services.forget(id);
        lock(&self.loaded).remove(id);
        lock(&self.asked).retain(|(p, _), _| p != id);
        if let Err(e) = self.core.plugin_delete(None, &format!("{id}:"), true) {
            log::warn!("[plugin:{id}] its Today items stay: {}", e.message);
        }
        log::info!("[plugin:{id}] unloaded");
    }

    fn problem(&self, id: &str, why: String) {
        log::warn!("[plugin:{id}] didn't load: {why}");
        lock(&self.problems).insert(id.to_string(), why);
    }

    /// Why each plugin that is on didn't load.
    pub fn problems(&self) -> BTreeMap<String, String> {
        lock(&self.problems).clone()
    }

    /// The ids of the loaded plugins.
    pub fn loaded(&self) -> Vec<String> {
        let mut ids: Vec<String> = lock(&self.loaded).keys().cloned().collect();
        ids.sort();
        ids
    }

    /// Runs a plugin's command for the window (its client half, a widget's or an Inbox item's
    /// button).
    pub async fn call(&self, id: &str, command: &str, args: Value) -> Result<Value, HostError> {
        if !lock(&self.loaded).contains_key(id) {
            return Err(HostError::new(
                ErrorCode::NotFound,
                format!("“{id}” isn't on in Connect"),
            ));
        }
        self.host.call(id, command, args).await
    }

    /// The user pressed Choose folder for a marketplace on this computer: the folder they chose.
    pub async fn pick_market_folder(&self) -> Option<PathBuf> {
        self.services
            .pick_folder("Choose a plugin marketplace folder")
            .await
    }

    /// The user pressed Sign in (or Sign out) on a plugin's settings.
    pub async fn sign_in(&self, id: &str, host: &str, on: bool) -> Result<Value, HostError> {
        let p = self.services.granted(id)?;
        if on {
            signin::allow(&self.services, &p, host).await
        } else {
            signin::revoke(&self.services, &p, host)
        }
    }

    /// One look after the plugins: faulted ones started again, providers asked when due, the
    /// profiles refreshed.
    pub async fn tick(&self) {
        self.host.revive_due();
        self.refresh_profiles(false).await;
        for (plugin, target) in self.due() {
            self.ask(&plugin, &target).await;
        }
    }

    async fn refresh_profiles(&self, now: bool) {
        let due = now || lock(&self.profiles_at).is_none_or(|at| at.elapsed() >= PROFILES_REFRESH);
        if due {
            *lock(&self.profiles_at) = Some(Instant::now());
            self.services
                .set_profiles(self.core.plugin_profiles().await);
        }
    }

    /// The providers to ask now: never asked, said `changed()` (10 s apart at most), or past
    /// their refresh.
    fn due(&self) -> Vec<(String, String)> {
        let (targets, changed) = {
            let today = lock(self.services.today());
            (today.targets(), today.changed.clone())
        };
        let asked = lock(&self.asked);
        targets
            .into_iter()
            .filter(|t| match asked.get(t) {
                None => true,
                Some(at) => {
                    (changed.contains(t) && at.elapsed() >= CHANGED_AFTER)
                        || at.elapsed() >= self.refresh_of(t)
                }
            })
            .collect()
    }

    fn refresh_of(&self, (plugin, target): &(String, String)) -> Duration {
        let Some(widget) = target.strip_prefix("widget:") else {
            return WORK_REFRESH;
        };
        let secs = self
            .services
            .granted(plugin)
            .ok()
            .and_then(|g| g.widgets.iter().find(|w| w.id == widget)?.refresh)
            .unwrap_or(60)
            .max(60);
        Duration::from_secs(secs)
    }

    /// Asks one provider and keeps its answer for Today. A slow or failing one keeps its last
    /// answer, marked not updated.
    async fn ask(&self, plugin: &str, target: &str) {
        let key = (plugin.to_string(), target.to_string());
        lock(&self.asked).insert(key.clone(), Instant::now());
        lock(self.services.today()).changed.remove(&key);
        let Ok(p) = self.services.granted(plugin) else {
            return;
        };
        let (provider, args) = match target.strip_prefix("widget:") {
            Some(widget) => (target.to_string(), widget_args(&p, widget)),
            None => ("work".to_string(), json!({"scope": "me"})),
        };
        let asked = tokio::time::timeout(PROVIDER_ANSWER, self.host.ask(plugin, &provider, args));
        let answer = match asked.await {
            Ok(answer) => answer,
            Err(_) => Err(HostError::new(
                ErrorCode::Timeout,
                format!("it didn't answer within {} s", PROVIDER_ANSWER.as_secs()),
            )),
        };
        let record = answer.and_then(|data| match target.strip_prefix("widget:") {
            Some(widget) => widget_record(&p, widget, &data),
            None => work_record(&p, &data),
        });
        let id = match target.strip_prefix("widget:") {
            Some(widget) => format!("{plugin}:{widget}"),
            None => format!("{plugin}:work"),
        };
        let saved = match record {
            Ok(record) => self.core.plugin_put(&record),
            Err(e) => {
                log::warn!("[plugin:{plugin}] {target}: {e}");
                self.mark_stale(&id, &e.to_string())
            }
        };
        if let Err(e) = saved {
            log::warn!("[plugin:{plugin}] {target} wasn't kept: {}", e.message);
        }
    }

    fn mark_stale(&self, id: &str, why: &str) -> crate::workspace::models::Result<()> {
        let records = self.core.plugin_records("plugin_widget")?;
        if let Some(mut last) = records.into_iter().find(|r| r.id == id) {
            last.data["stale"] = json!(true);
            last.data["error"] = json!(why);
            self.core.plugin_put(&last)?;
        }
        Ok(())
    }
}

/// What a widget's provider is asked with: its first size, one row high, what that size draws
/// (`fits`), and its settings' defaults (`thread` and `client` settings stay unset: Connect has
/// neither).
fn widget_args(p: &Granted, widget: &str) -> Value {
    let Some(def) = p.widgets.iter().find(|w| w.id == widget) else {
        return json!({});
    };
    let size = def.sizes.first().cloned().unwrap_or_else(|| "M".into());
    let (items, bars) = match size.as_str() {
        "S" => (3, 4),
        "L" => (10, 12),
        _ => (5, 6),
    };
    let params: serde_json::Map<String, Value> = def
        .params
        .iter()
        .filter(|p| !matches!(p["type"].as_str(), Some("thread" | "client")))
        .filter_map(|p| Some((p["key"].as_str()?.to_string(), p.get("default")?.clone())))
        .collect();
    json!({
        "size": size,
        "height": 1,
        "fits": {"rows": 8, "items": items, "bars": bars},
        "params": params,
    })
}

/// The folder picker over the main window (the data-folder picker's way, DESIGN 8).
struct NativePicker(tauri::AppHandle);

impl FolderPicker for NativePicker {
    #[cfg(any(target_os = "macos", windows))]
    fn pick(&self, title: String) -> BoxFuture<'static, Option<PathBuf>> {
        use tauri::Manager;
        let app = self.0.clone();
        Box::pin(async move {
            let window = app.get_webview_window("main")?;
            let (tx, rx) = tokio::sync::oneshot::channel();
            app.run_on_main_thread(move || {
                let picking = rfd::AsyncFileDialog::new()
                    .set_parent(&window)
                    .set_title(&title)
                    .set_can_create_directories(false)
                    .pick_folder();
                tauri::async_runtime::spawn(async move {
                    let _ = tx.send(picking.await);
                });
            })
            .ok()?;
            rx.await
                .ok()
                .flatten()
                .map(|folder| folder.path().to_path_buf())
        })
    }

    #[cfg(not(any(target_os = "macos", windows)))]
    fn pick(&self, _title: String) -> BoxFuture<'static, Option<PathBuf>> {
        Box::pin(async { None })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ai::fake::FakeRunner;
    use crate::plugins::registry::Source;
    use crate::plugins::services::testing::{FakeGh, Picked};
    use crate::workspace::test_core;

    pub struct Setup {
        _dir: tempfile::TempDir,
        pub core: Arc<Core>,
        pub manager: Arc<PluginManager>,
    }

    impl Setup {
        pub fn new(
            runner: Arc<FakeRunner>,
            profiles: Vec<crate::ai::profiles::AiProfile>,
        ) -> Setup {
            let dir = tempfile::tempdir().unwrap();
            let core = test_core(dir.path(), runner, profiles);
            let outside = Outside {
                picker: Arc::new(Picked::default()),
                signin: Arc::new(FakeGh::default()),
                http: http::Client::new(),
            };
            let manager = PluginManager::new(core.clone(), outside, Limits::default());
            Setup {
                _dir: dir,
                core,
                manager,
            }
        }

        /// Installs `id` at `version` with this manifest and main.js, agreeing to all of its
        /// `uses`, and turned on or off.
        pub fn install(&self, id: &str, version: &str, manifest: Value, main: &str, enabled: bool) {
            let paths = &self.manager.paths;
            let dir = paths.installed().join(id).join(version);
            std::fs::create_dir_all(&dir).unwrap();
            let mut m = manifest;
            m["id"] = json!(id);
            m["version"] = json!(version);
            m["main"] = json!("main.js");
            if m.get("name").is_none() {
                m["name"] = json!(format!("{id} plugin"));
            }
            std::fs::write(dir.join("echo-plugin.json"), m.to_string()).unwrap();
            std::fs::write(dir.join("main.js"), main).unwrap();
            let agreed: Vec<String> = m["uses"]
                .as_object()
                .map(|u| u.keys().cloned().collect())
                .unwrap_or_default();
            Registry::update(paths, |r| {
                r.installed.insert(
                    id.to_string(),
                    Installed {
                        version: version.into(),
                        market: "acme".into(),
                        source: Source::Local {
                            path: "/tmp/acme".into(),
                        }
                        .text(),
                        commit: None,
                        hash: format!("{id}-{version}"),
                        enabled,
                        agreed,
                        agreed_text: Default::default(),
                        installed_at: crate::plugins::registry::now(),
                    },
                );
                Ok(())
            })
            .unwrap();
        }

        pub fn set_enabled(&self, id: &str, on: bool) {
            Registry::update(&self.manager.paths, |r| {
                r.installed.get_mut(id).unwrap().enabled = on;
                Ok(())
            })
            .unwrap();
        }
    }

    const PING: &str = r#"
        export function apply(ctx) {
          ctx.command('ping', () => 'pong v1')
          ctx.inbox.set('hello', { title: 'Hello from v1' })
        }
    "#;

    #[tokio::test]
    async fn manager_loads_enabled_and_reloads_on_change() {
        let s = Setup::new(Arc::new(FakeRunner::new(vec![])), vec![]);
        s.install("hello", "1.0.0", json!({}), PING, true);
        s.install("idle", "1.0.0", json!({}), PING, false);
        s.install(
            "broken",
            "1.0.0",
            json!({}),
            "export function nope() {}",
            true,
        );
        s.manager.reload().await;
        assert_eq!(s.manager.loaded(), ["hello"]);
        assert!(
            s.manager.problems()["broken"].contains("apply"),
            "{:?}",
            s.manager.problems()
        );
        assert_eq!(
            s.manager.call("hello", "ping", Value::Null).await,
            Ok(json!("pong v1"))
        );
        assert_eq!(
            s.manager
                .call("idle", "ping", Value::Null)
                .await
                .unwrap_err()
                .code,
            ErrorCode::NotFound
        );
        let items = |core: &Core| -> Vec<String> {
            core.plugin_records("plugin_item")
                .unwrap()
                .into_iter()
                .map(|r| r.id)
                .collect()
        };
        assert_eq!(items(&s.core), ["hello:inbox:hello"]);

        // Turned on and off.
        s.set_enabled("idle", true);
        s.set_enabled("hello", false);
        s.manager.reload().await;
        assert_eq!(s.manager.loaded(), ["idle"]);
        assert_eq!(
            s.manager
                .call("hello", "ping", Value::Null)
                .await
                .unwrap_err()
                .code,
            ErrorCode::NotFound
        );
        // Its Today items went with it.
        assert_eq!(items(&s.core), ["idle:inbox:hello"]);

        // An update is loaded in its place.
        let v2 = PING.replace("pong v1", "pong v2");
        s.install("idle", "1.1.0", json!({}), &v2, true);
        s.manager.reload().await;
        assert_eq!(
            s.manager.call("idle", "ping", Value::Null).await,
            Ok(json!("pong v2"))
        );
        // Removed: unloaded, and nothing of it stays on Today.
        Registry::update(&s.manager.paths, |r| {
            r.installed.remove("idle");
            Ok(())
        })
        .unwrap();
        s.manager.reload().await;
        assert!(s.manager.loaded().is_empty());
        assert!(items(&s.core).is_empty());
    }

    /// A synthetic plugin that uses most of `ctx` (store, settings, inbox, a widget, Claude,
    /// delivery, Markdown, Connect's data, the network and folders), loaded by the manager from
    /// an installed package into the real host, with the real services over a real `Core`.
    const E2E: &str = r#"
        export async function apply(ctx) {
          ctx.store.write('state.json', JSON.stringify({ started: true }))
          ctx.inbox.set('welcome', { title: 'Try the e2e plugin', why: 'It is new',
            actions: [{ label: 'Run', command: 'run', primary: true }] })
          ctx.widgets.provide('status', () => ({ state: 'ok', title: ctx.settings.get('label') }))
          ctx.command('run', async () => {
            const out = await ctx.claude.run({ prompt: 'Say hi to Ann', title: 'Hi', tools: 'read' })
            await ctx.deliver.send('today', { title: 'Hi', markdown: out.answer, about: 'e2e' })
            const refused = async (f) => { try { await f(); return 'allowed' } catch (e) { return e.code } }
            return {
              answer: out.answer, model: out.model, actions: out.actions,
              html: ctx.markdown(out.answer + ' <b>x</b>'),
              state: JSON.parse(ctx.store.read('state.json')),
              people: ctx.echo.read('people').map((p) => p.name),
              threads: ctx.echo.read('threads'),
              host: ctx.host,
              profiles: ctx.profiles(),
              fetch: await refused(() => ctx.http.fetch('https://evil.example.com/')),
              folder: await refused(() => ctx.fs.read('/etc', 'hosts')),
              sources: await refused(() => ctx.echo.read('sources')),
              missing: [typeof ctx.sessions, typeof ctx.threads, ctx.terminal],
            }
          })
        }
    "#;

    #[tokio::test]
    async fn a_synthetic_plugin_uses_connects_services_through_the_real_host() {
        use crate::plugins::services::claude::tests::{answered, claude_profile};
        use crate::workspace::plugin_data::tests::{seed, source};
        let runner = Arc::new(FakeRunner::new(vec![Ok(answered("**Hi** Ann"))]));
        let s = Setup::new(runner.clone(), vec![claude_profile()]);
        seed(&s.core);
        s.core
            .repo()
            .unwrap()
            .put_record(&source(
                "m1",
                "message",
                "mail:inbox",
                1_795_000_000,
                json!({"channel": "mail", "title": "Hello", "from": "Ann Lee",
                       "fromAddress": "ann@example.test", "isMine": false, "at": 1_795_000_000}),
            ))
            .unwrap();
        s.install(
            "e2e",
            "1.0.0",
            json!({
                "uses": {"claude": {}, "deliver": {"to": ["today"]},
                         "echo": {"read": ["people", "threads"]},
                         "network": {"hosts": ["api.example.com"]}},
                "settings": [{"key": "label", "label": "Label", "type": "string", "default": "All good"}],
                "widgets": [{"id": "status", "label": "Status", "kind": "status"}]
            }),
            E2E,
            true,
        );
        s.manager.reload().await;
        assert_eq!(s.manager.loaded(), ["e2e"], "{:?}", s.manager.problems());

        let out = s.manager.call("e2e", "run", Value::Null).await.unwrap();
        assert_eq!(out["answer"], "**Hi** Ann");
        assert_eq!(out["model"], "claude-sonnet-4");
        assert_eq!(out["actions"], json!([]));
        assert_eq!(
            out["html"],
            "<p><strong>Hi</strong> Ann &lt;b&gt;x&lt;/b&gt;</p>"
        );
        assert_eq!(out["state"], json!({"started": true}));
        assert_eq!(out["people"], json!(["Ann Lee"]));
        assert_eq!(out["threads"], json!([]));
        assert_eq!(out["host"]["name"], "CodeMie Connect");
        assert_eq!(out["host"]["engine"], "1.0");
        assert_eq!(out["profiles"]["default"], "claude");
        assert_eq!(out["profiles"]["profiles"][0]["id"], "claude");
        assert_eq!(out["fetch"], "permission");
        assert_eq!(out["folder"], "permission");
        assert_eq!(out["sources"], "permission");
        assert_eq!(out["missing"], json!(["undefined", "undefined", false]));
        // The run was tool-free and recorded as the plugin's.
        assert_eq!(runner.calls()[0].purpose, "plugin");
        let runs = s.core.repo().unwrap().records_of_kind("ai_run").unwrap();
        assert_eq!(runs[0].data["plugin"], "e2e");
        assert_eq!(runs[0].data["tools"], "read");

        // Today shows its Inbox item, its delivery and (once asked) its widget.
        s.manager.tick().await;
        let snapshot = s.core.repo().unwrap().snapshot().unwrap();
        let ours: Vec<(String, String)> = snapshot
            .records
            .iter()
            .filter(|r| r.kind.starts_with("plugin_"))
            .map(|r| {
                (
                    r.kind.clone(),
                    r.data["type"].as_str().unwrap_or("").to_string(),
                )
            })
            .collect();
        for want in [
            ("plugin_item", "inbox"),
            ("plugin_item", "delivery"),
            ("plugin_widget", "widget"),
        ] {
            assert!(
                ours.contains(&(want.0.into(), want.1.into())),
                "{want:?} in {ours:?}"
            );
        }
        let widget = snapshot
            .records
            .iter()
            .find(|r| r.id == "e2e:status")
            .unwrap();
        assert_eq!(
            widget.data["data"],
            json!({"state": "ok", "title": "All good"})
        );

        // Its store is its own folder in the data root.
        let store = s.manager.paths.data_of("e2e").join("store/state.json");
        assert!(store.is_file());
    }

    #[tokio::test]
    async fn providers_are_asked_and_their_answers_kept_for_today() {
        let s = Setup::new(Arc::new(FakeRunner::new(vec![])), vec![]);
        s.install(
            "gh",
            "1.0.0",
            json!({
                "uses": {"work": {}},
                "widgets": [{"id": "ci", "label": "CI", "kind": "status", "sizes": ["S", "M"],
                             "params": [{"key": "thread", "label": "T", "type": "thread"},
                                        {"key": "prs", "label": "PRs", "type": "bool", "default": true}]}]
            }),
            r#"
            let asked = []
            let state = 'ok'
            export function apply(ctx) {
              ctx.widgets.provide('ci', (args) => { asked.push(args); return { state, title: `CI ${state}` } })
              ctx.work.provide(({ scope }) => [{ id: 'pr-1', title: `Review (${scope})`, kind: 'review' }])
              ctx.command('fail', () => { state = 'bad'; ctx.widgets.changed('ci') })
              ctx.command('asked', () => asked)
            }
            "#,
            true,
        );
        s.manager.reload().await;
        s.manager.tick().await;
        let widget = |core: &Core, id: &str| {
            core.plugin_records("plugin_widget")
                .unwrap()
                .into_iter()
                .find(|r| r.id == id)
        };
        let ci = widget(&s.core, "gh:ci").expect("the widget's answer is kept");
        assert_eq!(ci.data["data"], json!({"state": "ok", "title": "CI ok"}));
        let work = widget(&s.core, "gh:work").expect("the work rows are kept");
        assert_eq!(work.data["rows"][0]["title"], "Review (me)");
        let asked = s.manager.call("gh", "asked", Value::Null).await.unwrap();
        assert_eq!(
            asked[0],
            json!({"size": "S", "height": 1, "fits": {"rows": 8, "items": 3, "bars": 4}, "params": {"prs": true}})
        );
        // Not asked again before its refresh; `changed()` asks again once 10 s have passed.
        s.manager.call("gh", "fail", Value::Null).await.unwrap();
        s.manager.tick().await;
        assert_eq!(
            widget(&s.core, "gh:ci").unwrap().data["data"]["state"],
            "ok"
        );
        let key = ("gh".to_string(), "widget:ci".to_string());
        lock(&s.manager.asked).insert(key, Instant::now() - CHANGED_AFTER);
        s.manager.tick().await;
        assert_eq!(
            widget(&s.core, "gh:ci").unwrap().data["data"]["state"],
            "bad"
        );
    }
}
