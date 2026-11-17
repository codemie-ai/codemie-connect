//! Marketplaces (DESIGN 7.1): where plugins come from. A marketplace is a folder or a git
//! repository with `echo-marketplace.json` at its root:
//! `{name, featured: [id], plugins: [{id, source: "./plugins/<id>", categories}]}`.
//!
//! Sources the user can add:
//! - a local folder (its full path), read where it is;
//! - an `https://` git address (`#ref` picks a branch or tag) or GitHub's `owner/repo[@ref]`,
//!   cloned with `git clone --depth 1` (`git`) into `<data root>/plugins/markets/<name>-<hash8>/`;
//! - the built-in `onetest` (`onetest-ai/echo-plugins`), listed from the start and fetched only
//!   when the user asks.
//!
//! Connect reaches the network only when the user adds or refreshes a git marketplace. Every
//! other address (http, ssh, git, file) is refused, here and again by git's own protocol
//! allowlist. A clone keeps only its checked-out files (its `.git` folder is deleted once the
//! commit is read) and must stay within 5000 files and 64 MB.
use super::git::Git;
use super::registry::{io_error, now, Locked, Market, PluginPaths, Registry, Source};
use super::tree::{check_market_tree, delete_path, open_plain};
use crate::workspace::models::{Result, WorkspaceError};
use serde::Deserialize;
use serde_json::Value;
use std::io::Read;
use std::path::{Component, Path, PathBuf};

/// The catalog file at a marketplace's root.
pub const CATALOG_FILE: &str = "echo-marketplace.json";
const MAX_CATALOG_BYTES: u64 = 256 * 1024;
const MAX_CATALOG_PLUGINS: usize = 200;

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

/// A GitHub owner: letters, digits and dashes, not first.
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

/// A plain branch or tag name (`git clone --branch` takes nothing else): never an option
/// (`-x`), a path out (`..`) or anything a shell or git would read specially.
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
            "“{}” isn’t a plain branch or tag name.",
            r.escape_debug()
        )))
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
    let dir = entry_dir(&market.dir(paths), &entry.source)
        .map_err(|why| super::install::refused(id, why))?;
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

/// A git marketplace fetched into `tmp/`: its checked-out files only, within the limits.
struct Fetched {
    _tmp: super::registry::TmpDir,
    dir: PathBuf,
    commit: String,
    catalog: Catalog,
}

fn fetch(paths: &PluginPaths, git: &dyn Git, source: &Source) -> Result<Fetched> {
    let Source::Git { url, reference } = source else {
        return Err(invalid("Only a git marketplace is fetched."));
    };
    let failed = |why: String| {
        WorkspaceError::new(
            "fetch_failed",
            format!("Connect couldn’t fetch {}: {why}.", source.text()),
        )
    };
    let tmp = paths.fresh_tmp()?;
    let dir = tmp.join("clone");
    let commit = git
        .clone_at(url, reference.as_deref(), &dir)
        .map_err(failed)?;
    // The commit is read; the history isn't needed and would only take room.
    delete_path(&dir.join(".git")).map_err(|e| io_error("tidy the fetched marketplace", &e))?;
    check_market_tree(&dir)
        .map_err(|e| invalid(format!("That marketplace can’t be used: {e}.")))?;
    let catalog = read_catalog(&dir)?;
    Ok(Fetched {
        _tmp: tmp,
        dir,
        commit,
        catalog,
    })
}

/// Deletes what a marketplace change left aside; a failure only leaves files behind.
fn discard(path: &Path) {
    if let Err(e) = delete_path(path) {
        log::warn!("plugins: {} stays behind: {e}", path.display());
    }
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
    let (catalog, fetched) = match &source {
        Source::Local { path } => (read_catalog(path)?, None),
        Source::Git { .. } => {
            let f = fetch(paths, git, &source)?;
            (f.catalog.clone(), Some(f))
        }
    };
    let wanted = name_from(&catalog)?;
    let mut locked = Locked::take(paths)?;
    already_added(&locked.reg, &source)?;
    let market = Market {
        name: unique_name(&locked.reg, &wanted)?,
        source,
        built_in: false,
        commit: fetched.as_ref().map(|f| f.commit.clone()),
        fetched_at: Some(now()),
    };
    // A clone folder left by an earlier attempt is moved aside and deleted.
    let stale = match &fetched {
        Some(f) => place_clone(paths, &market, &f.dir)?,
        None => None,
    };
    locked.reg.markets.push(market.clone());
    locked.save()?;
    drop(locked);
    if let Some(stale) = stale {
        discard(&stale);
    }
    Ok(market)
}

/// Moves a checked clone to the marketplace's folder; a previous clone there is returned (moved
/// aside under `tmp/`) so the caller can delete it once the registry points at the new one.
fn place_clone(paths: &PluginPaths, market: &Market, clone: &Path) -> Result<Option<PathBuf>> {
    let target = market.dir(paths);
    std::fs::create_dir_all(paths.markets())
        .map_err(|e| io_error("prepare the marketplaces folder", &e))?;
    let old = if std::fs::symlink_metadata(&target).is_ok() {
        let aside = paths.tmp().join(uuid::Uuid::new_v4().to_string());
        std::fs::rename(&target, &aside)
            .map_err(|e| io_error("replace the marketplace’s files", &e))?;
        Some(aside)
    } else {
        None
    };
    if let Err(e) = std::fs::rename(clone, &target) {
        if let Some(aside) = &old {
            if let Err(back) = std::fs::rename(aside, &target) {
                log::warn!(
                    "plugins: the previous files of {} stay in {}: {back}",
                    market.name,
                    aside.display()
                );
            }
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
    let fetched = match &market.source {
        Source::Local { path } => {
            read_catalog(path)?;
            None
        }
        Source::Git { .. } => Some(fetch(paths, git, &market.source)?),
    };
    let mut locked = Locked::take(paths)?;
    let current = locked
        .reg
        .markets
        .iter_mut()
        .find(|m| m.name == name && m.source == market.source)
        .ok_or_else(|| no_market(name))?;
    let old = match &fetched {
        Some(f) => place_clone(paths, current, &f.dir)?,
        None => None,
    };
    if let Some(f) = &fetched {
        current.commit = Some(f.commit.clone());
    }
    current.fetched_at = Some(now());
    let updated = current.clone();
    locked.save()?;
    drop(locked);
    if let Some(old) = old {
        discard(&old);
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
        discard(&market.dir(paths));
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
        assert_eq!(
            parse_source("acme/plugins@-u").unwrap_err().message,
            "“-u” isn’t a plain branch or tag name."
        );

        // Adding one: the shorthand reaches git as the https address, at the ref.
        let env = testkit::env();
        let upstream = env.dir.path().join("upstream");
        testkit::write_catalog(&upstream, "Acme", &[("hello", "./plugins/hello")]);
        testkit::write_plugin(
            &upstream.join("plugins/hello"),
            testkit::manifest("hello", "1.0.0"),
        );
        std::fs::create_dir_all(upstream.join(".git/objects")).unwrap();
        std::fs::write(upstream.join(".git/HEAD"), "ref: refs/heads/main\n").unwrap();
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
        // Only the checked-out files are kept.
        assert!(!clone.join(".git").exists());
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
    fn a_fetched_marketplace_larger_than_64_mb_is_refused() {
        let env = testkit::env();
        let upstream = env.dir.path().join("upstream");
        testkit::write_catalog(&upstream, "Huge", &[]);
        let blob = std::fs::File::create(upstream.join("blob.bin")).unwrap();
        blob.set_len(64 * 1024 * 1024 + 1).unwrap();
        let git = FakeGit::new(&upstream, "a1b2c3");
        let e = add(&env.paths, &git, "acme/huge").unwrap_err();
        assert_eq!(
            (e.code.as_str(), e.message.as_str()),
            (
                "invalid",
                "That marketplace can’t be used: it is larger than 64 MB."
            )
        );
        assert_eq!(testkit::count(&env.paths.tmp()), 0);
        assert_eq!(testkit::count(&env.paths.markets()), 0);
        assert_eq!(Registry::load(&env.paths).unwrap().markets.len(), 1);
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
