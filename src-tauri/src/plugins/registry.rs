//! `<data root>/plugins/registry.json` (DESIGN 7.1): the marketplaces Connect knows and the plugins
//! installed from them. Every change re-reads the file under an exclusive `fs2` lock
//! (`registry.lock`) and writes it atomically, so two writers never undo each other and a reader
//! (the `connect-plugin` scheme) always sees a whole file.
//!
//! Layout under `<data root>/plugins/`:
//! - `registry.json`, `registry.lock`
//! - `markets/<name>-<hash8>/`: a git marketplace's clone (a local folder is read where it is)
//! - `installed/<id>/<version>/`: what is installed
//! - `tmp/<uuid>/`: clones and copies being checked, renamed into place when they pass
//! - `data/<id>/`: a plugin's own data, kept on remove unless the user asks
//!
//! A plugin's secrets live outside it, in `<private root>/credentials/plugins/<id>/`.
use crate::workspace::models::{Result, WorkspaceError};
use fs2::FileExt;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::BTreeMap;
use std::fs::{File, OpenOptions};
use std::io;
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

/// The marketplace every Connect has (DESIGN 7.1).
pub const BUILT_IN_NAME: &str = "onetest";
/// Its source, as `owner/repo` on GitHub.
pub const BUILT_IN_REPO: &str = "onetest-ai/echo-plugins";
/// How long a change waits for another one to finish.
const LOCK_WAIT: Duration = Duration::from_secs(30);

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
        let _ = std::fs::remove_dir_all(&self.0);
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
    /// The built-in marketplace's source.
    pub fn built_in() -> Self {
        Source::Git {
            url: format!("https://github.com/{BUILT_IN_REPO}"),
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
    /// The marketplace it came from (its name).
    pub market: String,
    /// That marketplace's source when it was installed.
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

#[derive(Debug, Default, Clone, PartialEq, Serialize, Deserialize)]
pub struct Registry {
    #[serde(default)]
    pub installed: BTreeMap<String, Installed>,
    /// The built-in marketplace first, then the ones the user added.
    #[serde(default)]
    pub markets: Vec<Market>,
}

impl Registry {
    /// The registry, or an empty one when there is none yet. The built-in marketplace is always
    /// listed first.
    pub fn load(paths: &PluginPaths) -> Result<Registry> {
        let mut reg = match std::fs::read(paths.registry()) {
            Ok(bytes) => serde_json::from_slice::<Registry>(&bytes).map_err(|e| {
                WorkspaceError::new(
                    "io",
                    format!("Connect couldn’t read its list of plugins (registry.json): {e}."),
                )
            })?,
            Err(e) if e.kind() == io::ErrorKind::NotFound => Registry::default(),
            Err(e) => return Err(io_error("read its list of plugins", &e)),
        };
        if !reg.markets.iter().any(|m| m.built_in) {
            reg.markets.insert(
                0,
                Market {
                    name: BUILT_IN_NAME.into(),
                    source: Source::built_in(),
                    built_in: true,
                    commit: None,
                    fetched_at: None,
                },
            );
        }
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

/// The registry held under its lock: changes are written with `save`, and the lock is released
/// when this is dropped.
pub struct Locked {
    _lock: File,
    paths: PluginPaths,
    pub reg: Registry,
}

impl Locked {
    /// Waits (at most `LOCK_WAIT`) for the lock, then reads the registry.
    pub fn take(paths: &PluginPaths) -> Result<Locked> {
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
        Ok(Locked {
            reg: Registry::load(paths)?,
            _lock: file,
            paths: paths.clone(),
        })
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
                                market: BUILT_IN_NAME.into(),
                                source: Source::built_in().text(),
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
        // The built-in marketplace is listed first, and written once.
        assert_eq!(reg.markets.len(), 1);
        assert!(reg.markets[0].built_in);
        assert_eq!(reg.markets[0].name, BUILT_IN_NAME);
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
    fn active_version_is_the_enabled_install_only() {
        let dir = tempfile::tempdir().unwrap();
        let paths = PluginPaths::new(dir.path(), dir.path());
        assert_eq!(active_version(&paths, "hello"), None);
        let entry = |enabled| Installed {
            version: "1.2.0".into(),
            market: BUILT_IN_NAME.into(),
            source: Source::built_in().text(),
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
