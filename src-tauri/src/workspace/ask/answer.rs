//! Ask's answer, checked before a turn keeps it (ask-capture design § 4, ruling 11): only cites
//! and actions the turn's context holds survive. Pure: the run's structured answer and the
//! context's `refs` and `facts` in, the kept answer and what was dropped out (counted, never
//! named, so a log can say how many). Nothing here runs an action: an action is a proposal the
//! window performs only on a click (ruling 12).
use super::context::cut_at_line_end;
use super::store::{Cite, RefItem};
use crate::workspace::prompts::{cap_chars, clean_output};
use crate::workspace::tasks::valid_due;
use serde::Serialize;
use serde_json::{json, Value};
use std::collections::{BTreeMap, BTreeSet};

/// Characters of an answer kept; a longer one is cut at a line end with "…".
pub const ANSWER_MAX: usize = 6_000;
/// Actions kept at most.
pub const ACTIONS_MAX: usize = 3;
/// A task action's text: 1 to this many characters, else the action is dropped.
pub const TASK_TEXT_MAX: usize = 2_000;
/// A draft action's hint is cut to this many characters.
pub const HINT_MAX: usize = 200;
/// The kinds an `open` action may point at: the ones a cite chip links to (design § 8).
const OPENABLE: [&str; 4] = ["message", "meeting", "task", "event"];

/// What a turn keeps of an answer. `cites` come from the context's refs (a fact keeps only its
/// id and title); `actions` are `{kind: "task", text, due}`, `{kind: "open", ref, recordId,
/// label}` or `{kind: "draft", ref, recordId, label, hint?}`, with `recordId` and `label` read
/// from the refs so the window can draw and follow an action without the context.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Checked {
    pub answer: String,
    pub cites: Vec<Cite>,
    pub actions: Vec<Value>,
    pub dropped_cites: usize,
    pub dropped_actions: usize,
}

/// `raw` (`{answer, cites, actions}`) checked against this turn's `refs` and `facts` (design
/// § 4): `[id]` marks and `cites` entries naming no ref are removed, each unknown id counted
/// once; at most 3 actions of `task`, `open` and `draft` are kept, every other one counted.
/// `Err("invalid_output")` when no answer text is left.
pub fn check(
    raw: &Value,
    refs: &BTreeMap<String, RefItem>,
    facts: &[(String, String)],
) -> Result<Checked, &'static str> {
    const INVALID: &str = "invalid_output";
    let known = |id: &str| refs.contains_key(id) || facts.iter().any(|(f, _)| f == id);
    let mut unknown: BTreeSet<String> = BTreeSet::new();
    let mut ids: Vec<String> = Vec::new();
    for entry in raw["cites"].as_array().into_iter().flatten() {
        match entry.as_str().map(str::trim) {
            Some(id) if known(id) => push_once(&mut ids, id),
            Some(id) => {
                unknown.insert(id.to_string());
            }
            None => {
                unknown.insert(entry.to_string());
            }
        }
    }
    let text = clean_output(raw["answer"].as_str().ok_or(INVALID)?);
    let text = marks(&text, |id| {
        if known(id) {
            push_once(&mut ids, id);
            true
        } else {
            unknown.insert(id.to_string());
            false
        }
    });
    let text = text.trim();
    if text.is_empty() {
        return Err(INVALID);
    }
    let (answer, _) = cut_at_line_end(text, ANSWER_MAX);
    // A cite whose every mark fell past the cut is no longer in the answer.
    let cites = ids
        .iter()
        .filter(|id| answer.contains(&format!("[{id}]")))
        .filter_map(|id| cite(id, refs, facts))
        .collect();

    let offered = raw["actions"].as_array().map(Vec::as_slice).unwrap_or(&[]);
    let valid: Vec<Value> = offered.iter().filter_map(|a| action(a, refs)).collect();
    let actions: Vec<Value> = valid.into_iter().take(ACTIONS_MAX).collect();
    Ok(Checked {
        answer,
        cites,
        dropped_cites: unknown.len(),
        dropped_actions: offered.len() - actions.len(),
        actions,
    })
}

fn push_once(ids: &mut Vec<String>, id: &str) {
    if !ids.iter().any(|i| i == id) {
        ids.push(id.to_string());
    }
}

/// `text` with every `[id]` mark (`\[[a-z]\d+\]`) that `keep` refuses removed, taking the
/// space before it along; anything else in brackets stays.
fn marks(text: &str, mut keep: impl FnMut(&str) -> bool) -> String {
    let chars: Vec<char> = text.chars().collect();
    let mut out = String::with_capacity(text.len());
    let mut i = 0;
    while i < chars.len() {
        if chars[i] == '[' && chars.get(i + 1).is_some_and(char::is_ascii_lowercase) {
            let digits = chars[i + 2..]
                .iter()
                .take_while(|c| c.is_ascii_digit())
                .count();
            let close = i + 2 + digits;
            if digits > 0 && chars.get(close) == Some(&']') {
                let id: String = chars[i + 1..close].iter().collect();
                if keep(&id) {
                    out.push('[');
                    out.push_str(&id);
                    out.push(']');
                } else if out.ends_with(' ') {
                    out.pop();
                }
                i = close + 1;
                continue;
            }
        }
        out.push(chars[i]);
        i += 1;
    }
    out
}

/// The turn's cite for a known `id`: a fact's id and title, else the ref's kind, record and
/// label.
fn cite(id: &str, refs: &BTreeMap<String, RefItem>, facts: &[(String, String)]) -> Option<Cite> {
    if let Some((_, title)) = facts.iter().find(|(f, _)| f == id) {
        return Some(Cite {
            id: id.into(),
            kind: "fact".into(),
            record_id: None,
            label: None,
            title: Some(title.clone()),
        });
    }
    refs.get(id).map(|r| Cite {
        id: id.into(),
        kind: r.kind.clone(),
        record_id: Some(r.record_id.clone()),
        label: Some(r.label.clone()),
        title: None,
    })
}

/// Model text on one line: invisible and control characters removed, whitespace collapsed.
fn one_line(s: &str) -> String {
    clean_output(s)
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
}

/// One offered action, kept as the window reads it, or `None` when it doesn't hold (design
/// § 4): `task` needs text of 1–2,000 characters and gets `due` only when `task_save` would
/// take it; `open` needs a ref to a message, meeting, task or event; `draft` a message ref.
fn action(a: &Value, refs: &BTreeMap<String, RefItem>) -> Option<Value> {
    let target = |kinds: &[&str]| {
        let id = a["ref"].as_str()?.trim();
        refs.get(id)
            .filter(|r| kinds.contains(&r.kind.as_str()))
            .map(|r| json!({"ref": id, "recordId": r.record_id, "label": r.label}))
    };
    match a["kind"].as_str()? {
        "task" => {
            let text = one_line(a["text"].as_str()?);
            let n = text.chars().count();
            if n == 0 || n > TASK_TEXT_MAX {
                return None;
            }
            let due = a["due"].as_str().map(str::trim).filter(|d| valid_due(d));
            Some(json!({"kind": "task", "text": text, "due": due}))
        }
        "open" => {
            let mut out = target(&OPENABLE)?;
            out["kind"] = "open".into();
            Some(out)
        }
        "draft" => {
            let mut out = target(&["message"])?;
            out["kind"] = "draft".into();
            let hint = a["hint"].as_str().map(one_line).unwrap_or_default();
            if !hint.is_empty() {
                out["hint"] = cap_chars(&hint, HINT_MAX).into();
            }
            Some(out)
        }
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn item(kind: &str, record_id: &str, label: &str) -> RefItem {
        RefItem {
            kind: kind.into(),
            record_id: record_id.into(),
            label: label.into(),
            gone: false,
        }
    }

    /// The refs a turn's context gave: a message, a task, an event, a meeting, a person and a
    /// fact, ids continuing from an earlier turn (ruling 33).
    fn refs() -> BTreeMap<String, RefItem> {
        BTreeMap::from([
            (
                "m9".into(),
                item("message", "msg-priya", "Priya N. · mail · Tue 24 Nov"),
            ),
            (
                "t10".into(),
                item("task", "task-atlas", "Task · Send the Atlas budget"),
            ),
            (
                "e11".into(),
                item("event", "evt-qbr", "Event · Fri 27 Nov 10:00 · QBR"),
            ),
            (
                "n12".into(),
                item("meeting", "mtg-qbr", "Meeting · Atlas QBR · Thu 20 Nov"),
            ),
            (
                "p13".into(),
                item("person", "person-marek", "Person · Marek Novak"),
            ),
            ("f14".into(), item("fact", "", "Knowledge · Atlas rollout")),
        ])
    }

    fn facts() -> Vec<(String, String)> {
        vec![("f14".into(), "Atlas rollout".into())]
    }

    fn checked(raw: Value) -> Checked {
        check(&raw, &refs(), &facts()).unwrap()
    }

    fn cite(id: &str, kind: &str, record_id: &str, label: &str) -> Cite {
        Cite {
            id: id.into(),
            kind: kind.into(),
            record_id: Some(record_id.into()),
            label: Some(label.into()),
            title: None,
        }
    }

    /// The cases `ask-answer-cases.json` holds: `{name, raw, expected}` against [`refs`] and
    /// [`facts`]; `expected` is the `Checked` or `{"error": code}`.
    fn cases() -> Vec<(&'static str, Value)> {
        let long: String = (0..160)
            .map(|i| format!("Line {i:03} of the Atlas notes, cited once [m9]."))
            .collect::<Vec<_>>()
            .join("\n");
        assert!(long.chars().count() >= 7_000);
        vec![
            (
                "clean answer",
                json!({
                    "answer": "The QBR is on Fri 27 Nov at 10:00 [e11]. Priya N. asked for the budget first [m9].",
                    "cites": ["e11", "m9"],
                    "actions": [
                        {"kind": "open", "ref": "e11"},
                        {"kind": "draft", "ref": "m9", "hint": "Say the budget goes out on Thursday."},
                        {"kind": "task", "text": "Send Priya the Atlas budget", "due": "2026-11-26"}
                    ]
                }),
            ),
            (
                "a cite the context never gave",
                json!({
                    "answer": "Marek Novak owns the rollout [p13], as agreed before [m3].\nThe plan is set [f14] [x].",
                    "cites": ["p13", "m3", "f14", 7],
                    "actions": []
                }),
            ),
            (
                "a bad action",
                json!({
                    "answer": "Jordan Lee is waiting on the report [m9].",
                    "cites": ["m9"],
                    "actions": [
                        {"kind": "send", "ref": "m9", "text": "Done"},
                        {"kind": "open", "ref": "m2"},
                        {"kind": "open", "ref": "f14"},
                        {"kind": "task", "text": "   "},
                        "open m9"
                    ]
                }),
            ),
            (
                "a draft on a task ref",
                json!({
                    "answer": "The budget task is open [t10].",
                    "cites": ["t10"],
                    "actions": [{"kind": "draft", "ref": "t10", "hint": "Remind them."}]
                }),
            ),
            (
                "an over-long answer",
                json!({"answer": long, "cites": ["m9"], "actions": []}),
            ),
            (
                "a bad due",
                json!({
                    "answer": "Not in Connect: a date for the plan. Searched tasks 2 (Todoist).",
                    "cites": [],
                    "actions": [
                        {"kind": "task", "text": "Ask Marek Novak for the plan date", "due": "2026-02-31"},
                        {"kind": "task", "text": "Book the Atlas review", "due": "next week"}
                    ]
                }),
            ),
            (
                "an empty answer",
                json!({"answer": " [m3] \n", "cites": ["m3"], "actions": []}),
            ),
        ]
    }

    fn expected(raw: &Value) -> Value {
        match check(raw, &refs(), &facts()) {
            Ok(c) => serde_json::to_value(c).unwrap(),
            Err(code) => json!({ "error": code }),
        }
    }

    #[test]
    fn answer_cases_from_the_fixture() {
        let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../ui/test/fixtures/contract/ask-answer-cases.json");
        let saved: Value = serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap();
        let refs: BTreeMap<String, RefItem> =
            serde_json::from_value(saved["refs"].clone()).unwrap();
        let facts: Vec<(String, String)> = serde_json::from_value(saved["facts"].clone()).unwrap();
        let cases = saved["cases"].as_array().unwrap();
        assert_eq!(cases.len(), 7);
        for case in cases {
            let got = match check(&case["raw"], &refs, &facts) {
                Ok(c) => serde_json::to_value(c).unwrap(),
                Err(code) => json!({ "error": code }),
            };
            assert_eq!(got, case["expected"], "{}", case["name"]);
        }
    }

    #[test]
    fn a_cite_from_an_earlier_turn_is_removed() {
        let c = checked(json!({
            "answer": "Priya N. asked on Tuesday [m3]. The budget is due Friday [m9].",
            "cites": ["m3", "m9"],
            "actions": []
        }));
        assert_eq!(
            c.answer,
            "Priya N. asked on Tuesday. The budget is due Friday [m9]."
        );
        assert_eq!(
            c.cites,
            vec![cite(
                "m9",
                "message",
                "msg-priya",
                "Priya N. · mail · Tue 24 Nov"
            )]
        );
        assert_eq!(c.dropped_cites, 1);
        // A mark only in the text still counts once; anything else in brackets stays.
        let c = checked(json!({
            "answer": "See [m3] and [Q3 plan] and [e11].",
            "cites": [],
            "actions": []
        }));
        assert_eq!(c.answer, "See and [Q3 plan] and [e11].");
        assert_eq!(c.cites.len(), 1);
        assert_eq!(c.cites[0].id, "e11");
        assert_eq!(c.dropped_cites, 1);
    }

    #[test]
    fn actions_are_bounded_and_checked() {
        let open = |r: &str| json!({"kind": "open", "ref": r});
        let c = checked(json!({
            "answer": "Four things [m9].",
            "cites": ["m9"],
            "actions": [open("m9"), open("e11"), open("n12"), open("t10")]
        }));
        assert_eq!(c.actions.len(), 3);
        assert_eq!(c.dropped_actions, 1);
        assert_eq!(
            c.actions[0],
            json!({"kind": "open", "ref": "m9", "recordId": "msg-priya", "label": "Priya N. · mail · Tue 24 Nov"})
        );

        let hint: String = "h".repeat(300);
        let c = checked(json!({
            "answer": "Checked [m9].",
            "cites": ["m9"],
            "actions": [
                {"kind": "send", "ref": "m9"},
                {"kind": "open", "ref": "m404"},
                {"kind": "draft", "ref": "t10", "hint": "x"},
                {"kind": "task", "text": ""},
                {"kind": "task", "text": "x".repeat(2_001)},
                {"kind": "task", "text": "Ask Marek Novak for the date", "due": "2026-02-31"},
                {"kind": "draft", "ref": "m9", "hint": hint},
            ]
        }));
        assert_eq!(c.dropped_actions, 5);
        assert_eq!(
            c.actions[0],
            json!({"kind": "task", "text": "Ask Marek Novak for the date", "due": null})
        );
        assert_eq!(c.actions[1]["kind"], "draft");
        assert_eq!(c.actions[1]["ref"], "m9");
        let kept = c.actions[1]["hint"].as_str().unwrap();
        assert_eq!(kept.chars().count(), 200);
        assert!(kept.ends_with('…'));

        let c = checked(json!({
            "answer": "Due soon [t10].",
            "cites": ["t10"],
            "actions": [
                {"kind": "task", "text": " Send the budget ", "due": "2026-11-27"},
                {"kind": "task", "text": "Book the room", "due": null},
                {"kind": "task", "text": "Book the review"},
            ]
        }));
        assert_eq!(c.dropped_actions, 0);
        assert_eq!(
            c.actions,
            vec![
                json!({"kind": "task", "text": "Send the budget", "due": "2026-11-27"}),
                json!({"kind": "task", "text": "Book the room", "due": null}),
                json!({"kind": "task", "text": "Book the review", "due": null}),
            ]
        );
        // Not an array: no actions, nothing counted.
        let c = checked(json!({"answer": "Fine [t10].", "cites": ["t10"], "actions": "open"}));
        assert!(c.actions.is_empty());
        assert_eq!(c.dropped_actions, 0);
    }

    #[test]
    fn an_over_long_answer_is_cut_at_a_line_end() {
        let lines: String = (0..210)
            .map(|i| format!("Line {i:03} of the Atlas answer."))
            .collect::<Vec<_>>()
            .join("\n");
        assert!(lines.chars().count() >= 6_000);
        let answer: String = format!("{lines}\n{}", "z".repeat(1_000));
        assert!(answer.chars().count() >= 7_000);
        let c = checked(json!({"answer": answer, "cites": [], "actions": []}));
        let n = c.answer.chars().count();
        assert!(n <= 6_000, "{n}");
        assert!(
            c.answer.ends_with(".…"),
            "{}",
            &c.answer[c.answer.len() - 40..]
        );
        assert!(!c.answer.contains('z'));
    }

    /// A cite whose only mark falls past the cut leaves the cites too.
    #[test]
    fn a_cite_cut_off_with_its_mark_is_dropped() {
        let lines: String = (0..210)
            .map(|i| format!("Line {i:03} of the Atlas answer."))
            .collect::<Vec<_>>()
            .join("\n");
        let answer = format!("Fine [t10].\n{lines}\nAnd the room [e11].");
        let c = checked(json!({"answer": answer, "cites": ["t10", "e11"], "actions": []}));
        assert!(!c.answer.contains("[e11]"));
        assert_eq!(
            c.cites.iter().map(|c| c.id.as_str()).collect::<Vec<_>>(),
            ["t10"]
        );
    }

    #[test]
    fn an_empty_answer_is_invalid_output() {
        for raw in [
            json!({"answer": "", "cites": [], "actions": []}),
            json!({"answer": " \n\u{200B}\t", "cites": [], "actions": []}),
            json!({"answer": "[m3]", "cites": ["m3"], "actions": []}),
            json!({"cites": [], "actions": []}),
            json!({"answer": 7, "cites": [], "actions": []}),
            json!("The QBR is on Friday."),
        ] {
            assert_eq!(
                check(&raw, &refs(), &facts()),
                Err("invalid_output"),
                "{raw}"
            );
        }
    }

    #[test]
    fn fact_cites_keep_id_and_title_only() {
        let c = checked(json!({
            "answer": "The rollout starts in December [f14], says Marek Novak [p13].",
            "cites": ["f14", "p13", "f14"],
            "actions": []
        }));
        assert_eq!(
            c.cites,
            vec![
                Cite {
                    id: "f14".into(),
                    kind: "fact".into(),
                    record_id: None,
                    label: None,
                    title: Some("Atlas rollout".into()),
                },
                cite("p13", "person", "person-marek", "Person · Marek Novak"),
            ]
        );
        assert_eq!(c.dropped_cites, 0);
    }

    /// `ask-answer-cases.json`: the refs and facts of one turn and what `check` makes of each
    /// raw answer. Regenerate with `UPDATE_CONTRACT_FIXTURES=1 cargo test contract_fixtures`.
    #[test]
    fn contract_fixtures_match_the_answer_cases() {
        let cases: Vec<Value> = cases()
            .into_iter()
            .map(|(name, raw)| json!({"name": name, "expected": expected(&raw), "raw": raw}))
            .collect();
        assert_eq!(cases[0]["expected"]["droppedActions"], 0);
        assert_eq!(cases[1]["expected"]["droppedCites"], 2);
        assert_eq!(cases[2]["expected"]["droppedActions"], 5);
        assert_eq!(cases[3]["expected"]["actions"], json!([]));
        assert!(cases[4]["expected"]["answer"]
            .as_str()
            .unwrap()
            .ends_with('…'));
        assert_eq!(cases[5]["expected"]["actions"][0]["due"], Value::Null);
        assert_eq!(cases[6]["expected"], json!({"error": "invalid_output"}));
        crate::plugins::testkit::contract_fixture(
            "ask-answer-cases.json",
            &json!({"refs": refs(), "facts": facts(), "cases": cases}),
        );
    }
}
