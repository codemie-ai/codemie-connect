//! The hidden files a plugin may write in a folder the user gave it (Echo 0.10's rules, from its
//! plugin API): nothing hidden, except a `.gitignore` (not inside a hidden folder), Obsidian's own
//! settings `.obsidian/<name>.json` at any depth under plain folders (never the files that switch
//! community code on), and a skill's Markdown at `.claude/skills/<name>/<file>.md`, whose text is
//! checked (`skill_md_problem`) so a skill can't run commands or choose how it runs.

/// The frontmatter keys a plugin's skill may set.
pub const SKILL_KEYS: [&str; 6] = [
    "name",
    "description",
    "when_to_use",
    "argument-hint",
    "disable-model-invocation",
    "user-invocable",
];

/// Obsidian's settings files that turn code on, never written by a plugin.
const OBSIDIAN_SWITCHES: [&str; 3] = [
    "community-plugins.json",
    "core-plugins.json",
    "core-plugins-migration.json",
];

/// The parts of a relative path, `.` and empty parts left out.
fn parts(rel: &str) -> Vec<&str> {
    rel.split('/')
        .filter(|c| !c.is_empty() && *c != ".")
        .collect()
}

fn hidden(part: &str) -> bool {
    part.starts_with('.')
}

/// A skill's name: 1–64 of a–z, 0–9 and `-`.
pub fn skill_name(name: &str) -> bool {
    (1..=64).contains(&name.len())
        && name
            .bytes()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-')
}

/// `name` ends with `ext` after something, isn't hidden and has no `:`.
fn named(name: &str, ext: &str) -> bool {
    name.len() > ext.len() && name.ends_with(ext) && !hidden(name) && !name.contains(':')
}

/// May a plugin write `rel` (a file, or with `folder` a folder it makes) in a folder it was given?
pub fn hidden_ok(rel: &str, folder: bool) -> bool {
    let p = parts(rel);
    if !p.iter().any(|c| hidden(c)) {
        return true;
    }
    let n = p.len();
    let plain_above = |upto: usize| !p[..upto].iter().any(|c| hidden(c));
    if !folder {
        let last = p[n - 1];
        if last == ".gitignore" {
            return plain_above(n - 1);
        }
        if n >= 2 && p[n - 2] == ".obsidian" {
            return plain_above(n - 2)
                && last.is_ascii()
                && named(last, ".json")
                && !OBSIDIAN_SWITCHES.contains(&last.to_ascii_lowercase().as_str());
        }
        return n == 4
            && p[0] == ".claude"
            && p[1] == "skills"
            && skill_name(p[2])
            && named(p[3], ".md");
    }
    if p[n - 1] == ".obsidian" {
        return plain_above(n - 1);
    }
    if (n == 1 && p[0] == ".claude") || (n == 2 && p[0] == ".claude" && p[1] == "skills") {
        return true;
    }
    n == 3 && p[0] == ".claude" && p[1] == "skills" && skill_name(p[2])
}

/// `rel` is under the folder's own `.claude/skills` (any case).
pub fn in_skills(rel: &str) -> bool {
    let p = parts(rel);
    p.len() >= 2 && p[0].eq_ignore_ascii_case(".claude") && p[1].eq_ignore_ascii_case("skills")
}

/// Why `md` can't be a skill's Markdown written by a plugin, or `None` when it can: it never runs a
/// command (`` !` ``, `!$`, a fence opened with `!`), its lines end with `\n`, and its frontmatter
/// holds only `SKILL_KEYS`, each a plain value (or a `|`/`>` block).
pub fn skill_md_problem(md: &str) -> Option<String> {
    let runs = "a skill can't run commands";
    if md.contains("!`") {
        return Some(format!("{runs}: “!`” in it runs one when the skill loads"));
    }
    if md.contains("!$") {
        return Some(format!("{runs}: “!$” turns an argument into one"));
    }
    if md.replace("\r\n", "").contains('\r') {
        return Some("a skill's lines end with a line feed, never a carriage return alone".into());
    }
    if fence_runs_command(md) {
        return Some(format!(
            "{runs}: a code block opened with “!” runs one when the skill loads"
        ));
    }
    let rest = md.trim_start_matches(|c: char| c == '\u{feff}' || c.is_whitespace());
    if !rest.starts_with("---") {
        return None;
    }
    let mut lines = rest.lines();
    if lines.next().unwrap_or("").trim_end() != "---" {
        return Some("a skill's frontmatter starts with a line “---” alone".into());
    }
    let keys = SKILL_KEYS.join(", ");
    // The indent of the `|`/`>` block being read: 0 until its first line sets it.
    let mut block: Option<usize> = None;
    for line in lines {
        let l = line.trim_end();
        if l == "---" {
            return None;
        }
        if l.trim_start().is_empty() || l.starts_with('#') {
            continue;
        }
        if l.starts_with(' ') || l.starts_with('\t') {
            let indent = l.len() - l.trim_start_matches(' ').len();
            let at = match block {
                Some(0) => Some(indent),
                other => other,
            };
            if !matches!(at, Some(a) if a > 0 && indent >= a) {
                return Some(format!(
                    "a skill's frontmatter holds only {keys}, each a plain value: “{}” isn't",
                    l.trim()
                ));
            }
            block = at;
            continue;
        }
        let (key, value) = l.split_once(':').unwrap_or((l, ""));
        if !SKILL_KEYS.contains(&key) {
            let k = key.trim();
            let does = if ["hooks", "allowed-tools", "shell"].contains(&k.to_lowercase().as_str()) {
                "run commands"
            } else {
                "choose how it runs"
            };
            return Some(format!(
                "a skill can't {does}: “{k}” in its frontmatter (it holds only {keys})"
            ));
        }
        let v = value.trim();
        if v.starts_with(['{', '[', '!', '&', '*', '<', '-', '?', '%', '@']) {
            return Some(format!(
                "a skill's frontmatter holds only plain values: “{key}” has “{v}”"
            ));
        }
        block = if v.starts_with(['|', '>']) {
            let chomp = &v[1..];
            if !(v.len() <= 3 && chomp.chars().all(|c| matches!(c, '-' | '+' | '1'..='9'))) {
                return Some(format!(
                    "a skill's frontmatter holds only plain values: “{key}” has “{v}”"
                ));
            }
            Some(0)
        } else {
            None
        };
    }
    Some("a skill's frontmatter has no closing “---”".into())
}

/// A run of three or more backticks or tildes followed (past spaces and tabs) by `!`.
fn fence_runs_command(md: &str) -> bool {
    let b = md.as_bytes();
    let mut i = 0;
    while i < b.len() {
        let c = b[i];
        let mut run = 0;
        while i + run < b.len() && b[i + run] == c {
            run += 1;
        }
        if (c == b'`' || c == b'~') && run >= 3 {
            let mut j = i + run;
            while j < b.len() && (b[j] == b' ' || b[j] == b'\t') {
                j += 1;
            }
            if j < b.len() && b[j] == b'!' {
                return true;
            }
        }
        i += run.max(1);
    }
    false
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn hidden_files_a_plugin_may_write() {
        for ok in [
            "notes/a.md",
            ".gitignore",
            "sub/.gitignore",
            ".obsidian/app.json",
            "work/.obsidian/daily-notes.json",
            ".claude/skills/twin/SKILL.md",
            ".claude/skills/twin/notes.md",
        ] {
            assert!(hidden_ok(ok, false), "{ok}");
        }
        for no in [
            ".git/config",
            ".hidden.md",
            "notes/.draft.md",
            ".obsidian/community-plugins.json",
            ".obsidian/Core-Plugins.json",
            ".obsidian/plugins/x/main.js",
            ".obsidian/plugins/x/data.json",
            ".trash/.obsidian/app.json",
            ".git/.gitignore",
            ".obsidian/.json",
            ".obsidian/applé.json",
            ".claude/skills/My Skill/SKILL.md",
            ".claude/skills/twin/run.sh",
            ".claude/settings.json",
            ".claude/commands/c.md",
        ] {
            assert!(!hidden_ok(no, false), "{no}");
        }
        for ok in [
            ".obsidian",
            "a/.obsidian",
            ".claude",
            ".claude/skills",
            ".claude/skills/twin",
        ] {
            assert!(hidden_ok(ok, true), "{ok}");
        }
        for no in [
            ".git",
            ".claude/agents",
            ".claude/skills/Bad Name",
            ".x/.obsidian",
        ] {
            assert!(!hidden_ok(no, true), "{no}");
        }
        assert!(in_skills(".Claude/Skills/x/SKILL.md"));
        assert!(!in_skills("notes/.claude/skills/x.md"));
    }

    #[test]
    fn skill_markdown_that_could_run_commands_is_refused() {
        let ok = "---\nname: twin\ndescription: My digital twin\nwhen_to_use: |\n  when asked about me\n  and my work\n---\n# Twin\n\nUse `ls` freely.\n";
        assert_eq!(skill_md_problem(ok), None);
        assert_eq!(skill_md_problem("# No frontmatter\n"), None);
        for (bad, says) in [
            ("Run !`date` now", "“!`” in it runs one"),
            ("Use !$ARGUMENTS", "“!$” turns an argument"),
            ("a\rb", "carriage return"),
            ("```!\nrm -rf\n```\n", "code block opened with “!”"),
            ("~~~ \t!\nx\n~~~\n", "code block opened with “!”"),
            (
                "---\nname: x\nallowed-tools: Bash\n---\n",
                "can't run commands: “allowed-tools”",
            ),
            (
                "---\nname: x\nmodel: opus\n---\n",
                "can't choose how it runs: “model”",
            ),
            (
                "---\nname: [x]\n---\n",
                "only plain values: “name” has “[x]”",
            ),
            ("---\nname: x\n  extra: 1\n---\n", "each a plain value"),
            ("---\nname: x\n", "no closing “---”"),
            ("--- x\nname: y\n---\n", "starts with a line “---” alone"),
            ("---\ndescription: >x\n---\n", "only plain values"),
        ] {
            let why = skill_md_problem(bad).unwrap_or_else(|| panic!("{bad:?} passed"));
            assert!(why.contains(says), "{bad:?}: {why}");
        }
    }
}
