//! Installing, updating and removing plugins (DESIGN 7.1).
//!
//! An install never trusts the marketplace's folder after looking at it once:
//! 1. the plugin's tree is checked (at most 400 files and 20 MB, plain files and folders only,
//!    no links, devices or FIFOs, no names with control characters) and hashed;
//! 2. it is copied to `<data root>/plugins/tmp/<uuid>/`, and the copy is hashed again: a
//!    different hash means the folder changed meanwhile, and nothing is installed;
//! 3. the copy's own manifest is read and judged: its Echo range must include Connect's, no
//!    line of its permission sheet may block it, and the user must have agreed to every line;
//! 4. the copy is renamed to `installed/<id>/<version>/` and the registry is written. An update
//!    removes the previous version's folder only after the registry points at the new one.
//!
//! An update keeps the user's agreement when every line is one they agreed to, word for word;
//! a new line, or a line that now says something else (a new host), asks again.
use super::capabilities::{sheet, SheetLine, Support};
use super::manifest::{check_compat, parse_manifest, Manifest, MANIFEST_FILE};
use super::market::{self, CatalogEntry};
use super::registry::{io_error, now, Installed, Locked, Market, PluginPaths, Registry, TmpDir};
use super::valid_id;
use crate::workspace::models::{Result, WorkspaceError};
use semver::Version;
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, BTreeSet};
use std::fmt::Display;
use std::fs::{self, File, OpenOptions};
use std::io::{self, Read, Write};
use std::path::{Path, PathBuf};

/// The most files a plugin may have.
pub const MAX_FILES: usize = 400;
/// The most bytes its files may hold together.
pub const MAX_BYTES: u64 = 20 * 1024 * 1024;
const MAX_FOLDERS: usize = 400;
const MAX_DEPTH: usize = 16;

#[derive(Debug, Clone, PartialEq, thiserror::Error)]
pub enum TreeError {
    #[error("it has more than {MAX_FILES} files")]
    TooManyFiles,
    #[error("it has more than {MAX_FOLDERS} folders, or they are nested too deeply")]
    TooManyFolders,
    #[error("it is larger than 20 MB")]
    TooLarge,
    #[error("it holds a link or a special file ({0})")]
    NotPlain(String),
    #[error("a name in it has characters Connect can’t use ({0})")]
    BadName(String),
    #[error("its files couldn’t be read ({0})")]
    Unreadable(String),
}

/// What `check_tree` counted.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct TreeStats {
    pub files: usize,
    pub folders: usize,
    pub bytes: u64,
}

struct Entry {
    /// Relative path with `/` separators.
    rel: String,
    path: PathBuf,
    file: bool,
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

/// Every entry of a tree, sorted by path, checked as it is read (never following a link).
fn walk(root: &Path) -> std::result::Result<(Vec<Entry>, TreeStats), TreeError> {
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
                if stats.folders > MAX_FOLDERS || depth >= MAX_DEPTH {
                    return Err(TreeError::TooManyFolders);
                }
                pending.push((item.path(), rel.clone(), depth + 1));
                entries.push(Entry {
                    rel,
                    path: item.path(),
                    file: false,
                });
            } else if kind.is_file() {
                let meta = item.metadata().map_err(unreadable)?;
                // A hard link is a link too: its other name may be anywhere on the disk.
                #[cfg(unix)]
                if std::os::unix::fs::MetadataExt::nlink(&meta) > 1 {
                    return Err(TreeError::NotPlain(rel));
                }
                stats.files += 1;
                stats.bytes += meta.len();
                if stats.files > MAX_FILES {
                    return Err(TreeError::TooManyFiles);
                }
                if stats.bytes > MAX_BYTES {
                    return Err(TreeError::TooLarge);
                }
                entries.push(Entry {
                    rel,
                    path: item.path(),
                    file: true,
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
pub fn check_tree(dir: &Path) -> std::result::Result<TreeStats, TreeError> {
    walk(dir).map(|(_, stats)| stats)
}

/// SHA-256 over the tree, after `check_tree`'s checks: each folder as `dir\0<path>\0`, each
/// file as `file\0<path>\0<sha256 of its bytes>`, in path order. Paths can't hold NUL, so no
/// two trees hash alike by moving bytes between names and contents.
pub fn tree_hash(dir: &Path) -> std::result::Result<String, TreeError> {
    let (entries, _) = walk(dir)?;
    let unreadable = |e: io::Error| TreeError::Unreadable(e.to_string());
    let mut tree = Sha256::new();
    let mut budget = MAX_BYTES;
    let mut buf = vec![0u8; 64 * 1024];
    for e in &entries {
        if !e.file {
            tree.update(b"dir\0");
            tree.update(e.rel.as_bytes());
            tree.update(b"\0");
            continue;
        }
        let mut file = open_plain(&e.path).map_err(|_| TreeError::NotPlain(e.rel.clone()))?;
        let mut content = Sha256::new();
        loop {
            let n = file.read(&mut buf).map_err(unreadable)?;
            if n == 0 {
                break;
            }
            budget = budget.checked_sub(n as u64).ok_or(TreeError::TooLarge)?;
            content.update(&buf[..n]);
        }
        tree.update(b"file\0");
        tree.update(e.rel.as_bytes());
        tree.update(b"\0");
        tree.update(content.finalize());
    }
    Ok(hex(&tree.finalize()))
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

/// Copies a checked tree to `dst` (which doesn't exist yet) as fresh files: no link, mode or
/// owner of the source comes along.
fn copy_tree(src: &Path, dst: &Path) -> std::result::Result<(), TreeError> {
    let (entries, _) = walk(src)?;
    let unreadable = |e: io::Error| TreeError::Unreadable(e.to_string());
    fs::create_dir(dst).map_err(unreadable)?;
    let mut budget = MAX_BYTES;
    for e in &entries {
        let to = e
            .rel
            .split('/')
            .fold(dst.to_path_buf(), |p, part| p.join(part));
        if !e.file {
            fs::create_dir(&to).map_err(unreadable)?;
            continue;
        }
        let from = open_plain(&e.path).map_err(|_| TreeError::NotPlain(e.rel.clone()))?;
        let mut out = OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&to)
            .map_err(unreadable)?;
        let copied = io::copy(&mut from.take(budget + 1), &mut out).map_err(unreadable)?;
        budget = budget.checked_sub(copied).ok_or(TreeError::TooLarge)?;
        out.flush().map_err(unreadable)?;
    }
    Ok(())
}

/// A reason as a sentence: capitalised, with a full stop.
pub fn sentence(reason: impl Display) -> String {
    let text = reason.to_string();
    let mut chars = text.chars();
    let mut out: String = chars
        .next()
        .map(|c| c.to_uppercase().chain(chars).collect())
        .unwrap_or_default();
    if !out.ends_with('.') {
        out.push('.');
    }
    out
}

fn refused(id: &str, why: impl Display) -> WorkspaceError {
    WorkspaceError::new("refused", format!("“{id}” can’t be installed: {why}."))
}

fn not_installed(id: &str) -> WorkspaceError {
    WorkspaceError::new(
        "not_found",
        format!("“{}” isn’t installed.", id.escape_debug()),
    )
}

fn checked_id(id: &str) -> Result<()> {
    if valid_id(id) {
        Ok(())
    } else {
        Err(WorkspaceError::new(
            "invalid",
            "That isn’t a plugin id (a-z, 0-9, -).",
        ))
    }
}

/// Judges a manifest: its id is the catalog's, its Echo range includes Connect's, its sheet can
/// be read, and no line blocks it. A refusal's message is the sentence the UI shows.
pub fn admit(m: &Manifest, id: &str) -> Result<Vec<SheetLine>> {
    if m.id != id {
        return Err(refused(
            id,
            format!("its {MANIFEST_FILE} names it “{}”", m.id),
        ));
    }
    check_compat(m).map_err(|e| WorkspaceError::new("incompatible", sentence(e)))?;
    let lines = sheet(m).map_err(|e| refused(id, e))?;
    if let Some(why) = lines.iter().find_map(|l| match l.support {
        Support::Blocking(why) => Some(why),
        _ => None,
    }) {
        return Err(WorkspaceError::new("blocked", why));
    }
    Ok(lines)
}

/// Checks a plugin's tree, then reads its manifest.
fn read_package(dir: &Path, id: &str) -> Result<Manifest> {
    check_tree(dir).map_err(|e| refused(id, e))?;
    parse_manifest(dir).map_err(|e| refused(id, e))
}

// ------------------------------------------------------------------ offers

/// A plugin a marketplace offers, as Connect judges it.
pub struct Offer {
    pub id: String,
    pub categories: Vec<String>,
    pub featured: bool,
    /// `None` when its folder or manifest can't be read (`refusal` says why).
    pub manifest: Option<Manifest>,
    pub sheet: Vec<SheetLine>,
    /// Why it can't be installed; `None` when it can.
    pub refusal: Option<WorkspaceError>,
}

fn judge(root: &Path, entry: &CatalogEntry, featured: bool) -> Offer {
    let mut offer = Offer {
        id: entry.id.clone(),
        categories: entry.categories(),
        featured,
        manifest: None,
        sheet: Vec::new(),
        refusal: None,
    };
    let manifest = market::entry_dir(root, &entry.source)
        .map_err(|why| refused(&entry.id, why))
        .and_then(|dir| read_package(&dir, &entry.id));
    match manifest {
        Ok(m) => {
            offer.sheet = sheet(&m).unwrap_or_default();
            offer.refusal = admit(&m, &entry.id).err();
            offer.manifest = Some(m);
        }
        Err(e) => offer.refusal = Some(e),
    }
    offer
}

/// Every plugin a marketplace offers (entries without a valid id are left out).
pub fn offers(paths: &PluginPaths, market: &Market) -> Result<Vec<Offer>> {
    let catalog = market::catalog_of(paths, market)?;
    let root = market.dir(paths);
    let mut seen = BTreeSet::new();
    Ok(catalog
        .plugins
        .iter()
        .filter(|e| valid_id(&e.id) && seen.insert(e.id.clone()))
        .map(|e| judge(&root, e, catalog.featured.contains(&e.id)))
        .collect())
}

/// One plugin a marketplace offers, with its permission sheet.
pub fn offer(paths: &PluginPaths, market: &Market, id: &str) -> Result<Offer> {
    checked_id(id)?;
    let catalog = market::catalog_of(paths, market)?;
    let entry = catalog.plugins.iter().find(|e| e.id == id).ok_or_else(|| {
        WorkspaceError::new(
            "not_found",
            format!("The “{}” marketplace has no plugin “{id}”.", market.name),
        )
    })?;
    Ok(judge(
        &market.dir(paths),
        entry,
        catalog.featured.iter().any(|f| f == id),
    ))
}

/// The version `market` offers of an installed plugin, when it can be read.
pub fn offered_version(paths: &PluginPaths, market: &Market, id: &str) -> Option<Version> {
    let (_, dir) = market::plugin_dir(paths, market, id).ok()?;
    read_package(&dir, id).ok().map(|m| m.version)
}

// ----------------------------------------------------------------- install

/// What an install or update did.
#[derive(Debug)]
pub enum Outcome {
    Installed(String),
    /// The update has lines the user hasn't agreed to; nothing changed.
    NeedsConsent {
        id: String,
        name: String,
        version: String,
        /// The new or changed lines.
        lines: Vec<SheetLine>,
        /// The whole sheet of the new version.
        sheet: Vec<SheetLine>,
    },
}

/// How the user agreed.
enum Consent<'a> {
    /// To these sheet keys, now: they must be every line.
    Given(&'a [String]),
    /// Earlier: lines that are new or say something else ask again.
    Kept,
}

#[derive(Clone, Copy, PartialEq)]
enum Mode {
    Install,
    Update,
}

/// A checked copy in `tmp/`, deleted unless it is moved into place.
struct Staged {
    _tmp: TmpDir,
    dir: PathBuf,
    hash: String,
    manifest: Manifest,
    sheet: Vec<SheetLine>,
}

fn stage(paths: &PluginPaths, source: &Path, id: &str) -> Result<Staged> {
    let before = tree_hash(source).map_err(|e| refused(id, e))?;
    let tmp = paths.fresh_tmp()?;
    let dir = tmp.join("package");
    copy_tree(source, &dir).map_err(|e| refused(id, e))?;
    let hash = tree_hash(&dir).map_err(|e| refused(id, e))?;
    if hash != before {
        return Err(WorkspaceError::new(
            "changed",
            format!("“{id}” changed while Connect was copying it. Try again."),
        ));
    }
    let manifest = parse_manifest(&dir).map_err(|e| refused(id, e))?;
    let sheet = admit(&manifest, id)?;
    Ok(Staged {
        _tmp: tmp,
        dir,
        hash,
        manifest,
        sheet,
    })
}

fn check_version(
    id: &str,
    offered: &Version,
    current: Option<&Installed>,
    mode: Mode,
) -> Result<()> {
    let Some(cur) = current else {
        return Ok(());
    };
    let have = Version::parse(&cur.version).ok();
    match have {
        Some(have) if offered > &have => Ok(()),
        Some(have) if offered == &have => Err(match mode {
            Mode::Install => {
                WorkspaceError::new("exists", format!("“{id}” {have} is already installed."))
            }
            Mode::Update => {
                WorkspaceError::new("up_to_date", format!("“{id}” is up to date ({have})."))
            }
        }),
        _ => Err(WorkspaceError::new(
            "exists",
            format!("A newer “{id}” ({}) is already installed.", cur.version),
        )),
    }
}

/// Lines the user hasn't agreed to: new keys, and keys whose words changed.
fn new_lines(sheet: &[SheetLine], cur: &Installed) -> Vec<SheetLine> {
    sheet
        .iter()
        .filter(|l| {
            !cur.agreed.contains(&l.key)
                || cur.agreed_text.get(&l.key).is_some_and(|t| t != &l.text)
        })
        .cloned()
        .collect()
}

fn require_all(id: &str, agreed: &[String], sheet: &[SheetLine]) -> Result<()> {
    let want: BTreeSet<&str> = sheet.iter().map(|l| l.key.as_str()).collect();
    let got: BTreeSet<&str> = agreed.iter().map(String::as_str).collect();
    if want == got {
        Ok(())
    } else {
        Err(WorkspaceError::new(
            "consent_required",
            format!("Agree to every line of the permission sheet to install “{id}”."),
        ))
    }
}

/// `installed/<id>/<version>`, for an id and a version that are plain names.
fn version_dir(paths: &PluginPaths, id: &str, version: &str) -> Option<PathBuf> {
    (valid_id(id) && Version::parse(version).is_ok())
        .then(|| paths.installed().join(id).join(version))
}

/// Installs plugin `id` from `market`, or upgrades it to the version the marketplace offers.
/// `agreed` must be every key of its permission sheet.
pub fn install(paths: &PluginPaths, market: &str, id: &str, agreed: &[String]) -> Result<Outcome> {
    put(paths, market, id, Consent::Given(agreed), Mode::Install)
}

/// Updates an installed plugin to the version its marketplace offers. Without `agreed`, the
/// earlier agreement is kept when nothing on the sheet is new; otherwise `NeedsConsent`.
pub fn update(paths: &PluginPaths, id: &str, agreed: Option<&[String]>) -> Result<Outcome> {
    checked_id(id)?;
    let reg = Registry::load(paths)?;
    let cur = reg.installed.get(id).ok_or_else(|| not_installed(id))?;
    let consent = agreed.map_or(Consent::Kept, Consent::Given);
    put(paths, &cur.market, id, consent, Mode::Update)
}

fn put(
    paths: &PluginPaths,
    market_name: &str,
    id: &str,
    consent: Consent,
    mode: Mode,
) -> Result<Outcome> {
    checked_id(id)?;
    let reg = Registry::load(paths)?;
    let market = reg
        .market(market_name)
        .cloned()
        .ok_or_else(|| market::no_market(market_name))?;
    let current = reg.installed.get(id).cloned();
    if let Some(cur) = current.as_ref().filter(|c| c.market != market.name) {
        return Err(WorkspaceError::new(
            "exists",
            format!(
                "“{id}” is installed from the “{}” marketplace. Remove it first to install it from “{}”.",
                cur.market, market.name
            ),
        ));
    }
    if mode == Mode::Update && current.is_none() {
        return Err(not_installed(id));
    }
    let (_, source) = market::plugin_dir(paths, &market, id)?;
    // A first look, so nothing is copied when there is nothing to do; the copy is judged again.
    let offered = read_package(&source, id)?;
    check_version(id, &offered.version, current.as_ref(), mode)?;
    let staged = stage(paths, &source, id)?;
    check_version(id, &staged.manifest.version, current.as_ref(), mode)?;
    match (consent, &current) {
        (Consent::Given(agreed), _) => require_all(id, agreed, &staged.sheet)?,
        (Consent::Kept, Some(cur)) => {
            let lines = new_lines(&staged.sheet, cur);
            if !lines.is_empty() {
                return Ok(Outcome::NeedsConsent {
                    id: id.to_string(),
                    name: staged.manifest.name.clone(),
                    version: staged.manifest.version.to_string(),
                    lines,
                    sheet: staged.sheet,
                });
            }
        }
        (Consent::Kept, None) => return Err(not_installed(id)),
    }
    commit(paths, &market, id, staged, current.as_ref())
}

/// Moves a staged copy into place and records it, if the plugin is still as `seen`.
fn commit(
    paths: &PluginPaths,
    market: &Market,
    id: &str,
    staged: Staged,
    seen: Option<&Installed>,
) -> Result<Outcome> {
    let mut locked = Locked::take(paths)?;
    if locked.reg.installed.get(id) != seen {
        return Err(WorkspaceError::new(
            "busy",
            "Your plugins changed while Connect was installing. Try again.",
        ));
    }
    let version = staged.manifest.version.to_string();
    let target = version_dir(paths, id, &version).ok_or_else(|| refused(id, "its version"))?;
    let home = paths.installed().join(id);
    fs::create_dir_all(&home).map_err(|e| io_error("prepare the plugin’s folder", &e))?;
    // A real folder inside the data root, not a link out of it.
    let real = |p: &Path| dunce::canonicalize(p).ok();
    if real(&home) != real(&paths.root).map(|r| r.join("installed").join(id)) {
        return Err(refused(id, "its folder in the data folder is a link"));
    }
    // Left by an attempt that never reached the registry.
    if target.exists() {
        fs::remove_dir_all(&target).map_err(|e| io_error("replace the plugin’s files", &e))?;
    }
    fs::rename(&staged.dir, &target).map_err(|e| io_error("move the plugin into place", &e))?;
    let agreed: Vec<String> = staged
        .sheet
        .iter()
        .map(|l| l.key.clone())
        .collect::<BTreeSet<_>>()
        .into_iter()
        .collect();
    let agreed_text: BTreeMap<String, String> = staged
        .sheet
        .iter()
        .map(|l| (l.key.clone(), l.text.clone()))
        .collect();
    locked.reg.installed.insert(
        id.to_string(),
        Installed {
            version: version.clone(),
            market: market.name.clone(),
            source: market.source.text(),
            commit: market.commit.clone(),
            hash: staged.hash.clone(),
            enabled: seen.is_none_or(|s| s.enabled),
            agreed,
            agreed_text,
            installed_at: now(),
        },
    );
    if let Err(e) = locked.save() {
        let _ = fs::remove_dir_all(&target);
        return Err(e);
    }
    // The previous version goes once the registry points at the new one.
    if let Some(old) = seen
        .filter(|s| s.version != version)
        .and_then(|s| version_dir(paths, id, &s.version))
    {
        if let Err(e) = fs::remove_dir_all(&old) {
            log::warn!("plugin {id}: the previous version's folder stays: {e}");
        }
    }
    Ok(Outcome::Installed(id.to_string()))
}

/// Turns an installed plugin on or off; its files and data stay.
pub fn set_enabled(paths: &PluginPaths, id: &str, enabled: bool) -> Result<()> {
    checked_id(id)?;
    Registry::update(paths, |r| {
        r.installed
            .get_mut(id)
            .ok_or_else(|| not_installed(id))?
            .enabled = enabled;
        Ok(())
    })
}

/// Deletes a folder or a file, if there is one; never follows a link.
fn delete_path(path: &Path) -> io::Result<()> {
    match fs::symlink_metadata(path) {
        Ok(m) if m.is_dir() => fs::remove_dir_all(path),
        Ok(_) => fs::remove_file(path),
        Err(e) if e.kind() == io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(e),
    }
}

/// Removes a plugin: its registry entry and `installed/<id>/`. With `delete_data`, also
/// `<data root>/plugins/data/<id>/` and `<private root>/credentials/plugins/<id>/`; nothing else.
pub fn remove(paths: &PluginPaths, id: &str, delete_data: bool) -> Result<()> {
    checked_id(id)?;
    let mut locked = Locked::take(paths)?;
    locked
        .reg
        .installed
        .remove(id)
        .ok_or_else(|| not_installed(id))?;
    locked.save()?;
    if let Err(e) = delete_path(&paths.installed().join(id)) {
        log::warn!("plugin {id}: its files stay after removal: {e}");
    }
    if delete_data {
        for dir in [paths.data_of(id), paths.secrets_of(id)] {
            delete_path(&dir)
                .map_err(|e| io_error(&format!("delete the data of “{id}” (it is removed)"), &e))?;
        }
    }
    Ok(())
}

/// The manifest of an installed plugin's files.
pub fn installed_manifest(paths: &PluginPaths, id: &str, p: &Installed) -> Option<Manifest> {
    parse_manifest(&version_dir(paths, id, &p.version)?).ok()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::plugins::registry::active_version;
    use crate::plugins::testkit::{self, count, manifest, Env};
    use serde_json::json;

    fn keys(lines: &[SheetLine]) -> Vec<String> {
        lines.iter().map(|l| l.key.clone()).collect()
    }

    fn installed(env: &Env, id: &str) -> Option<Installed> {
        Registry::load(&env.paths)
            .unwrap()
            .installed
            .get(id)
            .cloned()
    }

    fn hello(version: &str) -> serde_json::Value {
        let mut m = manifest("hello", version);
        m["uses"] = json!({"network": {"hosts": ["api.example.com"]}});
        m["icon"] = json!("icon.svg");
        m
    }

    /// The source folder of a plugin in the test marketplace.
    fn src(env: &Env, id: &str) -> PathBuf {
        env.market.join("plugins").join(id)
    }

    #[test]
    fn install_from_local_market_copies_and_hashes() {
        let env = testkit::env();
        let market = testkit::local_market(&env, &[hello("1.0.0")]);
        let source = src(&env, "hello");
        fs::write(source.join("icon.svg"), "<svg/>").unwrap();
        fs::create_dir_all(source.join("sub/empty")).unwrap();
        fs::write(source.join("sub/page.js"), "export {}").unwrap();
        fs::write(source.join("data.bin"), [0u8, 255, 7]).unwrap();

        let offer = offer(&env.paths, &market, "hello").unwrap();
        assert!(offer.refusal.is_none());
        assert_eq!(keys(&offer.sheet), ["network"]);
        assert_eq!(offer.sheet[0].text, "Connect to api.example.com");

        let out = install(&env.paths, "local", "hello", &["network".into()]).unwrap();
        assert!(matches!(out, Outcome::Installed(ref id) if id == "hello"));
        let dir = env.paths.installed().join("hello/1.0.0");
        for f in [
            "echo-plugin.json",
            "main.js",
            "client.js",
            "icon.svg",
            "sub/page.js",
            "data.bin",
        ] {
            assert_eq!(
                fs::read(dir.join(f)).unwrap(),
                fs::read(source.join(f)).unwrap(),
                "{f}"
            );
        }
        assert!(dir.join("sub/empty").is_dir());
        // The registry records where it came from, what was agreed and the hash of the copy,
        // which is the hash of the source.
        let p = installed(&env, "hello").unwrap();
        assert_eq!(p.version, "1.0.0");
        assert_eq!(p.market, "local");
        assert_eq!(p.source, market.source.text());
        assert_eq!(p.commit, None);
        assert!(p.enabled);
        assert_eq!(p.agreed, ["network"]);
        assert_eq!(p.agreed_text["network"], "Connect to api.example.com");
        assert!(p.installed_at.ends_with('Z'));
        assert_eq!(p.hash, tree_hash(&dir).unwrap());
        assert_eq!(p.hash, tree_hash(&source).unwrap());
        assert_eq!(p.hash.len(), 64);
        assert_eq!(count(&env.paths.tmp()), 0);
        assert_eq!(
            active_version(&env.paths, "hello").as_deref(),
            Some("1.0.0")
        );
        let files = [
            "echo-plugin.json",
            "main.js",
            "client.js",
            "icon.svg",
            "sub/page.js",
            "data.bin",
        ];
        let bytes = files
            .iter()
            .map(|f| fs::metadata(dir.join(f)).unwrap().len())
            .sum();
        assert_eq!(
            check_tree(&dir).unwrap(),
            TreeStats {
                files: 6,
                folders: 2,
                bytes
            }
        );

        // The hash covers names, contents and folders.
        let base = tree_hash(&source).unwrap();
        fs::write(source.join("data.bin"), [0u8, 255, 8]).unwrap();
        let changed = tree_hash(&source).unwrap();
        assert_ne!(changed, base);
        fs::rename(source.join("data.bin"), source.join("data2.bin")).unwrap();
        assert_ne!(tree_hash(&source).unwrap(), changed);
        let renamed = tree_hash(&source).unwrap();
        fs::create_dir(source.join("more")).unwrap();
        assert_ne!(tree_hash(&source).unwrap(), renamed);

        // The same version again is already there.
        let again = install(&env.paths, "local", "hello", &["network".into()]).unwrap_err();
        assert_eq!(again.code, "exists");
        assert_eq!(again.message, "“hello” 1.0.0 is already installed.");
        // Unknown marketplaces and plugins.
        assert_eq!(
            install(&env.paths, "nope", "hello", &[]).unwrap_err().code,
            "not_found"
        );
        assert_eq!(
            install(&env.paths, "local", "other", &[]).unwrap_err().code,
            "not_found"
        );
        assert_eq!(
            install(&env.paths, "local", "../x", &[]).unwrap_err().code,
            "invalid"
        );
        // The built-in marketplace isn't fetched until the user asks.
        assert_eq!(
            install(&env.paths, "onetest", "github", &[])
                .unwrap_err()
                .code,
            "not_fetched"
        );
    }

    #[test]
    fn install_rejects_symlink_oversize_traversal_and_blocking_capability() {
        let env = testkit::env();
        let mut knowledge = manifest("vault", "1.0.0");
        knowledge["uses"] = json!({"knowledge": {}, "network": {"hosts": ["api.example.com"]}});
        let mut newer = manifest("newer", "1.0.0");
        newer["echo"] = json!(">=0.9.13");
        let plugins = [
            manifest("linked", "1.0.0"),
            manifest("hardlinked", "1.0.0"),
            manifest("many", "1.0.0"),
            manifest("big", "1.0.0"),
            manifest("fifo", "1.0.0"),
            manifest("named", "1.0.0"),
            manifest("deep", "1.0.0"),
            knowledge,
            newer,
            manifest("other-id", "1.0.0"),
        ];
        testkit::local_market(&env, &plugins);
        let secret = env.dir.path().join("secret.txt");
        fs::write(&secret, "owner-secret").unwrap();
        #[cfg(unix)]
        {
            std::os::unix::fs::symlink(&secret, src(&env, "linked").join("notes.txt")).unwrap();
            fs::hard_link(&secret, src(&env, "hardlinked").join("notes.txt")).unwrap();
            let fifo =
                std::ffi::CString::new(src(&env, "fifo").join("pipe").to_str().unwrap()).unwrap();
            assert_eq!(unsafe { libc::mkfifo(fifo.as_ptr(), 0o600) }, 0);
            fs::write(src(&env, "named").join("bad\u{1b}name.js"), "").unwrap();
        }
        for i in 0..MAX_FILES {
            fs::write(src(&env, "many").join(format!("f{i}.js")), "").unwrap();
        }
        let big = File::create(src(&env, "big").join("blob.bin")).unwrap();
        big.set_len(MAX_BYTES + 1).unwrap();
        let mut deep = src(&env, "deep");
        for _ in 0..=MAX_DEPTH {
            deep = deep.join("d");
        }
        fs::create_dir_all(&deep).unwrap();
        // The catalog's own manifest says another id.
        let mut wrong = manifest("someone-else", "1.0.0");
        wrong["name"] = json!("Other");
        testkit::write_plugin(&src(&env, "other-id"), wrong);

        let mut cases: Vec<(&str, &str, String)> = vec![
            ("many", "refused", "“many” can’t be installed: it has more than 400 files.".into()),
            ("big", "refused", "“big” can’t be installed: it is larger than 20 MB.".into()),
            (
                "deep",
                "refused",
                "“deep” can’t be installed: it has more than 400 folders, or they are nested too deeply.".into(),
            ),
            ("vault", "blocked", "Needs Connect's Knowledge engine (coming later)".into()),
            (
                "newer",
                "incompatible",
                "It needs Echo >=0.9.13, and Connect provides Echo API 0.9.11.".into(),
            ),
            (
                "other-id",
                "refused",
                "“other-id” can’t be installed: its echo-plugin.json names it “someone-else”.".into(),
            ),
        ];
        if cfg!(unix) {
            cases.extend([
                (
                    "linked",
                    "refused",
                    "“linked” can’t be installed: it holds a link or a special file (notes.txt).".into(),
                ),
                (
                    "hardlinked",
                    "refused",
                    "“hardlinked” can’t be installed: it holds a link or a special file (notes.txt).".into(),
                ),
                (
                    "fifo",
                    "refused",
                    "“fifo” can’t be installed: it holds a link or a special file (pipe).".into(),
                ),
                (
                    "named",
                    "refused",
                    "“named” can’t be installed: a name in it has characters Connect can’t use (bad\\u{1b}name.js).".into(),
                ),
            ]);
        }
        let market = Registry::load(&env.paths)
            .unwrap()
            .market("local")
            .cloned()
            .unwrap();
        let listed = offers(&env.paths, &market).unwrap();
        for (id, code, message) in &cases {
            let e = install(&env.paths, "local", id, &[]).unwrap_err();
            assert_eq!((e.code.as_str(), &e.message), (*code, message), "{id}");
            // The catalog gives the same reason before anyone tries.
            let o = listed.iter().find(|o| o.id == *id).unwrap();
            assert_eq!(o.refusal.as_ref().unwrap().message, *message, "{id}");
        }
        // A blocked plugin still shows its whole sheet, the blocking line first.
        let vault = listed.iter().find(|o| o.id == "vault").unwrap();
        assert_eq!(keys(&vault.sheet), ["knowledge", "network"]);
        assert!(vault.manifest.is_some());

        // Catalog entries that point out of the marketplace.
        let outside = env.dir.path().join("outside");
        testkit::write_plugin(&outside, manifest("escape", "1.0.0"));
        #[cfg(unix)]
        std::os::unix::fs::symlink(&outside, env.market.join("plugins/linkdir")).unwrap();
        testkit::write_catalog(
            &env.market,
            "local",
            &[
                ("escape", "../outside"),
                ("absolute", outside.to_str().unwrap()),
                ("linkdir", "./plugins/linkdir"),
            ],
        );
        for id in ["escape", "absolute", "linkdir"] {
            let e = install(&env.paths, "local", id, &[]).unwrap_err();
            assert_eq!(e.code, "refused", "{id}");
            assert_eq!(
                e.message,
                format!("“{id}” can’t be installed: its folder isn’t inside the marketplace.")
            );
        }
        // Nothing was installed or left behind, and the secret was never copied.
        assert_eq!(count(&env.paths.installed()), 0);
        assert_eq!(count(&env.paths.tmp()), 0);
        assert!(Registry::load(&env.paths).unwrap().installed.is_empty());
    }

    #[test]
    fn install_requires_every_sheet_line_agreed() {
        let env = testkit::env();
        let mut m = manifest("standup", "1.0.0");
        m["uses"] = json!({
            "network": {"hosts": ["api.example.com"]},
            "schedule": {},
            "claude": {},
        });
        testkit::local_market(&env, &[m, manifest("plain", "1.0.0")]);
        let all = ["claude", "network", "schedule"].map(String::from);
        for agreed in [
            vec![],
            vec!["network".to_string()],
            vec!["claude".into(), "network".into()],
            [all.to_vec(), vec!["files".into()]].concat(),
        ] {
            let e = install(&env.paths, "local", "standup", &agreed).unwrap_err();
            assert_eq!(e.code, "consent_required", "{agreed:?}");
            assert_eq!(
                e.message,
                "Agree to every line of the permission sheet to install “standup”."
            );
        }
        assert_eq!(count(&env.paths.installed()), 0);
        assert_eq!(count(&env.paths.tmp()), 0);
        // Every line, in any order.
        let agreed = ["schedule", "claude", "network"].map(String::from);
        install(&env.paths, "local", "standup", &agreed).unwrap();
        let p = installed(&env, "standup").unwrap();
        assert_eq!(p.agreed, all);
        assert_eq!(p.agreed_text.len(), 3);
        // A plugin that asks for nothing needs no agreement.
        install(&env.paths, "local", "plain", &[]).unwrap();
        assert!(installed(&env, "plain").unwrap().agreed.is_empty());
    }

    #[test]
    fn update_with_new_capability_requires_reconsent() {
        let env = testkit::env();
        let market = testkit::local_market(&env, &[hello("1.0.0")]);
        install(&env.paths, "local", "hello", &["network".into()]).unwrap();
        let dir = |v: &str| env.paths.installed().join("hello").join(v);
        assert_eq!(
            update(&env.paths, "hello", None).unwrap_err().code,
            "up_to_date"
        );

        // The same sheet: updated without asking; the old version's folder goes.
        testkit::write_plugin(&src(&env, "hello"), hello("1.1.0"));
        assert_eq!(
            offered_version(&env.paths, &market, "hello"),
            Some(Version::new(1, 1, 0))
        );
        assert!(matches!(
            update(&env.paths, "hello", None).unwrap(),
            Outcome::Installed(_)
        ));
        assert_eq!(installed(&env, "hello").unwrap().version, "1.1.0");
        assert!(dir("1.1.0").is_dir() && !dir("1.0.0").exists());

        // A new line asks again; nothing changes meanwhile.
        let mut m = hello("1.2.0");
        m["uses"]["schedule"] = json!({});
        testkit::write_plugin(&src(&env, "hello"), m);
        let before = installed(&env, "hello").unwrap();
        match update(&env.paths, "hello", None).unwrap() {
            Outcome::NeedsConsent {
                id,
                name,
                version,
                lines,
                sheet,
            } => {
                assert_eq!(
                    (id.as_str(), name.as_str(), version.as_str()),
                    ("hello", "Hello", "1.2.0")
                );
                assert_eq!(keys(&lines), ["schedule"]);
                assert_eq!(keys(&sheet), ["network", "schedule"]);
            }
            other => panic!("{other:?}"),
        }
        assert_eq!(installed(&env, "hello").unwrap(), before);
        assert!(dir("1.1.0").is_dir() && !dir("1.2.0").exists());
        assert_eq!(count(&env.paths.tmp()), 0);
        // Agreeing to some lines isn't enough; agreeing to all updates it.
        let e = update(&env.paths, "hello", Some(&["schedule".into()])).unwrap_err();
        assert_eq!(e.code, "consent_required");
        update(
            &env.paths,
            "hello",
            Some(&["network".into(), "schedule".into()]),
        )
        .unwrap();
        let p = installed(&env, "hello").unwrap();
        assert_eq!(
            (p.version.as_str(), p.agreed.clone()),
            ("1.2.0", vec!["network".into(), "schedule".into()])
        );
        assert!(!dir("1.1.0").exists());

        // A line that now says more (another host) asks again too; a disabled plugin stays off.
        set_enabled(&env.paths, "hello", false).unwrap();
        let mut m = hello("1.3.0");
        m["uses"] = json!({"network": {"hosts": ["api.example.com", "collect.example.net"]}, "schedule": {}});
        testkit::write_plugin(&src(&env, "hello"), m);
        match update(&env.paths, "hello", None).unwrap() {
            Outcome::NeedsConsent { lines, .. } => {
                assert_eq!(keys(&lines), ["network"]);
                assert_eq!(
                    lines[0].text,
                    "Connect to api.example.com and collect.example.net"
                );
            }
            other => panic!("{other:?}"),
        }
        // Installing the newer version with every line agreed upgrades it as well.
        install(
            &env.paths,
            "local",
            "hello",
            &["network".into(), "schedule".into()],
        )
        .unwrap();
        let p = installed(&env, "hello").unwrap();
        assert_eq!(p.version, "1.3.0");
        assert!(!p.enabled);
        assert_eq!(active_version(&env.paths, "hello"), None);
        assert_eq!(count(&env.paths.installed().join("hello")), 1);
        // An older version is not an update.
        testkit::write_plugin(&src(&env, "hello"), hello("1.0.0"));
        let e = install(&env.paths, "local", "hello", &["network".into()]).unwrap_err();
        assert_eq!(e.message, "A newer “hello” (1.3.0) is already installed.");
        assert_eq!(
            update(&env.paths, "nope", None).unwrap_err().code,
            "not_found"
        );
    }

    #[test]
    fn disable_and_remove_keep_or_delete_data() {
        let env = testkit::env();
        testkit::local_market(&env, &[hello("1.0.0"), manifest("keeper", "1.0.0")]);
        let install_hello = || install(&env.paths, "local", "hello", &["network".into()]).unwrap();
        install_hello();
        install(&env.paths, "local", "keeper", &[]).unwrap();
        let data = env.paths.data_of("hello");
        let secrets = env.paths.secrets_of("hello");
        let plant = || {
            fs::create_dir_all(&data).unwrap();
            fs::write(data.join("store.json"), "{}").unwrap();
            fs::create_dir_all(&secrets).unwrap();
            fs::write(secrets.join("token"), "t").unwrap();
        };
        plant();
        // Neighbours that must survive every removal.
        let keeper_data = env.paths.data_of("keeper");
        fs::create_dir_all(&keeper_data).unwrap();
        fs::write(keeper_data.join("store.json"), "{}").unwrap();
        let other_secret = env.private.join("credentials/plugins/hello.json");
        fs::write(&other_secret, "x").unwrap();
        let signin = env.private.join("credentials/microsoft.json");
        fs::write(&signin, "x").unwrap();

        // Off and on again: files and data stay; the scheme serves it only while it is on.
        set_enabled(&env.paths, "hello", false).unwrap();
        assert!(!installed(&env, "hello").unwrap().enabled);
        assert_eq!(active_version(&env.paths, "hello"), None);
        assert!(env.paths.installed().join("hello/1.0.0").is_dir() && data.is_dir());
        set_enabled(&env.paths, "hello", true).unwrap();
        assert_eq!(
            active_version(&env.paths, "hello").as_deref(),
            Some("1.0.0")
        );
        assert_eq!(
            set_enabled(&env.paths, "nope", true).unwrap_err().code,
            "not_found"
        );

        // Removed, data kept.
        remove(&env.paths, "hello", false).unwrap();
        assert!(installed(&env, "hello").is_none());
        assert!(!env.paths.installed().join("hello").exists());
        assert!(data.join("store.json").is_file() && secrets.join("token").is_file());
        assert_eq!(
            remove(&env.paths, "hello", true).unwrap_err().code,
            "not_found"
        );

        // Installed again and removed with its data: only its own two folders go.
        install_hello();
        plant();
        remove(&env.paths, "hello", true).unwrap();
        assert!(!data.exists() && !secrets.exists());
        assert!(keeper_data.join("store.json").is_file());
        assert!(other_secret.is_file() && signin.is_file());
        assert!(env.paths.installed().join("keeper/1.0.0").is_dir());
        assert!(installed(&env, "keeper").is_some());

        // A link planted where the plugin's folder goes is not followed.
        #[cfg(unix)]
        {
            let elsewhere = env.dir.path().join("elsewhere");
            fs::create_dir_all(&elsewhere).unwrap();
            std::os::unix::fs::symlink(&elsewhere, env.paths.installed().join("hello")).unwrap();
            let e = install(&env.paths, "local", "hello", &["network".into()]).unwrap_err();
            assert_eq!(
                e.message,
                "“hello” can’t be installed: its folder in the data folder is a link."
            );
            assert_eq!(count(&elsewhere), 0);
            fs::remove_file(env.paths.installed().join("hello")).unwrap();
        }
        // An id that isn't one deletes nothing.
        for bad in ["..", "../keeper", "", "Keeper"] {
            assert_eq!(
                remove(&env.paths, bad, true).unwrap_err().code,
                "invalid",
                "{bad}"
            );
        }
        assert!(keeper_data.is_dir());
    }
}
