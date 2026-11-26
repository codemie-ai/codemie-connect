//! The native date parser (ask-capture design § 9 "The parser", rulings 20–21): the single date
//! rule in Connect, in English, Russian and Ukrainian. `parse` reads quick capture's `due`
//! phrase for `capture_parse`; `window` reads Ask's date span for a question. Both find the
//! phrase the same way — never inside quotes, on whole-word boundaries, the last match in the
//! text wins, and one leading word ("by", "on", "due", "до", "к", "в", "у", "на") is folded into
//! it — then resolve what they found differently: "next week" is tomorrow's Monday as a due
//! day, the whole week as a window.
//!
//! Offsets are character offsets throughout: the input is read as `Vec<char>` and never sliced
//! by byte index, so Cyrillic text never panics on a non-boundary slice (the bug step 8 hit in
//! a release build).

use super::prompts::time_zone;
use chrono::{Datelike, Duration, LocalResult, Months, NaiveDate, TimeZone, Utc};
use chrono_tz::Tz;
use serde::Serialize;

/// `capture_parse`'s answer (design § 9): the title with the date phrase removed, the due day
/// read from it (`None` when no date was read), and the phrase's own text and character
/// offsets in the input.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Parsed {
    pub title: String,
    pub due: Option<String>,
    pub phrase: Option<String>,
    pub start: Option<usize>,
    pub end: Option<usize>,
}

/// Ask's date window (design § 3, ruling 8): an inclusive `YYYY-MM-DD` span, and the phrase it
/// was read from (`None` for the default 7-days-back-to-7-ahead span).
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Window {
    pub from: String,
    pub to: String,
    pub phrase: Option<String>,
}

/// `capture_parse`'s read of `text`, and `window`'s read of a date phrase in `question` for
/// Ask's context window — the only two callers of the parser below.
pub fn parse(text: &str, now: i64, zone: &str) -> Parsed {
    let chars: Vec<char> = text.chars().collect();
    let today = today_in(now, time_zone(zone));
    match last_candidate(&chars, today, false)
        .and_then(|c| resolve_due(c.token, today).map(|due| (c, due)))
    {
        Some((c, due)) => Parsed {
            title: tidy_title(&chars, Some((c.start, c.end))),
            due: Some(due.format("%Y-%m-%d").to_string()),
            phrase: Some(chars[c.start..c.end].iter().collect()),
            start: Some(c.start),
            end: Some(c.end),
        },
        None => Parsed {
            title: tidy_title(&chars, None),
            due: None,
            phrase: None,
            start: None,
            end: None,
        },
    }
}

pub fn window(question: &str, now: i64, zone: &str) -> Window {
    let chars: Vec<char> = question.chars().collect();
    let today = today_in(now, time_zone(zone));
    match last_candidate(&chars, today, true)
        .and_then(|c| resolve_window(c.token, today).map(|span| (c, span)))
    {
        Some((c, (from, to))) => Window {
            from: from.format("%Y-%m-%d").to_string(),
            to: to.format("%Y-%m-%d").to_string(),
            phrase: Some(chars[c.start..c.end].iter().collect()),
        },
        None => Window {
            from: (today - Duration::days(7)).format("%Y-%m-%d").to_string(),
            to: (today + Duration::days(7)).format("%Y-%m-%d").to_string(),
            phrase: None,
        },
    }
}

/// One leading word folded into the phrase ahead of it.
const LEAD_WORDS: [&str; 9] = ["by", "on", "due", "до", "к", "в", "во", "у", "на"];

/// English (full and three-letter), Russian and Ukrainian (full and short) weekday names, plus
/// the inflected forms the lead words above (and [`NEXT_LEADS_RU`]/[`NEXT_LEADS_UK`]) combine
/// with: Russian's genitive "пятницы" (after "до"/"к") and accusative "пятницу", "среду",
/// "субботу" (среда, пятница and суббота are feminine, so "следующую пятницу" etc. use the
/// accusative, not the nominative); Ukrainian's accusative "п'ятницю", "середу", "суботу" the
/// same way.
const WEEKDAYS: &[(&str, u32)] = &[
    ("monday", 0),
    ("mon", 0),
    ("tuesday", 1),
    ("tue", 1),
    ("wednesday", 2),
    ("wed", 2),
    ("thursday", 3),
    ("thu", 3),
    ("friday", 4),
    ("fri", 4),
    ("saturday", 5),
    ("sat", 5),
    ("sunday", 6),
    ("sun", 6),
    ("понедельник", 0),
    ("понеділок", 0),
    ("пн", 0),
    ("вторник", 1),
    ("вівторок", 1),
    ("вт", 1),
    ("среда", 2),
    ("среду", 2),
    ("середа", 2),
    ("середу", 2),
    ("ср", 2),
    ("четверг", 3),
    ("четвер", 3),
    ("чт", 3),
    ("пятница", 4),
    ("пятницы", 4),
    ("пятницу", 4),
    ("п'ятниця", 4),
    ("п'ятницю", 4),
    ("пт", 4),
    ("суббота", 5),
    ("субботу", 5),
    ("субота", 5),
    ("суботу", 5),
    ("сб", 5),
    ("воскресенье", 6),
    ("неділя", 6),
    ("вс", 6),
    ("нд", 6),
];

/// English, Russian (genitive) and Ukrainian (genitive) month names to a `1..=12` number.
const MONTHS: &[(&str, u32)] = &[
    ("january", 1),
    ("jan", 1),
    ("января", 1),
    ("січня", 1),
    ("february", 2),
    ("feb", 2),
    ("февраля", 2),
    ("лютого", 2),
    ("march", 3),
    ("mar", 3),
    ("марта", 3),
    ("березня", 3),
    ("april", 4),
    ("apr", 4),
    ("апреля", 4),
    ("квітня", 4),
    ("may", 5),
    ("мая", 5),
    ("травня", 5),
    ("june", 6),
    ("jun", 6),
    ("июня", 6),
    ("червня", 6),
    ("july", 7),
    ("jul", 7),
    ("июля", 7),
    ("липня", 7),
    ("august", 8),
    ("aug", 8),
    ("августа", 8),
    ("серпня", 8),
    ("september", 9),
    ("sep", 9),
    ("сентября", 9),
    ("вересня", 9),
    ("october", 10),
    ("oct", 10),
    ("октября", 10),
    ("жовтня", 10),
    ("november", 11),
    ("nov", 11),
    ("ноября", 11),
    ("листопада", 11),
    ("december", 12),
    ("dec", 12),
    ("декабря", 12),
    ("грудня", 12),
];

/// "today", "tomorrow" and the like, as an offset in days from today; English, Russian and
/// Ukrainian. `-1` ("yesterday"/"вчера"/"вчора") is read only for `window` (parse's vocabulary
/// has no use for a due date in the past).
const DAY_WORDS: &[(&str, i64)] = &[
    ("today", 0),
    ("tonight", 0),
    ("tomorrow", 1),
    ("tmrw", 1),
    ("yesterday", -1),
    ("сегодня", 0),
    ("завтра", 1),
    ("послезавтра", 2),
    ("вчера", -1),
    ("сьогодні", 0),
    ("післязавтра", 2),
    ("вчора", -1),
];

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Unit {
    Days,
    Weeks,
    Months,
}

/// The unit word of "in N days/weeks/months" and "через N <unit>" (Russian and Ukrainian share
/// "через"; the unit word tells which language's day/week form it is).
const SPAN_UNITS: &[(&str, Unit)] = &[
    ("day", Unit::Days),
    ("days", Unit::Days),
    ("week", Unit::Weeks),
    ("weeks", Unit::Weeks),
    ("month", Unit::Months),
    ("months", Unit::Months),
    ("день", Unit::Days),
    ("дня", Unit::Days),
    ("дней", Unit::Days),
    ("дні", Unit::Days),
    ("днів", Unit::Days),
    ("неделю", Unit::Weeks),
    ("недели", Unit::Weeks),
    ("недель", Unit::Weeks),
    ("тиждень", Unit::Weeks),
    ("тижні", Unit::Weeks),
    ("тижнів", Unit::Weeks),
];

fn weekday_of(word: &str) -> Option<u32> {
    WEEKDAYS.iter().find(|(k, _)| *k == word).map(|&(_, v)| v)
}
fn month_of(word: &str) -> Option<u32> {
    MONTHS.iter().find(|(k, _)| *k == word).map(|&(_, v)| v)
}
fn day_offset_of(word: &str) -> Option<i64> {
    DAY_WORDS.iter().find(|(k, _)| *k == word).map(|&(_, v)| v)
}
fn span_unit_of(word: &str) -> Option<Unit> {
    SPAN_UNITS.iter().find(|(k, _)| *k == word).map(|&(_, v)| v)
}

/// A recognised date phrase, resolved later for a due day or a window span so the same match
/// can mean different things to `parse` and `window`.
#[derive(Debug, Clone, Copy)]
enum Token {
    Today,
    Yesterday,
    Tomorrow,
    DayAfterTomorrow,
    Weekday(u32),
    NextWeekday(u32),
    SpanDays(i64),
    SpanWeeks(i64),
    SpanMonths(i64),
    NextWeek,
    ThisWeek,
    LastWeek,
    EndOfWeek,
    EndOfMonth,
    NextMonth,
    ThisMonth,
    Date(NaiveDate),
}

enum LexKind {
    Word(String),
    Num(u32),
}

struct Lex {
    start: usize,
    end: usize,
    kind: LexKind,
}

impl Lex {
    fn as_num(&self) -> Option<u32> {
        match &self.kind {
            LexKind::Num(n) => Some(*n),
            LexKind::Word(_) => None,
        }
    }
    fn as_word(&self) -> Option<&str> {
        match &self.kind {
            LexKind::Word(w) => Some(w.as_str()),
            LexKind::Num(_) => None,
        }
    }
    fn width(&self) -> usize {
        self.end - self.start
    }
}

/// Splits `chars` into digit runs and letter runs (an apostrophe stays part of a word when a
/// letter follows it, for Ukrainian's "п'ятницю"); everything else (spaces, punctuation, quote
/// marks) is a separator the caller checks directly against `chars` when a pattern needs it
/// ("28.11" has no gap between the day, the dot and the month).
fn lex(chars: &[char]) -> Vec<Lex> {
    let mut out = Vec::new();
    let mut i = 0;
    let n = chars.len();
    while i < n {
        let c = chars[i];
        if c.is_ascii_digit() {
            let start = i;
            while i < n && chars[i].is_ascii_digit() {
                i += 1;
            }
            let text: String = chars[start..i].iter().collect();
            out.push(Lex {
                start,
                end: i,
                // A run too long for a u32 reads as the largest one, so a span cap refuses it
                // rather than it passing as 0.
                kind: LexKind::Num(text.parse().unwrap_or(u32::MAX)),
            });
        } else if c.is_alphabetic() {
            let start = i;
            i += 1;
            while i < n {
                let ch = chars[i];
                let apostrophe_in_word =
                    (ch == '\'' || ch == '\u{2019}') && i + 1 < n && chars[i + 1].is_alphabetic();
                if ch.is_alphabetic() || apostrophe_in_word {
                    i += 1;
                } else {
                    break;
                }
            }
            let text: String = chars[start..i].iter().collect::<String>().to_lowercase();
            out.push(Lex {
                start,
                end: i,
                kind: LexKind::Word(text),
            });
        } else {
            i += 1;
        }
    }
    out
}

/// `true` for a char position inside a double-quoted span (straight `"` or the typographic
/// pair “ ”), so a quoted word is never read as a date ("rename \"tomorrow\" column").
fn quoted_mask(chars: &[char]) -> Vec<bool> {
    let mut mask = vec![false; chars.len()];
    let mut in_quotes = false;
    for (i, &c) in chars.iter().enumerate() {
        if matches!(c, '"' | '\u{201C}' | '\u{201D}') {
            in_quotes = !in_quotes;
        }
        mask[i] = in_quotes;
    }
    mask
}

struct Candidate {
    start: usize,
    end: usize,
    token: Token,
}

/// The last non-quoted, whole-word date phrase in `chars`, with one leading word folded in.
/// `window_ctx` also allows the window-only vocabulary ("yesterday", "this/last week", "this
/// month") that makes no sense as a single due day. A match whose preceding word is "every" is
/// a recurrence rule, not a date, and is skipped.
fn last_candidate(chars: &[char], today: NaiveDate, window_ctx: bool) -> Option<Candidate> {
    let lexemes = lex(chars);
    let quoted = quoted_mask(chars);
    let mut best: Option<Candidate> = None;
    let mut i = 0;
    while i < lexemes.len() {
        if quoted[lexemes[i].start] {
            i += 1;
            continue;
        }
        let Some((last_idx, token)) = match_at(chars, &lexemes, i, today) else {
            i += 1;
            continue;
        };
        let window_only = matches!(
            token,
            Token::Yesterday | Token::ThisWeek | Token::LastWeek | Token::ThisMonth
        );
        let every_before =
            i > 0 && !quoted[lexemes[i - 1].start] && lexemes[i - 1].as_word() == Some("every");
        if (window_ctx || !window_only) && !every_before {
            let mut start = lexemes[i].start;
            let end = lexemes[last_idx].end;
            if i > 0 && !quoted[lexemes[i - 1].start] {
                if let Some(lead) = lexemes[i - 1].as_word() {
                    if LEAD_WORDS.contains(&lead) {
                        start = lexemes[i - 1].start;
                    }
                }
            }
            best = Some(Candidate { start, end, token });
        }
        i = last_idx + 1;
    }
    best
}

/// Tries every pattern at lexeme `idx`, longest and most specific first, and returns the index
/// of the last lexeme it consumed with the token it read.
fn match_at(
    chars: &[char],
    lexemes: &[Lex],
    idx: usize,
    today: NaiveDate,
) -> Option<(usize, Token)> {
    try_iso(chars, lexemes, idx, today)
        .or_else(|| try_numeric(chars, lexemes, idx, today))
        .or_else(|| try_day_then_month_name(lexemes, idx, today))
        .or_else(|| try_month_name_then_day(lexemes, idx, today))
        .or_else(|| try_next_prefixed(lexemes, idx))
        .or_else(|| try_this_or_last(lexemes, idx))
        .or_else(|| try_end_of(lexemes, idx))
        .or_else(|| try_the_day_after_tomorrow(lexemes, idx))
        .or_else(|| try_weekday_word(lexemes, idx))
        .or_else(|| try_day_word(lexemes, idx))
        .or_else(|| try_span(lexemes, idx))
}

/// `2026-11-28`.
fn try_iso(
    chars: &[char],
    lexemes: &[Lex],
    idx: usize,
    today: NaiveDate,
) -> Option<(usize, Token)> {
    let y = lexemes.get(idx)?;
    let year = y.as_num()?;
    if y.width() != 4 || chars.get(y.end) != Some(&'-') {
        return None;
    }
    let m = lexemes.get(idx + 1)?;
    let month = m.as_num()?;
    if m.start != y.end + 1 || m.width() != 2 || chars.get(m.end) != Some(&'-') {
        return None;
    }
    let d = lexemes.get(idx + 2)?;
    let day = d.as_num()?;
    if d.start != m.end + 1 || d.width() != 2 {
        return None;
    }
    let date = resolve_calendar(day, month, Some(year as i32), today)?;
    Some((idx + 2, Token::Date(date)))
}

/// `28.11`, `28/11`, `28.11.2026` — day first, never month first; an optional year uses the
/// same separator both times.
fn try_numeric(
    chars: &[char],
    lexemes: &[Lex],
    idx: usize,
    today: NaiveDate,
) -> Option<(usize, Token)> {
    let d = lexemes.get(idx)?;
    let day = d.as_num()?;
    if d.width() == 0 || d.width() > 2 {
        return None;
    }
    let sep = *chars.get(d.end)?;
    if sep != '.' && sep != '/' {
        return None;
    }
    let m = lexemes.get(idx + 1)?;
    let month = m.as_num()?;
    if m.start != d.end + 1 || m.width() == 0 || m.width() > 2 {
        return None;
    }
    if chars.get(m.end) == Some(&sep) {
        if let Some(y) = lexemes.get(idx + 2) {
            if let Some(year) = y.as_num() {
                if y.start == m.end + 1 && y.width() == 4 {
                    let date = resolve_calendar(day, month, Some(year as i32), today)?;
                    return Some((idx + 2, Token::Date(date)));
                }
            }
        }
    }
    let date = resolve_calendar(day, month, None, today)?;
    Some((idx + 1, Token::Date(date)))
}

/// `28 Nov`, `28th Nov`, `28 ноября`, `28 листопада` — a day number, an optional ordinal
/// suffix glued to it, then a month name; no year, so a past day and month means next year.
fn try_day_then_month_name(
    lexemes: &[Lex],
    idx: usize,
    today: NaiveDate,
) -> Option<(usize, Token)> {
    let d = lexemes.get(idx)?;
    let day = d.as_num()?;
    if d.width() == 0 || d.width() > 2 {
        return None;
    }
    let mut month_idx = idx + 1;
    if let Some(l) = lexemes.get(month_idx) {
        if let Some(w) = l.as_word() {
            if l.start == d.end && matches!(w, "st" | "nd" | "rd" | "th") {
                month_idx += 1;
            }
        }
    }
    let month = month_of(lexemes.get(month_idx)?.as_word()?)?;
    let date = resolve_calendar(day, month, None, today)?;
    Some((month_idx, Token::Date(date)))
}

/// `Nov 28`, `November 28th` — a month name then a day number, with an optional ordinal
/// suffix; no year, so a past day and month means next year.
fn try_month_name_then_day(
    lexemes: &[Lex],
    idx: usize,
    today: NaiveDate,
) -> Option<(usize, Token)> {
    let month = month_of(lexemes.get(idx)?.as_word()?)?;
    let d = lexemes.get(idx + 1)?;
    let day = d.as_num()?;
    if d.width() == 0 || d.width() > 2 {
        return None;
    }
    let mut last = idx + 1;
    if let Some(l) = lexemes.get(idx + 2) {
        if let Some(w) = l.as_word() {
            if l.start == d.end && matches!(w, "st" | "nd" | "rd" | "th") {
                last = idx + 2;
            }
        }
    }
    let date = resolve_calendar(day, month, None, today)?;
    Some((last, Token::Date(date)))
}

/// Every case of Russian "следующий" ("next") that agrees with a weekday noun: masculine
/// (понедельник, вторник, четверг) nominative/accusative "следующий", neuter (воскресенье)
/// "следующее", feminine (среда, пятница, суббота) accusative "следующую" ("следующую
/// пятницу"), and the genitive/dative/prepositional forms "следующего", "следующей",
/// "следующем" ("следующей" also leads "неделе" below, as in "на следующей неделе").
const NEXT_LEADS_RU: &[&str] = &[
    "следующий",
    "следующая",
    "следующее",
    "следующую",
    "следующего",
    "следующей",
    "следующем",
];

/// The Ukrainian equivalent of [`NEXT_LEADS_RU`]: masculine/neuter/feminine nominative and
/// accusative forms of "наступний" ("наступну середу").
const NEXT_LEADS_UK: &[&str] = &[
    "наступний",
    "наступна",
    "наступне",
    "наступну",
    "наступного",
    "наступної",
    "наступному",
];

/// "next week", "next month", "next <weekday>" (that weekday in the Monday-based week after
/// the current one); every agreeing form of Russian "следующий" and Ukrainian "наступний"
/// leads a weekday the same way ("следующую пятницу", "наступну середу" — a bare "next"
/// would wrongly leave вторник/четверг masculine while среда/пятница/суббота need the
/// feminine accusative, so every form the noun can take is accepted here rather than one).
/// "на следующей неделе" also reads as `next week`. A lead word before any of this ("by",
/// "в"/"во"/"у"/"на", …) is folded into the phrase by [`last_candidate`] as usual.
fn try_next_prefixed(lexemes: &[Lex], idx: usize) -> Option<(usize, Token)> {
    let lead = lexemes.get(idx)?.as_word()?;
    let ru = NEXT_LEADS_RU.contains(&lead);
    let uk = NEXT_LEADS_UK.contains(&lead);
    if lead != "next" && !ru && !uk {
        return None;
    }
    let next = lexemes.get(idx + 1)?.as_word()?;
    match next {
        "week" if lead == "next" => return Some((idx + 1, Token::NextWeek)),
        "month" if lead == "next" => return Some((idx + 1, Token::NextMonth)),
        "неделе" if ru => return Some((idx + 1, Token::NextWeek)),
        _ => {}
    }
    weekday_of(next).map(|w| (idx + 1, Token::NextWeekday(w)))
}

/// "this week", "last week", "this month" (window-only; a due day can't be "this week").
fn try_this_or_last(lexemes: &[Lex], idx: usize) -> Option<(usize, Token)> {
    let w = lexemes.get(idx)?.as_word()?;
    let next = lexemes.get(idx + 1)?.as_word()?;
    match (w, next) {
        ("this", "week") => Some((idx + 1, Token::ThisWeek)),
        ("last", "week") => Some((idx + 1, Token::LastWeek)),
        ("this", "month") => Some((idx + 1, Token::ThisMonth)),
        _ => None,
    }
}

/// "eow", "end of week", "eom", "end of month".
fn try_end_of(lexemes: &[Lex], idx: usize) -> Option<(usize, Token)> {
    let w = lexemes.get(idx)?.as_word()?;
    match w {
        "eow" => return Some((idx, Token::EndOfWeek)),
        "eom" => return Some((idx, Token::EndOfMonth)),
        "end" => {}
        _ => return None,
    }
    if lexemes.get(idx + 1)?.as_word()? != "of" {
        return None;
    }
    match lexemes.get(idx + 2)?.as_word()? {
        "week" => Some((idx + 2, Token::EndOfWeek)),
        "month" => Some((idx + 2, Token::EndOfMonth)),
        _ => None,
    }
}

/// "the day after tomorrow" (Russian and Ukrainian say this as the single word
/// "послезавтра"/"післязавтра", already in [`DAY_WORDS`]).
fn try_the_day_after_tomorrow(lexemes: &[Lex], idx: usize) -> Option<(usize, Token)> {
    let words = [
        lexemes.get(idx)?.as_word()?,
        lexemes.get(idx + 1)?.as_word()?,
        lexemes.get(idx + 2)?.as_word()?,
        lexemes.get(idx + 3)?.as_word()?,
    ];
    (words == ["the", "day", "after", "tomorrow"]).then_some((idx + 3, Token::DayAfterTomorrow))
}

/// A bare weekday name: the next such day after today.
fn try_weekday_word(lexemes: &[Lex], idx: usize) -> Option<(usize, Token)> {
    let w = weekday_of(lexemes.get(idx)?.as_word()?)?;
    Some((idx, Token::Weekday(w)))
}

/// "today", "tonight", "tomorrow", "tmrw", "yesterday" and their Russian and Ukrainian forms.
fn try_day_word(lexemes: &[Lex], idx: usize) -> Option<(usize, Token)> {
    let offset = day_offset_of(lexemes.get(idx)?.as_word()?)?;
    let token = match offset {
        -1 => Token::Yesterday,
        0 => Token::Today,
        1 => Token::Tomorrow,
        2 => Token::DayAfterTomorrow,
        _ => return None,
    };
    Some((idx, token))
}

/// The longest span "in N <unit>" reads (ten years); a longer one is no date, so its words
/// stay in the title and its due never leaves chrono's range or gains a five-digit year.
const MAX_SPAN_DAYS: i64 = 3_650;
const MAX_SPAN_WEEKS: i64 = 520;
const MAX_SPAN_MONTHS: i64 = 120;

/// "in 3 days", "in 2 weeks"; "через 3 дня", "через 2 тижні".
fn try_span(lexemes: &[Lex], idx: usize) -> Option<(usize, Token)> {
    let lead = lexemes.get(idx)?.as_word()?;
    if lead != "in" && lead != "через" {
        return None;
    }
    let n = lexemes.get(idx + 1)?.as_num()? as i64;
    let unit = span_unit_of(lexemes.get(idx + 2)?.as_word()?)?;
    let cap = match unit {
        Unit::Days => MAX_SPAN_DAYS,
        Unit::Weeks => MAX_SPAN_WEEKS,
        Unit::Months => MAX_SPAN_MONTHS,
    };
    if n > cap {
        return None;
    }
    let token = match unit {
        Unit::Days => Token::SpanDays(n),
        Unit::Weeks => Token::SpanWeeks(n),
        Unit::Months => Token::SpanMonths(n),
    };
    Some((idx + 2, token))
}

/// `day`/`month` in `year`, or (when `year` is `None`) in `today`'s year unless that date has
/// already passed, in which case next year; `None` for a day and month that never exist (Feb
/// 31, a month over 12).
fn resolve_calendar(
    day: u32,
    month: u32,
    year: Option<i32>,
    today: NaiveDate,
) -> Option<NaiveDate> {
    if let Some(y) = year {
        return NaiveDate::from_ymd_opt(y, month, day);
    }
    let this_year = NaiveDate::from_ymd_opt(today.year(), month, day)?;
    if this_year < today {
        NaiveDate::from_ymd_opt(today.year() + 1, month, day)
    } else {
        Some(this_year)
    }
}

fn today_in(now: i64, tz: Tz) -> NaiveDate {
    match tz.timestamp_opt(now, 0) {
        LocalResult::Single(t) | LocalResult::Ambiguous(t, _) => t.date_naive(),
        LocalResult::None => Utc
            .timestamp_opt(now, 0)
            .single()
            .map(|d| d.date_naive())
            .unwrap_or_else(|| NaiveDate::from_ymd_opt(1970, 1, 1).unwrap()),
    }
}

fn monday_of(d: NaiveDate) -> NaiveDate {
    d - Duration::days(d.weekday().num_days_from_monday() as i64)
}

/// The next `target` weekday strictly after `today` (today's own weekday means a full week
/// ahead, never today itself).
fn bare_weekday(today: NaiveDate, target: u32) -> NaiveDate {
    let cur = today.weekday().num_days_from_monday();
    let diff = (target + 7 - cur) % 7;
    let offset = if diff == 0 { 7 } else { diff };
    today + Duration::days(offset as i64)
}

/// "next <weekday>" (spec § 9: "the one in next week, Monday-based"): `target` in the
/// Monday-based week *after* the one containing `today` — not the bare next occurrence of
/// `target` (that's [`bare_weekday`]). From a Thursday, "next Monday" is next week's Monday
/// (4 days away, the same day `next_week` gives); from a Monday, "next Monday" is 7 days away;
/// from a Sunday, "next Monday" is the next day, since the next Monday-based week starts then.
fn next_weekday(today: NaiveDate, target: u32) -> NaiveDate {
    monday_of(today) + Duration::days(7 + target as i64)
}

/// This week's Friday, or next week's when today is already past it (Saturday or Sunday).
fn end_of_week(today: NaiveDate) -> NaiveDate {
    let friday = monday_of(today) + Duration::days(4);
    if friday < today {
        friday + Duration::days(7)
    } else {
        friday
    }
}

fn first_of_month(d: NaiveDate) -> NaiveDate {
    NaiveDate::from_ymd_opt(d.year(), d.month(), 1).unwrap_or(d)
}

fn first_of_next_month(d: NaiveDate) -> NaiveDate {
    first_of_month(d)
        .checked_add_months(Months::new(1))
        .unwrap_or(d)
}

fn end_of_month(d: NaiveDate) -> NaiveDate {
    first_of_next_month(d) - Duration::days(1)
}

/// What `token` means as a single due day (`capture_parse`); every token `parse`'s scan can
/// produce resolves here (the window-only tokens fall back to a sane value, unreachable since
/// `last_candidate(..., window_ctx: false)` never returns them); `None` when a span would leave
/// chrono's range, which reads as no date.
fn resolve_due(token: Token, today: NaiveDate) -> Option<NaiveDate> {
    let days = |n: i64| today.checked_add_signed(Duration::try_days(n)?);
    Some(match token {
        Token::Today => today,
        Token::Yesterday => today - Duration::days(1),
        Token::Tomorrow => today + Duration::days(1),
        Token::DayAfterTomorrow => today + Duration::days(2),
        Token::Weekday(w) => bare_weekday(today, w),
        Token::NextWeekday(w) => next_weekday(today, w),
        Token::SpanDays(n) => days(n)?,
        Token::SpanWeeks(n) => days(n.checked_mul(7)?)?,
        Token::SpanMonths(n) => today.checked_add_months(Months::new(u32::try_from(n).ok()?))?,
        Token::NextWeek => monday_of(today) + Duration::days(7),
        Token::ThisWeek => monday_of(today),
        Token::LastWeek => monday_of(today) - Duration::days(7),
        Token::EndOfWeek => end_of_week(today),
        Token::EndOfMonth => end_of_month(today),
        Token::NextMonth => first_of_next_month(today),
        Token::ThisMonth => first_of_month(today),
        Token::Date(d) => d,
    })
}

/// What `token` means as a window span (`window`): a single day for a day-like token, Monday
/// to Sunday for a week, the first to the last day for a month.
fn resolve_window(token: Token, today: NaiveDate) -> Option<(NaiveDate, NaiveDate)> {
    Some(match token {
        Token::NextWeek => {
            let m = monday_of(today) + Duration::days(7);
            (m, m + Duration::days(6))
        }
        Token::ThisWeek => {
            let m = monday_of(today);
            (m, m + Duration::days(6))
        }
        Token::LastWeek => {
            let m = monday_of(today) - Duration::days(7);
            (m, m + Duration::days(6))
        }
        Token::ThisMonth => (first_of_month(today), end_of_month(today)),
        Token::NextMonth => {
            let f = first_of_next_month(today);
            (f, end_of_month(f))
        }
        other => {
            let d = resolve_due(other, today)?;
            (d, d)
        }
    })
}

/// Collapses every run of whitespace (newlines included) to a single space and trims the
/// ends — shared by `tidy_title` and by `note_append`'s label and text (ask-capture design
/// § 10 review, round 1): a note is one line, so a subject or a typed line holding `\n` can
/// never fake another bullet.
pub(crate) fn collapse_whitespace(s: &str) -> String {
    let mut collapsed = String::with_capacity(s.len());
    let mut last_space = false;
    for c in s.chars() {
        if c.is_whitespace() {
            if !last_space {
                collapsed.push(' ');
            }
            last_space = true;
        } else {
            collapsed.push(c);
            last_space = false;
        }
    }
    collapsed.trim().to_string()
}

/// The title with `removed` (the matched phrase, if any) excised, whitespace collapsed to
/// single spaces, trimmed, and one trailing `,`, `-`, `–` or `—` tidied away.
fn tidy_title(chars: &[char], removed: Option<(usize, usize)>) -> String {
    let kept: String = match removed {
        Some((s, e)) => chars[..s].iter().chain(chars[e..].iter()).collect(),
        None => chars.iter().collect(),
    };
    let mut title = collapse_whitespace(&kept);
    if matches!(
        title.chars().last(),
        Some(',' | '-' | '\u{2013}' | '\u{2014}')
    ) {
        title.pop();
        title = title.trim_end().to_string();
    }
    title
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono_tz::Europe::Vilnius;
    use serde_json::{json, Value};
    use std::path::Path;

    /// Thu 2026-11-26 10:00, Europe/Vilnius — the fixed `now` most fixture cases use.
    fn default_now() -> i64 {
        Vilnius
            .with_ymd_and_hms(2026, 11, 26, 10, 0, 0)
            .unwrap()
            .timestamp()
    }
    const ZONE: &str = "Europe/Vilnius";

    fn fixture_path() -> std::path::PathBuf {
        Path::new(env!("CARGO_MANIFEST_DIR")).join("../ui/test/fixtures/contract/when-cases.json")
    }

    fn push_parse_case(
        cases: &mut Vec<Value>,
        name: &str,
        text: &str,
        now: i64,
        expected: &Parsed,
    ) {
        let got = parse(text, now, ZONE);
        assert_eq!(&got, expected, "case {name:?}");
        cases.push(json!({
            "name": name,
            "kind": "parse",
            "input": text,
            "now": now,
            "zone": ZONE,
            "expected": serde_json::to_value(expected).unwrap(),
        }));
    }

    fn push_window_case(
        cases: &mut Vec<Value>,
        name: &str,
        question: &str,
        now: i64,
        expected: &Window,
    ) {
        let got = window(question, now, ZONE);
        assert_eq!(&got, expected, "case {name:?}");
        cases.push(json!({
            "name": name,
            "kind": "window",
            "input": question,
            "now": now,
            "zone": ZONE,
            "expected": serde_json::to_value(expected).unwrap(),
        }));
    }

    fn due(title: &str, due: &str, phrase: &str, start: usize, end: usize) -> Parsed {
        Parsed {
            title: title.into(),
            due: Some(due.into()),
            phrase: Some(phrase.into()),
            start: Some(start),
            end: Some(end),
        }
    }

    fn no_due(title: &str) -> Parsed {
        Parsed {
            title: title.into(),
            due: None,
            phrase: None,
            start: None,
            end: None,
        }
    }

    fn span(from: &str, to: &str, phrase: Option<&str>) -> Window {
        Window {
            from: from.into(),
            to: to.into(),
            phrase: phrase.map(Into::into),
        }
    }

    fn build_cases() -> Vec<Value> {
        let mut cases = Vec::new();
        let now = default_now();
        let friday_now = Vilnius
            .with_ymd_and_hms(2026, 11, 27, 10, 0, 0)
            .unwrap()
            .timestamp();
        let saturday_now = Vilnius
            .with_ymd_and_hms(2026, 11, 28, 10, 0, 0)
            .unwrap()
            .timestamp();
        let monday_now = Vilnius
            .with_ymd_and_hms(2026, 11, 23, 10, 0, 0)
            .unwrap()
            .timestamp();
        let sunday_now = Vilnius
            .with_ymd_and_hms(2026, 11, 29, 10, 0, 0)
            .unwrap()
            .timestamp();

        push_parse_case(
            &mut cases,
            "tomorrow",
            "tomorrow",
            now,
            &due("", "2026-11-27", "tomorrow", 0, 8),
        );
        push_parse_case(
            &mut cases,
            "tmrw",
            "tmrw",
            now,
            &due("", "2026-11-27", "tmrw", 0, 4),
        );
        push_parse_case(
            &mut cases,
            "tonight",
            "tonight",
            now,
            &due("", "2026-11-26", "tonight", 0, 7),
        );
        push_parse_case(
            &mut cases,
            "the day after tomorrow",
            "the day after tomorrow",
            now,
            &due("", "2026-11-28", "the day after tomorrow", 0, 22),
        );
        push_parse_case(
            &mut cases,
            "by fri",
            "send the deck by fri",
            now,
            &due("send the deck", "2026-11-27", "by fri", 14, 20),
        );
        push_parse_case(
            &mut cases,
            "next mon from a Thursday",
            "call Priya next mon",
            now,
            &due("call Priya", "2026-11-30", "next mon", 11, 19),
        );
        push_parse_case(
            &mut cases,
            "next fri from a Thursday",
            "next fri",
            now,
            &due("", "2026-12-04", "next fri", 0, 8),
        );
        push_parse_case(
            &mut cases,
            "next thu from a Thursday",
            "next thu",
            now,
            &due("", "2026-12-03", "next thu", 0, 8),
        );
        push_parse_case(
            &mut cases,
            "next mon from a Monday is 7 days later",
            "next mon",
            monday_now,
            &due("", "2026-11-30", "next mon", 0, 8),
        );
        push_parse_case(
            &mut cases,
            "next mon from a Sunday is the next day",
            "next mon",
            sunday_now,
            &due("", "2026-11-30", "next mon", 0, 8),
        );
        push_parse_case(
            &mut cases,
            "следующий понедельник (Russian next Monday)",
            "следующий понедельник",
            now,
            &due("", "2026-11-30", "следующий понедельник", 0, 21),
        );
        push_parse_case(
            &mut cases,
            "наступний понеділок (Ukrainian next Monday)",
            "наступний понеділок",
            now,
            &due("", "2026-11-30", "наступний понеділок", 0, 19),
        );
        push_parse_case(
            &mut cases,
            "следующую пятницу (Russian feminine accusative, not the masculine next)",
            "следующую пятницу",
            now,
            &due("", "2026-12-04", "следующую пятницу", 0, 17),
        );
        push_parse_case(
            &mut cases,
            "наступну середу (Ukrainian feminine accusative, not the masculine next)",
            "наступну середу",
            now,
            &due("", "2026-12-02", "наступну середу", 0, 15),
        );
        push_parse_case(
            &mut cases,
            "в следующую пятницу (the optional в/во/у/на lead folds in too)",
            "в следующую пятницу",
            now,
            &due("", "2026-12-04", "в следующую пятницу", 0, 19),
        );
        push_parse_case(
            &mut cases,
            "на следующей неделе reads as next week",
            "на следующей неделе",
            now,
            &due("", "2026-11-30", "на следующей неделе", 0, 19),
        );
        push_parse_case(
            &mut cases,
            "on Friday said on a Friday-now case",
            "on Friday",
            friday_now,
            &due("", "2026-12-04", "on Friday", 0, 9),
        );
        push_parse_case(
            &mut cases,
            "in 3 days",
            "in 3 days",
            now,
            &due("", "2026-11-29", "in 3 days", 0, 9),
        );
        push_parse_case(
            &mut cases,
            "in 2 weeks",
            "in 2 weeks",
            now,
            &due("", "2026-12-10", "in 2 weeks", 0, 10),
        );
        push_parse_case(
            &mut cases,
            "next week",
            "next week",
            now,
            &due("", "2026-11-30", "next week", 0, 9),
        );
        push_parse_case(
            &mut cases,
            "eow",
            "eow",
            now,
            &due("", "2026-11-27", "eow", 0, 3),
        );
        push_parse_case(
            &mut cases,
            "end of week on a Saturday-now case",
            "end of week",
            saturday_now,
            &due("", "2026-12-04", "end of week", 0, 11),
        );
        push_parse_case(
            &mut cases,
            "eom",
            "eom",
            now,
            &due("", "2026-11-30", "eom", 0, 3),
        );
        push_parse_case(
            &mut cases,
            "next month",
            "next month",
            now,
            &due("", "2026-12-01", "next month", 0, 10),
        );
        push_parse_case(
            &mut cases,
            "2026-11-28",
            "2026-11-28",
            now,
            &due("", "2026-11-28", "2026-11-28", 0, 10),
        );
        push_parse_case(
            &mut cases,
            "28.11",
            "28.11",
            now,
            &due("", "2026-11-28", "28.11", 0, 5),
        );
        push_parse_case(
            &mut cases,
            "28/11",
            "28/11",
            now,
            &due("", "2026-11-28", "28/11", 0, 5),
        );
        push_parse_case(
            &mut cases,
            "28.11.2026",
            "28.11.2026",
            now,
            &due("", "2026-11-28", "28.11.2026", 0, 10),
        );
        push_parse_case(
            &mut cases,
            "28 Nov",
            "28 Nov",
            now,
            &due("", "2026-11-28", "28 Nov", 0, 6),
        );
        push_parse_case(
            &mut cases,
            "Nov 28",
            "Nov 28",
            now,
            &due("", "2026-11-28", "Nov 28", 0, 6),
        );
        push_parse_case(
            &mut cases,
            "November 28th",
            "November 28th",
            now,
            &due("", "2026-11-28", "November 28th", 0, 13),
        );
        push_parse_case(
            &mut cases,
            "завтра",
            "завтра",
            now,
            &due("", "2026-11-27", "завтра", 0, 6),
        );
        push_parse_case(
            &mut cases,
            "послезавтра",
            "послезавтра",
            now,
            &due("", "2026-11-28", "послезавтра", 0, 11),
        );
        push_parse_case(
            &mut cases,
            "до пятницы",
            "до пятницы",
            now,
            &due("", "2026-11-27", "до пятницы", 0, 10),
        );
        push_parse_case(
            &mut cases,
            "через 3 дня",
            "через 3 дня",
            now,
            &due("", "2026-11-29", "через 3 дня", 0, 11),
        );
        push_parse_case(
            &mut cases,
            "28 ноября",
            "28 ноября",
            now,
            &due("", "2026-11-28", "28 ноября", 0, 9),
        );
        push_parse_case(
            &mut cases,
            "сьогодні",
            "сьогодні",
            now,
            &due("", "2026-11-26", "сьогодні", 0, 8),
        );
        push_parse_case(
            &mut cases,
            "післязавтра",
            "післязавтра",
            now,
            &due("", "2026-11-28", "післязавтра", 0, 11),
        );
        push_parse_case(
            &mut cases,
            "у п'ятницю",
            "у п'ятницю",
            now,
            &due("", "2026-11-27", "у п'ятницю", 0, 10),
        );
        push_parse_case(
            &mut cases,
            "через 2 тижні",
            "через 2 тижні",
            now,
            &due("", "2026-12-10", "через 2 тижні", 0, 13),
        );
        push_parse_case(
            &mut cases,
            "28 листопада",
            "28 листопада",
            now,
            &due("", "2026-11-28", "28 листопада", 0, 12),
        );
        push_parse_case(
            &mut cases,
            "31.02 is never read",
            "31.02",
            now,
            &no_due("31.02"),
        );
        push_parse_case(
            &mut cases,
            "a quoted tomorrow is never read",
            "\"tomorrow\"",
            now,
            &no_due("\"tomorrow\""),
        );
        push_parse_case(
            &mut cases,
            "every monday is a recurrence, not a date",
            "every monday",
            now,
            &no_due("every monday"),
        );
        push_parse_case(
            &mut cases,
            "10:00 tomorrow",
            "10:00 tomorrow",
            now,
            &due("10:00", "2026-11-27", "tomorrow", 6, 14),
        );
        push_parse_case(
            &mut cases,
            "a trailing comma is tidied",
            "Call Priya, tomorrow",
            now,
            &due("Call Priya", "2026-11-27", "tomorrow", 12, 20),
        );
        push_parse_case(
            &mut cases,
            "a trailing dash is tidied",
            "Call Priya - tomorrow",
            now,
            &due("Call Priya", "2026-11-27", "tomorrow", 13, 21),
        );

        // Spans are capped at 3,650 days, 520 weeks and 120 months; a longer span (or a
        // number too long to hold) is no date, and its words stay in the title.
        push_parse_case(
            &mut cases,
            "in 3650 days is the longest day span",
            "in 3650 days",
            now,
            &due("", "2036-11-23", "in 3650 days", 0, 12),
        );
        push_parse_case(
            &mut cases,
            "in 520 weeks is the longest week span",
            "in 520 weeks",
            now,
            &due("", "2036-11-13", "in 520 weeks", 0, 12),
        );
        push_parse_case(
            &mut cases,
            "in 120 months is the longest month span",
            "in 120 months",
            now,
            &due("", "2036-11-26", "in 120 months", 0, 13),
        );
        for (name, text) in [
            ("in 3651 days is no date", "call bank in 3651 days"),
            ("in 521 weeks is no date", "call bank in 521 weeks"),
            ("in 121 months is no date", "call bank in 121 months"),
            (
                "in 100000000 days is no date",
                "call bank in 100000000 days",
            ),
            (
                "in 14000000 weeks is no date",
                "call bank in 14000000 weeks",
            ),
            ("in 999999 months is no date", "call bank in 999999 months"),
            (
                "a number too long to hold is no date",
                "call bank in 99999999999 days",
            ),
            ("через 100000000 дней is no date", "через 100000000 дней"),
            ("через 14000000 недель is no date", "через 14000000 недель"),
            ("через 100000000 днів is no date", "через 100000000 днів"),
            ("через 14000000 тижнів is no date", "через 14000000 тижнів"),
        ] {
            push_parse_case(&mut cases, name, text, now, &no_due(text));
        }

        push_window_case(
            &mut cases,
            "today",
            "today",
            now,
            &span("2026-11-26", "2026-11-26", Some("today")),
        );
        push_window_case(
            &mut cases,
            "yesterday",
            "yesterday",
            now,
            &span("2026-11-25", "2026-11-25", Some("yesterday")),
        );
        push_window_case(
            &mut cases,
            "this week",
            "this week",
            now,
            &span("2026-11-23", "2026-11-29", Some("this week")),
        );
        push_window_case(
            &mut cases,
            "next week",
            "next week",
            now,
            &span("2026-11-30", "2026-12-06", Some("next week")),
        );
        push_window_case(
            &mut cases,
            "last week",
            "last week",
            now,
            &span("2026-11-16", "2026-11-22", Some("last week")),
        );
        push_window_case(
            &mut cases,
            "next fri uses the same next-weekday rule as parse",
            "next fri",
            now,
            &span("2026-12-04", "2026-12-04", Some("next fri")),
        );
        push_window_case(
            &mut cases,
            "this month",
            "this month",
            now,
            &span("2026-11-01", "2026-11-30", Some("this month")),
        );
        push_window_case(
            &mut cases,
            "next month",
            "next month",
            now,
            &span("2026-12-01", "2026-12-31", Some("next month")),
        );
        push_window_case(
            &mut cases,
            "on Friday",
            "on Friday",
            now,
            &span("2026-11-27", "2026-11-27", Some("on Friday")),
        );
        push_window_case(
            &mut cases,
            "28 Nov",
            "28 Nov",
            now,
            &span("2026-11-28", "2026-11-28", Some("28 Nov")),
        );
        push_window_case(
            &mut cases,
            "no date means the default span",
            "what's urgent?",
            now,
            &span("2026-11-19", "2026-12-03", None),
        );
        for (name, question) in [
            (
                "a day span past the cap means the default span",
                "what's due in 100000000 days?",
            ),
            (
                "a week span past the cap means the default span",
                "what's due in 14000000 weeks?",
            ),
            (
                "a month span past the cap means the default span",
                "what's due in 999999 months?",
            ),
            (
                "a Russian day span past the cap means the default span",
                "что через 100000000 дней?",
            ),
        ] {
            push_window_case(
                &mut cases,
                name,
                question,
                now,
                &span("2026-11-19", "2026-12-03", None),
            );
        }

        cases
    }

    #[test]
    fn contract_fixtures_match_the_when_cases() {
        crate::plugins::testkit::contract_fixture("when-cases.json", &Value::Array(build_cases()));
    }

    #[test]
    fn when_cases_from_the_fixture() {
        let saved = std::fs::read_to_string(fixture_path()).expect(
            "when-cases.json is missing: run UPDATE_CONTRACT_FIXTURES=1 cargo test contract_fixtures",
        );
        let cases: Vec<Value> = serde_json::from_str(&saved).unwrap();
        assert!(!cases.is_empty());
        for case in cases {
            let name = case["name"].as_str().unwrap_or("<unnamed>");
            let now = case["now"].as_i64().unwrap();
            let zone = case["zone"].as_str().unwrap();
            let input = case["input"].as_str().unwrap();
            let got = match case["kind"].as_str().unwrap() {
                "parse" => serde_json::to_value(parse(input, now, zone)).unwrap(),
                "window" => serde_json::to_value(window(input, now, zone)).unwrap(),
                other => panic!("case {name:?} has an unknown kind {other:?}"),
            };
            assert_eq!(got, case["expected"], "case {name:?}");
        }
    }

    #[test]
    fn huge_spans_read_as_no_date_and_never_panic() {
        for text in [
            "in 100000000 days",
            "in 14000000 weeks",
            "in 999999 months",
            "in 4294967295 weeks",
            "через 100000000 дней",
        ] {
            let got = parse(text, default_now(), ZONE);
            assert_eq!(got.due, None, "{text:?}");
            assert_eq!(got.title, text, "{text:?}");
            assert_eq!(window(text, default_now(), ZONE).phrase, None, "{text:?}");
        }
    }

    #[test]
    fn the_last_phrase_wins_and_takes_its_lead_word() {
        let got = parse("call Priya tomorrow, send deck by fri", default_now(), ZONE);
        assert_eq!(got.phrase, Some("by fri".to_string()));
        assert_eq!(got.title, "call Priya tomorrow, send deck");
        assert_eq!(got.due, Some("2026-11-27".to_string()));
    }

    #[test]
    fn quoted_and_embedded_words_are_not_read() {
        assert_eq!(
            parse("rename \"tomorrow\" column", default_now(), ZONE).due,
            None
        );
        assert_eq!(parse("Mondays standup", default_now(), ZONE).due, None);
    }

    #[test]
    fn times_and_recurrence_stay_in_the_title() {
        let tomorrow_sync = parse("10:00 tomorrow sync", default_now(), ZONE);
        assert_eq!(tomorrow_sync.title, "10:00 sync");
        assert_eq!(tomorrow_sync.due, Some("2026-11-27".to_string()));

        let recurring = parse("every monday review", default_now(), ZONE);
        assert_eq!(recurring.due, None);
        assert_eq!(recurring.title, "every monday review");
    }

    #[test]
    fn numeric_dates_are_day_first_and_impossible_ones_unread() {
        assert_eq!(
            parse("28.11", default_now(), ZONE).due,
            Some("2026-11-28".to_string())
        );
        assert_eq!(parse("31.02", default_now(), ZONE).due, None);
        assert_eq!(parse("11/28", default_now(), ZONE).due, None);
    }

    #[test]
    fn a_past_day_and_month_means_next_year() {
        let now = Vilnius
            .with_ymd_and_hms(2026, 12, 30, 10, 0, 0)
            .unwrap()
            .timestamp();
        assert_eq!(
            parse("28 Dec", now, ZONE).due,
            Some("2027-12-28".to_string())
        );
    }

    #[test]
    fn the_zone_decides_today() {
        let now = Utc
            .with_ymd_and_hms(2026, 11, 26, 23, 30, 0)
            .unwrap()
            .timestamp();
        assert_eq!(
            parse("today", now, "Europe/Vilnius").due,
            Some("2026-11-27".to_string())
        );
    }
}
