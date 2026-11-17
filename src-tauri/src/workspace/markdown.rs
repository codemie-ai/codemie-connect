//! Claude's automation results (DESIGN 6.6, ruling R26). Claude writes them after reading
//! other people's mail, so the Markdown is untrusted. It is parsed with `pulldown-cmark` and
//! rebuilt from the parse, never patched as a string. Only paragraphs, headings (all shown as
//! level 3), list items (flattened to one level), bold, italic, plain text, line breaks and
//! links to `http`/`https` addresses survive. Everything else becomes plain text: images keep
//! only their alt text (nothing is ever loaded), HTML is literal text, inline code is text, and
//! a link (inline, reference or autolink) to any other kind of address keeps only its words.
//!
//! The result comes in two forms built from the same walk:
//! - [`Block`]s: what the UI renders. It escapes every `text` and takes `href` only from a
//!   block. It never parses Markdown.
//! - Canonical Markdown for copy and export, in which every text run is escaped so that it
//!   cannot form any syntax.
use super::prompts::{cap_chars, clean_output};
use pulldown_cmark::{Event, Options, Parser, Tag, TagEnd};
use serde::Serialize;

const MAX_CHARS: usize = 8_000;
const MAX_LINK_CHARS: usize = 2_000;
/// ASCII punctuation that can start or close Markdown syntax; escaped in every text run.
const SPECIAL: &str = "\\`*_{}[]()#+-!<>|~&=";

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum BlockKind {
    Heading,
    Paragraph,
    Item,
}

/// A run of text with one style. A hard line break is a `\n` in `text`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct Inline {
    pub text: String,
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    pub bold: bool,
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    pub italic: bool,
    /// Only ever an `http`/`https` address that passed [`web_link`].
    #[serde(skip_serializing_if = "Option::is_none")]
    pub href: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct Block {
    #[serde(rename = "type")]
    pub kind: BlockKind,
    pub inlines: Vec<Inline>,
}

/// A result in both forms.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Normalised {
    pub markdown: String,
    pub blocks: Vec<Block>,
}

/// Parses Claude's Markdown and rebuilds it from the parse (see the module docs).
pub fn normalise(text: &str) -> Normalised {
    let blocks = fit(blocks(text, MAX_CHARS));
    Normalised {
        markdown: render(&blocks),
        blocks,
    }
}

/// The [`Block`]s that survive of untrusted Markdown (see the module docs), read from at most
/// `max_chars` of it.
pub fn blocks(text: &str, max_chars: usize) -> Vec<Block> {
    let source = cap_chars(&clean_output(text), max_chars);
    let mut walk = Walk::default();
    for event in Parser::new_ext(&source, Options::empty()) {
        walk.event(event);
    }
    walk.close();
    walk.blocks
}

/// [`Block`]s as HTML, for a plugin's `ctx.markdown`: `<h3>`, `<p>`, `<ul><li>`, `<strong>`,
/// `<em>`, `<br>` and `<a href rel="noopener noreferrer">` with a [`web_link`] address. Every text
/// and address is escaped; nothing else is ever written, so no raw HTML gets through.
pub fn html(blocks: &[Block]) -> String {
    let mut out = String::new();
    let mut in_list = false;
    for block in blocks {
        let item = block.kind == BlockKind::Item;
        if item != in_list {
            out.push_str(if item { "<ul>" } else { "</ul>" });
            in_list = item;
        }
        let tag = match block.kind {
            BlockKind::Heading => "h3",
            BlockKind::Paragraph => "p",
            BlockKind::Item => "li",
        };
        out.push_str(&format!("<{tag}>"));
        for inline in &block.inlines {
            let mut text = html_escape(&inline.text).replace('\n', "<br>");
            if inline.italic {
                text = format!("<em>{text}</em>");
            }
            if inline.bold {
                text = format!("<strong>{text}</strong>");
            }
            if let Some(href) = &inline.href {
                text = format!(
                    "<a href=\"{}\" rel=\"noopener noreferrer\">{text}</a>",
                    html_escape(href)
                );
            }
            out.push_str(&text);
        }
        out.push_str(&format!("</{tag}>"));
    }
    if in_list {
        out.push_str("</ul>");
    }
    out
}

fn html_escape(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    for c in text.chars() {
        match c {
            '&' => out.push_str("&amp;"),
            '<' => out.push_str("&lt;"),
            '>' => out.push_str("&gt;"),
            '"' => out.push_str("&quot;"),
            '\'' => out.push_str("&#39;"),
            c => out.push(c),
        }
    }
    out
}

/// The blocks whose Markdown fits in [`MAX_CHARS`] (escaping can double the text): whole
/// blocks while they fit, cut on a block boundary. Only a first block that is too long on its
/// own is shortened, ending in "…", so a result is never empty.
fn fit(blocks: Vec<Block>) -> Vec<Block> {
    let mut kept: Vec<Block> = Vec::new();
    let mut used = 0;
    for block in blocks {
        let size = render_block(&block, kept.last(), &mut String::new());
        if used + size <= MAX_CHARS {
            used += size;
            kept.push(block);
            continue;
        }
        if !kept.is_empty() {
            break;
        }
        // The longest start of the block that still fits, found by halving.
        let total: usize = block.inlines.iter().map(|i| i.text.chars().count()).sum();
        let (mut low, mut high) = (0, total);
        while low < high {
            let mid = (low + high).div_ceil(2);
            let size = render_block(&shorten(&block, mid), kept.last(), &mut String::new());
            if used + size <= MAX_CHARS {
                low = mid;
            } else {
                high = mid - 1;
            }
        }
        if low > 0 {
            kept.push(shorten(&block, low));
        }
        break;
    }
    kept
}

/// The first `chars` characters of `block`'s text, ending in "…" (counted).
fn shorten(block: &Block, chars: usize) -> Block {
    let mut left = chars.saturating_sub(1);
    let mut inlines = Vec::new();
    for inline in &block.inlines {
        if left == 0 {
            break;
        }
        let text: String = inline.text.chars().take(left).collect();
        left -= text.chars().count();
        inlines.push(Inline {
            text,
            ..inline.clone()
        });
    }
    match inlines.last_mut() {
        Some(last) => last.text.push('…'),
        None => inlines.push(Inline {
            text: "…".into(),
            bold: false,
            italic: false,
            href: None,
        }),
    }
    Block {
        kind: block.kind,
        inlines,
    }
}

/// The address a link may keep: it parses as an `http` or `https` URL with a host and no user
/// name or password, and its text holds no control character, space, quote, angle bracket,
/// backslash or backtick (entities are already decoded by the parser, so `&#x22;` counts as a
/// quote). It is written percent-encoded, with nothing that could end a Markdown link.
fn web_link(destination: &str) -> Option<String> {
    if destination.chars().count() > MAX_LINK_CHARS
        || destination.chars().any(|c| {
            c.is_control() || c.is_whitespace() || matches!(c, '"' | '\'' | '<' | '>' | '\\' | '`')
        })
    {
        return None;
    }
    let url = url::Url::parse(destination).ok()?;
    let web = matches!(url.scheme(), "http" | "https")
        && url.host_str().is_some_and(|h| !h.is_empty())
        && url.username().is_empty()
        && url.password().is_none();
    web.then(|| {
        url.as_str()
            .chars()
            .map(|c| match c {
                '(' | ')' | '<' | '>' | '"' | '\'' | '\\' | '`' | ' ' => {
                    format!("%{:02X}", c as u32)
                }
                c => c.to_string(),
            })
            .collect()
    })
}

/// The state of the walk over the parser's events.
#[derive(Default)]
struct Walk {
    blocks: Vec<Block>,
    current: Option<Block>,
    /// List items we are inside; their paragraphs join the item.
    items: usize,
    strong: usize,
    emphasis: usize,
    /// One entry per open link: its address when it may keep it.
    links: Vec<Option<String>>,
}

impl Walk {
    fn event(&mut self, event: Event) {
        match event {
            Event::Start(tag) => self.start(tag),
            Event::End(tag) => self.end(tag),
            Event::Text(t)
            | Event::Code(t)
            | Event::Html(t)
            | Event::InlineHtml(t)
            | Event::InlineMath(t)
            | Event::DisplayMath(t)
            | Event::FootnoteReference(t) => self.text(&t.replace(['\r', '\n'], " ")),
            Event::SoftBreak => self.text(" "),
            Event::HardBreak => self.text("\n"),
            Event::TaskListMarker(done) => self.text(if done { "[x] " } else { "[ ] " }),
            Event::Rule => self.close(),
        }
    }

    fn start(&mut self, tag: Tag) {
        match tag {
            Tag::Heading { .. } => self.open(BlockKind::Heading),
            Tag::Item => {
                self.items += 1;
                self.open(BlockKind::Item);
            }
            // Block quotes, code and HTML blocks become paragraphs of text; inside an item they
            // continue it.
            Tag::Paragraph | Tag::BlockQuote(_) | Tag::CodeBlock(_) | Tag::HtmlBlock => {
                if self.items == 0 {
                    self.open(BlockKind::Paragraph);
                } else {
                    self.separate();
                }
            }
            Tag::Strong => self.strong += 1,
            Tag::Emphasis => self.emphasis += 1,
            Tag::Link { dest_url, .. } => self.links.push(web_link(&dest_url)),
            // An image is only its alt text, which arrives as text events.
            Tag::Image { .. } => {}
            _ => {}
        }
    }

    fn end(&mut self, tag: TagEnd) {
        match tag {
            TagEnd::Heading(_) => self.close(),
            TagEnd::Item => {
                self.items = self.items.saturating_sub(1);
                self.close();
            }
            TagEnd::Paragraph | TagEnd::BlockQuote(_) | TagEnd::CodeBlock | TagEnd::HtmlBlock => {
                if self.items == 0 {
                    self.close();
                }
            }
            TagEnd::Strong => self.strong = self.strong.saturating_sub(1),
            TagEnd::Emphasis => self.emphasis = self.emphasis.saturating_sub(1),
            TagEnd::Link => {
                self.links.pop();
            }
            _ => {}
        }
    }

    fn open(&mut self, kind: BlockKind) {
        self.close();
        self.current = Some(Block {
            kind,
            inlines: Vec::new(),
        });
    }

    /// A second paragraph (or quote, or code) in the same item: a space between them.
    fn separate(&mut self) {
        if self.current.as_ref().is_some_and(|b| !b.inlines.is_empty()) {
            self.text(" ");
        }
    }

    fn close(&mut self) {
        let Some(mut block) = self.current.take() else {
            return;
        };
        if let Some(first) = block.inlines.first_mut() {
            first.text = first.text.trim_start().to_string();
        }
        if let Some(last) = block.inlines.last_mut() {
            last.text = last.text.trim_end().to_string();
        }
        block.inlines.retain(|i| !i.text.is_empty());
        if !block.inlines.is_empty() {
            self.blocks.push(block);
        }
    }

    fn text(&mut self, text: &str) {
        if text.is_empty() {
            return;
        }
        if self.current.is_none() {
            self.open(if self.items > 0 {
                BlockKind::Item
            } else {
                BlockKind::Paragraph
            });
        }
        let inline = Inline {
            text: text.to_string(),
            bold: self.strong > 0,
            italic: self.emphasis > 0,
            href: self.links.last().cloned().flatten(),
        };
        let Some(block) = self.current.as_mut() else {
            return;
        };
        match block.inlines.last_mut() {
            Some(last)
                if last.bold == inline.bold
                    && last.italic == inline.italic
                    && last.href == inline.href =>
            {
                last.text.push_str(&inline.text)
            }
            _ => block.inlines.push(inline),
        }
    }
}

/// Canonical Markdown of `blocks`: `### ` headings, `- ` items, paragraphs, every text run
/// escaped.
fn render(blocks: &[Block]) -> String {
    let mut out = String::new();
    for (n, block) in blocks.iter().enumerate() {
        render_block(block, n.checked_sub(1).map(|p| &blocks[p]), &mut out);
    }
    out
}

/// Appends one block (with the break from `previous`) to `out`; returns how many characters
/// it added.
fn render_block(block: &Block, previous: Option<&Block>, out: &mut String) -> usize {
    let before = out.chars().count();
    if let Some(previous) = previous {
        let list = block.kind == BlockKind::Item && previous.kind == BlockKind::Item;
        out.push_str(if list { "\n" } else { "\n\n" });
    }
    out.push_str(match block.kind {
        BlockKind::Heading => "### ",
        BlockKind::Item => "- ",
        BlockKind::Paragraph => "",
    });
    // The text after a heading or item marker counts as the start of a line too, so
    // "1. x" in an item can never become a nested list.
    let mut line_start = true;
    for inline in &block.inlines {
        render_inline(inline, &mut line_start, out);
    }
    out.chars().count() - before
}

fn render_inline(inline: &Inline, line_start: &mut bool, out: &mut String) {
    // Emphasis markers must touch the words, so surrounding spaces stay outside them.
    let core = inline.text.trim_matches(|c| c == ' ' || c == '\t');
    let lead =
        &inline.text[..inline.text.len() - inline.text.trim_start_matches([' ', '\t']).len()];
    let trail = &inline.text[inline.text.trim_end_matches([' ', '\t']).len()..];
    let marker = match (inline.bold, inline.italic) {
        (true, true) => "***",
        (true, false) => "**",
        (false, true) => "*",
        (false, false) => "",
    };
    escape(lead, line_start, out);
    if core.is_empty() {
        return;
    }
    if inline.href.is_some() {
        out.push('[');
    }
    out.push_str(marker);
    escape(core, line_start, out);
    out.push_str(marker);
    if let Some(href) = &inline.href {
        out.push_str("](");
        // A destination is read for entities again: `&` must stay `&` (`&amp;commat;` was
        // decoded once to `&commat;` and must not become `@` now).
        out.push_str(&href.replace('&', "\\&"));
        out.push(')');
    }
    escape(trail, line_start, out);
}

/// `text` with every character that could form Markdown syntax backslash-escaped: [`SPECIAL`]
/// everywhere, and `.` or `)` after the digits that start a line (an ordered-list marker).
/// Spaces at the start of a line are dropped, so nothing becomes indented code.
fn escape(text: &str, line_start: &mut bool, out: &mut String) {
    let mut digits = false;
    for c in text.chars() {
        if c == '\n' {
            out.push_str("\\\n");
            *line_start = true;
            digits = false;
            continue;
        }
        if *line_start && (c == ' ' || c == '\t') {
            continue;
        }
        let after_digits = digits;
        digits = (*line_start || digits) && c.is_ascii_digit();
        if SPECIAL.contains(c) || (after_digits && matches!(c, '.' | ')')) {
            out.push('\\');
        }
        out.push(c);
        *line_start = false;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Whatever went in, the result is safe in both forms: parsing the Markdown again finds no
    /// image, no HTML and no link except to `allowed`, and no block links anywhere else.
    fn assert_safe(input: &str, allowed: &[&str]) -> Normalised {
        let out = normalise(input);
        for event in Parser::new_ext(&out.markdown, Options::empty()) {
            match event {
                Event::Start(Tag::Image { dest_url, .. }) => {
                    panic!("image {dest_url:?} from {input:?}: {:?}", out.markdown)
                }
                Event::Html(h) | Event::InlineHtml(h) => {
                    panic!("HTML {h:?} from {input:?}: {:?}", out.markdown)
                }
                Event::Start(Tag::Link { dest_url, .. }) => assert!(
                    allowed.contains(&dest_url.as_ref()),
                    "link {dest_url:?} from {input:?}: {:?}",
                    out.markdown
                ),
                _ => {}
            }
        }
        for inline in out.blocks.iter().flat_map(|b| &b.inlines) {
            if let Some(href) = &inline.href {
                assert!(
                    allowed.contains(&href.as_str()),
                    "href {href:?} from {input:?}"
                );
                assert!(href.starts_with("https://") || href.starts_with("http://"));
            }
        }
        out
    }

    /// All the words of a result, as the UI shows them.
    fn words(out: &Normalised) -> String {
        out.blocks
            .iter()
            .map(|b| {
                b.inlines
                    .iter()
                    .map(|i| i.text.as_str())
                    .collect::<String>()
            })
            .collect::<Vec<_>>()
            .join(" | ")
    }

    fn plain(text: &str) -> Inline {
        Inline {
            text: text.into(),
            bold: false,
            italic: false,
            href: None,
        }
    }

    #[test]
    fn keeps_headings_items_bold_italic_and_web_links() {
        let out = assert_safe(
            "# Day\n#### Deep\n\n* one\n+ two\n  1. nested\n\n**Bold**, *quiet* and [site](https://example.test/a?b=1)",
            &["https://example.test/a?b=1"],
        );
        let kinds: Vec<BlockKind> = out.blocks.iter().map(|b| b.kind).collect();
        use BlockKind::*;
        assert_eq!(kinds, [Heading, Heading, Item, Item, Item, Paragraph]);
        assert_eq!(
            out.blocks[5].inlines,
            vec![
                Inline {
                    bold: true,
                    ..plain("Bold")
                },
                plain(", "),
                Inline {
                    italic: true,
                    ..plain("quiet")
                },
                plain(" and "),
                Inline {
                    href: Some("https://example.test/a?b=1".into()),
                    ..plain("site")
                },
            ]
        );
        assert_eq!(
            out.markdown,
            "### Day\n\n### Deep\n\n- one\n- two\n- nested\n\n**Bold**, *quiet* and [site](https://example.test/a?b=1)"
        );
        assert_eq!(
            serde_json::to_value(&out.blocks[5]).unwrap()["inlines"][4],
            serde_json::json!({"text": "site", "href": "https://example.test/a?b=1"})
        );
    }

    #[test]
    fn html_images_and_code_are_only_text() {
        for input in [
            "Hi <img src=x onerror=alert(1)> there",
            "<img src=x onerror=alert(1)>",
            "<a href=\"javascript:alert(1)\">x</a>",
            "<a href=javascript:alert(1)>x</a>",
            "<javascript:alert(1)>",
            "<!-- hidden --> text",
            "<script>alert(1)</script>",
            "![pixel](https://t.example/p.png)",
            "!`[x](https://t.example/p.png?d=secret)`",
            "`<b>` and\n```html\n<img src=x>\n```",
        ] {
            let out = assert_safe(input, &[]);
            assert!(!out.blocks.is_empty(), "{input:?} kept no text");
        }
        assert_eq!(
            words(&assert_safe("Hi <img src=x onerror=alert(1)> there", &[])),
            "Hi <img src=x onerror=alert(1)> there"
        );
        assert_eq!(
            words(&assert_safe("![pixel](https://t.example/p.png)", &[])),
            "pixel"
        );
        assert_eq!(
            words(&assert_safe(
                "!`[x](https://t.example/p.png?d=secret)`",
                &[]
            )),
            "![x](https://t.example/p.png?d=secret)"
        );
    }

    #[test]
    fn links_to_anything_but_the_web_keep_only_their_words() {
        for (input, text) in [
            ("[x](JaVaScRiPt:alert(1))", "x"),
            ("[x](data:text/html;base64,PHNjcmlwdD4=)", "x"),
            ("[x](//evil.com)", "x"),
            ("[x](&#x6A;avascript:alert(1))", "x"),
            ("[x](https://ok.test&#x22;onmouseover=alert(1))", "x"),
            ("[x](https://user:pw@ok.test/)", "x"),
            ("[x](mailto:a@b.test)", "x"),
            ("[x](file:///etc/passwd)", "x"),
            ("[[b]](javascript:alert(1))", "[b]"),
            ("[a [b] c](javascript:alert(1))", "a [b] c"),
            ("[![i](https://ok.test/p.png)](javascript:alert(1))", "i"),
            (
                "[a\\](https://ok.test)](javascript:alert(1))",
                "a](https://ok.test)",
            ),
            // Split across lines: inside the text, before the address, inside the address.
            ("[split\ntext](javascript:alert(1))", "split text"),
            ("[t](\njavascript:alert(1)\n)", "t"),
            ("[t](javascript:alert(1)\n\"title\")", "t"),
        ] {
            let out = assert_safe(input, &[]);
            assert_eq!(words(&out), text, "{input:?}");
        }
        // Not a link at all: the words stay as they were written.
        let out = assert_safe("[t]\n(javascript:alert(1))", &[]);
        assert_eq!(words(&out), "[t] (javascript:alert(1))");
        // Double-encoded entities: the first parse leaves `&commat;` in a web address; written
        // back unescaped, a second parse would turn it into `@` (a user name), a quote, a line
        // break, a tag or a backslash. Every link must read back exactly as it was kept.
        for input in [
            "[x](https://ok.test&amp;commat;evil.test/)",
            "[x](https://ok.test/&amp;quot;onmouseover=alert(1))",
            "[x](https://ok.test/a&amp;#10;b)",
            "[x](https://ok.test/a&amp;Tab;b)",
            "[x](https://ok.test/&amp;lt;script&amp;gt;)",
            "[x](https://ok.test/&amp;bsol;x)",
        ] {
            let out = assert_same_links(input);
            assert_eq!(words(&out), "x", "{input:?}");
        }
        let out = assert_same_links("[x](https://ok.test/?a=1&b=2)");
        assert_eq!(
            out.blocks[0].inlines[0].href.as_deref(),
            Some("https://ok.test/?a=1&b=2")
        );
    }

    /// [`assert_safe`] allowing exactly the links the blocks kept: parsing the Markdown again
    /// must give back the same addresses, each still a web address on its own.
    fn assert_same_links(input: &str) -> Normalised {
        let kept: Vec<String> = normalise(input)
            .blocks
            .iter()
            .flat_map(|b| &b.inlines)
            .filter_map(|i| i.href.clone())
            .collect();
        for href in &kept {
            assert_eq!(web_link(href).as_deref(), Some(href.as_str()), "{input:?}");
            assert!(!href.contains('@'), "{href:?} from {input:?}");
        }
        let allowed: Vec<&str> = kept.iter().map(String::as_str).collect();
        assert_safe(input, &allowed)
    }

    #[test]
    fn reference_links_and_autolinks_follow_the_same_rule() {
        for (input, text) in [
            ("See [x][1].\n\n[1]: javascript:alert(1)", "See x."),
            ("See [x][].\n\n[x]: javascript:alert(1)", "See x."),
            ("See [x].\n\n[x]: data:text/html,hi", "See x."),
            // A definition inside a list item, and a label split across lines.
            ("- [x][r]\n- [r]: javascript:alert(1)", "x"),
            ("[x][a\nb]\n\n[a\nb]: javascript:alert(1)", "x"),
            ("<javascript:alert(1)>", "javascript:alert(1)"),
            ("<mailto:a@b.test>", "mailto:a@b.test"),
        ] {
            let out = assert_safe(input, &[]);
            assert_eq!(words(&out), text, "{input:?}");
        }
        let out = assert_safe(
            "See [the plan][p] and <https://ok.test/doc>.\n\n[p]: https://example.test/plan",
            &["https://example.test/plan", "https://ok.test/doc"],
        );
        assert_eq!(
            out.markdown,
            "See [the plan](https://example.test/plan) and [https://ok.test/doc](https://ok.test/doc)."
        );
    }

    #[test]
    fn text_that_looks_like_syntax_stays_text() {
        let out = assert_safe("[Note]: remember to call Ann", &[]);
        assert_eq!(
            words(&out),
            "[Note]: remember to call Ann",
            "no silent loss"
        );
        assert_eq!(out.markdown, "\\[Note\\]: remember to call Ann");
        // Escaped text that would read as syntax once unescaped stays text after a round trip.
        for input in [
            "\\# not a heading",
            "\\- not an item",
            "1\\. not a list",
            "\\[x\\](javascript:alert(1))",
            "\\!\\[x\\](https://t.example/p.png)",
            "\\<img src=x onerror=alert(1)\\>",
            "&lt;img src=x&gt;",
            "a  \nb",
        ] {
            let out = assert_safe(input, &[]);
            let again = assert_safe(&out.markdown, &[]);
            assert_eq!(again.blocks, out.blocks, "{input:?}");
        }
        assert_eq!(words(&assert_safe("a  \nb", &[])), "a\nb");
        assert_eq!(assert_safe("a  \nb", &[]).markdown, "a\\\nb");
        assert_eq!(assert_safe("- 1\\. x", &[]).markdown, "- 1\\. x");
    }

    #[test]
    fn web_links_are_written_so_they_cannot_break_out() {
        let out = assert_safe(
            "[a](https://example.test/a_(b)?q=x y) [b](<https://example.test/sp ace>)",
            &[],
        );
        // An address with a space is not a link.
        assert!(out.blocks[0].inlines.iter().all(|i| i.href.is_none()));
        let out = assert_safe(
            "[a](https://example.test/a_(b))",
            &["https://example.test/a_%28b%29"],
        );
        assert_eq!(out.markdown, "[a](https://example.test/a_%28b%29)");
    }

    #[test]
    fn output_is_capped() {
        let out = normalise(&"x".repeat(9_000));
        assert_eq!(out.markdown.chars().count(), 8_000);
        // Escaping can double the length: the rebuilt Markdown is capped too, and the blocks
        // say exactly what it says.
        let out = assert_safe(&"[".repeat(100_000), &[]);
        assert!(
            out.markdown.chars().count() <= 8_000,
            "{}",
            out.markdown.len()
        );
        assert_eq!(render(&out.blocks), out.markdown);
        assert!(words(&out).ends_with('…'));
        let many: String = (0..2_000)
            .map(|n| format!("- item {n} with [brackets]\n"))
            .collect();
        let out = assert_safe(&many, &[]);
        assert!(out.markdown.chars().count() <= 8_000);
        assert_eq!(render(&out.blocks), out.markdown);
        assert!(
            out.markdown.ends_with("\\]"),
            "cut on a block boundary: {:?}",
            &out.markdown[out.markdown.len() - 40..]
        );
    }
}
