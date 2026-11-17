//! Automations (DESIGN 6.6). `rules` holds the model and the pure decisions (validation,
//! schedule times, event matching); `engine` holds persistence, the job queue and the operations.
mod engine;
mod rules;

pub use engine::ROUND_TICKS;
