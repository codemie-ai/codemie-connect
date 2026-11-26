//! The Today grid a workspace stores (`Workspace.today`): where each card sits, the saved
//! layouts, card titles, per-card options and the cards taken off the page. Native storage
//! checks the whole object, so a broken save never reaches disk.
use super::{valid_widget_id, MAX_WIDGETS};
use crate::workspace::models::{id, Record, WorkspaceError};
use crate::workspace::repository::Repository;
use serde_json::{json, Map, Value};
use std::collections::HashSet;

type Result<T> = std::result::Result<T, WorkspaceError>;

const COLUMNS: i64 = 12;
const MAX_ROW: i64 = 400;
const MAX_HEIGHT: i64 = 24;
const MAX_LAYOUTS: usize = 15;
const MAX_TEXT: usize = 40;
const MAX_LIST: usize = 8;
const MAX_OPTIONS_BYTES: usize = 8 * 1024;
/// Quick capture's note text (ask-capture design § 10).
const NOTE_TEXT_MAX: usize = 2_000;
/// Today's Notes record's own limit (`local_save`'s `required(…, "text", 20000)`).
const NOTE_RECORD_MAX: usize = 20_000;

fn invalid() -> WorkspaceError {
    let mut e = WorkspaceError::new("validation", "Invalid Today layout.");
    e.field = Some("today".into());
    e
}

fn text(s: &str) -> Result<()> {
    if (1..=MAX_TEXT).contains(&s.chars().count()) {
        Ok(())
    } else {
        Err(invalid())
    }
}

fn int(v: Option<&Value>, min: i64, max: i64) -> Result<i64> {
    match v.and_then(Value::as_i64) {
        Some(n) if (min..=max).contains(&n) => Ok(n),
        _ => Err(invalid()),
    }
}

fn items(v: &Value) -> Result<Value> {
    let list = v
        .as_array()
        .filter(|l| l.len() <= MAX_WIDGETS)
        .ok_or_else(invalid)?;
    let mut seen = HashSet::new();
    let mut boxes: Vec<[i64; 4]> = Vec::new();
    let mut out = Vec::new();
    for item in list {
        let o = item.as_object().ok_or_else(invalid)?;
        let id = o.get("id").and_then(Value::as_str).ok_or_else(invalid)?;
        if !valid_widget_id(id) || !seen.insert(id) {
            return Err(invalid());
        }
        let w = int(o.get("w"), 2, COLUMNS)?;
        let x = int(o.get("x"), 0, COLUMNS - 1)?;
        let y = int(o.get("y"), 0, MAX_ROW)?;
        let h = int(o.get("h"), 1, MAX_HEIGHT)?;
        if x + w > COLUMNS
            || boxes
                .iter()
                .any(|b| x < b[0] + b[2] && x + w > b[0] && y < b[1] + b[3] && y + h > b[1])
        {
            return Err(invalid());
        }
        boxes.push([x, y, w, h]);
        let mut kept = json!({"id": id, "x": x, "y": y, "w": w, "h": h});
        if let Some(c) = o.get("collapsed") {
            kept["collapsed"] = json!(c.as_bool().ok_or_else(invalid)?);
        }
        if let Some(p) = o.get("prevH") {
            kept["prevH"] = json!(int(Some(p), 1, MAX_HEIGHT)?);
        }
        out.push(kept);
    }
    Ok(Value::Array(out))
}

fn option_value(v: &Value) -> Result<()> {
    let short = |s: &Value| s.as_str().is_some_and(|s| s.chars().count() <= MAX_TEXT);
    let ok = match v {
        Value::Bool(_) | Value::Number(_) => true,
        Value::String(_) => short(v),
        Value::Array(l) => l.len() <= MAX_LIST && l.iter().all(short),
        _ => false,
    };
    ok.then_some(()).ok_or_else(invalid)
}

fn options(v: &Value) -> Result<Value> {
    let map = v.as_object().ok_or_else(invalid)?;
    for (id, per_card) in map {
        let per_card = per_card.as_object().ok_or_else(invalid)?;
        if !valid_widget_id(id) {
            return Err(invalid());
        }
        per_card.values().try_for_each(option_value)?;
    }
    if serde_json::to_vec(map).map_err(|_| invalid())?.len() > MAX_OPTIONS_BYTES {
        return Err(invalid());
    }
    Ok(v.clone())
}

/// Checks a Today grid and returns it with only the keys storage keeps.
pub(in crate::workspace) fn valid_today(v: &Value) -> Result<Value> {
    let o = v.as_object().ok_or_else(invalid)?;
    let mut out = Map::new();
    if let Some(a) = o.get("active") {
        let a = a.as_str().ok_or_else(invalid)?;
        text(a)?;
        out.insert("active".into(), json!(a));
    }
    if let Some(i) = o.get("items") {
        out.insert("items".into(), items(i)?);
    }
    if let Some(l) = o.get("layouts") {
        let map = l
            .as_object()
            .filter(|m| m.len() <= MAX_LAYOUTS)
            .ok_or_else(invalid)?;
        let mut kept = Map::new();
        for (name, list) in map {
            text(name)?;
            kept.insert(name.clone(), items(list)?);
        }
        out.insert("layouts".into(), Value::Object(kept));
    }
    if let Some(t) = o.get("titles") {
        let map = t.as_object().ok_or_else(invalid)?;
        for (id, title) in map {
            if !valid_widget_id(id) {
                return Err(invalid());
            }
            text(title.as_str().ok_or_else(invalid)?)?;
        }
        out.insert("titles".into(), t.clone());
    }
    if let Some(p) = o.get("options") {
        out.insert("options".into(), options(p)?);
    }
    if let Some(h) = o.get("hidden") {
        let list = h
            .as_array()
            .filter(|l| l.len() <= MAX_WIDGETS)
            .ok_or_else(invalid)?;
        let mut seen = HashSet::new();
        for id in list {
            let id = id.as_str().ok_or_else(invalid)?;
            if !valid_widget_id(id) || !seen.insert(id) {
                return Err(invalid());
            }
        }
        out.insert("hidden".into(), h.clone());
    }
    Ok(Value::Object(out))
}

/// `note_append` (ask-capture design § 10): appends a line to Today's Notes — the active
/// workspace's newest `note` record, created when there is none. `source` is the record the
/// caller already resolved from `sourceId` (`None` for no source, or one that no longer names a
/// known record); its `title` is named in the appended line. Called under the mutation lock,
/// with the usual operation id and revision fence, so a replay adds one line, not two.
pub(crate) fn note_append(
    r: &mut Repository,
    workspace_id: &str,
    text: &str,
    source: Option<&Record>,
    at: i64,
) -> Result<Value> {
    let trimmed = text.trim();
    if trimmed.is_empty() || trimmed.chars().count() > NOTE_TEXT_MAX {
        let mut e = WorkspaceError::new("validation", "Write the note, up to 2,000 characters.");
        e.field = Some("text".into());
        return Err(e);
    }
    let mut line = format!("- {trimmed}");
    if let Some(label) = source
        .and_then(|s| s.data["title"].as_str())
        .map(str::trim)
        .filter(|s| !s.is_empty())
    {
        line.push_str(&format!(" (from {label})"));
    }
    let note = r.local_records(workspace_id, "note")?.into_iter().next();
    let prior = note
        .as_ref()
        .and_then(|n| n.data["text"].as_str())
        .unwrap_or("");
    let joined = if prior.is_empty() {
        line
    } else {
        format!("{prior}\n{line}")
    };
    if joined.chars().count() > NOTE_RECORD_MAX {
        return Err(WorkspaceError::new(
            "validation",
            "Notes on Today is full. Tidy it first.",
        ));
    }
    let record_id = note.map(|n| n.id).unwrap_or_else(id);
    r.put_record(&Record {
        id: record_id.clone(),
        kind: "note".into(),
        connection_id: None,
        workspace_id: Some(workspace_id.into()),
        source: "local".into(),
        revision: id(),
        updated_at: at,
        data: json!({"text": joined}),
    })?;
    Ok(json!({"id": record_id}))
}

#[cfg(test)]
mod tests {
    use crate::ai::fake::FakeRunner;
    use crate::workspace::ai::tests::{mutation, ready};
    use crate::workspace::models::Record;
    use crate::workspace::{test_core, Operation};
    use serde_json::{json, Value};
    use std::sync::Arc;

    fn local_note(id: &str, text: &str, at: i64) -> Record {
        Record {
            id: id.into(),
            kind: "note".into(),
            connection_id: None,
            workspace_id: Some("personal".into()),
            source: "local".into(),
            revision: "r0".into(),
            updated_at: at,
            data: json!({"text": text}),
        }
    }

    fn grid() -> Value {
        json!({"active":"Default",
            "items":[{"id":"brief","x":0,"y":0,"w":8,"h":4},
                     {"id":"focus","x":8,"y":0,"w":4,"h":4,"collapsed":false}],
            "layouts":{"Default":[{"id":"brief","x":0,"y":0,"w":8,"h":4},
                                  {"id":"focus","x":8,"y":0,"w":4,"h":4}],
                       "Mine":[{"id":"notes","x":0,"y":0,"w":4,"h":6}]},
            "titles":{"brief":"Next up"},
            "options":{"inbox":{"max":"3","sources":["mail"]}},
            "hidden":["plugins"]})
    }

    /// `n` valid, non-overlapping plugin cards, one row each.
    fn plugin_items(n: i64) -> Value {
        Value::Array(
            (0..n)
                .map(|i| json!({"id": format!("plugin:pp:w{i}"), "x": 0, "y": i, "w": 4, "h": 1}))
                .collect(),
        )
    }

    /// Options of valid short values, grown until they serialize to at least `bytes`.
    fn options_of_size(bytes: usize) -> Value {
        let mut card = serde_json::Map::new();
        let mut options = json!({"inbox": {}});
        while serde_json::to_vec(&options).unwrap().len() < bytes {
            card.insert(format!("key{:03}", card.len()), json!("v".repeat(30)));
            options = json!({"inbox": card});
        }
        options
    }

    #[tokio::test]
    async fn layout_accepts_the_limits() {
        let dir = tempfile::tempdir().unwrap();
        let core = test_core(dir.path(), Arc::new(FakeRunner::new(vec![])), ready());
        let under = options_of_size(8 * 1024 - 60);
        let size = serde_json::to_vec(&under).unwrap().len();
        assert!(size <= 8 * 1024 && size > 8 * 1024 - 120, "{size}");
        let today = json!({"items": plugin_items(16), "options": under});
        core.request(mutation(
            &core,
            Operation::LayoutSave,
            json!({"today": today}),
        ))
        .await
        .unwrap();
    }

    #[tokio::test]
    async fn layout_saves_the_today_grid() {
        let dir = tempfile::tempdir().unwrap();
        let core = test_core(dir.path(), Arc::new(FakeRunner::new(vec![])), ready());
        let mut sent = grid();
        sent["extra"] = json!(1);
        core.request(mutation(
            &core,
            Operation::LayoutSave,
            json!({"layout": ["brief","focus"], "today": sent}),
        ))
        .await
        .unwrap();
        let w = core.repo().unwrap().workspace("personal").unwrap();
        assert_eq!(w.today, grid());
        assert_eq!(w.layout, vec!["brief".to_string(), "focus".to_string()]);
    }

    #[tokio::test]
    async fn layout_refuses_a_broken_today_grid() {
        let dir = tempfile::tempdir().unwrap();
        let core = test_core(dir.path(), Arc::new(FakeRunner::new(vec![])), ready());
        let item = |id: &str, x: i64, w: i64| json!({"id": id, "x": x, "y": 0, "w": w, "h": 4});
        let with = |k: &str, v: Value| json!({ k: v });
        let seventeen = plugin_items(17);
        let layouts16: serde_json::Map<String, Value> = (0..16)
            .map(|n| (format!("L{n}"), json!([item("brief", 0, 4)])))
            .collect();
        let over_8kb = options_of_size(8 * 1024 + 1);
        let cases = vec![
            with("items", json!([item("brief", 0, 6), item("focus", 4, 6)])),
            with("items", json!([item("brief", 7, 6)])),
            with("items", json!([item("brief", 0, 1)])),
            with("items", json!([{"id":"brief","x":0,"y":0,"w":4,"h":0}])),
            with("items", json!([{"id":"brief","x":0,"y":0,"w":4,"h":25}])),
            with("items", json!([{"id":"brief","x":0,"y":401,"w":4,"h":4}])),
            with("items", seventeen),
            with("items", json!([item("brief", 0, 4), item("brief", 4, 4)])),
            with("items", json!([item("weather", 0, 4)])),
            with("titles", json!({"brief": "t".repeat(41)})),
            with("layouts", Value::Object(layouts16)),
            with("layouts", json!({"": [item("brief", 0, 4)]})),
            with("options", json!({"inbox": {"a": {"b": 1}}})),
            with(
                "options",
                json!({"inbox": {"a": ["1","2","3","4","5","6","7","8","9"]}}),
            ),
            with("options", over_8kb),
            with("items", json!({"id": "brief"})),
        ];
        for (n, today) in cases.into_iter().enumerate() {
            let err = core
                .request(mutation(
                    &core,
                    Operation::LayoutSave,
                    json!({"today": today}),
                ))
                .await
                .unwrap_err();
            assert_eq!(err.code, "validation", "case {n}");
            assert_eq!(err.message, "Invalid Today layout.", "case {n}");
            assert_eq!(err.field.as_deref(), Some("today"), "case {n}");
        }
        let w = core.repo().unwrap().workspace("personal").unwrap();
        assert_eq!(w.today, json!({}));
    }

    #[tokio::test]
    async fn layout_accepts_notes_and_timer() {
        let dir = tempfile::tempdir().unwrap();
        let core = test_core(dir.path(), Arc::new(FakeRunner::new(vec![])), ready());
        core.request(mutation(
            &core,
            Operation::LayoutSave,
            json!({"layout": ["notes","timer"]}),
        ))
        .await
        .unwrap();
    }

    #[tokio::test]
    async fn contract_fixtures_match_the_today_layout() {
        let dir = tempfile::tempdir().unwrap();
        let core = test_core(dir.path(), Arc::new(FakeRunner::new(vec![])), ready());
        core.request(mutation(
            &core,
            Operation::LayoutSave,
            json!({"layout": ["brief","focus"], "today": grid()}),
        ))
        .await
        .unwrap();
        let w = core.repo().unwrap().workspace("personal").unwrap();
        crate::plugins::testkit::contract_fixture(
            "today-layout.json",
            &json!({"layout": w.layout, "widgetWidths": w.widget_widths, "today": w.today}),
        );
    }

    #[tokio::test]
    async fn note_append_adds_a_line_at_the_end() {
        let dir = tempfile::tempdir().unwrap();
        let core = test_core(dir.path(), Arc::new(FakeRunner::new(vec![])), ready());
        core.repo()
            .unwrap()
            .put_record(&local_note("n1", "a", 1))
            .unwrap();
        core.request(mutation(
            &core,
            Operation::NoteAppend,
            json!({"text": "Ask Marek about the Q1 headcount"}),
        ))
        .await
        .unwrap();
        let notes = core
            .repo()
            .unwrap()
            .local_records("personal", "note")
            .unwrap();
        assert_eq!(notes.len(), 1);
        assert_eq!(
            notes[0].id, "n1",
            "the Notes widget keeps writing the same record"
        );
        assert_eq!(
            notes[0].data["text"],
            json!("a\n- Ask Marek about the Q1 headcount")
        );
    }

    #[tokio::test]
    async fn note_append_creates_the_note_when_there_is_none() {
        let dir = tempfile::tempdir().unwrap();
        let core = test_core(dir.path(), Arc::new(FakeRunner::new(vec![])), ready());
        let result = core
            .request(mutation(
                &core,
                Operation::NoteAppend,
                json!({"text": "Ask Marek about the Q1 headcount"}),
            ))
            .await
            .unwrap();
        let notes = core
            .repo()
            .unwrap()
            .local_records("personal", "note")
            .unwrap();
        assert_eq!(notes.len(), 1);
        assert_eq!(result["id"], json!(notes[0].id));
        assert_eq!(
            notes[0].data["text"],
            json!("- Ask Marek about the Q1 headcount")
        );
    }

    #[tokio::test]
    async fn note_append_names_its_source() {
        let dir = tempfile::tempdir().unwrap();
        let core = test_core(dir.path(), Arc::new(FakeRunner::new(vec![])), ready());
        {
            let mut r = core.repo().unwrap();
            let mut w = r.workspace("personal").unwrap();
            w.connection_id = Some("c1".into());
            r.save_workspace(&w).unwrap();
            r.put_record(&Record {
                id: "m1".into(),
                kind: "message".into(),
                connection_id: Some("c1".into()),
                workspace_id: None,
                source: "mail:c1".into(),
                revision: "r1".into(),
                updated_at: 1,
                data: json!({"title": "Atlas budget"}),
            })
            .unwrap();
        }
        core.request(mutation(
            &core,
            Operation::NoteAppend,
            json!({"text": "Follow up", "sourceId": "m1"}),
        ))
        .await
        .unwrap();
        let notes = core
            .repo()
            .unwrap()
            .local_records("personal", "note")
            .unwrap();
        assert_eq!(
            notes[0].data["text"],
            json!("- Follow up (from Atlas budget)")
        );
    }

    #[tokio::test]
    async fn note_append_refuses_empty_long_and_full() {
        let dir = tempfile::tempdir().unwrap();
        let core = test_core(dir.path(), Arc::new(FakeRunner::new(vec![])), ready());
        let empty = core
            .request(mutation(&core, Operation::NoteAppend, json!({"text": ""})))
            .await
            .unwrap_err();
        assert_eq!(empty.code, "validation");
        assert_eq!(empty.message, "Write the note, up to 2,000 characters.");
        assert_eq!(empty.field.as_deref(), Some("text"));

        let too_long = core
            .request(mutation(
                &core,
                Operation::NoteAppend,
                json!({"text": "x".repeat(2001)}),
            ))
            .await
            .unwrap_err();
        assert_eq!(too_long.code, "validation");
        assert_eq!(too_long.message, "Write the note, up to 2,000 characters.");
        assert_eq!(too_long.field.as_deref(), Some("text"));

        core.repo()
            .unwrap()
            .put_record(&local_note("n1", &"x".repeat(19_990), 1))
            .unwrap();
        let full = core
            .request(mutation(
                &core,
                Operation::NoteAppend,
                json!({"text": "y".repeat(18)}),
            ))
            .await
            .unwrap_err();
        assert_eq!(full.code, "validation");
        assert_eq!(full.message, "Notes on Today is full. Tidy it first.");
        let notes = core
            .repo()
            .unwrap()
            .local_records("personal", "note")
            .unwrap();
        assert_eq!(
            notes[0].data["text"],
            json!("x".repeat(19_990)),
            "refused, unchanged"
        );
    }

    #[tokio::test]
    async fn note_append_replays_its_operation_id() {
        let dir = tempfile::tempdir().unwrap();
        let core = test_core(dir.path(), Arc::new(FakeRunner::new(vec![])), ready());
        let req = mutation(
            &core,
            Operation::NoteAppend,
            json!({"text": "Ask Marek about the Q1 headcount"}),
        );
        core.request(req.clone()).await.unwrap();
        core.request(req).await.unwrap();
        let notes = core
            .repo()
            .unwrap()
            .local_records("personal", "note")
            .unwrap();
        assert_eq!(notes.len(), 1);
        assert_eq!(
            notes[0].data["text"],
            json!("- Ask Marek about the Q1 headcount")
        );
    }
}
