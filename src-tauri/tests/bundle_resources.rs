//! Guards the `bundle.resources` contract in tauri.conf.json.
//!
//! A glob key (`.../**/*`) makes tauri-utils join only the file name
//! (resources.rs:196), flattening 19,754 files into 9,782 targets — 620 of
//! them onto a single `index.js`. Tauri reports `errors: 0`, so the build
//! succeeds and ships a bundle Node cannot resolve. Only this test catches it.
use std::collections::{HashMap, HashSet};
use tauri_utils::resources::ResourcePaths;

fn resources_map() -> HashMap<String, String> {
    let raw = std::fs::read_to_string("tauri.conf.json").expect("read tauri.conf.json");
    let conf: serde_json::Value = serde_json::from_str(&raw).expect("parse tauri.conf.json");
    serde_json::from_value(conf["bundle"]["resources"].clone())
        .expect("bundle.resources must be a map of source -> target")
}

#[test]
fn bundle_resources_resolve_one_to_one() {
    let map = resources_map();

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
