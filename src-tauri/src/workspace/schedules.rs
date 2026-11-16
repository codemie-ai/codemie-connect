use super::models::*;
use chrono::{Datelike, LocalResult, NaiveTime, TimeZone, Timelike, Utc};
use chrono_tz::Tz;

/// Daily recurrence has a local wall time and an IANA zone. Folds execute once;
/// gaps advance to the next valid minute instead of dropping the occurrence.
pub fn next_occurrence(zone: &str, time: &str, weekdays: bool, after: i64) -> Result<i64> {
    let tz: Tz = zone
        .parse()
        .map_err(|_| WorkspaceError::new("validation", "Select a valid IANA time zone."))?;
    let time = NaiveTime::parse_from_str(time, "%H:%M")
        .map_err(|_| WorkspaceError::new("validation", "Enter time as HH:MM."))?;
    let start = chrono::DateTime::from_timestamp(after, 0)
        .ok_or_else(|| WorkspaceError::new("validation", "Invalid schedule date."))?
        .with_timezone(&tz)
        .date_naive();
    for day in 0..10 {
        let date = start + chrono::Duration::days(day);
        if weekdays && date.weekday().num_days_from_monday() >= 5 {
            continue;
        }
        let local = date
            .and_hms_opt(time.hour(), time.minute(), 0)
            .ok_or_else(|| WorkspaceError::new("validation", "Invalid schedule time."))?;
        for minute in 0..181 {
            let utc = match tz.from_local_datetime(&(local + chrono::Duration::minutes(minute))) {
                LocalResult::Single(dt) => Some(dt.with_timezone(&Utc)),
                LocalResult::Ambiguous(a, b) => Some(a.min(b).with_timezone(&Utc)),
                LocalResult::None => None,
            };
            if let Some(utc) = utc {
                if utc.timestamp() > after {
                    return Ok(utc.timestamp());
                }
                break;
            }
        }
    }
    Err(WorkspaceError::new(
        "validation",
        "Cannot calculate the next schedule occurrence.",
    ))
}

/// Event creation rejects gaps and requires an explicit offset during folds.
pub fn event_time(local: &str, zone: &str, offset: Option<i64>) -> Result<String> {
    let tz: Tz = zone
        .parse()
        .map_err(|_| WorkspaceError::new("validation", "Select a valid IANA time zone."))?;
    let dt = chrono::NaiveDateTime::parse_from_str(local, "%Y-%m-%dT%H:%M")
        .map_err(|_| WorkspaceError::new("validation", "Enter a complete event date and time."))?;
    let resolved = match tz.from_local_datetime(&dt) {
        LocalResult::Single(v) => v,
        LocalResult::None => {
            return Err(WorkspaceError::new(
                "validation",
                "This time falls in a daylight-saving gap. Choose a valid time.",
            ))
        }
        LocalResult::Ambiguous(a, b) => {
            use chrono::Offset;
            match offset {
                Some(o) if a.offset().fix().local_minus_utc() as i64 == o => a,
                Some(o) if b.offset().fix().local_minus_utc() as i64 == o => b,
                _ => {
                    return Err(WorkspaceError::new(
                        "ambiguous_time",
                        format!(
                            "This time occurs twice. Choose UTC offset {} or {} seconds.",
                            a.offset().fix().local_minus_utc(),
                            b.offset().fix().local_minus_utc()
                        ),
                    ))
                }
            }
        }
    };
    Ok(resolved.with_timezone(&Utc).to_rfc3339())
}
pub fn quiet(zone: &str, start: &str, end: &str, at: i64) -> bool {
    let Ok(tz) = zone.parse::<Tz>() else {
        return false;
    };
    let Some(at) = chrono::DateTime::from_timestamp(at, 0) else {
        return false;
    };
    let (Ok(start), Ok(end)) = (
        NaiveTime::parse_from_str(start, "%H:%M"),
        NaiveTime::parse_from_str(end, "%H:%M"),
    ) else {
        return false;
    };
    let time = at.with_timezone(&tz).time();
    if start == end {
        false
    } else if start < end {
        time >= start && time < end
    } else {
        time >= start || time < end
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn recurrence_handles_dst_without_duplicates() {
        let before = chrono::DateTime::parse_from_rfc3339("2026-03-28T12:00:00Z")
            .unwrap()
            .timestamp();
        let spring = next_occurrence("Europe/Berlin", "02:30", false, before).unwrap();
        assert_eq!(
            chrono::DateTime::from_timestamp(spring, 0)
                .unwrap()
                .to_rfc3339(),
            "2026-03-29T01:00:00+00:00"
        );
        let before = chrono::DateTime::parse_from_rfc3339("2026-10-24T12:00:00Z")
            .unwrap()
            .timestamp();
        let fold = next_occurrence("Europe/Berlin", "02:30", false, before).unwrap();
        let next = next_occurrence("Europe/Berlin", "02:30", false, fold).unwrap();
        assert!(next - fold > 86400);
    }
    #[test]
    fn event_gap_and_fold_require_review() {
        assert!(event_time("2026-03-29T02:30", "Europe/Berlin", None).is_err());
        assert_eq!(
            event_time("2026-10-25T02:30", "Europe/Berlin", None)
                .unwrap_err()
                .code,
            "ambiguous_time"
        );
        assert!(event_time("2026-10-25T02:30", "Europe/Berlin", Some(3600)).is_ok());
    }
}
