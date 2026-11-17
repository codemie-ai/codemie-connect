//! Reads the real published Echo plugins' manifests. Skipped when `CONNECT_ECHO_PLUGINS_DIR`
//! (default: a local checkout of echo-plugins) isn't there; nothing of those plugins is copied
//! into this repository.
use app_lib::plugins::capabilities::{sheet, Support};
use app_lib::plugins::manifest::{check_compat, parse_manifest, ManifestError};
use std::path::PathBuf;

const DEFAULT_DIR: &str =
    "/Users/Vadym_Vlasenko/.codex/worktrees/knowledge-plugin-0300/echo-plugins/plugins/";

#[test]
fn published_manifests_parse_and_only_knowledge_is_blocked() {
    let dir =
        PathBuf::from(std::env::var("CONNECT_ECHO_PLUGINS_DIR").unwrap_or(DEFAULT_DIR.into()));
    if !dir.is_dir() {
        eprintln!(
            "skipped: {} not found (set CONNECT_ECHO_PLUGINS_DIR)",
            dir.display()
        );
        return;
    }
    for id in ["knowledge", "scheduler", "github", "obsidian", "telegram"] {
        let m = parse_manifest(&dir.join(id)).unwrap_or_else(|e| panic!("{id}: {e}"));
        assert_eq!(m.id, id);
        if id == "knowledge" {
            let lines = sheet(&m).unwrap();
            let blocked: Vec<_> = lines
                .iter()
                .filter(|l| matches!(l.support, Support::Blocking(_)))
                .collect();
            assert_eq!(blocked.len(), 1, "{lines:?}");
            assert_eq!(blocked[0].key, "knowledge");
        } else {
            let lines = sheet(&m).unwrap_or_else(|e| panic!("{id}: {e}"));
            assert!(!lines.is_empty(), "{id}");
            assert!(
                lines
                    .iter()
                    .all(|l| !matches!(l.support, Support::Blocking(_))),
                "{id} must not be blocked"
            );
        }
        // Whether Connect's Echo API satisfies the plugin's range is a separate answer (Task 19).
        match check_compat(&m) {
            Ok(()) | Err(ManifestError::Incompatible { .. }) => {}
            Err(e) => panic!("{id}: {e}"),
        }
    }
}
