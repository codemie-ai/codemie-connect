//! The glossary and the tag list (spec "Glossary and tags"): two Markdown documents the person
//! writes in whatever structure reads well. Connect reads only what notes need: the name under
//! `## Me` and the quoted names after it, every **bold** term or person, the quoted spellings
//! after "heard as", and every `` `tag` `` that starts a list item.
use super::model::{MeAlias, MeetingSettings};
use crate::workspace::models::WorkspaceError;
use serde::Serialize;
use std::path::{Path, PathBuf};

/// The glossary and the tag list are each at most 100 KB.
pub const TEXT_MAX: usize = 100 * 1024;

/// What Connect picks up from the glossary.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize)]
pub struct Glossary {
    /// The `## Me` section: my name and the other names people use for me.
    pub me: Option<MeAlias>,
    /// (as heard, as written): `("light LLM", "LiteLLM")`.
    pub pairs: Vec<(String, String)>,
    /// The first bold term of every line outside `## Me` and the people sections.
    pub terms: Vec<String>,
    /// Every bold name in a section whose heading says "people".
    pub people: Vec<String>,
}

/// The text between each `open` and the next `close` on `line` (at least one character, none
/// of them `close`), left to right; an unclosed one reads nothing.
fn delimited<'a>(line: &'a str, open: &[&str], close: &[char]) -> Vec<&'a str> {
    let mut found = Vec::new();
    let mut at = 0;
    while at < line.len() {
        let rest = &line[at..];
        let Some(opener) = open.iter().find(|o| rest.starts_with(**o)) else {
            at += rest.chars().next().map_or(1, char::len_utf8);
            continue;
        };
        let inside = &rest[opener.len()..];
        let end = inside
            .find(|c: char| close.contains(&c))
            .unwrap_or(inside.len());
        let closed = end < inside.len() && end > 0;
        // `**bold**` closes with two stars, a quote with one quote character.
        let tail = &inside[end..];
        let ok = closed && (opener != &"**" || tail.starts_with("**"));
        if ok {
            found.push(&inside[..end]);
            let close_len = if opener == &"**" {
                2
            } else {
                tail.chars().next().map_or(1, char::len_utf8)
            };
            at += opener.len() + end + close_len;
        } else {
            at += rest.chars().next().map_or(1, char::len_utf8);
        }
    }
    found
}

/// Every `**bold**` of a line, trimmed.
fn bold(line: &str) -> Vec<String> {
    delimited(line, &["**"], &['*'])
        .into_iter()
        .map(|b| b.trim().to_string())
        .collect()
}

/// Every “quoted” or "quoted" text of a line.
fn quoted(line: &str) -> Vec<String> {
    delimited(line, &["“", "\""], &['”', '"'])
        .into_iter()
        .map(String::from)
        .collect()
}

/// The byte offset of `needle` (ASCII) in `hay`, ignoring ASCII case.
fn find_ascii(hay: &str, needle: &str) -> Option<usize> {
    let (h, n) = (hay.as_bytes(), needle.as_bytes());
    (0..=h.len().checked_sub(n.len())?).find(|&i| h[i..i + n.len()].eq_ignore_ascii_case(n))
}

/// What follows the first "heard as" of a line, up to a second one.
fn heard_as(line: &str) -> Option<&str> {
    const HEARD: &str = "heard as";
    let after = &line[find_ascii(line, HEARD)? + HEARD.len()..];
    Some(match find_ascii(after, HEARD) {
        Some(end) => &after[..end],
        None => after,
    })
}

/// A `## ` heading's text in lower case.
fn heading(line: &str) -> Option<String> {
    let rest = line.strip_prefix("##")?;
    rest.starts_with(char::is_whitespace)
        .then(|| rest.trim().to_lowercase())
}

/// Reads the glossary as the prototype's `parseGlossary` does: the intro before the first
/// `## ` heading is prose; under `## Me` the first bold name is me and the quoted names on its
/// line my aliases (not a quoted "we will…"); in a section whose heading says "people" every
/// bold name is a person, elsewhere a line's first bold is a term; the quoted spellings after
/// "heard as" (in any section) are heard-as pairs for the line's first bold.
pub fn parse_glossary(md: &str) -> Glossary {
    let mut g = Glossary::default();
    let mut section = String::new();
    for line in md.lines() {
        if let Some(h) = heading(line) {
            section = h;
            continue;
        }
        let bold = bold(line);
        if bold.is_empty() || section.is_empty() {
            continue;
        }
        if section == "me" && g.me.is_none() {
            let aliases = quoted(line)
                .into_iter()
                .filter(|q| find_ascii(q, "we will").is_none())
                .collect();
            g.me = Some(MeAlias {
                name: bold[0].clone(),
                aliases,
                address: None,
            });
            continue;
        }
        if section.contains("people") {
            g.people.extend(bold.iter().cloned());
        } else {
            g.terms.push(bold[0].clone());
        }
        if let Some(heard) = heard_as(line) {
            g.pairs
                .extend(quoted(heard).into_iter().map(|h| (h, bold[0].clone())));
        }
    }
    g
}

/// Every `` `tag` `` that starts a list item (`- ` or `* `), as the prototype's `parseTags`.
pub fn parse_tags(md: &str) -> Vec<String> {
    md.lines()
        .filter_map(|line| {
            let item = line.trim_start().strip_prefix(['-', '*'])?;
            let rest = item.trim_start();
            if rest.len() == item.len() {
                return None;
            }
            let inside = rest.strip_prefix('`')?;
            let end = inside.find('`')?;
            (end > 0).then(|| inside[..end].to_string())
        })
        .collect()
}

/// The two documents.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Text {
    Glossary,
    Tags,
}

impl Text {
    pub fn parse(name: &str) -> Option<Self> {
        match name {
            "glossary" => Some(Self::Glossary),
            "tags" => Some(Self::Tags),
            _ => None,
        }
    }
    pub fn file_name(self) -> &'static str {
        match self {
            Self::Glossary => "glossary.md",
            Self::Tags => "tags.md",
        }
    }
}

/// Where a document is, and whether it is a linked file the person keeps elsewhere:
/// `glossary.md`/`tags.md` in the meetings root, or `glossaryFile`/`tagsFile` when
/// `glossarySource` is `file` (`None` when that file is not chosen yet).
pub fn text_path(root: &Path, s: &MeetingSettings, which: Text) -> (Option<PathBuf>, bool) {
    if s.glossary_source == "file" {
        let linked = match which {
            Text::Glossary => &s.glossary_file,
            Text::Tags => &s.tags_file,
        };
        return (linked.as_deref().map(PathBuf::from), true);
    }
    (Some(root.join(which.file_name())), false)
}

/// A document's text: empty when there is no file (or none is chosen), the first 100 KB when it
/// is longer (and `true`). Any other failure to read it is `unreadable`, so nothing is ever
/// written over a document Connect could not read.
pub fn read_text(path: Option<&Path>) -> Result<(String, bool), WorkspaceError> {
    use std::io::Read;
    let Some(path) = path else {
        return Ok((String::new(), false));
    };
    let mut bytes = Vec::new();
    match std::fs::File::open(path)
        .and_then(|file| file.take(TEXT_MAX as u64 + 4).read_to_end(&mut bytes))
    {
        Ok(_) => {}
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok((String::new(), false)),
        Err(e) => return Err(unreadable(path, &e)),
    }
    let cut = bytes.len() > TEXT_MAX;
    if cut {
        bytes.truncate(TEXT_MAX);
    }
    let mut text = String::from_utf8_lossy(&bytes).into_owned();
    if cut && text.ends_with('\u{FFFD}') {
        // A character split by the cut.
        text.pop();
    }
    Ok((text, cut))
}

/// The file's name, as the person sees it in Finder.
pub fn file_label(path: &Path) -> String {
    path.file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_else(|| path.to_string_lossy().into_owned())
}

/// A glossary or tag list Connect can't read: names the file and says it stays as it is.
pub fn unreadable(path: &Path, e: &std::io::Error) -> WorkspaceError {
    let why = match e.kind() {
        std::io::ErrorKind::PermissionDenied => "it isn’t allowed to open it",
        std::io::ErrorKind::IsADirectory => "it is a folder, not a file",
        _ => "the file may be offline or in use",
    };
    WorkspaceError::new(
        "unreadable",
        format!(
            "Connect can’t read {} ({why}), so it won’t change it. Check the file in Finder, then try again.",
            file_label(path)
        ),
    )
}

/// `me` as the glossary names me: its `## Me` name and aliases (the account's own name becomes
/// an alias, so a transcript that writes it is still me); the account's e-mail stays.
pub fn me_with(me: MeAlias, glossary: &Glossary) -> MeAlias {
    let Some(named) = glossary.me.as_ref().filter(|m| !m.name.trim().is_empty()) else {
        return me;
    };
    let mut aliases = named.aliases.clone();
    let account = me.name.trim();
    if !account.is_empty()
        && !account.eq_ignore_ascii_case(named.name.trim())
        && !aliases
            .iter()
            .any(|a| a.trim().eq_ignore_ascii_case(account))
    {
        aliases.push(account.to_string());
    }
    MeAlias {
        name: named.name.clone(),
        aliases,
        address: me.address,
    }
}

/// The example glossary of the spec and the prototype (Settings › Glossary & tags).
#[cfg(test)]
pub(crate) const EXAMPLE_GLOSSARY: &str = "# Glossary

Spellings and names the AI should get right. Write it the way you would brief a new colleague — Connect picks up the **bold** terms and whatever follows “heard as”.

## Me
**Taylor Morgan** — also “Taylor”, “Тейлор”, “TM”. When the team says “we will…”, the task is mine.

## Products and tools
- **CodeMie** — EPAM’s AI platform; heard as “code me”, “code mie”
- **AI/Run** — the EPAM AI programme; heard as “air run”
- **LiteLLM** — the model proxy behind CodeMie budgets; heard as “light LLM”, “lite LLM”
- **Bedrock** — AWS models; heard as “bedrox”
- **Entra ID** — Microsoft identity, where Philips keeps its groups; heard as “entra id”

## People and roles
- **Jeroen de Vries** — Philips, product owner
- **Anouk Bakker** — Philips, solution architect
- **Priya Raman** — delivery manager, runs the weekly and the stand-ups
- **Hannah Lee**, **Marco Rossi** — Northwind (partner), partnerships and security
";

/// The example tag list.
#[cfg(test)]
pub(crate) const EXAMPLE_TAGS: &str = "# Tags

Notes get tags from this list only, `meeting` first. When nothing fits a topic, the AI uses fewer tags and says which one was missing.

- `meeting` — every meeting note
- `philips` — the Philips account
- `compliance` — audits, retention, legal hold
- `pilot` — pilots and rollouts
- `release` — releases and go/no-go decisions
- `codemie-connect` — the Connect desktop app
- `architecture` — design reviews and technical decisions
- `interview` — interviews I ran
- `stand-up` — daily stand-ups
- `partner` — partners and resellers
";

#[cfg(test)]
mod tests {
    use super::*;

    fn pair(heard: &str, write: &str) -> (String, String) {
        (heard.into(), write.into())
    }

    #[test]
    fn parse_glossary_reads_me_bold_terms_people_and_heard_as() {
        let g = parse_glossary(EXAMPLE_GLOSSARY);
        assert_eq!(
            g.me,
            Some(MeAlias {
                name: "Taylor Morgan".into(),
                aliases: vec!["Taylor".into(), "Тейлор".into(), "TM".into()],
                address: None,
            })
        );
        assert_eq!(
            g.pairs,
            vec![
                pair("code me", "CodeMie"),
                pair("code mie", "CodeMie"),
                pair("air run", "AI/Run"),
                pair("light LLM", "LiteLLM"),
                pair("lite LLM", "LiteLLM"),
                pair("bedrox", "Bedrock"),
                pair("entra id", "Entra ID"),
            ]
        );
        // The intro before the first `##` is prose: its **bold** is not a term.
        assert_eq!(
            g.terms,
            vec!["CodeMie", "AI/Run", "LiteLLM", "Bedrock", "Entra ID"]
        );
        assert_eq!(
            g.people,
            vec![
                "Jeroen de Vries",
                "Anouk Bakker",
                "Priya Raman",
                "Hannah Lee",
                "Marco Rossi"
            ]
        );
        // "heard as" counts in a people section too, with plain quotes as well as curly ones.
        let more = format!(
            "{EXAMPLE_GLOSSARY}- **Jeroen** — heard as “Yeroen”\n- **Anouk** — heard as \"Anuk\", “Annuk”\n"
        );
        let g = parse_glossary(&more);
        assert_eq!(g.pairs.len(), 10);
        assert_eq!(
            &g.pairs[7..],
            &[
                pair("Yeroen", "Jeroen"),
                pair("Anuk", "Anouk"),
                pair("Annuk", "Anouk")
            ]
        );
        assert!(g.people.contains(&"Jeroen".to_string()));
        // `## Me` keeps its first line only; a heading without bold lines reads nothing.
        let g = parse_glossary(
            "**Ignored** before any heading\n## Me\n**Sam Lee** — “Sam”\n**Other** — “x”\n### Notes\n## Tools\nno bold here\n- **Jira**",
        );
        assert_eq!(g.me.unwrap().name, "Sam Lee");
        assert_eq!(g.terms, vec!["Other", "Jira"]);
        assert_eq!(parse_glossary(""), Glossary::default());
        // Unclosed bold and quotes read nothing.
        let g = parse_glossary("## Terms\n- **Open — heard as “never closed\n- ****\n");
        assert_eq!(g, Glossary::default());
    }

    #[test]
    fn parse_tags_reads_backticked_list_items() {
        let tags = parse_tags(EXAMPLE_TAGS);
        assert_eq!(tags.len(), 10);
        assert_eq!(tags[0], "meeting");
        assert_eq!(tags[5], "codemie-connect");
        assert_eq!(tags[9], "partner");
        // Only a tag that starts a list item counts: not one in prose, nor a second on a line.
        assert_eq!(
            parse_tags("Use `meeting` first.\n  * `pilot` and `x`\n-`nospace`\n- ``\n-\t`tab`\n"),
            vec!["pilot", "tab"]
        );
    }

    #[test]
    fn texts_live_in_the_root_or_in_linked_files() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        let mut s = MeetingSettings::default();
        assert_eq!(
            text_path(root, &s, Text::Glossary),
            (Some(root.join("glossary.md")), false)
        );
        assert_eq!(
            text_path(root, &s, Text::Tags),
            (Some(root.join("tags.md")), false)
        );
        s.glossary_source = "file".into();
        s.glossary_file = Some("/Users/taylor/TERMS_TAXONOMY.md".into());
        assert_eq!(
            text_path(root, &s, Text::Glossary),
            (Some(PathBuf::from("/Users/taylor/TERMS_TAXONOMY.md")), true)
        );
        assert_eq!(text_path(root, &s, Text::Tags), (None, true));
        // Missing reads as empty; a long one is cut at 100 KB on a character boundary.
        assert_eq!(
            read_text(Some(&root.join("none.md"))).unwrap(),
            (String::new(), false)
        );
        assert_eq!(read_text(None).unwrap(), (String::new(), false));
        let long = root.join("long.md");
        std::fs::write(&long, "é".repeat(TEXT_MAX)).unwrap();
        let (text, cut) = read_text(Some(&long)).unwrap();
        assert!(cut);
        assert!(text.len() <= TEXT_MAX && text.chars().all(|c| c == 'é'));
        std::fs::write(&long, "- `meeting`\n").unwrap();
        assert_eq!(
            read_text(Some(&long)).unwrap(),
            ("- `meeting`\n".into(), false)
        );
    }

    #[test]
    fn a_text_that_cannot_be_read_is_an_error_that_names_the_file() {
        use std::os::unix::fs::PermissionsExt;
        let dir = tempfile::tempdir().unwrap();
        // A folder where the file should be.
        let folder = dir.path().join("glossary.md");
        std::fs::create_dir(&folder).unwrap();
        let e = read_text(Some(&folder)).unwrap_err();
        assert_eq!(e.code, "unreadable");
        assert!(e.message.contains("glossary.md"), "{}", e.message);
        // A file Connect may not read.
        let locked = dir.path().join("tags.md");
        std::fs::write(&locked, "- `meeting`\n").unwrap();
        std::fs::set_permissions(&locked, std::fs::Permissions::from_mode(0o000)).unwrap();
        let refused = read_text(Some(&locked));
        std::fs::set_permissions(&locked, std::fs::Permissions::from_mode(0o644)).unwrap();
        let e = refused.unwrap_err();
        assert_eq!(e.code, "unreadable");
        assert!(e.message.contains("tags.md"), "{}", e.message);
    }

    #[test]
    fn me_takes_the_glossary_name_and_keeps_the_account_name_as_an_alias() {
        let account = MeAlias {
            name: "Morgan, Taylor".into(),
            aliases: vec![],
            address: Some("taylor@example.test".into()),
        };
        let me = me_with(account.clone(), &parse_glossary(EXAMPLE_GLOSSARY));
        assert_eq!(me.name, "Taylor Morgan");
        assert_eq!(me.aliases, vec!["Taylor", "Тейлор", "TM", "Morgan, Taylor"]);
        assert_eq!(me.address.as_deref(), Some("taylor@example.test"));
        // No `## Me`: the account as it is. The same name is not repeated as an alias.
        assert_eq!(me_with(account.clone(), &Glossary::default()), account);
        let same = me_with(
            MeAlias {
                name: "Taylor Morgan".into(),
                ..account
            },
            &parse_glossary(EXAMPLE_GLOSSARY),
        );
        assert_eq!(same.aliases, vec!["Taylor", "Тейлор", "TM"]);
    }
}
