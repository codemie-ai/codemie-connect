//! `ctx.fs` and `ctx.system`: the folders the user picked for the plugin (`uses.folders`), read
//! as `(root, relative path)`. A root is one the user granted (`system.pickFolder`), kept in
//! `<data>/plugins/data/<id>/folders.json` by its real path. Every path is checked again on each
//! call: relative, plain names, never through a link, and its real path inside the root.
//! Changing files needs `folders.write`, never touches a hidden file or folder (`.git`) but the few
//! Echo allows (`hidden::hidden_ok`), replaces a file atomically (or only over the text the plugin
//! read, `{ifSha}`, or only where nothing is, `{createNew}`), and a move never replaces another
//! file (PLUGIN-ENGINE.md §8). A hidden folder, or one inside it, is never given.
use super::store::inside;
use super::{at, bad, io_failed, permission, read_json, text, write_json, Granted, Services};
use crate::plugins::host::{ErrorCode, HostError};
use serde_json::{json, Value};
use std::io::Read;
use std::path::{Path, PathBuf};
use std::sync::Arc;

/// A read without `max` gets 1 MB; none gets more than 4 MB.
const READ_DEFAULT: u64 = 1 << 20;
const READ_MAX: u64 = 4 << 20;
/// `readMany` reads at most this many files a call.
const MANY_MAX: usize = 5000;
/// `walk` lists 20 000 files unless asked for more, and never more than 100 000.
const WALK_DEFAULT: usize = 20_000;
const WALK_MAX: usize = 100_000;
/// A file's sha256 is given up to this size.
const SHA_MAX: u64 = 64 << 20;
/// `append` adds 1 MB at most.
const APPEND_MAX: usize = 1 << 20;
/// `search` gives 200 hits unless asked for more, never more than 1 000, reads 4 MB of a file and
/// cuts a line at 300 characters.
const SEARCH_DEFAULT: usize = 200;
const SEARCH_MAX: usize = 1000;
const SEARCH_READ: u64 = 4 << 20;
const SEARCH_LINE: usize = 300;

fn grants_file(s: &Services, id: &str) -> PathBuf {
    s.data_of(id).join("folders.json")
}

/// The roots granted to the plugin, as the plugin sees them.
pub fn roots(s: &Services, id: &str) -> Vec<String> {
    granted_roots(&s.paths, id)
}

/// The roots granted to plugin `id` under `paths` (for the frames' image route too).
pub fn granted_roots(paths: &crate::plugins::registry::PluginPaths, id: &str) -> Vec<String> {
    read_json(&paths.data_of(id).join("folders.json"), json!([]))
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(Value::as_str)
        .map(str::to_string)
        .collect()
}

/// Grants a folder the user picked; returns it as the plugin will name it (its real path).
pub fn grant(s: &Services, id: &str, dir: &Path) -> Result<String, HostError> {
    let real = dunce::canonicalize(dir).map_err(|e| io_failed("use that folder", &e))?;
    if !real.is_dir() {
        return Err(bad("that isn't a folder"));
    }
    let root = real.display().to_string();
    if let Some(h) = hidden_part(&real) {
        return Err(permission(format!(
            "{root} is a hidden folder or inside one (“{h}”), where other programs keep their settings: pick a folder that isn't hidden"
        )));
    }
    let mut all = roots(s, id);
    if !all.contains(&root) {
        all.push(root.clone());
        write_json(&grants_file(s, id), &json!(all))?;
    }
    Ok(root)
}

/// A granted root, still the folder it was granted as.
pub(crate) fn root_of(s: &Services, p: &Granted, root: &str) -> Result<PathBuf, HostError> {
    p.needs("folders", "read folders you pick")?;
    if root.is_empty() || !roots(s, &p.id).iter().any(|r| r == root) {
        return Err(permission(format!(
            "“{root}” isn't a folder you gave {}",
            p.name
        )));
    }
    let real = dunce::canonicalize(root).map_err(|e| io_failed("open the folder", &e))?;
    if real != Path::new(root) {
        return Err(permission(format!("“{root}” has become a link")));
    }
    Ok(real)
}

/// `rel` inside a granted root: no link on the way, and its real path inside the root.
pub(crate) fn resolve(root: &Path, rel: &str) -> Result<PathBuf, HostError> {
    let path = inside(root, rel, true)?;
    if let Ok(real) = dunce::canonicalize(&path) {
        if !real.starts_with(root) {
            return Err(permission(format!("“{rel}” leads out of the folder")));
        }
    }
    Ok(path)
}

/// The first hidden name in a path (`.claude` in `/Users/x/.claude/skills`), if any.
fn hidden_part(path: &Path) -> Option<String> {
    path.components()
        .filter_map(|c| match c {
            std::path::Component::Normal(n) => Some(n.to_string_lossy().into_owned()),
            _ => None,
        })
        .find(|n| n.starts_with('.'))
}

/// `rel` for a change: needs `folders.write`; never the folder itself, never a hidden name but
/// those Echo allows (`hidden_ok`), never in a hidden folder granted before such folders were
/// refused.
pub(crate) fn writable(
    s: &Services,
    p: &Granted,
    root: &str,
    rel: &str,
) -> Result<PathBuf, HostError> {
    let root = writable_root(s, p, root)?;
    if rel.trim_start_matches("./").is_empty() {
        return Err(permission(
            "a plugin doesn't change the folder itself, only files in it",
        ));
    }
    if !super::hidden::hidden_ok(rel, false) {
        return Err(permission(format!(
            "“{rel}” is hidden: a plugin changes notes, not other programs' files"
        )));
    }
    resolve(&root, rel)
}

/// A granted root the plugin may change (`folders.write`), not a hidden folder or inside one.
pub(crate) fn writable_root(s: &Services, p: &Granted, root: &str) -> Result<PathBuf, HostError> {
    let root = root_of(s, p, root)?;
    if !p.flag("folders", "write") {
        return Err(permission(format!(
            "{} may only read the folders you gave it (uses.folders.write)",
            p.id
        )));
    }
    s.writable()?;
    if let Some(h) = hidden_part(&root) {
        return Err(permission(format!(
            "{} is a hidden folder or inside one (“{h}”): nothing in it is changed",
            root.display()
        )));
    }
    Ok(root)
}

/// Makes the folders above `f` and checks again that none became a link.
fn make_parents(
    s: &Services,
    p: &Granted,
    root: &str,
    rel: &str,
    f: &Path,
) -> Result<PathBuf, HostError> {
    if let Some(parent) = f.parent() {
        std::fs::create_dir_all(parent).map_err(|e| io_failed("make its folder", &e))?;
    }
    writable(s, p, root, rel)
}

/// Adds `bytes` at the end of `f` (made when it isn't there), never through a link or into
/// anything but a plain file.
fn append(f: &Path, rel: &str, bytes: &[u8]) -> Result<(), HostError> {
    use std::io::Write as _;
    let failed = |e: std::io::Error| io_failed(&format!("add to “{rel}”"), &e);
    if let Ok(m) = std::fs::symlink_metadata(f) {
        if !m.file_type().is_file() {
            return Err(bad(format!("“{rel}” isn't a plain file")));
        }
    }
    let mut o = std::fs::OpenOptions::new();
    o.append(true).create(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        o.custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK);
    }
    let mut file = o.open(f).map_err(failed)?;
    if !file.metadata().map_err(failed)?.is_file() {
        return Err(bad(format!("“{rel}” isn't a plain file")));
    }
    file.write_all(bytes).map_err(failed)
}

/// How a file is read: `max` bytes at most (1 MB unless asked, 4 MB at most), and `strict`: bytes
/// that aren't UTF-8 are refused instead of replaced. Given as `max` or `{max, strict}`.
#[derive(Clone, Copy)]
pub(crate) struct ReadOpts {
    max: u64,
    strict: bool,
}

impl ReadOpts {
    pub(crate) fn of(v: &Value) -> ReadOpts {
        let max = v.get("max").unwrap_or(v);
        ReadOpts {
            max: max
                .as_u64()
                .filter(|m| *m > 0)
                .unwrap_or(READ_DEFAULT)
                .min(READ_MAX),
            strict: v.get("strict") == Some(&Value::Bool(true)),
        }
    }
}

/// `path`'s text, as `o` says. Strict: a character `max` cut in two is dropped, not refused;
/// anything else that isn't UTF-8 is `not UTF-8: <rel>`.
pub(crate) fn read_text(path: &Path, rel: &str, o: ReadOpts) -> Result<String, HostError> {
    let failed = |e: std::io::Error| io_failed(&format!("read “{rel}”"), &e);
    let mut buf = Vec::new();
    let mut f = std::fs::File::open(path).map_err(failed)?;
    (&mut f).take(o.max).read_to_end(&mut buf).map_err(failed)?;
    if !o.strict {
        return Ok(String::from_utf8_lossy(&buf).into_owned());
    }
    let whole = (buf.len() as u64) < o.max || f.metadata().is_ok_and(|m| m.len() <= o.max);
    match String::from_utf8(buf) {
        Ok(text) => Ok(text),
        // Only an unfinished character at the very end of a cut read.
        Err(e) if !whole && e.utf8_error().error_len().is_none() => {
            let valid = e.utf8_error().valid_up_to();
            let mut bytes = e.into_bytes();
            bytes.truncate(valid);
            Ok(String::from_utf8(bytes).expect("valid up to here"))
        }
        Err(_) => Err(bad(format!("not UTF-8: {rel}"))),
    }
}

/// A file's sha256 in hex, when it is no larger than 64 MB.
fn sha_of(path: &Path, size: u64) -> Option<String> {
    if size > SHA_MAX {
        return None;
    }
    std::fs::read(path).ok().map(|b| super::cas::sha_hex(&b))
}

/// Seconds since 1970 of a file's last change.
fn mtime_of(meta: &std::fs::Metadata) -> u64 {
    meta.modified()
        .ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map_or(0, |d| d.as_secs())
}

pub fn call(s: &Services, p: &Granted, name: &str, args: &Value) -> Result<Value, HostError> {
    let root = || text(args, 0, "a folder");
    let rel = |i| at(args, i).as_str().unwrap_or("");
    match name {
        "fs.folders" => {
            p.needs("folders", "read folders you pick")?;
            Ok(json!(roots(s, &p.id)))
        }
        "fs.forget" => {
            let gone = root()?;
            let all: Vec<String> = roots(s, &p.id).into_iter().filter(|r| r != gone).collect();
            write_json(&grants_file(s, &p.id), &json!(all))?;
            Ok(Value::Null)
        }
        "fs.list" => {
            let dir = resolve(&root_of(s, p, root()?)?, rel(1))?;
            let entries = std::fs::read_dir(&dir).map_err(|e| io_failed("list it", &e))?;
            let mut out = Vec::new();
            for e in entries.flatten() {
                let Ok(t) = e.file_type() else { continue };
                if t.is_symlink() {
                    continue;
                }
                out.push(json!({"name": e.file_name().to_string_lossy(), "dir": t.is_dir()}));
            }
            Ok(json!(out))
        }
        "fs.read" => {
            let f = resolve(&root_of(s, p, root()?)?, rel(1))?;
            read_text(&f, rel(1), ReadOpts::of(at(args, 2))).map(Value::from)
        }
        "fs.stat" => stat(&root_of(s, p, root()?)?, rel(1), at(args, 2)),
        "fs.write" => {
            let f = writable(s, p, root()?, rel(1))?;
            let content = text(args, 2, "the file's text")?;
            let guard = super::cas::guard_of(at(args, 3))?;
            if super::hidden::in_skills(rel(1)) {
                if let Some(why) = super::hidden::skill_md_problem(content) {
                    return Err(bad(why));
                }
            }
            if f.is_dir() {
                return Err(bad(format!("“{}” is a folder", rel(1))));
            }
            // The folders just made are checked again: none may have become a link.
            let f = make_parents(s, p, root()?, rel(1), &f)?;
            let _order = super::lock(&s.writes);
            super::cas::write(&f, rel(1), content.as_bytes(), &guard)?;
            Ok(Value::Null)
        }
        "fs.append" => {
            let f = writable(s, p, root()?, rel(1))?;
            if super::hidden::in_skills(rel(1)) {
                return Err(bad("a skill is written whole: no append"));
            }
            let mut content = text(args, 2, "the text to add")?.to_string();
            if content.len() > APPEND_MAX {
                return Err(HostError::new(
                    ErrorCode::Limit,
                    "ctx.fs.append adds 1 MB at most",
                ));
            }
            if !content.ends_with('\n') {
                content.push('\n');
            }
            let f = make_parents(s, p, root()?, rel(1), &f)?;
            let _order = super::lock(&s.writes);
            append(&f, rel(1), content.as_bytes())?;
            Ok(Value::Null)
        }
        "fs.move" => {
            let from = writable(s, p, root()?, rel(1))?;
            let to = writable(s, p, root()?, rel(2))?;
            if super::hidden::in_skills(rel(2)) {
                return Err(bad("a skill is written whole: no move into .claude/skills"));
            }
            if std::fs::symlink_metadata(&from).is_err() {
                return Err(HostError::new(
                    ErrorCode::NotFound,
                    format!("“{}” isn't there", rel(1)),
                ));
            }
            // There already, unless it is the same file under another case.
            let same = dunce::canonicalize(&to).ok() == dunce::canonicalize(&from).ok();
            if std::fs::symlink_metadata(&to).is_ok() && !same {
                return Err(bad(format!("“{}” is there already", rel(2))));
            }
            if let Some(parent) = to.parent() {
                std::fs::create_dir_all(parent).map_err(|e| io_failed("make its folder", &e))?;
            }
            std::fs::rename(&from, &to).map_err(|e| io_failed("move it", &e))?;
            Ok(Value::Null)
        }
        "fs.remove" => {
            let f = writable(s, p, root()?, rel(1))?;
            let removed = if f.is_dir() {
                std::fs::remove_dir(&f)
            } else {
                std::fs::remove_file(&f)
            };
            removed.map_err(|e| io_failed(&format!("remove “{}”", rel(1)), &e))?;
            Ok(Value::Null)
        }
        _ => Err(super::unsupported(name)),
    }
}

/// `fs.readMany`, `fs.walk` and `fs.search`: bulk reads, off the plugin's thread.
pub async fn call_async(
    s: Arc<Services>,
    p: Arc<Granted>,
    name: &str,
    args: Value,
) -> Result<Value, HostError> {
    let name = name.to_string();
    tauri::async_runtime::spawn_blocking(move || {
        let root = root_of(&s, &p, text(&args, 0, "a folder")?)?;
        match name.as_str() {
            "fs.readMany" => {
                let o = ReadOpts::of(at(&args, 2));
                let texts: Vec<Value> = at(&args, 1)
                    .as_array()
                    .into_iter()
                    .flatten()
                    .take(MANY_MAX)
                    .map(|rel| {
                        let rel = rel.as_str().unwrap_or("");
                        let f = resolve(&root, rel).ok()?;
                        read_text(&f, rel, o).ok()
                    })
                    .map(|t| t.map_or(Value::Null, Value::from))
                    .collect();
                Ok(json!(texts))
            }
            "fs.search" => search(&root, text(&args, 1, "what to look for")?, at(&args, 2)),
            _ => walk(&root, at(&args, 1)),
        }
    })
    .await
    .map_err(|e| bad(e.to_string()))?
}

/// Which files a walk takes: only `ext` when given, hidden names (`.git`, `.obsidian`) only with
/// `hidden`, links never, `max` at most (20 000 unless asked, 100 000 at most).
pub(crate) struct WalkOpts {
    exts: Vec<String>,
    hidden: bool,
    max: usize,
    sha: bool,
}

impl WalkOpts {
    pub(crate) fn of(o: &Value, default_max: usize, top: usize) -> WalkOpts {
        WalkOpts {
            exts: o["ext"]
                .as_array()
                .into_iter()
                .flatten()
                .filter_map(Value::as_str)
                .map(|e| e.trim_start_matches('.').to_lowercase())
                .collect(),
            hidden: o["hidden"] == true,
            max: o["max"]
                .as_u64()
                .filter(|m| *m > 0)
                .map_or(default_max, |m| (m as usize).min(top)),
            sha: o["sha"] == true,
        }
    }

    fn takes(&self, path: &Path) -> bool {
        let ext = path
            .extension()
            .map(|x| x.to_string_lossy().to_lowercase())
            .unwrap_or_default();
        self.exts.is_empty() || self.exts.contains(&ext)
    }
}

/// Visits the files under `start` (inside `base`) as `o` says, in path order, with their path
/// relative to `base` (`/`-separated) and their metadata, until `visit` says stop. A folder that
/// became a link since it was listed isn't read.
pub(crate) fn walk_files(
    base: &Path,
    start: &Path,
    o: &WalkOpts,
    mut visit: impl FnMut(&str, &Path, &std::fs::Metadata) -> bool,
) {
    let mut stack = vec![start.to_path_buf()];
    while let Some(dir) = stack.pop() {
        if !dunce::canonicalize(&dir).is_ok_and(|real| real.starts_with(base)) {
            continue;
        }
        let Ok(entries) = std::fs::read_dir(&dir) else {
            continue;
        };
        let mut entries: Vec<_> = entries.flatten().collect();
        entries.sort_by_key(|e| e.file_name());
        let mut dirs = Vec::new();
        for e in entries {
            let name = e.file_name().to_string_lossy().into_owned();
            let Ok(t) = e.file_type() else { continue };
            if t.is_symlink() || (!o.hidden && name.starts_with('.')) {
                continue;
            }
            let path = e.path();
            if t.is_dir() {
                dirs.push(path);
                continue;
            }
            if !t.is_file() || !o.takes(&path) {
                continue;
            }
            let Ok(meta) = e.metadata() else { continue };
            let rel = path.strip_prefix(base).unwrap_or(&path);
            if !visit(&rel.to_string_lossy().replace('\\', "/"), &path, &meta) {
                return;
            }
        }
        // Deeper folders after this one's files, each in name order.
        stack.extend(dirs.into_iter().rev());
    }
}

/// `[{path, size, mtime, sha?}]` of the files under `start`, relative to `base`.
pub(crate) fn file_rows(base: &Path, start: &Path, o: &WalkOpts) -> Vec<Value> {
    let mut out = Vec::new();
    walk_files(base, start, o, |rel, path, meta| {
        let mut row = json!({"path": rel, "size": meta.len(), "mtime": mtime_of(meta)});
        if o.sha {
            if let Some(sha) = sha_of(path, meta.len()) {
                row["sha"] = json!(sha);
            }
        }
        out.push(row);
        out.len() < o.max
    });
    out
}

/// The files under a granted root (or `path` in it): `[{path, size, mtime, sha?}]`.
fn walk(root: &Path, o: &Value) -> Result<Value, HostError> {
    let start = match o["path"].as_str().filter(|p| !p.is_empty()) {
        Some(rel) => resolve(root, rel)?,
        None => root.to_path_buf(),
    };
    Ok(json!(file_rows(
        root,
        &start,
        &WalkOpts::of(o, WALK_DEFAULT, WALK_MAX)
    )))
}

/// `fs.search(root, q, {path, ext, hidden, max, caseSensitive})`: the lines holding `q` as written
/// (case aside unless `caseSensitive`), `[{path, line, text}]`.
fn search(root: &Path, q: &str, o: &Value) -> Result<Value, HostError> {
    let n = q.chars().count();
    if n == 0 || n > 1000 {
        return Err(bad("ctx.fs.search looks for 1 to 1,000 characters"));
    }
    let start = match o["path"].as_str().filter(|p| !p.is_empty()) {
        Some(rel) => resolve(root, rel)?,
        None => root.to_path_buf(),
    };
    let exact = o["caseSensitive"] == true;
    let needle = if exact {
        q.to_string()
    } else {
        q.to_lowercase()
    };
    let walk = WalkOpts::of(
        &json!({"ext": o["ext"], "hidden": o["hidden"]}),
        WALK_MAX,
        WALK_MAX,
    );
    let max = o["max"]
        .as_u64()
        .filter(|m| *m > 0)
        .map_or(SEARCH_DEFAULT, |m| (m as usize).min(SEARCH_MAX));
    let mut hits = Vec::new();
    walk_files(root, &start, &walk, |rel, path, _| {
        let Ok(text) = read_text(
            path,
            rel,
            ReadOpts {
                max: SEARCH_READ,
                strict: false,
            },
        ) else {
            return true;
        };
        for (i, line) in text.split('\n').enumerate() {
            let line = line.strip_suffix('\r').unwrap_or(line);
            let found = if exact {
                line.contains(&needle)
            } else {
                line.to_lowercase().contains(&needle)
            };
            if found {
                let cut: String = line.chars().take(SEARCH_LINE).collect();
                hits.push(json!({"path": rel, "line": i + 1, "text": cut}));
                if hits.len() >= max {
                    return false;
                }
            }
        }
        true
    });
    Ok(json!(hits))
}

/// `fs.stat(root, path, {sha})`: `{kind, size, mtime, real, sha?}`, or null when nothing is there.
/// The path is looked at itself (a link is a `link`); `real` is where it leads inside the root,
/// or null (out of the folder, or nowhere).
fn stat(root: &Path, rel: &str, o: &Value) -> Result<Value, HostError> {
    let rel = rel.trim_end_matches('/');
    let path = match rel.rsplit_once('/') {
        _ if rel.trim_start_matches("./").is_empty() => root.to_path_buf(),
        Some((up, name)) => {
            super::store::relative(name, false)?;
            resolve(root, up)?.join(name)
        }
        None => {
            super::store::relative(rel, false)?;
            root.join(rel)
        }
    };
    let Ok(meta) = std::fs::symlink_metadata(&path) else {
        return Ok(Value::Null);
    };
    let t = meta.file_type();
    let kind = if t.is_symlink() {
        "link"
    } else if t.is_dir() {
        "dir"
    } else if t.is_file() {
        "file"
    } else {
        "other"
    };
    let real = dunce::canonicalize(&path)
        .ok()
        .and_then(|r| {
            r.strip_prefix(root)
                .ok()
                .map(|x| x.to_string_lossy().replace('\\', "/"))
        })
        .map_or(Value::Null, Value::from);
    let size = if kind == "file" { meta.len() } else { 0 };
    let mut out = json!({"kind": kind, "size": size, "mtime": mtime_of(&meta), "real": real});
    if kind == "file" && o["sha"] == true {
        if let Some(sha) = sha_of(&path, size) {
            out["sha"] = json!(sha);
        }
    }
    Ok(out)
}

/// `system.pickFolder(prompt)`: the user's choice is granted to the plugin.
pub async fn pick_folder(s: &Services, p: &Granted, args: &Value) -> Result<Value, HostError> {
    p.needs("folders", "read folders you pick")?;
    let prompt = at(args, 0).as_str().unwrap_or("Choose a folder");
    let title: String = format!("{} — {prompt}", p.name).chars().take(200).collect();
    match s.outside.picker.pick(title).await {
        Some(dir) => Ok(json!(grant(s, &p.id, &dir)?)),
        None => Ok(Value::Null),
    }
}

/// `system.which(name)`: where a program is installed, or `null`.
pub fn which(name: &str) -> Result<Value, HostError> {
    if name.is_empty()
        || name.len() > 64
        || !name
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'-' | b'_' | b'.'))
        || name.starts_with('.')
    {
        return Err(bad(format!("“{name}” isn't a program name")));
    }
    Ok(crate::ai::discover::find_program(name, &[])
        .map_or(Value::Null, |p| json!(p.display().to_string())))
}

#[cfg(test)]
mod tests {
    use super::super::testing::Env;
    use super::*;

    /// A plugin with a granted folder holding `notes/a.md`, `notes/b.txt` and `.git/config`.
    fn granted(env: &Env, uses: Value) -> String {
        env.plugin("vaults", uses, json!([]));
        let vault = env.dir.path().join("vault");
        std::fs::create_dir_all(vault.join("notes")).unwrap();
        std::fs::create_dir_all(vault.join(".git")).unwrap();
        std::fs::write(vault.join("notes/a.md"), "# A").unwrap();
        std::fs::write(vault.join("notes/b.txt"), "b").unwrap();
        std::fs::write(vault.join(".git/config"), "x").unwrap();
        *env.picker.0.lock().unwrap() = Some(vault);
        let rt = tokio::runtime::Runtime::new().unwrap();
        let root = rt
            .block_on(env.call_async("vaults", "system.pickFolder", json!(["A vault"])))
            .unwrap();
        root.as_str().unwrap().to_string()
    }

    #[test]
    fn fs_denies_outside_grant_and_symlink_escape() {
        let env = Env::new();
        let root = granted(&env, json!({"folders": {}}));
        let call = |name: &str, args: Value| env.call("vaults", name, args);
        assert_eq!(
            call("fs.folders", json!([])).unwrap(),
            json!([root.clone()])
        );
        assert_eq!(
            call("fs.read", json!([root, "notes/a.md"])).unwrap(),
            json!("# A")
        );
        assert_eq!(
            call("fs.read", json!([root, "notes/a.md", 1])).unwrap(),
            json!("#")
        );
        let mut names: Vec<String> = call("fs.list", json!([root, "notes"]))
            .unwrap()
            .as_array()
            .unwrap()
            .iter()
            .map(|e| e["name"].as_str().unwrap().to_string())
            .collect();
        names.sort();
        assert_eq!(names, ["a.md", "b.txt"]);

        // Another folder, a path out of the root, an absolute path: refused.
        let elsewhere = env.dir.path().join("elsewhere");
        std::fs::create_dir_all(&elsewhere).unwrap();
        std::fs::write(elsewhere.join("secret.txt"), "s").unwrap();
        let other = elsewhere.display().to_string();
        for (name, args) in [
            ("fs.read", json!([other, "secret.txt"])),
            ("fs.list", json!([other, ""])),
            ("fs.read", json!([root, "../elsewhere/secret.txt"])),
            ("fs.read", json!([root, "/etc/hosts"])),
            ("fs.read", json!([format!("{root}/notes"), "a.md"])),
        ] {
            let e = call(name, args.clone()).unwrap_err();
            assert_eq!(e.code, ErrorCode::Permission, "{name} {args}: {e}");
        }
        #[cfg(unix)]
        {
            // A link inside the root that leads out: not read, not listed, not walked.
            std::os::unix::fs::symlink(&elsewhere, Path::new(&root).join("notes/out")).unwrap();
            std::os::unix::fs::symlink(
                elsewhere.join("secret.txt"),
                Path::new(&root).join("notes/s.md"),
            )
            .unwrap();
            for rel in ["notes/out/secret.txt", "notes/s.md"] {
                let e = call("fs.read", json!([root, rel])).unwrap_err();
                assert_eq!(e.code, ErrorCode::Permission, "{rel}: {e}");
            }
            let listed = call("fs.list", json!([root, "notes"])).unwrap();
            assert_eq!(listed.as_array().unwrap().len(), 2, "{listed}");
            let rt = tokio::runtime::Runtime::new().unwrap();
            let walked = rt
                .block_on(env.call_async("vaults", "fs.walk", json!([root, {}])))
                .unwrap();
            let paths: Vec<&str> = walked
                .as_array()
                .unwrap()
                .iter()
                .map(|f| f["path"].as_str().unwrap())
                .collect();
            assert_eq!(paths.len(), 2, "{paths:?}");
            assert!(paths
                .iter()
                .all(|p| !p.contains("secret") && !p.starts_with(".git")));
            let md = rt
                .block_on(env.call_async("vaults", "fs.walk", json!([root, {"ext": ["md"]}])))
                .unwrap();
            assert_eq!(md.as_array().unwrap().len(), 1);
            let many = rt
                .block_on(env.call_async(
                    "vaults",
                    "fs.readMany",
                    json!([
                        root,
                        ["notes/a.md", "notes/s.md", "../elsewhere/secret.txt"]
                    ]),
                ))
                .unwrap();
            assert_eq!(many, json!(["# A", null, null]));
            // A granted root that is later swapped for a link is no longer the folder granted.
            let moved = env.dir.path().join("moved");
            std::fs::rename(&root, &moved).unwrap();
            std::os::unix::fs::symlink(&elsewhere, &root).unwrap();
            let e = call("fs.read", json!([root, "secret.txt"])).unwrap_err();
            assert_eq!(e.code, ErrorCode::Permission);
        }
        // Forgotten: no longer granted.
        call("fs.forget", json!([root])).unwrap();
        assert_eq!(call("fs.folders", json!([])).unwrap(), json!([]));
    }

    #[test]
    fn fs_write_requires_folders_write() {
        let env = Env::new();
        let root = granted(&env, json!({"folders": {}}));
        let call = |name: &str, args: Value| env.call("vaults", name, args);
        for (name, args) in [
            ("fs.write", json!([root, "notes/c.md", "c"])),
            ("fs.move", json!([root, "notes/a.md", "notes/z.md"])),
            ("fs.remove", json!([root, "notes/b.txt"])),
        ] {
            let e = call(name, args).unwrap_err();
            assert_eq!(e.code, ErrorCode::Permission, "{name}: {e}");
        }
        assert!(Path::new(&root).join("notes/b.txt").exists());

        // With folders.write: writes, moves and removes, but never hidden files, never over
        // another file, never the folder itself.
        let env = Env::new();
        let root = granted(&env, json!({"folders": {"write": true}}));
        let call = |name: &str, args: Value| env.call("vaults", name, args);
        call("fs.write", json!([root, "notes/new/c.md", "c"])).unwrap();
        assert_eq!(
            std::fs::read_to_string(Path::new(&root).join("notes/new/c.md")).unwrap(),
            "c"
        );
        let e = call("fs.move", json!([root, "notes/a.md", "notes/b.txt"])).unwrap_err();
        assert_eq!(e.code, ErrorCode::PluginError, "{e}");
        call("fs.move", json!([root, "notes/a.md", "notes/z.md"])).unwrap();
        call("fs.remove", json!([root, "notes/b.txt"])).unwrap();
        assert!(!Path::new(&root).join("notes/b.txt").exists());
        for (name, args) in [
            ("fs.write", json!([root, ".git/config", "x"])),
            ("fs.write", json!([root, "notes/.hidden", "x"])),
            ("fs.remove", json!([root, ".git"])),
            ("fs.remove", json!([root, ""])),
            ("fs.write", json!([root, "../outside.md", "x"])),
        ] {
            let e = call(name, args.clone()).unwrap_err();
            assert_eq!(e.code, ErrorCode::Permission, "{name} {args}: {e}");
        }
        assert_eq!(
            std::fs::read_to_string(Path::new(&root).join(".git/config")).unwrap(),
            "x"
        );
        assert!(!env.dir.path().join("outside.md").exists());
        #[cfg(unix)]
        {
            let elsewhere = env.dir.path().join("elsewhere");
            std::fs::create_dir_all(&elsewhere).unwrap();
            std::os::unix::fs::symlink(&elsewhere, Path::new(&root).join("out")).unwrap();
            let e = call("fs.write", json!([root, "out/x.md", "x"])).unwrap_err();
            assert_eq!(e.code, ErrorCode::Permission);
            assert!(!elsewhere.join("x.md").exists());
        }
    }

    #[test]
    fn write_if_sha_create_new_hidden_allowlist_and_append() {
        let env = Env::new();
        let root = granted(&env, json!({"folders": {"write": true}}));
        let r = Path::new(&root);
        let call = |name: &str, args: Value| env.call("vaults", name, args);
        let sha = |t: &str| super::super::cas::sha_hex(t.as_bytes());
        // Over the text read: the user's change in between wins, and the plugin hears Echo's words.
        call(
            "fs.write",
            json!([root, "notes/a.md", "# A2", {"ifSha": sha("# A")}]),
        )
        .unwrap();
        std::fs::write(r.join("notes/a.md"), "# A by the user").unwrap();
        let e = call(
            "fs.write",
            json!([root, "notes/a.md", "# A3", {"ifSha": sha("# A2")}]),
        )
        .unwrap_err();
        assert!(e.message.contains("changed since you read it"), "{e}");
        assert_eq!(
            std::fs::read_to_string(r.join("notes/a.md")).unwrap(),
            "# A by the user"
        );
        let e = call(
            "fs.write",
            json!([root, "notes/a.md", "x", {"createNew": true}]),
        )
        .unwrap_err();
        assert!(e.message.contains("is there already"), "{e}");
        call(
            "fs.write",
            json!([root, "notes/new.md", "x", {"ifSha": null}]),
        )
        .unwrap();
        // Hidden files: only Echo's few, a skill only when it runs nothing.
        for ok in [
            ".gitignore",
            ".obsidian/app.json",
            "kb/.obsidian/daily-notes.json",
        ] {
            call("fs.write", json!([root, ok, "{}"])).unwrap_or_else(|e| panic!("{ok}: {e}"));
        }
        call(
            "fs.write",
            json!([
                root,
                ".claude/skills/twin/SKILL.md",
                "---\nname: twin\ndescription: Me\n---\n# Twin\n"
            ]),
        )
        .unwrap();
        for no in [
            ".obsidian/community-plugins.json",
            ".obsidian/plugins/x/main.js",
            ".git/config",
            ".claude/settings.json",
            "notes/.draft.md",
        ] {
            let e = call("fs.write", json!([root, no, "x"])).unwrap_err();
            assert!(e.message.contains("hidden"), "{no}: {e}");
        }
        let e = call(
            "fs.write",
            json!([root, ".claude/skills/twin/SKILL.md", "Run !`ls`"]),
        )
        .unwrap_err();
        assert!(e.message.contains("can't run commands"), "{e}");
        // append: a line at the end, the file made when it isn't there; never a skill.
        call("fs.append", json!([root, "log.md", "one"])).unwrap();
        call("fs.append", json!([root, "log.md", "two\n"])).unwrap();
        assert_eq!(
            std::fs::read_to_string(r.join("log.md")).unwrap(),
            "one\ntwo\n"
        );
        assert!(call(
            "fs.append",
            json!([root, ".claude/skills/twin/SKILL.md", "x"])
        )
        .is_err());
        assert!(call(
            "fs.move",
            json!([root, "notes/new.md", ".claude/skills/twin/new.md"])
        )
        .is_err());
        #[cfg(unix)]
        {
            std::os::unix::fs::symlink("/etc/hosts", r.join("hosts.md")).unwrap();
            assert!(call("fs.append", json!([root, "hosts.md", "x"])).is_err());
        }
        // A hidden folder (or one inside it) is never given.
        let hidden = env.dir.path().join(".config/notes");
        std::fs::create_dir_all(&hidden).unwrap();
        env.picker.next(&hidden);
        let rt = tokio::runtime::Runtime::new().unwrap();
        let e = rt
            .block_on(env.call_async("vaults", "system.pickFolder", json!(["x"])))
            .unwrap_err();
        assert!(
            e.message
                .contains("is a hidden folder or inside one (“.config”)"),
            "{e}"
        );
    }

    #[test]
    fn stat_strict_reads_walk_shas_and_search() {
        let env = Env::new();
        let root = granted(&env, json!({"folders": {}}));
        let r = Path::new(&root);
        std::fs::write(r.join("notes/latin.md"), b"caf\xe9\n").unwrap();
        // "é" is two bytes: a cut after its first byte is dropped, not refused.
        std::fs::write(r.join("notes/cafe.md"), "café").unwrap();
        std::fs::write(
            r.join("notes/atlas.md"),
            "# Atlas\nOwner: Ann\r\nthe ATLAS beta\n",
        )
        .unwrap();
        let call = |name: &str, args: Value| env.call("vaults", name, args);

        // stat: a file (with its sha), a folder, nothing, the root itself.
        let st = call("fs.stat", json!([root, "notes/a.md", {"sha": true}])).unwrap();
        assert_eq!(st["kind"], "file");
        assert_eq!(st["size"], 3);
        assert_eq!(st["real"], "notes/a.md");
        assert_eq!(st["sha"], super::super::cas::sha_hex(b"# A"));
        assert!(st["mtime"].as_u64().unwrap() > 1_700_000_000);
        assert_eq!(
            call("fs.stat", json!([root, "notes/"])).unwrap()["kind"],
            "dir"
        );
        assert_eq!(
            call("fs.stat", json!([root, "notes/none.md"])).unwrap(),
            Value::Null
        );
        assert_eq!(call("fs.stat", json!([root, ""])).unwrap()["kind"], "dir");
        assert!(call("fs.stat", json!([root, "../x"])).is_err());
        #[cfg(unix)]
        {
            std::os::unix::fs::symlink(r.join("notes/a.md"), r.join("notes/alias.md")).unwrap();
            let link = call("fs.stat", json!([root, "notes/alias.md"])).unwrap();
            assert_eq!(link["kind"], "link");
            assert_eq!(link["real"], "notes/a.md");
            std::os::unix::fs::symlink("/etc/hosts", r.join("notes/out.md")).unwrap();
            let out = call("fs.stat", json!([root, "notes/out.md"])).unwrap();
            assert_eq!(out["kind"], "link");
            assert_eq!(
                out["real"],
                Value::Null,
                "a link out of the folder has no real path in it"
            );
        }

        // Reads: lossy by default, strict refuses bytes that aren't UTF-8.
        assert_eq!(
            call("fs.read", json!([root, "notes/latin.md"])).unwrap(),
            json!("caf\u{FFFD}\n")
        );
        let e = call("fs.read", json!([root, "notes/latin.md", {"strict": true}])).unwrap_err();
        assert_eq!(e.message, "not UTF-8: notes/latin.md");
        assert_eq!(
            call(
                "fs.read",
                json!([root, "notes/cafe.md", {"max": 4, "strict": true}])
            )
            .unwrap(),
            json!("caf")
        );
        assert_eq!(
            call("fs.read", json!([root, "notes/a.md", {"max": 1}])).unwrap(),
            json!("#")
        );

        let rt = tokio::runtime::Runtime::new().unwrap();
        let run = |name: &str, args: Value| rt.block_on(env.call_async("vaults", name, args));
        let many = run(
            "fs.readMany",
            json!([root, ["notes/latin.md", "notes/a.md"], {"strict": true}]),
        )
        .unwrap();
        assert_eq!(many, json!([null, "# A"]));
        // walk {sha}: each file's sha256; `path` narrows it.
        let walked = run(
            "fs.walk",
            json!([root, {"path": "notes", "ext": ["md"], "sha": true}]),
        )
        .unwrap();
        let a = walked
            .as_array()
            .unwrap()
            .iter()
            .find(|f| f["path"] == "notes/a.md")
            .unwrap();
        assert_eq!(a["sha"], super::super::cas::sha_hex(b"# A"));
        // search: literal, case-insensitive unless asked, line numbers, `max`, `ext`.
        let hits = run("fs.search", json!([root, "atlas", {}])).unwrap();
        assert_eq!(
            hits,
            json!([
                {"path": "notes/atlas.md", "line": 1, "text": "# Atlas"},
                {"path": "notes/atlas.md", "line": 3, "text": "the ATLAS beta"}
            ])
        );
        let exact = run("fs.search", json!([root, "ATLAS", {"caseSensitive": true}])).unwrap();
        assert_eq!(exact.as_array().unwrap().len(), 1);
        assert_eq!(
            run("fs.search", json!([root, "atlas", {"max": 1}]))
                .unwrap()
                .as_array()
                .unwrap()
                .len(),
            1
        );
        assert_eq!(
            run("fs.search", json!([root, "atlas", {"ext": ["txt"]}])).unwrap(),
            json!([])
        );
        assert_eq!(
            run("fs.search", json!([root, "Ann", {}])).unwrap()[0]["text"],
            "Owner: Ann"
        );
        let e = run("fs.search", json!([root, "", {}])).unwrap_err();
        assert_eq!(e.message, "ctx.fs.search looks for 1 to 1,000 characters");
        // A long line is cut at 300 characters.
        std::fs::write(
            r.join("notes/long.md"),
            format!("{}needle", "x".repeat(400)),
        )
        .unwrap();
        let long = run("fs.search", json!([root, "needle", {}])).unwrap();
        assert_eq!(long[0]["text"].as_str().unwrap().chars().count(), 300);
    }

    #[test]
    fn folders_need_the_grant_and_the_picker_adds_one() {
        let env = Env::new();
        env.plugin("plain", json!({}), json!([]));
        let e = env.call("plain", "fs.folders", json!([])).unwrap_err();
        assert_eq!(e.code, ErrorCode::Permission);
        let rt = tokio::runtime::Runtime::new().unwrap();
        let e = rt
            .block_on(env.call_async("plain", "system.pickFolder", json!(["x"])))
            .unwrap_err();
        assert_eq!(e.code, ErrorCode::Permission);
        // Cancelled: nothing granted.
        let root = granted(&env, json!({"folders": {}}));
        let cancelled = rt
            .block_on(env.call_async("vaults", "system.pickFolder", json!(["again"])))
            .unwrap();
        assert_eq!(cancelled, Value::Null);
        assert_eq!(
            env.call("vaults", "fs.folders", json!([])).unwrap(),
            json!([root])
        );
        // which: a program name only.
        // Found where installed (a path), else null; never an error for a plain name.
        let sh = which("sh").unwrap();
        assert!(
            sh.is_null() || sh.as_str().is_some_and(|p| p.ends_with("/sh")),
            "{sh}"
        );
        for bad in ["", "../sh", "a b", "/bin/sh", ".hidden"] {
            assert!(which(bad).is_err(), "{bad}");
        }
    }
}
