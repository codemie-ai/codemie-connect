DONE
commit: e3ef97d
changed paths: src-tauri/src/commands/pathman.rs
test command: cd src-tauri && cargo test

## Summary

Removed `codemie.exe` from `candidate_bin_names()` on Windows so a stale pkg
binary can no longer shadow the shim and reproduce the original crash.
Collapsed the three-way `sidecar_name` cfg block to two-way (macOS +
non-macOS), eliminating the Windows `.exe`-suffixed sidecar name.

Two new tests were added (test-first, RED then GREEN) inside the existing
`#[cfg(all(test, windows))] mod tests_windows_probe` block:
- `candidate_bin_names_exclude_pkg_exe` — asserts `codemie.exe` is absent and
  `codemie.cmd` is first.
- `probe_dir_ignores_stale_pkg_exe` — asserts a dir containing only
  `codemie.exe` does NOT match the probe.

Full suite: 62/62 passing (60 lib + 2 integration).
cargo fmt --check: exit 0.
cargo clippy -- -D warnings: exit 0.
