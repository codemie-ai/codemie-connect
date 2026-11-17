//! `echo-plugin.json` (DESIGN 7.1): the manifest of an Echo-compatible plugin, read and checked
//! without running anything. Parsing never judges `uses` or the Echo range: the permission sheet
//! (`capabilities::sheet`) and `check_compat` do, so a package can still be listed and described
//! when Connect can't install it.
use semver::{Version, VersionReq};
use serde::Deserialize;
use serde_json::{Map, Value};
use std::path::{Component, Path};

/// The manifest's file name inside a plugin folder.
pub const MANIFEST_FILE: &str = "echo-plugin.json";
/// The Echo plugin API Connect reports to plugins (DESIGN 7.1).
pub const ECHO_COMPAT: &str = "0.9.11";
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
    #[error("it needs Echo {needs}, and Connect provides Echo API {ECHO_COMPAT}")]
    Incompatible { needs: String },
    #[error("needs {0}, which Connect doesn't know")]
    UnknownKey(String),
    #[error("\"{key}\" is asked for in a way Connect can't read: {why}")]
    BadValue { key: String, why: String },
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
    /// The Echo API it needs (`*` when it doesn't say).
    pub echo: VersionReq,
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
    echo: Option<String>,
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

/// Echo writes `>=0.9.9`, or a bare `0.9.9` meaning the same; anything else is a semver range.
fn parse_echo_req(text: &str) -> Result<VersionReq, ManifestError> {
    let t = text.trim();
    let bare = t.strip_prefix(">=").unwrap_or(t).trim();
    if let Ok(v) = Version::parse(bare) {
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
    VersionReq::parse(t).map_err(|e| ManifestError::Invalid(format!("echo \"{text}\": {e}")))
}

/// A path the manifest names (`main`, `client`, `icon`): relative, inside the plugin folder (no
/// `..`, no symlink out) and an existing file.
fn inside_plugin(dir: &Path, rel: &str) -> Result<(), ManifestError> {
    let missing = || ManifestError::MissingFile(rel.to_string());
    let p = Path::new(rel.trim_start_matches("./"));
    if rel.is_empty()
        || p.is_absolute()
        || p.components().any(|c| !matches!(c, Component::Normal(_)))
    {
        return Err(missing());
    }
    let root = std::fs::canonicalize(dir).map_err(|_| missing())?;
    let file = std::fs::canonicalize(dir.join(p)).map_err(|_| missing())?;
    if file.starts_with(&root) && file.is_file() {
        Ok(())
    } else {
        Err(missing())
    }
}

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
    let echo = match raw.echo.as_deref() {
        None => VersionReq::STAR,
        Some(r) => parse_echo_req(r)?,
    };
    for w in &raw.widgets {
        if !WIDGET_KINDS.contains(&w.kind.as_str()) {
            return Err(ManifestError::BadWidgetKind {
                id: w.id.clone(),
                kind: w.kind.clone(),
            });
        }
    }
    for f in raw.main.iter().chain(&raw.client).chain(&raw.icon) {
        inside_plugin(dir, f)?;
    }
    Ok(Manifest {
        id: raw.id,
        name: raw.name,
        version,
        echo,
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

/// Refuses a plugin whose Echo range excludes the API Connect reports (`ECHO_COMPAT`).
pub fn check_compat(m: &Manifest) -> Result<(), ManifestError> {
    let have = Version::parse(ECHO_COMPAT).expect("ECHO_COMPAT is a version");
    if m.echo.matches(&have) {
        Ok(())
    } else {
        Err(ManifestError::Incompatible {
            needs: m.echo.to_string(),
        })
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
    fn echo_range_excluding_compat_is_refused_with_reason() {
        let with = |echo: Value| {
            let mut j = base();
            j["echo"] = echo;
            let d = package(j);
            parse_manifest(d.path()).and_then(|m| check_compat(&m))
        };
        for ok in [">=0.9.9", "0.9.11", ">=0.9.11", "^0.9", ">=0.9.0, <1.0.0"] {
            assert!(with(json!(ok)).is_ok(), "{ok}");
        }
        for (bad, shown) in [
            (">=0.9.13", ">=0.9.13"),
            ("0.10.0", ">=0.10.0"),
            ("<0.9.0", "<0.9.0"),
        ] {
            let e = with(json!(bad)).unwrap_err();
            assert_eq!(
                e,
                ManifestError::Incompatible {
                    needs: shown.into()
                },
                "{bad}"
            );
            assert!(
                e.to_string().contains("0.9.11") && e.to_string().contains(shown),
                "{e}"
            );
        }
        // No range at all: any Echo will do.
        let mut j = base();
        j.as_object_mut().unwrap().remove("echo");
        assert!(check_compat(&parse_manifest(package(j).path()).unwrap()).is_ok());
    }
}
