//! Guarded writes for `store.write` and `fs.write` (Echo 0.10's `{ifSha, createNew}`): a write over
//! the text a plugin read (`ifSha`, the sha256 of the bytes it read, in hex), or only where nothing
//! is (`createNew`, or `ifSha: null`). The refusals use Echo's words, which plugins match:
//! `“p” changed since you read it: read it again` and `“p” is there already`.
use super::{bad, io_failed};
use crate::plugins::host::HostError;
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::io::Write as _;
use std::path::Path;

/// The sha256 of `bytes`, lowercase hex.
pub fn sha_hex(bytes: &[u8]) -> String {
    Sha256::digest(bytes)
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect()
}

/// How a write may replace what is there.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub enum Guard {
    /// Whatever is there (Echo's plain write).
    #[default]
    Any,
    /// Only over a file whose bytes have this sha256 (lowercase hex).
    IfSha(String),
    /// Only where nothing is.
    CreateNew,
}

/// The guard a write's options ask for: `{ifSha: "<hex>"}`, `{ifSha: null}` or `{createNew: true}`.
pub fn guard_of(opts: &Value) -> Result<Guard, HostError> {
    let create_new = opts.get("createNew") == Some(&Value::Bool(true));
    match opts.get("ifSha") {
        None => Ok(if create_new {
            Guard::CreateNew
        } else {
            Guard::Any
        }),
        Some(Value::Null) => Ok(Guard::CreateNew),
        Some(Value::String(sha)) => {
            if create_new {
                return Err(bad("ifSha and createNew: one or the other"));
            }
            if sha.len() != 64 || !sha.bytes().all(|b| b.is_ascii_hexdigit()) {
                return Err(bad(
                    "ifSha is a sha256 in hex (64 characters), or null for a file that isn't there yet",
                ));
            }
            Ok(Guard::IfSha(sha.to_ascii_lowercase()))
        }
        Some(_) => Err(bad(
            "ifSha is a sha256 in hex (64 characters), or null for a file that isn't there yet",
        )),
    }
}

/// Writes `bytes` to `path` (named `rel` to the plugin) as `guard` allows, atomically. The caller
/// holds the lock that orders this plugin's guarded writes.
pub fn write(path: &Path, rel: &str, bytes: &[u8], guard: &Guard) -> Result<(), HostError> {
    let failed = |e: std::io::Error| io_failed(&format!("write “{rel}”"), &e);
    match guard {
        Guard::Any => crate::storage::location::write_atomic(path, bytes).map_err(failed),
        Guard::IfSha(want) => {
            let now = std::fs::read(path).ok().map(|b| sha_hex(&b));
            if now.as_deref() != Some(want.as_str()) {
                return Err(bad(format!(
                    "“{rel}” changed since you read it: read it again"
                )));
            }
            crate::storage::location::write_atomic(path, bytes).map_err(failed)
        }
        Guard::CreateNew => create_new(path, rel, bytes),
    }
}

/// A new file, whole or not at all: written beside it, then linked in place, which fails when
/// something is there already (even something made a moment ago by another program).
fn create_new(path: &Path, rel: &str, bytes: &[u8]) -> Result<(), HostError> {
    let there = || bad(format!("“{rel}” is there already"));
    if std::fs::symlink_metadata(path).is_ok() {
        return Err(there());
    }
    let dir = path.parent().unwrap_or(Path::new("."));
    let tmp = dir.join(format!(".connect-{}.tmp", uuid::Uuid::new_v4()));
    let made = (|| {
        let mut f = std::fs::File::create(&tmp)?;
        f.write_all(bytes)?;
        f.sync_all()?;
        std::fs::hard_link(&tmp, path)
    })();
    let _ = std::fs::remove_file(&tmp);
    match made {
        Ok(()) => Ok(()),
        Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => Err(there()),
        Err(e) => Err(io_failed(&format!("write “{rel}”"), &e)),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn guards_read_from_options() {
        assert_eq!(guard_of(&json!({})).unwrap(), Guard::Any);
        assert_eq!(guard_of(&Value::Null).unwrap(), Guard::Any);
        assert_eq!(
            guard_of(&json!({"createNew": true})).unwrap(),
            Guard::CreateNew
        );
        assert_eq!(guard_of(&json!({"ifSha": null})).unwrap(), Guard::CreateNew);
        let sha = "A".repeat(64);
        assert_eq!(
            guard_of(&json!({ "ifSha": sha })).unwrap(),
            Guard::IfSha("a".repeat(64))
        );
        for bad in [
            json!({"ifSha": "abc"}),
            json!({"ifSha": 3}),
            json!({"ifSha": "a".repeat(64), "createNew": true}),
        ] {
            assert!(guard_of(&bad).is_err(), "{bad}");
        }
    }

    #[test]
    fn writes_compare_and_create_with_echos_words() {
        let dir = tempfile::tempdir().unwrap();
        let f = dir.path().join("a.md");
        write(&f, "a.md", b"one", &Guard::CreateNew).unwrap();
        let e = write(&f, "a.md", b"two", &Guard::CreateNew).unwrap_err();
        assert_eq!(e.message, "“a.md” is there already");
        let stale = Guard::IfSha(sha_hex(b"zero"));
        let e = write(&f, "a.md", b"two", &stale).unwrap_err();
        assert_eq!(e.message, "“a.md” changed since you read it: read it again");
        assert_eq!(std::fs::read_to_string(&f).unwrap(), "one");
        write(&f, "a.md", b"two", &Guard::IfSha(sha_hex(b"one"))).unwrap();
        assert_eq!(std::fs::read_to_string(&f).unwrap(), "two");
        // A file that isn't there has no sha to match.
        let gone = dir.path().join("gone.md");
        let e = write(&gone, "gone.md", b"x", &Guard::IfSha(sha_hex(b""))).unwrap_err();
        assert!(e.message.contains("changed since you read it"));
        // Nothing is left beside the file.
        let names: Vec<_> = std::fs::read_dir(dir.path())
            .unwrap()
            .map(|e| e.unwrap().file_name())
            .collect();
        assert_eq!(names, ["a.md"]);
        assert_eq!(
            sha_hex(b"abc"),
            "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
        );
    }
}
