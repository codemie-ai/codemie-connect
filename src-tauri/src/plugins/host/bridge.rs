//! One plugin's QuickJS runtime and the bridge between its JavaScript and the host.
//!
//! Only JSON crosses the bridge, as text, both ways: the plugin hands no object to the host,
//! and the host hands it none. Every JavaScript entry (loading, a call, an event, a timer tick,
//! settling a promise and the jobs that follow) runs within a slice the interrupt handler
//! enforces. Everything here lives on the host thread.
use super::{ErrorCode, Grants, HostError, HostServices, Limits, Msg};
use rquickjs::promise::PromiseState;
use rquickjs::{
    CatchResultExt, CaughtError, Context, Ctx, Exception, Function, Module, Object, Persistent,
    Promise, Runtime, Value,
};
use serde_json::Value as Json;
use std::cell::{Cell, RefCell};
use std::collections::HashMap;
use std::rc::Rc;
use std::sync::{mpsc, Arc};
use std::time::{Duration, Instant};
use tokio::sync::oneshot;

/// The prelude: a script whose value builds `ctx` from the bridge (see the file).
const PRELUDE: &str = include_str!("prelude.js");

/// Timers one plugin may keep.
const MAX_TIMERS: usize = 64;

/// What the bridge's functions share with the host (they live in the runtime, the host
/// outside it).
struct State {
    plugin: String,
    generation: u64,
    limits: Arc<Limits>,
    grants: Grants,
    /// When the JavaScript running now must stop.
    deadline: Cell<Option<Instant>>,
    /// Async host calls waiting for their answer, by token.
    pending: RefCell<HashMap<u64, Pending>>,
    next_token: Cell<u64>,
    timers: RefCell<Vec<Timer>>,
}

struct Pending {
    resolve: Persistent<Function<'static>>,
    reject: Persistent<Function<'static>>,
    task: tauri::async_runtime::JoinHandle<()>,
}

struct Timer {
    id: u32,
    every: Duration,
    next: Instant,
}

impl State {
    fn stop_now(&self) -> bool {
        self.deadline.get().is_some_and(|d| Instant::now() >= d)
    }

    /// Host time isn't the plugin's: the slice is moved on by what a service took.
    fn exclude(&self, since: Instant) {
        if let Some(d) = self.deadline.get() {
            self.deadline.set(Some(d + since.elapsed()));
        }
    }

    fn parse(&self, json: &str) -> Result<Json, HostError> {
        if json.len() > self.limits.max_json {
            return Err(too_big(&self.limits));
        }
        serde_json::from_str(json)
            .map_err(|e| HostError::new(ErrorCode::PluginError, e.to_string()))
    }

    fn text(&self, value: &Json) -> Result<String, HostError> {
        let json = value.to_string();
        if json.len() > self.limits.max_json {
            return Err(too_big(&self.limits));
        }
        Ok(json)
    }
}

fn too_big(limits: &Limits) -> HostError {
    HostError::new(
        ErrorCode::Limit,
        format!("more than {} bytes of JSON in one call", limits.max_json),
    )
}

/// What every plugin's bridge is wired to.
pub(super) struct Wiring {
    pub services: Arc<dyn HostServices>,
    pub limits: Arc<Limits>,
    /// The host thread's own queue, for async answers.
    pub host: mpsc::Sender<Msg>,
}

/// Who waits for a promise the plugin returned.
pub(super) enum Reply {
    Load(oneshot::Sender<Result<(), HostError>>),
    Call(oneshot::Sender<Result<Json, HostError>>),
}

impl Reply {
    fn send(self, outcome: Result<Json, HostError>) {
        match self {
            Reply::Load(tx) => drop(tx.send(outcome.map(|_| ()))),
            Reply::Call(tx) => drop(tx.send(outcome)),
        }
    }

    fn is_closed(&self) -> bool {
        match self {
            Reply::Load(tx) => tx.is_closed(),
            Reply::Call(tx) => tx.is_closed(),
        }
    }
}

struct Waiting {
    promise: Persistent<Promise<'static>>,
    deadline: Instant,
    reply: Reply,
    what: String,
}

/// What `dispatch` runs: the prelude's kinds.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) enum Kind {
    Command,
    Provider,
    Event,
    Timer,
}

impl Kind {
    fn as_str(self) -> &'static str {
        match self {
            Kind::Command => "command",
            Kind::Provider => "provider",
            Kind::Event => "event",
            Kind::Timer => "timer",
        }
    }
}

/// A loaded plugin. Its JavaScript handles are released before its context and runtime
/// (field order, and `Drop`): QuickJS refuses to free a runtime something still points into.
pub(super) struct Plugin {
    dispatch: Option<Persistent<Function<'static>>>,
    waiting: Vec<Waiting>,
    state: Rc<State>,
    context: Context,
    runtime: Runtime,
}

impl Drop for Plugin {
    fn drop(&mut self) {
        let gone = || {
            HostError::new(
                ErrorCode::NotFound,
                format!("{} was unloaded", self.state.plugin),
            )
        };
        for w in self.waiting.drain(..) {
            w.reply.send(Err(gone()));
        }
        for (_, p) in self.state.pending.borrow_mut().drain() {
            p.task.abort();
        }
        self.dispatch = None;
    }
}

impl Plugin {
    /// Builds the plugin's runtime, evaluates `main.js` and starts `apply(ctx)`; `reply` hears
    /// when it has finished, or why it failed (and then there is no plugin).
    pub fn load(
        id: &str,
        generation: u64,
        file: &str,
        source: String,
        grants: Grants,
        wiring: &Wiring,
        reply: oneshot::Sender<Result<(), HostError>>,
    ) -> Option<Plugin> {
        let mut plugin = match Plugin::new(id, generation, grants, &wiring.limits) {
            Ok(p) => p,
            Err(e) => {
                let _ = reply.send(Err(e));
                return None;
            }
        };
        match plugin.start(file, source, wiring) {
            Ok(promise) => {
                plugin.wait(promise, Reply::Load(reply), "apply(ctx)".into());
                Some(plugin)
            }
            Err(e) => {
                let _ = reply.send(Err(e));
                None
            }
        }
    }

    fn new(
        id: &str,
        generation: u64,
        grants: Grants,
        limits: &Arc<Limits>,
    ) -> Result<Plugin, HostError> {
        let internal = |e: rquickjs::Error| HostError::new(ErrorCode::PluginError, e.to_string());
        let runtime = Runtime::new().map_err(internal)?;
        runtime.set_memory_limit(limits.memory);
        runtime.set_max_stack_size(limits.stack);
        let state = Rc::new(State {
            plugin: id.to_string(),
            generation,
            limits: limits.clone(),
            grants,
            deadline: Cell::new(None),
            pending: RefCell::new(HashMap::new()),
            next_token: Cell::new(0),
            timers: RefCell::new(Vec::new()),
        });
        let watch = state.clone();
        runtime.set_interrupt_handler(Some(Box::new(move || watch.stop_now())));
        let context = Context::full(&runtime).map_err(internal)?;
        Ok(Plugin {
            dispatch: None,
            waiting: Vec::new(),
            state,
            context,
            runtime,
        })
    }

    pub fn id(&self) -> &str {
        &self.state.plugin
    }

    pub fn generation(&self) -> u64 {
        self.state.generation
    }

    pub fn hears(&self, event: &str) -> bool {
        self.state.grants.events.contains(event)
    }

    /// Runs JavaScript within one slice.
    fn slice<R>(&self, f: impl FnOnce(&Ctx<'_>) -> R) -> R {
        self.state
            .deadline
            .set(Some(Instant::now() + self.state.limits.slice));
        let out = self.context.with(|ctx| f(&ctx));
        self.state.deadline.set(None);
        out
    }

    /// The prelude, then `main.js` as a module, then `apply(ctx)`: the promise of its end.
    fn start(
        &mut self,
        file: &str,
        source: String,
        wiring: &Wiring,
    ) -> Result<Persistent<Promise<'static>>, HostError> {
        let state = self.state.clone();
        let (dispatch, load, evaluated, exports) = self.slice(|ctx| {
            let built = (|| {
                let make: Function = ctx.eval(PRELUDE)?;
                let made: Object = make.call((bridge(ctx, &state, wiring)?,))?;
                let dispatch: Function = made.get("dispatch")?;
                let load: Function = made.get("load")?;
                Ok((dispatch, load))
            })();
            let (dispatch, load) = built.catch(ctx).map_err(|e| error_of(e, &state))?;
            let module = Module::declare(ctx.clone(), file, source)
                .catch(ctx)
                .map_err(|e| load_error(file, error_of(e, &state)))?;
            let (module, evaluated) = module
                .eval()
                .catch(ctx)
                .map_err(|e| load_error(file, error_of(e, &state)))?;
            let exports = module
                .namespace()
                .catch(ctx)
                .map_err(|e| error_of(e, &state))?;
            Ok::<_, HostError>((
                Persistent::save(ctx, dispatch),
                Persistent::save(ctx, load),
                Persistent::save(ctx, evaluated),
                Persistent::save(ctx, exports),
            ))
        })?;
        self.dispatch = Some(dispatch);
        self.run_jobs();
        self.slice(|ctx| {
            let evaluated = evaluated
                .restore(ctx)
                .map_err(|e| error_of(CaughtError::Error(e), &state))?;
            match evaluated.state() {
                PromiseState::Resolved => {}
                PromiseState::Rejected => {
                    return Err(load_error(file, rejection(ctx, &evaluated, &state)))
                }
                PromiseState::Pending => {
                    return Err(HostError::new(
                        ErrorCode::PluginError,
                        format!("{file} waits at its top level; start its work in apply(ctx)"),
                    ))
                }
            }
            let load = load
                .restore(ctx)
                .map_err(|e| error_of(CaughtError::Error(e), &state))?;
            let exports = exports
                .restore(ctx)
                .map_err(|e| error_of(CaughtError::Error(e), &state))?;
            let started: Promise = load
                .call((exports,))
                .catch(ctx)
                .map_err(|e| error_of(e, &state))?;
            Ok(Persistent::save(ctx, started))
        })
    }

    fn wait(&mut self, promise: Persistent<Promise<'static>>, reply: Reply, what: String) {
        self.waiting.push(Waiting {
            promise,
            deadline: Instant::now() + self.state.limits.call,
            reply,
            what,
        });
    }

    /// Runs a command or a provider for a caller, who hears its answer once it settles.
    pub fn call(
        &mut self,
        kind: Kind,
        name: &str,
        args: &Json,
        reply: oneshot::Sender<Result<Json, HostError>>,
    ) {
        let started = self
            .state
            .text(args)
            .and_then(|json| self.dispatch(kind, name, Some(json)));
        match started {
            Ok(Some(promise)) => self.wait(promise, Reply::Call(reply), format!("“{name}”")),
            Ok(None) => drop(reply.send(Ok(Json::Null))),
            Err(e) => drop(reply.send(Err(e))),
        }
    }

    /// Tells the plugin's listeners of `event`; their failures are only logged.
    pub fn event(&mut self, event: &str, payload: &Json) {
        let run = self
            .state
            .text(payload)
            .and_then(|json| self.dispatch(Kind::Event, event, Some(json)));
        if let Err(e) = run {
            log::warn!("[plugin:{}] {event}: {e}", self.state.plugin);
        }
    }

    fn dispatch(
        &self,
        kind: Kind,
        name: &str,
        json: Option<String>,
    ) -> Result<Option<Persistent<Promise<'static>>>, HostError> {
        let Some(dispatch) = self.dispatch.clone() else {
            return Err(HostError::new(
                ErrorCode::NotFound,
                format!("{} isn't loaded", self.state.plugin),
            ));
        };
        let state = &self.state;
        self.slice(|ctx| {
            let dispatch = dispatch
                .restore(ctx)
                .map_err(|e| error_of(CaughtError::Error(e), state))?;
            let out: Value = dispatch
                .call((kind.as_str(), name, json))
                .catch(ctx)
                .map_err(|e| error_of(e, state))?;
            Ok(out.into_promise().map(|p| Persistent::save(ctx, p)))
        })
    }

    /// Runs the plugin's pending jobs (promise reactions) within one slice.
    pub fn run_jobs(&self) {
        self.state
            .deadline
            .set(Some(Instant::now() + self.state.limits.slice));
        // A job fails here only when the runtime stopped it (the slice, its memory): the
        // promise it belonged to stays pending, and its caller's limit answers for it.
        let mut failed = false;
        loop {
            match self.runtime.execute_pending_job() {
                Ok(true) => {}
                Ok(false) => break,
                Err(_) => failed = true,
            }
        }
        if failed {
            let why = if self.state.stop_now() {
                interrupted(&self.state.limits).message
            } else {
                "a promise job was stopped".to_string()
            };
            log::warn!("[plugin:{}] {why}", self.state.plugin);
        }
        self.state.deadline.set(None);
    }

    /// Answers the callers whose promise settled or whose time is up.
    pub fn answer_settled(&mut self, now: Instant) -> Option<HostError> {
        if self.waiting.is_empty() {
            return None;
        }
        let mut load_failed = None;
        let waiting = std::mem::take(&mut self.waiting);
        let state = self.state.clone();
        let mut still = Vec::new();
        self.context.with(|ctx| {
            for w in waiting {
                if w.reply.is_closed() {
                    continue;
                }
                let Ok(promise) = w.promise.clone().restore(&ctx) else {
                    continue;
                };
                let outcome = match promise.state() {
                    PromiseState::Pending if now < w.deadline => {
                        still.push(w);
                        continue;
                    }
                    PromiseState::Pending => Err(HostError::new(
                        ErrorCode::Timeout,
                        format!(
                            "{} had no answer within {} s",
                            w.what,
                            state.limits.call.as_secs_f64()
                        ),
                    )),
                    PromiseState::Resolved => match promise.result::<String>() {
                        Some(Ok(json)) => state.parse(&json),
                        Some(Err(e)) => Err(error_of(CaughtError::from_error(&ctx, e), &state)),
                        None => continue,
                    },
                    PromiseState::Rejected => Err(rejection(&ctx, &promise, &state)),
                };
                if let (Reply::Load(_), Err(e)) = (&w.reply, &outcome) {
                    load_failed = Some(e.clone());
                }
                w.reply.send(outcome);
            }
        });
        self.waiting = still;
        load_failed
    }

    /// Settles an async host call's promise with the service's answer.
    pub fn settle(&mut self, token: u64, result: Result<Json, HostError>) {
        let Some(p) = self.state.pending.borrow_mut().remove(&token) else {
            return;
        };
        let state = self.state.clone();
        self.slice(|ctx| {
            let value = result.and_then(|v| state.text(&v)).and_then(|json| {
                ctx.json_parse(json)
                    .catch(ctx)
                    .map_err(|e| error_of(e, &state))
            });
            let settled = match value {
                Ok(v) => p.resolve.restore(ctx).and_then(|f| f.call::<_, ()>((v,))),
                Err(e) => js_error(ctx, &e)
                    .and_then(|v| p.reject.restore(ctx).and_then(|f| f.call::<_, ()>((v,)))),
            };
            if let Err(e) = settled.catch(ctx) {
                log::warn!("[plugin:{}] settling a host call failed: {e}", state.plugin);
            }
        });
        self.run_jobs();
    }

    /// When this plugin next needs the host thread: a timer, or a caller's limit.
    pub fn next_wake(&self) -> Option<Instant> {
        let timers = self.state.timers.borrow().iter().map(|t| t.next).min();
        let calls = self.waiting.iter().map(|w| w.deadline).min();
        timers.into_iter().chain(calls).min()
    }

    /// Runs the timers that are due.
    pub fn tick(&mut self, now: Instant) {
        let due: Vec<u32> = self
            .state
            .timers
            .borrow_mut()
            .iter_mut()
            .filter(|t| t.next <= now)
            .map(|t| {
                // A late tick isn't made up: the next one is a whole interval away.
                t.next = now + t.every;
                t.id
            })
            .collect();
        for id in &due {
            if let Err(e) = self.dispatch(Kind::Timer, &id.to_string(), None) {
                log::warn!("[plugin:{}] ctx.every: {e}", self.state.plugin);
            }
        }
        if !due.is_empty() {
            self.run_jobs();
        }
    }
}

/// Why a rejected promise was rejected.
fn rejection<'js>(ctx: &Ctx<'js>, promise: &Promise<'js>, state: &State) -> HostError {
    match promise.result::<Value>() {
        Some(Err(e)) => error_of(CaughtError::from_error(ctx, e), state),
        _ => HostError::new(ErrorCode::PluginError, "the plugin's promise failed"),
    }
}

fn interrupted(limits: &Limits) -> HostError {
    HostError::new(
        ErrorCode::Timeout,
        format!(
            "JavaScript ran for more than {} s without a break and was stopped",
            limits.slice.as_secs_f64()
        ),
    )
}

/// A JavaScript failure as the host reports it: the plugin's own error is `plugin_error`; an
/// error from the host keeps its code; the runtime's limits are `timeout` and `limit`.
fn error_of(caught: CaughtError<'_>, state: &State) -> HostError {
    let (message, code) = match &caught {
        CaughtError::Exception(e) => (
            e.message().unwrap_or_default(),
            e.get::<_, Option<String>>("code").ok().flatten(),
        ),
        CaughtError::Value(v) => (
            v.as_string()
                .and_then(|s| s.to_string().ok())
                .unwrap_or_else(|| format!("the plugin threw {}", v.type_name())),
            None,
        ),
        CaughtError::Error(rquickjs::Error::Allocation) => ("out of memory".into(), None),
        CaughtError::Error(e) => (e.to_string(), None),
    };
    let limits = &state.limits;
    if message == "interrupted" {
        return interrupted(limits);
    }
    if message == "out of memory" {
        return HostError::new(
            ErrorCode::Limit,
            format!("out of memory: a plugin has {} MB", limits.memory / 1048576),
        );
    }
    if message.starts_with("Maximum call stack size exceeded") {
        return HostError::new(ErrorCode::Limit, message);
    }
    if let Some(code) = code.as_deref().and_then(ErrorCode::parse) {
        let prefix = format!("{}: ", code.as_str());
        let message = message
            .strip_prefix(&prefix)
            .unwrap_or(&message)
            .to_string();
        return HostError::new(code, message);
    }
    if message.is_empty() {
        return HostError::new(
            ErrorCode::PluginError,
            "the plugin failed without a message",
        );
    }
    HostError::new(ErrorCode::PluginError, message)
}

fn load_error(file: &str, e: HostError) -> HostError {
    if e.message.starts_with("could not load module") {
        return HostError::new(
            ErrorCode::PluginError,
            format!(
                "{file} is one file: it can't import other files ({})",
                e.message
            ),
        );
    }
    e
}

/// A host error as JavaScript sees it: an `Error` with `code`.
fn js_error<'js>(ctx: &Ctx<'js>, e: &HostError) -> rquickjs::Result<Value<'js>> {
    let error = Exception::from_message(ctx.clone(), &e.to_string())?;
    error.as_object().set("code", e.code.as_str())?;
    Ok(error.into_value())
}

fn throw(ctx: &Ctx<'_>, e: &HostError) -> rquickjs::Error {
    match js_error(ctx, e) {
        Ok(v) => ctx.throw(v),
        Err(failed) => failed,
    }
}

/// The functions the prelude gets (and keeps from the plugin).
fn bridge<'js>(
    ctx: &Ctx<'js>,
    state: &Rc<State>,
    wiring: &Wiring,
) -> rquickjs::Result<Object<'js>> {
    let bridge = Object::new(ctx.clone())?;
    bridge.set("id", state.plugin.as_str())?;

    let (s, services_) = (state.clone(), wiring.services.clone());
    let call = move |ctx: Ctx<'js>, name: String, args: String| -> rquickjs::Result<String> {
        let args = s.parse(&args).map_err(|e| throw(&ctx, &e))?;
        let asked = Instant::now();
        let answer = services_.sync(&s.plugin, &name, args);
        s.exclude(asked);
        answer.and_then(|v| s.text(&v)).map_err(|e| throw(&ctx, &e))
    };
    bridge.set("host", Function::new(ctx.clone(), call)?)?;

    let (s, services_, host) = (state.clone(), wiring.services.clone(), wiring.host.clone());
    let later =
        move |ctx: Ctx<'js>, name: String, args: String| -> rquickjs::Result<Promise<'js>> {
            let (promise, resolve, reject) = Promise::new(&ctx)?;
            match s.parse(&args) {
                Err(e) => reject.call::<_, ()>((js_error(&ctx, &e)?,))?,
                Ok(args) => {
                    let token = s.next_token.get();
                    s.next_token.set(token + 1);
                    let asked = Instant::now();
                    let answer = services_.spawn_async(&s.plugin, &name, args);
                    s.exclude(asked);
                    let (host, generation) = (host.clone(), s.generation);
                    let task = tauri::async_runtime::spawn(async move {
                        let result = answer.await;
                        let _ = host.send(Msg::Settle {
                            generation,
                            token,
                            result,
                        });
                    });
                    s.pending.borrow_mut().insert(
                        token,
                        Pending {
                            resolve: Persistent::save(&ctx, resolve),
                            reject: Persistent::save(&ctx, reject),
                            task,
                        },
                    );
                }
            }
            Ok(promise)
        };
    bridge.set("hostAsync", Function::new(ctx.clone(), later)?)?;

    let s = state.clone();
    let every = move |ctx: Ctx<'js>, seconds: f64| -> rquickjs::Result<u32> {
        let min = s.limits.min_every;
        let every = Duration::try_from_secs_f64(seconds)
            .ok()
            .filter(|d| *d >= min);
        let Some(every) = every else {
            let message = format!(
                "ctx.every needs at least {} s between runs",
                min.as_secs_f64()
            );
            return Err(throw(&ctx, &HostError::new(ErrorCode::Limit, message)));
        };
        let mut timers = s.timers.borrow_mut();
        if timers.len() >= MAX_TIMERS {
            let message = format!("a plugin keeps at most {MAX_TIMERS} ctx.every timers");
            return Err(throw(&ctx, &HostError::new(ErrorCode::Limit, message)));
        }
        let id = timers.len() as u32;
        // The first run is one interval away: plugins do their start-up work in `apply`.
        timers.push(Timer {
            id,
            every,
            next: Instant::now() + every,
        });
        Ok(id)
    };
    bridge.set("every", Function::new(ctx.clone(), every)?)?;

    let s = state.clone();
    let listen = move |ctx: Ctx<'js>, event: String| -> rquickjs::Result<()> {
        if s.grants.events.contains(&event) {
            return Ok(());
        }
        let message =
            format!("“{event}” isn't among the events this plugin asked for (uses.events.on)");
        Err(throw(&ctx, &HostError::new(ErrorCode::Permission, message)))
    };
    bridge.set("listen", Function::new(ctx.clone(), listen)?)?;

    let s = state.clone();
    let report = move |text: String| {
        let text: String = text.chars().take(2000).collect();
        log::warn!("[plugin:{}] {text}", s.plugin);
    };
    bridge.set("report", Function::new(ctx.clone(), report)?)?;
    Ok(bridge)
}
