//! Automations (DESIGN 6.6). `rules` holds the model and the pure decisions (validation,
//! schedule times, event matching); `engine` holds persistence, the job queue and the
//! operations; `context` builds what a run reads and `run` executes and delivers it.
mod context;
mod engine;
mod rules;
mod run;

pub use engine::ROUND_TICKS;
