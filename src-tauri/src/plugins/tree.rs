//! Plugin and marketplace trees (DESIGN 7.1): walked without following links, checked against
//! limits, hashed and copied.
//!
//! A tree holds plain files and folders only: no symlinks, hard links, devices or FIFOs, and no
//! names with control characters. Every file is opened again by name after the walk, so each
//! open checks that it is still the file the walk saw (same device and inode, one link): a file
//! swapped or linked in between is refused as changed, never read.
use sha2::{Digest, Sha256};
use std::fs::{self, File, OpenOptions};
use std::io::{self, Read, Write};
use std::path::{Path, PathBuf};

const MB: u64 = 1024 * 1024;

/// How much a tree may hold.
#[derive(Debug, Clone, Copy)]
pub struct Limits {
    pub files: usize,
    pub bytes: u64,
    pub folders: usize,
    pub depth: usize,
}

/// A plugin: at most 400 files and 20 MB.
pub const PLUGIN: Limits = Limits {
    files: 400,
    bytes: 20 * MB,
    folders: 400,
    depth: 16,
};

/// A fetched marketplace: at most 5000 files and 64 MB.
pub const MARKET: Limits = Limits {
    files: 5000,
    bytes: 64 * MB,
    folders: 5000,
    depth: 32,
};

#[derive(Debug, Clone, PartialEq, thiserror::Error)]
pub enum TreeError {
    #[error("it has more than {0} files")]
    TooManyFiles(usize),
    #[error("it has more than {0} folders, or they are nested too deeply")]
    TooManyFolders(usize),
    #[error("it is larger than {0} MB")]
    TooLarge(u64),
    #[error("it holds a link or a special file ({0})")]
    NotPlain(String),
    #[error("a name in it has characters Connect can’t use ({0})")]
    BadName(String),
    #[error("its files couldn’t be read ({0})")]
    Unreadable(String),
    /// A file is no longer the one the walk saw.
    #[error("its files changed while Connect was reading them ({0})")]
    Changed(String),
}

/// What a walk counted.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct TreeStats {
    pub files: usize,
    pub folders: usize,
    pub bytes: u64,
}

/// Which file on which disk: what a later open must find again.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct FileId {
    dev: u64,
    ino: u64,
}

fn file_id(meta: &fs::Metadata) -> FileId {
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        FileId {
            dev: meta.dev(),
            ino: meta.ino(),
        }
    }
    #[cfg(not(unix))]
    {
        let _ = meta;
        FileId { dev: 0, ino: 0 }
    }
}

fn links(meta: &fs::Metadata) -> u64 {
    #[cfg(unix)]
    {
        std::os::unix::fs::MetadataExt::nlink(meta)
    }
    #[cfg(not(unix))]
    {
        let _ = meta;
        1
    }
}

struct Entry {
    /// Relative path with `/` separators.
    rel: String,
    path: PathBuf,
    /// `None` for a folder.
    file: Option<FileId>,
}

/// Opens a file for reading without following a link, and refuses anything but a regular file
/// (a FIFO is opened non-blocking, so swapping one in can't hang the read).
pub(crate) fn open_plain(path: &Path) -> io::Result<File> {
    let mut options = OpenOptions::new();
    options.read(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK);
    }
    #[cfg(not(unix))]
    if fs::symlink_metadata(path)?.file_type().is_symlink() {
        return Err(io::Error::other("a link"));
    }
    let file = options.open(path)?;
    if file.metadata()?.is_file() {
        Ok(file)
    } else {
        Err(io::Error::other("not a regular file"))
    }
}

/// Opens a file the walk saw, if it is still that file: plain, one link, same device and inode.
fn open_seen(e: &Entry) -> Result<File, TreeError> {
    let changed = || TreeError::Changed(e.rel.clone());
    let file = open_plain(&e.path).map_err(|_| changed())?;
    let meta = file.metadata().map_err(|_| changed())?;
    if links(&meta) == 1 && Some(file_id(&meta)) == e.file {
        Ok(file)
    } else {
        Err(changed())
    }
}

/// Every entry of a tree, sorted by path, checked as it is read (never following a link).
fn walk(root: &Path, limits: Limits) -> Result<(Vec<Entry>, TreeStats), TreeError> {
    let unreadable = |e: io::Error| TreeError::Unreadable(e.to_string());
    if !fs::symlink_metadata(root).map_err(unreadable)?.is_dir() {
        return Err(TreeError::NotPlain(".".into()));
    }
    let mut stats = TreeStats {
        files: 0,
        folders: 0,
        bytes: 0,
    };
    let mut entries = Vec::new();
    let mut pending = vec![(root.to_path_buf(), String::new(), 0usize)];
    while let Some((dir, prefix, depth)) = pending.pop() {
        for item in fs::read_dir(&dir).map_err(unreadable)? {
            let item = item.map_err(unreadable)?;
            let raw = item.file_name();
            let name = raw
                .to_str()
                .filter(|n| !n.chars().any(|c| c.is_control() || c == '\\'))
                .ok_or_else(|| {
                    TreeError::BadName(raw.to_string_lossy().escape_debug().to_string())
                })?;
            let rel = if prefix.is_empty() {
                name.to_string()
            } else {
                format!("{prefix}/{name}")
            };
            // `DirEntry::file_type` and `metadata` describe the entry itself, not a link's target.
            let kind = item.file_type().map_err(unreadable)?;
            if kind.is_dir() {
                stats.folders += 1;
                if stats.folders > limits.folders || depth >= limits.depth {
                    return Err(TreeError::TooManyFolders(limits.folders));
                }
                pending.push((item.path(), rel.clone(), depth + 1));
                entries.push(Entry {
                    rel,
                    path: item.path(),
                    file: None,
                });
            } else if kind.is_file() {
                let meta = item.metadata().map_err(unreadable)?;
                // A hard link is a link too: its other name may be anywhere on the disk.
                if links(&meta) > 1 {
                    return Err(TreeError::NotPlain(rel));
                }
                stats.files += 1;
                stats.bytes += meta.len();
                if stats.files > limits.files {
                    return Err(TreeError::TooManyFiles(limits.files));
                }
                if stats.bytes > limits.bytes {
                    return Err(TreeError::TooLarge(limits.bytes / MB));
                }
                entries.push(Entry {
                    rel,
                    path: item.path(),
                    file: Some(file_id(&meta)),
                });
            } else {
                return Err(TreeError::NotPlain(rel));
            }
        }
    }
    entries.sort_by(|a, b| a.rel.cmp(&b.rel));
    Ok((entries, stats))
}

/// Checks a plugin's tree: at most 400 files and 20 MB, plain files and folders only.
pub fn check_tree(dir: &Path) -> Result<TreeStats, TreeError> {
    walk(dir, PLUGIN).map(|(_, stats)| stats)
}

/// Checks a fetched marketplace: at most 5000 files and 64 MB, plain files and folders only.
pub(crate) fn check_market_tree(dir: &Path) -> Result<TreeStats, TreeError> {
    walk(dir, MARKET).map(|(_, stats)| stats)
}

/// SHA-256 over a plugin's tree, after `check_tree`'s checks: each folder as `dir\0<path>\0`,
/// each file as `file\0<path>\0<sha256 of its bytes>`, in path order. Paths can't hold NUL, so
/// no two trees hash alike by moving bytes between names and contents.
pub fn tree_hash(dir: &Path) -> Result<String, TreeError> {
    let (entries, _) = walk(dir, PLUGIN)?;
    let unreadable = |e: io::Error| TreeError::Unreadable(e.to_string());
    let mut tree = Sha256::new();
    let mut budget = PLUGIN.bytes;
    let mut buf = vec![0u8; 64 * 1024];
    for e in &entries {
        if e.file.is_none() {
            tree.update(b"dir\0");
            tree.update(e.rel.as_bytes());
            tree.update(b"\0");
            continue;
        }
        let mut file = open_seen(e)?;
        let mut content = Sha256::new();
        loop {
            let n = file.read(&mut buf).map_err(unreadable)?;
            if n == 0 {
                break;
            }
            budget = budget
                .checked_sub(n as u64)
                .ok_or(TreeError::TooLarge(PLUGIN.bytes / MB))?;
            content.update(&buf[..n]);
        }
        tree.update(b"file\0");
        tree.update(e.rel.as_bytes());
        tree.update(b"\0");
        tree.update(content.finalize());
    }
    Ok(hex(&tree.finalize()))
}

pub(crate) fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

/// Copies a plugin's checked tree to `dst` (which doesn't exist yet) as fresh files: no link,
/// mode or owner of the source comes along.
pub(crate) fn copy_tree(src: &Path, dst: &Path) -> Result<(), TreeError> {
    let (entries, _) = walk(src, PLUGIN)?;
    let unreadable = |e: io::Error| TreeError::Unreadable(e.to_string());
    fs::create_dir(dst).map_err(unreadable)?;
    let mut budget = PLUGIN.bytes;
    for e in &entries {
        let to = e
            .rel
            .split('/')
            .fold(dst.to_path_buf(), |p, part| p.join(part));
        if e.file.is_none() {
            fs::create_dir(&to).map_err(unreadable)?;
            continue;
        }
        let from = open_seen(e)?;
        let mut out = OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&to)
            .map_err(unreadable)?;
        let copied = io::copy(&mut from.take(budget + 1), &mut out).map_err(unreadable)?;
        budget = budget
            .checked_sub(copied)
            .ok_or(TreeError::TooLarge(PLUGIN.bytes / MB))?;
        out.flush().map_err(unreadable)?;
    }
    Ok(())
}

/// Deletes a folder or a file, if there is one; never follows a link.
pub(crate) fn delete_path(path: &Path) -> io::Result<()> {
    match fs::symlink_metadata(path) {
        Ok(m) if m.is_dir() => fs::remove_dir_all(path),
        Ok(_) => fs::remove_file(path),
        Err(e) if e.kind() == io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(e),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_file_swapped_or_linked_after_the_walk_is_not_read() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().join("plugin");
        fs::create_dir_all(&root).unwrap();
        fs::write(root.join("main.js"), "original").unwrap();
        fs::write(root.join("client.js"), "client").unwrap();
        let (entries, stats) = walk(&root, PLUGIN).unwrap();
        assert_eq!((stats.files, stats.folders), (2, 0));
        let main = entries.iter().find(|e| e.rel == "main.js").unwrap();
        let client = entries.iter().find(|e| e.rel == "client.js").unwrap();
        let mut text = String::new();
        open_seen(main).unwrap().read_to_string(&mut text).unwrap();
        assert_eq!(text, "original");

        // Replaced by another file of the same name (made first, so its inode is another).
        let secret = dir.path().join("secret.txt");
        fs::write(&secret, "owner-secret").unwrap();
        fs::copy(&secret, root.join("swap.tmp")).unwrap();
        fs::rename(root.join("swap.tmp"), root.join("main.js")).unwrap();
        assert_eq!(
            open_seen(main).unwrap_err(),
            TreeError::Changed("main.js".into())
        );
        #[cfg(unix)]
        {
            // Replaced by a link, or given a second name elsewhere.
            fs::remove_file(root.join("main.js")).unwrap();
            std::os::unix::fs::symlink(&secret, root.join("main.js")).unwrap();
            assert!(matches!(open_seen(main), Err(TreeError::Changed(_))));
            fs::hard_link(root.join("client.js"), dir.path().join("elsewhere.js")).unwrap();
            assert!(matches!(open_seen(client), Err(TreeError::Changed(_))));
        }
    }

    #[test]
    fn limits_are_per_kind_of_tree() {
        let dir = tempfile::tempdir().unwrap();
        for i in 0..=PLUGIN.files {
            fs::write(dir.path().join(format!("f{i}")), "").unwrap();
        }
        assert_eq!(
            check_tree(dir.path()).unwrap_err(),
            TreeError::TooManyFiles(400)
        );
        assert_eq!(check_market_tree(dir.path()).unwrap().files, 401);
        let big = File::create(dir.path().join("big.bin")).unwrap();
        big.set_len(MARKET.bytes + 1).unwrap();
        assert_eq!(
            check_market_tree(dir.path()).unwrap_err(),
            TreeError::TooLarge(64)
        );
        assert_eq!(
            TreeError::TooLarge(64).to_string(),
            "it is larger than 64 MB"
        );
    }
}
