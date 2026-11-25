//! Imports the tour's seed (design § 4) into a fresh `workspace.sqlite` before `Core::open_tour`
//! opens it: `lib.rs` calls [`import`] with the test folder, writes a refusal and exits 3 on
//! `Err`, and otherwise hands the returned `FakeProvider` to `Core::set_task_providers`.
//!
//! The seed holds no secret and no path outside the test folder (design § 4); [`import`] refuses
//! both before writing anything, so a refused import leaves no database behind.
use crate::workspace::models::{
    id, now, Connection, Record, Result, Settings, Workspace, WorkspaceError,
};
use crate::workspace::repository::Repository;
use crate::workspace::task_provider::{fake::FakeProvider, ProviderInfo};
use crate::workspace::CorePaths;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::path::{Component, Path, PathBuf};
use std::sync::Arc;

/// The seed file Node writes at the test root (`scripts/tour/seed.mjs`, Task 4).
const SEED_FILE: &str = "tour-seed.json";
/// The `menu_bar_seen` bookkeeping record (`workspace::menu_bar`'s own kind, id and scope):
/// duplicated here rather than exposed, since nothing else outside that module needs them.
const SEEN_KIND: &str = "menu_bar_seen";
const SEEN_ID: &str = "personal";
const PERSONAL: &str = "personal";

/// `tour-seed.json`'s shape, camelCase on the wire like the rest of the native contract. Task 4's
/// Node builder writes exactly this: the native records a snapshot would hold, the
/// `menu_bar_seen` record's body as `seen`, and the task provider's seeded state.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Seed {
    pub settings: Settings,
    pub connections: Vec<Connection>,
    pub workspaces: Vec<Workspace>,
    pub records: Vec<Record>,
    pub seen: Value,
    pub provider: ProviderSeed,
}

/// The seeded task provider (design § 4's "Task provider" row): what `available` answers, and
/// the tasks already in its remote store (`FakeProvider::put_remote`).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderSeed {
    pub available: Vec<ProviderInfo>,
    pub remote: Vec<Value>,
}

/// What [`import`] wrote, for the caller's own log line.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct SeedCounts {
    pub records: usize,
    pub connections: usize,
}

/// A key naming a secret, case-insensitively (design § 4: "The seed holds no secret.").
fn names_a_secret(key: &str) -> bool {
    let key = key.to_lowercase();
    ["token", "secret", "password"]
        .iter()
        .any(|needle| key.contains(needle))
}

fn child(path: &str, key: &str) -> String {
    if path.is_empty() {
        key.to_string()
    } else {
        format!("{path}.{key}")
    }
}

fn refused(message: impl Into<String>, field: String) -> WorkspaceError {
    let mut e = WorkspaceError::new("validation", message);
    e.field = Some(field);
    e
}

/// Walks every value the seed holds, refusing the first key that case-insensitively names a
/// secret (design § 4: "The seed holds no secret."). Runs before the seed is even deserialized
/// into [`Seed`], so it covers every field, typed or not (including `provider.remote`'s
/// free-form task bodies).
fn check_secrets(value: &Value, path: &str) -> Result<()> {
    match value {
        Value::Object(map) => {
            for (key, v) in map {
                if names_a_secret(key) {
                    return Err(refused(
                        "The tour seed may not hold a secret.",
                        child(path, key),
                    ));
                }
                check_secrets(v, &child(path, key))?;
            }
            Ok(())
        }
        Value::Array(items) => {
            for (i, v) in items.iter().enumerate() {
                check_secrets(v, &format!("{path}[{i}]"))?;
            }
            Ok(())
        }
        _ => Ok(()),
    }
}

/// `path.canonicalize()`, but for a path that may not exist yet in full (a meeting folder the
/// seed describes before Node has created it, or simply a path a test doesn't create): resolves
/// the longest ancestor that does exist on disk — which resolves any symlink in it — and appends
/// whatever is left literally. What's appended never contains `..`: [`confine`] already refuses
/// that before calling this.
fn canonicalize_existing_prefix(path: &Path) -> std::io::Result<PathBuf> {
    let existing = path
        .ancestors()
        .find(|a| a.exists())
        .ok_or_else(|| std::io::Error::new(std::io::ErrorKind::NotFound, "no existing ancestor"))?;
    let real = existing.canonicalize()?;
    Ok(match path.strip_prefix(existing) {
        Ok(rest) if !rest.as_os_str().is_empty() => real.join(rest),
        _ => real,
    })
}

/// Refuses `value` (a path-valued seed field named `field`) unless it stays inside the test
/// folder (design § 4: "No path in it points outside the test folder"):
/// - any `..` component, anywhere in the string, refuses it outright — whether `value` is
///   relative (`"../../etc/passwd"`) or absolute with an embedded `..`
///   (`"<test_dir>/../../etc/passwd"`), which a lexical `Path::starts_with` alone would miss;
/// - a relative `value` (no `..` left to find) is resolved against `test_dir`;
/// - what's left is canonicalized as far as it exists ([`canonicalize_existing_prefix`]), which
///   resolves a symlink inside the test folder that points out, and the result must stay inside
///   `canonical_root` (`test_dir`, already canonicalized once by the caller).
fn confine(value: &str, field: &str, test_dir: &Path, canonical_root: &Path) -> Result<()> {
    let candidate = Path::new(value);
    let outside = || {
        refused(
            format!("This path is outside the tour's test folder: {value}."),
            field.to_string(),
        )
    };
    if candidate.components().any(|c| c == Component::ParentDir) {
        return Err(outside());
    }
    let absolute = if candidate.is_absolute() {
        candidate.to_path_buf()
    } else {
        test_dir.join(candidate)
    };
    let resolved = canonicalize_existing_prefix(&absolute)
        .map_err(|_| WorkspaceError::new("storage", "A seeded path could not be resolved."))?;
    if !resolved.starts_with(canonical_root) {
        return Err(outside());
    }
    Ok(())
}

/// The seed's path-valued fields, decided from its schema (`Settings::meetings` and the
/// `meeting`/`note_template` record kinds), not from what a string looks like: a free-form
/// string elsewhere (a task title, a note) is never treated as a path just because it starts
/// with `/`.
fn check_paths(seed: &Seed, test_dir: &Path) -> Result<()> {
    let canonical_root = test_dir.canonicalize().map_err(|_| {
        WorkspaceError::new("storage", "The tour's test folder could not be resolved.")
    })?;
    let meetings = &seed.settings.meetings;
    if let Some(root) = &meetings.root {
        confine(root, "settings.meetings.root", test_dir, &canonical_root)?;
    }
    if let Some(file) = &meetings.glossary_file {
        confine(
            file,
            "settings.meetings.glossaryFile",
            test_dir,
            &canonical_root,
        )?;
    }
    if let Some(file) = &meetings.tags_file {
        confine(
            file,
            "settings.meetings.tagsFile",
            test_dir,
            &canonical_root,
        )?;
    }
    for (i, record) in seed.records.iter().enumerate() {
        let key = match record.kind.as_str() {
            "meeting" => "folder",
            "note_template" => "skillPath",
            _ => continue,
        };
        if let Some(value) = record.data.get(key).and_then(Value::as_str) {
            confine(
                value,
                &format!("records[{i}].data.{key}"),
                test_dir,
                &canonical_root,
            )?;
        }
    }
    Ok(())
}

/// Imports `<test_dir>/tour-seed.json` into `<test_dir>/workspace.sqlite` (`CorePaths::database`
/// for that root, with no custom data folder) before `Core::open_tour` opens it: `settings`,
/// each connection and workspace, then every record, then the `menu_bar_seen` record built from
/// `seen` so `menu_bar::ensure_since` finds it already there and leaves it exactly as seeded.
/// Nothing is wrapped in one transaction: a write that fails leaves a folder the next run's
/// `fresh_folder` check refuses as not fresh, rather than a tour that quietly ran on half a seed.
///
/// Returns what was written and the seeded `FakeProvider`, for the caller to give
/// `Core::set_task_providers`.
pub fn import(test_dir: &Path) -> Result<(SeedCounts, Arc<FakeProvider>)> {
    let raw = std::fs::read_to_string(test_dir.join(SEED_FILE)).map_err(|_| {
        WorkspaceError::new("validation", "tour-seed.json is missing or unreadable.")
    })?;
    let value: Value = serde_json::from_str(&raw)
        .map_err(|_| WorkspaceError::new("validation", "tour-seed.json is not valid JSON."))?;
    check_secrets(&value, "")?;
    let seed: Seed = serde_json::from_value(value).map_err(|_| {
        WorkspaceError::new(
            "validation",
            "tour-seed.json does not match the seed Task 3 reads.",
        )
    })?;
    check_paths(&seed, test_dir)?;

    let paths = CorePaths {
        data: test_dir.to_path_buf(),
        private: test_dir.to_path_buf(),
    };
    let mut repository = Repository::open(&paths.database())?;
    repository.settings_update(&seed.settings)?;
    for connection in &seed.connections {
        repository.save_connection(connection)?;
    }
    for workspace in &seed.workspaces {
        repository.save_workspace(workspace)?;
    }
    for record in &seed.records {
        repository.put_record(record)?;
    }
    repository.put_record_unversioned(&Record {
        id: SEEN_ID.into(),
        kind: SEEN_KIND.into(),
        connection_id: None,
        workspace_id: Some(PERSONAL.into()),
        source: "local".into(),
        revision: id(),
        updated_at: now(),
        data: seed.seen,
    })?;

    let counts = SeedCounts {
        records: seed.records.len(),
        connections: seed.connections.len(),
    };
    let provider = Arc::new(FakeProvider::new());
    provider.set_available(seed.provider.available);
    for task in seed.provider.remote {
        provider.put_remote(task);
    }
    Ok((counts, provider))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn workspace() -> Workspace {
        Workspace {
            id: PERSONAL.into(),
            name: "Personal".into(),
            color: "#2297f6".into(),
            archived: false,
            is_default: true,
            connection_id: Some("c1".into()),
            revision: 0,
            access_revision: 0,
            profile_revision: 0,
            sources: json!({"calendars": [], "mail": true, "chats": []}),
            layout: vec!["brief".into(), "inbox".into()],
            widget_widths: json!({}),
            today: json!({}),
        }
    }

    fn connection() -> Connection {
        Connection {
            id: "c1".into(),
            account_key: "ak1".into(),
            display_name: "Taylor Morgan".into(),
            email: "taylor@example.test".into(),
            user_id: "u1".into(),
            status: "connected".into(),
            scopes: vec!["Calendars.Read".into(), "Mail.Read".into()],
            enabled: vec!["mail_send".into(), "chat_send".into()],
            ..Default::default()
        }
    }

    fn record(kind: &str, id: &str, data: Value) -> Record {
        Record {
            id: id.into(),
            kind: kind.into(),
            connection_id: None,
            workspace_id: Some(PERSONAL.into()),
            source: "local".into(),
            revision: "r1".into(),
            updated_at: 1_700_000_000,
            data,
        }
    }

    fn seed_with(records: Vec<Record>) -> Seed {
        Seed {
            settings: Settings::default(),
            connections: vec![connection()],
            workspaces: vec![workspace()],
            records,
            seen: json!({"since": 1_700_000_000i64, "automations": 0, "meetings": {}}),
            provider: ProviderSeed {
                available: vec![ProviderInfo {
                    id: "plugin:todoist".into(),
                    name: "Todoist".into(),
                    on: true,
                    ready: true,
                }],
                remote: vec![json!({"id": "9001", "title": "Check something", "done": false})],
            },
        }
    }

    fn write_seed(dir: &Path, seed: &Seed) {
        std::fs::write(dir.join(SEED_FILE), serde_json::to_string(seed).unwrap()).unwrap();
    }

    /// `import`'s `Ok` holds a `FakeProvider`, which has no `Debug`, so a refusal test can't use
    /// `unwrap_err()`.
    fn expect_refusal(dir: &Path) -> WorkspaceError {
        match import(dir) {
            Err(e) => e,
            Ok(_) => panic!("expected the import to be refused"),
        }
    }

    #[test]
    fn import_writes_every_part() {
        let dir = tempfile::tempdir().unwrap();
        let seed = seed_with(vec![
            record("message", "msg-1", json!({"subject": "Hi"})),
            record("meeting", "meet-1", json!({"folder": null})),
        ]);
        write_seed(dir.path(), &seed);

        let (counts, provider) = import(dir.path()).unwrap();
        assert_eq!(counts.records, 2);
        assert_eq!(counts.connections, 1);

        let repository = Repository::open(&dir.path().join("workspace.sqlite")).unwrap();
        assert_eq!(
            repository.connection("c1").unwrap().display_name,
            "Taylor Morgan"
        );
        assert_eq!(
            repository
                .record("message", "msg-1", None, Some(PERSONAL))
                .unwrap()
                .data["subject"],
            "Hi"
        );
        assert!(repository
            .record("meeting", "meet-1", None, Some(PERSONAL))
            .is_ok());
        let seen = repository
            .record(SEEN_KIND, SEEN_ID, None, Some(PERSONAL))
            .unwrap();
        assert_eq!(seen.data["since"], 1_700_000_000);
        assert_eq!(provider.tasks().len(), 1);
    }

    #[test]
    fn import_refuses_a_path_outside_the_test_dir() {
        let dir = tempfile::tempdir().unwrap();
        let seed = seed_with(vec![record(
            "meeting",
            "meet-1",
            json!({"folder": "/Users/taylor/Meetings/meet-1"}),
        )]);
        write_seed(dir.path(), &seed);

        let err = expect_refusal(dir.path());
        assert_eq!(err.code, "validation");
        assert_eq!(err.field.as_deref(), Some("records[0].data.folder"));
        assert!(!dir.path().join("workspace.sqlite").exists());
    }

    #[test]
    fn import_refuses_a_bare_relative_traversal() {
        let dir = tempfile::tempdir().unwrap();
        let seed = seed_with(vec![record(
            "meeting",
            "meet-1",
            json!({"folder": "../../etc/passwd"}),
        )]);
        write_seed(dir.path(), &seed);

        let err = expect_refusal(dir.path());
        assert_eq!(err.code, "validation");
        assert_eq!(err.field.as_deref(), Some("records[0].data.folder"));
        assert!(!dir.path().join("workspace.sqlite").exists());
    }

    #[test]
    fn import_refuses_an_absolute_path_with_an_embedded_traversal() {
        let dir = tempfile::tempdir().unwrap();
        // Lexically starts with the test dir's own path, so a plain `Path::starts_with` (no `..`
        // resolution) would wrongly call this confined.
        let escaping = format!("{}/../../etc/passwd", dir.path().display());
        let seed = seed_with(vec![record(
            "meeting",
            "meet-1",
            json!({"folder": escaping}),
        )]);
        write_seed(dir.path(), &seed);

        let err = expect_refusal(dir.path());
        assert_eq!(err.code, "validation");
        assert_eq!(err.field.as_deref(), Some("records[0].data.folder"));
        assert!(!dir.path().join("workspace.sqlite").exists());
    }

    #[cfg(unix)]
    #[test]
    fn import_refuses_a_symlink_inside_the_test_dir_that_points_out() {
        let dir = tempfile::tempdir().unwrap();
        let outside = tempfile::tempdir().unwrap();
        let link = dir.path().join("escape");
        std::os::unix::fs::symlink(outside.path(), &link).unwrap();

        let seed = seed_with(vec![record(
            "meeting",
            "meet-1",
            json!({"folder": link.display().to_string()}),
        )]);
        write_seed(dir.path(), &seed);

        let err = expect_refusal(dir.path());
        assert_eq!(err.code, "validation");
        assert_eq!(err.field.as_deref(), Some("records[0].data.folder"));
        assert!(!dir.path().join("workspace.sqlite").exists());
    }

    #[test]
    fn import_leaves_a_free_form_remote_task_text_alone_even_with_a_leading_slash() {
        let dir = tempfile::tempdir().unwrap();
        let mut seed = seed_with(vec![]);
        // Not a path field by the seed's schema (`ProviderSeed::remote` is free-form task data):
        // a leading `/` here must not be treated as a path, let alone refused as one outside it.
        seed.provider.remote = vec![json!({
            "id": "9001",
            "title": "/urgent: call back",
            "done": false,
        })];
        write_seed(dir.path(), &seed);

        let (_counts, provider) = import(dir.path()).unwrap();
        assert_eq!(provider.tasks().len(), 1);
        assert_eq!(provider.tasks()[0]["title"], "/urgent: call back");
    }

    #[test]
    fn import_refuses_a_secret_field() {
        let dir = tempfile::tempdir().unwrap();
        let seed = seed_with(vec![record(
            "connection_extra",
            "x-1",
            json!({"accessToken": "shh"}),
        )]);
        write_seed(dir.path(), &seed);

        let err = expect_refusal(dir.path());
        assert_eq!(err.code, "validation");
        assert!(!dir.path().join("workspace.sqlite").exists());
    }

    #[test]
    fn import_then_core_open_keeps_since() {
        let dir = tempfile::tempdir().unwrap();
        let seed = seed_with(vec![]);
        write_seed(dir.path(), &seed);
        import(dir.path()).unwrap();

        // What `Core::open_with` (so `Core::open_tour`) runs right after `Repository::open`.
        let mut repository = Repository::open(&dir.path().join("workspace.sqlite")).unwrap();
        crate::workspace::menu_bar::ensure_since(&mut repository, 1_900_000_000).unwrap();

        let seen = repository
            .record(SEEN_KIND, SEEN_ID, None, Some(PERSONAL))
            .unwrap();
        assert_eq!(seen.data["since"], 1_700_000_000);
    }
}
