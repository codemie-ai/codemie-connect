//! A copy of a folder the user gave a plugin, for a Claude run that edits (`claude.run` with
//! `mode: 'copy'`): the folder's files into the plugin's store, `cache/snapshots/<id>/`, where the
//! run works and the plugin reviews what changed before writing anything back through `fs.write`.
//! Dot files come too (a vault's `.claude/skills` and `CLAUDE.md` guide the run), but never a
//! `.git` folder or `.obsidian/plugins`, nor a link, nor the paths `exclude` names. A file over
//! 50 MB, or one that can't be read, is left out and counted. A plugin keeps 3 at most.
use super::{bad, io_failed};
use crate::plugins::host::{ErrorCode, HostError};
use serde_json::{json, Value};
use std::path::{Path, PathBuf};

/// The store folder snapshots live in.
pub const DIR: &str = "cache/snapshots";
/// How many a plugin keeps, and the most one holds.
const KEEP: usize = 3;
const MAX_FILES: usize = 20_000;
const MAX_BYTES: u64 = 512 << 20;
const FILE_MAX: u64 = 50 << 20;
const MAX_EXCLUDE: usize = 100;

/// A snapshot made: where it is (in the store and on disk) and what it holds.
pub struct Snapshot {
    /// Its path in the store, `cache/snapshots/<id>`.
    pub path: String,
    pub dir: PathBuf,
    pub answer: Value,
}

impl Snapshot {
    /// Removes it (a run that failed leaves nothing behind).
    pub fn remove(&self) {
        let _ = std::fs::remove_dir_all(&self.dir);
    }
}

/// Copies `root` into `store`'s snapshots as described above.
pub fn take(store: &Path, root: &Path, exclude: &[String]) -> Result<Snapshot, HostError> {
    if exclude.len() > MAX_EXCLUDE {
        return Err(bad("exclude names 100 paths at most"));
    }
    let base = store.join(DIR);
    std::fs::create_dir_all(&base).map_err(|e| io_failed("make the snapshot", &e))?;
    let kept = std::fs::read_dir(&base)
        .map(|d| d.flatten().filter(|e| e.path().is_dir()).count())
        .unwrap_or(0);
    if kept >= KEEP {
        return Err(HostError::new(
            ErrorCode::Limit,
            "this plugin keeps 3 snapshots already: remove one (ctx.store.remove) first",
        ));
    }
    let id: String = uuid::Uuid::new_v4().simple().to_string()[..16].to_string();
    let dir = base.join(&id);
    let snap = Snapshot {
        path: format!("{DIR}/{id}"),
        dir: dir.clone(),
        answer: Value::Null,
    };
    let excluded: Vec<String> = exclude
        .iter()
        .map(|e| e.trim_matches('/').to_lowercase())
        .filter(|e| !e.is_empty())
        .collect();
    let mut counts = Counts::default();
    let copied = copy_tree(root, &dir, "", &excluded, &mut counts);
    if let Err(e) = copied {
        snap.remove();
        return Err(e);
    }
    Ok(Snapshot {
        answer: json!({
            "path": snap.path,
            "files": counts.files,
            "bytes": counts.bytes,
            "skipped": counts.large + counts.unreadable,
            "why": {"large": counts.large, "unreadable": counts.unreadable},
        }),
        ..snap
    })
}

#[derive(Default)]
struct Counts {
    files: usize,
    bytes: u64,
    large: usize,
    unreadable: usize,
}

/// Never copied, at any depth: a git repository, Obsidian's community code.
fn left_out(rel: &str, name: &str, is_dir: bool) -> bool {
    let lower = rel.to_lowercase();
    (is_dir && name.eq_ignore_ascii_case(".git"))
        || name.eq_ignore_ascii_case(".git")
        || lower == ".obsidian/plugins"
        || lower.ends_with("/.obsidian/plugins")
}

fn copy_tree(
    from: &Path,
    to: &Path,
    rel: &str,
    exclude: &[String],
    counts: &mut Counts,
) -> Result<(), HostError> {
    std::fs::create_dir_all(to).map_err(|e| io_failed("make the snapshot", &e))?;
    let Ok(entries) = std::fs::read_dir(from) else {
        counts.unreadable += 1;
        return Ok(());
    };
    for e in entries.flatten() {
        let name = e.file_name().to_string_lossy().into_owned();
        let path = if rel.is_empty() {
            name.clone()
        } else {
            format!("{rel}/{name}")
        };
        let Ok(t) = e.file_type() else {
            counts.unreadable += 1;
            continue;
        };
        let lower = path.to_lowercase();
        if t.is_symlink()
            || left_out(&path, &name, t.is_dir())
            || exclude
                .iter()
                .any(|x| lower == *x || lower.starts_with(&format!("{x}/")))
        {
            continue;
        }
        if t.is_dir() {
            copy_tree(&e.path(), &to.join(&name), &path, exclude, counts)?;
            continue;
        }
        if !t.is_file() {
            continue;
        }
        let size = e.metadata().map_or(0, |m| m.len());
        if size > FILE_MAX {
            counts.large += 1;
            continue;
        }
        if counts.files + 1 > MAX_FILES || counts.bytes + size > MAX_BYTES {
            return Err(HostError::new(
                ErrorCode::Limit,
                "the folder is too large to copy for a run (20,000 files or 512 MB at most)",
            ));
        }
        match std::fs::copy(e.path(), to.join(&name)) {
            Ok(n) if n <= FILE_MAX => {
                counts.files += 1;
                counts.bytes += n;
            }
            Ok(_) => {
                let _ = std::fs::remove_file(to.join(&name));
                counts.large += 1;
            }
            Err(_) => counts.unreadable += 1,
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_copy_leaves_out_git_plugins_links_and_what_is_excluded() {
        let dir = tempfile::tempdir().unwrap();
        let vault = dir.path().join("vault");
        let store = dir.path().join("store");
        for (p, t) in [
            ("notes/a.md", "a"),
            ("CLAUDE.md", "rules"),
            (".claude/skills/twin/SKILL.md", "---\nname: twin\n---\n"),
            (".obsidian/app.json", "{}"),
            (".obsidian/plugins/x/main.js", "code"),
            (".git/config", "x"),
            ("raw/secret.md", "s"),
            ("raw/keep.md", "k"),
        ] {
            let f = vault.join(p);
            std::fs::create_dir_all(f.parent().unwrap()).unwrap();
            std::fs::write(f, t).unwrap();
        }
        #[cfg(unix)]
        std::os::unix::fs::symlink("/etc", vault.join("etc")).unwrap();
        let snap = take(&store, &vault, &["raw/secret.md".into()]).unwrap();
        assert!(snap.path.starts_with("cache/snapshots/"));
        assert_eq!(snap.answer["files"], 5, "{}", snap.answer);
        assert_eq!(snap.answer["skipped"], 0);
        for kept in [
            "notes/a.md",
            "CLAUDE.md",
            ".claude/skills/twin/SKILL.md",
            ".obsidian/app.json",
            "raw/keep.md",
        ] {
            assert!(snap.dir.join(kept).is_file(), "{kept}");
        }
        for gone in [".obsidian/plugins", ".git", "raw/secret.md", "etc"] {
            assert!(!snap.dir.join(gone).exists(), "{gone}");
        }
        // Three at most; removing one makes room.
        let two = take(&store, &vault, &[]).unwrap();
        take(&store, &vault, &[]).unwrap();
        let e = take(&store, &vault, &[]).err().unwrap();
        assert!(e.message.contains("keeps 3 snapshots already"), "{e}");
        two.remove();
        take(&store, &vault, &[]).unwrap();
        assert!(take(&store, &vault, &vec!["x".to_string(); 101]).is_err());
    }
}
