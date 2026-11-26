//! Key terms for a draft's facts ask (design `docs/superpowers/specs/2026-11-25-reply-voice-design.md`
//! §10 "The terms", ruling 34): native, pure extraction of ticket ids, codes, acronyms,
//! capitalised names and amounts out of the marked message's subject and text, folded to drop
//! duplicates and capped to at most [`MAX_TERMS`] of at most [`MAX_TERM_WORDS`] words and
//! [`MAX_TERM_CHARS`] characters each, in the order they appear. Never an address, a phone
//! number, a URL, a greeting/weekday/month/sign-off/sentence-starter, or a name in
//! `skip_names` (the user's own names and the matched person's names, passed in by the
//! caller). Nothing here reaches a provider or a repository.

use std::collections::HashSet;

pub const MAX_TERMS: usize = 10;
pub const MAX_TERM_CHARS: usize = 40;
pub const MAX_TERM_WORDS: usize = 4;

/// A name run is at most this many words (spec §10: "runs of one to three capitalised words");
/// distinct from [`MAX_TERM_WORDS`], which is the final cap applied to every kind of term.
const NAME_RUN_MAX: usize = 3;
/// A phone-number run needs at least this many digits across its fragments (spec §10 "never:
/// ... phone numbers"; `+1 555 0100` has 8).
const PHONE_MIN_DIGITS: usize = 7;

/// English, Russian and Ukrainian greetings, weekdays, months, sign-offs and sentence starters
/// (spec §10's "a fixed list of common words in English, Russian and Ukrainian"): never a term,
/// capitalised or not.
const COMMON_WORDS: &[&str] = &[
    // English: greetings, sign-offs, sentence starters
    "hi",
    "hello",
    "hey",
    "dear",
    "thanks",
    "thank",
    "regards",
    "best",
    "sincerely",
    "cheers",
    "yours",
    "please",
    "today",
    "tomorrow",
    "yesterday",
    "the",
    "a",
    "an",
    "see",
    "you",
    "soon",
    "ok",
    "okay",
    "fyi",
    "asap",
    "pls",
    // English: weekdays, months
    "monday",
    "tuesday",
    "wednesday",
    "thursday",
    "friday",
    "saturday",
    "sunday",
    "january",
    "february",
    "march",
    "april",
    "may",
    "june",
    "july",
    "august",
    "september",
    "october",
    "november",
    "december",
    // Russian: greetings, sign-offs, sentence starters
    "привет",
    "здравствуйте",
    "спасибо",
    "пожалуйста",
    "уважаемый",
    "уважаемая",
    "уважением",
    "сегодня",
    "завтра",
    "вчера",
    // Russian: weekdays, months
    "понедельник",
    "вторник",
    "среда",
    "четверг",
    "пятница",
    "суббота",
    "воскресенье",
    "января",
    "февраля",
    "марта",
    "апреля",
    "мая",
    "июня",
    "июля",
    "августа",
    "сентября",
    "октября",
    "ноября",
    "декабря",
    // Ukrainian: greetings, sign-offs, sentence starters
    "привіт",
    "вітаю",
    "дякую",
    "будь",
    "ласка",
    "шановний",
    "шановна",
    "сьогодні",
    "завтра",
    "вчора",
    // Ukrainian: weekdays, months
    "понеділок",
    "вівторок",
    "середа",
    "четвер",
    "п'ятниця",
    "субота",
    "неділя",
    "січня",
    "лютого",
    "березня",
    "квітня",
    "травня",
    "червня",
    "липня",
    "серпня",
    "вересня",
    "жовтня",
    "листопада",
    "грудня",
];

/// One section's tokens (the subject, then the text), each the token's punctuation-stripped
/// surface form and whether it opens a sentence in that section.
struct Token {
    text: String,
    sentence_start: bool,
}

/// `<`/`>`/… punctuation trimmed off both ends (internal characters — a ticket's `-`, an
/// amount's `,`/`.`/k`/`m` suffix, a currency sign at the very start — are kept); empty when the
/// chunk holds nothing a term could use.
fn strip_punct(s: &str) -> &str {
    fn keep_lead(c: char) -> bool {
        c.is_alphanumeric() || matches!(c, '$' | '€' | '£' | '¥')
    }
    fn keep_trail(c: char) -> bool {
        c.is_alphanumeric()
    }
    let start = s
        .char_indices()
        .find(|&(_, c)| keep_lead(c))
        .map(|(i, _)| i)
        .unwrap_or(s.len());
    let tail = &s[start..];
    let end = tail
        .char_indices()
        .rev()
        .find(|&(_, c)| keep_trail(c))
        .map(|(i, c)| i + c.len_utf8())
        .unwrap_or(0);
    &tail[..end]
}

fn ends_a_sentence(chunk: &str) -> bool {
    let trimmed = chunk.trim_end_matches(['"', '\'', ')', ']', '”', '»']);
    trimmed.ends_with(['.', '!', '?'])
}

/// A whitespace-delimited chunk that is entirely an e-mail address (never a term, spec §10).
fn is_email(tok: &str) -> bool {
    match tok.rsplit_once('@') {
        Some((local, domain)) => !local.is_empty() && domain.contains('.'),
        None => false,
    }
}

/// A chunk that opens a URL (never a term, spec §10); the rest of the URL rides along in the
/// same whitespace-delimited chunk, so masking this one chunk is enough.
fn is_url(tok: &str) -> bool {
    let lower = tok.to_ascii_lowercase();
    lower.starts_with("http://") || lower.starts_with("https://") || lower.starts_with("www.")
}

/// Generic sentence punctuation that can trail (or lead) a phone fragment at a clause or
/// sentence boundary (`"0100,"`, `"0100."`) without being part of the number itself; `(`/`)`/
/// `+`/`-` are phone-meaningful and are never trimmed here.
const PHONE_TRIM: [char; 6] = [',', '.', ';', ':', '!', '?'];

/// A chunk that could be one fragment of a multi-chunk phone number (`+1`, `555`, `0100`, or one
/// of those with trailing sentence punctuation still attached, such as `0100,` or `0100.`): once
/// that punctuation is trimmed, only digits, `+`, `-`, `(`, `)` remain, with at least one digit.
fn is_phone_fragment(tok: &str) -> bool {
    let core = tok.trim_matches(|c: char| PHONE_TRIM.contains(&c));
    !core.is_empty()
        && core
            .chars()
            .all(|c| c.is_ascii_digit() || matches!(c, '+' | '-' | '(' | ')'))
        && core.chars().any(|c| c.is_ascii_digit())
}

/// Masks e-mail addresses, URLs and phone numbers (spec §10's "never", run before any other
/// rule) and splits what remains into [`Token`]s with their sentence-start flag.
fn tokenize_section(s: &str) -> Vec<Token> {
    let raw: Vec<&str> = s
        .split(char::is_whitespace)
        .filter(|t| !t.is_empty())
        .collect();
    let mut masked = vec![false; raw.len()];
    for (i, chunk) in raw.iter().enumerate() {
        if is_url(chunk) || is_email(chunk) {
            masked[i] = true;
        }
    }
    // Phone numbers split across chunks on whitespace (`+1 555 0100`): a run of consecutive,
    // not-yet-masked phone fragments whose digits total at least PHONE_MIN_DIGITS is masked
    // whole.
    let mut i = 0;
    while i < raw.len() {
        if masked[i] || !is_phone_fragment(raw[i]) {
            i += 1;
            continue;
        }
        let mut j = i;
        let mut digits = 0usize;
        while j < raw.len() && !masked[j] && is_phone_fragment(raw[j]) {
            digits += raw[j].chars().filter(char::is_ascii_digit).count();
            j += 1;
        }
        if digits >= PHONE_MIN_DIGITS {
            masked[i..j].fill(true);
        }
        i = j.max(i + 1);
    }

    let mut tokens = Vec::new();
    let mut sentence_start = true;
    for (i, chunk) in raw.iter().enumerate() {
        let ends_sentence = ends_a_sentence(chunk);
        if !masked[i] {
            let stripped = strip_punct(chunk);
            if !stripped.is_empty() {
                tokens.push(Token {
                    text: stripped.to_string(),
                    sentence_start,
                });
            }
        }
        sentence_start = ends_sentence;
    }
    tokens
}

/// `text`'s tokens as [`terms_of`] cuts them (addresses, URLs and phone numbers masked,
/// punctuation trimmed off both ends), for Ask's whole-token matching (ask-capture ruling 31).
pub(crate) fn tokens(text: &str) -> Vec<String> {
    tokenize_section(text).into_iter().map(|t| t.text).collect()
}

/// Whether `word` is on the extractor's common-word lists (greetings, weekdays, months,
/// sign-offs and sentence starters in English, Russian and Ukrainian), case-folded.
pub(crate) fn is_common(word: &str) -> bool {
    is_common_word(word)
}

/// A number with a currency sign attached (`$12,000`), or with a `k`/`m` suffix (`15k`, `2.5m`,
/// with or without a sign) — spec §10's amounts, the half that fits in one chunk. A number with
/// a separate currency *code* (`15k EUR`) is completed by the caller from the next token.
fn is_amount_token(tok: &str) -> bool {
    let mut chars = tok.chars().peekable();
    let has_sign = matches!(chars.peek(), Some('$' | '€' | '£' | '¥'));
    if has_sign {
        chars.next();
    }
    let mut saw_digit = false;
    while let Some(&c) = chars.peek() {
        if c.is_ascii_digit() {
            saw_digit = true;
            chars.next();
        } else if (c == ',' || c == '.') && saw_digit {
            chars.next();
        } else {
            break;
        }
    }
    if !saw_digit {
        return false;
    }
    let mut has_km = false;
    if let Some(&c) = chars.peek() {
        if matches!(c, 'k' | 'K' | 'm' | 'M') {
            chars.next();
            has_km = true;
        }
    }
    chars.next().is_none() && (has_sign || has_km)
}

/// A bare number (digits, optional `,`/`.`), no sign and no k/m suffix — the other half of
/// "a number with a currency sign or code": paired with a following [`is_currency_code`] token.
fn is_plain_number(tok: &str) -> bool {
    let mut saw_digit = false;
    for c in tok.chars() {
        if c.is_ascii_digit() {
            saw_digit = true;
        } else if c != ',' && c != '.' {
            return false;
        }
    }
    saw_digit
}

/// A 3-letter, all-uppercase currency code (`EUR`, `USD`), only ever read as the second half of
/// an amount that starts with a number in the previous token.
fn is_currency_code(tok: &str) -> bool {
    tok.len() == 3 && tok.chars().all(|c| c.is_ascii_uppercase())
}

/// A ticket id (`EPM-1234`) or code (`SOW-77`): 3-20 characters of letters, digits and at most
/// one internal hyphen, holding both a letter and a digit (spec §10).
fn is_ticket_or_code(tok: &str) -> bool {
    let len = tok.chars().count();
    if !(3..=20).contains(&len) || tok.starts_with('-') || tok.ends_with('-') {
        return false;
    }
    let mut letters = false;
    let mut digits = false;
    let mut hyphens = 0u32;
    for c in tok.chars() {
        if c.is_ascii_alphabetic() {
            letters = true;
        } else if c.is_ascii_digit() {
            digits = true;
        } else if c == '-' {
            hyphens += 1;
        } else {
            return false;
        }
    }
    letters && digits && hyphens <= 1
}

fn is_common_word(tok: &str) -> bool {
    COMMON_WORDS.contains(&tok.to_lowercase().as_str())
}

/// A 2-10 letter, all-uppercase acronym (`QBR`, `SLA`, `KPI`), never a common word written in
/// capitals (`OK`, `THANKS`, `FYI`, `ASAP`, `PLS` — spec §10's "never" list is unconditional, the
/// same as for a name); checked before a word is considered for a name run, so a real acronym is
/// never also read as a one-word name.
fn is_acronym(tok: &str) -> bool {
    let len = tok.chars().count();
    (2..=10).contains(&len) && tok.chars().all(|c| c.is_ascii_uppercase()) && !is_common_word(tok)
}

/// A capitalised word that could open or continue a name run: its first letter (Latin or
/// Cyrillic) is uppercase, the rest is letters/`'`/`-`, and it is not a common word — common
/// words are dropped unconditionally (spec §10's "never"), not only at a sentence start.
fn is_capitalized_word(tok: &str) -> bool {
    let Some(first) = tok.chars().next() else {
        return false;
    };
    first.is_uppercase()
        && tok
            .chars()
            .all(|c| c.is_alphabetic() || c == '\'' || c == '-')
        && !is_common_word(tok)
}

/// Each `skip_names` entry as its own lower-cased word set, kept apart so a run is only ever
/// matched against one whole name at a time (never a pool of words merged across every name).
fn skip_word_sets(skip_names: &[&str]) -> Vec<HashSet<String>> {
    skip_names
        .iter()
        .map(|n| n.split_whitespace().map(str::to_lowercase).collect())
        .collect()
}

/// Whether a candidate name run matches a whole skip name — every one of the run's words
/// belongs to the *same* skip name's word set (spec §10: "the user's own names, and the
/// person's names" — dropped whole, not just because one word happens to be shared). "Priya"
/// alone is dropped against the skip name "Priya Nair" (its one word is in that name); "Nair
/// Logistics" is not (`"logistics"` is not), even though "Nair" alone would match.
fn run_is_skipped(words: &[String], skip_sets: &[HashSet<String>]) -> bool {
    skip_sets
        .iter()
        .any(|set| !set.is_empty() && words.iter().all(|w| set.contains(&w.to_lowercase())))
}

struct Candidate {
    text: String,
    is_name: bool,
    sentence_start: bool,
    fold_key: String,
}

/// At most [`MAX_TERMS`] key terms out of `subject` and `text` (design §10, ruling 34): ticket
/// ids, codes, acronyms, names and amounts, never an address/phone/URL/common word or a name in
/// `skip_names` (the user's own names and the matched person's names), folded to drop duplicates
/// case-insensitively, in the order they first appear. An empty result means no `facts` ask
/// (ruling 34: "No term → no facts ask").
pub fn terms_of(subject: &str, text: &str, skip_names: &[&str]) -> Vec<String> {
    let skip = skip_word_sets(skip_names);
    let mut tokens = tokenize_section(subject);
    tokens.extend(tokenize_section(text));

    let mut candidates: Vec<Candidate> = Vec::new();
    let plain = |text: String| Candidate {
        fold_key: text.to_lowercase(),
        text,
        is_name: false,
        sentence_start: false,
    };

    let mut i = 0;
    while i < tokens.len() {
        let tok = &tokens[i].text;
        if is_amount_token(tok) {
            if i + 1 < tokens.len() && is_currency_code(&tokens[i + 1].text) {
                candidates.push(plain(format!("{tok} {}", tokens[i + 1].text)));
                i += 2;
            } else {
                candidates.push(plain(tok.clone()));
                i += 1;
            }
            continue;
        }
        if is_plain_number(tok) && i + 1 < tokens.len() && is_currency_code(&tokens[i + 1].text) {
            candidates.push(plain(format!("{tok} {}", tokens[i + 1].text)));
            i += 2;
            continue;
        }
        if is_ticket_or_code(tok) || is_acronym(tok) {
            candidates.push(plain(tok.clone()));
            i += 1;
            continue;
        }
        if is_capitalized_word(tok) {
            let start_sentence = tokens[i].sentence_start;
            // A name run never swallows an acronym-shaped word (`EUR`, `SLA`): that word is
            // also `is_capitalized_word` (an all-caps word's first letter is uppercase too),
            // but it is the more specific category, so it stops the run here — never consumed,
            // left for the outer loop to classify on its own next iteration.
            let is_run_word = |t: &str| is_capitalized_word(t) && !is_acronym(t);
            let mut j = i;
            let mut words = Vec::new();
            while j < tokens.len() && words.len() < NAME_RUN_MAX && is_run_word(&tokens[j].text) {
                words.push(tokens[j].text.clone());
                j += 1;
            }
            // Any further consecutive capitalised (non-acronym) words beyond the run cap are
            // consumed too, so they never start a second, overlapping run.
            while j < tokens.len() && is_run_word(&tokens[j].text) {
                j += 1;
            }
            if !run_is_skipped(&words, &skip) {
                let text = words.join(" ");
                candidates.push(Candidate {
                    fold_key: text.to_lowercase(),
                    text,
                    is_name: true,
                    sentence_start: start_sentence,
                });
            }
            i = j;
            continue;
        }
        i += 1;
    }

    // A name run at a sentence start is dropped unless the same run (case-insensitively) is
    // also capitalised elsewhere, not at a sentence start (spec §10).
    let keep_name_keys: HashSet<String> = candidates
        .iter()
        .filter(|c| c.is_name && !c.sentence_start)
        .map(|c| c.fold_key.clone())
        .collect();

    let mut seen: HashSet<String> = HashSet::new();
    let mut out: Vec<String> = Vec::new();
    for c in candidates {
        if c.is_name && c.sentence_start && !keep_name_keys.contains(c.fold_key.as_str()) {
            continue;
        }
        if !seen.insert(c.fold_key) {
            continue;
        }
        if c.text.split_whitespace().count() > MAX_TERM_WORDS
            || c.text.chars().count() > MAX_TERM_CHARS
        {
            continue;
        }
        out.push(c.text);
        if out.len() >= MAX_TERMS {
            break;
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::{json, Value};
    use std::path::Path;

    fn fixture_path() -> std::path::PathBuf {
        Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../ui/test/fixtures/contract/voice-terms-cases.json")
    }

    /// Asserts `terms_of(subject, text, skip)` against a hand-typed, literal `expected` *before*
    /// the case is written to the fixture — a wrong extraction fails this test directly, not
    /// only a committed-JSON comparison (matching Task 2's `push_case`).
    fn push_case(
        cases: &mut Vec<Value>,
        name: &str,
        subject: &str,
        text: &str,
        skip: &[&str],
        expected: &[&str],
    ) {
        let got = terms_of(subject, text, skip);
        assert_eq!(got, expected, "case {name:?}");
        cases.push(json!({
            "name": name,
            "subject": subject,
            "text": text,
            "skip": skip,
            "expected": expected,
        }));
    }

    fn build_cases() -> Vec<Value> {
        let mut cases = Vec::new();

        push_case(
            &mut cases,
            "ticket id and code kept",
            "Budget",
            "Can we move EPM-1234 and SOW-77 forward?",
            &[],
            &["EPM-1234", "SOW-77"],
        );

        push_case(
            &mut cases,
            "acronym kept",
            "Budget",
            "Let's prep for the QBR next week.",
            &[],
            &["QBR"],
        );

        push_case(
            &mut cases,
            "a name run kept mid-sentence",
            "Budget",
            "The team agreed that Atlas Rollout is on track.",
            &[],
            &["Atlas Rollout"],
        );

        push_case(
            &mut cases,
            "a greeting at a sentence start is dropped",
            "",
            "Hello there, let's talk tomorrow.",
            &[],
            &[],
        );

        push_case(
            &mut cases,
            "weekdays and months are dropped",
            "",
            "Monday works, or December if that is easier.",
            &[],
            &[],
        );

        push_case(
            &mut cases,
            "amounts kept: a currency sign and a k suffix with a code",
            "",
            "The budget is $12,000 this quarter, or about 15k EUR.",
            &[],
            &["$12,000", "15k EUR"],
        );

        push_case(
            &mut cases,
            "an address, a phone number and a URL are never terms",
            "",
            "Reach Priya at priya.n@example.test or +1 555 0100, details at https://example.test/x.",
            &["Priya Nair"],
            &[],
        );

        push_case(
            &mut cases,
            "the sender's and the user's names are dropped",
            "",
            "Priya Nair asked Taylor Reed to confirm the Atlas Rollout date.",
            &["Priya Nair", "Taylor Reed"],
            &["Atlas Rollout"],
        );

        push_case(
            &mut cases,
            "a short reply with only a greeting and a name yields no terms",
            "",
            "Thanks Priya, see you",
            &["Priya Nair"],
            &[],
        );

        push_case(
            &mut cases,
            "duplicates fold case-insensitively, order of appearance, capped at 10",
            "",
            "atlas rollout ABC-111 ABC-111 abc-111 QBR QBR CODE-222 CODE-333 CODE-444 CODE-555 \
             CODE-666 CODE-777 CODE-888 CODE-999",
            &[],
            &[
                "ABC-111", "QBR", "CODE-222", "CODE-333", "CODE-444", "CODE-555", "CODE-666",
                "CODE-777", "CODE-888", "CODE-999",
            ],
        );

        push_case(
            &mut cases,
            "cyrillic names kept",
            "",
            "Команда обсудила, что Проект Атлас идёт по плану.",
            &[],
            &["Проект Атлас"],
        );

        push_case(
            &mut cases,
            "a sentence-start run elsewhere in the text is kept",
            "",
            "Atlas Rollout starts Monday. We discussed Atlas Rollout again today.",
            &[],
            &["Atlas Rollout"],
        );

        // C1: a phone number whose last fragment carries trailing sentence punctuation (a
        // comma, a period) must still be masked whole, even right next to a currency-code-
        // shaped token — the brief's own case for "an address, a phone number and a URL are
        // never terms" with one clause inserted.
        push_case(
            &mut cases,
            "a phone number with a trailing comma before a currency code is still masked",
            "",
            "Call +1 555 0100, EUR is the budget line.",
            &[],
            &["EUR"],
        );
        push_case(
            &mut cases,
            "the brief's phone sentence stays masked with an inserted currency clause",
            "",
            "Reach Priya at priya.n@example.test or +1 555 0100, EUR is what we discussed, \
             details at https://example.test/x.",
            &["Priya Nair"],
            &["EUR"],
        );
        push_case(
            &mut cases,
            "a parenthesised area code plus a hyphenated local number is masked",
            "",
            "Call (555) 010-0100 for details.",
            &[],
            &[],
        );
        push_case(
            &mut cases,
            "a phone number ending a sentence with a period is masked",
            "",
            "Reach us at +44 20 7946 0958. Thanks.",
            &[],
            &[],
        );
        push_case(
            &mut cases,
            "a phone number at the very end of a sentence is masked",
            "",
            "Call me at 555 0100.",
            &[],
            &[],
        );

        // I1: an all-caps common word is never an acronym; a real acronym still is.
        push_case(
            &mut cases,
            "all-caps common words are never acronyms",
            "",
            "OK, THANKS for the update.",
            &[],
            &[],
        );
        push_case(
            &mut cases,
            "real acronyms stay terms",
            "",
            "Let's review the SLA and KPI before the SOW renewal.",
            &[],
            &["SLA", "KPI", "SOW"],
        );

        // Minor: a skip name only drops a run that matches it whole, not a run that merely
        // shares one word with it.
        push_case(
            &mut cases,
            "a run sharing one word with a skip name survives if the rest doesn't match",
            "",
            "Priya Nair reached out, and Nair Logistics confirmed the deal.",
            &["Priya Nair"],
            &["Nair Logistics"],
        );

        cases
    }

    #[test]
    fn contract_fixtures_match_the_terms_and_facts_cases() {
        crate::plugins::testkit::contract_fixture(
            "voice-terms-cases.json",
            &Value::Array(build_cases()),
        );
    }

    #[test]
    fn terms_cases_from_the_fixture() {
        let saved = std::fs::read_to_string(fixture_path()).expect(
            "voice-terms-cases.json is missing: run UPDATE_CONTRACT_FIXTURES=1 cargo test contract_fixtures",
        );
        let cases: Vec<Value> = serde_json::from_str(&saved).unwrap();
        assert!(!cases.is_empty());
        for case in cases {
            let name = case["name"].as_str().unwrap_or("<unnamed>");
            let subject = case["subject"].as_str().unwrap();
            let text = case["text"].as_str().unwrap();
            let skip: Vec<&str> = case["skip"]
                .as_array()
                .unwrap()
                .iter()
                .map(|v| v.as_str().unwrap())
                .collect();
            let expected: Vec<&str> = case["expected"]
                .as_array()
                .unwrap()
                .iter()
                .map(|v| v.as_str().unwrap())
                .collect();
            let got = terms_of(subject, text, &skip);
            assert_eq!(got, expected, "case {name:?}");
        }
    }

    /// Every term stays short even over a long, varied message (spec §10's own limits, not a
    /// computed bound): at most [`MAX_TERM_WORDS`] words and [`MAX_TERM_CHARS`] characters each.
    #[test]
    fn terms_never_carry_a_sentence() {
        let mut text = String::new();
        for i in 0..40 {
            text.push_str(&format!(
                "Project NorthStarExtendedNameRunningFarBeyondTheFortyCharacterLimit{i} \
                 EPM-{i:04} is on track this quarter for $12,{i:03} and 15k EUR. ",
            ));
        }
        assert!(
            text.chars().count() > 3_000,
            "message is {} chars",
            text.chars().count()
        );
        let terms = terms_of("", &text, &[]);
        assert!(!terms.is_empty());
        for t in &terms {
            assert!(
                t.split_whitespace().count() <= MAX_TERM_WORDS,
                "term {t:?} has more than {MAX_TERM_WORDS} words"
            );
            assert!(
                t.chars().count() <= MAX_TERM_CHARS,
                "term {t:?} has more than {MAX_TERM_CHARS} characters"
            );
        }
    }
}
