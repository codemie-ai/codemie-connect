//! Reading an answer that did not arrive as the structured output a run asked for. Smaller and
//! local models (an Ollama model behind CodeMie) often answer in the text instead: the JSON in a
//! ```json fence or between sentences, after a `<think>` block, with trailing commas, or plain
//! Markdown with no JSON at all. What is cut off, empty or unbalanced is still refused.
use super::stream::RunOutcome;
use serde_json::Value;

/// How many `{` a search tries as the start of the answer's object.
const STARTS_TRIED: usize = 16;

/// The values a run's answer can be read from, best first: the structured output when it is an
/// object; the JSON object found in a structured string or in the text; and, only when the run
/// gave no structured output at all, the text itself as a JSON string, for a parser that takes
/// plain Markdown (meeting notes). Every other parser reads fields and refuses a string.
pub fn candidates(outcome: &RunOutcome) -> Vec<Value> {
    let mut found = Vec::new();
    match &outcome.structured {
        Some(v @ Value::Object(_)) => found.push(v.clone()),
        Some(Value::String(s)) => found.extend(json_object_in(s)),
        _ => {}
    }
    if let Some(v) = json_object_in(&outcome.text) {
        if !found.contains(&v) {
            found.push(v);
        }
    }
    if outcome.structured.is_none() {
        found.extend(plain_text(&outcome.text).map(Value::String));
    }
    found
}

/// The first JSON object in `text` (fenced, between prose, after a closed `<think>` block),
/// trailing commas repaired. `None` when there is none, or it never closes.
pub fn json_object_in(text: &str) -> Option<Value> {
    let text = without_thinking(text)?;
    text.match_indices('{')
        .take(STARTS_TRIED)
        .find_map(|(i, _)| object_at(&text[i..]))
}

/// `text` as a Markdown answer: without a `<think>` block or a fence around it all. `None` when
/// it is empty, still thinking, looks like JSON (a cut-off object), leaves a fence open, or says
/// it hit the output limit.
pub fn plain_text(text: &str) -> Option<String> {
    let text = without_thinking(text)?;
    let mut body = text.trim();
    if let Some(inner) = outer_fence(body) {
        body = inner.trim();
    }
    let looks_like_json = body.starts_with('{')
        || body.starts_with('[')
        || find_ci(body, "```json", 0).is_some()
        || body
            .match_indices('{')
            .any(|(i, _)| body[i + 1..].trim_start().starts_with('"'));
    let fence_open = body.matches("```").count() % 2 == 1;
    let hit_limit = find_ci(body, "output token maximum", 0).is_some();
    (!body.is_empty() && !looks_like_json && !fence_open && !hit_limit).then(|| body.to_string())
}

/// `text` without its `<think>…</think>` (or `<thinking>`) blocks, and without what comes before
/// a lone closing tag. `None` while a block is still open: the answer was cut off thinking.
fn without_thinking(text: &str) -> Option<String> {
    let mut out = String::new();
    let mut rest = text;
    if let Some(close) = closing_tag(rest, 0) {
        if find_ci(&rest[..close.0], "<think", 0).is_none() {
            rest = &rest[close.1..];
        }
    }
    while let Some(open) = find_ci(rest, "<think", 0) {
        out.push_str(&rest[..open]);
        let (_, end) = closing_tag(rest, open)?;
        rest = &rest[end..];
    }
    out.push_str(rest);
    Some(out)
}

/// Where the first `</think>` or `</thinking>` at or after `from` starts and ends.
fn closing_tag(text: &str, from: usize) -> Option<(usize, usize)> {
    let start = find_ci(text, "</think", from)?;
    let end = text[start..].find('>')? + start + 1;
    Some((start, end))
}

/// The inside of a fence that wraps all of `text` (```markdown … ```), when one does.
fn outer_fence(text: &str) -> Option<&str> {
    let inner = text.strip_prefix("```")?.strip_suffix("```")?;
    let (lang, body) = inner.split_once('\n')?;
    (!lang.contains("```") && !body.contains("```")).then_some(body)
}

/// ASCII-case-insensitive search for `needle` in `hay` from byte `from`.
fn find_ci(hay: &str, needle: &str, from: usize) -> Option<usize> {
    let (h, n) = (hay.as_bytes(), needle.as_bytes());
    (from..=h.len().checked_sub(n.len())?).find(|&i| h[i..i + n.len()].eq_ignore_ascii_case(n))
}

/// The object that starts at the beginning of `text` and closes, read as JSON (trailing commas
/// repaired).
fn object_at(text: &str) -> Option<Value> {
    let slice = &text[..balanced_end(text)?];
    serde_json::from_str::<Value>(slice)
        .ok()
        .or_else(|| serde_json::from_str::<Value>(&without_trailing_commas(slice)).ok())
        .filter(Value::is_object)
}

/// The byte just past the brace that closes the one `text` starts with; strings are skipped.
fn balanced_end(text: &str) -> Option<usize> {
    let (mut depth, mut in_string, mut escaped) = (0usize, false, false);
    for (i, c) in text.char_indices() {
        if in_string {
            match c {
                _ if escaped => escaped = false,
                '\\' => escaped = true,
                '"' => in_string = false,
                _ => {}
            }
            continue;
        }
        match c {
            '"' => in_string = true,
            '{' | '[' => depth += 1,
            '}' | ']' => {
                depth = depth.checked_sub(1)?;
                if depth == 0 {
                    return Some(i + 1);
                }
            }
            _ => {}
        }
    }
    None
}

/// `json` without commas that only whitespace separates from a closing `}` or `]`.
fn without_trailing_commas(json: &str) -> String {
    let mut out = String::with_capacity(json.len());
    let (mut in_string, mut escaped) = (false, false);
    for (i, c) in json.char_indices() {
        if in_string {
            match c {
                _ if escaped => escaped = false,
                '\\' => escaped = true,
                '"' => in_string = false,
                _ => {}
            }
        } else if c == '"' {
            in_string = true;
        } else if c == ',' && json[i + 1..].trim_start().starts_with(['}', ']']) {
            continue;
        }
        out.push(c);
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ai::stream::Usage;
    use serde_json::json;

    fn text_only(text: &str) -> RunOutcome {
        RunOutcome {
            structured: None,
            text: text.into(),
            usage: Usage::default(),
            cost_usd: None,
            duration_ms: 0,
            model: None,
        }
    }

    const ENVELOPE: &str = r##"{"notesMarkdown": "# Синк\n- {скобки} в тексте", "tasks": []}"##;

    /// The envelope cut off by the output limit, inside its notes.
    fn cut() -> String {
        ENVELOPE.chars().take(40).collect()
    }

    fn envelope() -> Value {
        json!({"notesMarkdown": "# Синк\n- {скобки} в тексте", "tasks": []})
    }

    #[test]
    fn finds_the_object_in_a_fence() {
        let fenced = format!("```json\n{ENVELOPE}\n```");
        assert_eq!(json_object_in(&fenced), Some(envelope()));
    }

    #[test]
    fn finds_the_object_between_prose() {
        let prosed =
            format!("Вот заметки по встрече:\n\n{ENVELOPE}\n\nНадеюсь, это поможет! {{:)}}");
        assert_eq!(json_object_in(&prosed), Some(envelope()));
    }

    #[test]
    fn skips_a_think_block_even_with_braces_in_it() {
        let thought = format!(
            "<think>\nThe user wants {{\"notesMarkdown\": ...}}. Let me write it.\n</think>\n{ENVELOPE}"
        );
        assert_eq!(json_object_in(&thought), Some(envelope()));
        // Only the closing tag (the chat template opened it).
        let closing = format!("Okay, {{draft}} first.\n</think>\n\n{ENVELOPE}");
        assert_eq!(json_object_in(&closing), Some(envelope()));
    }

    #[test]
    fn repairs_trailing_commas_outside_strings() {
        let trailing = r#"{"notesMarkdown": "a, ]b,}", "tasks": [{"title": "x", "line": 0,},],}"#;
        assert_eq!(
            json_object_in(trailing),
            Some(json!({"notesMarkdown": "a, ]b,}", "tasks": [{"title": "x", "line": 0}]}))
        );
    }

    #[test]
    fn refuses_cut_off_unclosed_and_empty_output() {
        let cut = &cut();
        assert_eq!(json_object_in(cut), None);
        assert_eq!(json_object_in(&format!("```json\n{cut}")), None);
        assert_eq!(json_object_in(&format!("<think>{ENVELOPE}")), None);
        assert_eq!(json_object_in(""), None);
        assert_eq!(json_object_in("No JSON here."), None);
        assert_eq!(json_object_in("[1, 2]"), None);
    }

    #[test]
    fn plain_markdown_is_read_without_thinking_or_an_outer_fence() {
        let md = "# Синк\n\n- Решили: пилот в декабре\n- Марек готовит демо";
        assert_eq!(plain_text(md).as_deref(), Some(md));
        assert_eq!(
            plain_text(&format!("<think>Хм.</think>\n\n{md}\n")).as_deref(),
            Some(md)
        );
        assert_eq!(
            plain_text(&format!("```markdown\n{md}\n```")).as_deref(),
            Some(md)
        );
        // A fence inside the notes stays.
        let with_code = format!("{md}\n\n```\ncode\n```");
        assert_eq!(plain_text(&with_code).as_deref(), Some(with_code.as_str()));
    }

    #[test]
    fn plain_text_refuses_json_attempts_cut_output_and_empty() {
        let cut = &cut();
        for refused in [
            "".to_string(),
            "  \n ".to_string(),
            cut.to_string(),
            format!("```json\n{cut}"),
            format!("Here you go:\n{{\"notesMarkdown\": \"# Sync"),
            "<think>Still thinking about the".to_string(),
            "<think>Done.</think>".to_string(),
            "# Notes\n\n```\nleft open".to_string(),
            "# Notes\nAPI Error: Claude's response exceeded the 32000 output token maximum."
                .to_string(),
        ] {
            assert_eq!(plain_text(&refused), None, "{refused:?}");
        }
    }

    #[test]
    fn candidates_prefer_structured_then_text_json_then_plain_text() {
        let mut o = text_only("ignored");
        o.structured = Some(envelope());
        assert_eq!(candidates(&o), vec![envelope()]);
        // A structured string holding the JSON.
        o.structured = Some(Value::String(format!("```json\n{ENVELOPE}\n```")));
        o.text = String::new();
        assert_eq!(candidates(&o), vec![envelope()]);
        // No structured output: the text's JSON (text holding JSON is never a notes body).
        let prosed = format!("Sure!\n{ENVELOPE}");
        assert_eq!(candidates(&text_only(&prosed)), vec![envelope()]);
        let md = "# Sync\n- one";
        assert_eq!(candidates(&text_only(md)), vec![Value::String(md.into())]);
        // A structured object that a parser refused never makes the text a notes body.
        let mut refused = text_only("done");
        refused.structured = Some(json!({"other": 1}));
        assert_eq!(candidates(&refused), vec![json!({"other": 1})]);
        assert!(candidates(&text_only("")).is_empty());
    }
}
