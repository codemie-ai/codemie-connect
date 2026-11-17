//! Reads the real Echo plugins' manifests; nothing of those plugins is copied into this repository.
//! Each directory skips on its own, with a message, when it isn't there.
//!
//! - `CONNECT_ECHO_PLUGINS_DIR` (default `$HOME/AI/projects/other/echo-plugins/plugins`): the
//!   published plugins (echo-plugins main). Scheduler, GitHub, Obsidian and Telegram must parse,
//!   have a sheet with nothing blocking, and fit Connect's Echo API.
//! - `CONNECT_KNOWLEDGE_PLUGINS_DIR` (default
//!   `$HOME/.codex/worktrees/knowledge-plugin-0300/echo-plugins/plugins`): a moving worktree, used
//!   for Knowledge's blocked line and the compatibility refusal only (ruling R31).
//!
//! Each directory's parent holds its `echo-marketplace.json`, so it is also added as a local
//! marketplace and installed from, into a temp data root.
use app_lib::plugins::capabilities::{sheet, Support};
use app_lib::plugins::git::CliGit;
use app_lib::plugins::install::{self, sheet_hash, Agreement, Outcome};
use app_lib::plugins::manifest::{check_compat, parse_manifest, ManifestError};
use app_lib::plugins::market;
use app_lib::plugins::registry::{Market, PluginPaths, Registry};
use app_lib::plugins::tree::tree_hash;
use std::path::{Path, PathBuf};

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

/// The marketplace a plugins directory belongs to (its parent), added to a temp data root.
fn local_market(plugins: &Path) -> Option<(tempfile::TempDir, PluginPaths, Market)> {
    let root = plugins.parent()?;
    if !root.join(market::CATALOG_FILE).is_file() {
        eprintln!("skipped: no {} in {}", market::CATALOG_FILE, root.display());
        return None;
    }
    let tmp = tempfile::tempdir().unwrap();
    let data = tmp.path().join("data");
    std::fs::create_dir_all(&data).unwrap();
    let paths = PluginPaths::new(&data, &tmp.path().join("private"));
    // A folder is read where it is: nothing is fetched.
    let m = market::add(&paths, &CliGit::default(), root.to_str().unwrap()).unwrap();
    Some((tmp, paths, m))
}

#[test]
fn published_plugins_install_from_their_local_marketplace() {
    let Some(dir) = dir(
        "CONNECT_ECHO_PLUGINS_DIR",
        "AI/projects/other/echo-plugins/plugins",
    ) else {
        return;
    };
    let Some((_tmp, paths, m)) = local_market(&dir) else {
        return;
    };
    // Its catalog is named like the built-in one, so it gets the next free name.
    assert_eq!(m.name, "onetest-2");
    let ids = ["scheduler", "github", "obsidian", "telegram"];
    for id in ids {
        let offer = install::offer(&paths, &m, id).unwrap();
        assert!(offer.refusal.is_none(), "{id}: {:?}", offer.refusal);
        let agreed: Vec<String> = offer.sheet.iter().map(|l| l.key.clone()).collect();
        let hash = sheet_hash(&offer.sheet);
        let agreement = Agreement {
            keys: &agreed,
            sheet_hash: &hash,
        };
        let out = install::install(&paths, &m.name, id, agreement).unwrap();
        assert!(matches!(out, Outcome::Installed(ref got) if got == id));
        let reg = Registry::load(&paths).unwrap();
        let p = &reg.installed[id];
        let copy = paths.installed().join(id).join(&p.version);
        assert_eq!(p.hash, tree_hash(&copy).unwrap(), "{id}");
        assert_eq!(p.hash, tree_hash(&dir.join(id)).unwrap(), "{id}");
        let mut want = agreed.clone();
        want.sort();
        assert_eq!(p.agreed, want, "{id}");
        assert!(p.enabled);
    }
    for id in ids {
        install::remove(&paths, id, true).unwrap();
    }
    assert!(Registry::load(&paths).unwrap().installed.is_empty());
    assert_eq!(std::fs::read_dir(paths.installed()).unwrap().count(), 0);
    assert_eq!(
        std::fs::read_dir(paths.root.join("tmp")).unwrap().count(),
        0
    );
}

#[test]
fn knowledge_is_refused_at_install_with_its_sheet_line() {
    let Some(dir) = dir(
        "CONNECT_KNOWLEDGE_PLUGINS_DIR",
        ".codex/worktrees/knowledge-plugin-0300/echo-plugins/plugins",
    ) else {
        return;
    };
    let Some((_tmp, paths, m)) = local_market(&dir) else {
        return;
    };
    let offer = install::offer(&paths, &m, "knowledge").unwrap();
    let keys: Vec<String> = offer.sheet.iter().map(|l| l.key.clone()).collect();
    let hash = sheet_hash(&offer.sheet);
    let agreement = Agreement {
        keys: &keys,
        sheet_hash: &hash,
    };
    let e = install::install(&paths, &m.name, "knowledge", agreement).unwrap_err();
    assert_eq!(e.code, "blocked");
    assert_eq!(e.message, "Needs Connect's Knowledge engine (coming later)");
    assert!(Registry::load(&paths).unwrap().installed.is_empty());
}
