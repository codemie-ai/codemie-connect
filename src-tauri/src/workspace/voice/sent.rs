//! The user's own sent messages, read locally (reply-voice design §3): one reader for
//! `ctx.replyContext.sent` and a draft's examples. It answers from Connect's synced records of
//! the active account (`isMine`), newest first, and never reads Microsoft: an Outlook message is
//! its synced preview, a Teams message its synced text. A short reply's preview runs on into the
//! quoted original, so mail text is cut at the first quoted-reply marker, and every text loses
//! its email addresses: nothing someone else wrote, and no address, comes back as the user's.
use super::super::models::{Record, Result};
use super::super::prompts::{sanitize_line, sanitize_text};
use super::super::repository::Repository;
use serde_json::Value;
use std::collections::{BTreeMap, BTreeSet};

/// The longest text an item carries.
const TEXT_MAX: usize = 2_000;
const DAYS: (i64, i64) = (1, 180);
const LIMIT: (usize, usize) = (1, 200);
/// The longest subject or chat title.
const TITLE_MAX: usize = 200;
/// At most this many recipients' names, each at most `NAME_MAX` characters.
const NAMES_MAX: usize = 10;
const NAME_MAX: usize = 80;

/// Lines that start a quoted original's header (Outlook's, in the languages Connect drafts in,
/// and a few common others).
const HEADER_FROM: [&str; 6] = ["From:", "От:", "Від:", "Von:", "De:", "Da:"];
/// A header field that follows `From:` in a quoted original, when it runs on in one line.
const HEADER_NEXT: [&str; 10] = [
    "Sent:",
    "Date:",
    "To:",
    "Отправлено:",
    "Дата:",
    "Кому:",
    "Надіслано:",
    "Gesendet:",
    "Envoyé:",
    "Inviato:",
];
/// Separators a client puts above a quoted original.
const SEPARATORS: [&str; 5] = [
    "-----Original Message-----",
    "----- Original Message -----",
    "-----Исходное сообщение-----",
    "-----Оригінальне повідомлення-----",
    "__________",
];
/// "On <date>, <name> wrote:" and its forms. English runs on after the user's text, so the cut
/// goes back to "On "; the Russian and Ukrainian forms start with the date, so the cut is at the
/// start of their line.
const WROTE: [(&str, &[&str]); 7] = [
    ("wrote:", &["On "]),
    ("пишет:", &[]),
    ("написал:", &[]),
    ("написал(а):", &[]),
    ("пише:", &[]),
    ("написав:", &[]),
    ("написав(-ла):", &[]),
];
/// How far around a marker its partner is looked for, in bytes (always widened or narrowed to
/// a character boundary).
const NEAR: usize = 300;
/// Mail clients' own footer lines ("Sent from my iPhone"), never the user's words. Only a line
/// this short is taken for one.
const FOOTERS: [&str; 7] = [
    "Get Outlook for",
    "Sent from my ",
    "Sent from Outlook",
    "Sent from Mail for",
    "Отправлено с ",
    "Надіслано з ",
    "Envoyé de mon",
];
const FOOTER_MAX: usize = 80;

/// The largest character boundary of `s` at or below `n`.
fn floor_boundary(s: &str, n: usize) -> usize {
    let mut n = n.min(s.len());
    while !s.is_char_boundary(n) {
        n -= 1;
    }
    n
}

/// The smallest character boundary of `s` at or above `n`.
fn ceil_boundary(s: &str, n: usize) -> usize {
    let mut n = n.min(s.len());
    while !s.is_char_boundary(n) {
        n += 1;
    }
    n
}

/// The byte offset of the start of the line holding `at` (a character boundary).
fn line_start(text: &str, at: usize) -> usize {
    text[..at].rfind('\n').map_or(0, |i| i + 1)
}

/// The lines of `text` with the byte offset each starts at.
fn lines_at(text: &str) -> impl Iterator<Item = (usize, &str)> {
    text.split_inclusive('\n').scan(0, |at, line| {
        let start = *at;
        *at += line.len();
        Some((start, line))
    })
}

/// "… Priya <priya.n@example.test> написал(а):", "пн, 24 нояб. …, Priya <priya@…>:": a line
/// naming someone by `<address>` and ending in a colon introduces a quote, in any language.
fn is_attribution(line: &str) -> bool {
    let line = line.trim_end();
    line.ends_with(':')
        && line.find('<').is_some_and(|open| {
            let rest = &line[open..];
            rest.find('@').is_some_and(|at| rest[at..].contains('>'))
        })
}

/// Where the quoted original starts in a mail preview, if it does.
fn quote_start(text: &str) -> Option<usize> {
    let mut cuts = Vec::new();
    for sep in SEPARATORS {
        cuts.extend(text.find(sep));
    }
    for from in HEADER_FROM {
        for (at, _) in text.match_indices(from) {
            let at_line_start = text[line_start(text, at)..at].trim().is_empty();
            let rest = &text[at..floor_boundary(text, at + NEAR)];
            let followed = HEADER_NEXT.iter().any(|n| rest.contains(n));
            let after_space = at == 0 || text[..at].ends_with(char::is_whitespace);
            if (at_line_start || followed) && after_space {
                cuts.push(at);
                break;
            }
        }
    }
    for (word, openers) in WROTE {
        if let Some(at) = text.find(word) {
            let from = ceil_boundary(text, at.saturating_sub(NEAR));
            let opener = openers
                .iter()
                .filter_map(|o| text[from..at].rfind(o).map(|i| from + i))
                .max();
            cuts.push(opener.unwrap_or_else(|| line_start(text, at)));
        }
    }
    cuts.extend(
        lines_at(text)
            .find(|(_, line)| is_attribution(line))
            .map(|(at, _)| at),
    );
    cuts.into_iter().min()
}

/// A mail client's footer line.
fn is_footer(line: &str) -> bool {
    line.chars().count() <= FOOTER_MAX && FOOTERS.iter().any(|f| line.starts_with(f))
}

/// `text` without its email addresses: each word holding an `@` with a dot after it goes, with
/// the space after it.
fn without_addresses(text: &str) -> String {
    text.split_inclusive(char::is_whitespace)
        .filter(|seg| {
            let word = seg.trim_end();
            !word
                .split_once('@')
                .is_some_and(|(_, host)| host.contains('.'))
        })
        .collect()
}

/// A message's text as the user wrote it: a mail's quoted original cut off, with its `>` lines
/// and a client's footer dropped; sanitized and cut to `TEXT_MAX`, then addresses removed (after
/// sanitizing, so a character it deletes can't join an address back together).
fn own_text(raw: &str, mail: bool) -> String {
    let mine = if mail {
        raw[..quote_start(raw).unwrap_or(raw.len())]
            .lines()
            .filter(|l| {
                let l = l.trim();
                !l.starts_with('>') && !is_footer(l)
            })
            .collect::<Vec<_>>()
            .join("\n")
    } else {
        raw.to_string()
    };
    without_addresses(&sanitize_text(&mine, TEXT_MAX))
        .trim()
        .to_string()
}

/// What to read: `channel` `mail`, `chat` or `all`; `days` 1–180; `limit` 1–200 (both clamped);
/// `address` keeps mail whose recipients hold it, `from_id` Teams messages in the 1:1 chat with
/// that member (either one is enough when both are given); `chat_id` keeps that chat only.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SentFilter {
    pub channel: String,
    pub days: i64,
    pub limit: usize,
    pub address: Option<String>,
    pub from_id: Option<String>,
    pub chat_id: Option<String>,
}
impl Default for SentFilter {
    fn default() -> Self {
        Self {
            channel: "all".into(),
            days: 90,
            limit: 100,
            address: None,
            from_id: None,
            chat_id: None,
        }
    }
}

/// One sent message: `to` is the recipients' names (mail) or the chat's title (Teams), never an
/// address; `subject` is mail's only; `chat_type` is the Teams chat's type, `None` for mail.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SentItem {
    pub record_id: String,
    pub channel: String,
    pub at: i64,
    pub text: String,
    pub subject: Option<String>,
    pub to: String,
    pub chat_type: Option<String>,
}

/// The chats catalog of account `cid`, by chat id.
fn chats(repo: &Repository, cid: &str) -> BTreeMap<String, Value> {
    repo.record("catalog", "chats", Some(cid), None)
        .ok()
        .and_then(|c| c.data["values"].as_array().cloned())
        .into_iter()
        .flatten()
        .filter_map(|c| Some((c["id"].as_str()?.to_string(), c)))
        .collect()
}

/// The 1:1 chats whose other member is `user` (`me` is the account's own user id).
fn one_to_one_with(chats: &BTreeMap<String, Value>, me: &str, user: &str) -> BTreeSet<String> {
    chats
        .iter()
        .filter(|(_, c)| c["chatType"] == "oneOnOne")
        .filter(|(_, c)| {
            user != me
                && c["members"]
                    .as_array()
                    .is_some_and(|m| m.iter().any(|m| m["userId"].as_str() == Some(user)))
        })
        .map(|(id, _)| id.clone())
        .collect()
}

/// A mail's recipients (`to` and `cc`) as Graph gives them.
fn recipients(m: &Record) -> impl Iterator<Item = &Value> {
    ["to", "cc"]
        .into_iter()
        .flat_map(|k| m.data[k].as_array().into_iter().flatten())
}

/// A name that isn't an address (a recipient with no display name is often shown by address),
/// on one line and at most `max` characters.
fn plain_name(s: &str, max: usize) -> Option<String> {
    let s = sanitize_line(s, max);
    (!s.is_empty() && !s.contains('@')).then_some(s)
}

/// The user's own sent messages that pass `f`, newest first, at most `f.limit`.
pub fn own_sent(repo: &Repository, f: &SentFilter, now: i64) -> Result<Vec<SentItem>> {
    let Some(cid) = repo.settings()?.active_connection else {
        return Ok(Vec::new());
    };
    let me = repo.connection(&cid).map(|c| c.user_id).unwrap_or_default();
    let days = f.days.clamp(DAYS.0, DAYS.1);
    let limit = f.limit.clamp(LIMIT.0, LIMIT.1);
    let since = now - days * 86_400;
    let catalog = chats(repo, &cid);
    let address = f.address.as_deref().map(str::to_lowercase);
    let with = f
        .from_id
        .as_deref()
        .map(|u| one_to_one_with(&catalog, &me, u));
    let person = address.is_some() || with.is_some();

    let mut items: Vec<SentItem> = repo
        .provider_records(&cid, "message")?
        .into_iter()
        .filter(|m| m.data["isMine"] == true && m.data["deleted"] != true)
        .filter_map(|m| {
            let channel = m.data["channel"].as_str()?.to_string();
            let mail = match channel.as_str() {
                "mail" => true,
                "chat" => false,
                _ => return None,
            };
            if f.channel != "all" && f.channel != channel {
                return None;
            }
            let at = m.data["at"].as_i64().unwrap_or(0);
            if at < since {
                return None;
            }
            let chat_id = m.data["chatId"].as_str();
            if let Some(want) = &f.chat_id {
                if mail || chat_id != Some(want.as_str()) {
                    return None;
                }
            }
            if person {
                let to_address = mail
                    && address.as_ref().is_some_and(|a| {
                        recipients(&m).any(|r| {
                            r["emailAddress"]["address"]
                                .as_str()
                                .is_some_and(|x| x.to_lowercase() == *a)
                        })
                    });
                let in_chat = !mail
                    && with
                        .as_ref()
                        .zip(chat_id)
                        .is_some_and(|(set, id)| set.contains(id));
                if !(to_address || in_chat) {
                    return None;
                }
            }
            let text = own_text(m.data["text"].as_str().unwrap_or(""), mail);
            if text.is_empty() {
                return None;
            }
            let (subject, to, chat_type) = if mail {
                let names: Vec<String> = recipients(&m)
                    .filter_map(|r| {
                        r["emailAddress"]["name"]
                            .as_str()
                            .and_then(|n| plain_name(n, NAME_MAX))
                    })
                    .take(NAMES_MAX)
                    .collect();
                let subject = m.data["title"].as_str().map(|s| {
                    without_addresses(&sanitize_line(s, TITLE_MAX))
                        .trim()
                        .to_string()
                });
                (subject, names.join(", "), None)
            } else {
                let title = m.data["title"]
                    .as_str()
                    .and_then(|t| plain_name(t, TITLE_MAX))
                    .unwrap_or_default();
                let chat_type = m.data["chatType"]
                    .as_str()
                    .or_else(|| catalog.get(chat_id?)?["chatType"].as_str())
                    .map(str::to_string);
                (None, title, chat_type)
            };
            Some(SentItem {
                record_id: m.id,
                channel,
                at,
                text,
                subject,
                to,
                chat_type,
            })
        })
        .collect();
    items.sort_by(|a, b| b.at.cmp(&a.at).then_with(|| a.record_id.cmp(&b.record_id)));
    items.truncate(limit);
    Ok(items)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Cyrillic (two bytes a letter) after a header, at every byte alignment and length around
    /// every limit: never a slice inside a character, always cut at the header.
    #[test]
    fn long_cyrillic_quotes_never_split_a_character() {
        for header in ["От: ", "Від: ", "From: ", "De: "] {
            for pad in 0..4 {
                for len in [140, 149, 150, 151, 160, 300, 1_200] {
                    let quote: String = "о".repeat(len);
                    for next in ["Отправлено: понедельник", ""] {
                        let raw = format!(
                            "Ок.\n{header}Прія Наталенко{} {quote} {next}",
                            " ".repeat(pad)
                        );
                        let mine = own_text(&raw, true);
                        assert_eq!(mine, "Ок.", "{header:?} pad {pad} len {len}");
                        let inline = format!("Ок. {header}Прія{} {quote} {next} ", " ".repeat(pad));
                        own_text(&inline, true);
                    }
                }
            }
        }
        for len in 0..700 {
            let raw = format!("{}wrote: {}", "ы".repeat(len), "я".repeat(len % 7));
            own_text(&raw, true);
            own_text(&raw, false);
        }
    }

    #[test]
    fn other_quote_shapes_and_footers_are_cut() {
        let cases = [
            // `>` lines with no attribution, before and between the user's lines.
            ("Sure\r\n\r\n> Can you send the SOW?\r\n> Priya", "Sure"),
            ("Agreed.\r\n> question\r\n  >> older\r\nYes, today.", "Agreed.\nYes, today."),
            // macOS Mail in Russian and Ukrainian.
            (
                "Да, пришлю.\r\n\r\n24 нояб. 2026 г., в 10:00, Прія <priya.n@example.test> написал(а):\r\n\r\nМожешь прислать?",
                "Да, пришлю.",
            ),
            (
                "Так.\r\n\r\n24 лист. 2026 р. о 10:00 Прія <priya.n@example.test> написав(-ла):\r\nЧи можна?",
                "Так.",
            ),
            // The Ukrainian form with no address.
            ("Так.\r\nПрія написав(-ла):\r\nЧи можна?", "Так."),
            // Gmail in Russian with no verb.
            (
                "Ок\r\n\r\nпн, 24 нояб. 2026 г. в 10:00, Priya <priya.n@example.test>:\r\n\r\nМожешь прислать?",
                "Ок",
            ),
            // Client footers.
            (
                "Sure.\r\n\r\nGet Outlook for iOS<https://aka.ms/o0ukef>\r\n________________________________\r\nFrom: Priya",
                "Sure.",
            ),
            ("On my way.\r\n\r\nSent from my iPhone", "On my way."),
            ("Буду.\nОтправлено с iPhone", "Буду."),
            ("Буду.\nНадіслано з iPhone", "Буду."),
        ];
        for (raw, want) in cases {
            assert_eq!(own_text(raw, true), want, "{raw:?}");
        }
    }

    /// An address split by a character sanitizing deletes doesn't come back joined.
    #[test]
    fn addresses_are_removed_after_sanitizing() {
        for raw in [
            "Write priya@example\u{85}.test today",
            "Write priya@example\u{0b}.test today",
            "Write priya@\u{1f}example.test today",
        ] {
            let mine = own_text(raw, false);
            assert!(!mine.contains('@'), "{mine:?}");
            assert!(
                mine.starts_with("Write") && mine.ends_with("today"),
                "{mine:?}"
            );
        }
    }
}
