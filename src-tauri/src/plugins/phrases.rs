//! The plugin's own words that name Echo, for its frame to say Connect instead (shim.js
//! `renameHost`). Echo's plugins are written for Echo, and their screens say "Echo" where they
//! mean the app they run in. The frame changes only text that is the plugin's own: each phrase
//! here is a run of text around an "Echo" in the package's scripts, bounded where code would
//! begin, so a user's notes that mention Echo (shown by the same plugin) are left as written.
use std::path::Path;

/// Scripts read, and how much of each.
const MAX_FILES: usize = 64;
const MAX_FILE_BYTES: u64 = 4 << 20;
/// Phrases kept, and how long each may be.
const MAX_PHRASES: usize = 3000;
const MAX_PHRASE: usize = 400;

/// Each distinct phrase around an "Echo" in the `.js` / `.mjs` files of a plugin's package.
pub fn echo_phrases(dir: &Path) -> Vec<String> {
    let mut files = Vec::new();
    collect(dir, 0, &mut files);
    files.sort();
    let mut out: Vec<String> = Vec::new();
    for f in files.into_iter().take(MAX_FILES) {
        let Ok(text) = std::fs::read_to_string(&f) else {
            continue;
        };
        for p in phrases_in(&text) {
            if out.len() >= MAX_PHRASES {
                return out;
            }
            if !out.contains(&p) {
                out.push(p);
            }
        }
    }
    out
}

fn collect(dir: &Path, depth: usize, out: &mut Vec<std::path::PathBuf>) {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return;
    };
    for e in entries.flatten() {
        let name = e.file_name().to_string_lossy().to_string();
        if name.starts_with('.') || name == "node_modules" {
            continue;
        }
        let Ok(meta) = std::fs::symlink_metadata(e.path()) else {
            continue;
        };
        if meta.is_dir() && depth < 4 {
            collect(&e.path(), depth + 1, out);
        } else if meta.is_file()
            && meta.len() <= MAX_FILE_BYTES
            && (name.ends_with(".js") || name.ends_with(".mjs"))
        {
            out.push(e.path());
        }
    }
}

/// The phrases of one script: around each "Echo" (a word of its own, "Echo's" too), the text up
/// to where code would begin on either side — a line end, a backtick, a double quote, `<`, `>`,
/// `$`, `{`, `}`, or a single quote that isn't an apostrophe between two letters.
pub fn phrases_in(text: &str) -> Vec<String> {
    let c: Vec<char> = text.chars().collect();
    let word = |i: usize| c.get(i).is_some_and(|x| x.is_alphanumeric() || *x == '_');
    let stops = |i: usize| -> bool {
        match c[i] {
            '\n' | '\r' | '`' | '"' | '<' | '>' | '$' | '{' | '}' => true,
            '\'' => {
                // `\'` inside a single-quoted string, and an apostrophe in a word, are text.
                let escaped = i > 0 && c[i - 1] == '\\';
                let apostrophe = i > 0
                    && c[i - 1].is_alphabetic()
                    && c.get(i + 1).is_some_and(|x| x.is_alphabetic());
                !(escaped || apostrophe)
            }
            _ => false,
        }
    };
    let mut out = Vec::new();
    let mut i = 0;
    while i + 4 <= c.len() {
        let at_word = c[i..i + 4] == ['E', 'c', 'h', 'o'] && (i == 0 || !word(i - 1));
        let ends = !word(i + 4) || matches!(c.get(i + 4), Some('\'' | '’'));
        if !(at_word && ends) {
            i += 1;
            continue;
        }
        let mut start = i;
        while start > 0 && !stops(start - 1) {
            start -= 1;
        }
        let mut end = i + 4;
        while end < c.len() && !stops(end) {
            end += 1;
        }
        let raw: String = c[start..end].iter().collect();
        let phrase = decode(&raw);
        if !phrase.is_empty() && phrase.chars().count() <= MAX_PHRASE {
            out.push(phrase);
        }
        i = end.max(i + 4);
    }
    out
}

/// A phrase as the page shows it: JavaScript's escapes and a few HTML entities read, white space
/// folded, trimmed.
fn decode(raw: &str) -> String {
    let text = raw
        .replace("\\'", "'")
        .replace("\\\"", "\"")
        .replace("\\\\", "\\")
        .replace("&amp;", "&")
        .replace("&nbsp;", " ")
        .replace("&mdash;", "—")
        .replace("&rarr;", "→")
        .replace("&#39;", "'")
        .replace("&quot;", "\"");
    text.split_whitespace().collect::<Vec<_>>().join(" ")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn phrases_are_the_static_text_around_echo() {
        let js = r#"
const a = `<p class="x">Claude Code opens in Echo's panel with this vault as its project — its <code>CLAUDE.md</code></p>`
const b = 'Each vault is a folder you own; Echo changes nothing in it until you save something.'
const c = `${esc(v.name)} · Echo will create raw_inbox/ with a README`
say('Echo\'s people can\'t be read')
const d = "a script that says echo and Echoes, not Echo the app"
// Echo's people as pages
const e = el.dataset.echo || 'Echo'
"#;
        let p = phrases_in(js);
        assert_eq!(
            p,
            [
                "Claude Code opens in Echo's panel with this vault as its project — its",
                "Each vault is a folder you own; Echo changes nothing in it until you save something.",
                "· Echo will create raw_inbox/ with a README",
                "Echo's people can't be read",
                "a script that says echo and Echoes, not Echo the app",
                "// Echo's people as pages",
                "Echo",
            ]
        );
    }

    #[test]
    fn a_package_gives_its_phrases_once_each_from_its_scripts_only() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(
            dir.path().join("main.js"),
            "say('Echo keeps it'); say('Echo keeps it')",
        )
        .unwrap();
        std::fs::create_dir_all(dir.path().join("lib")).unwrap();
        std::fs::write(dir.path().join("lib/view.mjs"), "x = `Ask Echo first`").unwrap();
        std::fs::write(dir.path().join("README.md"), "Echo, the app").unwrap();
        std::fs::create_dir_all(dir.path().join(".git")).unwrap();
        std::fs::write(dir.path().join(".git/hook.js"), "'Echo hidden'").unwrap();
        assert_eq!(
            echo_phrases(dir.path()),
            ["Ask Echo first", "Echo keeps it"]
        );
    }
}
