//! AI features: finding the Claude Code CLIs, reporting which AI profiles can be used,
//! and running Claude headless and tool-free.
pub mod command;
pub mod discover;
#[cfg(any(test, feature = "test-support"))]
pub mod fake;
pub mod profiles;
pub mod runner;
pub mod stream;
