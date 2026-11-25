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
    /// Plugins installed and on before the app starts (the tour's plugin-frame stop): their
    /// files, written under `<test dir>/plugins/installed/<id>/<version>/`.
    #[serde(default)]
    pub plugins: Vec<PluginSeed>,
}

/// One seeded plugin: its id and version, its files by name (flat, text) and the `uses` keys
/// its permission sheet is agreed to.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PluginSeed {
    pub id: String,
    pub version: String,
    pub files: std::collections::BTreeMap<String, String>,
    pub agreed: Vec<String>,
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
/// the longest ancestor whose entry exists — `symlink_metadata`, not `exists()`, so a *dangling*
/// symlink (whose target is missing) still counts as that ancestor, rather than being skipped
/// over as if it weren't there — and appends whatever is left literally. What's appended never
/// contains `..`: callers already refuse that before calling this. `existing.canonicalize()`
/// then fully resolves `existing`: if `existing` is itself a dangling symlink, that resolution
/// fails and so does this function, which is exactly the refusal a dangling symlink must get.
fn canonicalize_existing_prefix(path: &Path) -> std::io::Result<PathBuf> {
    let existing = path
        .ancestors()
        .find(|a| a.symlink_metadata().is_ok())
        .ok_or_else(|| std::io::Error::new(std::io::ErrorKind::NotFound, "no existing ancestor"))?;
    let real = existing.canonicalize()?;
    Ok(match path.strip_prefix(existing) {
        Ok(rest) if !rest.as_os_str().is_empty() => real.join(rest),
        _ => real,
    })
}

/// Refuses `value` (a path-valued seed field named `field`) unless it is absolute and stays
/// inside the test folder (design § 4: "No path in it points outside the test folder"; the
/// app's own validators also require these fields absolute — `meetings/model.rs`,
/// `library_ops.rs` — and nothing in `import` resolves a relative one against the test folder,
/// so a relative value must be refused rather than silently accepted and later resolved against
/// whatever the process's current directory happens to be):
/// - not absolute refuses it outright;
/// - any `..` component, anywhere in the string, refuses it outright too — closing both the
///   plain-relative form (already caught by "not absolute") and an absolute path with an
///   embedded `..` (`"<test_dir>/../../etc/passwd"`), which a lexical `Path::starts_with` alone
///   would miss;
/// - what's left is canonicalized as far as it exists ([`canonicalize_existing_prefix`]), which
///   resolves a symlink inside the test folder that points out (or refuses a dangling one), and
///   the result must stay inside `canonical_root` (`test_dir`, canonicalized once by the
///   caller).
///
/// Returns the resolved, canonical path on success, so a caller that needs it as a boundary for
/// something nested inside it (a meeting's own documents, see [`confine_doc_file`]) doesn't
/// canonicalize the same value twice.
fn confine(value: &str, field: &str, canonical_root: &Path) -> Result<PathBuf> {
    let candidate = Path::new(value);
    let outside = |message: String| refused(message, field.to_string());
    if !candidate.is_absolute() {
        return Err(outside(format!(
            "This path must be absolute, inside the tour's test folder: {value}."
        )));
    }
    if candidate.components().any(|c| c == Component::ParentDir) {
        return Err(outside(format!(
            "This path is outside the tour's test folder: {value}."
        )));
    }
    let resolved = canonicalize_existing_prefix(candidate)
        .map_err(|_| outside(format!("This path could not be resolved: {value}.")))?;
    if !resolved.starts_with(canonical_root) {
        return Err(outside(format!(
            "This path is outside the tour's test folder: {value}."
        )));
    }
    Ok(resolved)
}

/// The one subfolder a document file name may sit in (`workspace::meetings::docs::HISTORY`,
/// private there; duplicated here as a literal for the same reason `menu_bar`'s kind/id/scope
/// are).
const HISTORY_SUBFOLDER: &str = "notes-history";

/// Whether `name` is a plain relative file name the app would accept for a document
/// (`Doc::file`) or a kept version (`DocVersion::file`, `allow_history_subfolder`): not empty,
/// not absolute, no `..` (or `.`, or any other non-plain component), and no path separator at
/// all unless it is exactly `notes-history/<name>`, the one subfolder the app itself writes
/// into (`docs.rs`'s `HISTORY`).
fn relative_name_shape(name: &str, allow_history_subfolder: bool) -> bool {
    if name.is_empty() {
        return false;
    }
    let candidate = Path::new(name);
    if candidate.is_absolute() {
        return false;
    }
    let components: Vec<Component> = candidate.components().collect();
    if components
        .iter()
        .any(|c| !matches!(c, Component::Normal(_)))
    {
        return false;
    }
    match components.as_slice() {
        [_] => true,
        [first, _] => allow_history_subfolder && first.as_os_str() == HISTORY_SUBFOLDER,
        _ => false,
    }
}

/// Confines a meeting document's file name (design § 4; `docs.rs` joins this onto the meeting
/// folder, then writes, renames, reads and deletes the result): refuses it unless
/// [`relative_name_shape`] accepts it, and unless `folder.join(file)`, resolved as far as it
/// exists, stays inside the meeting's own canonical folder — not just inside the test folder in
/// general, since a document belongs to its own meeting, not another one.
fn confine_doc_file(
    file: &str,
    folder: &Path,
    canonical_folder: &Path,
    field: &str,
    allow_history_subfolder: bool,
) -> Result<()> {
    if !relative_name_shape(file, allow_history_subfolder) {
        return Err(refused(
            format!("This isn't a plain file name inside the meeting folder: {file}."),
            field.to_string(),
        ));
    }
    let resolved = canonicalize_existing_prefix(&folder.join(file)).map_err(|_| {
        refused(
            format!("This file could not be resolved: {file}."),
            field.to_string(),
        )
    })?;
    if !resolved.starts_with(canonical_folder) {
        return Err(refused(
            format!("This file is outside its meeting folder: {file}."),
            field.to_string(),
        ));
    }
    Ok(())
}

/// A `meeting` record's path fields (design § 4): the folder itself, then — joined onto it —
/// every document's `file` and every kept version's `file` (`docs.rs:50,53,278,284,289,290,368`
/// reads, writes, renames and deletes `folder.join(file)`). Nothing is checked when the record
/// has no folder yet (an `upcoming` or `pending` meeting has no documents either).
fn check_meeting_record(i: usize, record: &Record, canonical_root: &Path) -> Result<()> {
    let Some(folder) = record.data.get("folder").and_then(Value::as_str) else {
        return Ok(());
    };
    let canonical_folder = confine(folder, &format!("records[{i}].data.folder"), canonical_root)?;
    let folder_path = Path::new(folder);
    let docs = record
        .data
        .get("docs")
        .and_then(Value::as_array)
        .into_iter()
        .flatten();
    for (d, doc) in docs.enumerate() {
        if let Some(file) = doc.get("file").and_then(Value::as_str) {
            confine_doc_file(
                file,
                folder_path,
                &canonical_folder,
                &format!("records[{i}].data.docs[{d}].file"),
                false,
            )?;
        }
        let versions = doc
            .get("versions")
            .and_then(Value::as_array)
            .into_iter()
            .flatten();
        for (v, version) in versions.enumerate() {
            if let Some(file) = version.get("file").and_then(Value::as_str) {
                confine_doc_file(
                    file,
                    folder_path,
                    &canonical_folder,
                    &format!("records[{i}].data.docs[{d}].versions[{v}].file"),
                    true,
                )?;
            }
        }
    }
    Ok(())
}

/// The seed's path-valued fields, decided from its schema (`Settings::meetings`, the
/// `meeting`/`note_template` record kinds, and a meeting's own documents), not from what a
/// string looks like: a free-form string elsewhere (a task title, a note) is never treated as a
/// path just because it starts with `/`.
fn check_paths(seed: &Seed, test_dir: &Path) -> Result<()> {
    let canonical_root = test_dir.canonicalize().map_err(|_| {
        WorkspaceError::new("storage", "The tour's test folder could not be resolved.")
    })?;
    let meetings = &seed.settings.meetings;
    if let Some(root) = &meetings.root {
        confine(root, "settings.meetings.root", &canonical_root)?;
    }
    if let Some(file) = &meetings.glossary_file {
        confine(file, "settings.meetings.glossaryFile", &canonical_root)?;
    }
    if let Some(file) = &meetings.tags_file {
        confine(file, "settings.meetings.tagsFile", &canonical_root)?;
    }
    for (i, record) in seed.records.iter().enumerate() {
        match record.kind.as_str() {
            "meeting" => check_meeting_record(i, record, &canonical_root)?,
            "note_template" => {
                if let Some(value) = record.data.get("skillPath").and_then(Value::as_str) {
                    confine(
                        value,
                        &format!("records[{i}].data.skillPath"),
                        &canonical_root,
                    )?;
                }
            }
            _ => {}
        }
    }
    Ok(())
}

/// A seeded plugin's id is a valid plugin id, its version one plain folder name, and each of its
/// files one plain name in that folder: nothing it names lands outside
/// `<test dir>/plugins/installed/<id>/<version>/`.
fn check_plugins(plugins: &[PluginSeed]) -> Result<()> {
    let plain = |name: &str| {
        !name.is_empty()
            && !name.contains(['/', '\\'])
            && matches!(
                Path::new(name).components().collect::<Vec<_>>()[..],
                [Component::Normal(_)]
            )
    };
    for (i, p) in plugins.iter().enumerate() {
        let version_ok = plain(&p.version)
            && p.version
                .chars()
                .all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '-' | '_' | '+'));
        if !crate::plugins::valid_id(&p.id) || !version_ok {
            return Err(refused(
                "A seeded plugin needs a valid id and version.",
                format!("plugins[{i}]"),
            ));
        }
        if p.files.keys().any(|name| !plain(name)) {
            return Err(refused(
                "A seeded plugin's files must sit in its own folder.",
                format!("plugins[{i}].files"),
            ));
        }
    }
    Ok(())
}

/// Writes each seeded plugin's files and records it in the plugin registry, installed and on,
/// with its permission sheet agreed to, as an install from a local folder would.
fn install_plugins(test_dir: &Path, plugins: &[PluginSeed]) -> Result<()> {
    use crate::plugins::registry::{
        now as installed_now, Installed, PluginPaths, Registry, Source,
    };
    let paths = PluginPaths::new(test_dir, test_dir);
    let io = |e: std::io::Error| {
        WorkspaceError::new(
            "validation",
            format!("A seeded plugin can't be written: {e}"),
        )
    };
    for p in plugins {
        let dir = paths.installed().join(&p.id).join(&p.version);
        std::fs::create_dir_all(&dir).map_err(io)?;
        for (name, text) in &p.files {
            std::fs::write(dir.join(name), text).map_err(io)?;
        }
        let hash = crate::plugins::tree::tree_hash(&dir).map_err(|e| {
            WorkspaceError::new(
                "validation",
                format!("A seeded plugin can't be read back: {e:?}"),
            )
        })?;
        let mut agreed = p.agreed.clone();
        agreed.sort();
        Registry::update(&paths, |r| {
            r.installed.insert(
                p.id.clone(),
                Installed {
                    version: p.version.clone(),
                    market: "tour".into(),
                    source: Source::Local {
                        path: test_dir.to_path_buf(),
                    }
                    .text(),
                    commit: None,
                    hash,
                    enabled: true,
                    agreed,
                    agreed_text: Default::default(),
                    installed_at: installed_now(),
                },
            );
            Ok(())
        })?;
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
    check_plugins(&seed.plugins)?;

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

    install_plugins(test_dir, &seed.plugins)?;

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
            plugins: vec![],
        }
    }

    fn hello(files: &[(&str, &str)]) -> PluginSeed {
        PluginSeed {
            id: "hello".into(),
            version: "1.0.0".into(),
            files: files
                .iter()
                .map(|(k, v)| (k.to_string(), v.to_string()))
                .collect(),
            agreed: vec!["network".into()],
        }
    }

    #[test]
    fn import_installs_a_seeded_plugin_turned_on() {
        let dir = tempfile::tempdir().unwrap();
        let mut seed = seed_with(vec![]);
        seed.plugins = vec![hello(&[
            (
                "echo-plugin.json",
                r#"{"id":"hello","version":"1.0.0","main":"main.js"}"#,
            ),
            ("main.js", "export function apply(ctx) {}"),
        ])];
        write_seed(dir.path(), &seed);
        import(dir.path()).unwrap();

        let paths = crate::plugins::registry::PluginPaths::new(dir.path(), dir.path());
        let installed = paths.installed().join("hello").join("1.0.0");
        assert_eq!(
            std::fs::read_to_string(installed.join("main.js")).unwrap(),
            "export function apply(ctx) {}"
        );
        let reg = crate::plugins::registry::Registry::load(&paths).unwrap();
        let p = &reg.installed["hello"];
        assert!(p.enabled);
        assert_eq!(p.version, "1.0.0");
        assert_eq!(p.agreed, vec!["network".to_string()]);
        assert_eq!(p.hash, crate::plugins::tree::tree_hash(&installed).unwrap());
    }

    #[test]
    fn import_refuses_a_plugin_file_outside_its_folder() {
        for name in ["../x.js", "sub/x.js", "/tmp/x.js", "", ".."] {
            let dir = tempfile::tempdir().unwrap();
            let mut seed = seed_with(vec![]);
            seed.plugins = vec![hello(&[(name, "x")])];
            write_seed(dir.path(), &seed);
            let e = expect_refusal(dir.path());
            assert_eq!(e.code, "validation", "{name}");
            assert_eq!(e.field.as_deref(), Some("plugins[0].files"), "{name}");
            assert!(
                !dir.path().join("workspace.sqlite").exists(),
                "{name}: nothing written"
            );
        }
    }

    #[test]
    fn import_refuses_a_bad_plugin_id_or_version() {
        for (id, version) in [
            ("../hello", "1.0.0"),
            ("Hello", "1.0.0"),
            ("hello", "../1"),
            ("hello", ""),
        ] {
            let dir = tempfile::tempdir().unwrap();
            let mut seed = seed_with(vec![]);
            let mut p = hello(&[("main.js", "x")]);
            p.id = id.into();
            p.version = version.into();
            seed.plugins = vec![p];
            write_seed(dir.path(), &seed);
            let e = expect_refusal(dir.path());
            assert_eq!(e.field.as_deref(), Some("plugins[0]"), "{id} {version}");
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
    fn import_refuses_a_relative_path_without_traversal() {
        // No `..` at all, but still not absolute: the app's own validators require an absolute
        // path (`meetings/model.rs`, `library_ops.rs`), and nothing in `import` resolves a
        // relative one against the test folder, so it must be refused outright.
        let dir = tempfile::tempdir().unwrap();
        let seed = seed_with(vec![record(
            "meeting",
            "meet-1",
            json!({"folder": "Meetings/meet-1"}),
        )]);
        write_seed(dir.path(), &seed);

        let err = expect_refusal(dir.path());
        assert_eq!(err.code, "validation");
        assert_eq!(err.field.as_deref(), Some("records[0].data.folder"));
        assert!(!dir.path().join("workspace.sqlite").exists());
    }

    #[cfg(unix)]
    #[test]
    fn import_refuses_a_dangling_symlink_inside_the_test_dir() {
        let dir = tempfile::tempdir().unwrap();
        let outside = tempfile::tempdir().unwrap();
        // A target that does not exist: `Path::exists()` would call the link itself "not
        // there" and skip straight past it to `dir` as the longest existing ancestor, which
        // would then wrongly accept whatever is appended after it.
        let missing_target = outside.path().join("missing");
        let link = dir.path().join("escape");
        std::os::unix::fs::symlink(&missing_target, &link).unwrap();

        let seed = seed_with(vec![record(
            "meeting",
            "meet-1",
            json!({"folder": link.join("meet-1").display().to_string()}),
        )]);
        write_seed(dir.path(), &seed);

        let err = expect_refusal(dir.path());
        assert_eq!(err.code, "validation");
        assert_eq!(err.field.as_deref(), Some("records[0].data.folder"));
        assert!(!dir.path().join("workspace.sqlite").exists());
    }

    #[test]
    fn import_refuses_an_absolute_document_file_name() {
        let dir = tempfile::tempdir().unwrap();
        let folder = dir.path().join("Meetings").join("meet-1");
        let seed = seed_with(vec![record(
            "meeting",
            "meet-1",
            json!({
                "folder": folder.display().to_string(),
                "docs": [{"file": "/etc/passwd"}],
            }),
        )]);
        write_seed(dir.path(), &seed);

        let err = expect_refusal(dir.path());
        assert_eq!(err.code, "validation");
        assert_eq!(err.field.as_deref(), Some("records[0].data.docs[0].file"));
        assert!(!dir.path().join("workspace.sqlite").exists());
    }

    #[test]
    fn import_refuses_a_document_file_name_with_traversal() {
        let dir = tempfile::tempdir().unwrap();
        let folder = dir.path().join("Meetings").join("meet-1");
        let seed = seed_with(vec![record(
            "meeting",
            "meet-1",
            json!({
                "folder": folder.display().to_string(),
                "docs": [{"file": "../../etc/passwd"}],
            }),
        )]);
        write_seed(dir.path(), &seed);

        let err = expect_refusal(dir.path());
        assert_eq!(err.code, "validation");
        assert_eq!(err.field.as_deref(), Some("records[0].data.docs[0].file"));
        assert!(!dir.path().join("workspace.sqlite").exists());
    }

    #[test]
    fn import_refuses_a_kept_version_file_in_a_disallowed_subfolder() {
        let dir = tempfile::tempdir().unwrap();
        let folder = dir.path().join("Meetings").join("meet-1");
        let seed = seed_with(vec![record(
            "meeting",
            "meet-1",
            json!({
                "folder": folder.display().to_string(),
                "docs": [{
                    "file": "notes.md",
                    "versions": [{"file": "not-history/old.md"}],
                }],
            }),
        )]);
        write_seed(dir.path(), &seed);

        let err = expect_refusal(dir.path());
        assert_eq!(err.code, "validation");
        assert_eq!(
            err.field.as_deref(),
            Some("records[0].data.docs[0].versions[0].file")
        );
        assert!(!dir.path().join("workspace.sqlite").exists());
    }

    #[cfg(unix)]
    #[test]
    fn import_refuses_a_document_file_that_is_a_symlink_escaping_the_meeting_folder() {
        let dir = tempfile::tempdir().unwrap();
        let outside = tempfile::tempdir().unwrap();
        let folder = dir.path().join("Meetings").join("meet-1");
        std::fs::create_dir_all(&folder).unwrap();
        std::os::unix::fs::symlink(outside.path(), folder.join("escape")).unwrap();

        let seed = seed_with(vec![record(
            "meeting",
            "meet-1",
            json!({
                "folder": folder.display().to_string(),
                "docs": [{"file": "escape"}],
            }),
        )]);
        write_seed(dir.path(), &seed);

        let err = expect_refusal(dir.path());
        assert_eq!(err.code, "validation");
        assert_eq!(err.field.as_deref(), Some("records[0].data.docs[0].file"));
        assert!(!dir.path().join("workspace.sqlite").exists());
    }

    #[test]
    fn import_accepts_a_document_file_and_a_kept_version_in_the_history_subfolder() {
        let dir = tempfile::tempdir().unwrap();
        let folder = dir.path().join("Meetings").join("meet-1");
        let seed = seed_with(vec![record(
            "meeting",
            "meet-1",
            json!({
                "folder": folder.display().to_string(),
                "docs": [{
                    "file": "notes.md",
                    "versions": [{"file": "notes-history/2026-01-01_1200-template.md"}],
                }],
            }),
        )]);
        write_seed(dir.path(), &seed);

        let (counts, _provider) = import(dir.path()).unwrap();
        assert_eq!(counts.records, 1);
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
