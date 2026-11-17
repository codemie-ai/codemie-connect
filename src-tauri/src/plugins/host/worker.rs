//! One plugin's own thread: its runtime (`bridge::Plugin`) is built, run and dropped here, driven
//! by messages on the plugin's own queue, so a busy or stuck plugin holds up no other.
//!
//! A turn that runs past its budget faults the plugin: its runtime is dropped, the callers still
//! waiting hear `timeout`, and it is built again from its package on its next use. The host
//! stops a thread (`Worker::stop`) to unload the plugin, or when the plugin kept a caller past
//! the call limit; a thread stuck in a service ends once the service returns.
use super::bridge::{Kind, LoadReply, Package, Plugin, Reply, Wiring};
use super::{ErrorCode, HostError, HostServices, Limits};
use serde_json::Value as Json;
use std::cell::{Cell, RefCell};
use std::collections::HashSet;
use std::rc::Rc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{mpsc, Arc, Mutex, PoisonError};
use std::time::{Duration, Instant};
use tokio::sync::oneshot;

/// Room for a plugin's JavaScript stack above the thread's own frames.
const THREAD_STACK: usize = 8 * 1024 * 1024;

/// Unhandled rejections logged per plugin per window.
const REPORTS_PER_WINDOW: u32 = 10;
const REPORT_WINDOW: Duration = Duration::from_secs(60);

thread_local! {
    static PLUGIN_THREAD: Cell<bool> = const { Cell::new(false) };
}

/// Whether this is a plugin's own thread (where waiting on the host would wait on itself).
pub(super) fn on_plugin_thread() -> bool {
    PLUGIN_THREAD.with(Cell::get)
}

/// What a plugin's thread is asked to do.
pub(super) enum Msg {
    Call {
        kind: Kind,
        name: String,
        args: Json,
        reply: oneshot::Sender<Result<Json, HostError>>,
    },
    Emit {
        event: String,
        payload: Json,
    },
    /// An async host call's answer, for the runtime that asked (a runtime built again after a
    /// fault has another generation and never hears it).
    Settle {
        generation: u64,
        token: u64,
        result: Result<Json, HostError>,
    },
    Stop,
}

/// Tells a plugin's thread to stop, and what its waiting callers hear. Running JavaScript
/// checks it through the interrupt handler.
#[derive(Default)]
pub(super) struct Halt {
    set: AtomicBool,
    reason: Mutex<Option<HostError>>,
}

impl Halt {
    pub fn is_set(&self) -> bool {
        self.set.load(Ordering::Relaxed)
    }

    fn stop(&self, reason: HostError) {
        let mut why = self.reason.lock().unwrap_or_else(PoisonError::into_inner);
        why.get_or_insert(reason);
        self.set.store(true, Ordering::Relaxed);
    }

    fn reason(&self) -> Option<HostError> {
        self.reason
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .clone()
    }
}

/// What a plugin's thread keeps across its runtimes, for the log.
#[derive(Default)]
pub(super) struct Notes {
    unsupported: RefCell<HashSet<String>>,
    /// The current window's start and how many reports it has had.
    reports: Cell<Option<(Instant, u32)>>,
}

impl Notes {
    /// Whether this is the first `unsupported` answer to the service.
    pub fn first_unsupported(&self, name: &str) -> bool {
        self.unsupported.borrow_mut().insert(name.to_string())
    }

    /// Whether another report fits in this window.
    pub fn may_report(&self) -> bool {
        let now = Instant::now();
        let (start, count) = match self.reports.get() {
            Some((start, count)) if now < start + REPORT_WINDOW => (start, count),
            _ => (now, 0),
        };
        self.reports.set(Some((start, count + 1)));
        count < REPORTS_PER_WINDOW
    }
}

/// The host's handle on a plugin's thread.
pub(super) struct Worker {
    queue: mpsc::Sender<Msg>,
    halt: Arc<Halt>,
    thread: std::thread::JoinHandle<()>,
    /// Tells this thread from the one started after it.
    pub serial: u64,
}

impl Worker {
    /// Starts the plugin's thread, which builds its runtime and runs `apply(ctx)` first; `load`
    /// hears when that has finished.
    pub fn spawn(
        package: Arc<Package>,
        services: Arc<dyn HostServices>,
        limits: Arc<Limits>,
        serial: u64,
        load: Option<LoadReply>,
    ) -> Result<Worker, HostError> {
        let (queue, rx) = mpsc::channel();
        let halt = Arc::new(Halt::default());
        let id = package.id.clone();
        let (own_queue, own_halt) = (queue.clone(), halt.clone());
        let run = move || {
            PLUGIN_THREAD.with(|t| t.set(true));
            let mut thread = PluginThread {
                wiring: Wiring {
                    services,
                    limits,
                    queue: own_queue,
                    halt: own_halt,
                    notes: Rc::new(Notes::default()),
                },
                package,
                plugin: None,
                generation: 0,
            };
            thread.run(rx, load);
        };
        let thread = std::thread::Builder::new()
            .name(format!("plugin-{id}"))
            .stack_size(THREAD_STACK)
            .spawn(run)
            .map_err(|e| {
                HostError::new(
                    ErrorCode::Limit,
                    format!("can't start a thread for {id}: {e}"),
                )
            })?;
        Ok(Worker {
            queue,
            halt,
            thread,
            serial,
        })
    }

    pub fn send(&self, msg: Msg) {
        // A send fails only once the thread has ended; the caller's reply is then dropped.
        let _ = self.queue.send(msg);
    }

    /// Asks the thread to stop: running JavaScript is interrupted, and callers still waiting
    /// hear `reason`. The thread ends once it is out of any service it is in.
    pub fn stop(&self, reason: HostError) {
        self.halt.stop(reason);
        self.send(Msg::Stop);
    }

    pub fn is_finished(&self) -> bool {
        self.thread.is_finished()
    }

    pub fn join(self) {
        let _ = self.thread.join();
    }
}

struct PluginThread {
    package: Arc<Package>,
    wiring: Wiring,
    plugin: Option<Plugin>,
    /// Numbers each runtime, so an async answer reaches only the runtime that asked.
    generation: u64,
}

impl PluginThread {
    fn run(&mut self, rx: mpsc::Receiver<Msg>, load: Option<LoadReply>) {
        if let Err(e) = self.build(load) {
            log::warn!("[plugin:{}] didn't load: {e}", self.package.id);
        }
        while !self.wiring.halt.is_set() {
            let wake = self.plugin.as_ref().and_then(Plugin::next_wake);
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
                Some(msg) if self.wiring.halt.is_set() => {
                    self.refuse(msg, &self.why_stopped());
                    break;
                }
                Some(msg) => self.handle(msg),
                None => {}
            }
            self.tick();
        }
        let why = self.why_stopped();
        if let Some(plugin) = self.plugin.take() {
            plugin.close(why.clone());
        }
        for msg in rx.try_iter() {
            self.refuse(msg, &why);
        }
    }

    fn why_stopped(&self) -> HostError {
        self.wiring.halt.reason().unwrap_or_else(|| {
            HostError::new(
                ErrorCode::NotFound,
                format!("{} was unloaded", self.package.id),
            )
        })
    }

    fn refuse(&self, msg: Msg, why: &HostError) {
        if let Msg::Call { reply, .. } = msg {
            let _ = reply.send(Err(why.clone()));
        }
    }

    fn handle(&mut self, msg: Msg) {
        match msg {
            Msg::Call {
                kind,
                name,
                args,
                reply,
            } => {
                if let Err(e) = self.ready() {
                    let _ = reply.send(Err(e));
                    return;
                }
                let Some(plugin) = self.plugin.as_mut() else {
                    return;
                };
                plugin.begin_turn();
                plugin.call(kind, &name, &args, reply);
                plugin.run_jobs();
                self.finish();
            }
            Msg::Emit { event, payload } => {
                if let Err(e) = self.ready() {
                    log::warn!("[plugin:{}] {event}: {e}", self.package.id);
                    return;
                }
                let Some(plugin) = self.plugin.as_mut() else {
                    return;
                };
                plugin.begin_turn();
                plugin.event(&event, &payload);
                plugin.run_jobs();
                self.finish();
            }
            Msg::Settle {
                generation,
                token,
                result,
            } => {
                let plugin = self.plugin.as_mut();
                let Some(plugin) = plugin.filter(|p| p.generation() == generation) else {
                    return;
                };
                plugin.begin_turn();
                plugin.settle(token, result);
                plugin.run_jobs();
                self.finish();
            }
            Msg::Stop => {}
        }
    }

    /// Runs the timers that are due, in one turn.
    fn tick(&mut self) {
        let Some(plugin) = self.plugin.as_mut() else {
            return;
        };
        let due = plugin.due_timers(Instant::now());
        if due.is_empty() {
            return;
        }
        plugin.begin_turn();
        for id in due {
            if plugin.overran() {
                break;
            }
            plugin.timer(id);
        }
        plugin.run_jobs();
        self.finish();
    }

    /// The plugin's runtime, built again if a fault dropped it.
    fn ready(&mut self) -> Result<(), HostError> {
        if self.plugin.is_some() {
            return Ok(());
        }
        self.build(None).map_err(|e| {
            let e = HostError::new(e.code, format!("couldn't start again: {}", e.message));
            log::warn!("[plugin:{}] {e}", self.package.id);
            e
        })
    }

    /// Builds a runtime from the package and starts `apply(ctx)`; `load` hears when it has
    /// finished. Returns why the plugin didn't start, if it didn't.
    fn build(&mut self, load: Option<LoadReply>) -> Result<(), HostError> {
        self.generation += 1;
        let (package, wiring) = (&self.package, &self.wiring);
        // Evaluating main.js and its apply(ctx) share one turn.
        let made = Plugin::new(package, self.generation, wiring).and_then(|mut plugin| {
            plugin.begin_turn();
            match plugin.evaluate(package, wiring) {
                Ok(()) => Ok(plugin),
                Err(e) => {
                    plugin.end_turn();
                    Err(e)
                }
            }
        });
        let plugin = match made {
            Ok(plugin) => plugin,
            Err(e) => {
                if let Some(load) = load {
                    let _ = load.send(Err(e.clone()));
                }
                return Err(e);
            }
        };
        let plugin = self.plugin.insert(plugin);
        plugin.apply(Reply::Load(load));
        plugin.run_jobs();
        match self.finish() {
            Some(why) => Err(why),
            None => Ok(()),
        }
    }

    /// Ends the turn under way: reports what nobody handled, sends the answers, and faults a
    /// plugin that overran (or whose `apply(ctx)` failed). Returns why the plugin went, if it
    /// did.
    fn finish(&mut self) -> Option<HostError> {
        let plugin = self.plugin.as_mut()?;
        if !plugin.overran() {
            plugin.report_unhandled();
        }
        plugin.end_turn();
        let load_failed = plugin.deliver();
        let why = if self.wiring.halt.is_set() {
            // Stopped by the host (unloaded, say): the thread ends next, and callers hear why.
            self.why_stopped()
        } else if plugin.overran() {
            plugin.overrun_error()
        } else {
            load_failed?
        };
        if !self.wiring.halt.is_set() {
            log::warn!("[plugin:{}] {why}", self.package.id);
        }
        if let Some(plugin) = self.plugin.take() {
            plugin.close(why.clone());
        }
        Some(why)
    }
}
