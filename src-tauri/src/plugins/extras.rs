//! What Settings → Plugins shows and sets about an installed plugin beyond its registry entry
//! (DESIGN 7.3):
//! - for the window: its client half, which gets a frame, and the widgets it declares for Today;
//! - its GitHub sign-ins (`uses.signin.hosts`): whether the user signed it in, never the token;
//! - the network addresses only the user gives it (`uses.network.hosts_from`): the plugin can't
//!   set those settings itself (`services::settings::set`);
//! - what its client half keeps in its frame's `localStorage` stand-in (an opaque frame has no
//!   storage of its own), in `<data>/plugins/data/<id>/client-storage.json`, which goes with
//!   "Also delete its data".
use super::manifest::Manifest;
use super::registry::{Installed, PluginPaths, Registry};
use super::services::{read_json, write_json};
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
