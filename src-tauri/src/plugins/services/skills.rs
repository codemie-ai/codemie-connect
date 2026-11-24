//! `ctx.claude.installSkill(name, md)` and `removeSkill(name)` (Echo 0.10, `uses.skills`): a skill in
//! the user's own Claude Code, `~/.claude/skills/<name>/SKILL.md`. Asked for by the plugin's page
//! on the user's click, confirmed in Connect's own window (which shows the skill's name and
//! description), and checked again here: 256 KB at most, Markdown that runs nothing
//! (`hidden::skill_md_problem`), and never over a skill the plugin didn't add. What it added is
//! kept in `<data>/plugins/data/<id>/skills.json`, so it removes only its own.
use super::hidden::{skill_md_problem, skill_name};
use super::{bad, io_failed, permission, read_json, write_json, Granted, Services};
use crate::plugins::host::{ErrorCode, HostError};
use serde_json::{json, Map, Value};
use std::path::{Path, PathBuf};

const MAX_BYTES: usize = 256 * 1024;

fn record(s: &Services, id: &str) -> PathBuf {
    s.data_of(id).join("skills.json")
}

fn owned(s: &Services, id: &str) -> Map<String, Value> {
    match read_json(&record(s, id), json!({})) {
        Value::Object(m) => m,
        _ => Map::new(),
    }
}

fn folder(home: &Path, name: &str) -> PathBuf {
    home.join(".claude/skills").join(name)
}

/// The user's home folder, where their Claude Code keeps its skills.
pub fn home() -> Result<PathBuf, HostError> {
    Some(crate::ai::discover::home_dir())
        .filter(|h| h.is_absolute())
        .ok_or_else(|| bad("Connect can't find your home folder"))
}

/// A skill's `description` from its frontmatter, when it has one.
fn description(md: &str) -> String {
    let rest = md.trim_start_matches(|c: char| c == '\u{feff}' || c.is_whitespace());
    let Some(body) = rest.strip_prefix("---") else {
        return String::new();
    };
    body.lines()
        .skip(1)
        .take_while(|l| l.trim_end() != "---")
        .find_map(|l| l.strip_prefix("description:"))
        .map(|d| {
            d.trim()
                .trim_matches(['"', '\''])
                .chars()
                .take(500)
                .collect()
        })
        .unwrap_or_default()
}

/// What installing `name` would do, for Connect's confirmation: `{name, description, path,
/// replaces}` (`replaces`: an earlier version of the plugin's own). Refuses what can't be added.
pub fn check(
    s: &Services,
    p: &Granted,
    name: &str,
    md: &str,
    home: &Path,
) -> Result<Value, HostError> {
    p.needs("skills", "add a skill to your own Claude Code")?;
    if !skill_name(name) {
        return Err(bad("a skill's name is 1–64 of a–z, 0–9 and -"));
    }
    if md.len() > MAX_BYTES {
        return Err(HostError::new(
            ErrorCode::Limit,
            "a skill is 256 KB at most",
        ));
    }
    if let Some(why) = skill_md_problem(md) {
        return Err(bad(why));
    }
    let dir = folder(home, name);
    let mine = owned(s, &p.id).contains_key(name);
    if std::fs::symlink_metadata(&dir).is_ok() && !mine {
        return Err(permission(format!(
            "~/.claude/skills/{name} is a skill you have already, not one {} added: Connect doesn't write over it",
            p.name
        )));
    }
    Ok(json!({
        "name": name,
        "description": description(md),
        "path": format!("~/.claude/skills/{name}/SKILL.md"),
        "replaces": mine && dir.exists(),
    }))
}

/// Writes the skill (after `check` and the user's yes) and records it as the plugin's.
pub fn install(
    s: &Services,
    p: &Granted,
    name: &str,
    md: &str,
    home: &Path,
) -> Result<Value, HostError> {
    check(s, p, name, md, home)?;
    s.writable()?;
    let dir = folder(home, name);
    std::fs::create_dir_all(&dir).map_err(|e| io_failed("make the skill's folder", &e))?;
    if std::fs::symlink_metadata(&dir).is_ok_and(|m| !m.is_dir()) {
        return Err(permission(format!(
            "~/.claude/skills/{name} isn't a folder"
        )));
    }
    crate::storage::location::write_atomic(&dir.join("SKILL.md"), md.as_bytes())
        .map_err(|e| io_failed("write the skill", &e))?;
    let mut mine = owned(s, &p.id);
    mine.insert(name.into(), json!(super::cas::sha_hex(md.as_bytes())));
    write_json(&record(s, &p.id), &Value::Object(mine))?;
    log::info!(
        "[plugin:{}] added the skill {name} to your Claude Code",
        p.id
    );
    Ok(json!({"installed": true, "path": format!("~/.claude/skills/{name}/SKILL.md")}))
}

/// Takes out a skill the plugin added (its `SKILL.md`, and the folder when nothing else is left in
/// it). One it didn't add, or one already gone, is refused in Echo's words.
pub fn remove(s: &Services, p: &Granted, name: &str, home: &Path) -> Result<Value, HostError> {
    p.needs("skills", "add a skill to your own Claude Code")?;
    let mut mine = owned(s, &p.id);
    let not_ours = || bad(format!("“{name}” isn't a skill {} added", p.id));
    if !skill_name(name) || !mine.contains_key(name) {
        return Err(not_ours());
    }
    let dir = folder(home, name);
    let file = dir.join("SKILL.md");
    let gone = std::fs::symlink_metadata(&file).is_err();
    if !gone {
        std::fs::remove_file(&file).map_err(|e| io_failed("remove the skill", &e))?;
        let _ = std::fs::remove_dir(&dir);
    }
    mine.remove(name);
    write_json(&record(s, &p.id), &Value::Object(mine))?;
    if gone {
        return Err(bad(format!(
            "“{name}” isn't a skill {} added any more: it was removed already",
            p.id
        )));
    }
    log::info!(
        "[plugin:{}] removed the skill {name} from your Claude Code",
        p.id
    );
    Ok(json!({"removed": true}))
}

#[cfg(test)]
mod tests {
    use super::super::testing::Env;
    use super::*;

    const TWIN: &str = "---\nname: twin-me\ndescription: My digital twin's voice\n---\n# Twin\n";

    #[test]
    fn a_plugin_adds_and_removes_only_its_own_skills() {
        let env = Env::new();
        let p = env.plugin("kn", json!({"skills": {}}), json!([]));
        let plain = env.plugin("plain", json!({}), json!([]));
        let home = env.dir.path().join("home");
        let checked = check(&env.services, &p, "twin-me", TWIN, &home).unwrap();
        assert_eq!(checked["description"], "My digital twin's voice");
        assert_eq!(checked["path"], "~/.claude/skills/twin-me/SKILL.md");
        assert_eq!(checked["replaces"], false);
        install(&env.services, &p, "twin-me", TWIN, &home).unwrap();
        assert_eq!(
            std::fs::read_to_string(home.join(".claude/skills/twin-me/SKILL.md")).unwrap(),
            TWIN
        );
        assert_eq!(
            check(&env.services, &p, "twin-me", TWIN, &home).unwrap()["replaces"],
            true
        );
        // Never over the user's own skill; never without `uses.skills`; never a command.
        std::fs::create_dir_all(home.join(".claude/skills/mine")).unwrap();
        let e = install(&env.services, &p, "mine", TWIN, &home).unwrap_err();
        assert!(e.message.contains("is a skill you have already"), "{e}");
        assert!(install(&env.services, &plain, "x", TWIN, &home).is_err());
        let e = install(&env.services, &p, "bad", "Run !`rm -rf ~`", &home).unwrap_err();
        assert!(e.message.contains("can't run commands"), "{e}");
        assert!(install(&env.services, &p, "Bad Name", TWIN, &home).is_err());
        assert!(install(&env.services, &p, "big", &"x".repeat(MAX_BYTES + 1), &home).is_err());
        // Removal: its own only, in Echo's words when it isn't (`/isn't a skill .* added/`).
        let e = remove(&env.services, &p, "mine", &home).unwrap_err();
        assert!(e.message.contains("isn't a skill kn added"), "{e}");
        assert!(home.join(".claude/skills/mine").exists());
        remove(&env.services, &p, "twin-me", &home).unwrap();
        assert!(!home.join(".claude/skills/twin-me").exists());
        let e = remove(&env.services, &p, "twin-me", &home).unwrap_err();
        assert!(e.message.contains("isn't a skill kn added"), "{e}");
        // Gone meanwhile (the user removed it): forgotten, said the same way.
        install(&env.services, &p, "twin-me", TWIN, &home).unwrap();
        std::fs::remove_dir_all(home.join(".claude/skills/twin-me")).unwrap();
        let e = remove(&env.services, &p, "twin-me", &home).unwrap_err();
        assert!(e.message.contains("isn't a skill kn added"), "{e}");
        assert!(owned(&env.services, "kn").is_empty());
    }
}
