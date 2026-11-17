//! `ctx.store` (the plugin's own folder, `<data>/plugins/data/<id>/store/`) and `ctx.package` (its
//! installed files, read only). Paths are relative, of plain names (no `..`, no root), and never
//! pass through a link (PLUGIN-ENGINE.md §8). Connect's own files about the plugin live beside the
//! store, not in it, so nothing here can touch them.
use super::{at, bad, io_failed, permission, text, Granted, Services};
use crate::plugins::host::{ErrorCode, HostError};
use serde_json::{json, Value};
use std::path::{Component, Path, PathBuf};

/// The plugin's store folder.
pub fn root(s: &Services, id: &str) -> PathBuf {
    s.data_of(id).join("store")
}

pub fn call(s: &Services, p: &Granted, name: &str, args: &Value) -> Result<Value, HostError> {
    let store = root(s, &p.id);
    match name {
        "store.read" => {
            let path = inside(&store, text(args, 0, "a path")?, false)?;
            read_text(&path)
        }
        "store.write" => {
            s.writable()?;
            let rel = text(args, 0, "a path")?;
            let content = at(args, 1)
                .as_str()
                .ok_or_else(|| bad("ctx.store.write takes text: JSON.stringify an object first"))?;
            plain_top(rel)?;
            let path = inside(&store, rel, false)?;
            if path.is_dir() {
                return Err(bad(format!("“{rel}” is a folder")));
            }
            ensure_dirs(&store, &path)?;
            crate::storage::location::write_atomic(&path, content.as_bytes())
                .map_err(|e| io_failed(&format!("write “{rel}”"), &e))?;
            Ok(Value::Null)
        }
        "store.list" => {
            let dir = inside(&store, at(args, 0).as_str().unwrap_or(""), true)?;
            Ok(json!(names(&dir)))
        }
        "store.remove" => {
            s.writable()?;
            let rel = text(args, 0, "a path")?;
            let path = inside(&store, rel, false)?;
            let removed = match std::fs::symlink_metadata(&path) {
                Ok(m) if m.is_dir() => std::fs::remove_dir_all(&path),
                Ok(_) => std::fs::remove_file(&path),
                Err(_) => Ok(()),
            };
            removed.map_err(|e| io_failed(&format!("remove “{rel}”"), &e))?;
            Ok(Value::Null)
        }
        "store.path" => {
            let path = inside(&store, at(args, 0).as_str().unwrap_or(""), true)?;
            ensure_dirs(&store, &store.join("_"))?;
            Ok(json!(path.display().to_string()))
        }
        "package.read" => match inside_package(p, text(args, 0, "a path")?)? {
            Some(f) if f.is_file() => read_text(&f),
            _ => Ok(Value::Null),
        },
        "package.list" => {
            let sub = at(args, 0).as_str().unwrap_or("");
            match inside_package(p, sub)? {
                Some(d) => Ok(json!(names(&d))),
                None => Ok(json!([])),
            }
        }
        _ => Err(super::unsupported(name)),
    }
}

/// The components of a relative path of plain names: no root, no `.`/`..`, no NUL or
/// backslash. `""` is the folder itself when `allow_root`.
pub fn relative(rel: &str, allow_root: bool) -> Result<Vec<String>, HostError> {
    let rel = rel.trim_start_matches("./");
    if rel.is_empty() {
        return if allow_root {
            Ok(Vec::new())
        } else {
            Err(bad(
                "this needs a path inside the folder, not the folder itself",
            ))
        };
    }
    let refused = || permission(format!("“{rel}” isn't a relative path of plain names"));
    if rel.len() > 4096 || rel.contains(['\0', '\\']) || Path::new(rel).is_absolute() {
        return Err(refused());
    }
    let mut parts = Vec::new();
    for c in Path::new(rel).components() {
        match c {
            Component::Normal(name) => parts.push(name.to_string_lossy().into_owned()),
            _ => return Err(refused()),
        }
    }
    if parts.is_empty() && !allow_root {
        return Err(refused());
    }
    Ok(parts)
}

/// `rel` under `base`, refused when any part of the way is a link (or `base` itself is one).
pub fn inside(base: &Path, rel: &str, allow_root: bool) -> Result<PathBuf, HostError> {
    let parts = relative(rel, allow_root)?;
    let linked = |p: &Path| std::fs::symlink_metadata(p).is_ok_and(|m| m.file_type().is_symlink());
    if linked(base) {
        return Err(permission("the plugin's folder is a link"));
    }
    let mut path = base.to_path_buf();
    for part in parts {
        path.push(part);
        if linked(&path) {
            return Err(permission(format!("“{rel}” passes through a link")));
        }
    }
    Ok(path)
}

/// A name at the store's top level is plain ASCII (Echo's rule), so the plugin's folder stays
/// readable on every disk.
fn plain_top(rel: &str) -> Result<(), HostError> {
    let top = rel.trim_start_matches("./").split('/').next().unwrap_or("");
    if top.is_empty()
        || !top
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'-' | b'_' | b'.'))
    {
        return Err(bad(format!(
            "“{top}”: a name at the store's top level is letters, digits, - _ and . only"
        )));
    }
    Ok(())
}

/// Creates the folders down to `path`'s parent, checking that none of them became a link.
fn ensure_dirs(base: &Path, path: &Path) -> Result<(), HostError> {
    let parent = path.parent().unwrap_or(base);
    std::fs::create_dir_all(parent).map_err(|e| io_failed("make its folder", &e))?;
    let rel = parent.strip_prefix(base).unwrap_or(Path::new(""));
    inside(base, &rel.to_string_lossy(), true).map(|_| ())
}

/// A file's text (`null` when it isn't there).
fn read_text(path: &Path) -> Result<Value, HostError> {
    match std::fs::read(path) {
        Ok(bytes) => Ok(json!(String::from_utf8_lossy(&bytes))),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(Value::Null),
        Err(e) if path.is_dir() => Err(bad(format!(
            "“{}” is a folder ({e})",
            path.file_name().unwrap_or_default().to_string_lossy()
        ))),
        Err(e) => Err(io_failed("read it", &e)),
    }
}

/// The sorted names in a folder (none when it isn't there).
fn names(dir: &Path) -> Vec<String> {
    let mut names: Vec<String> = std::fs::read_dir(dir)
        .map(|rd| {
            rd.flatten()
                .map(|e| e.file_name().to_string_lossy().into_owned())
                .collect()
        })
        .unwrap_or_default();
    names.sort();
    names
}

/// A file or folder of the plugin's own package, checked by its real path too (an installed
/// package holds no links, but it is checked again here).
fn inside_package(p: &Granted, rel: &str) -> Result<Option<PathBuf>, HostError> {
    let path = inside(&p.dir, rel, true)?;
    let (Ok(base), Ok(real)) = (dunce::canonicalize(&p.dir), dunce::canonicalize(&path)) else {
        return Ok(None);
    };
    if !real.starts_with(&base) {
        return Err(HostError::new(
            ErrorCode::Permission,
            format!("“{rel}” isn't in the plugin's package"),
        ));
    }
    Ok(Some(real))
}

#[cfg(test)]
mod tests {
    use super::super::testing::Env;
    use crate::plugins::host::ErrorCode;
    use serde_json::{json, Value};

    #[test]
    fn store_reads_writes_lists_and_removes_inside_its_own_folder() {
        let env = Env::new();
        env.plugin("alpha", json!({}), json!([]));
        env.plugin("beta", json!({}), json!([]));
        let call = |id: &str, name: &str, args: Value| env.call(id, name, args);
        assert_eq!(
            call("alpha", "store.read", json!(["state.json"])).unwrap(),
            Value::Null
        );
        call(
            "alpha",
            "store.write",
            json!(["runs/a/result.json", "{\"ok\":true}"]),
        )
        .unwrap();
        call("alpha", "store.write", json!(["runs/b.txt", "b"])).unwrap();
        assert_eq!(
            call("alpha", "store.read", json!(["runs/a/result.json"])).unwrap(),
            json!("{\"ok\":true}")
        );
        assert_eq!(
            call("alpha", "store.list", json!(["runs"])).unwrap(),
            json!(["a", "b.txt"])
        );
        assert_eq!(
            call("alpha", "store.list", json!(["nothing"])).unwrap(),
            json!([])
        );
        // Each plugin has its own store: beta sees nothing of alpha's.
        assert_eq!(
            call("beta", "store.read", json!(["runs/b.txt"])).unwrap(),
            Value::Null
        );
        let path = call("alpha", "store.path", json!(["vault"])).unwrap();
        let root = env.services.data_of("alpha").join("store");
        assert_eq!(path, json!(root.join("vault").display().to_string()));
        assert!(root.is_dir());
        call("alpha", "store.remove", json!(["runs"])).unwrap();
        call("alpha", "store.remove", json!(["gone"])).unwrap();
        assert_eq!(call("alpha", "store.list", json!([""])).unwrap(), json!([]));
        // Not the store itself, not outside it, not through a link, not a non-text write.
        for (name, args) in [
            ("store.remove", json!([""])),
            ("store.read", json!(["../settings.json"])),
            ("store.write", json!(["/etc/x", "x"])),
            ("store.write", json!(["a/../../x", "x"])),
            ("store.list", json!([".."])),
        ] {
            let e = call("alpha", name, args.clone()).unwrap_err();
            assert!(
                matches!(e.code, ErrorCode::Permission | ErrorCode::PluginError),
                "{name} {args}: {e}"
            );
        }
        assert!(call("alpha", "store.write", json!(["x.json", {"a": 1}])).is_err());
        assert!(call("alpha", "store.write", json!(["ünï/x", "x"])).is_err());
        #[cfg(unix)]
        {
            let outside = env.dir.path().join("outside");
            std::fs::create_dir_all(&outside).unwrap();
            std::fs::write(outside.join("secret"), "s").unwrap();
            std::os::unix::fs::symlink(&outside, root.join("link")).unwrap();
            for (name, args) in [
                ("store.read", json!(["link/secret"])),
                ("store.write", json!(["link/new", "x"])),
                ("store.list", json!(["link"])),
            ] {
                let e = call("alpha", name, args).unwrap_err();
                assert_eq!(e.code, ErrorCode::Permission, "{name}: {e}");
            }
            assert!(!outside.join("new").exists());
        }
    }

    #[test]
    fn package_reads_only_its_own_files() {
        let env = Env::new();
        env.plugin_with(
            "alpha",
            json!({}),
            json!([]),
            json!([]),
            &[
                ("templates/a.md", "# A"),
                ("templates/b.md", "# B"),
                ("main.js", ""),
            ],
        );
        env.plugin_with(
            "beta",
            json!({}),
            json!([]),
            json!([]),
            &[("secret.md", "x")],
        );
        assert_eq!(
            env.call("alpha", "package.list", json!(["templates"]))
                .unwrap(),
            json!(["a.md", "b.md"])
        );
        assert_eq!(
            env.call("alpha", "package.read", json!(["templates/a.md"]))
                .unwrap(),
            json!("# A")
        );
        assert_eq!(
            env.call("alpha", "package.read", json!(["none.md"]))
                .unwrap(),
            Value::Null
        );
        let e = env
            .call(
                "alpha",
                "package.read",
                json!(["../../beta/1.0.0/secret.md"]),
            )
            .unwrap_err();
        assert_eq!(e.code, ErrorCode::Permission);
    }
}
