//! Files the user hands a plugin (Echo 0.10): picked with `system.pickFiles` or dropped on its page
//! (`onFileDrop`). A plugin gets a handle `{file, name, size}`, never the path: `file` is an opaque
//! id of that plugin's alone, kept in memory for an hour (1,000 at most). `fs.copyIn` copies a
//! handle's bytes into a folder the plugin was given, checked as `fs.write`.
use super::{at, bad, io_failed, lock, text, Granted, Services};
use crate::plugins::host::{ErrorCode, HostError};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::path::PathBuf;
use std::time::{Duration, Instant};

/// How long a handle lasts, and how many are kept.
const LIFETIME: Duration = Duration::from_secs(3600);
const MAX_HANDLES: usize = 1000;
/// `copyIn` copies 50 MB at most.
const COPY_MAX: u64 = 50 << 20;
/// `pickFiles` filters by 20 extensions at most.
const MAX_EXTS: usize = 20;

struct Handle {
    plugin: String,
    path: PathBuf,
    at: Instant,
}

/// The handles given out, by id.
#[derive(Default)]
pub struct Handles(HashMap<String, Handle>);

impl Handles {
    /// A handle of `plugin`'s for the file at `path`: `{file, name, size}`.
    pub fn make(&mut self, plugin: &str, path: PathBuf) -> Result<Value, HostError> {
        let meta = std::fs::metadata(&path).map_err(|e| io_failed("use that file", &e))?;
        if !meta.is_file() {
            return Err(bad("only files can be handed to a plugin"));
        }
        self.0.retain(|_, h| h.at.elapsed() < LIFETIME);
        if self.0.len() >= MAX_HANDLES {
            if let Some(oldest) = self
                .0
                .iter()
                .min_by_key(|(_, h)| h.at)
                .map(|(k, _)| k.clone())
            {
                self.0.remove(&oldest);
            }
        }
        let id = format!("h{}", uuid::Uuid::new_v4().simple());
        let name = path
            .file_name()
            .map(|n| n.to_string_lossy().into_owned())
            .unwrap_or_default();
        self.0.insert(
            id.clone(),
            Handle {
                plugin: plugin.to_string(),
                path,
                at: Instant::now(),
            },
        );
        Ok(json!({"file": id, "name": name, "size": meta.len()}))
    }

    /// `plugin`'s handle `file` as the plugin knows it, `{file, name, size}`, while it lasts.
    pub fn handle_of(&self, plugin: &str, file: &str) -> Result<Value, HostError> {
        let path = self.path_of(plugin, file)?;
        let size = std::fs::metadata(&path).map_or(0, |m| m.len());
        let name = path
            .file_name()
            .map(|n| n.to_string_lossy().into_owned())
            .unwrap_or_default();
        Ok(json!({"file": file, "name": name, "size": size}))
    }

    /// Where `plugin`'s handle `file` points, while it lasts.
    pub fn path_of(&self, plugin: &str, file: &str) -> Result<PathBuf, HostError> {
        self.0
            .get(file)
            .filter(|h| h.plugin == plugin && h.at.elapsed() < LIFETIME)
            .map(|h| h.path.clone())
            .ok_or_else(|| {
                HostError::new(
                    ErrorCode::NotFound,
                    "that file isn't there (handed to another plugin, or over an hour ago)",
                )
            })
    }
}

/// Handles of `plugin`'s for files the user gave it (picked or dropped).
pub fn hand(s: &Services, plugin: &str, paths: Vec<PathBuf>) -> Result<Value, HostError> {
    let mut handles = lock(&s.files);
    let made = paths
        .into_iter()
        .map(|p| handles.make(plugin, p))
        .collect::<Result<Vec<_>, _>>()?;
    Ok(json!(made))
}

/// `system.pickFiles(prompt, {multiple, ext})`: the system's file picker, titled "<plugin> —
/// <prompt>"; `[]` when cancelled.
pub async fn pick(s: &Services, p: &Granted, args: &Value) -> Result<Value, HostError> {
    let prompt = at(args, 0).as_str().unwrap_or("Choose a file");
    let o = at(args, 1);
    let exts: Vec<String> = o["ext"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(Value::as_str)
        .map(|e| e.trim_start_matches('.').to_string())
        .collect();
    if exts.len() > MAX_EXTS
        || exts
            .iter()
            .any(|e| e.is_empty() || e.len() > 16 || !e.bytes().all(|b| b.is_ascii_alphanumeric()))
    {
        return Err(bad("ext lists up to 20 extensions of letters and digits"));
    }
    let title: String = format!("{} — {prompt}", p.name).chars().take(200).collect();
    let multiple = o["multiple"] == true;
    let mut picked = s.outside.picker.pick_files(title, multiple, exts).await;
    if !multiple {
        picked.truncate(1);
    }
    hand(s, &p.id, picked)
}

/// `fs.copyIn(file, root, path, {createNew = true})` → `{path, size}`: the handle's bytes as they
/// are, 50 MB at most, written as `fs.write` writes; never over a file unless `createNew: false`.
pub fn copy_in(s: &Services, p: &Granted, args: &Value) -> Result<Value, HostError> {
    let file = match at(args, 0) {
        Value::String(id) => id.as_str(),
        v => v["file"]
            .as_str()
            .ok_or_else(|| bad("copyIn takes a file handle {file, name, size}"))?,
    };
    let root = text(args, 1, "a folder")?;
    let rel = text(args, 2, "a path in the folder")?;
    let source = lock(&s.files).path_of(&p.id, file)?;
    let size = std::fs::metadata(&source)
        .map_err(|e| io_failed("read that file", &e))?
        .len();
    if size > COPY_MAX {
        return Err(HostError::new(
            ErrorCode::Limit,
            format!(
                "{} is {} MB — 50 MB at most",
                source.file_name().unwrap_or_default().to_string_lossy(),
                size >> 20
            ),
        ));
    }
    if super::hidden::in_skills(rel) {
        return Err(bad("a skill is written whole: no copyIn"));
    }
    let target = super::fs::writable(s, p, root, rel)?;
    if target.is_dir() {
        return Err(bad(format!("“{rel}” is a folder")));
    }
    if let Some(parent) = target.parent() {
        std::fs::create_dir_all(parent).map_err(|e| io_failed("make its folder", &e))?;
    }
    let target = super::fs::writable(s, p, root, rel)?;
    let bytes = std::fs::read(&source).map_err(|e| io_failed("read that file", &e))?;
    if bytes.len() as u64 > COPY_MAX {
        return Err(HostError::new(ErrorCode::Limit, "it grew past 50 MB"));
    }
    let guard = if at(args, 3)["createNew"] == false {
        super::cas::Guard::Any
    } else {
        super::cas::Guard::CreateNew
    };
    let _order = lock(&s.writes);
    super::cas::write(&target, rel, &bytes, &guard)?;
    Ok(json!({"path": rel, "size": bytes.len()}))
}

#[cfg(test)]
mod tests {
    use super::super::testing::Env;
    use super::*;
    use std::path::Path;

    #[test]
    fn handles_belong_to_one_plugin_and_expire() {
        let env = Env::new();
        let f = env.dir.path().join("deck.pdf");
        std::fs::write(&f, "%PDF").unwrap();
        let mut h = Handles::default();
        let made = h.make("obsidian", f.clone()).unwrap();
        assert_eq!(made["name"], "deck.pdf");
        assert_eq!(made["size"], 4);
        let id = made["file"].as_str().unwrap();
        assert!(id.starts_with('h') && !id.contains('/'));
        assert_eq!(h.path_of("obsidian", id).unwrap(), f);
        let e = h.path_of("github", id).unwrap_err();
        assert!(e.message.contains("isn't there"), "{e}");
        h.0.get_mut(id).unwrap().at = Instant::now() - LIFETIME;
        assert!(h.path_of("obsidian", id).is_err());
        assert!(h.make("obsidian", env.dir.path().to_path_buf()).is_err());
    }

    #[tokio::test]
    async fn a_command_hears_the_files_handed_with_its_call() {
        use crate::plugins::host::{Grants, PluginHost};
        let env = Env::new();
        let host = std::sync::Arc::new(PluginHost::new(env.services.clone()));
        env.services.set_host(&host);
        env.plugin("vaults", json!({}), json!([]));
        let main = env.dir.path().join("main.js");
        std::fs::write(
            &main,
            "export function apply(ctx) { ctx.command('got', (args, extra) => ({ args, files: extra.files })) }",
        )
        .unwrap();
        host.load("vaults", &main, Grants::default()).await.unwrap();
        let plain = host.call("vaults", "got", json!({"a": 1})).await.unwrap();
        assert_eq!(plain, json!({"args": {"a": 1}, "files": []}));
        let f = env.dir.path().join("Brief.md");
        std::fs::write(&f, "b").unwrap();
        let made = lock(&env.services.files).make("vaults", f).unwrap();
        let id = made["file"].as_str().unwrap();
        let handle = lock(&env.services.files).handle_of("vaults", id).unwrap();
        assert_eq!(handle, made);
        assert!(lock(&env.services.files).handle_of("other", id).is_err());
        let with = host
            .call_with_files(
                "vaults",
                "got",
                json!({"kind": "files"}),
                vec![handle.clone()],
            )
            .await
            .unwrap();
        assert_eq!(with, json!({"args": {"kind": "files"}, "files": [handle]}));
    }

    #[tokio::test]
    async fn picked_files_are_copied_in_never_over_a_file_or_into_skills() {
        let env = Env::new();
        env.plugin("vaults", json!({"folders": {"write": true}}), json!([]));
        let vault = env.dir.path().join("vault");
        std::fs::create_dir_all(&vault).unwrap();
        env.picker.next(&vault);
        let root = env
            .call_async("vaults", "system.pickFolder", json!(["A vault"]))
            .await
            .unwrap();
        let src = env.dir.path().join("Deck.pdf");
        std::fs::write(&src, "%PDF-1.4").unwrap();
        env.picker.next_files(&[&src]);
        let picked = env
            .call_async(
                "vaults",
                "system.pickFiles",
                json!(["Add a source", {"ext": ["pdf"]}]),
            )
            .await
            .unwrap();
        assert_eq!(picked.as_array().unwrap().len(), 1);
        let handle = picked[0].clone();
        assert!(
            !handle
                .to_string()
                .contains(env.dir.path().to_str().unwrap()),
            "no path: {handle}"
        );
        let out = env
            .call_async("vaults", "fs.copyIn", json!([handle, root, "raw/Deck.pdf"]))
            .await
            .unwrap();
        assert_eq!(out, json!({"path": "raw/Deck.pdf", "size": 8}));
        assert_eq!(
            std::fs::read_to_string(Path::new(root.as_str().unwrap()).join("raw/Deck.pdf"))
                .unwrap(),
            "%PDF-1.4"
        );
        let again = env
            .call_async("vaults", "fs.copyIn", json!([handle, root, "raw/Deck.pdf"]))
            .await
            .unwrap_err();
        assert!(again.message.contains("is there already"), "{again}");
        env.call_async(
            "vaults",
            "fs.copyIn",
            json!([handle, root, "raw/Deck.pdf", {"createNew": false}]),
        )
        .await
        .unwrap();
        for bad in [
            "/.claude/skills/x/SKILL.md",
            ".claude/skills/x/a.md",
            ".git/x",
        ] {
            assert!(
                env.call_async("vaults", "fs.copyIn", json!([handle, root, bad]))
                    .await
                    .is_err(),
                "{bad}"
            );
        }
        // Another plugin can't use the handle; a cancelled picker gives none.
        env.plugin("other", json!({"folders": {"write": true}}), json!([]));
        assert!(env
            .call_async("other", "fs.copyIn", json!([handle, root, "x.pdf"]))
            .await
            .is_err());
        assert_eq!(
            env.call_async("vaults", "system.pickFiles", json!(["x"]))
                .await
                .unwrap(),
            json!([])
        );
        assert!(env
            .call_async(
                "vaults",
                "system.pickFiles",
                json!(["x", {"ext": ["p d f"]}])
            )
            .await
            .is_err());
    }
}
