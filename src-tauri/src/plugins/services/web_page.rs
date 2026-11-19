//! `ctx.web.read` and `ctx.web.markdown` without the network (Echo's plugin-api.md, "Reading a
//! web page (`ctx.web`)"): a page's HTML in, what it says out. The caller fetches the page (the
//! grant, a plain GET, no redirect, its size and time) and saves its pictures; this reads it.
//!
//! The answer is the page's main part (the largest `<article>`, else `<main>`, else
//! `[role=main]`, else `<body>`) as Markdown in which the page's words are never markup, with the
//! links and pictures in it, and what the page says of itself. Nothing a page holds is run:
//! scripts, styles, navigation, page headers and footers, asides, forms, frames, objects, SVG,
//! templates and hidden elements are left out, and a link or a picture keeps only an absolute
//! `http(s)` address (any other link is its words). A page that builds itself with scripts is
//! read from what it embeds — JSON-LD's `articleBody`, its `<noscript>`, its description — when
//! that is clearly fuller than its HTML.
use dom_query::{Document, NodeId, NodeRef};
use serde_json::{Map, Value};
use std::collections::HashSet;
use url::Url;

/// The Markdown is at most this and ten times the HTML, whatever `max` is.
const MAX_MARKDOWN: usize = 20 * 1024 * 1024;
const MAX_LINKS: usize = 2000;
const MAX_IMAGES: usize = 500;
/// A link's text, a picture's alt and its caption, in characters.
const MAX_WORDS: usize = 500;
/// A link's or a picture's address once resolved, in bytes.
const MAX_ADDRESS: usize = 2048;
/// Deeper elements keep only their words.
const MAX_DEPTH: usize = 256;
/// Elements and text pieces read; the rest is left out (`truncated`).
const MAX_NODES: usize = 250_000;
/// An embedded JSON (JSON-LD) larger than this isn't read.
const MAX_JSON: usize = 2 * 1024 * 1024;
const MAX_COLUMNS: usize = 64;
/// Levels of list items with a marker; a deeper item's words sit at the last level's indent.
const MAX_LIST_LEVELS: usize = 8;
const MAX_LIST_START: i64 = 1_000_000;
/// Under this many characters of words, a page with scripts needs them to show anything.
const NEEDS_JS_CHARS: usize = 200;
/// A picture the page gives a smaller width or height is an icon or a tracker.
const MIN_PICTURE: u32 = 32;

/// Never part of the page's words.
const LEFT_OUT: &[&str] = &[
    "script", "style", "noscript", "template", "svg", "nav", "header", "footer", "aside", "form",
    "iframe", "frame", "frameset", "object", "embed", "button", "input", "select", "textarea",
    "canvas", "video", "audio", "map", "head", "title", "meta", "link", "base",
];
/// The same parts of a page, named by their ARIA role.
const LEFT_OUT_ROLES: &[&str] = &["navigation", "banner", "contentinfo", "complementary"];
/// Elements that stand as blocks: a paragraph ends before them.
const BLOCKS: &[&str] = &[
    "address",
    "article",
    "blockquote",
    "body",
    "caption",
    "center",
    "dd",
    "details",
    "dialog",
    "div",
    "dl",
    "dt",
    "fieldset",
    "figcaption",
    "figure",
    "h1",
    "h2",
    "h3",
    "h4",
    "h5",
    "h6",
    "hgroup",
    "hr",
    "html",
    "legend",
    "li",
    "main",
    "menu",
    "ol",
    "p",
    "pre",
    "search",
    "section",
    "summary",
    "table",
    "tbody",
    "td",
    "tfoot",
    "th",
    "thead",
    "tr",
    "ul",
];
/// Elements within a line of words.
const INLINE: &[&str] = &[
    "a", "abbr", "b", "bdi", "bdo", "big", "br", "cite", "code", "data", "del", "dfn", "em",
    "font", "i", "img", "ins", "kbd", "label", "mark", "nobr", "picture", "q", "rp", "rt", "ruby",
    "s", "samp", "small", "span", "strike", "strong", "sub", "sup", "time", "tt", "u", "var",
    "wbr",
];
/// The page's words that Markdown or GFM would read as markup wherever they stand.
const MARKS: &str = "\\`*_~[]()<>|#!{}";

/// What a page says, from its HTML: `ctx.web.read`'s answer without `url` and `bytes` (the
/// caller's), its `images` not yet saved.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct PageText {
    /// Its main part's first `<h1>`, else JSON-LD's `headline`, else `og:title`, else `<title>`;
    /// not repeated in `markdown`.
    pub title: String,
    pub markdown: String,
    /// Something was left out: the Markdown reached `max`, or the page passed one of its bounds.
    pub truncated: bool,
    /// `(text, href)` for each address the Markdown links to, once each, in order.
    pub links: Vec<(String, String)>,
    /// The pictures in the Markdown, once each, in order; then `og:image` and JSON-LD's.
    pub images: Vec<PageImage>,
    pub lang: Option<String>,
    pub byline: Option<String>,
    pub published: Option<String>,
    pub description: Option<String>,
    /// Where `markdown` came from: `html`, `json-ld`, `noscript`, or `meta` (its description
    /// alone).
    pub source: String,
    /// Under 200 characters of words on a page with scripts.
    pub needs_js: bool,
}

/// A picture of the page. The Markdown shows it in place as `![alt](src)`, `src` with `|` and a
/// backtick percent-encoded (and parentheses too, when they aren't balanced).
#[derive(Debug, Clone, Default, PartialEq)]
pub struct PageImage {
    /// An absolute `http(s)` address.
    pub src: String,
    pub alt: String,
    /// The caption of the figure it is in.
    pub caption: Option<String>,
    /// As the page gives them.
    pub width: Option<u32>,
    pub height: Option<u32>,
}

/// What a page says, from its HTML: `url` is the address it was read from (relative links and
/// pictures resolve against it, or against the page's `<base href>`; with no address they are
/// words); `max` caps the Markdown in bytes (also at most ten times the HTML, and 20 MB).
pub fn read_html(url: &str, html: &str, max: usize) -> PageText {
    let budget = max.min(MAX_MARKDOWN).min(html.len().saturating_mul(10));
    let doc = Document::from(html);
    let page = scan(doc.root());
    let at = Url::parse(url).ok();
    let base = page
        .base
        .as_deref()
        .and_then(|b| match &at {
            Some(u) => u.join(b).ok(),
            None => Url::parse(b).ok(),
        })
        .or_else(|| at.clone());
    let addr = Addresses {
        base: base.as_ref(),
        page: at.as_ref(),
    };
    let ld = json_ld(&page.json_ld);

    let main = page.main();
    let h1 = main.and_then(|m| m.descendants_it().find(|n| is_named(n, "h1")));
    let h1_title = h1
        .map(|h| plain(h, usize::MAX, false))
        .filter(|t| !t.is_empty());
    let skip = h1_title.as_ref().and(h1).map(|h| h.id);
    let title = h1_title
        .or_else(|| ld.headline.clone())
        .or_else(|| page.meta(&["og:title"]))
        .or_else(|| page.title.clone())
        .or_else(|| page.first_h1.map(|h| plain(h, usize::MAX, false)))
        .unwrap_or_default();

    let mut best = Text::new(addr, budget, "html");
    best.r.skip = skip;
    if let Some(m) = main {
        best.blocks = best.r.blocks_of(m, 0);
    }
    if let Some(body) = &ld.body {
        let alt = Text::json_ld(addr, budget, body);
        if fuller(alt.r.chars, best.r.chars) {
            best = alt;
        }
    }
    if !page.noscripts.is_empty() {
        let mut alt = Text::new(addr, budget, "noscript");
        for n in &page.noscripts {
            let blocks = alt.r.blocks_of(*n, 0);
            alt.blocks.extend(blocks);
        }
        if fuller(alt.r.chars, best.r.chars) {
            best = alt;
        }
    }
    let description = page.meta(&["description", "og:description", "twitter:description"]);
    if best.r.chars == 0 {
        if let Some(d) = page.meta(&["og:description"]).or(description.clone()) {
            let mut alt = Text::new(addr, budget, "meta");
            let mut c = Collect::default();
            alt.r.text(&mut c.para, &d);
            c.flush();
            alt.blocks = c.blocks;
            best = alt;
        }
    }

    let mut w = Writer {
        out: String::new(),
        budget,
        cut: false,
    };
    write_blocks(&mut w, &best.blocks, "", "", false, 0);
    let mut r = best.r;
    for src in page.meta_all("og:image").into_iter().chain(ld.images) {
        if let Some(u) = addr.resolve(&src) {
            r.add_image(u.into(), String::new(), None, None);
        }
    }
    let needs_js = r.chars < NEEDS_JS_CHARS && (page.scripts > 0 || !page.noscripts.is_empty());
    PageText {
        title,
        markdown: w.out.trim_end().to_string(),
        truncated: w.cut || r.truncated,
        links: r.links,
        images: r.images,
        lang: page
            .lang
            .clone()
            .or_else(|| page.meta(&["content-language"])),
        byline: page.meta(&["author"]).or(ld.author).or_else(|| {
            page.meta(&["article:author"])
                .filter(|a| !a.starts_with("http"))
        }),
        published: page
            .meta(&["article:published_time", "datepublished"])
            .or(ld.published)
            .or_else(|| {
                page.meta(&[
                    "date",
                    "pubdate",
                    "publishdate",
                    "publish-date",
                    "dc.date",
                    "dc.date.issued",
                    "dcterms.date",
                    "dcterms.created",
                ])
            }),
        description,
        source: best.source.to_string(),
        needs_js,
    }
}

/// An alternative's words are taken when clearly fuller than what was read before.
fn fuller(alternative: usize, read: usize) -> bool {
    alternative > read + read / 2 + 100
}

// ------------------------------------------------------------------ the page around the words

/// What the whole document holds besides its words.
#[derive(Default)]
struct Page<'a> {
    base: Option<String>,
    title: Option<String>,
    lang: Option<String>,
    /// `(key, content)`: a `<meta>`'s `property`, `name`, `itemprop` or `http-equiv` (lowercase),
    /// and a `<time itemprop>`'s `datetime`.
    metas: Vec<(String, String)>,
    json_ld: Vec<String>,
    /// Scripts that would run.
    scripts: usize,
    noscripts: Vec<NodeRef<'a>>,
    articles: Vec<NodeRef<'a>>,
    main: Option<NodeRef<'a>>,
    role_main: Option<NodeRef<'a>>,
    body: Option<NodeRef<'a>>,
    first_h1: Option<NodeRef<'a>>,
}

fn scan(root: NodeRef<'_>) -> Page<'_> {
    let mut p = Page::default();
    // (element, inside a <noscript> or an <svg>), in document order.
    let mut stack: Vec<(NodeRef, bool)> = root
        .children_it(true)
        .filter(|n| n.is_element())
        .map(|n| (n, false))
        .collect();
    while let Some((n, inside)) = stack.pop() {
        let Some(name) = n.node_name() else { continue };
        let attr = |k: &str| n.attr(k).map(|v| v.to_string());
        match &*name {
            "base" if p.base.is_none() => p.base = attr("href"),
            "title" if !inside && p.title.is_none() => {
                p.title = Some(clean(&n.text())).filter(|t| !t.is_empty())
            }
            "html" if p.lang.is_none() => {
                p.lang = attr("lang").map(|l| clean(&l)).filter(|l| !l.is_empty())
            }
            "meta" => {
                if let Some(content) = attr("content") {
                    for k in ["property", "name", "itemprop", "http-equiv"] {
                        if let Some(key) = attr(k) {
                            p.metas
                                .push((key.trim().to_ascii_lowercase(), content.clone()));
                        }
                    }
                }
            }
            "time" => {
                if let (Some(key), Some(at)) = (attr("itemprop"), attr("datetime")) {
                    p.metas.push((key.trim().to_ascii_lowercase(), at));
                }
            }
            "script" => {
                let kind = attr("type").unwrap_or_default().trim().to_ascii_lowercase();
                if kind.contains("ld+json") {
                    let text = n.text();
                    if text.len() <= MAX_JSON {
                        p.json_ld.push(text.to_string());
                    }
                } else if kind.is_empty()
                    || kind == "module"
                    || kind.contains("javascript")
                    || kind.contains("ecmascript")
                {
                    p.scripts += 1;
                }
            }
            "noscript" if !inside => p.noscripts.push(n),
            "article" if !inside && !hidden(&n) => p.articles.push(n),
            "main" if !inside && p.main.is_none() && !hidden(&n) => p.main = Some(n),
            "body" if p.body.is_none() => p.body = Some(n),
            "h1" if !inside && p.first_h1.is_none() => p.first_h1 = Some(n),
            _ => {}
        }
        let role_main = attr("role").is_some_and(|r| r.trim().eq_ignore_ascii_case("main"));
        if role_main && !inside && p.role_main.is_none() && !hidden(&n) {
            p.role_main = Some(n);
        }
        let inside = inside || &*name == "noscript" || &*name == "svg";
        stack.extend(
            n.children_it(true)
                .filter(|c| c.is_element())
                .map(|c| (c, inside)),
        );
    }
    p
}

impl<'a> Page<'a> {
    /// The largest `<article>` with words, else `<main>`, else `[role=main]`, else `<body>`.
    fn main(&self) -> Option<NodeRef<'a>> {
        let mut best: Option<(usize, NodeRef<'a>)> = None;
        for a in &self.articles {
            let len = plain(*a, usize::MAX, false).chars().count();
            if len > 0 && best.is_none_or(|(b, _)| len > b) {
                best = Some((len, *a));
            }
        }
        best.map(|(_, a)| a)
            .or(self.main)
            .or(self.role_main)
            .or(self.body)
    }

    /// The first of these keys' meta values that has words (in the keys' order).
    fn meta(&self, keys: &[&str]) -> Option<String> {
        keys.iter().find_map(|k| {
            self.metas
                .iter()
                .filter(|(key, _)| key == k)
                .map(|(_, v)| clean(v))
                .find(|v| !v.is_empty())
        })
    }

    fn meta_all(&self, key: &str) -> Vec<String> {
        self.metas
            .iter()
            .filter(|(k, _)| k == key)
            .map(|(_, v)| v.trim().to_string())
            .collect()
    }
}

/// What the page's JSON-LD says of its article (the one with the longest `articleBody`, else
/// the first with a `headline`).
#[derive(Default)]
struct Ld {
    headline: Option<String>,
    body: Option<String>,
    author: Option<String>,
    published: Option<String>,
    images: Vec<String>,
}

fn json_ld(texts: &[String]) -> Ld {
    let values: Vec<Value> = texts
        .iter()
        .filter_map(|t| serde_json::from_str(t.trim()).ok())
        .collect();
    let body_len = |o: &Map<String, Value>| {
        o.get("articleBody")
            .and_then(Value::as_str)
            .map_or(0, str::len)
    };
    let mut best: Option<&Map<String, Value>> = None;
    let mut queue: Vec<&Value> = values.iter().collect();
    let mut i = 0;
    while let Some(v) = queue.get(i).copied() {
        i += 1;
        match v {
            Value::Array(a) => queue.extend(a),
            Value::Object(o) => {
                let article = o.contains_key("articleBody") || o.contains_key("headline");
                if article && best.is_none_or(|b| body_len(o) > body_len(b)) {
                    best = Some(o);
                }
                if let Some(g) = o.get("@graph") {
                    queue.push(g);
                }
            }
            _ => {}
        }
    }
    let Some(o) = best else {
        return Ld::default();
    };
    let words = |k: &str| {
        o.get(k)
            .and_then(Value::as_str)
            .map(clean)
            .filter(|v| !v.is_empty())
    };
    Ld {
        headline: words("headline"),
        body: o
            .get("articleBody")
            .and_then(Value::as_str)
            .filter(|b| !b.trim().is_empty())
            .map(str::to_string),
        author: names(o.get("author")),
        published: words("datePublished"),
        images: addresses(o.get("image")),
    }
}

/// JSON-LD's people: a name, `{name}`, or a list of them.
fn names(v: Option<&Value>) -> Option<String> {
    let found: Vec<String> = match v {
        Some(Value::String(s)) => vec![clean(s)],
        Some(Value::Object(o)) => o
            .get("name")
            .and_then(Value::as_str)
            .map(clean)
            .into_iter()
            .collect(),
        Some(Value::Array(a)) => a.iter().filter_map(|x| names(Some(x))).collect(),
        _ => vec![],
    };
    let found: Vec<String> = found.into_iter().filter(|n| !n.is_empty()).collect();
    (!found.is_empty()).then(|| found.join(", "))
}

/// JSON-LD's pictures: an address, `{url}` / `{contentUrl}`, or a list of them.
fn addresses(v: Option<&Value>) -> Vec<String> {
    match v {
        Some(Value::String(s)) => vec![s.clone()],
        Some(Value::Object(o)) => ["url", "contentUrl"]
            .iter()
            .find_map(|k| o.get(*k).and_then(Value::as_str))
            .map(str::to_string)
            .into_iter()
            .collect(),
        Some(Value::Array(a)) => a.iter().flat_map(|x| addresses(Some(x))).collect(),
        _ => vec![],
    }
}

// ------------------------------------------------------------------ addresses

/// Where the page's relative addresses point.
#[derive(Clone, Copy)]
struct Addresses<'u> {
    base: Option<&'u Url>,
    page: Option<&'u Url>,
}

impl Addresses<'_> {
    /// An absolute `http(s)` address without a user part, 2 KB at most.
    fn resolve(&self, raw: &str) -> Option<Url> {
        let raw = raw.trim();
        if raw.is_empty() {
            return None;
        }
        let u = match self.base {
            Some(b) => b.join(raw).ok()?,
            None => Url::parse(raw).ok()?,
        };
        let ok = matches!(u.scheme(), "http" | "https")
            && u.username().is_empty()
            && u.password().is_none()
            && u.as_str().len() <= MAX_ADDRESS;
        ok.then_some(u)
    }

    /// A link's address, or `None` when the link is only its words (not `http(s)`, or one of
    /// the page's own anchors).
    fn link(&self, raw: &str) -> Option<String> {
        if raw.trim_start().starts_with('#') {
            return None;
        }
        let u = self.resolve(raw)?;
        let unanchored = |s: &str| s.split('#').next().map(str::to_string);
        if u.fragment().is_some()
            && self
                .page
                .is_some_and(|p| unanchored(p.as_str()) == unanchored(u.as_str()))
        {
            return None;
        }
        Some(u.into())
    }
}

/// An address as the Markdown writes it: `|` and a backtick percent-encoded (a table and a code
/// span would read them), and parentheses too when they aren't balanced.
fn md_address(a: &str) -> String {
    let s = a.replace('|', "%7C").replace('`', "%60");
    let mut open = 0i32;
    for c in s.chars() {
        match c {
            '(' => open += 1,
            ')' if open == 0 => return s.replace('(', "%28").replace(')', "%29"),
            ')' => open -= 1,
            _ => {}
        }
    }
    if open == 0 {
        s
    } else {
        s.replace('(', "%28").replace(')', "%29")
    }
}

/// A `srcset`'s candidates: (address, width descriptor, density descriptor).
fn srcset(v: &str) -> Vec<(String, Option<f64>, Option<f64>)> {
    let mut out = vec![];
    let mut rest = v;
    loop {
        rest = rest.trim_start_matches(|c: char| c.is_ascii_whitespace() || c == ',');
        if rest.is_empty() {
            return out;
        }
        let end = rest
            .find(|c: char| c.is_ascii_whitespace())
            .unwrap_or(rest.len());
        let (url, tail) = rest.split_at(end);
        let (url, descriptors) = if url.ends_with(',') {
            rest = tail;
            (url.trim_end_matches(','), "")
        } else {
            let stop = tail.find(',').unwrap_or(tail.len());
            rest = &tail[stop..];
            (url, &tail[..stop])
        };
        let (mut w, mut x) = (None, None);
        for d in descriptors.split_ascii_whitespace() {
            if let Some(n) = d.strip_suffix('w') {
                w = n.parse().ok();
            } else if let Some(n) = d.strip_suffix('x') {
                x = n.parse().ok();
            }
        }
        if !url.is_empty() {
            out.push((url.to_string(), w, x));
        }
    }
}

/// The largest candidate: by width when any gives one, else by density.
fn largest(candidates: Vec<(String, Option<f64>, Option<f64>)>) -> Option<String> {
    let by_width = candidates.iter().any(|c| c.1.is_some());
    let size = |c: &(String, Option<f64>, Option<f64>)| {
        if by_width {
            c.1.unwrap_or(0.0)
        } else {
            c.2.unwrap_or(1.0)
        }
    };
    candidates
        .into_iter()
        .filter(|c| !by_width || c.1.is_some())
        .max_by(|a, b| size(a).total_cmp(&size(b)))
        .map(|c| c.0)
}

/// A width or height the page gives in pixels.
fn pixels(v: &str) -> Option<u32> {
    let v = v.trim();
    v.strip_suffix("px").unwrap_or(v).trim().parse().ok()
}

// ------------------------------------------------------------------ reading the words

/// One reading of the page's words: its main part's HTML, or one of what it embeds.
struct Text<'u> {
    r: Render<'u>,
    blocks: Vec<Block>,
    source: &'static str,
}

impl<'u> Text<'u> {
    fn new(addr: Addresses<'u>, budget: usize, source: &'static str) -> Text<'u> {
        Text {
            r: Render::new(addr, budget),
            blocks: vec![],
            source,
        }
    }

    /// JSON-LD's `articleBody`: HTML read as HTML, else its lines as paragraphs.
    fn json_ld(addr: Addresses<'u>, budget: usize, body: &str) -> Text<'u> {
        let mut t = Text::new(addr, budget, "json-ld");
        if body.contains("</") || body.contains("<br") || body.contains("<p") {
            let doc = Document::fragment(body);
            t.blocks = t.r.blocks_of(doc.root(), 0);
        } else {
            let mut c = Collect::default();
            for line in body.lines() {
                t.r.text(&mut c.para, line);
                c.flush();
            }
            t.blocks = c.blocks;
        }
        t
    }
}

/// The Markdown's blocks before they are written.
enum Block {
    /// Lines of words (`\n` between them: a line break).
    Para(String),
    Heading(usize, String),
    /// (language, text).
    Code(String, String),
    Rule,
    Quote(Vec<Block>),
    List {
        ordered: bool,
        start: u64,
        items: Vec<Vec<Block>>,
    },
    /// Rows of cells, the first the header, all as wide.
    Table(Vec<Vec<String>>),
}

/// Blocks being gathered, with the paragraph being written.
#[derive(Default)]
struct Collect {
    blocks: Vec<Block>,
    para: Inline,
}

impl Collect {
    /// Ends the paragraph being written (an empty line in it splits it in two).
    fn flush(&mut self) {
        let words = std::mem::take(&mut self.para);
        let mut lines: Vec<String> = vec![];
        for line in words.s.split('\n') {
            let line = line.trim_matches(|c| c == ' ' || c == '\u{a0}');
            if !line.is_empty() {
                lines.push(line_start(line));
            } else if !lines.is_empty() {
                self.blocks.push(Block::Para(lines.join("\n")));
                lines.clear();
            }
        }
        if !lines.is_empty() {
            self.blocks.push(Block::Para(lines.join("\n")));
        }
    }
}

/// At a line's start a `-`, `+` or `=`, and digits with a `.`, would be a list or a heading.
fn line_start(line: &str) -> String {
    let b = line.as_bytes();
    match b.first() {
        Some(b'-' | b'+' | b'=') => format!("\\{line}"),
        Some(c) if c.is_ascii_digit() => {
            let digits = b.iter().take_while(|c| c.is_ascii_digit()).count();
            if b.get(digits) == Some(&b'.') {
                format!("{}\\{}", &line[..digits], &line[digits..])
            } else {
                line.to_string()
            }
        }
        _ => line.to_string(),
    }
}

/// A line of Markdown being written: the page's words escaped, whitespace collapsed.
#[derive(Default)]
struct Inline {
    s: String,
    /// A space is due before the next word.
    space: bool,
    /// It began with a space (for whatever wraps it).
    lead: bool,
}

impl Inline {
    fn space(&mut self) {
        if self.s.is_empty() {
            self.lead = true;
        } else {
            self.space = true;
        }
    }

    /// Markdown of Connect's own (a mark, a link, a code span).
    fn push(&mut self, markdown: &str) {
        if markdown.is_empty() {
            return;
        }
        if std::mem::take(&mut self.space) && !self.s.ends_with('\n') {
            self.s.push(' ');
        }
        self.s.push_str(markdown);
    }

    fn br(&mut self) {
        self.space = false;
        if !self.s.is_empty() {
            self.s.push('\n');
        }
    }

    /// The page's words: whitespace collapsed, invisible marks dropped, and every mark Markdown
    /// reads escaped (`&` only where it starts an entity). Returns the characters added.
    fn text(&mut self, words: &str) -> usize {
        let mut added = 0;
        for (i, c) in words.char_indices() {
            if html_space(c) {
                self.space();
                continue;
            }
            if invisible(c) {
                continue;
            }
            if std::mem::take(&mut self.space) && !self.s.ends_with('\n') {
                self.s.push(' ');
                added += 1;
            }
            if MARKS.contains(c) || (c == '&' && entity_at(&words[i + 1..])) {
                self.s.push('\\');
            }
            self.s.push(c);
            added += 1;
        }
        added
    }

    /// `inner` written between `open` and `close`, its spaces and a closing line break outside.
    fn wrap(&mut self, inner: Inline, open: &str, close: &str) {
        if inner.lead {
            self.space();
        }
        let words = inner.s.trim_end_matches('\n');
        if !words.is_empty() {
            self.push(&format!("{open}{words}{close}"));
        }
        if inner.s.ends_with('\n') {
            self.br();
        } else if inner.space {
            self.space();
        }
    }
}

/// After an `&`: `#…` or `name;` would be read as an entity.
fn entity_at(rest: &str) -> bool {
    let b = rest.as_bytes();
    let name = b.iter().take_while(|c| c.is_ascii_alphanumeric()).count();
    b.first() == Some(&b'#')
        || (name > 0 && b[0].is_ascii_alphabetic() && b.get(name) == Some(&b';'))
}

fn escaped(words: &str) -> String {
    let mut line = Inline::default();
    line.text(words);
    line.s
}

fn html_space(c: char) -> bool {
    matches!(c, ' ' | '\t' | '\n' | '\r' | '\x0C')
}

/// Control characters and invisible direction and joining marks.
fn invisible(c: char) -> bool {
    (c.is_control() && !html_space(c))
        || matches!(
            c,
            '\u{200B}'..='\u{200F}'
                | '\u{202A}'..='\u{202E}'
                | '\u{2060}'..='\u{2064}'
                | '\u{2066}'..='\u{2069}'
                | '\u{FEFF}'
        )
}

/// Words with their whitespace collapsed and invisible marks dropped.
fn clean(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let mut space = false;
    for c in s.chars() {
        if html_space(c) {
            space = true;
        } else if !invisible(c) {
            if space && !out.is_empty() {
                out.push(' ');
            }
            space = false;
            out.push(c);
        }
    }
    out
}

fn is_named(n: &NodeRef, name: &str) -> bool {
    n.node_name().is_some_and(|x| &*x == name)
}

fn hidden(n: &NodeRef) -> bool {
    n.has_attr("hidden")
        || n.attr("aria-hidden")
            .is_some_and(|v| v.trim().eq_ignore_ascii_case("true"))
        || n.attr("role").is_some_and(|r| {
            LEFT_OUT_ROLES
                .iter()
                .any(|x| r.trim().eq_ignore_ascii_case(x))
        })
}

fn left_out(n: &NodeRef, name: &str) -> bool {
    LEFT_OUT.contains(&name) || hidden(n)
}

/// An inline element holding blocks is read as their container.
fn has_block(n: &NodeRef) -> bool {
    n.descendants_it()
        .any(|d| d.node_name().is_some_and(|x| BLOCKS.contains(&&*x)))
}

/// `n`'s words as plain text: whitespace collapsed, what isn't read left out (and figures, for a
/// caption), `limit` characters at most.
fn plain(n: NodeRef, limit: usize, skip_figures: bool) -> String {
    enum Step<'a> {
        Node(NodeRef<'a>),
        Gap,
    }
    let mut out = String::new();
    let (mut count, mut space) = (0, false);
    let mut stack = vec![Step::Node(n)];
    while let Some(step) = stack.pop() {
        let x = match step {
            Step::Gap => {
                space = true;
                continue;
            }
            Step::Node(x) => x,
        };
        if x.is_text() {
            for c in x.text().chars() {
                if html_space(c) {
                    space = true;
                    continue;
                }
                if invisible(c) {
                    continue;
                }
                if count >= limit {
                    return out;
                }
                if std::mem::take(&mut space) && count > 0 {
                    out.push(' ');
                }
                out.push(c);
                count += 1;
            }
            continue;
        }
        let Some(name) = x.node_name() else { continue };
        if x.id != n.id && (left_out(&x, &name) || (skip_figures && &*name == "figure")) {
            continue;
        }
        let gap = &*name == "br" || BLOCKS.contains(&&*name);
        if gap {
            stack.push(Step::Gap);
        }
        stack.extend(x.children_it(true).map(Step::Node));
        if gap {
            stack.push(Step::Gap);
        }
    }
    out
}

/// A `<pre>`'s text as it stands, line breaks kept.
fn code_text(n: NodeRef) -> String {
    let mut out = String::new();
    let mut stack: Vec<NodeRef> = n.children_it(true).collect();
    while let Some(x) = stack.pop() {
        if x.is_text() {
            out.extend(x.text().chars().filter(|c| !invisible(*c)));
            continue;
        }
        let Some(name) = x.node_name() else { continue };
        if left_out(&x, &name) {
            continue;
        }
        if &*name == "br" {
            out.push('\n');
        }
        stack.extend(x.children_it(true));
    }
    out
}

/// A code block's language, from `language-…` or `lang-…` on the `<pre>` or its `<code>`.
fn code_language(n: NodeRef) -> String {
    let code = n
        .children_it(false)
        .find(|c| c.is_element())
        .filter(|c| is_named(c, "code"));
    for class in [Some(n), code]
        .into_iter()
        .flatten()
        .filter_map(|x| x.attr("class"))
    {
        for word in class.split_ascii_whitespace() {
            if let Some(lang) = word
                .strip_prefix("language-")
                .or_else(|| word.strip_prefix("lang-"))
            {
                let lang: String = lang
                    .chars()
                    .filter(|c| c.is_ascii_alphanumeric() || "+-_#.".contains(*c))
                    .take(32)
                    .collect();
                if !lang.is_empty() {
                    return lang;
                }
            }
        }
    }
    String::new()
}

fn longest_run(s: &str, mark: char) -> usize {
    let (mut longest, mut run) = (0, 0);
    for c in s.chars() {
        run = if c == mark { run + 1 } else { 0 };
        longest = longest.max(run);
    }
    longest
}

/// Reads elements into blocks, keeping the links and pictures it writes.
struct Render<'u> {
    addr: Addresses<'u>,
    budget: usize,
    /// The title's `<h1>`, not repeated.
    skip: Option<NodeId>,
    /// Bytes of words written; once past the budget, the rest would be cut anyway.
    size: usize,
    /// Characters of words written.
    chars: usize,
    nodes: usize,
    truncated: bool,
    /// The caption of the figure being read.
    caption: Option<String>,
    /// Inside a link: a link inside it is its words.
    in_link: bool,
    /// On one line (a heading, a link, a table cell): a line break is a space.
    flat: bool,
    in_cell: bool,
    /// The marks (`**`, `*`, `~~`) open around what is being read.
    marks: Vec<&'static str>,
    links: Vec<(String, String)>,
    seen_links: HashSet<String>,
    images: Vec<PageImage>,
    seen_images: HashSet<String>,
}

impl<'u> Render<'u> {
    fn new(addr: Addresses<'u>, budget: usize) -> Render<'u> {
        Render {
            addr,
            budget,
            skip: None,
            size: 0,
            chars: 0,
            nodes: 0,
            truncated: false,
            caption: None,
            in_link: false,
            flat: false,
            in_cell: false,
            marks: vec![],
            links: vec![],
            seen_links: HashSet::new(),
            images: vec![],
            seen_images: HashSet::new(),
        }
    }

    /// Past the Markdown's budget or the page's bounds: the rest is left out.
    fn stop(&mut self) -> bool {
        if self.nodes >= MAX_NODES || self.size > self.budget {
            self.truncated = true;
        }
        self.truncated
    }

    fn text(&mut self, out: &mut Inline, words: &str) {
        let before = out.s.len();
        self.chars += out.text(words);
        self.size += out.s.len() - before;
    }

    /// `n`'s children as blocks.
    fn blocks_of(&mut self, n: NodeRef, depth: usize) -> Vec<Block> {
        let mut c = Collect::default();
        self.children_into(n, depth, &mut c);
        c.flush();
        c.blocks
    }

    fn children_into(&mut self, n: NodeRef, depth: usize, c: &mut Collect) {
        for child in n.children_it(false) {
            self.block(child, depth + 1, c);
        }
    }

    fn block(&mut self, n: NodeRef, depth: usize, c: &mut Collect) {
        if self.stop() {
            return;
        }
        self.nodes += 1;
        if n.is_text() {
            self.text(&mut c.para, &n.text());
            return;
        }
        let Some(name) = n.node_name() else { return };
        if left_out(&n, &name) || Some(n.id) == self.skip {
            return;
        }
        if depth > MAX_DEPTH {
            c.para.space();
            self.text(&mut c.para, &plain(n, usize::MAX, false));
            c.para.space();
            return;
        }
        match &*name {
            "br" => c.para.br(),
            "hr" => {
                c.flush();
                c.blocks.push(Block::Rule);
            }
            "h1" | "h2" | "h3" | "h4" | "h5" | "h6" => {
                c.flush();
                let level = name[1..].parse().unwrap_or(1);
                c.blocks.extend(self.heading(n, depth, level));
            }
            "pre" => {
                c.flush();
                c.blocks.extend(self.pre(n));
            }
            "blockquote" => {
                c.flush();
                let inner = self.blocks_of(n, depth);
                if !inner.is_empty() {
                    c.blocks.push(Block::Quote(inner));
                }
            }
            "ul" | "ol" | "menu" => {
                c.flush();
                c.blocks.extend(self.list(n, depth, &*name == "ol"));
            }
            "table" => {
                c.flush();
                self.table(n, depth, c);
            }
            "figure" => {
                c.flush();
                self.figure(n, depth, c);
            }
            "a" | "img" | "picture" => self.inline_element(n, &name, depth, &mut c.para),
            x if BLOCKS.contains(&x) => {
                c.flush();
                self.children_into(n, depth, c);
                c.flush();
            }
            x if INLINE.contains(&x) && !has_block(&n) => {
                self.inline_element(n, &name, depth, &mut c.para)
            }
            x if INLINE.contains(&x) => self.children_into(n, depth, c),
            // Unknown elements (custom ones) hold whatever they hold; their words don't run
            // into their neighbours'.
            _ => {
                c.para.space();
                self.children_into(n, depth, c);
                c.para.space();
            }
        }
    }

    fn inline_children(&mut self, n: NodeRef, depth: usize, out: &mut Inline) {
        for child in n.children_it(false) {
            self.inline(child, depth + 1, out);
        }
    }

    fn inline(&mut self, n: NodeRef, depth: usize, out: &mut Inline) {
        if self.stop() {
            return;
        }
        self.nodes += 1;
        if n.is_text() {
            self.text(out, &n.text());
            return;
        }
        let Some(name) = n.node_name() else { return };
        if left_out(&n, &name) || Some(n.id) == self.skip {
            return;
        }
        if depth > MAX_DEPTH {
            out.space();
            self.text(out, &plain(n, usize::MAX, false));
            out.space();
            return;
        }
        self.inline_element(n, &name, depth, out);
    }

    fn inline_element(&mut self, n: NodeRef, name: &str, depth: usize, out: &mut Inline) {
        match name {
            "br" if self.flat => out.space(),
            "br" => out.br(),
            "img" | "picture" => self.picture(n, out),
            "a" => self.link(n, depth, out),
            "strong" | "b" => self.mark(n, depth, out, "**"),
            "em" | "i" => self.mark(n, depth, out, "*"),
            "del" | "s" | "strike" => self.mark(n, depth, out, "~~"),
            "code" | "kbd" | "samp" | "tt" | "pre" => self.code(n, out),
            x if INLINE.contains(&x) => self.inline_children(n, depth, out),
            // A block inside a line of words: its words, spaced.
            _ => {
                out.space();
                self.inline_children(n, depth, out);
                out.space();
            }
        }
    }

    fn mark(&mut self, n: NodeRef, depth: usize, out: &mut Inline, mark: &'static str) {
        if self.marks.contains(&mark) {
            return self.inline_children(n, depth, out);
        }
        self.marks.push(mark);
        let mut inner = Inline::default();
        self.inline_children(n, depth, &mut inner);
        self.marks.pop();
        out.wrap(inner, mark, mark);
    }

    fn link(&mut self, n: NodeRef, depth: usize, out: &mut Inline) {
        if self.in_link {
            return self.inline_children(n, depth, out);
        }
        let href = n.attr("href").and_then(|h| self.addr.link(&h));
        let flat = std::mem::replace(&mut self.flat, true);
        self.in_link = true;
        let mut inner = Inline::default();
        self.inline_children(n, depth, &mut inner);
        self.in_link = false;
        self.flat = flat;
        match href {
            Some(href) if !inner.s.is_empty() => {
                let close = format!("]({})", md_address(&href));
                if self.links.len() < MAX_LINKS && self.seen_links.insert(href.clone()) {
                    self.links.push((plain(n, MAX_WORDS, false), href));
                }
                out.wrap(inner, "[", &close);
            }
            _ => out.wrap(inner, "", ""),
        }
    }

    /// A code span, fenced one backtick longer than the longest run in it and never touching
    /// another backtick; in a table's cell, code holding a `|` is escaped words.
    fn code(&mut self, n: NodeRef, out: &mut Inline) {
        let raw = n.text();
        if raw.chars().next().is_some_and(html_space) {
            out.space();
        }
        let code = plain(n, usize::MAX, false);
        if !code.is_empty() {
            if self.in_cell && code.contains('|') {
                self.text(out, &code);
            } else {
                self.size += code.len();
                self.chars += code.chars().count();
                let fence = "`".repeat(longest_run(&code, '`') + 1);
                let pad = if code.starts_with('`') || code.ends_with('`') {
                    " "
                } else {
                    ""
                };
                if !out.space && out.s.ends_with('`') {
                    out.space = true;
                }
                out.push(&format!("{fence}{pad}{code}{pad}{fence}"));
            }
        }
        if raw.chars().last().is_some_and(html_space) {
            out.space();
        }
    }

    /// An `<img>`, or a `<picture>` by its largest source: in place as `![alt](src)`.
    fn picture(&mut self, n: NodeRef, out: &mut Inline) {
        let img = if is_named(&n, "img") {
            Some(n)
        } else {
            n.children_it(false).find(|c| is_named(c, "img"))
        };
        let mut sets = vec![];
        let sources = n.children_it(false).filter(|c| is_named(c, "source"));
        for s in sources.chain(img) {
            sets.extend(s.attr("srcset"));
            sets.extend(s.attr("data-srcset"));
        }
        let mut candidates: Vec<String> = largest(sets.iter().flat_map(|s| srcset(s)).collect())
            .into_iter()
            .collect();
        for k in ["data-src", "src"] {
            candidates.extend(img.and_then(|i| i.attr(k)).map(|v| v.to_string()));
        }
        let Some(src) = candidates.iter().find_map(|c| self.addr.resolve(c)) else {
            return;
        };
        let size = |k: &str| img.and_then(|i| i.attr(k)).and_then(|v| pixels(&v));
        let (width, height) = (size("width"), size("height"));
        if width.is_some_and(|w| w < MIN_PICTURE) || height.is_some_and(|h| h < MIN_PICTURE) {
            return;
        }
        let alt: String = img
            .and_then(|i| i.attr("alt"))
            .map(|a| clean(&a).chars().take(MAX_WORDS).collect())
            .unwrap_or_default();
        let src: String = src.into();
        out.push(&format!("![{}]({})", escaped(&alt), md_address(&src)));
        self.add_image(src, alt, width, height);
    }

    fn add_image(&mut self, src: String, alt: String, width: Option<u32>, height: Option<u32>) {
        if self.images.len() < MAX_IMAGES && self.seen_images.insert(src.clone()) {
            let caption = self.caption.clone();
            self.images.push(PageImage {
                src,
                alt,
                caption,
                width,
                height,
            });
        }
    }

    fn heading(&mut self, n: NodeRef, depth: usize, level: usize) -> Option<Block> {
        let flat = std::mem::replace(&mut self.flat, true);
        let mut words = Inline::default();
        self.inline_children(n, depth, &mut words);
        self.flat = flat;
        let words = words.s.trim();
        (!words.is_empty()).then(|| Block::Heading(level, words.to_string()))
    }

    fn pre(&mut self, n: NodeRef) -> Option<Block> {
        let text = code_text(n);
        let text = text.trim_end().trim_start_matches('\n');
        if text.trim().is_empty() {
            return None;
        }
        self.size += text.len();
        self.chars += text.chars().count();
        Some(Block::Code(code_language(n), text.to_string()))
    }

    /// A list of its items (anything else in it joins the item before); none without items.
    fn list(&mut self, n: NodeRef, depth: usize, ordered: bool) -> Option<Block> {
        let mut items: Vec<Vec<Block>> = vec![];
        for child in n.children_it(false) {
            if self.stop() {
                break;
            }
            if is_named(&child, "li") {
                self.nodes += 1;
                if !hidden(&child) {
                    let item = self.blocks_of(child, depth + 1);
                    if !item.is_empty() {
                        items.push(item);
                    }
                }
                continue;
            }
            let mut c = Collect::default();
            self.block(child, depth + 1, &mut c);
            c.flush();
            match items.last_mut() {
                _ if c.blocks.is_empty() => {}
                Some(last) => last.extend(c.blocks),
                None => items.push(c.blocks),
            }
        }
        if items.is_empty() {
            return None;
        }
        let start = n
            .attr("start")
            .and_then(|s| s.trim().parse::<i64>().ok())
            .map_or(1, |s| s.clamp(0, MAX_LIST_START) as u64);
        Some(Block::List {
            ordered,
            start,
            items,
        })
    }

    /// A GFM table when it is simple (no table in it, no cell spanning rows), else its cells'
    /// words in order; 64 columns at most.
    fn table(&mut self, n: NodeRef, depth: usize, c: &mut Collect) {
        let mut rows = vec![];
        let mut caption = None;
        for child in n.children_it(false) {
            match child.node_name().as_deref() {
                Some("tr") => rows.push(child),
                Some("thead" | "tbody" | "tfoot") => {
                    rows.extend(child.children_it(false).filter(|r| is_named(r, "tr")))
                }
                Some("caption") => caption = Some(child),
                _ => {}
            }
        }
        let spans_rows = |cell: &NodeRef| {
            cell.attr("rowspan")
                .and_then(|v| v.trim().parse::<u32>().ok())
                .is_some_and(|v| v > 1)
        };
        let simple = !rows.is_empty()
            && !n.descendants_it().any(|d| is_named(&d, "table"))
            && !rows
                .iter()
                .any(|r| r.children_it(false).any(|cell| spans_rows(&cell)));
        if !simple {
            self.children_into(n, depth, c);
            c.flush();
            return;
        }
        if let Some(caption) = caption {
            self.children_into(caption, depth + 1, c);
            c.flush();
        }
        let mut grid: Vec<Vec<String>> = vec![];
        for row in rows {
            if self.stop() {
                break;
            }
            let mut cells = vec![];
            for cell in row.children_it(false) {
                let Some(name) = cell.node_name() else {
                    continue;
                };
                if !matches!(&*name, "td" | "th") || left_out(&cell, &name) {
                    continue;
                }
                self.nodes += 1;
                let flat = std::mem::replace(&mut self.flat, true);
                let in_cell = std::mem::replace(&mut self.in_cell, true);
                let mut words = Inline::default();
                self.inline_children(cell, depth + 2, &mut words);
                self.flat = flat;
                self.in_cell = in_cell;
                cells.push(words.s.trim().to_string());
                let span = cell
                    .attr("colspan")
                    .and_then(|v| v.trim().parse::<usize>().ok())
                    .unwrap_or(1)
                    .clamp(1, MAX_COLUMNS);
                cells.extend(std::iter::repeat_n(String::new(), span - 1));
            }
            if cells.len() > MAX_COLUMNS {
                cells.truncate(MAX_COLUMNS);
                self.truncated = true;
            }
            grid.push(cells);
        }
        let columns = grid.iter().map(Vec::len).max().unwrap_or(0);
        if columns == 0 {
            return;
        }
        for row in &mut grid {
            row.resize(columns, String::new());
        }
        c.blocks.push(Block::Table(grid));
    }

    /// A figure's pictures (each with its caption), then its caption as words under them.
    fn figure(&mut self, n: NodeRef, depth: usize, c: &mut Collect) {
        let figcaption = n
            .children_it(false)
            .find(|x| is_named(x, "figcaption") && !hidden(x));
        let caption = figcaption
            .map(|f| plain(f, MAX_WORDS, true))
            .filter(|t| !t.is_empty());
        let outer = std::mem::replace(&mut self.caption, caption);
        for child in n.children_it(false) {
            if Some(child.id) != figcaption.map(|f| f.id) {
                self.block(child, depth + 1, c);
            }
        }
        self.caption = None;
        c.flush();
        if let Some(f) = figcaption {
            self.children_into(f, depth + 1, c);
            c.flush();
        }
        self.caption = outer;
    }
}

// ------------------------------------------------------------------ writing the Markdown

/// The Markdown, cut where a piece no longer fits its budget: only between blocks, a
/// paragraph's lines or a table's rows (a heading, a fenced block, a picture whole or not).
struct Writer {
    out: String,
    budget: usize,
    cut: bool,
}

impl Writer {
    fn put(&mut self, piece: &str) -> bool {
        if !self.cut && self.out.len() + piece.len() <= self.budget {
            self.out.push_str(piece);
            return true;
        }
        self.cut = true;
        false
    }
}

/// A list's markers: `-` or `1.`, or `*` and `1)` for a list right after one of its kind (the
/// same marker would join them).
struct Markers {
    ordered: bool,
    start: u64,
    other: bool,
}

impl Markers {
    fn nth(&self, k: usize) -> String {
        match (self.ordered, self.other) {
            (true, false) => format!("{}.", self.start + k as u64),
            (true, true) => format!("{})", self.start + k as u64),
            (false, false) => "-".into(),
            (false, true) => "*".into(),
        }
    }
}

/// `blocks` with `first` before their first line and `rest` before every other; `tight`: no
/// empty line between them.
fn write_blocks(
    w: &mut Writer,
    blocks: &[Block],
    first: &str,
    rest: &str,
    tight: bool,
    level: usize,
) {
    let mut after_list: Option<(bool, bool)> = None;
    for (i, block) in blocks.iter().enumerate() {
        if w.cut {
            return;
        }
        let lead = if i == 0 { first } else { rest };
        if i > 0 && !tight {
            w.put(&format!("{}\n", rest.trim_end()));
        }
        let mut list = None;
        match block {
            Block::Para(words) => {
                let lines: Vec<&str> = words.split('\n').collect();
                for (j, line) in lines.iter().enumerate() {
                    let prefix = if j == 0 { lead } else { rest };
                    let brk = if j + 1 < lines.len() { "\\" } else { "" };
                    if !w.put(&format!("{prefix}{line}{brk}\n")) {
                        return;
                    }
                }
            }
            Block::Heading(n, words) => {
                w.put(&format!("{lead}{} {words}\n", "#".repeat(*n)));
            }
            Block::Rule => {
                w.put(&format!("{lead}---\n"));
            }
            Block::Code(lang, text) => {
                let fence = "`".repeat(longest_run(text, '`').max(2) + 1);
                let mut piece = format!("{lead}{fence}{lang}\n");
                for line in text.split('\n') {
                    piece.push_str(if line.is_empty() {
                        rest.trim_end()
                    } else {
                        rest
                    });
                    piece.push_str(line);
                    piece.push('\n');
                }
                piece.push_str(&format!("{rest}{fence}\n"));
                w.put(&piece);
            }
            Block::Quote(inner) => write_blocks(
                w,
                inner,
                &format!("{lead}> "),
                &format!("{rest}> "),
                false,
                level,
            ),
            Block::List {
                ordered,
                start,
                items,
            } => {
                let other = after_list.is_some_and(|(o, other)| o == *ordered && !other);
                let markers = Markers {
                    ordered: *ordered,
                    start: *start,
                    other,
                };
                write_list(w, items, &markers, lead, rest, level);
                list = Some((*ordered, other));
            }
            Block::Table(rows) => {
                let row = |cells: &Vec<String>| format!("| {} |", cells.join(" | "));
                let rule = format!("| {} |", vec!["---"; rows[0].len()].join(" | "));
                if w.put(&format!("{lead}{}\n{rest}{rule}\n", row(&rows[0]))) {
                    for r in &rows[1..] {
                        if !w.put(&format!("{rest}{}\n", row(r))) {
                            break;
                        }
                    }
                }
            }
        }
        after_list = list;
    }
}

/// A list's items, each indented by its marker's width; past eight levels an item's blocks sit
/// at the eighth level's indent, without a marker.
fn write_list(
    w: &mut Writer,
    items: &[Vec<Block>],
    markers: &Markers,
    lead: &str,
    rest: &str,
    level: usize,
) {
    let deep = level >= MAX_LIST_LEVELS;
    // Tight when each item is at most a paragraph followed by lists that have markers.
    let tight = !deep
        && items.iter().all(|item| {
            item.iter().enumerate().all(|(i, b)| match b {
                Block::Para(_) => i == 0,
                Block::List { .. } => level + 1 < MAX_LIST_LEVELS,
                _ => false,
            })
        });
    for (k, item) in items.iter().enumerate() {
        if w.cut {
            return;
        }
        let first = if k == 0 { lead } else { rest };
        if k > 0 && !tight {
            w.put(&format!("{}\n", rest.trim_end()));
        }
        if deep {
            write_blocks(w, item, first, rest, false, level);
            continue;
        }
        let marker = markers.nth(k);
        let indent = " ".repeat(marker.len() + 1);
        write_blocks(
            w,
            item,
            &format!("{first}{marker} "),
            &format!("{rest}{indent}"),
            tight,
            level + 1,
        );
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const URL: &str = "https://example.com/blog/post.html";

    fn read(html: &str) -> PageText {
        read_html(URL, html, 1 << 20)
    }

    fn image(src: &str, alt: &str) -> PageImage {
        PageImage {
            src: src.into(),
            alt: alt.into(),
            ..PageImage::default()
        }
    }

    #[test]
    fn an_article_keeps_its_words_without_the_page_around_it() {
        let page = r#"<!doctype html><html lang="en"><head><title>Post | Example</title>
<style>p { color: red }</style><script>var secret = "leak";</script></head>
<body>
<header><a href="/">Example home</a></header>
<nav><ul><li><a href="/a">Menu A</a></li></ul></nav>
<article>
<header><p>Chrome inside the article</p></header>
<h1>The   Post</h1>
<p>Some <strong>bold</strong> and <em>soft</em> words with <code>x = 1</code>.</p>
<h2>Steps</h2>
<ul>
  <li>First
    <ul><li>Inner one</li><li>Inner two</li></ul>
  </li>
  <li>Second</li>
</ul>
<ol start="3"><li>Three</li><li>Four</li></ol>
<pre><code class="language-rust">fn main() {
    println!("hi");
}
</code></pre>
<table>
<thead><tr><th>Name</th><th>Value</th></tr></thead>
<tbody><tr><td>a</td><td>1</td></tr><tr><td>b|c</td><td><code>x|y</code></td></tr></tbody>
</table>
<blockquote><p>Quoted words.</p></blockquote>
<p>Line one<br>Line two</p>
<script>document.write("nope")</script>
<aside>Related stuff</aside>
<form><input name=q><button>Go</button></form>
</article>
<footer>Copyright</footer>
</body></html>"#;
        let p = read(page);
        assert_eq!(p.title, "The Post");
        assert_eq!(
            p.markdown,
            "Some **bold** and *soft* words with `x = 1`.\n\
             \n\
             ## Steps\n\
             \n\
             - First\n  - Inner one\n  - Inner two\n- Second\n\
             \n\
             3. Three\n4. Four\n\
             \n\
             ```rust\nfn main() {\n    println!(\"hi\");\n}\n```\n\
             \n\
             | Name | Value |\n| --- | --- |\n| a | 1 |\n| b\\|c | x\\|y |\n\
             \n\
             > Quoted words.\n\
             \n\
             Line one\\\nLine two"
        );
        for gone in [
            "leak",
            "nope",
            "Menu",
            "Example home",
            "Copyright",
            "Related",
            "Chrome",
            "Go",
        ] {
            assert!(!p.markdown.contains(gone), "{gone} in {}", p.markdown);
        }
        assert_eq!(p.lang.as_deref(), Some("en"));
        assert_eq!(p.source, "html");
        assert!(!p.truncated);
        // Under 200 characters of words, on a page with scripts.
        assert!(p.needs_js);
        assert!(p.links.is_empty() && p.images.is_empty());
    }

    #[test]
    fn links_and_pictures_are_absolute_http_addresses_once_each() {
        let page = r##"<body><main>
<p><a href="../about">About   us</a> and <a href="https://other.example/x?a=1|2">pipe</a></p>
<p><img src="img/a.png" alt="A [cat]" width="640" height="480"></p>
<p><a href="javascript:alert(1)">Click me</a> <a href="mailto:a@b.example">Mail</a>
<a href="#top">Top</a> <a href="https://user@evil.example/">Evil</a>
<a href="https://example.com/blog/post.html#part">Part</a>
<img src="data:image/png;base64,AAAA" alt="inline"> <img src="/pixel.gif" width="1" height="1"></p>
<p><a href="/about">again</a> <img src="img/a.png" alt="again"></p>
</main></body>"##;
        let p = read(page);
        assert_eq!(
            p.markdown,
            "[About us](https://example.com/about) and [pipe](https://other.example/x?a=1%7C2)\n\
             \n\
             ![A \\[cat\\]](https://example.com/blog/img/a.png)\n\
             \n\
             Click me Mail Top Evil Part\n\
             \n\
             [again](https://example.com/about) ![again](https://example.com/blog/img/a.png)"
        );
        assert_eq!(
            p.links,
            vec![
                ("About us".into(), "https://example.com/about".into()),
                ("pipe".into(), "https://other.example/x?a=1|2".into()),
            ]
        );
        assert_eq!(
            p.images,
            vec![PageImage {
                width: Some(640),
                height: Some(480),
                ..image("https://example.com/blog/img/a.png", "A [cat]")
            }]
        );
    }

    #[test]
    fn a_base_element_moves_where_relative_addresses_point() {
        let absolute = read(
            r#"<head><base href="https://cdn.example/static/"></head>
<body><p><a href="doc">Doc</a> <img src="p.jpg" alt="P"></p></body>"#,
        );
        assert_eq!(
            absolute.markdown,
            "[Doc](https://cdn.example/static/doc) ![P](https://cdn.example/static/p.jpg)"
        );
        let relative = read(r#"<head><base href="/root/"></head><body><a href="x">X</a></body>"#);
        assert_eq!(
            relative.links,
            vec![("X".into(), "https://example.com/root/x".into())]
        );
        // Without an address to resolve against (`ctx.web.markdown` with no base), they are text.
        let none = read_html(
            "",
            r#"<p><a href="x">X</a> <a href="https://a.example/">A</a></p>"#,
            1000,
        );
        assert_eq!(none.markdown, "X [A](https://a.example/)");
    }

    #[test]
    fn what_the_page_says_of_itself() {
        let page = r#"<html lang="de-AT"><head>
<title>Fallback title</title>
<meta property="og:title" content="OG Title">
<meta name="description" content="  A   short description. ">
<meta name="author" content="Jane Doe">
<meta property="article:published_time" content="2026-03-04T05:06:07Z">
<meta property="og:site_name" content="Example Site">
<meta property="og:image" content="/cover.jpg">
</head><body><main><p>Body words.</p></main></body></html>"#;
        let p = read(page);
        assert_eq!(p.title, "OG Title");
        assert_eq!(p.markdown, "Body words.");
        assert_eq!(p.description.as_deref(), Some("A short description."));
        assert_eq!(p.byline.as_deref(), Some("Jane Doe"));
        assert_eq!(p.published.as_deref(), Some("2026-03-04T05:06:07Z"));
        assert_eq!(p.lang.as_deref(), Some("de-AT"));
        assert_eq!(p.source, "html");
        assert_eq!(p.images, vec![image("https://example.com/cover.jpg", "")]);
        // The first <h1> is the title (and isn't repeated); else <title>.
        let h1 = read(
            r#"<head><meta property="og:title" content="OG"></head><body><h1>Real <em>title</em></h1><p>Text.</p></body>"#,
        );
        assert_eq!(
            (h1.title.as_str(), h1.markdown.as_str()),
            ("Real title", "Text.")
        );
        let plain = read("<head><title> Only   this </title></head><body><p>Text.</p></body>");
        assert_eq!(plain.title, "Only this");
    }

    #[test]
    fn the_largest_article_is_the_main_part() {
        let p = read(
            "<body><article><p>Short teaser.</p></article>\
             <article><p>The long story with many more words in it.</p></article></body>",
        );
        assert_eq!(p.markdown, "The long story with many more words in it.");
    }

    #[test]
    fn a_page_that_builds_itself_with_scripts_needs_js() {
        let shell = read(
            r#"<html><head><title>App</title><script src="/app.js"></script></head>
<body><div id="root"></div><noscript>You need to enable JavaScript to run this app.</noscript>
<script>window.__INIT__ = {"words": "not these"}</script></body></html>"#,
        );
        assert!(shell.needs_js);
        assert_eq!(shell.markdown, "");
        assert_eq!(shell.title, "App");
        // A short static page without scripts is just short.
        assert!(!read("<p>Short.</p>").needs_js);
        // Its embedded article (JSON-LD) is read when it is clearly fuller than the HTML.
        let body =
            "First paragraph of the story, long enough to count as the page's words. ".repeat(3);
        let ld = read(&format!(
            r#"<head><script type="application/ld+json">{{"@context":"https://schema.org","@graph":[{{"@type":"WebSite","name":"Site"}},
{{"@type":"NewsArticle","headline":"LD Headline","author":[{{"@type":"Person","name":"Ann"}},{{"name":"Bob"}}],
"datePublished":"2025-01-02","image":["https://img.example/1.jpg"],"articleBody":"{body}\nSecond paragraph *with* marks."}}]}}</script>
<script src="app.js"></script></head><body><div id="app">Loading…</div></body>"#
        ));
        assert_eq!(ld.source, "json-ld");
        assert_eq!(ld.title, "LD Headline");
        assert_eq!(ld.byline.as_deref(), Some("Ann, Bob"));
        assert_eq!(ld.published.as_deref(), Some("2025-01-02"));
        assert_eq!(
            ld.markdown,
            format!("{}\n\nSecond paragraph \\*with\\* marks.", body.trim())
        );
        assert_eq!(ld.images, vec![image("https://img.example/1.jpg", "")]);
        assert!(!ld.needs_js);
        // Nothing but its description: that, from `meta`.
        let meta = read(
            r#"<head><meta property="og:description" content="Just this."></head><body></body>"#,
        );
        assert_eq!(
            (meta.markdown.as_str(), meta.source.as_str()),
            ("Just this.", "meta")
        );
    }

    #[test]
    fn the_markdown_is_cut_at_max_between_blocks() {
        let paras: String = (0..50)
            .map(|i| format!("<p>Paragraph {i}: ünïcödé words here.</p>"))
            .collect();
        let page = format!("<body><article>{paras}</article></body>");
        let full = read(&page);
        assert!(!full.truncated);
        let cut = read_html(URL, &page, 200);
        assert!(cut.truncated);
        assert!(cut.markdown.len() <= 200, "{}", cut.markdown.len());
        assert!(cut.markdown.ends_with("words here."), "{}", cut.markdown);
        assert!(full.markdown.starts_with(&cut.markdown));
        // A fenced block is left out whole.
        let code = format!("<p>Intro.</p><pre>{}</pre>", "let x = 1;\n".repeat(40));
        let p = read_html(URL, &code, 100);
        assert_eq!((p.markdown.as_str(), p.truncated), ("Intro.", true));
    }

    #[test]
    fn script_text_and_raw_html_never_reach_the_markdown() {
        let page = r#"<body><p>Use &lt;b&gt;tags&lt;/b&gt; *carefully* &amp; 1 &amp;amp; 2 # not_a_heading</p>
<p>- not a list</p><p>1. not a list either</p>
<div><script>alert("x")</script><style>.a{}</style><template><p>tmpl</p></template>
<p hidden>hidden words</p><p aria-hidden="true">aria words</p><svg><text>svg words</text></svg>
<iframe src="https://ads.example/"></iframe><p>Kept<script>alert(2)</script> text.</p></div></body>"#;
        let p = read(page);
        assert_eq!(
            p.markdown,
            "Use \\<b\\>tags\\</b\\> \\*carefully\\* & 1 \\&amp; 2 \\# not\\_a\\_heading\n\
             \n\
             \\- not a list\n\
             \n\
             1\\. not a list either\n\
             \n\
             Kept text."
        );
        for gone in [
            "alert",
            "tmpl",
            "hidden words",
            "aria words",
            "svg words",
            "ads",
        ] {
            assert!(!p.markdown.contains(gone), "{gone} in {}", p.markdown);
        }
    }

    #[test]
    fn pictures_take_their_largest_source_and_their_figure_caption() {
        let page = r#"<article><figure><picture>
<source srcset="/s-480.webp 480w, /s-1200.webp 1200w">
<img src="/fallback.jpg" alt="Hero" width="1200" height="600"></picture>
<figcaption>The <em>hero</em> shot</figcaption></figure>
<p><img data-src="/lazy.jpg" src="data:image/gif;base64,R0lGOD" alt="Lazy">
<img srcset="/a-1x.png 1x, /a-2x.png 2x" src="/a.png" alt="Dense"></p></article>"#;
        let p = read(page);
        assert_eq!(
            p.markdown,
            "![Hero](https://example.com/s-1200.webp)\n\
             \n\
             The *hero* shot\n\
             \n\
             ![Lazy](https://example.com/lazy.jpg) ![Dense](https://example.com/a-2x.png)"
        );
        assert_eq!(
            p.images,
            vec![
                PageImage {
                    caption: Some("The hero shot".into()),
                    width: Some(1200),
                    height: Some(600),
                    ..image("https://example.com/s-1200.webp", "Hero")
                },
                image("https://example.com/lazy.jpg", "Lazy"),
                image("https://example.com/a-2x.png", "Dense"),
            ]
        );
    }

    #[test]
    fn code_spans_are_fenced_longer_than_their_backticks() {
        let p = read("<p><code>a`b</code> and <code>`tick</code> and <kbd>Ctrl</kbd></p>");
        assert_eq!(p.markdown, "``a`b`` and `` `tick `` and `Ctrl`");
        let pre = read("<pre>a ``` b</pre>");
        assert_eq!(pre.markdown, "````\na ``` b\n````");
    }

    #[test]
    fn deep_pages_keep_their_words() {
        let deep = format!("{}deep words{}", "<div>".repeat(400), "</div>".repeat(400));
        assert_eq!(read(&deep).markdown, "deep words");
        let lists = format!(
            "{}<li>bottom</li>{}",
            "<ul><li>level".repeat(10),
            "</li></ul>".repeat(10)
        );
        let md = read(&lists).markdown;
        // Eight levels of markers, then the text at the eighth level's indent.
        assert!(md.contains(&format!("{}- level", " ".repeat(14))), "{md}");
        assert!(!md.contains(&format!("{}- ", " ".repeat(16))), "{md}");
        assert!(md.contains("bottom"), "{md}");
    }
}
