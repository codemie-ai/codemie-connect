//! Events plugins hear (PLUGIN-ENGINE.md §7): Connect sends `meeting_soon`, `sources_changed` (from
//! `Core`, through `HostEvents`) and `shared_changed`, which is told here when a plugin changes a
//! value its marketplace's plugins share (`ctx.shared.get/set`, keys `<namespace>.<name>`). Any
//! plugin reads any namespace; only the plugins of the marketplace the namespace is named after
//! set it. `shared_changed` (`{namespace, key, by}`, never the value) goes to the namespace's
//! other plugins, never to the one that set it, and only when the value changed.
use super::{bad, permission, read_json, write_json, Granted, Services};
use crate::plugins::host::{ErrorCode, HostError, PluginHost};
use crate::workspace::EventSink;
use serde_json::{json, Map, Value};
use std::sync::Weak;

const MAX_VALUE: usize = 16 * 1024;
const MAX_KEYS: usize = 64;

/// `Core`'s events, told to the plugins granted them.
pub struct HostEvents(pub Weak<PluginHost>);

impl EventSink for HostEvents {
    fn emit(&self, event: &str, payload: Value) {
        if let Some(host) = self.0.upgrade() {
            host.emit(event, payload);
        }
    }

    fn hears(&self, event: &str) -> bool {
        self.0.upgrade().is_some_and(|h| h.anyone_hears(event))
    }
}

/// `<namespace>.<name>`: a namespace of `a–z 0–9 -` and a name of 1–80 characters.
fn split(key: &str) -> Result<(&str, &str), HostError> {
    let (ns, name) = key
        .split_once('.')
        .ok_or_else(|| bad(format!("“{key}” isn't a shared key (<namespace>.<name>)")))?;
    let ns_ok = !ns.is_empty()
        && ns.len() <= 40
        && ns
            .bytes()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-');
    if !ns_ok || name.is_empty() || name.chars().count() > 80 || name.contains(['/', '\\', '\0']) {
        return Err(bad(format!(
            "“{key}” isn't a shared key (<namespace>.<name>)"
        )));
    }
    Ok((ns, name))
}

fn file(s: &Services, ns: &str) -> std::path::PathBuf {
    s.paths.root.join("shared").join(format!("{ns}.json"))
}

pub fn shared_get(s: &Services, key: &str) -> Result<Value, HostError> {
    let (ns, name) = split(key)?;
    Ok(read_json(&file(s, ns), json!({}))
        .get(name)
        .cloned()
        .unwrap_or(Value::Null))
}

pub fn shared_set(s: &Services, p: &Granted, key: &str, value: &Value) -> Result<Value, HostError> {
    let (ns, name) = split(key)?;
    if ns != p.namespace {
        return Err(permission(format!(
            "{} may set only its marketplace's shared values ({}.…)",
            p.id, p.namespace
        )));
    }
    if value.to_string().len() > MAX_VALUE {
        return Err(bad("a shared value is 16 KB of JSON at most"));
    }
    s.writable()?;
    let path = file(s, ns);
    let mut all: Map<String, Value> = match read_json(&path, json!({})) {
        Value::Object(map) => map,
        _ => Map::new(),
    };
    let before = all.get(name).cloned().unwrap_or(Value::Null);
    if &before == value {
        return Ok(Value::Null);
    }
    if value.is_null() {
        all.remove(name);
    } else {
        if !all.contains_key(name) && all.len() >= MAX_KEYS {
            return Err(HostError::new(
                ErrorCode::Limit,
                format!("a namespace keeps {MAX_KEYS} shared values at most"),
            ));
        }
        all.insert(name.to_string(), value.clone());
    }
    write_json(&path, &Value::Object(all))?;
    let others: Vec<String> = s
        .loaded()
        .iter()
        .filter(|g| g.namespace == ns && g.id != p.id)
        .map(|g| g.id.clone())
        .collect();
    if let (false, Ok(host)) = (others.is_empty(), s.host()) {
        host.emit_to(
            &others,
            "shared_changed",
            json!({"namespace": ns, "key": key, "by": p.id}),
        );
    }
    Ok(Value::Null)
}

#[cfg(test)]
mod tests {
    use super::super::testing::Env;
    use super::*;
    use crate::plugins::host::Grants;
    use std::sync::Arc;
    use std::time::{Duration, Instant};

    #[tokio::test]
    async fn shared_values_tell_the_namespaces_other_plugins() {
        let env = Env::new();
        let host = Arc::new(PluginHost::new(env.services.clone()));
        env.services.set_host(&host);
        for id in ["setter", "listener", "stranger"] {
            env.plugin(id, json!({"events": {"on": ["shared_changed"]}}), json!([]));
        }
        // The stranger is of another marketplace.
        let mut stranger = (*env.services.granted("stranger").unwrap()).clone();
        stranger.namespace = "other".into();
        env.services.register(stranger);
        let main = env.dir.path().join("main.js");
        std::fs::write(
            &main,
            r#"
            export function apply(ctx) {
              const heard = []
              ctx.on('shared_changed', (p) => heard.push(p))
              ctx.command('heard', () => heard)
            }
            "#,
        )
        .unwrap();
        let grants = Grants {
            events: ["shared_changed".to_string()].into(),
        };
        for id in ["setter", "listener", "stranger"] {
            host.load(id, &main, grants.clone()).await.unwrap();
        }
        env.call("setter", "shared.set", json!(["acme.codes", ["A1"]]))
            .unwrap();
        // The same value again tells nobody.
        env.call("setter", "shared.set", json!(["acme.codes", ["A1"]]))
            .unwrap();
        assert_eq!(
            env.call("stranger", "shared.get", json!(["acme.codes"]))
                .unwrap(),
            json!(["A1"])
        );
        let deadline = Instant::now() + Duration::from_secs(10);
        loop {
            let heard = host.call("listener", "heard", Value::Null).await.unwrap();
            if !heard.as_array().unwrap().is_empty() {
                assert_eq!(
                    heard,
                    json!([{"namespace": "acme", "key": "acme.codes", "by": "setter"}])
                );
                break;
            }
            assert!(Instant::now() < deadline);
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
        for quiet in ["setter", "stranger"] {
            assert_eq!(
                host.call(quiet, "heard", Value::Null).await.unwrap(),
                json!([])
            );
        }
        // Another marketplace's namespace is read-only; keys are `<namespace>.<name>`.
        let e = env
            .call("stranger", "shared.set", json!(["acme.codes", 1]))
            .unwrap_err();
        assert_eq!(e.code, ErrorCode::Permission);
        assert!(env
            .call("setter", "shared.set", json!(["nodot", 1]))
            .is_err());
        assert_eq!(
            env.call("setter", "shared.get", json!(["acme.none"]))
                .unwrap(),
            Value::Null
        );
    }
}
