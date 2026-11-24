//! Note templates (spec "Templates"): the instructions the AI follows to turn a transcript into
//! notes. Three are built in (*Meeting notes*, the default, *Short summary* and *Formal
//! summary*, made by the Formal summary automation); the person adds their own (`custom`) and
//! Claude Code skills (`skill`, whose `SKILL.md` is read at every run).
//!
//! A template the person saved is a local record of kind [`KIND`] in the active workspace. A
//! record with a built-in's id overrides that built-in (*Edited*); deleting it is *Reset to
//! built-in*.
use super::model::{MeetingRecord, MeetingSettings};
use super::rules::{self, Rule};
use crate::workspace::models::*;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

/// The local record kind of a template.
pub const KIND: &str = "note_template";
/// The default template, and the one used when the chosen default is gone.
pub const DEFAULT_ID: &str = "meeting-notes";

/// A template written into Connect.
pub struct BuiltIn {
    pub id: &'static str,
    pub name: &'static str,
    pub blurb: &'static str,
    pub prompt: &'static str,
    pub sections: &'static [&'static str],
    pub color: &'static str,
    pub icon: &'static str,
}

/// *Meeting notes*, adapted from the `meeting-note-writer` agent (the prototype's
/// `NOTES_PROMPT`, verbatim).
const NOTES_PROMPT: &str = r##"You turn one meeting transcript into meeting notes for {{me}}. Nobody answers questions during your run — put doubts in Transcript Notes.

Meeting: {{title}} · {{date}}
Participants: {{participants}}
Extra wishes for this run: {{wishes}}

THE NOTE IS KNOWLEDGE, NOT MINUTES
Write what a reader needs to know afterwards, not what happened in what order.
- Organize by topic. A thread that recurs across the meeting becomes one topic.
- Each bullet is a standalone statement — a claim, definition, number, example, decision or argument — that still makes sense when read alone months later. Name the subject instead of writing "it" or "this".
- Keep the reasoning: why a decision or position holds, and what it was weighed against.
- Attribute positions to people (**Name:**) and keep disagreements visible.
- {{me}}'s statements matter most; capture them precisely.
- Speech-to-text garbles names and terms. Spell them as the glossary does; whatever stays uncertain goes to Transcript Notes.

Density over coverage: one bullet per distinct fact, argument, decision or number; repeated points merged; greetings, logistics and scheduling chatter left out. A short meeting makes a short note.

SECTIONS — keep this order. Sections marked "if" appear only when the condition holds.
---
title, date, participants, tags, summary (two sentences: who met and why, and what came out of it)
---
## TL;DR — 3–5 bullets: decisions, shifts in thinking, the most reusable insights
## Context — 2–4 sentences: why this meeting happened, who was there in what role, what was at stake
## Knowledge — 3–8 topics as noun phrases, each with standalone bullets
## Decisions — if any: <decision> — <why>
## Plan — if a plan or sequence of steps was discussed: <step> — <owner> — <timing or "timing open">
## Action Items — if concrete next steps exist
## Open Questions — if anything was left unresolved: <question> — <why it is open, who holds it>
## Transcript Notes — if a term or name stayed uncertain: "<as heard>" → <best reading> (unverified)

TAGS: only from the tag list, "meeting" first. When no tag fits a topic, use fewer tags and name the missing one in Transcript Notes.

TASKS (returned as JSON next to the note)
- One row per task, written as an imperative, self-contained action.
- Owner is one attendee's full name. A collective "we" becomes {{me}}.
- Due is a date only when one was stated or follows unambiguously from the meeting date ("by Friday"); otherwise empty.
- Quote the transcript line the task comes from.

Glossary:
{{glossary}}

Tag list:
{{tags}}

Transcript:
{{transcript}}"##;

/// *Short summary* (the prototype's `BRIEF_PROMPT`, verbatim).
const BRIEF_PROMPT: &str = r##"Write a short summary of "{{title}}" ({{date}}) that {{me}} can paste into a chat.

## Summary — two sentences: who met, why, and what came out of it
## Decisions — if any: <decision> — <why>, one line each
## Action items — owner · action · due date only when someone said one

Same rules as Meeting notes: name the subject, attribute positions, spell names and terms as the glossary does, "we" becomes {{me}}. Leave out everything else. Wishes: {{wishes}}

Glossary:
{{glossary}}

Transcript:
{{transcript}}"##;

/// *Formal summary* (spec step 5 §6): what the Formal summary automation makes for each
/// meeting, always in English and neutral about people, on the existing note-template engine.
const FORMAL_PROMPT: &str = r##"Write a summary of "{{title}}" ({{date}}) that {{me}} can send to the attendees. Always write in English, whatever language the meeting was held in. Be neutral: report positions and decisions, not opinions of the people who hold them.

# {{title}} — {{date}}
Attendees: {{participants}}

## Summary — two or three sentences: who met, why, and what came out of it
## Discussion — by topic, each a short paragraph or a few bullets
## Decisions — if any: <decision> — <why>
## Action items — owner · action · due date only when someone said one

Name the subject instead of "it" or "this". Spell names and terms as the glossary does. A collective "we" becomes {{me}}. Extra wishes for this run: {{wishes}}

Glossary:
{{glossary}}

Transcript:
{{transcript}}"##;

/// The built-in templates, the default first.
pub const BUILT_INS: [BuiltIn; 3] = [
    BuiltIn {
        id: DEFAULT_ID,
        name: "Meeting notes",
        blurb: "Your reference format: organized by topic, decisions keep their “why”, every task has one owner. Still makes sense months later.",
        prompt: NOTES_PROMPT,
        sections: &[
            "frontmatter",
            "tldr",
            "context",
            "knowledge",
            "decisions",
            "plan",
            "actions",
            "questions",
            "transcriptNotes",
        ],
        color: "#5677C8",
        icon: "note",
    },
    BuiltIn {
        id: "short-summary",
        name: "Short summary",
        blurb: "A recap you can paste into chat: two sentences, the decisions, who does what by when.",
        prompt: BRIEF_PROMPT,
        sections: &["summary", "decisions", "actions"],
        color: "#259F4C",
        icon: "list",
    },
    BuiltIn {
        id: "formal-summary",
        name: "Formal summary",
        blurb: "A summary you can send to the attendees: in English, the real title and people, what was discussed, decided and who does what by when.",
        prompt: FORMAL_PROMPT,
        sections: &["summary", "attendees", "discussion", "decisions", "actions"],
        color: "#8A5CC2",
        icon: "list",
    },
];

/// A template as notes use it and the snapshot shows it (`noteTemplates`): a built-in (with
/// the person's changes, `edited`), the person's own, or a skill.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Template {
    pub id: String,
    pub name: String,
    /// `builtin`, `custom` or `skill`.
    pub kind: String,
    pub blurb: String,
    /// The instructions with `{{variables}}`; empty for a skill, whose `SKILL.md` is read at
    /// every run.
    pub prompt: String,
    pub sections: Vec<String>,
    /// Whether runs with this template find tasks.
    pub extract_tasks: bool,
    pub color: String,
    pub icon: String,
    /// A skill's `SKILL.md` (absolute path).
    pub skill_path: Option<String>,
    /// A built-in the person changed.
    pub edited: bool,
}

impl Default for Template {
    fn default() -> Self {
        Self {
            id: String::new(),
            name: String::new(),
            kind: "custom".into(),
            blurb: String::new(),
            prompt: String::new(),
            sections: Vec::new(),
            extract_tasks: true,
            color: "#2297F6".into(),
            icon: "note".into(),
            skill_path: None,
            edited: false,
        }
    }
}

impl BuiltIn {
    pub fn template(&self) -> Template {
        Template {
            id: self.id.into(),
            name: self.name.into(),
            kind: "builtin".into(),
            blurb: self.blurb.into(),
            prompt: self.prompt.into(),
            sections: self.sections.iter().map(|s| s.to_string()).collect(),
            extract_tasks: true,
            color: self.color.into(),
            icon: self.icon.into(),
            skill_path: None,
            edited: false,
        }
    }
}

/// The built-in with this id.
pub fn built_in(id: &str) -> Option<Template> {
    BUILT_INS.iter().find(|b| b.id == id).map(BuiltIn::template)
}

impl Template {
    /// The record body: what the person chose, without `id` and `edited`.
    pub fn body(&self) -> Value {
        json!({"name": self.name, "kind": self.kind, "blurb": self.blurb, "prompt": self.prompt,
            "sections": self.sections, "extractTasks": self.extract_tasks, "color": self.color,
            "icon": self.icon, "skillPath": self.skill_path})
    }
}

/// A template from its record: an override of a built-in stays `builtin` and is `edited`.
pub fn from_record(record: &Record) -> Option<Template> {
    let mut t: Template = serde_json::from_value(record.data.clone()).ok()?;
    t.id = record.id.clone();
    t.edited = false;
    if built_in(&record.id).is_some() {
        t.kind = "builtin".into();
        t.skill_path = None;
        t.edited = true;
    } else if t.kind != "skill" {
        t.kind = "custom".into();
    }
    Some(t)
}

/// Every template: the built-ins (or their overrides) first, then the person's own and their
/// skills by name. `records` may hold any records; only templates are read.
pub fn all(records: &[Record]) -> Vec<Template> {
    let saved: Vec<Template> = records
        .iter()
        .filter(|r| r.kind == KIND && r.connection_id.is_none())
        .filter_map(from_record)
        .collect();
    let mut out: Vec<Template> = BUILT_INS
        .iter()
        .map(|b| {
            saved
                .iter()
                .find(|t| t.id == b.id)
                .cloned()
                .unwrap_or_else(|| b.template())
        })
        .collect();
    let mut own: Vec<Template> = saved
        .into_iter()
        .filter(|t| built_in(&t.id).is_none())
        .collect();
    own.sort_by(|a, b| {
        a.name
            .to_lowercase()
            .cmp(&b.name.to_lowercase())
            .then_with(|| a.id.cmp(&b.id))
    });
    out.extend(own);
    out
}

/// The template with this id.
pub fn find<'a>(all: &'a [Template], id: &str) -> Option<&'a Template> {
    all.iter().find(|t| t.id == id)
}

/// Why a meeting uses its template.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Why {
    /// Chosen for this meeting.
    Meeting,
    /// The first matching automatic rule (its id).
    Rule(String),
    /// The default template.
    Default,
}

impl Why {
    /// `{"why": "meeting" | "rule" | "default", "rule": id | null}`.
    pub fn to_json(&self) -> Value {
        match self {
            Self::Meeting => json!({"why": "meeting", "rule": null}),
            Self::Rule(id) => json!({"why": "rule", "rule": id}),
            Self::Default => json!({"why": "default", "rule": null}),
        }
    }
}

/// The template a meeting uses, and why: the one chosen for it, else the first matching rule's
/// (when that template still exists), else the default (Meeting notes when the default is gone).
pub fn resolve(
    meeting: &MeetingRecord,
    event: &Value,
    rules: &[Rule],
    settings: &MeetingSettings,
    all: &[Template],
) -> (Template, Why) {
    if let Some(t) = meeting.template.as_deref().and_then(|id| find(all, id)) {
        return (t.clone(), Why::Meeting);
    }
    if let Some(rule) = rules::first(rules, event) {
        if let Some(t) = find(all, &rule.template) {
            return (t.clone(), Why::Rule(rule.id.clone()));
        }
    }
    let t = find(all, &settings.default_template)
        .or_else(|| find(all, DEFAULT_ID))
        .cloned()
        .or_else(|| built_in(DEFAULT_ID))
        .unwrap_or_default();
    (t, Why::Default)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn record(id: &str, data: Value) -> Record {
        Record {
            id: id.into(),
            kind: KIND.into(),
            connection_id: None,
            workspace_id: Some("personal".into()),
            source: "local".into(),
            revision: "v".into(),
            updated_at: 0,
            data,
        }
    }

    fn rule(id: &str, value: &str, template: &str, order: i64) -> Rule {
        Rule {
            id: id.into(),
            field: "title".into(),
            value: value.into(),
            template: template.into(),
            order,
            ..Default::default()
        }
    }

    #[test]
    fn built_ins_port_the_prototype_prompts() {
        let notes = built_in("meeting-notes").unwrap();
        assert_eq!(notes.name, "Meeting notes");
        assert_eq!(notes.kind, "builtin");
        assert_eq!(
            notes.sections,
            vec![
                "frontmatter",
                "tldr",
                "context",
                "knowledge",
                "decisions",
                "plan",
                "actions",
                "questions",
                "transcriptNotes"
            ]
        );
        assert!(notes
            .prompt
            .starts_with("You turn one meeting transcript into meeting notes for {{me}}."));
        assert!(notes.prompt.contains("THE NOTE IS KNOWLEDGE, NOT MINUTES"));
        assert!(notes.prompt.ends_with("Transcript:\n{{transcript}}"));
        let brief = built_in("short-summary").unwrap();
        assert_eq!(brief.name, "Short summary");
        assert_eq!(brief.sections, vec!["summary", "decisions", "actions"]);
        assert!(brief
            .prompt
            .starts_with("Write a short summary of \"{{title}}\" ({{date}})"));
        assert!(built_in("notes").is_none());
        for b in &BUILT_INS {
            for var in [
                "{{title}}",
                "{{date}}",
                "{{me}}",
                "{{glossary}}",
                "{{wishes}}",
                "{{transcript}}",
            ] {
                assert!(b.prompt.contains(var), "{} lacks {var}", b.id);
            }
        }
    }

    #[test]
    fn formal_summary_is_a_built_in() {
        let plain = all(&[]);
        assert_eq!(plain.len(), 3);
        assert_eq!(plain[2].id, "formal-summary");
        let formal = built_in("formal-summary").unwrap();
        assert_eq!(formal.name, "Formal summary");
        assert_eq!(
            formal.sections,
            vec!["summary", "attendees", "discussion", "decisions", "actions"]
        );
        for needle in ["{{participants}}", "English", "{{transcript}}"] {
            assert!(formal.prompt.contains(needle), "lacks {needle}");
        }
    }

    #[test]
    fn resolve_prefers_meeting_choice_then_rule_then_default() {
        let records = vec![record(
            "client",
            json!({"name": "My client recap", "kind": "custom", "prompt": "Recap {{title}}"}),
        )];
        let all = all(&records);
        let event = json!({"title": "Philips stand-up"});
        let rules = vec![
            rule("r-brief", "stand-up", "short-summary", 1),
            rule("r-client", "philips", "client", 2),
        ];
        let s = MeetingSettings::default();
        let mut m = MeetingRecord {
            template: Some("client".into()),
            ..Default::default()
        };
        // Chosen for this meeting.
        let (t, why) = resolve(&m, &event, &rules, &s, &all);
        assert_eq!((t.id.as_str(), why), ("client", Why::Meeting));
        // A meeting choice that no longer exists falls through to the rules.
        m.template = Some("deleted".into());
        let (t, why) = resolve(&m, &event, &rules, &s, &all);
        assert_eq!(
            (t.id.as_str(), why),
            ("short-summary", Why::Rule("r-brief".into()))
        );
        // No rule matches: the default.
        m.template = None;
        let (t, why) = resolve(&m, &json!({"title": "Lunch"}), &rules, &s, &all);
        assert_eq!((t.id.as_str(), why), ("meeting-notes", Why::Default));
        let chosen = MeetingSettings {
            default_template: "client".into(),
            ..Default::default()
        };
        let (t, why) = resolve(&m, &json!({"title": "Lunch"}), &rules, &chosen, &all);
        assert_eq!((t.id.as_str(), why), ("client", Why::Default));
        // The first matching rule's template is gone: the default, not the next rule.
        let gone = vec![
            rule("r-gone", "philips", "deleted", 0),
            rule("r-brief", "stand-up", "short-summary", 1),
        ];
        let (t, why) = resolve(&m, &event, &gone, &s, &all);
        assert_eq!((t.id.as_str(), why), ("meeting-notes", Why::Default));
        // A default that is gone is Meeting notes.
        let lost = MeetingSettings {
            default_template: "deleted".into(),
            ..Default::default()
        };
        let (t, _) = resolve(&m, &json!({"title": "Lunch"}), &rules, &lost, &all);
        assert_eq!(t.id, "meeting-notes");
        assert_eq!(
            Why::Rule("r".into()).to_json(),
            json!({"why": "rule", "rule": "r"})
        );
    }

    #[test]
    fn built_in_override_and_reset() {
        let original = built_in("meeting-notes").unwrap();
        // No records: the three built-ins, unedited.
        let plain = all(&[]);
        assert_eq!(
            plain.iter().map(|t| t.id.as_str()).collect::<Vec<_>>(),
            vec!["meeting-notes", "short-summary", "formal-summary"]
        );
        assert!(!plain[0].edited);
        assert_eq!(plain[0], original);
        // An override keeps the built-in's id and kind and is edited.
        let mut changed = original.clone();
        changed.prompt = "Only decisions, please.".into();
        changed.kind = "skill".into();
        changed.skill_path = Some("/x/SKILL.md".into());
        let records = vec![
            record(
                "zz-skill",
                json!({"name": "Interview assessment", "kind": "skill", "skillPath": "/Users/taylor/.claude/skills/interview-review/SKILL.md", "extractTasks": false}),
            ),
            record("meeting-notes", changed.body()),
            record(
                "aa-mine",
                json!({"name": "a recap", "kind": "builtin", "prompt": "x"}),
            ),
            Record {
                kind: "note".into(),
                ..record("not-a-template", json!({"text": "x"}))
            },
            record("broken", json!("not an object")),
        ];
        let edited = all(&records);
        assert_eq!(
            edited.iter().map(|t| t.id.as_str()).collect::<Vec<_>>(),
            vec![
                "meeting-notes",
                "short-summary",
                "formal-summary",
                "aa-mine",
                "zz-skill"
            ]
        );
        assert_eq!(edited[0].prompt, "Only decisions, please.");
        assert_eq!(edited[0].kind, "builtin");
        assert_eq!(edited[0].skill_path, None);
        assert!(edited[0].edited);
        assert!(!edited[1].edited);
        // Only a built-in's id makes a built-in.
        assert_eq!(edited[3].kind, "custom");
        assert_eq!(edited[4].kind, "skill");
        assert!(!edited[4].extract_tasks);
        // Reset to built-in: the override record is gone, the original is back.
        let reset = all(&records[..1]);
        assert_eq!(reset[0], original);
    }
}
