//! User-chosen data folder: the location pointer and target validation.
//! Pure logic; wired into startup, moves and Settings by later tasks.

// TODO(Tasks 11-13): startup (11), moves (12) and Settings (13) are the users; drop this allow when wired.
#![allow(dead_code)]

pub mod location;
