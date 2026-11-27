//! `echo-plugin.json` (DESIGN 7.1, PLUGIN-ENGINE.md §3): the manifest of an Echo-compatible
//! plugin, read and checked without running anything. Parsing never judges `uses`, the engine
//! range or `requires`: the permission sheet (`capabilities::sheet`) and `check_compat` do, so a
//! package can still be listed and described when Connect can't install it. The manifest's `echo`
//! (the Echo version it needs) is compared with the Echo plugin API Connect provides
//! (`ECHO_COMPAT`); a range Connect can't read is Echo's own business and ignored.
use semver::{Version, VersionReq};
use serde::Deserialize;
use serde_json::{Map, Value};
use std::path::{Component, Path};

/// The manifest's file name inside a plugin folder.
pub const MANIFEST_FILE: &str = "echo-plugin.json";
/// The plugin engine Connect provides (PLUGIN-ENGINE.md §9), as `ctx.host.engine` reports it.
pub const ENGINE: &str = "1.0";
/// The Echo release whose plugin API Connect provides: a plugin made for a newer Echo is listed
/// as needing a newer Connect instead of installing and failing.
pub const ECHO_COMPAT: &str = "0.10.1";
/// The optional features (`requires`, PLUGIN-ENGINE.md §6) Connect has.
const FEATURES: [&str; 6] = [
    "work",
    "deliver",
    "deliver_provider",
    "echo",
    "tasks_provider",
    "reply_context_provider",
];
/// The roles a plugin can take in Connect (`provides`): `tasks` holds the user's tasks
/// (`ctx.tasks.provide`); `reply-context` shapes the user's reply drafts
/// (`ctx.replyContext.provide`, reply-voice design §1).
pub const ROLES: [&str; 2] = ["tasks", "reply-context"];
/// What a `reply-context` plugin may not also ask for (reply-voice ruling 10): it reads the
/// user's sent messages, so nothing it reads may leave the Mac.
const OFF_THIS_MAC: [&str; 4] = ["network", "web", "signin", "deliver"];
const SETTING_KINDS: [&str; 4] = ["string", "bool", "folder", "secret"];
/// The kinds of widget Echo draws (and Connect's Today draws) for a plugin.
pub const WIDGET_KINDS: [&str; 8] = [
    "stat", "stats", "chart", "list", "status", "card", "table", "page",
];

#[derive(Debug, thiserror::Error, PartialEq)]
pub enum ManifestError {
    #[error("no {MANIFEST_FILE} could be read: {0}")]
    Unreadable(String),
    #[error("{MANIFEST_FILE} isn't valid: {0}")]
    Invalid(String),
    #[error("its id \"{0}\" isn't a plain name (a-z, 0-9, -)")]
    BadId(String),
    #[error("{0} isn't a file inside the plugin")]
    MissingFile(String),
    #[error("widget \"{id}\" has a kind Connect doesn't draw ({kind}; {})", WIDGET_KINDS.join(", "))]
    BadWidgetKind { id: String, kind: String },
    #[error("it needs plugin engine {needs}, and Connect provides engine {ENGINE}")]
    Incompatible { needs: String },
    #[error("it needs {}, which Connect doesn't have", .0.join(" and "))]
    Lacking(Vec<String>),
    #[error("needs a newer Connect: it is made for Echo {needs}, and Connect gives plugins what Echo {ECHO_COMPAT} does")]
    NeedsNewerConnect { needs: String },
    #[error("needs {0}, which Connect doesn't know")]
    UnknownKey(String),
    #[error("\"{key}\" is asked for in a way Connect can't read: {why}")]
    BadValue { key: String, why: String },
    #[error("A reply-context plugin can't use the network: what it reads of your sent messages stays on this Mac.")]
    ReplyContextOffMac,
}

#[derive(Debug, Clone, Deserialize)]
pub struct SettingDef {
    pub key: String,
    pub label: String,
    /// `string`, `bool`, `folder` or `secret`.
    #[serde(rename = "type", default = "string_kind")]
    pub kind: String,
    #[serde(default)]
    pub default: Option<Value>,
    #[serde(default)]
    pub help: Option<String>,
}

fn string_kind() -> String {
    "string".into()
}

#[derive(Debug, Clone, Deserialize)]
pub struct WidgetDef {
    pub id: String,
    pub label: String,
    #[serde(default)]
    pub about: String,
    pub kind: String,
    #[serde(default)]
    pub sizes: Vec<String>,
    #[serde(default)]
    pub heights: Vec<u8>,
    #[serde(default)]
    pub refresh: Option<u64>,
    #[serde(default)]
    pub params: Vec<Value>,
}

/// Its part for Claude in Echo. Connect keeps the line and ignores the rest (agent is unsupported).
#[derive(Debug, Clone, Deserialize)]
pub struct AgentDef {
    #[serde(default)]
    pub summary: String,
    #[serde(default)]
    pub prefix: Option<String>,
}

#[derive(Debug, Clone)]
pub struct Manifest {
    pub id: String,
    pub name: String,
    pub version: Version,
    /// The plugin engine it needs (`>=1.0` when it doesn't say).
    pub engine: VersionReq,
    /// The Echo it is made for, when it says so in a way Connect can read.
    pub echo: Option<VersionReq>,
    /// The optional features it can't work without.
    pub requires: Vec<String>,
    /// The roles it takes in Connect (`ROLES`).
    pub provides: Vec<String>,
    pub summary: String,
    pub uses: Map<String, Value>,
    pub settings: Vec<SettingDef>,
    pub main: Option<String>,
    pub client: Option<String>,
    pub widgets: Vec<WidgetDef>,
    pub skills: Vec<String>,
    pub agent: Option<AgentDef>,
    pub icon: Option<String>,
}

/// The file as written; every field Echo defines, checked afterwards.
#[derive(Deserialize)]
struct Raw {
    id: String,
    name: String,
    version: String,
    #[serde(default)]
    engine: Option<String>,
    #[serde(default)]
    echo: Option<Value>,
    #[serde(default)]
    requires: Vec<String>,
    /// One role as a string, or a list of them.
    #[serde(default)]
    provides: Option<Value>,
    #[serde(default)]
    summary: String,
    #[serde(default)]
    uses: Map<String, Value>,
    #[serde(default)]
    settings: Vec<SettingDef>,
    #[serde(default)]
    main: Option<String>,
    #[serde(default)]
    client: Option<String>,
    #[serde(default)]
    widgets: Vec<WidgetDef>,
    #[serde(default)]
    skills: Vec<String>,
    #[serde(default)]
    agent: Option<AgentDef>,
    #[serde(default)]
    icon: Option<String>,
}

/// A range as manifests write it: `>=1.1`, or a bare `1.1` meaning the same; anything else is a
/// semver range.
fn parse_min_req(field: &str, text: &str) -> Result<VersionReq, ManifestError> {
    let t = text.trim();
    let mut bare = t.strip_prefix(">=").unwrap_or(t).trim().to_string();
    // A bare "0.9" or "1" is a minimum too, not semver's caret range.
    if !bare.is_empty()
        && bare.bytes().all(|b| b.is_ascii_digit() || b == b'.')
        && bare.matches('.').count() < 2
    {
        for _ in bare.matches('.').count()..2 {
            bare.push_str(".0");
        }
    }
    if let Ok(v) = Version::parse(&bare) {
        return Ok(VersionReq {
            comparators: vec![semver::Comparator {
                op: semver::Op::GreaterEq,
                major: v.major,
                minor: Some(v.minor),
                patch: Some(v.patch),
                pre: v.pre,
            }],
        });
    }
    VersionReq::parse(t).map_err(|e| ManifestError::Invalid(format!("{field} \"{text}\": {e}")))
}

/// What a manifest path must be.
#[derive(Clone, Copy, PartialEq)]
enum Entry {
    File,
    Folder,
}

/// A path the manifest names (`main`, `client`, `icon`, a skill): relative, inside the plugin
/// folder (no `..`, no symlink out) and an existing file or folder as asked.
fn inside_plugin(dir: &Path, rel: &str, want: Entry) -> Result<(), ManifestError> {
    let missing = || ManifestError::MissingFile(rel.to_string());
    let p = Path::new(rel.trim_start_matches("./").trim_end_matches('/'));
    if rel.is_empty()
        || p.as_os_str().is_empty()
        || p.is_absolute()
        || p.components().any(|c| !matches!(c, Component::Normal(_)))
    {
        return Err(missing());
    }
    let root = std::fs::canonicalize(dir).map_err(|_| missing())?;
    let found = std::fs::canonicalize(dir.join(p)).map_err(|_| missing())?;
    let right_kind = match want {
        Entry::File => found.is_file(),
        Entry::Folder => found.is_dir(),
    };
    if found.starts_with(&root) && right_kind {
        Ok(())
    } else {
        Err(missing())
    }
}

/// The most skills a plugin may ship (Echo's `MAX_SKILLS`).
const MAX_SKILLS: usize = 10;

/// Read and check `<dir>/echo-plugin.json`.
pub fn parse_manifest(dir: &Path) -> Result<Manifest, ManifestError> {
    let text = std::fs::read_to_string(dir.join(MANIFEST_FILE))
        .map_err(|e| ManifestError::Unreadable(e.to_string()))?;
    let raw: Raw =
        serde_json::from_str(&text).map_err(|e| ManifestError::Invalid(e.to_string()))?;
    if !super::valid_id(&raw.id) {
        return Err(ManifestError::BadId(raw.id));
    }
    if raw.name.trim().is_empty() || raw.name.chars().count() > 60 {
        return Err(ManifestError::Invalid(
            "its name must be 1-60 characters".into(),
        ));
    }
    let version = Version::parse(&raw.version).map_err(|_| {
        ManifestError::Invalid(format!("its version \"{}\" isn't like 1.2.3", raw.version))
    })?;
    let engine = parse_min_req("engine", raw.engine.as_deref().unwrap_or("1.0"))?;
    if raw.requires.len() > 16 || raw.requires.iter().any(|f| !is_feature(f)) {
        return Err(ManifestError::Invalid(
            "\"requires\" lists at most 16 feature names (a-z, _)".into(),
        ));
    }
    let provides = roles(raw.provides.as_ref())?;
    for w in &raw.widgets {
        if !WIDGET_KINDS.contains(&w.kind.as_str()) {
            return Err(ManifestError::BadWidgetKind {
                id: w.id.clone(),
                kind: w.kind.clone(),
            });
        }
    }
    for s in &raw.settings {
        if !SETTING_KINDS.contains(&s.kind.as_str()) {
            return Err(ManifestError::Invalid(format!(
                "setting \"{}\" has a type Connect doesn't know ({})",
                s.key,
                SETTING_KINDS.join(", ")
            )));
        }
    }
    if raw.skills.len() > MAX_SKILLS {
        return Err(ManifestError::Invalid(format!(
            "it ships more than {MAX_SKILLS} skills"
        )));
    }
    for f in raw.main.iter().chain(&raw.client).chain(&raw.icon) {
        inside_plugin(dir, f, Entry::File)?;
    }
    for f in &raw.skills {
        inside_plugin(dir, f, Entry::Folder)?;
    }
    Ok(Manifest {
        id: raw.id,
        name: raw.name,
        version,
        engine,
        echo: raw
            .echo
            .as_ref()
            .and_then(Value::as_str)
            .and_then(|t| parse_min_req("echo", t).ok()),
        requires: raw.requires,
        provides,
        summary: raw.summary,
        uses: raw.uses,
        settings: raw.settings,
        main: raw.main,
        client: raw.client,
        widgets: raw.widgets,
        skills: raw.skills,
        agent: raw.agent,
        icon: raw.icon,
    })
}

/// `provides`: one role or a list of them, each one Connect knows (`ROLES`).
fn roles(v: Option<&Value>) -> Result<Vec<String>, ManifestError> {
    let listed: Vec<&Value> = match v {
        None | Some(Value::Null) => Vec::new(),
        Some(Value::Array(a)) => a.iter().collect(),
        Some(one) => vec![one],
    };
    let mut roles = Vec::new();
    for role in listed {
        let Some(role) = role.as_str() else {
            return Err(ManifestError::Invalid(
                "\"provides\" lists roles by name".into(),
            ));
        };
        if !ROLES.contains(&role) {
            return Err(ManifestError::Invalid(format!(
                "provides a role Connect doesn't know ({})",
                role.escape_debug()
            )));
        }
        if !roles.iter().any(|r| r == role) {
            roles.push(role.to_string());
        }
    }
    Ok(roles)
}

fn is_feature(f: &str) -> bool {
    (1..=40).contains(&f.len()) && f.bytes().all(|b| b.is_ascii_lowercase() || b == b'_')
}

/// Whether these roles and `uses` break ruling 10: `reply-context` with the network, the web, a
/// sign-in or a delivery. Checked at install and turning on (`check_compat`), at load
/// (`Granted::of`) and when listing voice providers.
pub fn reaches_off_mac(provides: &[String], uses: &Map<String, Value>) -> bool {
    provides.iter().any(|r| r == "reply-context")
        && OFF_THIS_MAC.iter().any(|k| uses.contains_key(*k))
}

/// Refuses a plugin whose engine range excludes Connect's engine (`ENGINE`), whose `echo` range
/// excludes the Echo API Connect provides (`ECHO_COMPAT`), that requires a feature Connect
/// lacks (PLUGIN-ENGINE.md §3, §6), or that provides `reply-context` and also asks for the
/// network, the web, a sign-in or a delivery (`OFF_THIS_MAC`).
pub fn check_compat(m: &Manifest) -> Result<(), ManifestError> {
    if reaches_off_mac(&m.provides, &m.uses) {
        return Err(ManifestError::ReplyContextOffMac);
    }
    let have = Version::parse(&format!("{ENGINE}.0")).expect("ENGINE is a version");
    if !m.engine.matches(&have) {
        return Err(ManifestError::Incompatible {
            needs: m.engine.to_string(),
        });
    }
    let echo = Version::parse(ECHO_COMPAT).expect("ECHO_COMPAT is a version");
    if let Some(needs) = m.echo.as_ref().filter(|r| !r.matches(&echo)) {
        return Err(ManifestError::NeedsNewerConnect {
            needs: needs.to_string(),
        });
    }
    // Anything else (`threads`, `slots`, `scripts`, `sessions`, `channel`, or a name from a
    // newer spec) is a feature Connect lacks.
    let missing: Vec<String> = m
        .requires
        .iter()
        .filter(|f| !FEATURES.contains(&f.as_str()))
        .cloned()
        .collect();
    if missing.is_empty() {
        Ok(())
    } else {
        Err(ManifestError::Lacking(missing))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn write(dir: &Path, manifest: Value) {
        std::fs::write(dir.join(MANIFEST_FILE), manifest.to_string()).unwrap();
    }

    fn base() -> Value {
        json!({
            "id": "hello", "name": "Hello", "version": "1.2.3", "echo": ">=0.9.9",
            "summary": "Says hello", "main": "main.js", "client": "client.js", "icon": "icon.svg",
            "uses": {"network": {"hosts": ["api.example.com"]}},
            "settings": [{"key": "who", "label": "Who", "type": "string"}],
            "widgets": [{"id": "w", "label": "W", "kind": "stat"}],
            "skills": ["skills/a"], "agent": {"summary": "x", "prefix": "hi"}
        })
    }

    fn package(manifest: Value) -> tempfile::TempDir {
        let d = tempfile::tempdir().unwrap();
        for f in ["main.js", "client.js", "icon.svg"] {
            std::fs::write(d.path().join(f), "").unwrap();
        }
        std::fs::create_dir_all(d.path().join("skills/a")).unwrap();
        write(d.path(), manifest);
        d
    }

    #[test]
    fn parse_valid_and_reject_bad_id_missing_entry_bad_widget_kind() {
        let d = package(base());
        let m = parse_manifest(d.path()).unwrap();
        assert_eq!(
            (m.id.as_str(), m.version.to_string()),
            ("hello", "1.2.3".into())
        );
        assert_eq!(m.main.as_deref(), Some("main.js"));
        assert_eq!(m.widgets[0].kind, "stat");
        assert_eq!(m.settings[0].kind, "string");
        assert_eq!(m.agent.unwrap().prefix.as_deref(), Some("hi"));
        assert!(m.uses.contains_key("network"));

        for id in ["Hello", "a", "1x", "-x", "a.b", "x/y"] {
            let mut j = base();
            j["id"] = json!(id);
            let d = package(j);
            assert_eq!(
                parse_manifest(d.path()).unwrap_err(),
                ManifestError::BadId(id.into())
            );
        }
        // Entry files must exist and stay inside the folder.
        for (field, path) in [
            ("main", "gone.js"),
            ("client", "../outside.js"),
            ("main", "/etc/hosts"),
            ("icon", "sub/../../x.svg"),
        ] {
            let mut j = base();
            j[field] = json!(path);
            let d = package(j);
            assert_eq!(
                parse_manifest(d.path()).unwrap_err(),
                ManifestError::MissingFile(path.into()),
                "{field} {path}"
            );
        }
        let mut j = base();
        j["widgets"] = json!([{"id": "w", "label": "W", "kind": "gauge"}]);
        let d = package(j);
        let e = parse_manifest(d.path()).unwrap_err();
        assert!(matches!(e, ManifestError::BadWidgetKind { ref kind, .. } if kind == "gauge"));
        assert!(e.to_string().contains("stat, stats, chart"));
        for kind in WIDGET_KINDS {
            let mut j = base();
            j["widgets"] = json!([{"id": "w", "label": "W", "kind": kind}]);
            assert!(parse_manifest(package(j).path()).is_ok(), "{kind}");
        }
        // No manifest, not JSON, a bad version.
        let empty = tempfile::tempdir().unwrap();
        assert!(matches!(
            parse_manifest(empty.path()),
            Err(ManifestError::Unreadable(_))
        ));
        std::fs::write(empty.path().join(MANIFEST_FILE), "{").unwrap();
        assert!(matches!(
            parse_manifest(empty.path()),
            Err(ManifestError::Invalid(_))
        ));
        let mut j = base();
        j["version"] = json!("one");
        assert!(matches!(
            parse_manifest(package(j).path()),
            Err(ManifestError::Invalid(_))
        ));
    }

    #[test]
    fn entries_skills_settings_and_versions_are_checked() {
        // `./main.js` is fine; a folder is not a file; skills are folders inside the plugin.
        let mut j = base();
        j["main"] = json!("./main.js");
        assert!(parse_manifest(package(j).path()).is_ok());
        let mut j = base();
        j["main"] = json!("skills");
        let d = package(j);
        assert_eq!(
            parse_manifest(d.path()).unwrap_err(),
            ManifestError::MissingFile("skills".into())
        );
        let mut j = base();
        j["skills"] = json!(["skills/a"]);
        let d = package(j);
        assert!(parse_manifest(d.path()).is_ok());
        std::fs::remove_dir(d.path().join("skills/a")).unwrap();
        assert_eq!(
            parse_manifest(d.path()).unwrap_err(),
            ManifestError::MissingFile("skills/a".into())
        );
        for bad in ["../x", "/etc", "skills/../../x", "main.js"] {
            let mut j = base();
            j["skills"] = json!([bad]);
            let d = package(j);
            assert_eq!(
                parse_manifest(d.path()).unwrap_err(),
                ManifestError::MissingFile(bad.into()),
                "{bad}"
            );
        }
        let mut j = base();
        j["skills"] = json!((0..11).map(|i| format!("s{i}")).collect::<Vec<_>>());
        assert!(matches!(
            parse_manifest(package(j).path()),
            Err(ManifestError::Invalid(_))
        ));
        // A skill folder that is a symlink out of the plugin.
        #[cfg(unix)]
        {
            let outside = tempfile::tempdir().unwrap();
            let mut j = base();
            j["skills"] = json!(["skills/a"]);
            let d = package(j);
            std::fs::remove_dir(d.path().join("skills/a")).unwrap();
            std::os::unix::fs::symlink(outside.path(), d.path().join("skills/a")).unwrap();
            assert_eq!(
                parse_manifest(d.path()).unwrap_err(),
                ManifestError::MissingFile("skills/a".into())
            );
        }
        // Setting types.
        for kind in ["string", "bool", "folder", "secret"] {
            let mut j = base();
            j["settings"] = json!([{"key": "k", "label": "K", "type": kind}]);
            assert!(parse_manifest(package(j).path()).is_ok(), "{kind}");
        }
        let mut j = base();
        j["settings"] = json!([{"key": "k", "label": "K", "type": "color"}]);
        assert!(matches!(
            parse_manifest(package(j).path()),
            Err(ManifestError::Invalid(_))
        ));
        // A bare version is a minimum, whatever its length.
        for (text, shown) in [
            ("0.9", ">=0.9.0"),
            ("1", ">=1.0.0"),
            ("0.9.9", ">=0.9.9"),
            (">=0.9", ">=0.9.0"),
        ] {
            assert_eq!(
                parse_min_req("engine", text).unwrap().to_string(),
                shown,
                "{text}"
            );
        }
        assert!(parse_min_req("engine", "0.10")
            .unwrap()
            .matches(&Version::parse("0.11.0").unwrap()));
    }

    #[test]
    fn provides_tasks_parses_and_needs_the_feature() {
        for provides in [json!("tasks"), json!(["tasks"]), json!(["tasks", "tasks"])] {
            let mut j = base();
            j["provides"] = provides.clone();
            j["requires"] = json!(["tasks_provider"]);
            let m = parse_manifest(package(j).path()).unwrap();
            assert_eq!(m.provides, ["tasks"], "{provides}");
            assert!(
                check_compat(&m).is_ok(),
                "tasks_provider is a feature Connect has"
            );
        }
        let m = parse_manifest(package(base()).path()).unwrap();
        assert!(m.provides.is_empty());
        let mut j = base();
        j["provides"] = json!(["calendar"]);
        assert_eq!(
            parse_manifest(package(j).path()).unwrap_err(),
            ManifestError::Invalid("provides a role Connect doesn't know (calendar)".into())
        );
        let mut j = base();
        j["provides"] = json!([7]);
        assert!(matches!(
            parse_manifest(package(j).path()),
            Err(ManifestError::Invalid(_))
        ));
    }

    #[test]
    fn reply_context_role_needs_its_feature_and_is_known() {
        for provides in [json!("reply-context"), json!(["reply-context"])] {
            let mut j = base();
            j["uses"] = json!({});
            j["provides"] = provides.clone();
            j["requires"] = json!(["reply_context_provider"]);
            let m = parse_manifest(package(j).path()).unwrap();
            assert_eq!(m.provides, ["reply-context"], "{provides}");
            assert!(
                check_compat(&m).is_ok(),
                "reply_context_provider is a feature Connect has"
            );
        }
        let mut j = base();
        j["provides"] = json!(["reply-voice"]);
        assert_eq!(
            parse_manifest(package(j).path()).unwrap_err(),
            ManifestError::Invalid("provides a role Connect doesn't know (reply-voice)".into())
        );
    }

    #[test]
    fn reply_context_plugin_cannot_use_the_network() {
        for key in ["network", "web", "signin", "deliver"] {
            let mut j = base();
            j["uses"] = json!({ key: {} });
            j["provides"] = json!(["reply-context"]);
            j["requires"] = json!(["reply_context_provider"]);
            let m = parse_manifest(package(j).path()).unwrap();
            assert_eq!(
                check_compat(&m).unwrap_err().to_string(),
                "A reply-context plugin can't use the network: what it reads of your sent messages stays on this Mac.",
                "{key}"
            );
        }
        // Reading folders and Claude stays allowed; a tasks provider may still use the network.
        let mut j = base();
        j["uses"] = json!({"folders": {"write": true}, "claude": {}});
        j["provides"] = json!(["reply-context"]);
        assert!(check_compat(&parse_manifest(package(j).path()).unwrap()).is_ok());
        let mut j = base();
        j["provides"] = json!(["tasks"]);
        assert!(check_compat(&parse_manifest(package(j).path()).unwrap()).is_ok());
    }

    #[test]
    fn a_symlink_out_of_the_folder_is_not_an_entry_file() {
        let outside = tempfile::tempdir().unwrap();
        std::fs::write(outside.path().join("evil.js"), "").unwrap();
        let d = package(base());
        std::fs::remove_file(d.path().join("main.js")).unwrap();
        #[cfg(unix)]
        std::os::unix::fs::symlink(outside.path().join("evil.js"), d.path().join("main.js"))
            .unwrap();
        #[cfg(unix)]
        assert_eq!(
            parse_manifest(d.path()).unwrap_err(),
            ManifestError::MissingFile("main.js".into())
        );
    }

    #[test]
    fn engine_range_requires_and_echo_range_are_checked() {
        let with = |field: &str, v: Value| {
            let mut j = base();
            j[field] = v;
            let d = package(j);
            parse_manifest(d.path()).and_then(|m| check_compat(&m))
        };
        for ok in [">=1.0", "1.0", "1", "^1", ">=0.9, <2", "1.0.0"] {
            assert!(with("engine", json!(ok)).is_ok(), "{ok}");
        }
        for (bad, shown) in [(">=1.1", ">=1.1.0"), ("2", ">=2.0.0"), ("<1.0.0", "<1.0.0")] {
            let e = with("engine", json!(bad)).unwrap_err();
            assert_eq!(
                e,
                ManifestError::Incompatible {
                    needs: shown.into()
                },
                "{bad}"
            );
            assert_eq!(
                e.to_string(),
                format!("it needs plugin engine {shown}, and Connect provides engine 1.0")
            );
        }
        // No engine: 1.0 will do.
        let mut j = base();
        j.as_object_mut().unwrap().remove("engine");
        assert!(check_compat(&parse_manifest(package(j).path()).unwrap()).is_ok());
        // `echo`: a range Connect's Echo API (ECHO_COMPAT) meets passes, one above it needs a newer
        // Connect, and one that isn't a version is Echo's own business (ignored).
        for echo in [">=0.9.13", ">=0.10.0", ">=0.10.1", "0.10", "not a version"] {
            assert!(with("echo", json!(echo)).is_ok(), "{echo}");
        }
        for (echo, shown) in [(">=0.11.0", ">=0.11.0"), ("99.0.0", ">=99.0.0")] {
            let e = with("echo", json!(echo)).unwrap_err();
            assert_eq!(
                e,
                ManifestError::NeedsNewerConnect {
                    needs: shown.into()
                }
            );
            assert_eq!(
                e.to_string(),
                format!(
                    "needs a newer Connect: it is made for Echo {shown}, and Connect gives plugins what Echo {ECHO_COMPAT} does"
                )
            );
        }
        assert!(matches!(
            with("engine", json!("soon")),
            Err(ManifestError::Invalid(_))
        ));
        // Features Connect has pass; any other is named.
        assert!(with("requires", json!(["work", "deliver", "echo"])).is_ok());
        let e = with("requires", json!(["work", "threads", "slots"])).unwrap_err();
        assert_eq!(
            e.to_string(),
            "it needs threads and slots, which Connect doesn't have"
        );
        assert!(matches!(
            with("requires", json!(["Threads!"])),
            Err(ManifestError::Invalid(_))
        ));
    }
}
