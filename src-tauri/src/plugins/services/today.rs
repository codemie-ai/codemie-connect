//! What a plugin puts on Today (PLUGIN-ENGINE.md §4.2, §4.3; `plugin-api.md` § Widgets, § Work
//! rows), kept as records the snapshot shows:
//! - `inbox.set(key, {title, why, urgent, go, actions})` / `inbox.clear(key)`: a `plugin_item`
//!   `<plugin>:inbox:<key>` asking the user to decide; its buttons run the plugin's commands.
//! - `widgets.set(id, data)` / `clear(id)`: a `plugin_widget` `<plugin>:<widget>` for a widget its
//!   manifest declares. `widgets.provide(id, fn)` and `work.provide(fn)` register providers the
//!   plugin manager asks (on load, after `refresh`, and after `changed()`); their answers become
//!   the same records (work rows: `<plugin>:work`).
use super::deliver::{item, stored};
use super::{at, bad, lock, text, Granted, Services};
use crate::plugins::host::HostError;
use crate::workspace::models::{now, Record};
use serde_json::{json, Value};
use std::collections::{BTreeSet, HashMap, HashSet};

/// The largest widget data (`plugin-api.md` § Giving data).
const MAX_WIDGET: usize = 64 * 1024;
const MAX_ROWS: usize = 200;

/// What plugins give by `provide`, and what they said changed.
#[derive(Default)]
pub struct Provided {
    /// The widgets each plugin provides.
    pub widgets: HashMap<String, BTreeSet<String>>,
    /// The plugins that provide work rows.
    pub work: HashSet<String>,
    /// `(plugin, target)` to ask again: `widget:<id>` or `work`.
    pub changed: HashSet<(String, String)>,
}

impl Provided {
    pub fn forget(&mut self, id: &str) {
        self.widgets.remove(id);
        self.work.remove(id);
        self.changed.retain(|(p, _)| p != id);
    }

    /// Every `(plugin, target)` a provider answers.
    pub fn targets(&self) -> Vec<(String, String)> {
        let widgets = self
            .widgets
            .iter()
            .flat_map(|(p, ws)| ws.iter().map(move |w| (p.clone(), format!("widget:{w}"))));
        let work = self.work.iter().map(|p| (p.clone(), "work".to_string()));
        widgets.chain(work).collect()
    }
}

pub fn call(s: &Services, p: &Granted, name: &str, args: &Value) -> Result<Value, HostError> {
    match name {
        "inbox.set" => {
            let key = inbox_key(text(args, 0, "an item's key")?)?;
            let data = inbox_item(&key, at(args, 1))?;
            put(s, &item(&format!("{}:inbox:{key}", p.id), p, now(), data))
        }
        "inbox.clear" => {
            let key = inbox_key(text(args, 0, "an item's key")?)?;
            clear(s, "plugin_item", &format!("{}:inbox:{key}", p.id))
        }
        "widgets.provide" => {
            let widget = declared(p, at(args, 0))?;
            let mut today = lock(&s.today);
            today
                .widgets
                .entry(p.id.clone())
                .or_default()
                .insert(widget.clone());
            today
                .changed
                .insert((p.id.clone(), format!("widget:{widget}")));
            Ok(Value::Null)
        }
        "widgets.set" => {
            let widget = declared(p, at(args, 0))?;
            let record = widget_record(p, &widget, at(args, 1))?;
            put(s, &record)
        }
        "widgets.clear" => {
            let widget = declared(p, at(args, 0))?;
            clear(s, "plugin_widget", &format!("{}:{widget}", p.id))
        }
        "widgets.changed" => {
            let mut today = lock(&s.today);
            let mine: Vec<String> = match at(args, 0) {
                Value::Null => today
                    .widgets
                    .get(&p.id)
                    .map(|w| w.iter().cloned().collect())
                    .unwrap_or_default(),
                v => vec![declared(p, v)?],
            };
            for w in mine {
                today.changed.insert((p.id.clone(), format!("widget:{w}")));
            }
            Ok(Value::Null)
        }
        "work.provide" | "work.changed" => {
            p.needs("work", "add items to your work")?;
            let mut today = lock(&s.today);
            if name == "work.provide" {
                today.work.insert(p.id.clone());
            }
            if today.work.contains(&p.id) {
                today.changed.insert((p.id.clone(), "work".into()));
            }
            Ok(Value::Null)
        }
        _ => Err(super::unsupported(name)),
    }
}

fn put(s: &Services, record: &Record) -> Result<Value, HostError> {
    s.writable()?;
    s.core()?.plugin_put(record).map_err(stored)?;
    Ok(Value::Null)
}

fn clear(s: &Services, kind: &str, id: &str) -> Result<Value, HostError> {
    s.writable()?;
    s.core()?
        .plugin_delete(Some(kind), id, false)
        .map_err(stored)?;
    Ok(Value::Null)
}

fn inbox_key(key: &str) -> Result<String, HostError> {
    if key.is_empty() || key.len() > 80 || key.chars().any(char::is_control) {
        return Err(bad(
            "an Inbox item needs a short key (80 characters at most)",
        ));
    }
    Ok(key.to_string())
}

/// Text of at most `max` characters (a number is taken as text); missing is `""`.
fn plain(v: &Value, what: &str, max: usize) -> Result<String, HostError> {
    let text = match v {
        Value::Null => String::new(),
        Value::String(s) => s.clone(),
        Value::Number(n) => n.to_string(),
        _ => return Err(bad(format!("{what} is text"))),
    };
    Ok(text.chars().take(max).collect())
}

/// An Inbox item as stored: `{type: inbox, key, title, why, urgent, go, actions}`.
fn inbox_item(key: &str, v: &Value) -> Result<Value, HostError> {
    let title = plain(&v["title"], "an item's title", 200)?;
    if title.trim().is_empty() {
        return Err(bad("an Inbox item needs a title"));
    }
    let actions = v["actions"].as_array().cloned().unwrap_or_default();
    if actions.len() > 3 {
        return Err(bad("an Inbox item has at most 3 buttons"));
    }
    let actions = actions
        .iter()
        .map(|a| {
            let command = plain(&a["command"], "a button's command", 80)?;
            if command.is_empty() {
                return Err(bad("each button runs one of the plugin's commands"));
            }
            if a["args"].to_string().len() > 4096 {
                return Err(bad("a button's args are 4 KB at most"));
            }
            Ok(json!({
                "label": plain(&a["label"], "a button's label", 40)?,
                "command": command,
                "args": a["args"],
                "primary": a["primary"] == true,
            }))
        })
        .collect::<Result<Vec<_>, HostError>>()?;
    Ok(json!({
        "type": "inbox",
        "key": key,
        "title": title,
        "why": plain(&v["why"], "an item's why", 500)?,
        "urgent": v["urgent"] == true,
        "go": plain(&v["go"], "an item's go", 200)?,
        "actions": actions,
    }))
}

/// A widget its manifest declares.
fn declared(p: &Granted, v: &Value) -> Result<String, HostError> {
    let id = v.as_str().unwrap_or("");
    if !p.widgets.iter().any(|w| w.id == id) {
        return Err(bad(format!("{} declares no widget “{id}”", p.id)));
    }
    Ok(id.to_string())
}

/// A widget's data as Today keeps it, refused as `plugin-api.md` § Data by kind says (the
/// essentials: what each kind can't be drawn without, and the size).
pub fn widget_record(p: &Granted, widget: &str, data: &Value) -> Result<Record, HostError> {
    let def = p
        .widgets
        .iter()
        .find(|w| w.id == widget)
        .ok_or_else(|| bad(format!("{} declares no widget “{widget}”", p.id)))?;
    if data.to_string().len() > MAX_WIDGET {
        return Err(bad("a widget's data is 64 KB at most"));
    }
    if !data.is_object() {
        return Err(bad("a widget's data is an object"));
    }
    let list = |k: &str| data[k].is_array();
    let fits = match def.kind.as_str() {
        "stat" => !data["value"].is_null(),
        "stats" | "list" => list("items"),
        "status" => {
            matches!(data["state"].as_str(), Some("ok" | "warn" | "bad"))
                && data["title"].is_string()
        }
        "card" => data["title"].is_string() || data["text"].is_string(),
        "table" => {
            let columns = data["columns"].as_array().map_or(0, Vec::len);
            (1..=10).contains(&columns)
                && data["rows"].as_array().is_some_and(|r| r.len() <= MAX_ROWS)
        }
        "chart" => data["type"].is_string() && list("points"),
        _ => true,
    };
    if !fits {
        return Err(bad(format!(
            "that data can't be drawn as a {} widget (plugin-api.md § Data by kind)",
            def.kind
        )));
    }
    let at = now();
    Ok(Record {
        id: format!("{}:{widget}", p.id),
        kind: "plugin_widget".into(),
        connection_id: None,
        workspace_id: None,
        source: format!("plugin:{}", p.id),
        revision: crate::workspace::models::id(),
        updated_at: at,
        data: json!({
            "type": "widget",
            "plugin": p.id,
            "pluginName": p.name,
            "widget": widget,
            "kind": def.kind,
            "label": def.label,
            "data": data,
            "at": at,
        }),
    })
}

/// Work rows as Today keeps them (`plugin-api.md` § Work rows); one wrong row refuses them all.
pub fn work_record(p: &Granted, rows: &Value) -> Result<Record, HostError> {
    let rows = rows.as_array().ok_or_else(|| bad("work rows are a list"))?;
    if rows.len() > MAX_ROWS {
        return Err(bad("200 work rows at most"));
    }
    let mut ids = HashSet::new();
    let text = |r: &Value, k: &str, min: usize, max: usize| -> Result<Option<String>, HostError> {
        match &r[k] {
            Value::Null if min == 0 => Ok(None),
            Value::String(s) if (min..=max).contains(&s.chars().count()) => Ok(Some(s.clone())),
            _ => Err(bad(format!(
                "a work row's {k} is text of {min}–{max} characters"
            ))),
        }
    };
    let mut kept = Vec::new();
    for r in rows {
        let id = text(r, "id", 1, 200)?.unwrap_or_default();
        if !ids.insert(id.clone()) {
            return Err(bad(format!("two work rows have the id “{id}”")));
        }
        let url = text(r, "url", 0, 2000)?;
        if url.as_deref().is_some_and(|u| {
            !u.starts_with("https://") || u.contains([' ', '"', '\'', '<', '>', '\\'])
        }) {
            return Err(bad("a work row's url is an https:// address"));
        }
        let due = text(r, "due", 0, 10)?;
        if due
            .as_deref()
            .is_some_and(|d| chrono::NaiveDate::parse_from_str(d, "%Y-%m-%d").is_err())
        {
            return Err(bad("a work row's due is YYYY-MM-DD"));
        }
        if !matches!(r["late"], Value::Null | Value::Bool(_)) {
            return Err(bad("a work row's late is true or false"));
        }
        kept.push(json!({
            "id": id,
            "title": text(r, "title", 1, 300)?,
            "kind": text(r, "kind", 1, 30)?,
            "where": text(r, "where", 0, 120)?,
            "url": url,
            "due": due,
            "late": r["late"],
            "thread": text(r, "thread", 0, 60)?,
        }));
    }
    let at = now();
    Ok(Record {
        id: format!("{}:work", p.id),
        kind: "plugin_widget".into(),
        connection_id: None,
        workspace_id: None,
        source: format!("plugin:{}", p.id),
        revision: crate::workspace::models::id(),
        updated_at: at,
        data: json!({"type": "work", "plugin": p.id, "pluginName": p.name, "rows": kept, "at": at}),
    })
}

#[cfg(test)]
mod tests {
    use super::super::testing::Env;
    use super::*;
    use crate::ai::fake::FakeRunner;
    use crate::plugins::host::ErrorCode;
    use crate::workspace::test_core;
    use std::sync::Arc;

    #[test]
    fn inbox_and_widgets_appear_in_snapshot() {
        let dir = tempfile::tempdir().unwrap();
        let core = test_core(dir.path(), Arc::new(FakeRunner::new(vec![])), vec![]);
        let env = Env::with(Some(core.clone()), super::super::http::Client::new());
        let widgets = json!([
            {"id": "ci", "label": "CI", "kind": "status"},
            {"id": "repos", "label": "Repos", "kind": "list"}
        ]);
        env.plugin_with("github", json!({"work": {}}), json!([]), widgets, &[]);
        env.plugin("other", json!({}), json!([]));
        let call = |name: &str, args: Value| env.call("github", name, args);
        call(
            "inbox.set",
            json!(["review:1", {"title": "Check the vault", "why": "It was described",
                   "urgent": true, "go": "settings/x",
                   "actions": [{"label": "Confirm", "command": "confirm", "args": {"id": 1}, "primary": true}]}]),
        )
        .unwrap();
        call(
            "widgets.set",
            json!(["ci", {"state": "bad", "title": "2 failing"}]),
        )
        .unwrap();
        let rows = json!([{"id": "pr-1", "title": "Review #1", "kind": "review", "url": "https://github.com/a/b/pull/1", "due": "2026-11-20"}]);
        core.plugin_put(&work_record(&env.services.granted("github").unwrap(), &rows).unwrap())
            .unwrap();

        let snapshot = core.repo().unwrap().snapshot().unwrap();
        let find = |kind: &str, id: &str| {
            snapshot
                .records
                .iter()
                .find(|r| r.kind == kind && r.id == id)
                .cloned()
                .unwrap_or_else(|| panic!("{kind} {id} in the snapshot"))
        };
        let inbox = find("plugin_item", "github:inbox:review:1");
        assert_eq!(inbox.data["title"], "Check the vault");
        assert_eq!(inbox.data["plugin"], "github");
        assert_eq!(inbox.data["actions"][0]["command"], "confirm");
        let ci = find("plugin_widget", "github:ci");
        assert_eq!(ci.data["kind"], "status");
        assert_eq!(ci.data["data"]["state"], "bad");
        let work = find("plugin_widget", "github:work");
        assert_eq!(work.data["rows"][0]["id"], "pr-1");

        // Cleared, it leaves Today.
        call("inbox.clear", json!(["review:1"])).unwrap();
        call("widgets.clear", json!(["ci"])).unwrap();
        let snapshot = core.repo().unwrap().snapshot().unwrap();
        assert!(!snapshot
            .records
            .iter()
            .any(|r| r.id == "github:inbox:review:1" || r.id == "github:ci"));

        // Refused: an undeclared widget, data its kind can't draw, an item without a title, bad
        // rows; `work` needs its grant.
        for (name, args) in [
            (
                "widgets.set",
                json!(["nope", {"state": "ok", "title": "x"}]),
            ),
            (
                "widgets.set",
                json!(["ci", {"state": "great", "title": "x"}]),
            ),
            ("widgets.set", json!(["repos", {"items": "not a list"}])),
            ("inbox.set", json!(["k", {"why": "no title"}])),
            ("inbox.set", json!(["k".repeat(81), {"title": "x"}])),
        ] {
            let e = call(name, args.clone()).unwrap_err();
            assert_eq!(e.code, ErrorCode::PluginError, "{name} {args}: {e}");
        }
        let g = env.services.granted("github").unwrap();
        for rows in [
            json!([{"id": "a", "title": "x", "kind": "k"}, {"id": "a", "title": "y", "kind": "k"}]),
            json!([{"id": "a", "title": "x", "kind": "k", "url": "http://x"}]),
            json!([{"id": "a", "title": "x", "kind": "k", "due": "tomorrow"}]),
            json!([{"id": "a", "kind": "k"}]),
        ] {
            assert!(work_record(&g, &rows).is_err(), "{rows}");
        }
        assert_eq!(
            env.call("other", "work.provide", json!([]))
                .unwrap_err()
                .code,
            ErrorCode::Permission
        );
        // Providers are noted for the manager to ask.
        call("widgets.provide", json!(["repos"])).unwrap();
        call("work.provide", json!([])).unwrap();
        let mut targets = lock(&env.services.today).targets();
        targets.sort();
        assert_eq!(
            targets,
            [
                ("github".to_string(), "widget:repos".to_string()),
                ("github".to_string(), "work".to_string())
            ]
        );
    }
}
