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
//! | `set_enabled` | `{id, enabled, agreed?, sheetHash?}` | `Installed`, or turning it on with lines not agreed to: `{status: "needs_consent", …}` as `update` |
//! | `set_addresses` | `{id, key, value}` | `Installed`: the addresses the user typed for a `hosts_from` setting |
//! | `set_setting` | `{id, key, value}` | `Installed`: a declared setting the user set in Connect (not a `hosts_from` one); a `secret` is write-only (`""` or `null` clears it), and saving or clearing a task provider's secret queues a sync |
//! | `client_storage` | `{id, items?}` | `{items}`: what its client half keeps (read, or replaced with `items`) |
//! | `remove` | `{id, deleteData}` | `{removed, deletedData}` (also for the kept data of a removed plugin) |
//! | `installed` | | `[Installed]`, each with its `client`, `widgets`, `signin`, `addresses` and `settings` (`extras`; a secret only as `set: true\|false`), and `loadError` when it is on but its host half didn't load |
//! | `registry_reset` | | `{saved, adopted, leftovers}`, only when the list is `registry_unreadable` |
//! | `signin` | `{id, host}` | `{signedIn, host, from}`: the user's Sign in on the plugin's settings |
//! | `signout` | `{id, host}` | `{signedIn: false, host}` |
//! | `pick_folder` | | `{path}`: the folder the user chose for a marketplace, `null` when they cancelled |
//! | `open_link` | `{id, url}` | `{opened: true}`: the user pressed Open in Connect's confirmation of a link plugin `id`'s page asked to open; only `https:` and `obsidian:` addresses (ruling R41) |
//! | `frame_files` | `{id, paths}` | `[{file, name, size}]`: files dropped on plugin `id`'s page, as its handles (`services::window`) |
//! | `frame_reveal` | `{id, root, path}` | `{revealed: true}`: its page's `ctx.system.reveal`, on the user's click |
//! | `frame_session` | `{id, folder, path, mode, profile}` | `{opened: true}`: its page's `ctx.claude.session`, Claude Code in Terminal in that folder |
//! | `frame_skill_check` | `{id, name, md}` | `{name, description, path, replaces}`: what its page's `ctx.claude.installSkill` would add, for Connect's confirmation |
//! | `frame_skill_install` | `{id, name, md}` | `{installed, path}`: after the user said yes in Connect's window |
//! | `frame_skill_remove` | `{id, name}` | `{removed: true}`: its page's `ctx.claude.removeSkill`, after the user said yes |
//! | `address_answer` | `{ask, url}` | `{answered}`: what the user typed in Connect's box for a plugin's `http.askAddress` (`url` null: cancelled) |
//!
//! `agreed` is every key of the sheet the user was shown and `sheetHash` that sheet's hash (from
//! `inspect` or `needs_consent`): a sheet that changed since is refused as `changed`.
//!
//! A request that changes what is installed or turned on reloads the plugins (`PluginManager`).
//! `plugin_call(id, command, args)` runs a loaded plugin's command.
//!
//! Requests are counted while they run, so a data-folder move waits for them (`Core::quiesce`);
//! one that arrives during a move is refused with the move's own message.
use super::caller::require_main_frame;
use super::capabilities::SheetLine;
use super::extras::{self, Extras};
use super::git::{CliGit, Git};
use super::host::{ErrorCode, HostError};
use super::install::{self, Agreement, Offer, Outcome};
use super::manager::PluginManager;
use super::market;
use super::registry::{Market, PluginPaths, Registry, Source};
use crate::storage::commands::{blocking, main_window_only, not_restarting};
use crate::workspace::models::{Result, WorkspaceError};
use crate::workspace::WorkspaceState;
use semver::Version;
use serde::de::DeserializeOwned;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::BTreeMap;
use std::sync::Arc;

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
    if op == "pick_folder" {
        let folder = manager_of(&window)?.pick_market_folder().await;
        return Ok(json!({"path": folder.map(|f| f.display().to_string())}));
    }
    if op == "open_link" {
        let a: LinkArg = arg(data.unwrap_or(Value::Null))?;
        return blocking(move || {
            let _running = running;
            open_link(&a.id, &a.url, crate::workspace::graph::launch_url)
        })
        .await?;
    }
    if op == "address_answer" {
        let a: AnswerArg = arg(data.unwrap_or(Value::Null))?;
        let answered = super::manager::answer_address(a.ask, a.url);
        return Ok(json!({"answered": answered}));
    }
    if let Some(action) = op.strip_prefix("frame_") {
        let services = manager_of(&window)?.services().clone();
        let action = action.to_string();
        let app = {
            use tauri::Manager;
            window.app_handle().clone()
        };
        return blocking(move || {
            let _running = running;
            frame_request(&app, &services, &action, data.unwrap_or(Value::Null))
        })
        .await?;
    }
    if matches!(op.as_str(), "signin" | "signout") {
        let a: SigninArg = arg(data.unwrap_or(Value::Null))?;
        return manager_of(&window)?
            .sign_in(&a.id, &a.host, op == "signin")
            .await
            .map_err(host_error);
    }
    let paths = PluginPaths::new(&core.paths.data, &core.paths.private);
    if op == "set_setting" {
        let core = core.clone();
        return blocking(move || {
            let _running = running;
            let (view, provider_secret) = set_setting(&paths, data.unwrap_or(Value::Null))?;
            if let Some(plugin) = provider_secret {
                core.task_secret_saved(&plugin)?;
            }
            Ok(view)
        })
        .await?;
    }
    let changes = matches!(
        op.as_str(),
        "install" | "update" | "set_enabled" | "remove" | "registry_reset"
    );
    let listing = op == "installed";
    // The count ends with the work itself, even if this future is dropped first.
    let answer = blocking(move || {
        let _running = running;
        dispatch(&paths, &CliGit::default(), &op, data.unwrap_or(Value::Null))
    })
    .await?;
    if changes && answer.is_ok() {
        if let Ok(manager) = manager_of(&window) {
            manager.on_registry_change();
        }
    }
    match (listing, manager_of(&window)) {
        (true, Ok(manager)) => answer.map(|list| with_load_errors(list, &manager.problems())),
        _ => answer,
    }
}

/// The installed list with `loadError` on each plugin that is on but whose host half didn't load:
/// the manager's reason, without its code.
fn with_load_errors(mut list: Value, problems: &BTreeMap<String, String>) -> Value {
    for p in list.as_array_mut().into_iter().flatten() {
        let Some(problem) = p["id"].as_str().and_then(|id| problems.get(id)) else {
            continue;
        };
        let words = problem
            .split_once(": ")
            .filter(|(code, _)| ErrorCode::parse(code).is_some())
            .map_or(problem.as_str(), |(_, words)| words);
        p["loadError"] = json!(words);
    }
    list
}

/// `plugin_call(id, command, args)`: runs one of a plugin's host-half commands for Connect's own
/// page (its client half's `ctx.call`, a widget's or an Inbox item's button). A plugin's frame
/// reaches it only through the main window's bridge, which checks the frame (DESIGN 7.3).
#[tauri::command]
pub async fn plugin_call(
    window: tauri::WebviewWindow,
    call: tauri::ipc::Request<'_>,
    id: String,
    command: String,
    args: Option<Value>,
    files: Option<Vec<String>>,
) -> Result<Value> {
    require_main_frame(&call)?;
    main_window_only(window.label())?;
    let files = files.unwrap_or_default();
    manager_of(&window)?
        .call_with_files(&id, &command, args.unwrap_or(Value::Null), &files)
        .await
        .map_err(host_error)
}

/// The plugin manager, which runs while the data folder is open.
fn manager_of(window: &tauri::WebviewWindow) -> Result<Arc<PluginManager>> {
    use tauri::Manager;
    window
        .app_handle()
        .try_state::<Arc<PluginManager>>()
        .map(|m| m.inner().clone())
        .ok_or_else(|| {
            WorkspaceError::new(
                "storage_unavailable",
                "Your data folder isn’t open, so plugins aren’t running.",
            )
        })
}

/// A plugin's failure as the window hears it: its code (`permission`, `timeout`, …) and words.
fn host_error(e: HostError) -> WorkspaceError {
    WorkspaceError::new(e.code.as_str(), e.message)
}

#[derive(Deserialize)]
struct SigninArg {
    id: String,
    host: String,
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
#[serde(rename_all = "camelCase")]
struct EnableArg {
    id: String,
    enabled: bool,
    #[serde(default)]
    agreed: Option<Vec<String>>,
    #[serde(default)]
    sheet_hash: Option<String>,
}
#[derive(Deserialize)]
struct AddressArg {
    id: String,
    key: String,
    value: String,
}
#[derive(Deserialize)]
struct SettingArg {
    id: String,
    key: String,
    #[serde(default)]
    value: Value,
}
#[derive(Deserialize)]
struct StorageArg {
    id: String,
    #[serde(default)]
    items: Option<Value>,
}
#[derive(Deserialize)]
struct IdArg {
    id: String,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct RemoveArg {
    id: String,
    #[serde(default)]
    delete_data: bool,
}

#[derive(Deserialize)]
struct LinkArg {
    id: String,
    url: String,
}

/// The longest address a plugin's link may have.
const LINK_MAX: usize = 2000;

/// `open_link {id, url}` (ruling R41): the user pressed Open in Connect's own confirmation of a
/// link a plugin's page asked to open. The frame could forge the click, so the address is checked
/// again here: only `https:` (without a user name or password) and `obsidian:` addresses are
/// opened, with the system's handler (`open`); anything else is refused.
fn open_link(id: &str, url: &str, open: impl FnOnce(&str) -> Result<()>) -> Result<Value> {
    if !super::valid_id(id) {
        return Err(WorkspaceError::new("validation", "Unknown plugin."));
    }
    let refused = || {
        WorkspaceError::new(
            "validation",
            "Connect opens only https:// and obsidian:// links.",
        )
    };
    if url.len() > LINK_MAX {
        return Err(refused());
    }
    let link = url::Url::parse(url).map_err(|_| refused())?;
    let allowed = match link.scheme() {
        "https" => {
            link.host_str().is_some_and(|h| !h.is_empty())
                && link.username().is_empty()
                && link.password().is_none()
        }
        "obsidian" => true,
        _ => false,
    };
    if !allowed {
        return Err(refused());
    }
    open(link.as_str()).map_err(|e| match link.scheme() {
        "obsidian" => WorkspaceError::new(
            "io",
            "Connect couldn’t open it in Obsidian. Check that Obsidian is installed.",
        ),
        _ => e,
    })?;
    log::info!("[plugin:{id}] opened a {} link", link.scheme());
    Ok(json!({"opened": true}))
}

#[derive(Deserialize)]
struct FilesArg {
    id: String,
    paths: Vec<String>,
}
#[derive(Deserialize)]
struct AnswerArg {
    ask: u64,
    #[serde(default)]
    url: Option<String>,
}
#[derive(Deserialize)]
struct SkillArg {
    id: String,
    name: String,
    #[serde(default)]
    md: String,
}
#[derive(Deserialize)]
struct SessionArg {
    id: String,
    folder: String,
    #[serde(default)]
    path: String,
    #[serde(default)]
    mode: String,
    #[serde(default)]
    profile: String,
}
#[derive(Deserialize)]
struct RevealArg {
    id: String,
    root: String,
    #[serde(default)]
    path: String,
}

/// What the window asks for the plugin page on screen (`services::window`).
fn frame_request(
    app: &tauri::AppHandle,
    services: &crate::plugins::services::Services,
    action: &str,
    data: Value,
) -> Result<Value> {
    use crate::plugins::services::{skills, window};
    let skill = |data: Value| -> Result<(
        SkillArg,
        std::sync::Arc<crate::plugins::services::Granted>,
        std::path::PathBuf,
    )> {
        let a: SkillArg = arg(data)?;
        let p = services.granted(&a.id).map_err(host_error)?;
        let home = skills::home().map_err(host_error)?;
        Ok((a, p, home))
    };
    match action {
        "skill_check" => {
            let (a, p, home) = skill(data)?;
            skills::check(services, &p, &a.name, &a.md, &home).map_err(host_error)
        }
        "skill_install" => {
            let (a, p, home) = skill(data)?;
            skills::install(services, &p, &a.name, &a.md, &home).map_err(host_error)
        }
        "skill_remove" => {
            let (a, p, home) = skill(data)?;
            skills::remove(services, &p, &a.name, &home).map_err(host_error)
        }
        "session" => {
            let a: SessionArg = arg(data)?;
            let (dir, argv) =
                window::session(services, &a.id, &a.folder, &a.path, &a.mode, &a.profile)
                    .map_err(host_error)?;
            let name = services.granted(&a.id).map_err(host_error)?.name.clone();
            // In Connect's terminal dock, as in Echo's terminal panel.
            crate::commands::terminal::open_claude(app, &a.id, &name, &dir, argv)
                .map_err(|e| WorkspaceError::new("io", e))?;
            log::info!(
                "[plugin:{}] opened Claude Code in a folder it was given",
                a.id
            );
            Ok(json!({"opened": true}))
        }
        "files" => {
            let a: FilesArg = arg(data)?;
            window::hand_files(services, &a.id, &a.paths).map_err(host_error)
        }
        "reveal" => {
            let a: RevealArg = arg(data)?;
            window::reveal(services, &a.id, &a.root, &a.path, window::open_in_finder)
                .map_err(host_error)
        }
        other => Err(WorkspaceError::new(
            "invalid",
            format!(
                "Connect doesn’t know the plugin request “frame_{}”.",
                other.escape_debug()
            ),
        )),
    }
}

fn arg<T: DeserializeOwned>(data: Value) -> Result<T> {
    serde_json::from_value(data).map_err(|e| {
        WorkspaceError::new(
            "invalid",
            format!("That plugin request is incomplete: {e}."),
        )
    })
}

/// An agreement sent with a request: its keys and the hash of the sheet they were shown.
fn agreement_of<'a>(
    agreed: &'a Option<Vec<String>>,
    sheet_hash: &'a Option<String>,
) -> Result<Option<Agreement<'a>>> {
    match (agreed, sheet_hash) {
        (Some(keys), Some(hash)) => Ok(Some(Agreement {
            keys,
            sheet_hash: hash,
        })),
        (None, _) => Ok(None),
        (Some(_), None) => Err(WorkspaceError::new(
            "invalid",
            "That plugin request is incomplete: an agreement needs its sheetHash.",
        )),
    }
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
            let agreement = agreement_of(&a.agreed, &a.sheet_hash)?;
            outcome(paths, install::update(paths, &a.id, agreement)?)
        }
        "set_enabled" => {
            let a: EnableArg = arg(data)?;
            let agreement = agreement_of(&a.agreed, &a.sheet_hash)?;
            match install::enable(paths, &a.id, a.enabled, agreement)? {
                Outcome::Installed(id) => to_json(installed_view(paths, &id)?),
                asked => outcome(paths, asked),
            }
        }
        "set_addresses" => {
            let a: AddressArg = arg(data)?;
            extras::set_addresses(paths, &a.id, &a.key, &a.value)?;
            to_json(installed_view(paths, &a.id)?)
        }
        "set_setting" => set_setting(paths, data).map(|(view, _)| view),
        "host_phrases" => {
            let a: IdArg = arg(data)?;
            extras::host_phrases(paths, &a.id)
        }
        "client_storage" => {
            let a: StorageArg = arg(data)?;
            match &a.items {
                Some(items) => extras::set_client_storage(paths, &a.id, items),
                None => extras::client_storage(paths, &a.id),
            }
        }
        "remove" => {
            let a: RemoveArg = arg(data)?;
            install::remove(paths, &a.id, a.delete_data)?;
            Ok(json!({"removed": a.id, "deletedData": a.delete_data}))
        }
        "installed" => to_json(installed_views(paths)?),
        "registry_reset" => {
            let reset = install::reset_registry(paths)?;
            Ok(
                json!({"saved": reset.saved, "adopted": reset.adopted, "leftovers": reset.leftovers}),
            )
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

/// `set_setting`: sets a plugin's setting; answers its `installed` view and, when it was a task provider's
/// secret, the plugin's id (a sync is queued for it).
fn set_setting(paths: &PluginPaths, data: Value) -> Result<(Value, Option<String>)> {
    let a: SettingArg = arg(data)?;
    let provider_secret = extras::set_setting(paths, &a.id, &a.key, &a.value)?;
    let view = to_json(installed_view(paths, &a.id)?)?;
    Ok((view, provider_secret.then_some(a.id)))
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
    #[serde(flatten)]
    extras: Extras,
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
        extras: extras::extras(paths, id, p, manifest.as_ref()),
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

    #[test]
    fn open_link_opens_only_https_and_obsidian_addresses() {
        let mut opened = Vec::new();
        for good in [
            "https://github.com/login/device",
            "https://github.com/owner/repo",
            "obsidian://open?path=%2FUsers%2Fme%2FVault%2Fa.md",
        ] {
            let answer = open_link("github", good, |url| {
                opened.push(url.to_string());
                Ok(())
            })
            .unwrap();
            assert_eq!(answer, json!({"opened": true}));
        }
        assert_eq!(
            opened,
            [
                "https://github.com/login/device",
                "https://github.com/owner/repo",
                "obsidian://open?path=%2FUsers%2Fme%2FVault%2Fa.md"
            ]
        );
        // The frame could forge the click, so the address is checked again here.
        for bad in [
            "javascript:alert(1)",
            "file:///etc/passwd",
            "data:text/html,<script>alert(1)</script>",
            "http://github.com/login/device",
            "https://user:pw@github.com/",
            "https://user@github.com/",
            "tauri://localhost/",
            "connect-plugin://github/x",
            "vbscript:x",
            "github.com/login/device",
            "",
            &format!("https://github.com/{}", "x".repeat(2000)),
        ] {
            let refused = open_link("github", bad, |url| panic!("opened {url}")).unwrap_err();
            assert_eq!(refused.code, "validation", "{bad}");
            assert_eq!(
                refused.message,
                "Connect opens only https:// and obsidian:// links."
            );
        }
        let unknown = open_link("../x", "https://github.com/", |url| panic!("opened {url}"));
        assert_eq!(unknown.unwrap_err().code, "validation");
        // Obsidian not there: said in words, not as a browser failure.
        let missing = open_link("obsidian", "obsidian://open?path=x", |_| {
            Err(WorkspaceError::new("io", "Cannot open the system browser."))
        })
        .unwrap_err();
        assert_eq!(
            missing.message,
            "Connect couldn’t open it in Obsidian. Check that Obsidian is installed."
        );
    }

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

    /// The token the tests save: it must never show up anywhere but the private secrets file.
    const SENTINEL: &str = "tk_SENTINEL_do_not_log_0123456789";

    /// A synthetic task provider (Todoist-like) installed from a local marketplace, every line of
    /// its sheet agreed to.
    fn installed_provider(env: &testkit::Env) {
        let mut m = manifest("todoist", "1.0.0");
        m.as_object_mut().unwrap().remove("client");
        m["name"] = json!("Todoist");
        m["summary"] = json!("Keeps Connect's tasks in your Todoist");
        m["provides"] = json!(["tasks"]);
        m["requires"] = json!(["tasks_provider"]);
        m["uses"] = json!({"network": {"hosts": ["api.todoist.com"]}});
        m["settings"] = json!([
            {"key": "token", "label": "API token", "type": "secret", "help": "Todoist › Settings › Integrations › Developer"},
            {"key": "project", "label": "Project", "type": "string", "default": "Connect"},
            {"key": "label", "label": "App label", "type": "string", "default": "connect"}
        ]);
        testkit::local_market(env, &[m]);
        let shown = dispatch(
            &env.paths,
            &testkit::NoGit,
            "inspect",
            json!({"market": "local", "id": "todoist"}),
        )
        .unwrap();
        let keys: Vec<Value> = shown["sheet"]
            .as_array()
            .unwrap()
            .iter()
            .map(|l| l["key"].clone())
            .collect();
        assert!(keys.contains(&json!("provides_tasks")), "{keys:?}");
        let out = dispatch(
            &env.paths,
            &testkit::NoGit,
            "install",
            json!({"market": "local", "id": "todoist", "agreed": keys, "sheetHash": shown["sheetHash"]}),
        )
        .unwrap();
        assert_eq!(out["status"], "installed");
    }

    /// Every file under `dir` whose bytes contain `needle`.
    fn files_containing(dir: &std::path::Path, needle: &str) -> Vec<std::path::PathBuf> {
        let mut found = Vec::new();
        for entry in std::fs::read_dir(dir).into_iter().flatten().flatten() {
            let path = entry.path();
            if path.is_dir() {
                found.extend(files_containing(&path, needle));
            } else if std::fs::read(&path)
                .is_ok_and(|b| b.windows(needle.len()).any(|w| w == needle.as_bytes()))
            {
                found.push(path);
            }
        }
        found
    }

    #[test]
    fn secret_settings_are_write_only() {
        let env = testkit::env();
        installed_provider(&env);
        let run = |data: Value| dispatch(&env.paths, &testkit::NoGit, "set_setting", data);
        let view = run(json!({"id": "todoist", "key": "token", "value": SENTINEL})).unwrap();
        assert!(!view.to_string().contains(SENTINEL), "{view}");
        assert_eq!(
            view["settings"][0],
            json!({"key": "token", "label": "API token", "type": "secret",
                   "help": "Todoist › Settings › Integrations › Developer", "set": true})
        );
        assert_eq!(
            view["settings"][1],
            json!({"key": "project", "label": "Project", "type": "string", "help": null, "value": "Connect"})
        );
        // Stored once, owner-only, in the private root; nowhere in the data root.
        let secrets = env.private.join("credentials/plugins/todoist/secrets.json");
        assert!(std::fs::read_to_string(&secrets)
            .unwrap()
            .contains(SENTINEL));
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = std::fs::metadata(&secrets).unwrap().permissions().mode() & 0o777;
            assert_eq!(mode, 0o600);
        }
        assert_eq!(files_containing(&env.private, SENTINEL), [secrets.clone()]);
        assert!(files_containing(&env.dir.path().join("data"), SENTINEL).is_empty());
        let listed = dispatch(&env.paths, &testkit::NoGit, "installed", Value::Null).unwrap();
        assert!(!listed.to_string().contains(SENTINEL));
        assert_eq!(listed[0]["settings"][0]["set"], true);
        // It is a task provider's secret: the caller queues a sync. A plain setting isn't.
        assert!(extras::set_setting(&env.paths, "todoist", "token", &json!(SENTINEL)).unwrap());
        assert!(!extras::set_setting(&env.paths, "todoist", "project", &json!("Work")).unwrap());
        let view = run(json!({"id": "todoist", "key": "label", "value": "naya"})).unwrap();
        assert_eq!(view["settings"][1]["value"], "Work");
        assert_eq!(view["settings"][2]["value"], "naya");

        // Refused: an undeclared key, a value of the wrong type (its words never echo the value).
        let e = run(json!({"id": "todoist", "key": "nope", "value": "x"})).unwrap_err();
        assert_eq!(
            (e.code.as_str(), e.message.as_str()),
            ("invalid", "todoist has no setting “nope” in its manifest")
        );
        let e = run(json!({"id": "todoist", "key": "project", "value": 5})).unwrap_err();
        assert_eq!(e.code, "invalid");
        let e = run(json!({"id": "ghost", "key": "token", "value": SENTINEL})).unwrap_err();
        assert_eq!(e.code, "not_found");
        assert!(!e.message.contains(SENTINEL));

        // `""` and `null` clear it.
        let view = run(json!({"id": "todoist", "key": "token", "value": ""})).unwrap();
        assert_eq!(view["settings"][0]["set"], false);
        assert!(!std::fs::read_to_string(&secrets)
            .unwrap()
            .contains(SENTINEL));
        run(json!({"id": "todoist", "key": "token", "value": SENTINEL})).unwrap();
        let view = run(json!({"id": "todoist", "key": "token", "value": null})).unwrap();
        assert_eq!(view["settings"][0]["set"], false);
        assert!(files_containing(env.dir.path(), SENTINEL).is_empty());
    }

    #[test]
    fn contract_fixtures_match_the_plugin_settings() {
        let env = testkit::env();
        installed_provider(&env);
        let mut view = dispatch(
            &env.paths,
            &testkit::NoGit,
            "set_setting",
            json!({"id": "todoist", "key": "token", "value": SENTINEL}),
        )
        .unwrap();
        assert!(!view.to_string().contains(SENTINEL));
        view["source"] = json!("/Users/qa/Plugins/acme-market");
        testkit::contract_fixture("plugin-settings.json", &pin(view));
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
        next["summary"] = json!("Built for a newer plugin engine");
        next["engine"] = json!(">=1.1");
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
            "It needs plugin engine >=1.1.0, and Connect provides engine 1.0."
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
        // Its own words that name Echo, which its frame says in Connect's. The script is taken
        // away again, so the package the rest of the flow hashes is the one installed.
        let view = env.paths.installed().join("standup/1.0.0/view.js");
        std::fs::write(
            &view,
            "say(`Echo posts your standup when the meeting ends`)\nsay('Ask in Echo\\'s panel')\n",
        )
        .unwrap();
        let phrases = run("host_phrases", json!({"id": "standup"})).unwrap();
        std::fs::remove_file(&view).unwrap();
        assert_eq!(
            phrases["phrases"],
            json!([
                "Echo posts your standup when the meeting ends",
                "Ask in Echo's panel"
            ])
        );

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

        // The list can't be read: every request says so until it is reset, which takes the
        // installed copy back, off and with no agreement; turning it on asks for one.
        std::fs::write(env.paths.registry(), "{").unwrap();
        let unreadable = run("installed", Value::Null).unwrap_err();
        assert_eq!(unreadable.code, "registry_unreadable");
        let unreadable = json!({"code": unreadable.code, "message": unreadable.message});
        let mut reset = run("registry_reset", Value::Null).unwrap();
        assert!(reset["saved"]
            .as_str()
            .unwrap()
            .starts_with("registry.json.bad-"));
        reset["saved"] = json!("registry.json.bad-20261117T093000.000Z");
        assert_eq!(reset["adopted"], json!(["standup"]));
        let adopted = run("installed", Value::Null).unwrap();
        assert_eq!(adopted[0]["market"], "");
        assert_eq!(adopted[0]["enabled"], false);
        let enable = run("set_enabled", json!({"id": "standup", "enabled": true})).unwrap();
        assert_eq!(enable["status"], "needs_consent");
        assert_eq!(enable["lines"].as_array().unwrap().len(), 4);

        for (name, value) in [
            ("plugins-markets.json", markets),
            ("plugins-catalog.json", catalog),
            ("plugins-inspect.json", inspect),
            ("plugins-host-phrases.json", phrases),
            ("plugins-installed.json", installed_list),
            ("plugins-update-needs-consent.json", needs),
            ("plugins-registry-unreadable.json", unreadable),
            ("plugins-registry-reset.json", reset),
            ("plugins-installed-adopted.json", adopted),
            ("plugins-enable-needs-consent.json", enable),
        ] {
            testkit::contract_fixture(name, &pin(value));
        }
    }

    #[test]
    fn the_installed_list_says_why_a_host_half_did_not_load() {
        let list = json!([{"id": "telegram", "enabled": true}, {"id": "github", "enabled": true}]);
        let problems = std::collections::BTreeMap::from([
            (
                "telegram".to_string(),
                "unsupported: CodeMie Connect doesn't have ctx.sessions (only Echo has it), so \
                 this plugin needs a change to run here: cannot read property 'clearChannel' of \
                 undefined"
                    .to_string(),
            ),
            ("gone".to_string(), "its manifest names it “x”".to_string()),
        ]);
        let out = with_load_errors(list, &problems);
        assert_eq!(
            out[0]["loadError"],
            "CodeMie Connect doesn't have ctx.sessions (only Echo has it), so this plugin needs \
             a change to run here: cannot read property 'clearChannel' of undefined"
        );
        assert_eq!(out[1].get("loadError"), None);
        let other = with_load_errors(json!([{"id": "gone"}]), &problems);
        assert_eq!(other[0]["loadError"], "its manifest names it “x”");
    }

    #[test]
    fn turning_on_asks_again_for_lines_not_agreed_and_records_the_agreement() {
        let env = testkit::env();
        let mut m = manifest("hello", "1.0.0");
        m["uses"] = json!({"network": {"hosts": ["api.example.com"]}});
        testkit::local_market(&env, &[m]);
        let run = |op: &str, data: Value| dispatch(&env.paths, &testkit::NoGit, op, data);
        let shown = run("inspect", json!({"market": "local", "id": "hello"})).unwrap();
        run(
            "install",
            json!({"market": "local", "id": "hello", "agreed": ["network"], "sheetHash": shown["sheetHash"]}),
        )
        .unwrap();
        run("set_enabled", json!({"id": "hello", "enabled": false})).unwrap();
        // As after a reset: nothing agreed to any more.
        std::fs::write(env.paths.registry(), "{").unwrap();
        run("registry_reset", Value::Null).unwrap();
        let asked = run("set_enabled", json!({"id": "hello", "enabled": true})).unwrap();
        assert_eq!(asked["status"], "needs_consent");
        assert_eq!(asked["sheetHash"], shown["sheetHash"]);
        let e = run(
            "set_enabled",
            json!({"id": "hello", "enabled": true, "agreed": [], "sheetHash": asked["sheetHash"]}),
        )
        .unwrap_err();
        assert_eq!(e.code, "consent_required");
        let e = run(
            "set_enabled",
            json!({"id": "hello", "enabled": true, "agreed": ["network"], "sheetHash": "0"}),
        )
        .unwrap_err();
        assert_eq!(e.code, "changed");
        let on = run(
            "set_enabled",
            json!({"id": "hello", "enabled": true, "agreed": ["network"], "sheetHash": asked["sheetHash"]}),
        )
        .unwrap();
        assert_eq!(on["enabled"], true);
        assert_eq!(on["agreed"], json!(["network"]));
        // Off and on again needs nothing new.
        run("set_enabled", json!({"id": "hello", "enabled": false})).unwrap();
        let again = run("set_enabled", json!({"id": "hello", "enabled": true})).unwrap();
        assert_eq!(again["enabled"], true);
        // Addresses and the client's storage go through the same request.
        let stored = run(
            "client_storage",
            json!({"id": "hello", "items": {"tab": "graph"}}),
        )
        .unwrap();
        assert_eq!(stored, json!({"items": {"tab": "graph"}}));
        assert_eq!(
            run("client_storage", json!({"id": "hello"})).unwrap(),
            json!({"items": {"tab": "graph"}})
        );
        assert_eq!(
            run(
                "set_addresses",
                json!({"id": "hello", "key": "servers", "value": "x"})
            )
            .unwrap_err()
            .code,
            "invalid"
        );
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
        let names: Vec<_> = markets
            .as_array()
            .unwrap()
            .iter()
            .map(|m| m["name"].clone())
            .collect();
        assert_eq!(names, [json!("codemie"), json!("onetest")]);
        // An unreadable list says so in every request, until it is reset.
        std::fs::write(env.paths.registry(), "{").unwrap();
        assert_eq!(
            run("markets", Value::Null).unwrap_err().code,
            "registry_unreadable"
        );
        let reset = run("registry_reset", Value::Null).unwrap();
        assert_eq!(reset["adopted"], json!([]));
        assert_eq!(reset["leftovers"], json!([]));
        assert_eq!(
            run("markets", Value::Null)
                .unwrap()
                .as_array()
                .unwrap()
                .len(),
            2
        );
    }
}
