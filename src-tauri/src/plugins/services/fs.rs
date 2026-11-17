//! `ctx.fs` and `ctx.system`: the folders the user picked for the plugin (`uses.folders`), read
//! as `(root, relative path)`. A root is one the user granted (`system.pickFolder`), kept in
//! `<data>/plugins/data/<id>/folders.json` by its real path. Every path is checked again on each
//! call: relative, plain names, never through a link, and its real path inside the root.
//! Changing files needs `folders.write`, never touches a hidden file or folder (`.git`), replaces
//! a file atomically, and a move never replaces another file (PLUGIN-ENGINE.md §8).
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

fn grants_file(s: &Services, id: &str) -> PathBuf {
    s.data_of(id).join("folders.json")
}

/// The roots granted to the plugin, as the plugin sees them.
pub fn roots(s: &Services, id: &str) -> Vec<String> {
    read_json(&grants_file(s, id), json!([]))
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
    let mut all = roots(s, id);
    if !all.contains(&root) {
        all.push(root.clone());
        write_json(&grants_file(s, id), &json!(all))?;
    }
    Ok(root)
}

/// A granted root, still the folder it was granted as.
fn root_of(s: &Services, p: &Granted, root: &str) -> Result<PathBuf, HostError> {
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
fn resolve(root: &Path, rel: &str) -> Result<PathBuf, HostError> {
    let path = inside(root, rel, true)?;
    if let Ok(real) = dunce::canonicalize(&path) {
        if !real.starts_with(root) {
            return Err(permission(format!("“{rel}” leads out of the folder")));
        }
    }
    Ok(path)
}

/// `rel` for a change: needs `folders.write`, and no part of it may be hidden.
fn writable(s: &Services, p: &Granted, root: &str, rel: &str) -> Result<PathBuf, HostError> {
    let root = root_of(s, p, root)?;
    if !p.flag("folders", "write") {
        return Err(permission(format!(
            "{} may only read the folders you gave it (uses.folders.write)",
            p.id
        )));
    }
    s.writable()?;
    if rel.trim_start_matches("./").is_empty()
        || rel
            .split('/')
            .any(|part| part.starts_with('.') && part != ".")
    {
        return Err(permission(format!(
            "“{rel}”: a plugin doesn't change the folder itself or hidden files"
        )));
    }
    resolve(&root, rel)
}

fn read_upto(path: &Path, max: u64) -> std::io::Result<String> {
    let mut buf = Vec::new();
    std::fs::File::open(path)?.take(max).read_to_end(&mut buf)?;
    Ok(String::from_utf8_lossy(&buf).into_owned())
}

fn max_of(v: &Value) -> u64 {
    v.as_u64()
        .filter(|m| *m > 0)
        .unwrap_or(READ_DEFAULT)
        .min(READ_MAX)
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
            read_upto(&f, max_of(at(args, 2)))
                .map(Value::from)
                .map_err(|e| io_failed(&format!("read “{}”", rel(1)), &e))
        }
        "fs.write" => {
            let f = writable(s, p, root()?, rel(1))?;
            let content = text(args, 2, "the file's text")?;
            if f.is_dir() {
                return Err(bad(format!("“{}” is a folder", rel(1))));
            }
            if let Some(parent) = f.parent() {
                std::fs::create_dir_all(parent).map_err(|e| io_failed("make its folder", &e))?;
            }
            // The folders just made are checked again: none may have become a link.
            let f = writable(s, p, root()?, rel(1))?;
            crate::storage::location::write_atomic(&f, content.as_bytes())
                .map_err(|e| io_failed(&format!("write “{}”", rel(1)), &e))?;
            Ok(Value::Null)
        }
        "fs.move" => {
            let from = writable(s, p, root()?, rel(1))?;
            let to = writable(s, p, root()?, rel(2))?;
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

/// `fs.readMany` and `fs.walk`: bulk reads, off the plugin's thread.
pub async fn call_async(
    s: Arc<Services>,
    p: Arc<Granted>,
    name: &str,
    args: Value,
) -> Result<Value, HostError> {
    let name = name.to_string();
    tauri::async_runtime::spawn_blocking(move || {
        let root = root_of(&s, &p, text(&args, 0, "a folder")?)?;
        if name == "fs.readMany" {
            let max = max_of(at(&args, 2));
            let texts: Vec<Value> = at(&args, 1)
                .as_array()
                .into_iter()
                .flatten()
                .take(MANY_MAX)
                .map(|rel| {
                    let f = resolve(&root, rel.as_str().unwrap_or("")).ok()?;
                    read_upto(&f, max).ok()
                })
                .map(|t| t.map_or(Value::Null, Value::from))
                .collect();
            return Ok(json!(texts));
        }
        walk(&root, at(&args, 1))
    })
    .await
    .map_err(|e| bad(e.to_string()))?
}

/// The files under a granted root (or `path` in it): `[{path, size, mtime}]`, links and (unless
/// `hidden`) hidden names left out, only `ext` when given, `max` at most.
fn walk(root: &Path, o: &Value) -> Result<Value, HostError> {
    let base = match o["path"].as_str().filter(|p| !p.is_empty()) {
        Some(rel) => resolve(root, rel)?,
        None => root.to_path_buf(),
    };
    let hidden = o["hidden"] == true;
    let max = o["max"]
        .as_u64()
        .filter(|m| *m > 0)
        .map_or(WALK_DEFAULT, |m| (m as usize).min(WALK_MAX));
    let exts: Vec<String> = o["ext"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(Value::as_str)
        .map(|e| e.trim_start_matches('.').to_lowercase())
        .collect();
    let mut out = Vec::new();
    let mut stack = vec![base];
    while let Some(dir) = stack.pop() {
        // A folder swapped for a link since it was listed isn't read.
        if !dunce::canonicalize(&dir).is_ok_and(|real| real.starts_with(root)) {
            continue;
        }
        let Ok(entries) = std::fs::read_dir(&dir) else {
            continue;
        };
        for e in entries.flatten() {
            let name = e.file_name().to_string_lossy().into_owned();
            let Ok(t) = e.file_type() else { continue };
            if t.is_symlink() || (!hidden && name.starts_with('.')) {
                continue;
            }
            let path = e.path();
            if t.is_dir() {
                stack.push(path);
                continue;
            }
            let ext = path
                .extension()
                .map(|x| x.to_string_lossy().to_lowercase())
                .unwrap_or_default();
            if !exts.is_empty() && !exts.contains(&ext) {
                continue;
            }
            let meta = e.metadata().ok();
            let mtime = meta
                .as_ref()
                .and_then(|m| m.modified().ok())
                .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                .map_or(0, |d| d.as_secs());
            let rel = path.strip_prefix(root).unwrap_or(&path);
            out.push(json!({
                "path": rel.to_string_lossy().replace('\\', "/"),
                "size": meta.map_or(0, |m| m.len()),
                "mtime": mtime,
            }));
            if out.len() >= max {
                return Ok(json!(out));
            }
        }
    }
    Ok(json!(out))
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
