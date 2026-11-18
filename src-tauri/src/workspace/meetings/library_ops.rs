//! What notes are made with (Settings › Meetings): note templates (`template_save`,
//! `template_delete`), automatic rules (`meeting_rule_save`, `meeting_rule_delete`,
//! `meeting_rule_order`), the glossary and the tag list (`meeting_text_save`, and the
//! read-only `meeting_text`), and the skills on this Mac (read-only `meeting_skills`).
use super::folder;
use super::glossary::{self, Text, TEXT_MAX};
use super::notes_ops::{local_rule, local_template};
use super::rules::{self, Rule, FIELDS, VALUE_MAX};
use super::templates::{self, built_in, Template, DEFAULT_ID};
use crate::workspace::{models::*, Core};
use serde_json::{json, Value};
use std::path::Path;

const NAME_MAX: usize = 80;
const BLURB_MAX: usize = 300;
const PROMPT_MAX: usize = 50_000;
const SECTIONS_MAX: usize = 20;
const PATH_MAX: usize = 1024;
/// A skill's `SKILL.md` is read for its name and description up to this size.
const SKILL_HEAD: u64 = 16 * 1024;

fn invalid(field: &str, message: &str) -> WorkspaceError {
    let mut e = WorkspaceError::new("validation", message);
    e.field = Some(field.into());
    e
}

/// An id a person's template or rule may have: letters, digits and `-_.:`, up to 100.
fn valid_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= 100
        && id
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.' | ':'))
}

/// The id a save is about: the one given (checked), or a new one from the operation.
fn given_id(req: &Request, message: &str) -> Result<(String, bool)> {
    match &req.data["id"] {
        Value::Null => Ok((req.operation_id.clone().unwrap_or_else(id), false)),
        v => v
            .as_str()
            .filter(|id| valid_id(id))
            .map(|id| (id.to_string(), true))
            .ok_or_else(|| invalid("id", message)),
    }
}

/// Text of at most `max` characters, trimmed (no NUL).
fn text_field(data: &Value, key: &str, max: usize, message: &str) -> Result<Option<String>> {
    match data.get(key) {
        None => Ok(None),
        Some(Value::Null) => Ok(Some(String::new())),
        Some(v) => v
            .as_str()
            .map(str::trim)
            .filter(|s| s.chars().count() <= max && !s.contains('\0'))
            .map(|s| Some(s.to_string()))
            .ok_or_else(|| invalid(key, message)),
    }
}

fn bool_field(data: &Value, key: &str, message: &str) -> Result<Option<bool>> {
    match data.get(key) {
        None => Ok(None),
        Some(v) => v.as_bool().map(Some).ok_or_else(|| invalid(key, message)),
    }
}

/// `name: value` lines of a `SKILL.md`'s front matter, and the first line of text after it.
fn skill_head(text: &str) -> (Option<String>, Option<String>, Option<String>) {
    let mut lines = text.lines();
    let mut name = None;
    let mut description = None;
    let mut rest: Vec<&str> = Vec::new();
    if text.trim_start().starts_with("---") {
        lines.next();
        let mut folded: Option<String> = None;
        for line in lines.by_ref() {
            if line.trim() == "---" {
                break;
            }
            if let Some(acc) = folded.as_mut() {
                if line.starts_with([' ', '\t']) {
                    acc.push(' ');
                    acc.push_str(line.trim());
                    continue;
                }
                description = Some(acc.trim().to_string()).filter(|d| !d.is_empty());
                folded = None;
            }
            let Some((key, value)) = line.split_once(':') else {
                continue;
            };
            let value = value.trim().trim_matches(['"', '\'']).to_string();
            match key.trim() {
                "name" => name = Some(value).filter(|v| !v.is_empty()),
                "description" if matches!(value.as_str(), "" | ">" | "|" | ">-" | "|-") => {
                    folded = Some(String::new())
                }
                "description" => description = Some(value),
                _ => {}
            }
        }
        if let Some(acc) = folded {
            description = Some(acc.trim().to_string()).filter(|d| !d.is_empty());
        }
    }
    rest.extend(lines);
    let first = rest
        .iter()
        .map(|l| l.trim())
        .find(|l| !l.is_empty() && !l.starts_with('#'))
        .map(String::from);
    (name, description, first)
}

impl Core {
    /// `template_save`, `template_delete`, `meeting_rule_save`, `meeting_rule_delete`,
    /// `meeting_rule_order`, `meeting_text_save`.
    pub(in crate::workspace) fn library_op(&self, req: &Request) -> Result<Value> {
        let (w, _) = self.active_workspace(req, false)?;
        match req.op {
            Operation::TemplateSave => self.template_save(req, &w.id),
            Operation::TemplateDelete => self.template_delete(req, &w.id),
            Operation::MeetingRuleSave => self.rule_save(req, &w.id),
            Operation::MeetingRuleDelete => self.rule_delete(req, &w.id),
            Operation::MeetingRuleOrder => self.rule_order(req, &w.id),
            Operation::MeetingTextSave => self.text_save(req),
            _ => Err(WorkspaceError::new("validation", "Unsupported operation.")),
        }
    }

    /// `template_save {id?, name, kind?, blurb, prompt, sections, extractTasks, color, icon,
    /// skillPath}`: a new template (`custom`, or `skill` with its `SKILL.md`), a change to one,
    /// or to a built-in (which then says Edited). Fields left out stay as they are.
    fn template_save(&self, req: &Request, wid: &str) -> Result<Value> {
        let (tid, given) = given_id(req, "Choose a template.")?;
        let mut r = self.repo()?;
        let stored = given
            .then(|| r.record(templates::KIND, &tid, None, Some(wid)).ok())
            .flatten()
            .and_then(|rec| templates::from_record(&rec));
        let mut t = match (stored, built_in(&tid)) {
            (Some(t), _) => t,
            (None, Some(original)) => original,
            (None, None) => {
                let kind = match req.data["kind"].as_str() {
                    None | Some("custom") => "custom",
                    Some("skill") => "skill",
                    Some(_) => return Err(invalid("kind", "Choose your own template or a skill.")),
                };
                Template {
                    id: tid.clone(),
                    kind: kind.into(),
                    color: if kind == "skill" {
                        "#7B3FBF"
                    } else {
                        "#2297F6"
                    }
                    .into(),
                    icon: if kind == "skill" { "shield" } else { "note" }.into(),
                    ..Default::default()
                }
            }
        };
        let d = &req.data;
        if let Some(name) = text_field(
            d,
            "name",
            NAME_MAX,
            "Name the template (up to 80 characters).",
        )? {
            t.name = name;
        }
        if t.name.is_empty() {
            return Err(invalid("name", "Name the template (up to 80 characters)."));
        }
        if let Some(blurb) = text_field(
            d,
            "blurb",
            BLURB_MAX,
            "Keep the description to 300 characters.",
        )? {
            t.blurb = blurb;
        }
        if let Some(prompt) = text_field(
            d,
            "prompt",
            PROMPT_MAX,
            "Keep the instructions to 50,000 characters.",
        )? {
            t.prompt = prompt;
        }
        if let Some(v) = d.get("sections") {
            let message = "Choose the template’s sections.";
            let list = v.as_array().ok_or_else(|| invalid("sections", message))?;
            let mut sections: Vec<String> = Vec::new();
            for s in list {
                let s = s
                    .as_str()
                    .filter(|s| {
                        (1..=40).contains(&s.len())
                            && s.starts_with(|c: char| c.is_ascii_alphabetic())
                            && s.chars().all(|c| c.is_ascii_alphanumeric())
                    })
                    .ok_or_else(|| invalid("sections", message))?;
                if !sections.iter().any(|x| x == s) {
                    sections.push(s.into());
                }
            }
            if sections.len() > SECTIONS_MAX {
                return Err(invalid("sections", message));
            }
            t.sections = sections;
        }
        if let Some(on) = bool_field(d, "extractTasks", "Choose whether runs find tasks.")? {
            t.extract_tasks = on;
        }
        if let Some(color) = text_field(d, "color", 7, "Choose a colour.")? {
            let ok = color.len() == 7
                && color.starts_with('#')
                && color[1..].chars().all(|c| c.is_ascii_hexdigit());
            if !ok {
                return Err(invalid("color", "Choose a colour."));
            }
            t.color = color;
        }
        if let Some(icon) = text_field(d, "icon", 30, "Choose an icon.")? {
            if icon.is_empty()
                || !icon
                    .chars()
                    .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-')
            {
                return Err(invalid("icon", "Choose an icon."));
            }
            t.icon = icon;
        }
        if t.kind == "skill" {
            let message = "Choose the skill’s SKILL.md by its full path.";
            if let Some(path) = text_field(d, "skillPath", PATH_MAX, message)? {
                let ok = Path::new(&path).is_absolute()
                    && path.to_lowercase().ends_with(".md")
                    && (t.skill_path.as_deref() == Some(path.as_str())
                        || Path::new(&path).is_file());
                if !ok {
                    return Err(invalid("skillPath", message));
                }
                t.skill_path = Some(path);
            }
            if t.skill_path.as_deref().is_none_or(str::is_empty) {
                return Err(invalid("skillPath", message));
            }
        } else {
            t.skill_path = None;
            if t.prompt.is_empty() {
                return Err(invalid("prompt", "Write the template’s instructions."));
            }
        }
        r.put_record(&local_template(wid, &t))?;
        Ok(json!({"id": t.id}))
    }

    /// `template_delete {id}`: a template of your own or a skill is deleted (its rules switch to
    /// the default template, which is Meeting notes again if it was the default); a built-in is
    /// reset to the original (`reset`). Notes already written stay.
    fn template_delete(&self, req: &Request, wid: &str) -> Result<Value> {
        let tid = required(&req.data, "id", 200)?.to_string();
        let mut r = self.repo()?;
        if built_in(&tid).is_some() {
            r.delete_local(templates::KIND, &tid, wid)?;
            return Ok(json!({"reset": true, "id": tid}));
        }
        r.record(templates::KIND, &tid, None, Some(wid))
            .map_err(|_| WorkspaceError::new("not_found", "This template is no longer there."))?;
        let mut settings = r.settings()?;
        if settings.meetings.default_template == tid {
            settings.meetings.default_template = DEFAULT_ID.into();
            r.settings_update(&settings)?;
        }
        let fallback = settings.meetings.default_template.clone();
        for rec in r.local_records(wid, rules::KIND)? {
            if let Some(mut rule) = rules::from_record(&rec).filter(|rule| rule.template == tid) {
                rule.template = fallback.clone();
                r.put_record(&local_rule(wid, &rule)?)?;
            }
        }
        r.delete_local(templates::KIND, &tid, wid)?;
        Ok(json!({"deleted": true, "id": tid}))
    }

    /// `meeting_rule_save {id?, field, value, template, autoNotes?, on?, order?}`: a new rule
    /// goes last; a change keeps the rule's place unless `order` is given (Undo of a delete).
    fn rule_save(&self, req: &Request, wid: &str) -> Result<Value> {
        let (rid, _) = given_id(req, "Choose a rule.")?;
        let mut r = self.repo()?;
        let others: Vec<Rule> = r
            .local_records(wid, rules::KIND)?
            .iter()
            .filter_map(rules::from_record)
            .collect();
        let existing = others.iter().find(|x| x.id == rid).cloned();
        let creating = existing.is_none();
        let mut rule = existing.unwrap_or_else(|| Rule {
            id: rid.clone(),
            order: others.iter().map(|x| x.order + 1).max().unwrap_or(0),
            ..Default::default()
        });
        let d = &req.data;
        if let Some(field) = text_field(d, "field", 20, "Choose what the rule looks at.")? {
            if !FIELDS.contains(&field.as_str()) {
                return Err(invalid("field", "Choose what the rule looks at."));
            }
            rule.field = field;
        }
        if let Some(value) = text_field(
            d,
            "value",
            VALUE_MAX,
            "Keep the rule’s text to 200 characters.",
        )? {
            rule.value = value;
        }
        if let Some(template) = text_field(d, "template", 200, "Choose a note template.")? {
            rule.template = template;
        }
        let all = templates::all(&r.local_records(wid, templates::KIND)?);
        if (creating || d.get("template").is_some())
            && templates::find(&all, &rule.template).is_none()
        {
            return Err(invalid("template", "Choose a note template."));
        }
        if let Some(on) = bool_field(
            d,
            "autoNotes",
            "Choose whether the rule makes notes by itself.",
        )? {
            rule.auto_notes = on;
        }
        if let Some(on) = bool_field(d, "on", "Turn the rule on or off.")? {
            rule.on = on;
        }
        if let Some(v) = d.get("order") {
            rule.order = v
                .as_i64()
                .ok_or_else(|| invalid("order", "Place the rule in the list."))?;
        }
        r.put_record(&local_rule(wid, &rule)?)?;
        Ok(json!({"id": rule.id}))
    }

    /// `meeting_rule_delete {id}`: answers with the rule's body, so Undo can save it back.
    fn rule_delete(&self, req: &Request, wid: &str) -> Result<Value> {
        let rid = required(&req.data, "id", 200)?.to_string();
        let mut r = self.repo()?;
        let rec = r
            .record(rules::KIND, &rid, None, Some(wid))
            .map_err(|_| WorkspaceError::new("not_found", "This rule is no longer there."))?;
        r.delete_local(rules::KIND, &rid, wid)?;
        Ok(json!({"deleted": true, "id": rid, "body": rec.data}))
    }

    /// `meeting_rule_order {ids}`: the rules in this order; any left out follow, as they were.
    fn rule_order(&self, req: &Request, wid: &str) -> Result<Value> {
        let message = "Choose the rules’ order.";
        let ids: Vec<&str> = req.data["ids"]
            .as_array()
            .ok_or_else(|| invalid("ids", message))?
            .iter()
            .map(|v| v.as_str().ok_or_else(|| invalid("ids", message)))
            .collect::<Result<_>>()?;
        let mut r = self.repo()?;
        let mut all: Vec<Rule> = r
            .local_records(wid, rules::KIND)?
            .iter()
            .filter_map(rules::from_record)
            .collect();
        if ids.iter().any(|id| !all.iter().any(|rule| rule.id == *id)) {
            return Err(WorkspaceError::new(
                "not_found",
                "A rule is no longer there.",
            ));
        }
        all.sort_by(|a, b| a.order.cmp(&b.order).then_with(|| a.id.cmp(&b.id)));
        let rank = |rule: &Rule| {
            ids.iter()
                .position(|id| *id == rule.id)
                .unwrap_or(ids.len())
        };
        all.sort_by_key(|rule| rank(rule));
        for (i, mut rule) in all.into_iter().enumerate() {
            if rule.order != i as i64 {
                rule.order = i as i64;
                r.put_record(&local_rule(wid, &rule)?)?;
            }
        }
        Ok(json!({"saved": true}))
    }

    /// `meeting_text_save {name: "glossary"|"tags", text}`: writes `glossary.md` or `tags.md` in
    /// the meetings root. Linked files the person keeps elsewhere are only read.
    fn text_save(&self, req: &Request) -> Result<Value> {
        let which = Text::parse(req.data["name"].as_str().unwrap_or(""))
            .ok_or_else(|| invalid("name", "Choose the glossary or the tag list."))?;
        let text = req.data["text"]
            .as_str()
            .filter(|t| !t.contains('\0'))
            .ok_or_else(|| invalid("text", "Write the text."))?;
        if text.len() > TEXT_MAX {
            return Err(WorkspaceError::new(
                "too_large",
                "Keep the glossary and the tag list to 100 KB each.",
            ));
        }
        let s = self.repo()?.settings()?.meetings;
        let (root, is_default) = self.meetings_root(&s)?;
        let (path, linked) = glossary::text_path(&root, &s, which);
        if linked {
            return Err(invalid(
                "name",
                "This is a file you keep elsewhere. Edit it there, or keep the glossary and tags here in Connect.",
            ));
        }
        let path = path.ok_or_else(|| folder::unwritable(&root))?;
        // The default folder is made on first use; a chosen one that is gone is chosen again.
        let there = root.is_dir() || is_default && std::fs::create_dir_all(&root).is_ok();
        if !there {
            return Err(folder::unwritable(&root));
        }
        folder::write_file(&path, text.as_bytes()).map_err(|_| folder::unwritable(&root))?;
        Ok(json!({"saved": true, "path": path.to_string_lossy()}))
    }

    /// `meeting_text {name}`: the glossary or the tag list (`{text, path, linked}`); empty when
    /// there is none yet. Read-only.
    pub(in crate::workspace) fn meeting_text(&self, req: &Request) -> Result<Value> {
        let which = Text::parse(req.data["name"].as_str().unwrap_or(""))
            .ok_or_else(|| invalid("name", "Choose the glossary or the tag list."))?;
        let s = self.repo()?.settings()?.meetings;
        let (path, linked) = match self.meetings_root(&s) {
            Ok((root, _)) => glossary::text_path(&root, &s, which),
            Err(_) => (None, s.glossary_source == "file"),
        };
        let (text, _) = glossary::read_text(path.as_deref());
        Ok(
            json!({"text": text, "path": path.map(|p| p.to_string_lossy().into_owned()), "linked": linked}),
        )
    }

    /// `meeting_skills`: the Claude Code skills in `~/.claude/skills/*/SKILL.md`, by name, with
    /// their description. Read-only.
    pub(in crate::workspace) fn meeting_skills(&self) -> Result<Value> {
        use std::io::Read;
        let Some(home) = self.home.as_deref() else {
            return Ok(json!([]));
        };
        let Ok(entries) = std::fs::read_dir(home.join(".claude").join("skills")) else {
            return Ok(json!([]));
        };
        let mut skills: Vec<Value> = entries
            .flatten()
            .filter_map(|entry| {
                let path = entry.path().join("SKILL.md");
                let mut head = Vec::new();
                std::fs::File::open(&path)
                    .ok()?
                    .take(SKILL_HEAD)
                    .read_to_end(&mut head)
                    .ok()?;
                let text = String::from_utf8_lossy(&head);
                let (name, description, first) = skill_head(&text);
                let name = name.unwrap_or_else(|| entry.file_name().to_string_lossy().into_owned());
                let description: String = description
                    .or(first)
                    .unwrap_or_default()
                    .chars()
                    .take(300)
                    .collect();
                Some(json!({"name": name, "path": path.to_string_lossy(), "description": description}))
            })
            .collect();
        skills.sort_by(|a, b| {
            a["name"]
                .as_str()
                .unwrap_or("")
                .to_lowercase()
                .cmp(&b["name"].as_str().unwrap_or("").to_lowercase())
        });
        Ok(Value::Array(skills))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn skill_md_names_and_describes_itself() {
        assert_eq!(
            skill_head("---\nname: interview-review\ndescription: \"Assess an interview.\"\n---\n# Title\nBody"),
            (Some("interview-review".into()), Some("Assess an interview.".into()), Some("Body".into()))
        );
        assert_eq!(
            skill_head("---\nname: x\ndescription: >\n  Folded over\n  two lines.\nallowed-tools: Read\n---\nText"),
            (Some("x".into()), Some("Folded over two lines.".into()), Some("Text".into()))
        );
        assert_eq!(
            skill_head("# Only a title\n\nFirst line."),
            (None, None, Some("First line.".into()))
        );
        assert!(valid_id("custom-1") && valid_id("a1b2:c.d_e"));
        assert!(
            !valid_id("") && !valid_id("a b") && !valid_id("../x") && !valid_id(&"x".repeat(101))
        );
    }
}
