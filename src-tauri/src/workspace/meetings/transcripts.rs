//! Finding a meeting's Teams transcripts: Graph URLs, picking this occurrence's transcripts and
//! the state a check leaves the meeting in.
use super::model::{ErrorInfo, MeetingState, TranscriptRef};
use crate::workspace::{graph, models::*};
use serde_json::Value;

/// A transcript belongs to an occurrence when Teams started it from this long before the start
/// to this long after the end.
const MARGIN: i64 = 30 * 60;
/// How long after its start an occurrence without an end still claims transcripts.
const NO_END: i64 = 3 * 3600;
/// Checks stop this long after the meeting ended; a meeting still without a transcript is `none`.
pub const STOP_AFTER: i64 = 24 * 3600;

/// Percent-encodes all but the unreserved characters (RFC 3986): a space is `%20`, never `+`.
fn encode(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for b in s.bytes() {
        if b.is_ascii_alphanumeric() || matches!(b, b'-' | b'.' | b'_' | b'~') {
            out.push(b as char);
        } else {
            out.push_str(&format!("%{b:02X}"));
        }
    }
    out
}

/// `GET /me/onlineMeetings?$filter=JoinWebUrl eq '<link>'`: the online meeting behind an
/// event's join link. Quotes in the link are doubled (OData) and the whole filter is encoded.
pub fn lookup_url(join_url: &str) -> String {
    let filter = format!("JoinWebUrl eq '{}'", join_url.replace('\'', "''"));
    graph::endpoint(&format!("/me/onlineMeetings?$filter={}", encode(&filter)))
}

/// `GET /me/onlineMeetings/{id}/transcripts`
pub fn list_url(meeting_id: &str) -> String {
    graph::endpoint(&format!(
        "/me/onlineMeetings/{}/transcripts",
        encode(meeting_id)
    ))
}

/// The most pages of a transcripts list read: 500 transcripts at Graph's 50 a page.
pub const LIST_PAGES: usize = 10;

/// An online meeting's transcripts list, read whole: a recurring meeting's holds every
/// occurrence's, and Graph pages it, so `@odata.nextLink` is followed (a Graph URL only), at
/// most [`LIST_PAGES`] pages. One `{"value": [...]}` with every page's transcripts.
pub(super) async fn list_transcripts(
    core: &crate::workspace::Core,
    c: &Connection,
    meeting_id: &str,
) -> Result<Value> {
    let mut all = Vec::new();
    let mut url = list_url(meeting_id);
    for _ in 0..LIST_PAGES {
        let page = core.graph_reads.get(core, c, &url).await?;
        all.extend(page["value"].as_array().cloned().unwrap_or_default());
        let Some(next) = page["@odata.nextLink"].as_str() else {
            break;
        };
        graph::validate_graph_url(next)?;
        url = next.to_string();
    }
    Ok(serde_json::json!({ "value": all }))
}

/// `GET /me/onlineMeetings/{id}/transcripts/{id}/content?$format=text/vtt`
pub fn content_url(meeting_id: &str, transcript_id: &str) -> String {
    graph::endpoint(&format!(
        "/me/onlineMeetings/{}/transcripts/{}/content?$format=text/vtt",
        encode(meeting_id),
        encode(transcript_id)
    ))
}

/// The transcripts of one occurrence, oldest first. A recurring meeting shares one online
/// meeting, so its list holds every occurrence's transcripts: only those Teams started from 30
/// minutes before `start` to 30 minutes after `end` (3 hours after `start` without an end) count.
pub fn pick_transcripts(list: &Value, start: i64, end: Option<i64>) -> Vec<TranscriptRef> {
    let from = start - MARGIN;
    let to = end.map_or(start + NO_END, |end| end + MARGIN);
    let mut picked: Vec<TranscriptRef> = list["value"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|t| {
            let id = t["id"].as_str().filter(|id| !id.is_empty())?;
            let created = chrono::DateTime::parse_from_rfc3339(t["createdDateTime"].as_str()?)
                .ok()?
                .timestamp();
            (from..=to).contains(&created).then(|| TranscriptRef {
                id: id.into(),
                created,
            })
        })
        .collect();
    picked.sort_by_key(|t| t.created);
    picked
}

/// The state a check leaves a meeting in: `available` when Teams has transcripts; `blocked`
/// (with Microsoft's reason) when it refused them (403, or no meeting for this account);
/// otherwise still `pending` until a day after the meeting ended, then `none`. A read that did
/// not get through (offline, throttled, a token Graph refused with 401) keeps its reason, and
/// the next slot checks again.
pub fn state_after_check(
    found: Result<Vec<TranscriptRef>>,
    ended_at: i64,
    now: i64,
) -> (MeetingState, Option<ErrorInfo>) {
    let waiting = if now - ended_at < STOP_AFTER {
        MeetingState::Pending
    } else {
        MeetingState::None
    };
    match found {
        Ok(found) if !found.is_empty() => (MeetingState::Available, None),
        Ok(_) => (waiting, None),
        Err(e)
            if matches!(
                e.code.as_str(),
                "permission_required" | "transcript_blocked"
            ) =>
        {
            (
                MeetingState::Blocked,
                Some(ErrorInfo {
                    code: "transcript_blocked".into(),
                    message: e.message,
                }),
            )
        }
        Err(e) => (waiting, Some(ErrorInfo::from(&e))),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::workspace::graph::{timestamp, validate_graph_url};
    use serde_json::json;

    #[test]
    fn lookup_url_escapes_the_join_link() {
        let link = "https://teams.microsoft.com/l/meetup-join/19%3ameeting_x%40thread.v2/0?context=%7b%22Tid%22%7d&name=O'Brien sync";
        let url = lookup_url(link);
        assert!(
            url.starts_with("https://graph.microsoft.com/v1.0/me/onlineMeetings?$filter="),
            "{url}"
        );
        assert!(url.contains("%20"), "{url}");
        assert!(url.contains("O%27%27Brien"), "the quote is doubled: {url}");
        assert!(!url.contains(' ') && !url.contains('\''), "{url}");
        assert!(validate_graph_url(&url).is_ok());
        let parsed = url::Url::parse(&url).unwrap();
        let filter = parsed
            .query_pairs()
            .find(|(k, _)| k == "$filter")
            .unwrap()
            .1
            .to_string();
        assert_eq!(
            filter,
            "JoinWebUrl eq 'https://teams.microsoft.com/l/meetup-join/19%3ameeting_x%40thread.v2/0?context=%7b%22Tid%22%7d&name=O''Brien sync'"
        );
    }

    #[test]
    fn transcript_urls_are_graph_me_paths() {
        assert_eq!(
            list_url("MSo1N2Y5=="),
            "https://graph.microsoft.com/v1.0/me/onlineMeetings/MSo1N2Y5%3D%3D/transcripts"
        );
        let content = content_url("MSo1N2Y5==", "MSMjMCMj/x");
        assert_eq!(
            content,
            "https://graph.microsoft.com/v1.0/me/onlineMeetings/MSo1N2Y5%3D%3D/transcripts/MSMjMCMj%2Fx/content?$format=text/vtt"
        );
        assert!(validate_graph_url(&content).is_ok());
    }

    #[test]
    fn pick_transcripts_keeps_only_this_occurrence() {
        // A weekly sync shares one online meeting: the lookup lists every week's transcript.
        let start = timestamp("2026-11-11T10:00:00Z");
        let end = Some(start + 1800);
        let list = json!({"value": [
            {"id": "w3", "createdDateTime": "2026-11-18T10:01:00Z"},
            {"id": "w2b", "createdDateTime": "2026-11-11T10:20:00Z"},
            {"id": "w1", "createdDateTime": "2026-11-04T10:01:00Z"},
            {"id": "w2", "createdDateTime": "2026-11-11T10:02:00Z"},
            {"createdDateTime": "2026-11-11T10:03:00Z"},
            {"id": "bad-date", "createdDateTime": "yesterday"}
        ]});
        let picked = pick_transcripts(&list, start, end);
        assert_eq!(
            picked,
            vec![
                TranscriptRef {
                    id: "w2".into(),
                    created: timestamp("2026-11-11T10:02:00Z")
                },
                TranscriptRef {
                    id: "w2b".into(),
                    created: timestamp("2026-11-11T10:20:00Z")
                },
            ]
        );
        // The edges: 30 minutes before the start and after the end.
        let edge = |at: &str| json!({"value": [{"id": "t", "createdDateTime": at}]});
        assert_eq!(
            pick_transcripts(&edge("2026-11-11T09:30:00Z"), start, end).len(),
            1
        );
        assert_eq!(
            pick_transcripts(&edge("2026-11-11T09:29:59Z"), start, end).len(),
            0
        );
        assert_eq!(
            pick_transcripts(&edge("2026-11-11T11:00:00Z"), start, end).len(),
            1
        );
        assert_eq!(
            pick_transcripts(&edge("2026-11-11T11:00:01Z"), start, end).len(),
            0
        );
        // No end: three hours after the start.
        assert_eq!(
            pick_transcripts(&edge("2026-11-11T12:59:00Z"), start, None).len(),
            1
        );
        assert_eq!(
            pick_transcripts(&edge("2026-11-11T13:00:01Z"), start, None).len(),
            0
        );
        assert!(pick_transcripts(&json!({}), start, end).is_empty());
    }

    #[test]
    fn state_after_check_maps_every_outcome() {
        let ended = 1_795_000_000;
        let found = vec![TranscriptRef {
            id: "t".into(),
            created: ended - 1800,
        }];
        assert_eq!(
            state_after_check(Ok(found), ended, ended + 600),
            (MeetingState::Available, None)
        );
        assert_eq!(
            state_after_check(Ok(vec![]), ended, ended + 2 * 3600),
            (MeetingState::Pending, None)
        );
        assert_eq!(
            state_after_check(Ok(vec![]), ended, ended + 25 * 3600),
            (MeetingState::None, None)
        );
        let blocked = state_after_check(
            Err(WorkspaceError::new(
                "permission_required",
                "Forbidden: GraphAccessToTranscriptsDisabled: the tenant does not allow it",
            )),
            ended,
            ended + 600,
        );
        assert_eq!(blocked.0, MeetingState::Blocked);
        let info = blocked.1.unwrap();
        assert_eq!(info.code, "transcript_blocked");
        assert!(info.message.contains("GraphAccessToTranscriptsDisabled"));
        // A token Graph refused is not a meeting Microsoft refused: it waits and is checked again.
        let unauthorized = state_after_check(
            Err(WorkspaceError::new(
                "needs_login",
                "InvalidAuthenticationToken: expired",
            )),
            ended,
            ended + 600,
        );
        assert_eq!(unauthorized.0, MeetingState::Pending);
        assert_eq!(unauthorized.1.unwrap().code, "needs_login");
        let lookup_empty = state_after_check(
            Err(WorkspaceError::new(
                "transcript_blocked",
                "Teams didn’t return this meeting.",
            )),
            ended,
            ended + 600,
        );
        assert_eq!(lookup_empty.0, MeetingState::Blocked);
        // A read that did not get through says so, and the meeting keeps waiting.
        let offline = |now| {
            state_after_check(
                Err(WorkspaceError::new("offline", "Microsoft read timed out.")),
                ended,
                now,
            )
        };
        assert_eq!(
            offline(ended + 3600),
            (
                MeetingState::Pending,
                Some(ErrorInfo {
                    code: "offline".into(),
                    message: "Microsoft read timed out.".into()
                })
            )
        );
        assert_eq!(offline(ended + 25 * 3600).0, MeetingState::None);
    }
}
