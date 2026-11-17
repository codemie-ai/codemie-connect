//! Plugin host halves (DESIGN 7.2): each plugin's `main.js` runs in its own QuickJS runtime and
//! context (`Limits`: 64 MB, a 5 s slice, 30 s a call), all on one dedicated thread driven by
//! messages. The plugin gets `ctx` (`prelude.js`) from `apply(ctx)`; `ctx` reaches Connect only
//! through `HostServices`, which always hears the plugin's id from the runtime, never from the
//! plugin's arguments. `bridge` is one plugin's runtime and the JSON-only bridge into it.
//!
//! Not in Connect yet: `slots`, `threads`, `view`, `terminal` and `knowledge` are undefined;
//! `sessions`, `channel`, `agent`, `scripts` and `claude.hasPlugin/installPlugin` exist, and
//! each call rejects with `unsupported: <name> is not available in CodeMie Connect yet`. A
//! rejected promise rather than a throw: Telegram calls `ctx.sessions.clearChannel()` from
//! `apply` outside any error handling, and a throw there would keep it from loading.
mod bridge;

use bridge::{Kind, Plugin, Wiring};
use futures_util::future::BoxFuture;
use serde::Serialize;
use serde_json::{Map, Value};
use std::collections::{BTreeSet, HashMap};
use std::path::{Path, PathBuf};
use std::sync::{mpsc, Arc};
use std::time::{Duration, Instant};
use tokio::sync::oneshot;

/// Why a plugin call failed. In JavaScript it is an `Error` whose `message` is
/// `"<code>: <message>"` and whose `code` property is the code.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ErrorCode {
    Unsupported,
    Permission,
    Timeout,
    Limit,
    PluginError,
    NotFound,
}

impl ErrorCode {
    const ALL: [ErrorCode; 6] = [
        ErrorCode::Unsupported,
        ErrorCode::Permission,
        ErrorCode::Timeout,
        ErrorCode::Limit,
        ErrorCode::PluginError,
        ErrorCode::NotFound,
    ];

    pub fn as_str(self) -> &'static str {
        match self {
            ErrorCode::Unsupported => "unsupported",
            ErrorCode::Permission => "permission",
            ErrorCode::Timeout => "timeout",
            ErrorCode::Limit => "limit",
            ErrorCode::PluginError => "plugin_error",
            ErrorCode::NotFound => "not_found",
        }
    }

    pub fn parse(code: &str) -> Option<ErrorCode> {
        Self::ALL.into_iter().find(|c| c.as_str() == code)
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, thiserror::Error)]
#[error("{}: {message}", code.as_str())]
pub struct HostError {
    pub code: ErrorCode,
    pub message: String,
}

impl HostError {
    pub fn new(code: ErrorCode, message: impl Into<String>) -> HostError {
        HostError {
            code,
            message: message.into(),
        }
    }
}

/// What `ctx` calls in Connect, by the dotted name of the `ctx` member (`store.read`,
/// `http.fetch`, `widgets.provide`, …), with the plugin's arguments as one JSON array.
pub trait HostServices: Send + Sync {
    /// Answers now. It runs on the host thread while the plugin's JavaScript waits (that wait
    /// isn't counted against its slice), so it must be quick, and must never call back into the
    /// `PluginHost`.
    fn sync(&self, plugin: &str, name: &str, args: Value) -> Result<Value, HostError>;
    /// Answers later: the plugin gets a promise, settled on the host thread when this future
    /// is done. Dropped unfinished when the plugin unloads.
    fn spawn_async(
        &self,
        plugin: &str,
        name: &str,
        args: Value,
    ) -> BoxFuture<'static, Result<Value, HostError>>;
}

/// The limits each plugin runs under.
#[derive(Debug, Clone)]
pub struct Limits {
    /// Memory of one plugin's runtime.
    pub memory: usize,
    /// JavaScript stack of one plugin.
    pub stack: usize,
    /// JavaScript running this long without a break (an `await`) is interrupted.
    pub slice: Duration,
    /// A command or provider answers its caller within this, or the caller is told `timeout`.
    pub call: Duration,
    /// The shortest `ctx.every` interval.
    pub min_every: Duration,
    /// The largest JSON a call's arguments or answer may be, either way across the bridge.
    pub max_json: usize,
}

impl Default for Limits {
    fn default() -> Limits {
        Limits {
            memory: 64 * 1024 * 1024,
            stack: 1024 * 1024,
            slice: Duration::from_secs(5),
            call: Duration::from_secs(30),
            min_every: Duration::from_secs(10),
            max_json: 16 * 1024 * 1024,
        }
    }
}

/// What the runtime itself checks of what the user agreed to; the services check the rest.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Grants {
    /// The events `ctx.on` may listen to.
    pub events: BTreeSet<String>,
}

impl Grants {
    /// From the agreed manifest's `uses`: the events `events.on` names, and, as Echo hands
    /// them to a plugin that reads sources (`echo.read` with `source` or `sources`; Obsidian
    /// relies on it), `minutes_written` and `sources_changed`.
    pub fn from_uses(uses: &Map<String, Value>) -> Grants {
        let words = |v: Option<&Value>| -> Vec<String> {
            v.and_then(Value::as_array)
                .into_iter()
                .flatten()
                .filter_map(Value::as_str)
                .map(str::to_string)
                .collect()
        };
        let mut events: BTreeSet<String> = words(uses.get("events").and_then(|e| e.get("on")))
            .into_iter()
            .collect();
        let reads = words(uses.get("echo").and_then(|e| e.get("read")));
        if reads.iter().any(|k| k == "source" || k == "sources") {
            events.extend(["minutes_written", "sources_changed"].map(String::from));
        }
        Grants { events }
    }
}

/// What the host thread is asked to do.
enum Msg {
    Load {
        id: String,
        main_js: PathBuf,
        grants: Grants,
        reply: oneshot::Sender<Result<(), HostError>>,
    },
    Call {
        id: String,
        kind: Kind,
        name: String,
        args: Value,
        reply: oneshot::Sender<Result<Value, HostError>>,
    },
    Emit {
        event: String,
        payload: Value,
    },
    Unload {
        id: String,
        reply: oneshot::Sender<()>,
    },
    /// An async host call's answer, for the runtime it was asked from (a reloaded plugin's new
    /// runtime has another generation and never hears it).
    Settle {
        generation: u64,
        token: u64,
        result: Result<Value, HostError>,
    },
    Stop,
}

/// The plugins' host halves: one QuickJS runtime and context per plugin, all on one dedicated
/// thread, driven by messages. Callers wait for answers asynchronously, so a Tauri command may
/// await them on the async runtime.
pub struct PluginHost {
    tx: mpsc::Sender<Msg>,
    thread: Option<std::thread::JoinHandle<()>>,
}

impl PluginHost {
    pub fn new(services: Arc<dyn HostServices>) -> PluginHost {
        PluginHost::with_limits(services, Limits::default())
    }

    pub fn with_limits(services: Arc<dyn HostServices>, limits: Limits) -> PluginHost {
        let (tx, rx) = mpsc::channel();
        let to_host = tx.clone();
        // The runtimes are made, used and dropped on this thread only.
        let run = move || {
            let host = HostThread {
                wiring: Wiring {
                    services,
                    limits: Arc::new(limits),
                    host: to_host,
                },
                plugins: HashMap::new(),
                generation: 0,
            };
            host.run(rx)
        };
        let thread = std::thread::Builder::new()
            .name("plugin-host".into())
            // Room for the plugins' JavaScript stacks above the host's own frames.
            .stack_size(8 * 1024 * 1024)
            .spawn(run)
            .expect("start the plugin host thread");
        PluginHost {
            tx,
            thread: Some(thread),
        }
    }

    /// Loads `id` from its `main.js` (replacing a loaded one): evaluates it and runs its
    /// `apply(ctx)`. A plugin that fails to load isn't kept.
    pub async fn load(&self, id: &str, main_js: &Path, grants: Grants) -> Result<(), HostError> {
        let (reply, answer) = oneshot::channel();
        self.send(Msg::Load {
            id: id.to_string(),
            main_js: main_js.to_path_buf(),
            grants,
            reply,
        });
        answer.await.unwrap_or_else(|_| Err(stopped()))
    }

    /// Runs the plugin's command `ctx.command(command, fn)` with `args`.
    pub async fn call(&self, id: &str, command: &str, args: Value) -> Result<Value, HostError> {
        self.request(id, Kind::Command, command, args).await
    }

    /// Asks one of the plugin's providers: `widget:<id>` (`ctx.widgets.provide`), `work`
    /// (`ctx.work.provide`) or `deliver:<kind>` (`ctx.deliver.provide`).
    pub async fn ask(&self, id: &str, provider: &str, args: Value) -> Result<Value, HostError> {
        self.request(id, Kind::Provider, provider, args).await
    }

    async fn request(
        &self,
        id: &str,
        kind: Kind,
        name: &str,
        args: Value,
    ) -> Result<Value, HostError> {
        let (reply, answer) = oneshot::channel();
        self.send(Msg::Call {
            id: id.to_string(),
            kind,
            name: name.to_string(),
            args,
            reply,
        });
        answer.await.unwrap_or_else(|_| Err(stopped()))
    }

    /// Tells every plugin granted `event` (`uses.events.on`) that it happened.
    pub fn emit(&self, event: &str, payload: Value) {
        self.send(Msg::Emit {
            event: event.to_string(),
            payload,
        });
    }

    /// Drops the plugin's runtime, its timers and its calls in flight (their callers hear
    /// `not_found`).
    pub async fn unload(&self, id: &str) {
        let (reply, answer) = oneshot::channel();
        self.send(Msg::Unload {
            id: id.to_string(),
            reply,
        });
        let _ = answer.await;
    }

    fn send(&self, msg: Msg) {
        // A send fails only once the thread has ended; the caller's reply is then dropped.
        let _ = self.tx.send(msg);
    }
}

impl Drop for PluginHost {
    fn drop(&mut self) {
        let _ = self.tx.send(Msg::Stop);
        if let Some(thread) = self.thread.take() {
            if thread.thread().id() != std::thread::current().id() {
                let _ = thread.join();
            }
        }
    }
}

fn stopped() -> HostError {
    HostError::new(ErrorCode::NotFound, "the plugin host has stopped")
}

struct HostThread {
    wiring: Wiring,
    plugins: HashMap<String, Plugin>,
    /// Numbers each runtime, so an async answer reaches only the runtime that asked.
    generation: u64,
}

impl HostThread {
    fn run(mut self, rx: mpsc::Receiver<Msg>) {
        loop {
            let wake = self.plugins.values().filter_map(Plugin::next_wake).min();
            let msg = match wake {
                Some(at) => match rx.recv_timeout(at.saturating_duration_since(Instant::now())) {
                    Ok(msg) => Some(msg),
                    Err(mpsc::RecvTimeoutError::Timeout) => None,
                    Err(mpsc::RecvTimeoutError::Disconnected) => break,
                },
                None => match rx.recv() {
                    Ok(msg) => Some(msg),
                    Err(_) => break,
                },
            };
            match msg {
                Some(Msg::Stop) => break,
                Some(msg) => self.handle(msg),
                None => {}
            }
            self.tick();
        }
        // Each runtime goes with its plugin, after the JavaScript handles the host held.
        self.plugins.clear();
    }

    fn handle(&mut self, msg: Msg) {
        match msg {
            Msg::Load {
                id,
                main_js,
                grants,
                reply,
            } => self.load(id, &main_js, grants, reply),
            Msg::Call {
                id,
                kind,
                name,
                args,
                reply,
            } => match self.plugins.get_mut(&id) {
                Some(plugin) => {
                    plugin.call(kind, &name, &args, reply);
                    self.after(&id);
                }
                None => {
                    let _ = reply.send(Err(HostError::new(
                        ErrorCode::NotFound,
                        format!("no plugin “{id}” is loaded"),
                    )));
                }
            },
            Msg::Emit { event, payload } => {
                let ids: Vec<String> = self
                    .plugins
                    .values()
                    .filter(|p| p.hears(&event))
                    .map(|p| p.id().to_string())
                    .collect();
                for id in ids {
                    if let Some(plugin) = self.plugins.get_mut(&id) {
                        plugin.event(&event, &payload);
                        self.after(&id);
                    }
                }
            }
            Msg::Unload { id, reply } => {
                self.plugins.remove(&id);
                let _ = reply.send(());
            }
            Msg::Settle {
                generation,
                token,
                result,
            } => {
                let id = self
                    .plugins
                    .values()
                    .find(|p| p.generation() == generation)
                    .map(|p| p.id().to_string());
                if let Some(id) = id {
                    if let Some(plugin) = self.plugins.get_mut(&id) {
                        plugin.settle(token, result);
                    }
                    self.after(&id);
                }
            }
            Msg::Stop => {}
        }
    }

    fn load(
        &mut self,
        id: String,
        main_js: &Path,
        grants: Grants,
        reply: oneshot::Sender<Result<(), HostError>>,
    ) {
        self.plugins.remove(&id);
        let source = match std::fs::read_to_string(main_js) {
            Ok(source) => source,
            Err(e) => {
                let message = format!("can't read {}: {e}", main_js.display());
                let _ = reply.send(Err(HostError::new(ErrorCode::NotFound, message)));
                return;
            }
        };
        let file = main_js
            .file_name()
            .map(|f| f.to_string_lossy().into_owned())
            .unwrap_or_else(|| "main.js".into());
        self.generation += 1;
        let loaded = Plugin::load(
            &id,
            self.generation,
            &file,
            source,
            grants,
            &self.wiring,
            reply,
        );
        if let Some(plugin) = loaded {
            self.plugins.insert(id.clone(), plugin);
            self.after(&id);
        }
    }

    /// After the plugin's JavaScript ran: its jobs, then the callers it can answer. A plugin
    /// whose `apply(ctx)` failed is dropped.
    fn after(&mut self, id: &str) {
        if let Some(plugin) = self.plugins.get_mut(id) {
            plugin.run_jobs();
        }
        self.answer(id, Instant::now());
    }

    fn answer(&mut self, id: &str, now: Instant) {
        let Some(plugin) = self.plugins.get_mut(id) else {
            return;
        };
        if let Some(e) = plugin.answer_settled(now) {
            log::warn!("[plugin:{id}] didn't load: {e}");
            self.plugins.remove(id);
        }
    }

    /// Due timers, and callers whose time is up.
    fn tick(&mut self) {
        let now = Instant::now();
        let ids: Vec<String> = self.plugins.keys().cloned().collect();
        for id in ids {
            if let Some(plugin) = self.plugins.get_mut(&id) {
                plugin.tick(now);
            }
            self.answer(&id, now);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use std::collections::HashMap;
    use std::path::PathBuf;
    use std::sync::Mutex;
    use std::time::Instant;

    /// Stand-in services: a store per plugin, and a few named answers.
    #[derive(Default)]
    struct FakeServices {
        store: Mutex<HashMap<(String, String), Value>>,
        /// `(plugin, service, args)` of every call, in order.
        heard: Mutex<Vec<(String, String, Value)>>,
    }

    impl FakeServices {
        fn heard(&self, name: &str) -> Vec<(String, Value)> {
            let heard = self.heard.lock().unwrap();
            heard
                .iter()
                .filter(|(_, n, _)| n == name)
                .map(|(p, _, a)| (p.clone(), a.clone()))
                .collect()
        }
    }

    impl HostServices for FakeServices {
        fn sync(&self, plugin: &str, name: &str, args: Value) -> Result<Value, HostError> {
            self.heard
                .lock()
                .unwrap()
                .push((plugin.into(), name.into(), args.clone()));
            let key = |i: usize| (plugin.to_string(), args[i].as_str().unwrap().to_string());
            match name {
                "store.write" => {
                    self.store.lock().unwrap().insert(key(0), args[1].clone());
                    Ok(Value::Null)
                }
                "store.read" => Ok(self
                    .store
                    .lock()
                    .unwrap()
                    .get(&key(0))
                    .cloned()
                    .unwrap_or(Value::Null)),
                "log" | "widgets.provide" | "deliver.provide" => Ok(Value::Null),
                "settings.get" => Err(HostError::new(ErrorCode::Permission, "no settings here")),
                _ => Err(HostError::new(ErrorCode::NotFound, format!("no {name}"))),
            }
        }

        fn spawn_async(
            &self,
            plugin: &str,
            name: &str,
            args: Value,
        ) -> BoxFuture<'static, Result<Value, HostError>> {
            self.heard
                .lock()
                .unwrap()
                .push((plugin.into(), name.into(), args.clone()));
            let (plugin, name) = (plugin.to_string(), name.to_string());
            Box::pin(async move {
                match name.as_str() {
                    "http.fetch" => {
                        tokio::time::sleep(Duration::from_millis(30)).await;
                        Ok(json!({"status": 200, "body": format!("{plugin} got {}", args[0])}))
                    }
                    "system.pickFolder" => {
                        Err(HostError::new(ErrorCode::Permission, "the user said no"))
                    }
                    // Never answers: the call's limit has to end it.
                    "claude.run" => futures_util::future::pending().await,
                    _ => Err(HostError::new(ErrorCode::NotFound, format!("no {name}"))),
                }
            })
        }
    }

    /// Short limits, so the slice and call limits are reached quickly.
    fn quick() -> Limits {
        Limits {
            slice: Duration::from_millis(300),
            call: Duration::from_secs(1),
            ..Limits::default()
        }
    }

    struct Setup {
        host: PluginHost,
        services: Arc<FakeServices>,
        dir: tempfile::TempDir,
    }

    impl Setup {
        fn new(limits: Limits) -> Setup {
            let services = Arc::new(FakeServices::default());
            Setup {
                host: PluginHost::with_limits(services.clone(), limits),
                services,
                dir: tempfile::tempdir().unwrap(),
            }
        }

        fn write(&self, id: &str, main: &str) -> PathBuf {
            let dir = self.dir.path().join(id);
            std::fs::create_dir_all(&dir).unwrap();
            let path = dir.join("main.js");
            std::fs::write(&path, main).unwrap();
            path
        }

        async fn load(&self, id: &str, main: &str) {
            self.load_with(id, main, Grants::default()).await;
        }

        async fn load_with(&self, id: &str, main: &str, grants: Grants) {
            let path = self.write(id, main);
            self.host.load(id, &path, grants).await.unwrap();
        }

        async fn call(&self, id: &str, command: &str, args: Value) -> Result<Value, HostError> {
            self.host.call(id, command, args).await
        }
    }

    #[test]
    fn default_limits_are_the_designs() {
        let l = Limits::default();
        assert_eq!(l.memory, 64 * 1024 * 1024);
        assert_eq!(l.slice, Duration::from_secs(5));
        assert_eq!(l.call, Duration::from_secs(30));
        assert_eq!(l.min_every, Duration::from_secs(10));
    }

    #[tokio::test]
    async fn command_registered_and_called_returns_value() {
        let s = Setup::new(quick());
        s.load(
            "calc",
            r#"
            export const helper = (a, b) => a + b
            export function apply(ctx) {
              ctx.command('add', ({ a, b }) => ({ sum: helper(a, b), id: ctx.id }))
              ctx.command('later', async (x) => { await null; return [x, 'done'] })
              ctx.command('nothing', () => {})
              ctx.command('fails', () => { throw new Error('nope') })
            }
            "#,
        )
        .await;
        assert_eq!(
            s.call("calc", "add", json!({"a": 2, "b": 3})).await,
            Ok(json!({"sum": 5, "id": "calc"}))
        );
        assert_eq!(
            s.call("calc", "later", json!("x")).await,
            Ok(json!(["x", "done"]))
        );
        assert_eq!(
            s.call("calc", "nothing", Value::Null).await,
            Ok(Value::Null)
        );
        assert_eq!(
            s.call("calc", "fails", Value::Null).await,
            Err(HostError::new(ErrorCode::PluginError, "nope"))
        );
        let missing = s.call("calc", "missing", Value::Null).await.unwrap_err();
        assert_eq!(missing.code, ErrorCode::NotFound);
        let nobody = s.call("nobody", "add", Value::Null).await.unwrap_err();
        assert_eq!(nobody.code, ErrorCode::NotFound);
    }

    #[tokio::test]
    async fn async_host_call_settles_promise() {
        let s = Setup::new(quick());
        s.load(
            "net",
            r#"
            export function apply(ctx) {
              ctx.command('fetch', async (url) => (await ctx.http.fetch(url)).body)
              const caught = (e) => ({ message: e.message, code: e.code, isError: e instanceof Error })
              ctx.command('refused', async () => {
                try { await ctx.system.pickFolder('Pick') } catch (e) { return caught(e) }
              })
              ctx.command('refusedNow', () => {
                try { ctx.settings.get('k') } catch (e) { return caught(e) }
              })
              ctx.command('uncaught', () => ctx.settings.get('k'))
            }
            "#,
        )
        .await;
        assert_eq!(
            s.call("net", "fetch", json!("https://example.test/a"))
                .await,
            Ok(json!("net got \"https://example.test/a\""))
        );
        let refused = json!({"message": "permission: the user said no", "code": "permission", "isError": true});
        assert_eq!(s.call("net", "refused", Value::Null).await, Ok(refused));
        let refused_now = json!({"message": "permission: no settings here", "code": "permission", "isError": true});
        assert_eq!(
            s.call("net", "refusedNow", Value::Null).await,
            Ok(refused_now)
        );
        assert_eq!(
            s.call("net", "uncaught", Value::Null).await,
            Err(HostError::new(ErrorCode::Permission, "no settings here"))
        );
        assert_eq!(
            s.services.heard("http.fetch"),
            vec![("net".to_string(), json!(["https://example.test/a"]))]
        );
    }

    #[tokio::test]
    async fn infinite_loop_is_interrupted_and_runtime_survives() {
        let s = Setup::new(quick());
        s.load(
            "busy",
            r#"
            export function apply(ctx) {
              ctx.command('spin', () => { try { for (;;) {} } catch { return 'caught' } })
              ctx.command('spinLater', async () => { await null; for (;;) {} })
              // Never yields to the host: each step is short, but the steps don't end.
              ctx.command('awaitForever', async () => { for (;;) await null })
              ctx.command('ping', () => 'pong')
            }
            "#,
        )
        .await;
        // Stopped by the slice (its try/catch can't keep it going), not by the call's limit.
        let spun = s.call("busy", "spin", Value::Null).await.unwrap_err();
        assert_eq!(spun.code, ErrorCode::Timeout, "{spun}");
        assert!(spun.message.contains("without a break"), "{spun}");
        assert_eq!(s.call("busy", "ping", Value::Null).await, Ok(json!("pong")));
        for command in ["spinLater", "awaitForever"] {
            let late = s.call("busy", command, Value::Null).await.unwrap_err();
            assert_eq!(late.code, ErrorCode::Timeout, "{command}: {late}");
            assert_eq!(s.call("busy", "ping", Value::Null).await, Ok(json!("pong")));
        }
    }

    #[tokio::test]
    async fn memory_limit_is_per_plugin() {
        let s = Setup::new(quick());
        let main = r#"
            export function apply(ctx) {
              const held = []
              ctx.command('hold', (mb) => { held.push(new Uint8Array(mb << 20)); return held.length })
              ctx.command('bomb', () => { const k = []; for (;;) k.push(new Array(1 << 20).fill(1.5)) })
              ctx.command('ping', () => ctx.id)
            }
        "#;
        s.load("alpha", main).await;
        s.load("beta", main).await;
        // 80 MB between them: more than one runtime's 64 MB, so each has its own.
        assert_eq!(s.call("alpha", "hold", json!(40)).await, Ok(json!(1)));
        assert_eq!(s.call("beta", "hold", json!(40)).await, Ok(json!(1)));
        let more = s.call("alpha", "hold", json!(40)).await.unwrap_err();
        assert_eq!(more.code, ErrorCode::Limit, "{more}");
        let bomb = s.call("alpha", "bomb", Value::Null).await.unwrap_err();
        assert_eq!(bomb.code, ErrorCode::Limit, "{bomb}");
        assert!(bomb.message.contains("memory"), "{bomb}");
        assert_eq!(s.call("beta", "ping", Value::Null).await, Ok(json!("beta")));
        assert_eq!(
            s.call("alpha", "ping", Value::Null).await,
            Ok(json!("alpha"))
        );
    }

    #[tokio::test]
    async fn every_rejects_interval_below_10s() {
        let s = Setup::new(Limits::default());
        s.load(
            "timer",
            r#"
            export function apply(ctx) {
              ctx.command('every', (seconds) => {
                try { ctx.every(seconds, () => {}); return 'ok' } catch (e) { return `${e.code}|${e.message}` }
              })
            }
            "#,
        )
        .await;
        let refused = json!("limit|limit: ctx.every needs at least 10 s between runs");
        for seconds in [json!(5), json!(9.99), json!(0), json!(-10), json!("soon")] {
            assert_eq!(s.call("timer", "every", seconds).await, Ok(refused.clone()));
        }
        for seconds in [json!(10), json!(30), json!(3600)] {
            assert_eq!(s.call("timer", "every", seconds).await, Ok(json!("ok")));
        }
    }

    #[tokio::test]
    async fn every_ticks_on_the_host_thread() {
        let s = Setup::new(Limits {
            min_every: Duration::from_millis(50),
            ..quick()
        });
        s.load(
            "ticks",
            r#"
            export function apply(ctx) {
              let n = 0
              ctx.every(0.05, () => { n += 1 })
              ctx.every(0.05, () => { throw new Error('a failing tick is only logged') })
              ctx.command('n', () => n)
            }
            "#,
        )
        .await;
        assert_eq!(s.call("ticks", "n", Value::Null).await, Ok(json!(0)));
        let deadline = Instant::now() + Duration::from_secs(10);
        loop {
            let n = s.call("ticks", "n", Value::Null).await.unwrap();
            if n.as_u64().unwrap() >= 3 {
                break;
            }
            assert!(Instant::now() < deadline, "only {n} ticks in 10 s");
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
    }

    #[tokio::test]
    async fn missing_namespaces_are_undefined_or_throw_unsupported() {
        let s = Setup::new(quick());
        s.load(
            "compat",
            r#"
            export function apply(ctx) {
              // As Telegram does at start-up, outside any error handling: the plugin still loads.
              ctx.sessions.clearChannel()
              ctx.command('absent', () =>
                ['slots', 'threads', 'view', 'terminal', 'knowledge'].map((k) => typeof ctx[k]))
              ctx.command('unsupported', async () => {
                const out = {}
                const calls = {
                  'sessions.channel': () => ctx.sessions.channel({ plugin: 'x' }),
                  'sessions.skills': () => ctx.sessions.skills([]),
                  'channel.open': () => ctx.channel.open(),
                  'agent.set': () => ctx.agent.set({}),
                  'scripts.run': () => ctx.scripts.run('skill', 'run.sh', []),
                  'claude.hasPlugin': () => ctx.claude.hasPlugin('x@y'),
                  'claude.installPlugin': () => ctx.claude.installPlugin('x@y'),
                }
                for (const [name, f] of Object.entries(calls)) {
                  try { await f(); out[name] = 'resolved' } catch (e) { out[name] = `${e.code}|${e.message}` }
                }
                return out
              })
            }
            "#,
        )
        .await;
        assert_eq!(
            s.call("compat", "absent", Value::Null).await,
            Ok(json!(vec!["undefined"; 5]))
        );
        let out = s.call("compat", "unsupported", Value::Null).await.unwrap();
        let names = [
            "sessions.channel",
            "sessions.skills",
            "channel.open",
            "agent.set",
            "scripts.run",
            "claude.hasPlugin",
            "claude.installPlugin",
        ];
        assert_eq!(out.as_object().unwrap().len(), names.len(), "{out}");
        for name in names {
            assert_eq!(
                out[name],
                json!(format!(
                    "unsupported|unsupported: {name} is not available in CodeMie Connect yet"
                )),
                "{name}"
            );
        }
        assert!(
            s.services.heard.lock().unwrap().is_empty(),
            "none of them reached the services"
        );
    }

    #[tokio::test]
    async fn stores_are_isolated_between_plugins() {
        let s = Setup::new(quick());
        let main = r#"
            export function apply(ctx) {
              ctx.command('put', (text) => ctx.store.write('note.txt', text))
              // A plugin naming another plugin in its arguments still reaches only its own store.
              ctx.command('get', () => ctx.store.read('note.txt', { plugin: 'alpha' }))
              ctx.command('mark', () => { globalThis.mark = ctx.id; return typeof globalThis.__host })
              ctx.command('seen', () => (typeof globalThis.mark === 'undefined' ? null : globalThis.mark))
            }
        "#;
        s.load("alpha", main).await;
        s.load("beta", main).await;
        assert_eq!(s.call("alpha", "put", json!("a")).await, Ok(Value::Null));
        assert_eq!(s.call("beta", "get", Value::Null).await, Ok(Value::Null));
        assert_eq!(s.call("beta", "put", json!("b")).await, Ok(Value::Null));
        assert_eq!(s.call("alpha", "get", Value::Null).await, Ok(json!("a")));
        assert_eq!(s.call("beta", "get", Value::Null).await, Ok(json!("b")));
        let writers: Vec<String> = s
            .services
            .heard("store.write")
            .into_iter()
            .map(|(p, _)| p)
            .collect();
        assert_eq!(writers, ["alpha", "beta"]);
        // Nor do they share globals, or see the bridge.
        assert_eq!(
            s.call("alpha", "mark", Value::Null).await,
            Ok(json!("undefined"))
        );
        assert_eq!(s.call("beta", "seen", Value::Null).await, Ok(Value::Null));
        assert_eq!(
            s.call("alpha", "seen", Value::Null).await,
            Ok(json!("alpha"))
        );
    }

    #[tokio::test]
    async fn host_code_is_one_file_that_exports_apply() {
        let s = Setup::new(quick());
        let refused = |main: &str| {
            let path = s.write("bad", main);
            let host = &s.host;
            async move {
                host.load("bad", &path, Grants::default())
                    .await
                    .unwrap_err()
            }
        };
        let import = refused("import { x } from './other.js'\nexport function apply(ctx) {}").await;
        assert_eq!(import.code, ErrorCode::PluginError);
        assert!(import.message.contains("import"), "{import}");
        let reexport = refused("export * from './other.js'\nexport function apply(ctx) {}").await;
        assert!(reexport.message.contains("import"), "{reexport}");
        let no_apply = refused("export function start(ctx) {}").await;
        assert!(no_apply.message.contains("apply"), "{no_apply}");
        let syntax = refused("export function apply(ctx) {").await;
        assert_eq!(syntax.code, ErrorCode::PluginError);
        let throws = refused("export function apply(ctx) { throw new Error('broken') }").await;
        assert_eq!(throws, HostError::new(ErrorCode::PluginError, "broken"));
        assert_eq!(
            s.call("bad", "x", Value::Null).await.unwrap_err().code,
            ErrorCode::NotFound,
            "a plugin that failed to load isn't loaded"
        );
        s.load(
            "dynamic",
            r#"
            export function apply(ctx) {
              ctx.command('load', async () => { try { await import('./other.js') } catch (e) { return 'refused' } })
              ctx.command('globals', () => [typeof setTimeout, typeof require, typeof std, typeof os, typeof fetch])
            }
            "#,
        )
        .await;
        assert_eq!(
            s.call("dynamic", "load", Value::Null).await,
            Ok(json!("refused"))
        );
        assert_eq!(
            s.call("dynamic", "globals", Value::Null).await,
            Ok(json!(vec!["undefined"; 5]))
        );
    }

    #[tokio::test]
    async fn a_call_without_an_answer_times_out_and_unload_ends_the_rest() {
        let s = Arc::new(Setup::new(quick()));
        s.load(
            "slow",
            r#"
            export function apply(ctx) {
              ctx.command('wait', () => ctx.claude.run({ prompt: 'hi' }))
              ctx.command('ping', () => 'pong')
            }
            "#,
        )
        .await;
        let started = Instant::now();
        let waited = s.call("slow", "wait", Value::Null).await.unwrap_err();
        assert_eq!(waited.code, ErrorCode::Timeout, "{waited}");
        assert!(started.elapsed() >= quick().call, "{:?}", started.elapsed());
        assert_eq!(s.call("slow", "ping", Value::Null).await, Ok(json!("pong")));

        let waiting = tokio::spawn({
            let s = s.clone();
            async move { s.call("slow", "wait", Value::Null).await }
        });
        tokio::time::sleep(Duration::from_millis(100)).await;
        s.host.unload("slow").await;
        let ended = waiting.await.unwrap().unwrap_err();
        assert_eq!(ended.code, ErrorCode::NotFound, "{ended}");
        assert_eq!(
            s.call("slow", "ping", Value::Null).await.unwrap_err().code,
            ErrorCode::NotFound
        );
    }

    #[tokio::test]
    async fn events_reach_only_plugins_granted_them() {
        let s = Setup::new(quick());
        let main = r#"
            export function apply(ctx) {
              const heard = []
              let refused = null
              ctx.on('sources_changed', (p) => { heard.push(p.count) })
                .catch((e) => { refused = `${e.code}|${e.message}` })
              ctx.command('heard', () => ({ heard, refused }))
            }
        "#;
        let grants_of = |uses: Value| Grants::from_uses(uses.as_object().unwrap()).events;
        assert_eq!(
            grants_of(json!({"echo": {"read": ["people", "sources"]}})),
            BTreeSet::from(["minutes_written".into(), "sources_changed".into()]),
            "a plugin reading sources hears them change, as in Echo"
        );
        assert!(grants_of(json!({"echo": {"read": ["people", "dictionary"]}})).is_empty());
        let uses = json!({"events": {"on": ["sources_changed"]}});
        let grants = Grants::from_uses(uses.as_object().unwrap());
        assert_eq!(grants.events, BTreeSet::from(["sources_changed".into()]));
        s.load_with("hears", main, grants).await;
        s.load("deaf", main).await;
        s.host.emit("sources_changed", json!({"count": 3}));
        s.host.emit("threads_changed", json!({"count": 4}));
        let hears = s.call("hears", "heard", Value::Null).await.unwrap();
        assert_eq!(hears, json!({"heard": [3], "refused": null}));
        let deaf = s.call("deaf", "heard", Value::Null).await.unwrap();
        assert_eq!(deaf["heard"], json!([]));
        assert!(
            deaf["refused"]
                .as_str()
                .unwrap()
                .starts_with("permission|permission: "),
            "{deaf}"
        );
    }

    #[tokio::test]
    async fn providers_answer_the_host() {
        let s = Setup::new(quick());
        s.load(
            "giver",
            r#"
            export function apply(ctx) {
              ctx.widgets.provide('count', ({ size }) => ({ value: 7, size }))
              ctx.deliver.provide('telegram', { label: 'Telegram', send: async (msg) => `sent ${msg.title}` })
            }
            "#,
        )
        .await;
        assert_eq!(
            s.host
                .ask("giver", "widget:count", json!({"size": "M"}))
                .await,
            Ok(json!({"value": 7, "size": "M"}))
        );
        assert_eq!(
            s.host
                .ask("giver", "deliver:telegram", json!({"title": "Hi"}))
                .await,
            Ok(json!("sent Hi"))
        );
        assert_eq!(
            s.host
                .ask("giver", "work", Value::Null)
                .await
                .unwrap_err()
                .code,
            ErrorCode::NotFound
        );
        assert_eq!(
            s.services.heard("deliver.provide"),
            vec![(
                "giver".to_string(),
                json!(["telegram", {"label": "Telegram"}])
            )]
        );
        assert_eq!(
            s.call("giver", "widget:count", Value::Null)
                .await
                .unwrap_err()
                .code,
            ErrorCode::NotFound,
            "a provider isn't a command"
        );
    }

    #[tokio::test]
    async fn oversized_json_is_refused_with_limit() {
        let s = Setup::new(Limits {
            max_json: 1024,
            ..quick()
        });
        s.load(
            "big",
            r#"
            export function apply(ctx) {
              ctx.command('write', () => {
                try { ctx.store.write('x', 'y'.repeat(2000)) } catch (e) { return e.code }
              })
              ctx.command('answer', () => 'z'.repeat(2000))
              ctx.command('echo', (x) => x)
            }
            "#,
        )
        .await;
        assert_eq!(
            s.call("big", "write", Value::Null).await,
            Ok(json!("limit"))
        );
        assert_eq!(
            s.call("big", "answer", Value::Null).await.unwrap_err().code,
            ErrorCode::Limit
        );
        assert_eq!(
            s.call("big", "echo", json!("w".repeat(2000)))
                .await
                .unwrap_err()
                .code,
            ErrorCode::Limit
        );
        assert!(s.services.heard("store.write").is_empty());
    }
}
