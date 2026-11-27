//! What Settings → Plugins shows and sets about an installed plugin beyond its registry entry
//! (DESIGN 7.3):
//! - for the window: its client half, which gets a frame, and the widgets it declares for Today;
//! - its GitHub sign-ins (`uses.signin.hosts`): whether the user signed it in, never the token;
//! - the network addresses only the user gives it (`uses.network.hosts_from`): the plugin can't
//!   set those settings itself (`services::settings::set`);
//! - its other declared settings, which the user sets in Connect (`set_setting`): a `secret` is
//!   write-only, reported only as set or not, never read back to the window;
//! - what its client half keeps in its frame's `localStorage` stand-in (an opaque frame has no
//!   storage of its own), in `<data>/plugins/data/<id>/client-storage.json`, which goes with
//!   "Also delete its data".
use super::manifest::Manifest;
use super::registry::{Installed, PluginPaths, Registry};
use super::services::{read_json, settings, write_json};
use crate::workspace::models::{Result, WorkspaceError};
use serde::Serialize;
use serde_json::{json, Map, Value};

/// The longest list of addresses the user types for a plugin.
const MAX_ADDRESSES: usize = 8 * 1024;
/// The most a client half keeps in its `localStorage` stand-in, as JSON.
const MAX_CLIENT_STORAGE: usize = 1024 * 1024;

#[derive(Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct Extras {
    /// Its client half, relative to its package; none: no frame.
    pub client: Option<String>,
    pub widgets: Vec<WidgetView>,
    pub signin: Vec<SigninView>,
    pub addresses: Vec<AddressView>,
    pub settings: Vec<SettingView>,
}

/// One declared setting the user sets in Connect (not an address setting: those are
/// `addresses`). A secret says only whether it is set.
#[derive(Serialize)]
#[serde(untagged)]
pub enum SettingView {
    Plain {
        key: String,
        label: String,
        #[serde(rename = "type")]
        kind: String,
        help: Option<String>,
        /// What was set, else the manifest's default, else `null`.
        value: Value,
    },
    Secret {
        key: String,
        label: String,
        #[serde(rename = "type")]
        kind: String,
        help: Option<String>,
        set: bool,
    },
}

#[derive(Serialize)]
pub struct WidgetView {
    id: String,
    label: String,
    about: String,
    kind: String,
    sizes: Vec<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SigninView {
    host: String,
    signed_in: bool,
    /// `gh` (the user's Sign in) or `echo` (one the plugin made and Connect keeps).
    from: Option<String>,
}

#[derive(Serialize)]
pub struct AddressView {
    key: String,
    label: String,
    help: Option<String>,
    /// What the user typed, `""` when nothing.
    value: String,
}

/// The agreed `uses.<key>.<field>` words; nothing when the key wasn't agreed to.
fn agreed_words(m: &Manifest, p: &Installed, key: &str, field: &str) -> Vec<String> {
    if !p.agreed.iter().any(|a| a == key) {
        return Vec::new();
    }
    m.uses
        .get(key)
        .and_then(|v| v.get(field))
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(Value::as_str)
        .map(str::to_string)
        .collect()
}

fn object(v: Value) -> Map<String, Value> {
    match v {
        Value::Object(map) => map,
        _ => Map::new(),
    }
}

fn settings_file(paths: &PluginPaths, id: &str) -> std::path::PathBuf {
    paths.data_of(id).join("settings.json")
}

fn storage_file(paths: &PluginPaths, id: &str) -> std::path::PathBuf {
    paths.data_of(id).join("client-storage.json")
}

/// What the window shows about installed plugin `id` besides its registry entry.
pub fn extras(paths: &PluginPaths, id: &str, p: &Installed, m: Option<&Manifest>) -> Extras {
    let Some(m) = m else {
        return Extras::default();
    };
    let kept = object(read_json(
        &paths.secrets_of(id).join("signin.json"),
        json!({}),
    ));
    let set = object(read_json(&settings_file(paths, id), json!({})));
    Extras {
        client: m.client.clone(),
        widgets: m
            .widgets
            .iter()
            .map(|w| WidgetView {
                id: w.id.clone(),
                label: w.label.clone(),
                about: w.about.clone(),
                kind: w.kind.clone(),
                sizes: w.sizes.clone(),
            })
            .collect(),
        signin: agreed_words(m, p, "signin", "hosts")
            .into_iter()
            .map(|host| {
                let entry = kept
                    .iter()
                    .find(|(k, _)| k.eq_ignore_ascii_case(&host))
                    .map(|(_, v)| v);
                SigninView {
                    signed_in: entry.is_some(),
                    from: entry.and_then(|e| e["from"].as_str()).map(str::to_string),
                    host,
                }
            })
            .collect(),
        settings: user_settings(m)
            .map(|d| {
                let (key, label, kind, help) = (
                    d.key.clone(),
                    d.label.clone(),
                    d.kind.clone(),
                    d.help.clone(),
                );
                if d.kind == "secret" {
                    SettingView::Secret {
                        set: settings::secret_is_set(paths, id, &d.key),
                        key,
                        label,
                        kind,
                        help,
                    }
                } else {
                    SettingView::Plain {
                        value: set
                            .get(&d.key)
                            .filter(|v| !v.is_null())
                            .or(d.default.as_ref())
                            .cloned()
                            .unwrap_or(Value::Null),
                        key,
                        label,
                        kind,
                        help,
                    }
                }
            })
            .collect(),
        addresses: address_settings(m, p)
            .into_iter()
            .map(|(key, label, help)| AddressView {
                value: set
                    .get(&key)
                    .and_then(Value::as_str)
                    .unwrap_or_default()
                    .to_string(),
                key,
                label,
                help,
            })
            .collect(),
    }
}

/// The declared settings `uses.network.hosts_from` names: `(key, label, help)`.
fn address_settings(m: &Manifest, p: &Installed) -> Vec<(String, String, Option<String>)> {
    agreed_words(m, p, "network", "hosts_from")
        .into_iter()
        .filter_map(|key| m.settings.iter().find(|s| s.key == key))
        .map(|s| (s.key.clone(), s.label.clone(), s.help.clone()))
        .collect()
}

/// Every setting its manifest names in `uses.network.hosts_from`, agreed to or not: only
/// `set_addresses` sets those.
fn hosts_from(m: &Manifest) -> Vec<&str> {
    m.uses
        .get("network")
        .and_then(|v| v.get("hosts_from"))
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(Value::as_str)
        .collect()
}

/// The declared settings the user sets with `set_setting`: all but the address settings.
fn user_settings(m: &Manifest) -> impl Iterator<Item = &super::manifest::SettingDef> {
    let addresses = hosts_from(m);
    m.settings
        .iter()
        .filter(move |s| !addresses.contains(&s.key.as_str()))
}

/// A setting of a plugin that provides tasks, as `set_setting` saw it (the caller tells the core).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TaskSetting {
    /// Its secret (the token): a sync is queued.
    Secret,
    /// Any other setting (its project, its label): the provider is read again in full.
    Other,
}

/// The user set plugin `id`'s declared setting `key` in Connect (Settings › Tasks). `null`, or
/// `""` for a secret, clears it. A secret goes only to the private root (0600) and is never read
/// back. Answers which setting of a plugin that provides tasks it was, if it was one.
pub fn set_setting(
    paths: &PluginPaths,
    id: &str,
    key: &str,
    value: &Value,
) -> Result<Option<TaskSetting>> {
    let (p, m) = installed_with_manifest(paths, id)?;
    if hosts_from(&m).contains(&key) {
        return Err(WorkspaceError::new(
            "invalid",
            format!(
                "“{}” lists the addresses {id} may reach: set it under its addresses",
                key.escape_debug()
            ),
        ));
    }
    let def = user_settings(&m).find(|s| s.key == key).ok_or_else(|| {
        WorkspaceError::new(
            "invalid",
            format!(
                "{id} has no setting “{}” in its manifest",
                key.escape_debug()
            ),
        )
    })?;
    settings::store(paths, id, def, value).map_err(|e| match e.code {
        crate::plugins::host::ErrorCode::PluginError => WorkspaceError::new("invalid", e.message),
        _ => saved(e),
    })?;
    let role = super::capabilities::role_key("tasks");
    let provider = m.provides.iter().any(|r| r == "tasks") && p.agreed.iter().any(|a| a == &role);
    Ok(provider.then_some(if def.kind == "secret" {
        TaskSetting::Secret
    } else {
        TaskSetting::Other
    }))
}

fn installed_with_manifest(paths: &PluginPaths, id: &str) -> Result<(Installed, Manifest)> {
    let reg = Registry::load(paths)?;
    let p = reg.installed.get(id).cloned().ok_or_else(|| {
        WorkspaceError::new(
            "not_found",
            format!("“{}” isn’t installed.", id.escape_debug()),
        )
    })?;
    let m = super::install::installed_manifest(paths, id, &p).ok_or_else(|| {
        WorkspaceError::new(
            "refused",
            format!("The files of “{id}” can’t be read. Remove it and install it again."),
        )
    })?;
    Ok((p, m))
}

fn saved(e: crate::plugins::host::HostError) -> WorkspaceError {
    WorkspaceError::new("io", e.message)
}

/// The user typed the addresses plugin `id` may reach for its setting `key` (one that
/// `uses.network.hosts_from` names); empty clears them.
pub fn set_addresses(paths: &PluginPaths, id: &str, key: &str, value: &str) -> Result<()> {
    let (p, m) = installed_with_manifest(paths, id)?;
    if !address_settings(&m, &p).iter().any(|(k, _, _)| k == key) {
        return Err(WorkspaceError::new(
            "invalid",
            format!("“{id}” has no address setting “{}”.", key.escape_debug()),
        ));
    }
    let value = value.trim();
    if value.len() > MAX_ADDRESSES || value.chars().any(char::is_control) {
        return Err(WorkspaceError::new(
            "invalid",
            "Addresses are one line of text, 8 KB at most.",
        ));
    }
    let file = settings_file(paths, id);
    let mut all = object(read_json(&file, json!({})));
    if value.is_empty() {
        all.remove(key);
    } else {
        all.insert(key.to_string(), json!(value));
    }
    write_json(&file, &Value::Object(all)).map_err(saved)
}

/// What plugin `id`'s client half keeps in its `localStorage` stand-in: text by text key.
/// The phrases of plugin `id`'s own scripts that name Echo (`phrases::echo_phrases`), for its
/// frame to say Connect there: `{phrases}`.
pub fn host_phrases(paths: &PluginPaths, id: &str) -> Result<Value> {
    installed_with_manifest(paths, id)?;
    let phrases = super::registry::active_version(paths, id)
        .map(|v| super::phrases::echo_phrases(&paths.installed().join(id).join(v)))
        .unwrap_or_default();
    Ok(json!({ "phrases": phrases }))
}

pub fn client_storage(paths: &PluginPaths, id: &str) -> Result<Value> {
    installed_with_manifest(paths, id)?;
    let items: Map<String, Value> = object(read_json(&storage_file(paths, id), json!({})))
        .into_iter()
        .filter(|(_, v)| v.is_string())
        .collect();
    Ok(json!({ "items": items }))
}

/// Replaces what plugin `id`'s client half keeps: an object of text values, 1 MB at most.
pub fn set_client_storage(paths: &PluginPaths, id: &str, items: &Value) -> Result<Value> {
    installed_with_manifest(paths, id)?;
    let fits = items
        .as_object()
        .is_some_and(|map| map.values().all(Value::is_string))
        && items.to_string().len() <= MAX_CLIENT_STORAGE;
    if !fits {
        return Err(WorkspaceError::new(
            "invalid",
            "A plugin keeps text values only, 1 MB at most.",
        ));
    }
    write_json(&storage_file(paths, id), items).map_err(saved)?;
    Ok(json!({ "items": items }))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::plugins::install::{self, Agreement, Outcome};
    use crate::plugins::testkit::{self, manifest};

    fn installed(env: &testkit::Env, m: Value) {
        testkit::local_market(env, &[m]);
        let shown = crate::plugins::commands::dispatch(
            &env.paths,
            &testkit::NoGit,
            "inspect",
            json!({"market": "local", "id": "relay"}),
        )
        .unwrap();
        let keys: Vec<String> = shown["sheet"]
            .as_array()
            .unwrap()
            .iter()
            .map(|l| l["key"].as_str().unwrap().to_string())
            .collect();
        let out = install::install(
            &env.paths,
            "local",
            "relay",
            Agreement {
                keys: &keys,
                sheet_hash: shown["sheetHash"].as_str().unwrap(),
            },
        )
        .unwrap();
        assert!(matches!(out, Outcome::Installed(_)));
    }

    fn relay() -> Value {
        let mut m = manifest("relay", "1.0.0");
        m["uses"] = json!({
            "network": {"hosts": ["api.example.com"], "hosts_from": ["servers"]},
            "signin": {"hosts": ["github.com"]},
        });
        m["settings"] = json!([
            {"key": "servers", "label": "Your servers", "help": "Comma-separated"},
            {"key": "mode", "label": "Mode"},
        ]);
        m["widgets"] =
            json!([{"id": "glance", "label": "At a glance", "kind": "stat", "sizes": ["S"]}]);
        m
    }

    #[test]
    fn extras_name_the_client_widgets_signins_and_addresses() {
        let env = testkit::env();
        installed(&env, relay());
        let reg = Registry::load(&env.paths).unwrap();
        let p = &reg.installed["relay"];
        let m = install::installed_manifest(&env.paths, "relay", p).unwrap();
        let before = serde_json::to_value(extras(&env.paths, "relay", p, Some(&m))).unwrap();
        assert_eq!(before["client"], "client.js");
        assert_eq!(before["widgets"][0]["id"], "glance");
        assert_eq!(
            before["signin"],
            json!([{"host": "github.com", "signedIn": false, "from": null}])
        );
        assert_eq!(
            before["addresses"],
            json!([{"key": "servers", "label": "Your servers", "help": "Comma-separated", "value": ""}])
        );
        set_addresses(&env.paths, "relay", "servers", "  10.0.0.5, nas.local ").unwrap();
        std::fs::create_dir_all(env.paths.secrets_of("relay")).unwrap();
        std::fs::write(
            env.paths.secrets_of("relay").join("signin.json"),
            r#"{"github.com": {"token": "t", "from": "gh"}}"#,
        )
        .unwrap();
        let after = serde_json::to_value(extras(&env.paths, "relay", p, Some(&m))).unwrap();
        assert_eq!(after["addresses"][0]["value"], "10.0.0.5, nas.local");
        assert_eq!(after["signin"][0]["signedIn"], true);
        assert_eq!(after["signin"][0]["from"], "gh");
        assert!(
            !after.to_string().contains("\"t\""),
            "the token never leaves Rust"
        );
        // Only an address setting, one line, and only for an installed plugin.
        let refused = |key: &str, value: &str| {
            set_addresses(&env.paths, "relay", key, value)
                .unwrap_err()
                .code
        };
        assert_eq!(refused("mode", "x"), "invalid");
        assert_eq!(refused("servers", "a\nb"), "invalid");
        assert_eq!(
            set_addresses(&env.paths, "ghost", "servers", "x")
                .unwrap_err()
                .code,
            "not_found"
        );
        set_addresses(&env.paths, "relay", "servers", "").unwrap();
        let cleared = serde_json::to_value(extras(&env.paths, "relay", p, Some(&m))).unwrap();
        assert_eq!(cleared["addresses"][0]["value"], "");
    }

    #[test]
    fn address_settings_are_set_only_as_addresses() {
        let env = testkit::env();
        installed(&env, relay());
        let e = set_setting(&env.paths, "relay", "servers", &json!("10.0.0.5")).unwrap_err();
        assert_eq!(e.code, "invalid");
        assert!(
            e.message.contains("set it under its addresses"),
            "{}",
            e.message
        );
        // Its other setting is the user's to set, and is no task provider's secret.
        assert_eq!(
            set_setting(&env.paths, "relay", "mode", &json!("fast")).unwrap(),
            None
        );
        let reg = Registry::load(&env.paths).unwrap();
        let p = &reg.installed["relay"];
        let m = install::installed_manifest(&env.paths, "relay", p).unwrap();
        let view = serde_json::to_value(extras(&env.paths, "relay", p, Some(&m))).unwrap();
        assert_eq!(
            view["settings"],
            json!([{"key": "mode", "label": "Mode", "type": "string", "help": null, "value": "fast"}])
        );
    }

    #[test]
    fn client_storage_keeps_text_values_for_an_installed_plugin() {
        let env = testkit::env();
        installed(&env, relay());
        assert_eq!(
            client_storage(&env.paths, "relay").unwrap(),
            json!({"items": {}})
        );
        set_client_storage(&env.paths, "relay", &json!({"tab": "graph", "n": "3"})).unwrap();
        assert_eq!(
            client_storage(&env.paths, "relay").unwrap(),
            json!({"items": {"tab": "graph", "n": "3"}})
        );
        for bad in [
            json!({"n": 3}),
            json!(["x"]),
            json!({"big": "x".repeat(MAX_CLIENT_STORAGE)}),
        ] {
            assert_eq!(
                set_client_storage(&env.paths, "relay", &bad)
                    .unwrap_err()
                    .code,
                "invalid"
            );
        }
        assert_eq!(
            client_storage(&env.paths, "ghost").unwrap_err().code,
            "not_found"
        );
    }
}
