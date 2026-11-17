//! Free time for "Propose times" drafts (DESIGN 6.4). The sweep matches `freeSlots` in
//! `ui/workspace/calendar-model.js`: timed events that are not `showAs: "free"` (and not
//! declined) are busy, they are clipped to the day's window, and only gaps of at least
//! `min_len` minutes count. One deliberate addition: an all-day event shown as out of office
//! or busy takes the whole working day (the calendar view should follow).
use super::{graph, models::Record};
use chrono::{Datelike, Duration, LocalResult, NaiveDate, TimeZone, Weekday};
use chrono_tz::Tz;

/// The first free minute offered today is rounded up to a quarter hour.
const STEP_SECS: i64 = 15 * 60;
/// Calendar days looked at before giving up on finding enough working days.
const MAX_SCAN_DAYS: usize = 21;

/// Free `(start, end)` ranges (unix seconds) on the next `days` working days (Monday to
/// Friday) between `day_start_min` and `day_end_min` minutes of the day in `zone`.
/// Today counts while its window is still open; time before `now` is never offered.
pub fn free_slots(
    events: &[Record],
    day_start_min: i64,
    day_end_min: i64,
    days: usize,
    min_len: i64,
    zone: Tz,
    now: i64,
) -> Vec<(i64, i64)> {
    let blocking = events
        .iter()
        .filter(|e| e.data["cancelled"] != true && e.data["response"] != "declined");
    let busy_events: Vec<(i64, i64)> = blocking
        .clone()
        .filter(|e| e.data["showAs"] != "free" && e.data["allDay"] != true)
        .map(|e| {
            (
                graph::timestamp(e.data["start"].as_str().unwrap_or("")),
                graph::timestamp(e.data["end"].as_str().unwrap_or("")),
            )
        })
        .filter(|(s, e)| *s > 0 && e > s)
        .collect();
    // Local dates `[start, end)` taken by all-day absences.
    let away_days: Vec<(NaiveDate, NaiveDate)> = blocking
        .filter(|e| {
            e.data["allDay"] == true && matches!(e.data["showAs"].as_str(), Some("oof" | "busy"))
        })
        .filter_map(|e| all_day_dates(e, zone))
        .collect();
    let min_len = min_len * 60;
    let first_free = (now + STEP_SECS - 1).div_euclid(STEP_SECS) * STEP_SECS;
    let mut day = match zone.timestamp_opt(now, 0) {
        LocalResult::Single(t) | LocalResult::Ambiguous(t, _) => t.date_naive(),
        LocalResult::None => return Vec::new(),
    };
    let mut slots = Vec::new();
    let mut counted = 0;
    for _ in 0..MAX_SCAN_DAYS {
        if counted == days {
            break;
        }
        let working = !matches!(day.weekday(), Weekday::Sat | Weekday::Sun)
            && !away_days.iter().any(|(from, to)| *from <= day && day < *to);
        let (start, end) = (
            local(zone, day, day_start_min),
            local(zone, day, day_end_min),
        );
        if working && end > now {
            let before = slots.len();
            let from = start.max(first_free);
            let mut busy: Vec<(i64, i64)> = busy_events
                .iter()
                .map(|&(s, e)| (s.max(from), e.min(end)))
                .filter(|(s, e)| e > s)
                .collect();
            busy.sort_unstable();
            let mut cursor = from;
            for (s, e) in busy {
                if s - cursor >= min_len {
                    slots.push((cursor, s));
                }
                cursor = cursor.max(e);
            }
            if end - cursor >= min_len {
                slots.push((cursor, end));
            }
            // A day with no free time left is not one of the offered days.
            if slots.len() > before {
                counted += 1;
            }
        }
        day = match day.succ_opt() {
            Some(next) => next,
            None => break,
        };
    }
    slots
}

/// The local dates an all-day event covers, end exclusive: its `startDate`/`endDate` when
/// sync stored them, else the dates of its start and end in `zone`.
fn all_day_dates(e: &Record, zone: Tz) -> Option<(NaiveDate, NaiveDate)> {
    let stored = |key: &str| {
        e.data[key]
            .as_str()
            .and_then(|d| NaiveDate::parse_from_str(d, "%Y-%m-%d").ok())
    };
    let derived = |key: &str| {
        zone.timestamp_opt(graph::timestamp(e.data[key].as_str()?), 0)
            .earliest()
            .map(|t| t.date_naive())
    };
    let start = stored("startDate").or_else(|| derived("start"))?;
    let end = stored("endDate").or_else(|| derived("end"))?;
    Some((start, end.max(start.succ_opt()?)))
}

/// `minutes` after midnight of `day` in `zone`, as unix seconds. An hour skipped by a clock
/// change resolves to the first time after it; a repeated hour to its first occurrence.
fn local(zone: Tz, day: NaiveDate, minutes: i64) -> i64 {
    let naive = day.and_hms_opt(0, 0, 0).unwrap_or_default() + Duration::minutes(minutes);
    match zone.from_local_datetime(&naive) {
        LocalResult::Single(t) | LocalResult::Ambiguous(t, _) => t.timestamp(),
        LocalResult::None => zone
            .from_local_datetime(&(naive + Duration::hours(1)))
            .earliest()
            .map(|t| t.timestamp())
            .unwrap_or_else(|| naive.and_utc().timestamp()),
    }
}

/// "Mon 26 Oct, 09:00–10:30" in `zone` (offered within the next days, so no year).
pub fn format_slot(slot: (i64, i64), zone: Tz) -> String {
    let at = |t: i64| zone.timestamp_opt(t, 0).earliest();
    match (at(slot.0), at(slot.1)) {
        (Some(s), Some(e)) => format!(
            "{}, {}–{}",
            s.format("%a %-d %b"),
            s.format("%H:%M"),
            e.format("%H:%M")
        ),
        _ => String::new(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    const KYIV: Tz = chrono_tz::Europe::Kyiv;

    fn at(rfc3339: &str) -> i64 {
        chrono::DateTime::parse_from_rfc3339(rfc3339)
            .unwrap()
            .timestamp()
    }

    fn event(id: &str, start: &str, end: &str, extra: serde_json::Value) -> Record {
        let mut data = json!({"start": start, "end": end, "showAs": "busy"});
        for (k, v) in extra.as_object().unwrap() {
            data[k] = v.clone();
        }
        Record {
            id: id.into(),
            kind: "event".into(),
            connection_id: Some("acct".into()),
            workspace_id: None,
            source: "calendar:primary".into(),
            revision: "1".into(),
            updated_at: 0,
            data,
        }
    }

    #[test]
    fn free_slots_skip_busy_and_past_and_respect_working_hours() {
        // Friday 23 Oct 2026, 16:00 in Kyiv (EEST, UTC+3). Summer time ends on Sunday 25 Oct,
        // so Monday and Tuesday are on EET (UTC+2): 09:00 there is 07:00 UTC, not 06:00.
        let now = at("2026-10-23T13:00:00Z");
        let events = vec![
            // Earlier today: already past, so it changes nothing.
            event(
                "past",
                "2026-10-23T07:00:00Z",
                "2026-10-23T08:00:00Z",
                json!({}),
            ),
            // Friday 16:30-17:00 local.
            event(
                "fri",
                "2026-10-23T13:30:00Z",
                "2026-10-23T14:00:00Z",
                json!({}),
            ),
            // Monday 10:00-11:30 local (UTC+2).
            event(
                "mon-a",
                "2026-10-26T08:00:00Z",
                "2026-10-26T09:30:00Z",
                json!({}),
            ),
            // Free-marked and cancelled events, and an all-day "working elsewhere", never block time.
            event(
                "mon-free",
                "2026-10-26T10:00:00Z",
                "2026-10-26T11:00:00Z",
                json!({"showAs": "free"}),
            ),
            event(
                "mon-cancelled",
                "2026-10-26T12:30:00Z",
                "2026-10-26T13:00:00Z",
                json!({"cancelled": true}),
            ),
            event(
                "mon-all-day",
                "2026-10-26T00:00:00Z",
                "2026-10-27T00:00:00Z",
                json!({"allDay": true, "showAs": "workingElsewhere"}),
            ),
            // Monday 14:00-14:20 local.
            event(
                "mon-b",
                "2026-10-26T12:00:00Z",
                "2026-10-26T12:20:00Z",
                json!({}),
            ),
            // Tuesday 09:00-09:20 and 09:40-10:00 local: the 20-minute gap is too short.
            event(
                "tue-a",
                "2026-10-27T07:00:00Z",
                "2026-10-27T07:20:00Z",
                json!({}),
            ),
            event(
                "tue-b",
                "2026-10-27T07:40:00Z",
                "2026-10-27T08:00:00Z",
                json!({"showAs": "tentative"}),
            ),
            // Tuesday 17:30 local until Wednesday 10:00 local: clipped to Tuesday's window.
            event(
                "overnight",
                "2026-10-27T15:30:00Z",
                "2026-10-28T08:00:00Z",
                json!({}),
            ),
        ];
        let slots = free_slots(&events, 9 * 60, 18 * 60, 3, 30, KYIV, now);
        let expected = vec![
            // Friday: from now (16:00) to the 16:30 meeting, then 17:00-18:00.
            (at("2026-10-23T13:00:00Z"), at("2026-10-23T13:30:00Z")),
            (at("2026-10-23T14:00:00Z"), at("2026-10-23T15:00:00Z")),
            // Weekend skipped. Monday on UTC+2.
            (at("2026-10-26T07:00:00Z"), at("2026-10-26T08:00:00Z")),
            (at("2026-10-26T09:30:00Z"), at("2026-10-26T12:00:00Z")),
            (at("2026-10-26T12:20:00Z"), at("2026-10-26T16:00:00Z")),
            // Tuesday.
            (at("2026-10-27T08:00:00Z"), at("2026-10-27T15:30:00Z")),
        ];
        assert_eq!(slots, expected);
    }

    #[test]
    fn free_slots_round_today_up_and_skip_a_finished_day() {
        // Wednesday 18 Nov 2026 10:07 in Kyiv (UTC+2): today starts at 10:15.
        let now = at("2026-11-18T08:07:00Z");
        let slots = free_slots(&[], 9 * 60, 18 * 60, 1, 30, KYIV, now);
        assert_eq!(
            slots,
            vec![(at("2026-11-18T08:15:00Z"), at("2026-11-18T16:00:00Z"))]
        );
        // After 18:00 today no longer counts: the next working day is Thursday.
        let late = at("2026-11-18T16:30:00Z");
        let slots = free_slots(&[], 9 * 60, 18 * 60, 1, 30, KYIV, late);
        assert_eq!(
            slots,
            vec![(at("2026-11-19T07:00:00Z"), at("2026-11-19T16:00:00Z"))]
        );
    }

    #[test]
    fn free_slots_skip_declined_events_and_whole_day_absences() {
        // Monday 26 Oct 2026, 08:00 in Kyiv (EET, UTC+2), before the working day starts.
        let now = at("2026-10-26T06:00:00Z");
        let events = vec![
            // Declined: the time stays free (as in the calendar view).
            event(
                "declined",
                "2026-10-26T08:00:00Z",
                "2026-10-26T09:00:00Z",
                json!({"response": "declined"}),
            ),
            // Out of office all Tuesday: the whole day is taken and not counted.
            event(
                "ooo",
                "2026-10-26T22:00:00Z",
                "2026-10-27T22:00:00Z",
                json!({"allDay": true, "showAs": "oof", "startDate": "2026-10-27", "endDate": "2026-10-28"}),
            ),
            // An all-day note shown as free blocks nothing.
            event(
                "note",
                "2026-10-27T22:00:00Z",
                "2026-10-28T22:00:00Z",
                json!({"allDay": true, "showAs": "free", "startDate": "2026-10-28", "endDate": "2026-10-29"}),
            ),
        ];
        let slots = free_slots(&events, 9 * 60, 18 * 60, 2, 30, KYIV, now);
        assert_eq!(
            slots,
            vec![
                (at("2026-10-26T07:00:00Z"), at("2026-10-26T16:00:00Z")),
                (at("2026-10-28T07:00:00Z"), at("2026-10-28T16:00:00Z")),
            ]
        );
    }

    #[test]
    fn free_slots_count_only_days_with_free_time() {
        // Monday is booked from 09:00 to 18:00, so Tuesday and Wednesday are the two days.
        let now = at("2026-10-26T06:00:00Z");
        let events = vec![event(
            "workshop",
            "2026-10-26T07:00:00Z",
            "2026-10-26T16:00:00Z",
            json!({}),
        )];
        let slots = free_slots(&events, 9 * 60, 18 * 60, 2, 30, KYIV, now);
        assert_eq!(
            slots,
            vec![
                (at("2026-10-27T07:00:00Z"), at("2026-10-27T16:00:00Z")),
                (at("2026-10-28T07:00:00Z"), at("2026-10-28T16:00:00Z")),
            ]
        );
    }

    #[test]
    fn local_times_survive_skipped_and_repeated_hours() {
        // 29 Mar 2026: Kyiv clocks jump from 03:00 to 04:00, so 03:30 becomes 04:30 EEST.
        let spring = NaiveDate::from_ymd_opt(2026, 3, 29).unwrap();
        assert_eq!(local(KYIV, spring, 3 * 60 + 30), at("2026-03-29T01:30:00Z"));
        // 25 Oct 2026: 03:00-04:00 happens twice; the first (EEST) one is used.
        let autumn = NaiveDate::from_ymd_opt(2026, 10, 25).unwrap();
        assert_eq!(local(KYIV, autumn, 3 * 60 + 30), at("2026-10-25T00:30:00Z"));
    }

    #[test]
    fn format_slot_names_day_date_and_times_in_the_zone() {
        let slot = (at("2026-10-26T07:00:00Z"), at("2026-10-26T08:30:00Z"));
        assert_eq!(format_slot(slot, KYIV), "Mon 26 Oct, 09:00–10:30");
    }
}
