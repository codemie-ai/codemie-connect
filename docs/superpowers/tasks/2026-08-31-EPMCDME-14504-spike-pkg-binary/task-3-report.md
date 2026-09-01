DONE
commit: 70ec074
changed_paths: src-tauri/src/commands/pathman.rs, src-tauri/src/lib.rs
test_command: cd src-tauri && cargo test

notes:
- env!("TARGET") is not available at normal crate compile time (only in build scripts);
  replaced with runtime construction via std::env::consts::ARCH + cfg target_os guards.
- Added `use tauri::{Manager, State};` to bring Manager trait into scope for app.path() call.
- All 29 tests pass; cargo clippy -D warnings clean.
