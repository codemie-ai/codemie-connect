//! `<data root>/plugins/registry.json` (DESIGN 7.1): the marketplaces Connect knows and the plugins
//! installed from them. Every change re-reads the file under an exclusive `fs2` lock
//! (`registry.lock`) and writes it atomically, so two writers never undo each other and a reader
//! (the `connect-plugin` scheme) always sees a whole file.
//!
//! Layout under `<data root>/plugins/`:
//! - `registry.json`, `registry.lock`
//! - `markets/<name>-<hash8>/`: a git marketplace's clone (a local folder is read where it is)
//! - `installed/<id>/<version>/`: what is installed
//! - `tmp/<uuid>/`: clones and copies being checked, renamed into place when they pass; entries
//!   older than an hour (left by a crash) are swept the first time the lock is taken, and a
//!   data-folder move leaves `tmp/` behind
//! - `data/<id>/`: a plugin's own data, kept on remove unless the user asks
//!
//! A plugin's secrets live outside it, in `<private root>/credentials/plugins/<id>/`.
use crate::workspace::models::{Result, WorkspaceError};
use fs2::FileExt;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, BTreeSet};
use std::fs::{File, OpenOptions};
use std::io;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::{Duration, Instant};

/// A marketplace every Connect has (DESIGN 7.1): its name, and its source as `owner/repo` on GitHub.
pub struct BuiltIn {
    pub name: &'static str,
    pub repo: &'static str,
}

/// The built-in marketplaces, listed first and in this order.
pub const BUILT_INS: [BuiltIn; 2] = [
    BuiltIn {
        name: "codemie",
        repo: "codemie-ai/codemie-connect-marketplace",
    },
    BuiltIn {
        name: "onetest",
        repo: "onetest-ai/echo-plugins",
    },
];
/// How long a change waits for another one to finish.
const LOCK_WAIT: Duration = Duration::from_secs(30);
/// The registry format this Connect writes; a newer one is refused, never rewritten.
pub const FORMAT: u32 = 1;
/// A `tmp/` entry this old was left by a crash.
const STALE_TMP: Duration = Duration::from_secs(60 * 60);

/// Where the plugin files of one data folder live.
#[derive(Debug, Clone)]
pub struct PluginPaths {
    /// `<data root>/plugins`.
    pub root: PathBuf,
    /// `<private root>/credentials/plugins`.
    pub secrets: PathBuf,
}

impl PluginPaths {
    pub fn new(data_root: &Path, private_root: &Path) -> Self {
        Self {
            root: data_root.join("plugins"),
            secrets: private_root.join("credentials").join("plugins"),
        }
    }
    pub fn registry(&self) -> PathBuf {
        self.root.join("registry.json")
    }
    pub fn lock(&self) -> PathBuf {
        self.root.join("registry.lock")
    }
    pub fn installed(&self) -> PathBuf {
        self.root.join("installed")
    }
    pub fn tmp(&self) -> PathBuf {
        self.root.join("tmp")
    }
    pub fn markets(&self) -> PathBuf {
        self.root.join("markets")
    }
    /// A plugin's own data. `id` must be a valid plugin id (`plugins::valid_id`).
    pub fn data_of(&self, id: &str) -> PathBuf {
        self.root.join("data").join(id)
    }
    /// A plugin's secrets. `id` must be a valid plugin id.
    pub fn secrets_of(&self, id: &str) -> PathBuf {
        self.secrets.join(id)
    }

    /// Creates the `plugins` folder inside an existing data root, never the data root itself: a
    /// data folder that went away reads as unavailable and is not recreated.
    pub fn ensure_root(&self) -> Result<()> {
        match std::fs::create_dir(&self.root) {
            Ok(()) => Ok(()),
            Err(e) if e.kind() == io::ErrorKind::AlreadyExists && self.root.is_dir() => Ok(()),
            Err(_) => Err(WorkspaceError::storage_unavailable()),
        }
    }

    /// A fresh, empty folder under `tmp/` for a clone or a copy being checked; it is deleted when
    /// dropped, so whatever wasn't moved out of it goes.
    pub fn fresh_tmp(&self) -> Result<TmpDir> {
        self.ensure_root()?;
        let dir = self.tmp().join(uuid::Uuid::new_v4().to_string());
        std::fs::create_dir_all(&dir)
            .map_err(|e| io_error("prepare a folder for the plugin", &e))?;
        Ok(TmpDir(dir))
    }
}

/// A folder under `<data root>/plugins/tmp/`, deleted on drop.
#[derive(Debug)]
pub struct TmpDir(PathBuf);

impl std::ops::Deref for TmpDir {
    type Target = Path;
    fn deref(&self) -> &Path {
        &self.0
    }
}

impl Drop for TmpDir {
    fn drop(&mut self) {
        if let Err(e) = super::tree::delete_path(&self.0) {
            log::warn!("plugins: {} stays behind: {e}", self.0.display());
        }
    }
}

/// Where a marketplace's catalog and plugins come from.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum Source {
    /// A folder on this computer, read where it is.
    Local { path: PathBuf },
    /// An `https://` git repository, cloned at `reference` (its default branch when `None`).
    Git {
        url: String,
        #[serde(rename = "ref", default, skip_serializing_if = "Option::is_none")]
        reference: Option<String>,
    },
}

impl Source {
    /// A built-in marketplace's source, from its `owner/repo`.
    pub fn built_in(repo: &str) -> Self {
        Source::Git {
            url: format!("https://github.com/{repo}"),
            reference: None,
        }
    }
    /// How the source is shown and recorded: the folder, or the address with `#ref`.
    pub fn text(&self) -> String {
        match self {
            Source::Local { path } => path.display().to_string(),
            Source::Git { url, reference } => match reference {
                Some(r) => format!("{url}#{r}"),
                None => url.clone(),
            },
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Market {
    /// Lowercase, a valid plugin-id-like name; unique among the markets.
    pub name: String,
    pub source: Source,
    #[serde(default)]
    pub built_in: bool,
    /// The commit of the last fetch (git only).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub commit: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub fetched_at: Option<String>,
}

impl Market {
    /// Where its catalog is read: the folder itself, or its clone.
    pub fn dir(&self, paths: &PluginPaths) -> PathBuf {
        match &self.source {
            Source::Local { path } => path.clone(),
            Source::Git { .. } => paths.markets().join(self.clone_name()),
        }
    }
    /// `<name>-<hash8>`: the clone's folder name, from the name and the source.
    pub fn clone_name(&self) -> String {
        let hash = Sha256::digest(self.source.text().as_bytes());
        let hex: String = hash.iter().take(4).map(|b| format!("{b:02x}")).collect();
        format!("{}-{hex}", self.name)
    }
}

/// One installed plugin.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Installed {
    pub version: String,
    /// The marketplace it came from (its name); empty for a plugin taken back after a reset.
    pub market: String,
    /// That marketplace's source (`Source::text`) when it was installed: with the name, what
    /// identifies the marketplace, since a removed marketplace's name can be given to another.
    pub source: String,
    /// The marketplace's commit (git) when it was installed.
    #[serde(default)]
    pub commit: Option<String>,
    /// `install::tree_hash` of the installed files.
    pub hash: String,
    pub enabled: bool,
    /// The keys of the permission sheet the user agreed to, sorted.
    pub agreed: Vec<String>,
    /// Each agreed line's words, so an update that changes what a line says (a new host, a new
    /// folder) asks again too.
    #[serde(default)]
    pub agreed_text: BTreeMap<String, String>,
    pub installed_at: String,
}

impl Installed {
    /// Whether it came from this very marketplace: the same name and the same source.
    pub fn from_market(&self, m: &Market) -> bool {
        self.market == m.name && self.source == m.source.text()
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Registry {
    /// `FORMAT` when written by this Connect.
    #[serde(default = "first_format")]
    pub format: u32,
    #[serde(default)]
    pub installed: BTreeMap<String, Installed>,
    /// The built-in marketplaces first, then the ones the user added.
    #[serde(default)]
    pub markets: Vec<Market>,
}

/// Where `source` stands among the built-ins, or `None` for a marketplace the user added.
fn built_in_rank(source: &Source) -> Option<usize> {
    BUILT_INS
        .iter()
        .position(|b| &Source::built_in(b.repo) == source)
}

/// `wanted`, or `wanted-2` … `wanted-9` when that name is taken.
pub(super) fn unique_name(reg: &Registry, wanted: &str) -> Result<String> {
    std::iter::once(wanted.to_string())
        .chain((2..=9).map(|n| format!("{wanted}-{n}")))
        .find(|n| super::valid_id(n) && reg.market(n).is_none())
        .ok_or_else(|| {
            WorkspaceError::new(
                "exists",
                format!("A marketplace named “{wanted}” is already added."),
            )
        })
}

fn first_format() -> u32 {
    1
}

impl Default for Registry {
    fn default() -> Self {
        Self {
            format: FORMAT,
            installed: BTreeMap::new(),
            markets: Vec::new(),
        }
    }
}

/// Why the registry can't be used, with what the user can do (`registry_reset`).
fn unreadable(why: &str) -> WorkspaceError {
    WorkspaceError::new(
        "registry_unreadable",
        format!(
            "Connect couldn’t read its list of plugins: {why}. Reset the list to start it again; \
             installed plugins are kept, turned off."
        ),
    )
}

impl Registry {
    /// The registry, or an empty one when there is none yet. The built-in marketplaces are always
    /// listed first, in `BUILT_INS` order. One is known by its source, not its name: a copy the
    /// user added by hand becomes the built-in and keeps its name, and a user marketplace that
    /// already has a built-in's name keeps it while the built-in takes the next free one. A file that can't be read, or one written by a newer Connect, is
    /// `registry_unreadable`.
    pub fn load(paths: &PluginPaths) -> Result<Registry> {
        let mut reg = match std::fs::read(paths.registry()) {
            Ok(bytes) => serde_json::from_slice::<Registry>(&bytes)
                .map_err(|e| unreadable(&format!("registry.json isn’t valid ({e})")))?,
            Err(e) if e.kind() == io::ErrorKind::NotFound => Registry::default(),
            Err(e) => return Err(io_error("read its list of plugins", &e)),
        };
        if reg.format > FORMAT {
            return Err(unreadable("it was written by a newer Connect"));
        }
        for m in &mut reg.markets {
            m.built_in = built_in_rank(&m.source).is_some();
        }
        for b in &BUILT_INS {
            let source = Source::built_in(b.repo);
            if reg.markets.iter().all(|m| m.source != source) {
                // With every name taken the built-in is left out, rather than failing every read.
                let Ok(name) = unique_name(&reg, b.name) else {
                    log::warn!("plugins: no free name for the built-in {}", b.name);
                    continue;
                };
                reg.markets.push(Market {
                    name,
                    source,
                    built_in: true,
                    commit: None,
                    fetched_at: None,
                });
            }
        }
        reg.markets
            .sort_by_key(|m| built_in_rank(&m.source).unwrap_or(BUILT_INS.len()));
        Ok(reg)
    }

    pub fn market(&self, name: &str) -> Option<&Market> {
        self.markets.iter().find(|m| m.name == name)
    }

    /// Re-reads the registry under the lock, applies `change` and writes the result; nothing is
    /// written when `change` fails.
    pub fn update<T>(
        paths: &PluginPaths,
        change: impl FnOnce(&mut Registry) -> Result<T>,
    ) -> Result<T> {
        let mut locked = Locked::take(paths)?;
        let out = change(&mut locked.reg)?;
        locked.save()?;
        Ok(out)
    }
}

/// The exclusive lock on `registry.lock`, released on drop.
pub struct RegistryLock {
    _held: File,
}

/// Waits (at most `LOCK_WAIT`) for the registry's lock. The first time in this process, stale
/// `tmp/` entries are swept under it.
pub fn lock(paths: &PluginPaths) -> Result<RegistryLock> {
    paths.ensure_root()?;
    let file = OpenOptions::new()
        .create(true)
        .truncate(false)
        .write(true)
        .open(paths.lock())
        .map_err(|e| io_error("open its plugin lock", &e))?;
    let start = Instant::now();
    while let Err(e) = file.try_lock_exclusive() {
        if e.raw_os_error() != fs2::lock_contended_error().raw_os_error() {
            return Err(io_error("lock its list of plugins", &e));
        }
        if start.elapsed() > LOCK_WAIT {
            return Err(WorkspaceError::new(
                "busy",
                "Connect is still changing your plugins. Try again in a moment.",
            ));
        }
        std::thread::sleep(Duration::from_millis(20));
    }
    sweep_tmp_once(paths);
    Ok(RegistryLock { _held: file })
}

/// Data roots whose `tmp/` was swept in this process.
static SWEPT: Mutex<BTreeSet<PathBuf>> = Mutex::new(BTreeSet::new());

/// Deletes `tmp/` entries older than an hour: what a crash left mid-clone or mid-copy. Work in
/// progress is younger (a fetch stops after a minute).
fn sweep_tmp_once(paths: &PluginPaths) {
    let first = SWEPT
        .lock()
        .map(|mut swept| swept.insert(paths.root.clone()))
        .unwrap_or(false);
    if !first {
        return;
    }
    let Ok(entries) = std::fs::read_dir(paths.tmp()) else {
        return;
    };
    for entry in entries.flatten() {
        let stale = entry
            .metadata()
            .and_then(|m| m.modified())
            .ok()
            .and_then(|t| t.elapsed().ok())
            .is_some_and(|age| age > STALE_TMP);
        if stale {
            if let Err(e) = super::tree::delete_path(&entry.path()) {
                log::warn!("plugins: {} stays behind: {e}", entry.path().display());
            }
        }
    }
}

/// The registry held under its lock: changes are written with `save`, and the lock is released
/// when this is dropped.
pub struct Locked {
    _lock: RegistryLock,
    paths: PluginPaths,
    pub reg: Registry,
}

impl Locked {
    /// Takes the lock, then reads the registry.
    pub fn take(paths: &PluginPaths) -> Result<Locked> {
        let lock = lock(paths)?;
        Ok(Locked {
            reg: Registry::load(paths)?,
            _lock: lock,
            paths: paths.clone(),
        })
    }

    /// A registry to write under a lock already taken (a reset, which can't read the old one).
    pub fn with(lock: RegistryLock, paths: &PluginPaths, reg: Registry) -> Locked {
        Locked {
            _lock: lock,
            paths: paths.clone(),
            reg,
        }
    }

    pub fn save(&self) -> Result<()> {
        let bytes = serde_json::to_vec_pretty(&self.reg)
            .map_err(|e| WorkspaceError::new("io", e.to_string()))?;
        crate::storage::location::write_atomic(&self.paths.registry(), &bytes)
            .map_err(|e| io_error("save its list of plugins", &e))
    }
}

/// The version the `connect-plugin` scheme serves for `id`: the installed one, while it is
/// enabled. Read without the lock: the file is only ever replaced whole.
pub fn active_version(paths: &PluginPaths, id: &str) -> Option<String> {
    let reg = Registry::load(paths).ok()?;
    reg.installed
        .get(id)
        .filter(|p| p.enabled)
        .map(|p| p.version.clone())
}

/// Now, as the registry records times.
pub fn now() -> String {
    chrono::Utc::now().format("%Y-%m-%dT%H:%M:%SZ").to_string()
}

/// A file-system failure as a sentence: "Connect couldn't <what>: <error>."
pub fn io_error(what: &str, e: &io::Error) -> WorkspaceError {
    WorkspaceError::new("io", format!("Connect couldn’t {what}: {e}."))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::{json, Value};

    const CODEMIE: &str = "codemie-ai/codemie-connect-marketplace";

    fn git_market(name: &str, url: &str, built_in: bool) -> Value {
        json!({"name": name, "source": {"kind": "git", "url": url}, "built_in": built_in})
    }

    /// The registry `load` gives for a registry.json holding `file`.
    fn load_written(file: Value) -> Registry {
        let dir = tempfile::tempdir().unwrap();
        let paths = PluginPaths::new(dir.path(), dir.path());
        std::fs::create_dir_all(&paths.root).unwrap();
        std::fs::write(paths.registry(), file.to_string()).unwrap();
        Registry::load(&paths).unwrap()
    }

    #[test]
    fn every_built_in_is_listed_first_in_order() {
        let dir = tempfile::tempdir().unwrap();
        let reg = Registry::load(&PluginPaths::new(dir.path(), dir.path())).unwrap();
        let names: Vec<_> = reg
            .markets
            .iter()
            .map(|m| (m.name.as_str(), m.built_in))
            .collect();
        assert_eq!(names, [("codemie", true), ("onetest", true)]);
        assert_eq!(reg.markets[0].source, Source::built_in(CODEMIE));
        assert_eq!(
            reg.markets[1].source,
            Source::built_in("onetest-ai/echo-plugins")
        );
    }

    #[test]
    fn an_older_registry_gets_the_new_built_in_before_the_others() {
        let reg = load_written(json!({
            "format": 1,
            "markets": [
                git_market("onetest", "https://github.com/onetest-ai/echo-plugins", true),
                git_market("acme", "https://github.com/acme/plugins", false),
            ],
            "installed": {"hello": {
                "version": "1.0.0", "market": "acme", "source": "https://github.com/acme/plugins",
                "hash": "h", "enabled": true, "agreed": [], "installed_at": "2026-11-01T00:00:00Z"
            }}
        }));
        let names: Vec<_> = reg.markets.iter().map(|m| m.name.as_str()).collect();
        assert_eq!(names, ["codemie", "onetest", "acme"]);
        assert!(!reg.market("acme").unwrap().built_in);
        assert_eq!(reg.installed["hello"].market, "acme");
    }

    #[test]
    fn a_hand_added_copy_becomes_the_built_in() {
        let reg = load_written(json!({"format": 1, "markets": [
            git_market("acme", "https://github.com/acme/plugins", false),
            git_market("connect", &format!("https://github.com/{CODEMIE}"), false),
        ]}));
        let ours: Vec<_> = reg
            .markets
            .iter()
            .filter(|m| m.source == Source::built_in(CODEMIE))
            .collect();
        assert_eq!(ours.len(), 1);
        assert_eq!((ours[0].name.as_str(), ours[0].built_in), ("connect", true));
        let names: Vec<_> = reg.markets.iter().map(|m| m.name.as_str()).collect();
        assert_eq!(names, ["connect", "onetest", "acme"]);
    }

    #[test]
    fn a_built_in_with_no_free_name_is_left_out_and_the_rest_still_load() {
        let taken: Vec<_> = std::iter::once("codemie".to_string())
            .chain((2..=9).map(|n| format!("codemie-{n}")))
            .map(|n| git_market(&n, &format!("https://github.com/acme/{n}"), false))
            .collect();
        let reg = load_written(json!({"format": 1, "markets": taken}));
        assert!(reg
            .markets
            .iter()
            .all(|m| m.source != Source::built_in(CODEMIE)));
        assert_eq!(reg.markets[0].name, "onetest");
        assert_eq!(reg.markets.len(), 10);
    }

    #[test]
    fn a_user_market_keeps_a_built_in_name() {
        let reg = load_written(json!({"format": 1, "markets": [
            git_market("codemie", "https://github.com/acme/plugins", false),
        ]}));
        assert!(!reg.market("codemie").unwrap().built_in);
        assert!(reg.market("codemie-2").unwrap().built_in);
        assert_eq!(reg.markets[0].name, "codemie-2");
    }

    #[test]
    fn concurrent_registry_writes_are_serialised() {
        let dir = tempfile::tempdir().unwrap();
        let paths = PluginPaths::new(dir.path(), dir.path());
        // Each writer reads, waits, then adds its own entry: without the lock the writers would
        // read the same registry and all but one entry would be lost.
        let writers: Vec<_> = (0..12)
            .map(|i| {
                let paths = paths.clone();
                std::thread::spawn(move || {
                    Registry::update(&paths, |r| {
                        let seen = r.installed.len();
                        std::thread::sleep(Duration::from_millis(5));
                        r.installed.insert(
                            format!("plugin-{i:02}"),
                            Installed {
                                version: "1.0.0".into(),
                                market: BUILT_INS[1].name.into(),
                                source: Source::built_in(BUILT_INS[1].repo).text(),
                                commit: None,
                                hash: seen.to_string(),
                                enabled: true,
                                agreed: vec![],
                                agreed_text: BTreeMap::new(),
                                installed_at: now(),
                            },
                        );
                        Ok(())
                    })
                    .unwrap()
                })
            })
            .collect();
        for w in writers {
            w.join().unwrap();
        }
        let reg = Registry::load(&paths).unwrap();
        assert_eq!(reg.installed.len(), 12);
        // Every writer saw the ones before it: the counts it read are 0..12, each once.
        let mut seen: Vec<usize> = reg
            .installed
            .values()
            .map(|p| p.hash.parse().unwrap())
            .collect();
        seen.sort_unstable();
        assert_eq!(seen, (0..12).collect::<Vec<_>>());
        // The built-in marketplaces are listed first, each written once.
        assert_eq!(reg.markets.len(), 2);
        assert!(reg.markets.iter().all(|m| m.built_in));
        assert_eq!(reg.markets[0].name, BUILT_INS[0].name);
        // No temporary file is left behind by the atomic writes.
        let leftovers: Vec<_> = std::fs::read_dir(&paths.root)
            .unwrap()
            .flatten()
            .map(|e| e.file_name().to_string_lossy().into_owned())
            .filter(|n| n != "registry.json" && n != "registry.lock")
            .collect();
        assert!(leftovers.is_empty(), "{leftovers:?}");
    }

    #[test]
    fn a_failed_change_writes_nothing_and_a_missing_data_root_is_not_created() {
        let dir = tempfile::tempdir().unwrap();
        let paths = PluginPaths::new(dir.path(), dir.path());
        let r: Result<()> = Registry::update(&paths, |r| {
            r.markets.clear();
            Err(WorkspaceError::new("invalid", "no"))
        });
        assert!(r.is_err());
        assert!(!paths.registry().exists());
        // A data root that went away is not recreated.
        let gone = PluginPaths::new(&dir.path().join("gone"), dir.path());
        let err = Registry::update(&gone, |_| Ok(())).unwrap_err();
        assert_eq!(err.code, "storage_unavailable");
        assert!(!dir.path().join("gone").exists());
    }

    #[test]
    fn a_corrupt_or_newer_registry_is_unreadable() {
        let dir = tempfile::tempdir().unwrap();
        let paths = PluginPaths::new(dir.path(), dir.path());
        std::fs::create_dir_all(&paths.root).unwrap();
        for (text, why) in [
            ("{not json", "registry.json isn’t valid"),
            (
                r#"{"format": 2, "installed": {}}"#,
                "written by a newer Connect",
            ),
            (
                r#"{"installed": {"x": {"version": 1}}}"#,
                "registry.json isn’t valid",
            ),
        ] {
            std::fs::write(paths.registry(), text).unwrap();
            let e = Registry::load(&paths).unwrap_err();
            assert_eq!(e.code, "registry_unreadable", "{text}");
            assert!(e.message.contains(why), "{}", e.message);
            assert!(e.message.contains("Reset the list"), "{}", e.message);
            // Nothing is written over it, and nothing is served from it.
            assert_eq!(
                Registry::update(&paths, |_| Ok(())).unwrap_err().code,
                "registry_unreadable"
            );
            assert_eq!(std::fs::read_to_string(paths.registry()).unwrap(), text);
            assert_eq!(active_version(&paths, "x"), None);
        }
        // An older file without a format is this format.
        std::fs::write(paths.registry(), r#"{"installed": {}}"#).unwrap();
        assert_eq!(Registry::load(&paths).unwrap().format, FORMAT);
    }

    #[test]
    fn stale_tmp_entries_are_swept_the_first_time_the_lock_is_taken() {
        let dir = tempfile::tempdir().unwrap();
        let paths = PluginPaths::new(dir.path(), dir.path());
        let old = paths.tmp().join("crashed");
        let young = paths.tmp().join("working");
        std::fs::create_dir_all(old.join("clone")).unwrap();
        std::fs::create_dir_all(&young).unwrap();
        let then = std::time::SystemTime::now() - Duration::from_secs(2 * 60 * 60);
        File::open(&old).unwrap().set_modified(then).unwrap();
        drop(lock(&paths).unwrap());
        assert!(!old.exists());
        assert!(young.is_dir());
        // Only once per data root in a process.
        std::fs::create_dir_all(&old).unwrap();
        File::open(&old).unwrap().set_modified(then).unwrap();
        drop(lock(&paths).unwrap());
        assert!(old.is_dir());
    }

    #[test]
    fn active_version_is_the_enabled_install_only() {
        let dir = tempfile::tempdir().unwrap();
        let paths = PluginPaths::new(dir.path(), dir.path());
        assert_eq!(active_version(&paths, "hello"), None);
        let entry = |enabled| Installed {
            version: "1.2.0".into(),
            market: BUILT_INS[1].name.into(),
            source: Source::built_in(BUILT_INS[1].repo).text(),
            commit: None,
            hash: "h".into(),
            enabled,
            agreed: vec![],
            agreed_text: BTreeMap::new(),
            installed_at: now(),
        };
        Registry::update(&paths, |r| {
            r.installed.insert("hello".into(), entry(true));
            Ok(())
        })
        .unwrap();
        assert_eq!(active_version(&paths, "hello").as_deref(), Some("1.2.0"));
        assert_eq!(active_version(&paths, "other"), None);
        Registry::update(&paths, |r| {
            r.installed.insert("hello".into(), entry(false));
            Ok(())
        })
        .unwrap();
        assert_eq!(active_version(&paths, "hello"), None);
    }
}
