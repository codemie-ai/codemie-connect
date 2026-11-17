//! Synthetic plugins and marketplaces for the plugin tests: temp folders only, never the network.
use super::git::Git;
use super::manifest::MANIFEST_FILE;
use super::market::{self, CATALOG_FILE};
use super::registry::{Market, PluginPaths};
use serde_json::{json, Value};
use std::path::{Path, PathBuf};
use std::sync::Mutex;

/// A data root, a private root and a folder for a local marketplace, in one temp folder.
pub struct Env {
    pub dir: tempfile::TempDir,
    pub paths: PluginPaths,
    pub private: PathBuf,
    /// Where `local_market` writes its marketplace.
    pub market: PathBuf,
}

pub fn env() -> Env {
    let dir = tempfile::tempdir().unwrap();
    let data = dir.path().join("data");
    let private = dir.path().join("private");
    std::fs::create_dir_all(&data).unwrap();
    std::fs::create_dir_all(&private).unwrap();
    Env {
        paths: PluginPaths::new(&data, &private),
        market: dir.path().join("market"),
        private,
        dir,
    }
}

/// Checks `ui/test/fixtures/contract/<name>` against a real answer, or writes it with
/// `UPDATE_CONTRACT_FIXTURES=1` (the UI's fixtures and the browser mock read these files).
pub fn contract_fixture(name: &str, value: &Value) {
    let dir = Path::new(env!("CARGO_MANIFEST_DIR")).join("../ui/test/fixtures/contract");
    let text = serde_json::to_string_pretty(value).unwrap() + "\n";
    let path = dir.join(name);
    if std::env::var("UPDATE_CONTRACT_FIXTURES").is_ok_and(|v| v == "1") {
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(&path, &text).unwrap();
    } else {
        let saved = std::fs::read_to_string(&path).unwrap_or_default();
        assert_eq!(
            saved, text,
            "{name} is stale: run UPDATE_CONTRACT_FIXTURES=1 cargo test contract_fixtures"
        );
    }
}

/// A manifest asking for nothing, with a host and a client half.
pub fn manifest(id: &str, version: &str) -> Value {
    let mut name = id.to_string();
    name[..1].make_ascii_uppercase();
    json!({
        "id": id, "name": name, "version": version, "echo": ">=0.9.9",
        "summary": format!("The {id} test plugin"), "main": "main.js", "client": "client.js",
    })
}

/// Writes a plugin folder: its manifest, `main.js`, `client.js` and `icon.svg`.
pub fn write_plugin(dir: &Path, manifest: Value) {
    std::fs::create_dir_all(dir).unwrap();
    std::fs::write(
        dir.join(MANIFEST_FILE),
        serde_json::to_vec_pretty(&manifest).unwrap(),
    )
    .unwrap();
    std::fs::write(dir.join("main.js"), "export function start(ctx) {}\n").unwrap();
    std::fs::write(dir.join("client.js"), "export function apply(ctx) {}\n").unwrap();
    std::fs::write(
        dir.join("icon.svg"),
        "<svg xmlns=\"http://www.w3.org/2000/svg\"/>\n",
    )
    .unwrap();
}

/// Writes `<root>/echo-marketplace.json` listing `(id, source)`; the first one is featured.
pub fn write_catalog(root: &Path, name: &str, entries: &[(&str, &str)]) {
    std::fs::create_dir_all(root).unwrap();
    let plugins: Vec<Value> = entries
        .iter()
        .map(|(id, source)| json!({"id": id, "source": source, "categories": ["test"]}))
        .collect();
    let featured: Vec<&str> = entries.iter().take(1).map(|(id, _)| *id).collect();
    let catalog = json!({"name": name, "owner": "tests", "featured": featured, "plugins": plugins});
    std::fs::write(
        root.join(CATALOG_FILE),
        serde_json::to_vec_pretty(&catalog).unwrap(),
    )
    .unwrap();
}

/// A local marketplace named `local` at `env.market` offering these manifests (each under
/// `plugins/<id>`), added to the registry.
pub fn local_market(env: &Env, manifests: &[Value]) -> Market {
    let mut entries = Vec::new();
    for m in manifests {
        let id = m["id"].as_str().unwrap().to_string();
        write_plugin(&env.market.join("plugins").join(&id), m.clone());
        entries.push((id.clone(), format!("./plugins/{id}")));
    }
    let entries: Vec<(&str, &str)> = entries
        .iter()
        .map(|(id, s)| (id.as_str(), s.as_str()))
        .collect();
    write_catalog(&env.market, "local", &entries);
    market::add(&env.paths, &NoGit, env.market.to_str().unwrap()).unwrap()
}

/// How many entries a folder has (0 when it isn't there).
pub fn count(dir: &Path) -> usize {
    std::fs::read_dir(dir).map(|d| d.count()).unwrap_or(0)
}

/// For tests that must never fetch.
pub struct NoGit;
impl Git for NoGit {
    fn clone_at(&self, url: &str, _: Option<&str>, _: &Path) -> Result<String, String> {
        panic!("a test tried to fetch {url}");
    }
}

/// "Clones" any address by copying one folder, and records what it was asked.
pub struct FakeGit {
    from: PathBuf,
    state: Mutex<FakeState>,
}

struct FakeState {
    calls: Vec<(String, Option<String>)>,
    commit: String,
    fail: Option<String>,
}

impl FakeGit {
    pub fn new(from: &Path, commit: &str) -> Self {
        Self {
            from: from.to_path_buf(),
            state: Mutex::new(FakeState {
                calls: Vec::new(),
                commit: commit.into(),
                fail: None,
            }),
        }
    }
    pub fn calls(&self) -> Vec<(String, Option<String>)> {
        self.state.lock().unwrap().calls.clone()
    }
    pub fn set_commit(&self, commit: &str) {
        self.state.lock().unwrap().commit = commit.into();
    }
    pub fn fail_with(&self, why: &str) {
        self.state.lock().unwrap().fail = Some(why.into());
    }
}

impl Git for FakeGit {
    fn clone_at(&self, url: &str, reference: Option<&str>, dest: &Path) -> Result<String, String> {
        let mut state = self.state.lock().unwrap();
        state
            .calls
            .push((url.to_string(), reference.map(str::to_string)));
        if let Some(why) = &state.fail {
            return Err(why.clone());
        }
        copy_dir(&self.from, dest);
        Ok(state.commit.clone())
    }
}

fn copy_dir(from: &Path, to: &Path) {
    std::fs::create_dir_all(to).unwrap();
    for entry in std::fs::read_dir(from).unwrap().flatten() {
        let target = to.join(entry.file_name());
        if entry.file_type().unwrap().is_dir() {
            copy_dir(&entry.path(), &target);
        } else {
            std::fs::copy(entry.path(), target).unwrap();
        }
    }
}
