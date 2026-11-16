//! AI features: finding the Claude Code CLIs, reporting which AI profiles can be used,
//! and running Claude headless and tool-free.
#[allow(dead_code)] // used from Task 5
pub mod command;
pub mod discover;
#[cfg(test)]
pub mod fake;
pub mod profiles;
#[allow(dead_code)] // used from Task 5
pub mod runner;
#[allow(dead_code)] // used from Task 5
pub mod stream;
