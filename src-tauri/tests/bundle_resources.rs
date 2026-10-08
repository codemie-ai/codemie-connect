//! Guards the `bundle.resources` contract in tauri.conf.json and the platform overlay.
//!
//! A glob key (`.../**/*`) makes tauri-utils join only the file name
//! (resources.rs:196), flattening 19,754 files into 9,782 targets — 620 of
//! them onto a single `index.js`. Tauri reports `errors: 0`, so the build
//! succeeds and ships a bundle Node cannot resolve. Only this test catches it.
use std::collections::{HashMap, HashSet};
use tauri_utils::resources::ResourcePaths;

/// `bundle.resources` of one config file; an absent key is an empty map.
fn read_resources(file: &str) -> HashMap<String, String> {
    let Ok(raw) = std::fs::read_to_string(file) else {
        return HashMap::new();
    };
    let conf: serde_json::Value =
        serde_json::from_str(&raw).unwrap_or_else(|e| panic!("parse {file}: {e}"));
    match &conf["bundle"]["resources"] {
        serde_json::Value::Null => HashMap::new(),
        v => serde_json::from_value(v.clone()).unwrap_or_else(|e| {
            panic!("{file}: bundle.resources must be a map of source -> target: {e}")
        }),
    }
}

/// The map tauri-build sees on this platform: the shared config merged with the
/// platform overlay (`tauri.windows.conf.json` / `tauri.macos.conf.json`), the
/// same deep-merge Tauri applies. Each platform's artifacts live in its overlay
/// so the other platform's `cargo build` does not need them staged.
fn resources_map() -> HashMap<String, String> {
    let overlay = if cfg!(windows) {
        "tauri.windows.conf.json"
    } else if cfg!(target_os = "macos") {
        "tauri.macos.conf.json"
    } else {
        "tauri.linux.conf.json"
    };
    let mut map = read_resources("tauri.conf.json");
    map.extend(read_resources(overlay));
    map
}

#[test]
fn bundle_resources_resolve_one_to_one() {
    let map = resources_map();
    if map.is_empty() {
        // Nothing declared for this platform; nothing can flatten.
        return;
    }

    // allow_walk = true matches tauri-build-2.6.2/src/lib.rs:572
    let mut total = 0usize;
    let mut targets = HashSet::new();
    for res in ResourcePaths::from_map(&map, true).iter() {
        let r = res.expect("a bundle.resources pattern failed to resolve");
        total += 1;
        targets.insert(r.target().to_path_buf());
    }

    assert!(total > 0, "bundle.resources resolved to no files at all");
    assert_eq!(
        targets.len(),
        total,
        "bundle.resources collapses {} sources into {} targets — a glob key is \
         flattening the tree; use a plain directory path instead (spec §5)",
        total,
        targets.len()
    );
}

#[test]
fn bundle_resources_ship_no_pkg_exe() {
    for (src, target) in &resources_map() {
        assert!(
            !src.contains("codemie-x86_64-pc-windows-msvc") && !target.ends_with("codemie.exe"),
            "the pkg binary was reintroduced into bundle.resources: {src} -> {target}"
        );
    }
}

/// Node and the CLI tree are downloaded on first launch (commands/runtime.rs);
/// bundling them again would put ~200 MB back in the installer.
#[cfg(windows)]
#[test]
fn windows_bundle_ships_only_the_shims_and_the_runtime_key() {
    for (src, target) in &resources_map() {
        assert!(
            (target.starts_with("bin/codemie") && target.ends_with(".cmd"))
                || target == "bin/runtime-key",
            "unexpected bundled resource {src} -> {target}: Node and the CLI are downloaded"
        );
    }
}
