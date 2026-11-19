//! One plugin's QuickJS runtime and the bridge between its JavaScript and the host.
//!
//! Only text crosses the bridge, both ways: JSON, or `!<code> <message>` for a refusal ("wire"
//! text, see `prelude.js`). The bridge's functions never throw and never call back into
//! JavaScript, so no borrow of the shared `State` is ever held while plugin code runs; errors
//! are made by the prelude, which alone decides what a thrown value says.
//!
//! Every entry into JavaScript happens within a turn (`begin_turn` … `end_turn`): one message
//! from the host and the promise jobs after it, under one budget, a slice of JavaScript time
//! and twice that of wall time. A turn that runs past its budget leaves the plugin to be
//! restarted (the worker's job). Everything here lives on the plugin's own thread.
use super::worker::{Halt, Msg, Notes};
use super::{ErrorCode, Grants, HostError, HostServices, Limits};
use rquickjs::{
    CatchResultExt, CaughtError, Context, Ctx, Function, Module, Object, Persistent, Promise,
    Runtime, Value,
};
use serde_json::Value as Json;
use std::cell::{Cell, RefCell};
use std::collections::HashMap;
use std::rc::Rc;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{mpsc, Arc};
use std::time::{Duration, Instant};
use tokio::sync::oneshot;

/// The prelude: a script whose value builds `ctx` from the bridge (see the file).
const PRELUDE: &str = include_str!("prelude.js");

/// Timers one plugin may keep.
const MAX_TIMERS: usize = 64;

/// Async host calls one plugin may have waiting at once.
const MAX_IN_FLIGHT: usize = 64;

/// Unhandled rejections kept for the end of a turn; more are only counted.
const MAX_UNHANDLED: usize = 64;

/// A new `ctx.every` timer first runs this soon (or after its interval, if shorter).
const FIRST_RUN: Duration = Duration::from_secs(1);

/// How deep JSON may nest on the bridge (`serde_json`'s own limit).
const MAX_DEPTH: usize = 128;

/// One plugin's package, as loaded: what a runtime is built from.
pub(super) struct Package {
    pub id: String,
    pub file: String,
    pub source: String,
    pub grants: Grants,
}

/// What every runtime of one plugin is wired to.
pub(super) struct Wiring {
    pub services: Arc<dyn HostServices>,
    pub limits: Arc<Limits>,
    /// The plugin's own queue, for async answers.
    pub queue: mpsc::Sender<Msg>,
    pub halt: Arc<Halt>,
    pub notes: Rc<Notes>,
    /// How many of its async host calls are in flight: while any is, its callers' clocks stop.
    pub waiting: Arc<AtomicUsize>,
}

/// Counts one async host call as in flight until it is settled or dropped.
struct InFlight(Arc<AtomicUsize>);

impl InFlight {
    fn new(count: &Arc<AtomicUsize>) -> InFlight {
        count.fetch_add(1, Ordering::SeqCst);
        InFlight(count.clone())
    }
}

impl Drop for InFlight {
    fn drop(&mut self) {
        self.0.fetch_sub(1, Ordering::SeqCst);
    }
}

/// The budget of the turn under way.
#[derive(Default)]
struct Turn {
    /// JavaScript time: moved on by what host services take.
    js: Cell<Option<Instant>>,
    /// Wall time, services included.
    wall: Cell<Option<Instant>>,
    /// The turn ran past its budget (JavaScript was interrupted, a service refused, or jobs
    /// were left).
    overran: Cell<bool>,
}

/// What the bridge's functions share with the host (they live in the runtime, the host
/// outside it). No borrow of these cells is held across a call into JavaScript.
struct State {
    plugin: String,
    generation: u64,
    limits: Arc<Limits>,
    grants: Grants,
    halt: Arc<Halt>,
    notes: Rc<Notes>,
    turn: Turn,
    /// Async host calls waiting for their answer, by token.
    pending: RefCell<HashMap<u64, Pending>>,
    next_token: Cell<u64>,
    timers: RefCell<Vec<Timer>>,
    /// What the prelude answered this turn, by call.
    answers: RefCell<Vec<(u64, String)>>,
    /// Promises rejected with nobody to hear it yet: `(promise, reason)`.
    unhandled: RefCell<Vec<(Persistent<Value<'static>>, Persistent<Value<'static>>)>>,
    unhandled_dropped: Cell<usize>,
}

struct Pending {
    name: String,
    resolve: Persistent<Function<'static>>,
    task: tauri::async_runtime::JoinHandle<()>,
    _in_flight: InFlight,
}

struct Timer {
    id: u32,
    every: Duration,
    next: Instant,
}

impl State {
    /// Whether running JavaScript must stop: the turn's budget is spent, or the plugin is being
    /// stopped.
    fn stop_now(&self) -> bool {
        if self.halt.is_set() {
            return true;
        }
        let now = Instant::now();
        let past = |d: &Cell<Option<Instant>>| d.get().is_some_and(|d| now >= d);
        past(&self.turn.js) || past(&self.turn.wall)
    }

    /// Host time isn't the plugin's JavaScript time: the JavaScript budget moves on by what a
    /// service took (the wall budget doesn't).
    fn exclude(&self, since: Instant) {
        if let Some(d) = self.turn.js.get() {
            self.turn.js.set(Some(d + since.elapsed()));
        }
    }

    fn overrun(&self) -> HostError {
        overrun(&self.limits)
    }

    fn parse(&self, json: &str) -> Result<Json, HostError> {
        if json.len() > self.limits.max_json {
            return Err(too_big(&self.limits));
        }
        serde_json::from_str(json).map_err(|e| {
            if e.to_string().starts_with("recursion limit exceeded") {
                HostError::new(
                    ErrorCode::Limit,
                    format!("JSON nested more than {MAX_DEPTH} levels deep"),
                )
            } else {
                HostError::new(ErrorCode::PluginError, e.to_string())
            }
        })
    }

    fn text(&self, value: &Json) -> Result<String, HostError> {
        let json = value.to_string();
        if json.len() > self.limits.max_json {
            return Err(too_big(&self.limits));
        }
        Ok(json)
    }

    /// A service's answer as wire text; the first `unsupported` of each service is logged.
    fn wire(&self, name: &str, answer: Result<Json, HostError>) -> String {
        match answer.and_then(|v| self.text(&v)) {
            Ok(json) => json,
            Err(e) => {
                if e.code == ErrorCode::Unsupported && self.notes.first_unsupported(name) {
                    log::warn!("[plugin:{}] {e}", self.plugin);
                }
                refusal(&e)
            }
        }
    }

    /// What wire text from the prelude means.
    fn read_wire(&self, wire: &str) -> Result<Json, HostError> {
        let Some(refused) = wire.strip_prefix('!') else {
            return self.parse(wire);
        };
        let (code, message) = refused.split_once(' ').unwrap_or((refused, ""));
        Err(match ErrorCode::parse(code) {
            Some(code) => HostError::new(code, message),
            None => engine_error(message, &self.limits).unwrap_or_else(|| plugin_error(message)),
        })
    }

    /// An exception that escaped the prelude: only the engine's own (an interrupt, memory,
    /// the stack), since the prelude catches everything else.
    fn escaped(&self, caught: CaughtError<'_>) -> HostError {
        if self.turn.overran.get() {
            return self.overrun();
        }
        let message = match &caught {
            CaughtError::Exception(e) => e.message().unwrap_or_default(),
            CaughtError::Error(rquickjs::Error::Allocation) => "out of memory".into(),
            CaughtError::Error(e) => e.to_string(),
            CaughtError::Value(_) => String::new(),
        };
        engine_error(&message, &self.limits).unwrap_or_else(|| plugin_error(&message))
    }
}

fn too_big(limits: &Limits) -> HostError {
    HostError::new(
        ErrorCode::Limit,
        format!("more than {} bytes of JSON in one call", limits.max_json),
    )
}

fn refusal(e: &HostError) -> String {
    format!("!{} {}", e.code.as_str(), e.message)
}

fn overrun(limits: &Limits) -> HostError {
    HostError::new(
        ErrorCode::Timeout,
        format!(
            "the plugin used up its turn (a {} s slice of JavaScript, {} s in all) and was \
             stopped; it starts again on its next use",
            limits.slice.as_secs_f64(),
            2.0 * limits.slice.as_secs_f64()
        ),
    )
}

/// The engine's own failures, by their message: its limits are `timeout` and `limit`.
fn engine_error(message: &str, limits: &Limits) -> Option<HostError> {
    if message == "interrupted" {
        return Some(overrun(limits));
    }
    if message == "out of memory" {
        let message = format!("out of memory: a plugin has {} MB", limits.memory / 1048576);
        return Some(HostError::new(ErrorCode::Limit, message));
    }
    if message.starts_with("Maximum call stack size exceeded") {
        return Some(HostError::new(ErrorCode::Limit, message));
    }
    None
}

fn plugin_error(message: &str) -> HostError {
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

/// Who hears that `apply(ctx)` has finished.
pub(super) type LoadReply = oneshot::Sender<Result<(), HostError>>;

/// Who waits for an answer from the plugin.
pub(super) enum Reply {
    /// `apply(ctx)` finishing; nobody waits when the plugin is started again after a fault.
    Load(Option<LoadReply>),
    Call(oneshot::Sender<Result<Json, HostError>>),
}

impl Reply {
    fn send(self, outcome: Result<Json, HostError>) {
        match self {
            Reply::Load(Some(tx)) => drop(tx.send(outcome.map(|_| ()))),
            Reply::Load(None) => {}
            Reply::Call(tx) => drop(tx.send(outcome)),
        }
    }

    fn is_load(&self) -> bool {
        matches!(self, Reply::Load(_))
    }
}

/// What `dispatch` runs: the prelude's kinds.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) enum Kind {
    Command,
    /// A command with files the user handed the plugin: `{args, files}`.
    CommandFiles,
    Provider,
    Event,
    Timer,
}

impl Kind {
    fn as_str(self) -> &'static str {
        match self {
            Kind::Command => "command",
            Kind::CommandFiles => "command+files",
            Kind::Provider => "provider",
            Kind::Event => "event",
            Kind::Timer => "timer",
        }
    }
}

/// The prelude's functions the host calls.
struct Prelude {
    dispatch: Persistent<Function<'static>>,
    load: Persistent<Function<'static>>,
    failure: Persistent<Function<'static>>,
}

/// A running plugin. Its JavaScript handles are released before its context and runtime
/// (`Drop`, then field order): QuickJS refuses to free a runtime something still points into.
pub(super) struct Plugin {
    prelude: Option<Prelude>,
    exports: Option<Persistent<Object<'static>>>,
    waiting: HashMap<u64, Reply>,
    next_call: u64,
    /// What callers still waiting hear when the plugin goes.
    closing: HostError,
    state: Rc<State>,
    context: Context,
    runtime: Runtime,
}

impl Drop for Plugin {
    fn drop(&mut self) {
        for (_, reply) in self.waiting.drain() {
            reply.send(Err(self.closing.clone()));
        }
        for (_, p) in self.state.pending.borrow_mut().drain() {
            p.task.abort();
        }
        self.state.unhandled.borrow_mut().clear();
        self.prelude = None;
        self.exports = None;
    }
}

impl Plugin {
    /// A fresh runtime for the package: limits, the interrupt handler and the rejection
    /// tracker. Nothing of the plugin has run yet.
    pub fn new(package: &Package, generation: u64, wiring: &Wiring) -> Result<Plugin, HostError> {
        let internal = |e: rquickjs::Error| HostError::new(ErrorCode::PluginError, e.to_string());
        let runtime = Runtime::new().map_err(internal)?;
        runtime.set_memory_limit(wiring.limits.memory);
        runtime.set_max_stack_size(wiring.limits.stack);
        let state = Rc::new(State {
            plugin: package.id.clone(),
            generation,
            limits: wiring.limits.clone(),
            grants: package.grants.clone(),
            halt: wiring.halt.clone(),
            notes: wiring.notes.clone(),
            turn: Turn::default(),
            pending: RefCell::new(HashMap::new()),
            next_token: Cell::new(0),
            timers: RefCell::new(Vec::new()),
            answers: RefCell::new(Vec::new()),
            unhandled: RefCell::new(Vec::new()),
            unhandled_dropped: Cell::new(0),
        });
        let watch = state.clone();
        runtime.set_interrupt_handler(Some(Box::new(move || {
            let stop = watch.stop_now();
            if stop {
                watch.turn.overran.set(true);
            }
            stop
        })));
        let track = state.clone();
        runtime.set_host_promise_rejection_tracker(Some(Box::new(
            move |ctx: Ctx<'_>, promise: Value<'_>, reason: Value<'_>, handled: bool| {
                track_rejection(&track, &ctx, promise, reason, handled)
            },
        )));
        let context = Context::full(&runtime).map_err(internal)?;
        Ok(Plugin {
            prelude: None,
            exports: None,
            waiting: HashMap::new(),
            next_call: 0,
            closing: HostError::new(ErrorCode::NotFound, format!("{} was unloaded", package.id)),
            state,
            context,
            runtime,
        })
    }

    pub fn generation(&self) -> u64 {
        self.state.generation
    }

    /// Drops the plugin; callers still waiting hear `why`.
    pub fn close(mut self, why: HostError) {
        self.closing = why;
    }

    pub fn begin_turn(&self) {
        let now = Instant::now();
        let turn = &self.state.turn;
        turn.js.set(Some(now + self.state.limits.slice));
        turn.wall.set(Some(now + 2 * self.state.limits.slice));
        turn.overran.set(false);
    }

    pub fn end_turn(&self) {
        self.state.turn.js.set(None);
        self.state.turn.wall.set(None);
    }

    /// Whether this turn ran past its budget, with jobs left over or not.
    pub fn overran(&self) -> bool {
        self.state.turn.overran.get()
    }

    pub fn overrun_error(&self) -> HostError {
        self.state.overrun()
    }

    /// Runs JavaScript within the turn under way.
    fn enter<R>(&self, f: impl FnOnce(&Ctx<'_>) -> R) -> R {
        debug_assert!(
            self.state.turn.wall.get().is_some(),
            "JavaScript outside a turn"
        );
        self.context.with(|ctx| f(&ctx))
    }

    /// The prelude, then the package's `main.js` as a module, and its jobs: everything but
    /// `apply(ctx)`.
    pub fn evaluate(&mut self, package: &Package, wiring: &Wiring) -> Result<(), HostError> {
        let state = self.state.clone();
        let file = package.file.as_str();
        let (prelude, evaluated, exports) = self.enter(|ctx| {
            let built = (|| {
                let make: Function = ctx.eval(PRELUDE)?;
                let made: Object = make.call((bridge(ctx, &state, wiring)?,))?;
                Ok::<_, rquickjs::Error>(Prelude {
                    dispatch: Persistent::save(ctx, made.get::<_, Function>("dispatch")?),
                    load: Persistent::save(ctx, made.get::<_, Function>("load")?),
                    failure: Persistent::save(ctx, made.get::<_, Function>("failure")?),
                })
            })();
            let prelude = built.catch(ctx).map_err(|e| state.escaped(e))?;
            let module = Module::declare(ctx.clone(), file, package.source.as_str())
                .catch(ctx)
                .map_err(|e| load_error(file, state.escaped(e)))?;
            let (module, evaluated) = module
                .eval()
                .catch(ctx)
                .map_err(|e| load_error(file, state.escaped(e)))?;
            let exports = module
                .namespace()
                .catch(ctx)
                .map_err(|e| state.escaped(e))?;
            Ok::<_, HostError>((
                prelude,
                Persistent::save(ctx, evaluated),
                Persistent::save(ctx, exports),
            ))
        })?;
        self.prelude = Some(prelude);
        self.run_jobs();
        self.enter(|ctx| {
            let evaluated = evaluated
                .restore(ctx)
                .map_err(|e| state.escaped(CaughtError::Error(e)))?;
            match evaluated.result::<Value>() {
                None => Err(HostError::new(
                    ErrorCode::PluginError,
                    format!("{file} waits at its top level; start its work in apply(ctx)"),
                )),
                Some(Ok(_)) => Ok(()),
                Some(Err(_)) => {
                    let reason = ctx.catch();
                    Err(load_error(file, self.describe(ctx, reason)))
                }
            }
        })?;
        self.exports = Some(exports);
        Ok(())
    }

    /// Starts `apply(ctx)`; `reply` hears when it has finished.
    pub fn apply(&mut self, reply: Reply) {
        let call = self.wait(reply);
        let (Some(prelude), Some(exports)) = (&self.prelude, &self.exports) else {
            return self.answer_now(call, Err(plugin_error("the plugin isn't evaluated")));
        };
        let (load, exports) = (prelude.load.clone(), exports.clone());
        let state = &self.state;
        let started = self.enter(|ctx| {
            let run = || {
                let load = load.restore(ctx)?;
                load.call::<_, ()>((exports.restore(ctx)?, call as f64))
            };
            run().catch(ctx).map_err(|e| state.escaped(e))
        });
        if let Err(e) = started {
            self.answer_now(call, Err(e));
        }
    }

    fn wait(&mut self, reply: Reply) -> u64 {
        let call = self.next_call;
        self.next_call += 1;
        self.waiting.insert(call, reply);
        call
    }

    fn answer_now(&mut self, call: u64, outcome: Result<Json, HostError>) {
        if let Some(reply) = self.waiting.remove(&call) {
            reply.send(outcome);
        }
    }

    /// Runs a command or a provider for a caller, who hears its answer once it has one.
    pub fn call(
        &mut self,
        kind: Kind,
        name: &str,
        args: &Json,
        reply: oneshot::Sender<Result<Json, HostError>>,
    ) {
        let json = match self.state.text(args) {
            Ok(json) => json,
            Err(e) => return drop(reply.send(Err(e))),
        };
        let call = self.wait(Reply::Call(reply));
        if let Err(e) = self.dispatch(kind, name, Some(json), Some(call)) {
            self.answer_now(call, Err(e));
        }
    }

    /// Tells the plugin's listeners of `event`; their failures are only logged.
    pub fn event(&mut self, event: &str, payload: &Json) {
        let run = self
            .state
            .text(payload)
            .and_then(|json| self.dispatch(Kind::Event, event, Some(json), None));
        if let Err(e) = run {
            log::warn!("[plugin:{}] {event}: {e}", self.state.plugin);
        }
    }

    fn dispatch(
        &self,
        kind: Kind,
        name: &str,
        json: Option<String>,
        call: Option<u64>,
    ) -> Result<(), HostError> {
        let Some(prelude) = &self.prelude else {
            return Err(plugin_error("the plugin isn't evaluated"));
        };
        let dispatch = prelude.dispatch.clone();
        let state = &self.state;
        self.enter(|ctx| {
            let dispatch = dispatch
                .restore(ctx)
                .map_err(|e| state.escaped(CaughtError::Error(e)))?;
            dispatch
                .call::<_, ()>((kind.as_str(), name, json, call.map(|c| c as f64)))
                .catch(ctx)
                .map_err(|e| state.escaped(e))
        })
    }

    /// Runs the plugin's pending jobs (promise reactions) until there are none or the turn's
    /// budget is spent; jobs left over mean the turn overran.
    pub fn run_jobs(&self) {
        let state = &self.state;
        let drained = self.enter(|ctx| loop {
            if state.stop_now() {
                break false;
            }
            if !ctx.execute_pending_job() {
                break true;
            }
        });
        if !drained && self.runtime.is_job_pending() {
            state.turn.overran.set(true);
        }
    }

    /// Settles an async host call's promise with the service's answer.
    pub fn settle(&mut self, token: u64, result: Result<Json, HostError>) {
        let Some(p) = self.state.pending.borrow_mut().remove(&token) else {
            return;
        };
        let wire = self.state.wire(&p.name, result);
        let state = self.state.clone();
        self.enter(|ctx| {
            let settled = p
                .resolve
                .restore(ctx)
                .and_then(|resolve| resolve.call::<_, ()>((wire,)));
            if let Err(e) = settled.catch(ctx) {
                let e = state.escaped(e);
                log::warn!("[plugin:{}] settling a host call failed: {e}", state.plugin);
            }
        });
    }

    /// Logs the rejections nobody handled this turn (a few a minute), described in the
    /// plugin's time; within a turn only.
    pub fn report_unhandled(&self) {
        let reasons: Vec<_> = self
            .state
            .unhandled
            .borrow_mut()
            .drain(..)
            .map(|(_, reason)| reason)
            .collect();
        let dropped = self.state.unhandled_dropped.replace(0);
        if reasons.is_empty() && dropped == 0 {
            return;
        }
        for reason in reasons {
            if self.state.turn.overran.get() {
                break;
            }
            let message = self.enter(|ctx| match reason.restore(ctx) {
                Ok(reason) => self.describe(ctx, reason).message,
                Err(_) => String::new(),
            });
            if self.state.notes.may_report() {
                log::warn!(
                    "[plugin:{}] unhandled rejection: {message}",
                    self.state.plugin
                );
            }
        }
        if dropped > 0 && self.state.notes.may_report() {
            log::warn!(
                "[plugin:{}] {dropped} more unhandled rejections",
                self.state.plugin
            );
        }
    }

    /// What a thrown or rejected value says, as the prelude reads it.
    fn describe<'js>(&self, ctx: &Ctx<'js>, reason: Value<'js>) -> HostError {
        let Some(prelude) = &self.prelude else {
            return plugin_error("");
        };
        let wire = prelude
            .failure
            .clone()
            .restore(ctx)
            .and_then(|failure| failure.call::<_, String>((reason,)));
        match wire.catch(ctx) {
            Ok(wire) => match self.state.read_wire(&wire) {
                Err(e) => e,
                Ok(_) => plugin_error(""),
            },
            Err(e) => self.state.escaped(e),
        }
    }

    /// Sends the answers the prelude gave this turn. After an overrun only the successful ones
    /// go: the rest hear why the plugin is stopped. Returns how `apply(ctx)` failed, if it did.
    pub fn deliver(&mut self) -> Option<HostError> {
        let answers = std::mem::take(&mut *self.state.answers.borrow_mut());
        let overran = self.overran();
        let mut load_failed = None;
        for (call, wire) in answers {
            let outcome = self.state.read_wire(&wire);
            if overran && outcome.is_err() {
                continue;
            }
            let Some(reply) = self.waiting.remove(&call) else {
                continue;
            };
            if let (true, Err(e)) = (reply.is_load(), &outcome) {
                load_failed = Some(e.clone());
            }
            reply.send(outcome);
        }
        load_failed
    }

    /// When this plugin next needs its thread: its earliest timer.
    pub fn next_wake(&self) -> Option<Instant> {
        self.state.timers.borrow().iter().map(|t| t.next).min()
    }

    /// The timers that are due; each next runs a whole interval later (a late tick isn't made
    /// up).
    pub fn due_timers(&self, now: Instant) -> Vec<u32> {
        self.state
            .timers
            .borrow_mut()
            .iter_mut()
            .filter(|t| t.next <= now)
            .map(|t| {
                t.next = now + t.every;
                t.id
            })
            .collect()
    }

    pub fn timer(&self, id: u32) {
        if let Err(e) = self.dispatch(Kind::Timer, &id.to_string(), None, None) {
            log::warn!("[plugin:{}] ctx.every: {e}", self.state.plugin);
        }
    }
}

/// Keeps the promises rejected without a handler until the end of the turn; one handled later
/// in the turn is let go. Runs inside the engine: it never calls into JavaScript.
fn track_rejection<'js>(
    state: &State,
    ctx: &Ctx<'js>,
    promise: Value<'js>,
    reason: Value<'js>,
    handled: bool,
) {
    let mut unhandled = state.unhandled.borrow_mut();
    if handled {
        let at = unhandled
            .iter()
            .position(|(p, _)| p.clone().restore(ctx).is_ok_and(|p| p == promise));
        if let Some(at) = at {
            unhandled.remove(at);
        }
    } else if unhandled.len() < MAX_UNHANDLED {
        unhandled.push((
            Persistent::save(ctx, promise),
            Persistent::save(ctx, reason),
        ));
    } else {
        state
            .unhandled_dropped
            .set(state.unhandled_dropped.get() + 1);
    }
}

/// The functions the prelude gets (and keeps from the plugin). None of them throws or calls
/// into JavaScript: each answers in wire text.
fn bridge<'js>(
    ctx: &Ctx<'js>,
    state: &Rc<State>,
    wiring: &Wiring,
) -> rquickjs::Result<Object<'js>> {
    let bridge = Object::new(ctx.clone())?;
    bridge.set("id", state.plugin.as_str())?;
    let host = serde_json::json!({
        "name": "CodeMie Connect",
        "version": env!("CARGO_PKG_VERSION"),
        "engine": crate::plugins::manifest::ENGINE,
    });
    bridge.set("about", host.to_string())?;

    let (s, services) = (state.clone(), wiring.services.clone());
    let sync_call = move |name: String, args: String| -> String {
        if s.stop_now() {
            s.turn.overran.set(true);
            return refusal(&s.overrun());
        }
        let args = match s.parse(&args) {
            Ok(args) => args,
            Err(e) => return refusal(&e),
        };
        let asked = Instant::now();
        let answer = services.sync(&s.plugin, &name, args);
        s.exclude(asked);
        s.wire(&name, answer)
    };
    bridge.set("host", Function::new(ctx.clone(), sync_call)?)?;

    let (s, services, queue) = (state.clone(), wiring.services.clone(), wiring.queue.clone());
    let waiting = wiring.waiting.clone();
    let async_call =
        move |ctx: Ctx<'js>, name: String, args: String| -> rquickjs::Result<Promise<'js>> {
            let (promise, resolve, _reject) = Promise::new(&ctx)?;
            let refused = if s.stop_now() {
                s.turn.overran.set(true);
                Some(s.overrun())
            } else if s.pending.borrow().len() >= MAX_IN_FLIGHT {
                Some(HostError::new(
                    ErrorCode::Limit,
                    format!("a plugin has at most {MAX_IN_FLIGHT} host calls waiting"),
                ))
            } else {
                None
            };
            let args = match refused.map_or_else(|| s.parse(&args), Err) {
                Ok(args) => args,
                Err(e) => {
                    resolve.call::<_, ()>((refusal(&e),))?;
                    return Ok(promise);
                }
            };
            let token = s.next_token.get();
            s.next_token.set(token + 1);
            let asked = Instant::now();
            let answer = services.spawn_async(&s.plugin, &name, args);
            s.exclude(asked);
            let (queue, generation) = (queue.clone(), s.generation);
            let task = tauri::async_runtime::spawn(async move {
                let result = answer.await;
                let _ = queue.send(Msg::Settle {
                    generation,
                    token,
                    result,
                });
            });
            let resolve = Persistent::save(&ctx, resolve);
            s.pending.borrow_mut().insert(
                token,
                Pending {
                    name,
                    resolve,
                    task,
                    _in_flight: InFlight::new(&waiting),
                },
            );
            Ok(promise)
        };
    bridge.set("hostAsync", Function::new(ctx.clone(), async_call)?)?;

    let s = state.clone();
    let every = move |seconds: f64| -> String {
        let min = s.limits.min_every;
        let every = Duration::try_from_secs_f64(seconds)
            .ok()
            .filter(|d| *d >= min);
        let Some(every) = every else {
            let message = format!(
                "ctx.every needs at least {} s between runs",
                min.as_secs_f64()
            );
            return refusal(&HostError::new(ErrorCode::Limit, message));
        };
        let mut timers = s.timers.borrow_mut();
        if timers.len() >= MAX_TIMERS {
            let message = format!("a plugin keeps at most {MAX_TIMERS} ctx.every timers");
            return refusal(&HostError::new(ErrorCode::Limit, message));
        }
        let id = timers.len() as u32;
        timers.push(Timer {
            id,
            every,
            next: Instant::now() + every.min(FIRST_RUN),
        });
        id.to_string()
    };
    bridge.set("every", Function::new(ctx.clone(), every)?)?;

    let s = state.clone();
    let listen = move |event: String| -> String {
        if s.grants.events.contains(&event) {
            return "true".into();
        }
        let message =
            format!("“{event}” isn't among the events this plugin asked for (uses.events.on)");
        refusal(&HostError::new(ErrorCode::Permission, message))
    };
    bridge.set("listen", Function::new(ctx.clone(), listen)?)?;

    let s = state.clone();
    let answer = move |call: f64, wire: String| {
        s.answers.borrow_mut().push((call as u64, wire));
    };
    bridge.set("answer", Function::new(ctx.clone(), answer)?)?;

    let s = state.clone();
    let report = move |text: String| {
        let text: String = text.chars().take(2000).collect();
        log::warn!("[plugin:{}] {text}", s.plugin);
    };
    bridge.set("report", Function::new(ctx.clone(), report)?)?;
    Ok(bridge)
}
