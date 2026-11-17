//! The Markdown subset Claude's automation results may use (DESIGN 6.6): headings (at most
//! three levels), bullets, bold and inline http/https links.
//!
//! Claude writes these results after reading other people's mail, so the text is untrusted.
//! This sanitiser is a second line of defence, not a renderer: whatever shows a result must
//! still escape all text and build only headings, bullets, bold and links from it (never
//! `innerHTML` of the raw Markdown).
use super::prompts::{cap_chars, clean_output};

const MAX_CHARS: usize = 8_000;
const MAX_LINK_CHARS: usize = 2_000;

/// Claude's Markdown limited to the subset above.
/// - `<` and `>` become `‹` and `›`, as in the prompt sanitiser, so raw HTML, comments and
///   autolinks (`<javascript:…>`) are only text.
/// - Reference-style links (`[text][ref]`, `[text][]`) keep their text, and reference
///   definitions (`[ref]: address`) are dropped: only inline `[text](http…)` links stay links.
/// - Images, inline code and links to other schemes keep their text; code fences go.
pub fn sanitize(text: &str) -> String {
    let defused = clean_output(text).replace('<', "‹").replace('>', "›");
    let mut lines = Vec::new();
    for line in defused.lines() {
        let trimmed = line.trim_start();
        if trimmed.starts_with("```") || trimmed.starts_with("~~~") || definition(trimmed) {
            continue;
        }
        let hashes = trimmed.chars().take_while(|c| *c == '#').count();
        let bullet = ["- ", "* ", "+ "]
            .iter()
            .find_map(|b| trimmed.strip_prefix(b));
        let shaped = if (1..=6).contains(&hashes) && trimmed[hashes..].starts_with(' ') {
            format!("{} {}", "#".repeat(hashes.min(3)), trimmed[hashes..].trim())
        } else if let Some(rest) = bullet {
            let nested = line.len() - trimmed.len() >= 2;
            format!("{}- {}", if nested { "  " } else { "" }, rest.trim())
        } else {
            line.trim_end().to_string()
        };
        lines.push(inline(&shaped));
    }
    cap_chars(lines.join("\n").trim(), MAX_CHARS)
}

/// A reference definition: `[ref]: …` at the start of a line.
fn definition(trimmed: &str) -> bool {
    trimmed
        .strip_prefix('[')
        .and_then(|rest| rest.split_once(']'))
        .is_some_and(|(label, after)| !label.is_empty() && after.starts_with(':'))
}

/// One line's links, images and code spans: an inline web link is kept, anything else keeps
/// its text.
fn inline(line: &str) -> String {
    let chars: Vec<char> = line.chars().collect();
    let mut out = String::with_capacity(line.len());
    let mut i = 0;
    while i < chars.len() {
        let image = chars[i] == '!' && chars.get(i + 1) == Some(&'[');
        let open = if image { i + 1 } else { i };
        if chars[open] == '[' {
            if let Some((text, target, next)) = link(&chars, open) {
                match target {
                    Target::Inline(url) if !image && web_link(&url) => {
                        out.push_str(&format!("[{text}]({url})"))
                    }
                    _ => out.push_str(&text),
                }
                i = next;
                continue;
            }
        }
        if chars[i] != '`' {
            out.push(chars[i]);
        }
        i += 1;
    }
    out
}

enum Target {
    /// `[text](address)`
    Inline(String),
    /// `[text][ref]` or `[text][]`
    Reference,
}

/// The link starting at `open`: its text, what it points to and the index after it. An inline
/// address may hold nested parentheses.
fn link(chars: &[char], open: usize) -> Option<(String, Target, usize)> {
    let close = (open + 1..chars.len()).find(|&j| chars[j] == ']')?;
    let text: String = chars[open + 1..close]
        .iter()
        .filter(|c| **c != '`')
        .collect();
    match chars.get(close + 1)? {
        '[' => {
            let end = (close + 2..chars.len()).find(|&j| chars[j] == ']')?;
            Some((text, Target::Reference, end + 1))
        }
        '(' => {
            let mut depth = 0;
            let mut end = close + 2;
            loop {
                match chars.get(end)? {
                    '(' => depth += 1,
                    ')' if depth == 0 => break,
                    ')' => depth -= 1,
                    _ => {}
                }
                end += 1;
            }
            let url = chars[close + 2..end].iter().collect();
            Some((text, Target::Inline(url), end + 1))
        }
        _ => None,
    }
}

/// An http or https address with nothing that could break out of the link.
fn web_link(url: &str) -> bool {
    let lower = url.to_ascii_lowercase();
    let scheme = ["https://", "http://"]
        .iter()
        .find(|s| lower.starts_with(**s));
    scheme.is_some_and(|s| url.len() > s.len())
        && url.chars().count() <= MAX_LINK_CHARS
        && !url.chars().any(|c| {
            c.is_whitespace() || matches!(c, '<' | '>' | '‹' | '›' | '"' | '\'' | '`' | '\\')
        })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn keeps_headings_bullets_bold_and_web_links_only() {
        let text = "# Day\n#### Too deep\n* one\n+ two\n  - nested\n**Bold** and [site](https://example.test/a?b=1) \
                    and [bad](javascript:alert(1)) and [file](file:///etc/passwd) and ![pixel](https://t.example/p.png) \
                    and `code` and [mail](mailto:a@b.test)\n```js\nalert(1)\n```";
        assert_eq!(
            sanitize(text),
            "# Day\n### Too deep\n- one\n- two\n  - nested\n**Bold** and [site](https://example.test/a?b=1) \
             and bad and file and pixel and code and mail\nalert(1)"
        );
    }

    #[test]
    fn raw_html_and_autolinks_lose_their_angle_brackets() {
        assert_eq!(
            sanitize("Plain <b>tag</b> <img src=x onerror=alert(1)> <javascript:alert(1)> <https://evil.test>"),
            "Plain ‹b›tag‹/b› ‹img src=x onerror=alert(1)› ‹javascript:alert(1)› ‹https://evil.test›"
        );
        assert_eq!(
            sanitize("> quoted\n<!-- hidden -->"),
            "› quoted\n‹!-- hidden --›"
        );
        // Inside a kept link the text is defused the same way.
        assert_eq!(
            sanitize("[<b>plan</b>](https://example.test/plan)"),
            "[‹b›plan‹/b›](https://example.test/plan)"
        );
    }

    #[test]
    fn reference_links_keep_only_their_text_and_definitions_go() {
        assert_eq!(
            sanitize("See [the plan][1], [notes][] and [x] [y]\n[1]: javascript:alert(1)\n   [notes]: https://ok.test \"t\"\nend"),
            "See the plan, notes and [x] [y]\nend"
        );
        // A definition that names a web address is dropped too: only inline links stay links.
        assert_eq!(sanitize("[a][r]\n[r]: https://example.test"), "a");
    }

    #[test]
    fn a_link_with_a_space_or_quote_is_not_a_link() {
        assert_eq!(
            sanitize("[x](https://a.test/\"onmouseover) [y](https://a .test)"),
            "x y"
        );
        assert_eq!(
            sanitize("[unclosed](https://a.test"),
            "[unclosed](https://a.test"
        );
    }

    #[test]
    fn output_is_capped() {
        assert_eq!(sanitize(&"x".repeat(9_000)).chars().count(), 8_000);
    }
}
