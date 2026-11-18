//! Teams WebVTT and plain-text transcripts: cues, speaker matching and `transcript.md`.
use super::model::{MeAlias, Person};
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

/// One cue: who spoke (`voice`, as the file writes it) from `start` to `end` seconds.
#[derive(Debug, Clone, PartialEq)]
pub struct Cue {
    pub start: f64,
    pub end: f64,
    pub voice: String,
    pub text: String,
}

/// One turn of `segments.json`: consecutive cues of one voice less than [`MERGE_GAP`] apart.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Segment {
    /// As written in the transcript: the key for speaker mapping.
    pub voice: String,
    /// `me` or `remote`.
    pub speaker: String,
    pub name: String,
    pub address: Option<String>,
    pub start: f64,
    pub end: f64,
    pub text: String,
}

/// Cues of one voice closer than this (seconds) are one turn.
const MERGE_GAP: f64 = 2.0;
/// A plain-text line's speaker name is at most this long.
const NAME_MAX: usize = 80;

/// `HH:MM:SS.mmm` or `MM:SS.mmm` (a comma also separates the milliseconds).
fn parse_time(s: &str) -> Option<f64> {
    let parts: Vec<&str> = s.trim().split(':').collect();
    if !(2..=3).contains(&parts.len()) {
        return None;
    }
    let mut seconds = 0.0;
    for (i, part) in parts.iter().enumerate() {
        let last = i == parts.len() - 1;
        let valid = !part.is_empty()
            && part
                .chars()
                .all(|c| c.is_ascii_digit() || last && matches!(c, '.' | ','));
        if !valid {
            return None;
        }
        let value: f64 = part.replace(',', ".").parse().ok()?;
        seconds = seconds * 60.0 + value;
    }
    Some(seconds)
}

/// `&amp; &lt; &gt; &quot; &#39;` (and `&apos; &nbsp;`), `&amp;` last so nothing decodes twice.
fn decode_entities(s: &str) -> String {
    s.replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&quot;", "\"")
        .replace("&#39;", "'")
        .replace("&apos;", "'")
        .replace("&nbsp;", " ")
        .replace("&amp;", "&")
}

/// The name in the first `<v Name>` (or `<v.class Name>`) tag, if any.
fn voice_of(payload: &str) -> String {
    let Some(at) = payload.find("<v") else {
        return String::new();
    };
    let tag = &payload[at + 2..];
    let Some(close) = tag.find('>') else {
        return String::new();
    };
    let tag = &tag[..close];
    if !tag.starts_with([' ', '.', '\t']) {
        return String::new();
    }
    // Classes (`.loud`) come before the first space.
    let name = tag.trim_start_matches(|c: char| !c.is_whitespace());
    decode_entities(&collapse(name))
}

/// The text with every tag removed and entities decoded, on one line.
fn plain(payload: &str) -> String {
    let mut out = String::with_capacity(payload.len());
    let mut in_tag = false;
    for ch in payload.chars() {
        match ch {
            '<' => in_tag = true,
            '>' if in_tag => in_tag = false,
            _ if !in_tag => out.push(ch),
            _ => {}
        }
    }
    decode_entities(&collapse(&out))
}

fn collapse(s: &str) -> String {
    s.split_whitespace().collect::<Vec<_>>().join(" ")
}

/// The cues of a WebVTT file: each block with a `start --> end` line, its voice from `<v …>`
/// and its text without tags. Headers, `NOTE`, `STYLE` and `REGION` blocks are skipped.
pub fn parse_vtt(text: &str) -> Vec<Cue> {
    let text = text.replace("\r\n", "\n").replace('\r', "\n");
    let mut cues = Vec::new();
    let mut block: Vec<&str> = Vec::new();
    for line in text.lines().chain(std::iter::once("")) {
        if !line.trim().is_empty() {
            block.push(line);
            continue;
        }
        if let Some(cue) = cue_of(&block) {
            cues.push(cue);
        }
        block.clear();
    }
    cues
}

fn cue_of(block: &[&str]) -> Option<Cue> {
    let first = block.first()?.trim_start();
    // The `WEBVTT` header may run straight into the first cue, so it is not skipped here.
    if ["NOTE", "STYLE", "REGION"]
        .iter()
        .any(|k| first.starts_with(k))
    {
        return None;
    }
    let at = block.iter().position(|l| l.contains("-->"))?;
    let (from, rest) = block[at].split_once("-->")?;
    let start = parse_time(from)?;
    let end = parse_time(rest.split_whitespace().next()?)?;
    let payload = block[at + 1..].join("\n");
    let text = plain(&payload);
    (!text.is_empty()).then(|| Cue {
        start,
        end: end.max(start),
        voice: voice_of(&payload),
        text,
    })
}

/// A leading `[hh:mm:ss]` or `hh:mm:ss` and the rest of the line.
fn leading_time(line: &str) -> (Option<f64>, &str) {
    if let Some(inner) = line.strip_prefix('[') {
        if let Some((time, rest)) = inner.split_once(']') {
            if let Some(t) = parse_time(time) {
                return (Some(t), rest.trim_start());
            }
        }
    }
    if let Some((first, rest)) = line.split_once(char::is_whitespace) {
        if first.contains(':') {
            if let Some(t) = parse_time(first) {
                return (Some(t), rest.trim_start());
            }
        }
    }
    (None, line)
}

/// The cues of a plain-text transcript: `Name: text` lines, each optionally after a
/// `[hh:mm:ss]` time; other lines continue the previous turn. Without times every cue starts
/// where the last time left off.
pub fn parse_txt(text: &str) -> Vec<Cue> {
    let mut cues: Vec<Cue> = Vec::new();
    let mut at = 0.0;
    for raw in text.lines() {
        let line = raw.trim();
        if line.is_empty() {
            continue;
        }
        let (time, rest) = leading_time(line);
        if let Some(t) = time {
            at = t;
        }
        let turn = rest.split_once(": ").and_then(|(name, said)| {
            let name = collapse(name);
            let said = collapse(said);
            let valid = !name.is_empty()
                && name.chars().count() <= NAME_MAX
                && !name.contains("://")
                && !said.is_empty();
            valid.then_some((name, said))
        });
        match (turn, cues.last_mut()) {
            (Some((voice, said)), _) => cues.push(Cue {
                start: at,
                end: at,
                voice,
                text: said,
            }),
            (None, Some(last)) => {
                last.text.push(' ');
                last.text.push_str(&collapse(rest));
            }
            (None, None) => {}
        }
    }
    cues
}

fn norm(s: &str) -> String {
    collapse(s).to_lowercase()
}

/// "Novak, Marek" -> "marek novak".
fn flipped(voice: &str) -> Option<String> {
    let (last, first) = voice.split_once(',')?;
    let name = norm(&format!("{first} {last}"));
    (!name.is_empty()).then_some(name)
}

/// The attendee a voice names: the full name, "Last, First", a first name only one attendee
/// has, or an e-mail local part. `None` rather than a guess.
fn match_person<'a>(voice: &str, people: &'a [Person]) -> Option<&'a Person> {
    let v = norm(voice);
    if v.is_empty() {
        return None;
    }
    if let Some(p) = people.iter().find(|p| norm(&p.name) == v) {
        return Some(p);
    }
    if let Some(f) = flipped(voice) {
        if let Some(p) = people.iter().find(|p| norm(&p.name) == f) {
            return Some(p);
        }
    }
    if !v.contains(' ') {
        let first: Vec<&Person> = people
            .iter()
            .filter(|p| norm(&p.name).split(' ').next() == Some(v.as_str()))
            .collect();
        match first.len() {
            1 => return Some(first[0]),
            0 => {}
            _ => return None,
        }
    }
    let local = v.replace(' ', ".");
    people.iter().find(|p| {
        p.address
            .split('@')
            .next()
            .is_some_and(|l| !l.is_empty() && l.eq_ignore_ascii_case(&local))
    })
}

fn is_me(name: &str, me: &MeAlias) -> bool {
    let name = norm(name);
    !name.is_empty() && (norm(&me.name) == name || me.aliases.iter().any(|a| norm(a) == name))
}

/// Me among the meeting's people: the one with the account's e-mail, else the one with my name
/// (or an alias).
fn my_person<'a>(people: &'a [Person], me: &MeAlias) -> Option<&'a Person> {
    me.address
        .as_deref()
        .map(str::trim)
        .filter(|a| !a.is_empty())
        .and_then(|a| people.iter().find(|p| p.address.eq_ignore_ascii_case(a)))
        .or_else(|| people.iter().find(|p| is_me(&p.name, me)))
}

/// Whether `p` is the person [`my_person`] finds.
fn is_me_person(p: &Person, people: &[Person], me: &MeAlias) -> bool {
    my_person(people, me).is_some_and(|mine| mine.address.eq_ignore_ascii_case(&p.address))
}

/// Who a voice is: `(speaker, name, address)`. Me (my name or an alias; my attendee entry by
/// e-mail first), else an attendee (see [`match_person`]), else `@N` as "Speaker N", else the
/// name as written, with no address.
pub fn resolve_voice(
    voice: &str,
    people: &[Person],
    me: &MeAlias,
) -> (String, String, Option<String>) {
    let mine = is_me(voice, me) || flipped(voice).is_some_and(|f| is_me(&f, me));
    if mine {
        let address = my_person(people, me).map(|p| p.address.clone());
        let name = if me.name.trim().is_empty() {
            collapse(voice)
        } else {
            collapse(&me.name)
        };
        return ("me".into(), name, address);
    }
    if let Some(p) = match_person(voice, people) {
        let speaker = if is_me_person(p, people, me) {
            "me"
        } else {
            "remote"
        };
        return (speaker.into(), p.name.clone(), Some(p.address.clone()));
    }
    let voice = voice.trim();
    if let Some(n) = voice
        .strip_prefix('@')
        .filter(|n| !n.is_empty() && n.chars().all(|c| c.is_ascii_digit()))
    {
        return ("remote".into(), format!("Speaker {n}"), None);
    }
    if voice.is_empty() {
        return ("remote".into(), "Unknown speaker".into(), None);
    }
    ("remote".into(), collapse(voice), None)
}

/// The turns of a transcript, speakers matched to `people` and `me`; one voice's cues less
/// than two seconds apart are merged.
pub fn segments(cues: &[Cue], people: &[Person], me: &MeAlias) -> Vec<Segment> {
    let mut out: Vec<Segment> = Vec::new();
    for c in cues {
        let text = c.text.trim();
        if text.is_empty() {
            continue;
        }
        if let Some(last) = out.last_mut() {
            if last.voice == c.voice && c.start - last.end < MERGE_GAP {
                last.end = last.end.max(c.end);
                last.text.push(' ');
                last.text.push_str(text);
                continue;
            }
        }
        let (speaker, name, address) = resolve_voice(&c.voice, people, me);
        out.push(Segment {
            voice: c.voice.clone(),
            speaker,
            name,
            address,
            start: c.start,
            end: c.end,
            text: text.into(),
        });
    }
    out
}

/// Names the speakers again: a voice in `mapping` is the person with that address (from
/// `people`), every other voice is matched as [`segments`] matches it.
pub fn map_speakers(
    segments: &mut [Segment],
    mapping: &BTreeMap<String, String>,
    people: &[Person],
    me: &MeAlias,
) {
    for s in segments {
        let mapped = mapping.get(&s.voice).and_then(|address| {
            people
                .iter()
                .find(|p| p.address.eq_ignore_ascii_case(address))
        });
        let (speaker, name, address) = match mapped {
            Some(p) => (
                if is_me_person(p, people, me) {
                    "me"
                } else {
                    "remote"
                }
                .to_string(),
                p.name.clone(),
                Some(p.address.clone()),
            ),
            None => resolve_voice(&s.voice, people, me),
        };
        s.speaker = speaker;
        s.name = name;
        s.address = address;
    }
}

/// `hh:mm:ss`
pub fn clock(seconds: f64) -> String {
    let s = seconds.max(0.0).floor() as u64;
    format!("{:02}:{:02}:{:02}", s / 3600, s / 60 % 60, s % 60)
}

/// `transcript.md`: `# Title`, the header lines, then `**Name** [hh:mm:ss]` and the text of
/// every turn.
pub fn transcript_md(title: &str, header_lines: &[String], segments: &[Segment]) -> String {
    let title = collapse(title);
    let mut md = format!(
        "# {}\n\n",
        if title.is_empty() { "Meeting" } else { &title }
    );
    if !header_lines.is_empty() {
        md.push_str(&header_lines.join("\n"));
        md.push_str("\n\n");
    }
    for (i, s) in segments.iter().enumerate() {
        if i > 0 {
            md.push('\n');
        }
        md.push_str(&format!(
            "**{}** [{}]\n{}\n",
            s.name,
            clock(s.start),
            s.text
        ));
    }
    md
}

#[cfg(test)]
mod tests {
    use super::*;

    fn me() -> MeAlias {
        MeAlias {
            name: "Taylor Morgan".into(),
            aliases: vec!["TM".into()],
            address: None,
        }
    }
    fn person(name: &str, address: &str) -> Person {
        Person {
            name: name.into(),
            address: address.into(),
        }
    }
    fn cue(start: f64, end: f64, voice: &str, text: &str) -> Cue {
        Cue {
            start,
            end,
            voice: voice.into(),
            text: text.into(),
        }
    }

    const SAMPLE: &str = "WEBVTT\r\n\r\n0f3d6a1e/12-0\r\n00:00:01.000 --> 00:00:03.000\r\n<v Jeroen de Vries>Hi &amp; bye</v>\r\n\r\n00:00:04.500 --> 00:00:06.250 align:start\r\n<v @1>Who is <b>this</b>?\r\nSecond &lt;line&gt; &quot;quoted&quot; it&#39;s</v>\r\n\r\nNOTE a comment block\r\n\r\n01:02:03.000 --> 01:02:04.000\r\nNo voice here\r\n\r\n02:05.000 --> 02:06.000\r\n<v.loud Marek Novak>Short timestamps</v>\r\n";

    #[test]
    fn parse_vtt_reads_voices_and_strips_tags() {
        let cues = parse_vtt(SAMPLE);
        assert_eq!(cues.len(), 4, "{cues:?}");
        assert_eq!(cues[0], cue(1.0, 3.0, "Jeroen de Vries", "Hi & bye"));
        assert_eq!(cues[1].voice, "@1", "the voice is kept as Teams wrote it");
        assert_eq!(cues[1].text, "Who is this? Second <line> \"quoted\" it's");
        assert_eq!((cues[1].start, cues[1].end), (4.5, 6.25));
        assert_eq!(cues[2], cue(3723.0, 3724.0, "", "No voice here"));
        assert_eq!(
            cues[3],
            cue(125.0, 126.0, "Marek Novak", "Short timestamps")
        );
        // "@1" reads as "Speaker 1".
        let segments = segments(&cues, &[], &me());
        assert_eq!(segments[1].name, "Speaker 1");
        assert_eq!(segments[1].voice, "@1");
        assert!(parse_vtt("").is_empty());
        assert!(parse_vtt("WEBVTT\n\nnot a cue\n").is_empty());
        // A header that runs straight into the first cue.
        assert_eq!(
            parse_vtt("WEBVTT\n00:00:01.000 --> 00:00:02.000\n<v A>x</v>"),
            vec![cue(1.0, 2.0, "A", "x")]
        );
    }

    #[test]
    fn segments_match_speakers_to_attendees() {
        let people = vec![
            person("Marek Novak", "marek.novak@example.test"),
            person("Jeroen de Vries", "jeroen@example.test"),
            person("Taylor Morgan", "taylor@example.test"),
            person("Ana Silva", "asilva@example.test"),
            person("Ana Costa", "ana.costa@example.test"),
        ];
        let voices = [
            "Novak, Marek",
            "Marek",
            "@1",
            "TM",
            "taylor morgan",
            "asilva",
            "Jeroen",
            "Ana",
            "Guest Person (External)",
            "@2",
            "",
        ];
        let cues: Vec<Cue> = voices
            .iter()
            .enumerate()
            .map(|(i, v)| cue(i as f64 * 10.0, i as f64 * 10.0 + 1.0, v, "text"))
            .collect();
        let s = segments(&cues, &people, &me());
        let got: Vec<(&str, &str, Option<&str>)> = s
            .iter()
            .map(|s| (s.speaker.as_str(), s.name.as_str(), s.address.as_deref()))
            .collect();
        assert_eq!(
            got,
            vec![
                ("remote", "Marek Novak", Some("marek.novak@example.test")),
                ("remote", "Marek Novak", Some("marek.novak@example.test")),
                ("remote", "Speaker 1", None),
                ("me", "Taylor Morgan", Some("taylor@example.test")),
                ("me", "Taylor Morgan", Some("taylor@example.test")),
                ("remote", "Ana Silva", Some("asilva@example.test")),
                ("remote", "Jeroen de Vries", Some("jeroen@example.test")),
                // Two attendees are called Ana: no guess.
                ("remote", "Ana", None),
                ("remote", "Guest Person (External)", None),
                ("remote", "Speaker 2", None),
                ("remote", "Unknown speaker", None),
            ]
        );
        assert_eq!(
            s[0].voice, "Novak, Marek",
            "the VTT voice is the mapping key"
        );
        // "Me" without an attendee entry: no address, still me.
        let alone = segments(&[cue(0.0, 1.0, "TM", "hi")], &[], &me());
        assert_eq!(
            (alone[0].speaker.as_str(), alone[0].address.as_deref()),
            ("me", None)
        );
    }

    #[test]
    fn me_is_found_among_attendees_by_email_first() {
        let me = MeAlias {
            address: Some("taylor@example.test".into()),
            ..me()
        };
        // Teams lists me under another display name; a namesake has my exact name.
        let people = vec![
            person("Morgan, Taylor (EPAM)", "taylor@example.test"),
            person("Taylor Morgan", "taylor.morgan@other.test"),
        ];
        let s = segments(
            &[
                cue(0.0, 1.0, "TM", "hi"),
                cue(10.0, 11.0, "Morgan, Taylor (EPAM)", "again"),
            ],
            &people,
            &me,
        );
        assert_eq!(
            (
                s[0].speaker.as_str(),
                s[0].name.as_str(),
                s[0].address.as_deref()
            ),
            ("me", "Taylor Morgan", Some("taylor@example.test"))
        );
        assert_eq!(
            (s[1].speaker.as_str(), s[1].address.as_deref()),
            ("me", Some("taylor@example.test"))
        );
        let mut mapped = segments(&[cue(0.0, 1.0, "@1", "hi")], &people, &me);
        let mapping = BTreeMap::from([("@1".to_string(), "taylor@example.test".to_string())]);
        map_speakers(&mut mapped, &mapping, &people, &me);
        assert_eq!(mapped[0].speaker, "me");
        // Without an address, the name decides as before.
        let by_name = segments(&[cue(0.0, 1.0, "TM", "hi")], &people, &self::me());
        assert_eq!(
            by_name[0].address.as_deref(),
            Some("taylor.morgan@other.test")
        );
    }

    #[test]
    fn segments_merge_same_speaker_within_two_seconds() {
        let people = [];
        let merged = segments(
            &[cue(0.0, 3.0, "A", "One."), cue(4.5, 6.0, "A", "Two.")],
            &people,
            &me(),
        );
        assert_eq!(merged.len(), 1);
        assert_eq!((merged[0].start, merged[0].end), (0.0, 6.0));
        assert_eq!(merged[0].text, "One. Two.");
        let apart = segments(
            &[cue(0.0, 3.0, "A", "One."), cue(5.5, 6.0, "A", "Two.")],
            &people,
            &me(),
        );
        assert_eq!(apart.len(), 2);
        let others = segments(
            &[cue(0.0, 3.0, "A", "One."), cue(3.5, 6.0, "B", "Two.")],
            &people,
            &me(),
        );
        assert_eq!(others.len(), 2);
        // Empty cues are dropped and never glue two turns together.
        let blank = segments(&[cue(0.0, 1.0, "A", "  ")], &people, &me());
        assert!(blank.is_empty());
    }

    #[test]
    fn parse_txt_reads_name_colon_lines() {
        let text = "Weekly sync notes\nJeroen de Vries: Hi all\nMarek Novak: Hello\nsee https://example.test/x\n\n[00:01:05] Jeroen de Vries: Later\n00:02:00 Marek Novak: Bye\n";
        let cues = parse_txt(text);
        assert_eq!(
            cues,
            vec![
                cue(0.0, 0.0, "Jeroen de Vries", "Hi all"),
                cue(0.0, 0.0, "Marek Novak", "Hello see https://example.test/x"),
                cue(65.0, 65.0, "Jeroen de Vries", "Later"),
                cue(120.0, 120.0, "Marek Novak", "Bye"),
            ]
        );
        assert!(parse_txt("just prose\nwithout speakers\n").is_empty());
        assert!(parse_txt("").is_empty());
    }

    #[test]
    fn transcript_md_lists_speakers_with_times() {
        let people = [person("Jeroen de Vries", "jeroen@example.test")];
        let s = segments(
            &[
                cue(1.0, 3.0, "Jeroen de Vries", "Hi"),
                cue(3725.0, 3726.0, "TM", "Bye"),
            ],
            &people,
            &me(),
        );
        let md = transcript_md(
            "Weekly sync",
            &[
                "Date: 2026-11-04 16:04".into(),
                "Organizer: Jeroen de Vries".into(),
            ],
            &s,
        );
        assert_eq!(
            md,
            "# Weekly sync\n\nDate: 2026-11-04 16:04\nOrganizer: Jeroen de Vries\n\n**Jeroen de Vries** [00:00:01]\nHi\n\n**Taylor Morgan** [01:02:05]\nBye\n"
        );
    }
}
