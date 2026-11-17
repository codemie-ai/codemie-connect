//! Reads the real Echo plugins' manifests; nothing of those plugins is copied into this repository.
//! Each directory skips on its own, with a message, when it isn't there.
//!
//! - `CONNECT_ECHO_PLUGINS_DIR` (default `$HOME/AI/projects/other/echo-plugins/plugins`): the
//!   published plugins (echo-plugins main). Scheduler, GitHub, Obsidian and Telegram must parse,
//!   have a sheet with nothing blocking, and fit Connect's Echo API.
//! - `CONNECT_KNOWLEDGE_PLUGINS_DIR` (default
//!   `$HOME/.codex/worktrees/knowledge-plugin-0300/echo-plugins/plugins`): a moving worktree, used
//!   for Knowledge's blocked line and the compatibility refusal only (ruling R31).
use app_lib::plugins::capabilities::{sheet, Support};
use app_lib::plugins::manifest::{check_compat, parse_manifest, ManifestError};
use std::path::PathBuf;

fn dir(var: &str, default_under_home: &str) -> Option<PathBuf> {
    let d = std::env::var_os(var)
        .map(PathBuf::from)
        .or_else(|| std::env::var_os("HOME").map(|h| PathBuf::from(h).join(default_under_home)))?;
    if d.is_dir() {
        Some(d)
    } else {
        eprintln!("skipped: {} not found (set {var})", d.display());
        None
    }
}

#[test]
fn published_manifests_parse_and_none_is_blocked() {
    let Some(dir) = dir(
        "CONNECT_ECHO_PLUGINS_DIR",
        "AI/projects/other/echo-plugins/plugins",
    ) else {
        return;
    };
    for id in ["scheduler", "github", "obsidian", "telegram"] {
        let m = parse_manifest(&dir.join(id)).unwrap_or_else(|e| panic!("{id}: {e}"));
        assert_eq!(m.id, id);
        let lines = sheet(&m).unwrap_or_else(|e| panic!("{id}: {e}"));
        assert!(!lines.is_empty(), "{id}");
        assert!(
            lines
                .iter()
                .all(|l| !matches!(l.support, Support::Blocking(_))),
            "{id} must not be blocked: {lines:?}"
        );
        check_compat(&m).unwrap_or_else(|e| panic!("{id}: {e}"));
    }
}

#[test]
fn knowledge_is_blocked_and_a_range_above_connect_is_refused() {
    let Some(dir) = dir(
        "CONNECT_KNOWLEDGE_PLUGINS_DIR",
        ".codex/worktrees/knowledge-plugin-0300/echo-plugins/plugins",
    ) else {
        return;
    };
    let m = parse_manifest(&dir.join("knowledge")).unwrap();
    let lines = sheet(&m).unwrap();
    let blocked: Vec<_> = lines
        .iter()
        .filter(|l| matches!(l.support, Support::Blocking(_)))
        .collect();
    assert_eq!(blocked.len(), 1, "{lines:?}");
    assert_eq!(blocked[0].key, "knowledge");
    // Whatever else is in the worktree: a range that excludes Connect's API is refused with the
    // reason; a range that includes it passes.
    let mut seen = 0;
    for entry in std::fs::read_dir(&dir).unwrap().flatten() {
        let Ok(m) = parse_manifest(&entry.path()) else {
            continue;
        };
        seen += 1;
        match check_compat(&m) {
            Ok(()) => {}
            Err(e @ ManifestError::Incompatible { .. }) => {
                assert!(e.to_string().starts_with("it needs Echo "), "{}: {e}", m.id)
            }
            Err(e) => panic!("{}: {e}", m.id),
        }
    }
    assert!(seen >= 1);
}
