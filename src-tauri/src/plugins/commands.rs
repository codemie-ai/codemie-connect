//! `plugins_request(op, data)`: Settings → Plugins asks for marketplaces, catalogs and permission
//! sheets, and installs, updates, turns off and removes plugins (DESIGN 7.1). File and network
//! work runs on the blocking pool. Errors are sentences for the user (`WorkspaceError`).
//!
//! | op | data | answer |
//! |---|---|---|
//! | `markets` | | `[Market]` |
//! | `market_add` | `{source}` | `Market` |
//! | `market_refresh` | `{market}` | `Market` |
//! | `market_remove` | `{market}` | `[Market]` |
//! | `catalog` | `{market}` | `{market: Market, plugins: [Offer]}` |
//! | `inspect` | `{market, id}` | `Offer` with `market`, `source`, `commit`, `sheet` and `sheetHash` |
//! | `install` | `{market, id, agreed, sheetHash}` | `{status: "installed", plugin: Installed}` |
//! | `update` | `{id, agreed?, sheetHash?}` | the same, or `{status: "needs_consent", id, name, version, lines, sheet, sheetHash}` |
//! | `set_enabled` | `{id, enabled}` | `Installed` |
//! | `remove` | `{id, deleteData}` | `{removed, deletedData}` (also for the kept data of a removed plugin) |
//! | `installed` | | `[Installed]` |
//! | `registry_reset` | | `{saved, adopted}`, only when the list is `registry_unreadable` |
//!
//! `agreed` is every key of the sheet the user was shown and `sheetHash` that sheet's hash (from
//! `inspect` or `needs_consent`): a sheet that changed since is refused as `changed`.
//!
//! Requests are counted while they run, so a data-folder move waits for them (`Core::quiesce`);
//! one that arrives during a move is refused with the move's own message.
use super::caller::require_main_frame;
use super::capabilities::SheetLine;
use super::git::{CliGit, Git};
use super::install::{self, Agreement, Offer, Outcome};
use super::market;
use super::registry::{Market, PluginPaths, Registry, Source};
use crate::storage::commands::{blocking, main_window_only, not_restarting};
use crate::workspace::models::{Result, WorkspaceError};
use crate::workspace::WorkspaceState;
use semver::Version;
use serde::de::DeserializeOwned;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

#[tauri::command]
pub async fn plugins_request(
    window: tauri::WebviewWindow,
    call: tauri::ipc::Request<'_>,
    state: tauri::State<'_, WorkspaceState>,
    op: String,
    data: Option<Value>,
) -> Result<Value> {
    require_main_frame(&call)?;
    main_window_only(window.label())?;
    let core = state.core.as_ref().ok_or_else(|| {
        WorkspaceError::new(
            "storage_unavailable",
            state
                .error
                .clone()
                .unwrap_or_else(|| "Your data folder isn’t open, so plugins can’t change.".into()),
        )
    })?;
    // Counted first, then checked: a move that starts later waits for this request, and one
    // under way refuses it with its own message.
    let counted = core.begin_plugin_op();
    not_restarting(&state)?;
    let running = counted?;
    let paths = PluginPaths::new(&core.paths.data, &core.paths.private);
    // The count ends with the work itself, even if this future is dropped first.
    blocking(move || {
        let _running = running;
        dispatch(&paths, &CliGit::default(), &op, data.unwrap_or(Value::Null))
    })
    .await?
}

#[derive(Deserialize)]
struct SourceArg {
    source: String,
}
#[derive(Deserialize)]
struct MarketArg {
    market: String,
}
#[derive(Deserialize)]
struct PluginArg {
    market: String,
    id: String,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct InstallArg {
    market: String,
    id: String,
    agreed: Vec<String>,
    sheet_hash: String,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct UpdateArg {
    id: String,
    #[serde(default)]
    agreed: Option<Vec<String>>,
    #[serde(default)]
    sheet_hash: Option<String>,
}
#[derive(Deserialize)]
struct EnableArg {
    id: String,
    enabled: bool,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct RemoveArg {
    id: String,
    #[serde(default)]
    delete_data: bool,
}

fn arg<T: DeserializeOwned>(data: Value) -> Result<T> {
    serde_json::from_value(data).map_err(|e| {
        WorkspaceError::new(
            "invalid",
            format!("That plugin request is incomplete: {e}."),
        )
    })
}

fn to_json(value: impl Serialize) -> Result<Value> {
    serde_json::to_value(value).map_err(|e| WorkspaceError::new("io", e.to_string()))
}

/// Runs one plugin request against the plugin folders of `paths`.
pub fn dispatch(paths: &PluginPaths, git: &dyn Git, op: &str, data: Value) -> Result<Value> {
    match op {
        "markets" => to_json(market_views(paths)?),
        "market_add" => {
            let a: SourceArg = arg(data)?;
            to_json(market_view(paths, &market::add(paths, git, &a.source)?))
        }
        "market_refresh" => {
            let a: MarketArg = arg(data)?;
            to_json(market_view(paths, &market::refresh(paths, git, &a.market)?))
        }
        "market_remove" => {
            let a: MarketArg = arg(data)?;
            market::remove(paths, &a.market)?;
            to_json(market_views(paths)?)
        }
        "catalog" => {
            let a: MarketArg = arg(data)?;
            catalog(paths, &a.market)
        }
        "inspect" => {
            let a: PluginArg = arg(data)?;
            inspect(paths, &a.market, &a.id)
        }
        "install" => {
            let a: InstallArg = arg(data)?;
            let agreement = Agreement {
                keys: &a.agreed,
                sheet_hash: &a.sheet_hash,
            };
            outcome(paths, install::install(paths, &a.market, &a.id, agreement)?)
        }
        "update" => {
            let a: UpdateArg = arg(data)?;
            let agreement = match (&a.agreed, &a.sheet_hash) {
                (Some(keys), Some(hash)) => Some(Agreement {
                    keys,
                    sheet_hash: hash,
                }),
                (None, _) => None,
                (Some(_), None) => {
                    return Err(WorkspaceError::new(
                        "invalid",
                        "That plugin request is incomplete: an agreement needs its sheetHash.",
                    ))
                }
            };
            outcome(paths, install::update(paths, &a.id, agreement)?)
        }
        "set_enabled" => {
            let a: EnableArg = arg(data)?;
            install::set_enabled(paths, &a.id, a.enabled)?;
            to_json(installed_view(paths, &a.id)?)
        }
        "remove" => {
            let a: RemoveArg = arg(data)?;
            install::remove(paths, &a.id, a.delete_data)?;
            Ok(json!({"removed": a.id, "deletedData": a.delete_data}))
        }
        "installed" => to_json(installed_views(paths)?),
        "registry_reset" => {
            let reset = install::reset_registry(paths)?;
            Ok(json!({"saved": reset.saved, "adopted": reset.adopted}))
        }
        other => Err(WorkspaceError::new(
            "invalid",
            format!(
                "Connect doesn’t know the plugin request “{}”.",
                other.escape_debug()
            ),
        )),
    }
}

// --------------------------------------------------------------------- views

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct MarketView {
    name: String,
    /// `git` or `local`.
    kind: &'static str,
    /// The https address or the folder.
    source: String,
    #[serde(rename = "ref")]
    reference: Option<String>,
    built_in: bool,
    /// Its catalog can be read now (fetched, or the folder is there).
    ready: bool,
    commit: Option<String>,
    fetched_at: Option<String>,
}

fn market_view(paths: &PluginPaths, m: &Market) -> MarketView {
    let (kind, source, reference) = match &m.source {
        Source::Local { path } => ("local", path.display().to_string(), None),
        Source::Git { url, reference } => ("git", url.clone(), reference.clone()),
    };
    MarketView {
        name: m.name.clone(),
        kind,
        source,
        reference,
        built_in: m.built_in,
        ready: market::is_ready(paths, m),
        commit: m.commit.clone(),
        fetched_at: m.fetched_at.clone(),
    }
}

fn market_views(paths: &PluginPaths) -> Result<Vec<MarketView>> {
    Ok(Registry::load(paths)?
        .markets
        .iter()
        .map(|m| market_view(paths, m))
        .collect())
}

/// A plugin as a catalog lists it.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct OfferView {
    id: String,
    name: Option<String>,
    version: Option<String>,
    summary: Option<String>,
    categories: Vec<String>,
    featured: bool,
    installable: bool,
    /// Why it can't be installed, as the sentence to show.
    reason: Option<String>,
    /// The version installed, whichever marketplace it came from.
    installed: Option<String>,
    /// This marketplace offers a newer version of the one installed from it.
    update: bool,
}

fn offer_view(reg: &Registry, market: &Market, o: &Offer) -> OfferView {
    let installed = reg.installed.get(&o.id);
    let newer = |m: &super::manifest::Manifest| {
        installed
            .filter(|p| p.from_market(market))
            .and_then(|p| Version::parse(&p.version).ok())
            .is_some_and(|have| m.version > have)
    };
    OfferView {
        id: o.id.clone(),
        name: o.manifest.as_ref().map(|m| m.name.clone()),
        version: o.manifest.as_ref().map(|m| m.version.to_string()),
        summary: o.manifest.as_ref().map(|m| m.summary.clone()),
        categories: o.categories.clone(),
        featured: o.featured,
        installable: o.refusal.is_none(),
        reason: o.refusal.as_ref().map(|e| e.message.clone()),
        installed: installed.map(|p| p.version.clone()),
        update: o.manifest.as_ref().is_some_and(newer),
    }
}

fn find_market(reg: &Registry, name: &str) -> Result<Market> {
    reg.market(name)
        .cloned()
        .ok_or_else(|| market::no_market(name))
}

fn catalog(paths: &PluginPaths, name: &str) -> Result<Value> {
    let reg = Registry::load(paths)?;
    let m = find_market(&reg, name)?;
    let plugins: Vec<OfferView> = if market::is_ready(paths, &m) {
        install::offers(paths, &m)?
            .iter()
            .map(|o| offer_view(&reg, &m, o))
            .collect()
    } else {
        Vec::new()
    };
    Ok(json!({"market": to_json(market_view(paths, &m))?, "plugins": to_json(plugins)?}))
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct DetailView {
    #[serde(flatten)]
    offer: OfferView,
    market: String,
    source: String,
    commit: Option<String>,
    /// Every line, what blocks first; render each with text escaping only.
    sheet: Vec<SheetLine>,
    /// `install::sheet_hash(sheet)`: sent back with the agreement.
    sheet_hash: String,
}

fn inspect(paths: &PluginPaths, name: &str, id: &str) -> Result<Value> {
    let reg = Registry::load(paths)?;
    let m = find_market(&reg, name)?;
    let o = install::offer(paths, &m, id)?;
    to_json(DetailView {
        offer: offer_view(&reg, &m, &o),
        market: m.name.clone(),
        source: m.source.text(),
        commit: m.commit.clone(),
        sheet_hash: install::sheet_hash(&o.sheet),
        sheet: o.sheet,
    })
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct InstalledView {
    id: String,
    name: String,
    version: String,
    summary: String,
    market: String,
    source: String,
    commit: Option<String>,
    hash: String,
    enabled: bool,
    agreed: Vec<String>,
    installed_at: String,
    /// The newer version its marketplace offers.
    update: Option<String>,
    /// Set when its files can't be read.
    problem: Option<String>,
}

fn installed_views(paths: &PluginPaths) -> Result<Vec<InstalledView>> {
    let reg = Registry::load(paths)?;
    reg.installed
        .keys()
        .filter(|id| super::valid_id(id))
        .map(|id| view_of(paths, &reg, id))
        .collect()
}

fn installed_view(paths: &PluginPaths, id: &str) -> Result<InstalledView> {
    view_of(paths, &Registry::load(paths)?, id)
}

fn view_of(paths: &PluginPaths, reg: &Registry, id: &str) -> Result<InstalledView> {
    let p = reg.installed.get(id).ok_or_else(|| {
        WorkspaceError::new(
            "not_found",
            format!("“{}” isn’t installed.", id.escape_debug()),
        )
    })?;
    let manifest = install::installed_manifest(paths, id, p);
    // Only its own marketplace offers it updates: the same name and the same source.
    let update = reg
        .market(&p.market)
        .filter(|m| p.from_market(m) && market::is_ready(paths, m))
        .and_then(|m| install::offered_version(paths, m, id))
        .filter(|v| Version::parse(&p.version).is_ok_and(|have| v > &have))
        .map(|v| v.to_string());
    Ok(InstalledView {
        id: id.to_string(),
        name: manifest
            .as_ref()
            .map_or_else(|| id.to_string(), |m| m.name.clone()),
        version: p.version.clone(),
        summary: manifest
            .as_ref()
            .map(|m| m.summary.clone())
            .unwrap_or_default(),
        market: p.market.clone(),
        source: p.source.clone(),
        commit: p.commit.clone(),
        hash: p.hash.clone(),
        enabled: p.enabled,
        agreed: p.agreed.clone(),
        installed_at: p.installed_at.clone(),
        update,
        problem: manifest
            .is_none()
            .then(|| "Its files can’t be read. Remove it and install it again.".to_string()),
    })
}

fn outcome(paths: &PluginPaths, out: Outcome) -> Result<Value> {
    match out {
        Outcome::Installed(id) => Ok(json!({
            "status": "installed",
            "plugin": to_json(installed_view(paths, &id)?)?,
        })),
        Outcome::NeedsConsent {
            id,
            name,
            version,
            lines,
            sheet,
            sheet_hash,
        } => Ok(json!({
            "status": "needs_consent",
            "id": id,
            "name": name,
            "version": version,
            "lines": to_json(lines)?,
            "sheet": to_json(sheet)?,
            "sheetHash": sheet_hash,
        })),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::plugins::testkit::{self, manifest, FakeGit};

    const PINNED_TIME: &str = "2026-11-17T09:30:00Z";

    /// Clock values differ per run; everything else in the answers is deterministic.
    fn pin(mut v: Value) -> Value {
        fn walk(v: &mut Value) {
            match v {
                Value::Object(map) => {
                    for (k, val) in map.iter_mut() {
                        if (k == "fetchedAt" || k == "installedAt") && val.is_string() {
                            *val = Value::from(PINNED_TIME);
                        } else {
                            walk(val);
                        }
                    }
                }
                Value::Array(items) => items.iter_mut().for_each(walk),
                _ => {}
            }
        }
        walk(&mut v);
        v
    }

    fn standup(version: &str) -> Value {
        let mut m = manifest("standup", version);
        m["name"] = json!("Stand-up digest");
        m["summary"] = json!("A morning digest of your team's updates on Today");
        m["uses"] = json!({
            "network": {"hosts": ["api.example.com"]},
            "schedule": {},
            "claude": {},
            "deliver": {"to": ["today", "teams"]},
        });
        m
    }

    #[test]
    fn contract_fixtures_match_the_real_plugins() {
        let env = testkit::env();
        let upstream = env.dir.path().join("upstream");
        let mut vault = manifest("vault-notes", "1.0.0");
        vault["name"] = json!("Vault notes");
        vault["summary"] = json!("Your notes vaults, read and edited");
        vault["uses"] = json!({"knowledge": {}, "folders": {"what": "notes folders"}});
        let mut next = manifest("next-gen", "2.0.0");
        next["name"] = json!("Next gen");
        next["summary"] = json!("Built for a newer Echo");
        next["echo"] = json!(">=0.9.13");
        next["uses"] = json!({"work": {}});
        for (id, m) in [
            ("standup", standup("1.0.0")),
            ("vault-notes", vault),
            ("next-gen", next),
        ] {
            testkit::write_plugin(&upstream.join("plugins").join(id), m);
        }
        testkit::write_catalog(
            &upstream,
            "Acme",
            &[
                ("standup", "./plugins/standup"),
                ("vault-notes", "./plugins/vault-notes"),
                ("next-gen", "./plugins/next-gen"),
            ],
        );
        let git = FakeGit::new(&upstream, "9f3c2a17e5b04d6c8a1f2e3d4c5b6a7980123456");
        let run = |op: &str, data: Value| dispatch(&env.paths, &git, op, data);

        let added = run(
            "market_add",
            json!({"source": "acme-corp/connect-plugins@stable"}),
        )
        .unwrap();
        assert_eq!(added["name"], "acme");
        let markets = run("markets", Value::Null).unwrap();
        let catalog = run("catalog", json!({"market": "acme"})).unwrap();
        let plugins = catalog["plugins"].as_array().unwrap();
        assert_eq!(plugins[0]["installable"], true);
        assert_eq!(
            plugins[1]["reason"],
            "Needs Connect's Knowledge engine (coming later)"
        );
        assert_eq!(
            plugins[2]["reason"],
            "It needs Echo >=0.9.13, and Connect provides Echo API 0.9.11."
        );
        let inspect = run("inspect", json!({"market": "acme", "id": "standup"})).unwrap();
        let keys: Vec<Value> = inspect["sheet"]
            .as_array()
            .unwrap()
            .iter()
            .map(|l| l["key"].clone())
            .collect();
        let installed = run(
            "install",
            json!({"market": "acme", "id": "standup", "agreed": keys, "sheetHash": inspect["sheetHash"]}),
        )
        .unwrap();
        assert_eq!(installed["status"], "installed");
        assert_eq!(installed["plugin"]["version"], "1.0.0");

        // The marketplace publishes 1.1.0, which also wants a folder.
        let mut newer = standup("1.1.0");
        newer["uses"]["folders"] = json!({"what": "meeting notes folders"});
        testkit::write_plugin(&upstream.join("plugins/standup"), newer);
        git.set_commit("1c0ffee2e5b04d6c8a1f2e3d4c5b6a7980abcdef");
        run("market_refresh", json!({"market": "acme"})).unwrap();
        let installed_list = run("installed", Value::Null).unwrap();
        assert_eq!(installed_list[0]["update"], "1.1.0");
        let needs = run("update", json!({"id": "standup"})).unwrap();
        assert_eq!(needs["status"], "needs_consent");
        assert_eq!(needs["lines"][0]["key"], "folders");
        assert_ne!(needs["sheetHash"], inspect["sheetHash"]);

        let dir =
            std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../ui/test/fixtures/contract");
        let update = std::env::var("UPDATE_CONTRACT_FIXTURES").is_ok_and(|v| v == "1");
        for (name, value) in [
            ("plugins-markets.json", markets),
            ("plugins-catalog.json", catalog),
            ("plugins-inspect.json", inspect),
            ("plugins-installed.json", installed_list),
            ("plugins-update-needs-consent.json", needs),
        ] {
            let text = serde_json::to_string_pretty(&pin(value)).unwrap() + "\n";
            let path = dir.join(name);
            if update {
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
    }

    #[test]
    fn requests_are_read_and_refused_in_sentences() {
        let env = testkit::env();
        testkit::local_market(&env, &[manifest("hello", "1.0.0")]);
        let run = |op: &str, data: Value| dispatch(&env.paths, &testkit::NoGit, op, data);
        let e = run("explode", Value::Null).unwrap_err();
        assert_eq!(
            (e.code.as_str(), e.message.as_str()),
            (
                "invalid",
                "Connect doesn’t know the plugin request “explode”."
            )
        );
        let e = run("install", json!({"market": "local"})).unwrap_err();
        assert_eq!(e.code, "invalid");
        assert!(
            e.message
                .starts_with("That plugin request is incomplete: missing field"),
            "{}",
            e.message
        );
        // The whole round: inspect, install, turn off, remove with its data.
        let shown = run("inspect", json!({"market": "local", "id": "hello"})).unwrap();
        let e = run(
            "install",
            json!({"market": "local", "id": "hello", "agreed": [], "sheetHash": "0"}),
        )
        .unwrap_err();
        assert_eq!(e.code, "changed");
        let out = run(
            "install",
            json!({"market": "local", "id": "hello", "agreed": [], "sheetHash": shown["sheetHash"]}),
        )
        .unwrap();
        assert_eq!(out["plugin"]["enabled"], true);
        assert_eq!(out["plugin"]["name"], "Hello");
        assert_eq!(out["plugin"]["problem"], Value::Null);
        let off = run("set_enabled", json!({"id": "hello", "enabled": false})).unwrap();
        assert_eq!(off["enabled"], false);
        // An agreement without the sheet it was given to is incomplete; an unknown plugin is
        // refused, never a crash.
        let e = run("update", json!({"id": "hello", "agreed": []})).unwrap_err();
        assert_eq!(e.code, "invalid");
        assert_eq!(
            installed_view(&env.paths, "nope").err().unwrap().code,
            "not_found"
        );
        assert_eq!(
            run("set_enabled", json!({"id": "nope", "enabled": true}))
                .unwrap_err()
                .code,
            "not_found"
        );
        let catalog = run("catalog", json!({"market": "local"})).unwrap();
        assert_eq!(catalog["market"]["kind"], "local");
        assert_eq!(catalog["plugins"][0]["installed"], "1.0.0");
        assert_eq!(catalog["plugins"][0]["update"], false);
        let gone = run("remove", json!({"id": "hello", "deleteData": true})).unwrap();
        assert_eq!(gone, json!({"removed": "hello", "deletedData": true}));
        assert_eq!(run("installed", Value::Null).unwrap(), json!([]));
        // The built-in marketplace is listed, not fetched; its catalog is empty until it is.
        let catalog = run("catalog", json!({"market": "onetest"})).unwrap();
        assert_eq!(catalog["market"]["ready"], false);
        assert_eq!(catalog["plugins"], json!([]));
        let markets = run("market_remove", json!({"market": "local"})).unwrap();
        assert_eq!(markets.as_array().unwrap().len(), 1);
        // An unreadable list says so in every request, until it is reset.
        std::fs::write(env.paths.registry(), "{").unwrap();
        assert_eq!(
            run("markets", Value::Null).unwrap_err().code,
            "registry_unreadable"
        );
        let reset = run("registry_reset", Value::Null).unwrap();
        assert_eq!(reset["adopted"], json!([]));
        assert_eq!(
            run("markets", Value::Null)
                .unwrap()
                .as_array()
                .unwrap()
                .len(),
            1
        );
    }
}
