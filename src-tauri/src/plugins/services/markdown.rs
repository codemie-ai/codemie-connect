//! `ctx.markdown(md)`: a plugin's Markdown as safe HTML. It goes through the workspace's one
//! Markdown normaliser (`workspace::markdown`, the rules automation results use): raw HTML is
//! plain text, and a link keeps only an `http`/`https` address. Nothing else is a sanitiser.
//!
//! `ctx.markdown(md, {breaks, links, images})`: a page of a vault (Echo's plugin API,
//! `ctx.markdown`). It is parsed with `pulldown-cmark` (tables, strikethrough, task lists,
//! footnotes, `[[wikilinks]]`) and written here from the parse, every text and attribute
//! escaped; raw HTML is shown as text. A destination is a link or an image only through the
//! plugin's own map (`{"<dest>": "<href>" | null}`), and only to an address [`allowed_link`] or
//! [`allowed_image`] takes; `null` is a page that isn't there. Anything else is its words.
//! `ctx.markdown.links(md, {detail})` lists the destinations a page writes, for the plugin to
//! resolve before it asks for the page.
use super::{at, bad};
use crate::plugins::host::HostError;
use crate::workspace::markdown::{blocks, html};
use pulldown_cmark::{CodeBlockKind, Event, LinkType, Options, Parser, Tag, TagEnd};
use serde_json::{json, Map, Value};
use std::collections::HashSet;

/// How much of a plugin's Markdown is read (a note, a routine's answer).
const MAX_CHARS: usize = 200_000;
/// How much of a vault's page is written or scanned, in UTF-8 bytes.
const MAX_PAGE_BYTES: usize = 2 << 20;
/// The `echo://` kinds Echo's window opens.
const ECHO_KINDS: [&str; 10] = [
    "call", "thread", "project", "client", "person", "task", "prep", "needs", "mail", "post",
];

/// `ctx.markdown(md, opts?)`, `args` being `[md, opts?]`: without options the plain writer,
/// with them a vault's page.
pub fn render(plugin: &str, args: &Value) -> Result<Value, HostError> {
    let text = match at(args, 0) {
        Value::String(s) => s.as_str(),
        _ => "",
    };
    let Value::Object(opts) = at(args, 1) else {
        return Ok(json!(html(&blocks(text, MAX_CHARS))));
    };
    let map = |key: &str| opts.get(key).and_then(Value::as_object);
    let mut page = Page {
        plugin,
        breaks: opts.get("breaks") == Some(&Value::Bool(true)),
        links: map("links"),
        images: map("images"),
        out: String::new(),
        open_links: Vec::new(),
        image: None,
        in_head: false,
    };
    for event in parser(page_text(text)?) {
        page.event(event);
    }
    Ok(json!(page.out))
}

/// `ctx.markdown.links(md, {detail})` → `{links, images}`: each destination once, in the order
/// written, nothing in code; with `detail: true` also `entries`, each way one was written.
pub fn links(args: &Value) -> Result<Value, HostError> {
    let text = page_text(at(args, 0).as_str().unwrap_or(""))?;
    let detail = at(args, 1).get("detail") == Some(&Value::Bool(true));
    let (mut links, mut images, mut entries) = (Vec::new(), Vec::new(), Vec::new());
    let mut seen = HashSet::new();
    for event in parser(text) {
        let (embed, link_type, dest) = match event {
            Event::Start(Tag::Link {
                link_type,
                dest_url,
                ..
            }) => (false, link_type, dest_url),
            Event::Start(Tag::Image {
                link_type,
                dest_url,
                ..
            }) => (true, link_type, dest_url),
            _ => continue,
        };
        let Some(dest) = destination(link_type, &dest) else {
            continue;
        };
        let wiki = matches!(link_type, LinkType::WikiLink { .. });
        if seen.insert((dest.clone(), embed, None)) {
            let list = if embed { &mut images } else { &mut links };
            list.push(dest.clone());
        }
        if detail && seen.insert((dest.clone(), embed, Some(wiki))) {
            entries.push(
                json!({"dest": dest, "kind": if wiki { "wiki" } else { "md" }, "embed": embed}),
            );
        }
    }
    let mut out = json!({"links": links, "images": images});
    if detail {
        out["entries"] = Value::Array(entries);
    }
    Ok(out)
}

fn page_text(text: &str) -> Result<&str, HostError> {
    if text.len() > MAX_PAGE_BYTES {
        return Err(bad("ctx.markdown renders 2 MB of text at most"));
    }
    Ok(text)
}

fn parser(text: &str) -> Parser<'_> {
    Parser::new_ext(
        text,
        Options::ENABLE_TABLES
            | Options::ENABLE_STRIKETHROUGH
            | Options::ENABLE_TASKLISTS
            | Options::ENABLE_FOOTNOTES
            | Options::ENABLE_WIKILINKS,
    )
}

/// The destination a link or image is looked up by, as written: a wikilink's target before
/// `|`, trimmed, a trailing backslash dropped (`[[Page\|label]]` in a table). An e-mail
/// autolink or an empty destination is no destination.
fn destination(link_type: LinkType, dest: &str) -> Option<String> {
    let dest = match link_type {
        LinkType::WikiLink { .. } => {
            let t = dest.trim();
            t.strip_suffix('\\').unwrap_or(t).trim()
        }
        LinkType::Email => return None,
        _ => dest,
    };
    (!dest.is_empty()).then(|| dest.to_string())
}

/// No whitespace, control character or backslash anywhere in an address.
fn plain(href: &str) -> bool {
    !href
        .chars()
        .any(|c| c.is_whitespace() || c.is_control() || c == '\\')
}

/// A link's href the page may keep: `https://<host>…`, an `echo://<kind>/<id>` link Echo's
/// window opens, or the plugin's own route (`#<plugin>:…`, its Knowledge tab's
/// `#brain/<plugin>:…`).
fn allowed_link(plugin: &str, href: &str) -> bool {
    if !plain(href) || plugin.is_empty() {
        return false;
    }
    if let Some(rest) = href.strip_prefix("https://") {
        return rest
            .split(['/', '?', '#'])
            .next()
            .is_some_and(|host| !host.is_empty());
    }
    if let Some(rest) = href.strip_prefix("echo://") {
        let path = rest.split(['?', '#']).next().unwrap_or("");
        return path
            .split_once('/')
            .is_some_and(|(kind, id)| ECHO_KINDS.contains(&kind) && !id.is_empty());
    }
    href.strip_prefix("#brain/")
        .or_else(|| href.strip_prefix('#'))
        .and_then(|route| route.strip_prefix(plugin))
        .is_some_and(|rest| rest.starts_with(':'))
}

/// An image's src the page may keep: only the plugin's own folder route,
/// `[/]plugin/<plugin>/folder/<rest>`, with no `?` or `#` and no `.` or `..` segment once
/// `%`-decoded (`%2e`, `%2F` and `%5C` count).
fn allowed_image(plugin: &str, src: &str) -> bool {
    if !plain(src) || plugin.is_empty() {
        return false;
    }
    let Some(rest) = src
        .strip_prefix('/')
        .unwrap_or(src)
        .strip_prefix("plugin/")
        .and_then(|r| r.strip_prefix(plugin))
        .and_then(|r| r.strip_prefix("/folder/"))
    else {
        return false;
    };
    !rest.is_empty()
        && !rest.contains(['?', '#'])
        && !percent_decoded(rest)
            .split(['/', '\\'])
            .any(|segment| segment == "." || segment == "..")
}

/// `%XX` decoded to its byte, anything else kept; bytes that aren't UTF-8 become U+FFFD.
fn percent_decoded(text: &str) -> String {
    let bytes = text.as_bytes();
    let hex = |i: usize| bytes.get(i).and_then(|b| (*b as char).to_digit(16));
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' {
            if let (Some(hi), Some(lo)) = (hex(i + 1), hex(i + 2)) {
                out.push((hi * 16 + lo) as u8);
                i += 3;
                continue;
            }
        }
        out.push(bytes[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

fn escape_into(out: &mut String, text: &str) {
    for c in text.chars() {
        match c {
            '&' => out.push_str("&amp;"),
            '<' => out.push_str("&lt;"),
            '>' => out.push_str("&gt;"),
            '"' => out.push_str("&quot;"),
            '\'' => out.push_str("&#39;"),
            _ => out.push(c),
        }
    }
}

fn escaped(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    escape_into(&mut out, text);
    out
}

/// A link being written: its words go into `out` from `start`, and its end decides what wraps
/// them (`open` and `</a>`, or nothing: the words alone).
struct OpenLink {
    open: Option<String>,
    start: usize,
    /// The words shown instead: a wikilink written without a label shows its target, and a
    /// link with no words its destination.
    target: String,
    labelled: bool,
}

/// An image being read: its alt text is gathered as plain text until its end.
struct OpenImage {
    dest: Option<String>,
    target: String,
    labelled: bool,
    alt: String,
    /// Images nested in its alt text.
    depth: usize,
}

/// The writer of a vault's page.
struct Page<'a> {
    plugin: &'a str,
    breaks: bool,
    links: Option<&'a Map<String, Value>>,
    images: Option<&'a Map<String, Value>>,
    out: String,
    open_links: Vec<OpenLink>,
    image: Option<OpenImage>,
    in_head: bool,
}

impl Page<'_> {
    fn push(&mut self, html: &str) {
        self.out.push_str(html);
    }

    fn text(&mut self, text: &str) {
        escape_into(&mut self.out, text);
    }

    fn event(&mut self, event: Event) {
        if let Some(image) = self.image.as_mut() {
            match event {
                Event::Start(Tag::Image { .. }) => image.depth += 1,
                Event::End(TagEnd::Image) if image.depth > 0 => image.depth -= 1,
                Event::End(TagEnd::Image) => self.close_image(),
                Event::Text(t) | Event::Code(t) | Event::InlineHtml(t) => image.alt.push_str(&t),
                Event::SoftBreak | Event::HardBreak => image.alt.push(' '),
                _ => {}
            }
            return;
        }
        match event {
            Event::Start(tag) => self.start(tag),
            Event::End(tag) => self.end(tag),
            Event::Text(t) | Event::Html(t) | Event::InlineHtml(t) => self.text(&t),
            Event::InlineMath(t) | Event::DisplayMath(t) => self.text(&t),
            Event::Code(t) => {
                self.push("<code>");
                self.text(&t);
                self.push("</code>");
            }
            Event::SoftBreak if self.breaks => self.push("<br>\n"),
            Event::SoftBreak => self.push("\n"),
            Event::HardBreak => self.push("<br>\n"),
            Event::Rule => self.push("<hr>"),
            Event::FootnoteReference(label) => {
                self.push("<sup class=\"footnote-ref\">");
                self.text(&label);
                self.push("</sup>");
            }
            Event::TaskListMarker(true) => self.push("<input type=\"checkbox\" disabled checked> "),
            Event::TaskListMarker(false) => self.push("<input type=\"checkbox\" disabled> "),
        }
    }

    fn start(&mut self, tag: Tag) {
        match tag {
            Tag::Paragraph | Tag::HtmlBlock => self.push("<p>"),
            Tag::Heading { level, .. } => self.push(&format!("<h{}>", level as usize)),
            Tag::BlockQuote(_) => self.push("<blockquote>"),
            Tag::CodeBlock(CodeBlockKind::Fenced(info)) => match info.split_whitespace().next() {
                Some(lang) => {
                    self.push(&format!("<pre><code class=\"language-{}\">", escaped(lang)))
                }
                None => self.push("<pre><code>"),
            },
            Tag::CodeBlock(CodeBlockKind::Indented) => self.push("<pre><code>"),
            Tag::List(Some(1)) => self.push("<ol>"),
            Tag::List(Some(start)) => self.push(&format!("<ol start=\"{start}\">")),
            Tag::List(None) => self.push("<ul>"),
            Tag::Item => self.push("<li>"),
            Tag::FootnoteDefinition(label) => {
                self.push(
                    "<div class=\"footnote-definition\"><sup class=\"footnote-definition-label\">",
                );
                self.text(&label);
                self.push("</sup> ");
            }
            Tag::Table(_) => self.push("<div class=\"tablewrap\"><table>"),
            Tag::TableHead => {
                self.in_head = true;
                self.push("<thead><tr>");
            }
            Tag::TableRow => self.push("<tr>"),
            Tag::TableCell if self.in_head => self.push("<th>"),
            Tag::TableCell => self.push("<td>"),
            Tag::Emphasis => self.push("<em>"),
            Tag::Strong => self.push("<strong>"),
            Tag::Strikethrough => self.push("<del>"),
            Tag::Superscript => self.push("<sup>"),
            Tag::Subscript => self.push("<sub>"),
            Tag::Link {
                link_type,
                dest_url,
                ..
            } => self.open_link(link_type, &dest_url),
            Tag::Image {
                link_type,
                dest_url,
                ..
            } => {
                let dest = destination(link_type, &dest_url);
                self.image = Some(OpenImage {
                    target: dest.clone().unwrap_or_else(|| dest_url.to_string()),
                    dest,
                    labelled: link_label(link_type),
                    alt: String::new(),
                    depth: 0,
                })
            }
            // Not turned on.
            Tag::DefinitionList
            | Tag::DefinitionListTitle
            | Tag::DefinitionListDefinition
            | Tag::MetadataBlock(_) => {}
        }
    }

    fn end(&mut self, tag: TagEnd) {
        match tag {
            TagEnd::Paragraph => self.push("</p>"),
            TagEnd::HtmlBlock => {
                let kept = self.out.trim_end_matches('\n').len();
                self.out.truncate(kept);
                self.push("</p>");
            }
            TagEnd::Heading(level) => self.push(&format!("</h{}>", level as usize)),
            TagEnd::BlockQuote(_) => self.push("</blockquote>"),
            TagEnd::CodeBlock => self.push("</code></pre>"),
            TagEnd::List(true) => self.push("</ol>"),
            TagEnd::List(false) => self.push("</ul>"),
            TagEnd::Item => self.push("</li>"),
            TagEnd::FootnoteDefinition => self.push("</div>"),
            TagEnd::Table => self.push("</tbody></table></div>"),
            TagEnd::TableHead => {
                self.in_head = false;
                self.push("</tr></thead><tbody>");
            }
            TagEnd::TableRow => self.push("</tr>"),
            TagEnd::TableCell if self.in_head => self.push("</th>"),
            TagEnd::TableCell => self.push("</td>"),
            TagEnd::Emphasis => self.push("</em>"),
            TagEnd::Strong => self.push("</strong>"),
            TagEnd::Strikethrough => self.push("</del>"),
            TagEnd::Superscript => self.push("</sup>"),
            TagEnd::Subscript => self.push("</sub>"),
            TagEnd::Link => self.close_link(),
            TagEnd::Image => {}
            TagEnd::DefinitionList
            | TagEnd::DefinitionListTitle
            | TagEnd::DefinitionListDefinition
            | TagEnd::MetadataBlock(_) => {}
        }
    }

    fn open_link(&mut self, link_type: LinkType, dest_url: &str) {
        let dest = destination(link_type, dest_url);
        let open = match dest.as_deref().and_then(|d| Some((d, self.links?.get(d)?))) {
            Some((d, Value::Null)) => Some(format!(
                "<a class=\"md-missing\" data-md-missing=\"{}\" role=\"link\" tabindex=\"0\">",
                escaped(d)
            )),
            Some((_, Value::String(href))) if allowed_link(self.plugin, href) => {
                let rel = if href.starts_with("https://") {
                    " rel=\"noopener noreferrer\""
                } else {
                    ""
                };
                Some(format!("<a href=\"{}\"{rel}>", escaped(href)))
            }
            _ => None,
        };
        self.open_links.push(OpenLink {
            open,
            start: self.out.len(),
            target: dest.unwrap_or_else(|| dest_url.to_string()),
            labelled: link_label(link_type),
        });
    }

    fn close_link(&mut self) {
        let Some(link) = self.open_links.pop() else {
            return;
        };
        let mut words = self.out.split_off(link.start);
        if !link.labelled || words.is_empty() {
            words = escaped(&link.target);
        }
        match link.open {
            Some(open) => {
                self.push(&open);
                self.push(&words);
                self.push("</a>");
            }
            None => self.push(&words),
        }
    }

    fn close_image(&mut self) {
        let Some(image) = self.image.take() else {
            return;
        };
        let label = if !image.labelled || image.alt.is_empty() {
            image.target.as_str()
        } else {
            image.alt.as_str()
        };
        let html = match image
            .dest
            .as_deref()
            .and_then(|d| Some((d, self.images?.get(d)?)))
        {
            Some((d, Value::Null)) => format!(
                "<span class=\"figref md-missing\" data-md-missing=\"{0}\">[{0}]</span>",
                escaped(d)
            ),
            Some((_, Value::String(src))) if allowed_image(self.plugin, src) => format!(
                "<img src=\"{}\" alt=\"{}\" loading=\"lazy\">",
                escaped(src),
                escaped(label)
            ),
            _ => format!("[{}]", escaped(label)),
        };
        self.push(&html);
    }
}

/// Whether a link's words are its own: a wikilink without `|` shows its target instead.
fn link_label(link_type: LinkType) -> bool {
    !matches!(link_type, LinkType::WikiLink { has_pothole: false })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::plugins::host::ErrorCode;

    fn md(text: &str) -> String {
        render("obsidian", &json!([text]))
            .unwrap()
            .as_str()
            .unwrap()
            .to_string()
    }

    /// A vault page as Knowledge asks for it: `[md, opts]`.
    fn page(text: &str, opts: Value) -> String {
        render("obsidian", &json!([text, opts]))
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
        assert_eq!(render("obsidian", &json!([42])).unwrap(), json!(""));
        // Quotes in text can't break out of anything.
        assert_eq!(
            md("a \"b\" 'c' & <d>"),
            "<p>a &quot;b&quot; &#39;c&#39; &amp; &lt;d&gt;</p>"
        );
    }

    #[test]
    fn a_null_options_argument_is_the_plain_writer() {
        let text = "# Title\n\n[ok](https://example.com) [[Plan]]";
        assert_eq!(
            render("obsidian", &json!([text, null])).unwrap(),
            json!(md(text))
        );
    }

    #[test]
    fn a_link_is_a_link_only_through_the_map() {
        let opts = json!({"links": {
            "Plan": "#obsidian:knowledge/v/pages/Plan.md",
            "Gone": null,
            "https://example.com/a?b=1&c=2": "https://example.com/a?b=1&c=2",
            "js": "javascript:alert(1)",
            "plain": "http://example.com/",
            "d": "data:text/html,x",
            "other": "#other:knowledge/x",
            "near": "#obsidianx:knowledge/x",
            "brain": "#brain/obsidian:knowledge/x",
            "mail": "echo://mail/abc?x=1",
            "bogus": "echo://bogus/abc",
            "noid": "echo://mail/",
            "space": "https://exa mple.com/",
            "nohost": "https:///x",
            "slash": "https://example.com\\x",
            "ctl": "https://example.com/\u{7}",
            "protocol": "//example.com/x",
            "number": 42,
        }});
        let out = page(
            "[[Plan]] [[Plan|the plan]] [[Gone]] [web](https://example.com/a?b=1&c=2) \
             [x](js) [y](plain) [z](d) [o](other) [n](near) [b](brain) [m](mail) [e](bogus) \
             [i](noid) [s](space) [h](nohost) [k](slash) [c](ctl) [p](protocol) [9](number) \
             [u](https://unmapped.example)",
            opts,
        );
        assert!(
            out.contains("<a href=\"#obsidian:knowledge/v/pages/Plan.md\">Plan</a>"),
            "{out}"
        );
        assert!(
            out.contains("<a href=\"#obsidian:knowledge/v/pages/Plan.md\">the plan</a>"),
            "{out}"
        );
        assert!(
            out.contains(
                "<a class=\"md-missing\" data-md-missing=\"Gone\" role=\"link\" tabindex=\"0\">Gone</a>"
            ),
            "{out}"
        );
        assert!(
            out.contains(
                "<a href=\"https://example.com/a?b=1&amp;c=2\" rel=\"noopener noreferrer\">web</a>"
            ),
            "{out}"
        );
        assert!(
            out.contains("<a href=\"#brain/obsidian:knowledge/x\">b</a>"),
            "{out}"
        );
        assert!(
            out.contains("<a href=\"echo://mail/abc?x=1\">m</a>"),
            "{out}"
        );
        assert_eq!(out.matches("<a ").count(), 6, "{out}");
        for refused in [
            "javascript:",
            "http:",
            "data:",
            "#other",
            "#obsidianx",
            "bogus",
            "echo://mail/\"",
            "exa mple",
            "https:///",
            "\\x",
            "//example.com/x",
            "unmapped",
        ] {
            assert!(!out.contains(refused), "{refused}: {out}");
        }
        assert!(
            out.contains("</a> x y z o n <a") && out.contains("</a> e i s h k c p 9 u</p>"),
            "{out}"
        );
    }

    #[test]
    fn a_wiki_target_is_trimmed_and_loses_a_trailing_backslash() {
        let text =
            "| Page |\n|---|\n| [[Plan\\|the plan]] |\n\n[[ Plan#Goals ]] [[Plan#Goals|goals]]";
        let opts =
            json!({"links": {"Plan": "#obsidian:p/Plan", "Plan#Goals": "#obsidian:p/Plan#Goals"}});
        let out = page(text, opts);
        assert!(
            out.contains("<td><a href=\"#obsidian:p/Plan\">the plan</a></td>"),
            "{out}"
        );
        assert!(
            out.contains("<a href=\"#obsidian:p/Plan#Goals\">Plan#Goals</a>"),
            "{out}"
        );
        assert!(
            out.contains("<a href=\"#obsidian:p/Plan#Goals\">goals</a>"),
            "{out}"
        );
        assert_eq!(
            links(&json!([text])).unwrap(),
            json!({"links": ["Plan", "Plan#Goals"], "images": []})
        );
    }

    #[test]
    fn an_image_comes_only_from_the_plugins_folder_route() {
        let opts = json!({"images": {
            "a.png": "plugin/obsidian/folder/%2FUsers%2Fx/a.png",
            "b.png": "https://example.com/b.png",
            "c.png": "plugin/obsidian/folder/%2FUsers%2Fx/../c.png",
            "d.png": "/plugin/obsidian/folder/x/%2e%2E/d.png",
            "e.png": "plugin/other/folder/x/e.png",
            "f.png": "plugin/obsidian/folder/x/f.png?x=1",
            "g.png": null,
            "h.png": "/plugin/obsidian/folder/v/h.png",
            "i.png": "plugin/obsidian/folder/",
            "j.png": "plugin/obsidian/folder/x/%5C..%5Cj.png",
            "l.png": "plugin/obsidian/folder/x/./l.png",
            "m.png": "data:image/png;base64,AAAA",
        }});
        let out = page(
            "![[a.png]] ![chart](b.png) ![[c.png]] ![[d.png]] ![[e.png]] ![[f.png]] ![[g.png]] \
             ![[h.png|wide]] ![[i.png]] ![[j.png]] ![[k.png]] ![[l.png]] ![[m.png]]",
            opts,
        );
        assert!(
            out.contains(
                "<img src=\"plugin/obsidian/folder/%2FUsers%2Fx/a.png\" alt=\"a.png\" loading=\"lazy\">"
            ),
            "{out}"
        );
        assert!(
            out.contains(
                "<img src=\"/plugin/obsidian/folder/v/h.png\" alt=\"wide\" loading=\"lazy\">"
            ),
            "{out}"
        );
        assert!(
            out.contains(
                "<span class=\"figref md-missing\" data-md-missing=\"g.png\">[g.png]</span>"
            ),
            "{out}"
        );
        assert_eq!(out.matches("<img").count(), 2, "{out}");
        for text in [
            "[chart]", "[c.png]", "[d.png]", "[e.png]", "[f.png]", "[i.png]", "[j.png]", "[k.png]",
            "[l.png]", "[m.png]",
        ] {
            assert!(out.contains(text), "{text}: {out}");
        }
        assert!(
            !out.contains("example.com") && !out.contains("data:"),
            "{out}"
        );
    }

    #[test]
    fn raw_html_stays_text_and_every_attribute_is_escaped() {
        let opts = json!({"links": {
            "a&b \"c\" <d>": null,
            "q": "https://example.com/\"onmouseover=x'",
        }});
        let out = page(
            "<script>alert(1)</script>\n\n<img src=x onerror=alert(1)>\n\n\
             Inline <b onclick=x>b</b> & 'q' [[a&b \"c\" <d>]] [q](q)",
            opts,
        );
        assert!(
            !out.contains("<script") && !out.contains("<img") && !out.contains("<b "),
            "{out}"
        );
        assert!(
            out.contains("&lt;script&gt;alert(1)&lt;/script&gt;"),
            "{out}"
        );
        assert!(out.contains("&lt;img src=x onerror=alert(1)&gt;"), "{out}");
        assert!(
            out.contains("Inline &lt;b onclick=x&gt;b&lt;/b&gt; &amp; &#39;q&#39;"),
            "{out}"
        );
        assert!(
            out.contains("data-md-missing=\"a&amp;b &quot;c&quot; &lt;d&gt;\""),
            "{out}"
        );
        assert!(
            out.contains("href=\"https://example.com/&quot;onmouseover=x&#39;\""),
            "{out}"
        );
    }

    #[test]
    fn tables_task_lists_and_code_blocks_render() {
        let text = "# Title\n\n\
                    | Name | Value |\n|------|------:|\n| a    | `1`   |\n\n\
                    - [ ] todo\n- [x] done\n\n\
                    3. three\n4. four\n\n\
                    ~~gone~~ and a note[^1].\n\n[^1]: The note.\n\n\
                    > quoted\n\n---\n\n\
                    ```rust\nfn main() {}\n```\n\n\
                    ```mermaid\ngraph TD; A-->B\n```\n\n    indented <code>\n";
        let out = page(text, json!({}));
        assert!(out.starts_with("<h1>Title</h1>"), "{out}");
        assert!(!out.contains(" id="), "{out}");
        assert!(
            out.contains(
                "<div class=\"tablewrap\"><table><thead><tr><th>Name</th><th>Value</th></tr></thead>\
                 <tbody><tr><td>a</td><td><code>1</code></td></tr></tbody></table></div>"
            ),
            "{out}"
        );
        assert!(
            out.contains("<li><input type=\"checkbox\" disabled> todo</li>"),
            "{out}"
        );
        assert!(
            out.contains("<li><input type=\"checkbox\" disabled checked> done</li>"),
            "{out}"
        );
        assert!(
            out.contains("<ol start=\"3\"><li>three</li><li>four</li></ol>"),
            "{out}"
        );
        assert!(out.contains("<del>gone</del>"), "{out}");
        assert!(out.contains("<sup class=\"footnote-ref\">1</sup>"), "{out}");
        assert!(out.contains("The note."), "{out}");
        assert!(
            out.contains("<blockquote><p>quoted</p></blockquote><hr>"),
            "{out}"
        );
        assert!(
            out.contains("<pre><code class=\"language-rust\">fn main() {}\n</code></pre>"),
            "{out}"
        );
        assert!(
            out.contains("<pre><code class=\"language-mermaid\">graph TD; A--&gt;B\n</code></pre>"),
            "{out}"
        );
        assert!(
            out.contains("<pre><code>indented &lt;code&gt;\n</code></pre>"),
            "{out}"
        );
    }

    #[test]
    fn breaks_make_a_single_newline_a_line_break() {
        assert_eq!(
            page("a\nb  \nc", json!({"breaks": true})),
            "<p>a<br>\nb<br>\nc</p>"
        );
        assert_eq!(
            page("a\nb  \nc", json!({"breaks": false})),
            "<p>a\nb<br>\nc</p>"
        );
    }

    #[test]
    fn links_lists_each_destination_once_in_order_outside_code() {
        let text = "[[Plan]] and [Plan](Plan) and ![[a.png]] ![alt](img/b.png)\n\n\
                    `[[Code]]` [[Plan]] [[Plan|again]] [ref][r] ![[a.png|small]] [mail](<a@b.c>)\n\n\
                    ```\n[[Fenced]] ![x](f.png)\n```\n\n    [[Indented]]\n\n\
                    <https://auto.example> <a@b.c>\n\n[r]: https://example.com/r\n";
        assert_eq!(
            links(&json!([text])).unwrap(),
            json!({
                "links": ["Plan", "https://example.com/r", "a@b.c", "https://auto.example"],
                "images": ["a.png", "img/b.png"],
            })
        );
        assert_eq!(
            links(&json!([text, {"detail": true}])).unwrap()["entries"],
            json!([
                {"dest": "Plan", "kind": "wiki", "embed": false},
                {"dest": "Plan", "kind": "md", "embed": false},
                {"dest": "a.png", "kind": "wiki", "embed": true},
                {"dest": "img/b.png", "kind": "md", "embed": true},
                {"dest": "https://example.com/r", "kind": "md", "embed": false},
                {"dest": "a@b.c", "kind": "md", "embed": false},
                {"dest": "https://auto.example", "kind": "md", "embed": false},
            ])
        );
        assert_eq!(
            links(&json!([""])).unwrap(),
            json!({"links": [], "images": []})
        );
        // A destination the page doesn't map stays words when it is rendered.
        let out = page(text, json!({}));
        assert!(!out.contains("<a") && !out.contains("<img"), "{out}");
        assert!(out.contains("<code>[[Code]]</code>"), "{out}");
        assert!(out.contains("[[Fenced]] ![x](f.png)"), "{out}");
    }

    #[test]
    fn two_megabytes_of_text_at_most() {
        let fits = "a".repeat(2 << 20);
        let over = format!("{fits}a");
        assert!(render("obsidian", &json!([fits, {}])).is_ok());
        assert!(links(&json!([fits])).is_ok());
        for e in [
            render("obsidian", &json!([over, {}])).unwrap_err(),
            links(&json!([over])).unwrap_err(),
        ] {
            assert_eq!(e.code, ErrorCode::PluginError);
            assert_eq!(e.message, "ctx.markdown renders 2 MB of text at most");
        }
        // The plain writer cuts a long text instead.
        assert!(render("obsidian", &json!([over])).is_ok());
    }
}
