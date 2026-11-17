//! `ctx.markdown(md)`: a plugin's Markdown as safe HTML. It goes through the workspace's one
//! Markdown normaliser (`workspace::markdown`, the rules automation results use): raw HTML is
//! plain text, and a link keeps only an `http`/`https` address. Nothing else is a sanitiser.
use super::at;
use crate::plugins::host::HostError;
use crate::workspace::markdown::{blocks, html};
use serde_json::{json, Value};

/// How much of a plugin's Markdown is read (a note, a routine's answer).
const MAX_CHARS: usize = 200_000;

pub fn render(args: &Value) -> Result<Value, HostError> {
    let text = match at(args, 0) {
        Value::String(s) => s.as_str(),
        _ => "",
    };
    Ok(json!(html(&blocks(text, MAX_CHARS))))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn md(text: &str) -> String {
        render(&json!([text]))
            .unwrap()
            .as_str()
            .unwrap()
            .to_string()
    }

    #[test]
    fn markdown_strips_raw_html_and_javascript_links() {
        assert_eq!(
            md("# Title\n\nSome **bold** and *it*.\n\n- one\n- two"),
            "<h3>Title</h3><p>Some <strong>bold</strong> and <em>it</em>.</p>\
             <ul><li>one</li><li>two</li></ul>"
        );
        let out = md(
            "<script>alert(1)</script>\n\n<img src=x onerror=alert(1)>\n\n\
             [click](javascript:alert(1)) [data](data:text/html,x) [ok](https://example.com/a?b=1&c=2) [q](https://example.com/\"x)",
        );
        assert!(!out.contains("<script") && !out.contains("<img"), "{out}");
        assert!(
            out.contains("&lt;script&gt;alert(1)&lt;/script&gt;"),
            "{out}"
        );
        assert!(
            !out.contains("javascript:") && !out.contains("data:text"),
            "{out}"
        );
        assert!(
            out.contains(
                "<a href=\"https://example.com/a?b=1&amp;c=2\" rel=\"noopener noreferrer\">ok</a>"
            ),
            "{out}"
        );
        // Refused links keep only their words.
        assert!(
            out.contains("<p>click data <a") && out.contains("</a> q</p>"),
            "{out}"
        );
        assert_eq!(md(""), "");
        assert_eq!(render(&json!([42])).unwrap(), json!(""));
        // Quotes in text can't break out of anything.
        assert_eq!(
            md("a \"b\" 'c' & <d>"),
            "<p>a &quot;b&quot; &#39;c&#39; &amp; &lt;d&gt;</p>"
        );
    }
}
