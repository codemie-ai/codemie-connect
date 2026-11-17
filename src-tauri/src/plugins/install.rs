//! Installing, updating and removing plugins (DESIGN 7.1).
//!
//! An install never trusts the marketplace's folder after looking at it once:
//! 1. the plugin's tree is checked and hashed (`tree`);
//! 2. it is copied to `<data root>/plugins/tmp/<uuid>/`, and the copy is hashed again: a
//!    different hash means the folder changed meanwhile, and nothing is installed;
//! 3. the copy's own manifest is read and judged: its Echo range must include Connect's, no
//!    line of its permission sheet may block it, and the user must have agreed to that very
//!    sheet: every line, and the same words (`sheet_hash` of the sheet they were shown);
//! 4. under the registry lock, if neither the plugin's entry nor its marketplace changed
//!    meanwhile, the copy is renamed to `installed/<id>/<version>/` and the registry is written.
//!    An update removes the previous version's folder only after the registry points at the
//!    new one.
//!
//! A plugin is updated only from the marketplace it came from: the same name and the same
//! source, since a removed marketplace's name can be given to another. An update keeps the
//! user's agreement when every line is one they agreed to, word for word; a new line, or a line
//! that now says something else (a new host), asks again.
use super::capabilities::{sheet, SheetLine, Support};
use super::manifest::{check_compat, parse_manifest, Manifest, MANIFEST_FILE};
use super::market::{self, CatalogEntry};
use super::registry::{
    self, io_error, now, Installed, Locked, Market, PluginPaths, Registry, TmpDir,
};
use super::tree::{check_tree, copy_tree, delete_path, hex, tree_hash, TreeError};
use super::valid_id;
use crate::workspace::models::{Result, WorkspaceError};
use semver::Version;
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, BTreeSet};
use std::fmt::Display;
use std::fs;
use std::path::{Path, PathBuf};

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

/// Why a plugin can't be installed, as the sentence the catalog and an install show.
pub(crate) fn refused(id: &str, why: impl Display) -> WorkspaceError {
    WorkspaceError::new("refused", format!("“{id}” can’t be installed: {why}."))
}

fn changed(id: &str) -> WorkspaceError {
    WorkspaceError::new(
        "changed",
        format!("“{id}” changed while Connect was copying it. Try again."),
    )
}

fn tree_refusal(id: &str, e: TreeError) -> WorkspaceError {
    match e {
        TreeError::Changed(_) => changed(id),
        e => refused(id, e),
    }
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
    check_tree(dir).map_err(|e| tree_refusal(id, e))?;
    parse_manifest(dir).map_err(|e| refused(id, e))
}

/// SHA-256 over a permission sheet's words, `key\0text\0` per line in key order: what the user
/// was shown, so an install can tell that the sheet it is about to grant is that one.
pub fn sheet_hash(lines: &[SheetLine]) -> String {
    let mut sorted: Vec<&SheetLine> = lines.iter().collect();
    sorted.sort_by(|a, b| a.key.cmp(&b.key));
    let mut h = Sha256::new();
    for l in sorted {
        h.update(l.key.as_bytes());
        h.update([0]);
        h.update(l.text.as_bytes());
        h.update([0]);
    }
    hex(&h.finalize())
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

/// The version `market` offers of a plugin, when it can be read.
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
        /// `sheet_hash(sheet)`, to send back with the agreement.
        sheet_hash: String,
    },
}

/// The user's agreement to a permission sheet they were shown: every line's key, and the hash
/// of the sheet (`sheet_hash`).
#[derive(Debug, Clone, Copy)]
pub struct Agreement<'a> {
    pub keys: &'a [String],
    pub sheet_hash: &'a str,
}

/// How the user agreed.
enum Consent<'a> {
    /// Now, to the sheet they were shown.
    Given(Agreement<'a>),
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
    stage_with(paths, source, id, |_| {})
}

/// `stage`, with `after_copy` run on the copy before it is hashed again (tests change it there).
fn stage_with(
    paths: &PluginPaths,
    source: &Path,
    id: &str,
    after_copy: impl FnOnce(&Path),
) -> Result<Staged> {
    let before = tree_hash(source).map_err(|e| tree_refusal(id, e))?;
    let tmp = paths.fresh_tmp()?;
    let dir = tmp.join("package");
    copy_tree(source, &dir).map_err(|e| tree_refusal(id, e))?;
    after_copy(&dir);
    let hash = tree_hash(&dir).map_err(|e| tree_refusal(id, e))?;
    if hash != before {
        return Err(changed(id));
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
    match Version::parse(&cur.version).ok() {
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

/// The agreement is to this very sheet, and to every line of it.
fn require(id: &str, given: Agreement, sheet: &[SheetLine]) -> Result<()> {
    if given.sheet_hash != sheet_hash(sheet) {
        return Err(WorkspaceError::new(
            "changed",
            format!("The permission sheet of “{id}” changed. Look at it again before you agree."),
        ));
    }
    let want: BTreeSet<&str> = sheet.iter().map(|l| l.key.as_str()).collect();
    let got: BTreeSet<&str> = given.keys.iter().map(String::as_str).collect();
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

/// Installs plugin `id` from `market`, or upgrades it to the version that marketplace offers.
pub fn install(
    paths: &PluginPaths,
    market: &str,
    id: &str,
    agreement: Agreement,
) -> Result<Outcome> {
    put(paths, market, id, Consent::Given(agreement), Mode::Install)
}

/// Updates an installed plugin to the version its own marketplace offers. Without an
/// agreement, the earlier one is kept when nothing on the sheet is new; otherwise
/// `NeedsConsent`.
pub fn update(paths: &PluginPaths, id: &str, agreement: Option<Agreement>) -> Result<Outcome> {
    checked_id(id)?;
    let reg = Registry::load(paths)?;
    let cur = reg.installed.get(id).ok_or_else(|| not_installed(id))?;
    let market = reg
        .market(&cur.market)
        .filter(|m| cur.from_market(m))
        .ok_or_else(|| {
            WorkspaceError::new(
                "not_found",
                format!("The marketplace “{id}” came from isn’t added any more, so it can’t be updated."),
            )
        })?;
    let consent = agreement.map_or(Consent::Kept, Consent::Given);
    put(paths, &market.name, id, consent, Mode::Update)
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
    if current.as_ref().is_some_and(|c| !c.from_market(&market)) {
        return Err(WorkspaceError::new(
            "exists",
            format!(
                "“{id}” is installed from another marketplace. Remove it first to install it from “{}”.",
                market.name
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
        (Consent::Given(agreement), _) => require(id, agreement, &staged.sheet)?,
        (Consent::Kept, Some(cur)) => {
            let lines = new_lines(&staged.sheet, cur);
            if !lines.is_empty() {
                return Ok(Outcome::NeedsConsent {
                    id: id.to_string(),
                    name: staged.manifest.name.clone(),
                    version: staged.manifest.version.to_string(),
                    lines,
                    sheet_hash: sheet_hash(&staged.sheet),
                    sheet: staged.sheet,
                });
            }
        }
        (Consent::Kept, None) => return Err(not_installed(id)),
    }
    commit(paths, &market, id, staged, current.as_ref())
}

/// Moves a staged copy into place and records it, if the plugin and its marketplace are still
/// as they were when it was staged.
fn commit(
    paths: &PluginPaths,
    market: &Market,
    id: &str,
    staged: Staged,
    seen: Option<&Installed>,
) -> Result<Outcome> {
    let mut locked = Locked::take(paths)?;
    let moved_on = |what: String| {
        WorkspaceError::new(
            "busy",
            format!("{what} changed while Connect was installing “{id}”. Try again."),
        )
    };
    if locked.reg.installed.get(id) != seen {
        return Err(moved_on("Your plugins".into()));
    }
    let now_market = locked.reg.market(&market.name);
    if now_market.map(|m| (&m.source, &m.commit)) != Some((&market.source, &market.commit)) {
        return Err(moved_on(format!("The “{}” marketplace", market.name)));
    }
    let version = staged.manifest.version.to_string();
    let target = version_dir(paths, id, &version).ok_or_else(|| refused(id, "its version"))?;
    // Real folders inside the data root, not links out of it: checked before anything is
    // created through them, and again once they exist.
    let link = || refused(id, "its folder in the data folder is a link");
    let home = paths.installed().join(id);
    for dir in [paths.installed(), home.clone()] {
        if fs::symlink_metadata(&dir).is_ok_and(|m| !m.is_dir()) {
            return Err(link());
        }
    }
    fs::create_dir_all(&home).map_err(|e| io_error("prepare the plugin’s folder", &e))?;
    let real = |p: &Path| dunce::canonicalize(p).ok();
    if real(&home) != real(&paths.root).map(|r| r.join("installed").join(id)) {
        return Err(link());
    }
    // Left by an attempt that never reached the registry.
    if fs::symlink_metadata(&target).is_ok() {
        delete_path(&target).map_err(|e| io_error("replace the plugin’s files", &e))?;
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
        if let Err(undo) = delete_path(&target) {
            log::warn!("plugin {id}: an unrecorded copy stays: {undo}");
        }
        return Err(e);
    }
    // The previous version goes once the registry points at the new one.
    if let Some(old) = seen
        .filter(|s| s.version != version)
        .and_then(|s| version_dir(paths, id, &s.version))
    {
        if let Err(e) = delete_path(&old) {
            log::warn!("plugin {id}: the previous version's folder stays: {e}");
        }
    }
    Ok(Outcome::Installed(id.to_string()))
}

/// Turns an installed plugin on or off; its files and data stay. Turning it on needs the user's
/// agreement to the sheet of the version installed (a plugin taken back after a reset has none).
pub fn set_enabled(paths: &PluginPaths, id: &str, enabled: bool) -> Result<()> {
    checked_id(id)?;
    Registry::update(paths, |r| {
        let p = r.installed.get_mut(id).ok_or_else(|| not_installed(id))?;
        if enabled && !p.enabled {
            agreed_to_installed(paths, id, p)?;
        }
        p.enabled = enabled;
        Ok(())
    })
}

fn agreed_to_installed(paths: &PluginPaths, id: &str, p: &Installed) -> Result<()> {
    let m = installed_manifest(paths, id, p).ok_or_else(|| {
        WorkspaceError::new(
            "refused",
            format!("The files of “{id}” can’t be read. Remove it and install it again."),
        )
    })?;
    let lines = sheet(&m).map_err(|e| refused(id, e))?;
    if new_lines(&lines, p).is_empty() {
        Ok(())
    } else {
        Err(WorkspaceError::new(
            "consent_required",
            format!(
                "“{id}” can’t be turned on until you agree to its permission sheet. Remove it and install it again."
            ),
        ))
    }
}

/// Removes a plugin: its registry entry and `installed/<id>/`. With `delete_data`, also
/// `<data root>/plugins/data/<id>/` and `<private root>/credentials/plugins/<id>/`, and nothing
/// else; that works for a plugin removed earlier whose data was kept, too.
pub fn remove(paths: &PluginPaths, id: &str, delete_data: bool) -> Result<()> {
    checked_id(id)?;
    let mut locked = Locked::take(paths)?;
    let data = [paths.data_of(id), paths.secrets_of(id)];
    if locked.reg.installed.remove(id).is_some() {
        locked.save()?;
        if let Err(e) = delete_path(&paths.installed().join(id)) {
            log::warn!("plugin {id}: its files stay after removal: {e}");
        }
    } else if !(delete_data && data.iter().any(|d| fs::symlink_metadata(d).is_ok())) {
        return Err(not_installed(id));
    }
    if delete_data {
        for dir in &data {
            delete_path(dir).map_err(|e| io_error(&format!("delete the data of “{id}”"), &e))?;
        }
    }
    Ok(())
}

/// The manifest of an installed plugin's files.
pub fn installed_manifest(paths: &PluginPaths, id: &str, p: &Installed) -> Option<Manifest> {
    parse_manifest(&version_dir(paths, id, &p.version)?).ok()
}

// ------------------------------------------------------------------ reset

/// What `reset_registry` did.
#[derive(Debug)]
pub struct Reset {
    /// The unreadable file's new name, next to it.
    pub saved: String,
    /// The plugins taken back, turned off.
    pub adopted: Vec<String>,
    /// What else is under `installed/` (older versions, copies that no longer pass, stray
    /// entries), relative to the plugins folder: left as it is, for the UI to offer a clean-up.
    pub leftovers: Vec<String>,
}

/// Starts an unreadable registry again: the file is kept as `registry.json.bad-<time>`, the
/// new one lists the built-in marketplace, and each installed copy that still passes its checks
/// is taken back turned off, with no agreement and no marketplace (turning it on, or updating
/// it, means installing it again). A readable registry is never reset.
pub fn reset_registry(paths: &PluginPaths) -> Result<Reset> {
    let lock = registry::lock(paths)?;
    match Registry::load(paths) {
        Ok(_) => {
            return Err(WorkspaceError::new(
                "invalid",
                "Your list of plugins can be read; there is nothing to reset.",
            ))
        }
        Err(e) if e.code == "registry_unreadable" => {}
        Err(e) => return Err(e),
    }
    let saved = format!(
        "registry.json.bad-{}",
        chrono::Utc::now().format("%Y%m%dT%H%M%S%.3fZ")
    );
    fs::rename(paths.registry(), paths.root.join(&saved))
        .map_err(|e| io_error("set the unreadable list of plugins aside", &e))?;
    let mut reg = Registry::load(paths)?;
    let (adoptable, leftovers) = adoptable(paths);
    for (id, version, hash) in adoptable {
        reg.installed.insert(
            id,
            Installed {
                version: version.to_string(),
                market: String::new(),
                source: String::new(),
                commit: None,
                hash,
                enabled: false,
                agreed: Vec::new(),
                agreed_text: BTreeMap::new(),
                installed_at: now(),
            },
        );
    }
    let adopted = reg.installed.keys().cloned().collect();
    Locked::with(lock, paths, reg).save()?;
    Ok(Reset {
        saved,
        adopted,
        leftovers,
    })
}

/// What a reset takes back: in each `installed/<id>/`, the newest version whose tree passes
/// the checks and whose manifest is that id at that version, with its hash. And everything
/// else under `installed/`, as `installed/<name>[/<name>]` (sorted), which it leaves alone.
type Adoptable = (Vec<(String, Version, String)>, Vec<String>);

fn adoptable(paths: &PluginPaths) -> Adoptable {
    let Ok(ids) = fs::read_dir(paths.installed()) else {
        return (Vec::new(), Vec::new());
    };
    let is_dir = |e: &fs::DirEntry| e.file_type().is_ok_and(|t| t.is_dir());
    let name = |e: &fs::DirEntry| e.file_name().to_string_lossy().into_owned();
    let mut found = Vec::new();
    let mut leftovers = Vec::new();
    for entry in ids.flatten() {
        let id = name(&entry);
        let versions = match fs::read_dir(entry.path()) {
            Ok(versions) if is_dir(&entry) && valid_id(&id) => versions,
            _ => {
                leftovers.push(format!("installed/{id}"));
                continue;
            }
        };
        // Every version folder that could be taken back: a plain version name, files that pass,
        // the manifest of this id at that version, a hash.
        let mut usable = Vec::new();
        let mut empty = true;
        for v in versions.flatten() {
            empty = false;
            let dir = name(&v);
            let taken = is_dir(&v)
                .then(|| Version::parse(&dir).ok())
                .flatten()
                .filter(|version| read_package(&v.path(), &id).is_ok_and(|m| &m.version == version))
                .and_then(|version| Some((version, tree_hash(&v.path()).ok()?)));
            match taken {
                Some((version, hash)) => usable.push((version, hash, dir)),
                None => leftovers.push(format!("installed/{id}/{dir}")),
            }
        }
        usable.sort_by(|a, b| b.0.cmp(&a.0));
        let mut usable = usable.into_iter();
        match usable.next() {
            Some((version, hash, _)) => found.push((id.clone(), version, hash)),
            None if empty => leftovers.push(format!("installed/{id}")),
            None => {}
        }
        // Older versions stay where they are.
        leftovers.extend(usable.map(|(_, _, dir)| format!("installed/{id}/{dir}")));
    }
    leftovers.sort();
    (found, leftovers)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::plugins::registry::active_version;
    use crate::plugins::testkit::{self, count, manifest, Env};
    use crate::plugins::tree::{TreeStats, PLUGIN};
    use serde_json::json;
    use std::fs::File;

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

    fn local(env: &Env) -> Market {
        Registry::load(&env.paths)
            .unwrap()
            .market("local")
            .cloned()
            .unwrap()
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

    /// Every key of the sheet the local marketplace shows now, and its hash.
    fn shown(env: &Env, id: &str) -> (Vec<String>, String) {
        let o = offer(&env.paths, &local(env), id).unwrap();
        (keys(&o.sheet), sheet_hash(&o.sheet))
    }

    /// Installs from the local marketplace, agreeing to the whole sheet it shows.
    fn install_shown(env: &Env, id: &str) -> Result<Outcome> {
        let (keys, hash) = shown(env, id);
        let agreement = Agreement {
            keys: &keys,
            sheet_hash: &hash,
        };
        install(&env.paths, "local", id, agreement)
    }

    const NOTHING: Agreement = Agreement {
        keys: &[],
        sheet_hash: "",
    };

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

        let out = install_shown(&env, "hello").unwrap();
        assert!(matches!(out, Outcome::Installed(ref id) if id == "hello"));
        let dir = env.paths.installed().join("hello/1.0.0");
        let files = [
            "echo-plugin.json",
            "main.js",
            "client.js",
            "icon.svg",
            "sub/page.js",
            "data.bin",
        ];
        for f in files {
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
        assert!(p.from_market(&market));
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
        let again = install_shown(&env, "hello").unwrap_err();
        assert_eq!(again.code, "exists");
        assert_eq!(again.message, "“hello” 1.0.0 is already installed.");
        // Unknown marketplaces and plugins.
        for (market, id, code) in [
            ("nope", "hello", "not_found"),
            ("local", "other", "not_found"),
            ("local", "../x", "invalid"),
            // The built-in marketplace isn't fetched until the user asks.
            ("onetest", "github", "not_fetched"),
        ] {
            let e = install(&env.paths, market, id, NOTHING).unwrap_err();
            assert_eq!(e.code, code, "{market} {id}");
        }
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
        for i in 0..PLUGIN.files {
            fs::write(src(&env, "many").join(format!("f{i}.js")), "").unwrap();
        }
        let big = File::create(src(&env, "big").join("blob.bin")).unwrap();
        big.set_len(PLUGIN.bytes + 1).unwrap();
        let mut deep = src(&env, "deep");
        for _ in 0..=PLUGIN.depth {
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
        let listed = offers(&env.paths, &local(&env)).unwrap();
        for (id, code, message) in &cases {
            let e = install_shown(&env, id).unwrap_err();
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
            let e = install(&env.paths, "local", id, NOTHING).unwrap_err();
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
        let (_, hash) = shown(&env, "standup");
        for agreed in [
            vec![],
            vec!["network".to_string()],
            vec!["claude".into(), "network".into()],
            [all.to_vec(), vec!["files".into()]].concat(),
        ] {
            let agreement = Agreement {
                keys: &agreed,
                sheet_hash: &hash,
            };
            let e = install(&env.paths, "local", "standup", agreement).unwrap_err();
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
        let agreement = Agreement {
            keys: &agreed,
            sheet_hash: &hash,
        };
        install(&env.paths, "local", "standup", agreement).unwrap();
        let p = installed(&env, "standup").unwrap();
        assert_eq!(p.agreed, all);
        assert_eq!(p.agreed_text.len(), 3);
        // A plugin that asks for nothing needs no lines, only the (empty) sheet's hash.
        install_shown(&env, "plain").unwrap();
        assert!(installed(&env, "plain").unwrap().agreed.is_empty());
    }

    #[test]
    fn install_refuses_a_sheet_that_changed_since_it_was_shown() {
        let env = testkit::env();
        testkit::local_market(&env, &[hello("1.0.0")]);
        let (keys_shown, hash_shown) = shown(&env, "hello");
        assert_eq!(
            hash_shown,
            sheet_hash(&offer(&env.paths, &local(&env), "hello").unwrap().sheet)
        );
        // The marketplace's copy now asks to reach another host: the same key, other words.
        let mut m = hello("1.0.0");
        m["uses"] = json!({"network": {"hosts": ["api.example.com", "collect.example.net"]}});
        testkit::write_plugin(&src(&env, "hello"), m);
        let agreement = Agreement {
            keys: &keys_shown,
            sheet_hash: &hash_shown,
        };
        let e = install(&env.paths, "local", "hello", agreement).unwrap_err();
        assert_eq!(
            (e.code.as_str(), e.message.as_str()),
            (
                "changed",
                "The permission sheet of “hello” changed. Look at it again before you agree."
            )
        );
        assert_eq!(count(&env.paths.installed()), 0);
        assert_eq!(count(&env.paths.tmp()), 0);
        // The sheet shown now installs.
        install_shown(&env, "hello").unwrap();
        // An update agreed to with an old sheet's hash is refused the same way.
        let mut m = hello("1.1.0");
        m["uses"]["schedule"] = json!({});
        testkit::write_plugin(&src(&env, "hello"), m);
        let keys = ["network".to_string(), "schedule".to_string()];
        let stale = Agreement {
            keys: &keys,
            sheet_hash: &hash_shown,
        };
        assert_eq!(
            update(&env.paths, "hello", Some(stale)).unwrap_err().code,
            "changed"
        );
        let Outcome::NeedsConsent {
            sheet_hash: fresh, ..
        } = update(&env.paths, "hello", None).unwrap()
        else {
            panic!("a new line asks again");
        };
        let agreed = Agreement {
            keys: &keys,
            sheet_hash: &fresh,
        };
        update(&env.paths, "hello", Some(agreed)).unwrap();
        assert_eq!(installed(&env, "hello").unwrap().version, "1.1.0");
    }

    #[test]
    fn update_with_new_capability_requires_reconsent() {
        let env = testkit::env();
        let market = testkit::local_market(&env, &[hello("1.0.0")]);
        install_shown(&env, "hello").unwrap();
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
        let hash = match update(&env.paths, "hello", None).unwrap() {
            Outcome::NeedsConsent {
                id,
                name,
                version,
                lines,
                sheet,
                sheet_hash: hash,
            } => {
                assert_eq!(
                    (id.as_str(), name.as_str(), version.as_str()),
                    ("hello", "Hello", "1.2.0")
                );
                assert_eq!(keys(&lines), ["schedule"]);
                assert_eq!(keys(&sheet), ["network", "schedule"]);
                assert_eq!(hash, sheet_hash(&sheet));
                hash
            }
            other => panic!("{other:?}"),
        };
        assert_eq!(installed(&env, "hello").unwrap(), before);
        assert!(dir("1.1.0").is_dir() && !dir("1.2.0").exists());
        assert_eq!(count(&env.paths.tmp()), 0);
        // Agreeing to some lines isn't enough; agreeing to all updates it.
        let some = ["schedule".to_string()];
        let e = update(
            &env.paths,
            "hello",
            Some(Agreement {
                keys: &some,
                sheet_hash: &hash,
            }),
        )
        .unwrap_err();
        assert_eq!(e.code, "consent_required");
        let both = ["network".to_string(), "schedule".to_string()];
        update(
            &env.paths,
            "hello",
            Some(Agreement {
                keys: &both,
                sheet_hash: &hash,
            }),
        )
        .unwrap();
        let p = installed(&env, "hello").unwrap();
        assert_eq!(
            (p.version.as_str(), p.agreed.clone()),
            ("1.2.0", both.to_vec())
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
        // Installing the newer version with its whole sheet agreed upgrades it as well.
        install_shown(&env, "hello").unwrap();
        let p = installed(&env, "hello").unwrap();
        assert_eq!(p.version, "1.3.0");
        assert!(!p.enabled);
        assert_eq!(active_version(&env.paths, "hello"), None);
        assert_eq!(count(&env.paths.installed().join("hello")), 1);
        // An older version is not an update.
        testkit::write_plugin(&src(&env, "hello"), hello("1.0.0"));
        let e = install_shown(&env, "hello").unwrap_err();
        assert_eq!(e.message, "A newer “hello” (1.3.0) is already installed.");
        assert_eq!(
            update(&env.paths, "nope", None).unwrap_err().code,
            "not_found"
        );
    }

    #[test]
    fn a_marketplace_reusing_a_name_is_not_an_update_source() {
        let env = testkit::env();
        let first = testkit::local_market(&env, &[hello("1.0.0")]);
        install_shown(&env, "hello").unwrap();
        // That marketplace goes; another folder whose catalog has the same name takes the name
        // and offers a newer "hello".
        market::remove(&env.paths, "local").unwrap();
        let other = env.dir.path().join("other-market");
        let mut m = hello("2.0.0");
        m["uses"] = json!({"network": {"hosts": ["collect.example.net"]}});
        testkit::write_plugin(&other.join("plugins/hello"), m);
        testkit::write_catalog(&other, "local", &[("hello", "./plugins/hello")]);
        let second = market::add(&env.paths, &testkit::NoGit, other.to_str().unwrap()).unwrap();
        assert_eq!(second.name, first.name);
        assert_ne!(second.source, first.source);
        let e = update(&env.paths, "hello", None).unwrap_err();
        assert_eq!(
            (e.code.as_str(), e.message.as_str()),
            (
                "not_found",
                "The marketplace “hello” came from isn’t added any more, so it can’t be updated."
            )
        );
        let e = install_shown(&env, "hello").unwrap_err();
        assert_eq!(
            e.message,
            "“hello” is installed from another marketplace. Remove it first to install it from “local”."
        );
        assert_eq!(installed(&env, "hello").unwrap().version, "1.0.0");
        // Removed first, it installs from the new one.
        remove(&env.paths, "hello", false).unwrap();
        install_shown(&env, "hello").unwrap();
        assert!(installed(&env, "hello").unwrap().from_market(&second));
    }

    #[test]
    fn a_copy_that_changed_or_a_registry_that_moved_on_installs_nothing() {
        let env = testkit::env();
        testkit::local_market(&env, &[hello("1.0.0")]);
        let source = src(&env, "hello");
        // The copy differs from what was hashed at the source.
        let e = stage_with(&env.paths, &source, "hello", |copy| {
            fs::write(copy.join("main.js"), "tampered").unwrap()
        })
        .err()
        .unwrap();
        assert_eq!(
            (e.code.as_str(), e.message.as_str()),
            (
                "changed",
                "“hello” changed while Connect was copying it. Try again."
            )
        );
        assert_eq!(count(&env.paths.tmp()), 0);

        // Another install of the same plugin got there first.
        let staged = stage(&env.paths, &source, "hello").unwrap();
        install_shown(&env, "hello").unwrap();
        let e = commit(&env.paths, &local(&env), "hello", staged, None).unwrap_err();
        assert_eq!(e.code, "busy");
        assert_eq!(
            e.message,
            "Your plugins changed while Connect was installing “hello”. Try again."
        );
        remove(&env.paths, "hello", false).unwrap();

        // The marketplace was refreshed to another commit meanwhile.
        let market = local(&env);
        let staged = stage(&env.paths, &source, "hello").unwrap();
        Registry::update(&env.paths, |r| {
            r.markets
                .iter_mut()
                .find(|m| m.name == "local")
                .unwrap()
                .commit = Some("f00d".into());
            Ok(())
        })
        .unwrap();
        let e = commit(&env.paths, &market, "hello", staged, None).unwrap_err();
        assert_eq!(e.code, "busy");
        assert!(
            e.message.starts_with("The “local” marketplace changed"),
            "{}",
            e.message
        );
        assert_eq!(count(&env.paths.installed()), 0);
        assert_eq!(count(&env.paths.tmp()), 0);
        assert!(installed(&env, "hello").is_none());
    }

    #[test]
    fn a_corrupt_registry_is_reset_keeping_installed_plugins_off() {
        let env = testkit::env();
        testkit::local_market(&env, &[hello("1.0.0"), manifest("plain", "1.0.0")]);
        install_shown(&env, "hello").unwrap();
        install_shown(&env, "plain").unwrap();
        // A copy whose files no longer pass is not taken back; nor are an older version, a
        // folder that isn't a version, an empty plugin folder or a stray file.
        fs::write(
            env.paths.installed().join("plain/1.0.0/echo-plugin.json"),
            "{",
        )
        .unwrap();
        testkit::write_plugin(&env.paths.installed().join("hello/0.9.0"), hello("0.9.0"));
        fs::create_dir_all(env.paths.installed().join("hello/notes")).unwrap();
        fs::create_dir_all(env.paths.installed().join("empty")).unwrap();
        fs::write(env.paths.installed().join("stray.txt"), "x").unwrap();
        // A readable registry is never reset.
        assert_eq!(reset_registry(&env.paths).unwrap_err().code, "invalid");

        fs::write(env.paths.registry(), "{ broken").unwrap();
        assert_eq!(
            Registry::load(&env.paths).unwrap_err().code,
            "registry_unreadable"
        );
        let reset = reset_registry(&env.paths).unwrap();
        assert!(
            reset.saved.starts_with("registry.json.bad-"),
            "{}",
            reset.saved
        );
        assert_eq!(
            fs::read_to_string(env.paths.root.join(&reset.saved)).unwrap(),
            "{ broken"
        );
        assert_eq!(reset.adopted, ["hello"]);
        // What it didn't take back is listed, and left alone.
        assert_eq!(
            reset.leftovers,
            [
                "installed/empty",
                "installed/hello/0.9.0",
                "installed/hello/notes",
                "installed/plain/1.0.0",
                "installed/stray.txt",
            ]
        );
        for left in &reset.leftovers {
            assert!(
                fs::symlink_metadata(env.paths.root.join(left)).is_ok(),
                "{left}"
            );
        }
        let reg = Registry::load(&env.paths).unwrap();
        assert_eq!(reg.markets.len(), 1, "the built-in marketplace only");
        let p = &reg.installed["hello"];
        assert!(!p.enabled && p.agreed.is_empty() && p.market.is_empty());
        assert_eq!(
            p.hash,
            tree_hash(&env.paths.installed().join("hello/1.0.0")).unwrap()
        );
        // Taken back, it can't be turned on or updated without agreeing again.
        let e = set_enabled(&env.paths, "hello", true).unwrap_err();
        assert_eq!(e.code, "consent_required");
        assert_eq!(
            update(&env.paths, "hello", None).unwrap_err().code,
            "not_found"
        );
        // Removed (data kept) and installed again from a marketplace, it works as before.
        remove(&env.paths, "hello", false).unwrap();
        testkit::local_market(&env, &[hello("1.0.0")]);
        install_shown(&env, "hello").unwrap();
        assert!(installed(&env, "hello").unwrap().enabled);
    }

    #[test]
    fn disable_and_remove_keep_or_delete_data() {
        let env = testkit::env();
        testkit::local_market(&env, &[hello("1.0.0"), manifest("keeper", "1.0.0")]);
        let install_hello = || install_shown(&env, "hello").unwrap();
        install_hello();
        install_shown(&env, "keeper").unwrap();
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
            remove(&env.paths, "hello", false).unwrap_err().code,
            "not_found"
        );
        // The kept data can be deleted later; after that there is nothing left to remove.
        remove(&env.paths, "hello", true).unwrap();
        assert!(!data.exists() && !secrets.exists());
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

        // A link planted where the plugin's folder goes is not followed, nor created through.
        #[cfg(unix)]
        {
            let elsewhere = env.dir.path().join("elsewhere");
            fs::create_dir_all(&elsewhere).unwrap();
            std::os::unix::fs::symlink(&elsewhere, env.paths.installed().join("hello")).unwrap();
            let e = install_shown(&env, "hello").unwrap_err();
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
