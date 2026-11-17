//! Marketplaces (DESIGN 7.1): where plugins come from. A marketplace is a folder or a git
//! repository with `echo-marketplace.json` at its root:
//! `{name, featured: [id], plugins: [{id, source: "./plugins/<id>", categories}]}`.
//!
//! Sources the user can add:
//! - a local folder (its full path), read where it is;
//! - an `https://` git address (`#ref` picks a branch, tag or commit) or GitHub's `owner/repo[@ref]`,
//!   cloned with `git clone --depth 1` into `<data root>/plugins/markets/<name>-<hash8>/`;
//! - the built-in `onetest` (`onetest-ai/echo-plugins`), listed from the start and fetched only
//!   when the user asks.
//!
//! Connect reaches the network only when the user adds or refreshes a git marketplace. Every
//! other address (http, ssh, git, file) is refused, here and again by git's own protocol allowlist.
use super::install::open_plain;
use super::registry::{io_error, now, Locked, Market, PluginPaths, Registry, Source};
use crate::workspace::models::{Result, WorkspaceError};
use serde::Deserialize;
use serde_json::Value;
use std::ffi::OsString;
use std::io::{self, Read};
use std::path::{Component, Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

/// The catalog file at a marketplace's root.
pub const CATALOG_FILE: &str = "echo-marketplace.json";
const MAX_CATALOG_BYTES: u64 = 256 * 1024;
const MAX_CATALOG_PLUGINS: usize = 200;
/// How long a fetch may take.
pub const GIT_TIMEOUT: Duration = Duration::from_secs(60);

fn invalid(message: impl Into<String>) -> WorkspaceError {
    WorkspaceError::new("invalid", message)
}

// ------------------------------------------------------------------ sources

const SOURCE_HELP: &str =
    "Enter a marketplace as an https:// address, owner/repo on GitHub, or a folder’s full path.";
const HTTPS_ONLY: &str =
    "Connect fetches marketplaces over https:// only. Use the repository’s https:// address.";

/// Reads what the user typed as a marketplace source.
pub fn parse_source(text: &str) -> Result<Source> {
    let t = text.trim();
    if t.is_empty() || t.chars().any(char::is_control) {
        return Err(invalid(SOURCE_HELP));
    }
    if t == super::registry::BUILT_IN_NAME {
        return Ok(Source::built_in());
    }
    if Path::new(t).is_absolute() {
        return Ok(Source::Local {
            path: PathBuf::from(t),
        });
    }
    if let Some((scheme, _)) = t.split_once("://") {
        if !scheme.eq_ignore_ascii_case("https") {
            return Err(invalid(HTTPS_ONLY));
        }
        return parse_https(t);
    }
    // scp-like ssh (`git@github.com:owner/repo.git`).
    if t.contains('@') && t.split('@').nth(1).is_some_and(|rest| rest.contains(':')) {
        return Err(invalid(HTTPS_ONLY));
    }
    let (repo, reference) = match t.split_once('@') {
        Some((repo, r)) => (repo, Some(r)),
        None => (t, None),
    };
    if let Some((owner, name)) = repo.split_once('/') {
        if is_owner(owner) && is_repo(name) {
            return Ok(Source::Git {
                url: format!("https://github.com/{owner}/{name}"),
                reference: checked_ref(reference)?,
            });
        }
    }
    if t.starts_with('~') || t.starts_with('.') {
        return Err(invalid("Give the folder’s full path, starting with /."));
    }
    Err(invalid(SOURCE_HELP))
}

fn parse_https(t: &str) -> Result<Source> {
    let url = url::Url::parse(t).map_err(|_| invalid(SOURCE_HELP))?;
    if url.scheme() != "https" {
        return Err(invalid(HTTPS_ONLY));
    }
    if !url.username().is_empty() || url.password().is_some() {
        return Err(invalid(
            "Leave sign-in details out of the address: Connect fetches public repositories only.",
        ));
    }
    if url.host_str().is_none() || url.query().is_some() || url.path().trim_matches('/').is_empty()
    {
        return Err(invalid(SOURCE_HELP));
    }
    let reference = checked_ref(url.fragment())?;
    let mut bare = url.clone();
    bare.set_fragment(None);
    Ok(Source::Git {
        url: bare.as_str().trim_end_matches('/').to_string(),
        reference,
    })
}

/// A GitHub owner: letters, digits and single dashes inside.
fn is_owner(s: &str) -> bool {
    (1..=39).contains(&s.len())
        && !s.starts_with('-')
        && s.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-')
}

fn is_repo(s: &str) -> bool {
    (1..=100).contains(&s.len())
        && s != "."
        && s != ".."
        && s.bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'.' | b'_' | b'-'))
}

/// A plain branch, tag or commit: never an option (`-x`), a path out (`..`) or anything a shell
/// or git would read specially.
fn checked_ref(reference: Option<&str>) -> Result<Option<String>> {
    let Some(r) = reference else {
        return Ok(None);
    };
    let ok = (1..=100).contains(&r.len())
        && !r.starts_with(['-', '/', '.'])
        && !r.ends_with(['/', '.'])
        && !r.contains("..")
        && !r.ends_with(".lock")
        && r.bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'.' | b'_' | b'-' | b'/'));
    if ok {
        Ok(Some(r.to_string()))
    } else {
        Err(invalid(format!(
            "“{}” isn’t a plain branch, tag or commit.",
            r.escape_debug()
        )))
    }
}

// ---------------------------------------------------------------------- git

/// Fetches a marketplace. The real one is `CliGit`; tests use a stand-in so they never reach
/// the network.
pub trait Git: Send + Sync {
    /// Clones `url` at `reference` (its default branch when `None`) into `dest`, which doesn't
    /// exist yet, and returns the commit it checked out. The error is git's reason, one line.
    fn clone_at(
        &self,
        url: &str,
        reference: Option<&str>,
        dest: &Path,
    ) -> std::result::Result<String, String>;
}

/// The `git` command line.
pub struct CliGit {
    pub program: PathBuf,
    pub timeout: Duration,
}

impl Default for CliGit {
    fn default() -> Self {
        Self {
            program: PathBuf::from("git"),
            timeout: GIT_TIMEOUT,
        }
    }
}

#[cfg(windows)]
const NO_HOOKS: &str = "core.hooksPath=NUL";
#[cfg(not(windows))]
const NO_HOOKS: &str = "core.hooksPath=/dev/null";

/// Settings every git call runs with: no hooks, https only (git refuses file, ssh, git and http
/// itself, redirects included), no stored or prompted credentials, links checked out as plain
/// files, no submodules, no filesystem monitor.
fn hardening() -> Vec<OsString> {
    [
        NO_HOOKS,
        "protocol.allow=never",
        "protocol.https.allow=always",
        "credential.helper=",
        "core.askPass=",
        "core.symlinks=false",
        "core.fsmonitor=false",
        "submodule.recurse=false",
    ]
    .iter()
    .flat_map(|setting| [OsString::from("-c"), OsString::from(setting)])
    .collect()
}

/// `git clone --depth 1` of one branch, tag or commit, never its submodules.
pub fn clone_args(url: &str, reference: Option<&str>, dest: &Path) -> Vec<OsString> {
    let mut args = hardening();
    args.extend(["clone", "--depth", "1", "--no-recurse-submodules"].map(OsString::from));
    if let Some(r) = reference {
        args.extend([OsString::from("--branch"), OsString::from(r)]);
    }
    args.extend([OsString::from("--"), OsString::from(url), dest.into()]);
    args
}

impl Git for CliGit {
    fn clone_at(
        &self,
        url: &str,
        reference: Option<&str>,
        dest: &Path,
    ) -> std::result::Result<String, String> {
        let parent = dest.parent().ok_or("no folder to clone into")?;
        self.run(&clone_args(url, reference, dest), parent)?;
        self.head(dest)
    }
}

impl CliGit {
    /// The commit checked out in `repo`.
    fn head(&self, repo: &Path) -> std::result::Result<String, String> {
        let mut args = hardening();
        args.extend(["rev-parse", "HEAD"].map(OsString::from));
        let commit = self.run(&args, repo)?.trim().to_string();
        let hex = |s: &str| s.bytes().all(|b| b.is_ascii_hexdigit());
        if (commit.len() == 40 || commit.len() == 64) && hex(&commit) {
            Ok(commit.to_ascii_lowercase())
        } else {
            Err("git didn’t say which commit it fetched".into())
        }
    }

    /// Runs git in `cwd` with no terminal, no askpass and no credential prompts, at most
    /// `timeout`; returns its output, or the last line of its complaint.
    fn run(&self, args: &[OsString], cwd: &Path) -> std::result::Result<String, String> {
        let mut child = Command::new(&self.program)
            .args(args)
            .current_dir(cwd)
            .env("GIT_TERMINAL_PROMPT", "0")
            .env("GIT_LFS_SKIP_SMUDGE", "1")
            .env_remove("GIT_ASKPASS")
            .env_remove("SSH_ASKPASS")
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .map_err(|e| {
                if e.kind() == io::ErrorKind::NotFound {
                    "Connect needs git to fetch marketplaces; install it, then try again".into()
                } else {
                    e.to_string()
                }
            })?;
        let drain = |pipe: Option<Box<dyn Read + Send>>| {
            std::thread::spawn(move || {
                let mut kept = Vec::new();
                if let Some(mut pipe) = pipe {
                    let _ = (&mut pipe).take(64 * 1024).read_to_end(&mut kept);
                    let _ = io::copy(&mut pipe, &mut io::sink());
                }
                kept
            })
        };
        let out = drain(
            child
                .stdout
                .take()
                .map(|p| Box::new(p) as Box<dyn Read + Send>),
        );
        let err = drain(
            child
                .stderr
                .take()
                .map(|p| Box::new(p) as Box<dyn Read + Send>),
        );
        let start = Instant::now();
        let status = loop {
            match child.try_wait() {
                Ok(Some(status)) => break status,
                Ok(None) if start.elapsed() > self.timeout => {
                    let _ = child.kill();
                    let _ = child.wait();
                    return Err(format!(
                        "it took longer than {} seconds",
                        self.timeout.as_secs()
                    ));
                }
                Ok(None) => std::thread::sleep(Duration::from_millis(25)),
                Err(e) => return Err(e.to_string()),
            }
        };
        let stdout = out.join().unwrap_or_default();
        let stderr = err.join().unwrap_or_default();
        if status.success() {
            return Ok(String::from_utf8_lossy(&stdout).into_owned());
        }
        let text = String::from_utf8_lossy(&stderr);
        let reason = text
            .lines()
            .map(str::trim)
            .rfind(|l| !l.is_empty())
            .unwrap_or("git failed");
        let reason = reason
            .strip_prefix("fatal: ")
            .or_else(|| reason.strip_prefix("error: "))
            .unwrap_or(reason);
        Err(reason
            .chars()
            .filter(|c| !c.is_control())
            .take(200)
            .collect())
    }
}

// ------------------------------------------------------------------ catalog

#[derive(Debug, Clone, Deserialize)]
pub struct Catalog {
    #[serde(default)]
    pub name: String,
    #[serde(default)]
    pub featured: Vec<String>,
    #[serde(default)]
    pub plugins: Vec<CatalogEntry>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct CatalogEntry {
    pub id: String,
    /// The plugin's folder, relative to the marketplace's root.
    pub source: Value,
    #[serde(default)]
    pub categories: Vec<Value>,
}

impl CatalogEntry {
    /// Its categories that are plain words; anything else is left out.
    pub fn categories(&self) -> Vec<String> {
        self.categories
            .iter()
            .filter_map(Value::as_str)
            .filter(|c| {
                (1..=24).contains(&c.len())
                    && c.bytes()
                        .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
            })
            .take(8)
            .map(str::to_string)
            .collect()
    }
}

/// Reads `<root>/echo-marketplace.json`: a plain file (not a link), at most 256 KB.
pub fn read_catalog(root: &Path) -> Result<Catalog> {
    let path = root.join(CATALOG_FILE);
    let missing = || invalid(format!("That marketplace has no {CATALOG_FILE}."));
    let mut file = open_plain(&path).map_err(|_| missing())?;
    let mut bytes = Vec::new();
    (&mut file)
        .take(MAX_CATALOG_BYTES + 1)
        .read_to_end(&mut bytes)
        .map_err(|_| missing())?;
    if bytes.len() as u64 > MAX_CATALOG_BYTES {
        return Err(invalid(format!(
            "Its {CATALOG_FILE} is larger than 256 KB."
        )));
    }
    let catalog: Catalog = serde_json::from_slice(&bytes)
        .map_err(|e| invalid(format!("Its {CATALOG_FILE} isn’t valid: {e}.")))?;
    if catalog.plugins.len() > MAX_CATALOG_PLUGINS {
        return Err(invalid(format!(
            "Its {CATALOG_FILE} lists more than {MAX_CATALOG_PLUGINS} plugins."
        )));
    }
    Ok(catalog)
}

/// The folder a catalog entry names: a relative path inside the marketplace (no `..`, nothing
/// absolute) that stays inside it once every link is resolved.
pub fn entry_dir(root: &Path, source: &Value) -> std::result::Result<PathBuf, String> {
    let outside = || "its folder isn’t inside the marketplace".to_string();
    let rel = source.as_str().ok_or_else(outside)?;
    let rel = rel.strip_prefix("./").unwrap_or(rel).trim_end_matches('/');
    let p = Path::new(rel);
    if rel.is_empty()
        || rel.chars().any(|c| c.is_control() || c == '\\')
        || p.is_absolute()
        || !p.components().all(|c| matches!(c, Component::Normal(_)))
    {
        return Err(outside());
    }
    let base = dunce::canonicalize(root).map_err(|_| outside())?;
    let dir = dunce::canonicalize(base.join(p)).map_err(|_| outside())?;
    if dir.starts_with(&base) && dir != base && dir.is_dir() {
        Ok(dir)
    } else {
        Err(outside())
    }
}

/// Whether a marketplace's catalog can be read now: a git one has been fetched, a folder is there.
pub fn is_ready(paths: &PluginPaths, market: &Market) -> bool {
    market.dir(paths).join(CATALOG_FILE).is_file()
}

/// A marketplace's catalog, or why it can't be read yet.
pub fn catalog_of(paths: &PluginPaths, market: &Market) -> Result<Catalog> {
    if !is_ready(paths, market) {
        return Err(match market.source {
            Source::Git { .. } => WorkspaceError::new(
                "not_fetched",
                format!("Refresh the “{}” marketplace first.", market.name),
            ),
            Source::Local { ref path } => WorkspaceError::new(
                "not_found",
                format!(
                    "The folder of the “{}” marketplace isn’t there any more ({}).",
                    market.name,
                    path.display()
                ),
            ),
        });
    }
    read_catalog(&market.dir(paths))
}

/// The catalog entry for plugin `id` in `market`, and its folder.
pub fn plugin_dir(
    paths: &PluginPaths,
    market: &Market,
    id: &str,
) -> Result<(CatalogEntry, PathBuf)> {
    let catalog = catalog_of(paths, market)?;
    let entry = catalog
        .plugins
        .into_iter()
        .find(|e| e.id == id)
        .ok_or_else(|| {
            WorkspaceError::new(
                "not_found",
                format!("The “{}” marketplace has no plugin “{id}”.", market.name),
            )
        })?;
    let dir = entry_dir(&market.dir(paths), &entry.source).map_err(|why| {
        WorkspaceError::new("refused", format!("“{id}” can’t be installed: {why}."))
    })?;
    Ok((entry, dir))
}

// ------------------------------------------------------------------ markets

/// A marketplace name from its catalog: lowercase, a-z 0-9 and `-`.
fn name_from(catalog: &Catalog) -> Result<String> {
    let mut slug = String::new();
    for c in catalog.name.trim().chars() {
        if c.is_ascii_alphanumeric() {
            slug.push(c.to_ascii_lowercase());
        } else if !slug.ends_with('-') {
            slug.push('-');
        }
    }
    let slug = slug.trim_matches('-').to_string();
    if super::valid_id(&slug) {
        Ok(slug)
    } else {
        Err(invalid(format!(
            "Its {CATALOG_FILE} gives it no name Connect can use (a-z, 0-9, -)."
        )))
    }
}

/// `wanted`, or `wanted-2` … `wanted-9` when that name is taken.
fn unique_name(reg: &Registry, wanted: &str) -> Result<String> {
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

fn already_added(reg: &Registry, source: &Source) -> Result<()> {
    match reg.markets.iter().find(|m| &m.source == source) {
        Some(m) => Err(WorkspaceError::new(
            "exists",
            format!("That marketplace is already added, as “{}”.", m.name),
        )),
        None => Ok(()),
    }
}

fn fetch_error(source: &Source, why: String) -> WorkspaceError {
    WorkspaceError::new(
        "fetch_failed",
        format!("Connect couldn’t fetch {}: {why}.", source.text()),
    )
}

/// Adds a marketplace: reads a folder's catalog where it is, or clones a git one.
pub fn add(paths: &PluginPaths, git: &dyn Git, text: &str) -> Result<Market> {
    let source = match parse_source(text)? {
        Source::Local { path } => {
            let path = dunce::canonicalize(&path)
                .ok()
                .filter(|p| p.is_dir())
                .ok_or_else(|| invalid(format!("There is no folder {}.", path.display())))?;
            Source::Local { path }
        }
        git => git,
    };
    already_added(&Registry::load(paths)?, &source)?;
    let fetched = match &source {
        Source::Local { path } => {
            let catalog = read_catalog(path)?;
            (catalog, None)
        }
        Source::Git { url, reference } => {
            let tmp = paths.fresh_tmp()?;
            let dest = tmp.join("clone");
            let commit = git
                .clone_at(url, reference.as_deref(), &dest)
                .map_err(|why| fetch_error(&source, why))?;
            (read_catalog(&dest)?, Some((tmp, dest, commit)))
        }
    };
    let (catalog, clone) = fetched;
    let wanted = name_from(&catalog)?;
    let mut locked = Locked::take(paths)?;
    already_added(&locked.reg, &source)?;
    let market = Market {
        name: unique_name(&locked.reg, &wanted)?,
        source,
        built_in: false,
        commit: clone.as_ref().map(|(_, _, c)| c.clone()),
        fetched_at: Some(now()),
    };
    // A clone folder left by an earlier attempt is moved aside and deleted.
    let stale = match &clone {
        Some((_tmp, dest, _)) => place_clone(paths, &market, dest)?,
        None => None,
    };
    locked.reg.markets.push(market.clone());
    locked.save()?;
    drop(locked);
    if let Some(stale) = stale {
        let _ = std::fs::remove_dir_all(stale);
    }
    Ok(market)
}

/// Moves a checked clone to the marketplace's folder; a previous clone there is returned (moved
/// aside under `tmp/`) so the caller can delete it once the registry points at the new one.
fn place_clone(paths: &PluginPaths, market: &Market, clone: &Path) -> Result<Option<PathBuf>> {
    let target = market.dir(paths);
    std::fs::create_dir_all(paths.markets())
        .map_err(|e| io_error("prepare the marketplaces folder", &e))?;
    let old = if target.exists() {
        let aside = paths.tmp().join(uuid::Uuid::new_v4().to_string());
        std::fs::rename(&target, &aside)
            .map_err(|e| io_error("replace the marketplace’s files", &e))?;
        Some(aside)
    } else {
        None
    };
    if let Err(e) = std::fs::rename(clone, &target) {
        if let Some(aside) = &old {
            let _ = std::fs::rename(aside, &target);
        }
        return Err(io_error("store the marketplace’s files", &e));
    }
    Ok(old)
}

/// Fetches a git marketplace again into a fresh clone, then swaps it in. A folder is only read
/// again.
pub fn refresh(paths: &PluginPaths, git: &dyn Git, name: &str) -> Result<Market> {
    let market = Registry::load(paths)?
        .market(name)
        .cloned()
        .ok_or_else(|| no_market(name))?;
    let (commit, clone) = match &market.source {
        Source::Local { path } => {
            read_catalog(path)?;
            (None, None)
        }
        Source::Git { url, reference } => {
            let tmp = paths.fresh_tmp()?;
            let dest = tmp.join("clone");
            let commit = git
                .clone_at(url, reference.as_deref(), &dest)
                .map_err(|why| fetch_error(&market.source, why))?;
            read_catalog(&dest)?;
            (Some(commit), Some((tmp, dest)))
        }
    };
    let mut locked = Locked::take(paths)?;
    let current = locked
        .reg
        .markets
        .iter_mut()
        .find(|m| m.name == name && m.source == market.source)
        .ok_or_else(|| no_market(name))?;
    let old = match &clone {
        Some((_tmp, dest)) => place_clone(paths, current, dest)?,
        None => None,
    };
    current.commit = commit.or(current.commit.take());
    current.fetched_at = Some(now());
    let updated = current.clone();
    locked.save()?;
    drop(locked);
    if let Some(old) = old {
        let _ = std::fs::remove_dir_all(old);
    }
    Ok(updated)
}

/// Removes a marketplace the user added, and its clone. Its installed plugins stay installed;
/// a folder marketplace's own folder is never touched.
pub fn remove(paths: &PluginPaths, name: &str) -> Result<()> {
    let mut locked = Locked::take(paths)?;
    let at = locked
        .reg
        .markets
        .iter()
        .position(|m| m.name == name)
        .ok_or_else(|| no_market(name))?;
    if locked.reg.markets[at].built_in {
        return Err(invalid("The built-in marketplace can’t be removed."));
    }
    let market = locked.reg.markets.remove(at);
    locked.save()?;
    if let Source::Git { .. } = market.source {
        let _ = std::fs::remove_dir_all(market.dir(paths));
    }
    Ok(())
}

pub fn no_market(name: &str) -> WorkspaceError {
    WorkspaceError::new(
        "not_found",
        format!("There is no marketplace “{}”.", name.escape_debug()),
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::plugins::testkit::{self, FakeGit};

    #[test]
    fn market_add_expands_owner_repo_and_rejects_http_and_ssh() {
        let gh = |url: &str, r: Option<&str>| Source::Git {
            url: url.into(),
            reference: r.map(str::to_string),
        };
        for (text, want) in [
            (
                "acme-corp/connect-plugins",
                gh("https://github.com/acme-corp/connect-plugins", None),
            ),
            (
                " acme/plugins@v1.2 ",
                gh("https://github.com/acme/plugins", Some("v1.2")),
            ),
            (
                "acme/plugins.git@release/2026",
                gh("https://github.com/acme/plugins.git", Some("release/2026")),
            ),
            (
                "https://gitlab.example.com/team/plugins.git",
                gh("https://gitlab.example.com/team/plugins.git", None),
            ),
            (
                "https://gitlab.example.com/team/plugins/#stable",
                gh("https://gitlab.example.com/team/plugins", Some("stable")),
            ),
            ("onetest", Source::built_in()),
            (
                "/Users/taylor/plugins",
                Source::Local {
                    path: "/Users/taylor/plugins".into(),
                },
            ),
        ] {
            assert_eq!(parse_source(text).unwrap(), want, "{text}");
        }
        assert_eq!(
            Source::built_in(),
            gh("https://github.com/onetest-ai/echo-plugins", None)
        );
        for bad in [
            "http://github.com/acme/plugins",
            "HTTP://github.com/acme/plugins",
            "ssh://git@github.com/acme/plugins.git",
            "git@github.com:acme/plugins.git",
            "git://github.com/acme/plugins",
            "file:///tmp/plugins",
            "https://user:secret@github.com/acme/plugins",
            "https://token@github.com/acme/plugins",
            "https://github.com/acme/plugins?x=1",
            "https://github.com/",
            "acme/plugins@-u",
            "acme/plugins@../x",
            "acme/plugins@a b",
            "-acme/plugins",
            "acme/../plugins",
            "acme/plugins/extra",
            "plugins",
            "./plugins",
            "~/plugins",
            "",
            "acme/plu\ngins",
        ] {
            let e = parse_source(bad).unwrap_err();
            assert_eq!(e.code, "invalid", "{bad}");
        }
        assert!(parse_source("ssh://x/y")
            .unwrap_err()
            .message
            .contains("https://"));

        // Adding one: the shorthand reaches git as the https address, at the ref.
        let env = testkit::env();
        let upstream = env.dir.path().join("upstream");
        testkit::write_catalog(&upstream, "Acme", &[("hello", "./plugins/hello")]);
        testkit::write_plugin(
            &upstream.join("plugins/hello"),
            testkit::manifest("hello", "1.0.0"),
        );
        let git = FakeGit::new(&upstream, "a1b2c3");
        let m = add(&env.paths, &git, "acme-corp/connect-plugins@stable").unwrap();
        assert_eq!(
            git.calls(),
            [(
                "https://github.com/acme-corp/connect-plugins".to_string(),
                Some("stable".to_string())
            )]
        );
        assert_eq!(m.name, "acme");
        assert_eq!(m.commit.as_deref(), Some("a1b2c3"));
        assert!(m.fetched_at.is_some());
        let clone = env.paths.markets().join(m.clone_name());
        assert!(m.clone_name().starts_with("acme-") && m.clone_name().len() == 13);
        assert!(clone.join(CATALOG_FILE).is_file());
        assert!(clone.join("plugins/hello/echo-plugin.json").is_file());
        assert_eq!(m.dir(&env.paths), clone);
        // Nothing is left in tmp.
        assert_eq!(testkit::count(&env.paths.tmp()), 0);
        let reg = Registry::load(&env.paths).unwrap();
        assert_eq!(
            reg.markets
                .iter()
                .map(|m| m.name.as_str())
                .collect::<Vec<_>>(),
            ["onetest", "acme"]
        );

        // The same source again, and the built-in one, are already there; refused sources never
        // reach git.
        for again in [
            "acme-corp/connect-plugins@stable",
            "onetest",
            "onetest-ai/echo-plugins",
        ] {
            assert_eq!(
                add(&env.paths, &git, again).unwrap_err().code,
                "exists",
                "{again}"
            );
        }
        for bad in [
            "http://example.com/plugins",
            "ssh://git@github.com/acme/plugins",
            "git@github.com:acme/plugins.git",
            "file:///tmp/plugins",
        ] {
            assert_eq!(
                add(&env.paths, &git, bad).unwrap_err().code,
                "invalid",
                "{bad}"
            );
        }
        assert_eq!(git.calls().len(), 1);

        // Another source whose catalog has the same name gets the next free name.
        let m2 = add(&env.paths, &git, "acme-corp/other").unwrap();
        assert_eq!(m2.name, "acme-2");

        // Refresh fetches into a fresh clone and swaps it in.
        std::fs::write(upstream.join("plugins/hello/new.txt"), "new").unwrap();
        git.set_commit("d4e5f6");
        let r = refresh(&env.paths, &git, "acme").unwrap();
        assert_eq!(r.commit.as_deref(), Some("d4e5f6"));
        assert!(clone.join("plugins/hello/new.txt").is_file());
        assert_eq!(testkit::count(&env.paths.tmp()), 0);

        // A fetch that fails says why, and leaves nothing behind.
        git.fail_with("repository not found");
        let e = add(&env.paths, &git, "acme/missing").unwrap_err();
        assert_eq!(e.code, "fetch_failed");
        assert_eq!(
            e.message,
            "Connect couldn’t fetch https://github.com/acme/missing: repository not found."
        );
        assert_eq!(testkit::count(&env.paths.tmp()), 0);

        // Removing deletes the clone; the built-in one stays.
        remove(&env.paths, "acme").unwrap();
        assert!(!clone.exists());
        assert_eq!(remove(&env.paths, "onetest").unwrap_err().code, "invalid");
        assert_eq!(remove(&env.paths, "acme").unwrap_err().code, "not_found");

        // A folder: its full path, with a catalog; removing it never touches the folder.
        let local = add(&env.paths, &git, upstream.to_str().unwrap()).unwrap();
        assert_eq!(local.name, "acme");
        assert!(matches!(local.source, Source::Local { .. }));
        assert_eq!(local.commit, None);
        remove(&env.paths, "acme").unwrap();
        assert!(upstream.join(CATALOG_FILE).is_file());
        let empty = env.dir.path().join("empty");
        std::fs::create_dir_all(&empty).unwrap();
        assert_eq!(
            add(&env.paths, &git, empty.to_str().unwrap())
                .unwrap_err()
                .message,
            "That marketplace has no echo-marketplace.json."
        );
        assert_eq!(
            add(&env.paths, &git, "/no/such/folder").unwrap_err().code,
            "invalid"
        );
    }

    #[test]
    fn git_runs_hardened_and_refuses_other_transports() {
        let dest = Path::new("/data/plugins/tmp/u/clone");
        let args: Vec<String> = clone_args("https://github.com/acme/plugins", Some("v1"), dest)
            .iter()
            .map(|a| a.to_string_lossy().into_owned())
            .collect();
        let hooks = if cfg!(windows) {
            "core.hooksPath=NUL"
        } else {
            "core.hooksPath=/dev/null"
        };
        assert_eq!(
            args,
            [
                "-c",
                hooks,
                "-c",
                "protocol.allow=never",
                "-c",
                "protocol.https.allow=always",
                "-c",
                "credential.helper=",
                "-c",
                "core.askPass=",
                "-c",
                "core.symlinks=false",
                "-c",
                "core.fsmonitor=false",
                "-c",
                "submodule.recurse=false",
                "clone",
                "--depth",
                "1",
                "--no-recurse-submodules",
                "--branch",
                "v1",
                "--",
                "https://github.com/acme/plugins",
                "/data/plugins/tmp/u/clone",
            ]
        );
        // The real git, if this machine has one: file and http are refused before any
        // connection is made (nothing listens at 127.0.0.1:9).
        let probe = Command::new("git").arg("--version").output();
        if !probe.is_ok_and(|o| o.status.success()) {
            eprintln!("skipped: no git on this machine");
            return;
        }
        let dir = tempfile::tempdir().unwrap();
        let bare = dir.path().join("repo.git");
        let init = Command::new("git")
            .args(["init", "-q", "--bare"])
            .arg(&bare)
            .status()
            .unwrap();
        assert!(init.success());
        let git = CliGit {
            program: "git".into(),
            timeout: Duration::from_secs(20),
        };
        for (url, transport) in [
            (format!("file://{}", bare.display()), "file"),
            ("http://127.0.0.1:9/acme/plugins".to_string(), "http"),
            ("ssh://127.0.0.1:9/acme/plugins".to_string(), "ssh"),
        ] {
            let why = git
                .clone_at(&url, None, &dir.path().join(format!("c-{transport}")))
                .unwrap_err();
            assert!(
                why.contains(&format!("transport '{transport}' not allowed")),
                "{url}: {why}"
            );
            assert!(!dir.path().join(format!("c-{transport}")).exists());
        }
        // Every hardening setting is one git accepts: the commit lookup runs with all of them.
        let repo = dir.path().join("work");
        let ok = Command::new("git")
            .args(["init", "-q"])
            .arg(&repo)
            .status()
            .unwrap()
            .success()
            && Command::new("git")
                .args(["-c", "user.name=t", "-c", "user.email=t@example.com"])
                .args(["commit", "-q", "--allow-empty", "-m", "x"])
                .current_dir(&repo)
                .status()
                .unwrap()
                .success();
        assert!(ok);
        let commit = git.head(&repo).unwrap();
        assert_eq!(commit.len(), 40, "{commit}");
        // A folder that isn't a repository has no commit.
        assert!(!git.head(dir.path()).unwrap_err().is_empty());
    }

    #[test]
    fn catalog_entries_stay_inside_the_marketplace() {
        let env = testkit::env();
        let root = env.dir.path().join("m");
        testkit::write_catalog(&root, "m", &[]);
        std::fs::create_dir_all(root.join("plugins/a")).unwrap();
        std::fs::create_dir_all(env.dir.path().join("outside")).unwrap();
        let ok = entry_dir(&root, &Value::from("./plugins/a")).unwrap();
        assert_eq!(ok, dunce::canonicalize(root.join("plugins/a")).unwrap());
        assert!(entry_dir(&root, &Value::from("plugins/a/")).is_ok());
        #[cfg(unix)]
        std::os::unix::fs::symlink(env.dir.path().join("outside"), root.join("plugins/out"))
            .unwrap();
        for bad in [
            Value::from("../outside"),
            Value::from("./plugins/../../outside"),
            Value::from("/etc"),
            Value::from(env.dir.path().join("outside").to_str().unwrap()),
            Value::from("."),
            Value::from(""),
            Value::from("plugins/missing"),
            Value::from("plugins/out"),
            Value::from("plugins\\a"),
            serde_json::json!({"path": "plugins/a"}),
        ] {
            assert!(entry_dir(&root, &bad).is_err(), "{bad}");
        }
        // The catalog file itself is a plain file of bounded size.
        std::fs::write(root.join(CATALOG_FILE), vec![b' '; 300 * 1024]).unwrap();
        assert!(read_catalog(&root).unwrap_err().message.contains("256 KB"));
        #[cfg(unix)]
        {
            std::fs::remove_file(root.join(CATALOG_FILE)).unwrap();
            let elsewhere = env.dir.path().join("elsewhere");
            testkit::write_catalog(&elsewhere, "m", &[]);
            std::os::unix::fs::symlink(elsewhere.join(CATALOG_FILE), root.join(CATALOG_FILE))
                .unwrap();
            assert!(read_catalog(&root).is_err());
        }
    }
}
