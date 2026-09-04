DONE

commit: 0451650
changed paths:
  - src-tauri/tauri.conf.json
  - src-tauri/Cargo.toml
  - src-tauri/tests/bundle_resources.rs

test command: cd src-tauri && cargo test --test bundle_resources

summary:
  - Created src-tauri/tests/bundle_resources.rs with two integration tests:
    1. bundle_resources_resolve_one_to_one — walks the filesystem and asserts source count == target count (catches glob flattening)
    2. bundle_resources_ship_no_pkg_exe — asserts the pkg binary is not in bundle.resources
  - Added tauri-utils = { version = "2", features = ["resources"] } to [dev-dependencies]
  - Updated tauri.conf.json bundle.resources to ship codemie.cmd, node/node.exe, and cli/node_modules (plain directory path, no glob)
  - TDD flow: RED (bundle_resources_ship_no_pkg_exe failed on pkg exe), GREEN (both pass with new config)
  - Glob regression proven: temporarily adding /**/* caused build failure (exit 101), plain path restores GREEN
  - Full cargo test suite: EXIT=0, 2 passed
