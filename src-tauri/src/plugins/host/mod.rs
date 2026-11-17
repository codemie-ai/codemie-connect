//! Plugin host halves (PLUGIN-ENGINE.md §4, DESIGN 7.2): each plugin's `main.js` runs in its own
//! QuickJS runtime and context on its own thread (`worker`), under `Limits`: 64 MB, a 5 s slice
//! of JavaScript per turn (and twice that of wall time), 30 s a call. The plugin gets `ctx`
//! (`prelude.js`) from `apply(ctx)`; `ctx` reaches Connect only through `HostServices`, which
//! always hears the plugin's id from the runtime, never from the plugin's arguments. `bridge` is
//! one plugin's runtime and the text-only bridge into it.
//!
//! A plugin that runs past its turn, or keeps a caller past the call limit, is stopped: its
//! callers hear `timeout`, and it starts again from its package on its next use.
//!
//! Not in Connect (PLUGIN-ENGINE.md §10): `sessions`, `channel`, `agent`, `scripts`, `slots`,
//! `threads`, `view`, `knowledge` and `claude.hasPlugin/installPlugin` are `undefined`, and
//! `terminal` is `false`. A plugin that calls one of them unguarded fails as it would anywhere
//! (Telegram's `apply` does, so it doesn't load until it checks).
mod bridge;
mod worker;

use bridge::{Kind, Package};
use futures_util::future::BoxFuture;
use serde::Serialize;
use serde_json::{Map, Value};
use std::collections::{BTreeSet, HashMap};
use std::path::Path;
use std::sync::atomic::{AtomicU64, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex, MutexGuard, PoisonError};
use std::time::{Duration, Instant};
use tokio::sync::oneshot;
use worker::{on_plugin_thread, Msg, Worker};

/// How long unloading waits for a plugin's thread before leaving it to end on its own.
const LET_GO: Duration = Duration::from_secs(2);

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
    /// Answers now. It runs on the plugin's own thread while its JavaScript waits (that wait
    /// counts against the turn's wall time, not its JavaScript slice), so it should be quick;
    /// it can't call back into the `PluginHost` (refused). Its first `unsupported` answer to
    /// each service is logged.
    fn sync(&self, plugin: &str, name: &str, args: Value) -> Result<Value, HostError>;
    /// Answers later: the plugin gets a promise, settled on its thread when this future is
    /// done. Dropped unfinished when the plugin stops.
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
    /// JavaScript time of one turn: a message from the host (a call, an event, the due timers,
    /// an async answer) and the promise jobs after it. A turn also ends after twice this of wall
    /// time, host services included. A plugin that runs past it is stopped.
    pub slice: Duration,
    /// A command or provider answers its caller within this, or the caller is told `timeout`
    /// and the plugin is stopped. Time it spends waiting for its async host calls (a Claude run,
    /// a fetch) doesn't count: those are bounded by their own timeouts, and by `host_wait`.
    pub call: Duration,
    /// How much longer than `call` a caller waits in all, while the plugin waits for its host
    /// calls (a Claude run takes up to 20 min).
    pub host_wait: Duration,
    /// A plugin stopped for a fault starts again on its own after this (its timers resume),
    /// doubling while it keeps faulting, up to `restart_max`.
    pub restart: Duration,
    pub restart_max: Duration,
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
            host_wait: Duration::from_secs(21 * 60),
            restart: Duration::from_secs(30),
            restart_max: Duration::from_secs(10 * 60),
            min_every: Duration::from_secs(10),
            max_json: 16 * 1024 * 1024,
        }
    }
}

impl Limits {
    /// The pause before a plugin that faulted again starts again: `restart`, doubled after each
    /// fault, up to `restart_max`. `last` is the pause before this fault (none after one that
    /// came long after the last restart).
    pub fn next_restart(&self, last: Option<Duration>) -> Duration {
        last.map_or(self.restart, |d| (d * 2).min(self.restart_max))
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

/// A loaded plugin: its package, and its thread while it has one (none after it was stopped
/// for keeping a caller too long, until its next use or `revive_at`).
struct Entry {
    package: Arc<Package>,
    worker: Option<Worker>,
    /// When its current thread started.
    started: Instant,
    /// After a stop, when it starts again on its own (`PluginHost::revive_due`), and the pause
    /// before that.
    revive_at: Option<Instant>,
    pause: Option<Duration>,
}

/// The plugins' host halves: one QuickJS runtime per plugin, each on its own thread, driven by
/// messages. Callers wait for answers asynchronously, so a Tauri command may await them on the
/// async runtime.
pub struct PluginHost {
    services: Arc<dyn HostServices>,
    limits: Arc<Limits>,
    plugins: Mutex<HashMap<String, Entry>>,
    next_serial: AtomicU64,
}

impl PluginHost {
    pub fn new(services: Arc<dyn HostServices>) -> PluginHost {
        PluginHost::with_limits(services, Limits::default())
    }

    pub fn with_limits(services: Arc<dyn HostServices>, limits: Limits) -> PluginHost {
        PluginHost {
            services,
            limits: Arc::new(limits),
            plugins: Mutex::new(HashMap::new()),
            next_serial: AtomicU64::new(0),
        }
    }

    /// Loads `id` from its `main.js` (replacing a loaded one): evaluates it and runs its
    /// `apply(ctx)`. A plugin that fails to load isn't kept.
    pub async fn load(&self, id: &str, main_js: &Path, grants: Grants) -> Result<(), HostError> {
        refuse_reentry()?;
        let source = std::fs::read_to_string(main_js).map_err(|e| {
            let message = format!("can't read {}: {e}", main_js.display());
            HostError::new(ErrorCode::NotFound, message)
        })?;
        let file = main_js
            .file_name()
            .map(|f| f.to_string_lossy().into_owned())
            .unwrap_or_else(|| "main.js".into());
        self.unload(id).await;
        let package = Arc::new(Package {
            id: id.to_string(),
            file,
            source,
            grants,
        });
        let (reply, answer) = oneshot::channel();
        let worker = self.spawn(&package, Some(reply))?;
        let loaded = match self.answer_of(answer, &worker.waiting).await {
            Some(Ok(loaded)) => loaded,
            Some(Err(_)) => Err(stopped(id)),
            None => Err(HostError::new(
                ErrorCode::Timeout,
                format!(
                    "apply(ctx) didn't finish within {} s",
                    self.limits.call.as_secs_f64()
                ),
            )),
        };
        if let Err(e) = loaded {
            worker.stop(HostError::new(
                ErrorCode::NotFound,
                format!("{id} didn't load"),
            ));
            return Err(e);
        }
        let entry = Entry {
            package,
            worker: Some(worker),
            started: Instant::now(),
            revive_at: None,
            pause: None,
        };
        if let Some(old) = self.plugins().insert(id.to_string(), entry) {
            if let Some(worker) = old.worker {
                worker.stop(HostError::new(
                    ErrorCode::NotFound,
                    format!("{id} was replaced"),
                ));
            }
        }
        Ok(())
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
        refuse_reentry()?;
        let (reply, answer) = oneshot::channel();
        let (serial, waiting) = {
            let mut plugins = self.plugins();
            let Some(entry) = plugins.get_mut(id) else {
                return Err(HostError::new(
                    ErrorCode::NotFound,
                    format!("no plugin “{id}” is loaded"),
                ));
            };
            let worker = self.worker(entry)?;
            worker.send(Msg::Call {
                kind,
                name: name.to_string(),
                args,
                reply,
            });
            (worker.serial, worker.waiting.clone())
        };
        match self.answer_of(answer, &waiting).await {
            Some(Ok(outcome)) => outcome,
            Some(Err(_)) => Err(stopped(id)),
            None => {
                let e = HostError::new(
                    ErrorCode::Timeout,
                    format!(
                        "“{name}” didn't answer within {} s",
                        self.limits.call.as_secs_f64()
                    ),
                );
                self.stop_late(id, serial, &e);
                Err(e)
            }
        }
    }

    /// Waits for a plugin's answer. Only the time while none of its async host calls is in
    /// flight counts against the call limit: waiting for Claude or the network is the host's
    /// time, bounded by those services' own timeouts and by `host_wait` in all. `None`: no
    /// answer in time.
    async fn answer_of<T>(
        &self,
        mut answer: oneshot::Receiver<T>,
        waiting: &AtomicUsize,
    ) -> Option<Result<T, oneshot::error::RecvError>> {
        let tick =
            (self.limits.call / 20).clamp(Duration::from_millis(5), Duration::from_millis(100));
        let started = Instant::now();
        let mut last = started;
        let mut own = Duration::ZERO;
        loop {
            if let Ok(answer) = tokio::time::timeout(tick, &mut answer).await {
                return Some(answer);
            }
            let now = Instant::now();
            if waiting.load(Ordering::SeqCst) == 0 {
                own += now - last;
            }
            last = now;
            if own >= self.limits.call || now - started >= self.limits.call + self.limits.host_wait
            {
                return None;
            }
        }
    }

    /// Tells every plugin granted `event` (`uses.events.on`) that it happened.
    pub fn emit(&self, event: &str, payload: Value) {
        self.emit_where(event, payload, |_| true);
    }

    /// Tells the plugins of `ids` granted `event` that it happened.
    pub fn emit_to(&self, ids: &[String], event: &str, payload: Value) {
        self.emit_where(event, payload, |id| ids.iter().any(|i| i == id));
    }

    fn emit_where(&self, event: &str, payload: Value, to: impl Fn(&str) -> bool) {
        let mut plugins = self.plugins();
        let hearing = plugins
            .values_mut()
            .filter(|e| e.package.grants.events.contains(event) && to(&e.package.id));
        for entry in hearing {
            match self.worker(entry) {
                Ok(worker) => worker.send(Msg::Emit {
                    event: event.to_string(),
                    payload: payload.clone(),
                }),
                Err(e) => log::warn!("[plugin:{}] {event}: {e}", entry.package.id),
            }
        }
    }

    /// Stops the plugin and drops its runtime, timers and calls in flight (their callers hear
    /// `not_found`). Waits up to 2 s for its thread; one stuck in a service is left to end on
    /// its own.
    pub async fn unload(&self, id: &str) {
        if on_plugin_thread() {
            log::warn!("[plugin:{id}] {}", reentry());
            return;
        }
        let Some(worker) = self.plugins().remove(id).and_then(|e| e.worker) else {
            return;
        };
        worker.stop(HostError::new(
            ErrorCode::NotFound,
            format!("{id} was unloaded"),
        ));
        let deadline = Instant::now() + LET_GO;
        while !worker.is_finished() {
            if Instant::now() >= deadline {
                log::warn!(
                    "[plugin:{id}] still busy {} s after it was unloaded; left to end on its own",
                    LET_GO.as_secs()
                );
                return;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        worker.join();
    }

    fn plugins(&self) -> MutexGuard<'_, HashMap<String, Entry>> {
        self.plugins.lock().unwrap_or_else(PoisonError::into_inner)
    }

    fn spawn(
        &self,
        package: &Arc<Package>,
        load: Option<bridge::LoadReply>,
    ) -> Result<Worker, HostError> {
        Worker::spawn(
            package.clone(),
            self.services.clone(),
            self.limits.clone(),
            self.next_serial.fetch_add(1, Ordering::Relaxed),
            load,
        )
    }

    /// The plugin's thread, started again if it was stopped or has ended.
    fn worker<'a>(&self, entry: &'a mut Entry) -> Result<&'a Worker, HostError> {
        if entry.worker.as_ref().is_some_and(Worker::is_finished) {
            entry.worker = None;
        }
        if entry.worker.is_none() {
            entry.worker = Some(self.spawn(&entry.package, None)?);
            entry.started = Instant::now();
            entry.revive_at = None;
        }
        entry
            .worker
            .as_ref()
            .ok_or_else(|| stopped(&entry.package.id))
    }

    /// Starts again the plugins stopped for keeping a caller too long whose pause is over, so
    /// their timers resume without waiting for a use. The plugin manager calls it on its tick.
    pub fn revive_due(&self) {
        let now = Instant::now();
        let mut plugins = self.plugins();
        for entry in plugins.values_mut() {
            if entry.worker.is_none() && entry.revive_at.is_some_and(|at| now >= at) {
                log::info!(
                    "[plugin:{}] starting again after it was stopped",
                    entry.package.id
                );
                if let Err(e) = self.worker(entry) {
                    log::warn!("[plugin:{}] {e}", entry.package.id);
                }
            }
        }
    }

    /// Stops a plugin that kept a caller past the call limit (unless it was already replaced):
    /// its other callers hear `timeout`, and it starts again on its next use or after a pause.
    fn stop_late(&self, id: &str, serial: u64, why: &HostError) {
        let mut plugins = self.plugins();
        let Some(entry) = plugins.get_mut(id) else {
            return;
        };
        if entry.worker.as_ref().is_none_or(|w| w.serial != serial) {
            return;
        }
        if let Some(worker) = entry.worker.take() {
            log::warn!("[plugin:{id}] {why}; stopped, it starts again on its next use");
            worker.stop(HostError::new(
                ErrorCode::Timeout,
                format!("{id} was stopped: {}", why.message),
            ));
            let last = entry
                .pause
                .filter(|_| entry.started.elapsed() < self.limits.restart_max);
            let pause = self.limits.next_restart(last);
            entry.pause = Some(pause);
            entry.revive_at = Some(Instant::now() + pause);
        }
    }
}

impl Drop for PluginHost {
    fn drop(&mut self) {
        let plugins = self
            .plugins
            .get_mut()
            .unwrap_or_else(PoisonError::into_inner);
        let workers: Vec<(String, Worker)> = plugins
            .drain()
            .filter_map(|(id, e)| e.worker.map(|w| (id, w)))
            .collect();
        for (_, worker) in &workers {
            worker.stop(HostError::new(
                ErrorCode::NotFound,
                "the plugin host has stopped",
            ));
        }
        if on_plugin_thread() {
            return;
        }
        let deadline = Instant::now() + LET_GO;
        for (id, worker) in workers {
            while !worker.is_finished() && Instant::now() < deadline {
                std::thread::sleep(Duration::from_millis(5));
            }
            if worker.is_finished() {
                worker.join();
            } else {
                log::warn!(
                    "[plugin:{id}] still busy when the host stopped; left to end on its own"
                );
            }
        }
    }
}

fn stopped(id: &str) -> HostError {
    HostError::new(ErrorCode::NotFound, format!("{id} has stopped"))
}

fn reentry() -> HostError {
    HostError::new(
        ErrorCode::PluginError,
        "the plugin host can't call into itself from a plugin's own thread",
    )
}

/// A service running on a plugin's thread that waited on the host would wait on itself.
fn refuse_reentry() -> Result<(), HostError> {
    if on_plugin_thread() {
        return Err(reentry());
    }
    Ok(())
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
                // A slow service, or one stuck far past the call limit.
                "system.which" => {
                    let ms = if args[0] == "stuck" { 6000 } else { 50 };
                    std::thread::sleep(Duration::from_millis(ms));
                    Ok(Value::Null)
                }
                "settings.get" => Err(HostError::new(ErrorCode::Permission, "no settings here")),
                "profiles" | "work.changed" => Err(HostError::new(
                    ErrorCode::Unsupported,
                    format!("{name} is not available in CodeMie Connect yet"),
                )),
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
                        // "slow": longer than the call limit of `quick()`.
                        let ms = if args[0] == "slow" { 1500 } else { 30 };
                        tokio::time::sleep(Duration::from_millis(ms)).await;
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
        assert_eq!(l.host_wait, Duration::from_secs(21 * 60));
        assert_eq!(l.restart, Duration::from_secs(30));
        assert_eq!(l.restart_max, Duration::from_secs(600));
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
        assert!(spun.message.contains("slice"), "{spun}");
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
    async fn every_ticks_on_the_plugins_thread() {
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
    async fn missing_namespaces_are_undefined() {
        let s = Setup::new(quick());
        s.load(
            "compat",
            r#"
            export function apply(ctx) {
              ctx.command('absent', () =>
                ['slots', 'threads', 'view', 'knowledge', 'sessions', 'channel', 'agent', 'scripts']
                  .map((k) => typeof ctx[k])
                  .concat([typeof ctx.claude.hasPlugin, typeof ctx.claude.installPlugin]))
              ctx.command('terminal', () => ctx.terminal)
            }
            "#,
        )
        .await;
        assert_eq!(
            s.call("compat", "absent", Value::Null).await,
            Ok(json!(vec!["undefined"; 10]))
        );
        assert_eq!(
            s.call("compat", "terminal", Value::Null).await,
            Ok(json!(false))
        );
        // As Telegram does at start-up, outside any error handling: it doesn't load, and says
        // why.
        let path = s.write(
            "telegram",
            "export function apply(ctx) { ctx.sessions.clearChannel() }",
        );
        let refused = s
            .host
            .load("telegram", &path, Grants::default())
            .await
            .unwrap_err();
        assert_eq!(refused.code, ErrorCode::PluginError, "{refused}");
        assert!(refused.message.contains("clearChannel"), "{refused}");
        assert!(
            s.services.heard.lock().unwrap().is_empty(),
            "nothing reached the services"
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
              ctx.command('wait', () => new Promise(() => {}))
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
    async fn awaiting_a_host_call_is_not_the_plugins_time() {
        let s = Setup::new(Limits {
            host_wait: Duration::from_millis(800),
            ..quick()
        });
        s.load(
            "waits",
            r#"
            let n = 0
            export function apply(ctx) {
              // 1.5 s of a host call, then 0.5 s of its own waiting: past the 1 s call limit
              // only with the host's time counted.
              ctx.command('fetch', async () => {
                const r = await ctx.http.fetch('slow')
                await ctx.http.fetch('quick')
                n += 1
                return [r.status, n]
              })
              ctx.command('claude', () => ctx.claude.run({ prompt: 'never answered' }))
              ctx.command('n', () => n)
            }
            "#,
        )
        .await;
        let started = Instant::now();
        assert_eq!(
            bounded(s.call("waits", "fetch", Value::Null)).await,
            Ok(json!([200, 1]))
        );
        assert!(started.elapsed() >= Duration::from_millis(1500));
        // Not stopped: its state is still there.
        assert_eq!(s.call("waits", "n", Value::Null).await, Ok(json!(1)));
        // A host call that never answers is bounded by the call limit plus `host_wait`.
        let started = Instant::now();
        let e = bounded(s.call("waits", "claude", Value::Null))
            .await
            .unwrap_err();
        assert_eq!(e.code, ErrorCode::Timeout, "{e}");
        assert!(
            started.elapsed() >= Duration::from_millis(1800),
            "{:?}",
            started.elapsed()
        );
    }

    #[tokio::test]
    async fn a_faulted_plugin_starts_again_on_its_own_and_its_timers_resume() {
        let s = Setup::new(Limits {
            min_every: Duration::from_millis(50),
            restart: Duration::from_millis(700),
            restart_max: Duration::from_secs(5),
            ..quick()
        });
        s.load(
            "ticker",
            r#"
            export function apply(ctx) {
              ctx.every(0.05, () => ctx.store.write('tick', 'x'))
              ctx.command('spin', () => { for (;;) {} })
              ctx.command('hang', () => new Promise(() => {}))
            }
            "#,
        )
        .await;
        let ticks = || s.services.heard("store.write").len();
        let ticking = |from: usize| async move {
            let deadline = Instant::now() + Duration::from_secs(10);
            while ticks() < from + 2 {
                assert!(Instant::now() < deadline, "the timer didn't resume");
                tokio::time::sleep(Duration::from_millis(20)).await;
            }
        };
        ticking(0).await;
        // A fault inside its turn: the runtime is dropped, so its timer stops…
        let e = bounded(s.call("ticker", "spin", Value::Null))
            .await
            .unwrap_err();
        assert_eq!(e.code, ErrorCode::Timeout, "{e}");
        tokio::time::sleep(Duration::from_millis(100)).await;
        let stopped = ticks();
        tokio::time::sleep(Duration::from_millis(300)).await;
        assert_eq!(ticks(), stopped, "no ticks while it is down");
        // …and it starts again on its own after the pause, with no call to wake it.
        ticking(stopped).await;

        // Stopped for keeping a caller past the call limit: the host starts it again too.
        let e = bounded(s.call("ticker", "hang", Value::Null))
            .await
            .unwrap_err();
        assert_eq!(e.code, ErrorCode::Timeout, "{e}");
        tokio::time::sleep(Duration::from_millis(100)).await;
        let stopped = ticks();
        s.host.revive_due();
        tokio::time::sleep(Duration::from_millis(200)).await;
        assert_eq!(ticks(), stopped, "not before its pause is over");
        let deadline = Instant::now() + Duration::from_secs(10);
        while ticks() < stopped + 2 {
            assert!(Instant::now() < deadline, "the host didn't start it again");
            s.host.revive_due();
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
    }

    #[test]
    fn restart_pauses_double_up_to_the_most() {
        let l = Limits::default();
        assert_eq!(l.next_restart(None), Duration::from_secs(30));
        assert_eq!(
            l.next_restart(Some(Duration::from_secs(30))),
            Duration::from_secs(60)
        );
        assert_eq!(
            l.next_restart(Some(Duration::from_secs(480))),
            Duration::from_secs(600)
        );
        assert_eq!(
            l.next_restart(Some(Duration::from_secs(600))),
            Duration::from_secs(600)
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

    /// Fails the test, rather than hanging it, when the host doesn't answer.
    async fn bounded<T>(work: impl std::future::Future<Output = T>) -> T {
        tokio::time::timeout(Duration::from_secs(15), work)
            .await
            .expect("the host answered within 15 s")
    }

    /// Every log line of the test process; each test looks for its own plugin's.
    struct Capture;
    static LOGGED: Mutex<Vec<String>> = Mutex::new(Vec::new());

    impl log::Log for Capture {
        fn enabled(&self, _: &log::Metadata) -> bool {
            true
        }
        fn log(&self, record: &log::Record) {
            LOGGED.lock().unwrap().push(record.args().to_string());
        }
        fn flush(&self) {}
    }

    fn capture_logs() {
        static ONCE: std::sync::Once = std::sync::Once::new();
        ONCE.call_once(|| {
            let _ = log::set_logger(&Capture);
            log::set_max_level(log::LevelFilter::Info);
        });
    }

    fn logged(prefix: &str) -> Vec<String> {
        let lines = LOGGED.lock().unwrap();
        lines
            .iter()
            .filter(|l| l.starts_with(prefix))
            .cloned()
            .collect()
    }

    #[tokio::test]
    async fn errors_are_read_within_the_plugins_time() {
        let s = Setup::new(quick());
        s.load(
            "odd",
            r#"
            export function apply(ctx) {
              ctx.command('codeGetter', async () => {
                const e = new Error('m')
                Object.defineProperty(e, 'code', { get() { for (;;) {} } })
                throw e
              })
              ctx.command('messageGetter', async () => {
                await null
                const e = new Error('x')
                Object.defineProperty(e, 'message', { get() { for (;;) {} } })
                throw e
              })
              ctx.command('toStringLoop', () => { throw { toString() { for (;;) {} } } })
              ctx.command('forgedCode', () => {
                const e = new Error('permission: forged')
                e.code = 'permission'
                throw e
              })
              ctx.command('ping', () => 'pong')
            }
            "#,
        )
        .await;
        // The host never reads `code` of the plugin's own error.
        assert_eq!(
            bounded(s.call("odd", "codeGetter", Value::Null)).await,
            Err(HostError::new(ErrorCode::PluginError, "m"))
        );
        // A `message` getter runs within the turn: it is stopped, and the plugin with it.
        let started = Instant::now();
        let stopped = bounded(s.call("odd", "messageGetter", Value::Null))
            .await
            .unwrap_err();
        assert_eq!(stopped.code, ErrorCode::Timeout, "{stopped}");
        assert!(started.elapsed() < quick().call, "{:?}", started.elapsed());
        // Nothing of a thrown non-Error is read (no toString).
        assert_eq!(
            bounded(s.call("odd", "toStringLoop", Value::Null)).await,
            Err(HostError::new(
                ErrorCode::PluginError,
                "the plugin failed without a message"
            ))
        );
        // Only the host's own errors keep a code.
        assert_eq!(
            bounded(s.call("odd", "forgedCode", Value::Null)).await,
            Err(HostError::new(ErrorCode::PluginError, "permission: forged"))
        );
        assert_eq!(
            bounded(s.call("odd", "ping", Value::Null)).await,
            Ok(json!("pong"))
        );
    }

    #[tokio::test]
    async fn reentry_from_error_setters_is_harmless() {
        let s = Setup::new(quick());
        s.load(
            "setter",
            r#"
            export function apply(ctx) {
              for (let i = 0; i < 64; i++) ctx.every(3600, () => {})
              ctx.command('evil', () => {
                Object.defineProperty(Error.prototype, 'message', {
                  set(v) { ctx.every(3600, () => {}) }, get() { return 'x' }, configurable: true })
                try { ctx.every(3600, () => {}) } catch (e) { return `${e.code}|${e.message}` }
                finally { delete Error.prototype.message }
              })
              // The same, uncaught: the caller hears the host's own error.
              ctx.command('evilUncaught', () => {
                Object.defineProperty(Error.prototype, 'message', {
                  set(v) { ctx.every(3600, () => {}) }, get() { return 'x' }, configurable: true })
                try { ctx.every(3600, () => {}) } finally { delete Error.prototype.message }
              })
              ctx.command('ping', () => 'pong')
            }
            "#,
        )
        .await;
        assert_eq!(
            bounded(s.call("setter", "evil", Value::Null)).await,
            Ok(json!(
                "limit|limit: a plugin keeps at most 64 ctx.every timers"
            ))
        );
        assert_eq!(
            bounded(s.call("setter", "evilUncaught", Value::Null)).await,
            Err(HostError::new(
                ErrorCode::Limit,
                "a plugin keeps at most 64 ctx.every timers"
            ))
        );
        assert_eq!(
            bounded(s.call("setter", "ping", Value::Null)).await,
            Ok(json!("pong"))
        );
    }

    #[tokio::test]
    async fn runaway_timers_stall_only_their_plugin() {
        let s = Setup::new(Limits {
            min_every: Duration::from_millis(50),
            ..quick()
        });
        s.load(
            "hog",
            r#"
            export function apply(ctx) {
              for (let i = 0; i < 10; i++) ctx.every(0.05, () => { for (;;) {} })
              ctx.command('ping', () => 'hog')
            }
            "#,
        )
        .await;
        s.load(
            "victim",
            r#"export function apply(ctx) { ctx.command('ping', () => 'pong') }"#,
        )
        .await;
        for _ in 0..3 {
            tokio::time::sleep(Duration::from_millis(100)).await;
            let started = Instant::now();
            assert_eq!(
                bounded(s.call("victim", "ping", Value::Null)).await,
                Ok(json!("pong"))
            );
            assert!(started.elapsed() < quick().slice, "{:?}", started.elapsed());
        }
        // The hog itself still answers: a call waits at most for the turn under way.
        let started = Instant::now();
        assert_eq!(
            bounded(s.call("hog", "ping", Value::Null)).await,
            Ok(json!("hog"))
        );
        assert!(
            started.elapsed() < 4 * quick().slice,
            "{:?}",
            started.elapsed()
        );
    }

    #[tokio::test]
    async fn a_job_flood_faults_only_its_plugin() {
        let s = Arc::new(Setup::new(quick()));
        let main = r#"
            export function apply(ctx) {
              ctx.command('flood', () => {
                const f = () => { Promise.resolve().then(f); Promise.resolve().then(f) }
                f()
                return 'started'
              })
              ctx.command('ping', () => ctx.id)
            }
        "#;
        s.load("flood", main).await;
        s.load("calm", main).await;
        let flooding = tokio::spawn({
            let s = s.clone();
            async move {
                let started = Instant::now();
                let answer = bounded(s.call("flood", "flood", Value::Null)).await;
                (answer, started.elapsed())
            }
        });
        tokio::time::sleep(Duration::from_millis(50)).await;
        let started = Instant::now();
        assert_eq!(
            bounded(s.call("calm", "ping", Value::Null)).await,
            Ok(json!("calm"))
        );
        assert!(
            started.elapsed() < 2 * quick().slice,
            "{:?}",
            started.elapsed()
        );
        let (answer, took) = flooding.await.unwrap();
        assert_eq!(answer, Ok(json!("started")));
        assert!(took < 4 * quick().slice, "{took:?}");
        // The flood faulted the plugin; its next call starts it again.
        assert_eq!(
            bounded(s.call("flood", "ping", Value::Null)).await,
            Ok(json!("flood"))
        );
    }

    #[tokio::test]
    async fn slow_services_dont_stretch_a_turn_without_bound() {
        let s = Arc::new(Setup::new(quick()));
        s.load(
            "slow",
            r#"
            export function apply(ctx) {
              ctx.command('spin', () => { for (;;) ctx.system.which('git') })
              ctx.command('spinCaught', () => { for (;;) { try { ctx.system.which('git') } catch {} } })
              ctx.command('ping', () => 'pong')
            }
            "#,
        )
        .await;
        s.load(
            "victim",
            r#"export function apply(ctx) { ctx.command('ping', () => 'pong') }"#,
        )
        .await;
        for command in ["spin", "spinCaught"] {
            let spinning = tokio::spawn({
                let s = s.clone();
                async move {
                    let started = Instant::now();
                    (
                        bounded(s.call("slow", command, Value::Null)).await,
                        started.elapsed(),
                    )
                }
            });
            tokio::time::sleep(Duration::from_millis(100)).await;
            assert_eq!(
                bounded(s.call("victim", "ping", Value::Null)).await,
                Ok(json!("pong"))
            );
            let (answer, took) = spinning.await.unwrap();
            assert_eq!(answer.unwrap_err().code, ErrorCode::Timeout, "{command}");
            // Twice the slice of wall time, plus one slow call and a margin.
            assert!(took < 4 * quick().slice, "{command}: {took:?}");
            assert_eq!(
                bounded(s.call("slow", "ping", Value::Null)).await,
                Ok(json!("pong"))
            );
        }
    }

    #[tokio::test]
    async fn a_stuck_service_faults_its_plugin_and_unload_still_returns() {
        let s = Setup::new(quick());
        let main = r#"
            export function apply(ctx) {
              ctx.command('stuck', () => ctx.system.which('stuck'))
              ctx.command('ping', () => 'pong')
            }
        "#;
        s.load("stuck", main).await;
        let stuck = bounded(s.call("stuck", "stuck", Value::Null))
            .await
            .unwrap_err();
        assert_eq!(stuck.code, ErrorCode::Timeout, "{stuck}");
        assert!(stuck.message.contains("didn't answer"), "{stuck}");
        // Its thread is still inside the service: unload gives up on it after a bound.
        let started = Instant::now();
        bounded(s.host.unload("stuck")).await;
        assert!(
            started.elapsed() < Duration::from_secs(3),
            "{:?}",
            started.elapsed()
        );
        s.load("stuck", main).await;
        assert_eq!(
            bounded(s.call("stuck", "ping", Value::Null)).await,
            Ok(json!("pong"))
        );
        // A faulted plugin starts again on its next call.
        let again = bounded(s.call("stuck", "stuck", Value::Null))
            .await
            .unwrap_err();
        assert_eq!(again.code, ErrorCode::Timeout);
        assert_eq!(
            bounded(s.call("stuck", "ping", Value::Null)).await,
            Ok(json!("pong"))
        );
    }

    #[tokio::test]
    async fn unload_and_drop_let_go_of_a_stuck_plugin() {
        let s = Setup::new(Limits {
            call: Duration::from_secs(20),
            ..quick()
        });
        let main = r#"
            export function apply(ctx) {
              ctx.command('stuck', () => ctx.system.which('stuck'))
              ctx.command('ping', () => 'pong')
            }
        "#;
        s.load("stuck", main).await;
        // The caller gives up while the plugin's thread is still inside the 6 s service.
        let gave_up = tokio::time::timeout(
            Duration::from_millis(200),
            s.call("stuck", "stuck", Value::Null),
        );
        assert!(gave_up.await.is_err());
        let started = Instant::now();
        bounded(s.host.unload("stuck")).await;
        let took = started.elapsed();
        assert!(
            took >= Duration::from_millis(1500) && took < Duration::from_secs(4),
            "{took:?}"
        );
        assert_eq!(
            s.call("stuck", "ping", Value::Null).await.unwrap_err().code,
            ErrorCode::NotFound
        );
        s.load("stuck", main).await;
        let gave_up = tokio::time::timeout(
            Duration::from_millis(200),
            s.call("stuck", "stuck", Value::Null),
        );
        assert!(gave_up.await.is_err());
        let started = Instant::now();
        drop(s);
        assert!(
            started.elapsed() < Duration::from_secs(4),
            "{:?}",
            started.elapsed()
        );
    }

    #[tokio::test]
    async fn stack_hooks_cant_reach_the_bridge() {
        let s = Setup::new(quick());
        s.load(
            "grabber",
            r#"
            export function apply(ctx) {
              ctx.command('grab', () => {
                const grabbed = new Set()
                Error.prepareStackTrace = (e, sites) => {
                  for (const site of sites) {
                    try { const f = site.getFunction(); if (typeof f === 'function') grabbed.add(f) } catch {}
                  }
                  return ''
                }
                Object.defineProperty(Error.prototype, 'message', {
                  set(v) { new Error('probe'); Object.defineProperty(this, 'message', { value: v, writable: true, configurable: true }) },
                  get() { return '' }, configurable: true })
                try { ctx.settings.get('k') } catch (e) {}
                new Error('probe')
                delete Error.prototype.message
                Error.prepareStackTrace = undefined
                const out = []
                for (const f of grabbed) {
                  try { out.push(String(f('sessions.channel', '[{"plugin":"x"}]'))) } catch (e) { out.push('threw') }
                }
                return { out, capture: typeof Error.captureStackTrace }
              })
            }
            "#,
        )
        .await;
        assert_eq!(
            bounded(s.call("grabber", "grab", Value::Null)).await,
            Ok(json!({"out": [], "capture": "undefined"}))
        );
        assert!(s.services.heard("sessions.channel").is_empty());
    }

    #[tokio::test]
    async fn deep_json_and_recursion_hit_limits() {
        let s = Setup::new(Limits::default());
        s.load(
            "deep",
            r#"
            const nest = (n) => { let o = null; for (let i = 0; i < n; i++) o = [o]; return o }
            export function apply(ctx) {
              ctx.command('recurse', () => { const f = (n) => f(n + 1) + 1; return f(0) })
              ctx.command('recurseLater', async () => { await null; const f = (n) => f(n + 1) + 1; return f(0) })
              ctx.command('nested', () => nest(100000))
              ctx.command('nested200', () => nest(200))
              ctx.command('nestedArg', () => {
                try { ctx.store.write('k', nest(200)) } catch (e) { return `${e.code}|${e.message}` }
              })
              ctx.command('ping', () => 'pong')
            }
            "#,
        )
        .await;
        for command in ["recurse", "recurseLater", "nested", "nested200"] {
            let failed = bounded(s.call("deep", command, Value::Null))
                .await
                .unwrap_err();
            assert_eq!(failed.code, ErrorCode::Limit, "{command}: {failed}");
        }
        let nested = bounded(s.call("deep", "nested200", Value::Null))
            .await
            .unwrap_err();
        assert_eq!(nested.message, "JSON nested more than 128 levels deep");
        assert_eq!(
            bounded(s.call("deep", "nestedArg", Value::Null)).await,
            Ok(json!("limit|limit: JSON nested more than 128 levels deep"))
        );
        assert_eq!(
            bounded(s.call("deep", "ping", Value::Null)).await,
            Ok(json!("pong"))
        );

        let q = Setup::new(quick());
        q.load(
            "getter",
            r#"
            export function apply(ctx) {
              ctx.command('getter', () => ({ get x() { for (;;) {} } }))
              ctx.command('toJSON', () => ({ toJSON() { for (;;) {} } }))
              ctx.command('ping', () => 'pong')
            }
            "#,
        )
        .await;
        for command in ["getter", "toJSON"] {
            let failed = bounded(q.call("getter", command, Value::Null))
                .await
                .unwrap_err();
            assert_eq!(failed.code, ErrorCode::Timeout, "{command}: {failed}");
            assert_eq!(
                bounded(q.call("getter", "ping", Value::Null)).await,
                Ok(json!("pong"))
            );
        }
    }

    #[tokio::test]
    async fn async_host_calls_in_flight_are_capped() {
        let s = Setup::new(quick());
        s.load(
            "eager",
            r#"
            export function apply(ctx) {
              ctx.command('many', async () => {
                const waits = []
                for (let i = 0; i < 65; i++) waits.push(ctx.claude.run({}).then(() => 'answered', (e) => e.code))
                return await waits[64]
              })
            }
            "#,
        )
        .await;
        assert_eq!(
            bounded(s.call("eager", "many", Value::Null)).await,
            Ok(json!("limit"))
        );
        assert_eq!(s.services.heard("claude.run").len(), 64);
    }

    #[tokio::test]
    async fn unsupported_calls_and_unhandled_rejections_are_logged() {
        capture_logs();
        let s = Setup::new(quick());
        s.load(
            "noisy",
            r#"
            export function apply(ctx) {
              ctx.command('unsupported', () => {
                for (const f of [ctx.profiles, ctx.profiles, () => ctx.work.changed()]) {
                  try { f() } catch (e) { if (e.code !== 'unsupported') throw e }
                }
              })
              ctx.command('unhandled', () => { Promise.reject(new Error('nobody looked')); return 'ok' })
              ctx.command('handledLater', async () => {
                const p = Promise.reject(new Error('looked at later'))
                await null
                p.catch(() => {})
                return 'ok'
              })
              ctx.command('fails', async () => { throw new Error('answered the caller') })
            }
            "#,
        )
        .await;
        for command in ["unsupported", "unhandled", "handledLater"] {
            bounded(s.call("noisy", command, Value::Null))
                .await
                .unwrap();
        }
        bounded(s.call("noisy", "fails", Value::Null))
            .await
            .unwrap_err();
        let unsupported = logged("[plugin:noisy] unsupported:");
        assert_eq!(
            unsupported,
            [
                "[plugin:noisy] unsupported: profiles is not available in CodeMie Connect yet",
                "[plugin:noisy] unsupported: work.changed is not available in CodeMie Connect yet",
            ]
        );
        assert_eq!(
            logged("[plugin:noisy] unhandled rejection:"),
            ["[plugin:noisy] unhandled rejection: nobody looked"]
        );
    }

    /// Services that call back into the host, as a careless one might.
    #[derive(Default)]
    struct Loopback {
        host: std::sync::OnceLock<std::sync::Weak<PluginHost>>,
    }

    impl HostServices for Loopback {
        fn sync(&self, plugin: &str, _name: &str, _args: Value) -> Result<Value, HostError> {
            use futures_util::FutureExt;
            let host = self.host.get().and_then(|h| h.upgrade()).expect("the host");
            let answer = host.call(plugin, "ping", Value::Null).now_or_never();
            Ok(json!(format!("{answer:?}")))
        }

        fn spawn_async(
            &self,
            _plugin: &str,
            _name: &str,
            _args: Value,
        ) -> BoxFuture<'static, Result<Value, HostError>> {
            Box::pin(async { Ok(Value::Null) })
        }
    }

    #[tokio::test]
    async fn a_plugin_cannot_wait_on_itself() {
        let services = Arc::new(Loopback::default());
        let host = Arc::new(PluginHost::with_limits(services.clone(), quick()));
        services.host.set(Arc::downgrade(&host)).unwrap();
        let dir = tempfile::tempdir().unwrap();
        let main = dir.path().join("main.js");
        std::fs::write(
            &main,
            r#"
            export function apply(ctx) {
              ctx.command('self', () => ctx.system.which('x'))
              ctx.command('ping', () => 'pong')
            }
            "#,
        )
        .unwrap();
        host.load("loop", &main, Grants::default()).await.unwrap();
        let answer = bounded(host.call("loop", "self", Value::Null))
            .await
            .unwrap();
        assert!(
            answer.as_str().unwrap().contains("can't call into itself"),
            "{answer}"
        );
        assert_eq!(
            bounded(host.call("loop", "ping", Value::Null)).await,
            Ok(json!("pong"))
        );
    }

    #[tokio::test]
    async fn a_new_timer_first_runs_after_a_second() {
        let s = Setup::new(Limits::default());
        s.load(
            "soon",
            r#"
            export function apply(ctx) {
              let n = 0
              ctx.every(3600, () => { n += 1 })
              ctx.command('n', () => n)
            }
            "#,
        )
        .await;
        let started = Instant::now();
        assert_eq!(s.call("soon", "n", Value::Null).await, Ok(json!(0)));
        loop {
            if s.call("soon", "n", Value::Null).await == Ok(json!(1)) {
                break;
            }
            assert!(started.elapsed() < Duration::from_secs(5), "never ran");
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
        assert!(
            started.elapsed() >= Duration::from_millis(800),
            "{:?}",
            started.elapsed()
        );
    }
}
