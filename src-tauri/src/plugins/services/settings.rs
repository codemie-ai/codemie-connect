//! `ctx.settings`: the settings its manifest declares. Plain values live in
//! `<data>/plugins/data/<id>/settings.json`; `secret` ones only in
//! `<private>/credentials/plugins/<id>/secrets.json`, written 0600 inside 0700 folders, never in
//! the data folder (PLUGIN-ENGINE.md §8). The addresses a plugin may reach over the network
//! (`uses.network.hosts_from`) are the user's to set, never the plugin's.
use super::{bad, io_failed, permission, read_json, write_json, Granted, Services};
use crate::plugins::host::HostError;
use serde_json::{json, Map, Value};
use std::path::{Path, PathBuf};

/// The longest text a setting holds.
const MAX_TEXT: usize = 8 * 1024;

fn settings_file(s: &Services, id: &str) -> PathBuf {
    s.data_of(id).join("settings.json")
}

pub(crate) fn secrets_file(s: &Services, id: &str) -> PathBuf {
    s.paths.secrets_of(id).join("secrets.json")
}

/// Its value: what was set, else the manifest's default, else `null`. An undeclared key is
/// `null`.
pub fn get(s: &Services, p: &Granted, key: &str) -> Value {
    let Some(def) = p.setting(key) else {
        return Value::Null;
    };
    let file = if def.kind == "secret" {
        secrets_file(s, &p.id)
    } else {
        settings_file(s, &p.id)
    };
    match read_json(&file, json!({})).get(key) {
        Some(v) if !v.is_null() => v.clone(),
        _ => def.default.clone().unwrap_or(Value::Null),
    }
}

/// Sets a declared setting the plugin may set; `null` (or `""` for a secret) clears it.
pub fn set(s: &Services, p: &Granted, key: &str, value: &Value) -> Result<Value, HostError> {
    let def = p
        .setting(key)
        .ok_or_else(|| bad(format!("{} has no setting “{key}” in its manifest", p.id)))?;
    if p.words("network", "hosts_from").iter().any(|k| k == key) {
        return Err(permission(format!(
            "only you set the addresses {} may reach (its setting “{key}”)",
            p.id
        )));
    }
    let fits = match (def.kind.as_str(), value) {
        (_, Value::Null) => true,
        ("bool", v) => v.is_boolean(),
        (_, Value::String(t)) => t.len() <= MAX_TEXT,
        _ => false,
    };
    if !fits {
        return Err(bad(format!(
            "“{key}” is a {} setting: {}",
            def.kind,
            if def.kind == "bool" {
                "true or false"
            } else {
                "text of 8 KB at most"
            }
        )));
    }
    s.writable()?;
    if def.kind == "secret" {
        let mut secrets = read_object(&secrets_file(s, &p.id));
        match value.as_str().filter(|t| !t.is_empty()) {
            Some(t) => secrets.insert(key.into(), json!(t)),
            None => secrets.remove(key),
        };
        write_private(&secrets_file(s, &p.id), &Value::Object(secrets))?;
    } else {
        let file = settings_file(s, &p.id);
        let mut all = read_object(&file);
        if value.is_null() {
            all.remove(key);
        } else {
            all.insert(key.into(), value.clone());
        }
        write_json(&file, &Value::Object(all))?;
    }
    Ok(Value::Null)
}

/// The addresses the user listed in the settings `uses.network.hosts_from` names.
pub fn listed_addresses(s: &Services, p: &Granted) -> Vec<String> {
    p.words("network", "hosts_from")
        .iter()
        .filter_map(|key| get(s, p, key).as_str().map(str::to_string))
        .flat_map(|text| {
            text.split(|c: char| c == ',' || c.is_whitespace())
                .filter(|a| !a.is_empty())
                .map(str::to_string)
                .collect::<Vec<_>>()
        })
        .collect()
}

fn read_object(file: &Path) -> Map<String, Value> {
    match read_json(file, json!({})) {
        Value::Object(map) => map,
        _ => Map::new(),
    }
}

/// Writes a file only the user can read: 0700 folders (`<private>/credentials/plugins/<id>`),
/// a 0600 file, replaced atomically, never through a link.
pub(crate) fn write_private(file: &Path, value: &Value) -> Result<(), HostError> {
    let dir = file.parent().ok_or_else(|| bad("no folder for it"))?;
    let failed = |e: std::io::Error| io_failed("keep it in Connect's private folder", &e);
    for d in [dir.parent().unwrap_or(dir), dir] {
        if std::fs::symlink_metadata(d).is_ok_and(|m| m.file_type().is_symlink()) {
            return Err(permission("Connect's private folder for plugins is a link"));
        }
        std::fs::create_dir_all(d).map_err(failed)?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(d, std::fs::Permissions::from_mode(0o700)).map_err(failed)?;
        }
    }
    let bytes = serde_json::to_vec(value).map_err(|e| bad(e.to_string()))?;
    let tmp = dir.join(format!(".{}.tmp", uuid::Uuid::new_v4()));
    let written = (|| {
        use std::io::Write;
        let mut options = std::fs::OpenOptions::new();
        options.write(true).create_new(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        let mut f = options.open(&tmp)?;
        f.write_all(&bytes)?;
        f.sync_all()?;
        std::fs::rename(&tmp, file)
    })();
    if written.is_err() {
        let _ = std::fs::remove_file(&tmp);
    }
    written.map_err(failed)
}

#[cfg(test)]
mod tests {
    use super::super::testing::Env;
    use super::*;
    use crate::plugins::host::ErrorCode;

    fn declared() -> Value {
        json!([
            {"key": "bot_token", "label": "Bot", "type": "secret"},
            {"key": "knowledge", "label": "K", "type": "bool", "default": false},
            {"key": "server", "label": "Server", "type": "string"},
            {"key": "name", "label": "Name", "type": "string", "default": "x"}
        ])
    }

    #[test]
    fn secret_settings_are_written_0600_in_private_root() {
        let env = Env::new();
        env.plugin(
            "telegram",
            json!({"network": {"hosts": ["api.telegram.org"], "hosts_from": ["server"]}}),
            declared(),
        );
        let call = |name: &str, args: Value| env.call("telegram", name, args);
        call("settings.set", json!(["bot_token", "123:abc"])).unwrap();
        call("settings.set", json!(["knowledge", true])).unwrap();
        assert_eq!(
            call("settings.get", json!(["bot_token"])).unwrap(),
            json!("123:abc")
        );
        assert_eq!(
            call("settings.get", json!(["knowledge"])).unwrap(),
            json!(true)
        );
        assert_eq!(call("settings.get", json!(["name"])).unwrap(), json!("x"));
        assert_eq!(
            call("settings.get", json!(["undeclared"])).unwrap(),
            Value::Null
        );

        // The secret is in the private root only, owner-only; nothing of it in the data folder.
        let secrets = env
            .dir
            .path()
            .join("private/credentials/plugins/telegram/secrets.json");
        assert!(secrets.is_file());
        let data = env.services.data_of("telegram");
        let settings = std::fs::read_to_string(data.join("settings.json")).unwrap();
        assert!(!settings.contains("123:abc") && settings.contains("knowledge"));
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = |p: &Path| std::fs::metadata(p).unwrap().permissions().mode() & 0o777;
            assert_eq!(mode(&secrets), 0o600);
            assert_eq!(mode(secrets.parent().unwrap()), 0o700);
            assert_eq!(
                mode(&env.dir.path().join("private/credentials/plugins")),
                0o700
            );
        }
        // Clearing a secret removes it.
        call("settings.set", json!(["bot_token", ""])).unwrap();
        assert_eq!(
            call("settings.get", json!(["bot_token"])).unwrap(),
            Value::Null
        );
        assert!(!std::fs::read_to_string(&secrets)
            .unwrap()
            .contains("123:abc"));

        // Undeclared keys, wrong types and the user's addresses are refused.
        let e = call("settings.set", json!(["other", "x"])).unwrap_err();
        assert_eq!(e.code, ErrorCode::PluginError);
        assert!(call("settings.set", json!(["knowledge", "yes"])).is_err());
        let e = call("settings.set", json!(["server", "http://10.0.0.2"])).unwrap_err();
        assert_eq!(e.code, ErrorCode::Permission);
        assert!(
            listed_addresses(&env.services, &env.services.granted("telegram").unwrap()).is_empty()
        );
    }
}
